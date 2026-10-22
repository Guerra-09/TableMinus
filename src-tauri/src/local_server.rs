use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::{
    process::{Child, Command},
    sync::Mutex,
};

use crate::{
    connections::{ConnectionConfig, Driver},
    db::DbPool,
    error::{AppError, AppResult},
    introspect::{quote_identifier, quote_literal},
};

const SERVERS_DIRECTORY: &str = "servers";
const DATA_DIRECTORY: &str = "data";
const LOG_FILE: &str = "server.log";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);
const READINESS_POLL_INTERVAL: Duration = Duration::from_millis(250);
const PORT_PROBE_TIMEOUT: Duration = Duration::from_millis(300);
const LOG_TAIL_LINES: usize = 200;
const MYSQL_READY_MARKER: &str = "ready for connections";
const POSTGRES_READY_MARKER: &str = "database system is ready to accept connections";
const LOCAL_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "::1"];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerConfig {
    #[serde(default)]
    pub is_enabled: bool,
    #[serde(default)]
    pub bin_dir: String,
    #[serde(default)]
    pub data_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInstallation {
    pub label: String,
    pub bin_dir: String,
    pub version: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LocalServerState {
    Running,
    External,
    Stopped,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServerStatus {
    pub connection_id: String,
    pub state: LocalServerState,
    pub pid: Option<u32>,
}

struct ManagedServer {
    child: Child,
    driver: Driver,
}

#[derive(Default)]
pub struct LocalServerManager {
    servers: Mutex<HashMap<String, ManagedServer>>,
}

struct ServerPaths {
    root: PathBuf,
    data: PathBuf,
    log: PathBuf,
    socket_directory: PathBuf,
}

fn server_binary_name(driver: Driver) -> &'static str {
    match driver {
        Driver::Mysql => "mysqld",
        Driver::Postgres | Driver::Sqlite => "postgres",
    }
}

pub fn servers_root_directory(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app.path().app_data_dir()?.join(SERVERS_DIRECTORY))
}

fn server_paths(servers_root: &Path, config: &ConnectionConfig, local_server: &LocalServerConfig) -> ServerPaths {
    let root = servers_root.join(&config.id);
    let data = if local_server.data_dir.trim().is_empty() {
        root.join(DATA_DIRECTORY)
    } else {
        PathBuf::from(local_server.data_dir.trim())
    };
    let short_id: String = config.id.chars().filter(char::is_ascii_alphanumeric).take(8).collect();
    let socket_directory = if cfg!(unix) {
        PathBuf::from(format!("/tmp/tableminus-{short_id}"))
    } else {
        root.join("run")
    };
    ServerPaths { log: root.join(LOG_FILE), root, data, socket_directory }
}

fn is_port_open(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, PORT_PROBE_TIMEOUT).is_ok()
}

fn is_data_directory_initialized(driver: Driver, data_directory: &Path) -> bool {
    match driver {
        Driver::Mysql => data_directory.join("mysql").exists() || data_directory.join("mysql.ibd").exists(),
        Driver::Postgres | Driver::Sqlite => data_directory.join("PG_VERSION").exists(),
    }
}

fn read_log_from(log_path: &Path, offset: u64) -> String {
    let mut content = String::new();
    if let Ok(mut file) = File::open(log_path) {
        if file.seek(SeekFrom::Start(offset)).is_ok() {
            let _ = file.read_to_string(&mut content);
        }
    }
    content
}

fn tail_lines(content: &str, line_count: usize) -> String {
    let lines: Vec<&str> = content.lines().collect();
    lines[lines.len().saturating_sub(line_count)..].join("\n")
}

fn open_log_for_append(log_path: &Path) -> AppResult<File> {
    Ok(OpenOptions::new().create(true).append(true).open(log_path)?)
}

async fn run_to_completion(command: &mut Command, log_path: &Path, description: &str) -> AppResult<()> {
    let log_file = open_log_for_append(log_path)?;
    let status = command
        .stdout(Stdio::from(log_file.try_clone()?))
        .stderr(Stdio::from(log_file))
        .status()
        .await?;
    if status.success() {
        return Ok(());
    }
    let log_tail = tail_lines(&read_log_from(log_path, 0), 15);
    Err(AppError::Message(format!("{description} failed ({status}).\n{log_tail}")))
}

fn version_of(binary_path: &Path) -> String {
    std::process::Command::new(binary_path)
        .arg("--version")
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default()
}

fn candidate_bin_directories(driver: Driver) -> Vec<PathBuf> {
    let formula_prefixes: &[&str] = match driver {
        Driver::Mysql => &["mysql", "mariadb", "percona-server"],
        Driver::Postgres | Driver::Sqlite => &["postgresql", "postgres"],
    };
    let mut candidates = Vec::new();
    for homebrew_opt in ["/opt/homebrew/opt", "/usr/local/opt", "/home/linuxbrew/.linuxbrew/opt"] {
        if let Ok(entries) = fs::read_dir(homebrew_opt) {
            for entry in entries.flatten() {
                let formula_name = entry.file_name().to_string_lossy().to_string();
                if formula_prefixes.iter().any(|prefix| formula_name.starts_with(prefix)) {
                    candidates.push(entry.path().join("bin"));
                }
            }
        }
    }
    match driver {
        Driver::Mysql => {
            candidates.push(PathBuf::from("/usr/local/mysql/bin"));
            candidates.push(PathBuf::from("/usr/sbin"));
        }
        Driver::Postgres | Driver::Sqlite => {
            for versions_root in ["/Applications/Postgres.app/Contents/Versions", "/usr/lib/postgresql"] {
                if let Ok(entries) = fs::read_dir(versions_root) {
                    candidates.extend(entries.flatten().map(|entry| entry.path().join("bin")));
                }
            }
        }
    }
    candidates
}

pub fn detect_installations(driver: Driver) -> Vec<ServerInstallation> {
    if driver == Driver::Sqlite {
        return Vec::new();
    }
    let mut seen_binaries = Vec::new();
    let mut installations = Vec::new();
    for bin_directory in candidate_bin_directories(driver) {
        let binary_path = bin_directory.join(server_binary_name(driver));
        let Ok(canonical_binary) = fs::canonicalize(&binary_path) else { continue };
        if seen_binaries.contains(&canonical_binary) {
            continue;
        }
        seen_binaries.push(canonical_binary);
        let source = if bin_directory.starts_with("/opt/homebrew") || bin_directory.starts_with("/usr/local/opt") {
            "Homebrew"
        } else if bin_directory.starts_with("/Applications/Postgres.app") {
            "Postgres.app"
        } else {
            "System"
        };
        let version = version_of(&binary_path);
        installations.push(ServerInstallation {
            label: format!("{source} — {}", if version.is_empty() { bin_directory.display().to_string() } else { version.clone() }),
            bin_dir: bin_directory.display().to_string(),
            version,
        });
    }
    installations
}

impl LocalServerManager {
    pub async fn statuses(&self, connections: &[ConnectionConfig]) -> Vec<LocalServerStatus> {
        let mut servers = self.servers.lock().await;
        servers.retain(|_, server| matches!(server.child.try_wait(), Ok(None)));
        connections
            .iter()
            .filter(|connection| connection.local_server.as_ref().is_some_and(|local_server| local_server.is_enabled))
            .map(|connection| {
                let managed_pid = servers.get(&connection.id).and_then(|server| server.child.id());
                let state = if managed_pid.is_some() {
                    LocalServerState::Running
                } else if is_port_open(connection.port) {
                    LocalServerState::External
                } else {
                    LocalServerState::Stopped
                };
                LocalServerStatus { connection_id: connection.id.clone(), state, pid: managed_pid }
            })
            .collect()
    }

    pub async fn start(&self, servers_root: &Path, config: &ConnectionConfig, password: Option<String>) -> AppResult<()> {
        let local_server = config
            .local_server
            .clone()
            .filter(|local_server| local_server.is_enabled)
            .ok_or_else(|| AppError::Message("Local server is not enabled for this connection".into()))?;
        if config.driver == Driver::Sqlite {
            return Err(AppError::Message("SQLite does not need a server".into()));
        }
        if !LOCAL_HOSTS.contains(&config.host.trim()) {
            return Err(AppError::Message("Local server requires host 127.0.0.1 or localhost".into()));
        }

        let mut servers = self.servers.lock().await;
        if let Some(server) = servers.get_mut(&config.id) {
            if matches!(server.child.try_wait(), Ok(None)) {
                return Ok(());
            }
            servers.remove(&config.id);
        }
        if is_port_open(config.port) {
            return Err(AppError::Message(format!(
                "Port {} is already in use by another process (Docker or another server). Stop it or change the port.",
                config.port
            )));
        }

        let bin_directory = PathBuf::from(local_server.bin_dir.trim());
        let server_binary = bin_directory.join(server_binary_name(config.driver));
        if !server_binary.exists() {
            return Err(AppError::Message(format!("Server binary not found: {}", server_binary.display())));
        }

        let paths = server_paths(servers_root, config, &local_server);
        fs::create_dir_all(&paths.root)?;
        fs::create_dir_all(&paths.socket_directory)?;
        if let Some(data_parent) = paths.data.parent() {
            fs::create_dir_all(data_parent)?;
        }

        let is_new_data_directory = !is_data_directory_initialized(config.driver, &paths.data);
        if is_new_data_directory {
            initialize_data_directory(config, password.as_deref(), &bin_directory, &paths).await?;
        }

        let log_offset = fs::metadata(&paths.log).map(|metadata| metadata.len()).unwrap_or(0);
        let child = spawn_server(config, &server_binary, &paths)?;
        let mut managed_server = ManagedServer { child, driver: config.driver };

        if let Err(error) = wait_until_ready(&mut managed_server, &paths.log, log_offset).await {
            stop_managed_server(&mut managed_server).await;
            return Err(error);
        }
        if is_new_data_directory {
            if let Err(error) = provision_new_server(config, password.as_deref()).await {
                stop_managed_server(&mut managed_server).await;
                return Err(error);
            }
        }
        servers.insert(config.id.clone(), managed_server);
        Ok(())
    }

    pub async fn stop(&self, connection_id: &str) -> AppResult<()> {
        let managed_server = self.servers.lock().await.remove(connection_id);
        match managed_server {
            Some(mut server) => {
                stop_managed_server(&mut server).await;
                Ok(())
            }
            None => Err(AppError::Message("This server was not started by TableMinus".into())),
        }
    }

    pub async fn stop_all(&self) {
        let mut servers = self.servers.lock().await;
        for (_, mut server) in servers.drain() {
            stop_managed_server(&mut server).await;
        }
    }

    pub fn read_log(servers_root: &Path, config: &ConnectionConfig) -> AppResult<String> {
        let local_server = config.local_server.clone().unwrap_or_default();
        let paths = server_paths(servers_root, config, &local_server);
        Ok(tail_lines(&read_log_from(&paths.log, 0), LOG_TAIL_LINES))
    }
}

async fn initialize_data_directory(
    config: &ConnectionConfig,
    password: Option<&str>,
    bin_directory: &Path,
    paths: &ServerPaths,
) -> AppResult<()> {
    match config.driver {
        Driver::Mysql => {
            let mut command = Command::new(bin_directory.join("mysqld"));
            command
                .arg("--no-defaults")
                .arg("--initialize-insecure")
                .arg(format!("--datadir={}", paths.data.display()));
            run_to_completion(&mut command, &paths.log, "MySQL data directory initialization").await
        }
        Driver::Postgres | Driver::Sqlite => {
            let superuser = if config.user.trim().is_empty() { "postgres" } else { config.user.trim() };
            let mut command = Command::new(bin_directory.join("initdb"));
            command
                .arg("-D")
                .arg(&paths.data)
                .arg("-U")
                .arg(superuser)
                .arg("-E")
                .arg("UTF8")
                .arg("--auth-local=trust");
            let password_file = paths.root.join("initdb-password");
            match password.filter(|value| !value.is_empty()) {
                Some(value) => {
                    fs::write(&password_file, value)?;
                    command.arg("--auth-host=scram-sha-256").arg(format!("--pwfile={}", password_file.display()));
                }
                None => {
                    command.arg("--auth-host=trust");
                }
            }
            let result = run_to_completion(&mut command, &paths.log, "PostgreSQL initdb").await;
            let _ = fs::remove_file(&password_file);
            result
        }
    }
}

fn spawn_server(config: &ConnectionConfig, server_binary: &Path, paths: &ServerPaths) -> AppResult<Child> {
    let log_file = open_log_for_append(&paths.log)?;
    let mut command = Command::new(server_binary);
    match config.driver {
        Driver::Mysql => {
            command
                .arg("--no-defaults")
                .arg(format!("--datadir={}", paths.data.display()))
                .arg(format!("--port={}", config.port))
                .arg("--bind-address=127.0.0.1")
                .arg(format!("--socket={}", paths.socket_directory.join("mysql.sock").display()))
                .arg("--mysqlx=OFF")
                .arg(format!("--pid-file={}", paths.root.join("mysqld.pid").display()))
                .arg(format!("--log-error={}", paths.log.display()));
        }
        Driver::Postgres | Driver::Sqlite => {
            command
                .arg("-D")
                .arg(&paths.data)
                .arg("-p")
                .arg(config.port.to_string())
                .arg("-h")
                .arg("127.0.0.1")
                .arg("-k")
                .arg(&paths.socket_directory);
        }
    }
    Ok(command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file.try_clone()?))
        .stderr(Stdio::from(log_file))
        .kill_on_drop(false)
        .spawn()?)
}

/// Waits until the server writes its readiness marker to the log. The TCP port
/// alone is not enough: mysqld accepts sockets before it can serve the handshake.
async fn wait_until_ready(server: &mut ManagedServer, log_path: &Path, log_offset: u64) -> AppResult<()> {
    let ready_marker = match server.driver {
        Driver::Mysql => MYSQL_READY_MARKER,
        Driver::Postgres | Driver::Sqlite => POSTGRES_READY_MARKER,
    };
    let started_at = Instant::now();
    while started_at.elapsed() < STARTUP_TIMEOUT {
        let new_log_content = read_log_from(log_path, log_offset);
        if new_log_content.contains(ready_marker) {
            return Ok(());
        }
        if let Ok(Some(exit_status)) = server.child.try_wait() {
            return Err(AppError::Message(format!(
                "Server exited during startup ({exit_status}).\n{}",
                tail_lines(&new_log_content, 15)
            )));
        }
        tokio::time::sleep(READINESS_POLL_INTERVAL).await;
    }
    Err(AppError::Message(format!(
        "Server did not become ready within {} seconds.\n{}",
        STARTUP_TIMEOUT.as_secs(),
        tail_lines(&read_log_from(log_path, log_offset), 15)
    )))
}

/// Creates the configured user and database on a freshly initialized server so
/// the saved connection works immediately. MySQL starts with a passwordless root;
/// PostgreSQL already has the configured superuser from initdb.
async fn provision_new_server(config: &ConnectionConfig, password: Option<&str>) -> AppResult<()> {
    let password = password.unwrap_or_default();
    let mut admin_config = config.clone();
    admin_config.host = "127.0.0.1".into();
    let mut statements = Vec::new();

    let admin_password = match config.driver {
        Driver::Mysql => {
            admin_config.user = "root".into();
            admin_config.database = String::new();
            let user = if config.user.trim().is_empty() { "root" } else { config.user.trim() };
            let password_literal = quote_literal(Driver::Mysql, password);
            if user == "root" {
                if !password.is_empty() {
                    statements.push(format!("ALTER USER 'root'@'localhost' IDENTIFIED BY {password_literal}"));
                }
            } else {
                let user_literal = quote_literal(Driver::Mysql, user);
                statements.push(format!("CREATE USER IF NOT EXISTS {user_literal}@'%' IDENTIFIED BY {password_literal}"));
                statements.push(format!("GRANT ALL PRIVILEGES ON *.* TO {user_literal}@'%' WITH GRANT OPTION"));
            }
            if !config.database.trim().is_empty() {
                statements.insert(0, format!("CREATE DATABASE IF NOT EXISTS {}", quote_identifier(Driver::Mysql, config.database.trim())));
            }
            None
        }
        Driver::Postgres | Driver::Sqlite => {
            admin_config.database = "postgres".into();
            if !config.user.trim().is_empty() {
                admin_config.user = config.user.trim().into();
            } else {
                admin_config.user = "postgres".into();
            }
            let database = config.database.trim();
            if !database.is_empty() && database != "postgres" {
                statements.push(format!("CREATE DATABASE {}", quote_identifier(Driver::Postgres, database)));
            }
            Some(password.to_string()).filter(|value| !value.is_empty())
        }
    };

    if statements.is_empty() {
        return Ok(());
    }
    let pool = DbPool::connect(&admin_config, admin_password).await?;
    let mut provisioning_result = Ok(());
    for statement in &statements {
        if let Err(error) = pool.execute(statement).await {
            provisioning_result = Err(error);
            break;
        }
    }
    pool.close().await;
    provisioning_result
}

#[cfg(unix)]
fn request_graceful_shutdown(server: &ManagedServer) {
    if let Some(pid) = server.child.id() {
        let signal = match server.driver {
            Driver::Mysql => libc::SIGTERM,
            Driver::Postgres | Driver::Sqlite => libc::SIGINT,
        };
        unsafe {
            libc::kill(pid as libc::pid_t, signal);
        }
    }
}

#[cfg(not(unix))]
fn request_graceful_shutdown(_server: &ManagedServer) {}

async fn stop_managed_server(server: &mut ManagedServer) {
    if cfg!(not(unix)) {
        let _ = server.child.kill().await;
        return;
    }
    request_graceful_shutdown(server);
    if tokio::time::timeout(SHUTDOWN_TIMEOUT, server.child.wait()).await.is_err() {
        let _ = server.child.kill().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOMEBREW_MYSQL_BIN: &str = "/opt/homebrew/opt/mysql/bin";
    const TEST_MYSQL_PORT: u16 = 3398;

    fn mysql_test_config() -> ConnectionConfig {
        ConnectionConfig {
            id: "localservertest".into(),
            name: "local server test".into(),
            driver: Driver::Mysql,
            host: "127.0.0.1".into(),
            port: TEST_MYSQL_PORT,
            user: "app_user".into(),
            database: "app_db".into(),
            file_path: String::new(),
            tag: String::new(),
            color: String::new(),
            safe_mode: String::new(),
            folder: String::new(),
            local_server: Some(LocalServerConfig { is_enabled: true, bin_dir: HOMEBREW_MYSQL_BIN.into(), data_dir: String::new() }),
            ssh: None,
        }
    }

    #[tokio::test]
    async fn managed_mysql_lifecycle() {
        if !Path::new(HOMEBREW_MYSQL_BIN).join("mysqld").exists() {
            eprintln!("skipping: Homebrew mysqld not installed");
            return;
        }
        let servers_root = std::env::temp_dir().join("tableminus-local-server-test");
        let _ = fs::remove_dir_all(&servers_root);
        let config = mysql_test_config();
        let password = Some("s3cret".to_string());
        let manager = LocalServerManager::default();

        manager.start(&servers_root, &config, password.clone()).await.expect("first start initializes and provisions");
        let statuses = manager.statuses(std::slice::from_ref(&config)).await;
        assert_eq!(statuses[0].state, LocalServerState::Running);

        let pool = DbPool::connect(&config, password.clone()).await.expect("provisioned user can connect");
        let rows = pool.fetch_text_rows("SELECT DATABASE()").await.unwrap();
        assert_eq!(rows[0][0].as_deref(), Some("app_db"));
        pool.execute("CREATE TABLE notes (id INT PRIMARY KEY, body TEXT)").await.unwrap();
        pool.execute("INSERT INTO notes VALUES (1, 'kept')").await.unwrap();
        let blocked_write = pool.execute_read_only("INSERT INTO notes VALUES (2, 'blocked')", None).await;
        assert!(blocked_write.is_err(), "read-only transaction must reject writes");
        let read_back = pool.execute_read_only("SELECT COUNT(*) FROM notes", None).await.unwrap();
        assert_eq!(read_back.rows[0][0], serde_json::json!(1));
        pool.close().await;

        manager.start(&servers_root, &config, password.clone()).await.expect("second start is a no-op");
        manager.stop(&config.id).await.expect("stop");
        assert!(!is_port_open(TEST_MYSQL_PORT));
        assert_eq!(manager.statuses(std::slice::from_ref(&config)).await[0].state, LocalServerState::Stopped);

        manager.start(&servers_root, &config, password.clone()).await.expect("restart reuses data directory");
        let pool = DbPool::connect(&config, password).await.unwrap();
        let rows = pool.fetch_text_rows("SELECT body FROM notes").await.unwrap();
        assert_eq!(rows[0][0].as_deref(), Some("kept"));
        pool.close().await;
        manager.stop_all().await;
        assert!(!is_port_open(TEST_MYSQL_PORT));
        assert!(LocalServerManager::read_log(&servers_root, &config).unwrap().contains("ready for connections"));

        let _ = fs::remove_dir_all(&servers_root);
    }

    #[tokio::test]
    async fn start_refuses_busy_port() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let mut config = mysql_test_config();
        config.id = "busyporttest".into();
        config.port = listener.local_addr().unwrap().port();
        let error = LocalServerManager::default()
            .start(&std::env::temp_dir().join("tableminus-busy-port-test"), &config, None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("already in use"));
    }
}

use std::{
    fmt::Display,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use russh::{
    client,
    keys::{self, known_hosts::learn_known_hosts_path, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate},
    Disconnect,
};
use serde::{Deserialize, Serialize};
use tokio::{net::TcpListener, task::JoinHandle};

use crate::error::{AppError, AppResult};

const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SSH_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const DEFAULT_PRIVATE_KEY_NAMES: [&str; 3] = ["id_ed25519", "id_ecdsa", "id_rsa"];

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SshAuthMethod {
    #[default]
    Key,
    Password,
    Agent,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    #[serde(default)]
    pub is_enabled: bool,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub auth_method: SshAuthMethod,
    #[serde(default)]
    pub private_key_path: String,
}

struct HostKeyVerifier {
    host: String,
    port: u16,
    app_known_hosts: PathBuf,
    rejection_reason: Arc<Mutex<Option<String>>>,
}

impl client::Handler for HostKeyVerifier {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let public_key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(certificate) => PublicKey::new(certificate.public_key().clone(), ""),
        };
        match verify_host_key(&self.host, self.port, &public_key, &self.app_known_hosts) {
            Ok(()) => Ok(true),
            Err(reason) => {
                if let Ok(mut rejection_reason) = self.rejection_reason.lock() {
                    *rejection_reason = Some(reason);
                }
                Ok(false)
            }
        }
    }
}

pub struct SshTunnel {
    pub local_port: u16,
    session: Arc<client::Handle<HostKeyVerifier>>,
    accept_task: JoinHandle<()>,
}

fn ssh_error(context: &str, error: impl Display) -> AppError {
    AppError::Message(format!("{context}: {error}"))
}

fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

fn expand_home(path: &str) -> PathBuf {
    match (path.strip_prefix("~/"), home_directory()) {
        (Some(relative_path), Some(home)) => home.join(relative_path),
        _ => PathBuf::from(path),
    }
}

fn resolve_private_key_path(configured_path: &str) -> AppResult<PathBuf> {
    if !configured_path.trim().is_empty() {
        return Ok(expand_home(configured_path.trim()));
    }
    let ssh_directory = home_directory().map(|home| home.join(".ssh")).unwrap_or_default();
    DEFAULT_PRIVATE_KEY_NAMES
        .iter()
        .map(|key_name| ssh_directory.join(key_name))
        .find(|key_path| key_path.exists())
        .ok_or_else(|| AppError::Message("No private key selected and none found in ~/.ssh".into()))
}

/// Trust-on-first-use host key check, equivalent to OpenSSH's
/// `StrictHostKeyChecking=accept-new`. Keys already in the user's
/// `~/.ssh/known_hosts` are honored; unknown hosts are recorded in the app's own
/// known_hosts file so the user's file is never modified. A changed key aborts
/// the connection.
fn verify_host_key(host: &str, port: u16, public_key: &PublicKey, app_known_hosts: &Path) -> Result<(), String> {
    let user_known_hosts = home_directory().map(|home| home.join(".ssh").join("known_hosts"));
    let known_hosts_files = user_known_hosts.into_iter().chain(std::iter::once(app_known_hosts.to_path_buf()));
    for known_hosts_file in known_hosts_files.filter(|path| path.exists()) {
        match keys::check_known_hosts_path(host, port, public_key, &known_hosts_file) {
            Ok(true) => return Ok(()),
            Err(keys::Error::KeyChanged { line }) => {
                return Err(format!(
                    "The SSH host key for {host} has CHANGED ({}:{line}). This can mean a man-in-the-middle attack or a reinstalled server. Verify the server and remove the old key before connecting.",
                    known_hosts_file.display()
                ))
            }
            _ => continue,
        }
    }
    learn_known_hosts_path(host, port, public_key, app_known_hosts)
        .map_err(|error| format!("Could not record the SSH host key: {error}"))
}

async fn authenticate(
    session: &mut client::Handle<HostKeyVerifier>,
    ssh: &SshConfig,
    secret: Option<String>,
) -> AppResult<()> {
    let user = ssh.user.trim().to_string();
    let rsa_hash = session
        .best_supported_rsa_hash()
        .await
        .map_err(|error| ssh_error("SSH negotiation failed", error))?
        .flatten();

    let is_authenticated = match ssh.auth_method {
        SshAuthMethod::Password => session
            .authenticate_password(user.clone(), secret.unwrap_or_default())
            .await
            .map_err(|error| ssh_error("SSH password authentication failed", error))?
            .success(),
        SshAuthMethod::Key => {
            let key_path = resolve_private_key_path(&ssh.private_key_path)?;
            let passphrase = secret.filter(|value| !value.is_empty());
            let private_key = keys::load_secret_key(&key_path, passphrase.as_deref()).map_err(|error| {
                ssh_error(
                    &format!("Cannot load private key {} (if it is encrypted, enter its passphrase)", key_path.display()),
                    error,
                )
            })?;
            session
                .authenticate_publickey(user.clone(), PrivateKeyWithHashAlg::new(Arc::new(private_key), rsa_hash))
                .await
                .map_err(|error| ssh_error("SSH key authentication failed", error))?
                .success()
        }
        SshAuthMethod::Agent => authenticate_with_agent(session, &user, rsa_hash).await?,
    };

    if is_authenticated {
        Ok(())
    } else {
        Err(AppError::Message(format!(
            "SSH authentication was rejected for {user}@{}. Check the user and credentials.",
            ssh.host.trim()
        )))
    }
}

#[cfg(unix)]
async fn authenticate_with_agent(
    session: &mut client::Handle<HostKeyVerifier>,
    user: &str,
    rsa_hash: Option<keys::HashAlg>,
) -> AppResult<bool> {
    let mut agent = keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|error| ssh_error("Cannot reach the SSH agent (SSH_AUTH_SOCK)", error))?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|error| ssh_error("Cannot list SSH agent keys", error))?;
    for identity in identities {
        let result = session
            .authenticate_publickey_with(user.to_string(), identity.public_key().into_owned(), rsa_hash, &mut agent)
            .await;
        if matches!(result, Ok(auth_result) if auth_result.success()) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(not(unix))]
async fn authenticate_with_agent(
    _session: &mut client::Handle<HostKeyVerifier>,
    _user: &str,
    _rsa_hash: Option<keys::HashAlg>,
) -> AppResult<bool> {
    Err(AppError::Message("SSH agent authentication is not supported on this platform yet".into()))
}

impl SshTunnel {
    /// Opens an SSH session and a local listener on 127.0.0.1 with a random port.
    /// Every local connection is forwarded through a `direct-tcpip` channel to
    /// `remote_host:remote_port` as seen from the SSH server.
    pub async fn open(
        ssh: &SshConfig,
        secret: Option<String>,
        remote_host: &str,
        remote_port: u16,
        app_known_hosts: PathBuf,
    ) -> AppResult<Self> {
        let ssh_host = ssh.host.trim().to_string();
        let ssh_port = if ssh.port == 0 { 22 } else { ssh.port };
        if ssh_host.is_empty() || ssh.user.trim().is_empty() {
            return Err(AppError::Message("SSH host and user are required".into()));
        }

        let config = Arc::new(client::Config {
            keepalive_interval: Some(SSH_KEEPALIVE_INTERVAL),
            inactivity_timeout: None,
            ..Default::default()
        });
        let rejection_reason = Arc::new(Mutex::new(None));
        let verifier = HostKeyVerifier {
            host: ssh_host.clone(),
            port: ssh_port,
            app_known_hosts,
            rejection_reason: rejection_reason.clone(),
        };

        let mut session = match tokio::time::timeout(
            SSH_CONNECT_TIMEOUT,
            client::connect(config, (ssh_host.as_str(), ssh_port), verifier),
        )
        .await
        {
            Err(_) => {
                return Err(AppError::Message(format!(
                    "SSH connection to {ssh_host}:{ssh_port} timed out after {} seconds",
                    SSH_CONNECT_TIMEOUT.as_secs()
                )))
            }
            Ok(Err(error)) => {
                let reason = rejection_reason.lock().ok().and_then(|mut reason| reason.take());
                return Err(match reason {
                    Some(reason) => AppError::Message(reason),
                    None => ssh_error(&format!("SSH connection to {ssh_host}:{ssh_port} failed"), error),
                });
            }
            Ok(Ok(session)) => session,
        };

        authenticate(&mut session, ssh, secret).await?;

        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let local_port = listener.local_addr()?.port();
        let session = Arc::new(session);
        let forwarding_session = session.clone();
        let remote_host = remote_host.trim().to_string();

        let accept_task = tokio::spawn(async move {
            while let Ok((mut local_socket, peer_address)) = listener.accept().await {
                let channel_session = forwarding_session.clone();
                let target_host = remote_host.clone();
                tokio::spawn(async move {
                    let channel = channel_session
                        .channel_open_direct_tcpip(target_host, u32::from(remote_port), "127.0.0.1", u32::from(peer_address.port()))
                        .await;
                    if let Ok(channel) = channel {
                        let mut remote_stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut local_socket, &mut remote_stream).await;
                    }
                });
            }
        });

        Ok(Self { local_port, session, accept_task })
    }

    pub async fn close(self) {
        self.accept_task.abort();
        let _ = self.session.disconnect(Disconnect::ByApplication, "", "en").await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const TEST_SSHD_PORT: u16 = 2222;

    /// These tests need an unprivileged sshd on 127.0.0.1:2222 whose
    /// authorized_keys accepts `client_ed25519` and `client_encrypted`
    /// (passphrase `secretpass`) from the directory in TABLEMINUS_TEST_SSH_DIR.
    fn test_ssh_directory() -> Option<PathBuf> {
        std::env::var_os("TABLEMINUS_TEST_SSH_DIR").map(PathBuf::from)
    }

    fn key_config(ssh_directory: &Path, key_name: &str) -> SshConfig {
        SshConfig {
            is_enabled: true,
            host: "127.0.0.1".into(),
            port: TEST_SSHD_PORT,
            user: std::env::var("USER").unwrap_or_default(),
            auth_method: SshAuthMethod::Key,
            private_key_path: ssh_directory.join(key_name).display().to_string(),
        }
    }

    async fn start_echo_server() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buffer = [0u8; 1024];
                    while let Ok(read_count) = socket.read(&mut buffer).await {
                        if read_count == 0 || socket.write_all(&buffer[..read_count]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        port
    }

    async fn echo_through(local_port: u16, message: &[u8]) -> Vec<u8> {
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", local_port)).await.unwrap();
        socket.write_all(message).await.unwrap();
        let mut response = vec![0u8; message.len()];
        socket.read_exact(&mut response).await.unwrap();
        response
    }

    #[tokio::test]
    async fn tunnel_forwards_tcp_with_key_and_passphrase_auth() {
        let Some(ssh_directory) = test_ssh_directory() else {
            eprintln!("skipping: TABLEMINUS_TEST_SSH_DIR not set");
            return;
        };
        let known_hosts = std::env::temp_dir().join("tableminus-test-known-hosts");
        let _ = std::fs::remove_file(&known_hosts);
        let echo_port = start_echo_server().await;

        let tunnel = SshTunnel::open(&key_config(&ssh_directory, "client_ed25519"), None, "127.0.0.1", echo_port, known_hosts.clone())
            .await
            .expect("key auth tunnel");
        assert_eq!(echo_through(tunnel.local_port, b"hello").await, b"hello");
        assert_eq!(echo_through(tunnel.local_port, b"second connection").await, b"second connection");
        tunnel.close().await;
        assert!(std::fs::read_to_string(&known_hosts).unwrap().contains("[127.0.0.1]:2222"), "host key learned on first use");

        let encrypted_config = key_config(&ssh_directory, "client_encrypted");
        let tunnel = SshTunnel::open(&encrypted_config, Some("secretpass".into()), "127.0.0.1", echo_port, known_hosts.clone())
            .await
            .expect("encrypted key with passphrase");
        assert_eq!(echo_through(tunnel.local_port, b"encrypted").await, b"encrypted");
        tunnel.close().await;

        let wrong_passphrase = SshTunnel::open(&encrypted_config, Some("nope".into()), "127.0.0.1", echo_port, known_hosts.clone()).await;
        assert!(wrong_passphrase.err().unwrap().to_string().contains("Cannot load private key"));

        let mut wrong_user = key_config(&ssh_directory, "client_ed25519");
        wrong_user.user = "tableminus-nobody".into();
        let rejected = SshTunnel::open(&wrong_user, None, "127.0.0.1", echo_port, known_hosts.clone()).await;
        assert!(rejected.err().unwrap().to_string().contains("rejected"));

        let _ = std::fs::remove_file(&known_hosts);
    }

    #[tokio::test]
    async fn tunnel_refuses_changed_host_key() {
        let Some(ssh_directory) = test_ssh_directory() else {
            eprintln!("skipping: TABLEMINUS_TEST_SSH_DIR not set");
            return;
        };
        let known_hosts = std::env::temp_dir().join("tableminus-test-known-hosts-changed");
        let impostor_key = std::fs::read_to_string(ssh_directory.join("client_ed25519.pub")).unwrap();
        std::fs::write(&known_hosts, format!("[127.0.0.1]:{TEST_SSHD_PORT} {impostor_key}")).unwrap();

        let result = SshTunnel::open(&key_config(&ssh_directory, "client_ed25519"), None, "127.0.0.1", 1, known_hosts.clone()).await;
        assert!(result.err().unwrap().to_string().contains("CHANGED"));
        let _ = std::fs::remove_file(&known_hosts);
    }

    #[tokio::test]
    async fn tunnel_reports_unreachable_ssh_server() {
        let mut config = key_config(Path::new("/nonexistent"), "client_ed25519");
        config.port = 1;
        let result = SshTunnel::open(&config, None, "127.0.0.1", 3306, std::env::temp_dir().join("tableminus-unused-known-hosts")).await;
        assert!(result.err().unwrap().to_string().contains("SSH connection to 127.0.0.1:1 failed"));
    }

    #[tokio::test]
    async fn tunnel_authenticates_with_ssh_agent() {
        let (Some(ssh_directory), Some(_)) = (test_ssh_directory(), std::env::var_os("TABLEMINUS_TEST_SSH_AGENT")) else {
            eprintln!("skipping: TABLEMINUS_TEST_SSH_DIR / TABLEMINUS_TEST_SSH_AGENT not set");
            return;
        };
        let mut agent_config = key_config(&ssh_directory, "unused");
        agent_config.auth_method = SshAuthMethod::Agent;
        agent_config.private_key_path = String::new();
        let echo_port = start_echo_server().await;
        let known_hosts = std::env::temp_dir().join("tableminus-test-known-hosts-agent");
        let tunnel = SshTunnel::open(&agent_config, None, "127.0.0.1", echo_port, known_hosts.clone())
            .await
            .expect("agent auth tunnel");
        assert_eq!(echo_through(tunnel.local_port, b"agent").await, b"agent");
        tunnel.close().await;
        let _ = std::fs::remove_file(&known_hosts);
    }

    #[tokio::test]
    async fn mysql_queries_work_through_tunnel() {
        use crate::{
            connections::{ConnectionConfig, Driver},
            db::DbPool,
            local_server::{LocalServerConfig, LocalServerManager},
        };
        const MYSQL_BIN: &str = "/opt/homebrew/opt/mysql/bin";
        const MYSQL_PORT: u16 = 3397;
        let Some(ssh_directory) = test_ssh_directory() else {
            eprintln!("skipping: TABLEMINUS_TEST_SSH_DIR not set");
            return;
        };
        if !Path::new(MYSQL_BIN).join("mysqld").exists() {
            eprintln!("skipping: Homebrew mysqld not installed");
            return;
        }
        let database_config = ConnectionConfig {
            id: "sshtunneltest".into(),
            name: "ssh tunnel test".into(),
            driver: Driver::Mysql,
            host: "127.0.0.1".into(),
            port: MYSQL_PORT,
            user: "root".into(),
            database: "remote_db".into(),
            file_path: String::new(),
            tag: String::new(),
            color: String::new(),
            safe_mode: String::new(),
            local_server: Some(LocalServerConfig { is_enabled: true, bin_dir: MYSQL_BIN.into(), data_dir: String::new() }),
            ssh: None,
        };
        let servers_root = std::env::temp_dir().join("tableminus-ssh-mysql-test");
        let _ = std::fs::remove_dir_all(&servers_root);
        let servers = LocalServerManager::default();
        servers.start(&servers_root, &database_config, Some("rootpw".into())).await.expect("mysql up");

        let known_hosts = std::env::temp_dir().join("tableminus-test-known-hosts-mysql");
        let tunnel = SshTunnel::open(&key_config(&ssh_directory, "client_ed25519"), None, "127.0.0.1", MYSQL_PORT, known_hosts.clone())
            .await
            .expect("tunnel");
        let mut tunneled_config = database_config.clone();
        tunneled_config.port = tunnel.local_port;
        let pool = DbPool::connect(&tunneled_config, Some("rootpw".into())).await.expect("mysql through tunnel");
        let rows = pool.fetch_text_rows("SELECT DATABASE(), @@port").await.unwrap();
        assert_eq!(rows[0][0].as_deref(), Some("remote_db"));
        assert_eq!(rows[0][1].as_deref(), Some(MYSQL_PORT.to_string().as_str()));
        pool.close().await;
        tunnel.close().await;
        servers.stop_all().await;
        let _ = std::fs::remove_dir_all(&servers_root);
        let _ = std::fs::remove_file(&known_hosts);
    }
}

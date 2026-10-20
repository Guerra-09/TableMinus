use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;

use crate::{
    connections::{self, ConnectionConfig, Driver},
    db::{DbPool, QueryResult},
    error::{AppError, AppResult},
    introspect::{self, DbObject, TableStructure},
    local_server::{self, LocalServerManager, LocalServerStatus, ServerInstallation},
    mcp::{McpManager, McpStatus},
    ssh_tunnel::SshTunnel,
};

const SSH_KNOWN_HOSTS_FILE: &str = "known_hosts";

#[derive(Default)]
pub struct AppState {
    pools: RwLock<HashMap<String, DbPool>>,
    tunnels: RwLock<HashMap<String, SshTunnel>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedConnection {
    pub connection: ConnectionConfig,
    pub schemas: Vec<String>,
    pub current_schema: String,
    pub server_version: String,
}

impl AppState {
    async fn pool(&self, connection_id: &str) -> AppResult<DbPool> {
        self.pools
            .read()
            .await
            .get(connection_id)
            .cloned()
            .ok_or_else(|| AppError::Message("Connection is not open".into()))
    }

    /// Returns the open pool for a saved connection, connecting (and opening its
    /// SSH tunnel) on first use. Shared by the UI and the MCP server.
    pub async fn ensure_pool(&self, app: &AppHandle, connection: &ConnectionConfig) -> AppResult<DbPool> {
        if let Some(pool) = self.pools.read().await.get(&connection.id).cloned() {
            return Ok(pool);
        }
        let password = connections::read_password(&connection.id)?;
        let ssh_secret = connections::read_ssh_secret(&connection.id)?;
        let (pool, tunnel) = connect_database(app, connection, password, ssh_secret).await?;
        self.pools.write().await.insert(connection.id.clone(), pool.clone());
        if let Some(tunnel) = tunnel {
            self.tunnels.write().await.insert(connection.id.clone(), tunnel);
        }
        Ok(pool)
    }

    async fn close_session(&self, connection_id: &str) {
        if let Some(pool) = self.pools.write().await.remove(connection_id) {
            pool.close().await;
        }
        if let Some(tunnel) = self.tunnels.write().await.remove(connection_id) {
            tunnel.close().await;
        }
    }
}

/// Connects to the database, first opening an SSH tunnel when the connection is
/// configured to go through SSH. The database host and port are then resolved
/// from the SSH server's point of view.
async fn connect_database(
    app: &AppHandle,
    config: &ConnectionConfig,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<(DbPool, Option<SshTunnel>)> {
    let Some(ssh) = config.active_ssh() else {
        return Ok((DbPool::connect(config, password).await?, None));
    };
    let known_hosts_path = app.path().app_data_dir()?.join(SSH_KNOWN_HOSTS_FILE);
    let remote_host = if config.host.trim().is_empty() { "127.0.0.1" } else { config.host.trim() };
    let tunnel = SshTunnel::open(ssh, ssh_secret, remote_host, config.port, known_hosts_path).await?;
    let mut tunneled_config = config.clone();
    tunneled_config.host = "127.0.0.1".into();
    tunneled_config.port = tunnel.local_port;
    match DbPool::connect(&tunneled_config, password).await {
        Ok(pool) => Ok((pool, Some(tunnel))),
        Err(error) => {
            tunnel.close().await;
            Err(AppError::Message(format!("SSH tunnel is up, but the database connection failed: {error}")))
        }
    }
}

fn resolve_secret(provided: Option<String>, connection_id: &str, read_stored: fn(&str) -> AppResult<Option<String>>) -> AppResult<Option<String>> {
    match provided {
        Some(secret) => Ok(Some(secret)),
        None if !connection_id.is_empty() => read_stored(connection_id),
        None => Ok(None),
    }
}

async fn server_version(pool: &DbPool) -> AppResult<String> {
    let sql = match pool.driver() {
        Driver::Postgres => "SHOW server_version",
        Driver::Mysql => "SELECT VERSION()",
        Driver::Sqlite => "SELECT sqlite_version()",
    };
    let rows = pool.fetch_text_rows(sql).await?;
    Ok(rows.first().and_then(|row| row.first().cloned().flatten()).unwrap_or_default())
}

#[tauri::command]
pub async fn list_connections(app: AppHandle) -> AppResult<Vec<ConnectionConfig>> {
    connections::load_connections(&app)
}

#[tauri::command]
pub async fn save_connection(
    app: AppHandle,
    mut config: ConnectionConfig,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<ConnectionConfig> {
    if config.id.is_empty() {
        config.id = uuid::Uuid::new_v4().to_string();
    }
    if let Some(password) = password {
        connections::write_password(&config.id, &password)?;
    }
    if let Some(ssh_secret) = ssh_secret {
        connections::write_ssh_secret(&config.id, &ssh_secret)?;
    }
    let mut saved_connections = connections::load_connections(&app)?;
    match saved_connections.iter_mut().find(|connection| connection.id == config.id) {
        Some(existing) => *existing = config.clone(),
        None => saved_connections.push(config.clone()),
    }
    connections::store_connections(&app, &saved_connections)?;
    let _ = crate::menu::refresh_menu(&app);
    Ok(config)
}

#[tauri::command]
pub async fn delete_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    servers: State<'_, LocalServerManager>,
    id: String,
) -> AppResult<()> {
    state.close_session(&id).await;
    let _ = servers.stop(&id).await;
    let remaining_connections: Vec<ConnectionConfig> = connections::load_connections(&app)?
        .into_iter()
        .filter(|connection| connection.id != id)
        .collect();
    connections::store_connections(&app, &remaining_connections)?;
    let _ = crate::menu::refresh_menu(&app);
    connections::delete_ssh_secret(&id)?;
    connections::delete_password(&id)
}

#[tauri::command]
pub async fn test_connection(
    app: AppHandle,
    config: ConnectionConfig,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<String> {
    let resolved_password = resolve_secret(password, &config.id, connections::read_password)?;
    let resolved_ssh_secret = resolve_secret(ssh_secret, &config.id, connections::read_ssh_secret)?;
    let (pool, tunnel) = connect_database(&app, &config, resolved_password, resolved_ssh_secret).await?;
    let version = server_version(&pool).await;
    pool.close().await;
    let route = if tunnel.is_some() { " (via SSH tunnel)" } else { "" };
    if let Some(tunnel) = tunnel {
        tunnel.close().await;
    }
    Ok(format!("{}{route}", version?))
}

#[tauri::command]
pub async fn open_connection(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<OpenedConnection> {
    let connection = connections::find_connection(&app, &id)?;
    let pool = state.ensure_pool(&app, &connection).await?;
    Ok(OpenedConnection {
        schemas: introspect::list_schemas(&pool).await?,
        current_schema: introspect::current_schema(&pool).await?,
        server_version: server_version(&pool).await?,
        connection,
    })
}

#[tauri::command]
pub async fn close_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.close_session(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn list_schemas(state: State<'_, AppState>, id: String) -> AppResult<Vec<String>> {
    introspect::list_schemas(&state.pool(&id).await?).await
}

#[tauri::command]
pub async fn list_objects(state: State<'_, AppState>, id: String, schema: String) -> AppResult<Vec<DbObject>> {
    introspect::list_objects(&state.pool(&id).await?, &schema).await
}

#[tauri::command]
pub async fn get_table_structure(
    state: State<'_, AppState>,
    id: String,
    schema: String,
    table: String,
) -> AppResult<TableStructure> {
    introspect::table_structure(&state.pool(&id).await?, &schema, &table).await
}

#[tauri::command]
pub async fn execute_query(state: State<'_, AppState>, id: String, sql: String) -> AppResult<QueryResult> {
    state.pool(&id).await?.execute(&sql).await
}

#[tauri::command]
pub async fn execute_transaction(
    state: State<'_, AppState>,
    id: String,
    statements: Vec<String>,
) -> AppResult<u64> {
    state.pool(&id).await?.execute_transaction(&statements).await
}

#[tauri::command]
pub async fn execute_transaction_ignoring_foreign_keys(
    state: State<'_, AppState>,
    id: String,
    statements: Vec<String>,
) -> AppResult<u64> {
    state.pool(&id).await?.execute_transaction_ignoring_foreign_keys(&statements).await
}

#[tauri::command]
pub async fn read_text_file(path: String) -> AppResult<String> {
    Ok(tokio::fs::read_to_string(path).await?)
}

#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> AppResult<()> {
    Ok(tokio::fs::write(path, content).await?)
}

#[tauri::command]
pub async fn detect_server_installations(driver: Driver) -> AppResult<Vec<ServerInstallation>> {
    Ok(tauri::async_runtime::spawn_blocking(move || local_server::detect_installations(driver))
        .await
        .map_err(|error| AppError::Message(error.to_string()))?)
}

#[tauri::command]
pub async fn local_server_statuses(
    app: AppHandle,
    servers: State<'_, LocalServerManager>,
) -> AppResult<Vec<LocalServerStatus>> {
    let saved_connections = connections::load_connections(&app)?;
    Ok(servers.statuses(&saved_connections).await)
}

#[tauri::command]
pub async fn start_local_server(app: AppHandle, servers: State<'_, LocalServerManager>, id: String) -> AppResult<()> {
    let connection = connections::find_connection(&app, &id)?;
    let password = connections::read_password(&id)?;
    servers.start(&local_server::servers_root_directory(&app)?, &connection, password).await
}

#[tauri::command]
pub async fn stop_local_server(
    state: State<'_, AppState>,
    servers: State<'_, LocalServerManager>,
    id: String,
) -> AppResult<()> {
    state.close_session(&id).await;
    servers.stop(&id).await
}

#[tauri::command]
pub async fn read_local_server_log(app: AppHandle, id: String) -> AppResult<String> {
    let connection = connections::find_connection(&app, &id)?;
    LocalServerManager::read_log(&local_server::servers_root_directory(&app)?, &connection)
}

#[tauri::command]
pub async fn get_mcp_status(app: AppHandle, mcp: State<'_, McpManager>) -> AppResult<McpStatus> {
    mcp.status(&app).await
}

#[tauri::command]
pub async fn update_mcp_settings(
    app: AppHandle,
    mcp: State<'_, McpManager>,
    is_enabled: bool,
    port: u16,
) -> AppResult<McpStatus> {
    mcp.update_settings(&app, is_enabled, port).await
}

#[tauri::command]
pub async fn regenerate_mcp_token(app: AppHandle, mcp: State<'_, McpManager>) -> AppResult<McpStatus> {
    mcp.regenerate_token(&app).await
}

#[tauri::command]
pub async fn resolve_mcp_approval(mcp: State<'_, McpManager>, id: String, is_approved: bool) -> AppResult<()> {
    mcp.resolve_approval(&id, is_approved).await;
    Ok(())
}

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::sync::RwLock;

use crate::{
    connections::{self, ConnectionConfig, Driver},
    db::{DbPool, QueryResult},
    error::{AppError, AppResult},
    introspect::{self, DbObject, TableStructure},
    local_server::{self, LocalServerManager, LocalServerStatus, ServerInstallation},
};

#[derive(Default)]
pub struct AppState {
    pools: RwLock<HashMap<String, DbPool>>,
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
) -> AppResult<ConnectionConfig> {
    if config.id.is_empty() {
        config.id = uuid::Uuid::new_v4().to_string();
    }
    if let Some(password) = password {
        connections::write_password(&config.id, &password)?;
    }
    let mut saved_connections = connections::load_connections(&app)?;
    match saved_connections.iter_mut().find(|connection| connection.id == config.id) {
        Some(existing) => *existing = config.clone(),
        None => saved_connections.push(config.clone()),
    }
    connections::store_connections(&app, &saved_connections)?;
    Ok(config)
}

#[tauri::command]
pub async fn delete_connection(
    app: AppHandle,
    state: State<'_, AppState>,
    servers: State<'_, LocalServerManager>,
    id: String,
) -> AppResult<()> {
    if let Some(pool) = state.pools.write().await.remove(&id) {
        pool.close().await;
    }
    let _ = servers.stop(&id).await;
    let remaining_connections: Vec<ConnectionConfig> = connections::load_connections(&app)?
        .into_iter()
        .filter(|connection| connection.id != id)
        .collect();
    connections::store_connections(&app, &remaining_connections)?;
    connections::delete_password(&id)
}

#[tauri::command]
pub async fn test_connection(config: ConnectionConfig, password: Option<String>) -> AppResult<String> {
    let resolved_password = match password {
        Some(password) => Some(password),
        None if !config.id.is_empty() => connections::read_password(&config.id)?,
        None => None,
    };
    let pool = DbPool::connect(&config, resolved_password).await?;
    let version = server_version(&pool).await;
    pool.close().await;
    version
}

#[tauri::command]
pub async fn open_connection(app: AppHandle, state: State<'_, AppState>, id: String) -> AppResult<OpenedConnection> {
    let connection = connections::find_connection(&app, &id)?;
    let existing_pool = state.pools.read().await.get(&id).cloned();
    let pool = match existing_pool {
        Some(pool) => pool,
        None => {
            let password = connections::read_password(&id)?;
            let pool = DbPool::connect(&connection, password).await?;
            state.pools.write().await.insert(id.clone(), pool.clone());
            pool
        }
    };
    Ok(OpenedConnection {
        schemas: introspect::list_schemas(&pool).await?,
        current_schema: introspect::current_schema(&pool).await?,
        server_version: server_version(&pool).await?,
        connection,
    })
}

#[tauri::command]
pub async fn close_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if let Some(pool) = state.pools.write().await.remove(&id) {
        pool.close().await;
    }
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
    if let Some(pool) = state.pools.write().await.remove(&id) {
        pool.close().await;
    }
    servers.stop(&id).await
}

#[tauri::command]
pub async fn read_local_server_log(app: AppHandle, id: String) -> AppResult<String> {
    let connection = connections::find_connection(&app, &id)?;
    LocalServerManager::read_log(&local_server::servers_root_directory(&app)?, &connection)
}

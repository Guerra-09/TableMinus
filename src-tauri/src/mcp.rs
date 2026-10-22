use std::{collections::HashMap, fs, path::PathBuf, time::Duration};

use axum::{
    body::Bytes,
    extract::State as AxumState,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, UserAttentionType};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Mutex},
};

use crate::{
    commands::AppState,
    connections::{self, ConnectionConfig},
    db::QueryResult,
    error::{AppError, AppResult},
    introspect,
};

const MCP_SETTINGS_FILE: &str = "mcp.json";
const MCP_PATH: &str = "/mcp";
const DEFAULT_MCP_PORT: u16 = 47821;
const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_RESULT_ROWS: usize = 200;
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(180);
const PRODUCTION_TAG: &str = "production";
const APPROVAL_REQUEST_EVENT: &str = "mcp-approval-request";
const APPROVAL_CLOSED_EVENT: &str = "mcp-approval-closed";
const ACTIVITY_EVENT: &str = "mcp-activity";
const JSON_RPC_METHOD_NOT_FOUND: i64 = -32601;
const JSON_RPC_INVALID_PARAMS: i64 = -32602;
const JSON_RPC_PARSE_ERROR: i64 = -32700;

const READ_KEYWORDS: [&str; 9] = ["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH", "PRAGMA", "VALUES", "TABLE"];
const WRITE_KEYWORDS: [&str; 21] = [
    "INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT", "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME", "GRANT",
    "REVOKE", "CALL", "DO", "COPY", "LOCK", "SET", "INTO", "LOAD", "HANDLER",
];

const SERVER_INSTRUCTIONS: &str = "TableMinus gives you access to the user's saved database connections. \
Access depends on each connection: connections tagged Production are strictly read-only — never try to modify them; \
instead, write the exact SQL and give it to the user so they can review and run it themselves in TableMinus. \
Other connections follow their safe mode: some statements require the user to approve them in the TableMinus window, \
so tell the user when you are waiting for approval. Send one SQL statement per run_query call and prefer LIMIT on large tables.";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSettings {
    pub is_enabled: bool,
    pub port: u16,
    pub token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub settings: McpSettings,
    pub is_running: bool,
    pub endpoint: String,
    pub last_error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalRequest {
    id: String,
    connection_name: String,
    tag: String,
    sql: String,
    reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityEvent {
    connection_name: String,
    sql: String,
    duration_ms: Option<u64>,
    error: Option<String>,
}

struct RunningServer {
    port: u16,
    shutdown: oneshot::Sender<()>,
}

#[derive(Default)]
pub struct McpManager {
    server: Mutex<Option<RunningServer>>,
    last_error: Mutex<Option<String>>,
    approvals: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

#[derive(Clone)]
struct HttpState {
    app: AppHandle,
    token: String,
}

#[derive(Debug, PartialEq, Eq)]
enum AccessDecision {
    Allow { is_read_only: bool },
    NeedsApproval { is_read_only: bool },
    Deny(String),
}

fn generate_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

fn settings_path(app: &AppHandle) -> AppResult<PathBuf> {
    let directory = app.path().app_data_dir()?;
    fs::create_dir_all(&directory)?;
    Ok(directory.join(MCP_SETTINGS_FILE))
}

pub fn load_settings(app: &AppHandle) -> AppResult<McpSettings> {
    let path = settings_path(app)?;
    if path.exists() {
        return Ok(serde_json::from_str(&fs::read_to_string(path)?)?);
    }
    let settings = McpSettings { is_enabled: false, port: DEFAULT_MCP_PORT, token: generate_token() };
    save_settings(app, &settings)?;
    Ok(settings)
}

fn save_settings(app: &AppHandle, settings: &McpSettings) -> AppResult<()> {
    let path = settings_path(app)?;
    fs::write(&path, serde_json::to_string_pretty(settings)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn endpoint_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}{MCP_PATH}")
}

/// Removes string literals, quoted identifiers and comments so keyword checks
/// only see SQL syntax, e.g. a column named `update` or a value 'drop' is ignored.
fn strip_literals_and_comments(sql: &str) -> String {
    let characters: Vec<char> = sql.chars().collect();
    let mut stripped = String::with_capacity(sql.len());
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        let next_character = characters.get(index + 1).copied();
        if character == '-' && next_character == Some('-') || character == '#' {
            while index < characters.len() && characters[index] != '\n' {
                index += 1;
            }
            stripped.push(' ');
            continue;
        }
        if character == '/' && next_character == Some('*') {
            index += 2;
            while index + 1 < characters.len() && !(characters[index] == '*' && characters[index + 1] == '/') {
                index += 1;
            }
            index += 2;
            stripped.push(' ');
            continue;
        }
        if matches!(character, '\'' | '"' | '`') {
            index += 1;
            while index < characters.len() {
                if characters[index] == '\\' && character == '\'' {
                    index += 2;
                    continue;
                }
                if characters[index] == character {
                    if characters.get(index + 1) == Some(&character) {
                        index += 2;
                        continue;
                    }
                    break;
                }
                index += 1;
            }
            index += 1;
            stripped.push_str(" ? ");
            continue;
        }
        stripped.push(character);
        index += 1;
    }
    stripped
}

/// Classifies a single SQL statement. Returns `Ok(true)` for reads, `Ok(false)`
/// for anything that may write, and an error when several statements are sent.
fn classify_statement(sql: &str) -> Result<bool, String> {
    let stripped = strip_literals_and_comments(sql);
    let trimmed = stripped.trim().trim_end_matches(|character: char| character == ';' || character.is_whitespace());
    if trimmed.is_empty() {
        return Err("The SQL statement is empty.".into());
    }
    if trimmed.contains(';') {
        return Err("Send one SQL statement per run_query call.".into());
    }
    let uppercase = trimmed.to_uppercase();
    let words: Vec<&str> = uppercase
        .split(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
        .filter(|word| !word.is_empty())
        .collect();
    let starts_with_read_keyword = words.first().is_some_and(|first_word| READ_KEYWORDS.contains(first_word));
    let has_write_keyword = words.iter().any(|word| WRITE_KEYWORDS.contains(word));
    let is_pragma_assignment = words.first() == Some(&"PRAGMA") && uppercase.contains('=');
    Ok(starts_with_read_keyword && !has_write_keyword && !is_pragma_assignment)
}

fn decide_access(connection: &ConnectionConfig, is_read: bool) -> AccessDecision {
    if connection.tag.eq_ignore_ascii_case(PRODUCTION_TAG) && !is_read {
        return AccessDecision::Deny(format!(
            "Blocked: \"{}\" is tagged Production, so TableMinus only allows read-only queries through MCP. \
Do not retry or work around this. Give the user the exact SQL so they can review it and run it themselves in TableMinus.",
            connection.name
        ));
    }
    match connection.safe_mode.as_str() {
        "alert" => AccessDecision::NeedsApproval { is_read_only: is_read },
        "alert-writes" if !is_read => AccessDecision::NeedsApproval { is_read_only: false },
        _ => AccessDecision::Allow { is_read_only: is_read },
    }
}

fn tag_label(connection: &ConnectionConfig) -> String {
    if connection.tag.is_empty() {
        "local".into()
    } else {
        connection.tag.clone()
    }
}

fn describe_access(connection: &ConnectionConfig) -> &'static str {
    if connection.tag.eq_ignore_ascii_case(PRODUCTION_TAG) {
        return match connection.safe_mode.as_str() {
            "alert" => "read-only (each query needs user approval); writes blocked — give SQL to the user",
            _ => "read-only; writes blocked — give SQL to the user",
        };
    }
    match connection.safe_mode.as_str() {
        "alert" => "read and write; every query needs user approval in TableMinus",
        "alert-writes" => "reads allowed; writes need user approval in TableMinus",
        _ => "read and write",
    }
}

fn find_connection(app: &AppHandle, reference: &str) -> Result<ConnectionConfig, String> {
    let saved_connections = connections::load_connections(app).map_err(|error| error.to_string())?;
    let normalized_reference = reference.trim().to_lowercase();
    saved_connections
        .iter()
        .find(|connection| connection.id == reference.trim() || connection.name.to_lowercase() == normalized_reference)
        .cloned()
        .ok_or_else(|| {
            let available: Vec<&str> = saved_connections.iter().map(|connection| connection.name.as_str()).collect();
            format!("Connection \"{reference}\" not found. Available connections: {}", available.join(", "))
        })
}

fn string_argument(arguments: &Value, name: &str) -> Result<String, String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Missing required argument \"{name}\""))
}

fn optional_string_argument(arguments: &Value, name: &str) -> Option<String> {
    arguments.get(name).and_then(Value::as_str).map(str::to_string).filter(|value| !value.trim().is_empty())
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "list_connections",
            "title": "List connections",
            "description": "List the database connections saved in TableMinus with their driver, database, environment tag and what this assistant is allowed to do on each. Never returns credentials.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "list_tables",
            "title": "List tables",
            "description": "List tables and views of a connection. Uses the connection's default schema/database unless one is given.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name (as shown by list_connections) or id" },
                    "schema": { "type": "string", "description": "Schema (PostgreSQL), database (MySQL) or attached database (SQLite)" }
                },
                "required": ["connection"]
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "describe_table",
            "title": "Describe table",
            "description": "Columns, types, nullability, defaults, primary key, indexes, foreign keys and the CREATE definition of a table or view.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "table": { "type": "string", "description": "Table or view name" },
                    "schema": { "type": "string", "description": "Optional schema/database" }
                },
                "required": ["connection", "table"]
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "run_query",
            "title": "Run SQL query",
            "description": "Run ONE SQL statement on a connection. Results are limited to 200 rows. Production connections are read-only: for changes there, give the SQL to the user instead. Depending on the connection's safe mode, the user may have to approve the statement in the TableMinus window first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": { "type": "string", "description": "Connection name or id" },
                    "sql": { "type": "string", "description": "A single SQL statement" }
                },
                "required": ["connection", "sql"]
            },
            "annotations": { "destructiveHint": true }
        }
    ])
}

fn format_query_result(result: &QueryResult, access_mode: &str) -> Value {
    json!({
        "columns": result.columns.iter().map(|column| column.name.clone()).collect::<Vec<_>>(),
        "rows": result.rows,
        "rowCount": result.rows.len(),
        "rowsAffected": result.rows_affected,
        "truncated": result.is_truncated,
        "durationMs": result.duration_ms,
        "accessMode": access_mode,
    })
}

impl McpManager {
    pub async fn apply(&self, app: &AppHandle) -> AppResult<()> {
        self.stop().await;
        let settings = load_settings(app)?;
        if !settings.is_enabled {
            *self.last_error.lock().await = None;
            return Ok(());
        }
        match start_server(app.clone(), &settings).await {
            Ok(server) => {
                *self.server.lock().await = Some(server);
                *self.last_error.lock().await = None;
                Ok(())
            }
            Err(error) => {
                *self.last_error.lock().await = Some(error.to_string());
                Err(error)
            }
        }
    }

    pub async fn stop(&self) {
        if let Some(server) = self.server.lock().await.take() {
            let _ = server.shutdown.send(());
        }
    }

    pub async fn status(&self, app: &AppHandle) -> AppResult<McpStatus> {
        let settings = load_settings(app)?;
        let running_port = self.server.lock().await.as_ref().map(|server| server.port);
        Ok(McpStatus {
            endpoint: endpoint_for(running_port.unwrap_or(settings.port)),
            is_running: running_port.is_some(),
            last_error: self.last_error.lock().await.clone(),
            settings,
        })
    }

    pub async fn update_settings(&self, app: &AppHandle, is_enabled: bool, port: u16) -> AppResult<McpStatus> {
        let mut settings = load_settings(app)?;
        settings.is_enabled = is_enabled;
        settings.port = if port == 0 { DEFAULT_MCP_PORT } else { port };
        save_settings(app, &settings)?;
        let _ = self.apply(app).await;
        self.status(app).await
    }

    pub async fn regenerate_token(&self, app: &AppHandle) -> AppResult<McpStatus> {
        let mut settings = load_settings(app)?;
        settings.token = generate_token();
        save_settings(app, &settings)?;
        let _ = self.apply(app).await;
        self.status(app).await
    }

    pub async fn resolve_approval(&self, request_id: &str, is_approved: bool) {
        if let Some(sender) = self.approvals.lock().await.remove(request_id) {
            let _ = sender.send(is_approved);
        }
    }
}

async fn start_server(app: AppHandle, settings: &McpSettings) -> AppResult<RunningServer> {
    let listener = TcpListener::bind(("127.0.0.1", settings.port))
        .await
        .map_err(|error| AppError::Message(format!("Cannot start MCP server on port {}: {error}", settings.port)))?;
    let state = HttpState { app, token: settings.token.clone() };
    let router = Router::new()
        .route(MCP_PATH, post(handle_post).get(handle_unsupported).delete(handle_unsupported))
        .with_state(state);
    let (shutdown_sender, shutdown_receiver) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_receiver.await;
            })
            .await;
    });
    Ok(RunningServer { port: settings.port, shutdown: shutdown_sender })
}

fn is_local_origin(headers: &HeaderMap) -> bool {
    match headers.get("origin").and_then(|origin| origin.to_str().ok()) {
        None => true,
        Some(origin) => ["http://127.0.0.1", "http://localhost"].iter().any(|prefix| origin.starts_with(prefix)),
    }
}

fn is_authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|provided| provided.trim() == token)
}

async fn handle_unsupported() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}

async fn handle_post(AxumState(state): AxumState<HttpState>, headers: HeaderMap, body: Bytes) -> Response {
    if !is_local_origin(&headers) {
        return (StatusCode::FORBIDDEN, "Forbidden origin").into_response();
    }
    if !is_authorized(&headers, &state.token) {
        return (StatusCode::UNAUTHORIZED, "Missing or invalid bearer token").into_response();
    }
    let message: Value = match serde_json::from_slice(&body) {
        Ok(message) => message,
        Err(error) => {
            return Json(json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": { "code": JSON_RPC_PARSE_ERROR, "message": format!("Parse error: {error}") }
            }))
            .into_response()
        }
    };
    match message {
        Value::Array(messages) => {
            let mut responses = Vec::new();
            for single_message in messages {
                if let Some(response) = handle_message(&state.app, single_message).await {
                    responses.push(response);
                }
            }
            if responses.is_empty() {
                StatusCode::ACCEPTED.into_response()
            } else {
                Json(Value::Array(responses)).into_response()
            }
        }
        single_message => match handle_message(&state.app, single_message).await {
            Some(response) => Json(response).into_response(),
            None => StatusCode::ACCEPTED.into_response(),
        },
    }
}

async fn handle_message(app: &AppHandle, message: Value) -> Option<Value> {
    let id = message.get("id").cloned()?;
    let method = message.get("method").and_then(Value::as_str).unwrap_or_default();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let outcome = match method {
        "initialize" => Ok(initialize_result(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => call_tool(app, &params).await,
        _ => Err((JSON_RPC_METHOD_NOT_FOUND, format!("Method not found: {method}"))),
    };
    Some(match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, error_message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": error_message } }),
    })
}

fn initialize_result(params: &Value) -> Value {
    let requested_version = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(LATEST_PROTOCOL_VERSION);
    let protocol_version =
        if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested_version) { requested_version } else { LATEST_PROTOCOL_VERSION };
    json!({
        "protocolVersion": protocol_version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "tableminus", "title": "TableMinus", "version": env!("CARGO_PKG_VERSION") },
        "instructions": SERVER_INSTRUCTIONS,
    })
}

async fn call_tool(app: &AppHandle, params: &Value) -> Result<Value, (i64, String)> {
    let tool_name = params.get("name").and_then(Value::as_str).unwrap_or_default();
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let tool_outcome = match tool_name {
        "list_connections" => list_connections_tool(app),
        "list_tables" => list_tables_tool(app, &arguments).await,
        "describe_table" => describe_table_tool(app, &arguments).await,
        "run_query" => run_query_tool(app, &arguments).await,
        _ => return Err((JSON_RPC_INVALID_PARAMS, format!("Unknown tool: {tool_name}"))),
    };
    Ok(match tool_outcome {
        Ok(content) => json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&content).unwrap_or_default() }],
            "isError": false
        }),
        Err(error_message) => json!({ "content": [{ "type": "text", "text": error_message }], "isError": true }),
    })
}

fn list_connections_tool(app: &AppHandle) -> Result<Value, String> {
    let saved_connections = connections::load_connections(app).map_err(|error| error.to_string())?;
    Ok(Value::Array(
        saved_connections
            .iter()
            .map(|connection| {
                json!({
                    "name": connection.name,
                    "id": connection.id,
                    "driver": connection.driver,
                    "database": if connection.database.is_empty() { connection.file_path.clone() } else { connection.database.clone() },
                    "tag": tag_label(connection),
                    "viaSsh": connection.active_ssh().is_some(),
                    "access": describe_access(connection),
                })
            })
            .collect(),
    ))
}

async fn resolve_schema(pool: &crate::db::DbPool, requested_schema: Option<String>) -> Result<String, String> {
    match requested_schema {
        Some(schema) => Ok(schema),
        None => introspect::current_schema(pool).await.map_err(|error| error.to_string()),
    }
}

async fn open_pool(app: &AppHandle, connection: &ConnectionConfig) -> Result<crate::db::DbPool, String> {
    app.state::<AppState>()
        .ensure_pool(app, connection)
        .await
        .map_err(|error| format!("Cannot connect to \"{}\": {error}", connection.name))
}

async fn list_tables_tool(app: &AppHandle, arguments: &Value) -> Result<Value, String> {
    let connection = find_connection(app, &string_argument(arguments, "connection")?)?;
    let pool = open_pool(app, &connection).await?;
    let schema = resolve_schema(&pool, optional_string_argument(arguments, "schema")).await?;
    let objects = introspect::list_objects(&pool, &schema).await.map_err(|error| error.to_string())?;
    Ok(json!({ "schema": schema, "objects": objects }))
}

async fn describe_table_tool(app: &AppHandle, arguments: &Value) -> Result<Value, String> {
    let connection = find_connection(app, &string_argument(arguments, "connection")?)?;
    let table = string_argument(arguments, "table")?;
    let pool = open_pool(app, &connection).await?;
    let schema = resolve_schema(&pool, optional_string_argument(arguments, "schema")).await?;
    let structure = introspect::table_structure(&pool, &schema, &table).await.map_err(|error| error.to_string())?;
    if structure.columns.is_empty() {
        return Err(format!("Table \"{table}\" not found in \"{schema}\"."));
    }
    Ok(json!({ "schema": schema, "table": table, "structure": structure }))
}

async fn run_query_tool(app: &AppHandle, arguments: &Value) -> Result<Value, String> {
    let connection = find_connection(app, &string_argument(arguments, "connection")?)?;
    let sql = string_argument(arguments, "sql")?;
    let is_read = classify_statement(&sql)?;

    let is_read_only = match decide_access(&connection, is_read) {
        AccessDecision::Deny(reason) => {
            emit_activity(app, &connection, &sql, None, Some("Blocked: production is read-only".into()));
            return Err(reason);
        }
        AccessDecision::Allow { is_read_only } => is_read_only,
        AccessDecision::NeedsApproval { is_read_only } => {
            let reason = if is_read_only {
                "This connection asks for confirmation on every query."
            } else {
                "This statement can modify data."
            };
            if !request_approval(app, &connection, &sql, reason).await {
                emit_activity(app, &connection, &sql, None, Some("Rejected by user".into()));
                return Err("The user rejected this statement in TableMinus. Do not retry it unless the user asks; explain what you intended instead.".into());
            }
            is_read_only
        }
    };

    let pool = open_pool(app, &connection).await?;
    let execution = if is_read_only {
        pool.execute_read_only(&sql, Some(MAX_RESULT_ROWS)).await
    } else {
        pool.execute_limited(&sql, Some(MAX_RESULT_ROWS)).await
    };
    match execution {
        Ok(result) => {
            emit_activity(app, &connection, &sql, Some(result.duration_ms), None);
            Ok(format_query_result(&result, if is_read_only { "read-only" } else { "read-write" }))
        }
        Err(error) => {
            let error_message = error.to_string();
            emit_activity(app, &connection, &sql, None, Some(error_message.clone()));
            Err(format!("Database error: {error_message}"))
        }
    }
}

fn emit_activity(app: &AppHandle, connection: &ConnectionConfig, sql: &str, duration_ms: Option<u64>, error: Option<String>) {
    let _ = app.emit(
        ACTIVITY_EVENT,
        ActivityEvent { connection_name: connection.name.clone(), sql: sql.to_string(), duration_ms, error },
    );
}

async fn request_approval(app: &AppHandle, connection: &ConnectionConfig, sql: &str, reason: &str) -> bool {
    let manager = app.state::<McpManager>();
    let request_id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    manager.approvals.lock().await.insert(request_id.clone(), sender);

    let request = ApprovalRequest {
        id: request_id.clone(),
        connection_name: connection.name.clone(),
        tag: tag_label(connection),
        sql: sql.to_string(),
        reason: reason.to_string(),
    };
    if app.emit(APPROVAL_REQUEST_EVENT, request).is_err() {
        manager.approvals.lock().await.remove(&request_id);
        return false;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.request_user_attention(Some(UserAttentionType::Critical));
    }

    let is_approved = matches!(tokio::time::timeout(APPROVAL_TIMEOUT, receiver).await, Ok(Ok(true)));
    manager.approvals.lock().await.remove(&request_id);
    let _ = app.emit(APPROVAL_CLOSED_EVENT, request_id);
    is_approved
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::Driver;

    fn connection(tag: &str, safe_mode: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: "id".into(),
            name: "test".into(),
            driver: Driver::Mysql,
            host: "127.0.0.1".into(),
            port: 3306,
            user: "root".into(),
            database: "app".into(),
            file_path: String::new(),
            tag: tag.into(),
            color: String::new(),
            safe_mode: safe_mode.into(),
            folder: String::new(),
            local_server: None,
            ssh: None,
        }
    }

    #[test]
    fn classifies_reads_and_writes() {
        assert_eq!(classify_statement("SELECT * FROM users"), Ok(true));
        assert_eq!(classify_statement("  select 1;  "), Ok(true));
        assert_eq!(classify_statement("SHOW TABLES"), Ok(true));
        assert_eq!(classify_statement("EXPLAIN SELECT * FROM orders"), Ok(true));
        assert_eq!(classify_statement("WITH recent AS (SELECT 1) SELECT * FROM recent"), Ok(true));
        assert_eq!(classify_statement("SELECT 'drop table users' AS note, `update` FROM t -- delete"), Ok(true));
        assert_eq!(classify_statement("UPDATE users SET name = 'a'"), Ok(false));
        assert_eq!(classify_statement("DELETE FROM users"), Ok(false));
        assert_eq!(classify_statement("WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone"), Ok(false));
        assert_eq!(classify_statement("SELECT * INTO backup FROM users"), Ok(false));
        assert_eq!(classify_statement("EXPLAIN ANALYZE DELETE FROM users"), Ok(false));
        assert_eq!(classify_statement("PRAGMA foreign_keys = OFF"), Ok(false));
        assert_eq!(classify_statement("CREATE TABLE t (id int)"), Ok(false));
        assert!(classify_statement("SELECT 1; DROP TABLE users").is_err());
        assert!(classify_statement("  ;  ").is_err());
        assert_eq!(classify_statement("SELECT 'a;b' AS text"), Ok(true));
    }

    #[test]
    fn production_is_read_only() {
        assert_eq!(decide_access(&connection("production", "silent"), true), AccessDecision::Allow { is_read_only: true });
        assert!(matches!(decide_access(&connection("production", "silent"), false), AccessDecision::Deny(_)));
        assert!(matches!(decide_access(&connection("Production", "alert-writes"), false), AccessDecision::Deny(_)));
        assert_eq!(
            decide_access(&connection("production", "alert"), true),
            AccessDecision::NeedsApproval { is_read_only: true }
        );
    }

    #[test]
    fn safe_mode_controls_approval() {
        assert_eq!(decide_access(&connection("development", "silent"), false), AccessDecision::Allow { is_read_only: false });
        assert_eq!(decide_access(&connection("development", ""), true), AccessDecision::Allow { is_read_only: true });
        assert_eq!(
            decide_access(&connection("development", "alert-writes"), true),
            AccessDecision::Allow { is_read_only: true }
        );
        assert_eq!(
            decide_access(&connection("development", "alert-writes"), false),
            AccessDecision::NeedsApproval { is_read_only: false }
        );
        assert_eq!(
            decide_access(&connection("local", "alert"), true),
            AccessDecision::NeedsApproval { is_read_only: true }
        );
    }
}

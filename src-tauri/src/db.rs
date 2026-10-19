use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use serde::Serialize;
use serde_json::{Number, Value};
use sqlx::{
    mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow},
    postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow},
    sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow},
    Column, Either, Row, TypeInfo, ValueRef,
};

use crate::{
    connections::{ConnectionConfig, Driver},
    error::{AppError, AppResult},
};

const MAX_POOL_CONNECTIONS: u32 = 5;
const ACQUIRE_TIMEOUT_SECONDS: u64 = 10;
const MAX_SAFE_JS_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Clone)]
pub enum DbPool {
    Postgres(PgPool),
    Mysql(MySqlPool),
    Sqlite(SqlitePool),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    pub rows_affected: u64,
    pub duration_ms: u64,
    pub is_truncated: bool,
}

macro_rules! collect_raw_results {
    ($executor:expr, $sql:expr, $decode:expr, $max_rows:expr) => {{
        let mut columns: Vec<ColumnMeta> = Vec::new();
        let mut rows: Vec<Vec<Value>> = Vec::new();
        let mut rows_affected: u64 = 0;
        let mut is_truncated = false;
        let max_rows: Option<usize> = $max_rows;
        #[allow(deprecated)]
        let mut stream = sqlx::Executor::fetch_many($executor, $sql);
        while let Some(item) = stream.try_next().await? {
            match item {
                Either::Left(done) => rows_affected += done.rows_affected(),
                Either::Right(row) => {
                    if max_rows.is_some_and(|limit| rows.len() >= limit) {
                        is_truncated = true;
                        break;
                    }
                    if columns.is_empty() {
                        columns = row
                            .columns()
                            .iter()
                            .map(|column| ColumnMeta {
                                name: column.name().to_string(),
                                type_name: column.type_info().name().to_string(),
                            })
                            .collect();
                    }
                    rows.push((0..row.len()).map(|index| $decode(&row, index)).collect());
                }
            }
        }
        (columns, rows, rows_affected, is_truncated)
    }};
}

macro_rules! collect_read_only {
    ($pool:expr, $connection_type:ty, $sql:expr, $decode:expr, $max_rows:expr, $begin_sql:expr, $end_sql:expr) => {{
        let mut pooled_connection = $pool.acquire().await?;
        let connection: &mut $connection_type = &mut pooled_connection;
        sqlx::Executor::execute(&mut *connection, $begin_sql).await?;
        let outcome: AppResult<_> = async { Ok(collect_raw_results!(&mut *connection, $sql, $decode, $max_rows)) }.await;
        let _ = sqlx::Executor::execute(&mut *connection, $end_sql).await;
        outcome?
    }};
}

macro_rules! execute_in_transaction {
    ($pool:expr, $statements:expr, $connection_type:ty) => {{
        let mut transaction = $pool.begin().await?;
        let mut rows_affected: u64 = 0;
        for statement in $statements.iter() {
            let connection: &mut $connection_type = &mut transaction;
            rows_affected += sqlx::Executor::execute(connection, statement.as_str()).await?.rows_affected();
        }
        transaction.commit().await?;
        rows_affected
    }};
}

impl DbPool {
    pub async fn connect(config: &ConnectionConfig, password: Option<String>) -> AppResult<Self> {
        let acquire_timeout = Duration::from_secs(ACQUIRE_TIMEOUT_SECONDS);
        match config.driver {
            Driver::Postgres => {
                let mut options = PgConnectOptions::new()
                    .host(&config.host)
                    .port(config.port)
                    .username(&config.user)
                    .application_name("tableminus");
                if !config.database.is_empty() {
                    options = options.database(&config.database);
                }
                if let Some(password) = password.as_deref() {
                    options = options.password(password);
                }
                let pool = PgPoolOptions::new()
                    .max_connections(MAX_POOL_CONNECTIONS)
                    .acquire_timeout(acquire_timeout)
                    .connect_with(options)
                    .await?;
                Ok(Self::Postgres(pool))
            }
            Driver::Mysql => {
                let mut options = MySqlConnectOptions::new()
                    .host(&config.host)
                    .port(config.port)
                    .username(&config.user);
                if !config.database.is_empty() {
                    options = options.database(&config.database);
                }
                if let Some(password) = password.as_deref() {
                    options = options.password(password);
                }
                let pool = MySqlPoolOptions::new()
                    .max_connections(MAX_POOL_CONNECTIONS)
                    .acquire_timeout(acquire_timeout)
                    .connect_with(options)
                    .await?;
                Ok(Self::Mysql(pool))
            }
            Driver::Sqlite => {
                if config.file_path.is_empty() {
                    return Err(AppError::Message("SQLite connection requires a file path".into()));
                }
                let options = SqliteConnectOptions::new()
                    .filename(&config.file_path)
                    .create_if_missing(true)
                    .foreign_keys(true);
                let pool = SqlitePoolOptions::new()
                    .max_connections(MAX_POOL_CONNECTIONS)
                    .acquire_timeout(acquire_timeout)
                    .connect_with(options)
                    .await?;
                Ok(Self::Sqlite(pool))
            }
        }
    }

    pub fn driver(&self) -> Driver {
        match self {
            Self::Postgres(_) => Driver::Postgres,
            Self::Mysql(_) => Driver::Mysql,
            Self::Sqlite(_) => Driver::Sqlite,
        }
    }

    pub async fn close(&self) {
        match self {
            Self::Postgres(pool) => pool.close().await,
            Self::Mysql(pool) => pool.close().await,
            Self::Sqlite(pool) => pool.close().await,
        }
    }

    /// Runs raw SQL through the simple/text protocol so any column type can be
    /// rendered as text without per-type decoders, then coerces numeric and
    /// boolean columns back into JSON scalars using the reported type name.
    pub async fn execute(&self, sql: &str) -> AppResult<QueryResult> {
        self.execute_limited(sql, None).await
    }

    pub async fn execute_limited(&self, sql: &str, max_rows: Option<usize>) -> AppResult<QueryResult> {
        let started_at = Instant::now();
        let (columns, rows, rows_affected, is_truncated) = match self {
            Self::Postgres(pool) => collect_raw_results!(pool, sql, decode_postgres_value, max_rows),
            Self::Mysql(pool) => collect_raw_results!(pool, sql, decode_mysql_value, max_rows),
            Self::Sqlite(pool) => collect_raw_results!(pool, sql, decode_sqlite_value, max_rows),
        };
        Ok(QueryResult {
            columns,
            rows,
            rows_affected,
            duration_ms: started_at.elapsed().as_millis() as u64,
            is_truncated,
        })
    }

    /// Runs a statement inside a database-enforced read-only session (read-only
    /// transaction on PostgreSQL and MySQL, `query_only` on SQLite) so that a
    /// statement misclassified as a read still cannot modify data.
    pub async fn execute_read_only(&self, sql: &str, max_rows: Option<usize>) -> AppResult<QueryResult> {
        let started_at = Instant::now();
        let (columns, rows, rows_affected, is_truncated) = match self {
            Self::Postgres(pool) => collect_read_only!(
                pool,
                sqlx::PgConnection,
                sql,
                decode_postgres_value,
                max_rows,
                "BEGIN READ ONLY",
                "ROLLBACK"
            ),
            Self::Mysql(pool) => collect_read_only!(
                pool,
                sqlx::MySqlConnection,
                sql,
                decode_mysql_value,
                max_rows,
                "START TRANSACTION READ ONLY",
                "ROLLBACK"
            ),
            Self::Sqlite(pool) => collect_read_only!(
                pool,
                sqlx::SqliteConnection,
                sql,
                decode_sqlite_value,
                max_rows,
                "PRAGMA query_only = ON",
                "PRAGMA query_only = OFF"
            ),
        };
        Ok(QueryResult {
            columns,
            rows,
            rows_affected,
            duration_ms: started_at.elapsed().as_millis() as u64,
            is_truncated,
        })
    }

    pub async fn execute_transaction(&self, statements: &[String]) -> AppResult<u64> {
        Ok(match self {
            Self::Postgres(pool) => execute_in_transaction!(pool, statements, sqlx::PgConnection),
            Self::Mysql(pool) => execute_in_transaction!(pool, statements, sqlx::MySqlConnection),
            Self::Sqlite(pool) => execute_in_transaction!(pool, statements, sqlx::SqliteConnection),
        })
    }

    /// Runs statements with foreign key enforcement disabled. PostgreSQL has no
    /// session-level switch, so callers must add `CASCADE` to the statements.
    pub async fn execute_transaction_ignoring_foreign_keys(&self, statements: &[String]) -> AppResult<u64> {
        Ok(match self {
            Self::Postgres(pool) => execute_in_transaction!(pool, statements, sqlx::PgConnection),
            Self::Mysql(pool) => {
                let mut connection = pool.acquire().await?;
                execute_mysql_ignoring_foreign_keys(&mut connection, statements).await?
            }
            Self::Sqlite(pool) => {
                let mut connection = pool.acquire().await?;
                execute_sqlite_ignoring_foreign_keys(&mut connection, statements).await?
            }
        })
    }

    pub async fn fetch_text_rows(&self, sql: &str) -> AppResult<Vec<Vec<Option<String>>>> {
        let result = self.execute(sql).await?;
        Ok(result
            .rows
            .into_iter()
            .map(|row| row.into_iter().map(value_to_text).collect())
            .collect())
    }
}

async fn execute_mysql_ignoring_foreign_keys(
    connection: &mut sqlx::MySqlConnection,
    statements: &[String],
) -> AppResult<u64> {
    sqlx::Executor::execute(&mut *connection, "SET FOREIGN_KEY_CHECKS=0").await?;
    let outcome: AppResult<u64> = async {
        let mut rows_affected = 0u64;
        for statement in statements {
            rows_affected += sqlx::Executor::execute(&mut *connection, statement.as_str()).await?.rows_affected();
        }
        Ok(rows_affected)
    }
    .await;
    // Session variables are not transactional: always restore the check, even
    // when a statement fails, so the pooled connection is not left unsafe.
    let reset_result = sqlx::Executor::execute(&mut *connection, "SET FOREIGN_KEY_CHECKS=1").await;
    let rows_affected = outcome?;
    reset_result?;
    Ok(rows_affected)
}

async fn execute_sqlite_ignoring_foreign_keys(
    connection: &mut sqlx::SqliteConnection,
    statements: &[String],
) -> AppResult<u64> {
    // PRAGMA foreign_keys is a no-op inside a transaction, so disable it before
    // starting one.
    sqlx::Executor::execute(&mut *connection, "PRAGMA foreign_keys=OFF").await?;
    let outcome: AppResult<u64> = async {
        sqlx::Executor::execute(&mut *connection, "BEGIN").await?;
        let mut rows_affected = 0u64;
        for statement in statements {
            rows_affected += sqlx::Executor::execute(&mut *connection, statement.as_str()).await?.rows_affected();
        }
        sqlx::Executor::execute(&mut *connection, "COMMIT").await?;
        Ok(rows_affected)
    }
    .await;
    if outcome.is_err() {
        let _ = sqlx::Executor::execute(&mut *connection, "ROLLBACK").await;
    }
    let reset_result = sqlx::Executor::execute(&mut *connection, "PRAGMA foreign_keys=ON").await;
    let rows_affected = outcome?;
    reset_result?;
    Ok(rows_affected)
}

fn value_to_text(value: Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text),
        Value::Bool(flag) => Some(flag.to_string()),
        other => Some(other.to_string()),
    }
}

fn integer_value(integer: i64) -> Value {
    if integer.abs() <= MAX_SAFE_JS_INTEGER {
        Value::Number(integer.into())
    } else {
        Value::String(integer.to_string())
    }
}

fn float_value(float: f64) -> Value {
    Number::from_f64(float).map(Value::Number).unwrap_or_else(|| Value::String(float.to_string()))
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(2 + bytes.len() * 2);
    hex.push_str("0x");
    for byte in bytes {
        hex.push_str(&format!("{byte:02X}"));
    }
    hex
}

fn coerce_text_by_type(type_name: &str, text: String) -> Value {
    match type_name.to_uppercase().as_str() {
        "BOOL" | "BOOLEAN" => Value::Bool(matches!(text.as_str(), "t" | "true" | "1")),
        "INT2" | "INT4" | "INT8" | "SMALLINT" | "INT" | "INTEGER" | "BIGINT" | "TINYINT" | "MEDIUMINT" => {
            text.parse::<i64>().map(integer_value).unwrap_or(Value::String(text))
        }
        "FLOAT4" | "FLOAT8" | "REAL" | "FLOAT" | "DOUBLE" => {
            text.parse::<f64>().map(float_value).unwrap_or(Value::String(text))
        }
        _ => Value::String(text),
    }
}

fn decode_postgres_value(row: &PgRow, index: usize) -> Value {
    let type_name = row.column(index).type_info().name().to_string();
    match row.try_get_unchecked::<Option<String>, _>(index) {
        Ok(Some(text)) => coerce_text_by_type(&type_name, text),
        Ok(None) => Value::Null,
        Err(_) => Value::String("<unreadable>".into()),
    }
}

fn decode_mysql_value(row: &MySqlRow, index: usize) -> Value {
    let type_name = row.column(index).type_info().name().to_string();
    match row.try_get_unchecked::<Option<String>, _>(index) {
        Ok(Some(text)) => coerce_text_by_type(&type_name, text),
        Ok(None) => Value::Null,
        Err(_) => match row.try_get_unchecked::<Option<Vec<u8>>, _>(index) {
            Ok(Some(bytes)) => Value::String(bytes_to_hex(&bytes)),
            _ => Value::Null,
        },
    }
}

fn decode_sqlite_value(row: &SqliteRow, index: usize) -> Value {
    let storage_class = match row.try_get_raw(index) {
        Ok(raw) if raw.is_null() => return Value::Null,
        Ok(raw) => raw.type_info().name().to_string(),
        Err(_) => return Value::Null,
    };
    match storage_class.as_str() {
        "INTEGER" => row.try_get_unchecked::<i64, _>(index).map(integer_value).unwrap_or(Value::Null),
        "REAL" => row.try_get_unchecked::<f64, _>(index).map(float_value).unwrap_or(Value::Null),
        "BLOB" => row
            .try_get_unchecked::<Vec<u8>, _>(index)
            .map(|bytes| Value::String(bytes_to_hex(&bytes)))
            .unwrap_or(Value::Null),
        _ => row.try_get_unchecked::<String, _>(index).map(Value::String).unwrap_or(Value::Null),
    }
}

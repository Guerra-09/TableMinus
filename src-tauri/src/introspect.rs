use serde::Serialize;

use crate::{connections::Driver, db::DbPool, error::AppResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub default_value: Option<String>,
    pub is_primary_key: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub definition: String,
    pub is_unique: bool,
    pub is_primary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub name: String,
    pub definition: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    pub definition: String,
}

pub fn quote_identifier(driver: Driver, identifier: &str) -> String {
    match driver {
        Driver::Mysql => format!("`{}`", identifier.replace('`', "``")),
        Driver::Postgres | Driver::Sqlite => format!("\"{}\"", identifier.replace('"', "\"\"")),
    }
}

pub fn quote_literal(driver: Driver, value: &str) -> String {
    let escaped = value.replace('\'', "''");
    match driver {
        Driver::Mysql => format!("'{}'", escaped.replace('\\', "\\\\")),
        Driver::Postgres | Driver::Sqlite => format!("'{escaped}'"),
    }
}

fn text_at(row: &[Option<String>], index: usize) -> String {
    row.get(index).cloned().flatten().unwrap_or_default()
}

fn optional_text_at(row: &[Option<String>], index: usize) -> Option<String> {
    row.get(index).cloned().flatten()
}

fn flag_at(row: &[Option<String>], index: usize) -> bool {
    matches!(text_at(row, index).as_str(), "1" | "t" | "true" | "YES")
}

pub async fn list_schemas(pool: &DbPool) -> AppResult<Vec<String>> {
    let sql = match pool.driver() {
        Driver::Postgres => {
            "SELECT nspname FROM pg_namespace ORDER BY (nspname LIKE 'pg\\_%' OR nspname = 'information_schema'), nspname"
        }
        Driver::Mysql => "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME",
        Driver::Sqlite => "SELECT name FROM pragma_database_list ORDER BY seq",
    };
    Ok(pool.fetch_text_rows(sql).await?.iter().map(|row| text_at(row, 0)).collect())
}

pub async fn current_schema(pool: &DbPool) -> AppResult<String> {
    let sql = match pool.driver() {
        Driver::Postgres => "SELECT current_schema()",
        Driver::Mysql => "SELECT DATABASE()",
        Driver::Sqlite => "SELECT 'main'",
    };
    let rows = pool.fetch_text_rows(sql).await?;
    Ok(rows.first().map(|row| text_at(row, 0)).unwrap_or_default())
}

pub async fn list_objects(pool: &DbPool, schema: &str) -> AppResult<Vec<DbObject>> {
    let driver = pool.driver();
    let schema_literal = quote_literal(driver, schema);
    let sql = match driver {
        Driver::Postgres => format!(
            "SELECT c.relname, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' ELSE 'table' END \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = {schema_literal} AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY c.relname"
        ),
        Driver::Mysql => format!(
            "SELECT TABLE_NAME, CASE TABLE_TYPE WHEN 'VIEW' THEN 'view' ELSE 'table' END \
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = {schema_literal} ORDER BY TABLE_NAME"
        ),
        Driver::Sqlite => format!(
            "SELECT name, type FROM {}.sqlite_master WHERE type IN ('table', 'view') \
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
            quote_identifier(driver, schema)
        ),
    };
    Ok(pool
        .fetch_text_rows(&sql)
        .await?
        .iter()
        .map(|row| DbObject { name: text_at(row, 0), kind: text_at(row, 1) })
        .collect())
}

pub async fn table_structure(pool: &DbPool, schema: &str, table: &str) -> AppResult<TableStructure> {
    match pool.driver() {
        Driver::Postgres => postgres_structure(pool, schema, table).await,
        Driver::Mysql => mysql_structure(pool, schema, table).await,
        Driver::Sqlite => sqlite_structure(pool, schema, table).await,
    }
}

async fn postgres_structure(pool: &DbPool, schema: &str, table: &str) -> AppResult<TableStructure> {
    let driver = Driver::Postgres;
    let qualified_name = format!("{}.{}", quote_identifier(driver, schema), quote_identifier(driver, table));
    let relation = format!("{}::regclass", quote_literal(driver, &qualified_name));

    let columns: Vec<ColumnInfo> = pool
        .fetch_text_rows(&format!(
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, \
             pg_get_expr(d.adbin, d.adrelid), \
             EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)), \
             col_description(a.attrelid, a.attnum) \
             FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE a.attrelid = {relation} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"
        ))
        .await?
        .iter()
        .map(|row| ColumnInfo {
            name: text_at(row, 0),
            data_type: text_at(row, 1),
            is_nullable: flag_at(row, 2),
            default_value: optional_text_at(row, 3),
            is_primary_key: flag_at(row, 4),
            comment: optional_text_at(row, 5),
        })
        .collect();

    let indexes: Vec<IndexInfo> = pool
        .fetch_text_rows(&format!(
            "SELECT i.relname, pg_get_indexdef(ix.indexrelid), ix.indisunique, ix.indisprimary \
             FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid WHERE ix.indrelid = {relation} ORDER BY i.relname"
        ))
        .await?
        .iter()
        .map(|row| IndexInfo {
            name: text_at(row, 0),
            definition: text_at(row, 1),
            is_unique: flag_at(row, 2),
            is_primary: flag_at(row, 3),
        })
        .collect();

    let constraints = pool
        .fetch_text_rows(&format!(
            "SELECT conname, pg_get_constraintdef(oid), contype FROM pg_constraint \
             WHERE conrelid = {relation} ORDER BY contype = 'p' DESC, conname"
        ))
        .await?;

    let foreign_keys = constraints
        .iter()
        .filter(|row| text_at(row, 2) == "f")
        .map(|row| ForeignKeyInfo { name: text_at(row, 0), definition: text_at(row, 1) })
        .collect();

    let relation_kind = pool
        .fetch_text_rows(&format!("SELECT relkind FROM pg_class WHERE oid = {relation}"))
        .await?
        .first()
        .map(|row| text_at(row, 0))
        .unwrap_or_default();

    let definition = if relation_kind == "v" || relation_kind == "m" {
        let view_body = pool
            .fetch_text_rows(&format!("SELECT pg_get_viewdef({relation}, true)"))
            .await?
            .first()
            .map(|row| text_at(row, 0))
            .unwrap_or_default();
        let keyword = if relation_kind == "m" { "MATERIALIZED VIEW" } else { "VIEW" };
        format!("CREATE {keyword} {qualified_name} AS\n{view_body}")
    } else {
        let standalone_indexes = pool
            .fetch_text_rows(&format!(
                "SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid = {relation} \
                 AND indexrelid NOT IN (SELECT conindid FROM pg_constraint WHERE conrelid = {relation})"
            ))
            .await?;
        build_postgres_create_table(&qualified_name, &columns, &constraints, &standalone_indexes)
    };

    Ok(TableStructure { columns, indexes, foreign_keys, definition })
}

fn build_postgres_create_table(
    qualified_name: &str,
    columns: &[ColumnInfo],
    constraints: &[Vec<Option<String>>],
    standalone_indexes: &[Vec<Option<String>>],
) -> String {
    let mut lines: Vec<String> = columns
        .iter()
        .map(|column| {
            let mut line = format!("  {} {}", quote_identifier(Driver::Postgres, &column.name), column.data_type);
            if !column.is_nullable {
                line.push_str(" NOT NULL");
            }
            if let Some(default_value) = &column.default_value {
                line.push_str(&format!(" DEFAULT {default_value}"));
            }
            line
        })
        .collect();
    lines.extend(constraints.iter().map(|row| {
        format!("  CONSTRAINT {} {}", quote_identifier(Driver::Postgres, &text_at(row, 0)), text_at(row, 1))
    }));
    let mut definition = format!("CREATE TABLE {qualified_name} (\n{}\n);", lines.join(",\n"));
    for index_row in standalone_indexes {
        definition.push_str(&format!("\n{};", text_at(index_row, 0)));
    }
    definition
}

async fn mysql_structure(pool: &DbPool, schema: &str, table: &str) -> AppResult<TableStructure> {
    let driver = Driver::Mysql;
    let schema_literal = quote_literal(driver, schema);
    let table_literal = quote_literal(driver, table);

    let columns = pool
        .fetch_text_rows(&format!(
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE = 'YES', COLUMN_DEFAULT, COLUMN_KEY = 'PRI', \
             NULLIF(COLUMN_COMMENT, '') FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = {schema_literal} AND TABLE_NAME = {table_literal} ORDER BY ORDINAL_POSITION"
        ))
        .await?
        .iter()
        .map(|row| ColumnInfo {
            name: text_at(row, 0),
            data_type: text_at(row, 1),
            is_nullable: flag_at(row, 2),
            default_value: optional_text_at(row, 3),
            is_primary_key: flag_at(row, 4),
            comment: optional_text_at(row, 5),
        })
        .collect();

    let indexes = pool
        .fetch_text_rows(&format!(
            "SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', '), NON_UNIQUE = 0, \
             INDEX_NAME = 'PRIMARY' FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = {schema_literal} AND TABLE_NAME = {table_literal} \
             GROUP BY INDEX_NAME, NON_UNIQUE ORDER BY INDEX_NAME"
        ))
        .await?
        .iter()
        .map(|row| IndexInfo {
            name: text_at(row, 0),
            definition: format!("({})", text_at(row, 1)),
            is_unique: flag_at(row, 2),
            is_primary: flag_at(row, 3),
        })
        .collect();

    let foreign_keys = pool
        .fetch_text_rows(&format!(
            "SELECT CONSTRAINT_NAME, CONCAT('FOREIGN KEY (', GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR ', '), \
             ') REFERENCES ', REFERENCED_TABLE_NAME, '(', \
             GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR ', '), ')') \
             FROM information_schema.KEY_COLUMN_USAGE \
             WHERE TABLE_SCHEMA = {schema_literal} AND TABLE_NAME = {table_literal} AND REFERENCED_TABLE_NAME IS NOT NULL \
             GROUP BY CONSTRAINT_NAME, REFERENCED_TABLE_NAME ORDER BY CONSTRAINT_NAME"
        ))
        .await?
        .iter()
        .map(|row| ForeignKeyInfo { name: text_at(row, 0), definition: text_at(row, 1) })
        .collect();

    let definition = pool
        .fetch_text_rows(&format!(
            "SHOW CREATE TABLE {}.{}",
            quote_identifier(driver, schema),
            quote_identifier(driver, table)
        ))
        .await?
        .first()
        .map(|row| text_at(row, 1))
        .unwrap_or_default();

    Ok(TableStructure { columns, indexes, foreign_keys, definition })
}

async fn sqlite_structure(pool: &DbPool, schema: &str, table: &str) -> AppResult<TableStructure> {
    let driver = Driver::Sqlite;
    let table_literal = quote_literal(driver, table);
    let schema_literal = quote_literal(driver, schema);
    let schema_identifier = quote_identifier(driver, schema);

    let columns = pool
        .fetch_text_rows(&format!(
            "SELECT name, type, \"notnull\" = 0, dflt_value, pk > 0 FROM pragma_table_info({table_literal}, {schema_literal}) ORDER BY cid"
        ))
        .await?
        .iter()
        .map(|row| ColumnInfo {
            name: text_at(row, 0),
            data_type: text_at(row, 1),
            is_nullable: flag_at(row, 2),
            default_value: optional_text_at(row, 3),
            is_primary_key: flag_at(row, 4),
            comment: None,
        })
        .collect();

    let indexes = pool
        .fetch_text_rows(&format!(
            "SELECT il.name, COALESCE(m.sql, '(' || (SELECT group_concat(ii.name, ', ') FROM pragma_index_info(il.name, {schema_literal}) ii) || ')'), \
             il.\"unique\", il.origin = 'pk' FROM pragma_index_list({table_literal}, {schema_literal}) il \
             LEFT JOIN {schema_identifier}.sqlite_master m ON m.type = 'index' AND m.name = il.name ORDER BY il.name"
        ))
        .await?
        .iter()
        .map(|row| IndexInfo {
            name: text_at(row, 0),
            definition: text_at(row, 1),
            is_unique: flag_at(row, 2),
            is_primary: flag_at(row, 3),
        })
        .collect();

    let foreign_keys = pool
        .fetch_text_rows(&format!(
            "SELECT 'fk_' || id, 'FOREIGN KEY (' || group_concat(\"from\", ', ') || ') REFERENCES ' || \"table\" || '(' || group_concat(\"to\", ', ') || ')' \
             FROM pragma_foreign_key_list({table_literal}, {schema_literal}) GROUP BY id, \"table\" ORDER BY id"
        ))
        .await?
        .iter()
        .map(|row| ForeignKeyInfo { name: text_at(row, 0), definition: text_at(row, 1) })
        .collect();

    let definition = pool
        .fetch_text_rows(&format!(
            "SELECT group_concat(sql || ';', char(10)) FROM {schema_identifier}.sqlite_master \
             WHERE tbl_name = {table_literal} AND sql IS NOT NULL"
        ))
        .await?
        .first()
        .map(|row| text_at(row, 0))
        .unwrap_or_default();

    Ok(TableStructure { columns, indexes, foreign_keys, definition })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::ConnectionConfig;
    use serde_json::json;

    async fn sqlite_pool(file_name: &str) -> DbPool {
        let path = std::env::temp_dir().join(file_name);
        let _ = std::fs::remove_file(&path);
        let config = ConnectionConfig {
            id: "test".into(),
            name: "test".into(),
            driver: Driver::Sqlite,
            host: String::new(),
            port: 0,
            user: String::new(),
            database: String::new(),
            file_path: path.to_string_lossy().into_owned(),
            tag: String::new(),
            color: String::new(),
            safe_mode: String::new(),
            local_server: None,
            ssh: None,
        };
        DbPool::connect(&config, None).await.expect("sqlite connect")
    }

    #[tokio::test]
    async fn sqlite_introspection_and_queries() {
        let pool = sqlite_pool("tableminus-introspection.sqlite").await;
        pool.execute_transaction(&[
            "CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)".into(),
            "CREATE TABLE books (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES authors(id), title TEXT, price REAL, cover BLOB, published INTEGER DEFAULT 0)".into(),
            "CREATE INDEX books_title_idx ON books(title)".into(),
            "CREATE VIEW cheap_books AS SELECT * FROM books WHERE price < 10".into(),
            "INSERT INTO authors (name) VALUES ('Ana'), ('O''Brien')".into(),
            "INSERT INTO books (author_id, title, price, cover) VALUES (1, 'Uno', 9.5, X'CAFE'), (2, NULL, 20, NULL)".into(),
        ])
        .await
        .expect("setup transaction");

        assert_eq!(list_schemas(&pool).await.unwrap(), vec!["main".to_string()]);

        let objects = list_objects(&pool, "main").await.unwrap();
        let object_summary: Vec<(String, String)> = objects.into_iter().map(|object| (object.name, object.kind)).collect();
        assert_eq!(
            object_summary,
            vec![
                ("authors".into(), "table".into()),
                ("books".into(), "table".into()),
                ("cheap_books".into(), "view".into())
            ]
        );

        let structure = table_structure(&pool, "main", "books").await.unwrap();
        assert_eq!(structure.columns.len(), 6);
        assert!(structure.columns[0].is_primary_key);
        assert_eq!(structure.columns[5].default_value.as_deref(), Some("0"));
        assert!(structure.indexes.iter().any(|index| index.name == "books_title_idx"));
        assert_eq!(structure.foreign_keys.len(), 1);
        assert!(structure.foreign_keys[0].definition.contains("REFERENCES authors(id)"));
        assert!(structure.definition.contains("CREATE TABLE books"));

        let result = pool.execute("SELECT id, title, price, cover FROM books ORDER BY id").await.unwrap();
        assert_eq!(result.columns.len(), 4);
        assert_eq!(result.rows[0], vec![json!(1), json!("Uno"), json!(9.5), json!("0xCAFE")]);
        assert_eq!(result.rows[1], vec![json!(2), json!(null), json!(20.0), json!(null)]);

        let update = pool.execute("UPDATE books SET price = 1").await.unwrap();
        assert_eq!(update.rows_affected, 2);
        assert!(update.columns.is_empty());

        let read_only_select = pool.execute_read_only("SELECT id FROM books ORDER BY id", Some(1)).await.unwrap();
        assert_eq!(read_only_select.rows.len(), 1);
        assert!(read_only_select.is_truncated);
        assert!(pool.execute_read_only("DELETE FROM books", None).await.is_err(), "query_only must block writes");
        assert_eq!(pool.execute("SELECT COUNT(*) FROM books").await.unwrap().rows[0][0], json!(2));
        pool.execute("UPDATE books SET price = 2 WHERE id = 1").await.expect("query_only is reset after read-only use");

        let failing = pool
            .execute_transaction(&["DELETE FROM books".into(), "INSERT INTO missing_table VALUES (1)".into()])
            .await;
        assert!(failing.is_err());
        let count = pool.fetch_text_rows("SELECT COUNT(*) FROM books").await.unwrap();
        assert_eq!(count[0][0].as_deref(), Some("2"), "failed transaction must roll back");

        pool.close().await;
    }
}

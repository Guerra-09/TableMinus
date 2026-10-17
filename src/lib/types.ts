export type Driver = "postgres" | "mysql" | "sqlite";

export type ConnectionTag = "local" | "testing" | "development" | "staging" | "production";

export type SafeMode = "silent" | "alert" | "alert-writes";

export interface LocalServerConfig {
  isEnabled: boolean;
  binDir: string;
  dataDir: string;
}

export interface ServerInstallation {
  label: string;
  binDir: string;
  version: string;
}

export type LocalServerState = "running" | "external" | "stopped";

export interface LocalServerStatus {
  connectionId: string;
  state: LocalServerState;
  pid: number | null;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  driver: Driver;
  host: string;
  port: number;
  user: string;
  database: string;
  filePath: string;
  tag: ConnectionTag;
  color: string;
  safeMode: SafeMode;
  localServer: LocalServerConfig | null;
}

export interface OpenedConnection {
  connection: ConnectionConfig;
  schemas: string[];
  currentSchema: string;
  serverVersion: string;
}

export interface DbObject {
  name: string;
  kind: "table" | "view";
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  comment: string | null;
}

export interface IndexInfo {
  name: string;
  definition: string;
  isUnique: boolean;
  isPrimary: boolean;
}

export interface ForeignKeyInfo {
  name: string;
  definition: string;
}

export interface TableStructure {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  definition: string;
}

export type CellValue = string | number | boolean | null;

export interface ColumnMeta {
  name: string;
  typeName: string;
}

export interface QueryResult {
  columns: ColumnMeta[];
  rows: CellValue[][];
  rowsAffected: number;
  durationMs: number;
}

export interface TableRef {
  schema: string;
  name: string;
  kind: "table" | "view";
}

export type FilterOperator =
  | "="
  | "<>"
  | "<"
  | ">"
  | "<="
  | ">="
  | "IN"
  | "NOT IN"
  | "IS NULL"
  | "IS NOT NULL"
  | "BETWEEN"
  | "CONTAINS"
  | "NOT CONTAINS"
  | "BEGINS WITH"
  | "ENDS WITH";

export const RAW_SQL_FILTER_COLUMN = "__raw_sql__";

export interface RowFilter {
  id: string;
  isEnabled: boolean;
  column: string;
  operator: FilterOperator;
  value: string;
  secondValue: string;
}

export type SortDirection = "DESC" | "ASC";

export interface SortState {
  column: string;
  direction: SortDirection;
}

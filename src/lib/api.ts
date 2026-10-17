import { invoke } from "@tauri-apps/api/core";
import { logQuery } from "./consoleLog";
import type {
  ConnectionConfig,
  DbObject,
  Driver,
  LocalServerStatus,
  OpenedConnection,
  QueryResult,
  ServerInstallation,
  TableStructure,
} from "./types";

export const api = {
  listConnections: () => invoke<ConnectionConfig[]>("list_connections"),

  saveConnection: (config: ConnectionConfig, password: string | null, sshSecret: string | null = null) =>
    invoke<ConnectionConfig>("save_connection", { config, password, sshSecret }),

  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),

  testConnection: (config: ConnectionConfig, password: string | null, sshSecret: string | null) =>
    invoke<string>("test_connection", { config, password, sshSecret }),

  openConnection: (id: string) => invoke<OpenedConnection>("open_connection", { id }),

  closeConnection: (id: string) => invoke<void>("close_connection", { id }),

  listSchemas: (id: string) => invoke<string[]>("list_schemas", { id }),

  listObjects: (id: string, schema: string) => invoke<DbObject[]>("list_objects", { id, schema }),

  getTableStructure: (id: string, schema: string, table: string) =>
    invoke<TableStructure>("get_table_structure", { id, schema, table }),

  executeQuery: async (id: string, sql: string, kind: "data" | "meta" = "data") => {
    try {
      const result = await invoke<QueryResult>("execute_query", { id, sql });
      logQuery({ sql, kind, durationMs: result.durationMs });
      return result;
    } catch (error) {
      logQuery({ sql, kind, error: String(error) });
      throw error;
    }
  },

  executeTransaction: async (id: string, statements: string[]) => {
    try {
      const rowsAffected = await invoke<number>("execute_transaction", { id, statements });
      statements.forEach((sql) => logQuery({ sql, kind: "data" }));
      return rowsAffected;
    } catch (error) {
      logQuery({ sql: statements.join(";\n"), kind: "data", error: String(error) });
      throw error;
    }
  },

  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),

  writeTextFile: (path: string, content: string) => invoke<void>("write_text_file", { path, content }),

  detectServerInstallations: (driver: Driver) => invoke<ServerInstallation[]>("detect_server_installations", { driver }),

  localServerStatuses: () => invoke<LocalServerStatus[]>("local_server_statuses"),

  startLocalServer: (id: string) => invoke<void>("start_local_server", { id }),

  stopLocalServer: (id: string) => invoke<void>("stop_local_server", { id }),

  readLocalServerLog: (id: string) => invoke<string>("read_local_server_log", { id }),
};

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ConnectionConfig, ConnectionTag, Driver, SafeMode } from "./types";

export const DRIVER_LABELS: Record<Driver, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL / MariaDB",
  sqlite: "SQLite",
};

export const DRIVER_SHORT_LABELS: Record<Driver, string> = {
  postgres: "Pg",
  mysql: "My",
  sqlite: "Sl",
};

export const DEFAULT_PORTS: Record<Driver, number> = {
  postgres: 5432,
  mysql: 3306,
  sqlite: 0,
};

export const CONNECTION_TAGS: { value: ConnectionTag; label: string; color: string }[] = [
  { value: "local", label: "Local", color: "#6e6e73" },
  { value: "testing", label: "Testing", color: "#8e44ad" },
  { value: "development", label: "Development", color: "#2f9e44" },
  { value: "staging", label: "Staging", color: "#e67700" },
  { value: "production", label: "Production", color: "#d83a3a" },
];

export const STATUS_COLORS = ["#6e6e73", "#2f9e44", "#1e6fd9", "#8e44ad", "#e67700", "#d83a3a", "#0b7285"];

export const SAFE_MODE_LABELS: Record<SafeMode, string> = {
  silent: "Silent mode",
  alert: "Alert mode: confirm every query",
  "alert-writes": "Alert mode: confirm except SELECT/EXPLAIN",
};

export const DEFAULT_PAGE_SIZE = 300;

export const MAX_RESULT_TABS = 100;

export function tagColor(tag: ConnectionTag): string {
  return CONNECTION_TAGS.find((connectionTag) => connectionTag.value === tag)?.color ?? "#6e6e73";
}

export function createEmptyConnection(driver: Driver = "postgres"): ConnectionConfig {
  return {
    id: "",
    name: "",
    driver,
    host: driver === "sqlite" ? "" : "127.0.0.1",
    port: DEFAULT_PORTS[driver],
    user: driver === "postgres" ? "postgres" : driver === "mysql" ? "root" : "",
    database: "",
    filePath: "",
    tag: "local",
    color: tagColor("local"),
    safeMode: "silent",
  };
}

export function describeConnection(connection: ConnectionConfig): string {
  if (connection.driver === "sqlite") return connection.filePath;
  const database = connection.database ? `/${connection.database}` : "";
  return `${connection.user ? `${connection.user}@` : ""}${connection.host}:${connection.port}${database}`;
}

export const isMacPlatform = navigator.userAgent.includes("Mac");

export function isModifierPressed(event: KeyboardEvent | ReactKeyboardEvent | MouseEvent): boolean {
  return isMacPlatform ? event.metaKey : event.ctrlKey;
}

export const MOD_KEY_LABEL = isMacPlatform ? "⌘" : "Ctrl+";

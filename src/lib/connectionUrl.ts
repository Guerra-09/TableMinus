import { createEmptyConnection, DEFAULT_PORTS } from "./constants";
import type { ConnectionConfig, Driver } from "./types";

const PROTOCOL_DRIVERS: Record<string, Driver> = {
  postgres: "postgres",
  postgresql: "postgres",
  mysql: "mysql",
  mariadb: "mysql",
  sqlite: "sqlite",
};

export interface ParsedConnectionUrl {
  config: ConnectionConfig;
  password: string;
}

export function parseConnectionUrl(rawUrl: string): ParsedConnectionUrl {
  const trimmedUrl = rawUrl.trim();
  const protocolMatch = /^([a-z]+):\/\//i.exec(trimmedUrl);
  const driver = protocolMatch ? PROTOCOL_DRIVERS[protocolMatch[1].toLowerCase()] : undefined;
  if (!driver) throw new Error("Unsupported URL. Use postgres://, mysql:// or sqlite://");

  const config = createEmptyConnection(driver);

  if (driver === "sqlite") {
    config.filePath = decodeURIComponent(trimmedUrl.replace(/^sqlite:\/\//i, ""));
    config.name = config.filePath.split(/[\\/]/).pop() ?? "SQLite";
    return { config, password: "" };
  }

  const url = new URL(trimmedUrl.replace(/^[a-z]+:/i, "http:"));
  config.host = url.hostname || "127.0.0.1";
  config.port = url.port ? Number(url.port) : DEFAULT_PORTS[driver];
  config.user = decodeURIComponent(url.username);
  config.database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  config.name = url.searchParams.get("name") ?? (config.database || config.host);
  return { config, password: decodeURIComponent(url.password) };
}

export function buildConnectionUrl(config: ConnectionConfig): string {
  if (config.driver === "sqlite") return `sqlite://${config.filePath}`;
  const user = config.user ? `${encodeURIComponent(config.user)}@` : "";
  return `${config.driver}://${user}${config.host}:${config.port}/${encodeURIComponent(config.database)}`;
}

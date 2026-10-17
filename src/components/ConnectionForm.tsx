import { useState } from "react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { LocalServerFields } from "./LocalServerFields";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import {
  CONNECTION_TAGS,
  DEFAULT_PORTS,
  DRIVER_LABELS,
  SAFE_MODE_LABELS,
  STATUS_COLORS,
  createEmptyConnection,
  tagColor,
} from "../lib/constants";
import type { ConnectionConfig, ConnectionTag, Driver, SafeMode } from "../lib/types";

interface ConnectionFormProps {
  initialConfig: ConnectionConfig;
  initialPassword?: string;
  onClose: () => void;
  onSaved: (config: ConnectionConfig, shouldConnect: boolean) => void;
}

type TestStatus = { state: "idle" } | { state: "testing" } | { state: "success"; message: string } | { state: "error"; message: string };

export function ConnectionForm({ initialConfig, initialPassword, onClose, onSaved }: ConnectionFormProps) {
  const [config, setConfig] = useState<ConnectionConfig>(initialConfig);
  const [password, setPassword] = useState(initialPassword ?? "");
  const [isPasswordTouched, setIsPasswordTouched] = useState(initialPassword !== undefined);
  const [testStatus, setTestStatus] = useState<TestStatus>({ state: "idle" });
  const [saveError, setSaveError] = useState<string | null>(null);

  const isExistingConnection = config.id.length > 0;
  const isSqlite = config.driver === "sqlite";

  const updateConfig = <Key extends keyof ConnectionConfig>(key: Key, value: ConnectionConfig[Key]) =>
    setConfig((current) => ({ ...current, [key]: value }));

  const changeDriver = (driver: Driver) => {
    const defaults = createEmptyConnection(driver);
    setConfig((current) => ({
      ...current,
      driver,
      port: DEFAULT_PORTS[driver],
      user: current.user || defaults.user,
      host: current.host || defaults.host,
    }));
  };

  const changeTag = (tag: ConnectionTag) => setConfig((current) => ({ ...current, tag, color: tagColor(tag) }));

  const passwordForRequest = () => (isPasswordTouched || !isExistingConnection ? password : null);

  const testConnection = async () => {
    setTestStatus({ state: "testing" });
    try {
      const version = await api.testConnection(config, passwordForRequest());
      setTestStatus({ state: "success", message: `Connection is OK. Server version: ${version}` });
    } catch (error) {
      setTestStatus({ state: "error", message: String(error) });
    }
  };

  const saveConnection = async (shouldConnect: boolean) => {
    setSaveError(null);
    const configToSave = { ...config, name: config.name.trim() || config.database || config.host || "Untitled" };
    try {
      const savedConfig = await api.saveConnection(configToSave, passwordForRequest());
      onSaved(savedConfig, shouldConnect);
    } catch (error) {
      setSaveError(String(error));
    }
  };

  const chooseSqliteFile = async (shouldCreate: boolean) => {
    const selectedPath = shouldCreate
      ? await saveFileDialog({ filters: [{ name: "SQLite", extensions: ["sqlite", "db", "sqlite3"] }] })
      : await openFileDialog({ multiple: false, directory: false });
    if (typeof selectedPath === "string") {
      updateConfig("filePath", selectedPath);
      if (!config.name) updateConfig("name", selectedPath.split(/[\\/]/).pop() ?? "");
    }
  };

  return (
    <Modal
      title={`${isExistingConnection ? "Edit" : "New"} ${DRIVER_LABELS[config.driver]} connection`}
      onClose={onClose}
      footer={
        <>
          {testStatus.state === "testing" && <span className="muted">Testing…</span>}
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={testConnection} disabled={testStatus.state === "testing"}>
            Test
          </button>
          <button className="btn" onClick={() => saveConnection(false)}>
            Save
          </button>
          <button className="btn btn-primary" onClick={() => saveConnection(true)}>
            Connect
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>Name</label>
        <input value={config.name} placeholder="My database" onChange={(event) => updateConfig("name", event.target.value)} autoFocus />

        <label>Driver</label>
        <select value={config.driver} onChange={(event) => changeDriver(event.target.value as Driver)}>
          {(Object.keys(DRIVER_LABELS) as Driver[]).map((driver) => (
            <option key={driver} value={driver}>
              {DRIVER_LABELS[driver]}
            </option>
          ))}
        </select>

        <label>Tag</label>
        <div className="form-row-inline">
          <select value={config.tag} onChange={(event) => changeTag(event.target.value as ConnectionTag)}>
            {CONNECTION_TAGS.map((connectionTag) => (
              <option key={connectionTag.value} value={connectionTag.value}>
                {connectionTag.label}
              </option>
            ))}
          </select>
          <div className="color-swatches" style={{ alignItems: "center" }}>
            {STATUS_COLORS.map((color) => (
              <button
                key={color}
                className={`color-swatch ${config.color === color ? "is-selected" : ""}`}
                style={{ background: color }}
                onClick={() => updateConfig("color", color)}
                title={color}
              />
            ))}
          </div>
        </div>

        {isSqlite ? (
          <>
            <label>Database path</label>
            <div className="form-row-inline">
              <input
                value={config.filePath}
                placeholder="/path/to/database.sqlite"
                onChange={(event) => updateConfig("filePath", event.target.value)}
                style={{ flex: 3 }}
              />
              <button className="btn" style={{ flex: "none" }} onClick={() => chooseSqliteFile(false)}>
                Select…
              </button>
              <button className="btn" style={{ flex: "none" }} onClick={() => chooseSqliteFile(true)}>
                New…
              </button>
            </div>
          </>
        ) : (
          <>
            <label>Host / Port</label>
            <div className="form-row-inline">
              <input value={config.host} onChange={(event) => updateConfig("host", event.target.value)} style={{ flex: 3 }} />
              <input
                type="number"
                value={config.port}
                onChange={(event) => updateConfig("port", Number(event.target.value))}
                style={{ flex: 1 }}
              />
            </div>

            <label>User</label>
            <input value={config.user} onChange={(event) => updateConfig("user", event.target.value)} />

            <label>Password</label>
            <input
              type="password"
              value={password}
              placeholder={isExistingConnection && !isPasswordTouched ? "Stored in keychain" : ""}
              onChange={(event) => {
                setPassword(event.target.value);
                setIsPasswordTouched(true);
              }}
            />

            <label>Database</label>
            <input
              value={config.database}
              placeholder={config.driver === "postgres" ? "postgres" : "optional"}
              onChange={(event) => updateConfig("database", event.target.value)}
            />
          </>
        )}

        <label>Safe mode</label>
        <select value={config.safeMode} onChange={(event) => updateConfig("safeMode", event.target.value as SafeMode)}>
          {(Object.keys(SAFE_MODE_LABELS) as SafeMode[]).map((safeMode) => (
            <option key={safeMode} value={safeMode}>
              {SAFE_MODE_LABELS[safeMode]}
            </option>
          ))}
        </select>

        {!isSqlite && <LocalServerFields config={config} onChange={(localServer) => updateConfig("localServer", localServer)} />}
      </div>

      {testStatus.state === "success" && <p style={{ color: "var(--color-success)" }}>{testStatus.message}</p>}
      {testStatus.state === "error" && <p className="error-text">{testStatus.message}</p>}
      {saveError && <p className="error-text">{saveError}</p>}
    </Modal>
  );
}

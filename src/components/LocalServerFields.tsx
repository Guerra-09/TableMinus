import { useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { LOCAL_SERVER_HOSTS } from "../lib/constants";
import type { ConnectionConfig, LocalServerConfig, ServerInstallation } from "../lib/types";

const CUSTOM_INSTALLATION_VALUE = "__custom__";

const INSTALL_HINTS: Record<string, string> = {
  mysql: "brew install mysql",
  postgres: "brew install postgresql@17",
};

const BIN_FOLDER_PLACEHOLDERS: Record<string, string> = {
  mysql: "/opt/homebrew/opt/mysql/bin",
  postgres: "/opt/homebrew/opt/postgresql@17/bin",
};

interface LocalServerFieldsProps {
  config: ConnectionConfig;
  onChange: (localServer: LocalServerConfig | null) => void;
}

export function LocalServerFields({ config, onChange }: LocalServerFieldsProps) {
  const [installations, setInstallations] = useState<ServerInstallation[] | null>(null);
  const localServer = config.localServer;
  const isEnabled = localServer?.isEnabled ?? false;
  const isLocalHost = LOCAL_SERVER_HOSTS.includes(config.host.trim());

  useEffect(() => {
    let isCancelled = false;
    setInstallations(null);
    api
      .detectServerInstallations(config.driver)
      .then((detected) => !isCancelled && setInstallations(detected))
      .catch(() => !isCancelled && setInstallations([]));
    return () => {
      isCancelled = true;
    };
  }, [config.driver]);

  const updateLocalServer = (changes: Partial<LocalServerConfig>) =>
    onChange({ isEnabled: true, binDir: "", dataDir: "", ...localServer, ...changes });

  const toggleEnabled = (shouldEnable: boolean) => {
    if (!shouldEnable) {
      onChange(localServer ? { ...localServer, isEnabled: false } : null);
      return;
    }
    const preferredInstallation =
      installations?.find((installation) => installation.label.startsWith("Homebrew")) ?? installations?.[0];
    updateLocalServer({ isEnabled: true, binDir: localServer?.binDir || preferredInstallation?.binDir || "" });
  };

  const chooseDirectory = async (field: "binDir" | "dataDir") => {
    const selectedPath = await openFileDialog({ directory: true, multiple: false });
    if (typeof selectedPath === "string") updateLocalServer({ [field]: selectedPath });
  };

  const isKnownInstallation = installations?.some((installation) => installation.binDir === localServer?.binDir) ?? false;
  const selectedInstallationValue = isKnownInstallation ? localServer?.binDir : CUSTOM_INSTALLATION_VALUE;

  return (
    <>
      <label>Local server</label>
      <label style={{ display: "flex", alignItems: "center", gap: 6, textAlign: "left", color: "var(--color-text)" }}>
        <input type="checkbox" checked={isEnabled} onChange={(event) => toggleEnabled(event.target.checked)} />
        Start and stop this server from TableMinus
      </label>

      {isEnabled && (
        <>
          <label>Installation</label>
          {installations === null ? (
            <span className="muted">Detecting installed servers…</span>
          ) : (
            <select
              value={selectedInstallationValue}
              onChange={(event) =>
                event.target.value !== CUSTOM_INSTALLATION_VALUE && updateLocalServer({ binDir: event.target.value })
              }
            >
              {installations.map((installation) => (
                <option key={installation.binDir} value={installation.binDir}>
                  {installation.label}
                </option>
              ))}
              <option value={CUSTOM_INSTALLATION_VALUE}>Custom bin folder…</option>
            </select>
          )}

          <label>Bin folder</label>
          <div className="form-row-inline">
            <input
              value={localServer?.binDir ?? ""}
              placeholder={BIN_FOLDER_PLACEHOLDERS[config.driver]}
              onChange={(event) => updateLocalServer({ binDir: event.target.value })}
              style={{ flex: 3 }}
            />
            <button className="btn" style={{ flex: "none" }} onClick={() => chooseDirectory("binDir")}>
              Select…
            </button>
          </div>

          <label>Data folder</label>
          <div className="form-row-inline">
            <input
              value={localServer?.dataDir ?? ""}
              placeholder="Default: TableMinus app data folder"
              onChange={(event) => updateLocalServer({ dataDir: event.target.value })}
              style={{ flex: 3 }}
            />
            <button className="btn" style={{ flex: "none" }} onClick={() => chooseDirectory("dataDir")}>
              Select…
            </button>
          </div>

          <span />
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.4 }}>
            {installations?.length === 0 && (
              <div>
                No installation found. Install one with <code>{INSTALL_HINTS[config.driver]}</code> or pick its bin folder.
              </div>
            )}
            {!isLocalHost && <div className="error-text">Host must be 127.0.0.1 or localhost to run a local server.</div>}
            <div>
              The first start creates a new empty server in the data folder with the user, password and database above.
              The server listens only on 127.0.0.1 and stops when you press stop or quit TableMinus.
            </div>
          </div>
        </>
      )}
    </>
  );
}

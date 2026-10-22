import { useCallback, useEffect, useMemo, useState } from "react";
import packageInfo from "../../package.json";
import { ChangelogModal } from "./ChangelogModal";
import { ConnectionForm } from "./ConnectionForm";
import { McpSettingsModal } from "./McpSettingsModal";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import { buildConnectionUrl, parseConnectionUrl } from "../lib/connectionUrl";
import {
  CONNECTION_TAGS,
  DRIVER_SHORT_LABELS,
  LOCAL_SERVER_STATUS_POLL_MS,
  MOD_KEY_LABEL,
  createEmptyConnection,
  describeConnection,
} from "../lib/constants";
import type { ConnectionConfig, LocalServerState } from "../lib/types";

interface WelcomeProps {
  isNewConnectionRequested: boolean;
  onNewConnectionRequestHandled: () => void;
  isConsoleOpen: boolean;
  onToggleConsole: () => void;
  connectingId: string | null;
  connectError: string | null;
  onConnect: (connectionId: string) => void;
}

const FOLDERS_STORAGE_KEY = "tableminus.folders";

type ServerTransition = "starting" | "stopping";

const SERVER_STATE_LABELS: Record<LocalServerState, string> = {
  running: "Local server running",
  external: "Port in use by another process (Docker or another server)",
  stopped: "Local server stopped",
};

interface FormState {
  config: ConnectionConfig;
  password?: string;
}

export function Welcome({ isNewConnectionRequested, onNewConnectionRequestHandled, isConsoleOpen, onToggleConsole, connectingId, connectError, onConnect }: WelcomeProps) {
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [searchText, setSearchText] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [isUrlImportOpen, setIsUrlImportOpen] = useState(false);
  const [connectionUrl, setConnectionUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverStates, setServerStates] = useState<Record<string, LocalServerState>>({});
  const [serverTransitions, setServerTransitions] = useState<Record<string, ServerTransition>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverLog, setServerLog] = useState<{ connectionName: string; content: string } | null>(null);
  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const [isMcpSettingsOpen, setIsMcpSettingsOpen] = useState(false);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [storedFolders, setStoredFolders] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(FOLDERS_STORAGE_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const reloadConnections = useCallback(async () => {
    try {
      setConnections(await api.listConnections());
    } catch (error) {
      setLoadError(String(error));
    }
  }, []);

  const refreshServerStates = useCallback(async () => {
    try {
      const statuses = await api.localServerStatuses();
      setServerStates(Object.fromEntries(statuses.map((status) => [status.connectionId, status.state])));
    } catch {
      setServerStates({});
    }
  }, []);

  useEffect(() => {
    reloadConnections();
  }, [reloadConnections]);

  useEffect(() => {
    if (!isNewConnectionRequested) return;
    setFormState({ config: createEmptyConnection() });
    onNewConnectionRequestHandled();
  }, [isNewConnectionRequested, onNewConnectionRequestHandled]);

  useEffect(() => {
    refreshServerStates();
    const pollTimer = window.setInterval(refreshServerStates, LOCAL_SERVER_STATUS_POLL_MS);
    return () => window.clearInterval(pollTimer);
  }, [refreshServerStates, connections]);

  const runServerTransition = async (connection: ConnectionConfig, transition: ServerTransition) => {
    setServerError(null);
    setServerTransitions((current) => ({ ...current, [connection.id]: transition }));
    try {
      if (transition === "starting") await api.startLocalServer(connection.id);
      else await api.stopLocalServer(connection.id);
      await refreshServerStates();
      return true;
    } catch (error) {
      setServerError(`${connection.name}: ${String(error)}`);
      return false;
    } finally {
      setServerTransitions(({ [connection.id]: _finished, ...remaining }) => remaining);
    }
  };

  const showServerLog = async (connection: ConnectionConfig) => {
    try {
      setServerLog({ connectionName: connection.name, content: (await api.readLocalServerLog(connection.id)) || "(empty log)" });
    } catch (error) {
      setServerError(String(error));
    }
  };

  const connectWithLocalServer = async (connection: ConnectionConfig) => {
    if (connection.localServer?.isEnabled && serverStates[connection.id] === "stopped") {
      const didStart = await runServerTransition(connection, "starting");
      if (!didStart) return;
    }
    onConnect(connection.id);
  };

  const filteredConnections = useMemo(() => {
    const normalizedSearch = searchText.trim().toLowerCase();
    return connections.filter((connection) =>
      `${connection.name} ${describeConnection(connection)}`.toLowerCase().includes(normalizedSearch),
    );
  }, [connections, searchText]);

  const folderNames = useMemo(
    () =>
      [...new Set([...storedFolders, ...connections.map((connection) => (connection.folder ?? "").trim())].filter(Boolean))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [storedFolders, connections],
  );

  const saveStoredFolders = (folders: string[]) => {
    setStoredFolders(folders);
    try {
      localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));
    } catch {
      // Folders that contain connections still persist; only empty ones are lost.
    }
  };

  const createFolder = () => {
    const name = (newFolderName ?? "").trim();
    if (name && !folderNames.includes(name)) saveStoredFolders([...storedFolders, name]);
    setNewFolderName(null);
  };

  const moveToFolder = async (connectionId: string, folder: string) => {
    const connection = connections.find((item) => item.id === connectionId);
    if (!connection || (connection.folder ?? "") === folder) return;
    await api.saveConnection({ ...connection, folder }, null);
    await reloadConnections();
  };

  const deleteFolder = async (folder: string) => {
    for (const connection of connections.filter((item) => (item.folder ?? "").trim() === folder)) {
      await api.saveConnection({ ...connection, folder: "" }, null);
    }
    saveStoredFolders(storedFolders.filter((name) => name !== folder));
    if (openFolder === folder) setOpenFolder(null);
    await reloadConnections();
  };

  const openFolderMenu = (event: React.MouseEvent, folder: string) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, entries: [{ label: "Delete folder", onSelect: () => deleteFolder(folder) }] });
  };

  const readDraggedId = (event: React.DragEvent) => event.dataTransfer.getData("text/plain");

  const isSearching = searchText.trim().length > 0;
  const rootConnections = filteredConnections.filter((connection) => !(connection.folder ?? "").trim());
  const folderConnections = filteredConnections.filter((connection) => (connection.folder ?? "").trim() === openFolder);

  const startNewConnection = () => setFormState({ config: { ...createEmptyConnection(), folder: openFolder ?? "" } });

  const handleSaved = async (config: ConnectionConfig, shouldConnect: boolean) => {
    setFormState(null);
    await reloadConnections();
    setSelectedId(config.id);
    if (shouldConnect) onConnect(config.id);
  };

  const deleteConnection = async (connection: ConnectionConfig) => {
    if (!window.confirm(`Delete connection "${connection.name}"?`)) return;
    await api.deleteConnection(connection.id);
    await reloadConnections();
  };

  const importFromUrl = () => {
    try {
      const parsed = parseConnectionUrl(connectionUrl);
      setIsUrlImportOpen(false);
      setConnectionUrl("");
      setUrlError(null);
      setFormState({ config: parsed.config, password: parsed.password });
    } catch (error) {
      setUrlError(error instanceof Error ? error.message : String(error));
    }
  };

  const openConnectionMenu = (event: React.MouseEvent, connection: ConnectionConfig) => {
    event.preventDefault();
    setSelectedId(connection.id);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        { label: "Connect", onSelect: () => connectWithLocalServer(connection) },
        ...(connection.localServer?.isEnabled
          ? [
              {
                label: "Start local server",
                isDisabled: serverStates[connection.id] !== "stopped",
                onSelect: () => runServerTransition(connection, "starting"),
              },
              {
                label: "Stop local server",
                isDisabled: serverStates[connection.id] !== "running",
                onSelect: () => runServerTransition(connection, "stopping"),
              },
              { label: "View server log…", onSelect: () => showServerLog(connection) },
            ]
          : []),
        { label: "Edit…", onSelect: () => setFormState({ config: connection }) },
        {
          label: "Duplicate",
          onSelect: () => setFormState({ config: { ...connection, id: "", name: `${connection.name} copy` }, password: "" }),
        },
        { label: "Copy as URL", onSelect: () => navigator.clipboard.writeText(buildConnectionUrl(connection)) },
        { isSeparator: true },
        { label: "Delete", onSelect: () => deleteConnection(connection) },
      ],
    });
  };

  const renderConnection = (connection: ConnectionConfig) => {
              const connectionTag = CONNECTION_TAGS.find((tag) => tag.value === connection.tag);
              return (
                <div
                  key={connection.id}
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData("text/plain", connection.id)}
                  className={`connection-item ${selectedId === connection.id ? "is-selected" : ""}`}
                  onClick={() => setSelectedId(connection.id)}
                  onDoubleClick={() => connectWithLocalServer(connection)}
                  onContextMenu={(event) => openConnectionMenu(event, connection)}
                >
                  <div className={`driver-icon driver-${connection.driver}`}>{DRIVER_SHORT_LABELS[connection.driver]}</div>
                  <div className="connection-info">
                    <div className="connection-name">
                      {connection.name}
                      {connectionTag && (
                        <span className="tag-pill" style={{ background: connection.color || connectionTag.color }}>
                          {connectionTag.label}
                        </span>
                      )}
                    </div>
                    <div className="connection-detail muted">{describeConnection(connection)}</div>
                  </div>
                  {connectingId === connection.id && <span className="muted">Connecting…</span>}
                  {connection.localServer?.isEnabled && (
                    <LocalServerControl
                      state={serverStates[connection.id]}
                      transition={serverTransitions[connection.id]}
                      onStart={() => runServerTransition(connection, "starting")}
                      onStop={() => runServerTransition(connection, "stopping")}
                    />
                  )}
                </div>
              );
  };

  return (
    <div className="welcome">
      <div className="welcome-intro">
        <div className="welcome-logo">T−</div>
        <div className="welcome-title">TableMinus</div>
        <div className="muted">Free, open-source, lightweight database client</div>
        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={startNewConnection}>
            Create a new connection…
          </button>
          <button className="btn" onClick={() => setIsUrlImportOpen(true)}>
            Import from URL…
          </button>
          <button className="btn" onClick={() => setIsMcpSettingsOpen(true)}>
            AI access (MCP)…
          </button>
          <button className={`btn ${isConsoleOpen ? "btn-primary" : ""}`} onClick={onToggleConsole} title={`${MOD_KEY_LABEL}⇧C`}>
            {isConsoleOpen ? "Hide console log" : "Console log"}
          </button>
        </div>
        <button className="welcome-version" onClick={() => setIsChangelogOpen(true)} title="See what's new">
          Version {packageInfo.version} · What's new
        </button>
      </div>

      <div className="welcome-connections">
        <div className="welcome-search">
          <input placeholder="Search for connection…" value={searchText} onChange={(event) => setSearchText(event.target.value)} />
          <button className="btn folder-add-button" onClick={() => setNewFolderName("")} title="New folder" aria-label="New folder">
            📁＋
          </button>
        </div>
        {loadError && <div className="inline-error error-text">{loadError}</div>}
        {connectError && <div className="inline-error error-text">{connectError}</div>}
        {serverError && <div className="inline-error error-text">{serverError}</div>}
        <div
          className="connection-list"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            moveToFolder(readDraggedId(event), "");
          }}
        >
          {isSearching ? (
            filteredConnections.map(renderConnection)
          ) : openFolder !== null ? (
            <>
              <div
                className={`folder-back ${dropTarget === "" ? "is-drop-target" : ""}`}
                onClick={() => setOpenFolder(null)}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setDropTarget("");
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setDropTarget(null);
                  moveToFolder(readDraggedId(event), "");
                }}
                title="Click to go back, or drop a connection here to take it out of the folder"
              >
                ‹ All connections
                <span className="folder-back-name">{openFolder}</span>
              </div>
              {folderConnections.length === 0 ? (
                <div className="empty-state">
                  <div>This folder is empty. Drag connections here from the main list.</div>
                </div>
              ) : (
                folderConnections.map(renderConnection)
              )}
            </>
          ) : rootConnections.length === 0 && folderNames.length === 0 ? (
            <div className="empty-state">
              <div>No connections yet</div>
              <button className="btn" onClick={startNewConnection}>
                Create a new connection
              </button>
            </div>
          ) : (
            <>
              {folderNames.map((folder) => (
                <div
                  key={folder}
                  className={`connection-item ${dropTarget === folder ? "is-drop-target" : ""}`}
                  onClick={() => setOpenFolder(folder)}
                  onContextMenu={(event) => openFolderMenu(event, folder)}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setDropTarget(folder);
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setDropTarget(null);
                    moveToFolder(readDraggedId(event), folder);
                  }}
                >
                  <div className="driver-icon folder-icon">📁</div>
                  <div className="connection-info">
                    <div className="connection-name">{folder}</div>
                    <div className="connection-detail muted">
                      {connections.filter((connection) => (connection.folder ?? "").trim() === folder).length} connections
                    </div>
                  </div>
                  <span className="muted">›</span>
                </div>
              ))}
              {rootConnections.map(renderConnection)}
            </>
          )}
        </div>
      </div>

      {formState && (
        <ConnectionForm
          initialConfig={formState.config}
          initialPassword={formState.password}
          onClose={() => setFormState(null)}
          onSaved={handleSaved}
        />
      )}

      {isUrlImportOpen && (
        <Modal
          title="Import connection from URL"
          onClose={() => setIsUrlImportOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setIsUrlImportOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={importFromUrl}>
                Import
              </button>
            </>
          }
        >
          <input
            style={{ width: "100%" }}
            autoFocus
            placeholder="postgres://user:password@host:5432/database"
            value={connectionUrl}
            onChange={(event) => setConnectionUrl(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && importFromUrl()}
          />
          {urlError && <p className="error-text">{urlError}</p>}
        </Modal>
      )}

      {newFolderName !== null && (
        <Modal
          title="New folder"
          onClose={() => setNewFolderName(null)}
          footer={
            <>
              <button className="btn" onClick={() => setNewFolderName(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={createFolder}>
                Create
              </button>
            </>
          }
        >
          <input
            style={{ width: "100%" }}
            autoFocus
            placeholder="Folder name"
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && createFolder()}
          />
        </Modal>
      )}

      {serverLog && (
        <Modal title={`Server log — ${serverLog.connectionName}`} isWide onClose={() => setServerLog(null)}>
          <pre className="code-block" style={{ maxHeight: "60vh" }}>
            {serverLog.content}
          </pre>
        </Modal>
      )}

      {isMcpSettingsOpen && <McpSettingsModal onClose={() => setIsMcpSettingsOpen(false)} />}

      {isChangelogOpen && <ChangelogModal appVersion={packageInfo.version} onClose={() => setIsChangelogOpen(false)} />}

      {contextMenu && <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />}
    </div>
  );
}

interface LocalServerControlProps {
  state: LocalServerState | undefined;
  transition: ServerTransition | undefined;
  onStart: () => void;
  onStop: () => void;
}

function LocalServerControl({ state, transition, onStart, onStop }: LocalServerControlProps) {
  const displayState = state ?? "stopped";
  const title = transition === "starting" ? "Starting server…" : transition === "stopping" ? "Stopping server…" : SERVER_STATE_LABELS[displayState];
  return (
    <div className="server-control" title={title} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <span className={`server-dot is-${transition ? "busy" : displayState}`} />
      {transition ? (
        <span className="server-control-label">{transition === "starting" ? "Starting…" : "Stopping…"}</span>
      ) : displayState === "running" ? (
        <button className="server-button" onClick={onStop} aria-label="Stop local server">
          ■
        </button>
      ) : displayState === "stopped" ? (
        <button className="server-button" onClick={onStart} aria-label="Start local server">
          ▶
        </button>
      ) : (
        <span className="server-control-label">Port busy</span>
      )}
    </div>
  );
}

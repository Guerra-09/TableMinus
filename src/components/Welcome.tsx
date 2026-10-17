import { useCallback, useEffect, useMemo, useState } from "react";
import { ConnectionForm } from "./ConnectionForm";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import { buildConnectionUrl, parseConnectionUrl } from "../lib/connectionUrl";
import { CONNECTION_TAGS, DRIVER_SHORT_LABELS, createEmptyConnection, describeConnection } from "../lib/constants";
import type { ConnectionConfig } from "../lib/types";

interface WelcomeProps {
  connectingId: string | null;
  connectError: string | null;
  onConnect: (connectionId: string) => void;
}

interface FormState {
  config: ConnectionConfig;
  password?: string;
}

export function Welcome({ connectingId, connectError, onConnect }: WelcomeProps) {
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [searchText, setSearchText] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [isUrlImportOpen, setIsUrlImportOpen] = useState(false);
  const [connectionUrl, setConnectionUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reloadConnections = useCallback(async () => {
    try {
      setConnections(await api.listConnections());
    } catch (error) {
      setLoadError(String(error));
    }
  }, []);

  useEffect(() => {
    reloadConnections();
  }, [reloadConnections]);

  const filteredConnections = useMemo(() => {
    const normalizedSearch = searchText.trim().toLowerCase();
    return connections.filter((connection) =>
      `${connection.name} ${describeConnection(connection)}`.toLowerCase().includes(normalizedSearch),
    );
  }, [connections, searchText]);

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
        { label: "Connect", onSelect: () => onConnect(connection.id) },
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

  return (
    <div className="welcome">
      <div className="welcome-intro">
        <div className="welcome-logo">T</div>
        <div className="welcome-title">TablePlus Clone</div>
        <div className="muted">Modern, native-feeling database client</div>
        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={() => setFormState({ config: createEmptyConnection() })}>
            Create a new connection…
          </button>
          <button className="btn" onClick={() => setIsUrlImportOpen(true)}>
            Import from URL…
          </button>
        </div>
      </div>

      <div className="welcome-connections">
        <div className="welcome-search">
          <input placeholder="Search for connection…" value={searchText} onChange={(event) => setSearchText(event.target.value)} />
        </div>
        {loadError && <div className="inline-error error-text">{loadError}</div>}
        {connectError && <div className="inline-error error-text">{connectError}</div>}
        <div className="connection-list">
          {filteredConnections.length === 0 ? (
            <div className="empty-state">
              <div>No connections yet</div>
              <button className="btn" onClick={() => setFormState({ config: createEmptyConnection() })}>
                Create a new connection
              </button>
            </div>
          ) : (
            filteredConnections.map((connection) => {
              const connectionTag = CONNECTION_TAGS.find((tag) => tag.value === connection.tag);
              return (
                <div
                  key={connection.id}
                  className={`connection-item ${selectedId === connection.id ? "is-selected" : ""}`}
                  onClick={() => setSelectedId(connection.id)}
                  onDoubleClick={() => onConnect(connection.id)}
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
                </div>
              );
            })
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

      {contextMenu && <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />}
    </div>
  );
}

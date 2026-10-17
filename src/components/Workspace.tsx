import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./Modal";
import { OpenAnything, type OpenAnythingItem } from "./OpenAnything";
import { QueryEditor } from "./QueryEditor";
import { Sidebar, tableKey } from "./Sidebar";
import { TableView } from "./TableView";
import { api } from "../lib/api";
import { CONNECTION_TAGS, MOD_KEY_LABEL, SAFE_MODE_LABELS, isMacPlatform, isModifierPressed } from "../lib/constants";
import { isReadOnlyStatement, quoteLiteral } from "../lib/sql";
import type { DbObject, OpenedConnection, SafeMode, TableRef } from "../lib/types";
import { WorkspaceContext, type QueryHistoryEntry, type TabActions, type WorkspaceContextValue } from "../lib/workspaceContext";

const MAX_HISTORY_ENTRIES = 500;
const CONFIRM_PREVIEW_LENGTH = 600;

type WorkspaceTab =
  | { id: string; kind: "table"; table: TableRef; initialView: "data" | "structure" }
  | { id: string; kind: "query"; title: string; initialSql: string };

interface WorkspaceProps {
  isConsoleOpen: boolean;
  onToggleConsole: () => void;
  opened: OpenedConnection;
  isDarkTheme: boolean;
  onDisconnect: () => void;
}

function historyStorageKey(connectionId: string): string {
  return `query-history:${connectionId}`;
}

function readStoredHistory(connectionId: string): QueryHistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(historyStorageKey(connectionId)) ?? "[]");
  } catch {
    return [];
  }
}

function writeStoredHistory(connectionId: string, history: QueryHistoryEntry[]) {
  try {
    localStorage.setItem(historyStorageKey(connectionId), JSON.stringify(history));
  } catch {
    return;
  }
}

export function Workspace({ opened, isDarkTheme, isConsoleOpen, onToggleConsole, onDisconnect }: WorkspaceProps) {
  const connectionId = opened.connection.id;
  const driver = opened.connection.driver;
  const [connection, setConnection] = useState(opened.connection);
  const [schemas, setSchemas] = useState(opened.schemas);
  const [currentSchema, setCurrentSchema] = useState(opened.currentSchema || opened.schemas[0] || "");
  const [objects, setObjects] = useState<DbObject[]>([]);
  const [schemaColumns, setSchemaColumns] = useState<Record<string, string[]>>({});
  const [history, setHistory] = useState<QueryHistoryEntry[]>(() => readStoredHistory(connectionId));
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [pendingCounts, setPendingCounts] = useState<Record<string, number>>({});
  const [isOpenAnythingOpen, setIsOpenAnythingOpen] = useState(false);
  const [previewStatements, setPreviewStatements] = useState<string[] | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const tabActionsRef = useRef(new Map<string, TabActions>());
  const queryTabCounterRef = useRef(0);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activePendingCount = activeTabId ? pendingCounts[activeTabId] ?? 0 : 0;

  const reloadObjects = useCallback(async () => {
    if (!currentSchema) return;
    setWorkspaceError(null);
    try {
      setObjects(await api.listObjects(connectionId, currentSchema));
      setSchemas(await api.listSchemas(connectionId));
      const columnsSql =
        driver === "sqlite"
          ? `SELECT m.name, p.name FROM "${currentSchema.replace(/"/g, '""')}".sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type IN ('table', 'view')`
          : `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = ${quoteLiteral(driver, currentSchema)} ORDER BY table_name, ordinal_position`;
      const columnsResult = await api.executeQuery(connectionId, columnsSql, "meta");
      const columnsByTable: Record<string, string[]> = {};
      columnsResult.rows.forEach(([tableName, columnName]) => {
        const key = String(tableName);
        columnsByTable[key] = [...(columnsByTable[key] ?? []), String(columnName)];
      });
      setSchemaColumns(columnsByTable);
    } catch (error) {
      setWorkspaceError(String(error));
    }
  }, [connectionId, currentSchema, driver]);

  useEffect(() => {
    reloadObjects();
  }, [reloadObjects]);

  useEffect(() => {
    writeStoredHistory(connectionId, history);
  }, [connectionId, history]);

  const openQueryEditor = useCallback((initialSql = "") => {
    queryTabCounterRef.current += 1;
    const newTab: WorkspaceTab = {
      id: crypto.randomUUID(),
      kind: "query",
      title: `SQL Query ${queryTabCounterRef.current}`,
      initialSql,
    };
    setTabs((currentTabs) => [...currentTabs, newTab]);
    setActiveTabId(newTab.id);
  }, []);

  const openTable = useCallback(
    (table: TableRef, options: { isNewTab?: boolean; view?: "data" | "structure" } = {}) => {
      const existingTab = tabs.find((tab) => tab.kind === "table" && tableKey(tab.table) === tableKey(table));
      if (existingTab && !options.view) {
        setActiveTabId(existingTab.id);
        return;
      }
      const newTab: WorkspaceTab = { id: crypto.randomUUID(), kind: "table", table, initialView: options.view ?? "data" };
      const canReplaceActiveTab =
        !options.isNewTab && activeTab?.kind === "table" && (pendingCounts[activeTab.id] ?? 0) === 0;
      setTabs((currentTabs) =>
        canReplaceActiveTab ? currentTabs.map((tab) => (tab.id === activeTab.id ? newTab : tab)) : [...currentTabs, newTab],
      );
      setActiveTabId(newTab.id);
    },
    [tabs, activeTab, pendingCounts],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      if ((pendingCounts[tabId] ?? 0) > 0 && !window.confirm("This tab has uncommitted changes. Close anyway?")) return;
      setTabs((currentTabs) => {
        const closedIndex = currentTabs.findIndex((tab) => tab.id === tabId);
        const remainingTabs = currentTabs.filter((tab) => tab.id !== tabId);
        if (tabId === activeTabId) {
          setActiveTabId(remainingTabs[Math.min(closedIndex, remainingTabs.length - 1)]?.id ?? null);
        }
        return remainingTabs;
      });
    },
    [activeTabId, pendingCounts],
  );

  const confirmStatements = useCallback(
    (statements: string[]) => {
      const safeMode = connection.safeMode || "silent";
      if (safeMode === "silent") return true;
      if (safeMode === "alert-writes" && statements.every(isReadOnlyStatement)) return true;
      const preview = statements.join(";\n");
      const truncatedPreview = preview.length > CONFIRM_PREVIEW_LENGTH ? `${preview.slice(0, CONFIRM_PREVIEW_LENGTH)}…` : preview;
      return window.confirm(`Send ${statements.length} statement(s) to ${connection.name}?\n\n${truncatedPreview}`);
    },
    [connection],
  );

  const changeSafeMode = async (safeMode: SafeMode) => {
    const updatedConnection = { ...connection, safeMode };
    setConnection(updatedConnection);
    try {
      await api.saveConnection(updatedConnection, null);
    } catch (error) {
      setWorkspaceError(String(error));
    }
  };

  const changeSchema = (schema: string) => {
    setCurrentSchema(schema);
  };

  const contextValue: WorkspaceContextValue = useMemo(
    () => ({
      connectionId,
      connection,
      driver,
      schemas,
      currentSchema,
      objects,
      schemaColumns,
      history,
      openTable,
      openQueryEditor,
      reloadObjects,
      addHistoryEntry: (sql) =>
        setHistory((currentHistory) =>
          [{ id: crypto.randomUUID(), sql, executedAt: new Date().toISOString() }, ...currentHistory.filter((entry) => entry.sql !== sql)].slice(
            0,
            MAX_HISTORY_ENTRIES,
          ),
        ),
      removeHistoryEntry: (id) => setHistory((currentHistory) => currentHistory.filter((entry) => entry.id !== id)),
      clearHistory: () => setHistory([]),
      confirmStatements,
      registerTabActions: (tabId, actions) => {
        if (actions) tabActionsRef.current.set(tabId, actions);
        else tabActionsRef.current.delete(tabId);
      },
      setTabPendingCount: (tabId, pendingCount) =>
        setPendingCounts((currentCounts) => (currentCounts[tabId] === pendingCount ? currentCounts : { ...currentCounts, [tabId]: pendingCount })),
    }),
    [connectionId, connection, driver, schemas, currentSchema, objects, schemaColumns, history, openTable, openQueryEditor, reloadObjects, confirmStatements],
  );

  const activeActions = () => (activeTabId ? tabActionsRef.current.get(activeTabId) : undefined);

  const commitActiveTab = () => activeActions()?.commitChanges();
  const discardActiveTab = () => activeActions()?.discardChanges();
  const previewActiveTab = () => {
    const statements = activeActions()?.getPendingStatements() ?? [];
    setPreviewStatements(statements);
  };
  const reloadWorkspace = () => {
    reloadObjects();
    activeActions()?.reload();
  };

  const shortcutHandlersRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  shortcutHandlersRef.current = (event: KeyboardEvent) => {
    if (!isModifierPressed(event)) return;
    if (isMacPlatform && event.ctrlKey) return;
    const key = event.key.toLowerCase();
    const runShortcut = (handler: () => void) => {
      event.preventDefault();
      handler();
    };
    if (key === "s" && !event.shiftKey) return runShortcut(commitActiveTab);
    if (key === "p" && event.shiftKey) return runShortcut(previewActiveTab);
    if ((event.key === "Backspace" || event.key === "Delete") && event.shiftKey) return runShortcut(discardActiveTab);
    if (key === "p" && !event.shiftKey) return runShortcut(() => setIsOpenAnythingOpen(true));
    if ((key === "t" || key === "e") && !event.shiftKey) return runShortcut(() => openQueryEditor());
    if (event.key === "Enter" && !event.shiftKey && activeTab?.kind !== "query") return runShortcut(() => openQueryEditor());
    if (key === "w" && !event.shiftKey) return runShortcut(() => activeTabId && closeTab(activeTabId));
    if (key === "r" && !event.shiftKey) return runShortcut(reloadWorkspace);
    if ((event.key === "[" || event.key === "]") && !event.shiftKey && !event.altKey) {
      return runShortcut(() => {
        const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
        const nextIndex = (activeIndex + (event.key === "]" ? 1 : -1) + tabs.length) % tabs.length;
        if (tabs[nextIndex]) setActiveTabId(tabs[nextIndex].id);
      });
    }
    if (/^[1-9]$/.test(event.key)) {
      return runShortcut(() => {
        const targetTab = tabs[Number(event.key) - 1];
        if (targetTab) setActiveTabId(targetTab.id);
      });
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => shortcutHandlersRef.current(event);
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const openFromOpenAnything = (item: OpenAnythingItem) => {
    if (item.kind === "schema") changeSchema(item.schema);
    else openTable({ schema: currentSchema, name: item.object.name, kind: item.object.kind });
  };

  const connectionTag = CONNECTION_TAGS.find((tag) => tag.value === connection.tag);
  const activeTableKey = activeTab?.kind === "table" ? tableKey(activeTab.table) : null;

  return (
    <WorkspaceContext.Provider value={contextValue}>
      <div className="workspace">
        <div className="toolbar">
          <div className="toolbar-group">
            <button className="icon-btn" title={`Discard changes (${MOD_KEY_LABEL}⇧⌫)`} disabled={activePendingCount === 0} onClick={discardActiveTab}>
              ⊘
            </button>
            <button className="icon-btn" title={`Preview SQL (${MOD_KEY_LABEL}⇧P)`} disabled={activePendingCount === 0} onClick={previewActiveTab}>
              ⌥
            </button>
            <button className="icon-btn" title={`Commit changes (${MOD_KEY_LABEL}S)`} disabled={activePendingCount === 0} onClick={commitActiveTab}>
              ✓
            </button>
            <div className="toolbar-separator" />
            <select
              value={connection.safeMode || "silent"}
              title="Safe mode"
              onChange={(event) => changeSafeMode(event.target.value as SafeMode)}
              style={{ padding: "1px 4px", fontSize: 12, maxWidth: 150 }}
            >
              {(Object.keys(SAFE_MODE_LABELS) as SafeMode[]).map((safeMode) => (
                <option key={safeMode} value={safeMode}>
                  🔒 {SAFE_MODE_LABELS[safeMode]}
                </option>
              ))}
            </select>
            <button className="icon-btn" title={`Reload (${MOD_KEY_LABEL}R)`} onClick={reloadWorkspace}>
              ⟳
            </button>
          </div>

          <div className="status-bar" style={{ background: connection.color || connectionTag?.color }}>
            {connectionTag && <strong>{connectionTag.label.toUpperCase()}</strong>}
            <span>{connection.name}</span>
            <span className="status-bar-detail">
              {opened.serverVersion} · {currentSchema}
              {activeTab?.kind === "table" ? ` · ${activeTab.table.name}` : ""}
            </span>
          </div>

          <div className="toolbar-group is-end">
            <button className="icon-btn" title={`Open anything (${MOD_KEY_LABEL}P)`} onClick={() => setIsOpenAnythingOpen(true)}>
              ⌕
            </button>
            <button className="btn btn-small" title={`New query (${MOD_KEY_LABEL}E)`} onClick={() => openQueryEditor()}>
              SQL
            </button>
            <button
              className={`btn btn-small ${isConsoleOpen ? "btn-primary" : ""}`}
              title={`Console log (${MOD_KEY_LABEL}⇧C)`}
              onClick={onToggleConsole}
            >
              Console
            </button>
            <button className="btn btn-small" title={`Close this connection and show all connections (${MOD_KEY_LABEL}⇧K)`} onClick={onDisconnect}>
              ‹ Connections
            </button>
          </div>
        </div>

        {workspaceError && <div className="inline-error error-text">{workspaceError}</div>}

        <div className="workspace-body">
          <Sidebar activeTableKey={activeTableKey} onSchemaChange={changeSchema} />
          <div className="main-area">
            {tabs.length > 0 && (
              <div className="tab-bar">
                {tabs.map((tab) => (
                  <div
                    key={tab.id}
                    className={`tab ${tab.id === activeTabId ? "is-active" : ""}`}
                    onMouseDown={(event) => {
                      if (event.button === 1) closeTab(tab.id);
                      else setActiveTabId(tab.id);
                    }}
                  >
                    {(pendingCounts[tab.id] ?? 0) > 0 && <span className="tab-dirty-dot" />}
                    <span className="tab-label">{tab.kind === "table" ? tab.table.name : tab.title}</span>
                    <button
                      className="tab-close"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={() => closeTab(tab.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            {tabs.length === 0 ? (
              <div className="empty-state">
                <div>Select a table from the sidebar or open a new query</div>
                <button className="btn" onClick={() => openQueryEditor()}>
                  New query ({MOD_KEY_LABEL}E)
                </button>
              </div>
            ) : (
              tabs.map((tab) => (
                <div
                  key={tab.id}
                  className="tab-content"
                  style={{ display: tab.id === activeTabId ? "flex" : "none" }}
                >
                  {tab.kind === "table" ? (
                    <TableView tabId={tab.id} table={tab.table} isActive={tab.id === activeTabId} initialView={tab.initialView} />
                  ) : (
                    <QueryEditor initialSql={tab.initialSql} isDarkTheme={isDarkTheme} />
                  )}
                </div>
              ))
            )}

          </div>
        </div>
      </div>

      {isOpenAnythingOpen && (
        <OpenAnything
          objects={objects}
          schemas={schemas}
          onOpen={openFromOpenAnything}
          onClose={() => setIsOpenAnythingOpen(false)}
        />
      )}

      {previewStatements && (
        <Modal
          title="Code review"
          isWide
          onClose={() => setPreviewStatements(null)}
          footer={
            <>
              <button className="btn" onClick={() => navigator.clipboard.writeText(previewStatements.join(";\n") + ";")}>
                Copy
              </button>
              <div style={{ flex: 1 }} />
              <button className="btn" onClick={() => setPreviewStatements(null)}>
                Close
              </button>
              <button
                className="btn btn-primary"
                disabled={previewStatements.length === 0}
                onClick={() => {
                  setPreviewStatements(null);
                  commitActiveTab();
                }}
              >
                Commit
              </button>
            </>
          }
        >
          <pre className="code-block">
            {previewStatements.length === 0 ? "-- No pending changes" : previewStatements.map((statement) => `${statement};`).join("\n")}
          </pre>
        </Modal>
      )}
    </WorkspaceContext.Provider>
  );
}

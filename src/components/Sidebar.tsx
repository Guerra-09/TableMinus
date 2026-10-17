import { useMemo, useState } from "react";
import { ContextMenu, type ContextMenuState } from "./ContextMenu";
import { api } from "../lib/api";
import { qualifiedTableName } from "../lib/sql";
import type { DbObject, TableRef } from "../lib/types";
import { useWorkspace } from "../lib/workspaceContext";

interface SidebarProps {
  activeTableKey: string | null;
  onSchemaChange: (schema: string) => void;
}

export function fuzzyMatches(candidate: string, search: string): boolean {
  const normalizedCandidate = candidate.toLowerCase();
  let searchPosition = 0;
  const normalizedSearch = search.toLowerCase();
  for (const character of normalizedCandidate) {
    if (character === normalizedSearch[searchPosition]) searchPosition += 1;
    if (searchPosition === normalizedSearch.length) return true;
  }
  return normalizedSearch.length === 0;
}

export function tableKey(table: TableRef): string {
  return `${table.schema}.${table.name}`;
}

export function Sidebar({ activeTableKey, onSchemaChange }: SidebarProps) {
  const workspace = useWorkspace();
  const [searchText, setSearchText] = useState("");
  const [activeSection, setActiveSection] = useState<"items" | "history">("items");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const matchingObjects = useMemo(
    () => workspace.objects.filter((object) => fuzzyMatches(object.name, searchText.trim())),
    [workspace.objects, searchText],
  );
  const tables = matchingObjects.filter((object) => object.kind === "table");
  const views = matchingObjects.filter((object) => object.kind === "view");
  const matchingHistory = workspace.history.filter((entry) => entry.sql.toLowerCase().includes(searchText.trim().toLowerCase()));

  const toTableRef = (object: DbObject): TableRef => ({ schema: workspace.currentSchema, name: object.name, kind: object.kind });

  const runDestructiveAction = async (statement: string) => {
    if (!workspace.confirmStatements([statement]) || !window.confirm(`Execute?\n\n${statement}`)) return;
    setActionError(null);
    try {
      await api.executeTransaction(workspace.connectionId, [statement]);
      await workspace.reloadObjects();
    } catch (error) {
      setActionError(String(error));
    }
  };

  const openObjectMenu = (event: React.MouseEvent, object: DbObject) => {
    event.preventDefault();
    const table = toTableRef(object);
    const tableSql = qualifiedTableName(workspace.driver, table);
    const truncateStatement = workspace.driver === "sqlite" ? `DELETE FROM ${tableSql}` : `TRUNCATE TABLE ${tableSql}`;
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        { label: "Open in new tab", onSelect: () => workspace.openTable(table, { isNewTab: true }) },
        { label: "Open structure", onSelect: () => workspace.openTable(table, { isNewTab: true, view: "structure" }) },
        { label: "Copy name", onSelect: () => navigator.clipboard.writeText(object.name) },
        { label: "Query this table", onSelect: () => workspace.openQueryEditor(`SELECT * FROM ${tableSql} LIMIT 100;`) },
        { isSeparator: true },
        { label: "Truncate…", isDisabled: object.kind !== "table", onSelect: () => runDestructiveAction(truncateStatement) },
        {
          label: "Delete…",
          onSelect: () => runDestructiveAction(`DROP ${object.kind === "view" ? "VIEW" : "TABLE"} ${tableSql}`),
        },
      ],
    });
  };

  const openHistoryMenu = (event: React.MouseEvent, entryId: string, sql: string) => {
    event.preventDefault();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        { label: "Open in a new tab", onSelect: () => workspace.openQueryEditor(sql) },
        { label: "Copy", onSelect: () => navigator.clipboard.writeText(sql) },
        { isSeparator: true },
        { label: "Delete", onSelect: () => workspace.removeHistoryEntry(entryId) },
        { label: "Clear all history", onSelect: workspace.clearHistory },
      ],
    });
  };

  const renderObject = (object: DbObject) => {
    const table = toTableRef(object);
    return (
      <div
        key={object.name}
        className={`sidebar-item ${activeTableKey === tableKey(table) ? "is-selected" : ""}`}
        onClick={() => workspace.openTable(table)}
        onDoubleClick={() => workspace.openTable(table, { isNewTab: true })}
        onContextMenu={(event) => openObjectMenu(event, object)}
        title={object.name}
      >
        <span className="sidebar-item-icon">{object.kind === "view" ? "◫" : "▦"}</span>
        <span className="sidebar-item-label">{object.name}</span>
      </div>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-search">
        <input placeholder="Search for item…" value={searchText} onChange={(event) => setSearchText(event.target.value)} />
      </div>
      <div className="sidebar-tabs">
        <button className={activeSection === "items" ? "is-active" : ""} onClick={() => setActiveSection("items")}>
          Items
        </button>
        <button className={activeSection === "history" ? "is-active" : ""} onClick={() => setActiveSection("history")}>
          History
        </button>
      </div>
      {actionError && <div className="inline-error error-text">{actionError}</div>}
      <div className="sidebar-list">
        {activeSection === "items" ? (
          <>
            <div className="sidebar-section-title">Tables ({tables.length})</div>
            {tables.map(renderObject)}
            {views.length > 0 && <div className="sidebar-section-title">Views ({views.length})</div>}
            {views.map(renderObject)}
          </>
        ) : matchingHistory.length === 0 ? (
          <div className="muted" style={{ padding: 8 }}>
            No queries yet
          </div>
        ) : (
          matchingHistory.map((entry) => (
            <div
              key={entry.id}
              className="history-item"
              title={`${entry.executedAt}\n${entry.sql}`}
              onDoubleClick={() => workspace.openQueryEditor(entry.sql)}
              onContextMenu={(event) => openHistoryMenu(event, entry.id, entry.sql)}
            >
              {entry.sql}
            </div>
          ))
        )}
      </div>
      <div className="sidebar-footer">
        <select value={workspace.currentSchema} onChange={(event) => onSchemaChange(event.target.value)} title="Schema">
          {workspace.schemas.map((schema) => (
            <option key={schema} value={schema}>
              {schema}
            </option>
          ))}
        </select>
        <button className="icon-btn" title="Reload items" onClick={() => workspace.reloadObjects()}>
          ⟳
        </button>
      </div>
      {contextMenu && <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />}
    </aside>
  );
}

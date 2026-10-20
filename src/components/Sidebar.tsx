import { useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from "./ContextMenu";
import { api } from "../lib/api";
import { MOD_KEY_LABEL, SELECT_ALL_EVENT, isModifierPressed } from "../lib/constants";
import { qualifiedTableName } from "../lib/sql";
import type { DbObject, TableRef } from "../lib/types";
import { useWorkspace } from "../lib/workspaceContext";

interface SidebarProps {
  activeTableKey: string | null;
  onSchemaChange: (schema: string) => void;
}

const CONFIRMATION_PREVIEW_LIMIT = 25;

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

function summarizeObjects(objects: DbObject[]): string {
  const lines = objects
    .slice(0, CONFIRMATION_PREVIEW_LIMIT)
    .map((object) => `  • ${object.name}${object.kind === "view" ? " (view)" : ""}`);
  if (objects.length > CONFIRMATION_PREVIEW_LIMIT) {
    lines.push(`  …and ${objects.length - CONFIRMATION_PREVIEW_LIMIT} more`);
  }
  return lines.join("\n");
}

export function Sidebar({ activeTableKey, onSchemaChange }: SidebarProps) {
  const workspace = useWorkspace();
  const [searchText, setSearchText] = useState("");
  const [activeSection, setActiveSection] = useState<"items" | "history">("items");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [ignoreForeignKeys, setIgnoreForeignKeys] = useState(false);

  const matchingObjects = useMemo(
    () => workspace.objects.filter((object) => fuzzyMatches(object.name, searchText.trim())),
    [workspace.objects, searchText],
  );
  const tables = matchingObjects.filter((object) => object.kind === "table");
  const views = matchingObjects.filter((object) => object.kind === "view");
  const orderedObjects = useMemo(() => [...tables, ...views], [tables, views]);
  const allObjectsOrdered = useMemo(
    () => [
      ...workspace.objects.filter((object) => object.kind === "table"),
      ...workspace.objects.filter((object) => object.kind === "view"),
    ],
    [workspace.objects],
  );
  const selectedObjects = useMemo(
    () => allObjectsOrdered.filter((object) => selectedNames.has(object.name)),
    [allObjectsOrdered, selectedNames],
  );
  const selectedTableCount = selectedObjects.filter((object) => object.kind === "table").length;
  const matchingHistory = workspace.history.filter((entry) => entry.sql.toLowerCase().includes(searchText.trim().toLowerCase()));

  const toTableRef = (object: DbObject): TableRef => ({ schema: workspace.currentSchema, name: object.name, kind: object.kind });

  const tableSqlFor = (object: DbObject) => qualifiedTableName(workspace.driver, toTableRef(object));
  const truncateStatementFor = (object: DbObject, ignoreForeignKeys = false) => {
    if (workspace.driver === "sqlite") return `DELETE FROM ${tableSqlFor(object)}`;
    const cascade = ignoreForeignKeys && workspace.driver === "postgres" ? " CASCADE" : "";
    return `TRUNCATE TABLE ${tableSqlFor(object)}${cascade}`;
  };
  const dropStatementFor = (object: DbObject, ignoreForeignKeys = false) => {
    const cascade = ignoreForeignKeys && workspace.driver === "postgres" ? " CASCADE" : "";
    return `DROP ${object.kind === "view" ? "VIEW" : "TABLE"} ${tableSqlFor(object)}${cascade}`;
  };

  const foreignKeyNote = (ignoreChecks: boolean) => {
    if (!ignoreChecks) return "";
    return workspace.driver === "postgres"
      ? "\n\nForeign keys ignored: CASCADE will also drop/truncate dependent objects."
      : "\n\nForeign keys ignored: constraints will not be checked and related rows may be left inconsistent.";
  };

  const clearSelection = () => {
    setSelectedNames(new Set());
    setSelectionAnchor(null);
    setIgnoreForeignKeys(false);
  };

  const selectAllObjects = () => {
    const allNames = orderedObjects.map((object) => object.name);
    setSelectedNames(new Set(allNames));
    setSelectionAnchor(allNames[0] ?? null);
    setIgnoreForeignKeys(false);
  };

  const selectAllRef = useRef(selectAllObjects);
  selectAllRef.current = selectAllObjects;

  useEffect(() => {
    const handleSelectAll = () => {
      if (!document.activeElement?.closest(".sidebar-list")) return;
      selectAllRef.current();
    };
    window.addEventListener(SELECT_ALL_EVENT, handleSelectAll);
    return () => window.removeEventListener(SELECT_ALL_EVENT, handleSelectAll);
  }, []);

  useEffect(() => {
    clearSelection();
  }, [workspace.currentSchema]);

  useEffect(() => {
    setSelectedNames((currentNames) => {
      if (currentNames.size === 0) return currentNames;
      const availableNames = new Set(workspace.objects.map((object) => object.name));
      if ([...currentNames].every((name) => availableNames.has(name))) return currentNames;
      return new Set([...currentNames].filter((name) => availableNames.has(name)));
    });
  }, [workspace.objects]);

  const runDestructiveStatements = async (
    statements: string[],
    confirmationMessage: string,
    ignoreChecks = false,
  ): Promise<boolean> => {
    if (statements.length === 0) return false;
    if (!workspace.confirmStatements(statements) || !window.confirm(confirmationMessage)) return false;
    setActionError(null);
    try {
      if (ignoreChecks) await api.executeTransactionIgnoringForeignKeys(workspace.connectionId, statements);
      else await api.executeTransaction(workspace.connectionId, statements);
      await workspace.reloadObjects();
      return true;
    } catch (error) {
      setActionError(String(error));
      return false;
    }
  };

  const truncateObjects = async (objects: DbObject[], ignoreChecks = false) => {
    const objectsToTruncate = objects.filter((object) => object.kind === "table");
    if (objectsToTruncate.length === 0) return;
    const noun = objectsToTruncate.length === 1 ? "table" : "tables";
    const didTruncate = await runDestructiveStatements(
      objectsToTruncate.map((object) => truncateStatementFor(object, ignoreChecks)),
      `Delete all rows from ${objectsToTruncate.length} ${noun} in "${workspace.currentSchema}"?\n\n${summarizeObjects(objectsToTruncate)}\n\nThis cannot be undone.${foreignKeyNote(ignoreChecks)}`,
      ignoreChecks,
    );
    if (didTruncate) setIgnoreForeignKeys(false);
  };

  const dropObjects = async (objects: DbObject[], ignoreChecks = false) => {
    if (objects.length === 0) return;
    const noun = objects.length === 1 ? "object" : "objects";
    const didDrop = await runDestructiveStatements(
      objects.map((object) => dropStatementFor(object, ignoreChecks)),
      `Permanently drop ${objects.length} ${noun} from "${workspace.currentSchema}"?\n\n${summarizeObjects(objects)}\n\nThis cannot be undone.${foreignKeyNote(ignoreChecks)}`,
      ignoreChecks,
    );
    if (!didDrop) return;
    setIgnoreForeignKeys(false);
    workspace.closeTabsForObjects(workspace.currentSchema, objects.map((object) => object.name));
    clearSelection();
  };

  const handleObjectClick = (event: React.MouseEvent, object: DbObject) => {
    setIgnoreForeignKeys(false);
    if (event.shiftKey && selectionAnchor) {
      const orderedNames = orderedObjects.map((candidate) => candidate.name);
      const anchorIndex = orderedNames.indexOf(selectionAnchor);
      const targetIndex = orderedNames.indexOf(object.name);
      if (anchorIndex !== -1 && targetIndex !== -1) {
        setSelectedNames(new Set(orderedNames.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)));
        return;
      }
    }
    if (isModifierPressed(event)) {
      setSelectedNames((currentNames) => {
        const nextNames = new Set(currentNames);
        if (nextNames.has(object.name)) nextNames.delete(object.name);
        else nextNames.add(object.name);
        return nextNames;
      });
      setSelectionAnchor(object.name);
      return;
    }
    setSelectedNames(new Set([object.name]));
    setSelectionAnchor(object.name);
    workspace.openTable(toTableRef(object));
  };

  const openObjectMenu = (event: React.MouseEvent, object: DbObject) => {
    event.preventDefault();
    setIgnoreForeignKeys(false);
    const isPartOfSelection = selectedNames.has(object.name);
    const menuSelection = isPartOfSelection ? selectedNames : new Set([object.name]);
    if (!isPartOfSelection) {
      setSelectedNames(menuSelection);
      setSelectionAnchor(object.name);
    }
    const menuObjects = allObjectsOrdered.filter((candidate) => menuSelection.has(candidate.name));

    if (menuObjects.length > 1) {
      const tableCount = menuObjects.filter((candidate) => candidate.kind === "table").length;
      const entries: ContextMenuEntry[] = [
        {
          label: `Copy ${menuObjects.length} names`,
          onSelect: () => navigator.clipboard.writeText(menuObjects.map((candidate) => candidate.name).join("\n")),
        },
        { isSeparator: true },
        {
          label: `Truncate ${tableCount} table${tableCount === 1 ? "" : "s"}…`,
          isDisabled: tableCount === 0,
          onSelect: () => void truncateObjects(menuObjects),
        },
        {
          label: `Truncate ${tableCount} table${tableCount === 1 ? "" : "s"} (ignore FKs)…`,
          isDisabled: tableCount === 0,
          onSelect: () => void truncateObjects(menuObjects, true),
        },
        {
          label: `Drop ${menuObjects.length} item${menuObjects.length === 1 ? "" : "s"}…`,
          onSelect: () => void dropObjects(menuObjects),
        },
        {
          label: `Drop ${menuObjects.length} item${menuObjects.length === 1 ? "" : "s"} (ignore FKs)…`,
          onSelect: () => void dropObjects(menuObjects, true),
        },
        { isSeparator: true },
        { label: "Clear selection", onSelect: clearSelection },
      ];
      setContextMenu({ x: event.clientX, y: event.clientY, entries });
      return;
    }

    const table = toTableRef(object);
    const tableSql = tableSqlFor(object);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      entries: [
        { label: "Open in new tab", onSelect: () => workspace.openTable(table, { isNewTab: true }) },
        { label: "Open structure", onSelect: () => workspace.openTable(table, { isNewTab: true, view: "structure" }) },
        { label: "Copy name", onSelect: () => navigator.clipboard.writeText(object.name) },
        { label: "Query this table", onSelect: () => workspace.openQueryEditor(`SELECT * FROM ${tableSql} LIMIT 100;`) },
        { isSeparator: true },
        { label: "Truncate…", isDisabled: object.kind !== "table", onSelect: () => void truncateObjects([object]) },
        {
          label: "Truncate (ignore FKs)…",
          isDisabled: object.kind !== "table",
          onSelect: () => void truncateObjects([object], true),
        },
        { label: "Delete…", onSelect: () => void dropObjects([object]) },
        { label: "Delete (ignore FKs)…", onSelect: () => void dropObjects([object], true) },
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

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (activeSection !== "items") return;
    if (isModifierPressed(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectAllObjects();
      return;
    }
    if (event.key === "Escape") clearSelection();
  };

  const renderObject = (object: DbObject) => {
    const table = toTableRef(object);
    const isActive = activeTableKey === tableKey(table);
    const isSelected = selectedNames.has(object.name);
    return (
      <div
        key={object.name}
        className={`sidebar-item ${isSelected ? "is-selected" : ""} ${isActive ? "is-active" : ""}`}
        tabIndex={0}
        onClick={(event) => handleObjectClick(event, object)}
        onDoubleClick={() => {
          setSelectedNames(new Set([object.name]));
          setSelectionAnchor(object.name);
          setIgnoreForeignKeys(false);
          workspace.openTable(table, { isNewTab: true });
        }}
        onMouseDown={(event) => {
          if (event.button === 0) event.currentTarget.focus();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") workspace.openTable(table);
        }}
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
      <div
        className="sidebar-list"
        onKeyDown={handleListKeyDown}
        title={activeSection === "items" ? `${MOD_KEY_LABEL}A selects all items` : undefined}
      >
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
      {activeSection === "items" && selectedNames.size > 1 && (
        <div className="sidebar-selection-bar">
          <span className="sidebar-selection-count">{selectedNames.size} selected</span>
          <label className="sidebar-selection-toggle" title="Do not check foreign key constraints">
            <input
              type="checkbox"
              checked={ignoreForeignKeys}
              onChange={(event) => setIgnoreForeignKeys(event.target.checked)}
            />
            Ignore FKs
          </label>
          <button
            className="sidebar-selection-action"
            disabled={selectedTableCount === 0}
            onClick={() => void truncateObjects(selectedObjects, ignoreForeignKeys)}
          >
            Truncate…
          </button>
          <button
            className="sidebar-selection-action is-danger"
            onClick={() => void dropObjects(selectedObjects, ignoreForeignKeys)}
          >
            Drop…
          </button>
          <button className="sidebar-selection-clear" title="Clear selection (Esc)" onClick={clearSelection}>
            ✕
          </button>
        </div>
      )}
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

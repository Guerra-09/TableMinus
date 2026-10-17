import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from "./ContextMenu";
import { DataGrid, type CellPosition } from "./DataGrid";
import { ExportDialog } from "./ExportDialog";
import { FilterPanel, createRowFilter } from "./FilterPanel";
import { Modal } from "./Modal";
import { QuickLookModal } from "./QuickLookModal";
import { RowDetailPanel } from "./RowDetailPanel";
import { StructureView } from "./StructureView";
import { api } from "../lib/api";
import { DEFAULT_PAGE_SIZE, isMacPlatform, isModifierPressed } from "../lib/constants";
import { EXPORT_FORMAT_LABELS, parseCsv, serializeRows, type ExportFormat } from "../lib/exporters";
import {
  buildCountQuery,
  buildDeleteStatement,
  buildInsertForRows,
  buildInsertStatement,
  buildSelectQuery,
  buildUpdateStatement,
  qualifiedTableName,
} from "../lib/sql";
import type { CellValue, ColumnMeta, QueryResult, RowFilter, SortState, TableRef, TableStructure } from "../lib/types";
import { useWorkspace } from "../lib/workspaceContext";

const COPY_FORMATS: ExportFormat[] = ["tsv", "json", "csv", "csv-header", "markdown", "sql"];

interface PendingChanges {
  updates: Map<number, Map<number, CellValue>>;
  inserts: Map<number, CellValue>[];
  deletes: Set<number>;
}

function createEmptyPendingChanges(): PendingChanges {
  return { updates: new Map(), inserts: [], deletes: new Set() };
}

interface TableViewProps {
  tabId: string;
  table: TableRef;
  isActive: boolean;
  initialView: "data" | "structure";
}

function isViewSwitchShortcut(event: KeyboardEvent, key: "[" | "]"): boolean {
  if (event.key !== key && event.code !== (key === "[" ? "BracketLeft" : "BracketRight")) return false;
  return isMacPlatform ? event.metaKey && event.ctrlKey : event.ctrlKey && event.shiftKey;
}

export function TableView({ tabId, table, isActive, initialView }: TableViewProps) {
  const workspace = useWorkspace();
  const { connectionId, driver } = workspace;
  const tableSql = qualifiedTableName(driver, table);
  const isEditable = table.kind === "table";

  const [view, setView] = useState<"data" | "structure">(initialView);
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [limit, setLimit] = useState(DEFAULT_PAGE_SIZE);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<SortState | null>(null);
  const [filters, setFilters] = useState<RowFilter[]>([]);
  const [appliedFilters, setAppliedFilters] = useState<RowFilter[]>([]);
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [isColumnFilterOpen, setIsColumnFilterOpen] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<PendingChanges>(createEmptyPendingChanges);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [focusedCell, setFocusedCell] = useState<CellPosition | null>(null);
  const [isRowDetailOpen, setIsRowDetailOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [quickLookCell, setQuickLookCell] = useState<{ rowIndex: number; columnIndex: number } | null>(null);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [filterSqlPreview, setFilterSqlPreview] = useState<string | null>(null);

  const allColumns: ColumnMeta[] = useMemo(() => {
    if (structure && structure.columns.length > 0) {
      return structure.columns.map((column) => ({ name: column.name, typeName: column.dataType }));
    }
    return result?.columns ?? [];
  }, [structure, result]);

  const columnNames = useMemo(() => allColumns.map((column) => column.name), [allColumns]);

  const primaryKeyColumns = useMemo(
    () => structure?.columns.filter((column) => column.isPrimaryKey).map((column) => column.name) ?? [],
    [structure],
  );

  const baseRows = result?.rows ?? [];

  const displayRows: CellValue[][] = useMemo(() => {
    const updatedRows = baseRows.map((row, rowIndex) => {
      const rowUpdates = pendingChanges.updates.get(rowIndex);
      if (!rowUpdates) return row;
      return row.map((value, columnIndex) => (rowUpdates.has(columnIndex) ? (rowUpdates.get(columnIndex) as CellValue) : value));
    });
    const insertedRows = pendingChanges.inserts.map((insertValues) =>
      allColumns.map((_, columnIndex) => (insertValues.has(columnIndex) ? (insertValues.get(columnIndex) as CellValue) : null)),
    );
    return [...updatedRows, ...insertedRows];
  }, [baseRows, pendingChanges, allColumns]);

  const visibleColumnIndexes = useMemo(
    () => allColumns.map((column, columnIndex) => ({ column, columnIndex })).filter(({ column }) => !hiddenColumns.has(column.name)).map(({ columnIndex }) => columnIndex),
    [allColumns, hiddenColumns],
  );

  const gridColumns = useMemo(() => visibleColumnIndexes.map((columnIndex) => allColumns[columnIndex]), [visibleColumnIndexes, allColumns]);

  const gridRows = useMemo(
    () => displayRows.map((row) => visibleColumnIndexes.map((columnIndex) => row[columnIndex])),
    [displayRows, visibleColumnIndexes],
  );

  const pendingCount = pendingChanges.updates.size + pendingChanges.deletes.size + pendingChanges.inserts.length;

  const resetSelection = () => {
    setSelectedRows(new Set());
    setFocusedCell(null);
  };

  const loadStructure = useCallback(async () => {
    try {
      setStructure(await api.getTableStructure(connectionId, table.schema, table.name));
    } catch (error) {
      setLoadError(String(error));
    }
  }, [connectionId, table.schema, table.name]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const queryOptions = { table, filters: appliedFilters, sort, limit, offset };
      const [pageResult, countResult] = await Promise.all([
        api.executeQuery(connectionId, buildSelectQuery(driver, queryOptions)),
        api.executeQuery(connectionId, buildCountQuery(driver, table, appliedFilters), "meta"),
      ]);
      setResult(pageResult);
      setTotalCount(Number(countResult.rows[0]?.[0] ?? 0));
      setPendingChanges(createEmptyPendingChanges());
      resetSelection();
    } catch (error) {
      setLoadError(String(error));
    } finally {
      setIsLoading(false);
    }
  }, [connectionId, driver, table, appliedFilters, sort, limit, offset]);

  useEffect(() => {
    loadStructure();
  }, [loadStructure]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    workspace.setTabPendingCount(tabId, pendingCount);
  }, [pendingCount, tabId]);

  const confirmDiscardIfPending = () => pendingCount === 0 || window.confirm("Discard uncommitted changes?");

  const buildPendingStatements = (): string[] => {
    const statements: string[] = [];
    pendingChanges.updates.forEach((rowUpdates, rowIndex) => {
      if (pendingChanges.deletes.has(rowIndex) || rowUpdates.size === 0) return;
      statements.push(buildUpdateStatement(driver, table, columnNames, baseRows[rowIndex], rowUpdates, primaryKeyColumns));
    });
    pendingChanges.deletes.forEach((rowIndex) => {
      statements.push(buildDeleteStatement(driver, table, columnNames, baseRows[rowIndex], primaryKeyColumns));
    });
    pendingChanges.inserts.forEach((insertValues) => {
      statements.push(buildInsertStatement(driver, table, columnNames, insertValues));
    });
    return statements;
  };

  const commitChanges = async () => {
    const statements = buildPendingStatements();
    if (statements.length === 0 || !workspace.confirmStatements(statements)) return;
    setActionError(null);
    try {
      await api.executeTransaction(connectionId, statements);
      await loadData();
    } catch (error) {
      setActionError(String(error));
    }
  };

  const discardChanges = () => {
    setPendingChanges(createEmptyPendingChanges());
    setActionError(null);
  };

  const actionsRef = useRef({ buildPendingStatements, commitChanges, discardChanges, loadData });
  actionsRef.current = { buildPendingStatements, commitChanges, discardChanges, loadData };

  useEffect(() => {
    workspace.registerTabActions(tabId, {
      getPendingStatements: () => actionsRef.current.buildPendingStatements(),
      commitChanges: () => actionsRef.current.commitChanges(),
      discardChanges: () => actionsRef.current.discardChanges(),
      reload: () => {
        loadStructure();
        actionsRef.current.loadData();
      },
    });
    return () => workspace.registerTabActions(tabId, null);
  }, [tabId, loadStructure]);

  const setCellValue = (rowIndex: number, columnIndex: number, value: CellValue) => {
    if (!isEditable) return;
    setPendingChanges((current) => {
      if (rowIndex >= baseRows.length) {
        const inserts = [...current.inserts];
        const insertIndex = rowIndex - baseRows.length;
        inserts[insertIndex] = new Map(inserts[insertIndex]).set(columnIndex, value);
        return { ...current, inserts };
      }
      const updates = new Map(current.updates);
      const rowUpdates = new Map(updates.get(rowIndex));
      if (baseRows[rowIndex][columnIndex] === value) rowUpdates.delete(columnIndex);
      else rowUpdates.set(columnIndex, value);
      if (rowUpdates.size === 0) updates.delete(rowIndex);
      else updates.set(rowIndex, rowUpdates);
      return { ...current, updates };
    });
  };

  const insertRow = (initialValues: Map<number, CellValue> = new Map()) => {
    if (!isEditable) return;
    const newRowIndex = baseRows.length + pendingChanges.inserts.length;
    setPendingChanges((current) => ({ ...current, inserts: [...current.inserts, initialValues] }));
    setSelectedRows(new Set([newRowIndex]));
    setFocusedCell({ rowIndex: newRowIndex, columnIndex: 0 });
  };

  const sortedSelection = () => [...selectedRows].sort((first, second) => first - second);

  const duplicateSelectedRows = () => {
    if (!isEditable || selectedRows.size === 0) return;
    const duplicatedRows = sortedSelection().map((rowIndex) => {
      const values = new Map<number, CellValue>();
      displayRows[rowIndex].forEach((value, columnIndex) => {
        if (!primaryKeyColumns.includes(columnNames[columnIndex])) values.set(columnIndex, value);
      });
      return values;
    });
    setPendingChanges((current) => ({ ...current, inserts: [...current.inserts, ...duplicatedRows] }));
  };

  const deleteSelectedRows = () => {
    if (!isEditable || selectedRows.size === 0) return;
    setPendingChanges((current) => {
      const deletes = new Set(current.deletes);
      const removedInsertIndexes = new Set<number>();
      selectedRows.forEach((rowIndex) => {
        if (rowIndex >= baseRows.length) removedInsertIndexes.add(rowIndex - baseRows.length);
        else if (deletes.has(rowIndex)) deletes.delete(rowIndex);
        else deletes.add(rowIndex);
      });
      const inserts = current.inserts.filter((_, insertIndex) => !removedInsertIndexes.has(insertIndex));
      return { ...current, deletes, inserts };
    });
    if ([...selectedRows].some((rowIndex) => rowIndex >= baseRows.length)) resetSelection();
  };

  const copyRows = (format: ExportFormat, rowIndexes = sortedSelection()) => {
    const rows = rowIndexes.map((rowIndex) => displayRows[rowIndex]);
    navigator.clipboard.writeText(serializeRows(format, { driver, qualifiedTableName: tableSql, columnNames, rows }));
  };

  const applyFilters = (filtersToApply: RowFilter[]) => {
    if (!confirmDiscardIfPending()) return;
    setOffset(0);
    setAppliedFilters(filtersToApply);
  };

  const openFilterPanel = () => {
    if (filters.length === 0) setFilters([createRowFilter(primaryKeyColumns[0] ?? columnNames[0] ?? "")]);
    setIsFilterPanelOpen(true);
  };

  const quickFilterByValue = (columnIndex: number, value: CellValue) => {
    const quickFilter =
      value === null
        ? createRowFilter(columnNames[columnIndex], "IS NULL")
        : createRowFilter(columnNames[columnIndex], "=", String(value));
    setFilters([quickFilter]);
    setIsFilterPanelOpen(true);
    applyFilters([quickFilter]);
  };

  const changeSort = (columnName: string) => {
    if (!confirmDiscardIfPending()) return;
    setSort((current) => {
      if (current?.column !== columnName) return { column: columnName, direction: "DESC" };
      if (current.direction === "DESC") return { column: columnName, direction: "ASC" };
      return null;
    });
  };

  const goToOffset = (nextOffset: number) => {
    if (!confirmDiscardIfPending()) return;
    setOffset(Math.max(0, nextOffset));
  };

  const importCsv = async () => {
    const filePath = await openFileDialog({ multiple: false, filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }] });
    if (typeof filePath !== "string") return;
    setActionError(null);
    try {
      const { headers, rows } = parseCsv(await api.readTextFile(filePath));
      const matchedColumns = headers
        .map((header, headerIndex) => ({ header: header.trim(), headerIndex }))
        .filter(({ header }) => columnNames.includes(header));
      if (matchedColumns.length === 0) {
        setActionError("CSV header does not match any column of this table");
        return;
      }
      const rowsToInsert = rows.map((row) =>
        matchedColumns.map(({ headerIndex }) => (row[headerIndex] === undefined || row[headerIndex] === "" ? null : row[headerIndex])),
      );
      const statements = buildInsertForRows(driver, tableSql, matchedColumns.map(({ header }) => header), rowsToInsert);
      const ignoredHeaders = headers.filter((header) => !columnNames.includes(header.trim()));
      const ignoredMessage = ignoredHeaders.length > 0 ? `\nIgnored columns: ${ignoredHeaders.join(", ")}` : "";
      if (!window.confirm(`Import ${statements.length} rows into ${table.name}?${ignoredMessage}`)) return;
      await api.executeTransaction(connectionId, statements);
      await loadData();
    } catch (error) {
      setActionError(`Import failed: ${String(error)}`);
    }
  };

  useEffect(() => {
    if (!isActive) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isViewSwitchShortcut(event, "]")) {
        event.preventDefault();
        setView("structure");
      } else if (isViewSwitchShortcut(event, "[")) {
        event.preventDefault();
        setView("data");
      } else if (isModifierPressed(event) && event.altKey && event.code === "KeyF") {
        event.preventDefault();
        setIsColumnFilterOpen((isOpen) => !isOpen);
      } else if (isModifierPressed(event) && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (isFilterPanelOpen) setIsFilterPanelOpen(false);
        else openFilterPanel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const handleGridKeyDown = (event: React.KeyboardEvent): boolean => {
    const key = event.key.toLowerCase();
    if (event.key === " ") {
      event.preventDefault();
      setIsRowDetailOpen((isOpen) => !isOpen);
      return true;
    }
    if (event.key === "Delete" || (event.key === "Backspace" && !isModifierPressed(event))) {
      event.preventDefault();
      deleteSelectedRows();
      return true;
    }
    if (!isModifierPressed(event) || event.shiftKey) return false;
    if (key === "i") {
      event.preventDefault();
      insertRow();
      return true;
    }
    if (key === "d") {
      event.preventDefault();
      duplicateSelectedRows();
      return true;
    }
    if (key === "c") {
      event.preventDefault();
      copyRows("tsv");
      return true;
    }
    return false;
  };

  const openCellMenu = (event: React.MouseEvent, rowIndex: number, visibleColumnIndex: number) => {
    const columnIndex = visibleColumnIndexes[visibleColumnIndex];
    const value = displayRows[rowIndex]?.[columnIndex];
    const rowIndexes = selectedRows.has(rowIndex) ? sortedSelection() : [rowIndex];
    if (!selectedRows.has(rowIndex)) {
      setSelectedRows(new Set([rowIndex]));
      setFocusedCell({ rowIndex, columnIndex: visibleColumnIndex });
    }
    const entries: ContextMenuEntry[] = [
      { label: "Copy cell value", onSelect: () => navigator.clipboard.writeText(value === null ? "NULL" : String(value)) },
      ...COPY_FORMATS.map((format) => ({
        label: `Copy rows as ${EXPORT_FORMAT_LABELS[format]}`,
        onSelect: () => copyRows(format, rowIndexes),
      })),
      { isSeparator: true },
      { label: "Quick filter by this value", onSelect: () => quickFilterByValue(columnIndex, value) },
      { label: "Quick Look", onSelect: () => setQuickLookCell({ rowIndex, columnIndex }) },
      { isSeparator: true },
      { label: "Set NULL", isDisabled: !isEditable, onSelect: () => setCellValue(rowIndex, columnIndex, null) },
      { label: "Duplicate", isDisabled: !isEditable, onSelect: duplicateSelectedRows },
      { label: "Delete", isDisabled: !isEditable, onSelect: deleteSelectedRows },
    ];
    setContextMenu({ x: event.clientX, y: event.clientY, entries });
  };

  const focusedRow = focusedCell ? displayRows[focusedCell.rowIndex] ?? null : null;
  const pageNumber = Math.floor(offset / limit) + 1;
  const pageCount = totalCount === null ? 1 : Math.max(1, Math.ceil(totalCount / limit));

  return (
    <div className="tab-content">
      {view === "data" && isFilterPanelOpen && (
        <FilterPanel
          driver={driver}
          columnNames={columnNames}
          filters={filters}
          appliedFilterIds={new Set(appliedFilters.map((filter) => filter.id))}
          onFiltersChange={setFilters}
          onApply={applyFilters}
          onShowSql={setFilterSqlPreview}
          onClose={() => setIsFilterPanelOpen(false)}
        />
      )}
      {loadError && <div className="inline-error error-text">{loadError}</div>}
      {actionError && <div className="inline-error error-text">{actionError}</div>}

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}>
          {view === "data" ? (
            <>
              <DataGrid
                columns={gridColumns}
                rows={gridRows}
                isEditable={isEditable}
                selectedRows={selectedRows}
                focusedCell={focusedCell}
                sort={sort}
                getRowStatus={(rowIndex) =>
                  rowIndex >= baseRows.length ? "insert" : pendingChanges.deletes.has(rowIndex) ? "delete" : undefined
                }
                isCellPending={(rowIndex, visibleColumnIndex) =>
                  pendingChanges.updates.get(rowIndex)?.has(visibleColumnIndexes[visibleColumnIndex]) ?? false
                }
                onSelectionChange={(nextSelectedRows, nextFocusedCell) => {
                  setSelectedRows(nextSelectedRows);
                  setFocusedCell(nextFocusedCell);
                }}
                onCellEdit={(rowIndex, visibleColumnIndex, value) => setCellValue(rowIndex, visibleColumnIndexes[visibleColumnIndex], value)}
                onSortChange={changeSort}
                onCellContextMenu={openCellMenu}
                onCellMiddleClick={(rowIndex, visibleColumnIndex) =>
                  setQuickLookCell({ rowIndex, columnIndex: visibleColumnIndexes[visibleColumnIndex] })
                }
                onGridKeyDown={handleGridKeyDown}
              />
              {isLoading && <div className="loading-overlay">Loading…</div>}
            </>
          ) : structure ? (
            <StructureView structure={structure} />
          ) : (
            <div className="empty-state">Loading structure…</div>
          )}
        </div>
        {view === "data" && isRowDetailOpen && (
          <RowDetailPanel
            columns={allColumns}
            row={focusedRow}
            isEditable={isEditable}
            onFieldChange={(columnIndex, value) => focusedCell && setCellValue(focusedCell.rowIndex, columnIndex, value)}
          />
        )}
      </div>

      <div className="bottom-bar" style={{ position: "relative" }}>
        <div className="segmented">
          <button className={view === "data" ? "is-active" : ""} onClick={() => setView("data")}>
            Data
          </button>
          <button className={view === "structure" ? "is-active" : ""} onClick={() => setView("structure")}>
            Structure
          </button>
        </div>
        {view === "data" && (
          <>
            <button className="btn btn-small" disabled={!isEditable} onClick={() => insertRow()} title="Insert row (⌘I)">
              + Row
            </button>
            <button className={`btn btn-small ${hiddenColumns.size > 0 ? "btn-primary" : ""}`} onClick={() => setIsColumnFilterOpen((isOpen) => !isOpen)}>
              Columns
            </button>
            <button
              className={`btn btn-small ${appliedFilters.length > 0 ? "btn-primary" : ""}`}
              onClick={() => (isFilterPanelOpen ? setIsFilterPanelOpen(false) : openFilterPanel())}
              title="Filters (⌘F)"
            >
              Filters
            </button>
            <button className="btn btn-small" onClick={() => setIsExportOpen(true)}>
              Export…
            </button>
            <button className="btn btn-small" disabled={!isEditable} onClick={importCsv}>
              Import CSV…
            </button>
          </>
        )}
        <div className="bottom-bar-spacer" />
        {view === "data" && result && (
          <span className="muted">
            {pendingCount > 0 && <span className="badge" style={{ marginRight: 8 }}>{pendingCount} pending</span>}
            {totalCount === null ? "" : `${totalCount.toLocaleString()} rows`} · {result.durationMs} ms
          </span>
        )}
        {view === "data" && (
          <div className="pagination">
            <button className="icon-btn" disabled={offset === 0} onClick={() => goToOffset(offset - limit)}>
              ‹
            </button>
            <span>
              Page {pageNumber} / {pageCount}
            </span>
            <button
              className="icon-btn"
              disabled={totalCount !== null && offset + limit >= totalCount}
              onClick={() => goToOffset(offset + limit)}
            >
              ›
            </button>
            <span className="muted">Limit</span>
            <input
              type="number"
              min={1}
              defaultValue={limit}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                const nextLimit = Number((event.target as HTMLInputElement).value);
                if (nextLimit > 0 && confirmDiscardIfPending()) {
                  setOffset(0);
                  setLimit(nextLimit);
                }
              }}
            />
          </div>
        )}

        {isColumnFilterOpen && (
          <div className="column-filter-popover" style={{ left: 120 }}>
            <div className="column-filter-list">
              {columnNames.map((columnName) => (
                <label key={columnName}>
                  <input
                    type="checkbox"
                    checked={!hiddenColumns.has(columnName)}
                    onChange={(event) => {
                      const nextHiddenColumns = new Set(hiddenColumns);
                      if (event.target.checked) nextHiddenColumns.delete(columnName);
                      else nextHiddenColumns.add(columnName);
                      setHiddenColumns(nextHiddenColumns);
                    }}
                  />
                  {columnName}
                </label>
              ))}
            </div>
            <div className="modal-footer">
              <button className="btn btn-small" onClick={() => setHiddenColumns(new Set())}>
                Clear
              </button>
              <button className="btn btn-small btn-primary" onClick={() => setIsColumnFilterOpen(false)}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>

      {contextMenu && <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />}

      {quickLookCell && (
        <QuickLookModal
          title={columnNames[quickLookCell.columnIndex]}
          value={displayRows[quickLookCell.rowIndex]?.[quickLookCell.columnIndex] ?? null}
          isEditable={isEditable}
          onSave={(value) => setCellValue(quickLookCell.rowIndex, quickLookCell.columnIndex, value)}
          onClose={() => setQuickLookCell(null)}
        />
      )}

      {filterSqlPreview !== null && (
        <Modal title="Filter SQL" onClose={() => setFilterSqlPreview(null)}>
          <pre className="code-block">{filterSqlPreview}</pre>
        </Modal>
      )}

      {isExportOpen && (
        <ExportDialog
          driver={driver}
          qualifiedTableName={tableSql}
          defaultFileName={table.name}
          onClose={() => setIsExportOpen(false)}
          sources={[
            {
              label: "All rows (with current filters)",
              load: async () => {
                const allRowsResult = await api.executeQuery(
                  connectionId,
                  buildSelectQuery(driver, { table, filters: appliedFilters, sort, limit: null, offset: 0 }),
                );
                return { columnNames: allRowsResult.columns.map((column) => column.name), rows: allRowsResult.rows };
              },
            },
            { label: "Current page", load: async () => ({ columnNames, rows: displayRows }) },
            { label: "Selected rows", load: async () => ({ columnNames, rows: sortedSelection().map((rowIndex) => displayRows[rowIndex]) }) },
          ]}
        />
      )}
    </div>
  );
}

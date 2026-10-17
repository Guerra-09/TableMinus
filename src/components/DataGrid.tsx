import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { isModifierPressed } from "../lib/constants";
import type { CellValue, ColumnMeta, SortState } from "../lib/types";

const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 26;
const DEFAULT_COLUMN_WIDTH = 160;
const MIN_COLUMN_WIDTH = 48;
const MAX_CELL_PREVIEW_LENGTH = 300;
const NUMERIC_TYPE_PATTERN = /^(INT|INT2|INT4|INT8|INTEGER|SMALLINT|BIGINT|TINYINT|MEDIUMINT|FLOAT|FLOAT4|FLOAT8|REAL|DOUBLE|NUMERIC|DECIMAL)/i;

export interface CellPosition {
  rowIndex: number;
  columnIndex: number;
}

export type RowStatus = "insert" | "delete" | undefined;

interface DataGridProps {
  columns: ColumnMeta[];
  rows: CellValue[][];
  isEditable: boolean;
  selectedRows: Set<number>;
  focusedCell: CellPosition | null;
  sort?: SortState | null;
  getRowStatus?: (rowIndex: number) => RowStatus;
  isCellPending?: (rowIndex: number, columnIndex: number) => boolean;
  onSelectionChange: (selectedRows: Set<number>, focusedCell: CellPosition | null) => void;
  onCellEdit?: (rowIndex: number, columnIndex: number, value: CellValue) => void;
  onSortChange?: (columnName: string) => void;
  onCellContextMenu?: (event: React.MouseEvent, rowIndex: number, columnIndex: number) => void;
  onCellMiddleClick?: (rowIndex: number, columnIndex: number) => void;
  onGridKeyDown?: (event: React.KeyboardEvent) => boolean;
}

interface EditingCell extends CellPosition {
  draftValue: string;
}

function formatCellPreview(value: CellValue): string {
  if (value === null) return "NULL";
  const text = String(value);
  return text.length > MAX_CELL_PREVIEW_LENGTH ? `${text.slice(0, MAX_CELL_PREVIEW_LENGTH)}…` : text.replace(/\n/g, "↵");
}

function rangeSet(fromIndex: number, toIndex: number): Set<number> {
  const selection = new Set<number>();
  for (let index = Math.min(fromIndex, toIndex); index <= Math.max(fromIndex, toIndex); index += 1) selection.add(index);
  return selection;
}

export function DataGrid({
  columns,
  rows,
  isEditable,
  selectedRows,
  focusedCell,
  sort,
  getRowStatus,
  isCellPending,
  onSelectionChange,
  onCellEdit,
  onSortChange,
  onCellContextMenu,
  onCellMiddleClick,
  onGridKeyDown,
}: DataGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const selectionAnchorRef = useRef<number | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 25,
  });

  useEffect(() => {
    if (editingCell) editorRef.current?.focus();
  }, [editingCell?.rowIndex, editingCell?.columnIndex]);

  useEffect(() => {
    if (focusedCell) rowVirtualizer.scrollToIndex(focusedCell.rowIndex, { align: "auto" });
  }, [focusedCell?.rowIndex]);

  const widthOf = (columnName: string) => columnWidths[columnName] ?? DEFAULT_COLUMN_WIDTH;
  const totalWidth = columns.reduce((sum, column) => sum + widthOf(column.name), 0);

  const startEditing = (cell: CellPosition, initialDraft?: string) => {
    if (!isEditable || getRowStatus?.(cell.rowIndex) === "delete") return;
    const currentValue = rows[cell.rowIndex]?.[cell.columnIndex];
    setEditingCell({ ...cell, draftValue: initialDraft ?? (currentValue === null ? "" : String(currentValue)) });
  };

  const commitEditing = () => {
    if (!editingCell) return;
    const originalValue = rows[editingCell.rowIndex]?.[editingCell.columnIndex];
    const originalText = originalValue === null ? "" : String(originalValue);
    if (editingCell.draftValue !== originalText || (originalValue === null && editingCell.draftValue !== "")) {
      onCellEdit?.(editingCell.rowIndex, editingCell.columnIndex, editingCell.draftValue);
    }
    setEditingCell(null);
    containerRef.current?.focus();
  };

  const cancelEditing = () => {
    setEditingCell(null);
    containerRef.current?.focus();
  };

  const focusCell = (cell: CellPosition, extendSelection = false) => {
    const clampedCell = {
      rowIndex: Math.max(0, Math.min(rows.length - 1, cell.rowIndex)),
      columnIndex: Math.max(0, Math.min(columns.length - 1, cell.columnIndex)),
    };
    if (extendSelection && selectionAnchorRef.current !== null) {
      onSelectionChange(rangeSet(selectionAnchorRef.current, clampedCell.rowIndex), clampedCell);
    } else {
      selectionAnchorRef.current = clampedCell.rowIndex;
      onSelectionChange(new Set([clampedCell.rowIndex]), clampedCell);
    }
  };

  const handleCellMouseDown = (event: React.MouseEvent, rowIndex: number, columnIndex: number) => {
    if (event.button === 1) {
      event.preventDefault();
      onCellMiddleClick?.(rowIndex, columnIndex);
      return;
    }
    if (event.button === 2 && selectedRows.has(rowIndex)) {
      onSelectionChange(selectedRows, { rowIndex, columnIndex });
      return;
    }
    if (editingCell) commitEditing();
    if (event.shiftKey && selectionAnchorRef.current !== null) {
      onSelectionChange(rangeSet(selectionAnchorRef.current, rowIndex), { rowIndex, columnIndex });
    } else if (event.metaKey || event.ctrlKey) {
      const toggledSelection = new Set(selectedRows);
      if (toggledSelection.has(rowIndex)) toggledSelection.delete(rowIndex);
      else toggledSelection.add(rowIndex);
      selectionAnchorRef.current = rowIndex;
      onSelectionChange(toggledSelection, { rowIndex, columnIndex });
    } else {
      selectionAnchorRef.current = rowIndex;
      onSelectionChange(new Set([rowIndex]), { rowIndex, columnIndex });
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (editingCell) return;
    if (onGridKeyDown?.(event)) return;
    if (!focusedCell) {
      if (rows.length > 0 && event.key.startsWith("Arrow")) {
        event.preventDefault();
        focusCell({ rowIndex: 0, columnIndex: 0 });
      }
      return;
    }
    const navigationDeltas: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const delta = navigationDeltas[event.key];
    if (delta) {
      event.preventDefault();
      focusCell(
        { rowIndex: focusedCell.rowIndex + delta[0], columnIndex: focusedCell.columnIndex + delta[1] },
        event.shiftKey && delta[0] !== 0,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      startEditing(focusedCell);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      focusCell({ rowIndex: focusedCell.rowIndex, columnIndex: focusedCell.columnIndex + (event.shiftKey ? -1 : 1) });
      return;
    }
    if (event.key.length === 1 && !isModifierPressed(event) && !event.ctrlKey && !event.altKey && event.key !== " ") {
      event.preventDefault();
      startEditing(focusedCell, event.key);
    }
  };

  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      commitEditing();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelEditing();
    } else if (event.key === "Tab" && editingCell) {
      event.preventDefault();
      const nextCell = { rowIndex: editingCell.rowIndex, columnIndex: editingCell.columnIndex + (event.shiftKey ? -1 : 1) };
      commitEditing();
      focusCell(nextCell);
    }
  };

  const startColumnResize = (event: React.MouseEvent, columnName: string) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = widthOf(columnName);
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.max(MIN_COLUMN_WIDTH, startWidth + moveEvent.clientX - startX);
      setColumnWidths((current) => ({ ...current, [columnName]: nextWidth }));
    };
    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <div ref={containerRef} className="grid-container" tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="grid-header" style={{ height: HEADER_HEIGHT }}>
        <div className="grid-header-row-number" />
        {columns.map((column) => (
          <div
            key={column.name}
            className="grid-header-cell"
            style={{ width: widthOf(column.name) }}
            title={`${column.name} (${column.typeName})`}
            onClick={() => onSortChange?.(column.name)}
          >
            {column.name}
            {column.typeName && <span className="grid-header-type">{column.typeName.toLowerCase()}</span>}
            {sort?.column === column.name && (
              <span className="grid-sort-indicator">{sort.direction === "DESC" ? "▼" : "▲"}</span>
            )}
            <div className="grid-column-resizer" onMouseDown={(event) => startColumnResize(event, column.name)} onClick={(event) => event.stopPropagation()} />
          </div>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="grid-empty">No rows</div>
      ) : (
        <div style={{ height: rowVirtualizer.getTotalSize(), width: totalWidth + 44, position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const rowIndex = virtualRow.index;
            const row = rows[rowIndex];
            const rowStatus = getRowStatus?.(rowIndex);
            const rowClassName = [
              "grid-row",
              rowIndex % 2 === 1 ? "is-alternate" : "",
              selectedRows.has(rowIndex) ? "is-selected" : "",
              rowStatus === "insert" ? "is-pending-insert" : "",
              rowStatus === "delete" ? "is-pending-delete" : "",
            ].join(" ");
            return (
              <div
                key={virtualRow.key}
                className={rowClassName}
                style={{ top: virtualRow.start, height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT - 1}px` }}
              >
                <div className="grid-row-number">{rowIndex + 1}</div>
                {columns.map((column, columnIndex) => {
                  const value = row[columnIndex];
                  const isEditing = editingCell?.rowIndex === rowIndex && editingCell.columnIndex === columnIndex;
                  const isFocused = focusedCell?.rowIndex === rowIndex && focusedCell.columnIndex === columnIndex;
                  const cellClassName = [
                    "grid-cell",
                    value === null ? "is-null" : "",
                    NUMERIC_TYPE_PATTERN.test(column.typeName) ? "is-numeric" : "",
                    isFocused ? "is-focused" : "",
                    isCellPending?.(rowIndex, columnIndex) ? "is-pending-update" : "",
                  ].join(" ");
                  return (
                    <div
                      key={column.name}
                      className={cellClassName}
                      style={{ width: widthOf(column.name), padding: isEditing ? 0 : undefined }}
                      onMouseDown={(event) => handleCellMouseDown(event, rowIndex, columnIndex)}
                      onDoubleClick={() => startEditing({ rowIndex, columnIndex })}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        onCellContextMenu?.(event, rowIndex, columnIndex);
                      }}
                    >
                      {isEditing ? (
                        <input
                          ref={editorRef}
                          className="grid-cell-editor"
                          value={editingCell.draftValue}
                          onChange={(event) => setEditingCell({ ...editingCell, draftValue: event.target.value })}
                          onKeyDown={handleEditorKeyDown}
                          onBlur={commitEditing}
                        />
                      ) : (
                        formatCellPreview(value)
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

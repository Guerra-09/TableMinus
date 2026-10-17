import { useMemo, useState } from "react";
import type { CellValue, ColumnMeta } from "../lib/types";

interface RowDetailPanelProps {
  columns: ColumnMeta[];
  row: CellValue[] | null;
  isEditable: boolean;
  onFieldChange: (columnIndex: number, value: CellValue) => void;
}

export function RowDetailPanel({ columns, row, isEditable, onFieldChange }: RowDetailPanelProps) {
  const [columnSearch, setColumnSearch] = useState("");

  const visibleColumns = useMemo(() => {
    const normalizedSearch = columnSearch.trim().toLowerCase();
    return columns
      .map((column, columnIndex) => ({ column, columnIndex }))
      .filter(({ column }) => column.name.toLowerCase().includes(normalizedSearch));
  }, [columns, columnSearch]);

  return (
    <aside className="right-panel">
      <div className="right-panel-header">
        <input placeholder="Search column…" value={columnSearch} onChange={(event) => setColumnSearch(event.target.value)} />
      </div>
      <div className="right-panel-body">
        {!row ? (
          <div className="muted">Select a row to see its details</div>
        ) : (
          visibleColumns.map(({ column, columnIndex }) => {
            const value = row[columnIndex];
            return (
              <div key={column.name} className="field-editor">
                <label>
                  <span>{column.name}</span>
                  <span className="muted">{column.typeName.toLowerCase()}</span>
                </label>
                <textarea
                  key={`${column.name}-${String(value)}`}
                  rows={String(value ?? "").length > 60 ? 4 : 1}
                  defaultValue={value === null ? "" : String(value)}
                  placeholder={value === null ? "NULL" : ""}
                  readOnly={!isEditable}
                  onBlur={(event) => {
                    const nextValue = event.target.value;
                    const currentText = value === null ? "" : String(value);
                    if (nextValue !== currentText) onFieldChange(columnIndex, nextValue);
                  }}
                />
                {isEditable && value !== null && (
                  <button className="btn btn-ghost btn-small" onClick={() => onFieldChange(columnIndex, null)}>
                    Set NULL
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

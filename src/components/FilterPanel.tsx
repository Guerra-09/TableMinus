import { useEffect, useRef } from "react";
import { buildWhereClause } from "../lib/sql";
import { isModifierPressed } from "../lib/constants";
import { RAW_SQL_FILTER_COLUMN, type Driver, type FilterOperator, type RowFilter } from "../lib/types";

const FILTER_OPERATORS: FilterOperator[] = [
  "=",
  "<>",
  "<",
  ">",
  "<=",
  ">=",
  "IN",
  "NOT IN",
  "IS NULL",
  "IS NOT NULL",
  "BETWEEN",
  "CONTAINS",
  "NOT CONTAINS",
  "BEGINS WITH",
  "ENDS WITH",
];

const VALUELESS_OPERATORS: FilterOperator[] = ["IS NULL", "IS NOT NULL"];

export function createRowFilter(column: string, operator: FilterOperator = "=", value = ""): RowFilter {
  return { id: crypto.randomUUID(), isEnabled: true, column, operator, value, secondValue: "" };
}

interface FilterPanelProps {
  driver: Driver;
  columnNames: string[];
  filters: RowFilter[];
  appliedFilterIds: Set<string>;
  onFiltersChange: (filters: RowFilter[]) => void;
  onApply: (filters: RowFilter[]) => void;
  onShowSql: (sql: string) => void;
  onClose: () => void;
}

export function FilterPanel({
  driver,
  columnNames,
  filters,
  appliedFilterIds,
  onFiltersChange,
  onApply,
  onShowSql,
  onClose,
}: FilterPanelProps) {
  const firstValueInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstValueInputRef.current?.focus();
  }, []);

  const updateFilter = (filterId: string, changes: Partial<RowFilter>) =>
    onFiltersChange(filters.map((filter) => (filter.id === filterId ? { ...filter, ...changes } : filter)));

  const duplicateFilter = (filter: RowFilter) => {
    const filterIndex = filters.findIndex((candidate) => candidate.id === filter.id);
    const nextFilters = [...filters];
    nextFilters.splice(filterIndex + 1, 0, { ...filter, id: crypto.randomUUID() });
    onFiltersChange(nextFilters);
  };

  const removeFilter = (filterId: string) => {
    const remainingFilters = filters.filter((filter) => filter.id !== filterId);
    onFiltersChange(remainingFilters.length > 0 ? remainingFilters : [createRowFilter(columnNames[0] ?? RAW_SQL_FILTER_COLUMN)]);
  };

  const enabledFilters = filters.filter((filter) => filter.isEnabled);

  const handleKeyDown = (event: React.KeyboardEvent, filter: RowFilter) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Enter" && isModifierPressed(event)) {
      event.preventDefault();
      onApply(enabledFilters);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onApply([filter]);
    } else if (event.key.toLowerCase() === "i" && isModifierPressed(event)) {
      event.preventDefault();
      if (event.shiftKey) removeFilter(filter.id);
      else duplicateFilter(filter);
    }
  };

  return (
    <div className="filter-panel">
      {filters.map((filter, filterIndex) => {
        const isRawSql = filter.column === RAW_SQL_FILTER_COLUMN;
        const isApplied = appliedFilterIds.has(filter.id);
        return (
          <div key={filter.id} className="filter-row" onKeyDown={(event) => handleKeyDown(event, filter)}>
            <input
              type="checkbox"
              checked={filter.isEnabled}
              onChange={(event) => updateFilter(filter.id, { isEnabled: event.target.checked })}
            />
            <select value={filter.column} onChange={(event) => updateFilter(filter.id, { column: event.target.value })}>
              <option value={RAW_SQL_FILTER_COLUMN}>Raw SQL</option>
              {columnNames.map((columnName) => (
                <option key={columnName} value={columnName}>
                  {columnName}
                </option>
              ))}
            </select>
            {!isRawSql && (
              <select
                value={filter.operator}
                onChange={(event) => updateFilter(filter.id, { operator: event.target.value as FilterOperator })}
              >
                {FILTER_OPERATORS.map((operator) => (
                  <option key={operator} value={operator}>
                    {operator}
                  </option>
                ))}
              </select>
            )}
            {!VALUELESS_OPERATORS.includes(filter.operator) || isRawSql ? (
              <input
                ref={filterIndex === 0 ? firstValueInputRef : undefined}
                type="text"
                value={filter.value}
                placeholder={isRawSql ? "id = 1 OR name LIKE 'a%'" : filter.operator.includes("IN") ? "value1, value2" : "EMPTY"}
                onChange={(event) => updateFilter(filter.id, { value: event.target.value })}
              />
            ) : (
              <div style={{ flex: 1 }} />
            )}
            {filter.operator === "BETWEEN" && !isRawSql && (
              <input
                type="text"
                value={filter.secondValue}
                placeholder="and"
                onChange={(event) => updateFilter(filter.id, { secondValue: event.target.value })}
              />
            )}
            <button className={`btn btn-small ${isApplied ? "btn-primary" : ""}`} onClick={() => onApply([filter])}>
              {isApplied ? "Applied" : "Apply"}
            </button>
            <button className="icon-btn" title="Duplicate filter (⌘I)" onClick={() => duplicateFilter(filter)}>
              ＋
            </button>
            <button className="icon-btn" title="Remove filter (⌘⇧I)" onClick={() => removeFilter(filter.id)}>
              －
            </button>
          </div>
        );
      })}
      <div className="filter-actions">
        <button className="btn btn-small" onClick={() => onShowSql(buildWhereClause(driver, enabledFilters).trim() || "-- No filter")}>
          SQL
        </button>
        <button className="btn btn-small" onClick={() => onApply([])}>
          Unset
        </button>
        <button className="btn btn-small btn-primary" onClick={() => onApply(enabledFilters)}>
          Apply All
        </button>
      </div>
    </div>
  );
}

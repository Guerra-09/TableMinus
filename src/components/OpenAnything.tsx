import { useMemo, useState } from "react";
import { fuzzyMatches } from "./Sidebar";
import type { DbObject } from "../lib/types";

const MAX_OPEN_ANYTHING_RESULTS = 50;

export type OpenAnythingItem = { kind: "object"; object: DbObject } | { kind: "schema"; schema: string };

interface OpenAnythingProps {
  objects: DbObject[];
  schemas: string[];
  onOpen: (item: OpenAnythingItem) => void;
  onClose: () => void;
}

export function OpenAnything({ objects, schemas, onOpen, onClose }: OpenAnythingProps) {
  const [searchText, setSearchText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const results: OpenAnythingItem[] = useMemo(() => {
    const search = searchText.trim();
    const objectItems: OpenAnythingItem[] = objects
      .filter((object) => fuzzyMatches(object.name, search))
      .map((object) => ({ kind: "object", object }));
    const schemaItems: OpenAnythingItem[] = schemas
      .filter((schema) => fuzzyMatches(schema, search))
      .map((schema) => ({ kind: "schema", schema }));
    return [...objectItems, ...schemaItems].slice(0, MAX_OPEN_ANYTHING_RESULTS);
  }, [objects, schemas, searchText]);

  const openSelected = (item = results[selectedIndex]) => {
    if (!item) return;
    onOpen(item);
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(results.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      openSelected();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal open-anything" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-body">
          <input
            autoFocus
            placeholder="Search for table, view, schema…"
            value={searchText}
            onChange={(event) => {
              setSearchText(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          <div className="open-anything-results">
            {results.map((item, index) => (
              <div
                key={item.kind === "object" ? `object-${item.object.name}` : `schema-${item.schema}`}
                className={`open-anything-result ${index === selectedIndex ? "is-selected" : ""}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onDoubleClick={() => openSelected(item)}
                onClick={() => openSelected(item)}
              >
                <span className="sidebar-item-icon">
                  {item.kind === "schema" ? "◇" : item.object.kind === "view" ? "◫" : "▦"}
                </span>
                <span>{item.kind === "object" ? item.object.name : item.schema}</span>
                <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>
                  {item.kind === "object" ? item.object.kind : "schema"}
                </span>
              </div>
            ))}
            {results.length === 0 && <div className="muted">No matches</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

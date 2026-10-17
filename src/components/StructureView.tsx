import { useState } from "react";
import type { TableStructure } from "../lib/types";

interface StructureViewProps {
  structure: TableStructure;
}

export function StructureView({ structure }: StructureViewProps) {
  const [isDefinitionVisible, setIsDefinitionVisible] = useState(false);

  return (
    <div className="structure-view">
      <section>
        <div className="structure-section-title">
          <span>Columns ({structure.columns.length})</span>
          <button className="btn btn-small" onClick={() => setIsDefinitionVisible((isVisible) => !isVisible)}>
            {isDefinitionVisible ? "Hide definition" : "Definition"}
          </button>
        </div>
        {isDefinitionVisible && (
          <div style={{ marginBottom: 12 }}>
            <pre className="code-block">{structure.definition || "-- Definition not available"}</pre>
            <button className="btn btn-small" style={{ marginTop: 6 }} onClick={() => navigator.clipboard.writeText(structure.definition)}>
              Copy definition
            </button>
          </div>
        )}
        <table className="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>column_name</th>
              <th>data_type</th>
              <th>is_nullable</th>
              <th>column_default</th>
              <th>primary_key</th>
              <th>comment</th>
            </tr>
          </thead>
          <tbody>
            {structure.columns.map((column, index) => (
              <tr key={column.name}>
                <td className="muted">{index + 1}</td>
                <td>{column.name}</td>
                <td className="mono">{column.dataType}</td>
                <td>{column.isNullable ? "YES" : "NO"}</td>
                <td className="mono">{column.defaultValue ?? <span className="muted">NULL</span>}</td>
                <td>{column.isPrimaryKey ? "🔑" : ""}</td>
                <td>{column.comment ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <div className="structure-section-title">Indexes ({structure.indexes.length})</div>
        {structure.indexes.length === 0 ? (
          <div className="muted">No indexes</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>index_name</th>
                <th>definition</th>
                <th>is_unique</th>
                <th>is_primary</th>
              </tr>
            </thead>
            <tbody>
              {structure.indexes.map((index) => (
                <tr key={index.name}>
                  <td>{index.name}</td>
                  <td className="mono">{index.definition}</td>
                  <td>{index.isUnique ? "YES" : "NO"}</td>
                  <td>{index.isPrimary ? "YES" : "NO"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <div className="structure-section-title">Foreign keys ({structure.foreignKeys.length})</div>
        {structure.foreignKeys.length === 0 ? (
          <div className="muted">No foreign keys</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>constraint_name</th>
                <th>definition</th>
              </tr>
            </thead>
            <tbody>
              {structure.foreignKeys.map((foreignKey) => (
                <tr key={foreignKey.name}>
                  <td>{foreignKey.name}</td>
                  <td className="mono">{foreignKey.definition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

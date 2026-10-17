import { useEffect, useRef, useState } from "react";
import { clearConsoleLog, useConsoleEntries } from "../lib/consoleLog";

type ConsoleFilter = "all" | "data" | "meta" | "ai";

export function ConsoleLogPanel() {
  const entries = useConsoleEntries();
  const [consoleFilter, setConsoleFilter] = useState<ConsoleFilter>("all");
  const bodyRef = useRef<HTMLDivElement>(null);

  const visibleEntries = entries.filter((entry) => {
    if (consoleFilter === "all") return true;
    if (consoleFilter === "ai") return entry.source === "ai";
    return entry.kind === consoleFilter;
  });

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [visibleEntries.length]);

  return (
    <div className="console-log">
      <div className="console-log-header">
        <strong>Console</strong>
        <select value={consoleFilter} onChange={(event) => setConsoleFilter(event.target.value as ConsoleFilter)}>
          <option value="all">All queries</option>
          <option value="data">Data queries only</option>
          <option value="meta">Meta queries only</option>
          <option value="ai">AI (MCP) queries only</option>
        </select>
        <button className="btn btn-small" onClick={clearConsoleLog}>
          Clear
        </button>
      </div>
      <div className="console-log-body" ref={bodyRef}>
        {visibleEntries.map((entry) => (
          <div key={entry.id} className={`console-entry ${entry.error ? "is-error" : ""}`}>
            <span className="console-entry-time">
              {entry.timestamp.toLocaleTimeString()}
              {entry.durationMs !== undefined ? ` (${entry.durationMs} ms)` : ""}
            </span>
            {entry.source === "ai" && (
              <span className="console-entry-ai" title={`Executed by AI via MCP on ${entry.connectionName ?? ""}`}>
                AI{entry.connectionName ? ` · ${entry.connectionName}` : ""}
              </span>
            )}
            {entry.sql}
            {entry.error ? `\n  → ${entry.error}` : ""}
          </div>
        ))}
      </div>
    </div>
  );
}

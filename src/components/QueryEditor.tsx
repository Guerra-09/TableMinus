import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { MySQL, PostgreSQL, SQLite, sql as sqlLanguage } from "@codemirror/lang-sql";
import { Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { format as formatSql } from "sql-formatter";
import { DataGrid, type CellPosition } from "./DataGrid";
import { ExportDialog } from "./ExportDialog";
import { api } from "../lib/api";
import { MAX_RESULT_TABS, MOD_KEY_LABEL, SELECT_ALL_EVENT } from "../lib/constants";
import { findStatementAtOffset, splitSqlStatements } from "../lib/sql";
import type { Driver, QueryResult } from "../lib/types";
import { useWorkspace } from "../lib/workspaceContext";

const EDITOR_DIALECTS = { postgres: PostgreSQL, mysql: MySQL, sqlite: SQLite };
const FORMATTER_LANGUAGES = { postgres: "postgresql", mysql: "mysql", sqlite: "sqlite" } as const;
const MIN_EDITOR_HEIGHT = 80;

interface StatementOutcome {
  sql: string;
  result?: QueryResult;
  error?: string;
}

interface QueryEditorProps {
  initialSql: string;
  isDarkTheme: boolean;
}

function describeOutcome(outcome: StatementOutcome): string {
  if (outcome.error) return "Error";
  if (!outcome.result) return "";
  if (outcome.result.columns.length > 0) return `${outcome.result.rows.length} rows`;
  return `${outcome.result.rowsAffected} affected`;
}

function uglifySql(sqlText: string): string {
  return sqlText.replace(/\s+/g, " ").trim();
}

export function QueryEditor({ initialSql, isDarkTheme }: QueryEditorProps) {
  const workspace = useWorkspace();
  const { connectionId, driver } = workspace;
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [sqlText, setSqlText] = useState(initialSql);
  const [outcomes, setOutcomes] = useState<StatementOutcome[]>([]);
  const [activeOutcomeIndex, setActiveOutcomeIndex] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [editorHeight, setEditorHeight] = useState<number | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [focusedCell, setFocusedCell] = useState<CellPosition | null>(null);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [fileMessage, setFileMessage] = useState<string | null>(null);

  const runStatements = async (statements: string[]) => {
    if (statements.length === 0 || isRunning || !workspace.confirmStatements(statements)) return;
    setIsRunning(true);
    setSelectedRows(new Set());
    setFocusedCell(null);
    const nextOutcomes: StatementOutcome[] = [];
    for (const statement of statements.slice(0, MAX_RESULT_TABS)) {
      workspace.addHistoryEntry(statement);
      try {
        nextOutcomes.push({ sql: statement, result: await api.executeQuery(connectionId, statement) });
      } catch (error) {
        nextOutcomes.push({ sql: statement, error: String(error) });
        break;
      }
    }
    setOutcomes(nextOutcomes);
    const firstErrorIndex = nextOutcomes.findIndex((outcome) => outcome.error);
    const lastResultSetIndex = nextOutcomes.map((outcome) => (outcome.result?.columns.length ?? 0) > 0).lastIndexOf(true);
    setActiveOutcomeIndex(firstErrorIndex >= 0 ? firstErrorIndex : Math.max(0, lastResultSetIndex));
    setIsRunning(false);
    if (statements.some((statement) => /^\s*(CREATE|DROP|ALTER|RENAME)\b/i.test(statement))) workspace.reloadObjects();
  };

  const runCurrent = () => {
    const view = editorRef.current?.view;
    if (!view) return;
    const selection = view.state.selection.main;
    const hasBackslashEscapes = driver === "mysql";
    if (!selection.empty) {
      const selectedText = view.state.sliceDoc(selection.from, selection.to);
      runStatements(splitSqlStatements(selectedText, hasBackslashEscapes).map((statement) => statement.text));
      return;
    }
    const statement = findStatementAtOffset(view.state.doc.toString(), selection.head, hasBackslashEscapes);
    if (statement) runStatements([statement.text]);
  };

  const runAll = () => {
    const view = editorRef.current?.view;
    if (!view) return;
    runStatements(splitSqlStatements(view.state.doc.toString(), driver === "mysql").map((statement) => statement.text));
  };

  const transformSelectionOrDocument = (transform: (text: string) => string) => {
    const view = editorRef.current?.view;
    if (!view) return;
    const selection = view.state.selection.main;
    const from = selection.empty ? 0 : selection.from;
    const to = selection.empty ? view.state.doc.length : selection.to;
    try {
      view.dispatch({ changes: { from, to, insert: transform(view.state.sliceDoc(from, to)) } });
    } catch (error) {
      setFileMessage(`Format failed: ${String(error)}`);
    }
  };

  const beautify = () =>
    transformSelectionOrDocument((text) => formatSql(text, { language: FORMATTER_LANGUAGES[driver as Driver], keywordCase: "upper" }));

  const uglify = () => transformSelectionOrDocument(uglifySql);

  const actionsRef = useRef({ runCurrent, runAll, beautify, uglify });
  actionsRef.current = { runCurrent, runAll, beautify, uglify };

  const selectAllSqlRef = useRef<() => void>(() => undefined);
  selectAllSqlRef.current = () => {
    const view = editorRef.current?.view;
    const activeElement = document.activeElement;
    if (!view || activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) return;
    if (!view.dom.contains(activeElement)) return;
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length }, scrollIntoView: true });
  };

  useEffect(() => {
    const handleSelectAll = () => selectAllSqlRef.current();
    window.addEventListener(SELECT_ALL_EVENT, handleSelectAll);
    return () => window.removeEventListener(SELECT_ALL_EVENT, handleSelectAll);
  }, []);

  const extensions = useMemo(
    () => [
      sqlLanguage({ dialect: EDITOR_DIALECTS[driver], schema: workspace.schemaColumns, upperCaseKeywords: true }),
      EditorView.lineWrapping,
      Prec.highest(
        keymap.of([
          { key: "Mod-Enter", run: () => (actionsRef.current.runCurrent(), true) },
          { key: "Shift-Mod-Enter", run: () => (actionsRef.current.runAll(), true) },
          { key: "Mod-i", run: () => (actionsRef.current.beautify(), true) },
          { key: "Shift-Mod-i", run: () => (actionsRef.current.uglify(), true) },
        ]),
      ),
    ],
    [driver, workspace.schemaColumns],
  );

  const openSqlFile = async () => {
    const filePath = await openFileDialog({ multiple: false, filters: [{ name: "SQL", extensions: ["sql", "txt"] }] });
    if (typeof filePath !== "string") return;
    setSqlText(await api.readTextFile(filePath));
    setFileMessage(`Opened ${filePath}`);
  };

  const saveSqlFile = async () => {
    const filePath = await saveFileDialog({ defaultPath: "query.sql", filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (!filePath) return;
    await api.writeTextFile(filePath, sqlText);
    setFileMessage(`Saved ${filePath}`);
  };

  const importSqlDump = async () => {
    const filePath = await openFileDialog({ multiple: false, filters: [{ name: "SQL dump", extensions: ["sql"] }] });
    if (typeof filePath !== "string") return;
    try {
      const statements = splitSqlStatements(await api.readTextFile(filePath), driver === "mysql").map((statement) => statement.text);
      if (!window.confirm(`Run ${statements.length} statements from ${filePath} in a single transaction?`)) return;
      const rowsAffected = await api.executeTransaction(connectionId, statements);
      setFileMessage(`Imported ${statements.length} statements (${rowsAffected} rows affected)`);
      workspace.reloadObjects();
    } catch (error) {
      setFileMessage(`Import failed: ${String(error)}`);
    }
  };

  const startResize = (event: React.MouseEvent) => {
    event.preventDefault();
    const containerTop = containerRef.current?.getBoundingClientRect().top ?? 0;
    const containerHeight = containerRef.current?.getBoundingClientRect().height ?? 600;
    const handleMouseMove = (moveEvent: MouseEvent) => {
      setEditorHeight(Math.min(containerHeight - MIN_EDITOR_HEIGHT, Math.max(MIN_EDITOR_HEIGHT, moveEvent.clientY - containerTop)));
    };
    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const activeOutcome = outcomes[activeOutcomeIndex];

  return (
    <div className="query-editor" ref={containerRef}>
      <div className="query-editor-input" style={editorHeight ? { height: editorHeight } : undefined}>
        <CodeMirror
          ref={editorRef}
          value={sqlText}
          onChange={setSqlText}
          extensions={extensions}
          theme={isDarkTheme ? "dark" : "light"}
          autoFocus
          basicSetup={{ highlightActiveLine: true, foldGutter: false }}
        />
        <div className="query-editor-actions">
          <button className="btn btn-small btn-primary" onClick={runCurrent} disabled={isRunning} title={`${MOD_KEY_LABEL}⏎`}>
            {isRunning ? "Running…" : "Run Current"}
          </button>
          <button className="btn btn-small" onClick={runAll} disabled={isRunning} title={`${MOD_KEY_LABEL}⇧⏎`}>
            Run All
          </button>
          <button className="btn btn-small" onClick={beautify} title={`${MOD_KEY_LABEL}I`}>
            Beautify
          </button>
          <button className="btn btn-small" onClick={uglify} title={`${MOD_KEY_LABEL}⇧I`}>
            Uglify
          </button>
          <div className="bottom-bar-spacer" />
          {fileMessage && <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{fileMessage}</span>}
          <button className="btn btn-small" onClick={openSqlFile}>
            Open…
          </button>
          <button className="btn btn-small" onClick={saveSqlFile}>
            Save SQL as…
          </button>
          <button className="btn btn-small" onClick={importSqlDump}>
            Import SQL dump…
          </button>
        </div>
      </div>
      <div className="splitter" onMouseDown={startResize} />

      {outcomes.length > 1 && (
        <div className="result-tabs">
          {outcomes.map((outcome, index) => (
            <button
              key={index}
              className={index === activeOutcomeIndex ? "is-active" : ""}
              onClick={() => setActiveOutcomeIndex(index)}
              title={outcome.sql}
            >
              Result {index + 1} · {describeOutcome(outcome)}
            </button>
          ))}
        </div>
      )}

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {!activeOutcome ? (
          <div className="empty-state">Run a query to see results ({MOD_KEY_LABEL}⏎)</div>
        ) : activeOutcome.error ? (
          <div className="result-message">
            <div className="error-text">{activeOutcome.error}</div>
            <pre className="code-block" style={{ marginTop: 10 }}>
              {activeOutcome.sql}
            </pre>
          </div>
        ) : activeOutcome.result && activeOutcome.result.columns.length > 0 ? (
          <DataGrid
            columns={activeOutcome.result.columns}
            rows={activeOutcome.result.rows}
            isEditable={false}
            selectedRows={selectedRows}
            focusedCell={focusedCell}
            onSelectionChange={(nextSelectedRows, nextFocusedCell) => {
              setSelectedRows(nextSelectedRows);
              setFocusedCell(nextFocusedCell);
            }}
          />
        ) : (
          <div className="result-message muted">
            Query executed successfully. {activeOutcome.result?.rowsAffected ?? 0} rows affected.
          </div>
        )}
      </div>

      <div className="bottom-bar">
        {activeOutcome?.result && (
          <span className="muted">
            {describeOutcome(activeOutcome)} · {activeOutcome.result.durationMs} ms
          </span>
        )}
        <div className="bottom-bar-spacer" />
        <button
          className="btn btn-small"
          disabled={!activeOutcome?.result || activeOutcome.result.columns.length === 0}
          onClick={() => setIsExportOpen(true)}
        >
          Export…
        </button>
      </div>

      {isExportOpen && activeOutcome?.result && (
        <ExportDialog
          driver={driver}
          qualifiedTableName="query_result"
          defaultFileName="query_result"
          onClose={() => setIsExportOpen(false)}
          sources={[
            {
              label: "All result rows",
              load: async () => ({
                columnNames: activeOutcome.result!.columns.map((column) => column.name),
                rows: activeOutcome.result!.rows,
              }),
            },
          ]}
        />
      )}
    </div>
  );
}

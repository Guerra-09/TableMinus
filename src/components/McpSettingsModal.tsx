import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import type { McpStatus } from "../lib/types";

const MCP_SERVER_NAME = "tableminus";

interface McpSettingsModalProps {
  onClose: () => void;
}

function buildClaudeCodeCommand(status: McpStatus): string {
  return `claude mcp add --scope user --transport http ${MCP_SERVER_NAME} ${status.endpoint} --header "Authorization: Bearer ${status.settings.token}"`;
}

function buildJsonConfig(status: McpStatus): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "http",
          url: status.endpoint,
          headers: { Authorization: `Bearer ${status.settings.token}` },
        },
      },
    },
    null,
    2,
  );
}

export function McpSettingsModal({ onClose }: McpSettingsModalProps) {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [portDraft, setPortDraft] = useState("");
  const [isTokenVisible, setIsTokenVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);

  const applyStatus = (nextStatus: McpStatus) => {
    setStatus(nextStatus);
    setPortDraft(String(nextStatus.settings.port));
  };

  useEffect(() => {
    api.getMcpStatus().then(applyStatus).catch((loadError) => setError(String(loadError)));
  }, []);

  const runUpdate = async (update: () => Promise<McpStatus>) => {
    setError(null);
    try {
      applyStatus(await update());
    } catch (updateError) {
      setError(String(updateError));
    }
  };

  const copyText = async (label: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedLabel(label);
    window.setTimeout(() => setCopiedLabel(null), 1500);
  };

  const maskedToken = status ? `${status.settings.token.slice(0, 6)}${"•".repeat(20)}` : "";

  return (
    <Modal
      title="AI access (MCP)"
      isWide
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      {!status ? (
        <div className="muted">{error ?? "Loading…"}</div>
      ) : (
        <div className="mcp-settings">
          <p className="muted" style={{ marginTop: 0 }}>
            Let AI assistants such as Claude Code use your saved connections through a local MCP server. Credentials
            are never shared with the assistant, and everything it runs appears in the console marked as AI.
          </p>

          <div className="form-grid">
            <label>Server</label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, textAlign: "left", color: "var(--color-text)" }}>
              <input
                type="checkbox"
                checked={status.settings.isEnabled}
                onChange={(event) => runUpdate(() => api.updateMcpSettings(event.target.checked, Number(portDraft)))}
              />
              Enable MCP server
              <span className={`server-dot is-${status.isRunning ? "running" : "stopped"}`} />
              <span className="muted">{status.isRunning ? `Running on ${status.endpoint}` : "Stopped"}</span>
            </label>

            <label>Port</label>
            <div className="form-row-inline">
              <input
                type="number"
                value={portDraft}
                onChange={(event) => setPortDraft(event.target.value)}
                style={{ maxWidth: 120 }}
              />
              <button
                className="btn"
                style={{ flex: "none" }}
                disabled={Number(portDraft) === status.settings.port}
                onClick={() => runUpdate(() => api.updateMcpSettings(status.settings.isEnabled, Number(portDraft)))}
              >
                Apply
              </button>
            </div>

            <label>Token</label>
            <div className="form-row-inline">
              <input className="mono" readOnly value={isTokenVisible ? status.settings.token : maskedToken} style={{ flex: 3 }} />
              <button className="btn" style={{ flex: "none" }} onClick={() => setIsTokenVisible((isVisible) => !isVisible)}>
                {isTokenVisible ? "Hide" : "Show"}
              </button>
              <button
                className="btn"
                style={{ flex: "none" }}
                onClick={() => {
                  if (window.confirm("Generate a new token? Assistants using the current token will stop working.")) {
                    runUpdate(api.regenerateMcpToken);
                  }
                }}
              >
                Regenerate
              </button>
            </div>
          </div>

          {(error || status.lastError) && <p className="error-text">{error ?? status.lastError}</p>}

          <h4 className="changelog-section">Connect Claude Code</h4>
          <p className="muted" style={{ margin: "4px 0" }}>
            Run once in your terminal, then restart Claude Code. TableMinus must be open for the tools to work.
          </p>
          <pre className="code-block">{buildClaudeCodeCommand(status)}</pre>
          <button className="btn btn-small" style={{ marginTop: 6 }} onClick={() => copyText("command", buildClaudeCodeCommand(status))}>
            {copiedLabel === "command" ? "Copied ✓" : "Copy command"}
          </button>

          <h4 className="changelog-section">Other MCP clients (JSON config)</h4>
          <pre className="code-block">{buildJsonConfig(status)}</pre>
          <button className="btn btn-small" style={{ marginTop: 6 }} onClick={() => copyText("json", buildJsonConfig(status))}>
            {copiedLabel === "json" ? "Copied ✓" : "Copy JSON"}
          </button>

          <h4 className="changelog-section">What the assistant can do</h4>
          <table className="data-table">
            <thead>
              <tr>
                <th>Connection</th>
                <th>Reads</th>
                <th>Writes</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Tag Production</td>
                <td>Allowed, in a read-only transaction</td>
                <td>Blocked — the assistant must give you the SQL to run yourself</td>
              </tr>
              <tr>
                <td>Safe mode Silent</td>
                <td>Allowed</td>
                <td>Allowed</td>
              </tr>
              <tr>
                <td>Safe mode “confirm except SELECT/EXPLAIN”</td>
                <td>Allowed</td>
                <td>You approve each one in TableMinus</td>
              </tr>
              <tr>
                <td>Safe mode “confirm every query”</td>
                <td>You approve each one</td>
                <td>You approve each one</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

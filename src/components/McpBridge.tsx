import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import { logQuery } from "../lib/consoleLog";
import { CONNECTION_TAGS } from "../lib/constants";
import type { McpActivity, McpApprovalRequest } from "../lib/types";

const APPROVAL_REQUEST_EVENT = "mcp-approval-request";
const APPROVAL_CLOSED_EVENT = "mcp-approval-closed";
const ACTIVITY_EVENT = "mcp-activity";

/**
 * Listens to MCP server events: logs every AI-executed statement in the console
 * and shows a queue of approval dialogs for statements that need the user's OK.
 */
export function McpBridge() {
  const [pendingApprovals, setPendingApprovals] = useState<McpApprovalRequest[]>([]);

  useEffect(() => {
    const unlistenPromises = [
      listen<McpApprovalRequest>(APPROVAL_REQUEST_EVENT, (event) =>
        setPendingApprovals((current) => [...current, event.payload]),
      ),
      listen<string>(APPROVAL_CLOSED_EVENT, (event) =>
        setPendingApprovals((current) => current.filter((request) => request.id !== event.payload)),
      ),
      listen<McpActivity>(ACTIVITY_EVENT, (event) =>
        logQuery({
          sql: event.payload.sql,
          kind: "data",
          source: "ai",
          connectionName: event.payload.connectionName,
          durationMs: event.payload.durationMs ?? undefined,
          error: event.payload.error ?? undefined,
        }),
      ),
    ];
    return () => {
      unlistenPromises.forEach((unlistenPromise) => unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined));
    };
  }, []);

  const currentRequest = pendingApprovals[0];
  if (!currentRequest) return null;

  const decide = (isApproved: boolean) => {
    setPendingApprovals((current) => current.filter((request) => request.id !== currentRequest.id));
    api.resolveMcpApproval(currentRequest.id, isApproved).catch(() => undefined);
  };

  const connectionTag = CONNECTION_TAGS.find((tag) => tag.value === currentRequest.tag);

  return (
    <Modal
      title="AI assistant wants to run a query"
      isWide
      shouldCloseOnBackdrop={false}
      onClose={() => decide(false)}
      footer={
        <>
          {pendingApprovals.length > 1 && <span className="muted">{pendingApprovals.length - 1} more waiting</span>}
          <div style={{ flex: 1 }} />
          <button className="btn btn-danger" onClick={() => decide(false)}>
            Reject
          </button>
          <button className="btn btn-primary" onClick={() => decide(true)} autoFocus>
            Approve and run
          </button>
        </>
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <strong>{currentRequest.connectionName}</strong>
        {connectionTag && (
          <span className="tag-pill" style={{ background: connectionTag.color }}>
            {connectionTag.label}
          </span>
        )}
        <span className="muted">{currentRequest.reason}</span>
      </div>
      <pre className="code-block" style={{ maxHeight: "50vh" }}>
        {currentRequest.sql}
      </pre>
      <p className="muted" style={{ marginBottom: 0 }}>
        Requested via MCP. Rejecting tells the assistant not to run it. Unanswered requests are rejected after 3 minutes.
      </p>
    </Modal>
  );
}

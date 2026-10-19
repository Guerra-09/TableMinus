import { createContext, useContext } from "react";
import type { ConnectionConfig, DbObject, Driver, TableRef } from "./types";

export interface TabActions {
  getPendingStatements: () => string[];
  commitChanges: () => Promise<void>;
  discardChanges: () => void;
  reload: () => void;
}

export interface QueryHistoryEntry {
  id: string;
  sql: string;
  executedAt: string;
}

export interface WorkspaceContextValue {
  connectionId: string;
  connection: ConnectionConfig;
  driver: Driver;
  schemas: string[];
  currentSchema: string;
  objects: DbObject[];
  schemaColumns: Record<string, string[]>;
  history: QueryHistoryEntry[];
  openTable: (table: TableRef, options?: { isNewTab?: boolean; view?: "data" | "structure" }) => void;
  openQueryEditor: (initialSql?: string) => void;
  reloadObjects: () => Promise<void>;
  closeTabsForObjects: (schema: string, tableNames: string[]) => void;
  addHistoryEntry: (sql: string) => void;
  removeHistoryEntry: (id: string) => void;
  clearHistory: () => void;
  confirmStatements: (statements: string[]) => boolean;
  registerTabActions: (tabId: string, actions: TabActions | null) => void;
  setTabPendingCount: (tabId: string, pendingCount: number) => void;
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace must be used inside WorkspaceContext");
  return context;
}

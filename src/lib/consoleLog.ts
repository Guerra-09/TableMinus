import { useSyncExternalStore } from "react";

export interface ConsoleEntry {
  id: number;
  timestamp: Date;
  sql: string;
  kind: "data" | "meta";
  durationMs?: number;
  error?: string;
}

const MAX_CONSOLE_ENTRIES = 1000;

let consoleEntries: ConsoleEntry[] = [];
let nextEntryId = 1;
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((listener) => listener());
}

export function logQuery(entry: Omit<ConsoleEntry, "id" | "timestamp">) {
  consoleEntries = [...consoleEntries, { ...entry, id: nextEntryId++, timestamp: new Date() }].slice(
    -MAX_CONSOLE_ENTRIES,
  );
  notifyListeners();
}

export function clearConsoleLog() {
  consoleEntries = [];
  notifyListeners();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConsoleEntries() {
  return useSyncExternalStore(subscribe, () => consoleEntries);
}

import { useEffect, useState } from "react";
import { Welcome } from "./components/Welcome";
import { Workspace } from "./components/Workspace";
import { api } from "./lib/api";
import { useAppZoom } from "./lib/appZoom";
import type { OpenedConnection } from "./lib/types";

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

function useIsDarkTheme(): boolean {
  const [isDarkTheme, setIsDarkTheme] = useState(() => window.matchMedia(DARK_SCHEME_QUERY).matches);
  useEffect(() => {
    const mediaQuery = window.matchMedia(DARK_SCHEME_QUERY);
    const handleChange = (event: MediaQueryListEvent) => setIsDarkTheme(event.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);
  return isDarkTheme;
}

export default function App() {
  const isDarkTheme = useIsDarkTheme();
  const zoomIndicatorPercent = useAppZoom();
  const [openedConnection, setOpenedConnection] = useState<OpenedConnection | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    const preventBrowserShortcuts = (event: KeyboardEvent) => {
      const isModifier = event.metaKey || event.ctrlKey;
      if (isModifier && ["r", "p", "f", "s"].includes(event.key.toLowerCase())) event.preventDefault();
    };
    const preventDefaultContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest("input, textarea, .cm-editor")) event.preventDefault();
    };
    window.addEventListener("keydown", preventBrowserShortcuts, { capture: false });
    window.addEventListener("contextmenu", preventDefaultContextMenu);
    return () => {
      window.removeEventListener("keydown", preventBrowserShortcuts);
      window.removeEventListener("contextmenu", preventDefaultContextMenu);
    };
  }, []);

  const connect = async (connectionId: string) => {
    setConnectingId(connectionId);
    setConnectError(null);
    try {
      setOpenedConnection(await api.openConnection(connectionId));
    } catch (error) {
      setConnectError(String(error));
    } finally {
      setConnectingId(null);
    }
  };

  const disconnect = async () => {
    if (!openedConnection) return;
    await api.closeConnection(openedConnection.connection.id);
    setOpenedConnection(null);
  };

  return (
    <>
      {openedConnection ? (
        <Workspace key={openedConnection.connection.id} opened={openedConnection} isDarkTheme={isDarkTheme} onDisconnect={disconnect} />
      ) : (
        <Welcome connectingId={connectingId} connectError={connectError} onConnect={connect} />
      )}
      {zoomIndicatorPercent !== null && <div className="zoom-indicator">{zoomIndicatorPercent}%</div>}
    </>
  );
}

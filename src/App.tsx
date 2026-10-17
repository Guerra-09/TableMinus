import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ConsoleLogPanel } from "./components/ConsoleLogPanel";
import { McpBridge } from "./components/McpBridge";
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
  const [isConsoleOpen, setIsConsoleOpen] = useState(false);
  const [isNewConnectionRequested, setIsNewConnectionRequested] = useState(false);
  const toggleConsole = () => setIsConsoleOpen((isOpen) => !isOpen);

  useEffect(() => {
    const handleConsoleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === "KeyC") {
        event.preventDefault();
        setIsConsoleOpen((isOpen) => !isOpen);
      }
    };
    window.addEventListener("keydown", handleConsoleShortcut);
    return () => window.removeEventListener("keydown", handleConsoleShortcut);
  }, []);

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

  const openedConnectionRef = useRef<OpenedConnection | null>(null);
  openedConnectionRef.current = openedConnection;

  const startLocalServerIfStopped = async (connectionId: string) => {
    const statuses = await api.localServerStatuses().catch(() => []);
    if (statuses.some((status) => status.connectionId === connectionId && status.state === "stopped")) {
      await api.startLocalServer(connectionId);
    }
  };

  const connect = async (connectionId: string) => {
    setConnectingId(connectionId);
    setConnectError(null);
    try {
      await startLocalServerIfStopped(connectionId);
      setOpenedConnection(await api.openConnection(connectionId));
    } catch (error) {
      setConnectError(String(error));
    } finally {
      setConnectingId(null);
    }
  };

  const disconnect = async () => {
    const currentConnection = openedConnectionRef.current;
    if (!currentConnection) return;
    await api.closeConnection(currentConnection.connection.id).catch(() => undefined);
    setOpenedConnection(null);
  };

  const menuActionsRef = useRef({ connect, disconnect });
  menuActionsRef.current = { connect, disconnect };

  useEffect(() => {
    const unlistenPromises = [
      listen("menu-show-connections", () => menuActionsRef.current.disconnect()),
      listen("menu-new-connection", async () => {
        await menuActionsRef.current.disconnect();
        setIsNewConnectionRequested(true);
      }),
      listen<string>("menu-open-connection", async (event) => {
        if (openedConnectionRef.current?.connection.id === event.payload) return;
        await menuActionsRef.current.disconnect();
        await menuActionsRef.current.connect(event.payload);
      }),
    ];
    return () => {
      unlistenPromises.forEach((unlistenPromise) => unlistenPromise.then((unlisten) => unlisten()).catch(() => undefined));
    };
  }, []);

  return (
    <div className="app-shell">
      <div className="app-main">
        {openedConnection ? (
          <Workspace
            key={openedConnection.connection.id}
            opened={openedConnection}
            isDarkTheme={isDarkTheme}
            isConsoleOpen={isConsoleOpen}
            onToggleConsole={toggleConsole}
            onDisconnect={disconnect}
          />
        ) : (
          <Welcome
            isNewConnectionRequested={isNewConnectionRequested}
            onNewConnectionRequestHandled={() => setIsNewConnectionRequested(false)}
            isConsoleOpen={isConsoleOpen}
            onToggleConsole={toggleConsole}
            connectingId={connectingId}
            connectError={connectError}
            onConnect={connect}
          />
        )}
      </div>
      {isConsoleOpen && <ConsoleLogPanel />}
      <McpBridge />
      {zoomIndicatorPercent !== null && <div className="zoom-indicator">{zoomIndicatorPercent}%</div>}
    </div>
  );
}

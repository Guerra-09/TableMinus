import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

const ZOOM_STORAGE_KEY = "app-zoom-level";
const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const DEFAULT_ZOOM_LEVEL = 1;
const ZOOM_INDICATOR_DURATION_MS = 1200;

function readStoredZoom(): number {
  try {
    const storedZoom = Number(localStorage.getItem(ZOOM_STORAGE_KEY));
    return ZOOM_LEVELS.includes(storedZoom) ? storedZoom : DEFAULT_ZOOM_LEVEL;
  } catch {
    return DEFAULT_ZOOM_LEVEL;
  }
}

function storeZoom(zoomLevel: number) {
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(zoomLevel));
  } catch {
    return;
  }
}

async function applyZoom(zoomLevel: number) {
  try {
    await getCurrentWebview().setZoom(zoomLevel);
  } catch {
    document.documentElement.style.setProperty("zoom", String(zoomLevel));
  }
}

function nextZoomLevel(currentZoom: number, direction: 1 | -1): number {
  const currentIndex = ZOOM_LEVELS.indexOf(currentZoom);
  const nextIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, currentIndex + direction));
  return ZOOM_LEVELS[nextIndex];
}

/**
 * Whole-app zoom with ⌘/Ctrl + "+", "-" and "0", persisted per device.
 * Returns the zoom percentage to show briefly after each change, or null.
 */
export function useAppZoom(): number | null {
  const zoomRef = useRef(readStoredZoom());
  const hideTimerRef = useRef<number | undefined>(undefined);
  const [indicatorPercent, setIndicatorPercent] = useState<number | null>(null);

  const setZoom = useCallback((zoomLevel: number) => {
    zoomRef.current = zoomLevel;
    storeZoom(zoomLevel);
    applyZoom(zoomLevel);
    setIndicatorPercent(Math.round(zoomLevel * 100));
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setIndicatorPercent(null), ZOOM_INDICATOR_DURATION_MS);
  }, []);

  useEffect(() => {
    if (zoomRef.current !== DEFAULT_ZOOM_LEVEL) applyZoom(zoomRef.current);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        setZoom(nextZoomLevel(zoomRef.current, 1));
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setZoom(nextZoomLevel(zoomRef.current, -1));
      } else if (event.key === "0" && !event.shiftKey) {
        event.preventDefault();
        setZoom(DEFAULT_ZOOM_LEVEL);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.clearTimeout(hideTimerRef.current);
    };
  }, [setZoom]);

  return indicatorPercent;
}

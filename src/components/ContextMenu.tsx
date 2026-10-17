import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type ContextMenuEntry =
  | { label: string; onSelect: () => void; isDisabled?: boolean }
  | { isSeparator: true };

export interface ContextMenuState {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
}

interface ContextMenuProps {
  menu: ContextMenuState;
  onClose: () => void;
}

export function ContextMenu({ menu, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: menu.x, y: menu.y });

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    setPosition({
      x: Math.min(menu.x, window.innerWidth - bounds.width - 8),
      y: Math.min(menu.y, window.innerHeight - bounds.height - 8),
    });
  }, [menu.x, menu.y]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div ref={menuRef} className="context-menu" style={{ left: position.x, top: position.y }}>
      {menu.entries.map((entry, index) =>
        "isSeparator" in entry ? (
          <div key={index} className="context-menu-separator" />
        ) : (
          <button
            key={index}
            className="context-menu-item"
            disabled={entry.isDisabled}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            {entry.label}
          </button>
        ),
      )}
    </div>
  );
}

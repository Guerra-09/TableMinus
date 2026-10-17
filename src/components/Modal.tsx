import { useEffect, useRef, useState, type ReactNode } from "react";

const MIN_VISIBLE_HEADER_PIXELS = 48;

interface ModalProps {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  isWide?: boolean;
  shouldCloseOnBackdrop?: boolean;
  onClose: () => void;
}

interface DragOffset {
  x: number;
  y: number;
}

export function Modal({ title, children, footer, isWide = false, shouldCloseOnBackdrop = true, onClose }: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [dragOffset, setDragOffset] = useState<DragOffset>({ x: 0, y: 0 });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const startDragging = (event: React.MouseEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button, input, select, textarea")) return;
    event.preventDefault();
    const pointerStart = { x: event.clientX - dragOffset.x, y: event.clientY - dragOffset.y };
    const initialBounds = modalRef.current?.getBoundingClientRect();
    const handleMouseMove = (moveEvent: MouseEvent) => {
      let nextX = moveEvent.clientX - pointerStart.x;
      let nextY = moveEvent.clientY - pointerStart.y;
      if (initialBounds) {
        const deltaX = nextX - dragOffset.x;
        const deltaY = nextY - dragOffset.y;
        const projectedLeft = initialBounds.left + deltaX;
        const projectedTop = initialBounds.top + deltaY;
        nextX -= Math.min(0, projectedLeft + initialBounds.width - MIN_VISIBLE_HEADER_PIXELS);
        nextX -= Math.max(0, projectedLeft - (window.innerWidth - MIN_VISIBLE_HEADER_PIXELS));
        nextY -= Math.min(0, projectedTop);
        nextY -= Math.max(0, projectedTop - (window.innerHeight - MIN_VISIBLE_HEADER_PIXELS));
      }
      setDragOffset({ x: nextX, y: nextY });
    };
    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const resetPositionAndSize = () => {
    setDragOffset({ x: 0, y: 0 });
    modalRef.current?.style.removeProperty("width");
    modalRef.current?.style.removeProperty("height");
  };

  return (
    <div className="modal-backdrop" onMouseDown={shouldCloseOnBackdrop ? onClose : undefined}>
      <div
        ref={modalRef}
        className={`modal is-floating ${isWide ? "modal-wide" : ""}`}
        style={{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className="modal-header is-draggable"
          onMouseDown={startDragging}
          onDoubleClick={resetPositionAndSize}
          title="Drag to move · double-click to reset"
        >
          {title}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

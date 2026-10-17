import { useEffect, type ReactNode } from "react";

interface ModalProps {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  isWide?: boolean;
  onClose: () => void;
}

export function Modal({ title, children, footer, isWide = false, onClose }: ModalProps) {
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

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${isWide ? "modal-wide" : ""}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">{title}</div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

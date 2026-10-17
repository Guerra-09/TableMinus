import { useState } from "react";
import { Modal } from "./Modal";
import type { CellValue } from "../lib/types";

interface QuickLookModalProps {
  title: string;
  value: CellValue;
  isEditable: boolean;
  onSave: (value: CellValue) => void;
  onClose: () => void;
}

function prettifyValue(value: CellValue): string {
  if (value === null) return "";
  const text = String(value);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
  return text;
}

export function QuickLookModal({ title, value, isEditable, onSave, onClose }: QuickLookModalProps) {
  const [draftValue, setDraftValue] = useState(() => prettifyValue(value));

  return (
    <Modal
      title={`Quick Look — ${title}`}
      isWide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => navigator.clipboard.writeText(draftValue)}>
            Copy
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Close
          </button>
          {isEditable && (
            <button
              className="btn btn-primary"
              onClick={() => {
                onSave(draftValue);
                onClose();
              }}
            >
              Update
            </button>
          )}
        </>
      }
    >
      <textarea
        className="quick-look-content"
        value={draftValue}
        placeholder={value === null ? "NULL" : ""}
        readOnly={!isEditable}
        onChange={(event) => setDraftValue(event.target.value)}
      />
    </Modal>
  );
}

import { useState } from "react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import { EXPORT_FILE_EXTENSIONS, EXPORT_FORMAT_LABELS, serializeRows, type ExportFormat } from "../lib/exporters";
import type { CellValue, Driver } from "../lib/types";

const FILE_EXPORT_FORMATS: ExportFormat[] = ["csv-header", "json", "sql", "markdown"];

export interface ExportSource {
  label: string;
  load: () => Promise<{ columnNames: string[]; rows: CellValue[][] }>;
}

interface ExportDialogProps {
  driver: Driver;
  qualifiedTableName: string;
  defaultFileName: string;
  sources: ExportSource[];
  onClose: () => void;
}

export function ExportDialog({ driver, qualifiedTableName, defaultFileName, sources, onClose }: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("csv-header");
  const [sourceIndex, setSourceIndex] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const exportToFile = async () => {
    const extension = EXPORT_FILE_EXTENSIONS[format];
    const filePath = await saveFileDialog({
      defaultPath: `${defaultFileName}.${extension}`,
      filters: [{ name: EXPORT_FORMAT_LABELS[format], extensions: [extension] }],
    });
    if (!filePath) return;
    setIsExporting(true);
    setStatus(null);
    try {
      const { columnNames, rows } = await sources[sourceIndex].load();
      await api.writeTextFile(filePath, serializeRows(format, { driver, qualifiedTableName, columnNames, rows }));
      setStatus(`Exported ${rows.length} rows to ${filePath}`);
    } catch (error) {
      setStatus(`Export failed: ${String(error)}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Modal
      title="Export"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" onClick={exportToFile} disabled={isExporting}>
            {isExporting ? "Exporting…" : "Export…"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>Format</label>
        <select value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
          {FILE_EXPORT_FORMATS.map((exportFormat) => (
            <option key={exportFormat} value={exportFormat}>
              {EXPORT_FORMAT_LABELS[exportFormat]}
            </option>
          ))}
        </select>
        <label>Rows</label>
        <select value={sourceIndex} onChange={(event) => setSourceIndex(Number(event.target.value))}>
          {sources.map((source, index) => (
            <option key={source.label} value={index}>
              {source.label}
            </option>
          ))}
        </select>
      </div>
      {status && <p className={status.startsWith("Export failed") ? "error-text" : "muted"}>{status}</p>}
    </Modal>
  );
}

import Papa from "papaparse";
import { buildInsertForRows } from "./sql";
import type { CellValue, Driver } from "./types";

export type ExportFormat = "csv" | "csv-header" | "tsv" | "json" | "markdown" | "sql";

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  csv: "CSV",
  "csv-header": "CSV with header",
  tsv: "Plain text (TSV)",
  json: "JSON",
  markdown: "Markdown table",
  sql: "SQL INSERT",
};

export const EXPORT_FILE_EXTENSIONS: Record<ExportFormat, string> = {
  csv: "csv",
  "csv-header": "csv",
  tsv: "tsv",
  json: "json",
  markdown: "md",
  sql: "sql",
};

export interface ExportInput {
  driver: Driver;
  qualifiedTableName: string;
  columnNames: string[];
  rows: CellValue[][];
}

function cellToText(value: CellValue): string {
  if (value === null) return "NULL";
  return String(value);
}

export function serializeRows(format: ExportFormat, input: ExportInput): string {
  const { columnNames, rows } = input;
  switch (format) {
    case "csv":
      return Papa.unparse(rows.map((row) => row.map((value) => (value === null ? "" : value))));
    case "csv-header":
      return Papa.unparse({
        fields: columnNames,
        data: rows.map((row) => row.map((value) => (value === null ? "" : value))),
      });
    case "tsv":
      return rows.map((row) => row.map(cellToText).join("\t")).join("\n");
    case "json":
      return JSON.stringify(
        rows.map((row) => Object.fromEntries(columnNames.map((columnName, index) => [columnName, row[index]]))),
        null,
        2,
      );
    case "markdown": {
      const header = `| ${columnNames.join(" | ")} |`;
      const separator = `| ${columnNames.map(() => "---").join(" | ")} |`;
      const body = rows.map((row) => `| ${row.map((value) => cellToText(value).replace(/\|/g, "\\|")).join(" | ")} |`);
      return [header, separator, ...body].join("\n");
    }
    case "sql":
      return buildInsertForRows(input.driver, input.qualifiedTableName, columnNames, rows)
        .map((statement) => `${statement};`)
        .join("\n");
  }
}

export function parseCsv(content: string): { headers: string[]; rows: string[][] } {
  const parsed = Papa.parse<string[]>(content.trim(), { skipEmptyLines: true });
  const [headers = [], ...rows] = parsed.data;
  return { headers, rows };
}

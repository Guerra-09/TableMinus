import type { CellValue, Driver, RowFilter, SortState, TableRef } from "./types";
import { RAW_SQL_FILTER_COLUMN } from "./types";

export function quoteIdentifier(driver: Driver, identifier: string): string {
  if (driver === "mysql") return `\`${identifier.replace(/`/g, "``")}\``;
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function quoteLiteral(driver: Driver, value: string): string {
  const escapedQuotes = value.replace(/'/g, "''");
  if (driver === "mysql") return `'${escapedQuotes.replace(/\\/g, "\\\\")}'`;
  return `'${escapedQuotes}'`;
}

export function toSqlLiteral(driver: Driver, value: CellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") {
    if (driver === "sqlite") return value ? "1" : "0";
    return value ? "TRUE" : "FALSE";
  }
  return quoteLiteral(driver, value);
}

export function qualifiedTableName(driver: Driver, table: TableRef): string {
  return `${quoteIdentifier(driver, table.schema)}.${quoteIdentifier(driver, table.name)}`;
}

function textCast(driver: Driver, columnSql: string): string {
  if (driver === "postgres") return `CAST(${columnSql} AS TEXT)`;
  return columnSql;
}

function likeOperator(driver: Driver, isNegated: boolean): string {
  const operator = driver === "postgres" ? "ILIKE" : "LIKE";
  return isNegated ? `NOT ${operator}` : operator;
}

function splitListValues(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function buildFilterCondition(driver: Driver, filter: RowFilter): string {
  if (filter.column === RAW_SQL_FILTER_COLUMN) return filter.value.trim() ? `(${filter.value})` : "";

  const columnSql = quoteIdentifier(driver, filter.column);
  const literal = quoteLiteral(driver, filter.value);

  switch (filter.operator) {
    case "IS NULL":
    case "IS NOT NULL":
      return `${columnSql} ${filter.operator}`;
    case "IN":
    case "NOT IN": {
      const listValues = splitListValues(filter.value).map((item) => quoteLiteral(driver, item));
      if (listValues.length === 0) return "";
      return `${columnSql} ${filter.operator} (${listValues.join(", ")})`;
    }
    case "BETWEEN":
      return `${columnSql} BETWEEN ${literal} AND ${quoteLiteral(driver, filter.secondValue)}`;
    case "CONTAINS":
    case "NOT CONTAINS":
      return `${textCast(driver, columnSql)} ${likeOperator(driver, filter.operator === "NOT CONTAINS")} ${quoteLiteral(driver, `%${filter.value}%`)}`;
    case "BEGINS WITH":
      return `${textCast(driver, columnSql)} ${likeOperator(driver, false)} ${quoteLiteral(driver, `${filter.value}%`)}`;
    case "ENDS WITH":
      return `${textCast(driver, columnSql)} ${likeOperator(driver, false)} ${quoteLiteral(driver, `%${filter.value}`)}`;
    default:
      return `${columnSql} ${filter.operator} ${literal}`;
  }
}

export function buildWhereClause(driver: Driver, filters: RowFilter[]): string {
  const conditions = filters
    .map((filter) => buildFilterCondition(driver, filter))
    .filter((condition) => condition.length > 0);
  return conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
}

export interface TableQueryOptions {
  table: TableRef;
  filters: RowFilter[];
  sort: SortState | null;
  limit: number | null;
  offset: number;
}

export function buildSelectQuery(driver: Driver, options: TableQueryOptions): string {
  const orderClause = options.sort
    ? ` ORDER BY ${quoteIdentifier(driver, options.sort.column)} ${options.sort.direction}`
    : "";
  return (
    `SELECT * FROM ${qualifiedTableName(driver, options.table)}` +
    buildWhereClause(driver, options.filters) +
    orderClause +
    (options.limit === null ? "" : ` LIMIT ${options.limit} OFFSET ${options.offset}`)
  );
}

export function buildCountQuery(driver: Driver, table: TableRef, filters: RowFilter[]): string {
  return `SELECT COUNT(*) FROM ${qualifiedTableName(driver, table)}${buildWhereClause(driver, filters)}`;
}

function buildRowIdentityCondition(
  driver: Driver,
  columnNames: string[],
  originalRow: CellValue[],
  primaryKeyColumns: string[],
): string {
  const identityColumns = primaryKeyColumns.length > 0 ? primaryKeyColumns : columnNames;
  return identityColumns
    .map((columnName) => {
      const value = originalRow[columnNames.indexOf(columnName)];
      const columnSql = quoteIdentifier(driver, columnName);
      return value === null ? `${columnSql} IS NULL` : `${columnSql} = ${toSqlLiteral(driver, value)}`;
    })
    .join(" AND ");
}

export function buildUpdateStatement(
  driver: Driver,
  table: TableRef,
  columnNames: string[],
  originalRow: CellValue[],
  changedValues: Map<number, CellValue>,
  primaryKeyColumns: string[],
): string {
  const assignments = [...changedValues.entries()]
    .map(([columnIndex, value]) => `${quoteIdentifier(driver, columnNames[columnIndex])} = ${toSqlLiteral(driver, value)}`)
    .join(", ");
  const condition = buildRowIdentityCondition(driver, columnNames, originalRow, primaryKeyColumns);
  const limitClause = driver === "mysql" && primaryKeyColumns.length === 0 ? " LIMIT 1" : "";
  return `UPDATE ${qualifiedTableName(driver, table)} SET ${assignments} WHERE ${condition}${limitClause}`;
}

export function buildDeleteStatement(
  driver: Driver,
  table: TableRef,
  columnNames: string[],
  originalRow: CellValue[],
  primaryKeyColumns: string[],
): string {
  const condition = buildRowIdentityCondition(driver, columnNames, originalRow, primaryKeyColumns);
  const limitClause = driver === "mysql" && primaryKeyColumns.length === 0 ? " LIMIT 1" : "";
  return `DELETE FROM ${qualifiedTableName(driver, table)} WHERE ${condition}${limitClause}`;
}

export function buildInsertStatement(
  driver: Driver,
  table: TableRef,
  columnNames: string[],
  values: Map<number, CellValue>,
): string {
  const tableSql = qualifiedTableName(driver, table);
  if (values.size === 0) {
    return driver === "mysql" ? `INSERT INTO ${tableSql} () VALUES ()` : `INSERT INTO ${tableSql} DEFAULT VALUES`;
  }
  const entries = [...values.entries()];
  const columnsSql = entries.map(([columnIndex]) => quoteIdentifier(driver, columnNames[columnIndex])).join(", ");
  const valuesSql = entries.map(([, value]) => toSqlLiteral(driver, value)).join(", ");
  return `INSERT INTO ${tableSql} (${columnsSql}) VALUES (${valuesSql})`;
}

export function buildInsertForRows(
  driver: Driver,
  tableName: string,
  columnNames: string[],
  rows: CellValue[][],
): string[] {
  const columnsSql = columnNames.map((columnName) => quoteIdentifier(driver, columnName)).join(", ");
  return rows.map(
    (row) =>
      `INSERT INTO ${tableName} (${columnsSql}) VALUES (${row.map((value) => toSqlLiteral(driver, value)).join(", ")})`,
  );
}

export interface SqlStatementRange {
  text: string;
  from: number;
  to: number;
}

/**
 * Splits a SQL script into statements on top-level semicolons, skipping
 * semicolons inside quoted strings, quoted identifiers, line/block comments
 * and PostgreSQL dollar-quoted bodies.
 * @param script - Full SQL text
 * @param hasBackslashEscapes - Whether backslash escapes quotes inside strings (MySQL)
 * @returns Statements with their source offsets, trimmed and without the trailing semicolon
 */
export function splitSqlStatements(script: string, hasBackslashEscapes = false): SqlStatementRange[] {
  const statements: SqlStatementRange[] = [];
  let statementStart = 0;
  let position = 0;

  const pushStatement = (end: number) => {
    const rawText = script.slice(statementStart, end);
    const leadingWhitespace = rawText.length - rawText.trimStart().length;
    const text = rawText.trim();
    if (text.length > 0) {
      const from = statementStart + leadingWhitespace;
      statements.push({ text, from, to: from + text.length });
    }
  };

  while (position < script.length) {
    const character = script[position];
    const nextCharacter = script[position + 1];

    if (character === "-" && nextCharacter === "-") {
      const lineEnd = script.indexOf("\n", position);
      position = lineEnd === -1 ? script.length : lineEnd + 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      const commentEnd = script.indexOf("*/", position + 2);
      position = commentEnd === -1 ? script.length : commentEnd + 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      position += 1;
      while (position < script.length) {
        if (hasBackslashEscapes && script[position] === "\\" && character === "'") {
          position += 2;
          continue;
        }
        if (script[position] === character) {
          if (script[position + 1] === character) {
            position += 2;
            continue;
          }
          break;
        }
        position += 1;
      }
      position += 1;
      continue;
    }
    if (character === "$") {
      const dollarTagMatch = /^\$[A-Za-z_]*\$/.exec(script.slice(position));
      if (dollarTagMatch) {
        const dollarTag = dollarTagMatch[0];
        const bodyEnd = script.indexOf(dollarTag, position + dollarTag.length);
        position = bodyEnd === -1 ? script.length : bodyEnd + dollarTag.length;
        continue;
      }
    }
    if (character === ";") {
      pushStatement(position);
      statementStart = position + 1;
    }
    position += 1;
  }
  pushStatement(script.length);
  return statements;
}

export function findStatementAtOffset(
  script: string,
  offset: number,
  hasBackslashEscapes = false,
): SqlStatementRange | null {
  const statements = splitSqlStatements(script, hasBackslashEscapes);
  return (
    statements.find((statement) => offset >= statement.from && offset <= statement.to + 1) ??
    statements.filter((statement) => statement.to < offset).at(-1) ??
    statements[0] ??
    null
  );
}

const READ_ONLY_STATEMENT_PATTERN = /^\s*(\(\s*)*(SELECT|EXPLAIN|SHOW|DESCRIBE|DESC|WITH|PRAGMA|VALUES)\b/i;

export function isReadOnlyStatement(statement: string): boolean {
  const withoutLeadingComments = statement.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*/, "");
  return READ_ONLY_STATEMENT_PATTERN.test(withoutLeadingComments);
}

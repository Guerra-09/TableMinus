# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-17 — Alpha

First public alpha release of TableMinus.

### Added

- **Desktop app**: Tauri 2 + React 19 frontend with a Rust (sqlx) backend for macOS, Windows and Linux, with light and dark themes.
- **Database drivers**: PostgreSQL, MySQL / MariaDB and SQLite.
- **Connection manager**
  - Create, edit, duplicate and delete saved connections.
  - Environment tags (local, testing, development, staging, production) and status bar colors.
  - Import a connection from a URL and copy a connection as a URL.
  - Test a connection and show the server version.
  - Passwords stored in the OS keychain.
  - SQLite: open an existing file or create a new database.
- **Workspace**
  - Toolbar with discard, preview and commit actions, safe mode selector and reload.
  - Status bar with connection name, tag, server version, schema and table.
  - Sidebar with schema switcher, fuzzy search, tables and views, and query history.
  - Sidebar context menu: open in new tab, open structure, copy name, query table, truncate and drop.
  - Multiple tabs with dirty indicator; opening an object replaces the current tab when it has no pending changes.
  - Open Anything (⌘P) for tables, views and schemas.
  - Console log of executed queries with data / meta filter.
- **Data grid**
  - Virtualized rows, resizable columns, numeric alignment and NULL styling.
  - Pagination with configurable limit (300 rows by default) and total row count.
  - Sort by column header (descending → ascending → none).
  - Inline editing, insert, duplicate and delete rows, kept as pending changes.
  - Code review of the generated SQL, commit in a single transaction, or discard.
  - Row filters with 15 operators, raw SQL filters, Apply / Apply All / Unset and SQL preview.
  - Column visibility filter.
  - Context menu: copy cell, copy rows as TSV, JSON, CSV, CSV with header, Markdown or SQL INSERT, quick filter by value, Quick Look, set NULL, duplicate and delete.
  - Row detail side panel (Space) with column search and field editing.
  - Quick Look editor with JSON pretty printing.
- **Structure view**: columns (type, nullability, default, primary key, comment), indexes, foreign keys and `CREATE` definition.
- **SQL editor**
  - CodeMirror editor with per-driver SQL dialect and table / column autocomplete.
  - Run current statement or selection (⌘⏎) and run all (⌘⇧⏎).
  - One result tab per statement, error details and execution time.
  - Beautify (⌘I) and uglify (⌘⇧I).
  - Open and save `.sql` files.
- **Import / export**
  - Export a table (all rows, current page or selection) or a query result to CSV, JSON, SQL INSERT or Markdown.
  - Import CSV into an existing table, matching columns by header.
  - Run a SQL dump file inside a transaction.
- **Safe mode**: silent, confirm every query, or confirm everything except SELECT / EXPLAIN.
- **Keyboard shortcuts** for the main actions.
- **Tests**: SQLite integration test covering introspection, value decoding and transaction rollback.

### Known limitations

- No SSH tunnels or TLS configuration yet.
- Table structure is read-only in the GUI; use the SQL editor to alter tables.
- Query results in the SQL editor are read-only.
- Long-running queries cannot be cancelled yet.
- Tested against SQLite; PostgreSQL and MySQL support has not been validated against live servers in this release.

[0.1.0]: https://github.com/Guerra-09/TableMinus/releases/tag/v0.1.0

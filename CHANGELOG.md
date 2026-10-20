# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.1] - 2026-10-20 — Alpha

### Added

- **Multi-select in the sidebar**: press ⌘A (Ctrl+A) after clicking a table to select every visible item, or use ⌘-click / Shift-click to select a range. A selection bar then offers **Truncate…** (empty the selected tables) and **Drop…** (delete the selected tables/views), with a confirmation listing the affected objects. Dropped objects also close their open tabs.
- **Select all rows with ⌘A**: with the data grid focused, ⌘A selects every row on the current page so they can be deleted in bulk.
- **Ignore foreign key checks**: Truncate and Drop can now run without foreign key enforcement, like TablePlus. Use the **Ignore FKs** checkbox in the multi-selection bar or the `(ignore FKs)` actions in the table context menu. PostgreSQL uses `CASCADE`; MySQL disables `FOREIGN_KEY_CHECKS` for the connection and SQLite disables `PRAGMA foreign_keys`, restoring the setting afterwards.

## [0.4.0] - 2026-10-17 — Alpha

### Added

- **AI access via MCP**: TableMinus can run a local MCP server so AI assistants such as Claude Code can work with your saved connections.
  - Off by default. Enable it from "AI access (MCP)…" on the welcome screen; it listens on 127.0.0.1 only and requires a bearer token.
  - One-click copy of the `claude mcp add` command and of a JSON config for other MCP clients.
  - Tools: `list_connections`, `list_tables`, `describe_table` and `run_query` (one statement per call, results limited to 200 rows).
  - Credentials are never exposed to the assistant; it refers to connections by name.
  - Connections tagged **Production** are read-only: writes are blocked and the assistant is told to give you the SQL to run yourself. Reads run inside a database-enforced read-only transaction.
  - Safe mode is respected: with "confirm except SELECT/EXPLAIN" you approve every write, and with "confirm every query" you approve every statement, in a dialog inside TableMinus (unanswered requests are rejected after 3 minutes).
  - Every statement run by the assistant appears in the console log with an **AI** badge.
- **Connections menu**: a native "Connections" menu (macOS menu bar) with Show All Connections (⌘⇧K), New Connection… (⌘N), Open Connection ▸ (your saved connections, switching directly between them) and Close Connection. The toolbar's eject icon is now a "‹ Connections" button.
- **Console log everywhere**: open it from the welcome screen or the "Console" button in the toolbar (⌘⇧C), even without an open connection, to follow what the AI runs.

## [0.3.0] - 2026-10-17 — Alpha

### Added

- **SSH tunnel**: connect to PostgreSQL or MySQL on a remote server (for example a VPS) through SSH, without exposing the database port to the internet.
  - "Over SSH" section in the connection form: SSH host, port, user and authentication method.
  - Authentication with a private key (default `~/.ssh/id_ed25519`, `id_ecdsa` or `id_rsa`, encrypted keys supported with a passphrase), password, or the SSH agent.
  - SSH passwords and key passphrases are stored in the OS keychain.
  - Trust-on-first-use host key verification: keys in `~/.ssh/known_hosts` are honored, new hosts are remembered in TableMinus' own known_hosts file, and a changed host key blocks the connection.
  - The tunnel opens on connect, is shared by all queries of the connection and closes on disconnect.
  - "Test" reports whether the SSH step or the database step failed.
  - Connection list shows the SSH route.
  - The private key picker opens in `~/.ssh`.
- **Version and changelog**: the welcome screen shows the installed version; clicking it opens this changelog.
- **Floating dialogs**: dialogs such as the connection form can be moved by dragging their title and resized from the bottom-right corner (double-click the title to reset). The connection form no longer closes when clicking outside it.
- **Connection form**: changing the driver keeps a custom port instead of resetting it to the driver's default.
- **Zoom**: zoom the whole app in and out with ⌘ + / ⌘ − and reset with ⌘ 0 (Ctrl on Windows/Linux). The zoom level is remembered.

## [0.2.0] - 2026-10-17 — Alpha

### Added

- **Local server manager**: start and stop a local MySQL or PostgreSQL server from the launcher, without Docker.
  - Per-connection "Local server" option with auto-detected installations (Homebrew, Postgres.app, system) or a custom bin folder.
  - The first start initializes a new data directory and creates the connection's user, password and database.
  - ▶ / ■ button and status dot in the connection list; "Port busy" when another process (for example Docker) owns the port.
  - Connecting to a stopped local server starts it first.
  - Server log viewer from the connection context menu.
  - Servers listen on 127.0.0.1 only and are stopped when TableMinus quits.

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

- No TLS configuration yet.
- Table structure is read-only in the GUI; use the SQL editor to alter tables.
- Query results in the SQL editor are read-only.
- Long-running queries cannot be cancelled yet.
- Tested against SQLite; PostgreSQL and MySQL support has not been validated against live servers in this release.

[Unreleased]: https://github.com/Guerra-09/TableMinus/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Guerra-09/TableMinus/releases/tag/v0.4.0
[0.3.0]: https://github.com/Guerra-09/TableMinus/releases/tag/v0.3.0
[0.2.0]: https://github.com/Guerra-09/TableMinus/releases/tag/v0.2.0
[0.1.0]: https://github.com/Guerra-09/TableMinus/releases/tag/v0.1.0

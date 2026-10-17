# TableMinus

**A free, open-source, lightweight database client for everyone.**

TableMinus is the "minus" version of a modern GUI database client: fewer features, zero cost, and fully open source. It is meant for anyone who wants a simple, fast desktop tool to connect to a database, browse tables, edit rows and run SQL while trying things out — no license, no account, no telemetry.

> **Status: 0.4.0 alpha.** Core workflow works, rough edges expected. Feedback and pull requests are welcome.

Built with Tauri 2 + React 19 + Rust (sqlx). Runs on macOS, Windows and Linux.

## Supported databases

- PostgreSQL
- MySQL / MariaDB
- SQLite

## Features

- **Connections** — saved connections with environment tags (local, testing, development, staging, production) and status colors, import from URL (`postgres://…`, `mysql://…`, `sqlite://…`), test connection. Passwords are stored in the OS keychain, never in plain text.
- **SSH tunnel** — reach a database on a remote server (VPS) through SSH with a private key, password or SSH agent, keeping the database port closed to the internet. Host keys are verified on first use and changes are blocked.
- **AI access (MCP)** — let Claude Code or any MCP client query your saved connections through a local, token-protected MCP server. Production connections stay read-only, writes follow each connection's safe mode with an approval dialog, and credentials never leave TableMinus.
- **Sidebar** — schema switcher, fuzzy search, tables and views, query history.
- **Data grid** — pagination (300 rows per page), sort by column, inline editing, insert / duplicate / delete rows. Every change stays pending until you **review** the generated SQL (⌘⇧P) and **commit** it (⌘S) in a single transaction, or **discard** it (⌘⇧⌫).
- **Filters** — row filters with 15 operators or raw SQL, column visibility filter, quick filter from any cell.
- **Structure** — columns, indexes, foreign keys and the `CREATE` definition.
- **SQL editor** — syntax highlighting, autocomplete for tables and columns, run current statement (⌘⏎) or all (⌘⇧⏎), one result tab per statement, beautify / uglify, open and save `.sql` files.
- **Import / export** — export to CSV, JSON, SQL `INSERT` or Markdown; import CSV into a table; run a SQL dump file.
- **Local servers without Docker** — start and stop a local MySQL or PostgreSQL server with one click from the connection list. TableMinus detects Homebrew / Postgres.app installations, creates the data folder, user and database on first start, and stops the server when you quit. A native server uses a fraction of the memory of a Docker VM.
- **Safety** — safe mode that asks for confirmation before every query, or before every write.
- **Productivity** — tabs, Open Anything (⌘P), console log of every query (⌘⇧C), Quick Look for long / JSON values, row detail panel (Space).

See [SPEC.md](SPEC.md) for the detailed feature list and what is still pending, and [CHANGELOG.md](CHANGELOG.md) for release notes.

## Getting started

### Requirements

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) stable
- Tauri system prerequisites for your OS: https://tauri.app/start/prerequisites/
  - Linux also needs `libdbus-1-dev` for keychain access (Secret Service).

### Run in development

```bash
npm install
npm run tauri dev
```

### Build an installer for your OS

```bash
npm run tauri build
```

### Run the backend tests

```bash
cd src-tauri
cargo test
```

## AI access (MCP)

1. In TableMinus, open **AI access (MCP)…** on the welcome screen and enable the server.
2. Copy the command shown there and run it once, for example:

   ```bash
   claude mcp add --scope user --transport http tableminus http://127.0.0.1:47821/mcp --header "Authorization: Bearer <token>"
   ```

3. Keep TableMinus open and ask your assistant things like *"list my connections and check the orders table in Argentus dev"*.

| Connection | Reads | Writes |
| --- | --- | --- |
| Tag Production | Allowed (read-only transaction) | Blocked — the assistant gives you the SQL |
| Safe mode Silent | Allowed | Allowed |
| Safe mode "confirm except SELECT/EXPLAIN" | Allowed | Approved by you in TableMinus |
| Safe mode "confirm every query" | Approved by you | Approved by you |

## Keyboard shortcuts

On Windows and Linux use Ctrl instead of ⌘.

| Shortcut | Action |
| --- | --- |
| ⌘P | Open anything |
| ⌘E / ⌘T | New SQL editor |
| ⌘⏎ / ⌘⇧⏎ | Run current / all statements |
| ⌘S | Commit pending changes |
| ⌘⇧P | Preview generated SQL |
| ⌘⇧⌫ | Discard pending changes |
| ⌘R | Reload |
| ⌘⇧C | Toggle console log |
| ⌘F / ⌘⌥F | Row filter / column filter |
| ⌘⌃] / ⌘⌃[ | Structure / data view |
| ⌘I / ⌘D / Delete | Insert / duplicate / delete row |
| Space | Toggle row detail panel |
| ⌘W, ⌘[ ⌘], ⌘1–9 | Close / navigate tabs |
| ⌘+ / ⌘− / ⌘0 | Zoom in / out / reset |

## Project structure

| Path | Purpose |
| --- | --- |
| `src-tauri/src/db.rs` | Connection pools per driver; runs raw SQL and converts every value to JSON |
| `src-tauri/src/introspect.rs` | Schemas, tables, columns, indexes, foreign keys and DDL per driver |
| `src-tauri/src/connections.rs` | Saved connections (app data dir) and keychain passwords |
| `src/lib/sql.ts` | SQL generation: filters, pagination, pending UPDATE / INSERT / DELETE, statement splitter |
| `src/components/TableView.tsx` | Data grid with pending changes, filters, import / export |
| `src/components/QueryEditor.tsx` | SQL editor and result tabs |

## Roadmap

Connection groups, editing table structure from the GUI, saved favorite queries, query cancellation, foreign-key navigation, more drivers.

## Contributing

Issues and pull requests are welcome. Please run `cargo test` and `npm run build` before opening a PR.

## License

[MIT](LICENSE) © Jose Guerra

## Disclaimer

TableMinus is an independent open-source project. It is not affiliated with, endorsed by, or connected to TablePlus or TablePlus Inc. All product names are trademarks of their respective owners. TableMinus was written from scratch and contains no code or assets from any other database client.

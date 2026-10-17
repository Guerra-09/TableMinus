# TablePlus Clone

Cliente de bases de datos local estilo TablePlus. Tauri 2 + React 19 + Rust (sqlx).
Soporta PostgreSQL, MySQL/MariaDB y SQLite. Ver [SPEC.md](SPEC.md) para el estado de cada feature.

## Requisitos

- Node.js 20+
- Rust (stable): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Prerrequisitos de Tauri por SO: https://tauri.app/start/prerequisites/
  - Linux: `libwebkit2gtk-4.1-dev`, `libdbus-1-dev` (keychain vía Secret Service)

## Desarrollo

```bash
npm install
npm run tauri dev
```

## Build (instalador para el SO actual)

```bash
npm run tauri build
```

## Arquitectura

- `src-tauri/src/db.rs` — pools sqlx por driver; ejecuta SQL crudo por protocolo de texto y convierte cada valor a JSON.
- `src-tauri/src/introspect.rs` — schemas, tablas/vistas, columnas, índices, FKs y DDL por driver.
- `src-tauri/src/connections.rs` — conexiones en `connections.json` (app data dir); passwords en el keychain del SO.
- `src/lib/sql.ts` — generación de SQL (filtros, paginación, UPDATE/INSERT/DELETE pendientes) y splitter de statements.
- `src/components/TableView.tsx` — grid de datos con cambios pendientes → Preview (⌘⇧P) / Commit (⌘S) / Discard (⌘⇧⌫).
- `src/components/QueryEditor.tsx` — editor CodeMirror, Run current (⌘⏎), Run all (⌘⇧⏎), resultados en tabs.

## Atajos principales

| Atajo | Acción |
| --- | --- |
| ⌘P | Open anything |
| ⌘E / ⌘T | Nuevo editor SQL |
| ⌘S | Commit cambios |
| ⌘⇧P | Preview SQL de cambios |
| ⌘⇧⌫ | Descartar cambios |
| ⌘R | Recargar |
| ⌘⇧C | Console log |
| ⌘F / ⌘⌥F | Filtro de filas / columnas |
| ⌘⌃] / ⌘⌃[ | Vista Structure / Data |
| ⌘I / ⌘D / Delete | Insertar / duplicar / borrar fila |
| Space | Panel de detalle de fila |
| ⌘W, ⌘[ ⌘], ⌘1–9 | Cerrar / navegar tabs |

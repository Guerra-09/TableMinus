# TableMinus — Feature Spec v0.1

Fuente: documentación pública de TablePlus (docs.tableplus.com) + observación de la app.
Sin descompilar ni copiar código/assets. Estado: ✅ implementado · 🟡 parcial · ⬜ pendiente.

> Verificación: backend compila sin warnings; test de integración SQLite pasa (`cargo test`: introspección, tipos, rollback). UI renderiza. Pendiente: probar flujo completo en la ventana nativa y contra Postgres/MySQL reales.

## 1. Conexiones (Welcome screen)
- ✅ Lista de conexiones guardadas; doble clic abre.
- ✅ Crear/editar/borrar conexión: driver (PostgreSQL, MySQL/MariaDB, SQLite), nombre, host, puerto, usuario, password, database.
- ✅ Tag de entorno: Local, Testing, Development, Staging, Production + color de status bar.
- ✅ Test connection.
- ✅ Importar desde URL (`postgres://user:pass@host:port/db`, `mysql://…`, `sqlite:///path`).
- ✅ Password en el keychain del SO (no en el JSON).
- ⬜ Grupos de conexiones (drag & drop), export/import de conexiones con password.
- ⬜ SSH tunnel, TLS mode.
- ✅ Servidor local gestionado (MySQL/PostgreSQL): botón ▶/■ en el launcher, detección de instalaciones Homebrew, inicialización + usuario/DB en primer arranque, log, parada al salir. (Extra de TableMinus, inspirado en DBngin.)
- ⬜ Deeplink / CLI (`open -a … "postgresql://…?table=…&column=…&operation=…"`).

## 2. Workspace / Interfaz
- ✅ Toolbar: Discard (⌘⇧⌫), Preview SQL (⌘⇧P), Commit (⌘S), status bar con color/tag de conexión, Refresh (⌘R).
- ✅ Left sidebar: selector de schema (abajo), búsqueda fuzzy, secciones Tables / Views, History.
- ✅ Tabs múltiples: abrir objeto reemplaza tab actual si no está modificado; ⌘T nuevo tab, ⌘W cerrar.
- ✅ Console log (⌘⇧C): registra todas las queries ejecutadas (meta + data).
- ✅ Open Anything (⌘P): búsqueda fuzzy de tablas/vistas/schemas.
- 🟡 Right sidebar (Space): detalle de fila seleccionada, editar campos. (edición en bulk ⬜)
- ⬜ Switch database (⌘K), switch connection (⌘⇧K) sin volver a welcome.
- ⬜ Pin to top, sección Recent, split panes, múltiples ventanas.

## 3. Datos de tabla (grid)
- ✅ Paginación: 300 filas por página por defecto, limit/offset configurables.
- ✅ Sort por clic en header: desc → asc → sin orden.
- ✅ Edición inline (doble clic); cambios quedan pendientes (celda resaltada) hasta Commit.
- ✅ Insertar fila (+ Row / ⌘I), duplicar (⌘D), borrar (Delete) → pendientes.
- ✅ Code review: Preview muestra UPDATE/INSERT/DELETE generados; Commit ejecuta en transacción; Discard revierte.
- ✅ Row filters (⌘F): columna + operador (=, <>, <, >, <=, >=, IN, NOT IN, IS NULL, IS NOT NULL, BETWEEN, Contains, Not contains, Begins with, Ends with) + valor; múltiples filtros con checkbox; Apply individual, Apply all (⌘⏎), Unset, botón SQL; opción Raw SQL.
- ✅ Column filter (⌘⌥F): mostrar sólo columnas seleccionadas.
- ✅ Copiar filas como: TSV, JSON, CSV, CSV con header, Markdown, SQL INSERT. Copiar valor de celda.
- ✅ Quick Look (clic central o menú): ver/editar celda JSON/texto largo en popup.
- ✅ NULL mostrado en gris; tipos alineados.
- ✅ Quick filter desde celda (menú contextual).
- ⬜ Seguir FK con flecha, paste rows (⌘V), editar resultados del editor SQL.

## 4. Estructura de tabla
- ✅ Vista Structure (⌘^]) / Data (⌘^[) con tabs abajo.
- ✅ Columnas: nombre, tipo, nullable, default, PK, comment.
- ✅ Índices y foreign keys.
- ✅ Definition: CREATE TABLE (Postgres reconstruido, MySQL `SHOW CREATE TABLE`, SQLite `sqlite_master`).
- ⬜ Editar estructura vía GUI (add/edit/delete column, índices) con commit.
- ✅ Truncate / Drop table desde menú contextual del sidebar (con confirmación, ejecución inmediata).

## 5. Editor SQL
- ✅ Abrir con ⌘E / ⌘⏎ desde sidebar; editor CodeMirror con highlight SQL.
- ✅ Run current (⌘⏎: selección o statement bajo el cursor), Run all (⌘⇧⏎).
- ✅ Split results into tabs (una pestaña por result set).
- ✅ Autocomplete de keywords, tablas y columnas del schema.
- ✅ Query history (sidebar): doble clic inserta, borrar, limpiar todo.
- ✅ Comentar líneas (⌘/), multi-cursor (⌘Click), ⌘D seleccionar siguiente.
- ✅ Beautify (⌘I) básico.
- ✅ Safe mode: Silent, Alert 1 (confirma todo), Alert 2 (confirma salvo SELECT/EXPLAIN).
- ⬜ Favorites + keyword binding, query parameters, cancel query (⌘.), streaming.

## 6. Import / Export
- ✅ Export tabla o resultado a CSV, JSON, SQL (INSERTs).
- ✅ Import CSV a tabla existente (mapeo por header).
- ✅ Import SQL dump (ejecuta script).
- ⬜ Import CSV creando tabla nueva, backup/restore (pg_dump/mysqldump).

## Fuera de v1
User management, metrics board, plugins, LLM plugin, Redis/Mongo/otros drivers, iOS.

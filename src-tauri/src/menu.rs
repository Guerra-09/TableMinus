use tauri::{
    menu::{Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Emitter, Wry,
};

use crate::{connections, error::AppResult};

const SHOW_CONNECTIONS_ID: &str = "show-connections";
const NEW_CONNECTION_ID: &str = "new-connection";
const CLOSE_CONNECTION_ID: &str = "close-connection";
const SELECT_ALL_ID: &str = "select-all";
const OPEN_CONNECTION_PREFIX: &str = "open-connection:";
const SHOW_CONNECTIONS_EVENT: &str = "menu-show-connections";
const NEW_CONNECTION_EVENT: &str = "menu-new-connection";
const SELECT_ALL_EVENT: &str = "menu-select-all";
const OPEN_CONNECTION_EVENT: &str = "menu-open-connection";

/// Builds the native menu bar. The Connections menu lists the saved
/// connections, so it is rebuilt whenever a connection is saved or deleted.
fn build_menu(app: &AppHandle) -> AppResult<Menu<Wry>> {
    let saved_connections = connections::load_connections(app).unwrap_or_default();

    let app_menu = SubmenuBuilder::new(app, "TableMinus")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .item(&MenuItemBuilder::with_id(SELECT_ALL_ID, "Select All").accelerator("CmdOrCtrl+A").build(app)?)
        .build()?;

    let mut open_connection_menu = SubmenuBuilder::new(app, "Open Connection");
    if saved_connections.is_empty() {
        open_connection_menu = open_connection_menu.item(
            &MenuItemBuilder::with_id("no-saved-connections", "No saved connections").enabled(false).build(app)?,
        );
    }
    let mut folder_names: Vec<&str> =
        saved_connections.iter().map(|connection| connection.folder.trim()).filter(|folder| !folder.is_empty()).collect();
    folder_names.sort_by_key(|folder| folder.to_lowercase());
    folder_names.dedup();
    for folder in folder_names {
        let mut folder_menu = SubmenuBuilder::new(app, folder);
        for connection in saved_connections.iter().filter(|connection| connection.folder.trim() == folder) {
            folder_menu = folder_menu.item(
                &MenuItemBuilder::with_id(format!("{OPEN_CONNECTION_PREFIX}{}", connection.id), &connection.name).build(app)?,
            );
        }
        open_connection_menu = open_connection_menu.item(&folder_menu.build()?);
    }
    for connection in saved_connections.iter().filter(|connection| connection.folder.trim().is_empty()) {
        open_connection_menu = open_connection_menu.item(
            &MenuItemBuilder::with_id(format!("{OPEN_CONNECTION_PREFIX}{}", connection.id), &connection.name).build(app)?,
        );
    }

    let connections_menu = SubmenuBuilder::new(app, "Connections")
        .item(
            &MenuItemBuilder::with_id(SHOW_CONNECTIONS_ID, "Show All Connections")
                .accelerator("CmdOrCtrl+Shift+K")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id(NEW_CONNECTION_ID, "New Connection…").accelerator("CmdOrCtrl+N").build(app)?)
        .separator()
        .item(&open_connection_menu.build()?)
        .separator()
        .item(&MenuItemBuilder::with_id(CLOSE_CONNECTION_ID, "Close Connection").build(app)?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window").minimize().maximize().separator().fullscreen().build()?;

    Ok(MenuBuilder::new(app).items(&[&app_menu, &edit_menu, &connections_menu, &window_menu]).build()?)
}

pub fn refresh_menu(app: &AppHandle) -> AppResult<()> {
    app.set_menu(build_menu(app)?)?;
    Ok(())
}

pub fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let menu_id = event.id().as_ref();
    let _ = match menu_id {
        SHOW_CONNECTIONS_ID | CLOSE_CONNECTION_ID => app.emit(SHOW_CONNECTIONS_EVENT, ()),
        NEW_CONNECTION_ID => app.emit(NEW_CONNECTION_EVENT, ()),
        SELECT_ALL_ID => app.emit(SELECT_ALL_EVENT, ()),
        _ => match menu_id.strip_prefix(OPEN_CONNECTION_PREFIX) {
            Some(connection_id) => app.emit(OPEN_CONNECTION_EVENT, connection_id.to_string()),
            None => Ok(()),
        },
    };
}

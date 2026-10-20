mod commands;
mod connections;
mod db;
mod error;
mod introspect;
mod local_server;
mod mcp;
mod menu;
mod ssh_tunnel;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::default())
        .manage(local_server::LocalServerManager::default())
        .manage(mcp::McpManager::default())
        .on_menu_event(menu::handle_menu_event)
        .setup(|app| {
            let _ = menu::refresh_menu(app.handle());
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mcp_manager = app_handle.state::<mcp::McpManager>();
                let _ = mcp_manager.apply(&app_handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::open_connection,
            commands::close_connection,
            commands::list_schemas,
            commands::list_objects,
            commands::get_table_structure,
            commands::execute_query,
            commands::execute_transaction,
            commands::execute_transaction_ignoring_foreign_keys,
            commands::read_text_file,
            commands::write_text_file,
            commands::detect_server_installations,
            commands::local_server_statuses,
            commands::start_local_server,
            commands::stop_local_server,
            commands::read_local_server_log,
            commands::get_mcp_status,
            commands::update_mcp_settings,
            commands::regenerate_mcp_token,
            commands::resolve_mcp_approval,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let servers = app.state::<local_server::LocalServerManager>();
                let mcp_manager = app.state::<mcp::McpManager>();
                tauri::async_runtime::block_on(async {
                    mcp_manager.stop().await;
                    servers.stop_all().await;
                });
            }
        });
}

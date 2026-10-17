mod commands;
mod connections;
mod db;
mod error;
mod introspect;
mod local_server;

use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::default())
        .manage(local_server::LocalServerManager::default())
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
            commands::read_text_file,
            commands::write_text_file,
            commands::detect_server_installations,
            commands::local_server_statuses,
            commands::start_local_server,
            commands::stop_local_server,
            commands::read_local_server_log,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let servers = app.state::<local_server::LocalServerManager>();
                tauri::async_runtime::block_on(servers.stop_all());
            }
        });
}

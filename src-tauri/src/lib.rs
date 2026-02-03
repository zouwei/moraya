use tauri::{Emitter, Manager};

mod commands;
mod menu;

#[tauri::command]
fn set_editor_mode_menu(app: tauri::AppHandle, mode: String) {
    menu::update_mode_checks(&app, &mode);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(commands::mcp::MCPProcessManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::file::read_file,
            commands::file::write_file,
            commands::file::read_dir_recursive,
            commands::mcp::mcp_connect_stdio,
            commands::mcp::mcp_send_request,
            commands::mcp::mcp_disconnect,
            set_editor_mode_menu,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // macOS: enable decorations for native traffic lights, then overlay
            #[cfg(target_os = "macos")]
            {
                use tauri::TitleBarStyle;
                let _ = window.set_decorations(true);
                let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
            }

            // Create and set native menu
            let app_handle = app.handle().clone();
            let native_menu = menu::create_menu(&app_handle)?;
            app.set_menu(native_menu)?;

            // Handle menu events — emit to the main window
            let app_handle_for_events = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let id = event.id().0.as_str();

                // Update mode check marks when a mode menu item is clicked
                match id {
                    "view_mode_visual" => menu::update_mode_checks(&app_handle_for_events, "visual"),
                    "view_mode_source" => menu::update_mode_checks(&app_handle_for_events, "source"),
                    "view_mode_split" => menu::update_mode_checks(&app_handle_for_events, "split"),
                    _ => {}
                }

                // Emit as global event to all webviews
                let _ = app_handle_for_events.emit(&format!("menu:{}", id), ());
            });

            let _ = window;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

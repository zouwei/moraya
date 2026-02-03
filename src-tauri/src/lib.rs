use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

mod commands;
mod menu;

/// Holds file paths requested to be opened via OS file association or CLI args.
pub struct OpenedFiles(pub Mutex<Vec<String>>);

#[tauri::command]
fn set_editor_mode_menu(app: tauri::AppHandle, mode: String) {
    menu::update_mode_checks(&app, &mode);
}

#[tauri::command]
fn update_menu_labels(app: tauri::AppHandle, labels: HashMap<String, String>) {
    menu::update_menu_labels(&app, &labels);
}

/// Called by the frontend once it's ready; returns the first file path to open (if any).
#[tauri::command]
fn get_opened_file(state: tauri::State<'_, OpenedFiles>) -> Option<String> {
    let files = state.0.lock().unwrap();
    files.first().cloned()
}

/// Extract file paths from CLI arguments (used on Windows where file association
/// spawns a new process with the file path as an argument).
fn file_paths_from_args() -> Vec<String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .filter(|a| {
            let p = std::path::Path::new(a);
            p.exists() && p.is_file()
        })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Collect file paths from CLI args (Windows file association)
    let initial_files = file_paths_from_args();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(commands::mcp::MCPProcessManager::new())
        .manage(OpenedFiles(Mutex::new(initial_files)))
        .invoke_handler(tauri::generate_handler![
            commands::file::read_file,
            commands::file::write_file,
            commands::file::read_dir_recursive,
            commands::mcp::mcp_connect_stdio,
            commands::mcp::mcp_send_request,
            commands::mcp::mcp_disconnect,
            set_editor_mode_menu,
            update_menu_labels,
            get_opened_file,
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Handle macOS "Open With" / file association events
            if let tauri::RunEvent::Opened { urls } = event {
                // Extract file paths from URLs
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|url| {
                        if url.scheme() == "file" {
                            url.to_file_path().ok().map(|p| p.to_string_lossy().into_owned())
                        } else {
                            None
                        }
                    })
                    .collect();

                if let Some(path) = paths.first() {
                    // Store in state
                    if let Some(state) = app.try_state::<OpenedFiles>() {
                        let mut files = state.0.lock().unwrap();
                        files.clear();
                        files.push(path.clone());
                    }
                    // Emit to frontend (if already loaded)
                    let _ = app.emit("open-file", path.clone());
                }
            }
        });
}

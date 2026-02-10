use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

mod commands;
#[cfg(target_os = "macos")]
mod dock;
mod menu;

/// Holds file paths requested to be opened via OS file association or CLI args.
pub struct OpenedFiles(pub Mutex<Vec<String>>);

/// Maps window labels to file paths that should be opened when the window mounts.
pub struct PendingFiles(pub Mutex<HashMap<String, String>>);

/// Tracks whether the main window has called get_opened_file (i.e. frontend is ready).
/// Used to distinguish cold-start file association from runtime file opens.
pub struct MainWindowReady(pub AtomicBool);

/// Atomic counter for generating unique window labels.
static WINDOW_COUNTER: AtomicU32 = AtomicU32::new(0);

#[tauri::command]
fn set_editor_mode_menu(app: tauri::AppHandle, mode: String) {
    menu::update_mode_checks(&app, &mode);
}

#[tauri::command]
fn update_menu_labels(app: tauri::AppHandle, labels: HashMap<String, String>) {
    menu::update_menu_labels(&app, &labels);
}

#[tauri::command]
fn set_menu_check(app: tauri::AppHandle, id: String, checked: bool) {
    menu::set_check_item(&app, &id, checked);
}

/// Called by the frontend once it's ready; returns the file path to open (if any).
/// For new windows created via drag-drop, looks up PendingFiles by window label.
/// For the main window, falls back to OpenedFiles (startup CLI args / file association).
#[tauri::command]
fn get_opened_file(
    window: tauri::Window,
    state: tauri::State<'_, OpenedFiles>,
    pending: tauri::State<'_, PendingFiles>,
    ready: tauri::State<'_, MainWindowReady>,
) -> Option<String> {
    let label = window.label();

    // Check PendingFiles first (for dynamically created windows)
    {
        let mut pending_map = pending.0.lock().unwrap();
        if let Some(path) = pending_map.remove(label) {
            return Some(path);
        }
    }

    // Main window: fall back to startup OpenedFiles
    if label == "main" {
        // Mark main window as ready so future RunEvent::Opened events
        // create new windows instead of routing to main
        ready.0.store(true, Ordering::SeqCst);
        let files = state.0.lock().unwrap();
        return files.first().cloned();
    }

    None
}

/// Create a new editor window, optionally for a specific file path.
pub(crate) fn create_editor_window(
    app: &tauri::AppHandle,
    pending: &PendingFiles,
    path: Option<String>,
) -> Result<String, String> {
    let counter = WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
    let label = format!("moraya-{}", counter);

    // Extract filename for native window title (shown in macOS Dock & Window menu)
    let title = path
        .as_ref()
        .and_then(|p| std::path::Path::new(p).file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Moraya".to_string());

    // Store pending file path for this window (if any)
    if let Some(ref p) = path {
        let mut pending_map = pending.0.lock().unwrap();
        pending_map.insert(label.clone(), p.clone());
    }

    // Build window with same config as main
    let window = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::default(),
    )
    .title(&title)
    .inner_size(1200.0, 800.0)
    .min_inner_size(600.0, 400.0)
    .decorations(false)
    .center()
    .build()
    .map_err(|e| format!("Failed to create window: {}", e))?;

    // macOS: enable decorations for native traffic lights, then overlay
    #[cfg(target_os = "macos")]
    {
        use tauri::TitleBarStyle;
        let _ = window.set_decorations(true);
        let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
    }

    #[cfg(not(target_os = "macos"))]
    let _ = window;

    Ok(label)
}

/// Open a file in a new editor window.
#[tauri::command]
fn open_file_in_new_window(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingFiles>,
    path: String,
) -> Result<String, String> {
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("File not found: {}", path));
    }
    create_editor_window(&app, &pending, Some(path))
}

/// Create a new empty editor window (for Dock "New Window" and menu).
#[tauri::command]
fn create_new_window(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingFiles>,
) -> Result<String, String> {
    create_editor_window(&app, &pending, None)
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .manage(commands::mcp::MCPProcessManager::new())
        .manage(OpenedFiles(Mutex::new(initial_files)))
        .manage(PendingFiles(Mutex::new(HashMap::new())))
        .manage(MainWindowReady(AtomicBool::new(false)))
        .invoke_handler(tauri::generate_handler![
            commands::file::read_file,
            commands::file::read_resource_file,
            commands::file::write_file,
            commands::file::write_file_binary,
            commands::file::read_dir_recursive,
            commands::mcp::mcp_connect_stdio,
            commands::mcp::mcp_send_request,
            commands::mcp::mcp_send_notification,
            commands::mcp::mcp_disconnect,
            commands::mcp::check_command_exists,
            commands::update::get_platform_info,
            commands::update::exit_app,
            commands::update::download_update,
            set_editor_mode_menu,
            update_menu_labels,
            set_menu_check,
            get_opened_file,
            open_file_in_new_window,
            create_new_window,
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

            // Set up macOS Dock right-click menu with "New Window"
            #[cfg(target_os = "macos")]
            dock::setup_dock_menu(&app_handle);

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
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            {
                match &_event {
                    // Handle macOS "Open With" / file association events
                    tauri::RunEvent::Opened { urls } => {
                        let main_ready = _app
                            .try_state::<MainWindowReady>()
                            .map(|s| s.0.load(Ordering::SeqCst))
                            .unwrap_or(false);

                        for u in urls {
                            if u.scheme() == "file" {
                                if let Ok(p) = u.to_file_path() {
                                    let path = p.to_string_lossy().into_owned();

                                    if !main_ready {
                                        // Cold start: store file for the main window to pick up
                                        // via get_opened_file(). Also emit open-file in case the
                                        // frontend has already called get_opened_file.
                                        if let Some(opened) = _app.try_state::<OpenedFiles>() {
                                            opened.0.lock().unwrap().push(path.clone());
                                        }
                                        let _ = _app.emit("open-file", &path);
                                    } else {
                                        // Runtime: create a new window for the file
                                        if let Some(pending) = _app.try_state::<PendingFiles>() {
                                            let _ = create_editor_window(_app, &pending, Some(path));
                                        }
                                    }
                                }
                            }
                        }
                    }
                    // Handle Dock icon click when no windows are visible → create new window
                    tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                        if !has_visible_windows {
                            if let Some(pending) = _app.try_state::<PendingFiles>() {
                                let _ = create_editor_window(_app, &pending, None);
                            }
                        }
                    }
                    _ => {}
                }
            }
        });
}

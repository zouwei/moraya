use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

mod commands;
#[cfg(target_os = "macos")]
mod dock;
#[cfg(not(target_os = "ios"))]
mod menu;
#[cfg(all(not(target_os = "macos"), not(target_os = "ios")))]
mod tray;

/// Holds file paths requested to be opened via OS file association or CLI args.
pub struct OpenedFiles(pub Mutex<Vec<String>>);

/// Maps window labels to file paths that should be opened when the window mounts.
pub struct PendingFiles(pub Mutex<HashMap<String, String>>);

/// Tracks whether the main window has called get_opened_file (i.e. frontend is ready).
/// Used to distinguish cold-start file association from runtime file opens.
pub struct MainWindowReady(pub AtomicBool);

/// Atomic counter for generating unique window labels.
static WINDOW_COUNTER: AtomicU32 = AtomicU32::new(0);

/// Tracks the number of focused Moraya windows (Windows only).
/// Used to register/unregister the global Ctrl+Shift+I shortcut so it
/// intercepts the key before WebView2 opens DevTools.
#[cfg(target_os = "windows")]
static FOCUSED_WINDOW_COUNT: AtomicU32 = AtomicU32::new(0);

/// Windows/Linux: shrink window if it exceeds the available screen area.
/// Reserves space for OS taskbar (~48px) and window decorations (~52px).
#[cfg(all(not(target_os = "macos"), not(target_os = "ios")))]
fn fit_window_to_screen(window: &tauri::WebviewWindow) {
    use tauri::WebviewWindow;
    let _ = &window; // suppress unused import warning in cfg-off builds
    if let Ok(Some(monitor)) = WebviewWindow::current_monitor(window) {
        let scale = monitor.scale_factor();
        let monitor_h = monitor.size().height as f64 / scale;
        let monitor_w = monitor.size().width as f64 / scale;

        // Reserve ~100 logical px for taskbar + title bar + menu bar + borders
        let max_h = monitor_h - 100.0;
        let max_w = monitor_w - 20.0;

        if let Ok(current) = WebviewWindow::inner_size(window) {
            let cur_w = current.width as f64 / scale;
            let cur_h = current.height as f64 / scale;
            let new_w = if cur_w > max_w && max_w >= 600.0 { max_w } else { cur_w };
            let new_h = if cur_h > max_h && max_h >= 400.0 { max_h } else { cur_h };

            if (new_w - cur_w).abs() > 1.0 || (new_h - cur_h).abs() > 1.0 {
                let _ = window.set_size(tauri::LogicalSize::new(new_w, new_h));
                let _ = window.center();
            }
        }
    }
}

#[tauri::command]
fn set_editor_mode_menu(_app: tauri::AppHandle, _mode: String) {
    #[cfg(not(target_os = "ios"))]
    menu::update_mode_checks(&_app, &_mode);
}

#[tauri::command]
fn update_menu_labels(_app: tauri::AppHandle, _labels: HashMap<String, String>) {
    #[cfg(not(target_os = "ios"))]
    menu::update_menu_labels(&_app, &_labels);
}

#[tauri::command]
fn set_menu_check(_app: tauri::AppHandle, _id: String, _checked: bool) {
    #[cfg(not(target_os = "ios"))]
    menu::set_check_item(&_app, &_id, _checked);
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
    .devtools(false)
    .build()
    .map_err(|e| format!("Failed to create window: {}", e))?;

    // macOS: enable decorations for native traffic lights, then overlay
    #[cfg(target_os = "macos")]
    {
        use tauri::TitleBarStyle;
        let _ = window.set_decorations(true);
        let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
    }

    // Windows/Linux: enable decorations for native title bar + menu bar
    #[cfg(all(not(target_os = "macos"), not(target_os = "ios")))]
    {
        let _ = window.set_decorations(true);
        fit_window_to_screen(&window);
    }

    Ok(label)
}

/// Open a file in a new editor window.
#[tauri::command]
fn open_file_in_new_window(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingFiles>,
    path: String,
) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        let _ = (&app, &pending, &path);
        return Err("Multi-window is not supported on iPad".to_string());
    }
    #[cfg(not(target_os = "ios"))]
    {
        if !std::path::Path::new(&path).is_file() {
            return Err("File not found".to_string());
        }
        create_editor_window(&app, &pending, Some(path))
    }
}

/// Create a new empty editor window (for Dock "New Window" and menu).
#[tauri::command]
fn create_new_window(
    app: tauri::AppHandle,
    pending: tauri::State<'_, PendingFiles>,
) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        let _ = (&app, &pending);
        return Err("Multi-window is not supported on iPad".to_string());
    }
    #[cfg(not(target_os = "ios"))]
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
    // Fix PATH for macOS GUI apps (Dock/Finder don't inherit shell PATH)
    #[cfg(not(target_os = "ios"))]
    let _ = fix_path_env::fix();

    // Collect file paths from CLI args (Windows file association)
    let initial_files = file_paths_from_args();

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = app.emit("menu:view_ai_panel", ());
                    }
                })
                .build(),
        )
        .manage(commands::mcp::MCPProcessManager::new())
        .manage(commands::ai_proxy::AIProxyState::new())
        .manage(OpenedFiles(Mutex::new(initial_files)))
        .manage(PendingFiles(Mutex::new(HashMap::new())))
        .manage(MainWindowReady(AtomicBool::new(false)))
        .invoke_handler(tauri::generate_handler![
            commands::file::read_file,
            commands::file::read_resource_file,
            commands::file::write_file,
            commands::file::write_file_binary,
            commands::file::read_dir_recursive,
            commands::file::create_markdown_file,
            commands::file::rename_file,
            commands::file::delete_file,
            commands::file::read_file_previews,
            commands::mcp::mcp_connect_stdio,
            commands::mcp::mcp_send_request,
            commands::mcp::mcp_send_notification,
            commands::mcp::mcp_disconnect,
            commands::mcp::check_command_exists,
            commands::keychain::keychain_set,
            commands::keychain::keychain_get,
            commands::keychain::keychain_delete,
            commands::ai_proxy::ai_proxy_fetch,
            commands::ai_proxy::ai_proxy_stream,
            commands::ai_proxy::ai_proxy_abort,
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

            // Desktop: configure window decorations
            #[cfg(not(target_os = "ios"))]
            {
                // macOS: enable decorations for native traffic lights, then overlay
                #[cfg(target_os = "macos")]
                {
                    use tauri::TitleBarStyle;
                    let _ = window.set_decorations(true);
                    let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
                }

                // Windows/Linux: enable decorations for native title bar + menu bar
                #[cfg(all(not(target_os = "macos"), not(target_os = "ios")))]
                {
                    let _ = window.set_decorations(true);
                    fit_window_to_screen(&window);
                }

                // Create and set native menu
                let app_handle = app.handle().clone();
                let native_menu = menu::create_menu(&app_handle)?;
                app.set_menu(native_menu)?;

                // Set up macOS Dock right-click menu with "New Window"
                #[cfg(target_os = "macos")]
                dock::setup_dock_menu(&app_handle);

                // Set up system tray for Windows/Linux
                #[cfg(all(not(target_os = "macos"), not(target_os = "ios")))]
                tray::setup_tray(app)?;

                // Handle menu events — emit to the main window
                let app_handle_for_events = app.handle().clone();
                app.on_menu_event(move |_app, event| {
                    // Skip spurious events fired by GTK's set_checked() during
                    // programmatic checkmark updates (update_mode_checks).
                    if menu::is_updating_mode_checks() {
                        return;
                    }

                    let id = event.id().0.as_str();

                    // Emit as global event to all webviews
                    let _ = app_handle_for_events.emit(&format!("menu:{}", id), ());
                });
            }

            let _ = window;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // Windows: register/unregister global Ctrl+Shift+I shortcut based on
            // window focus to intercept the key before WebView2 opens DevTools.
            #[cfg(target_os = "windows")]
            {
                if let tauri::RunEvent::WindowEvent {
                    event: tauri::WindowEvent::Focused(focused),
                    ..
                } = &_event
                {
                    use tauri_plugin_global_shortcut::{
                        Code, GlobalShortcutExt, Modifiers, Shortcut,
                    };
                    let shortcut =
                        Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyI);
                    if *focused {
                        let prev = FOCUSED_WINDOW_COUNT.fetch_add(1, Ordering::SeqCst);
                        if prev == 0 {
                            let _ = _app.global_shortcut().register(shortcut);
                        }
                    } else {
                        let prev = FOCUSED_WINDOW_COUNT.fetch_sub(1, Ordering::SeqCst);
                        if prev == 1 {
                            let _ = _app.global_shortcut().unregister(shortcut);
                        }
                    }
                }
            }

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

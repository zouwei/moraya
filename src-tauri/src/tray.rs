use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

/// Set up a system tray icon with a context menu for Windows/Linux.
/// Provides quick access to New Window, Open File, Settings, and Quit.
pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let is_zh = std::env::var("LANG").unwrap_or_default().starts_with("zh");

    let new_window = MenuItem::with_id(
        app,
        "tray_new_window",
        if is_zh { "新建窗口" } else { "New Window" },
        true,
        None::<&str>,
    )?;
    let open_file = MenuItem::with_id(
        app,
        "tray_open_file",
        if is_zh { "打开文件" } else { "Open File" },
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(
        app,
        "tray_settings",
        if is_zh { "设置" } else { "Settings" },
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "tray_quit",
        if is_zh { "退出" } else { "Quit" },
        true,
        None::<&str>,
    )?;

    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(
        app,
        &[&new_window, &open_file, &sep1, &settings, &sep2, &quit],
    )?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Moraya")
        .menu(&menu)
        .menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                // Try to show and focus any existing window
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                } else {
                    // No main window — create a new one
                    if let Some(pending) = app.try_state::<crate::PendingFiles>() {
                        let _ = crate::create_editor_window(app, &pending, None);
                    }
                }
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray_new_window" => {
                if let Some(pending) = app.try_state::<crate::PendingFiles>() {
                    let _ = crate::create_editor_window(app, &pending, None);
                }
            }
            "tray_open_file" => {
                let _ = app.emit("menu:file_open", ());
            }
            "tray_settings" => {
                let _ = app.emit("menu:preferences", ());
            }
            "tray_quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

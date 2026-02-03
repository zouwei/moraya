use std::collections::HashMap;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    AppHandle, Wry,
};

pub fn create_menu(app: &AppHandle) -> Result<Menu<Wry>, tauri::Error> {
    // File menu
    let file_menu = Submenu::with_id_and_items(
        app,
        "menu_file",
        "File",
        true,
        &[
            &MenuItem::with_id(app, "file_new", "New", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(app, "file_open", "Open...", true, Some("CmdOrCtrl+O"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "file_save", "Save", true, Some("CmdOrCtrl+S"))?,
            &MenuItem::with_id(app, "file_save_as", "Save As...", true, Some("CmdOrCtrl+Shift+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "file_export_html", "Export as HTML", true, Some("CmdOrCtrl+Shift+E"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("Close Window"))?,
        ],
    )?;

    // Edit menu — PredefinedMenuItems auto-localize on macOS
    let edit_menu = Submenu::with_id_and_items(
        app,
        "menu_edit",
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // Paragraph menu
    let paragraph_menu = Submenu::with_id_and_items(
        app,
        "menu_paragraph",
        "Paragraph",
        true,
        &[
            &MenuItem::with_id(app, "para_h1", "Heading 1", true, Some("CmdOrCtrl+1"))?,
            &MenuItem::with_id(app, "para_h2", "Heading 2", true, Some("CmdOrCtrl+2"))?,
            &MenuItem::with_id(app, "para_h3", "Heading 3", true, Some("CmdOrCtrl+3"))?,
            &MenuItem::with_id(app, "para_h4", "Heading 4", true, Some("CmdOrCtrl+4"))?,
            &MenuItem::with_id(app, "para_h5", "Heading 5", true, Some("CmdOrCtrl+5"))?,
            &MenuItem::with_id(app, "para_h6", "Heading 6", true, Some("CmdOrCtrl+6"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "para_table", "Table", true, None::<&str>)?,
            &MenuItem::with_id(app, "para_code_block", "Code Block", true, Some("CmdOrCtrl+Shift+K"))?,
            &MenuItem::with_id(app, "para_math_block", "Math Block", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "para_quote", "Quote", true, Some("CmdOrCtrl+Shift+Q"))?,
            &MenuItem::with_id(app, "para_bullet_list", "Bullet List", true, None::<&str>)?,
            &MenuItem::with_id(app, "para_ordered_list", "Ordered List", true, None::<&str>)?,
            &MenuItem::with_id(app, "para_hr", "Horizontal Rule", true, None::<&str>)?,
        ],
    )?;

    // Format menu
    let format_menu = Submenu::with_id_and_items(
        app,
        "menu_format",
        "Format",
        true,
        &[
            &MenuItem::with_id(app, "fmt_bold", "Bold", true, Some("CmdOrCtrl+B"))?,
            &MenuItem::with_id(app, "fmt_italic", "Italic", true, Some("CmdOrCtrl+I"))?,
            &MenuItem::with_id(app, "fmt_strikethrough", "Strikethrough", true, Some("CmdOrCtrl+Shift+X"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "fmt_code", "Code", true, Some("CmdOrCtrl+E"))?,
            &MenuItem::with_id(app, "fmt_link", "Link", true, Some("CmdOrCtrl+K"))?,
            &MenuItem::with_id(app, "fmt_image", "Image", true, Some("CmdOrCtrl+Shift+G"))?,
        ],
    )?;

    // View menu — mode items use CheckMenuItem
    let view_menu = Submenu::with_id_and_items(
        app,
        "menu_view",
        "View",
        true,
        &[
            &CheckMenuItem::with_id(app, "view_mode_visual", "Visual Mode          ⌘/", true, true, None::<&str>)?,
            &CheckMenuItem::with_id(app, "view_mode_source", "Source Mode         ⌘/", true, false, None::<&str>)?,
            &CheckMenuItem::with_id(app, "view_mode_split", "Split Mode       ⇧⌘/", true, false, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "view_sidebar", "Toggle Sidebar", true, Some("CmdOrCtrl+\\"))?,
            &MenuItem::with_id(app, "view_ai_panel", "Toggle AI Panel", true, Some("CmdOrCtrl+Shift+I"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "view_zoom_in", "Zoom In", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(app, "view_zoom_out", "Zoom Out", true, Some("CmdOrCtrl+-"))?,
            &MenuItem::with_id(app, "view_actual_size", "Actual Size", true, Some("CmdOrCtrl+0"))?,
        ],
    )?;

    // Help menu
    let help_menu = Submenu::with_id_and_items(
        app,
        "menu_help",
        "Help",
        true,
        &[
            &MenuItem::with_id(app, "help_about", "About Moraya", true, None::<&str>)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            app,
            "Moraya",
            true,
            &[
                &PredefinedMenuItem::about(app, Some("About Moraya"), None)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "preferences", "Settings...", true, Some("CmdOrCtrl+,"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;

        let menu = Menu::with_items(
            app,
            &[
                &app_menu,
                &file_menu,
                &edit_menu,
                &paragraph_menu,
                &format_menu,
                &view_menu,
                &help_menu,
            ],
        )?;
        Ok(menu)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let menu = Menu::with_items(
            app,
            &[
                &file_menu,
                &edit_menu,
                &paragraph_menu,
                &format_menu,
                &view_menu,
                &help_menu,
            ],
        )?;
        Ok(menu)
    }
}

/// Update the check state of the three mode menu items.
/// `active_mode` should be "visual", "source", or "split".
pub fn update_mode_checks(app: &AppHandle, active_mode: &str) {
    let mode_ids = ["view_mode_visual", "view_mode_source", "view_mode_split"];
    let active_id = format!("view_mode_{}", active_mode);

    if let Some(menu) = app.menu() {
        // Search through all items including submenus
        if let Ok(items) = menu.items() {
            for item in &items {
                if let MenuItemKind::Submenu(submenu) = item {
                    if let Ok(sub_items) = submenu.items() {
                        for sub_item in &sub_items {
                            if let MenuItemKind::Check(check_item) = sub_item {
                                let item_id = check_item.id().0.as_str();
                                if mode_ids.contains(&item_id) {
                                    let _ = check_item.set_checked(item_id == active_id.as_str());
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Update menu item labels for i18n.
/// `labels` maps menu item IDs (e.g., "file_new", "menu_file") to translated text.
pub fn update_menu_labels(app: &AppHandle, labels: &HashMap<String, String>) {
    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            update_labels_recursive(&items, labels);
        }
    }
}

fn update_labels_recursive(items: &[MenuItemKind<Wry>], labels: &HashMap<String, String>) {
    for item in items {
        match item {
            MenuItemKind::MenuItem(mi) => {
                if let Some(label) = labels.get(mi.id().0.as_str()) {
                    let _ = mi.set_text(label);
                }
            }
            MenuItemKind::Check(ci) => {
                if let Some(label) = labels.get(ci.id().0.as_str()) {
                    let _ = ci.set_text(label);
                }
            }
            MenuItemKind::Submenu(sub) => {
                if let Some(label) = labels.get(sub.id().0.as_str()) {
                    let _ = sub.set_text(label);
                }
                if let Ok(sub_items) = sub.items() {
                    update_labels_recursive(&sub_items, labels);
                }
            }
            _ => {}
        }
    }
}

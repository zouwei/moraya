use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    AppHandle, Wry,
};

pub fn create_menu(app: &AppHandle) -> Result<Menu<Wry>, tauri::Error> {
    // File menu
    let file_menu = Submenu::with_items(
        app,
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

    // Edit menu
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("Undo"))?,
            &PredefinedMenuItem::redo(app, Some("Redo"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("Cut"))?,
            &PredefinedMenuItem::copy(app, Some("Copy"))?,
            &PredefinedMenuItem::paste(app, Some("Paste"))?,
            &PredefinedMenuItem::select_all(app, Some("Select All"))?,
        ],
    )?;

    // Paragraph menu
    let paragraph_menu = Submenu::with_items(
        app,
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
    let format_menu = Submenu::with_items(
        app,
        "Format",
        true,
        &[
            &MenuItem::with_id(app, "fmt_bold", "Bold", true, Some("CmdOrCtrl+B"))?,
            &MenuItem::with_id(app, "fmt_italic", "Italic", true, Some("CmdOrCtrl+I"))?,
            &MenuItem::with_id(app, "fmt_strikethrough", "Strikethrough", true, Some("CmdOrCtrl+Shift+X"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "fmt_code", "Code", true, Some("CmdOrCtrl+E"))?,
            &MenuItem::with_id(app, "fmt_link", "Link", true, Some("CmdOrCtrl+K"))?,
            &MenuItem::with_id(app, "fmt_image", "Image", true, None::<&str>)?,
        ],
    )?;

    // View menu — mode items use CheckMenuItem
    let view_menu = Submenu::with_items(
        app,
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
    let help_menu = Submenu::with_items(
        app,
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
                &PredefinedMenuItem::services(app, Some("Services"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, Some("Hide Moraya"))?,
                &PredefinedMenuItem::hide_others(app, Some("Hide Others"))?,
                &PredefinedMenuItem::show_all(app, Some("Show All"))?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, Some("Quit Moraya"))?,
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

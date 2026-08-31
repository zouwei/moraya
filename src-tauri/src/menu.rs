use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu},
    AppHandle, Wry,
};
#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;

/// MCP tool info for dynamic menu updates from frontend.
#[derive(serde::Deserialize, Clone)]
pub struct MCPMenuTool {
    pub name: String,
    pub description: String,
}

/// MCP server info for dynamic menu updates from frontend.
#[derive(serde::Deserialize, Clone)]
pub struct MCPMenuServer {
    pub name: String,
    pub tools: Vec<MCPMenuTool>,
}

/// Truncate a string to max_chars, appending "…" if truncated.
fn truncate_str(s: &str, max_chars: usize) -> String {
    let char_count = s.chars().count();
    if char_count <= max_chars {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_chars).collect();
        format!("{}…", truncated)
    }
}

/// Guard flag: true while `update_mode_checks` is running.
/// On Linux (GTK), `set_checked()` synchronously triggers the "activate" signal,
/// which fires `on_menu_event`. This flag lets the event handler skip those
/// spurious events to avoid a feedback loop.
static UPDATING_MODE_CHECKS: AtomicBool = AtomicBool::new(false);

/// Returns true when mode checkmarks are being programmatically updated.
pub fn is_updating_mode_checks() -> bool {
    UPDATING_MODE_CHECKS.load(Ordering::SeqCst)
}

pub fn create_menu(app: &AppHandle) -> Result<Menu<Wry>, tauri::Error> {
    // File menu
    let file_new = MenuItem::with_id(app, "file_new", "New Markdown Document", true, Some("CmdOrCtrl+N"))?;
    let file_new_typst = MenuItem::with_id(app, "file_new_typst", "New Typst Document", true, None::<&str>)?;
    // Typst Universe templates — the engine's own `typst init` does the work.
    let file_new_template = MenuItem::with_id(app, "file_new_template", "New Typst Document from Template...", true, None::<&str>)?;
    // Convert to the other flavor. Result opens as a NEW document; the source
    // is left untouched because the conversion is lossy. The label is replaced
    // from the frontend with the direction that applies to the active document.
    let file_convert_typst = MenuItem::with_id(app, "file_convert_typst", "Save as Typst Document", true, None::<&str>)?;
    let file_new_window = MenuItem::with_id(app, "file_new_window", "New Window", true, Some("CmdOrCtrl+Shift+N"))?;
    let file_open = MenuItem::with_id(app, "file_open", "Open...", true, Some("CmdOrCtrl+O"))?;
    let file_save = MenuItem::with_id(app, "file_save", "Save", true, Some("CmdOrCtrl+S"))?;
    let file_save_as = MenuItem::with_id(app, "file_save_as", "Save As...", true, Some("CmdOrCtrl+Shift+S"))?;
    let export_submenu = Submenu::with_id_and_items(
        app,
        "menu_export",
        "Export",
        true,
        &[
            &MenuItem::with_id(app, "file_export_html", "HTML", true, Some("CmdOrCtrl+Shift+E"))?,
            &MenuItem::with_id(app, "file_export_pdf", "PDF", true, None::<&str>)?,
            &MenuItem::with_id(app, "file_export_image", "Image (PNG)", true, None::<&str>)?,
            &MenuItem::with_id(app, "file_export_doc", "Word (.doc)", true, None::<&str>)?,
        ],
    )?;
    // Cmd/Ctrl+W closes the TAB, not the window — Moraya is tabbed, and the
    // predefined close_window item claims that accelerator, so quitting was one
    // keystroke away from any editing session. The frontend runs the same
    // handler as the tab's × (unsaved prompt included) and only falls through to
    // closing the window when the last tab goes. Closing the window outright
    // moves to Cmd/Ctrl+Shift+W, matching the browser convention.
    let close_tab =
        MenuItem::with_id(app, "file_close_tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let close_window = MenuItem::with_id(
        app,
        "file_close_window",
        "Close Window",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;

    #[cfg(target_os = "macos")]
    let file_menu = Submenu::with_id_and_items(
        app,
        "menu_file",
        "File",
        true,
        &[
            &file_new,
            &file_new_typst,
            &file_new_template,
            &file_new_window,
            &file_open,
            &PredefinedMenuItem::separator(app)?,
            &file_save,
            &file_save_as,
            &file_convert_typst,
            &PredefinedMenuItem::separator(app)?,
            &export_submenu,
            &PredefinedMenuItem::separator(app)?,
            &close_tab,
            &close_window,
        ],
    )?;

    #[cfg(not(target_os = "macos"))]
    let file_menu = {
        let preferences = MenuItem::with_id(app, "preferences", "Settings...", true, Some("CmdOrCtrl+,"))?;
        Submenu::with_id_and_items(
            app,
            "menu_file",
            "File",
            true,
            &[
                &file_new,
                &file_new_typst,
                &file_new_template,
                &file_new_window,
                &file_open,
                &PredefinedMenuItem::separator(app)?,
                &file_save,
                &file_save_as,
                &file_convert_typst,
                &PredefinedMenuItem::separator(app)?,
                &export_submenu,
                &PredefinedMenuItem::separator(app)?,
                &preferences,
                &PredefinedMenuItem::separator(app)?,
                &close_tab,
                &close_window,
            ],
        )?
    };

    // Edit menu — use custom MenuItem for Undo/Redo so they emit menu events
    // to the frontend. PredefinedMenuItem::undo sends the native `undo:` selector
    // which bypasses ProseMirror's JavaScript-based history stack.
    let edit_menu = Submenu::with_id_and_items(
        app,
        "menu_edit",
        "Edit",
        true,
        &[
            &MenuItem::with_id(app, "edit_undo", "Undo", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, "edit_redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &MenuItem::with_id(app, "edit_select_all", "Select All", true, Some("CmdOrCtrl+A"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "edit_find", "Find", true, Some("CmdOrCtrl+F"))?,
            &MenuItem::with_id(app, "edit_replace", "Replace", true, Some("CmdOrCtrl+H"))?,
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
            &MenuItem::with_id(app, "para_task_list", "Task List", true, None::<&str>)?,
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
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "insert_cloud_image", "Insert Cloud Image…", true, None::<&str>)?,
            &MenuItem::with_id(app, "insert_cloud_audio", "Insert Cloud Audio…", true, None::<&str>)?,
            &MenuItem::with_id(app, "insert_cloud_video", "Insert Cloud Video…", true, None::<&str>)?,
        ],
    )?;

    // View menu — mode items
    // Shortcut hints are label text (not accelerators) — use platform-appropriate symbols.
    // CheckMenuItem on all platforms with programmatic checkmark sync via update_mode_checks.
    // On Linux (GTK), set_checked() can trigger on_menu_event; the UPDATING_MODE_CHECKS
    // flag in the event handler prevents the resulting feedback loop.
    //
    // v0.41.5 (idempotent-floating-bumblebee, A5): accelerators are now
    // real OS-level shortcuts (not Unicode-painted text), so menu-sync
    // can update them when the user remaps. Pressing the visual-mode accel
    // toggles between visual ↔ source (logic lives in the frontend
    // `runShortcutAction('view.toggleMode')`); the source item does not
    // need its own accel.
    let mode_visual = CheckMenuItem::with_id(app, "view_mode_visual", "Visual Mode", true, true, Some("CmdOrCtrl+/"))?;
    let mode_source = CheckMenuItem::with_id(app, "view_mode_source", "Source Mode", true, false, None::<&str>)?;
    let mode_split = CheckMenuItem::with_id(app, "view_mode_split", "Split Mode", true, false, Some("CmdOrCtrl+Shift+/"))?;

    // Creation views — a second, orthogonal axis to the three modes above:
    // those pick WHAT you look at, these pick WHAT YOU ARE DOING. Kept FLAT in
    // the View menu rather than nested in a submenu of their own, because
    // `set_check_item` walks exactly one level of submenus; a nested group
    // would never receive its checkmark sync.
    let view_standard = CheckMenuItem::with_id(app, "view_creation_standard", "Standard View", true, true, Some("CmdOrCtrl+Shift+1"))?;
    let view_reading = CheckMenuItem::with_id(app, "view_creation_reading", "Reading View", true, false, Some("CmdOrCtrl+Shift+2"))?;
    let view_writing = CheckMenuItem::with_id(app, "view_creation_writing", "Writing View", true, false, Some("CmdOrCtrl+Shift+3"))?;

    let view_menu = Submenu::with_id_and_items(
        app,
        "menu_view",
        "View",
        true,
        &[
            &view_standard,
            &view_reading,
            &view_writing,
            &PredefinedMenuItem::separator(app)?,
            &mode_visual,
            &mode_source,
            &mode_split,
            &PredefinedMenuItem::separator(app)?,
            &CheckMenuItem::with_id(app, "view_sidebar", "Toggle Sidebar", true, false, Some("CmdOrCtrl+\\"))?,
            &CheckMenuItem::with_id(app, "view_ai_panel", "Toggle AI Panel", true, false, Some("CmdOrCtrl+Shift+I"))?,
            &CheckMenuItem::with_id(app, "view_outline", "Toggle Outline", true, false, Some("CmdOrCtrl+Shift+O"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "view_zoom_in", "Zoom In", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(app, "view_zoom_out", "Zoom Out", true, Some("CmdOrCtrl+-"))?,
            &MenuItem::with_id(app, "view_actual_size", "Actual Size", true, Some("CmdOrCtrl+0"))?,
        ],
    )?;

    // Workflow menu
    let workflow_menu = Submenu::with_id_and_items(
        app,
        "menu_workflow",
        "Workflow",
        true,
        &[
            &MenuItem::with_id(app, "wf_seo", "SEO Optimization", true, None::<&str>)?,
            &MenuItem::with_id(app, "wf_image_gen", "AI Image Generation", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "wf_publish", "Publish", true, None::<&str>)?,
            &Submenu::with_id_and_items(
                app,
                "wf_mcp",
                "MCP Tools",
                true,
                &[
                    &MenuItem::with_id(app, "wf_mcp_empty", "No MCP Tools Connected", false, None::<&str>)?,
                ],
            )?,
        ],
    )?;

    // Window menu (macOS standard: Minimize, Zoom + auto window list via set_as_windows_menu_for_nsapp)
    let window_menu = Submenu::with_id_and_items(
        app,
        "menu_window",
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    // Help menu
    let help_menu = Submenu::with_id_and_items(
        app,
        "menu_help",
        "Help",
        true,
        &[
            &MenuItem::with_id(app, "help_version_info", "Version Info", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "help_changelog", "Changelog", true, None::<&str>)?,
            &MenuItem::with_id(app, "help_terms", "Terms of Service", true, None::<&str>)?,
            &MenuItem::with_id(app, "help_privacy", "Privacy Policy", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "help_website", "Official Website", true, None::<&str>)?,
            &MenuItem::with_id(app, "help_about", "About Moraya", true, None::<&str>)?,
            &MenuItem::with_id(app, "help_feedback", "Feedback", true, None::<&str>)?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    {
        let about_metadata = AboutMetadata {
            copyright: Some("© 2026 Moraya Contributors".into()),
            credits: Some(
                "A minimal, AI-ready Markdown editor\n\n\
                 Tech Stack\n\
                 Rust + Tauri v2 · Svelte 5 · TypeScript\n\
                 ProseMirror · KaTeX · mermaid\n\n\
                 https://moraya.app"
                    .into(),
            ),
            ..Default::default()
        };

        let app_menu = Submenu::with_items(
            app,
            "Moraya",
            true,
            &[
                &PredefinedMenuItem::about(app, Some("About Moraya"), Some(about_metadata))?,
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

        // Tell macOS this is the "Window" menu so it auto-populates with open windows
        let _ = window_menu.set_as_windows_menu_for_nsapp();

        let menu = Menu::with_items(
            app,
            &[
                &app_menu,
                &file_menu,
                &edit_menu,
                &paragraph_menu,
                &format_menu,
                &view_menu,
                &workflow_menu,
                &window_menu,
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
                &workflow_menu,
                &window_menu,
                &help_menu,
            ],
        )?;
        Ok(menu)
    }
}

/// Update the check state of the three mode menu items.
/// `active_mode` should be "visual", "source", or "split".
///
/// Sets [`UPDATING_MODE_CHECKS`] while running so the `on_menu_event` handler
/// can skip spurious events caused by GTK's synchronous "activate" signal.
pub fn update_mode_checks(app: &AppHandle, active_mode: &str) {
    let mode_ids = ["view_mode_visual", "view_mode_source", "view_mode_split"];
    let active_id = format!("view_mode_{}", active_mode);

    UPDATING_MODE_CHECKS.store(true, Ordering::SeqCst);

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

    UPDATING_MODE_CHECKS.store(false, Ordering::SeqCst);
}

/// Set the checked state of a single CheckMenuItem by its ID.
///
/// Uses [`UPDATING_MODE_CHECKS`] guard to prevent the feedback loop where
/// `set_checked()` triggers `on_menu_event` (GTK/macOS), which emits back
/// to the frontend, toggling the state, firing `$effect`, calling this
/// function again — ad infinitum.
pub fn set_check_item(app: &AppHandle, item_id: &str, checked: bool) {
    UPDATING_MODE_CHECKS.store(true, Ordering::SeqCst);

    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            for item in &items {
                if let MenuItemKind::Submenu(submenu) = item {
                    if let Ok(sub_items) = submenu.items() {
                        for sub_item in &sub_items {
                            if let MenuItemKind::Check(check_item) = sub_item {
                                if check_item.id().0.as_str() == item_id {
                                    let _ = check_item.set_checked(checked);
                                    UPDATING_MODE_CHECKS.store(false, Ordering::SeqCst);
                                    return;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    UPDATING_MODE_CHECKS.store(false, Ordering::SeqCst);
}

/// Read the current `is_checked()` state of a CheckMenuItem by ID.
/// Returns `None` if the item is not found.
pub fn get_check_state(app: &AppHandle, item_id: &str) -> Option<bool> {
    let menu = app.menu()?;
    let items = menu.items().ok()?;
    for item in &items {
        if let MenuItemKind::Submenu(submenu) = item {
            if let Ok(sub_items) = submenu.items() {
                for sub_item in &sub_items {
                    if let MenuItemKind::Check(check_item) = sub_item {
                        if check_item.id().0.as_str() == item_id {
                            return check_item.is_checked().ok();
                        }
                    }
                }
            }
        }
    }
    None
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

/// Enable / disable menu items by ID (v0.46.0 — per-document-flavor gating).
///
/// Moraya edits both Markdown and Typst documents. Actions that exist in only
/// one format (Task List has no Typst counterpart; cloud audio/video cannot be
/// embedded in a print format) are greyed out — never removed — while the other
/// flavor is active, so the menu keeps a stable shape and the user can still see
/// the action exists. `states` maps menu item IDs to the desired enabled flag.
///
/// Walks nested submenus because some targets live two levels deep
/// (File ▸ Export ▸ …).
pub fn set_menu_items_enabled(app: &AppHandle, states: &HashMap<String, bool>) {
    if let Some(menu) = app.menu() {
        if let Ok(items) = menu.items() {
            set_enabled_recursive(&items, states);
        }
    }
}

fn set_enabled_recursive(items: &[MenuItemKind<Wry>], states: &HashMap<String, bool>) {
    for item in items {
        match item {
            MenuItemKind::MenuItem(mi) => {
                if let Some(&enabled) = states.get(mi.id().0.as_str()) {
                    let _ = mi.set_enabled(enabled);
                }
            }
            MenuItemKind::Check(ci) => {
                if let Some(&enabled) = states.get(ci.id().0.as_str()) {
                    let _ = ci.set_enabled(enabled);
                }
            }
            MenuItemKind::Submenu(sub) => {
                if let Some(&enabled) = states.get(sub.id().0.as_str()) {
                    let _ = sub.set_enabled(enabled);
                }
                if let Ok(sub_items) = sub.items() {
                    set_enabled_recursive(&sub_items, states);
                }
            }
            _ => {}
        }
    }
}

/// Update the MCP Tools submenu with connected server tools.
/// Called from frontend whenever MCP connections change.
/// `no_tools_label` is the i18n-resolved placeholder text for when no tools are connected.
pub fn update_mcp_submenu(app: &AppHandle, servers: &[MCPMenuServer], no_tools_label: &str) {
    let Some(menu) = app.menu() else { return };
    let Ok(items) = menu.items() else { return };

    // Find the workflow submenu → MCP submenu
    for item in &items {
        if let MenuItemKind::Submenu(workflow) = item {
            if workflow.id().0.as_str() == "menu_workflow" {
                if let Ok(wf_items) = workflow.items() {
                    for wf_item in &wf_items {
                        if let MenuItemKind::Submenu(mcp_sub) = wf_item {
                            if mcp_sub.id().0.as_str() == "wf_mcp" {
                                rebuild_mcp_items(app, mcp_sub, servers, no_tools_label);
                                return;
                            }
                        }
                    }
                }
            }
        }
    }
}

fn rebuild_mcp_items(app: &AppHandle, submenu: &Submenu<Wry>, servers: &[MCPMenuServer], no_tools_label: &str) {
    // Remove all existing items
    while submenu.remove_at(0).ok().flatten().is_some() {}

    if servers.is_empty() {
        if let Ok(item) = MenuItem::with_id(app, "wf_mcp_empty", no_tools_label, false, None::<&str>) {
            let _ = submenu.append(&item);
        }
        return;
    }

    for (si, server) in servers.iter().enumerate() {
        if si > 0 {
            if let Ok(sep) = PredefinedMenuItem::separator(app) {
                let _ = submenu.append(&sep);
            }
        }

        // Build tool items for this server
        let mut tool_items: Vec<MenuItem<Wry>> = Vec::new();
        for (ti, tool) in server.tools.iter().enumerate() {
            let tool_id = format!("wf_mcp_{}_{}", si, ti);
            let tool_label = if tool.description.is_empty() {
                tool.name.clone()
            } else {
                format!("{} — {}", tool.name, truncate_str(&tool.description, 50))
            };
            if let Ok(item) = MenuItem::with_id(app, &tool_id, &tool_label, true, None::<&str>) {
                tool_items.push(item);
            }
        }

        let refs: Vec<&dyn IsMenuItem<Wry>> = tool_items.iter().map(|i| i as &dyn IsMenuItem<Wry>).collect();
        let server_submenu_id = format!("wf_mcp_s{}", si);
        let tool_word = if server.tools.len() == 1 { "tool" } else { "tools" };
        let server_label = format!("{} ({} {})", server.name, server.tools.len(), tool_word);

        if let Ok(server_sub) = Submenu::with_id_and_items(app, &server_submenu_id, &server_label, true, &refs) {
            let _ = submenu.append(&server_sub);
        }
    }
}

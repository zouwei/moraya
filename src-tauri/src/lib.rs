use std::collections::{HashMap, HashSet};
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

/// Serializable tab data for cross-window tab transfer (detach/attach).
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct TabTransferData {
    pub file_path: Option<String>,
    pub file_name: String,
    pub content: String,
    pub is_dirty: bool,
    pub cursor_offset: usize,
    pub scroll_fraction: f64,
    pub last_mtime: Option<f64>,
    /// Markup language the document is authored in (`"markdown"` / `"typst"`).
    /// Must travel with the tab: an unsaved Typst document has no `.typ` path to
    /// re-detect from, so dropping this would silently reopen it as markdown in
    /// the destination window and lose the compiled preview.
    /// Optional for backward compatibility with in-flight payloads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flavor: Option<String>,
}

/// Maps window labels to pending tab data for newly created windows (tab detach).
pub struct PendingTabData(pub Mutex<HashMap<String, TabTransferData>>);

/// File extension for the scratch file used when detaching a tab on
/// Windows/Linux (those platforms spawn a new process with the file as an
/// argument, and the receiving window re-detects the document flavor from the
/// extension). Lives outside the `cfg` block so it is compiled — and tested —
/// on every platform.
///
/// `allow(dead_code)`: only the Windows/Linux detach path calls this (macOS
/// builds the window directly and passes `TabTransferData` in memory), but the
/// function stays platform-independent so its behavior is unit-tested wherever
/// the suite runs, rather than only on the platforms that use it.
#[allow(dead_code)]
fn detach_temp_extension(flavor: Option<&str>) -> &'static str {
    match flavor {
        Some("typst") => "typ",
        _ => "md",
    }
}

/// Tracks whether the main window has called get_opened_files (i.e. frontend is ready).
/// Used to distinguish cold-start file association from runtime file opens.
pub struct MainWindowReady(pub AtomicBool);

/// Holds a pending Picora deep-link payload received before the frontend is ready.
/// Frontend drains this via `take_pending_picora_import` once the import dialog is mounted.
pub struct PendingPicoraImport(pub Mutex<Option<serde_json::Value>>);

/// Recent file-open dispatches, used to dedupe `on_open_url` (deep-link plugin)
/// vs `RunEvent::Opened` (Tauri runtime) which can both fire for the same
/// macOS apple-event. Maps path → instant of last dispatch; entries older than
/// the dedup window are ignored.
pub struct RecentOpens(pub Mutex<HashMap<String, std::time::Instant>>);

/// Atomic counter for generating unique window labels.
static WINDOW_COUNTER: AtomicU32 = AtomicU32::new(0);

/// Tracks which document is open in each window (used for macOS Dock menu).
pub struct DockDocumentTracker(pub Mutex<HashMap<String, DockDocEntry>>);

/// Entry for a single window in the Dock document tracker.
#[derive(Clone)]
pub struct DockDocEntry {
    pub display_name: String,
    pub file_path: Option<String>,
}

/// Label of the currently focused window (macOS Dock menu checkmark).
#[cfg(target_os = "macos")]
pub(crate) static FOCUSED_WINDOW_LABEL: Mutex<Option<String>> = Mutex::new(None);

/// Saved window positions for set_window_alpha on Windows/Linux.
/// When alpha=0 moves a window off-screen, the original position is saved here
/// so alpha>0 can restore it. Without this, windows get stuck at (-99999,-99999).
#[cfg(not(target_os = "macos"))]
static SAVED_WINDOW_POSITIONS: Mutex<Option<HashMap<String, (f64, f64)>>> = Mutex::new(None);

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

#[tauri::command]
fn update_mcp_menu(_app: tauri::AppHandle, _servers: Vec<menu::MCPMenuServer>, _no_tools_label: String) {
    #[cfg(not(target_os = "ios"))]
    menu::update_mcp_submenu(&_app, &_servers, &_no_tools_label);
}

/// Called by the frontend once it's ready; returns ALL queued file paths to open.
/// For new windows created via drag-drop, looks up PendingFiles by window label
/// (always exactly one path).
/// For the main window, drains OpenedFiles (startup CLI args / file association).
/// Multi-select on macOS Finder "Open With" and `open -a Moraya.app *.md` queue
/// every path; returning just the first dropped the rest silently (issue #65).
#[tauri::command]
fn get_opened_files(
    window: tauri::Window,
    state: tauri::State<'_, OpenedFiles>,
    pending: tauri::State<'_, PendingFiles>,
    ready: tauri::State<'_, MainWindowReady>,
) -> Vec<String> {
    let label = window.label();

    // Check PendingFiles first (for dynamically created windows)
    {
        let mut pending_map = pending.0.lock().unwrap();
        if let Some(path) = pending_map.remove(label) {
            return vec![path];
        }
    }

    // Main window: drain startup OpenedFiles, dedupe preserving order.
    // Drain (not clone) so subsequent calls return empty and a stuck cold-start
    // queue can't bleed into later warm-start re-opens.
    if label == "main" {
        // Mark main window as ready so future RunEvent::Opened events
        // create new windows instead of routing to main
        ready.0.store(true, Ordering::SeqCst);
        let mut files = state.0.lock().unwrap();
        let mut seen = HashSet::new();
        return files
            .drain(..)
            .filter(|path| seen.insert(path.clone()))
            .collect();
    }

    Vec::new()
}

/// Create a new editor window, optionally for a specific file path.
pub(crate) fn create_editor_window(
    app: &tauri::AppHandle,
    pending: &PendingFiles,
    path: Option<String>,
) -> Result<String, String> {
    let title = path
        .as_ref()
        .and_then(|p| std::path::Path::new(p).file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Moraya".to_string());

    // Windows/Linux: spawn a new Moraya process.
    // WebviewWindowBuilder::build() hangs at runtime on Windows due to a
    // WebView2 nested message pump deadlock with the running event loop.
    // Spawning a new process avoids this — the new process creates its
    // window during setup() before the event loop starts (no deadlock).
    #[cfg(all(not(target_os = "macos"), not(target_os = "ios")))]
    {
        let exe = std::env::current_exe()
            .map_err(|_| "Failed to locate executable".to_string())?;
        let mut cmd = std::process::Command::new(exe);
        if let Some(ref p) = path {
            cmd.arg(p);
        }
        cmd.spawn()
            .map_err(|_| "Failed to start new window".to_string())?;
        return Ok("spawned".to_string());
    }

    // macOS: direct build (WKWebView doesn't have the hang issue)
    #[cfg(target_os = "macos")]
    {
        let counter = WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
        let label = format!("moraya-{}", counter);

        if let Some(ref p) = path {
            pending.0.lock().unwrap().insert(label.clone(), p.clone());
        }

        let cascade_pos = app
            .webview_windows()
            .values()
            .find_map(|w| w.outer_position().ok())
            .map(|pos| (pos.x as f64 + 30.0, pos.y as f64 + 30.0));

        let mut builder = tauri::WebviewWindowBuilder::new(
            app,
            &label,
            tauri::WebviewUrl::default(),
        )
        .title(&title)
        .inner_size(1200.0, 800.0)
        .min_inner_size(600.0, 400.0)
        .decorations(true);

        if let Some((x, y)) = cascade_pos {
            builder = builder.position(x, y);
        } else {
            builder = builder.center();
        }

        use tauri::TitleBarStyle;
        builder = builder.title_bar_style(TitleBarStyle::Overlay);

        let window = builder
            .build()
            .map_err(|e| format!("Failed to create window: {}", e))?;
        let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
        let _ = window.set_focus();
        return Ok(label);
    }

    // iOS: not supported
    #[cfg(target_os = "ios")]
    {
        let _ = (app, pending, path, title);
        return Err("Multi-window is not supported on iPad".to_string());
    }
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

/// Return bounding rects of all Moraya windows (for cross-window drag detection).
/// Each entry: (label, x, y, width, height, client_y_offset) in logical (CSS) pixels.
/// client_y_offset is the vertical distance from the outer top to the client area top
/// (equals the native title bar height on Windows/Linux; 0 on macOS overlay).
#[tauri::command]
fn get_all_window_bounds(app: tauri::AppHandle) -> Vec<(String, f64, f64, f64, f64, f64)> {
    app.webview_windows()
        .iter()
        .filter(|(_, w)| w.is_visible().unwrap_or(false))
        .filter_map(|(label, w)| {
            let pos = w.outer_position().ok()?;
            let size = w.outer_size().ok()?;
            // Convert physical pixels to logical (CSS) pixels to match PointerEvent.screenX/Y
            let scale = w.scale_factor().ok().unwrap_or(1.0);
            // Client area offset: distance from outer top to inner content top (title bar height)
            let inner_pos = w.inner_position().ok()?;
            let client_y_offset = (inner_pos.y - pos.y) as f64 / scale;
            Some((
                label.clone(),
                pos.x as f64 / scale,
                pos.y as f64 / scale,
                size.width as f64 / scale,
                size.height as f64 / scale,
                client_y_offset.max(0.0), // ensure non-negative
            ))
        })
        .collect()
}

/// Create a new window at a specific position with pending tab data (for tab detach).
#[tauri::command]
fn detach_tab_to_window(
    app: tauri::AppHandle,
    pending_tab: tauri::State<'_, PendingTabData>,
    tab_data: TabTransferData,
    x: f64,
    y: f64,
) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        let _ = (&app, &pending_tab, &tab_data, x, y);
        return Err("Multi-window is not supported on iPad".to_string());
    }

    // Windows/Linux: save content to temp file and spawn a new process.
    #[cfg(all(not(target_os = "macos"), not(target_os = "ios")))]
    {
        let temp_dir = std::env::temp_dir();
        // The spawned process re-detects the document flavor from the file
        // extension, so the scratch file must carry the ORIGINAL flavor's
        // extension — writing a Typst document to `.md` would reopen it in the
        // markdown editor and lose the compiled preview.
        let ext = detach_temp_extension(tab_data.flavor.as_deref());
        let temp_name = format!(
            "moraya-detach-{}.{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            ext
        );
        let temp_path = temp_dir.join(&temp_name);
        std::fs::write(&temp_path, &tab_data.content)
            .map_err(|_| "Failed to save tab content".to_string())?;

        let exe = std::env::current_exe()
            .map_err(|_| "Failed to locate executable".to_string())?;
        std::process::Command::new(exe)
            .arg(temp_path.to_string_lossy().as_ref())
            .spawn()
            .map_err(|_| "Failed to start new window".to_string())?;
        return Ok("spawned".to_string());
    }

    // macOS: direct build
    #[cfg(target_os = "macos")]
    {
        let counter = WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
        let label = format!("moraya-{}", counter);

        let title = if tab_data.file_name.is_empty() {
            "Moraya".to_string()
        } else {
            tab_data.file_name.clone()
        };

        pending_tab.0.lock().unwrap().insert(label.clone(), tab_data);

        let mut builder = tauri::WebviewWindowBuilder::new(
            &app,
            &label,
            tauri::WebviewUrl::default(),
        )
        .title(&title)
        .inner_size(1200.0, 800.0)
        .min_inner_size(600.0, 400.0)
        .decorations(true)
        .position(x, y);

        use tauri::TitleBarStyle;
        builder = builder.title_bar_style(TitleBarStyle::Overlay);

        let window = builder
            .build()
            .map_err(|e| format!("Failed to create window: {}", e))?;

        let _ = window.set_position(tauri::LogicalPosition::new(x, y));
        let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
        Ok(label)
    }
}

/// Retrieve pending tab data for a newly created window (called on mount, mirrors get_opened_files).
#[tauri::command]
fn get_pending_tab(
    window: tauri::Window,
    pending_tab: tauri::State<'_, PendingTabData>,
) -> Option<TabTransferData> {
    let label = window.label();
    pending_tab.0.lock().unwrap().remove(label)
}

/// Set a window's visual opacity (0.0 = invisible, 1.0 = fully opaque).
/// Used to hide the active window during single-tab drag without moving it off-screen
/// (macOS constrains active window positions, preventing full off-screen placement).
#[tauri::command]
fn set_window_alpha(app: tauri::AppHandle, label: String, alpha: f64) -> Result<(), String> {
    let win = app.get_webview_window(&label).ok_or("Window not found")?;
    let alpha_val = alpha.clamp(0.0, 1.0);

    #[cfg(target_os = "macos")]
    {
        use objc::{msg_send, sel, sel_impl};
        // SAFETY: ns_window() returns a valid NSWindow pointer on macOS.
        // setAlphaValue: accepts CGFloat (f64 on 64-bit macOS). Value is clamped to [0,1].
        let ns_window = win.ns_window().map_err(|e| e.to_string())?;
        unsafe {
            let _: () = msg_send![ns_window as *mut objc::runtime::Object, setAlphaValue: alpha_val];
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        // Windows/Linux: move off-screen to "hide", restore saved position to "show".
        let mut guard = match SAVED_WINDOW_POSITIONS.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        let map = guard.get_or_insert_with(HashMap::new);

        if alpha_val <= 0.0 {
            // Save current position before moving off-screen
            if let Ok(pos) = win.outer_position() {
                let scale = win.scale_factor().unwrap_or(1.0);
                map.insert(label.clone(), (pos.x as f64 / scale, pos.y as f64 / scale));
            }
            let _ = win.set_position(tauri::LogicalPosition::new(-99999.0, -99999.0));
        } else if let Some((x, y)) = map.remove(&label) {
            // Restore to saved position
            let _ = win.set_position(tauri::LogicalPosition::new(x, y));
        }
    }

    Ok(())
}

/// Move a window to a specific logical position (used for dragging detached tab windows).
#[tauri::command]
fn move_window(app: tauri::AppHandle, label: String, x: f64, y: f64) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Close a window by label (used for closing detached windows on re-attach).
#[tauri::command]
fn close_window_by_label(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Show or hide a window by label (used for hiding detached tab window when hovering over target).
#[tauri::command]
fn set_window_visible(app: tauri::AppHandle, label: String, visible: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        if visible {
            win.show().map_err(|e| e.to_string())?;
        } else {
            win.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Register or update the document displayed in a window (for macOS Dock menu).
/// Called from frontend whenever the file path or document name changes.
#[cfg(target_os = "macos")]
#[tauri::command]
fn register_dock_document(
    window: tauri::Window,
    tracker: tauri::State<'_, DockDocumentTracker>,
    app: tauri::AppHandle,
    display_name: String,
    file_path: Option<String>,
) {
    let label = window.label().to_string();
    // Only rebuild the dock menu when the entry actually changed.
    // This prevents redundant NSMenu rebuilds (~20 ObjC calls each).
    let changed = {
        let mut map = tracker.0.lock().unwrap();
        let needs_update = match map.get(&label) {
            Some(entry) => entry.display_name != display_name || entry.file_path != file_path,
            None => true,
        };
        if needs_update {
            map.insert(label, DockDocEntry { display_name, file_path });
        }
        needs_update
    };
    if changed {
        dock::refresh_dock_menu(&app);
    }
}

/// No-op on non-macOS platforms — the command must exist so frontend invoke doesn't fail.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn register_dock_document(_display_name: String, _file_path: Option<String>) {}

/// Parse a `moraya://import-image-host?...` URL into a JSON payload understood
/// by the frontend `picora-import-request` listener. Returns `None` for any
/// scheme/host combination we don't recognise so we never accidentally surface
/// untrusted data.
fn parse_picora_deeplink(raw: &str) -> Option<serde_json::Value> {
    let parsed = url::Url::parse(raw).ok()?;
    if parsed.scheme() != "moraya" {
        return None;
    }
    if parsed.host_str() != Some("import-image-host") {
        return None;
    }
    let mut version: Option<String> = None;
    let mut ott: Option<String> = None;
    let mut key: Option<String> = None;
    let mut name: Option<String> = None;
    let mut api_base: Option<String> = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "v" => version = Some(v.into_owned()),
            "ott" => ott = Some(v.into_owned()),
            "key" => key = Some(v.into_owned()),
            "name" => name = Some(v.into_owned()),
            "apiBase" | "api_base" => api_base = Some(v.into_owned()),
            _ => {}
        }
    }
    let mut payload = serde_json::Map::new();
    if let Some(v) = version { payload.insert("version".to_string(), serde_json::Value::String(v)); }
    if let Some(o) = ott { payload.insert("ott".to_string(), serde_json::Value::String(o)); }
    if let Some(k) = key { payload.insert("key".to_string(), serde_json::Value::String(k)); }
    if let Some(n) = name { payload.insert("name".to_string(), serde_json::Value::String(n)); }
    if let Some(b) = api_base { payload.insert("apiBase".to_string(), serde_json::Value::String(b)); }
    if payload.is_empty() {
        return None;
    }
    Some(serde_json::Value::Object(payload))
}

/// Returns true if this path was dispatched within the dedup window.
/// On macOS, both the deep-link plugin's `on_open_url` and Tauri's
/// `RunEvent::Opened` can fire for the same apple-event; without this guard
/// the file would be opened twice (cold start) or two windows would be
/// created (warm start).
fn is_duplicate_open(app: &tauri::AppHandle, path: &str) -> bool {
    let recent = match app.try_state::<RecentOpens>() {
        Some(s) => s,
        None => return false,
    };
    let mut map = match recent.0.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let now = std::time::Instant::now();
    let window = std::time::Duration::from_millis(1500);
    // Clean stale entries to bound memory.
    map.retain(|_, t| now.duration_since(*t) < window);
    if let Some(prev) = map.get(path) {
        if now.duration_since(*prev) < window {
            return true;
        }
    }
    map.insert(path.to_string(), now);
    false
}

/// Route a URL handed to us by the deep-link plugin. Custom-scheme URLs go
/// to the Picora deep-link handler; `file://` URLs are intentionally a
/// no-op at runtime — see the comment inside.
fn dispatch_open_url(app: &tauri::AppHandle, url: &url::Url) {
    if url.scheme() == "file" {
        // On macOS, a Finder double-click delivers ONE apple-event but TWO
        // callbacks fire from it: the deep-link plugin's `on_open_url`
        // (this path) AND Tauri's `RunEvent::Opened` (the runtime branch
        // further below). Both originally tried to call
        // `create_editor_window` and we deduped via `is_duplicate_open`.
        //
        // That hangs the app on the SECOND double-click (warm start):
        //   1. `on_open_url` fires first, calls `WebviewWindowBuilder::build()`
        //   2. `build()` re-enters NSApp's run loop to drive window init
        //   3. The still-queued `RunEvent::Opened` dispatches mid-build and
        //      tries to call `build()` again on the same main thread
        //   4. The mutex inside `is_duplicate_open` is read after the
        //      re-entry, so the dedup can't fire in time — the second
        //      build is launched nested inside the first, and the main
        //      thread deadlocks waiting on itself.
        //
        // Fix: warm-start window creation goes exclusively through
        // `RunEvent::Opened` (the runtime callback runs on the main thread
        // without the re-entrancy hazard — v0.39.0 behavior). Cold-start
        // buffering stays here because it does no UI work (just a Mutex
        // push that `get_opened_files` drains later), so it's safe from
        // any thread the deep-link plugin invokes us on.
        //
        // On Windows/Linux the deep-link plugin only fires `on_open_url`
        // for custom schemes (`moraya://`); file-association argv is
        // handled by tauri-plugin-single-instance, so this branch is
        // unreachable for `file://` there.
        if let Ok(path_buf) = url.to_file_path() {
            let path = path_buf.to_string_lossy().into_owned();
            let main_ready = app
                .try_state::<MainWindowReady>()
                .map(|s| s.0.load(Ordering::SeqCst))
                .unwrap_or(false);
            if !main_ready {
                if is_duplicate_open(app, &path) {
                    return;
                }
                if let Some(opened) = app.try_state::<OpenedFiles>() {
                    if let Ok(mut files) = opened.0.lock() {
                        files.push(path.clone());
                    }
                }
                let _ = app.emit("open-file", &path);
            }
            // Warm-start: intentionally do nothing — `RunEvent::Opened`
            // will handle window creation on the main thread.
        }
        return;
    }
    handle_picora_deeplink(app, url.as_str());
}

/// Dispatch a deep-link URL: parse it, then either emit `picora-import-request`
/// to the main window (if the frontend is ready) or buffer it for later pickup.
fn handle_picora_deeplink(app: &tauri::AppHandle, raw_url: &str) {
    let Some(payload) = parse_picora_deeplink(raw_url) else { return; };

    let main_ready = app
        .try_state::<MainWindowReady>()
        .map(|s| s.0.load(Ordering::SeqCst))
        .unwrap_or(false);

    if main_ready {
        let _ = app.emit("picora-import-request", payload.clone());
    }

    if let Some(pending) = app.try_state::<PendingPicoraImport>() {
        if let Ok(mut guard) = pending.0.lock() {
            *guard = Some(payload);
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Frontend pulls any deep-link payload buffered before it was ready.
#[tauri::command]
fn take_pending_picora_import(
    state: tauri::State<'_, PendingPicoraImport>,
) -> Option<serde_json::Value> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

#[cfg(test)]
mod detach_tests {
    use super::detach_temp_extension;

    #[test]
    fn typst_tabs_detach_as_typ() {
        // A `.md` scratch file would make the spawned window reopen the
        // document in the markdown editor, losing the compiled preview.
        assert_eq!(detach_temp_extension(Some("typst")), "typ");
    }

    #[test]
    fn markdown_and_unknown_flavors_detach_as_md() {
        assert_eq!(detach_temp_extension(Some("markdown")), "md");
        // Payloads predating the `flavor` field carry None.
        assert_eq!(detach_temp_extension(None), "md");
        assert_eq!(detach_temp_extension(Some("something-else")), "md");
    }
}

#[cfg(test)]
mod deeplink_tests {
    use super::parse_picora_deeplink;

    #[test]
    fn rejects_unrelated_schemes() {
        assert!(parse_picora_deeplink("file:///tmp/foo.md").is_none());
        assert!(parse_picora_deeplink("https://example.com").is_none());
        assert!(parse_picora_deeplink("moraya://other-host?key=x").is_none());
    }

    #[test]
    fn parses_v1_key_payload() {
        let v = parse_picora_deeplink("moraya://import-image-host?key=sk_live_abc&name=My&v=1")
            .expect("should parse");
        assert_eq!(v["key"], "sk_live_abc");
        assert_eq!(v["name"], "My");
        assert_eq!(v["version"], "1");
    }

    #[test]
    fn parses_v2_ott_payload() {
        let v = parse_picora_deeplink("moraya://import-image-host?ott=ott_xyz&v=2")
            .expect("should parse");
        assert_eq!(v["ott"], "ott_xyz");
        assert_eq!(v["version"], "2");
        assert!(v.get("key").is_none());
    }

    #[test]
    fn rejects_empty_query() {
        assert!(parse_picora_deeplink("moraya://import-image-host").is_none());
        assert!(parse_picora_deeplink("moraya://import-image-host?").is_none());
    }

    #[test]
    fn ignores_unknown_query_keys() {
        let v = parse_picora_deeplink("moraya://import-image-host?key=k&surprise=evil")
            .expect("should parse");
        assert_eq!(v["key"], "k");
        assert!(v.get("surprise").is_none());
    }
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

/// Re-export of [`commands::pdf_export::child_mode::detect_child_mode`] so
/// `main.rs` can route argv before `tauri::Builder` starts. Returns the
/// config-file path when `--print-pdf-config=<path>` is present in argv.
pub fn detect_print_child_arg<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    commands::pdf_export::child_mode::detect_child_mode(args)
}

/// Subprocess child-mode entry for the PDF export pipeline (Windows/Linux).
///
/// This runs in a child process spawned by [`commands::pdf_export::subprocess::run`].
/// Its job is to load the `/print` route in a hidden WebView, wait for the
/// frontend's `export_print_ready` handshake, call the platform-native
/// printToPdf API, write the bytes to `output_path`, and exit.
///
/// v0.60.0 shipped the macOS direct path fully wired and a stub here.
/// v0.60.1 adds:
///   - up-front config validation (typed `JobConfig` returned)
///   - platform dispatch to `run_print_child_windows` / `run_print_child_linux`
///   - structured Fallback messaging that names the missing implementation
/// The WebView2 `PrintToPdfStreamAsync` and WebKitGTK `print_to_stream` bindings
/// themselves still need to land — they require hands-on testing on Win/Linux
/// machines. Until they do, this function exits 1 with a `Fallback` event so
/// the frontend orchestrator automatically switches to the canvas path.
pub fn run_print_child(cfg_path: &str) {
    use commands::pdf_export::child_mode;
    use commands::pdf_export::ProgressEvent;

    let job = match child_mode::load_config(cfg_path) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("print-child: load_config failed: {e}");
            child_mode::emit_progress(&ProgressEvent::Error { message: e });
            std::process::exit(2);
        }
    };

    #[cfg(target_os = "windows")]
    let result = run_print_child_windows(&job);

    #[cfg(target_os = "linux")]
    let result = run_print_child_linux(&job);

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let result: Result<(), String> = {
        let _ = &job; // suppress unused warning on macOS/iOS
        Err("subprocess child mode is only spawned on Windows/Linux".to_string())
    };

    if let Err(reason) = result {
        child_mode::emit_progress(&ProgressEvent::Fallback { reason });
        std::process::exit(1);
    }
    std::process::exit(0);
}

/// Windows native print-to-PDF child entry (stub for v0.60.1).
///
/// Will host a minimal Tauri instance with one hidden window loading `/print`,
/// wait for `export_print_ready`, then call
/// `CoreWebView2.PrintToPdfStreamAsync` (via `webview2-com`) with paper /
/// margin / orientation derived from `job.options`, write the bytes to
/// `job.output_path`, emit `ProgressEvent::Done`, and exit.
///
/// Currently returns Err so the parent transparently falls back to canvas;
/// see `docs/iterations/v0.60.1-pc-win-linux-native-pdf.md` Phase 2 for the
/// full implementation plan.
#[cfg(target_os = "windows")]
fn run_print_child_windows(job: &commands::pdf_export::JobConfig) -> Result<(), String> {
    let _ = job;
    Err("Windows native PrintToPdfStreamAsync binding pending v0.60.1 Phase 2".to_string())
}

/// Linux native print-to-PDF child entry (stub for v0.60.1).
///
/// Will host a minimal Tauri instance with one hidden WebKitGTK WebView
/// loading `/print`, wait for `export_print_ready`, then call
/// `WebKitPrintOperation::print_to_stream` (via `webkit2gtk`) with the right
/// `PrintSettings` / `PageSetup`, drain the `MemoryOutputStream` into a
/// `Vec<u8>`, write to `job.output_path`, emit `ProgressEvent::Done`, exit.
///
/// Currently returns Err so the parent transparently falls back to canvas;
/// see `docs/iterations/v0.60.1-pc-win-linux-native-pdf.md` Phase 3 for the
/// full implementation plan.
#[cfg(target_os = "linux")]
fn run_print_child_linux(job: &commands::pdf_export::JobConfig) -> Result<(), String> {
    let _ = job;
    Err("Linux native WebKitGTK print_to_stream binding pending v0.60.1 Phase 3".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Fix PATH for macOS GUI apps (Dock/Finder don't inherit shell PATH)
    #[cfg(not(target_os = "ios"))]
    let _ = fix_path_env::fix();

    // WebKit2GTK 4.1 + Wayland mitigations (Linux only).
    //
    // Symptom (issue #59): SIGABRT inside libjavascriptcoregtk-4.1.so.0
    // when any menu item is clicked on NixOS unstable + Wayland + KDE
    // Plasma 6. Affects WebKit2GTK 4.1 across multiple recent distros —
    // not specific to Moraya.
    //
    // Root cause: WebKit2GTK's DMABUF renderer fails to share GPU buffers
    // with certain Wayland compositors (KDE Plasma 6, newer Mutter,
    // recent Mesa with NVIDIA/Intel mixed setups). When rendering aborts
    // mid-frame, JavaScriptCore — which runs on the same thread — sees
    // a corrupted GL/EGL state on its next dispatch and abort()s.
    //
    // Mitigation: force shared-memory (SHM) rendering. Measurably slower
    // than DMABUF but stable everywhere. Standard recommendation from
    // both the Tauri Linux guide and WebKit2GTK upstream
    // (https://blogs.gnome.org/mcatanzaro/2023/09/11/webkitgtk-on-wayland/).
    //
    // Only set when unset so power users can still opt back into DMABUF
    // (or use WEBKIT_DISABLE_COMPOSITING_MODE=1 if they hit a different bug).
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    // Collect file paths from CLI args (Windows file association)
    let initial_files = file_paths_from_args();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second instance was launched. Two carriers to forward:
            //   1. moraya:// deep-link URL → Picora handler
            //   2. file path (Windows/Linux file association) → file-open path
            for arg in args.iter().skip(1) {
                if arg.starts_with("moraya://") {
                    handle_picora_deeplink(app, arg);
                } else if !arg.starts_with('-') {
                    let p = std::path::Path::new(arg);
                    if p.is_file() {
                        let path = arg.clone();
                        let main_ready = app
                            .try_state::<MainWindowReady>()
                            .map(|s| s.0.load(Ordering::SeqCst))
                            .unwrap_or(false);
                        if main_ready {
                            // Existing window picks it up via the event.
                            let _ = app.emit("open-file", &path);
                        } else {
                            if let Some(opened) = app.try_state::<OpenedFiles>() {
                                if let Ok(mut files) = opened.0.lock() {
                                    files.push(path.clone());
                                }
                            }
                            let _ = app.emit("open-file", &path);
                        }
                    }
                }
            }
            // Always raise the main window — that's the user expectation when
            // they launch the app a second time.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
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
        .manage(commands::mcp_lan_bridge::LanBridge::new())
        .manage(commands::ai_proxy::AIProxyState::new())
        .manage(commands::kb::KBIndexState::new())
        .manage(commands::speech_proxy::SpeechProxyState::new())
        .manage(commands::speech_proxy::RtDialogueState::new())
        .manage(commands::plugin_manager::PluginProcessManager::new())
        .manage(commands::pdf_export::PdfExportState::new())
        .manage(OpenedFiles(Mutex::new(initial_files)))
        .manage(PendingFiles(Mutex::new(HashMap::new())))
        .manage(PendingTabData(Mutex::new(HashMap::new())))
        .manage(MainWindowReady(AtomicBool::new(false)))
        .manage(PendingPicoraImport(Mutex::new(None)))
        .manage(RecentOpens(Mutex::new(HashMap::new())))
        .manage(DockDocumentTracker(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            commands::file::read_file,
            commands::claude_transcripts::list_claude_transcripts,
            commands::claude_transcripts::read_claude_transcript,
            commands::file::read_file_binary,
            commands::file::read_resource_file,
            commands::file::write_file,
            commands::file::write_file_binary,
            commands::file::write_file_bytes,
            commands::pdf_export::export_pdf_native,
            commands::pdf_export::export_print_ready,
            commands::typst_engine::typst_engine_status,
            commands::typst_engine::typst_ensure_engine,
            commands::typst_engine::typst_export_markdown_pdf,
            commands::typst_engine::typst_compile_source,
            commands::file::read_dir_recursive,
            commands::file::list_hidden_dirs,
            commands::file::migrate_voice_profiles_dir,
            commands::file::create_markdown_file,
            commands::file::create_dir,
            commands::file::rename_file,
            commands::file::delete_file,
            commands::file::read_file_previews,
            commands::file::get_files_mtime,
            commands::mcp::mcp_connect_stdio,
            commands::mcp::mcp_send_request,
            commands::mcp::mcp_send_notification,
            commands::mcp::mcp_disconnect,
            commands::mcp::check_command_exists,
            commands::mcp_lan_bridge::mcp_lan_expose,
            commands::mcp_lan_bridge::mcp_lan_unexpose,
            commands::mcp_lan_bridge::mcp_lan_status,
            commands::keychain::keychain_set,
            commands::keychain::keychain_get,
            commands::keychain::keychain_delete,
            commands::ai_proxy::ai_proxy_fetch,
            commands::ai_proxy::ai_proxy_stream,
            commands::ai_proxy::ai_proxy_abort,
            commands::dmg_cleanup::find_stale_moraya_mounts,
            commands::dmg_cleanup::eject_dmg_mount,
            commands::kb::kb_index_files,
            commands::kb::kb_index_single_file,
            commands::kb::kb_search,
            commands::kb::kb_get_index_status,
            commands::kb::kb_delete_index,
            commands::kb::kb_list_local_models,
            commands::kb::kb_download_model,
            commands::kb::kb_delete_model,
            commands::kb::kb_download_ort_runtime,
            commands::kb::kb_check_ort_available,
            commands::kb::kb_embed_local,
            commands::kb::kb_suggest_filename,
            commands::update::get_platform_info,
            commands::update::exit_app,
            commands::update::download_update,
            commands::object_storage::upload_to_object_storage,
            commands::image_hosting_picora::upload_to_picora,
            commands::image_hosting_picora::verify_picora_token,
            commands::image_hosting_picora::test_picora_connection,
            commands::image_hosting_picora::exchange_picora_export_token,
            take_pending_picora_import,
            commands::speech_proxy::speech_proxy_start,
            commands::speech_proxy::speech_proxy_send_audio,
            commands::speech_proxy::speech_proxy_stop,
            commands::speech_proxy::rt_dialogue_start,
            commands::speech_proxy::rt_dialogue_send_text,
            commands::speech_proxy::rt_dialogue_send_audio,
            commands::speech_proxy::rt_dialogue_stop,
            commands::plugin_manager::plugin_validate_manifest,
            commands::plugin_manager::plugin_install_local,
            commands::plugin_manager::plugin_install_from_url,
            commands::plugin_manager::plugin_enable,
            commands::plugin_manager::plugin_disable,
            commands::plugin_manager::plugin_uninstall,
            commands::plugin_manager::plugin_list_running,
            commands::plugin_manager::plugin_invoke,
            commands::plugin_manager::plugin_registry_fetch,
            commands::plugin_manager::plugin_fetch_blacklist,
            commands::plugin_manager::plugin_fetch_github_asset,
            commands::plugin_manager::download_renderer_plugin,
            commands::plugin_manager::delete_renderer_plugin,
            commands::git::git_check_installed,
            commands::git::git_clone,
            commands::git::git_init_and_push,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_status,
            commands::git::git_log,
            commands::git::git_diff,
            commands::git::git_add_commit,
            commands::git::git_get_user_info,
            commands::git::git_sync_status,
            commands::git::git_head_commit,
            commands::git::git_show_file,
            commands::git::git_blame,
            commands::git::git_in_merge,
            commands::kb_sync::picora_kb_list,
            commands::kb_sync::picora_kb_create,
            commands::kb_sync::picora_kb_manifest,
            commands::kb_sync::picora_kb_sync_batch,
            commands::kb_sync::picora_kb_raw,
            commands::kb_sync::kb_sync_scan_dir,
            commands::kb_sync::kb_sync_move_to_trash,
            commands::kb_sync::kb_sync_list_trash,
            commands::kb_sync::kb_sync_restore_from_trash,
            commands::kb_sync::kb_sync_purge_trash,
            commands::picora_media::picora_media_list,
            commands::picora_media::picora_media_detail,
            commands::picora_media::picora_video_status,
            commands::picora_media::picora_media_update_visibility,
            commands::picora_media::picora_server_caps,
            commands::picora_account::picora_get_quota,
            commands::picora_account::picora_media_delete,
            commands::picora_doc_revisions::picora_doc_revisions,
            commands::picora_doc_revisions::picora_doc_revision_content,
            commands::picora_doc_revisions::picora_clear_doc_revisions,
            commands::picora_doc_revisions::picora_update_user_settings,
            commands::picora_oauth::picora_oauth_start_device_flow,
            commands::picora_oauth::picora_oauth_poll,
            commands::picora_oauth::picora_oauth_get_token,
            commands::picora_oauth::picora_oauth_has_session,
            commands::picora_oauth::picora_oauth_logout,
            set_editor_mode_menu,
            update_menu_labels,
            set_menu_check,
            update_mcp_menu,
            commands::menu_accel::set_menu_accelerator,
            commands::menu_accel::set_menu_accelerators_batch,
            get_opened_files,
            open_file_in_new_window,
            create_new_window,
            get_all_window_bounds,
            detach_tab_to_window,
            get_pending_tab,
            move_window,
            set_window_alpha,
            close_window_by_label,
            set_window_visible,
            register_dock_document,
        ])
        .setup(|app| {
            // Pre-warm OS keychain in background during app setup.
            // Windows Credential Manager can take 500ms–2s on cold start;
            // starting early means secrets are cached by the time the frontend
            // calls keychain_get, eliminating the visible startup delay.
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<commands::ai_proxy::AIProxyState>();
                    state.ensure_secrets_loaded().await;
                });
            }

            // Wire moraya:// deep-link delivery. Three entry points:
            //   1. Cold start via OS scheme association → on_open_url callback
            //   2. Cold start via CLI argv (Linux) → handled via single_instance plugin
            //   3. Runtime open from another app → on_open_url callback
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        dispatch_open_url(&app_handle, &url);
                    }
                });
                // Also drain any URL the OS handed us at startup (macOS/Windows path).
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        dispatch_open_url(app.handle(), &url);
                    }
                }
            }

            let window = app.get_webview_window("main").unwrap();

            // Desktop: decorations: true + titleBarStyle: Overlay are set in
            // tauri.conf.json. The runtime call below is a fallback in case
            // the config field is not applied (e.g. older CLI version on CI).
            // Because decorations starts as true, this is at most a one-step
            // transition (standard → overlay), avoiding the old three-step
            // toggle (false → true → overlay) that broke WKWebView layout.
            #[cfg(not(target_os = "ios"))]
            {
                #[cfg(target_os = "macos")]
                {
                    use tauri::TitleBarStyle;
                    let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
                }

                // Windows/Linux: shrink window to fit screen (taskbar/decorations)
                #[cfg(all(not(target_os = "macos"), not(target_os = "ios")))]
                fit_window_to_screen(&window);

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

                // Handle menu events — emit only to the focused window.
                // Using app.emit() would broadcast to ALL windows, causing duplicate
                // actions (e.g., "New Window" creating N windows instead of 1).
                let app_handle_for_events = app.handle().clone();
                app.on_menu_event(move |_app, event| {
                    // Skip spurious events fired by set_checked() during
                    // programmatic checkmark updates (update_mode_checks / set_check_item).
                    if menu::is_updating_mode_checks() {
                        return;
                    }

                    let id = event.id().0.as_str();
                    let event_name = format!("menu:{}", id);

                    // Find target window: prefer focused, fall back to first visible
                    // non-pool window. NEVER broadcast to all windows — that causes
                    // duplicate actions (e.g., "New Window" creating N windows).
                    let windows = app_handle_for_events.webview_windows();
                    let target_label = windows
                        .iter()
                        .find(|(_, w)| w.is_focused().unwrap_or(false))
                        .or_else(|| {
                            windows.iter().find(|(l, w)| {
                                !l.starts_with("moraya-pool-")
                                    && w.is_visible().unwrap_or(false)
                            })
                        })
                        .map(|(label, _)| label.clone());

                    let Some(label) = target_label else {
                        return;
                    };

                    // For CheckMenuItem items, emit the current check state as
                    // payload so the frontend can SET (not toggle) the value.
                    match id {
                        "view_mode_visual" | "view_mode_source" | "view_mode_split"
                        | "view_sidebar" | "view_ai_panel" | "view_outline" => {
                            if let Some(checked) = menu::get_check_state(&app_handle_for_events, id) {
                                let _ = app_handle_for_events.emit_to(&label, &event_name, checked);
                            }
                        }
                        // Dynamic MCP tool items: emit dedicated event with tool ID as payload
                        _ if id.starts_with("wf_mcp_") && id != "wf_mcp_empty" => {
                            let _ = app_handle_for_events.emit_to(&label, "mcp-tool-clicked", id.to_string());
                        }
                        _ => {
                            let _ = app_handle_for_events.emit_to(&label, &event_name, ());
                        }
                    }
                });
            }

            // Window starts hidden (visible:false in tauri.conf.json) to avoid
            // a position flash on Windows/Linux where fit_window_to_screen may
            // reposition/resize the window. Show it now that setup is complete.
            let _ = window.show();
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

            // macOS Dock menu: track focused window + clean up on destroy
            #[cfg(target_os = "macos")]
            {
                if let tauri::RunEvent::WindowEvent { label, event, .. } = &_event {
                    match event {
                        tauri::WindowEvent::Focused(true) => {
                            // Only rebuild dock menu when the focused window actually
                            // changes. Skips redundant rebuilds when the same window
                            // regains focus (e.g., user switches back from another app).
                            let changed = {
                                let mut focused = match FOCUSED_WINDOW_LABEL.lock() {
                                    Ok(g) => g,
                                    Err(e) => e.into_inner(),
                                };
                                if focused.as_deref() == Some(label.as_str()) {
                                    false
                                } else {
                                    *focused = Some(label.clone());
                                    true
                                }
                            };
                            if changed {
                                dock::refresh_dock_menu(_app);
                            }
                        }
                        tauri::WindowEvent::Destroyed => {
                            if let Some(tracker) = _app.try_state::<DockDocumentTracker>() {
                                if let Ok(mut map) = tracker.0.lock() {
                                    map.remove(label);
                                }
                            }
                            if let Ok(mut focused) = FOCUSED_WINDOW_LABEL.lock() {
                                if focused.as_deref() == Some(label.as_str()) {
                                    *focused = None;
                                }
                            }
                            dock::refresh_dock_menu(_app);
                        }
                        _ => {}
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
                                    if is_duplicate_open(_app, &path) {
                                        continue;
                                    }

                                    if !main_ready {
                                        // Cold start: store file for the main window to pick up
                                        // via get_opened_files(). Also emit open-file in case the
                                        // frontend has already called get_opened_files.
                                        if let Some(opened) = _app.try_state::<OpenedFiles>() {
                                            opened.0.lock().unwrap().push(path.clone());
                                        }
                                        let _ = _app.emit("open-file", &path);
                                    } else {
                                        // Runtime: create a new window for the file.
                                        // Also emit open-file to all windows so an existing
                                        // window can pick it up if window creation fails.
                                        if let Some(pending) = _app.try_state::<PendingFiles>() {
                                            if create_editor_window(_app, &pending, Some(path.clone())).is_err() {
                                                let _ = _app.emit("open-file", &path);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    // Handle Dock icon click when no windows are visible → create new window.
                    // Guard: macOS may report `has_visible_windows = false` when a
                    // `visible(false)` print-job window is destroyed (PDF export cleanup).
                    // In that case the main editor window is still open — check directly.
                    tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                        let any_editor_open = _app
                            .webview_windows()
                            .keys()
                            .any(|lbl| !lbl.starts_with("moraya-print-"));
                        if !has_visible_windows && !any_editor_open {
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

use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Set up the macOS Dock right-click menu and register ObjC helper class.
/// Called once at app startup. The menu is rebuilt dynamically via `refresh_dock_menu()`.
pub fn setup_dock_menu(app: &AppHandle) {
    APP_HANDLE.set(app.clone()).ok();

    // SAFETY: All Objective-C runtime calls below interact with AppKit classes
    // (NSObject, NSMenu, NSMenuItem, NSString, NSApplication) which are valid
    // after application launch. Each msg_send! return is checked for nil where
    // it returns an id type.
    unsafe {
        use objc::declare::ClassDecl;
        use objc::runtime::{Object, Sel};
        use objc::{class, msg_send, sel, sel_impl};

        // Declare a helper ObjC class to receive menu item actions
        let superclass = class!(NSObject);
        if let Some(mut decl) = ClassDecl::new("MorayaDockHelper", superclass) {
            // "New Window" action
            extern "C" fn new_window_action(
                _this: &Object,
                _cmd: Sel,
                _sender: *mut Object,
            ) {
                if let Some(app) = APP_HANDLE.get() {
                    if let Some(pending) = app.try_state::<crate::PendingFiles>() {
                        let _ = crate::create_editor_window(app, &pending, None);
                    }
                }
            }

            // "Focus Window" action — reads the window label from representedObject
            extern "C" fn focus_window_action(
                _this: &Object,
                _cmd: Sel,
                sender: *mut Object,
            ) {
                if sender.is_null() {
                    return;
                }
                // SAFETY: representedObject returns an autoreleased id (NSString in our case)
                let repr: *mut Object = unsafe { msg_send![sender, representedObject] };
                if repr.is_null() {
                    return;
                }
                // SAFETY: UTF8String returns a C string pointer from an NSString
                let cstr: *const i8 = unsafe { msg_send![repr, UTF8String] };
                if cstr.is_null() {
                    return;
                }
                // SAFETY: the C string is valid for the duration of the autoreleased NSString
                let label = unsafe { std::ffi::CStr::from_ptr(cstr) }
                    .to_string_lossy()
                    .to_string();

                if let Some(app) = APP_HANDLE.get() {
                    if let Some(window) = app.get_webview_window(&label) {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }

            decl.add_method(
                sel!(newWindowAction:),
                new_window_action as extern "C" fn(&Object, Sel, *mut Object),
            );
            decl.add_method(
                sel!(focusWindowAction:),
                focus_window_action as extern "C" fn(&Object, Sel, *mut Object),
            );

            decl.register();
        }
    }

    // Build and install the initial dock menu
    refresh_dock_menu(app);
}

/// Rebuild and install the macOS Dock right-click menu.
///
/// Menu structure:
///   New Window
///   ─────────── (separator)
///   ✓ README.md       (focused window)
///     design-notes.md
///     Untitled
///
/// Thread safety: ObjC calls are dispatched to the main thread via
/// `AppHandle::run_on_main_thread()`. Reading Mutex-protected state
/// happens on the calling thread before dispatch.
pub fn refresh_dock_menu(app: &AppHandle) {
    // Read state on the current thread (Mutex-protected, any thread is fine)
    let focused = crate::FOCUSED_WINDOW_LABEL
        .lock()
        .ok()
        .and_then(|g| g.clone());

    let mut entries: Vec<(String, String, bool)> = Vec::new(); // (label, display_name, is_focused)

    if let Some(tracker) = app.try_state::<crate::DockDocumentTracker>() {
        if let Ok(map) = tracker.0.lock() {
            for (label, entry) in map.iter() {
                let is_focused = focused.as_deref() == Some(label.as_str());
                entries.push((label.clone(), entry.display_name.clone(), is_focused));
            }
        }
    }

    // Sort: focused window first, then alphabetical by display name
    entries.sort_by(|a, b| {
        b.2.cmp(&a.2)
            .then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase()))
    });

    // Dispatch ObjC menu building to the main thread
    let _ = app.run_on_main_thread(move || {
        build_and_install_menu(&entries);
    });
}

/// Build an NSMenu from the given entries and install it as the Dock menu.
/// Must be called on the main thread.
fn build_and_install_menu(entries: &[(String, String, bool)]) {
    // SAFETY: All Objective-C runtime calls below interact with AppKit classes
    // which are valid after application launch. Called on the main thread via
    // run_on_main_thread(). Each msg_send! return is checked for nil.
    unsafe {
        use objc::runtime::{Class, Object};
        use objc::{class, msg_send, sel, sel_impl};

        // Determine locale for menu item titles
        let lang = std::env::var("LANG").unwrap_or_default();
        let new_window_text = if lang.starts_with("zh") {
            "新建窗口"
        } else {
            "New Window"
        };
        let untitled_text = if lang.starts_with("zh") {
            "未命名"
        } else {
            "Untitled"
        };

        // SAFETY: NSMenu is a standard AppKit class
        let menu: *mut Object = msg_send![class!(NSMenu), new];
        if menu.is_null() {
            return;
        }

        // SAFETY: MorayaDockHelper was registered in setup_dock_menu()
        let helper_class: &Class = class!(MorayaDockHelper);
        let helper: *mut Object = msg_send![helper_class, new];
        if helper.is_null() {
            return;
        }

        // --- "New Window" item ---
        let title = nsstring(new_window_text);
        let key = nsstring("");
        if title.is_null() || key.is_null() {
            return;
        }
        let item: *mut Object = msg_send![class!(NSMenuItem), alloc];
        if item.is_null() {
            return;
        }
        // SAFETY: initWithTitle:action:keyEquivalent: is the standard NSMenuItem initializer
        let item: *mut Object = msg_send![
            item,
            initWithTitle: title
            action: sel!(newWindowAction:)
            keyEquivalent: key
        ];
        if !item.is_null() {
            // SAFETY: setTarget: retains the helper object
            let _: () = msg_send![item, setTarget: helper];
            let _: () = msg_send![menu, addItem: item];
        }

        // --- Document items (only add separator + items if there are entries) ---
        if !entries.is_empty() {
            // SAFETY: separatorItem is a class method returning an autoreleased NSMenuItem
            let sep: *mut Object = msg_send![class!(NSMenuItem), separatorItem];
            if !sep.is_null() {
                let _: () = msg_send![menu, addItem: sep];
            }

            for (label, display_name, is_focused) in entries {
                let name = if display_name.is_empty() {
                    untitled_text
                } else {
                    display_name.as_str()
                };

                let doc_title = nsstring(name);
                let doc_key = nsstring("");
                if doc_title.is_null() || doc_key.is_null() {
                    continue;
                }

                let doc_item: *mut Object = msg_send![class!(NSMenuItem), alloc];
                if doc_item.is_null() {
                    continue;
                }
                // SAFETY: standard NSMenuItem initializer
                let doc_item: *mut Object = msg_send![
                    doc_item,
                    initWithTitle: doc_title
                    action: sel!(focusWindowAction:)
                    keyEquivalent: doc_key
                ];
                if doc_item.is_null() {
                    continue;
                }

                // SAFETY: setTarget: retains the helper
                let _: () = msg_send![doc_item, setTarget: helper];

                // Store window label as represented object for the action handler
                let label_ns = nsstring(label);
                if !label_ns.is_null() {
                    // SAFETY: setRepresentedObject: retains the NSString
                    let _: () = msg_send![doc_item, setRepresentedObject: label_ns];
                }

                // Checkmark for the focused window (NSOnState = 1)
                if *is_focused {
                    let _: () = msg_send![doc_item, setState: 1_isize];
                }

                let _: () = msg_send![menu, addItem: doc_item];
            }
        }

        // Install as the application dock menu
        // SAFETY: sharedApplication returns the singleton NSApplication instance
        let ns_app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        if ns_app.is_null() {
            return;
        }
        // SAFETY: setDockMenu: is a valid NSApplication selector
        let _: () = msg_send![ns_app, setDockMenu: menu];
    }
}

/// Create an autoreleased NSString from a Rust &str.
/// Returns null on failure (e.g., embedded null bytes).
unsafe fn nsstring(s: &str) -> *mut objc::runtime::Object {
    use objc::{class, msg_send, sel, sel_impl};

    let cstr = match std::ffi::CString::new(s) {
        Ok(c) => c,
        Err(_) => return std::ptr::null_mut(),
    };
    // SAFETY: stringWithUTF8String: returns an autoreleased NSString
    msg_send![class!(NSString), stringWithUTF8String: cstr.as_ptr()]
}

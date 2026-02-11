use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Set up a native macOS Dock right-click menu with a "New Window" item.
pub fn setup_dock_menu(app: &AppHandle) {
    APP_HANDLE.set(app.clone()).ok();

    // SAFETY: All Objective-C runtime calls below interact with AppKit classes
    // (NSObject, NSMenu, NSMenuItem, NSString, NSApplication) which are valid
    // after application launch. Each msg_send! return is checked for nil where
    // it returns an id type. The helper object is retained by NSMenuItem via
    // setTarget:, so it won't be deallocated prematurely.
    unsafe {
        use objc::declare::ClassDecl;
        use objc::runtime::{Class, Object, Sel};
        use objc::{class, msg_send, sel, sel_impl};

        // Determine locale for the menu item title
        let lang = std::env::var("LANG").unwrap_or_default();
        let title_text = if lang.starts_with("zh") {
            "新建窗口"
        } else {
            "New Window"
        };

        // Declare a helper ObjC class to receive the menu item action
        let superclass = class!(NSObject);
        if let Some(mut decl) = ClassDecl::new("MorayaDockHelper", superclass) {
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

            decl.add_method(
                sel!(newWindowAction:),
                new_window_action as extern "C" fn(&Object, Sel, *mut Object),
            );

            decl.register();
        }

        // SAFETY: MorayaDockHelper class was just registered above
        let helper_class: &Class = class!(MorayaDockHelper);
        let helper: *mut Object = msg_send![helper_class, new];
        if helper.is_null() {
            return;
        }

        // SAFETY: NSMenu is a standard AppKit class, always available
        let menu: *mut Object = msg_send![class!(NSMenu), new];
        if menu.is_null() {
            return;
        }

        // SAFETY: CString::new can fail if the string contains null bytes.
        // Menu title text is a compile-time constant, so this won't fail.
        let title_cstr = match std::ffi::CString::new(title_text) {
            Ok(c) => c,
            Err(_) => return,
        };
        // SAFETY: stringWithUTF8String: returns an autoreleased NSString
        let title: *mut Object =
            msg_send![class!(NSString), stringWithUTF8String: title_cstr.as_ptr()];
        if title.is_null() {
            return;
        }

        let empty_cstr = match std::ffi::CString::new("") {
            Ok(c) => c,
            Err(_) => return,
        };
        // SAFETY: stringWithUTF8String: returns an autoreleased NSString
        let key_equiv: *mut Object =
            msg_send![class!(NSString), stringWithUTF8String: empty_cstr.as_ptr()];
        if key_equiv.is_null() {
            return;
        }

        // SAFETY: NSMenuItem alloc + initWithTitle:action:keyEquivalent: is standard pattern
        let item: *mut Object = msg_send![class!(NSMenuItem), alloc];
        if item.is_null() {
            return;
        }
        let item: *mut Object = msg_send![
            item,
            initWithTitle: title
            action: sel!(newWindowAction:)
            keyEquivalent: key_equiv
        ];
        if item.is_null() {
            return;
        }
        // SAFETY: setTarget: retains the helper object
        let _: () = msg_send![item, setTarget: helper];

        // SAFETY: addItem: adds the item to the menu
        let _: () = msg_send![menu, addItem: item];

        // SAFETY: sharedApplication returns the singleton NSApplication instance
        let ns_app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        if ns_app.is_null() {
            return;
        }
        // SAFETY: setDockMenu: is a valid NSApplication selector
        let _: () = msg_send![ns_app, setDockMenu: menu];
    }
}

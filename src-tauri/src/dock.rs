use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Set up a native macOS Dock right-click menu with a "New Window" item.
pub fn setup_dock_menu(app: &AppHandle) {
    APP_HANDLE.set(app.clone()).ok();

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

        let helper_class: &Class = class!(MorayaDockHelper);
        let helper: *mut Object = msg_send![helper_class, new];

        // Create NSMenu
        let menu: *mut Object = msg_send![class!(NSMenu), new];

        // Create NSString for title and key equivalent
        let title_cstr = std::ffi::CString::new(title_text).unwrap();
        let title: *mut Object =
            msg_send![class!(NSString), stringWithUTF8String: title_cstr.as_ptr()];

        let empty_cstr = std::ffi::CString::new("").unwrap();
        let key_equiv: *mut Object =
            msg_send![class!(NSString), stringWithUTF8String: empty_cstr.as_ptr()];

        // Create NSMenuItem: "New Window"
        let item: *mut Object = msg_send![class!(NSMenuItem), alloc];
        let item: *mut Object = msg_send![
            item,
            initWithTitle: title
            action: sel!(newWindowAction:)
            keyEquivalent: key_equiv
        ];
        let _: () = msg_send![item, setTarget: helper];

        // Add item to menu
        let _: () = msg_send![menu, addItem: item];

        // Set as Dock menu: [NSApp setDockMenu:menu]
        let ns_app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![ns_app, setDockMenu: menu];

        // helper is retained by NSMenuItem via setTarget: — no explicit prevent-drop needed
    }
}

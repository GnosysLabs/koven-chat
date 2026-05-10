//! Auto-grant getUserMedia requests in the macOS WKWebView.
//!
//! macOS's WKWebView has THREE independent gates for camera/mic
//! access:
//!
//!   1. Hardened-runtime entitlement (Entitlements.plist)
//!      `com.apple.security.device.{audio-input,camera}` — without
//!      this, the device-access syscall is rejected before the page
//!      even gets a chance.
//!
//!   2. Info.plist usage description (Info.macOS.plist)
//!      `NS{Microphone,Camera}UsageDescription` — without this,
//!      macOS NEVER shows the user the permission prompt and the
//!      app doesn't appear in System Settings → Privacy & Security
//!      at all.  This is the symptom we hit: "the app didn't even
//!      ask, and Koven isn't in the list."
//!
//!   3. WKWebView's UIDelegate
//!      `webView:requestMediaCapturePermissionForOrigin:...:decisionHandler:`
//!      — when the page's `getUserMedia()` call reaches the
//!      delegate, the delegate must call `decisionHandler(.grant)`
//!      to actually let the browser-side permission resolve.  The
//!      DEFAULT delegate (none set) silently denies, so even with
//!      gates 1 and 2 in place, the page's promise rejects with
//!      NotAllowedError.
//!
//! This module installs gate 3.  Called once after the main window
//! is built; sets the WKWebView's UIDelegate to a custom class we
//! declare at runtime that grants every media-capture request.
//!
//! Trust model: the SPA we serve is from our own origin (the
//! tauri-plugin-localhost server, http://localhost:<port>).  The
//! is_internal navigation guard prevents the WebView from ever
//! loading a third-party origin at the top level, so "auto-grant
//! every request" is bounded to our own code.

use cocoa::base::{id, nil, BOOL, YES};
use objc::declare::ClassDecl;
use objc::runtime::{Class, Object, Sel};
use objc::{class, msg_send, sel, sel_impl};
use std::ffi::c_void;
use std::sync::Once;

/// WKPermissionDecision values from WebKit headers.
const WK_PERMISSION_DECISION_GRANT: i64 = 1;

/// One-shot delegate-class registration.  Defining the same ObjC
/// class twice in a process is a runtime error, so we gate the
/// declaration on Once.
static REGISTER_DELEGATE: Once = Once::new();
static mut DELEGATE_CLASS: *const Class = std::ptr::null();

extern "C" fn grant_media_capture(
    _this: &Object,
    _cmd: Sel,
    _webview: id,
    _origin: id,
    _frame: id,
    _media_type: i64,
    decision_handler: *mut c_void,
) {
    // decision_handler is an Objective-C block (^void(WKPermissionDecision)).
    // Calling a block from Rust = casting it to its block layout and
    // invoking the function pointer at offset 16.  Block ABI:
    //
    //   struct Block_layout {
    //       void *isa;            // +0
    //       int flags;            // +8
    //       int reserved;         // +12
    //       void (*invoke)(void *, ...);  // +16  ← our function ptr
    //       ...
    //   }
    //
    // Saves us from pulling in a `block` crate just to call one
    // delegate.  Decision = 1 (Grant).
    unsafe {
        let invoke_ptr = (decision_handler as *const u8).add(16) as *const extern "C" fn(*mut c_void, i64);
        let invoke = *invoke_ptr;
        invoke(decision_handler, WK_PERMISSION_DECISION_GRANT);
    }
}

fn ensure_delegate_class() -> *const Class {
    REGISTER_DELEGATE.call_once(|| {
        let superclass = class!(NSObject);
        let mut decl = ClassDecl::new("KovenWebViewMediaDelegate", superclass)
            .expect("KovenWebViewMediaDelegate already registered");
        unsafe {
            decl.add_method(
                sel!(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:),
                grant_media_capture as extern "C" fn(&Object, Sel, id, id, id, i64, *mut c_void),
            );
        }
        let class = decl.register();
        unsafe { DELEGATE_CLASS = class as *const Class; }
    });
    unsafe { DELEGATE_CLASS }
}

/// Install the auto-granting UIDelegate on the WKWebView nested
/// inside `ns_window`'s contentView hierarchy.  Walks the subviews
/// recursively to find the WKWebView (Tauri/wry wraps it in a
/// container, so contentView itself isn't the WKWebView directly).
/// No-op if the WKWebView can't be found — the call layout still
/// works without media access, just without successful camera/mic.
pub fn install(ns_window: id) {
    if ns_window.is_null() {
        return;
    }
    let class = ensure_delegate_class();
    if class.is_null() {
        return;
    }

    unsafe {
        let content_view: id = msg_send![ns_window, contentView];
        if content_view.is_null() {
            return;
        }
        let webview = find_wkwebview(content_view);
        if webview.is_null() {
            log::warn!("mac_webrtc_permission: WKWebView not found under contentView; getUserMedia will be silently denied");
            return;
        }
        let delegate: id = msg_send![class, new];
        // Retain the delegate beyond this scope: setting UIDelegate
        // takes a WEAK reference, so a stack-local instance would
        // be deallocated immediately and the next media request
        // would crash on a dangling pointer.  Boxing into a static
        // would leak; instead we pin it as an associated object on
        // the WKWebView itself, which lives for the app's lifetime.
        let key: *const c_void = &MEDIA_DELEGATE_KEY as *const _ as *const c_void;
        let _: () = msg_send![
            webview,
            setAssociatedObject: delegate
            withKey: key
            policy: 1i64  // OBJC_ASSOCIATION_RETAIN_NONATOMIC
        ];
        let _: () = msg_send![webview, setUIDelegate: delegate];
        log::info!("mac_webrtc_permission: UIDelegate installed for getUserMedia");
    }
}

// Private const used as the key for objc_setAssociatedObject.  The
// VALUE doesn't matter — only the pointer's identity is significant.
static MEDIA_DELEGATE_KEY: u8 = 0;

/// Recursively walk the view hierarchy from `view` looking for a
/// WKWebView instance.  Tauri / wry typically nests the WKWebView
/// one or two levels deep inside the NSWindow's contentView.
unsafe fn find_wkwebview(view: id) -> id {
    if view.is_null() {
        return nil;
    }
    let wk_class = class!(WKWebView);
    let is_wk: BOOL = msg_send![view, isKindOfClass: wk_class];
    if is_wk == YES {
        return view;
    }
    let subviews: id = msg_send![view, subviews];
    if subviews.is_null() {
        return nil;
    }
    let count: usize = msg_send![subviews, count];
    for i in 0..count {
        let child: id = msg_send![subviews, objectAtIndex: i];
        let found = find_wkwebview(child);
        if !found.is_null() {
            return found;
        }
    }
    nil
}

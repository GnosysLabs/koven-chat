// Windows-only chrome integration for our chromeless main window.
//
// Two pieces, both opt-in:
//
//   * apply_rounded_corners — one DWM call to opt the window into
//     Win11's rounded-corner treatment.  Silent no-op on Win10.
//
//   * apply_drag_region — creates an invisible (alpha-0) layered
//     child HWND that sits z-top above the WebView2 control,
//     covering the top 40px minus the right ~138px where Min/Max/
//     Close live.  Its WndProc handles WM_LBUTTONDOWN /
//     WM_LBUTTONDBLCLK directly, in-process, and synthesizes the
//     standard WM_NCLBUTTONDOWN HTCAPTION drag-start on the parent.
//     No JS, no IPC, no race.
//
//     Why an overlay HWND and not a subclass on the existing
//     children: we strip the native title bar with
//     `decorations(false)` so the SPA can render its own chrome,
//     but that leaves WebView2's `Chrome_RenderWidgetHostHWND`
//     (in the WebView2 RUNTIME process, not ours) as the receiver
//     of WM_LBUTTONDOWN over the drag area.  Cross-process
//     SetWindowSubclass isn't allowed, so we can't intercept
//     there.  Tauri's own TAURI_DRAG_RESIZE_BORDERS HWND solves
//     the same problem for resize edges by occupying a strip of
//     pixels above the WebView2 that we DO own — we replicate
//     the trick for the top drag strip.

use tauri::{Runtime, WebviewWindow};

/// Apply Win11 rounded corners to the given window.  Best-effort —
/// any failure path (no HWND, DWM call rejects) is logged and
/// swallowed; rounded corners are a polish detail, not load-bearing.
pub fn apply_rounded_corners<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
        };

        let hwnd = match window.hwnd() {
            Ok(h) => h,
            Err(err) => {
                log::warn!("windows_rounded_corners: hwnd unavailable: {err}");
                return;
            }
        };
        let hwnd_raw: windows_sys::Win32::Foundation::HWND = hwnd.0 as _;
        let pref: u32 = DWMWCP_ROUND as u32;
        let res = unsafe {
            DwmSetWindowAttribute(
                hwnd_raw,
                DWMWA_WINDOW_CORNER_PREFERENCE as u32,
                &pref as *const u32 as *const _,
                std::mem::size_of::<u32>() as u32,
            )
        };
        if res != 0 {
            log::warn!("windows_rounded_corners: DwmSetWindowAttribute → HRESULT {res:#x}");
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
    }
}

/// Install the drag-region overlay on the given window.  See the
/// module docs for why we use a separate HWND instead of a subclass.
pub fn apply_drag_region<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "windows")]
    {
        let hwnd = match window.hwnd() {
            Ok(h) => h,
            Err(err) => {
                log::warn!("apply_drag_region: hwnd unavailable: {err}");
                return;
            }
        };
        let hwnd_raw: windows_sys::Win32::Foundation::HWND = hwnd.0 as _;
        win::install(hwnd_raw);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
    }
}

#[cfg(target_os = "windows")]
mod win {
    use std::io::Write;
    use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, GetClientRect, GetCursorPos, GetParent,
        GetWindowLongPtrW, RegisterClassW, SendMessageW, SetLayeredWindowAttributes,
        SetWindowLongPtrW, SetWindowPos, CS_DBLCLKS, GWL_EXSTYLE, HTCAPTION, HWND_TOP, LWA_ALPHA,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WM_DPICHANGED, WM_LBUTTONDBLCLK,
        WM_LBUTTONDOWN, WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN, WM_SIZE, WNDCLASSW, WS_CHILD,
        WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_VISIBLE,
    };

    /// Append a line to %TEMP%\koven-drag.log.  Stays installed until
    /// the drag path is proven stable in the field.  The overlay
    /// only logs at creation time, on parent-resize, and (currently)
    /// on every intercepted mouse-down — none of which fire often
    /// enough for the log to grow unreasonably.
    fn dbg_log(msg: &str) {
        let mut path = std::env::temp_dir();
        path.push("koven-drag.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(f, "{msg}");
        }
    }

    // Drag-strip geometry, in CSS pixels.  Mirrors the layout in
    // client/src/components/DesktopTitleBar.tsx:
    //   * 40px tall  — DTB's h-10
    //   * 138px wide button cluster on the RIGHT (3 × 46px controls
    //     for Min/Max/Close) — must stay clickable, so the overlay
    //     stops short of them.
    //   * 8px from the top edge — the resize-handle zone that
    //     Tauri's TAURI_DRAG_RESIZE_BORDERS owns.  Skipping it
    //     means top-edge resize keeps working.
    //
    // Bump these if DesktopTitleBar's layout changes.
    const DRAG_HEIGHT_CSS: i32 = 40;
    const BUTTONS_WIDTH_CSS: i32 = 138;
    const TOP_RESIZE_INSET_CSS: i32 = 8;

    const SUBCLASS_ID_PARENT: usize = 0x4B6F_5650; // 'KoVP'

    // UTF-16 null-terminated literal — needed for the Win32 W APIs.
    fn class_name_w() -> Vec<u16> {
        "KOVEN_DRAG_OVERLAY"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect()
    }

    static REGISTERED: std::sync::Once = std::sync::Once::new();

    fn ensure_class_registered() {
        REGISTERED.call_once(|| {
            let class_name = class_name_w();
            let wnd_class = WNDCLASSW {
                style: CS_DBLCLKS,
                lpfnWndProc: Some(overlay_wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: unsafe { GetModuleHandleW(core::ptr::null()) },
                hIcon: core::ptr::null_mut(),
                hCursor: core::ptr::null_mut(),
                hbrBackground: core::ptr::null_mut(),
                lpszMenuName: core::ptr::null(),
                lpszClassName: class_name.as_ptr(),
            };
            let atom = unsafe { RegisterClassW(&wnd_class) };
            dbg_log(&format!("RegisterClassW returned atom={}", atom));
        });
    }

    pub fn install(parent: HWND) {
        dbg_log(&format!(
            "==== install begin parent=0x{:x} ====",
            parent as usize
        ));

        ensure_class_registered();

        // Geometry — compute physical-pixel dimensions for the
        // overlay based on the parent's current size + DPI.
        let (overlay_w, overlay_h, overlay_y) = overlay_geometry(parent);
        dbg_log(&format!(
            "overlay geometry parent_w + dpi → y={} w={} h={}",
            overlay_y, overlay_w, overlay_h
        ));

        let class_name = class_name_w();
        let hinstance = unsafe { GetModuleHandleW(core::ptr::null()) };
        dbg_log(&format!("hinstance=0x{:x}", hinstance as usize));

        // Create without WS_EX_LAYERED — passing it at creation can
        // fail with ERROR_ALREADY_EXISTS (183) on some Win11 / DWM
        // configurations where the parent's composition state
        // conflicts.  Toggling the bit AFTER creation via
        // SetWindowLongPtrW is the documented workaround and works
        // even when the create-time flag doesn't.
        let overlay = unsafe {
            CreateWindowExW(
                WS_EX_NOACTIVATE,
                class_name.as_ptr(),
                core::ptr::null(),
                WS_CHILD | WS_VISIBLE,
                0,
                overlay_y,
                overlay_w,
                overlay_h,
                parent,
                core::ptr::null_mut(),
                hinstance,
                core::ptr::null(),
            )
        };

        if overlay.is_null() {
            let err = unsafe { GetLastError() };
            dbg_log(&format!(
                "CreateWindowExW returned NULL — GetLastError={} (0x{:x})",
                err, err
            ));
            return;
        }
        dbg_log(&format!("overlay HWND created: 0x{:x}", overlay as usize));

        // Now apply WS_EX_LAYERED.  Once set, the window honours
        // SetLayeredWindowAttributes.
        let cur_style = unsafe { GetWindowLongPtrW(overlay, GWL_EXSTYLE) };
        let new_style = cur_style | (WS_EX_LAYERED as isize);
        let prev = unsafe { SetWindowLongPtrW(overlay, GWL_EXSTYLE, new_style) };
        dbg_log(&format!(
            "SetWindowLongPtrW(GWL_EXSTYLE) prev=0x{:x} new=0x{:x}",
            prev, new_style
        ));

        // alpha=0 → fully transparent, but still receives mouse events
        // (the per-pixel-transparency dance with LWA_COLORKEY would
        // be click-through; pure LWA_ALPHA is not).
        let r = unsafe { SetLayeredWindowAttributes(overlay, 0, 0, LWA_ALPHA) };
        dbg_log(&format!("SetLayeredWindowAttributes returned {}", r));

        // Force the overlay to the top of the z-order so it sits
        // ABOVE the WebView2 (otherwise the WebView2 surface,
        // which was created earlier, would obscure us).
        let r = unsafe {
            SetWindowPos(
                overlay,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
        };
        dbg_log(&format!("SetWindowPos HWND_TOP returned {}", r));

        // Subclass the parent so we can resize the overlay when
        // the parent's size or DPI changes.  Without this the
        // drag region would stop tracking the window edge after
        // the first maximize / monitor move.
        let ok = unsafe {
            SetWindowSubclass(
                parent,
                Some(parent_subclass_proc),
                SUBCLASS_ID_PARENT,
                overlay as usize,
            )
        };
        dbg_log(&format!("parent subclass install returned {}", ok));

        dbg_log("==== install end ====");
    }

    /// Compute the overlay's (width, height, y) in physical pixels
    /// for the parent's current client size + DPI.
    fn overlay_geometry(parent: HWND) -> (i32, i32, i32) {
        let mut client: RECT = unsafe { core::mem::zeroed() };
        let _ = unsafe { GetClientRect(parent, &mut client) };
        let parent_w = client.right - client.left;

        let dpi = unsafe { GetDpiForWindow(parent) }.max(96);
        let scale = dpi as f32 / 96.0;
        let drag_h = (DRAG_HEIGHT_CSS as f32 * scale) as i32;
        let btn_w = (BUTTONS_WIDTH_CSS as f32 * scale) as i32;
        let top_inset = (TOP_RESIZE_INSET_CSS as f32 * scale) as i32;

        let overlay_w = (parent_w - btn_w).max(0);
        let overlay_h = (drag_h - top_inset).max(0);
        let overlay_y = top_inset;
        (overlay_w, overlay_h, overlay_y)
    }

    unsafe extern "system" fn overlay_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_LBUTTONDOWN | WM_LBUTTONDBLCLK => {
                let parent = unsafe { GetParent(hwnd) };
                unsafe {
                    ReleaseCapture();
                    let mut pt: POINT = core::mem::zeroed();
                    if GetCursorPos(&mut pt) != 0 {
                        let lp_screen = ((pt.x as u32 & 0xFFFF)
                            | ((pt.y as u32 & 0xFFFF) << 16))
                            as LPARAM;
                        let nc_msg = if msg == WM_LBUTTONDBLCLK {
                            WM_NCLBUTTONDBLCLK
                        } else {
                            WM_NCLBUTTONDOWN
                        };
                        // Log only the first intercept so the log
                        // file doesn't grow unboundedly — proves
                        // the overlay is doing its job without
                        // appending a line on every click.
                        static FIRST_INTERCEPT: std::sync::Once = std::sync::Once::new();
                        FIRST_INTERCEPT.call_once(|| {
                            dbg_log(&format!(
                                "first drag intercepted: parent=0x{:x} nc_msg={} pt=({},{})",
                                parent as usize, nc_msg, pt.x, pt.y
                            ));
                        });
                        SendMessageW(parent, nc_msg, HTCAPTION as WPARAM, lp_screen);
                    }
                }
                return 0;
            }
            _ => {}
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    unsafe extern "system" fn parent_subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _uid_subclass: usize,
        overlay_addr: usize,
    ) -> LRESULT {
        if msg == WM_SIZE || msg == WM_DPICHANGED {
            let overlay: HWND = overlay_addr as HWND;
            let (w, h, y) = overlay_geometry(hwnd);
            unsafe {
                SetWindowPos(
                    overlay,
                    core::ptr::null_mut(),
                    0,
                    y,
                    w,
                    h,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }
}

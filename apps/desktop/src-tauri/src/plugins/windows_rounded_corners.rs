// Windows-only: opt the main window into Win11's rounded-corner
// treatment via DWM (Desktop Window Manager).  We strip the native
// title bar with `decorations(false)` so the SPA can render its own
// chrome (DesktopTitleBar — close/min/max on the right), but
// chromeless windows render with sharp corners by default on Win11.
// Setting DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND tells the
// compositor to clip the window to the same rounded shape native
// Win11 apps get.
//
// Silent no-op on Win10: DWM ignores attributes it doesn't
// recognise, so the call returns success and the window stays
// square — which is the native Win10 look anyway, so users on
// older Windows don't see any regression.

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
        // Tauri's HWND is windows::Win32::Foundation::HWND; windows-sys
        // expects its own HWND newtype which is just an isize.  The
        // underlying handle is identical, so a raw cast is correct.
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
            // Non-fatal: Win10 returns S_OK anyway because it ignores
            // the unknown attribute; only Win11 with a broken DWM
            // would land here.  Log + carry on.
            log::warn!("windows_rounded_corners: DwmSetWindowAttribute → HRESULT {res:#x}");
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
    }
}

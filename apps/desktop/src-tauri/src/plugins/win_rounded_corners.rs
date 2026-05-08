// Windows 11 rounded-corner support for the (frameless) main window.
//
// We build the main window with `decorations(false)` so the SPA can
// render its own custom title bar — same trick we use on macOS to
// get pixel-perfect chrome.  The downside on Windows is that without
// the standard frame, DWM (the compositor) doesn't apply its
// rounded-corner treatment automatically: the window paints with
// hard square corners.
//
// `DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ROUND)`
// opts the window back in.  This is the same API the OS uses for
// every Win11 window's chrome, so the radius, anti-aliasing, and
// drop shadow all match the look of native apps automatically — no
// custom region masking, no manual shadow draw.
//
// Behaviour by Windows version:
//   * Windows 11 (build 22000+): rounded corners + native shadow.
//   * Windows 10: the attribute is unknown — DwmSetWindowAttribute
//     returns E_INVALIDARG and the window stays square.  We log
//     and move on; Win10 reaches EOL Oct 2025 and a square frameless
//     window is not a regression vs. the previous square-with-chrome
//     state.
//
// This is the Windows analogue to plugins/mac_rounded_corners.rs,
// but much simpler — DWM does the work, we just ask for it.

use tauri::{AppHandle, Runtime, WebviewWindow};

#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWM_WINDOW_CORNER_PREFERENCE,
    DWMWCP_ROUND,
};

/// Apply the Win11 rounded-corner DWM hint to the window.  Invoked
/// from the SPA's main.tsx after the main window mounts (mirrors the
/// macOS rounded-corner setup pattern).  No-op on Win10 / earlier.
#[tauri::command]
pub fn enable_windows_rounded_corners<R: Runtime>(
    _app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let hwnd_raw: HWND = hwnd.0 as HWND;
        // DWMWCP_ROUND = 2 (large rounded corners — what every native
        // Win11 chromed window uses).  DWMWCP_ROUNDSMALL = 3 is the
        // tighter 4px variant; we want the larger one to better
        // match our 14px macOS radius.
        let pref: DWM_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND;
        // Safety: HWND is valid for the lifetime of the WebviewWindow,
        // and we pass a properly-sized, properly-aligned attribute
        // value.  DwmSetWindowAttribute is thread-safe when the HWND
        // is valid; we're called from the Tauri main-thread invoke
        // handler so there's no concurrent destruction either.
        let hr = unsafe {
            DwmSetWindowAttribute(
                hwnd_raw,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &pref as *const _ as *const _,
                std::mem::size_of::<DWM_WINDOW_CORNER_PREFERENCE>() as u32,
            )
        };
        if hr < 0 {
            // Likely Win10 — log and continue rather than failing the
            // command, since the SPA caller can't do anything useful
            // with the error and a hard error here would be alarming
            // for users on supported-but-old Windows builds.
            log::info!(
                "DwmSetWindowAttribute(corner_preference) returned 0x{:08x} — likely pre-Win11; corners will paint square",
                hr,
            );
        }
    }
    let _ = window;
    Ok(())
}

// Surgical Node-globals shim, applied before React mounts.  Only
// `Buffer` is genuinely needed — matrix-js-sdk uses it in places that
// don't tolerate undefined.  We deliberately do NOT use
// vite-plugin-node-polyfills: its broader Node-module shims (crypto,
// stream, util) interfere with WASM ↔ JS string marshaling in
// matrix-sdk-crypto-wasm, manifesting as "Unexpected end of JSON
// input" inside receiveSyncChanges and breaking the encrypted sync
// loop.
import { Buffer } from "buffer";
const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (typeof g.Buffer === "undefined") {
	g.Buffer = Buffer;
}

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DesktopTitleBar } from "./components/DesktopTitleBar";
import "./index.css";

// Per-platform desktop chrome setup.  Both branches run BEFORE the
// reveal sequence so when the splash hands off to the main window
// it's already fully chromed (rounded corners applied, native
// controls hidden where needed) — no square-flash → rounded-final
// transition.  Browsers and Linux desktop builds short-circuit
// immediately; the Tauri-API chunks only get pulled when actually
// running inside the Tauri shell.
//
// macOS:
//   1. enable_modern_window_style — sets contentView.layer.cornerRadius
//      (cloudworxx plugin invokes this via #[tauri::command]).
//   2. hide_traffic_lights — setHidden:YES on close/min/zoom because
//      the plugin's style-mask change re-enabled them; we render
//      our own in DesktopTitleBar instead.
//
// Windows:
//   1. enable_windows_rounded_corners — DWM `WINDOW_CORNER_PREFERENCE`
//      = ROUND, which gives the frameless window the OS's native
//      Win11 rounded-corner treatment with proper anti-aliasing
//      and shadow.  Win10 silently no-ops (square corners).
async function setupDesktopChrome(): Promise<void> {
	if (typeof window === "undefined") return;
	const platform = (window as { __KOVEN_PLATFORM__?: string }).__KOVEN_PLATFORM__;
	if (platform === "macos") {
		try {
			const [cloudworxx, tauriCore] = await Promise.all([
				import("@cloudworxx/tauri-plugin-mac-rounded-corners"),
				import("@tauri-apps/api/core"),
			]);
			await cloudworxx.enableModernWindowStyle({
				cornerRadius: 14,
				offsetX: 0,
				offsetY: 0,
			});
			await tauriCore.invoke("hide_traffic_lights");
		} catch (err) {
			console.error("macOS rounded-corner setup failed", err);
		}
		return;
	}
	if (platform === "windows") {
		try {
			const tauriCore = await import("@tauri-apps/api/core");
			await tauriCore.invoke("enable_windows_rounded_corners");
		} catch (err) {
			console.error("Windows rounded-corner setup failed", err);
		}
		return;
	}
}

// Reveal sequence: ask Rust to close the floating splash window
// and show the main window.  By this point the main window is
// fully styled (rounded corners applied, custom chrome rendered,
// React mounted) so the swap from splash to main is a single
// transition with no in-between state visible.
//
// Runs on macOS + Windows — both build the main window with
// `decorations(false)` and need the splash mask to hide the
// chrome-setup transition.  Linux desktop and browser builds
// short-circuit (no splash exists; main window is either already
// visible or doesn't apply).
async function revealApp(): Promise<void> {
	if (typeof window === "undefined") return;
	const platform = (window as { __KOVEN_PLATFORM__?: string }).__KOVEN_PLATFORM__;
	if (platform !== "macos" && platform !== "windows") return;
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("reveal_app");
	} catch (err) {
		console.error("reveal_app failed", err);
	}
}

// SPA fills the entire window.  No title-bar gutter at the top —
// individual views are responsible for their own top inset on
// macOS / Windows where the custom chrome reserves the top 40px
// as a drag zone with the window controls.  The login screen
// leaves it empty (so its wallpaper extends edge-to-edge under
// the floating window controls); the authed app layout adds the
// gutter explicitly.  DesktopTitleBar stays absolute-positioned
// at the top so the controls paint over whatever the SPA renders
// below.
ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<div className="h-full relative">
			<App />
			<DesktopTitleBar />
		</div>
	</React.StrictMode>,
);

// Boot sequence:
//   1. setupDesktopChrome — round the corners (and hide native
//      traffic lights on macOS).  No-op for browsers / Linux.
//   2. wait one frame so React's first commit has actually painted
//   3. revealApp — close splash window, show main window
// All three are sequenced so the user only sees: floating favicon
// over the desktop → fully styled main window.  No square flash,
// no half-painted intermediate.
void setupDesktopChrome()
	.then(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
	.then(revealApp);

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

// macOS desktop only: round the NSWindow corners via cloudworxx's
// plugin, then immediately hide the native traffic lights it
// re-enabled — we want the rounded window but the SPA renders its
// own traffic-light buttons (DesktopTitleBar) for pixel-perfect
// alignment with the rest of the chrome.  Two invokes:
//   1. enable_modern_window_style — sets contentView.layer.cornerRadius
//   2. hide_traffic_lights        — setHidden:YES on close/min/zoom
// Lazy-imported so browsers / Linux / Windows don't pull the
// Tauri-API chunk.
//
// Returns a Promise so the splash teardown below can await the
// chrome being fully ready before fading the splash out — without
// the await we'd briefly see a square dark window before the
// corners round.
async function setupMacChrome(): Promise<void> {
	if (
		typeof window === "undefined" ||
		(window as { __KOVEN_PLATFORM__?: string }).__KOVEN_PLATFORM__ !== "macos"
	) {
		return;
	}
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
		console.error("rounded-corner setup failed", err);
	}
}

// Reveal sequence: ask Rust to close the floating splash window
// and show the main window.  By this point the main window is
// fully styled (rounded corners, traffic lights hidden, custom
// chrome rendered, React mounted) so the swap from splash to
// main is a single transition with no in-between state visible.
//
// On non-macOS-desktop platforms there's no splash window and the
// main window was shown by lib.rs's setup() — invoking reveal_app
// there is a cheap no-op (splash window not found, main already
// visible) and keeps the codepath uniform.
async function revealApp(): Promise<void> {
	if (
		typeof window === "undefined" ||
		(window as { __KOVEN_PLATFORM__?: string }).__KOVEN_PLATFORM__ !== "macos"
	) {
		return;
	}
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("reveal_app");
	} catch (err) {
		console.error("reveal_app failed", err);
	}
}

// SPA fills the entire window.  No title-bar gutter at the top —
// individual views are responsible for their own top inset on
// macOS where the OS reserves the top 28px as a drag zone.  The
// login screen leaves it empty (so its wallpaper extends edge-to-
// edge under the floating traffic lights); the authed app layout
// adds pt-7 to its main content row so chat-header buttons clear
// the drag zone.  DesktopTitleBar stays absolute-positioned at
// the top so the traffic lights paint over whatever the SPA
// renders below.
ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<div className="h-full relative">
			<App />
			<DesktopTitleBar />
		</div>
	</React.StrictMode>,
);

// Boot sequence:
//   1. setupMacChrome — round the corners, hide native traffic lights
//   2. wait one frame so React's first commit has actually painted
//   3. revealApp — close splash window, show main window
// All three are sequenced so the user only sees: floating favicon
// over the desktop → fully styled main window.  No square flash,
// no half-painted intermediate.
void setupMacChrome()
	.then(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
	.then(revealApp);

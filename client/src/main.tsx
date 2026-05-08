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
if (
	typeof window !== "undefined" &&
	(window as { __KOVEN_PLATFORM__?: string }).__KOVEN_PLATFORM__ === "macos"
) {
	void Promise.all([
		import("@cloudworxx/tauri-plugin-mac-rounded-corners"),
		import("@tauri-apps/api/core"),
	]).then(async ([cloudworxx, tauriCore]) => {
		await cloudworxx.enableModernWindowStyle({
			cornerRadius: 14,
			offsetX: 0,
			offsetY: 0,
		});
		await tauriCore.invoke("hide_traffic_lights");
	}).catch((err) => console.error("rounded-corner setup failed", err));
}

// macOS desktop only: the cloudworxx plugin's rounded-corner setup
// uses NSFullSizeContentView, which makes the OS reserve the top
// ~28px of the window as a draggable title-bar zone — clicks in
// that strip are eaten by the OS, NOT delivered to the WebView.
// Even if the SPA paints interactive content there (chat-pane
// header buttons, etc.) those buttons can't be clicked.  So on
// macOS we shift the entire app content down by 28px (a flex
// `pt-7` gutter); on browsers / Linux / Windows the gutter
// disappears.  The DesktopTitleBar remains absolute-positioned
// over everything so the custom traffic lights still float in
// the top-left.
const isMacDesktop =
	typeof window !== "undefined" &&
	(window as { __KOVEN_PLATFORM__?: string }).__KOVEN_PLATFORM__ === "macos";

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<div className="h-full relative flex flex-col">
			{isMacDesktop && (
				/* 40px title-bar gutter with a bottom hairline that
				 * separates the chrome strip from the SPA content
				 * below.  Height matches DesktopTitleBar's `h-10`
				 * so the strip the traffic lights live in and the
				 * gutter the SPA content sits below are the same
				 * 40px.  The border-b draws a faint divider in the
				 * theme's border color so it stays subtle on dark
				 * and light themes alike.
				 */
				<div className="h-10 shrink-0 border-b border-border" />
			)}
			<div className="flex-1 min-h-0">
				<App />
			</div>
			<DesktopTitleBar />
		</div>
	</React.StrictMode>,
);

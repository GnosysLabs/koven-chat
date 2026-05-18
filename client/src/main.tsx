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
import { CallWindowApp } from "./components/voice/CallWindowApp";
import { CallProvider } from "./lib/call-context";
import { primeRingtone } from "./lib/callRingtone";
import { tryDeepLinkBounce } from "./lib/deepLinkBounce";
import { drainPendingCall, isCallWindow, type PendingCall } from "./lib/native-window";
import "./index.css";

// Deep-link bounce: if the browser loaded /invite/<id> or /r/<id>/<eid>
// in a plain browser (Brave/Chrome don't honor Universal Links on
// macOS at all; Safari only auto-opens for cross-origin clicks), try
// to hand the URL off to the registered `koven://` scheme so the
// desktop app actually opens.  No-op inside the Tauri shell.  Fires
// before React mounts so the OS confirmation dialog pops as soon as
// the bundle starts, no perceptible SPA flash before the handoff.
tryDeepLinkBounce();

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

// Window-kind branching: the Tauri shell injects __KOVEN_WINDOW_KIND__
// per webview ("main" for the app shell, "call" for the popped-out
// call window).  On the call branch we mount a stripped-down shell
// that only hosts the call surface; no sidebar, no chat, no
// DesktopTitleBar (the call window uses native OS chrome so the user
// gets traffic lights, fullscreen, free resize without any
// reimplementation).  Plain browsers read the global as undefined
// and take the main branch, matching today's inline-call flow.
//
// SPA fills the entire window.  No title-bar gutter at the top —
// individual views are responsible for their own top inset on
// macOS where the OS reserves the top 28px as a drag zone.  The
// login screen leaves it empty (so its wallpaper extends edge-to-
// edge under the floating traffic lights); the authed app layout
// adds pt-7 to its main content row so chat-header buttons clear
// the drag zone.  DesktopTitleBar stays absolute-positioned at
// the top so the traffic lights paint over whatever the SPA
// renders below.
const isCallWin = isCallWindow();
const root = ReactDOM.createRoot(document.getElementById("root")!);

function renderMain() {
	root.render(
		<React.StrictMode>
			<CallProvider>
				<div className="h-full relative">
					<App />
					<DesktopTitleBar />
				</div>
			</CallProvider>
		</React.StrictMode>,
	);
}

function renderCallWindow(pendingCall: PendingCall | null) {
	root.render(
		<React.StrictMode>
			<CallWindowApp pendingCall={pendingCall} />
		</React.StrictMode>,
	);
}

if (isCallWin) {
	// Drain the call params from Rust BEFORE rendering React.  The
	// drain is a take-once Mutex on the Rust side, so calling it
	// twice yields null on the second call — which is exactly what
	// React 18's Strict Mode double-mount does to component-driven
	// drains in dev.  Doing it here, outside the React lifecycle,
	// guarantees a single drain and lets us thread the result down
	// as a prop.  Errors (IPC denied, no slot) come back as null
	// and CallWindowApp renders its "no pending call" recovery UI.
	void drainPendingCall()
		.catch((err) => {
			console.error("call-window: drain failed", err);
			return null;
		})
		.then((pendingCall) => {
			renderCallWindow(pendingCall);
		});
} else {
	// Arm the call ringtone so the first click/tap unlocks audio
	// playback before any call arrives.  See callRingtone.ts.
	primeRingtone();
	renderMain();
}

// Boot sequence (main window only):
//   1. setupMacChrome — round the corners, hide native traffic lights
//   2. wait one frame so React's first commit has actually painted
//   3. revealApp — close splash window, show main window
// All three are sequenced so the user only sees: floating favicon
// over the desktop → fully styled main window.  No square flash,
// no half-painted intermediate.
//
// The call window uses native OS chrome (decorations=true) so it
// has no rounded-corner setup to run and no splash to dismiss.
// Skipping these calls there also avoids invoking
// `hide_traffic_lights` on a window where they're intentionally
// visible.
if (!isCallWin) {
	void setupMacChrome()
		.then(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
		.then(revealApp);
}

// Register the service worker that backs notifications + (later)
// offline caching.  Done after the React tree mounts so the
// installation cost (network request for /sw.js, parse, install
// event) doesn't compete with first paint.  iOS Safari requires the
// SW to fire notifications on installed PWAs (the page-side
// `new Notification(...)` is a silent no-op there); modern Chromium /
// Firefox / Safari desktop also work fine via the SW path, so we use
// it universally.  Skipped silently if `serviceWorker` isn't on
// `navigator` (older browsers, sandbox modes that disable workers).
//
// Note: the SW itself only handles install / activate /
// notificationclick — no fetch handler, so it doesn't intercept
// network traffic.  An earlier suspicion that SW was the cause of
// a fleet-wide regression turned out to be wrong; the actual bug
// was a render loop in useNotifications hammering the engine, fixed
// in 3cb48d0.  SW is back to its intended job: notification
// surfacing on iOS PWA.
if (typeof window !== "undefined" && "serviceWorker" in navigator) {
	window.addEventListener("load", () => {
		navigator.serviceWorker
			.register("/sw.js", { scope: "/" })
			.catch((err) => {
				// Don't escalate — a missing SW falls back to page-
				// side `new Notification(...)` (see lib/notifications.ts).
				console.warn("sw: registration failed", err);
			});
	});
}

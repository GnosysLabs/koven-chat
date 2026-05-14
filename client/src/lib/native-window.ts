// Tauri-window helpers for the popped-out call window.
//
// The desktop shell can host a second WebviewWindow labeled "call"
// alongside the main window.  The two windows share the bundled SPA
// origin (http://localhost:<port>/) but each runs in its own JS
// context: nothing is shared by reference, so the call window has to
// be told what call to join via a Rust-side handoff (see
// `spawn_call_window` / `drain_pending_call` in lib.rs).
//
// All Tauri APIs are lazy-imported so plain browsers and the mobile
// Capacitor shell don't pull the @tauri-apps/api chunk into their
// bundles.
//
// Window-kind detection keys on the `__KOVEN_WINDOW_KIND__` global
// injected by the Tauri shell's per-window initialization script
// ("main" for the app shell, "call" for the popped-out call window).
// Plain browsers see the global as undefined and read as "main" by
// default, matching the inline-call behaviour on the web.

import type { RoomId } from "@koven/shared";

/** True when running inside the Tauri desktop shell.  Distinct from
 *  `isNativeShell()` (which is also true under Capacitor on mobile);
 *  we use this gate for things that are specifically desktop-window
 *  affordances: spawning a second OS window, toggling native
 *  fullscreen, asking the OS to close the current window. */
export function isDesktopShell(): boolean {
	if (typeof window === "undefined") return false;
	const w = window as { isTauri?: boolean; __KOVEN_DESKTOP__?: boolean };
	return w.isTauri === true || w.__KOVEN_DESKTOP__ === true;
}

/** True when the current SPA instance is rendering inside the popped-
 *  out call window (the Tauri shell injects `__KOVEN_WINDOW_KIND__ =
 *  "call"` only for that webview).  Used to suppress the pop-out
 *  buttons inside the call window itself and to mount the call-only
 *  shell from main.tsx instead of the full app. */
export function isCallWindow(): boolean {
	if (typeof window === "undefined") return false;
	return (window as { __KOVEN_WINDOW_KIND__?: string }).__KOVEN_WINDOW_KIND__ === "call";
}

/** Params handed to the call window when it's spawned.  Matches the
 *  Rust `PendingCall` struct (serde rename_all = "camelCase"), so the
 *  field names go over the IPC bridge unchanged in both directions. */
export interface PendingCall {
	roomId: RoomId;
	roomName: string;
	authToken: string;
	accessToken: string;
	isDm: boolean;
	/** Mic state at the moment of pop-out, preserved so the new SDK
	 *  session starts with the user's current setting (vs.
	 *  defaulting to off and forcing a re-enable). */
	defaultAudio: boolean;
	/** Camera state at the moment of pop-out.  Same reasoning. */
	defaultVideo: boolean;
}

/** Spawn the call window, handing it the params it needs to join the
 *  meeting on its own.  No-op on non-desktop hosts (caller is
 *  responsible for gating with `isDesktopShell()` before offering the
 *  affordance). */
export async function spawnCallWindow(params: PendingCall): Promise<void> {
	if (!isDesktopShell()) {
		throw new Error("spawnCallWindow: not running inside the desktop shell");
	}
	const { invoke } = await import("@tauri-apps/api/core");
	await invoke("spawn_call_window", { params });
}

/** Drain the pending-call slot the main window stashed for us via
 *  `spawn_call_window`.  Called once on call-window boot.  Returns
 *  `null` if the slot is empty (the SPA shows an error state and
 *  the user closes the orphaned window). */
export async function drainPendingCall(): Promise<PendingCall | null> {
	if (!isDesktopShell()) return null;
	const { invoke } = await import("@tauri-apps/api/core");
	const r = await invoke<PendingCall | null>("drain_pending_call");
	return r ?? null;
}

/** Toggle native fullscreen on the current window.  Wired to the call
 *  surface's fullscreen button (and on macOS the green traffic light
 *  does the same thing for free).  Silent no-op outside the desktop
 *  shell. */
export async function toggleCallWindowFullscreen(): Promise<void> {
	if (!isDesktopShell()) return;
	const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
	const win = getCurrentWebviewWindow();
	const isFull = await win.isFullscreen();
	await win.setFullscreen(!isFull);
}

/** Close the current Tauri window.  Used by the call window when
 *  the meeting ends (user clicks Leave, or remote teardown fires
 *  roomLeft).  Silent no-op outside the desktop shell. */
export async function closeCurrentWindow(): Promise<void> {
	if (!isDesktopShell()) return;
	const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
	const win = getCurrentWebviewWindow();
	await win.close();
}

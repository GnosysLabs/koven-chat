// Native-shell bootstrap.  Called once early in App.tsx mount when
// we detect we're running inside Capacitor (iOS / Android).  Has no
// effect in a regular browser or under Tauri.
//
// Why dynamic-import the Capacitor plugins instead of static-import:
// the koven-web client is the same bundle that gets shipped to the
// web (where `@capacitor/*` doesn't resolve at runtime), to Tauri
// desktop (where it's also not installed), and to Capacitor mobile
// (where it IS).  Static imports would force every host to ship the
// plugin code; dynamic imports keep the cost on the platform that
// uses them.

/** True when running inside a Capacitor WebView (iOS / Android shell). */
export function isCapacitor(): boolean {
	return typeof window !== "undefined"
		&& (window as { Capacitor?: unknown }).Capacitor !== undefined;
}

/** True when running inside any native shell — Capacitor (iOS / Android)
 * OR Tauri (desktop / mobile experimental) OR the legacy
 * `__KOVEN_DESKTOP__` init flag.  Use this for "we are not a regular
 * mobile browser" decisions like showing the brand wallpaper /
 * wordmark on login surfaces. */
export function isNativeShell(): boolean {
	if (typeof window === "undefined") return false;
	const w = window as {
		Capacitor?: unknown;
		isTauri?: boolean;
		__KOVEN_DESKTOP__?: boolean;
	};
	return w.Capacitor !== undefined
		|| w.isTauri === true
		|| w.__KOVEN_DESKTOP__ === true;
}

/** Apply native-shell tweaks that improve mobile UX.  Currently:
 *
 *   - Hide the keyboard input-accessory bar (the up/down/done strip
 *     that iOS attaches above the keyboard for form-field
 *     navigation).  It looks out of place in a chat composer and
 *     covers the top of the keyboard with vestigial buttons.
 *
 * Safe to call repeatedly; the Capacitor APIs are idempotent. */
export async function applyNativeShellTweaks(): Promise<void> {
	if (!isCapacitor()) return;
	try {
		// `@capacitor/keyboard` only lives in the koven-ios package's
		// node_modules — the web client doesn't statically depend on
		// it (and Vite leaves dynamic imports of unresolved modules as
		// external).  Suppress the bundle-time type-check; at runtime
		// the import resolves inside the iOS Capacitor WebView.
		// @ts-expect-error: optional native-only dependency.
		const { Keyboard } = await import("@capacitor/keyboard");
		await Keyboard.setAccessoryBarVisible({ isVisible: false });
	} catch {
		// Plugin not installed (e.g. running web build via Capacitor's
		// dev-server in a browser) — silently no-op.
	}
}

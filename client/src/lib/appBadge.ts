// Cross-environment app-icon badge helper.
//
// Surfaces the unread notification count on the OS-level app icon so
// users see "you have stuff" without having the app focused:
//
//   * Browser (installed PWA)        → navigator.setAppBadge(count)
//                                      Web App Badging API.  Chrome/
//                                      Edge desktop, Android, iOS
//                                      16.4+ on home-screen PWAs.
//                                      No-op for plain browser tabs;
//                                      graceful (just doesn't show).
//   * Tauri desktop (macOS)          → window.setBadgeCount(count)
//                                      Dock icon in the bottom-right
//                                      corner.  Mirrors Notification
//                                      Center's per-app counter.
//   * Tauri desktop (Windows/Linux)  → no-op (the Tauri 2 API only
//                                      maps badges on macOS for now).
//                                      Notifications still fire; the
//                                      taskbar just doesn't get a
//                                      number.
//
// Idempotent.  Calling with the same count twice is fine — the OS
// just re-asserts.  Calling with 0 (or a falsy value) clears the
// badge.

const isDesktop = typeof window !== "undefined"
	&& (window as { __KOVEN_DESKTOP__?: boolean }).__KOVEN_DESKTOP__ === true;

/** Set the app badge to `count`, or clear it when `count <= 0`.
 * Fire-and-forget — async but the caller doesn't need to await. */
export async function setAppBadge(count: number): Promise<void> {
	const safe = Math.max(0, Math.floor(count));
	if (isDesktop) {
		try {
			const { getCurrentWindow } = await import("@tauri-apps/api/window");
			const w = getCurrentWindow();
			// `setBadgeCount` accepts undefined to clear, a number to
			// set.  Handles macOS only at the Rust layer; the JS side
			// resolves successfully on Windows/Linux too but the Rust
			// implementation is a no-op there.
			await w.setBadgeCount(safe > 0 ? safe : undefined);
		} catch (err) {
			console.warn("appBadge: Tauri setBadgeCount failed", err);
		}
		return;
	}
	if (typeof navigator === "undefined") return;
	const nav = navigator as Navigator & {
		setAppBadge?(count?: number): Promise<void>;
		clearAppBadge?(): Promise<void>;
	};
	try {
		if (safe > 0 && nav.setAppBadge) {
			await nav.setAppBadge(safe);
		} else if (nav.clearAppBadge) {
			await nav.clearAppBadge();
		}
	} catch (err) {
		// Common reason: the page isn't an installed PWA, so the API
		// throws.  Not actionable for the user, just log + drop.
		console.debug("appBadge: navigator badge API failed", err);
	}
}

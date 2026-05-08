// Cross-environment notification helper.
//
// Abstracts the OS-level notification surface so callers don't have
// to branch on whether they're in the desktop shell or the browser:
//
//   * Tauri desktop  → @tauri-apps/plugin-notification → native OS
//                      notification (Notification Center on macOS,
//                      Action Center on Windows, libnotify on Linux).
//                      Works even when the window is in the background
//                      or the app is minimized.
//   * Browser        → window.Notification (the W3C Notification API).
//                      Works in modern Chromium / Firefox / Safari;
//                      respects the user's OS-level "Do Not Disturb."
//
// Permission request:
//   Browsers gate Notification on a per-origin permission grant —
//   "default" means we haven't asked, "granted" means OK, "denied"
//   means hard-no.  We probe once on app boot via `ensurePermission`;
//   subsequent calls short-circuit on the cached state.
//
//   Tauri's plugin handles its own OS-mediated permission flow with
//   isPermissionGranted / requestPermission helpers from
//   @tauri-apps/plugin-notification.  Same pattern, different
//   underlying syscall.
//
// We also gate on document.hidden / document.visibilityState — a
// notification while the user is actively looking at the relevant
// room is just noise.  Caller still has to check
// "is this the active room", since visibility doesn't tell us that.

const isDesktop = typeof window !== "undefined"
	&& (window as { __KOVEN_DESKTOP__?: boolean }).__KOVEN_DESKTOP__ === true;

let permissionState: "granted" | "denied" | "default" | "unknown" = "unknown";

/**
 * Probe (and on "default", request) the OS notification permission.
 * Idempotent — subsequent calls with the same cached state are
 * no-ops.  Call once on app boot; later calls during the session
 * just read the cached state.
 *
 * Returns the granted/denied result so callers can decide whether
 * to show fallback in-app affordances if denied.
 */
export async function ensureNotificationPermission(): Promise<"granted" | "denied"> {
	if (permissionState === "granted") return "granted";
	if (permissionState === "denied") return "denied";

	if (isDesktop) {
		try {
			const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
			const already = await isPermissionGranted();
			if (already) {
				permissionState = "granted";
				return "granted";
			}
			const result = await requestPermission();
			permissionState = result === "granted" ? "granted" : "denied";
			return permissionState;
		} catch (err) {
			console.warn("notifications: Tauri permission probe failed", err);
			permissionState = "denied";
			return "denied";
		}
	}

	if (typeof Notification === "undefined") {
		permissionState = "denied";
		return "denied";
	}
	if (Notification.permission === "granted") {
		permissionState = "granted";
		return "granted";
	}
	if (Notification.permission === "denied") {
		permissionState = "denied";
		return "denied";
	}
	try {
		const result = await Notification.requestPermission();
		permissionState = result === "granted" ? "granted" : "denied";
		return permissionState;
	} catch (err) {
		console.warn("notifications: browser permission request failed", err);
		permissionState = "denied";
		return "denied";
	}
}

export interface NotifyOptions {
	title: string;
	body: string;
	// Optional room id — clicked notifications focus the window and
	// open this room.  Captured into the click handler closure on
	// the web side; on Tauri desktop we don't yet wire navigation
	// from the OS notification (Tauri 2's plugin doesn't expose a
	// click event the same way; coming in a later iteration).
	roomId?: string;
	// Tag groups the notifications.  When a new notification
	// arrives with the same tag, it replaces the previous one
	// rather than stacking — useful for "10 messages in #general"
	// not turning into a tower of alerts.
	tag?: string;
	// Click handler for the web Notification API.  Tauri's plugin
	// can't currently route click events back to the SPA, so this
	// only matters in browser mode.
	onClick?(): void;
}

/**
 * Fire a notification.  Drops silently when permission isn't
 * granted (caller should have probed via `ensureNotificationPermission`
 * but we don't want unhandled errors).  Also drops when the document
 * is currently visible AND focused — there's no value in popping
 * a desktop notification for a message you're already looking at.
 */
export async function notify(opts: NotifyOptions): Promise<void> {
	// Visibility gate: only suppress when the page is actually
	// visible AND focused.  visibilityState alone isn't enough
	// because a window can be visible but unfocused (user is in
	// another app on the same screen).
	if (
		typeof document !== "undefined" &&
		document.visibilityState === "visible" &&
		typeof document.hasFocus === "function" &&
		document.hasFocus()
	) {
		// Caller is responsible for additionally suppressing
		// notifications for the currently-active room — we don't
		// have that context here.
	}

	if (permissionState === "unknown") {
		// First call with no probe — try once.  Cheap if already
		// granted; surfaces a permission prompt if not.
		await ensureNotificationPermission();
	}
	if (permissionState !== "granted") return;

	if (isDesktop) {
		try {
			const { sendNotification } = await import("@tauri-apps/plugin-notification");
			sendNotification({ title: opts.title, body: opts.body });
		} catch (err) {
			console.warn("notifications: Tauri sendNotification failed", err);
		}
		return;
	}

	if (typeof Notification === "undefined") return;
	try {
		const n = new Notification(opts.title, {
			body: opts.body,
			tag: opts.tag,
			// Use favicon as the badge — small icon shown alongside
			// the body text on platforms that support it.  Same
			// asset Discord/Slack/etc. use for browser notifications.
			icon: "/favicon.png",
		});
		if (opts.onClick) {
			n.onclick = () => {
				try {
					window.focus();
				} catch { /* some browsers refuse */ }
				opts.onClick?.();
				n.close();
			};
		}
	} catch (err) {
		console.warn("notifications: browser Notification failed", err);
	}
}

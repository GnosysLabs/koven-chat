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

/**
 * Read the LIVE OS notification-permission state.  Don't cache —
 * `Notification.permission` is a property read (no IPC, no syscall)
 * and the user can change it at any time via browser settings,
 * site-info popovers, the Brave shield, etc.  Caching even briefly
 * means we miss the moment they grant it.
 */
async function currentPermission(): Promise<"granted" | "denied" | "default"> {
	if (isDesktop) {
		try {
			const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
			return (await isPermissionGranted()) ? "granted" : "default";
		} catch {
			return "default";
		}
	}
	if (typeof Notification === "undefined") return "denied";
	return Notification.permission;
}

/**
 * Surface the OS permission prompt the FIRST time the user signs in.
 * Idempotent — once already granted, becomes a no-op (the underlying
 * Notification.requestPermission resolves immediately when state is
 * "granted").  When state is "denied" we don't re-prompt either:
 * browsers ignore second-and-later requestPermission calls and the
 * user has to grant via site settings instead.
 *
 * Returns the resolved state so callers can decide whether to show
 * a fallback in-app affordance if denied.
 */
export async function ensureNotificationPermission(): Promise<"granted" | "denied" | "default"> {
	if (isDesktop) {
		try {
			const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
			if (await isPermissionGranted()) return "granted";
			const result = await requestPermission();
			return result === "granted" ? "granted" : "denied";
		} catch (err) {
			console.warn("notifications: Tauri permission probe failed", err);
			return "denied";
		}
	}
	if (typeof Notification === "undefined") return "denied";
	const cur = Notification.permission;
	if (cur === "granted" || cur === "denied") return cur;
	try {
		const result = await Notification.requestPermission();
		return result === "granted" ? "granted" : "denied";
	} catch (err) {
		console.warn("notifications: browser permission request failed", err);
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
	// Read the live OS permission — don't cache.  See currentPermission
	// above for why; tl;dr the user can flip the setting at any time
	// via browser site-info / Brave shields / OS notification center,
	// and a stale cached "denied" silently disables notifications even
	// though we'd otherwise be allowed to fire.
	const perm = await currentPermission();
	if (perm !== "granted") return;

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

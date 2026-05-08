// Koven service worker.
//
// Currently only does notifications — no offline cache, no push API,
// no fetch interception.  Why we have it at all: iOS Safari (both as
// a browser tab on iOS 16.4+ and as an installed PWA from 16.4+)
// REQUIRES `registration.showNotification(...)` to fire notifications;
// the page-side `new Notification(title, opts)` constructor doesn't
// work the same way and on installed PWAs is effectively a no-op.
// A minimal SW unblocks notifications across all browsers (the SW
// path also works fine on Chrome / Firefox / Safari desktop) and
// gives us a single notification code path to maintain.
//
// Adding more later (background sync, push subscription via Web Push,
// asset precaching for offline) means extending this file; the
// registration call in main.tsx stays unchanged.

self.addEventListener("install", () => {
	// Skip the standard waiting-for-old-client phase — we don't have
	// any breaking-change concerns since this SW is brand new and
	// future versions will just replace this one wholesale.
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	// Take control of all open SPA tabs immediately, so the very
	// first message that arrives after the SW activates can fire a
	// notification through it (rather than waiting for the next page
	// reload to claim the client).
	event.waitUntil(self.clients.claim());
});

// Notification click → focus an existing Koven tab + tell it to open
// the relevant room, OR open a fresh one at the room URL.  The roomId
// rides along in the notification's `data` payload, set by
// `lib/notifications.ts` when calling `registration.showNotification`.
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const data = event.notification.data || {};
	const roomId = typeof data.roomId === "string" ? data.roomId : null;

	event.waitUntil((async () => {
		const tabs = await self.clients.matchAll({
			type: "window",
			includeUncontrolled: true,
		});
		// Prefer focusing an existing tab — opening a duplicate is
		// jarring, especially on desktop where it'd sit alongside
		// the original.  The page handles `open-room` postMessage.
		for (const tab of tabs) {
			try {
				await tab.focus();
			} catch {
				// Some browsers throw when the SW can't bring the
				// tab forward (Safari sometimes refuses); ignore
				// and post the navigation message anyway.
			}
			if (roomId) {
				tab.postMessage({ type: "open-room", roomId });
			}
			return;
		}
		// No open tab → open a new one.  The room id can't be
		// expressed in the URL today (the SPA doesn't route by
		// room), so we just open the root and let the user land on
		// the default screen.
		if (self.clients.openWindow) {
			await self.clients.openWindow("/");
		}
	})());
});

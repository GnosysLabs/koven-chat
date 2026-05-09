// Typed client for the engine's /api/notifications surface.
//
// All requests are authenticated with the user's Matrix access
// token via Authorization: Bearer.  The engine validates via
// /whoami; this module doesn't keep its own auth state.

import { ENGINE_URL } from "@/lib/urls";

export type NotificationKind =
	| "dm"
	| "mention"
	| "reply"
	| "invite"
	| "system"
	// "message" — fired when the user has set the room's notification
	// level to "all messages" via the right-click menu, for any message
	// that wasn't already a DM/mention/reply.  Lets the user follow
	// every message in a room they care deeply about without having to
	// be @-mentioned.
	| "message";

export interface NotificationEntry {
	id: number;
	event_id: string;
	room_id: string;
	kind: NotificationKind;
	sender: string;
	snippet: string | null;
	created_at: number;
	read_at: number | null;
}

interface ListResponse {
	notifications: NotificationEntry[];
}

function authHeaders(accessToken: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${accessToken}`,
	};
}

/** Fetch a page of notifications.  Page boundary is exclusive on
 * `before` (the previous page's last `created_at`).  First page:
 * omit `before`.  `limit` clamps to [1, 200] server-side; we default
 * 50 here. */
export async function listNotifications(opts: {
	accessToken: string;
	limit?: number;
	before?: number;
}): Promise<NotificationEntry[]> {
	// Build query string by hand — `new URL()` throws when ENGINE_URL
	// is empty (the default in Vite dev where /api/* is proxied via
	// the dev server), and other modules in this codebase already
	// use plain string concat for the same reason.
	const params = new URLSearchParams();
	if (opts.limit !== undefined) params.set("limit", String(opts.limit));
	if (opts.before !== undefined) params.set("before", String(opts.before));
	const qs = params.toString();
	const url = `${ENGINE_URL}/api/notifications${qs ? `?${qs}` : ""}`;
	const r = await fetch(url, { headers: authHeaders(opts.accessToken) });
	if (!r.ok) throw new Error(`listNotifications: HTTP ${r.status}`);
	const body = (await r.json()) as ListResponse;
	return body.notifications;
}

/** Cheap point query — drives the bell badge count.  Polled every
 * ~30s by `useNotifications`. */
export async function fetchUnreadCount(accessToken: string): Promise<number> {
	const r = await fetch(`${ENGINE_URL}/api/notifications/unread-count`, {
		headers: authHeaders(accessToken),
	});
	if (!r.ok) throw new Error(`fetchUnreadCount: HTTP ${r.status}`);
	const body = (await r.json()) as { count: number };
	return body.count;
}

/** Mark one notification read.  Idempotent — re-running on an
 * already-read row or a row that was deleted is a no-op success. */
export async function markRead(opts: { accessToken: string; id: number }): Promise<void> {
	const r = await fetch(`${ENGINE_URL}/api/notifications/${opts.id}/read`, {
		method: "POST",
		headers: authHeaders(opts.accessToken),
	});
	if (!r.ok) throw new Error(`markRead: HTTP ${r.status}`);
}

/** Mark every unread notification read.  Returns the count updated
 * so the caller can optimistically zero its badge. */
export async function markAllRead(accessToken: string): Promise<number> {
	const r = await fetch(`${ENGINE_URL}/api/notifications/read-all`, {
		method: "POST",
		headers: authHeaders(accessToken),
	});
	if (!r.ok) throw new Error(`markAllRead: HTTP ${r.status}`);
	const body = (await r.json()) as { updated?: number };
	return body.updated ?? 0;
}

/** Mark every unread notification for `roomId` as read.  Used by the
 * bell when the user enters a room with the tab focused — accumulating
 * unread for a room they're actively viewing reads as broken. */
export async function markRoomRead(opts: {
	accessToken: string;
	roomId: string;
}): Promise<number> {
	const r = await fetch(`${ENGINE_URL}/api/notifications/read-by-room`, {
		method: "POST",
		headers: authHeaders(opts.accessToken),
		body: JSON.stringify({ room_id: opts.roomId }),
	});
	if (!r.ok) throw new Error(`markRoomRead: HTTP ${r.status}`);
	const body = (await r.json()) as { updated?: number };
	return body.updated ?? 0;
}

/** Hard-delete a single notification from the bell log.  Doesn't
 * affect the underlying Matrix event. */
export async function dismissNotification(opts: { accessToken: string; id: number }): Promise<void> {
	const r = await fetch(`${ENGINE_URL}/api/notifications/${opts.id}/dismiss`, {
		method: "POST",
		headers: authHeaders(opts.accessToken),
	});
	if (!r.ok) throw new Error(`dismissNotification: HTTP ${r.status}`);
}

/** Hard-delete every notification for the caller.  Used by the
 * "Clear all" affordance.  Returns the count deleted. */
export async function dismissAll(accessToken: string): Promise<number> {
	const r = await fetch(`${ENGINE_URL}/api/notifications/dismiss-all`, {
		method: "POST",
		headers: authHeaders(accessToken),
	});
	if (!r.ok) throw new Error(`dismissAll: HTTP ${r.status}`);
	const body = (await r.json()) as { deleted?: number };
	return body.deleted ?? 0;
}

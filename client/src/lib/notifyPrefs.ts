// Per-room notification level — client surface for the engine's
// /api/notify-prefs/rooms endpoints.
//
// Three levels:
//   - "all"      → fire on every message in this room (kind=message)
//   - "mentions" → DM/mention/reply only (current default)
//   - "muted"    → never fire, even on mentions
//
// In-memory cache holds the full overridden set, hydrated on app boot
// via the bulk GET.  Mutations write through to the engine + update
// the local cache so the right-click menu's checked state flips
// instantly.  Listeners let the sidebar (or any other UI) refresh
// when prefs change.

import { ENGINE_URL } from "@/lib/urls";

export type RoomNotifyLevel = "all" | "mentions" | "muted";

const cache: Map<string, RoomNotifyLevel> = new Map();
const listeners: Set<() => void> = new Set();
let hydrated = false;

function emit() {
	for (const fn of listeners) {
		try { fn(); } catch (err) { console.warn("notifyPrefs listener threw", err); }
	}
}

/** Subscribe to local cache changes.  Returns an unsubscribe. */
export function onNotifyPrefsChanged(fn: () => void): () => void {
	listeners.add(fn);
	return () => { listeners.delete(fn); };
}

/** Read the user's level for one room from the local cache.  Returns
 * the default 'mentions' when no override is recorded.  Cheap;
 * synchronous; safe to call on every render. */
export function getRoomNotifyLevel(roomId: string): RoomNotifyLevel {
	return cache.get(roomId) ?? "mentions";
}

/** Hydrate the cache from the engine.  Call once on app boot — the
 * sidebar and right-click menus depend on it.  Idempotent: repeated
 * calls re-fetch and overwrite the cache. */
export async function hydrateNotifyPrefs(accessToken: string): Promise<void> {
	try {
		const r = await fetch(`${ENGINE_URL}/api/notify-prefs/rooms`, {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (!r.ok) {
			console.warn(`hydrateNotifyPrefs: HTTP ${r.status}`);
			return;
		}
		const body = (await r.json()) as { rooms: Record<string, RoomNotifyLevel> };
		cache.clear();
		for (const [roomId, level] of Object.entries(body.rooms ?? {})) {
			if (level === "all" || level === "mentions" || level === "muted") {
				cache.set(roomId, level);
			}
		}
		hydrated = true;
		emit();
	} catch (err) {
		console.warn("hydrateNotifyPrefs: fetch failed", err);
	}
}

/** Set the user's level for one room.  Optimistic local update +
 * write-through to the engine.  Reverts on server error so the UI
 * doesn't stay out-of-sync with the server's view. */
export async function setRoomNotifyLevel(
	accessToken: string,
	roomId: string,
	level: RoomNotifyLevel,
): Promise<{ ok: boolean; error?: string }> {
	const prev = cache.get(roomId);
	if (level === "mentions") cache.delete(roomId);
	else cache.set(roomId, level);
	emit();
	try {
		const r = await fetch(
			`${ENGINE_URL}/api/notify-prefs/rooms/${encodeURIComponent(roomId)}`,
			{
				method: "PUT",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ level }),
			},
		);
		if (!r.ok) {
			// Revert on failure.
			if (prev === undefined) cache.delete(roomId);
			else cache.set(roomId, prev);
			emit();
			const body = (await r.json().catch(() => ({}))) as { error?: string };
			return { ok: false, error: body.error ?? `HTTP ${r.status}` };
		}
		return { ok: true };
	} catch (err) {
		if (prev === undefined) cache.delete(roomId);
		else cache.set(roomId, prev);
		emit();
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Bulk-set the level for every room in `roomIds`.  Used by the
 * space tile context menu's "Set notifications for all rooms in
 * space" action.  Fires N PUTs in parallel; partial failures are
 * tolerated (cache reflects the server's actual state via the
 * per-call revert logic).  Resolves when all calls have settled. */
export async function setRoomNotifyLevelBulk(
	accessToken: string,
	roomIds: string[],
	level: RoomNotifyLevel,
): Promise<void> {
	await Promise.all(roomIds.map(id => setRoomNotifyLevel(accessToken, id, level)));
}

/** Has the cache been hydrated yet?  False during the brief window
 * between transport.start and the first hydrateNotifyPrefs call —
 * lets UI suppress mute indicators until we have real data instead
 * of flashing "everything's mentions" briefly. */
export function isHydrated(): boolean {
	return hydrated;
}

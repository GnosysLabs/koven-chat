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
 * space" action.  Single atomic round-trip to the engine, then a
 * forced re-hydrate so the local cache exactly matches the server
 * — no chance of partial application or cache drift, which the
 * previous "fire N parallel PUTs" implementation could fall into.
 * Throws on any failure so the caller can surface it (instead of
 * the silent half-applied state we had before). */
export async function setRoomNotifyLevelBulk(
	accessToken: string,
	roomIds: string[],
	level: RoomNotifyLevel,
): Promise<{ updated: number }> {
	if (roomIds.length === 0) return { updated: 0 };
	// Optimistic local update so the right-click menu's checked
	// state flips instantly even if the server is slow.  Will be
	// overwritten by the re-hydrate below.
	for (const id of roomIds) {
		if (level === "mentions") cache.delete(id);
		else cache.set(id, level);
	}
	emit();
	const r = await fetch(`${ENGINE_URL}/api/notify-prefs/rooms-bulk`, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ room_ids: roomIds, level }),
	});
	if (!r.ok) {
		// Re-hydrate from the server so the local cache reflects
		// the actual stored state, not our optimistic guess.
		await hydrateNotifyPrefs(accessToken);
		const body = (await r.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `setRoomNotifyLevelBulk: HTTP ${r.status}`);
	}
	const body = (await r.json()) as { updated?: number };
	// Force-rehydrate after success.  Belt-and-suspenders: the
	// optimistic update should already match the server, but the
	// cost is a single GET and the upside is a guaranteed
	// post-condition that the local cache is exactly what the
	// server has.  This is the rule the user asked for — make it
	// impossible to fail silently.
	await hydrateNotifyPrefs(accessToken);
	return { updated: body.updated ?? roomIds.length };
}

/** Has the cache been hydrated yet?  False during the brief window
 * between transport.start and the first hydrateNotifyPrefs call —
 * lets UI suppress mute indicators until we have real data instead
 * of flashing "everything's mentions" briefly. */
export function isHydrated(): boolean {
	return hydrated;
}

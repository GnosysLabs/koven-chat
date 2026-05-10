// Local cache of the engine's Founders roster.
//
// The first 666 users get a Founder badge keyed to their numerical
// signup slot.  We surface the badge inline next to usernames in
// chat and member lists, which means every render path needs to
// answer "is this user a founder, and if so, which number" without
// hitting the network.
//
// Strategy: fetch the full roster (cap is 666 entries, ~30KB max)
// once on app boot, mirror it into a Map<userId, number>, and let
// every consumer read from the in-memory map synchronously.
// Refresh every few minutes to pick up new claims (a new signup
// landing while the user has the app open).  Listeners get notified
// on every refresh so React components can re-render.
//
// Cache also persists to localStorage so a cold app launch has
// instant data while the network refresh is in flight — bridge for
// the brief window between mount and first /api/founders response.

import { ENGINE_URL } from "@/lib/urls";

const STORAGE_KEY = "koven_founders_v1";
const REFRESH_MS = 5 * 60 * 1000; // 5 minutes

interface FoundersRoster {
	founders: Map<string, number>;
	cap: number;
	loadedAt: number;
}

interface PersistedShape {
	founders: Array<[string, number]>;
	cap: number;
	loadedAt: number;
}

let current: FoundersRoster = loadFromStorage() ?? {
	founders: new Map(),
	cap: 666,
	loadedAt: 0,
};
const listeners = new Set<() => void>();

function loadFromStorage(): FoundersRoster | null {
	try {
		const raw = typeof localStorage !== "undefined"
			? localStorage.getItem(STORAGE_KEY)
			: null;
		if (!raw) return null;
		const parsed = JSON.parse(raw) as PersistedShape;
		if (!Array.isArray(parsed.founders)) return null;
		const map = new Map<string, number>();
		for (const entry of parsed.founders) {
			if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number") {
				map.set(entry[0], entry[1]);
			}
		}
		return {
			founders: map,
			cap: typeof parsed.cap === "number" ? parsed.cap : 666,
			loadedAt: typeof parsed.loadedAt === "number" ? parsed.loadedAt : 0,
		};
	} catch {
		// Bad JSON / quota error — start fresh, the next refresh
		// will repopulate.
		return null;
	}
}

function persistToStorage(roster: FoundersRoster): void {
	try {
		const persisted: PersistedShape = {
			founders: Array.from(roster.founders.entries()),
			cap: roster.cap,
			loadedAt: roster.loadedAt,
		};
		localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
	} catch {
		// localStorage unavailable / over quota — in-memory cache
		// still works for the session.  Not worth surfacing.
	}
}

/** Synchronous lookup: returns the founder number for a given mxid,
 * or null if they don't have one.  Cheap — Map.get over at most 666
 * entries.  Render directly from this in chat / member rows. */
export function getCachedFounderNumber(userId: string): number | null {
	return current.founders.get(userId) ?? null;
}

/** Total cap (typically 666) for the "X of N" tooltip text.  Reads
 * from the last roster fetch; falls back to the hardcoded default. */
export function getFounderCap(): number {
	return current.cap;
}

/** Subscribe to roster updates.  Listener fires after every
 * successful refresh; React components wrap this in useSyncExternalStore
 * (or a useEffect + setState) to re-render badges as new founders
 * land mid-session. */
export function subscribeToFoundersRoster(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/** Pull the roster from the engine and replace the in-memory map.
 * Idempotent — safe to call concurrently (last writer wins, both
 * land at the same data anyway).  Errors swallow into a console
 * warning; we never want a missing badge to break rendering. */
export async function refreshFoundersRoster(): Promise<void> {
	try {
		const r = await fetch(`${ENGINE_URL}/api/founders`, {
			credentials: "omit",
		});
		if (!r.ok) {
			console.warn(`founders-cache: GET /api/founders → ${r.status}`);
			return;
		}
		const body = (await r.json()) as {
			founders?: Array<{ user_id?: string; founder_number?: number }>;
			cap?: number;
		};
		const map = new Map<string, number>();
		for (const f of body.founders ?? []) {
			if (typeof f.user_id === "string" && typeof f.founder_number === "number") {
				map.set(f.user_id, f.founder_number);
			}
		}
		const cap = typeof body.cap === "number" ? body.cap : 666;
		current = { founders: map, cap, loadedAt: Date.now() };
		persistToStorage(current);
		for (const listener of listeners) listener();
	} catch (err) {
		console.warn("founders-cache: refresh threw", err);
	}
}

/** Called once from App.tsx on mount.  Fires an immediate refresh
 * + a recurring 5-minute interval, returns a cleanup that clears
 * the interval.  Idempotent — if the cache was already hydrated
 * from localStorage, the immediate refresh just confirms or
 * extends it without disrupting anything. */
export function startFoundersRosterRefresh(): () => void {
	void refreshFoundersRoster();
	const id = window.setInterval(() => {
		void refreshFoundersRoster();
	}, REFRESH_MS);
	return () => window.clearInterval(id);
}

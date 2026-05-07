// React hook + module-level cache for reading a user's reputation
// weight from the Koven engine.  The engine exposes a point lookup
// at GET /api/weight/:userId; we hit it on first render and cache the
// result for a minute so a chat pane rendering 50 messages doesn't
// fan out 50 requests.
//
// One in-flight Promise per userId — concurrent callers share it,
// which collapses N rapid mounts into a single fetch.

import { useEffect, useState } from "react";
import type { ReputationData } from "@/lib/reputation";
import { ENGINE_URL } from "@/lib/urls";
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
	at: number;
	data: ReputationData;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ReputationData>>();

async function fetchWeight(userId: string): Promise<ReputationData> {
	const url = `${ENGINE_URL}/api/weight/${encodeURIComponent(userId)}`;
	const r = await fetch(url, { credentials: "omit" });
	if (!r.ok) throw new Error(`engine /api/weight ${userId} → ${r.status}`);
	return (await r.json()) as ReputationData;
}

export function getReputation(userId: string): ReputationData | null {
	const entry = cache.get(userId);
	if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry.data;
	return null;
}

export function loadReputation(userId: string): Promise<ReputationData> {
	const cached = getReputation(userId);
	if (cached) return Promise.resolve(cached);
	const existing = inflight.get(userId);
	if (existing) return existing;
	const p = fetchWeight(userId)
		.then(data => {
			cache.set(userId, { at: Date.now(), data });
			inflight.delete(userId);
			return data;
		})
		.catch(err => {
			inflight.delete(userId);
			throw err;
		});
	inflight.set(userId, p);
	return p;
}

/**
 * Subscribe to a user's reputation.  Returns the cached value if any
 * (so first render isn't blank when many components ask for the same
 * user) and updates as the fetch completes.
 */
export function useReputation(userId: string | null | undefined): ReputationData | null {
	const [data, setData] = useState<ReputationData | null>(() =>
		userId ? getReputation(userId) : null,
	);

	useEffect(() => {
		if (!userId) { setData(null); return; }
		const cached = getReputation(userId);
		if (cached) {
			setData(cached);
			return;
		}
		let cancelled = false;
		loadReputation(userId)
			.then(d => { if (!cancelled) setData(d); })
			.catch(() => {
				// Engine offline / transient error — leave it null and
				// the UI renders the default (no badge).  Logging here
				// would be noisy across many users.
			});
		return () => { cancelled = true; };
	}, [userId]);

	return data;
}

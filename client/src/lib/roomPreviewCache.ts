// Session-lifetime cache for room/space preview metadata fetched
// via transport.previewTarget — used by inline room-mention pills
// (and the JoinConfirmSheet's "no local data" branch) so multiple
// pills referencing the same target share one HTTP request and
// re-render cheaply on cache hit.
//
// Three states per id:
//   - Not in cache → first read triggers a fetch.
//   - In cache as object → resolved preview, render with metadata.
//   - In cache as null → previewTarget returned null (private,
//     federated-but-unreachable, or transport error).  Cached so
//     we don't retry every render.
//
// Concurrency: a single in-flight Promise per id deduplicates
// parallel calls.  Useful when a message renders + a JoinConfirmSheet
// opens for the same target — both kick off useRoomPreview and we
// only hit Synapse once.
//
// Privacy note: getRoomSummary (MSC3266) calls the LOCAL Synapse,
// not the federated server directly.  Synapse decides whether to
// federate-fetch from a remote server based on its own settings
// (which on Koven means: only between Koven instances that pass
// the federation gate).  So the client's privacy footprint here
// is exactly "you trust your homeserver" — same as every other
// SDK call.
//
// Subscription mechanism: useRoomPreview wants to re-render when
// a cache entry resolves, but cache entries can resolve while a
// component is mid-mount (between the render and the effect).
// Per-id subscriber sets fire after every write so all components
// looking at the same id get the update.  Subscribers Map cleans
// up via the unsubscribe returned from `subscribe`.

import { useEffect, useReducer } from "react";
import type { MatrixTransport } from "@/lib/matrix";

export interface RoomPreview {
	roomId: string;
	name: string;
	topic?: string;
	avatarUrl?: string;
	memberCount?: number;
	isSpace: boolean;
	nsfw?: boolean;
}

const cache = new Map<string, RoomPreview | null>();
const inflight = new Map<string, Promise<void>>();
const subscribers = new Map<string, Set<() => void>>();

function notify(id: string): void {
	const subs = subscribers.get(id);
	if (!subs) return;
	for (const cb of subs) cb();
}

/** Synchronous cache read.  Returns the cached value (object or
 * null), or `undefined` when the id has never been fetched. */
export function getCachedRoomPreview(id: string): RoomPreview | null | undefined {
	return cache.has(id) ? cache.get(id)! : undefined;
}

/** Fire-and-forget fetch.  No-op if the id is already cached or
 * an in-flight fetch exists for it.  Returns a promise the caller
 * can await if they need to. */
export function fetchRoomPreview(transport: MatrixTransport, id: string): Promise<void> {
	if (cache.has(id)) return Promise.resolve();
	const existing = inflight.get(id);
	if (existing) return existing;
	const p = transport.previewTarget(id)
		.then(preview => {
			cache.set(id, preview);
			inflight.delete(id);
			notify(id);
		})
		.catch(err => {
			console.warn("roomPreviewCache: fetch failed", id, err);
			cache.set(id, null);
			inflight.delete(id);
			notify(id);
		});
	inflight.set(id, p);
	return p;
}

/** Manually seed the cache.  Useful when the SPA already has
 * locally-known data (e.g. the Room is in the user's joined list)
 * and we want pills for that id to render synchronously without a
 * redundant network fetch. */
export function seedRoomPreview(id: string, preview: RoomPreview): void {
	cache.set(id, preview);
	notify(id);
}

/** Drop a cache entry — used when the cached value would be stale
 * (e.g. user just joined a room, name might have changed since
 * the directory snapshot we cached).  Forces the next consumer to
 * re-fetch. */
export function invalidateRoomPreview(id: string): void {
	if (!cache.delete(id)) return;
	notify(id);
}

/** Hook for components that want to render based on a target's
 * preview.  Returns the current cached value (object / null /
 * undefined-meaning-loading) and kicks off a fetch if needed.
 *
 * The component re-renders when the cache entry for this id
 * changes, via a per-id subscriber set; pills referencing
 * different ids don't churn each other.
 */
export function useRoomPreview(target: string | null | undefined): RoomPreview | null | undefined {
	const [, force] = useReducer((x: number) => x + 1, 0);
	useEffect(() => {
		if (!target) return;
		// Always subscribe (even if cache is already populated) so
		// late seeds / invalidations still trigger this consumer.
		if (!subscribers.has(target)) subscribers.set(target, new Set());
		subscribers.get(target)!.add(force);
		return () => {
			subscribers.get(target)?.delete(force);
		};
	}, [target]);
	return target ? getCachedRoomPreview(target) : undefined;
}

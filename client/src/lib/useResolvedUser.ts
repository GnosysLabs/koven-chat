// Resolve a Matrix user id to {displayName, avatarMxc} via matrix-
// js-sdk's profile API.  Designed for "I'm rendering many references
// to user ids and want display names instead of mxids."
//
// Caching:
//   - matrix-js-sdk's `getUser(mxid)` is checked first — populated
//     for everyone we've seen via /sync, returns synchronously.
//   - For users NOT in the SDK cache (mod log refers to people who
//     left the room, federated participants we haven't synced, etc.)
//     we fall back to an HTTP `getProfileInfo` call.  Results are
//     memoised in a module-level Map keyed by userId so the second
//     UserInline mounting for the same id doesn't re-fetch.
//
// Falls back to the bare localpart when no display name is set.  Never
// returns the full `@user:server` mxid — the whole point is to avoid
// rendering noisy handles in the UI.

import { useEffect, useState } from "react";
import type { MatrixTransport } from "@/lib/matrix";

export interface ResolvedUser {
	displayName: string;
	avatarMxc?: string;
}

const CACHE = new Map<string, ResolvedUser>();
// In-flight promises so two callers requesting the same id at once
// share a single network round-trip.
const PENDING = new Map<string, Promise<ResolvedUser>>();

function localpartFromMxid(mxid: string): string {
	if (!mxid.startsWith("@")) return mxid;
	const colon = mxid.indexOf(":");
	return colon > 1 ? mxid.slice(1, colon) : mxid.slice(1);
}

function snapshotFromSdk(transport: MatrixTransport | null, userId: string): ResolvedUser | undefined {
	const u = transport?.getSdkUser?.(userId);
	if (!u) return undefined;
	const dn = (u.displayName ?? "").trim();
	const mxc = u.avatarUrl;
	if (!dn && !mxc) return undefined;
	return {
		displayName: dn || localpartFromMxid(userId),
		avatarMxc: typeof mxc === "string" && mxc.length > 0 ? mxc : undefined,
	};
}

async function fetchAndCache(
	transport: MatrixTransport,
	userId: string,
): Promise<ResolvedUser> {
	const existing = CACHE.get(userId);
	if (existing) return existing;
	const inFlight = PENDING.get(userId);
	if (inFlight) return inFlight;
	const p = (async () => {
		try {
			const profile = await transport.getUserProfile(userId as never);
			const resolved: ResolvedUser = {
				displayName: profile.displayName?.trim() || localpartFromMxid(userId),
				avatarMxc: profile.avatarUrl,
			};
			CACHE.set(userId, resolved);
			return resolved;
		} catch {
			// Profile lookup failed (404 for nonexistent user, federation
			// outage, etc.).  Fall back to localpart and DON'T cache the
			// failure — next attempt may succeed.
			return { displayName: localpartFromMxid(userId) };
		} finally {
			PENDING.delete(userId);
		}
	})();
	PENDING.set(userId, p);
	return p;
}

/** Synchronous read for a single user.  Returns the SDK-cached or
 * previously-fetched user, otherwise undefined.  Use this when you
 * need a value during render and can fall back gracefully on miss. */
export function useResolvedUser(
	transport: MatrixTransport | null,
	userId: string | undefined,
): ResolvedUser | undefined {
	// Initial value: synchronous SDK lookup; falls back to module
	// cache.  React keeps this stable across renders so we don't
	// flicker between "have data" / "no data" while the async fetch
	// runs.
	const initial = userId
		? (snapshotFromSdk(transport, userId) ?? CACHE.get(userId))
		: undefined;
	const [resolved, setResolved] = useState<ResolvedUser | undefined>(initial);

	useEffect(() => {
		if (!transport || !userId) return;
		// If we already have a name, we're good — but still re-check
		// the SDK in case its cache filled in the meantime.
		const sdk = snapshotFromSdk(transport, userId);
		if (sdk) {
			setResolved(prev => prev?.displayName === sdk.displayName && prev.avatarMxc === sdk.avatarMxc ? prev : sdk);
			return;
		}
		const cached = CACHE.get(userId);
		if (cached) {
			setResolved(cached);
			return;
		}
		let cancelled = false;
		fetchAndCache(transport, userId).then(r => {
			if (!cancelled) setResolved(r);
		});
		return () => { cancelled = true; };
	}, [transport, userId]);

	return resolved;
}

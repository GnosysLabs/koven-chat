// Persist + restore the user's "where am I" state across page
// refreshes — which space they were viewing and which room (if any)
// was open inside it.  Without this, every refresh dumps the user
// back at the Rooms tab with no room selected, which is jarring
// when you reload mid-conversation.
//
// Scoped per Matrix user id so multi-account installs don't leak
// state across accounts: signing in as @alice shouldn't show you
// @bob's last-open room.
//
// Active space is a discriminated union (`{ kind: "rooms" }` /
// `{ kind: "dms" }` / `{ kind: "explore" }` / `{ kind: "bots" }` /
// `{ kind: "space"; id: SpaceId }`).  We serialise the whole shape
// and validate on read so a stale or corrupt entry can't crash the
// boot path.

import type { ActiveSpace } from "@/state/store";
import type { RoomId } from "@koven/shared";

const KEY_PREFIX = "koven:session-view:";

interface PersistedView {
	activeSpace: ActiveSpace;
	activeRoomId: RoomId | null;
}

/** localStorage key for one user.  Per-user scoping prevents a
 * second account from inheriting the first account's last view. */
function keyFor(userId: string): string {
	return `${KEY_PREFIX}${userId}`;
}

/** Persist the current view for `userId`.  Best-effort — failures
 * (private mode, full storage, disabled localStorage) silently
 * no-op so a broken storage layer can't break the SPA. */
export function saveView(userId: string, view: PersistedView): void {
	try {
		localStorage.setItem(keyFor(userId), JSON.stringify(view));
	} catch {
		// no-op
	}
}

/** Read the persisted view for `userId`.  Returns null when nothing
 * is stored, the JSON is corrupt, or the shape doesn't validate.
 * Caller is responsible for further validating that the referenced
 * roomId / spaceId still exists in the user's joined set before
 * applying — a stored room id for a room the user has since left
 * shouldn't navigate them into a missing room. */
export function loadView(userId: string): PersistedView | null {
	try {
		const raw = localStorage.getItem(keyFor(userId));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<PersistedView>;
		if (!parsed || typeof parsed !== "object") return null;
		// activeSpace can legitimately be null (no virtual tab
		// selected — we treat that as "rooms tab" by default but
		// the type allows it).  null is valid; non-null must be a
		// {kind} discriminated-union member we recognise.
		const space = parsed.activeSpace ?? null;
		if (space !== null) {
			if (typeof space !== "object" || typeof (space as { kind?: unknown }).kind !== "string") return null;
			const kind = (space as { kind: string }).kind;
			// Activate-space kinds we know about.  Unknown values
			// (added in a later release, then downgrade to this
			// build) get rejected so dispatch can't crash on them.
			if (!["rooms", "dms", "explore", "bots", "space", "spaces_overview"].includes(kind)) return null;
			if (kind === "space" && typeof (space as { id?: unknown }).id !== "string") return null;
		}
		const roomId = parsed.activeRoomId === null
			? null
			: typeof parsed.activeRoomId === "string"
				? parsed.activeRoomId as RoomId
				: null;
		return {
			activeSpace: (space as ActiveSpace) ?? null,
			activeRoomId: roomId,
		};
	} catch {
		return null;
	}
}

/** Clear the persisted view for `userId`.  Used on sign-out so the
 * next sign-in (potentially as a different user) starts fresh. */
export function clearView(userId: string): void {
	try {
		localStorage.removeItem(keyFor(userId));
	} catch {
		// no-op
	}
}

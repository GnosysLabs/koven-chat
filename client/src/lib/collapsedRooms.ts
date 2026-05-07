// Collapsed-room display override.  When the community (or a floor
// flag) collapses a room's name via the /api/rooms/:id/flag pipeline,
// the engine records the decision and exposes the list at
// /api/rooms/collapsed.  Every place we render a room name in the SPA
// — sidebar, chat header, member sheets, Explore — substitutes
// `COLLAPSED_NAME` for the verbatim name when the id is in the set.
//
// We don't mutate `m.room.name` in Matrix state on collapse; the
// original is preserved on the engine so an admin reverse can restore
// it verbatim.  The override is purely a display concern, which is why
// it ships as a hook + a string-mapper rather than baked into the
// Room type.

import { useCallback, useEffect, useState } from "react";
import { fetchCollapsedRooms } from "@/lib/instance";

/** The placeholder text every collapsed room name renders as.  Kept
 * here so the spelling stays consistent across surfaces — drift like
 * "Removed by Review" vs. "Name Removed" would look like a bug. */
export const COLLAPSED_NAME = "Name Removed by Community Review";

export interface CollapsedRoomsState {
	/** Set of room ids currently flagged as collapsed by the engine.
	 * Empty until the first fetch completes — `displayRoomName` returns
	 * the original name during the brief loading window, which is the
	 * right default (we err on showing more rather than less). */
	ids: Set<string>;
	/** Force a re-poll.  Called on demand when something has just
	 * changed (the user submitted a flag, the user is on the admin
	 * floor queue and just confirmed/reversed a case). */
	refresh: () => Promise<void>;
}

/** Poll /api/rooms/collapsed periodically + expose the current Set.
 *
 * Refresh cadence: every 5 min by default + on tab refocus (collapses
 * are rare enough that this is plenty; the engine emits a
 * chat.koven.collapse.v1 event in the room itself, which the SPA's
 * existing event listener picks up — but for non-members of the
 * collapsed room, this poll is the only signal). */
export function useCollapsedRooms(): CollapsedRoomsState {
	const [ids, setIds] = useState<Set<string>>(new Set());

	const refresh = useCallback(async () => {
		try {
			const rooms = await fetchCollapsedRooms();
			setIds(new Set(rooms.map(r => r.room_id)));
		} catch {
			// Best-effort; leave the existing set in place if the engine
			// is briefly unreachable rather than flicker rooms back to
			// their original names mid-poll.
		}
	}, []);

	useEffect(() => {
		void refresh();
		const id = window.setInterval(() => { void refresh(); }, 5 * 60 * 1000);
		const onFocus = () => { void refresh(); };
		window.addEventListener("focus", onFocus);
		return () => {
			window.clearInterval(id);
			window.removeEventListener("focus", onFocus);
		};
	}, [refresh]);

	return { ids, refresh };
}

/** Resolve the display name for a room given the current collapsed
 * set.  Pass the Set, not a Map — collapse decisions are binary at the
 * display layer (collapsed → placeholder, otherwise → original).  The
 * original name is still stored on the engine for admin reverse. */
export function displayRoomName(
	room: { id: string; name: string },
	collapsedIds: Set<string>,
): string {
	return collapsedIds.has(room.id) ? COLLAPSED_NAME : room.name;
}

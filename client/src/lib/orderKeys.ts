// Order-key helpers for drag-and-drop in the sidebar.
//
// Each `m.space.child` event carries an optional `order` field (per
// MSC1772 + the Matrix room version 12 spec) — a string sorted
// lexicographically.  When the user drags a room to a new position
// we need to assign it an order string that falls between its new
// neighbours' keys, ideally without rewriting every other room's
// order in the process.
//
// `fractional-indexing` is the standard solution: each generated
// key is a base-62 string that midpoints between two anchors.  The
// library exposes a single `generateKeyBetween(a, b)` function:
//   - both anchors null → "a0" (the starting key)
//   - first null, second "a0" → "Zz"
//   - first "a0", second null → "a1"
//   - both set → lexicographic midpoint
// It throws if the anchors aren't strictly ordered, which is the
// correct behaviour: dnd-kit guarantees ordered neighbours when we
// pass them in the right slot.

import { generateKeyBetween } from "fractional-indexing";

/** Compute the new order string for a room dropped between two
 * existing rooms.  Pass `undefined` for either anchor when the
 * room is being placed at the top (no before) or bottom (no after)
 * of the list.  Returns a sort key that's < `after` and > `before`
 * (or anchored against the open end). */
export function orderKeyBetween(
	before: string | undefined,
	after: string | undefined,
): string {
	// The library's contract uses null for missing anchors.  We use
	// undefined in our codebase because that's how the `order` field
	// is typed everywhere else; translate at the boundary.
	return generateKeyBetween(before ?? null, after ?? null);
}

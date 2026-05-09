// Tiny external store that lets any component "claim" extra bottom
// padding for the floating notification bell.
//
// The bell is a viewport-fixed FAB at bottom-right, but some panes
// (the bot edit form's sticky footer is the canonical case) put
// their own action buttons in the same corner.  Without this, the
// bell sits on top of "Cancel / Create bot".
//
// Pattern: each component that needs the bell out of the way calls
// `claimBellOffset(id, px)` on mount and `releaseBellOffset(id)` on
// unmount.  The bell renders with `bottom = base + max(claims)` so
// the largest claim wins (e.g. multiple sheets stacked don't add).
//
// External-store style (subscribe / getSnapshot) so the bell can
// react with `useSyncExternalStore` and we don't need a Provider in
// the tree — useful because the bell renders into a portal and may
// not share the React tree with the claimant.

import { useSyncExternalStore } from "react";

const claims = new Map<string, number>();
const listeners = new Set<() => void>();
let cachedMax = 0;

function recompute(): void {
	let max = 0;
	for (const v of claims.values()) {
		if (v > max) max = v;
	}
	if (max !== cachedMax) {
		cachedMax = max;
		for (const l of listeners) l();
	}
}

export function claimBellOffset(id: string, px: number): void {
	claims.set(id, px);
	recompute();
}

export function releaseBellOffset(id: string): void {
	if (claims.delete(id)) recompute();
}

function subscribe(l: () => void): () => void {
	listeners.add(l);
	return () => { listeners.delete(l); };
}

function getSnapshot(): number {
	return cachedMax;
}

/** React hook — returns the current max claimed offset in px.  Use
 * inside components that lay out alongside the bell (the bell itself,
 * or anything that needs to know how much vertical space the FAB has
 * been pushed to). */
export function useBellOffset(): number {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

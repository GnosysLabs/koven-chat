// React hook that owns the bell's state.
//
// Two concerns:
//
//   1. Unread badge.  Polled cheaply (~30s) so the bell can light up
//      without the user opening it.  On focus / visibility-change we
//      poll immediately so a backgrounded tab catches up the moment
//      it returns.
//
//   2. Full list.  Fetched on bell open + after any
//      mutation (mark-read, dismiss).  Not polled — the unread
//      counter alone tells us "there's new stuff", and refreshing the
//      list is cheap to do reactively.
//
// Auth: pass the user's Matrix access token in.  The hook becomes a
// no-op until a token is provided (so it can mount before login
// without exploding).

import { useCallback, useEffect, useRef, useState } from "react";
import {
	dismissAll as apiDismissAll,
	dismissNotification as apiDismiss,
	fetchUnreadCount,
	listNotifications,
	markAllRead as apiMarkAllRead,
	markRead as apiMarkRead,
	markRoomRead as apiMarkRoomRead,
	type NotificationEntry,
} from "@/lib/notifications-api";

const POLL_MS = 30_000;
const PAGE_SIZE = 50;

export interface UseNotificationsResult {
	unreadCount: number;
	entries: NotificationEntry[];
	loading: boolean;
	error: string | null;
	/// Force-refresh both the unread counter and the list.  Called
	/// whenever the bell is opened so the user always sees fresh data
	/// without needing to wait for the next 30s poll tick.
	refresh: () => Promise<void>;
	/// Mark a single entry read on the server, then optimistically
	/// update local state.  No-op success on a row that's already
	/// read or deleted.
	markRead: (id: number) => Promise<void>;
	markAllRead: () => Promise<void>;
	dismiss: (id: number) => Promise<void>;
	dismissAll: () => Promise<void>;
}

export function useNotifications(
	accessToken: string | null,
	activeRoomId: string | null = null,
): UseNotificationsResult {
	const [unreadCount, setUnreadCount] = useState(0);
	const [entries, setEntries] = useState<NotificationEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Latest token in a ref so the polling loop's setInterval doesn't
	// have to re-bind every render.  Keeping the loop stable means we
	// don't double-fire on rapid prop changes.
	const tokenRef = useRef<string | null>(accessToken);
	useEffect(() => { tokenRef.current = accessToken; }, [accessToken]);
	const activeRoomIdRef = useRef<string | null>(activeRoomId);
	useEffect(() => { activeRoomIdRef.current = activeRoomId; }, [activeRoomId]);

	const refresh = useCallback(async () => {
		const t = tokenRef.current;
		if (!t) {
			setUnreadCount(0);
			setEntries([]);
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const [count, list] = await Promise.all([
				fetchUnreadCount(t),
				listNotifications({ accessToken: t, limit: PAGE_SIZE }),
			]);
			setUnreadCount(count);
			setEntries(list);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	// Poll the unread count.  Cheaper than refetching the full list,
	// and the list is reactively pulled when the bell opens or after
	// a mutation.
	useEffect(() => {
		if (!accessToken) {
			setUnreadCount(0);
			setEntries([]);
			return;
		}

		let cancelled = false;
		const pollOnce = async () => {
			const t = tokenRef.current;
			if (!t) return;
			try {
				const count = await fetchUnreadCount(t);
				if (!cancelled) setUnreadCount(count);
			} catch {
				// Transient — leave the previous count alone.  A real
				// problem will re-surface on the next tick or on the
				// next user-initiated refresh.
			}
		};

		void pollOnce(); // immediate so the badge isn't stale on mount
		const id = window.setInterval(pollOnce, POLL_MS);

		// Re-poll when the tab regains visibility / focus — gets a
		// backgrounded user a current count immediately rather than
		// waiting up to POLL_MS for the next interval tick.
		const onVisible = () => {
			if (typeof document === "undefined" || document.visibilityState !== "visible") return;
			void pollOnce();
		};
		document.addEventListener("visibilitychange", onVisible);
		window.addEventListener("focus", onVisible);

		return () => {
			cancelled = true;
			window.clearInterval(id);
			document.removeEventListener("visibilitychange", onVisible);
			window.removeEventListener("focus", onVisible);
		};
	}, [accessToken]);

	const markRead = useCallback(async (id: number) => {
		const t = tokenRef.current;
		if (!t) return;
		// Optimistic — flip read_at locally before the round-trip.
		setEntries(prev => prev.map(e => e.id === id && !e.read_at ? { ...e, read_at: Date.now() } : e));
		setUnreadCount(c => Math.max(0, c - 1));
		try {
			await apiMarkRead({ accessToken: t, id });
		} catch (e) {
			// Reconcile by re-pulling truth.  Better than leaving the
			// optimistic write to drift if the server rejected it.
			setError(e instanceof Error ? e.message : String(e));
			void refresh();
		}
	}, [refresh]);

	const markAllRead = useCallback(async () => {
		const t = tokenRef.current;
		if (!t) return;
		const now = Date.now();
		setEntries(prev => prev.map(e => e.read_at ? e : { ...e, read_at: now }));
		setUnreadCount(0);
		try {
			await apiMarkAllRead(t);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			void refresh();
		}
	}, [refresh]);

	const dismiss = useCallback(async (id: number) => {
		const t = tokenRef.current;
		if (!t) return;
		// Stash the row in case we have to re-insert on failure.
		const prev = entries;
		const removed = prev.find(e => e.id === id);
		setEntries(prev.filter(e => e.id !== id));
		if (removed && removed.read_at === null) {
			setUnreadCount(c => Math.max(0, c - 1));
		}
		try {
			await apiDismiss({ accessToken: t, id });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			void refresh();
		}
	}, [entries, refresh]);

	const dismissAll = useCallback(async () => {
		const t = tokenRef.current;
		if (!t) return;
		setEntries([]);
		setUnreadCount(0);
		try {
			await apiDismissAll(t);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			void refresh();
		}
	}, [refresh]);

	// In-room suppression — when the user is actively viewing a
	// room with the tab focused + visible, treat any unread for
	// that room as already-seen.  They're literally watching the
	// messages land in real time; accumulating bell unread for the
	// room they're staring at reads as broken.
	//
	// Same gate as the OS-notification path's `looking` check in
	// App.tsx — symmetric behavior so the two surfaces don't
	// disagree about whether a given event was "seen."
	//
	// Implementation: one bulk `read-by-room` call when the gate
	// flips true, OR when entries update (a new message arrived
	// in the active room).  Optimistically zero local state for
	// the room so the badge doesn't flicker.  Listens to focus +
	// visibility events so toggling away → toggling back → still
	// in-room re-runs the clear.
	useEffect(() => {
		if (!accessToken || !activeRoomId) return;

		// Read live focus / visibility — `document.hasFocus()` and
		// `visibilityState` are both cheap property reads, no
		// caching, so we don't have to subscribe just to read
		// (we DO subscribe below to retrigger on changes).
		const isLooking = () => {
			if (typeof document === "undefined") return false;
			if (document.visibilityState !== "visible") return false;
			if (typeof document.hasFocus === "function" && !document.hasFocus()) return false;
			return true;
		};

		const clearIfLooking = async () => {
			if (!isLooking()) return;
			const t = tokenRef.current;
			const room = activeRoomIdRef.current;
			if (!t || !room) return;

			// Read CURRENT entries via setEntries' updater to avoid
			// closing over a stale snapshot, AND only mutate state
			// if there's actually something to clear.  Returning
			// `prev` unchanged when there are no unread rows for
			// this room is critical — otherwise we'd hand React a
			// new array reference every run, the effect would
			// re-fire (entries changed), call this again, hand
			// React another new reference… an infinite loop that
			// hammers /read-by-room and starves the connection
			// pool that matrix-js-sdk's /sync, /send, /receipt,
			// /profile calls share.  THIS WAS A SHIPPED BUG.
			let cleared = 0;
			const now = Date.now();
			setEntries(prev => {
				let mutated = false;
				const next = prev.map(e => {
					if (e.room_id === room && e.read_at === null) {
						cleared++;
						mutated = true;
						return { ...e, read_at: now };
					}
					return e;
				});
				return mutated ? next : prev;
			});

			// Bail without firing the API call when nothing changed
			// — same anti-loop reasoning, and saves a wasted RTT.
			if (cleared === 0) return;

			setUnreadCount(c => Math.max(0, c - cleared));
			try {
				await apiMarkRoomRead({ accessToken: t, roomId: room });
			} catch {
				// Best-effort.  If it fails, the optimistic update
				// will get reconciled on the next poll tick or
				// next refresh().
			}
		};

		// Run immediately (in case we entered the room while it
		// already had unread entries, or the user just gained
		// focus on a tab that was already on this room).
		void clearIfLooking();

		// Re-run when focus / visibility flips back to "looking".
		const onFocus = () => void clearIfLooking();
		document.addEventListener("visibilitychange", onFocus);
		window.addEventListener("focus", onFocus);
		return () => {
			document.removeEventListener("visibilitychange", onFocus);
			window.removeEventListener("focus", onFocus);
		};
		// `entries` IS in deps — combined with setEntries returning
		// the same reference when nothing changed, this gives us:
		//   - new unread arrives in active room → effect fires →
		//     clearIfLooking flips it to read, fires API call,
		//     setEntries returns NEW array (mutation happened),
		//     React re-renders, effect fires AGAIN, clearIfLooking
		//     finds nothing to clear, setEntries returns prev (same
		//     identity), React skips re-render, loop stops.  One
		//     extra effect run but bounded.
		//   - poll tick returns identical entries → setEntries
		//     receives a new array from the API but only updates
		//     state if it differs from current; effect fires but
		//     immediately bails (cleared=0).
	}, [accessToken, activeRoomId, entries]);

	return { unreadCount, entries, loading, error, refresh, markRead, markAllRead, dismiss, dismissAll };
}

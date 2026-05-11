// App-level listener for incoming DM call rings.  Subscribes to
// every joined room's timeline via transport.onCallEvent and
// surfaces an IncomingRingSheet when a `chat.koven.call.ring`
// event arrives in a DM where the sender is the other peer.
//
// Lifecycle:
//   - ring received → push into local state, start a 30s timer
//   - cancel received (matching ring_event_id) → drop the ring
//   - timer fires → drop the ring (caller didn't follow up)
//   - user clicks Accept → mint token + startCall (same flow as
//     the Live bar's Join button), drop the ring
//   - user clicks Decline → send chat.koven.call.decline back to
//     the room (referencing ring_event_id), drop the ring
//
// Multiple incoming rings are supported (someone calls you in DM
// A while DM B is also ringing) but in practice only one will be
// shown at a time — the most recent one wins on render.  v2 could
// stack them.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	useCall,
	RING_EVENT_TYPE,
	RING_CANCEL_EVENT_TYPE,
	RING_TIMEOUT_MS,
} from "@/lib/call-context";
import { joinCall as joinCallApi, CallApiError } from "@/lib/calls-api";
import { sendCallEventRaw } from "@/components/voice/sendCallEventRaw";
import { IncomingRingSheet } from "@/components/voice/IncomingRingSheet";
import type { MatrixTransport } from "@/lib/matrix";
import type { Room, RoomId, UserId, EventId } from "@koven/shared";

export interface IncomingRingListenerProps {
	transport: MatrixTransport | null;
	rooms: Room[];
	currentUserId: UserId | null;
	accessToken: string | null;
	// Navigate the user into the DM room when they accept a ring.
	// Distinct from App.tsx's `navigateToRoom` helper because we
	// DON'T want to flip inCallView=false here — the user just
	// answered a call, they want the call view, not chat.  App
	// passes a function that only dispatches set_active_room.
	onAcceptedNavigate(roomId: RoomId): void;
}

interface IncomingRing {
	ringEventId: EventId;
	roomId: RoomId;
	roomName: string;
	callerId: UserId;
	callerDisplayName: string;
	callerAvatarMxc: string | undefined;
	receivedAt: number;
}

export function IncomingRingListener({
	transport, rooms, currentUserId, accessToken, onAcceptedNavigate,
}: IncomingRingListenerProps) {
	const call = useCall();
	const [activeRing, setActiveRing] = useState<IncomingRing | null>(null);

	// Build a quick lookup of roomId → room so the listener (which
	// fires from outside React) can resolve room metadata
	// synchronously when an event arrives.  Keep stable across
	// re-renders so the listener identity stays the same.
	const roomsById = useMemo(() => {
		const m = new Map<string, Room>();
		for (const r of rooms) m.set(r.id, r);
		return m;
	}, [rooms]);

	useEffect(() => {
		if (!transport) return;
		const unsubscribe = transport.onCallEvent(({ roomId, eventType, eventId, senderId, content, timestamp }) => {
			const room = roomsById.get(roomId);
			if (!room) return;
			// Only DMs surface as ringing UI.  Group-room rings are
			// out of scope for v1 — those still rely on the avatar-
			// stack social signal.
			if (room.kind !== "dm") return;
			if (eventType === RING_EVENT_TYPE) {
				// Stale event guard: events older than the ring
				// timeout get dropped (e.g. backfill from a
				// historic call).  Belt-and-suspenders alongside
				// the live-only filter in transport.onCallEvent.
				if (Date.now() - timestamp > RING_TIMEOUT_MS) return;
				// Don't surface a ring if WE'RE the one already in
				// a call somewhere (avoid an awkward "decline our
				// own ringing recipient while they're ringing us
				// from somewhere else" race).
				if (call.activeCall) return;
				setActiveRing({
					ringEventId: eventId,
					roomId,
					roomName: room.name,
					callerId: senderId,
					// For DMs the room.name is set to the peer's
					// display name by matrix-js-sdk's heuristic
					// resolver, so we can just use it here.
					callerDisplayName: room.name,
					callerAvatarMxc: room.avatarUrl,
					receivedAt: Date.now(),
				});
			} else if (eventType === RING_CANCEL_EVENT_TYPE) {
				// Caller cancelled before we picked up.  Clear the
				// matching ring, if one is showing.  Match by
				// ring_event_id so a future "stack of rings"
				// scenario only dismisses the right one.
				const ringId = (content as { ring_event_id?: unknown }).ring_event_id;
				setActiveRing(prev => {
					if (!prev) return null;
					if (typeof ringId === "string" && prev.ringEventId !== ringId) return prev;
					return null;
				});
			}
			// chat.koven.call.decline is for the CALLER's side
			// (separate listener in CallToastListener).  No-op here.
		});
		return unsubscribe;
		// roomsById is the only changing dep we care about — when
		// it updates we re-bind so the lookup stays current.  The
		// transport identity is stable for the session.
	}, [transport, roomsById, call.activeCall]);

	// Auto-dismiss on timeout.  Re-runs whenever a ring lands; the
	// effect cleans up its prior timer to keep things tidy.
	useEffect(() => {
		if (!activeRing) return;
		const remaining = RING_TIMEOUT_MS - (Date.now() - activeRing.receivedAt);
		if (remaining <= 0) {
			setActiveRing(null);
			return;
		}
		const id = window.setTimeout(() => setActiveRing(null), remaining);
		return () => window.clearTimeout(id);
	}, [activeRing]);

	const handleAccept = useCallback(async () => {
		if (!activeRing || !accessToken || !transport) return;
		const ring = activeRing;
		setActiveRing(null);
		try {
			const r = await joinCallApi({ accessToken, roomId: ring.roomId });
			call.startCall({
				roomId: ring.roomId,
				roomName: ring.roomName,
				authToken: r.authToken,
				accessToken,
				isDm: true,
				// We're answering, not initiating.  Suppresses our
				// own outgoing ring (which would loop back to the
				// caller) and flips the pre-join CTA to "Join X".
				isAnsweringRing: true,
			});
			// Jump the user into the DM so the inline pre-join /
			// call view actually renders in the chat pane.  Without
			// this, the user stays on whatever they were viewing
			// when the ring came in and only the PIP shows up —
			// which feels like the call vanished.  Uses a navigate
			// helper that does NOT flip inCallView=false (the
			// normal sidebar navigateToRoom does, which would
			// drop them into chat view of the DM instead of the
			// call view).
			onAcceptedNavigate(ring.roomId);
		} catch (err) {
			if (err instanceof CallApiError && err.errcode === "M_NOT_CONFIGURED") {
				console.warn("ring accept: calls not configured");
				return;
			}
			console.warn("ring accept: joinCall failed", err);
		}
	}, [activeRing, accessToken, transport, call, onAcceptedNavigate]);

	const handleDecline = useCallback(async () => {
		if (!activeRing || !accessToken) return;
		const ring = activeRing;
		setActiveRing(null);
		await sendCallEventRaw({
			accessToken,
			roomId: ring.roomId,
			eventType: "chat.koven.call.decline",
			content: { ring_event_id: ring.ringEventId },
		});
	}, [activeRing, accessToken]);

	if (!activeRing || !currentUserId) return null;
	return (
		<IncomingRingSheet
			ring={activeRing}
			onAccept={handleAccept}
			onDecline={handleDecline}
		/>
	);
}

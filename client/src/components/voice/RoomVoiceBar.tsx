// "Live channel" affordance pinned to the top of every text room.
//
// Two roles:
//   1. Affordance to JOIN — one click → engine mints a Cloudflare
//      RealtimeKit participant token → CallProvider takes over and
//      the in-call view renders inline in this room's chat pane.
//   2. Social signal — when other people are already in voice in
//      this room, render their avatars in a stack so non-joined
//      users can see who's around to drop in with.
//
// Presence is fed by the engine's `/api/calls/:roomId/active`
// endpoint which mirrors RealtimeKit's webhook stream.  Polled
// every PRESENCE_POLL_MS while the bar is mounted; cheap (single
// SQLite SELECT on the engine) and the lag is on the order of
// network latency.
//
// When the engine returns M_NOT_CONFIGURED (env vars unset) the
// bar hides itself entirely so instances without RealtimeKit
// wired up don't see broken UI.
//
// Single-call enforcement: clicking Join while already in another
// room's call surfaces a confirm prompt — Discord rule, prevents
// accidentally splitting your audio across two calls.

import { useCallback, useEffect, useState } from "react";
import { Mic, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import {
	joinCall,
	listActiveCallParticipants,
	CallApiError,
	type CallParticipant,
} from "@/lib/calls-api";
import { useCall } from "@/lib/call-context";
import type { RoomId, UserId } from "@koven/shared";
import { cn } from "@/lib/utils";

export interface RoomVoiceBarProps {
	roomId: RoomId;
	roomName: string;
	accessToken: string;
	// True when the parent room is a 1:1 DM.  Only changes the
	// surface copy ("Voice / video call" + "Call" CTA vs "Live
	// channel" + "Join call") — the underlying token mint + SDK
	// flow is identical.  Caller-side ring sending happens in
	// CallProvider, not here.
	isDm?: boolean;
}

const PRESENCE_POLL_MS = 5_000;
const MAX_VISIBLE_AVATARS = 4;

type LocalState =
	| { status: "idle" }
	| { status: "joining" }
	| { status: "error"; message: string }
	| { status: "not_configured" };

export function RoomVoiceBar({ roomId, roomName, accessToken, isDm }: RoomVoiceBarProps) {
	const [state, setState] = useState<LocalState>({ status: "idle" });
	const [participants, setParticipants] = useState<CallParticipant[]>([]);
	const call = useCall();

	// Whether THIS room is the one the user is currently in a call
	// in.  Drives the button label (In call / Join call) and gates
	// the join-while-in-another-call confirm flow.  When the user
	// is in this room's call AND has the call view open, we hide
	// the bar entirely (the call surface below has its own
	// controls).  When the call view is CLOSED (user reading chat
	// while in voice), the bar shows a "Return to call" affordance
	// instead of the join CTA.
	const inThisRoomsCall = !!call.activeCall && call.activeCall.roomId === roomId && call.phase !== "idle";
	const inAnotherRoomsCall = !!call.activeCall && call.activeCall.roomId !== roomId && call.phase !== "idle";

	// Presence poll.  Runs on mount + every PRESENCE_POLL_MS; clears
	// on unmount.  Skipped when not_configured so we don't keep
	// hammering the engine for nothing.
	useEffect(() => {
		if (state.status === "not_configured") return;
		let cancelled = false;
		const tick = async () => {
			try {
				const list = await listActiveCallParticipants({ accessToken, roomId });
				if (!cancelled) setParticipants(list);
			} catch {
				// Network blip.  Leave the previous list visible.
			}
		};
		void tick();
		const id = window.setInterval(tick, PRESENCE_POLL_MS);
		return () => {
			cancelled = true;
			window.clearInterval(id);
		};
	}, [accessToken, roomId, state.status]);

	const onJoin = useCallback(async () => {
		// Single-call rule: if the user's already in a different
		// room's call, ask before dropping it.  We can't show our
		// own dialog easily here, so use the native confirm — gross
		// but functional, swap to a custom dialog if it matters.
		if (inAnotherRoomsCall) {
			const otherName = call.activeCall?.roomName ?? "another room";
			const ok = window.confirm(
				`You're already in a call in ${otherName}.  Leave that call and join ${roomName}?`,
			);
			if (!ok) return;
			await call.endCall();
		}
		setState({ status: "joining" });
		try {
			const r = await joinCall({ accessToken, roomId });
			call.startCall({
				roomId,
				roomName,
				authToken: r.authToken,
				accessToken,
				isDm: !!isDm,
			});
			setState({ status: "idle" });
		} catch (err) {
			if (err instanceof CallApiError && err.errcode === "M_NOT_CONFIGURED") {
				setState({ status: "not_configured" });
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`voice: join failed for ${roomId}`, err);
			setState({ status: "error", message });
		}
	}, [accessToken, roomId, roomName, inAnotherRoomsCall, call]);

	if (state.status === "not_configured") return null;

	// In this room's call AND looking at the call view → bar would
	// duplicate the call surface below.  Suppress.
	if (inThisRoomsCall && call.inCallView) return null;

	const hasParticipants = participants.length > 0;
	const visible = participants.slice(0, MAX_VISIBLE_AVATARS);
	const overflow = Math.max(0, participants.length - visible.length);
	const buttonLabel =
		state.status === "joining" ? "Joining…"
		: inThisRoomsCall ? "Return to call"
		: inAnotherRoomsCall ? "Switch call"
		: hasParticipants ? "Hop in"
		: isDm ? "Call"
		: "Join call";

	// When already in this room's call (chat view), the button is
	// a one-click "open the call surface" instead of a fresh join
	// (which would mint a new token + restart the SDK).
	const onClick = inThisRoomsCall
		? () => call.setInCallView(true)
		: onJoin;

	return (
		<div className={cn(
			"flex items-center justify-between gap-3 px-4 py-2 border-b border-border",
			hasParticipants ? "bg-primary/5" : "bg-card/50",
		)}>
			<div className="flex items-center gap-2.5 min-w-0">
				<Video className={cn("h-4 w-4 shrink-0", hasParticipants ? "text-primary" : "text-muted-foreground")} />
				<div className="flex flex-col min-w-0 leading-tight">
					<span className="text-sm font-medium">
						{hasParticipants
							? `Live · ${participants.length} ${participants.length === 1 ? "person" : "people"}`
							: isDm ? "Voice / video call"
							: "Live channel"}
					</span>
					<span className="text-[11px] text-muted-foreground">
						voice · video · screen share
					</span>
				</div>
			</div>

			<div className="flex items-center gap-2 shrink-0">
				{state.status === "error" && (
					<span className="text-xs text-destructive truncate max-w-[240px]" title={state.message}>
						{state.message}
					</span>
				)}
				{/* Avatar stack — sits directly left of the CTA so the
				    social signal reads in line with the action.
				    Names suppressed in the subtitle (above) on
				    purpose: the avatars carry that information more
				    cleanly, and dropping the text keeps the row
				    height stable regardless of how many people are
				    in the call. */}
				{hasParticipants && (
					<div className="flex items-center -space-x-1.5">
						{visible.map(p => (
							<MatrixAvatar
								key={p.userId as UserId}
								mxc={p.avatarUrl ?? undefined}
								seed={p.userId}
								kind="user"
								className="h-7 w-7 rounded-full ring-2 ring-background"
							/>
						))}
						{overflow > 0 && (
							<div className="h-7 px-2 rounded-full ring-2 ring-background bg-muted flex items-center justify-center text-[11px] font-medium text-muted-foreground">
								+{overflow}
							</div>
						)}
					</div>
				)}
				<Button
					type="button"
					size="sm"
					onClick={onClick}
					disabled={state.status === "joining"}
					className="gap-1.5"
				>
					<Mic className="h-3.5 w-3.5" />
					{buttonLabel}
				</Button>
			</div>
		</div>
	);
}

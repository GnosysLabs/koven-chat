// "Live channel" affordance pinned to the top of every text room.
//
// Two roles:
//   1. Affordance to JOIN — one click → engine mints a Cloudflare
//      RealtimeKit participant token → VoiceCallSheet opens with
//      that token → user is in the call.
//   2. Social signal — when other people are already in voice in
//      this room, render their avatars in a stack.  The
//      avatar-stack-with-Hop-In-button is the whole point of
//      Option 3 (every room has implicit voice; the sidebar
//      surfaces presence so people know to drop in).
//
// Presence is fed by the engine's `/api/calls/:roomId/active`
// endpoint which mirrors RealtimeKit's webhook stream.  Polled
// every PRESENCE_POLL_MS while the bar is mounted; cheap (single
// SQLite SELECT on the engine) and the lag is on the order of
// network latency.  When the SDK ships server-sent events for
// participant lists we can swap the poll for a subscription
// without changing the rendered UI.
//
// When the engine returns M_NOT_CONFIGURED (env vars unset) the
// bar hides itself entirely so instances without RealtimeKit
// wired up don't see broken UI.

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
import { VoiceCallSheet } from "@/components/voice/VoiceCallSheet";
import type { RoomId, UserId } from "@koven/shared";
import { cn } from "@/lib/utils";

export interface RoomVoiceBarProps {
	roomId: RoomId;
	roomName: string;
	accessToken: string;
}

const PRESENCE_POLL_MS = 5_000;
const MAX_VISIBLE_AVATARS = 4;

type JoinState =
	| { status: "idle" }
	| { status: "joining" }
	| { status: "in_call"; authToken: string }
	| { status: "error"; message: string }
	| { status: "not_configured" };

export function RoomVoiceBar({ roomId, roomName, accessToken }: RoomVoiceBarProps) {
	const [state, setState] = useState<JoinState>({ status: "idle" });
	const [participants, setParticipants] = useState<CallParticipant[]>([]);

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
		setState({ status: "joining" });
		try {
			const r = await joinCall({ accessToken, roomId });
			setState({ status: "in_call", authToken: r.authToken });
		} catch (err) {
			if (err instanceof CallApiError && err.errcode === "M_NOT_CONFIGURED") {
				setState({ status: "not_configured" });
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`voice: join failed for ${roomId}`, err);
			setState({ status: "error", message });
		}
	}, [accessToken, roomId]);

	const onLeave = useCallback(() => {
		setState({ status: "idle" });
	}, []);

	if (state.status === "not_configured") return null;

	const hasParticipants = participants.length > 0;
	const visible = participants.slice(0, MAX_VISIBLE_AVATARS);
	const overflow = Math.max(0, participants.length - visible.length);

	return (
		<>
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
								: "Live channel"}
						</span>
						<span className="text-[11px] text-muted-foreground">
							{hasParticipants
								? participants.map(p => p.displayName).slice(0, 3).join(", ")
									+ (participants.length > 3 ? `, +${participants.length - 3} more` : "")
								: "voice · video · screen share"}
						</span>
					</div>

					{hasParticipants && (
						<div className="flex items-center -space-x-1.5 ml-1 shrink-0">
							{visible.map(p => (
								<MatrixAvatar
									key={p.userId}
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
				</div>

				<div className="flex items-center gap-2 shrink-0">
					{state.status === "error" && (
						<span className="text-xs text-destructive truncate max-w-[240px]" title={state.message}>
							{state.message}
						</span>
					)}
					<Button
						type="button"
						size="sm"
						variant={state.status === "in_call" ? "secondary" : "default"}
						onClick={onJoin}
						disabled={state.status === "joining" || state.status === "in_call"}
						className="gap-1.5"
					>
						<Mic className="h-3.5 w-3.5" />
						{state.status === "joining" ? "Joining…"
							: state.status === "in_call" ? "In call"
							: hasParticipants ? "Hop in"
							: "Join call"}
					</Button>
				</div>
			</div>

			<VoiceCallSheet
				open={state.status === "in_call"}
				authToken={state.status === "in_call" ? state.authToken : null}
				roomName={roomName}
				onClose={onLeave}
			/>
		</>
	);
}

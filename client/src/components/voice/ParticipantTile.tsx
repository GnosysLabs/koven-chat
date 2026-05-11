// One participant's video tile inside the in-call grid.
//
// Renders one of two states based on the participant's media:
//   - Video on  → <video> element bound to their videoTrack.  Self
//                 is mirrored on X (selfie convention); remotes
//                 render as-shot.
//   - Video off → centered avatar fallback.
//
// Audio is handled OUTSIDE this component — at the App level via
// CallAudioSink — so audio survives the user navigating away from
// the call's room (the tile would unmount, taking its audio
// element with it).  This component never plays audio; the
// <video> element here is muted (for self) or has no audio track
// attached (for remotes, since the SDK separates audio + video
// tracks and we only bind the video one here).
//
// Active-speaker indicator: a primary-colored ring around the tile
// when this participant is the currently-speaking one.  Driven by
// the parent (CallView) which subscribes to participants.activeSpeaker.

import { useEffect, useRef } from "react";
import type { RTKParticipant, RTKSelf } from "@cloudflare/realtimekit-react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { cn } from "@/lib/utils";
import { Mic, MicOff, MonitorUp } from "lucide-react";

export interface ParticipantTileProps {
	// RTKSelf has the same media-track shape as RTKParticipant for
	// our purposes (audioTrack, videoTrack, audioEnabled,
	// videoEnabled, name, customParticipantId).  Cast at the call
	// site so we can render self + remote with the same component.
	participant: RTKParticipant | RTKSelf;
	isSelf: boolean;
	isSpeaking: boolean;
	// "camera" (default) renders the participant's webcam +
	// avatar fallback.  "screen" renders their active screen-share
	// stream (object-contain, never mirrored, with a screen-share
	// pill replacing the mic indicator).  When mode is "screen"
	// and the participant has stopped sharing, the tile shows a
	// fallback "share ended" placeholder — but the parent should
	// have already removed the tile from the grid, so this is
	// belt-and-suspenders.
	mode?: "camera" | "screen";
}

export function ParticipantTile({ participant, isSelf, isSpeaking, mode = "camera" }: ParticipantTileProps) {
	const videoRef = useRef<HTMLVideoElement | null>(null);

	// Pick the right track + enabled flag based on mode.  Camera
	// mode reads videoTrack/videoEnabled; screen mode reads
	// screenShareTracks.video/screenShareEnabled.
	const isScreen = mode === "screen";
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const screenVideoTrack = (participant as any).screenShareTracks?.video as MediaStreamTrack | undefined;
	const activeTrack = isScreen ? screenVideoTrack : participant.videoTrack;
	const activeEnabled = isScreen ? participant.screenShareEnabled : participant.videoEnabled;

	// Bind the chosen track to <video> element.  Re-runs when the
	// track reference changes (camera swap, screen-share start,
	// toggle).  When inactive, srcObject gets nulled and the
	// avatar / fallback below covers the empty box.
	useEffect(() => {
		const el = videoRef.current;
		if (!el) return;
		if (activeEnabled && activeTrack) {
			el.srcObject = new MediaStream([activeTrack]);
			void el.play().catch(() => { /* autoplay-blocked, fine */ });
		} else {
			el.srcObject = null;
		}
	}, [activeEnabled, activeTrack]);

	const displayName = participant.name || "Unknown";
	// participant.customParticipantId is the Koven mxid we stamped
	// in calls.ts joinCall (`customId: opts.userId`).  Falls back to
	// the SDK participant id if that wasn't set.
	const avatarSeed =
		(participant as { customParticipantId?: string }).customParticipantId
		|| participant.id
		|| displayName;

	return (
		<div
			className={cn(
				"relative w-full h-full rounded-lg overflow-hidden bg-muted border-2 transition-colors",
				isSpeaking ? "border-primary" : "border-transparent",
			)}
		>
			{/* Video element always present; we toggle visibility via
			    opacity so the layout doesn't reflow on track changes.
			    Camera tiles use object-cover (fill the box, crop
			    overflow) and mirror self horizontally for the selfie
			    convention.  Screen tiles use object-contain (show
			    the entire screen, letterbox if needed) and never
			    mirror — a flipped screenshare of someone's terminal
			    is unusable. */}
			<video
				ref={videoRef}
				autoPlay
				playsInline
				muted={isSelf}
				className={cn(
					"w-full h-full",
					isScreen ? "object-contain bg-black" : "object-cover",
					activeEnabled ? "opacity-100" : "opacity-0",
				)}
				style={isSelf && !isScreen ? { transform: "scaleX(-1)" } : undefined}
			/>
			{!activeEnabled && (
				<div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
					{isScreen ? (
						<MonitorUp className="h-12 w-12 text-muted-foreground" />
					) : (
						<MatrixAvatar
							seed={avatarSeed}
							kind="user"
							className="h-20 w-20 rounded-full"
						/>
					)}
				</div>
			)}
			{/* Bottom strip: name + mic OR screen-share badge.  Same
			    layout regardless of state so the chrome is stable. */}
			<div className="absolute bottom-0 left-0 right-0 px-3 py-1.5 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent text-white">
				<span className="text-xs font-medium truncate">
					{isScreen
						? `${displayName}${isSelf ? " (you)" : ""} — screen`
						: `${displayName}${isSelf ? " (you)" : ""}`}
				</span>
				{isScreen ? (
					<MonitorUp className="h-3.5 w-3.5 shrink-0 opacity-80" />
				) : participant.audioEnabled ? (
					<Mic className="h-3.5 w-3.5 shrink-0 opacity-80" />
				) : (
					<MicOff className="h-3.5 w-3.5 shrink-0 text-destructive" />
				)}
			</div>
		</div>
	);
}

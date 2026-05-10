// In-call surface.  Two modes:
//
//   1. Full-screen (default) — `fixed inset-0` overlay.  Peer video
//      or avatar fills the canvas, local self-preview pip in the
//      bottom-right (video calls only), control bar at the bottom.
//
//   2. Minimized (Discord-style PIP) — small floating thumbnail in
//      the bottom-left corner with peer video / avatar + compact
//      mute / hangup / expand controls.  Lets the user navigate
//      around the rest of the app without losing the call.
//
// Auto-minimize: when the parent passes `activeRoomId` and it
// stops matching the call's roomId (user navigated away from the
// in-call room), the view collapses to the PIP automatically.
// Re-expands manually via the expand button on the thumbnail.
//
// State sync: MatrixCall is an event emitter; we mirror the bits we
// render into React state via listeners so the component re-paints on
// State / FeedsChanged / Hangup.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { Maximize2, Mic, MicOff, Minimize2, PhoneOff, Video, VideoOff } from "lucide-react";
import { CallEvent, CallState, CallType } from "matrix-js-sdk/lib/webrtc/call";
import type { MatrixCall } from "matrix-js-sdk/lib/webrtc/call";
import type { RoomId, UserId } from "@koven/shared";
import { cn } from "@/lib/utils";
import { startOutboundDial } from "@/lib/callRingtone";

export interface ActiveCallViewProps {
	call: MatrixCall;
	// Peer identity, resolved by the parent from the DM's partner
	// data.  Outbound calls have no opponent member info from the
	// SDK until the answer arrives — without this prop the avatar
	// would briefly DiceBear-fallback to a roomId-seeded placeholder.
	peer?: {
		userId: UserId;
		displayName?: string;
		avatarMxc?: string;
	};
	// Currently-active room in the SPA.  When this stops matching
	// the call's roomId the view auto-minimizes — Discord pattern,
	// lets the user wander into other channels without losing the
	// call.  Pass null to opt out of auto-minimize entirely (the
	// view just stays in whatever mode the user picked).
	activeRoomId?: RoomId | null;
	// Click handler invoked when the user clicks the minimized
	// thumbnail's body (NOT the controls).  Parent uses this to
	// navigate back to the call's room — without it, the user has
	// to find the room manually after re-expanding.  Optional; when
	// omitted, the thumbnail click just expands without nav.
	onClickThumbnail?(roomId: RoomId): void;
	// Fires when the call has ended (locally or remotely) and the
	// view should be unmounted by the parent.
	onEnded(): void;
}

export function ActiveCallView({ call, peer, activeRoomId, onClickThumbnail, onEnded }: ActiveCallViewProps) {
	const [state, setState] = useState<CallState>(call.state);
	const [muted, setMuted] = useState<boolean>(call.isMicrophoneMuted());
	const [videoMuted, setVideoMuted] = useState<boolean>(call.isLocalVideoMuted());
	const [, forceFeedsRefresh] = useState(0);    // bump to refresh stream refs
	// Manual minimize state (the user clicked the minimize button) +
	// derived auto-minimize (the user navigated away).  We track them
	// separately so navigating BACK to the call's room re-expands
	// automatically only if the user hadn't manually minimized.
	const [manuallyMinimized, setManuallyMinimized] = useState(false);
	const autoMinimized = activeRoomId != null && activeRoomId !== call.roomId;
	const minimized = manuallyMinimized || autoMinimized;

	const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
	const localVideoRef = useRef<HTMLVideoElement | null>(null);
	const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
	// Refs for the same media in the minimized thumbnail.  Both modes
	// render their own <video>/<audio> elements (mounting/unmounting
	// the same element across modes mid-call drops the WebRTC stream
	// reference and produces a black frame).  We re-bind srcObject to
	// whichever set is currently mounted in the layout effect below.
	const remoteVideoMiniRef = useRef<HTMLVideoElement | null>(null);
	const remoteAudioMiniRef = useRef<HTMLAudioElement | null>(null);

	const isVideo = call.type === CallType.Video;
	// Peer identity — see prop docstring.  Caller (App.tsx) resolves
	// the DM partner up front so the avatar/name are correct from the
	// first paint; we fall back to SDK getters only if the prop wasn't
	// provided (defensive — e.g. a future non-DM call surface).
	const opponent = call.getOpponentMember();
	const peerUserId = (peer?.userId ?? opponent?.userId ?? call.roomId ?? "") as UserId;
	const peerName = peer?.displayName ?? opponent?.name ?? "Calling…";
	const peerAvatar = peer?.avatarMxc ?? opponent?.getMxcAvatarUrl() ?? undefined;

	// Outbound dial tone while the call is in pre-connected states
	// (InviteSent, Ringing, Connecting).  Stops the moment we hit
	// Connected or any terminal state.  Skipped entirely when the
	// call started in Connected (e.g. an inbound call we already
	// answered before this view mounted) — the inbound ring on the
	// IncomingCallSheet was the audible cue, no need for a second
	// tone after it disappears.
	useEffect(() => {
		const isPreConnected = state === CallState.InviteSent
			|| state === CallState.Ringing
			|| state === CallState.Connecting
			|| state === CallState.CreateOffer
			|| state === CallState.CreateAnswer;
		if (!isPreConnected) return;
		const ring = startOutboundDial();
		return () => ring.stop();
	}, [state]);

	// State-change wiring.  We re-read MatrixCall's getters each time
	// rather than copying values into state up-front because the SDK
	// surfaces some props (mute states) only via getter, and they can
	// change without firing State.
	useEffect(() => {
		const onState = (s: CallState) => setState(s);
		const onHangup = () => { setState(CallState.Ended); onEnded(); };
		const onError = () => { setState(CallState.Ended); onEnded(); };
		const onFeeds = () => forceFeedsRefresh(x => x + 1);

		call.on(CallEvent.State, onState);
		call.on(CallEvent.Hangup, onHangup);
		call.on(CallEvent.Error, onError);
		call.on(CallEvent.FeedsChanged, onFeeds);
		return () => {
			call.off(CallEvent.State, onState);
			call.off(CallEvent.Hangup, onHangup);
			call.off(CallEvent.Error, onError);
			call.off(CallEvent.FeedsChanged, onFeeds);
		};
	}, [call, onEnded]);

	// Bind WebRTC streams to whichever set of media elements is
	// currently mounted (full-screen vs minimized).  setting
	// srcObject is idempotent if the stream is the same instance,
	// so we just always reattach to every ref that has a node.
	useEffect(() => {
		const remoteStream = call.remoteUsermediaStream ?? null;
		// Full-screen layout video / audio.
		if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream;
		if (remoteAudioRef.current) remoteAudioRef.current.srcObject = remoteStream;
		// Minimized layout video / audio.  Only one of (full-screen,
		// minimized) is mounted at any time so the other branch's
		// refs are null and the assignment no-ops cleanly.
		if (remoteVideoMiniRef.current) remoteVideoMiniRef.current.srcObject = remoteStream;
		if (remoteAudioMiniRef.current) remoteAudioMiniRef.current.srcObject = remoteStream;
		// Even on a video call we route audio through a dedicated
		// <audio> element — it lets the OS treat the call audio as a
		// communication stream (echo-cancellation, ducking) and
		// behaves more reliably than relying on <video> playback for
		// audio-only flow.

		const localVideo = localVideoRef.current;
		const localStream = call.localUsermediaStream ?? null;
		if (localVideo) localVideo.srcObject = localStream;
	});

	async function toggleMic() {
		const next = !muted;
		await call.setMicrophoneMuted(next);
		setMuted(call.isMicrophoneMuted());
	}

	async function toggleCamera() {
		if (!isVideo) return;
		const next = !videoMuted;
		await call.setLocalVideoMuted(next);
		setVideoMuted(call.isLocalVideoMuted());
	}

	function hangup() {
		try {
			// "user_hangup" is the spec'd reason; second arg suppresses
			// re-emit of an event we're already initiating.
			call.hangup("user_hangup" as any, false);
		} catch (err) {
			console.warn("hangup failed", err);
		}
		onEnded();
	}

	const statusLabel =
		state === CallState.Ringing      ? "Ringing…" :
		state === CallState.InviteSent   ? "Calling…" :
		state === CallState.Connecting   ? "Connecting…" :
		state === CallState.Connected    ? null : // hide once connected
		state === CallState.WaitLocalMedia ? "Requesting access…" :
		state === CallState.CreateOffer  ? "Connecting…" :
		state === CallState.CreateAnswer ? "Connecting…" :
		state === CallState.Ended        ? "Call ended" :
		null;

	const showRemoteVideo = isVideo && state === CallState.Connected && !!call.remoteUsermediaStream;

	if (minimized) {
		// Compact floating thumbnail in the bottom-left.  Click body
		// to navigate back to the call's room (and clear the manual-
		// minimize so re-entering the room re-expands fullscreen);
		// dedicated buttons for mute / hangup / explicit expand.
		const goBackToCallRoom = () => {
			setManuallyMinimized(false);
			if (onClickThumbnail) onClickThumbnail(call.roomId as RoomId);
		};
		return (
			<div className="fixed bottom-4 left-4 z-[100] w-72 rounded-xl bg-black border border-white/15 shadow-2xl overflow-hidden flex flex-col">
				{/* Audio still needs to play in minimized mode —
				    re-mounted here so the stream stays bound. */}
				<audio ref={remoteAudioMiniRef} autoPlay playsInline />

				{/* Body: peer video or avatar + name.  Click to
				    navigate back / expand. */}
				<button
					type="button"
					onClick={goBackToCallRoom}
					className="relative h-40 w-full bg-black overflow-hidden cursor-pointer"
					aria-label={`Return to call with ${peerName}`}
				>
					{showRemoteVideo ? (
						<video
							ref={remoteVideoMiniRef}
							autoPlay
							playsInline
							className="h-full w-full object-cover"
						/>
					) : (
						<div className="h-full w-full flex flex-col items-center justify-center gap-2 text-white">
							<MatrixAvatar
								mxc={peerAvatar}
								seed={peerUserId}
								className="h-14 w-14"
							/>
							<div className="text-xs font-medium truncate max-w-[14rem] px-2 text-center">
								{peerName}
							</div>
							{statusLabel && (
								<div className="text-[10px] text-white/60">{statusLabel}</div>
							)}
						</div>
					)}
					{showRemoteVideo && (
						<div className="absolute bottom-1 left-2 text-[11px] text-white/80 px-1.5 py-0.5 rounded bg-black/50 backdrop-blur-sm truncate max-w-[14rem]">
							{peerName}
						</div>
					)}
				</button>

				{/* Compact control strip.  Mute / hangup / expand —
				    same primary actions as full-screen, miniaturized. */}
				<div className="h-11 bg-black/80 border-t border-white/10 flex items-center justify-center gap-1.5">
					<CompactControl
						active={!muted}
						onClick={toggleMic}
						ariaLabel={muted ? "Unmute microphone" : "Mute microphone"}
					>
						{muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
					</CompactControl>
					{isVideo && (
						<CompactControl
							active={!videoMuted}
							onClick={toggleCamera}
							ariaLabel={videoMuted ? "Turn camera on" : "Turn camera off"}
						>
							{videoMuted ? <VideoOff className="h-4 w-4" /> : <Video className="h-4 w-4" />}
						</CompactControl>
					)}
					<CompactControl
						active={true}
						onClick={() => {
							setManuallyMinimized(false);
							if (onClickThumbnail) onClickThumbnail(call.roomId as RoomId);
						}}
						ariaLabel="Expand call"
					>
						<Maximize2 className="h-4 w-4" />
					</CompactControl>
					<button
						type="button"
						onClick={hangup}
						className="h-8 w-8 rounded-full flex items-center justify-center bg-destructive hover:bg-destructive/90 text-destructive-foreground"
						aria-label="End call"
					>
						<PhoneOff className="h-4 w-4" />
					</button>
				</div>
			</div>
		);
	}

	return (
		// Outer backdrop dims the rest of the app so the call surface
		// reads as a centered modal rather than swallowing the whole
		// screen.  Inner card is bounded to a max width / height with
		// rounded corners so the call has obvious "edges" the way
		// Zoom / Discord's windowed-call mode does.
		<div className="fixed inset-0 z-[100] bg-black/85 backdrop-blur-sm flex items-center justify-center p-6">
			{/* Hidden audio element — peer audio always routes here. */}
			<audio ref={remoteAudioRef} autoPlay playsInline />

			<div className="relative flex flex-col w-full max-w-5xl max-h-[85vh] aspect-video bg-black border border-white/10 rounded-2xl overflow-hidden shadow-2xl">

			{/* Main canvas — peer video or peer-avatar fallback.
			    `object-contain` preserves aspect ratio (letterboxes
			    a 16:9 video on a 4:3 canvas instead of cropping it).
			    Tested in 1:1 calls between portrait + landscape
			    cameras — neither participant looked stretched. */}
			<div className="flex-1 relative flex items-center justify-center overflow-hidden bg-black">
				{showRemoteVideo ? (
					<video
						ref={remoteVideoRef}
						autoPlay
						playsInline
						className="h-full w-full object-contain"
					/>
				) : (
					<div className="flex flex-col items-center text-center gap-4 text-white">
						<MatrixAvatar
							mxc={peerAvatar}
							seed={peerUserId}
							className="h-32 w-32"
						/>
						<div>
							<div className="text-2xl font-semibold">{peerName}</div>
							{statusLabel && (
								<div className="text-sm text-white/70 mt-1">{statusLabel}</div>
							)}
						</div>
					</div>
				)}

				{/* Local self-preview pip.  Only shown for video calls
				    and when the camera isn't muted; voice calls don't
				    need a self-view. */}
				{isVideo && !videoMuted && (
					<video
						ref={localVideoRef}
						autoPlay
						playsInline
						muted
						className="absolute bottom-24 right-4 h-32 w-44 rounded-lg object-cover border border-white/20 shadow-xl bg-black"
					/>
				)}

				{/* Status pill on top of video calls (no other place
				    to surface "Connecting…" once the video is showing). */}
				{showRemoteVideo && statusLabel && (
					<div className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/60 text-white text-xs">
						{statusLabel}
					</div>
				)}

				{/* Minimize button — top-right corner.  Collapses the
				    full-screen surface to the floating thumbnail so
				    the user can navigate the rest of the app while
				    staying in the call (Discord pattern). */}
				<button
					type="button"
					onClick={() => setManuallyMinimized(true)}
					className="absolute top-4 right-4 h-9 w-9 rounded-full flex items-center justify-center bg-white/15 text-white hover:bg-white/25"
					aria-label="Minimize call"
					title="Minimize call"
				>
					<Minimize2 className="h-4 w-4" />
				</button>
			</div>

			{/* Control bar — fixed height at the bottom of the surface. */}
			<div className="h-24 bg-black/80 border-t border-white/10 flex items-center justify-center gap-3">
				<CallControl
					active={!muted}
					onClick={toggleMic}
					ariaLabel={muted ? "Unmute microphone" : "Mute microphone"}
				>
					{muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
				</CallControl>
				{isVideo && (
					<CallControl
						active={!videoMuted}
						onClick={toggleCamera}
						ariaLabel={videoMuted ? "Turn camera on" : "Turn camera off"}
					>
						{videoMuted ? <VideoOff className="h-5 w-5" /> : <Video className="h-5 w-5" />}
					</CallControl>
				)}
				<Button
					type="button"
					size="lg"
					onClick={hangup}
					className="h-12 w-12 rounded-full p-0 bg-destructive hover:bg-destructive/90 text-destructive-foreground"
					aria-label="End call"
				>
					<PhoneOff className="h-5 w-5" />
				</Button>
			</div>
			</div>
		</div>
	);
}

function CompactControl({
	active, onClick, ariaLabel, children,
}: {
	active: boolean;
	onClick(): void;
	ariaLabel: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={ariaLabel}
			className={cn(
				"h-8 w-8 rounded-full flex items-center justify-center transition-colors",
				active ? "bg-white/15 text-white hover:bg-white/25" : "bg-white/40 text-black hover:bg-white/55",
			)}
		>
			{children}
		</button>
	);
}

function CallControl({
	active, onClick, ariaLabel, children,
}: {
	active: boolean;
	onClick(): void;
	ariaLabel: string;
	children: React.ReactNode;
}) {
	// "active" here means the corresponding feature is enabled (mic on,
	// camera on).  The off state gets a darker fill so a quick glance
	// reads "this is currently muted/disabled."
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={ariaLabel}
			className={cn(
				"h-12 w-12 rounded-full flex items-center justify-center transition-colors",
				active ? "bg-white/15 text-white hover:bg-white/25" : "bg-white/40 text-black hover:bg-white/55",
			)}
		>
			{children}
		</button>
	);
}

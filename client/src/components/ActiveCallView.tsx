// Full-screen in-call surface.  Mounted while a call is connecting,
// ringing (outbound), or connected.  Stays on top of everything else
// so the user can switch rooms in the app underneath without losing
// the call.
//
// Layout:
//   - Voice call: black canvas with the peer's avatar centered, a
//     status string (Ringing… / Connecting… / Connected / Ended), and
//     a bottom control bar (mute / hangup).
//   - Video call: peer's video fills the surface; local self-preview
//     pip in the bottom-right corner; same control bar (mute / camera
//     / hangup).
//
// State sync:  MatrixCall is an event emitter; we mirror the bits we
// render into React state via listeners so the component re-paints on
// State / FeedsChanged / Hangup.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { Mic, MicOff, PhoneOff, Video, VideoOff } from "lucide-react";
import { CallEvent, CallState, CallType } from "matrix-js-sdk/lib/webrtc/call";
import type { MatrixCall } from "matrix-js-sdk/lib/webrtc/call";
import type { UserId } from "@koven/shared";
import { cn } from "@/lib/utils";

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
	// Fires when the call has ended (locally or remotely) and the
	// view should be unmounted by the parent.
	onEnded(): void;
}

export function ActiveCallView({ call, peer, onEnded }: ActiveCallViewProps) {
	const [state, setState] = useState<CallState>(call.state);
	const [muted, setMuted] = useState<boolean>(call.isMicrophoneMuted());
	const [videoMuted, setVideoMuted] = useState<boolean>(call.isLocalVideoMuted());
	const [, forceFeedsRefresh] = useState(0);    // bump to refresh stream refs

	const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
	const localVideoRef = useRef<HTMLVideoElement | null>(null);
	const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

	const isVideo = call.type === CallType.Video;
	// Peer identity — see prop docstring.  Caller (App.tsx) resolves
	// the DM partner up front so the avatar/name are correct from the
	// first paint; we fall back to SDK getters only if the prop wasn't
	// provided (defensive — e.g. a future non-DM call surface).
	const opponent = call.getOpponentMember();
	const peerUserId = (peer?.userId ?? opponent?.userId ?? call.roomId ?? "") as UserId;
	const peerName = peer?.displayName ?? opponent?.name ?? "Calling…";
	const peerAvatar = peer?.avatarMxc ?? opponent?.getMxcAvatarUrl() ?? undefined;

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

	// Bind WebRTC streams to the media elements every time feeds
	// change.  setting srcObject is idempotent if the stream is the
	// same instance, so we just always reattach.
	useEffect(() => {
		const remoteVideo = remoteVideoRef.current;
		const remoteAudio = remoteAudioRef.current;
		const remoteStream = call.remoteUsermediaStream ?? null;
		if (remoteVideo) remoteVideo.srcObject = remoteStream;
		// Even on a video call we route audio through a dedicated
		// <audio> element — it lets the OS treat the call audio as a
		// communication stream (echo-cancellation, ducking) and
		// behaves more reliably than relying on <video> playback for
		// audio-only flow.
		if (remoteAudio) remoteAudio.srcObject = remoteStream;

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

	return (
		<div className="fixed inset-0 z-[100] bg-black flex flex-col">
			{/* Hidden audio element — peer audio always routes here. */}
			<audio ref={remoteAudioRef} autoPlay playsInline />

			{/* Main canvas — peer video or peer-avatar fallback. */}
			<div className="flex-1 relative flex items-center justify-center overflow-hidden">
				{showRemoteVideo ? (
					<video
						ref={remoteVideoRef}
						autoPlay
						playsInline
						className="h-full w-full object-cover"
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

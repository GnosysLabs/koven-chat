// Pre-join screen for a Live channel.  Replaces the prebuilt
// RtkSetupScreen — the cookie-cutter Cloudflare UI didn't match the
// rest of Koven and had quirks we couldn't theme around (display-
// name input we didn't want, room id as title, white avatar
// placeholder, etc.).  This is our own UI built on the lower-level
// RealtimeKit React hooks.
//
// What it shows:
//   - Pulsing favicon + room name at the top
//   - Local camera preview (or a muted-camera placeholder)
//   - Mic on/off + Cam on/off toggle pills under the preview
//   - Three device pickers (Mic, Camera, Speaker) using shadcn Select
//   - Big primary "Join Live" button on the right, with Cancel
//
// Behavior:
//   - We call `meeting.self.enableVideo() / disableVideo() /
//     enableAudio() / disableAudio()` on toggle.  The SDK keeps
//     the chosen state when the user hits Join — they enter the
//     call with whatever device + on/off state they picked here.
//   - Device selection persists through join via meeting.self.setDevice().
//   - On Join we call `meeting.joinRoom()`; the parent sheet
//     listens for `roomJoined` to swap to the in-call view.
//
// Why not bind to `meeting.self.audioEnabled` directly?  That field
// is a getter that reads the SDK's internal state, but React doesn't
// subscribe to it.  We mirror it into local state and listen to the
// SDK's `audioUpdate` / `videoUpdate` events to stay in sync — that
// way the toggle visually flips the moment the SDK confirms the
// device acquired (or didn't, on permission deny).

import { useEffect, useRef, useState } from "react";
import { useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";
import { Button } from "@/components/ui/button";
import { DeviceRow } from "@/components/voice/DeviceRow";
import { NoiseSuppressionToggle } from "@/components/voice/NoiseSuppressionToggle";
import { useCallDevices } from "@/components/voice/useCallDevices";
import { cn } from "@/lib/utils";
import { Mic, MicOff, Video, VideoOff, Volume2 } from "lucide-react";

export interface PreJoinScreenProps {
	roomName: string;
	onJoined(): void;
	// Bail out of the pre-join + tear down the meeting.  Wired
	// to call.endCall() by InCallPane.  Without this the user has
	// no escape from the pre-join surface short of navigating away
	// (which leaves the call alive in the background) — bad UX.
	onCancel(): void;
	// True when the call is a 1:1 DM.  Changes the CTA copy from
	// "Join Live" to "Ring <peer>" so the user knows clicking it
	// notifies the other person (versus channel-style joins where
	// you're entering an open room).  When `isAnsweringRing` or
	// `skipRing` is also true, the copy flips to "Join <peer>" —
	// they're not initiating a ring, they're joining a call that
	// already exists (picking up an incoming ring, or hopping into
	// a call already in progress).
	isDm?: boolean;
	isAnsweringRing?: boolean;
	// True when hopping into a DM call that already has someone in
	// it.  Like `isAnsweringRing` for copy purposes: no ring is
	// being sent, so the CTA reads "Join", not "Ring".
	skipRing?: boolean;
}

export function PreJoinScreen({ roomName, onJoined, onCancel, isDm, isAnsweringRing, skipRing }: PreJoinScreenProps) {
	const { meeting } = useRealtimeKitMeeting();
	// Local mirrors of self.audioEnabled / videoEnabled so React
	// re-renders on toggle.  Seeded false: we proactively enable
	// both devices on mount (see the probe effect), and the
	// audioUpdate/videoUpdate listeners flip these true once the
	// hardware is actually acquired — so the UI shows "off" only
	// for the brief moment before the camera/mic come up, never a
	// false "on".
	const [audioOn, setAudioOn] = useState<boolean>(false);
	const [videoOn, setVideoOn] = useState<boolean>(false);
	const [joining, setJoining] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// True once the permission probe below has resolved.  Gates the
	// device hook so it only enumerates after the browser will
	// return labeled device names.
	const [probeDone, setProbeDone] = useState(false);
	// Device lists + current selection + switch action.  Enumeration
	// is deferred until `probeDone` so the dropdowns get real names.
	const devices = useCallDevices(meeting, probeDone);

	// Camera preview <video> ref.  We attach the local video track to
	// it whenever it changes (toggle on/off, device swap).
	const previewRef = useRef<HTMLVideoElement | null>(null);

	// Permission probe + default-on media.  Runs once when the
	// meeting is available.
	//
	// Step 1 — probe.  Fire a one-shot getUserMedia({audio,video}).
	// This pops the OS / browser permission prompt the moment the
	// user lands on the prejoin screen so the device dropdowns can
	// populate with REAL names instead of "Default" placeholders
	// (browsers hide device labels until permission is granted at
	// least once).  We stop the probe tracks immediately; the SDK
	// acquires its own in step 2.  `probeDone` then ungates the
	// useCallDevices hook so it enumerates with labels available.
	//
	// Step 2 — default-on.  Explicitly enable mic + camera so the
	// user lands on the prejoin screen with a live preview and an
	// open mic, and opts OUT via the toggle pills rather than having
	// to opt in.  Each enable is isolated: a denied or absent device
	// (e.g. a desktop with a mic but no webcam) leaves that one off
	// without blocking the other or the join.  The audioUpdate /
	// videoUpdate listeners flip the audioOn / videoOn mirrors once
	// the hardware is actually acquired.
	//
	// If the user denies the prompt, the catches keep us on the
	// prejoin screen with empty dropdowns and both devices off
	// rather than blocking the join — they can still join with no
	// audio/video.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const probe = await navigator.mediaDevices.getUserMedia({
					audio: true,
					video: true,
				});
				probe.getTracks().forEach(t => t.stop());
			} catch (err) {
				console.warn("PreJoinScreen: permission probe failed", err);
			}
			if (cancelled) return;
			setProbeDone(true);
			try { await meeting.self.enableAudio(); }
			catch (err) { console.warn("PreJoinScreen: enableAudio failed", err); }
			if (cancelled) return;
			try { await meeting.self.enableVideo(); }
			catch (err) { console.warn("PreJoinScreen: enableVideo failed", err); }
		})();
		return () => { cancelled = true; };
	}, [meeting]);

	// Subscribe to SDK events so our mirrors stay accurate.  audioUpdate
	// + videoUpdate fire after enableX/disableX resolves (or after a
	// permission denial flips state back).
	useEffect(() => {
		const onAudio = (p: { audioEnabled: boolean }) => setAudioOn(p.audioEnabled);
		const onVideo = (p: { videoEnabled: boolean }) => setVideoOn(p.videoEnabled);
		meeting.self.on("audioUpdate", onAudio);
		meeting.self.on("videoUpdate", onVideo);
		return () => {
			try {
				meeting.self.off("audioUpdate", onAudio);
				meeting.self.off("videoUpdate", onVideo);
			} catch {
				// SDK already torn down.
			}
		};
	}, [meeting]);

	// Wire the current video track into the <video> preview element.
	// Re-runs on track swap (camera change) + on/off toggle.  When
	// video is off we clear srcObject so the element collapses
	// gracefully to its placeholder background.
	useEffect(() => {
		const el = previewRef.current;
		if (!el) return;
		if (videoOn && meeting.self.videoTrack) {
			el.srcObject = new MediaStream([meeting.self.videoTrack]);
			void el.play().catch(() => { /* autoplay blocked, fine */ });
		} else {
			el.srcObject = null;
		}
	}, [videoOn, meeting.self.videoTrack, meeting]);

	async function toggleAudio() {
		setError(null);
		try {
			if (meeting.self.audioEnabled) await meeting.self.disableAudio();
			else await meeting.self.enableAudio();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function toggleVideo() {
		setError(null);
		try {
			if (meeting.self.videoEnabled) await meeting.self.disableVideo();
			else await meeting.self.enableVideo();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function pickDevice(kind: "audio" | "video" | "speaker", deviceId: string) {
		setError(null);
		try {
			await devices.pickDevice(kind, deviceId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleJoin() {
		if (joining) return;
		setJoining(true);
		setError(null);
		try {
			await meeting.joinRoom();
			onJoined();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setJoining(false);
		}
	}

	return (
		<div className="flex-1 flex flex-col items-center justify-center px-6 py-6 gap-5 overflow-y-auto">
			{/* Header — small favicon + "Joining {roomName}" sitting
			    just above the preview so the eye reads downward in
			    one column.  Eyebrow text ("JOINING") + the name as
			    the heading so the user knows immediately what
			    they're about to enter. */}
			<div className="flex flex-col items-center gap-2.5 shrink-0">
				<img
					src="/favicon.png"
					alt=""
					aria-hidden
					className="h-10 w-10 animate-pulse"
					style={{ animationDuration: "1.6s" }}
				/>
				<div className="text-center">
					<div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
						Joining Live
					</div>
					<div className="text-base font-semibold mt-0.5 leading-tight">
						{roomName}
					</div>
				</div>
			</div>

			{/* Camera preview — capped width so it stays visually
			    proportionate to the rest of the column instead of
			    dominating.  16:9 box with the local video stretched
			    to cover; falls back to a centered VideoOff icon
			    when the cam is muted.  Slight shadow so the box
			    floats off the dialog background. */}
			<div className="relative w-full max-w-[480px] aspect-video rounded-xl bg-muted overflow-hidden border border-border shadow-lg shrink-0">
				<video
					ref={previewRef}
					autoPlay
					playsInline
					muted
					className={cn(
						"w-full h-full object-cover",
						videoOn ? "opacity-100" : "opacity-0",
					)}
					style={{ transform: "scaleX(-1)" }}
				/>
				{!videoOn && (
					<div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
						<VideoOff className="h-10 w-10" />
					</div>
				)}
				{/* Mic + Cam toggle pills floating bottom-center over
				    the preview.  Subtle background tint so they read
				    against any camera frame, not just dark ones. */}
				<div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2">
					<ToggleButton
						active={audioOn}
						onClick={toggleAudio}
						iconOn={<Mic className="h-4 w-4" />}
						iconOff={<MicOff className="h-4 w-4" />}
						label={audioOn ? "Mute mic" : "Unmute mic"}
					/>
					<ToggleButton
						active={videoOn}
						onClick={toggleVideo}
						iconOn={<Video className="h-4 w-4" />}
						iconOff={<VideoOff className="h-4 w-4" />}
						label={videoOn ? "Turn camera off" : "Turn camera on"}
					/>
				</div>
			</div>

			{/* Device pickers — compact stacked rows with an icon
			    prefix so they read as "this controls your mic / cam
			    / speaker" without needing a wordy label.  Native
			    <select> for free OS keyboard nav + zero new deps. */}
			<div className="w-full max-w-[480px] flex flex-col gap-1.5 shrink-0">
				<DeviceRow
					icon={<Mic className="h-3.5 w-3.5" />}
					devices={devices.audioDevices}
					currentId={devices.currentAudioId}
					placeholder="Default microphone"
					onChange={(id) => pickDevice("audio", id)}
				/>
				<DeviceRow
					icon={<Video className="h-3.5 w-3.5" />}
					devices={devices.videoDevices}
					currentId={devices.currentVideoId}
					placeholder="Default camera"
					onChange={(id) => pickDevice("video", id)}
				/>
				<DeviceRow
					icon={<Volume2 className="h-3.5 w-3.5" />}
					devices={devices.speakerDevices}
					currentId={devices.currentSpeakerId}
					placeholder="Default speaker"
					onChange={(id) => pickDevice("speaker", id)}
				/>
				<NoiseSuppressionToggle />
			</div>

			{/* Join is the obvious primary, generously sized + centered.
			    Cancel is a small ghost-text escape underneath that
			    tears down the meeting and returns the chat pane to
			    its normal state.  Now that the surface is inline
			    (no dialog X), this button is the only way out short
			    of navigating away (which would keep the call alive
			    in the background — not what the user wants here). */}
			<div className="flex flex-col items-center gap-1 shrink-0">
				<Button
					onClick={handleJoin}
					disabled={joining}
					size="lg"
					className="min-w-[200px]"
				>
					{joining
						? (isDm ? (isAnsweringRing || skipRing ? "Joining…" : "Ringing…") : "Joining…")
						: (isDm
							? (isAnsweringRing || skipRing ? `Join ${roomName}` : `Ring ${roomName}`)
							: "Join Live")}
				</Button>
				<Button
					onClick={onCancel}
					disabled={joining}
					variant="ghost"
					size="sm"
					className="text-muted-foreground hover:text-foreground"
				>
					Cancel
				</Button>
			</div>

			{error && (
				<div className="w-full max-w-[480px] text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2 shrink-0">
					{error}
				</div>
			)}
		</div>
	);
}

/** Round media-control pill on the camera preview overlay.  Red
 *  background when the device is OFF (mirrors the muted convention
 *  in Discord / Zoom / Meet); translucent dark when ON so it reads
 *  against any video frame, not just dark ones. */
function ToggleButton({
	active, onClick, iconOn, iconOff, label,
}: {
	active: boolean;
	onClick(): void;
	iconOn: React.ReactNode;
	iconOff: React.ReactNode;
	label: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className={cn(
				"h-9 w-9 rounded-full flex items-center justify-center transition-colors backdrop-blur-sm",
				active
					? "bg-black/50 hover:bg-black/70 text-white"
					: "bg-destructive hover:bg-destructive/90 text-destructive-foreground",
			)}
		>
			{active ? iconOn : iconOff}
		</button>
	);
}

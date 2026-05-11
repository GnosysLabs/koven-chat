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
	// you're entering an open room).  When `isAnsweringRing` is
	// also true, the copy flips to "Join <peer>" — they're not
	// initiating a ring, they're picking up an incoming one.
	isDm?: boolean;
	isAnsweringRing?: boolean;
}

export function PreJoinScreen({ roomName, onJoined, onCancel, isDm, isAnsweringRing }: PreJoinScreenProps) {
	const { meeting } = useRealtimeKitMeeting();
	// Local mirrors of self.audioEnabled / videoEnabled so React
	// re-renders on toggle.  Seed from current state in case the
	// user had defaults that already enabled either.
	const [audioOn, setAudioOn] = useState<boolean>(false);
	const [videoOn, setVideoOn] = useState<boolean>(false);
	const [joining, setJoining] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Device state — list + current selection per kind.  We re-fetch
	// when the SDK fires deviceListUpdate (plug/unplug a headset).
	const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
	const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
	const [speakerDevices, setSpeakerDevices] = useState<MediaDeviceInfo[]>([]);
	const [currentAudioId, setCurrentAudioId] = useState<string>("");
	const [currentVideoId, setCurrentVideoId] = useState<string>("");
	const [currentSpeakerId, setCurrentSpeakerId] = useState<string>("");

	// Camera preview <video> ref.  We attach the local video track to
	// it whenever it changes (toggle on/off, device swap).
	const previewRef = useRef<HTMLVideoElement | null>(null);

	// Initial device + state hydration.  Runs once when the meeting
	// is available.  Best-effort — getDevices can throw if the user
	// hasn't granted permission yet, which is fine; the dropdowns
	// just stay empty until they hit toggle and accept the prompt.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const [a, v, s, current] = await Promise.all([
					meeting.self.getAudioDevices(),
					meeting.self.getVideoDevices(),
					meeting.self.getSpeakerDevices(),
					meeting.self.getCurrentDevices(),
				]);
				if (cancelled) return;
				setAudioDevices(a);
				setVideoDevices(v);
				setSpeakerDevices(s);
				setCurrentAudioId(current.audio?.deviceId ?? "");
				setCurrentVideoId(current.video?.deviceId ?? "");
				setCurrentSpeakerId(current.speaker?.deviceId ?? "");
			} catch (err) {
				console.warn("PreJoinScreen: device hydration failed", err);
			}
			setAudioOn(meeting.self.audioEnabled);
			setVideoOn(meeting.self.videoEnabled);
		})();
		return () => { cancelled = true; };
	}, [meeting]);

	// Subscribe to SDK events so our mirrors stay accurate.  audioUpdate
	// + videoUpdate fire after enableX/disableX resolves (or after a
	// permission denial flips state back).  deviceListUpdate fires when
	// a device is plugged or unplugged.
	useEffect(() => {
		const onAudio = (p: { audioEnabled: boolean }) => setAudioOn(p.audioEnabled);
		const onVideo = (p: { videoEnabled: boolean }) => setVideoOn(p.videoEnabled);
		const onDeviceList = async () => {
			try {
				const [a, v, s] = await Promise.all([
					meeting.self.getAudioDevices(),
					meeting.self.getVideoDevices(),
					meeting.self.getSpeakerDevices(),
				]);
				setAudioDevices(a);
				setVideoDevices(v);
				setSpeakerDevices(s);
			} catch (err) {
				console.warn("PreJoinScreen: device-list refresh failed", err);
			}
		};
		meeting.self.on("audioUpdate", onAudio);
		meeting.self.on("videoUpdate", onVideo);
		meeting.self.on("deviceListUpdate", onDeviceList);
		return () => {
			try {
				meeting.self.off("audioUpdate", onAudio);
				meeting.self.off("videoUpdate", onVideo);
				meeting.self.off("deviceListUpdate", onDeviceList);
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
		const list =
			kind === "audio" ? audioDevices
			: kind === "video" ? videoDevices
			: speakerDevices;
		const device = list.find(d => d.deviceId === deviceId);
		if (!device) return;
		try {
			await meeting.self.setDevice(device);
			if (kind === "audio") setCurrentAudioId(deviceId);
			else if (kind === "video") setCurrentVideoId(deviceId);
			else setCurrentSpeakerId(deviceId);
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
					devices={audioDevices}
					currentId={currentAudioId}
					placeholder="Default microphone"
					onChange={(id) => pickDevice("audio", id)}
				/>
				<DeviceRow
					icon={<Video className="h-3.5 w-3.5" />}
					devices={videoDevices}
					currentId={currentVideoId}
					placeholder="Default camera"
					onChange={(id) => pickDevice("video", id)}
				/>
				<DeviceRow
					icon={<Volume2 className="h-3.5 w-3.5" />}
					devices={speakerDevices}
					currentId={currentSpeakerId}
					placeholder="Default speaker"
					onChange={(id) => pickDevice("speaker", id)}
				/>
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
						? (isDm ? (isAnsweringRing ? "Joining…" : "Ringing…") : "Joining…")
						: (isDm
							? (isAnsweringRing ? `Join ${roomName}` : `Ring ${roomName}`)
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

/** Compact device dropdown row.  Icon prefix tells the user which
 *  device kind it controls (mic, cam, speaker) without a wordy
 *  text label, leaving the row short enough to stack three of them
 *  in a tight column.  Native <select> for free keyboard nav,
 *  screen-reader semantics, and long-list scrolling — no extra dep.
 *
 *  Subtle hover/focus styling matches the rest of the app's
 *  inputs.  When the SDK reports zero devices for the kind (e.g.
 *  permissions not yet granted), the placeholder shows so the
 *  control still reads as legible-but-empty rather than broken. */
function DeviceRow({
	icon, devices, currentId, placeholder, onChange,
}: {
	icon: React.ReactNode;
	devices: MediaDeviceInfo[];
	currentId: string;
	placeholder: string;
	onChange(deviceId: string): void;
}) {
	return (
		<div className="relative flex items-center">
			<div className="absolute left-3 text-muted-foreground pointer-events-none">
				{icon}
			</div>
			<select
				value={currentId}
				onChange={(e) => onChange(e.target.value)}
				disabled={devices.length === 0}
				className={cn(
					"w-full h-9 pl-9 pr-3 rounded-md border border-border bg-background/50",
					"text-foreground text-xs focus:outline-none focus:ring-2 focus:ring-primary/40",
					"disabled:opacity-50 disabled:cursor-not-allowed",
					"appearance-none cursor-pointer hover:bg-accent/50 transition-colors",
				)}
			>
				{devices.length === 0 ? (
					<option value="">{placeholder}</option>
				) : (
					devices.map(d => (
						<option key={d.deviceId} value={d.deviceId}>
							{d.label || placeholder}
						</option>
					))
				)}
			</select>
			{/* Custom chevron — the default OS one breaks the visual
			    consistency of the row and on macOS shows a different
			    indicator than on Windows/Linux.  appearance-none on
			    the select hides the native chevron; we draw our own. */}
			<svg
				className="absolute right-3 h-3 w-3 text-muted-foreground pointer-events-none"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
			</svg>
		</div>
	);
}

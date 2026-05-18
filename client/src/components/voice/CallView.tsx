// In-call view: thumbnail strip + optional spotlight + control bar.
//
// Layout modes:
//   - Single participant (just self) → one centered fit-to-fill tile
//     (no need to thumbnailify; you'd be alone in a wall of negative
//     space).
//   - Multi participant, unpinned → row of equally-sized thumbnails
//     centered in the body, wrapping if many.  Click any thumbnail
//     to spotlight it.
//   - Multi participant, pinned → spotlight tile fills most of the
//     body, thumbnails strip along the bottom.  ‹ › arrows on the
//     sides of the spotlight cycle through participants.  Click the
//     spotlight (or the same thumbnail again) to unpin.
//
// Subscribes to:
//   - meeting.participants.joined → the live map of remote
//     participants.  We re-derive a snapshot array on every
//     `participantJoined` / `participantLeft` event.
//   - meeting.participants.activeSpeaker → the participant id
//     currently above the volume threshold.  Drives the speaking
//     border on the matching tile.
//   - meeting.self media-update events → mirror state for the
//     control bar's toggle states.
//
// Discord-style: no in-call chat panel.  Chat lives in the parent
// room — leave or background the call to use the room's normal
// composer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";
import type { RTKParticipant, RTKSelf } from "@cloudflare/realtimekit-react";
import { Button } from "@/components/ui/button";
import { ParticipantTile } from "@/components/voice/ParticipantTile";
import { SharedBrowserTile } from "@/components/voice/SharedBrowserTile";
import { useCall } from "@/lib/call-context";
import { startBrowserSession, stopBrowserSession } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import { isMobileShell } from "@/lib/mobile";
import {
	isCallWindow,
	isDesktopShell,
	toggleCallWindowFullscreen,
} from "@/lib/native-window";
import {
	ChevronLeft,
	ChevronRight,
	Globe,
	Maximize,
	Mic,
	MicOff,
	MonitorUp,
	MonitorOff,
	PhoneOff,
	PictureInPicture,
	PictureInPicture2,
	Video,
	VideoOff,
} from "lucide-react";

export interface CallViewProps {
	roomName: string;
	onLeaveRequested(): void;
}

export function CallView({ roomName, onLeaveRequested }: CallViewProps) {
	const { meeting } = useRealtimeKitMeeting();

	// Local mirrors of self media state so the control bar buttons
	// reflect the real SDK state (changes fire from outside React,
	// so we listen to events).
	const [audioOn, setAudioOn] = useState<boolean>(meeting.self.audioEnabled);
	const [videoOn, setVideoOn] = useState<boolean>(meeting.self.videoEnabled);
	const [screenOn, setScreenOn] = useState<boolean>(meeting.self.screenShareEnabled);
	const [error, setError] = useState<string | null>(null);

	// Remote participants snapshot.  We trigger a re-derive on every
	// participants-map mutation; the actual array is computed via
	// useMemo from the SDK's joined map.  Counter is a simple
	// "something changed, re-render" signal.
	const [participantsTick, setParticipantsTick] = useState(0);
	const remoteParticipants = useMemo<RTKParticipant[]>(() => {
		// Map.toArray() exists on RTKParticipantMap; fall back to
		// Map.values() iteration if the type widens.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const m = meeting.participants.joined as any;
		if (typeof m.toArray === "function") return m.toArray() as RTKParticipant[];
		return Array.from(m.values()) as RTKParticipant[];
		// participantsTick is the dependency that drives re-derivation
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [meeting, participantsTick]);

	// Active-speaker id.  null when no one is currently speaking
	// (or we haven't received an activeSpeaker event yet).
	const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);

	// Self events for the control-bar mirrors.
	useEffect(() => {
		const onAudio = (p: { audioEnabled: boolean }) => setAudioOn(p.audioEnabled);
		const onVideo = (p: { videoEnabled: boolean }) => setVideoOn(p.videoEnabled);
		const onScreen = (p: { screenShareEnabled: boolean }) => setScreenOn(p.screenShareEnabled);
		meeting.self.on("audioUpdate", onAudio);
		meeting.self.on("videoUpdate", onVideo);
		meeting.self.on("screenShareUpdate", onScreen);
		return () => {
			try {
				meeting.self.off("audioUpdate", onAudio);
				meeting.self.off("videoUpdate", onVideo);
				meeting.self.off("screenShareUpdate", onScreen);
			} catch {
				// SDK already torn down.
			}
		};
	}, [meeting]);

	// Participants subscription.  Re-derive the tile list on:
	//   - participantJoined / participantLeft on the joined map
	//   - per-participant videoUpdate / audioUpdate /
	//     screenShareUpdate (so screen-share toggles add/remove a
	//     screen tile in real time)
	//   - self's own video/audio/screen-share updates
	// Also captures the activeSpeaker event for the speaking-border.
	useEffect(() => {
		const bump = () => setParticipantsTick(t => t + 1);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const joined = meeting.participants.joined as any;

		// Per-participant subscription helper.  Tracks which
		// participants we've already subscribed to (via WeakSet) so
		// joining-and-rejoining the same person doesn't double-bind.
		const subscribed = new WeakSet<object>();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const subscribeP = (p: any) => {
			if (subscribed.has(p)) return;
			subscribed.add(p);
			p.on("videoUpdate", bump);
			p.on("audioUpdate", bump);
			p.on("screenShareUpdate", bump);
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const unsubscribeP = (p: any) => {
			try {
				p.off("videoUpdate", bump);
				p.off("audioUpdate", bump);
				p.off("screenShareUpdate", bump);
			} catch { /* p already torn down */ }
		};

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const onJoined = (p: any) => { subscribeP(p); bump(); };
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const onLeft = (p: any) => { unsubscribeP(p); bump(); };

		joined.on("participantJoined", onJoined);
		joined.on("participantLeft", onLeft);

		// Subscribe to participants already in the room when this
		// effect runs.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const initial = typeof joined.toArray === "function"
			? (joined.toArray() as any[])
			: (Array.from(joined.values()) as any[]);
		for (const p of initial) subscribeP(p);

		// Self's own media updates also re-derive (add/remove the
		// self-screen tile when screen share toggles).
		meeting.self.on("videoUpdate", bump);
		meeting.self.on("audioUpdate", bump);
		meeting.self.on("screenShareUpdate", bump);

		// Active-speaker tracking — sets the speaking-border id.
		const onSpeaker = (payload: { peerId: string }) => {
			setActiveSpeakerId(payload.peerId);
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(meeting.participants as any).on("activeSpeaker", onSpeaker);

		return () => {
			try {
				joined.off("participantJoined", onJoined);
				joined.off("participantLeft", onLeft);
				for (const p of initial) unsubscribeP(p);
				meeting.self.off("videoUpdate", bump);
				meeting.self.off("audioUpdate", bump);
				meeting.self.off("screenShareUpdate", bump);
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(meeting.participants as any).off("activeSpeaker", onSpeaker);
			} catch {
				// SDK already torn down.
			}
		};
	}, [meeting]);

	const toggleAudio = useCallback(async () => {
		setError(null);
		try {
			if (meeting.self.audioEnabled) await meeting.self.disableAudio();
			else await meeting.self.enableAudio();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [meeting]);

	const toggleVideo = useCallback(async () => {
		setError(null);
		try {
			if (meeting.self.videoEnabled) await meeting.self.disableVideo();
			else await meeting.self.enableVideo();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [meeting]);

	const toggleScreen = useCallback(async () => {
		setError(null);
		try {
			if (meeting.self.screenShareEnabled) await meeting.self.disableScreenShare();
			else await meeting.self.enableScreenShare();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [meeting]);

	const onLeave = useCallback(async () => {
		try {
			await meeting.leaveRoom();
		} catch (err) {
			console.warn("CallView: leaveRoom threw, closing sheet anyway", err);
		}
		onLeaveRequested();
	}, [meeting, onLeaveRequested]);

	// Spotlight pin lives in the call context so the App-level PIP
	// panel can read which participant to miniaturize.  null =
	// thumbnail row mode; participant id = spotlight on that one.
	// Click a thumbnail to pin; click the spotlight to unpin;
	// ‹ › arrows cycle.  Auto-clears if the pinned participant
	// leaves the room.
	const { spotlitId: pinnedId, setSpotlight, activeCall, popOutToWindow, popInToMain, browserSession } = useCall();

	// FaceTime-style pop-out: only offered in the desktop shell's
	// main window.  Hidden in plain browsers (no native pop-out path
	// for v1) and hidden inside the call window itself (you can't
	// pop out twice).  Same gating as the PIP panel's pop-out button
	// so the two affordances stay in sync.
	const onPopOut = isDesktopShell() && !isCallWindow()
		? () => { void popOutToWindow(); }
		: undefined;

	// Inverse of pop-out: send the call back into the main window
	// and close this OS window.  Only meaningful inside the call
	// window.
	const onPopIn = isCallWindow()
		? () => { void popInToMain(); }
		: undefined;

	// Fullscreen toggle is wired inside the call window only.  The
	// main window has its own decorations / non-fullscreen behaviour
	// and the call surface there is just a pane inside chat.
	const onFullscreen = isCallWindow()
		? () => { void toggleCallWindowFullscreen(); }
		: undefined;

	const toggleBrowser = useCallback(async () => {
		if (!activeCall) return;
		setError(null);
		try {
			if (browserSession) {
				await stopBrowserSession({ accessToken: activeCall.accessToken, roomId: activeCall.roomId });
			} else {
				await startBrowserSession({ accessToken: activeCall.accessToken, roomId: activeCall.roomId });
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [activeCall, browserSession]);

	const togglePin = useCallback((id: string) => {
		setSpotlight(pinnedId === id ? null : id);
	}, [pinnedId, setSpotlight]);

	// Build the tile order ONCE per render: camera tiles first
	// (self → remotes), then a SECOND tile for anyone whose screen
	// share is active (self → remotes again).  Cameras-before-
	// screens reads as "people first, content second" and matches
	// what every other call app does.  Each entry has a unique key
	// so the spotlight pin can address camera + screen
	// independently.
	const allTiles = useMemo(() => {
		const tiles: Array<{ key: string; participant: RTKParticipant | RTKSelf; isSelf: boolean; mode: "camera" | "screen" }> = [
			{ key: meeting.self.id, participant: meeting.self, isSelf: true, mode: "camera" },
			...remoteParticipants.map(p => ({ key: p.id, participant: p, isSelf: false, mode: "camera" as const })),
		];
		if (meeting.self.screenShareEnabled) {
			tiles.push({ key: `${meeting.self.id}#screen`, participant: meeting.self, isSelf: true, mode: "screen" });
		}
		for (const p of remoteParticipants) {
			if (p.screenShareEnabled) {
				tiles.push({ key: `${p.id}#screen`, participant: p, isSelf: false, mode: "screen" });
			}
		}
		return tiles;
		// participantsTick captures join/leave + per-participant
		// media-update bumps so this re-derives when anyone toggles
		// their screen share (or video / audio).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [meeting.self, remoteParticipants, participantsTick]);
	const totalTiles = allTiles.length;

	// Drop the pin if the pinned participant left the room mid-call.
	useEffect(() => {
		if (pinnedId && !allTiles.some(t => t.key === pinnedId)) {
			setSpotlight(null);
		}
	}, [allTiles, pinnedId, setSpotlight]);

	// In a 1:1 DM, auto-spotlight the OTHER person the moment they
	// join.  Most people would rather see the person they're
	// talking to than themselves as the main tile; auto-pinning
	// matches that intuition without forcing the user to click.
	// Fires exactly once per call (tracked via ref) so it doesn't
	// fight the user if they manually unpin later.  Only applies
	// to camera tiles — screen-share tiles stay unpinned by
	// default so they're discoverable but not forced.
	const autoPinnedDmPeerRef = useRef(false);
	useEffect(() => {
		if (!activeCall?.isDm) return;
		if (autoPinnedDmPeerRef.current) return;
		const peer = remoteParticipants[0];
		if (!peer) return;
		autoPinnedDmPeerRef.current = true;
		setSpotlight(peer.id);
	}, [activeCall?.isDm, remoteParticipants, setSpotlight]);
	// Reset the auto-pin flag whenever the call ends so the next
	// call gets the auto-pin treatment too.
	useEffect(() => {
		if (!activeCall) autoPinnedDmPeerRef.current = false;
	}, [activeCall]);

	const cyclePin = useCallback((dir: 1 | -1) => {
		if (pinnedId === null) {
			setSpotlight(allTiles[0]?.key ?? null);
			return;
		}
		const idx = allTiles.findIndex(t => t.key === pinnedId);
		if (idx === -1) {
			setSpotlight(allTiles[0]?.key ?? null);
			return;
		}
		const next = (idx + dir + allTiles.length) % allTiles.length;
		setSpotlight(allTiles[next]?.key ?? null);
	}, [allTiles, pinnedId, setSpotlight]);

	const pinnedTile = pinnedId ? allTiles.find(t => t.key === pinnedId) : null;

	// When the shared browser is active it forces a spotlight layout,
	// overriding any manual pin.  Participant tiles move to the strip.
	const hasBrowser = !!browserSession;
	const effectivePinned = hasBrowser ? true : !!pinnedTile;

	return (
		<div className="flex-1 flex flex-col min-h-0">
			<div className="shrink-0 px-4 py-2 border-b border-border text-xs text-muted-foreground text-center">
				Live in <span className="text-foreground font-medium">{roomName}</span>
				{" · "}{totalTiles} {totalTiles === 1 ? "person" : "people"}
				{hasBrowser && <span className="ml-1 text-primary"> · shared browser</span>}
			</div>

			{/* Body — flex column with three rows depending on mode:
			      1. tile area (fills available space)
			      2. thumbnail strip (only in spotlight mode)
			      3. control bar
			    The bar floats over row 1 in solo + grid modes (chrome
			    out of the way, hover-revealed).  In spotlight mode
			    it sits inline above the strip — no overlap, both
			    always visible since the strip is already eating
			    chrome real estate so hiding the controls would just
			    be inconsistent.
			    `group` keeps the hover-fade behavior live for the
			    floating variant.  `min-h-0` on the tile row is
			    critical so a wide 16:9 doesn't blow past 85vh. */}
			<div className="relative flex-1 min-h-0 group bg-background flex flex-col">
				<div className="relative flex-1 min-h-0 flex items-center justify-center p-4">
					{hasBrowser ? (
						/* Shared browser spotlight: the Hyperbeam embed
						   fills the tile area; participant tiles move to
						   the thumbnail strip below. */
						<SharedBrowserTile
							embedUrl={browserSession!.embedUrl}
							className="max-h-full max-w-full"
						/>
					) : totalTiles === 1 ? (
						/* Solo case: just self, centered + fit-to-fill. */
						<div className="aspect-video max-h-full max-w-full w-auto">
							<ParticipantTile
								participant={meeting.self}
								isSelf
								isSpeaking={activeSpeakerId === meeting.self.id}
							/>
						</div>
					) : pinnedTile ? (
						/* Spotlight: pinned tile fills the tile-area row.
						   Click it to unpin.  Arrows cycle through. */
						<>
							<button
								type="button"
								onClick={() => setSpotlight(null)}
								className="aspect-video max-h-full max-w-full w-auto"
								aria-label="Unpin (return to grid)"
								title="Click to return to thumbnail view"
							>
								<ParticipantTile
									participant={pinnedTile.participant}
									isSelf={pinnedTile.isSelf}
									isSpeaking={activeSpeakerId === pinnedTile.key}
									mode={pinnedTile.mode}
								/>
							</button>
							{totalTiles > 1 && (
								<>
									<CycleArrow direction="prev" onClick={() => cyclePin(-1)} />
									<CycleArrow direction="next" onClick={() => cyclePin(1)} />
								</>
							)}
						</>
					) : (
						/* Default grid: equally-sized thumbnails wrap-
						   centered.  Click any to spotlight. */
						<div className="flex flex-wrap items-center justify-center gap-3 max-w-full">
							{allTiles.map(t => (
								<button
									key={t.key}
									type="button"
									onClick={() => togglePin(t.key)}
									className="w-[260px] aspect-video"
									aria-label={`Spotlight ${t.participant.name || (t.isSelf ? "yourself" : "this participant")}`}
									title="Click to spotlight"
								>
									<ParticipantTile
										participant={t.participant}
										isSelf={t.isSelf}
										isSpeaking={activeSpeakerId === t.key}
										mode={t.mode}
									/>
								</button>
							))}
						</div>
					)}

					{/* Floating control bar — solo + grid modes only.
					    In spotlight / browser mode the strip below
					    already consumes chrome space; the inline bar
					    variant further down handles that case. */}
					{!effectivePinned && (
						<ControlBar
							floating
							audioOn={audioOn}
							videoOn={videoOn}
							screenOn={screenOn}
							browserOn={hasBrowser}
							toggleAudio={toggleAudio}
							toggleVideo={toggleVideo}
							toggleScreen={toggleScreen}
							toggleBrowser={toggleBrowser}
							onLeave={onLeave}
							onPopOut={onPopOut}
							onPopIn={onPopIn}
							onFullscreen={onFullscreen}
						/>
					)}
				</div>

				{effectivePinned && (
					/* Spotlight / browser bottom chrome — controls +
					   thumbnail strip stack inline so they never
					   overlap. */
					<div
						className="shrink-0 flex flex-col items-center gap-2 px-4 pb-3 pt-1"
						style={
							isMobileShell
								? { paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }
								: undefined
						}
					>
						<ControlBar
							floating={false}
							audioOn={audioOn}
							videoOn={videoOn}
							screenOn={screenOn}
							browserOn={hasBrowser}
							toggleAudio={toggleAudio}
							toggleVideo={toggleVideo}
							toggleScreen={toggleScreen}
							toggleBrowser={toggleBrowser}
							onLeave={onLeave}
							onPopOut={onPopOut}
							onPopIn={onPopIn}
							onFullscreen={onFullscreen}
						/>
						<ThumbnailStrip
							tiles={allTiles}
							pinnedId={pinnedId}
							activeSpeakerId={activeSpeakerId}
							onTileClick={togglePin}
						/>
					</div>
				)}

				{/* Errors stack at top-center so they don't fight with
				    the control bar.  Always visible when present. */}
				{error && (
					<div className="absolute top-3 left-1/2 -translate-x-1/2 max-w-md text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
						{error}
					</div>
				)}
			</div>
		</div>
	);
}

/** Pill of mic / cam / screen / leave buttons.  Two visual modes:
 *  `floating` overlays it absolute bottom-center of its parent
 *  with a hover fade — used in solo + grid modes where the chrome
 *  should stay out of the way.  Non-floating renders inline so it
 *  participates in the parent's flex flow — used in spotlight
 *  mode where the thumbnail strip below would otherwise be
 *  fighting for the same bottom space. */
function ControlBar({
	floating, audioOn, videoOn, screenOn, browserOn,
	toggleAudio, toggleVideo, toggleScreen, toggleBrowser, onLeave,
	onPopOut, onPopIn, onFullscreen,
}: {
	floating: boolean;
	audioOn: boolean;
	videoOn: boolean;
	screenOn: boolean;
	browserOn: boolean;
	toggleAudio(): void;
	toggleVideo(): void;
	toggleScreen(): void;
	toggleBrowser(): void;
	onLeave(): void;
	// Pop the call into a dedicated OS window (FaceTime-style).
	// Undefined when the affordance isn't applicable to the current
	// host (browser, mobile shell, or the call window itself).
	onPopOut?: () => void;
	// Inverse of onPopOut: send the call back into the main window.
	// Only set inside the popped-out call window; undefined elsewhere.
	onPopIn?: () => void;
	// Toggle native fullscreen on the current OS window.  Only set
	// inside the popped-out call window; undefined elsewhere.
	onFullscreen?: () => void;
}) {
	return (
		<div
			className={cn(
				"flex items-center gap-2 px-3 py-2 rounded-full",
				"bg-card/95 backdrop-blur-sm border border-border shadow-lg",
				floating
					? cn(
						"absolute left-1/2 -translate-x-1/2",
						// Mobile: bar stays visible always (no hover
						// on touch devices) — the inline style on this
						// element positions it above the iOS home
						// indicator via env(safe-area-inset-bottom).
						// Desktop: hover-gated so the chrome stays
						// out of the way until the user reaches for
						// it; bottom-4 (16px) is fine since desktop
						// has no safe-area inset.
						isMobileShell
							? ""
							: cn(
								"bottom-4",
								"opacity-0 group-hover:opacity-100 focus-within:opacity-100",
								"transition-opacity duration-150",
							),
					)
					: "",
			)}
			style={
				floating && isMobileShell
					? { bottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)" }
					: undefined
			}
		>
			<ControlButton
				active={audioOn}
				onClick={toggleAudio}
				iconOn={<Mic className="h-5 w-5" />}
				iconOff={<MicOff className="h-5 w-5" />}
				label={audioOn ? "Mute" : "Unmute"}
			/>
			<ControlButton
				active={videoOn}
				onClick={toggleVideo}
				iconOn={<Video className="h-5 w-5" />}
				iconOff={<VideoOff className="h-5 w-5" />}
				label={videoOn ? "Stop video" : "Start video"}
			/>
			<ControlButton
				active={screenOn}
				onClick={toggleScreen}
				iconOn={<MonitorUp className="h-5 w-5" />}
				iconOff={<MonitorOff className="h-5 w-5" />}
				label={screenOn ? "Stop sharing" : "Share screen"}
			/>
			<button
				type="button"
				onClick={toggleBrowser}
				aria-label={browserOn ? "Stop shared browser" : "Share browser"}
				title={browserOn ? "Stop shared browser" : "Share browser"}
				className={cn(
					"h-11 w-11 rounded-full flex items-center justify-center transition-colors",
					browserOn
						? "bg-primary hover:bg-primary/90 text-primary-foreground"
						: "bg-muted hover:bg-accent text-foreground",
				)}
			>
				<Globe className="h-5 w-5" />
			</button>
			{onPopOut && (
				<button
					type="button"
					onClick={onPopOut}
					aria-label="Open call in its own window"
					title="Open call in its own window"
					className="h-11 w-11 rounded-full flex items-center justify-center bg-muted hover:bg-accent text-foreground transition-colors"
				>
					<PictureInPicture2 className="h-5 w-5" />
				</button>
			)}
			{onPopIn && (
				<button
					type="button"
					onClick={onPopIn}
					aria-label="Send call back to main window"
					title="Send call back to main window"
					className="h-11 w-11 rounded-full flex items-center justify-center bg-muted hover:bg-accent text-foreground transition-colors"
				>
					<PictureInPicture className="h-5 w-5" />
				</button>
			)}
			{onFullscreen && (
				<button
					type="button"
					onClick={onFullscreen}
					aria-label="Toggle fullscreen"
					title="Toggle fullscreen"
					className="h-11 w-11 rounded-full flex items-center justify-center bg-muted hover:bg-accent text-foreground transition-colors"
				>
					<Maximize className="h-5 w-5" />
				</button>
			)}
			<div className="w-1" />
			<Button
				variant="destructive"
				onClick={onLeave}
				className="gap-2 rounded-full"
			>
				<PhoneOff className="h-4 w-4" />
				Leave
			</Button>
		</div>
	);
}

/** Square media-control button.  Theme-tinted when ON, destructive
 *  red when OFF — same convention as the pre-join screen so the
 *  visual language is consistent across the call lifecycle. */
function ControlButton({
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
				"h-11 w-11 rounded-full flex items-center justify-center transition-colors",
				active
					? "bg-muted hover:bg-accent text-foreground"
					: "bg-destructive hover:bg-destructive/90 text-destructive-foreground",
			)}
		>
			{active ? iconOn : iconOff}
		</button>
	);
}

/** Bottom strip of thumbnails shown in spotlight mode.  Renders one
 *  small tile per participant (including the pinned one — keeping
 *  the lineup complete reads better than hiding the spotlight's
 *  thumbnail).  Click any thumb to swap the spotlight to it. */
function ThumbnailStrip({
	tiles, pinnedId, activeSpeakerId, onTileClick,
}: {
	tiles: Array<{ key: string; participant: RTKParticipant | RTKSelf; isSelf: boolean; mode: "camera" | "screen" }>;
	pinnedId: string | null;
	activeSpeakerId: string | null;
	onTileClick(id: string): void;
}) {
	return (
		<div className="shrink-0 flex items-center justify-center gap-2 overflow-x-auto">
			{tiles.map(t => {
				const isPinned = t.key === pinnedId;
				return (
					<button
						key={t.key}
						type="button"
						onClick={() => onTileClick(t.key)}
						className={cn(
							"shrink-0 w-[140px] aspect-video rounded-lg",
							"transition-opacity",
							isPinned ? "opacity-60" : "opacity-100 hover:opacity-90",
						)}
						aria-label={isPinned ? "Unpin (return to grid)" : `Spotlight ${t.participant.name || (t.isSelf ? "yourself" : "this participant")}`}
						title={isPinned ? "Currently spotlit — click to unpin" : "Click to spotlight"}
					>
						<ParticipantTile
							participant={t.participant}
							isSelf={t.isSelf}
							isSpeaking={activeSpeakerId === t.key}
							mode={t.mode}
						/>
					</button>
				);
			})}
		</div>
	);
}

/** ‹ or › arrow floated over the spotlight tile to cycle through
 *  participants without having to find + click a thumbnail.  Fades
 *  in on hover (same group-hover behavior as the control bar) so
 *  the chrome stays out of the way most of the time. */
function CycleArrow({
	direction, onClick,
}: {
	direction: "prev" | "next";
	onClick(): void;
}) {
	const Icon = direction === "prev" ? ChevronLeft : ChevronRight;
	const positionalClass = direction === "prev" ? "left-2" : "right-2";
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={direction === "prev" ? "Previous participant" : "Next participant"}
			title={direction === "prev" ? "Previous participant" : "Next participant"}
			className={cn(
				"absolute top-1/2 -translate-y-1/2", positionalClass,
				"h-10 w-10 rounded-full flex items-center justify-center",
				"bg-card/95 backdrop-blur-sm border border-border shadow-lg",
				"text-foreground hover:bg-accent",
				"opacity-0 group-hover:opacity-100 focus:opacity-100",
				"transition-opacity duration-150",
			)}
		>
			<Icon className="h-5 w-5" />
		</button>
	);
}

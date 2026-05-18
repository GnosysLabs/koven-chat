// Draggable picture-in-picture panel.  Replaces the Discord-style
// "in call" mini-strip — instead of a thin pill in the sidebar
// you get a real video tile floating in the corner of the
// viewport.  Drag it anywhere; click it to jump back into the call
// room; mute / leave from a hover overlay.
//
// Renders only when:
//   - There's a joined call (phase === "joined") AND
//   - The user is currently viewing a DIFFERENT room than the call
//     (no point miniaturizing what's already filling the chat pane).
//
// Content rule: shows whichever participant is spotlit in the call
// view.  No spotlight → falls back to self.  When the spotlit
// participant leaves the room the call context clears the
// spotlight, which falls through here to "show self" so the panel
// stays useful instead of going blank.
//
// Position: persisted to localStorage so the panel stays where you
// put it across reloads and across calls.  Defaults to bottom-left
// with a 16px margin.  On window resize we clamp to keep it
// on-screen — without that, shrinking the window orphan-positions
// the panel beyond the viewport and you can't drag it back.
//
// Drag vs click distinction: pointer-down records the start
// coords; pointer-up only fires the click handler if total
// movement was under DRAG_THRESHOLD_PX.  Same pattern every modern
// drag-to-reposition control uses (Spotify mini-player, Teams PIP).

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";
import type { RTKParticipant, RTKSelf } from "@cloudflare/realtimekit-react";
import { useCall } from "@/lib/call-context";
import { ParticipantTile } from "@/components/voice/ParticipantTile";
import { cn } from "@/lib/utils";
import { isMobileShell } from "@/lib/mobile";
import { isCallWindow, isDesktopShell } from "@/lib/native-window";
import { Globe, Mic, MicOff, PhoneOff, Maximize2, PictureInPicture2, Video, VideoOff } from "lucide-react";
import type { RoomId } from "@koven/shared";

export interface CallPipPanelProps {
	currentRoomId: RoomId | null;
	onJumpToCallRoom(roomId: RoomId): void;
}

// 16:9 panel sized to feel "small but readable".  Numbers picked to
// match Discord's PIP roughly (240×135 with chrome).  Both halves
// of the aspect must update together.
const PIP_WIDTH = 240;
const PIP_HEIGHT = 135;
const VIEWPORT_MARGIN = 16;
const DRAG_THRESHOLD_PX = 5;
const STORAGE_KEY = "koven:call-pip-position";

export function CallPipPanel({ currentRoomId, onJumpToCallRoom }: CallPipPanelProps) {
	const { activeCall, phase, endCall, inCallView, setInCallView } = useCall();

	// Show whenever there's a joined call AND the user isn't
	// actually looking at the call surface right now.  The
	// "actually looking" check is two-pronged: inCallView must be
	// true AND the user must be in the call's room — both have to
	// hold for the call view to render in the chat pane.  Any
	// other state (chat view of the call's room, DMs, Bots,
	// Explore, a different space) should show the PIP so the user
	// can get back in one click.  Earlier this used `if
	// (inCallView) return null`, which created a bad state when
	// the user navigated to DMs / Bots / Explore: those handlers
	// don't flip inCallView (they only change activeSpace), so
	// inCallView stayed true and the PIP hid even though the call
	// view wasn't rendering anywhere.
	if (phase !== "joined") return null;
	if (!activeCall) return null;
	if (inCallView && activeCall.roomId === currentRoomId) return null;

	return (
		<CallPipPanelInner
			activeCall={activeCall}
			currentRoomId={currentRoomId}
			onJumpToCallRoom={onJumpToCallRoom}
			setInCallView={setInCallView}
			onLeave={endCall}
		/>
	);
}

/** Inner component splits out so we can call useRealtimeKitMeeting()
 *  unconditionally — the parent's early-returns guarantee the
 *  RealtimeKitProvider is mounted by the time we get here. */
function CallPipPanelInner({
	activeCall, currentRoomId, onJumpToCallRoom, setInCallView, onLeave,
}: {
	activeCall: { roomId: RoomId; roomName: string };
	currentRoomId: RoomId | null;
	onJumpToCallRoom(roomId: RoomId): void;
	setInCallView(b: boolean): void;
	onLeave(): Promise<void>;
}) {
	const { meeting } = useRealtimeKitMeeting();
	const { spotlitId, popOutToWindow, browserSession } = useCall();

	// Pop-out is only offered in the desktop shell's main window:
	// the call window doesn't render the PIP at all, and plain
	// browsers have no native multi-window path in v1.  Matches the
	// gating in CallView so both pop-out affordances appear and
	// disappear together.
	const canPopOut = isDesktopShell() && !isCallWindow();

	// Pick which participant to show in the panel.  Spotlit one
	// when set, else self.  Listening to the joined-map mutations
	// keeps the choice fresh as people come and go.
	const [_tick, setTick] = useState(0);
	useEffect(() => {
		const bump = () => setTick(t => t + 1);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const joined = meeting.participants.joined as any;
		joined.on("participantJoined", bump);
		joined.on("participantLeft", bump);
		return () => {
			try {
				joined.off("participantJoined", bump);
				joined.off("participantLeft", bump);
			} catch { /* SDK torn down */ }
		};
	}, [meeting]);

	const showBrowser = spotlitId === "browser" && !!browserSession;

	let pipParticipant: RTKParticipant | RTKSelf = meeting.self;
	let pipIsSelf = true;
	if (!showBrowser && spotlitId && spotlitId !== meeting.self.id) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const joined = meeting.participants.joined as any;
		const candidate: RTKParticipant | undefined =
			typeof joined.get === "function"
				? (joined.get(spotlitId) as RTKParticipant | undefined)
				: undefined;
		if (candidate) {
			pipParticipant = candidate;
			pipIsSelf = false;
		}
	}

	// Mirror self.audioEnabled + videoEnabled for the toggle buttons.
	// Both react to the SDK's per-property events so external
	// toggles (from CallView's bar, hotkeys later, etc.) keep the
	// PIP buttons honest.
	const [audioOn, setAudioOn] = useState<boolean>(meeting.self.audioEnabled);
	const [videoOn, setVideoOn] = useState<boolean>(meeting.self.videoEnabled);
	useEffect(() => {
		const onAudio = (p: { audioEnabled: boolean }) => setAudioOn(p.audioEnabled);
		const onVideo = (p: { videoEnabled: boolean }) => setVideoOn(p.videoEnabled);
		meeting.self.on("audioUpdate", onAudio);
		meeting.self.on("videoUpdate", onVideo);
		return () => {
			try {
				meeting.self.off("audioUpdate", onAudio);
				meeting.self.off("videoUpdate", onVideo);
			} catch { /* SDK torn down */ }
		};
	}, [meeting]);

	// Position state with localStorage persistence.  Init to
	// bottom-left.  On viewport resize we clamp so the panel
	// can't drift off-screen.
	const [pos, setPos] = useState(() => readSavedPosition());
	useEffect(() => {
		const onResize = () => setPos(p => clampToViewport(p));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);
	// Initial clamp on mount in case localStorage held a stale
	// position from a wider viewport.
	useEffect(() => {
		setPos(p => clampToViewport(p));
	}, []);

	// Drag bookkeeping.  We track via refs to avoid re-render churn
	// during the drag — only commit to state on pointer up.
	const dragStartRef = useRef<{ pointerX: number; pointerY: number; posX: number; posY: number } | null>(null);
	const isDraggingRef = useRef(false);
	const containerRef = useRef<HTMLDivElement | null>(null);

	const onPointerDown = useCallback((e: React.PointerEvent) => {
		// Don't start a drag from inside a button — let the button
		// handle its own click.  Defensive: the buttons' own
		// stopPropagation also handles this, but checking the
		// target avoids a flicker if event bubbling order ever
		// changes.
		const target = e.target as HTMLElement;
		if (target.closest("button")) return;
		dragStartRef.current = {
			pointerX: e.clientX,
			pointerY: e.clientY,
			posX: pos.x,
			posY: pos.y,
		};
		isDraggingRef.current = false;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}, [pos.x, pos.y]);

	const onPointerMove = useCallback((e: React.PointerEvent) => {
		const start = dragStartRef.current;
		if (!start) return;
		const dx = e.clientX - start.pointerX;
		const dy = e.clientY - start.pointerY;
		// Only flip into "dragging" once we've crossed the threshold —
		// keeps small movement-jitter on click from registering as a
		// drag and suppressing the click handler.
		if (!isDraggingRef.current && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
			isDraggingRef.current = true;
		}
		if (isDraggingRef.current) {
			setPos(clampToViewport({ x: start.posX + dx, y: start.posY + dy }));
		}
	}, []);

	const onPointerUp = useCallback((e: React.PointerEvent) => {
		const start = dragStartRef.current;
		if (!start) return;
		const wasDragging = isDraggingRef.current;
		dragStartRef.current = null;
		isDraggingRef.current = false;
		try {
			(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		} catch { /* nothing was captured */ }
		if (wasDragging) {
			savePosition(pos);
			return;
		}
		// Treat as click → enter the call view.  If the user is
		// already in the call's room (just reading chat) we only
		// need to flip the view flag.  Otherwise we also navigate
		// to the call's room.
		setInCallView(true);
		if (currentRoomId !== activeCall.roomId) {
			onJumpToCallRoom(activeCall.roomId);
		}
	}, [pos, activeCall.roomId, currentRoomId, onJumpToCallRoom, setInCallView]);

	async function toggleAudio(e: React.MouseEvent) {
		e.stopPropagation();
		try {
			if (meeting.self.audioEnabled) await meeting.self.disableAudio();
			else await meeting.self.enableAudio();
		} catch (err) {
			console.warn("CallPipPanel: toggleAudio failed", err);
		}
	}

	async function toggleVideo(e: React.MouseEvent) {
		e.stopPropagation();
		try {
			if (meeting.self.videoEnabled) await meeting.self.disableVideo();
			else await meeting.self.enableVideo();
		} catch (err) {
			console.warn("CallPipPanel: toggleVideo failed", err);
		}
	}

	function handleLeave(e: React.MouseEvent) {
		e.stopPropagation();
		void onLeave();
	}

	return (
		<div
			ref={containerRef}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			style={{
				position: "fixed",
				left: pos.x,
				top: pos.y,
				width: PIP_WIDTH,
				height: PIP_HEIGHT,
				zIndex: 50,
				touchAction: "none",
			}}
			className={cn(
				"group cursor-grab active:cursor-grabbing select-none",
				"rounded-lg overflow-hidden shadow-2xl ring-1 ring-border",
			)}
			role="button"
			aria-label={`Return to Live in ${activeCall.roomName}`}
			title={`Click to return to Live in ${activeCall.roomName}`}
		>
			{showBrowser ? (
				<div className="w-full h-full bg-muted flex flex-col items-center justify-center gap-1">
					<Globe className="h-6 w-6 text-primary" />
					<span className="text-[10px] text-muted-foreground">Shared Browser</span>
				</div>
			) : (
				<ParticipantTile
					participant={pipParticipant}
					isSelf={pipIsSelf}
					isSpeaking={false}
				/>
			)}

			{/* Controls overlay.  Critical: the OUTER overlay stays
			    pointer-events-none always — the individual buttons
			    flip pointer-events-auto on themselves.  That way
			    empty space inside the panel still passes pointer-
			    down events through to the outer drag handler, while
			    button taps register on the buttons.  Earlier this
			    used a full-overlay pointer-events-auto on hover,
			    which made "click to drag" silently reopen the call
			    view because the maximize button ate the pointer-
			    down.
			    Visibility: on hover-capable devices the overlay
			    fades in on hover (chrome out of the way).  On touch
			    devices there's no hover, so it stays visible — the
			    user just navigated away from the call surface and
			    needs the controls right there.  Backdrop is dropped
			    on mobile too: a permanent dark wash would smother
			    the video, and the per-button backgrounds give
			    enough contrast on their own. */}
			<div
				className={cn(
					"absolute inset-0 flex flex-col justify-between p-1.5 pointer-events-none",
					isMobileShell
						? "opacity-100"
						: cn(
							"bg-black/40 opacity-0",
							"group-hover:opacity-100",
							"transition-opacity duration-150",
						),
				)}
			>
				<div className="flex items-center justify-between gap-1">
					<div className="text-[10px] uppercase tracking-wider text-white/90 px-1.5 py-0.5 rounded bg-black/40">
						In Live
					</div>
					<div className="flex items-center gap-1">
						{canPopOut && (
							<PipButton
								onClick={(e) => {
									e.stopPropagation();
									// Hand the call off to a dedicated
									// FaceTime-style window.  Mints a
									// fresh token, tears down the main-
									// window meeting, spawns the call
									// window (see popOutToWindow in
									// call-context.tsx).  The PIP itself
									// disappears the moment the main-
									// window call ends (phase = idle),
									// so no manual hide needed here.
									void popOutToWindow();
								}}
								label={`Open ${activeCall.roomName} in its own window`}
							>
								<PictureInPicture2 className={cn(isMobileShell ? "h-4 w-4" : "h-3 w-3")} />
							</PipButton>
						)}
						<PipButton
							onClick={(e) => {
								e.stopPropagation();
								// Same flow as the body click: flip the
								// view flag, and only navigate the room
								// if we're not already there.  Without
								// the setInCallView this button just
								// took the user to the room's chat
								// (which is where they often already
								// are when the PIP is visible) — visual
								// no-op.  The flag is what actually
								// surfaces the call UI.
								setInCallView(true);
								if (currentRoomId !== activeCall.roomId) {
									onJumpToCallRoom(activeCall.roomId);
								}
							}}
							label={`Open Live in ${activeCall.roomName}`}
						>
							<Maximize2 className={cn(isMobileShell ? "h-4 w-4" : "h-3 w-3")} />
						</PipButton>
					</div>
				</div>
				<div className="flex items-center justify-end gap-1">
					<PipButton
						onClick={toggleAudio}
						label={audioOn ? "Mute" : "Unmute"}
						variant={audioOn ? "default" : "destructive"}
					>
						{audioOn ? <Mic className={cn(isMobileShell ? "h-4 w-4" : "h-3 w-3")} /> : <MicOff className={cn(isMobileShell ? "h-4 w-4" : "h-3 w-3")} />}
					</PipButton>
					<PipButton
						onClick={toggleVideo}
						label={videoOn ? "Stop video" : "Start video"}
						variant={videoOn ? "default" : "destructive"}
					>
						{videoOn ? <Video className={cn(isMobileShell ? "h-4 w-4" : "h-3 w-3")} /> : <VideoOff className={cn(isMobileShell ? "h-4 w-4" : "h-3 w-3")} />}
					</PipButton>
					<PipButton
						onClick={handleLeave}
						label="Leave call"
						variant="destructive"
					>
						<PhoneOff className={cn(isMobileShell ? "h-4 w-4" : "h-3 w-3")} />
					</PipButton>
				</div>
			</div>
		</div>
	);
}

/** Small overlay button used inside the PIP control chrome.  All
 *  buttons stop pointer-event propagation so clicking them doesn't
 *  trigger the outer container's drag/click handlers.
 *
 *  `pointer-events-auto` is critical: the parent overlay is now
 *  permanently `pointer-events-none` (so empty space passes drags
 *  through to the panel body), and only the buttons themselves
 *  need to catch taps.  Without this, the buttons would inherit
 *  the parent's none and be dead. */
function PipButton({
	children, onClick, label, variant = "default",
}: {
	children: React.ReactNode;
	onClick(e: React.MouseEvent): void;
	label: string;
	variant?: "default" | "destructive";
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			onPointerDown={(e) => e.stopPropagation()}
			aria-label={label}
			title={label}
			className={cn(
				"pointer-events-auto rounded flex items-center justify-center",
				// Mobile gets a real touch target (Apple HIG ≥ 44pt).
				// Desktop stays compact since the cursor is precise
				// and the overlay only appears on hover anyway.
				isMobileShell ? "h-9 w-9" : "h-6 w-6",
				variant === "destructive"
					? "bg-destructive/90 hover:bg-destructive text-destructive-foreground"
					: "bg-black/60 hover:bg-black/80 text-white",
			)}
		>
			{children}
		</button>
	);
}

// ─── Position persistence + clamping ────────────────────────────

function readSavedPosition(): { x: number; y: number } {
	if (typeof window === "undefined") return defaultPosition();
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return defaultPosition();
		const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
		if (typeof parsed?.x !== "number" || typeof parsed?.y !== "number") return defaultPosition();
		return clampToViewport({ x: parsed.x, y: parsed.y });
	} catch {
		return defaultPosition();
	}
}

function savePosition(pos: { x: number; y: number }): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
	} catch {
		// Private mode / quota / disabled localStorage — silently no-op.
	}
}

/** Bottom-left of the viewport with a comfortable margin.  Used
 *  for first-run + when the saved position fails to parse. */
function defaultPosition(): { x: number; y: number } {
	if (typeof window === "undefined") return { x: VIEWPORT_MARGIN, y: VIEWPORT_MARGIN };
	return {
		x: VIEWPORT_MARGIN,
		y: window.innerHeight - PIP_HEIGHT - VIEWPORT_MARGIN,
	};
}

/** Clamp a candidate position so the panel stays fully inside the
 *  viewport.  Re-applied on resize so a window-shrink doesn't
 *  strand the panel off-screen. */
function clampToViewport(pos: { x: number; y: number }): { x: number; y: number } {
	if (typeof window === "undefined") return pos;
	const maxX = window.innerWidth - PIP_WIDTH - VIEWPORT_MARGIN;
	const maxY = window.innerHeight - PIP_HEIGHT - VIEWPORT_MARGIN;
	return {
		x: Math.min(Math.max(VIEWPORT_MARGIN, pos.x), Math.max(VIEWPORT_MARGIN, maxX)),
		y: Math.min(Math.max(VIEWPORT_MARGIN, pos.y), Math.max(VIEWPORT_MARGIN, maxY)),
	};
}

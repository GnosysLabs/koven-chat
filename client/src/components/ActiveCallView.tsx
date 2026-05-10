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

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { Maximize2, Mic, MicOff, Minimize2, PhoneOff, Video, VideoOff } from "lucide-react";
import { CallEvent, CallState, CallType } from "matrix-js-sdk/lib/webrtc/call";
import type { MatrixCall } from "matrix-js-sdk/lib/webrtc/call";
import type { RoomId, UserId } from "@koven/shared";
import { cn } from "@/lib/utils";
import { startOutboundDial } from "@/lib/callRingtone";

// localStorage key for the user's last-set self-preview PIP offset
// (the small camera thumbnail INSIDE the call canvas).  Kept
// module-level so the lazy initializer in ActiveCallView and the
// persist handler in onPipMouseDown agree on the same key.
const PIP_POS_KEY = "koven.callPipOffset";
// Separate localStorage key for the MINIMIZED-mode floating
// thumbnail's position (the Discord-style PIP in the bottom-left
// when the user has navigated away from the call's room).  Kept
// distinct from PIP_POS_KEY so the two surfaces remember their
// positions independently — they live in different coordinate
// spaces (call canvas vs viewport) and a value valid for one is
// nonsense for the other.
const MINI_POS_KEY = "koven.callMiniOffset";

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

	// Remote stream's natural aspect ratio.  Defaults to 16:9 until
	// the video element fires loadedmetadata; updated when we know
	// the actual W:H so the modal sizes itself to fit the peer's
	// camera (no letterbox / pillarbox bars).  Stored as a CSS
	// `aspect-ratio` string ("W / H") so we can drop it straight
	// into a style prop.  Switches back to 16:9 when there's no
	// remote video (avatar fallback) so the modal isn't a tiny
	// portrait sliver while waiting for the call to connect.
	const [remoteAspect, setRemoteAspect] = useState<string>("16 / 9");
	const handleRemoteMetadata = () => {
		const v = remoteVideoRef.current;
		if (!v || !v.videoWidth || !v.videoHeight) return;
		setRemoteAspect(`${v.videoWidth} / ${v.videoHeight}`);
	};

	// Draggable position for the local self-preview PIP.  Stored as
	// an offset from the default bottom-right anchor (negative x =
	// further left, negative y = further up).  Persisted to
	// localStorage so the user's preferred spot survives page
	// reloads.  Read-once on mount via lazy initializer to skip the
	// localStorage roundtrip on every render.
	const [pipOffset, setPipOffset] = useState<{ x: number; y: number }>(() => {
		try {
			const raw = typeof localStorage !== "undefined"
				? localStorage.getItem(PIP_POS_KEY)
				: null;
			if (raw) {
				const parsed = JSON.parse(raw);
				if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
					return { x: parsed.x, y: parsed.y };
				}
			}
		} catch {
			// Bad JSON / no localStorage — fall through to default.
		}
		return { x: 0, y: 0 };
	});
	// Live size of the call canvas (the inner div the PIP is anchored
	// inside).  Tracked via ResizeObserver so we can clamp the PIP
	// offset to keep the thumbnail fully on-screen when the modal
	// resizes — viewport shrink, switch to portrait camera, reload
	// with a stale offset that no longer fits, etc.  Without this the
	// PIP can drift past the canvas edge into `overflow-hidden`
	// territory and become un-grabbable.
	const canvasSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
	// PIP geometry.  Default anchor is `absolute bottom-24 right-4`
	// (96px from bottom, 16px from right) and the box is `h-32 w-44`
	// (128 × 176).  Constants kept local so the clamp math stays
	// readable and any future class change is a one-line update.
	const PIP_W = 176;
	const PIP_H = 128;
	const PIP_RIGHT_INSET = 16;
	const PIP_BOTTOM_INSET = 96;
	const clampOffset = (offset: { x: number; y: number }): { x: number; y: number } => {
		const { w, h } = canvasSizeRef.current;
		// Pre-mount / not-yet-measured — pass through; the
		// ResizeObserver will re-clamp on first measurement.
		if (!w || !h) return offset;
		// Bounds derived from the default anchor:
		//   default top-left  = (w - PIP_RIGHT_INSET - PIP_W,
		//                        h - PIP_BOTTOM_INSET - PIP_H)
		//   after translate(x, y) the top-left moves by (x, y).
		// Constrain so the PIP stays fully inside the canvas — left
		// edge ≥ 0, right edge ≤ w, top edge ≥ 0, bottom edge ≤ h.
		const minX = PIP_RIGHT_INSET + PIP_W - w;
		const maxX = PIP_RIGHT_INSET;
		const minY = PIP_BOTTOM_INSET + PIP_H - h;
		const maxY = PIP_BOTTOM_INSET;
		return {
			x: Math.min(Math.max(offset.x, minX), maxX),
			y: Math.min(Math.max(offset.y, minY), maxY),
		};
	};
	// Callback ref + ResizeObserver for the canvas div.  Using a
	// callback ref instead of useRef + useEffect so observe / unobserve
	// happens automatically when the canvas mounts and unmounts (it
	// disappears in the minimized branch, then remounts on expand —
	// an effect with [] deps would only run once and miss the remount).
	const observerRef = useRef<ResizeObserver | null>(null);
	const canvasRef = useCallback((node: HTMLDivElement | null) => {
		// Tear down any previous observer before re-binding so we
		// don't leak observers on remount.
		observerRef.current?.disconnect();
		observerRef.current = null;
		if (!node) return;
		// Initialise size synchronously so the very first paint clamps
		// against real bounds instead of the {0, 0} placeholder.
		const rect = node.getBoundingClientRect();
		canvasSizeRef.current = { w: rect.width, h: rect.height };
		setPipOffset(prev => clampOffset(prev));
		const ro = new ResizeObserver(entries => {
			for (const entry of entries) {
				const { width, height } = entry.contentRect;
				canvasSizeRef.current = { w: width, h: height };
			}
			// Re-clamp current offset against the new canvas bounds.
			// Using functional setState so we don't miss concurrent
			// updates from an in-progress drag.
			setPipOffset(prev => clampOffset(prev));
		});
		ro.observe(node);
		observerRef.current = ro;
	}, []);
	// Track the in-progress drag.  Captured on mousedown, cleared on
	// mouseup.  Window-level listeners (not element-level) so the
	// drag doesn't break when the cursor leaves the PIP rectangle —
	// otherwise fast pointer moves would orphan the drag.
	const dragStateRef = useRef<{
		startMouseX: number;
		startMouseY: number;
		startOffsetX: number;
		startOffsetY: number;
	} | null>(null);
	const onPipMouseDown = (e: React.MouseEvent) => {
		// Skip drag init if the click started on a control inside
		// the PIP (we don't have any yet, but defensive).
		e.preventDefault();
		dragStateRef.current = {
			startMouseX: e.clientX,
			startMouseY: e.clientY,
			startOffsetX: pipOffset.x,
			startOffsetY: pipOffset.y,
		};
		const onMove = (ev: MouseEvent) => {
			const ds = dragStateRef.current;
			if (!ds) return;
			setPipOffset(clampOffset({
				x: ds.startOffsetX + (ev.clientX - ds.startMouseX),
				y: ds.startOffsetY + (ev.clientY - ds.startMouseY),
			}));
		};
		const onUp = () => {
			dragStateRef.current = null;
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			// Persist the final position only on drag END (not every
			// move event) — saves localStorage churn during a drag.
			try {
				localStorage.setItem(
					PIP_POS_KEY,
					JSON.stringify({ x: pipOffsetRef.current.x, y: pipOffsetRef.current.y }),
				);
			} catch {
				// localStorage unavailable — drag still works in-session.
			}
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};
	// Mirror pipOffset into a ref so the persist call inside onUp
	// (captured at mousedown time) sees the LATEST position rather
	// than the stale value at mousedown.
	const pipOffsetRef = useRef(pipOffset);
	useEffect(() => {
		pipOffsetRef.current = pipOffset;
	}, [pipOffset]);
	// Tear down the ResizeObserver when the component itself
	// unmounts (call ends).  Callback-ref cleanup handles
	// mount/unmount of the canvas node, but if the entire view
	// unmounts while the canvas is still mounted, the callback
	// ref's "node = null" branch runs first and clears it cleanly.
	// This guard is belt-and-suspenders for paranoia.
	useEffect(() => () => {
		observerRef.current?.disconnect();
		observerRef.current = null;
	}, []);

	// ─── Minimized-mode floating thumbnail draggability ─────────────
	//
	// Independent of the in-call PIP above.  When the call is
	// minimized to the Discord-style thumbnail, the user wants to be
	// able to drag it anywhere on the SPA viewport (not just within
	// the call canvas — there is no canvas in this mode, the
	// thumbnail floats over whatever room they navigated to).  Same
	// pattern as above: localStorage-persisted offset from the
	// default bottom-left anchor, ResizeObserver to track the
	// thumbnail's measured size for clamping, window resize listener
	// to re-clamp on viewport changes, and a drag handler with a
	// click-vs-drag threshold so a quick tap on the thumbnail body
	// still navigates back to the call's room.
	const [miniOffset, setMiniOffset] = useState<{ x: number; y: number }>(() => {
		try {
			const raw = typeof localStorage !== "undefined"
				? localStorage.getItem(MINI_POS_KEY)
				: null;
			if (raw) {
				const parsed = JSON.parse(raw);
				if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
					return { x: parsed.x, y: parsed.y };
				}
			}
		} catch {
			// Bad JSON / no localStorage — fall through.
		}
		return { x: 0, y: 0 };
	});
	const miniOffsetRef = useRef(miniOffset);
	useEffect(() => {
		miniOffsetRef.current = miniOffset;
	}, [miniOffset]);

	// Default anchor for the minimized thumbnail.  Mirrors the
	// `fixed bottom-4 left-4` Tailwind classes on the rendered
	// element below — keep these in sync if the className changes.
	const MINI_LEFT_INSET = 16;
	const MINI_BOTTOM_INSET = 16;
	// Live measured size of the minimized thumbnail (the video area's
	// height changes when the remote stream connects mid-call, so we
	// can't hardcode it).  Updated by the ResizeObserver in
	// miniRef below; consumed by clampMiniOffset to compute viewport
	// bounds that keep the thumbnail fully on-screen.
	const miniSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
	const clampMiniOffset = (offset: { x: number; y: number }): { x: number; y: number } => {
		if (typeof window === "undefined") return offset;
		const { w, h } = miniSizeRef.current;
		// Pre-measurement — bail through; the resize observer will
		// re-clamp on first paint.
		if (!w || !h) return offset;
		// Default top-left corner of the thumbnail:
		//   (MINI_LEFT_INSET,  window.innerHeight - MINI_BOTTOM_INSET - h)
		// After translate(x, y), top-left moves by (x, y).  Keep the
		// thumbnail fully inside the viewport — left edge ≥ 0, right
		// edge ≤ vw, top edge ≥ 0, bottom edge ≤ vh.
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const minX = -MINI_LEFT_INSET;
		const maxX = vw - MINI_LEFT_INSET - w;
		const minY = MINI_BOTTOM_INSET + h - vh;
		const maxY = MINI_BOTTOM_INSET;
		return {
			x: Math.min(Math.max(offset.x, minX), maxX),
			y: Math.min(Math.max(offset.y, minY), maxY),
		};
	};
	// Callback ref + ResizeObserver for the minimized div.  Same
	// reasoning as canvasRef above (callback ref handles
	// mount/unmount of the node automatically across the
	// minimized↔expanded toggle, where a useRef + useEffect with
	// `[]` deps would silently miss the remount).
	const miniObserverRef = useRef<ResizeObserver | null>(null);
	const miniRef = useCallback((node: HTMLDivElement | null) => {
		miniObserverRef.current?.disconnect();
		miniObserverRef.current = null;
		if (!node) return;
		const rect = node.getBoundingClientRect();
		miniSizeRef.current = { w: rect.width, h: rect.height };
		setMiniOffset(prev => clampMiniOffset(prev));
		const ro = new ResizeObserver(entries => {
			for (const entry of entries) {
				const { width, height } = entry.contentRect;
				miniSizeRef.current = { w: width, h: height };
			}
			setMiniOffset(prev => clampMiniOffset(prev));
		});
		ro.observe(node);
		miniObserverRef.current = ro;
	}, []);
	// Re-clamp on viewport resize — without this, dragging the
	// thumbnail to the right edge then shrinking the window would
	// orphan it past the new edge.  Window resize doesn't fire
	// inside the ResizeObserver above (that watches the THUMBNAIL,
	// not the viewport), so we need a dedicated listener.
	useEffect(() => {
		const onResize = () => setMiniOffset(prev => clampMiniOffset(prev));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);
	// Cleanup the resize observer when the view unmounts entirely.
	useEffect(() => () => {
		miniObserverRef.current?.disconnect();
		miniObserverRef.current = null;
	}, []);
	// Drag handler for the minimized thumbnail.  Threshold-based
	// click-vs-drag detection: small movements pass through to the
	// inner button (which navigates back to the call's room), larger
	// movements activate drag mode and suppress the synthetic click
	// that would otherwise fire on mouseup.  Window-level listeners
	// so fast cursor moves outside the thumbnail rectangle don't
	// orphan the drag.
	const onMiniMouseDown = (e: React.MouseEvent) => {
		// Don't preventDefault here — the inner navigate-back button
		// needs to receive its click event when this turns out to be
		// a tap rather than a drag.  We only call preventDefault once
		// movement exceeds the drag threshold (below).
		const startX = e.clientX;
		const startY = e.clientY;
		const startOffset = { x: miniOffset.x, y: miniOffset.y };
		let isDragging = false;
		const DRAG_THRESHOLD = 4; // px; tuned to feel like Discord/Slack
		const onMove = (ev: MouseEvent) => {
			const dx = ev.clientX - startX;
			const dy = ev.clientY - startY;
			if (!isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
				isDragging = true;
			}
			if (!isDragging) return;
			ev.preventDefault();
			setMiniOffset(clampMiniOffset({
				x: startOffset.x + dx,
				y: startOffset.y + dy,
			}));
		};
		const onUp = (_ev: MouseEvent) => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			if (isDragging) {
				// Persist the final position only on drag END.
				try {
					localStorage.setItem(
						MINI_POS_KEY,
						JSON.stringify({
							x: miniOffsetRef.current.x,
							y: miniOffsetRef.current.y,
						}),
					);
				} catch {
					// localStorage unavailable — drag still works in-session.
				}
				// Suppress the impending synthetic `click` event so the
				// inner button's onClick (navigate-back-to-call-room)
				// doesn't fire.  Capture-phase + once-only so we
				// intercept the very next click anywhere in the document
				// then remove ourselves cleanly — leaving the listener
				// installed would eat unrelated clicks afterwards.
				const suppressClick = (ce: MouseEvent) => {
					ce.preventDefault();
					ce.stopPropagation();
					window.removeEventListener("click", suppressClick, true);
				};
				window.addEventListener("click", suppressClick, true);
			}
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

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
			<div
				ref={miniRef}
				onMouseDown={onMiniMouseDown}
				style={{ transform: `translate(${miniOffset.x}px, ${miniOffset.y}px)` }}
				className="fixed bottom-4 left-4 z-[100] w-72 rounded-xl bg-black border border-white/15 shadow-2xl overflow-hidden flex flex-col cursor-grab active:cursor-grabbing select-none"
			>
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

			<div className="relative flex flex-col bg-black border border-white/10 rounded-2xl overflow-hidden shadow-2xl">

			{/* Main canvas — peer video or peer-avatar fallback.
			    Aspect ratio matches the peer's camera (or 16:9 while
			    waiting / on audio fallback) so the video fills the
			    canvas edge-to-edge with no letterbox / pillarbox.
			    Width capped at max-w-5xl + 80vw; height capped at
			    85vh minus the bottom control bar (h-24 = 6rem).
			    Aspect-ratio + bounded max-w/max-h auto-shrinks
			    correctly on portrait videos. */}
			<div
				ref={canvasRef}
				className="relative flex items-center justify-center overflow-hidden bg-black w-[80vw] max-w-5xl"
				style={{
					aspectRatio: showRemoteVideo ? remoteAspect : "16 / 9",
					maxHeight: "calc(85vh - 6rem)",
				}}
			>
				{showRemoteVideo ? (
					<video
						ref={remoteVideoRef}
						autoPlay
						playsInline
						onLoadedMetadata={handleRemoteMetadata}
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
				    need a self-view.  Draggable: the user grabs it and
				    moves it anywhere on the call canvas; the offset
				    persists to localStorage so it sticks across reloads.
				    `select-none` prevents text-selection cursor flicker
				    while dragging; `cursor-grab` (active: `grabbing`)
				    advertises the affordance. */}
				{isVideo && !videoMuted && (
					<video
						ref={localVideoRef}
						autoPlay
						playsInline
						muted
						onMouseDown={onPipMouseDown}
						style={{ transform: `translate(${pipOffset.x}px, ${pipOffset.y}px)` }}
						className="absolute bottom-24 right-4 h-32 w-44 rounded-lg object-cover border border-white/20 shadow-xl bg-black cursor-grab active:cursor-grabbing select-none"
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

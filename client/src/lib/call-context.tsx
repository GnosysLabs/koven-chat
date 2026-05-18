// CallProvider — app-level context that owns the Live call lifecycle
// so the call survives navigation.  Before this lifted out, the
// meeting client lived inside <VoiceCallSheet> and died the moment
// the dialog closed; switching rooms mid-call wasn't possible.
//
// The provider holds:
//   - `activeCall`  — the room we're calling in + its display name
//                     + the single-use auth token from the engine.
//                     null when there's no call in flight.
//   - `meeting`     — the RTKClient instance once initialised.  Same
//                     hook as before (useRealtimeKitClient), just
//                     hoisted here.
//   - `phase`       — state machine:
//                       "idle"       no call active
//                       "connecting" token in hand, SDK initialising
//                       "prejoin"    SDK ready, user hasn't hit Join
//                       "joined"     in the room, audio + video flowing
//
// And exposes actions:
//   - `startCall(roomId, roomName, authToken)`  begin the lifecycle
//   - `confirmJoin()`                            transition prejoin→joined
//   - `endCall()`                                tear down + reset
//
// Single-call enforcement: only one activeCall at a time.
// `startCall` while another is in-flight overwrites — RoomVoiceBar
// is responsible for the "leave current call?" confirm before calling
// in (this provider stays mechanical).
//
// The provider also wraps children in <RealtimeKitProvider> when a
// meeting exists, so any descendant component (ChatPane's inline
// call view, the mini-strip, the audio sink) can call
// useRealtimeKitMeeting() to grab the live client.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
	RealtimeKitProvider,
	useRealtimeKitClient,
} from "@cloudflare/realtimekit-react";
import { joinCall, pingCallPresenceJoined, pingCallPresenceLeft, type ActiveBrowserSession } from "@/lib/calls-api";
import { startRing, stopRing } from "@/lib/callRingtone";
import {
	closeCurrentWindow,
	drainPendingCall,
	isCallWindow,
	isDesktopShell,
	popInToMain as ipcPopInToMain,
	setPopInActive,
	spawnCallWindow,
} from "@/lib/native-window";
import { HOMESERVER_URL } from "@/lib/urls";
import type { RoomId } from "@koven/shared";

// Matrix custom event types for the DM-call ring lifecycle.
// Exported so the recipient-side listener (IncomingRingListener)
// matches on the same constants.
export const RING_EVENT_TYPE = "chat.koven.call.ring";
export const RING_CANCEL_EVENT_TYPE = "chat.koven.call.cancel";
export const RING_DECLINE_EVENT_TYPE = "chat.koven.call.decline";

/** Ring lifetime — after this the recipient's sheet auto-dismisses
 *  and the caller stops considering the ring "live."  Discord rings
 *  for ~30s; we match. */
export const RING_TIMEOUT_MS = 30_000;

export type CallPhase = "idle" | "connecting" | "prejoin" | "joined";

export interface ActiveCall {
	roomId: RoomId;
	roomName: string;
	authToken: string;
	// Caller's Koven access token — kept on ActiveCall (not as a
	// separate provider prop) because it's already in hand at
	// startCall time and lets the provider fire the iam-here /
	// iam-gone presence pings without plumbing a second source of
	// auth state through the React tree.
	accessToken: string;
	// True when this call is in a 1:1 DM.  Drives the ring
	// behavior: caller sends `chat.koven.call.ring` after joining,
	// caller sends `chat.koven.call.cancel` on leave (if the
	// recipient hasn't accepted yet).  Channel-style calls don't
	// ring — the avatar stack in the Live bar is the social
	// signal there.
	isDm?: boolean;
	// True when we're entering this call by ACCEPTING someone
	// else's incoming ring (vs. initiating one ourselves).
	// Suppresses our own outgoing ring on roomJoined (otherwise
	// recipient + caller would ring each other in a loop) and
	// flips the pre-join CTA copy from "Ring X" to "Join X" since
	// the user is answering, not ringing.
	isAnsweringRing?: boolean;
	// Initial mic + camera state.  Channel-style calls default
	// both off (Discord's "join muted" convention; user enables
	// in pre-join).  DMs may want defaults differently per the
	// caller's intent, but for v1 we keep the same off-by-default.
	defaults?: { audio?: boolean; video?: boolean };
	// True when entering the call as a pop-out from the main
	// window: the user was already in the meeting moments ago,
	// so skip the PreJoinScreen step and join directly.  The
	// connecting→prejoin transition honours this by calling
	// `meeting.joinRoom()` itself instead of handing off to
	// PreJoinScreen.  Used only by the call-window flow today.
	skipPrejoin?: boolean;
}

interface CallContextValue {
	activeCall: ActiveCall | null;
	phase: CallPhase;
	error: string | null;
	// Spotlit participant id when the user has expanded one tile in
	// the call view; null = thumbnail-row mode.  Lifted to the
	// context so the PIP-panel (rendered at App level, outside the
	// CallView component tree) can read which participant to
	// miniaturize.  CallView writes here instead of holding local
	// state.
	spotlitId: string | null;
	setSpotlight(id: string | null): void;
	// "Am I looking at the call?"  Discord-style: voice and chat
	// are separate views, even when they share a room.  When true
	// the chat pane swaps in the in-call surface (PreJoinScreen /
	// CallView).  When false the chat pane shows normal chat for
	// whatever activeRoomId is and the PIP appears so the call is
	// still reachable in one click.  startCall flips this to true
	// automatically (you just hit Join, you want to see the call);
	// any room click in the sidebar flips it to false (you went to
	// look at chat).  Clicking the PIP flips it back to true.
	inCallView: boolean;
	setInCallView(b: boolean): void;
	startCall(opts: ActiveCall): void;
	confirmJoin(): void;
	endCall(): Promise<void>;
	// Hand the current call off to a freely-resizable Tauri window
	// (FaceTime-style).  Mints a fresh single-use auth token, tears
	// down the current SDK session, then spawns the call window
	// with the new token + the user's current mic/cam state so the
	// pop-out lands directly in the joined state.  Brief
	// "Reconnecting…" gap is unavoidable while the SDK re-handshakes
	// (RealtimeKit's WebRTC session can't cross JS contexts).
	// No-op outside the desktop shell.
	popOutToWindow(): Promise<void>;
	// Inverse of popOutToWindow: pop the call from a popped-out
	// window back into the main window.  Mints a fresh token,
	// notifies main, leaves the call window's meeting, then closes
	// the call window.  Only meaningful inside the call window.
	popInToMain(): Promise<void>;
	// Active Hyperbeam shared browser session for the current call's
	// room.  Updated by the /active poll in RoomVoiceBar.  null when
	// no shared browser is running.
	browserSession: ActiveBrowserSession | null;
	setBrowserSession(s: ActiveBrowserSession | null): void;
}

const CallContext = createContext<CallContextValue | null>(null);

/** Read the call context.  Throws if used outside of <CallProvider> —
 *  better to fail loud at dev time than silently get a noop. */
export function useCall(): CallContextValue {
	const ctx = useContext(CallContext);
	if (!ctx) throw new Error("useCall must be used inside <CallProvider>");
	return ctx;
}

export function CallProvider({ children }: { children: React.ReactNode }) {
	const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
	const [phase, setPhase] = useState<CallPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [spotlitId, setSpotlightState] = useState<string | null>(null);
	const [browserSession, setBrowserSession] = useState<ActiveBrowserSession | null>(null);
	const [inCallView, setInCallViewState] = useState<boolean>(false);
	const [meeting, initMeeting] = useRealtimeKitClient();

	// Reset spotlight + view-flag when the call ends so the next
	// call starts in the default thumbnail-row view + as a fresh
	// in-call landing.
	useEffect(() => {
		if (phase === "idle") {
			setSpotlightState(null);
			setInCallViewState(false);
		}
	}, [phase]);

	const setSpotlight = useCallback((id: string | null) => {
		setSpotlightState(id);
	}, []);
	const setInCallView = useCallback((b: boolean) => {
		setInCallViewState(b);
	}, []);

	// When activeCall flips from null → set, kick off SDK init.
	// Token is single-use per the RealtimeKit docs, so each
	// startCall must come with a freshly minted token from the
	// engine (RoomVoiceBar handles that).
	useEffect(() => {
		if (!activeCall) return;
		setPhase("connecting");
		setError(null);
		void initMeeting({
			authToken: activeCall.authToken,
			defaults: {
				audio: activeCall.defaults?.audio ?? false,
				video: activeCall.defaults?.video ?? false,
				// RealtimeKit defaults screenshare to 5 FPS, which is
				// optimised for slides and looks like a slideshow on
				// motion content.  30 FPS is Cloudflare's recommended
				// ceiling for group calls (higher rates can starve
				// other peers' camera bandwidth on constrained uplinks).
				// 1080p cap keeps bitrate sane on retina displays.
				//
				// Note on screenshare system audio: RealtimeKit's
				// internal getScreenShareTracks() already passes
				// `audio: true` to getDisplayMedia, so the SDK IS
				// asking the OS for tab/system audio.  Whether it
				// arrives depends on what the user picks in the
				// browser/OS picker: Chrome only offers "Share tab
				// audio" for Tab capture and "Share system audio" for
				// Entire Screen capture (macOS Sequoia / Windows);
				// Window capture never includes audio.  Nothing to
				// configure on our side — it's a browser limitation.
				//
				// Audio processing: turn on the three standard WebRTC
				// processors so calls match Discord/Meet/Zoom out of
				// the box.  The SDK defaults these to off.  NB the
				// `noiseSupression` key is misspelled in RealtimeKit's
				// type (one 's'); we have to match that or it gets
				// silently dropped.
				mediaConfiguration: {
					audio: {
						echoCancellation: true,
						noiseSupression: true,
						autoGainControl: false,
					},
					screenshare: {
						frameRate: { ideal: 30, max: 30 },
						width: { max: 1920 },
						height: { max: 1080 },
					},
				},
			},
		}).catch(err => {
			// CRITICAL — keep activeCall + phase in place so the
			// InCallPane stays mounted and can SHOW the user the
			// error.  Tearing state down silently (the previous
			// behavior) made failures invisible: the UI just
			// vanished back to chat with no indication of what
			// went wrong.  The user can hit Cancel to clear, or
			// (eventually) Retry once the underlying issue is
			// fixed.  Logged loud so it's grep-able in dev tools
			// and the desktop app's console.
			const msg = err instanceof Error ? err.message : String(err);
			console.error("CallProvider: initMeeting failed", err);
			setError(msg);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeCall?.authToken]);

	// Once the SDK resolves, advance to prejoin so the UI swaps
	// from "Connecting…" to the camera preview + device pickers,
	// UNLESS this is a pop-out flow, in which case the user was
	// already in the meeting moments ago and re-prompting them with
	// a device picker would be jarring.  For pop-outs we call
	// `meeting.joinRoom()` directly and flip straight to "joined"
	// so the new window lands in the call surface, no extra clicks.
	useEffect(() => {
		if (!meeting || phase !== "connecting") return;
		if (activeCall?.skipPrejoin) {
			// `defaults.audio` / `defaults.video` are HINTS to the
			// SDK, not activation commands — the actual mic/cam
			// publishers are only attached when enableAudio() /
			// enableVideo() resolve.  In the normal flow,
			// PreJoinScreen does that for us via its toggle pills
			// before the user hits Join.  The pop-out flow skips
			// PreJoinScreen, so without this step the new SDK
			// session joined without a mic track — UI showed mic
			// "on" (audioEnabled mirrored the default) but
			// remote participants heard nothing.  Mirror what
			// PreJoinScreen does: toggle on first, then join.
			//
			// Errors are caught per-call so a failed mic (e.g.
			// permission denied) doesn't block joining — the user
			// still gets into the room, just muted, and can retry
			// from the in-call control bar.
			void (async () => {
				try {
					if (activeCall.defaults?.audio) {
						try { await meeting.self.enableAudio(); }
						catch (e) { console.warn("CallProvider: pop-out enableAudio failed", e); }
					}
					if (activeCall.defaults?.video) {
						try { await meeting.self.enableVideo(); }
						catch (e) { console.warn("CallProvider: pop-out enableVideo failed", e); }
					}
					await meeting.joinRoom();
					setPhase("joined");
				} catch (err) {
					console.error("CallProvider: auto-join (pop-out) failed", err);
					const msg = err instanceof Error ? err.message : String(err);
					setError(msg);
				}
			})();
			return;
		}
		setPhase("prejoin");
	}, [meeting, phase, activeCall?.skipPrejoin]);

	// Hold a ref to activeCall so the SDK event handlers (which
	// only re-bind when meeting changes, not on every state edit)
	// can read the latest auth + room id when firing presence
	// pings.  Without this the closure would capture the activeCall
	// at meeting-init time and skip iam-gone if the user changed
	// rooms between joining and leaving.
	const activeCallRef = useRef<ActiveCall | null>(null);
	useEffect(() => {
		activeCallRef.current = activeCall;
	}, [activeCall]);

	// Track the ring event id we sent for the current DM call so
	// `roomLeft` can fire a cancel referencing it.  Also tracks
	// "did the recipient accept yet?" — once they join the call,
	// we don't need to send a cancel on our leave (their sheet is
	// already gone).  Reset to null whenever the call ends or the
	// user starts a new call.
	const ringStateRef = useRef<{
		eventId: string;
		recipientAccepted: boolean;
	} | null>(null);

	// Safety timer for the caller's outgoing ringback.  The ringback
	// loops /ring.mp3 while the caller waits for an answer; this timer
	// stops it after RING_TIMEOUT_MS if the call is neither answered
	// nor hung up by then (matches the recipient sheet's 30s
	// auto-dismiss).  stopRingback() also handles the answered /
	// hung-up paths.
	const ringbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const stopRingback = useCallback(() => {
		stopRing();
		if (ringbackTimerRef.current) {
			clearTimeout(ringbackTimerRef.current);
			ringbackTimerRef.current = null;
		}
	}, []);

	// Listen for the SDK's roomJoined / roomLeft events.  roomJoined
	// fires the iam-here presence ping AND (for DMs) sends the
	// `chat.koven.call.ring` so the recipient's IncomingRingSheet
	// surfaces.  roomLeft fires iam-gone + (for DMs whose recipient
	// hasn't accepted yet) sends `chat.koven.call.cancel` so the
	// recipient's sheet dismisses immediately instead of waiting
	// out the 30s timeout.  Both fire regardless of who initiated
	// the disconnect (leave button, kicked, network teardown).
	useEffect(() => {
		if (!meeting) return;
		const onJoined = () => {
			const ac = activeCallRef.current;
			if (!ac) return;
			void pingCallPresenceJoined({ accessToken: ac.accessToken, roomId: ac.roomId });
			// Send the outgoing ring ONLY when we initiated the
			// call (not when answering someone else's ring).
			// Without this guard, recipient + caller would ring
			// each other in an infinite loop on accept.
			if (ac.isDm && !ac.isAnsweringRing) {
				// Caller-side ringback: loop /ring.mp3 while waiting
				// for the recipient to answer.  Stopped on
				// participantJoined (answered), roomLeft (hung up /
				// declined), or the safety timer below.
				startRing();
				if (ringbackTimerRef.current) clearTimeout(ringbackTimerRef.current);
				ringbackTimerRef.current = setTimeout(() => {
					stopRing();
					ringbackTimerRef.current = null;
				}, RING_TIMEOUT_MS);
				void sendCallEvent({
					accessToken: ac.accessToken,
					roomId: ac.roomId,
					eventType: RING_EVENT_TYPE,
					content: { started_at: Date.now() },
				}).then(eventId => {
					if (eventId) ringStateRef.current = { eventId, recipientAccepted: false };
				}).catch(err => {
					console.warn("CallProvider: ring send failed", err);
				});
			}
		};
		const onLeft = () => {
			// Caller hung up (or decline → endCall → roomLeft):
			// kill any ringback that's still looping.
			stopRingback();
			const ac = activeCallRef.current;
			const ring = ringStateRef.current;
			if (ac) {
				void pingCallPresenceLeft({ accessToken: ac.accessToken, roomId: ac.roomId });
				// Fire cancel for the outgoing DM ring if the
				// recipient hadn't accepted yet.  No-op if the
				// recipient already joined the call (their sheet
				// is already gone).
				if (ac.isDm && ring && !ring.recipientAccepted) {
					void sendCallEvent({
						accessToken: ac.accessToken,
						roomId: ac.roomId,
						eventType: RING_CANCEL_EVENT_TYPE,
						content: { ring_event_id: ring.eventId },
					}).catch(err => {
						console.warn("CallProvider: cancel send failed", err);
					});
				}
			}
			ringStateRef.current = null;
			setPhase("idle");
			setActiveCall(null);
		};
		meeting.self.on("roomJoined", onJoined);
		meeting.self.on("roomLeft", onLeft);
		return () => {
			stopRingback();
			try {
				meeting.self.off("roomJoined", onJoined);
				meeting.self.off("roomLeft", onLeft);
			} catch {
				// SDK already torn down — fine.
			}
		};
	}, [meeting, stopRingback]);

	// Listen for "another participant joined the meeting" events.
	// When a remote joins the same DM call (their iam-here will be
	// matched by Cloudflare's participantJoined webhook AND we
	// also see them via the SDK's participants map), it means our
	// ring was accepted — flip the recipientAccepted flag so a
	// later roomLeft doesn't fire a stale cancel.
	useEffect(() => {
		if (!meeting) return;
		const onParticipantJoined = () => {
			// Recipient answered — silence the caller's ringback.
			stopRingback();
			if (ringStateRef.current && !ringStateRef.current.recipientAccepted) {
				ringStateRef.current = { ...ringStateRef.current, recipientAccepted: true };
			}
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const joined = meeting.participants.joined as any;
		joined.on("participantJoined", onParticipantJoined);
		return () => {
			try {
				joined.off("participantJoined", onParticipantJoined);
			} catch { /* SDK torn down */ }
		};
	}, [meeting, stopRingback]);

	const startCall = useCallback((opts: ActiveCall) => {
		// Replace any in-flight call.  Caller is expected to have
		// confirmed with the user first (single-call rule).  If
		// there's an existing meeting we don't explicitly leaveRoom
		// here because re-init on the SDK will tear the old session
		// down implicitly.
		setActiveCall(opts);
		// User just hit Join — drop them straight into the call view
		// (skipping the ambiguous "chat-with-PIP" intermediate state).
		setInCallViewState(true);
	}, []);

	const confirmJoin = useCallback(() => {
		// PreJoinScreen calls this once meeting.joinRoom() resolves.
		// We mirror to the phase machine so all UI keys off `phase`,
		// not the SDK's internal state.
		setPhase("joined");
	}, []);

	const endCall = useCallback(async () => {
		if (meeting) {
			try {
				await meeting.leaveRoom();
				// Don't reset state here — the roomLeft handler above
				// will fire and do it.  Resetting eagerly here would
				// race the cleanup and leak the SDK's audio tracks.
			} catch (err) {
				// leaveRoom can throw if the socket already closed;
				// fall through to forced cleanup so the UI doesn't
				// get stuck with no way out.
				console.warn("endCall: leaveRoom threw, force-resetting", err);
				setPhase("idle");
				setActiveCall(null);
			}
		} else {
			setPhase("idle");
			setActiveCall(null);
		}
	}, [meeting]);

	const popOutToWindow = useCallback(async (): Promise<void> => {
		// Pop-out is a desktop-only affordance (we'd need a different
		// strategy for browser-side: window.open + BroadcastChannel).
		// Caller is expected to gate the affordance, but bail safely
		// here too so an errant call in a browser context is a no-op.
		if (!isDesktopShell()) return;
		if (!activeCall) return;

		// Capture the user's current mic + cam state BEFORE tearing
		// down the meeting so we can hand them off to the new SDK
		// session as defaults.  Without this, the new window would
		// start with mic / cam off and the user would have to
		// re-enable everything they had on a second ago.  meeting
		// may be undefined if we're still in connecting/prejoin
		// (in that case fall back to whatever activeCall.defaults
		// said).
		const audioOn = meeting?.self.audioEnabled ?? activeCall.defaults?.audio ?? false;
		const videoOn = meeting?.self.videoEnabled ?? activeCall.defaults?.video ?? false;

		// Mint a fresh single-use auth token.  RealtimeKit rejects
		// reused tokens, so the new SDK session needs its own.
		let freshAuthToken: string;
		try {
			const r = await joinCall({
				accessToken: activeCall.accessToken,
				roomId: activeCall.roomId,
			});
			freshAuthToken = r.authToken;
		} catch (err) {
			console.error("popOutToWindow: token mint failed", err);
			setError(err instanceof Error ? err.message : String(err));
			return;
		}

		const params = {
			roomId: activeCall.roomId,
			roomName: activeCall.roomName,
			authToken: freshAuthToken,
			accessToken: activeCall.accessToken,
			isDm: !!activeCall.isDm,
			defaultAudio: audioOn,
			defaultVideo: videoOn,
		};

		// Spawn the new window BEFORE leaving the current meeting.
		// Two reasons:
		//   1. If spawn fails (e.g. ACL-denied, OS refused window
		//      creation), surface the error to the user and keep
		//      them in the call rather than dropping them out
		//      blind.  Earlier this was reversed and a silent spawn
		//      rejection looked like "the call just ended for no
		//      reason."
		//   2. WebviewWindowBuilder::build returns as soon as the
		//      OS window exists, well before the new SPA boots and
		//      initialises RealtimeKit.  By the time the new window
		//      is actually JOINING (~1-3s later), our subsequent
		//      endCall has completed and the participant slot is
		//      free.
		try {
			await spawnCallWindow(params);
		} catch (err) {
			console.error("popOutToWindow: spawn failed", err);
			setError(err instanceof Error ? err.message : String(err));
			return;
		}

		// Spawn succeeded; tear down THIS window's meeting so the
		// new one can claim the participant slot.  endCall waits
		// for meeting.leaveRoom() to resolve (which fires roomLeft
		// → state reset → cancel-ring path for unfinished DM rings).
		try {
			await endCall();
		} catch (err) {
			console.warn("popOutToWindow: endCall threw after spawn", err);
		}
	}, [activeCall, meeting, endCall]);

	const popInToMain = useCallback(async (): Promise<void> => {
		// Only meaningful inside the call window's CallProvider:
		// the main window doesn't have a separate OS window to pop
		// FROM.  Bail safely if invoked elsewhere.
		if (!isDesktopShell() || !isCallWindow()) return;
		if (!activeCall) return;

		// Capture the user's current mic + cam state so main resumes
		// with the same devices live.  Same reasoning as
		// popOutToWindow's audioOn/videoOn capture.
		const audioOn = meeting?.self.audioEnabled ?? activeCall.defaults?.audio ?? false;
		const videoOn = meeting?.self.videoEnabled ?? activeCall.defaults?.video ?? false;

		// Mint a fresh single-use auth token for main to join with.
		let freshAuthToken: string;
		try {
			const r = await joinCall({
				accessToken: activeCall.accessToken,
				roomId: activeCall.roomId,
			});
			freshAuthToken = r.authToken;
		} catch (err) {
			console.error("popInToMain: token mint failed", err);
			setError(err instanceof Error ? err.message : String(err));
			return;
		}

		const params = {
			roomId: activeCall.roomId,
			roomName: activeCall.roomName,
			authToken: freshAuthToken,
			accessToken: activeCall.accessToken,
			isDm: !!activeCall.isDm,
			defaultAudio: audioOn,
			defaultVideo: videoOn,
		};

		// Suppress CallWindowBoot's auto-close-on-idle for the
		// duration of this flow.  endCall flips phase to idle which
		// would otherwise race the explicit close at the end —
		// closing too early could kill the JS context before we've
		// finished telling main to take over.
		setPopInActive(true);
		try {
			// Leave this window's meeting first so the participant
			// slot is free when main joins.  endCall awaits
			// leaveRoom() which keeps presence + ring cleanup
			// running on the engine side.
			try {
				await endCall();
			} catch (err) {
				console.warn("popInToMain: endCall threw, continuing", err);
			}

			// Notify main: Rust stashes the params and emits
			// `call-reattach-ready` so main's CallProvider takes
			// over.  Awaited so we know the IPC reached Rust before
			// we close the JS context.
			try {
				await ipcPopInToMain(params);
			} catch (err) {
				console.error("popInToMain: IPC failed", err);
				setError(err instanceof Error ? err.message : String(err));
				return;
			}

			// Close our OS window.  Main is already on its way to
			// rejoining; nothing more for us to do here.
			try {
				await closeCurrentWindow();
			} catch (err) {
				console.warn("popInToMain: closeCurrentWindow threw", err);
			}
		} finally {
			setPopInActive(false);
		}
	}, [activeCall, meeting, endCall]);

	// Main-window listener for the call window's pop-in flow.  When
	// the call window invokes `pop_in_to_main`, Rust emits
	// `call-reattach-ready` here; we drain the freshly-stashed
	// params and resume the call with skipPrejoin so the user lands
	// directly back in the joined state.  Only the main window
	// binds this — the call window doesn't need to listen to
	// itself.
	useEffect(() => {
		if (!isDesktopShell()) return;
		if (isCallWindow()) return;
		let unlisten: (() => void) | undefined;
		let cancelled = false;
		void (async () => {
			try {
				const { listen } = await import("@tauri-apps/api/event");
				const off = await listen("call-reattach-ready", async () => {
					try {
						const params = await drainPendingCall();
						if (!params) {
							console.warn("call-reattach: drain returned no params");
							return;
						}
						startCall({
							roomId: params.roomId as RoomId,
							roomName: params.roomName,
							authToken: params.authToken,
							accessToken: params.accessToken,
							isDm: params.isDm,
							isAnsweringRing: true,
							defaults: {
								audio: params.defaultAudio,
								video: params.defaultVideo,
							},
							skipPrejoin: true,
						});
					} catch (err) {
						console.error("call-reattach: handler threw", err);
					}
				});
				if (cancelled) {
					off();
					return;
				}
				unlisten = off;
			} catch (err) {
				console.warn("call-reattach: listen failed", err);
			}
		})();
		return () => {
			cancelled = true;
			if (unlisten) unlisten();
		};
		// startCall is stable across renders (useCallback with []), so
		// the listener never needs to re-bind.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const value = useMemo<CallContextValue>(
		() => ({ activeCall, phase, error, spotlitId, setSpotlight, inCallView, setInCallView, startCall, confirmJoin, endCall, popOutToWindow, popInToMain, browserSession, setBrowserSession }),
		[activeCall, phase, error, spotlitId, setSpotlight, inCallView, setInCallView, startCall, confirmJoin, endCall, popOutToWindow, popInToMain, browserSession],
	);

	// Always render the RealtimeKitProvider — even when meeting is
	// undefined — so adding/removing a meeting does NOT change the
	// React tree shape.  Earlier we conditionally-wrapped children
	// with the SDK provider only when meeting existed; flipping the
	// tree shape on meeting-init unmounted the entire App subtree
	// and re-mounted it from initialState, which manifested as a
	// "click Join → flash → bounced to DMs" bug because App's
	// reducer reset to its DMs default.
	//
	// IMPORTANT: the SDK's provider implements `value ? children :
	// fallback`, which means with no fallback prop it renders
	// undefined (i.e. nothing) when value is undefined — blanking
	// the entire app.  We pass the same `children` as the
	// `fallback` so the subtree is identical regardless of
	// whether meeting exists.  React reconciles both branches as
	// the same element, so no unmount.
	return (
		<CallContext.Provider value={value}>
			<RealtimeKitProvider value={meeting} fallback={children}>
				{children}
			</RealtimeKitProvider>
		</CallContext.Provider>
	);
}

/** Send a Matrix custom event into a room via the raw Synapse API.
 *  We don't go through transport.sendCustomEvent here because the
 *  CallProvider lives outside the TransportContext (it wraps App)
 *  and routing the transport down would require more plumbing
 *  than just hitting Synapse directly with the access token we
 *  already have on activeCall.  Returns the event id, or null on
 *  failure so callers can decide what to do (we just log + ignore). */
async function sendCallEvent(opts: {
	accessToken: string;
	roomId: RoomId;
	eventType: string;
	content: Record<string, unknown>;
}): Promise<string | null> {
	const txnId = `koven-call-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const url = `${HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/send/${encodeURIComponent(opts.eventType)}/${encodeURIComponent(txnId)}`;
	try {
		const r = await fetch(url, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${opts.accessToken}`,
			},
			body: JSON.stringify(opts.content),
		});
		if (!r.ok) {
			console.warn(`sendCallEvent ${opts.eventType} → ${r.status}`);
			return null;
		}
		const body = (await r.json().catch(() => ({}))) as { event_id?: string };
		return body.event_id ?? null;
	} catch (err) {
		console.warn(`sendCallEvent ${opts.eventType} threw`, err);
		return null;
	}
}

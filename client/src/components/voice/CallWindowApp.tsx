// Top-level shell for the popped-out call window.
//
// Mounted by main.tsx when `window.__KOVEN_WINDOW_KIND__ === "call"`
// (set by the Tauri shell's per-window initialization script).  Owns
// a fresh `<CallProvider>` instance (no shared state with the main
// window's CallProvider) and joins the meeting using the params
// drained out of Tauri's managed `CallHandoff` slot by main.tsx
// before React mounted (see `drainPendingCall` there).
//
// Lifecycle:
//   1. Mount → call `startCall(pendingCall)` once on first effect.
//   2. CallProvider drives connecting → joined (with skipPrejoin).
//   3. When the call ends (phase returns to "idle" after having
//      been non-idle), close the OS window.
//
// The window itself uses native chrome (traffic lights / title bar
// drawn by the OS) so there's no DesktopTitleBar here: the user
// dragged this thing out specifically to get a normal OS window
// they can fullscreen and resize freely.
//
// Why the params come in as a prop instead of being drained here:
// the Rust-side `drain_pending_call` is a take-once Mutex.  When
// React 18's Strict Mode double-mounts this component in dev, the
// first mount would drain the slot and the second mount would find
// it empty (showing "no call was pending").  Draining BEFORE React
// boots and threading the result through as a prop sidesteps the
// React lifecycle entirely.

import { useEffect, useRef } from "react";
import { CallProvider, useCall } from "@/lib/call-context";
import { InCallPane } from "@/components/voice/InCallPane";
import {
	closeCurrentWindow,
	isPopInActive,
	type PendingCall,
} from "@/lib/native-window";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

export interface CallWindowAppProps {
	/** Params drained from Rust at module-load time by main.tsx.
	 *  `null` when the window was opened without a pending call
	 *  (e.g. the user reloaded after the call ended), in which
	 *  case we render an error state and let them close out. */
	pendingCall: PendingCall | null;
}

export function CallWindowApp({ pendingCall }: CallWindowAppProps) {
	if (!pendingCall) {
		return <NoPendingCall />;
	}
	return (
		<CallProvider>
			<CallWindowBoot pendingCall={pendingCall} />
		</CallProvider>
	);
}

function CallWindowBoot({ pendingCall }: { pendingCall: PendingCall }) {
	const call = useCall();
	const startedRef = useRef(false);
	const wasActiveRef = useRef(false);

	// Start the call exactly once.  startedRef is set BEFORE the
	// call, so React 18's Strict Mode double-mount doesn't double-
	// dispatch startCall (which would mint a doubled SDK init).
	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;
		call.startCall({
			roomId: pendingCall.roomId,
			roomName: pendingCall.roomName,
			authToken: pendingCall.authToken,
			accessToken: pendingCall.accessToken,
			isDm: pendingCall.isDm,
			// Suppress the outgoing-ring branch on the new SDK
			// session: the original main-window join already sent
			// the ring (and the cancel-on-leave fired when we
			// ended that meeting before popping out).  Treat the
			// pop-out re-join as "answering" so the ring pipeline
			// stays silent.
			isAnsweringRing: true,
			// Preserve the user's mic + cam setting across the
			// hand-off: they were just in the call with these
			// devices live, so the new session should pick up
			// where they left off, not reset to mute / cam-off.
			defaults: {
				audio: pendingCall.defaultAudio,
				video: pendingCall.defaultVideo,
			},
			// Skip the PreJoinScreen step.  The user was in the
			// call seconds ago; making them re-confirm device
			// pickers in the new window would be jarring.  The
			// CallProvider treats this as "connecting → joined"
			// directly once the SDK is ready.
			skipPrejoin: true,
		});
		// `call` identity changes per render but startCall is stable
		// inside CallProvider; we only ever want this once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Track whether we've ever been in a live phase, so we only
	// auto-close after a real call ended (vs. closing immediately
	// on mount because phase is still "idle").  The pop-in flow
	// also takes phase through idle as part of its handoff, but
	// closes the window itself at a controlled moment after
	// notifying main; skip auto-close in that case so we don't
	// race the explicit close.
	useEffect(() => {
		if (call.phase !== "idle") {
			wasActiveRef.current = true;
			return;
		}
		if (wasActiveRef.current && !isPopInActive()) {
			void closeCurrentWindow();
		}
	}, [call.phase]);

	// Active call surface.  Reuses the inline component end-to-end so
	// the PreJoinScreen / CallView pair stays identical to the main-
	// window flow; the call-window-specific affordances (fullscreen
	// toggle) are wired into CallView's control bar by way of the
	// `isCallWindow()` check, so this shell stays a thin frame.
	return (
		<div className="h-screen w-screen flex flex-col bg-background overflow-hidden">
			<div className="flex-1 min-h-0 flex flex-col">
				<InCallPane roomName={call.activeCall?.roomName ?? pendingCall.roomName} />
			</div>
		</div>
	);
}

/** Rendered when the window was opened without a pending call.
 *  Lets the user close out cleanly instead of being stuck. */
function NoPendingCall() {
	return (
		<div className="h-screen w-screen flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
			<div className="text-sm font-medium text-destructive">
				Couldn&rsquo;t open the call window.
			</div>
			<div className="text-xs text-muted-foreground max-w-md break-words">
				No call was pending for this window.  Close it and try the pop-out button again.
			</div>
			<Button size="sm" variant="ghost" onClick={() => { void closeCurrentWindow(); }}>
				<X className="h-3.5 w-3.5 mr-1.5" />
				Close window
			</Button>
		</div>
	);
}

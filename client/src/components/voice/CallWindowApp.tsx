// Top-level shell for the popped-out call window.
//
// Mounted by main.tsx when `window.__KOVEN_WINDOW_KIND__ === "call"`
// (set by the Tauri shell's per-window initialization script).  Owns
// a fresh `<CallProvider>` instance (no shared state with the main
// window's CallProvider) and is told what to do via params handed
// over through Tauri's managed `CallHandoff` slot.
//
// Lifecycle:
//   1. Mount → drain `PendingCall` via Tauri IPC.
//   2. Hand params to `startCall()` so RealtimeKit initialises and
//      drops the user into the PreJoinScreen → CallView flow.
//   3. When the call ends (phase returns to "idle" after having
//      been non-idle), close the OS window.
//
// The window itself uses native chrome (traffic lights / title bar
// drawn by the OS) so there's no DesktopTitleBar here: the user
// dragged this thing out specifically to get a normal OS window
// they can fullscreen and resize freely.

import { useEffect, useRef, useState } from "react";
import { CallProvider, useCall } from "@/lib/call-context";
import { InCallPane } from "@/components/voice/InCallPane";
import {
	closeCurrentWindow,
	drainPendingCall,
	type PendingCall,
} from "@/lib/native-window";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

type BootState = "loading" | "ready" | "no_params" | "error";

export function CallWindowApp() {
	return (
		<CallProvider>
			<CallWindowBoot />
		</CallProvider>
	);
}

function CallWindowBoot() {
	const call = useCall();
	const [boot, setBoot] = useState<BootState>("loading");
	const [bootError, setBootError] = useState<string | null>(null);
	const startedRef = useRef(false);
	const wasActiveRef = useRef(false);

	// Drain the params Rust stashed for us and start the call.
	// Strict-mode guards: React 18 in dev double-invokes effects, and
	// `startCall` is not idempotent (it would mint a doubled SDK
	// init).  The ref-based guard ensures we only call it once
	// even if this effect re-fires.
	useEffect(() => {
		if (startedRef.current) return;
		let cancelled = false;
		(async () => {
			let params: PendingCall | null = null;
			try {
				params = await drainPendingCall();
			} catch (err) {
				if (cancelled) return;
				setBootError(err instanceof Error ? err.message : String(err));
				setBoot("error");
				return;
			}
			if (cancelled) return;
			if (!params) {
				setBoot("no_params");
				return;
			}
			startedRef.current = true;
			call.startCall({
				roomId: params.roomId,
				roomName: params.roomName,
				authToken: params.authToken,
				accessToken: params.accessToken,
				isDm: params.isDm,
				// Suppress the outgoing-ring branch on the new SDK
				// session: the original main-window join already
				// sent the ring (and the cancel-on-leave fired when
				// we ended that meeting before popping out).  Treat
				// the pop-out re-join as "answering" so the ring
				// pipeline stays silent.
				isAnsweringRing: true,
				// Preserve the user's mic + cam setting across the
				// hand-off: they were just in the call with these
				// devices live, so the new session should pick up
				// where they left off, not reset to mute / cam-off.
				defaults: {
					audio: params.defaultAudio,
					video: params.defaultVideo,
				},
				// Skip the PreJoinScreen step.  The user was in the
				// call seconds ago; making them re-confirm device
				// pickers in the new window would be jarring.  The
				// CallProvider treats this as "connecting → joined"
				// directly once the SDK is ready.
				skipPrejoin: true,
			});
			setBoot("ready");
		})();
		return () => { cancelled = true; };
		// `call` identity changes per render but startCall is stable
		// inside CallProvider; we only ever want this once.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Track whether we've ever been in a live phase, so we only
	// auto-close after a real call ended (vs. closing immediately
	// on mount because phase is still "idle").
	useEffect(() => {
		if (call.phase !== "idle") {
			wasActiveRef.current = true;
			return;
		}
		if (wasActiveRef.current) {
			void closeCurrentWindow();
		}
	}, [call.phase]);

	if (boot === "loading") {
		return (
			<div className="h-screen w-screen flex flex-col items-center justify-center gap-3 bg-background">
				<img
					src="/favicon.png"
					alt=""
					aria-hidden
					className="h-12 w-12 animate-pulse"
					style={{ animationDuration: "1.4s" }}
				/>
				<div className="text-sm text-muted-foreground">Opening call…</div>
			</div>
		);
	}

	if (boot === "no_params" || boot === "error") {
		return (
			<div className="h-screen w-screen flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
				<div className="text-sm font-medium text-destructive">
					Couldn&rsquo;t open the call window.
				</div>
				<div className="text-xs text-muted-foreground max-w-md break-words">
					{boot === "no_params"
						? "No call was pending for this window.  Close it and try the pop-out button again."
						: bootError ?? "Unknown error."}
				</div>
				<Button size="sm" variant="ghost" onClick={() => { void closeCurrentWindow(); }}>
					<X className="h-3.5 w-3.5 mr-1.5" />
					Close window
				</Button>
			</div>
		);
	}

	// Active call surface.  Reuses the inline component end-to-end so
	// the PreJoinScreen / CallView pair stays identical to the main-
	// window flow; the call-window-specific affordances (fullscreen
	// toggle) are wired into CallView's control bar by way of the
	// `isCallWindow()` check, so this shell stays a thin frame.
	return (
		<div className="h-screen w-screen flex flex-col bg-background overflow-hidden">
			<div className="flex-1 min-h-0 flex flex-col">
				<InCallPane roomName={call.activeCall?.roomName ?? "Call"} />
			</div>
		</div>
	);
}

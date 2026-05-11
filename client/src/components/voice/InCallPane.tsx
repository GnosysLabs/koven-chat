// Inline call surface that ChatPane renders in place of the
// message area when the user is in a Live call in the active
// room.  Switches between the pre-join screen (camera preview +
// device pickers + Join button) and the in-call grid based on
// the CallProvider's phase machine.
//
// Connecting state shows a centered spinner — OR an error message
// if the SDK failed to open its websocket / acquire media / get a
// valid token.  Errors are visible because the previous "kill
// state silently on failure" path made bugs invisible.
//
// onJoined / onLeaveRequested route through the context so the
// rest of the app (mini-strip, audio sink, RoomVoiceBar) stays
// in sync via a single source of truth.

import { useCall } from "@/lib/call-context";
import { PreJoinScreen } from "@/components/voice/PreJoinScreen";
import { CallView } from "@/components/voice/CallView";
import { Button } from "@/components/ui/button";

export interface InCallPaneProps {
	roomName: string;
}

export function InCallPane({ roomName }: InCallPaneProps) {
	const { phase, confirmJoin, endCall, activeCall, error } = useCall();

	if (phase === "idle") return null;

	if (phase === "connecting") {
		// Failure surface: the SDK init promise rejected.  Keep the
		// call view mounted so the user can see + react to the
		// error.  Cancel tears down; the user can re-Join from the
		// Live bar afterwards (which mints a fresh single-use token).
		if (error) {
			return (
				<div className="flex-1 flex flex-col items-center justify-center gap-4 min-h-0 px-6">
					<div className="text-sm font-medium text-destructive text-center">
						Couldn&rsquo;t connect to the call.
					</div>
					<div className="text-xs text-muted-foreground max-w-md text-center break-words">
						{error}
					</div>
					<Button onClick={() => { void endCall(); }} variant="ghost" size="sm">
						Cancel
					</Button>
				</div>
			);
		}
		return (
			<div className="flex-1 flex flex-col items-center justify-center gap-4 min-h-0">
				<img
					src="/favicon.png"
					alt=""
					aria-hidden
					className="h-16 w-16 animate-pulse"
					style={{ animationDuration: "1.4s" }}
				/>
				<div className="text-sm text-muted-foreground">
					Connecting to Live…
				</div>
				<Button onClick={() => { void endCall(); }} variant="ghost" size="sm">
					Cancel
				</Button>
			</div>
		);
	}

	if (phase === "prejoin") {
		return (
			<PreJoinScreen
				roomName={roomName}
				onJoined={confirmJoin}
				onCancel={() => { void endCall(); }}
				isDm={activeCall?.isDm ?? false}
				isAnsweringRing={activeCall?.isAnsweringRing ?? false}
			/>
		);
	}

	// phase === "joined"
	return (
		<CallView
			roomName={roomName}
			onLeaveRequested={() => { void endCall(); }}
		/>
	);
}

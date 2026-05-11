// Inline call surface that ChatPane renders in place of the
// message area when the user is in a Live call in the active
// room.  Switches between the pre-join screen (camera preview +
// device pickers + Join button) and the in-call grid based on
// the CallProvider's phase machine.
//
// Connecting state shows a centered spinner so the user has
// something to watch while the SDK opens its websocket to
// Cloudflare's signaling server.  Pre-join + joined render their
// existing components.  Idle returns null (the parent shouldn't
// have mounted us in that case anyway, but defensive).
//
// onJoined / onLeaveRequested route through the context so the
// rest of the app (mini-strip, audio sink, RoomVoiceBar) stays
// in sync via a single source of truth.

import { useCall } from "@/lib/call-context";
import { PreJoinScreen } from "@/components/voice/PreJoinScreen";
import { CallView } from "@/components/voice/CallView";

export interface InCallPaneProps {
	roomName: string;
}

export function InCallPane({ roomName }: InCallPaneProps) {
	const { phase, confirmJoin, endCall, activeCall } = useCall();

	if (phase === "idle") return null;

	if (phase === "connecting") {
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

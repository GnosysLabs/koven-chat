// Tiny gate around CallAudioSink that handles the "is there a
// meeting yet?" decision via call-context.  The CallAudioSink
// itself uses useRealtimeKitMeeting() unconditionally — that hook
// throws when no RealtimeKitProvider is mounted, which is the
// normal state before any call starts.  This gate keeps App.tsx
// from having to know about the call lifecycle: it just renders
// <CallAudioSinkGate /> at the top of the tree and the gate
// decides whether to mount the sink.

import { useCall } from "@/lib/call-context";
import { CallAudioSink } from "@/components/voice/CallAudioSink";

export function CallAudioSinkGate() {
	const { phase } = useCall();
	// Only mount when there's a live meeting that's actually joined
	// or about to be (the SDK's tracks aren't there until past
	// connecting → prejoin transition).  Pre-join is included so
	// the user can hear themselves loop-back if they're checking
	// audio levels — wait, no, self-audio is muted on the local
	// element, only remotes pipe through here, and remotes only
	// exist post-join.  So joined-only is enough; pre-join + earlier
	// have nothing to render.
	if (phase !== "joined") return null;
	return <CallAudioSink />;
}

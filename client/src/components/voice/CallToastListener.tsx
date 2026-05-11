// Listens for `chat.koven.call.decline` events targeting our
// outgoing DM ring.  When the recipient declines, we show a small
// toast ("X declined the call") so the caller knows their ring
// failed to connect.  Toast auto-dismisses after a few seconds.
//
// Lives at the App level (next to IncomingRingListener) so the
// subscription is global — works whether the caller is staring at
// the call view, has navigated away, or is on the PIP.

import { useEffect, useState } from "react";
import { useCall } from "@/lib/call-context";
import type { MatrixTransport } from "@/lib/matrix";
import { cn } from "@/lib/utils";
import { PhoneOff } from "lucide-react";

export interface CallToastListenerProps {
	transport: MatrixTransport | null;
}

const DECLINE_TOAST_MS = 4_000;

interface ToastState {
	id: number;
	text: string;
}

export function CallToastListener({ transport }: CallToastListenerProps) {
	const call = useCall();
	const [toast, setToast] = useState<ToastState | null>(null);

	useEffect(() => {
		if (!transport) return;
		const unsubscribe = transport.onCallEvent(({ roomId, eventType, content, senderId }) => {
			if (eventType !== "chat.koven.call.decline") return;
			// Only react if the decline is for the ROOM we're
			// currently calling (i.e. our active call's room).
			// Otherwise it's a stale decline for some other call.
			if (!call.activeCall || call.activeCall.roomId !== roomId) return;
			void content; // ring_event_id check could be tighter; for v1 the room match is enough
			setToast({
				id: Date.now(),
				// senderId is the recipient (the one who declined).
				// For a DM the recipient's display name = the
				// activeCall.roomName (matrix-js-sdk sets DM rooms
				// to the peer's name).
				text: `${call.activeCall.roomName} declined`,
			});
			void senderId;
			// Tear down our own meeting too — there's no point
			// hanging around in an empty 1:1 call.
			void call.endCall();
		});
		return unsubscribe;
	}, [transport, call]);

	useEffect(() => {
		if (!toast) return;
		const id = window.setTimeout(() => setToast(null), DECLINE_TOAST_MS);
		return () => window.clearTimeout(id);
	}, [toast]);

	if (!toast) return null;
	return (
		<div
			className={cn(
				"fixed bottom-6 left-1/2 -translate-x-1/2 z-50",
				"flex items-center gap-2 px-4 py-3 rounded-full",
				"bg-card border border-border shadow-lg text-sm",
				"animate-in fade-in slide-in-from-bottom-2 duration-200",
			)}
		>
			<PhoneOff className="h-4 w-4 text-destructive" />
			<span>{toast.text}</span>
		</div>
	);
}

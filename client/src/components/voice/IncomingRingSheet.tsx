// Centered modal sheet that surfaces when an incoming DM call
// arrives.  Avatar + name of the caller, Accept (primary green)
// and Decline (destructive red) buttons.  Renders only when there's
// an active incoming ring — its parent (IncomingRingListener) holds
// the lifecycle (timeout, cancel events, etc.) and just hands us
// the data + actions.

import { useEffect, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { startRing, stopRing } from "@/lib/callRingtone";
import { hapticImpact } from "@/lib/haptics";
import { Phone, PhoneOff } from "lucide-react";
import type { UserId, RoomId, EventId } from "@koven/shared";

export interface IncomingRingSheetProps {
	ring: {
		ringEventId: EventId;
		roomId: RoomId;
		roomName: string;
		callerId: UserId;
		callerDisplayName: string;
		callerAvatarMxc: string | undefined;
		receivedAt: number;
	};
	onAccept(): void | Promise<void>;
	onDecline(): void | Promise<void>;
}

export function IncomingRingSheet({ ring, onAccept, onDecline }: IncomingRingSheetProps) {
	const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
	// Looping ringtone while the sheet is up.  Driven by the shared
	// callRingtone singleton (pre-unlocked on the first user gesture)
	// rather than a fresh <audio> element here — gesture-less play()
	// on a freshly created element is policy-blocked on iOS / WKWebView
	// and unreliable in Chrome.  Starts on mount, stops on unmount, so
	// it ends naturally on accept / decline / timeout.
	useEffect(() => {
		startRing();
		return stopRing;
	}, []);

	async function handle(action: "accept" | "decline") {
		if (busy) return;
		void hapticImpact("medium");
		setBusy(action);
		try {
			if (action === "accept") await onAccept();
			else await onDecline();
		} finally {
			setBusy(null);
		}
	}

	return (
		<Dialog open onOpenChange={() => { /* closing the modal counts as decline */ void handle("decline"); }}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader className="sr-only">
					<DialogTitle>Incoming call</DialogTitle>
					<DialogDescription>
						{ring.callerDisplayName} is calling you.  Accept or decline.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col items-center gap-4 py-2">
					{/* Pulsing avatar — same animate-pulse as the
					    Connecting state, but on a larger tile.  Reads
					    as "this is ringing." */}
					<div className="relative">
						<MatrixAvatar
							mxc={ring.callerAvatarMxc}
							seed={ring.callerId}
							kind="user"
							className="h-24 w-24 rounded-full animate-pulse"
						/>
					</div>

					<div className="text-center">
						<div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
							Incoming call
						</div>
						<div className="text-lg font-semibold mt-1">
							{ring.callerDisplayName}
						</div>
					</div>

					<div className="flex items-center gap-3 mt-2">
						<Button
							variant="destructive"
							onClick={() => handle("decline")}
							disabled={busy === "accept"}
							className="gap-2 min-w-[120px]"
						>
							<PhoneOff className="h-4 w-4" />
							{busy === "decline" ? "Declining…" : "Decline"}
						</Button>
						<Button
							onClick={() => handle("accept")}
							disabled={busy === "decline"}
							className="gap-2 min-w-[120px] bg-emerald-600 hover:bg-emerald-500 text-white"
						>
							<Phone className="h-4 w-4" />
							{busy === "accept" ? "Joining…" : "Accept"}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

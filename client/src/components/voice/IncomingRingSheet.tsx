// Centered modal sheet that surfaces when an incoming DM call
// arrives.  Avatar + name of the caller, Accept (primary green)
// and Decline (destructive red) buttons.  Renders only when there's
// an active incoming ring — its parent (IncomingRingListener) holds
// the lifecycle (timeout, cancel events, etc.) and just hands us
// the data + actions.

import { useEffect, useRef, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
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
	// Looping ringtone while the sheet is up.  Mounted/unmounted
	// with the sheet so it stops naturally on accept/decline/timeout.
	//
	// Browser autoplay quirks:
	//   - `preload="auto"` doesn't guarantee the file is decoded by
	//     the time we call play(); on some browsers play() returns
	//     a rejected promise with NotAllowedError or AbortError if
	//     the data isn't ready.  Wait for canplay before invoking.
	//   - Chrome / Safari require a recent user gesture to autoplay.
	//     The recipient has been clicking around the app, so MEI
	//     (Media Engagement Index) should be high — but if play()
	//     still rejects we LOG it (instead of swallowing silently)
	//     so we can see the failure mode in dev.
	const audioRef = useRef<HTMLAudioElement | null>(null);
	useEffect(() => {
		const el = audioRef.current;
		if (!el) return;
		el.loop = true;
		el.volume = 0.6;
		// Tap into canplay so play() runs once data is ready —
		// fixes the case where the file hasn't decoded yet.  Also
		// kick off a play() attempt immediately for the cached-
		// resource case where the audio is already buffered.
		const tryPlay = () => {
			el.play().catch(err => {
				console.warn("ring audio: play() rejected", err);
			});
		};
		el.addEventListener("canplaythrough", tryPlay);
		// Fire once immediately too — fast path when the browser
		// already has the file cached from a prior ring.
		tryPlay();
		return () => {
			el.removeEventListener("canplaythrough", tryPlay);
			try {
				el.pause();
				el.currentTime = 0;
			} catch { /* element gone, fine */ }
		};
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
				{/* Looping ringtone — hidden, audio-only.  Mount/unmount
				    follows the sheet so accept/decline/timeout stop
				    the sound for free. */}
				<audio ref={audioRef} src="/ring.mp3" preload="auto" />

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

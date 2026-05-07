// Modal that pops up when a remote party rings us.  Renders on top of
// everything (including the encryption gate, in theory — but in
// practice we only fire after sync is up, so the gate has resolved).
//
// Three exits:
//   - Accept → MatrixCall.answer(audio, video=type==='video') and
//     hand off to ActiveCallView (parent transitions our state).
//   - Decline → MatrixCall.reject() and clear.
//   - Caller hangs up first → CallEvent.Hangup fires; we clear.

import { useEffect, useState } from "react";
import {
	Dialog,
	DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { Phone, PhoneOff, Video } from "lucide-react";
import { CallEvent, CallType } from "matrix-js-sdk/lib/webrtc/call";
import type { MatrixCall } from "matrix-js-sdk/lib/webrtc/call";
import type { UserId } from "@koven/shared";

export interface IncomingCallSheetProps {
	call: MatrixCall;
	// Caller identity, resolved by the parent from the DM's partner
	// data.  More reliable than MatrixCall.getOpponentMember() —
	// which relies on member-event state that may not be fully synced
	// when an inbound invite first arrives, leading to wrong-avatar
	// flashes.  When the parent can't resolve the peer, omit and we
	// fall back to the SDK's getter.
	peer?: {
		userId: UserId;
		displayName?: string;
		avatarMxc?: string;
	};
	// Fired once the user accepts.  Parent should clear the
	// `incomingCall` slot and set the call as the active call.
	onAccept(call: MatrixCall): void;
	// Fired when the call ends without ever connecting — caller hung
	// up before we answered, we declined, or some error fired.
	onDismiss(): void;
}

export function IncomingCallSheet({ call, peer, onAccept, onDismiss }: IncomingCallSheetProps) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Caller identity — prefer the parent-supplied peer (resolved from
	// the DM's known partner) over SDK getters, which can be unreliable
	// pre-answer.  Fall back to getOpponentMember() and finally the
	// room id so we always have *something* to render.
	const opponent = call.getOpponentMember();
	const callerUserId = (peer?.userId ?? opponent?.userId ?? call.roomId ?? "") as UserId;
	const callerName = peer?.displayName ?? opponent?.name ?? callerUserId;
	const callerAvatar = peer?.avatarMxc ?? opponent?.getMxcAvatarUrl() ?? undefined;
	const isVideo = call.type === CallType.Video;

	// React to the call ending without us answering — caller hung up,
	// timed out, or replaced the call.  We listen for state changes
	// and hangup; when ended we drop the sheet.
	useEffect(() => {
		const onHangup = () => onDismiss();
		const onError = () => onDismiss();
		call.on(CallEvent.Hangup, onHangup);
		call.on(CallEvent.Error, onError);
		return () => {
			call.off(CallEvent.Hangup, onHangup);
			call.off(CallEvent.Error, onError);
		};
	}, [call, onDismiss]);

	async function accept() {
		setPending(true);
		setError(null);
		try {
			// answer(audio, video) — we always grab audio; video only
			// when the inbound invite was a video call.
			await call.answer(true, isVideo);
			onAccept(call);
		} catch (err) {
			// Most common failures here are media-access related —
			// mic/camera permission denied, hardware unavailable, or
			// another tab already holding the device.  Surface the
			// reason instead of silently dropping the sheet so the
			// user can fix it (toggle permission, close other tab) and
			// retry.  Translate the standard DOMException names into
			// human language; fall through to err.message otherwise.
			console.warn("call.answer failed", err);
			const e = err as { name?: string; message?: string };
			const friendly =
				e.name === "NotAllowedError"  ? "Microphone or camera access was denied. Allow access in your browser and try again." :
				e.name === "NotFoundError"    ? "No microphone or camera found on this device." :
				e.name === "NotReadableError" ? "Another app or tab is using your microphone or camera. Close it and try again." :
				e.name === "OverconstrainedError" ? "Your microphone or camera couldn't satisfy the call's constraints." :
				(e.message ?? "Couldn't start the call.");
			setError(friendly);
			// Hang up the call so the caller's side ends too — without
			// this they'd keep ringing while we sit on the error.
			try { call.reject(); } catch { /* already gone */ }
		} finally {
			setPending(false);
		}
	}

	function decline() {
		try { call.reject(); } catch (err) { console.warn("call.reject failed", err); }
		onDismiss();
	}

	return (
		<Dialog open onOpenChange={() => {}}>
			<DialogContent className="sm:max-w-sm" onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
				<div className="flex flex-col items-center text-center gap-4 py-2">
					<MatrixAvatar
						mxc={callerAvatar}
						seed={callerUserId}
						className="h-20 w-20"
					/>
					<div>
						<div className="text-base font-semibold">{callerName}</div>
						<div className="text-xs text-muted-foreground mt-0.5 flex items-center justify-center gap-1.5">
							{isVideo ? <Video className="h-3 w-3" /> : <Phone className="h-3 w-3" />}
							<span>Incoming {isVideo ? "video" : "voice"} call</span>
						</div>
					</div>
					{error && (
						<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2 text-left w-full">
							{error}
						</div>
					)}
					<div className="flex items-center gap-3 mt-2">
						{error ? (
							// After an error, the call is already cancelled —
							// show only Close so the user clears the sheet
							// without us reattempting answer().
							<Button
								type="button"
								size="lg"
								onClick={onDismiss}
							>
								Close
							</Button>
						) : (
							<>
								<Button
									type="button"
									variant="outline"
									size="lg"
									onClick={decline}
									disabled={pending}
									className="text-destructive border-destructive/40 hover:bg-destructive/10"
								>
									<PhoneOff className="h-4 w-4 mr-2" />
									Decline
								</Button>
								<Button
									type="button"
									size="lg"
									onClick={accept}
									disabled={pending}
									className="bg-emerald-600 hover:bg-emerald-700 text-white"
								>
									{isVideo ? <Video className="h-4 w-4 mr-2" /> : <Phone className="h-4 w-4 mr-2" />}
									{pending ? "Connecting…" : "Accept"}
								</Button>
							</>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

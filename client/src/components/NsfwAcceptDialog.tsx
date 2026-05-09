// NSFW invite-confirmation gate.
//
// Shown when a user without their `chat.koven.nsfw_preference` enabled
// is about to accept an invite to an NSFW-flagged room or space, OR
// just joined a SFW space whose hierarchy contains NSFW children.
// Confirming flips the preference on (cross-device via account_data)
// and proceeds with the accept; declining cancels and the room/space
// invite stays pending.
//
// Pre-accept variant ("invite"): caller hasn't joined yet — confirming
// runs the join, declining is a no-op.
//
// Post-accept variant ("space-children"): caller is already in the
// space.  The body explains that NSFW child rooms were skipped and
// confirming will flip the pref + the live m.space.child listener
// will pick up the existing children on the next poll.  Declining
// leaves the user in the space with the NSFW children unjoined.

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface NsfwAcceptDialogProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	mode: "invite" | "space-children";
	// Display name for the room or space at hand — used in the body
	// copy so the user can tell which thing they're confirming for.
	subjectName: string;
	// True when the subject is a space (vs. a room).  Just affects
	// the wording — "this room" vs. "this space".
	isSpace?: boolean;
	// Number of NSFW children skipped during joinSpaceWithChildren —
	// only relevant for mode "space-children".
	skippedNsfwCount?: number;
	// Confirm = enable NSFW pref and proceed.
	onConfirm(): Promise<void> | void;
	// Decline = close the dialog without enabling NSFW.  For "invite"
	// mode the caller should NOT auto-join; for "space-children" the
	// user stays in the space with NSFW children skipped.
	onDecline?(): void;
}

export function NsfwAcceptDialog({
	open, onOpenChange, mode, subjectName, isSpace, skippedNsfwCount, onConfirm, onDecline,
}: NsfwAcceptDialogProps) {
	const subject = isSpace ? "space" : "room";
	const title =
		mode === "invite"
			? `This ${subject} contains adult content`
			: "This space contains NSFW rooms";
	const body =
		mode === "invite"
			? `“${subjectName}” is flagged as NSFW. Accepting will enable adult content on your account so you can see it — you can turn this off later in Settings.`
			: `You joined “${subjectName}”, but ${skippedNsfwCount === 1 ? "1 child room" : `${skippedNsfwCount ?? 0} child rooms`} were skipped because they're flagged NSFW. Enable adult content to auto-join them?`;
	const confirmLabel = mode === "invite" ? "Enable NSFW & accept" : "Enable NSFW";
	const declineLabel = mode === "invite" ? "Cancel" : "Keep them hidden";
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{body}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => {
							onDecline?.();
							onOpenChange(false);
						}}
					>
						{declineLabel}
					</Button>
					<Button
						type="button"
						onClick={async () => {
							await onConfirm();
							onOpenChange(false);
						}}
					>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

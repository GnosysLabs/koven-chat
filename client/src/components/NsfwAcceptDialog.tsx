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
	// Display name for the room or space at hand, used in the body
	// copy so the user can tell which thing they're confirming for.
	// Optional: when omitted (or empty), the body copy falls back to
	// "This room/space" capitalised and unquoted instead of dropping
	// stray '"this room"' fallback strings into the user's face.
	subjectName?: string;
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
	// Body copy switches between named ("Foo Space") and unnamed
	// (fallback "This room/space") cases.  In the unnamed case we
	// capitalise the leading word and skip the curly quotes; in the
	// named case we keep the typographic quotes so the room/space
	// name reads as a quoted title rather than running into the
	// surrounding prose.
	const hasName = !!subjectName && subjectName.length > 0;
	const namedRef = `“${subjectName}”`;
	const fallbackRef = isSpace ? "This space" : "This room";
	const inviteRef = hasName ? namedRef : fallbackRef;
	const childrenLabel = skippedNsfwCount === 1
		? "1 child room"
		: `${skippedNsfwCount ?? 0} child rooms`;
	const body =
		mode === "invite"
			? `${inviteRef} is flagged as NSFW. Accepting will enable adult content on your account so you can see it. You can turn this off later in Settings.`
			: hasName
				? `You joined ${namedRef}, but ${childrenLabel} were skipped because they're flagged NSFW. Enable adult content to auto-join them?`
				: `You joined this space, but ${childrenLabel} were skipped because they're flagged NSFW. Enable adult content to auto-join them?`;
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

// Confirmation modal for bilateral DM deletion.  Lifted out of
// DmProfilePanel so multiple entry points (the panel's button AND
// the sidebar's right-click context menu) share one source of truth
// for the "you are about to nuke this conversation for both
// parties" copy + the irreversible-action gate.
//
// Owned by App.tsx (open/close state, target room id, in-flight
// state).  The parent provides the names + confirm handler; this
// component is pure presentation.
//
// Why a shared modal: a right-click that fires `transport.deleteDm`
// directly is too easy to misfire and the consequences are
// permanent (server-side purge, no undo).  Routing every entry
// point through the same dialog means the user always sees the
// same three bullets and the same two buttons before anything
// irreversible runs.

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

export type DeleteProgressPhase = "paginating" | "redacting" | "kicking" | "cleanup";

export interface DeleteConversationDialogProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	// Display name of the other DM participant.  Used in the body
	// copy.  Falls back to the bare mxid in the caller when no
	// profile is loaded.
	otherDisplayName: string;
	// True while the delete is mid-flight.  Disables both buttons
	// and prevents the dialog from closing on backdrop click.
	deleting: boolean;
	// Progress reported by transport.deleteDm.  Null while idle.
	// We narrate the two coarse phases ("Deleting conversation…" /
	// "Finishing up…") because the server-side purge resolves the
	// whole timeline in one round-trip, a per-event counter would
	// just flash and disappear.
	progress: { phase: DeleteProgressPhase; done: number; total: number } | null;
	onConfirm(): void | Promise<void>;
}

export function DeleteConversationDialog({
	open,
	onOpenChange,
	otherDisplayName,
	deleting,
	progress,
	onConfirm,
}: DeleteConversationDialogProps) {
	let statusLine: string | null = null;
	if (progress) {
		statusLine = progress.phase === "cleanup"
			? "Finishing up…"
			: "Deleting conversation…";
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				// Suppress close while the delete is in flight.  The
				// caller's finally clause owns the close after the
				// operation completes.
				if (!o && deleting) return;
				onOpenChange(o);
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<AlertTriangle className="h-4 w-4 text-destructive" />
						Delete this conversation?
					</DialogTitle>
					<DialogDescription>
						This deletes the conversation for BOTH you and {otherDisplayName}.
					</DialogDescription>
				</DialogHeader>

				<ul className="text-xs text-muted-foreground space-y-1.5 list-disc list-inside leading-relaxed">
					<li>Every message in this DM is deleted on the server.  Their content is wiped from both sides.</li>
					<li>{otherDisplayName} is removed from the conversation.  It disappears from their conversation list too.</li>
					<li>This <strong className="text-foreground">cannot be undone</strong>.  Sent media is unrecoverable once deleted.</li>
				</ul>

				{statusLine && (
					<div className="text-xs text-muted-foreground border border-border rounded-md px-3 py-2 bg-muted/40">
						{statusLine}
					</div>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={deleting}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						onClick={onConfirm}
						disabled={deleting}
					>
						{deleting ? "Deleting…" : "Delete for both"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// Centered confirmation dialog for an admin redacting someone else's
// message.  Parallel to DeleteMessageDialog (which is for own-message
// + own-bot deletion); both live at the message-row level so they
// stay mounted while the user moves their cursor off the hover-gated
// MessageActions toolbar.  See DeleteMessageDialog for the
// architectural rationale.
//
// Distinct from a self-delete in two ways:
//   1. The accent is the amber "moderation" tone matching the shield
//      icon on the toolbar — not the destructive red of a self-delete.
//      Admin redact is consequential but it isn't your content;
//      colour-coding the two flows separately avoids muscle-memory
//      misclicks.
//   2. The redaction goes into the public mod log with the actor's
//      mxid, and the dialog copy says so up front.  Sunlight is the
//      one rule Koven's moderation model enforces; this is where the
//      operator sees that reminder before committing.

import { useEffect, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Shield } from "lucide-react";

export interface AdminRedactDialogProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	onConfirm(): void | Promise<void>;
}

export function AdminRedactDialog({ open, onOpenChange, onConfirm }: AdminRedactDialogProps) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			setError(null);
			setPending(false);
		}
	}, [open]);

	async function handleConfirm() {
		setError(null);
		setPending(true);
		try {
			await onConfirm();
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Shield className="h-4 w-4 text-amber-500" aria-hidden />
						Redact this message?
					</DialogTitle>
					<DialogDescription>
						The message will be removed for everyone in the room.
						The redaction lands in the public mod log with your
						mxid and stays there forever.
					</DialogDescription>
				</DialogHeader>
				{error && (
					<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
						{error}
					</div>
				)}
				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={pending}
					>
						Cancel
					</Button>
					<Button
						type="button"
						onClick={handleConfirm}
						disabled={pending}
						// Amber accent matching the shield icon on the
						// MessageActions toolbar — distinct from the
						// destructive-red of a self-delete so the two
						// flows feel visually different and a misclick
						// on the wrong row never produces the wrong kind
						// of action.
						className="bg-amber-500 text-amber-950 hover:bg-amber-500/90 focus-visible:ring-amber-500"
					>
						{pending ? "Redacting…" : "Redact"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

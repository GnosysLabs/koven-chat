// Centered confirmation dialog for redacting a message.
//
// Lives at the message-row level (not inside MessageActions) so it
// stays mounted while the user moves their cursor off the row to
// click Delete.  MessageActions is hover-gated and would otherwise
// unmount the dialog the moment the row un-hovered, making it pop
// up and disappear after a beat.
//
// `onConfirm` is async so the dialog can await the real network
// round-trip — Cancel button disabled, "Deleting…" label, and on
// failure we keep the dialog open and surface the engine's error
// in a red-bordered box (same shape as the encryption sheets).
// That way 403 "not your bot", 502 "redaction failed", and network
// errors are all visibly debuggable without devtools.

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

export interface DeleteMessageDialogProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	onConfirm(): void | Promise<void>;
}

export function DeleteMessageDialog({ open, onOpenChange, onConfirm }: DeleteMessageDialogProps) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Reset transient state whenever the dialog reopens — without
	// this a previous error message would still be there next time.
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
					<DialogTitle>Delete this message?</DialogTitle>
					<DialogDescription>
						This can't be undone.
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
						variant="destructive"
						onClick={handleConfirm}
						disabled={pending}
					>
						{pending ? "Deleting…" : "Delete"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

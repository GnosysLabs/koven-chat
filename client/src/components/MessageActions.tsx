// Hover toolbar that appears next to each message — react, reply, flag.
// Reactions use a tight inline popover (just emoji buttons).  Flag and
// reply are single-click — flag in particular needs a dialog with
// category + rationale, hosted at the message-row level so the always-
// visible flag pill can also open it.

import { useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Flag, Reply, SmilePlus, Trash2 } from "lucide-react";

const QUICK_EMOJI = ["👍", "❤️", "😂", "🎉", "🔥", "😮", "🙏", "👀"];

export interface MessageActionsProps {
	onReact(emoji: string): void;
	onReply(): void;
	onFlagClick(): void;
	// Show the flag button.  Defaults to true; the chat pane sets it
	// false in DM rooms where the consensus-flag mechanism doesn't
	// apply (a 1-on-1 chat has no community to vote with you).
	showFlag?: boolean;
	// Self-delete affordance.  When provided, a trash icon appears at
	// the end of the toolbar — clicking it invokes onDelete.  Shown
	// for messages the caller is allowed to redact: their own, or
	// their owned bot's.  The chat pane decides eligibility and only
	// passes a handler when applicable; everyone else sees the
	// toolbar without a trash button at all.
	onDelete?(): void;
	className?: string;
	// Optional controlled popover state for the React picker.  Lifted
	// up to the parent message row so the parent can keep the action
	// toolbar visible while the picker is open (otherwise the toolbar
	// fades out the moment the user moves their mouse off the message
	// to pick an emoji).  When omitted, the popover stays uncontrolled
	// for callers that don't need this coordination.
	reactOpen?: boolean;
	onReactOpenChange?(open: boolean): void;
}

export function MessageActions({
	onReact, onReply, onFlagClick, showFlag = true, onDelete, className,
	reactOpen: reactOpenProp, onReactOpenChange,
}: MessageActionsProps) {
	const [internalReactOpen, setInternalReactOpen] = useState(false);
	const reactOpen = reactOpenProp ?? internalReactOpen;
	const setReactOpen = onReactOpenChange ?? setInternalReactOpen;

	return (
		<div className={cn(
			"flex items-center gap-0.5 p-0.5 rounded-md border border-border bg-card shadow-sm",
			className
		)}>
			<Popover open={reactOpen} onOpenChange={setReactOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
						title="React"
						aria-label="React"
					>
						<SmilePlus className="h-3.5 w-3.5" />
					</button>
				</PopoverTrigger>
				<PopoverContent
					side="top"
					align="end"
					className="w-auto p-1.5"
					sideOffset={4}
				>
					<div className="flex gap-0.5">
						{QUICK_EMOJI.map(e => (
							<button
								key={e}
								type="button"
								onClick={() => {
									onReact(e);
									setReactOpen(false);
								}}
								className="h-7 w-7 rounded hover:bg-accent text-base leading-none transition-colors"
								title={`React with ${e}`}
							>
								{e}
							</button>
						))}
					</div>
				</PopoverContent>
			</Popover>

			<button
				type="button"
				onClick={onReply}
				className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
				title="Reply"
				aria-label="Reply"
			>
				<Reply className="h-3.5 w-3.5" />
			</button>

			{showFlag && (
				<button
					type="button"
					onClick={onFlagClick}
					className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
					title="Flag"
					aria-label="Flag"
				>
					<Flag className="h-3.5 w-3.5" />
				</button>
			)}

			{onDelete && <DeleteAction onConfirm={onDelete} />}
		</div>
	);
}

// Inline confirmation popover for the trash button.
//
// We DON'T use `window.confirm()` here — Tauri 2's WebView
// suppresses the native dialog without a runtime warning, so on the
// desktop app the "are you sure?" prompt silently returns undefined
// and the click looks like it does nothing.  Some browser extensions
// and corporate policies do the same in the web client.  An in-app
// Popover is reliable across every environment we ship to and
// matches the affordance pattern of the React picker right next to
// it (so the muscle memory of "click, get a small pop-up, click
// the action" is consistent across the toolbar).
function DeleteAction({ onConfirm }: { onConfirm: () => void }) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
					title="Delete"
					aria-label="Delete"
				>
					<Trash2 className="h-3.5 w-3.5" />
				</button>
			</PopoverTrigger>
			<PopoverContent side="top" align="end" sideOffset={4} className="w-auto p-2">
				<div className="flex items-center gap-2">
					<span className="text-xs text-foreground">Delete this message?</span>
					<button
						type="button"
						onClick={() => setOpen(false)}
						className="text-xs px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={() => {
							setOpen(false);
							onConfirm();
						}}
						className="text-xs px-2 py-1 rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
					>
						Delete
					</button>
				</div>
			</PopoverContent>
		</Popover>
	);
}

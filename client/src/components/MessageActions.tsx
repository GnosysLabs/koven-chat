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
import { Flag, Reply, Shield, SmilePlus, Trash2, Pencil } from "lucide-react";
import { InlineEmojiPicker } from "@/components/EmojiPicker";

export interface MessageActionsProps {
	onReact(emoji: string): void;
	onReply(): void;
	onFlagClick(): void;
	// Show the flag button.  Defaults to true; the chat pane sets it
	// false in DM rooms where the consensus-flag mechanism doesn't
	// apply (a 1-on-1 chat has no community to vote with you).
	showFlag?: boolean;
	onEdit?(): void;
	// Self-delete affordance.  When provided, a trash icon appears at
	// the end of the toolbar: clicking it fires this handler, which
	// is expected to OPEN the confirmation dialog (not perform the
	// redaction directly).  Confirmation + the actual network call
	// live at the row level (see ChatPane's MessageRow) so the
	// dialog stays mounted when the user moves their cursor off the
	// message to interact with it: a Dialog inside MessageActions
	// would unmount the moment the toolbar's hover state cleared.
	onDelete?(): void;
	// Admin redact affordance.  Distinct from `onDelete` (which is
	// scoped to the message's own author or to a bot the viewer owns):
	// this surface is for admins (PL ≥ 50) acting on someone ELSE's
	// message.  When provided AND the message isn't the viewer's own
	// (the caller decides), a Shield icon appears at the end of the
	// toolbar.  The handler is expected to confirm + perform the
	// redaction + record the audit row.
	onAdminRedact?(): void;
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
	onReact, onReply, onFlagClick, showFlag = true, onEdit, onDelete, onAdminRedact, className,
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
					// Hand sizing entirely to emoji-mart.  The picker
					// paints its own ~360x450 surface with search,
					// categories, and a Frequently-Used row at the
					// top that effectively replaces the old hardcoded
					// quick-react buttons (with the user's actual
					// most-used emojis instead of our 8 guesses).
					className="p-0 border-0 bg-transparent shadow-none w-auto"
					sideOffset={4}
					// Trap wheel + touch inside the picker so the
					// surrounding chat pane doesn't intercept scroll.
					onWheel={e => e.stopPropagation()}
					onTouchMove={e => e.stopPropagation()}
					collisionPadding={16}
				>
					<InlineEmojiPicker
						onPick={(emoji) => {
							onReact(emoji);
							setReactOpen(false);
						}}
					/>
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

			{onEdit && (
				<button
					type="button"
					onClick={onEdit}
					className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
					title="Edit"
					aria-label="Edit"
				>
					<Pencil className="h-3.5 w-3.5" />
				</button>
			)}

			{onDelete && (
				<button
					type="button"
					onClick={onDelete}
					className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
					title="Delete"
					aria-label="Delete"
				>
					<Trash2 className="h-3.5 w-3.5" />
				</button>
			)}

			{onAdminRedact && (
				<button
					type="button"
					onClick={onAdminRedact}
					// Amber tone visually separates the admin-redact
					// affordance from the destructive self-delete trash
					// — admins moderating other people's content read
					// the icon AND the colour as "this is a moderation
					// action, not your own message".
					className="p-1 rounded text-muted-foreground hover:text-amber-500 hover:bg-amber-500/10 transition-colors"
					title="Admin redact"
					aria-label="Admin redact"
				>
					<Shield className="h-3.5 w-3.5" />
				</button>
			)}
		</div>
	);
}

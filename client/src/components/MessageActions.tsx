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
import { Flag, Reply, SmilePlus } from "lucide-react";

const QUICK_EMOJI = ["👍", "❤️", "😂", "🎉", "🔥", "😮", "🙏", "👀"];

export interface MessageActionsProps {
	onReact(emoji: string): void;
	onReply(): void;
	onFlagClick(): void;
	// Show the flag button.  Defaults to true; the chat pane sets it
	// false in DM rooms where the consensus-flag mechanism doesn't
	// apply (a 1-on-1 chat has no community to vote with you).
	showFlag?: boolean;
	className?: string;
}

export function MessageActions({ onReact, onReply, onFlagClick, showFlag = true, className }: MessageActionsProps) {
	const [reactOpen, setReactOpen] = useState(false);

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
		</div>
	);
}

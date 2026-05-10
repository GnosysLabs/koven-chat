// Small bot pill rendered next to a bot user's name across the
// chat surface — in member lists, message-row sender labels, DM
// headers, and the bot management pane.  No other visual difference
// is applied to bot mxids: avatars, mention behaviour, and message
// formatting all stay identical to a regular user, so the badge is
// the single source of truth that a name belongs to an automated
// account.
//
// Glyph-only via lucide's Bot icon — reads cleaner than the BOT
// wordmark next to a username, especially in dense member lists.
// Tooltip carries the "Bot account" label for hover / screen reader
// context.

import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BotBadgeProps {
	className?: string;
	// Compact variant: smaller padding, used inline next to a name in
	// dense lists (member list, message header).  Default = full size,
	// suited to standalone profile chips.
	compact?: boolean;
}

export function BotBadge({ className, compact = true }: BotBadgeProps) {
	return (
		<span
			className={cn(
				"inline-flex items-center justify-center",
				"bg-primary/15 text-primary rounded",
				compact ? "h-5 w-5" : "h-6 w-6",
				className,
			)}
			aria-label="Bot account"
			title="Bot account"
		>
			<Bot
				className={compact ? "h-3.5 w-3.5" : "h-4 w-4"}
				strokeWidth={2.4}
				aria-hidden
			/>
		</span>
	);
}

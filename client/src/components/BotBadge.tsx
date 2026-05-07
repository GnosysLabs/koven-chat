// Small "BOT" pill rendered next to a bot user's name across the
// chat surface — in member lists, message-row sender labels, DM
// headers, and the bot management pane.  No other visual difference
// is applied to bot mxids: avatars, mention behaviour, and message
// formatting all stay identical to a regular user, so the badge is
// the single source of truth that a name belongs to an automated
// account.

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
				"inline-flex items-center font-semibold tracking-wide uppercase",
				"bg-primary/15 text-primary rounded",
				compact ? "text-[9px] px-1 py-px leading-none" : "text-[10px] px-1.5 py-0.5",
				className,
			)}
			aria-label="Bot account"
			title="Bot account"
		>
			Bot
		</span>
	);
}

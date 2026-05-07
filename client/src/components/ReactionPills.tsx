// Renders the row of reaction pills under a message bubble.  Each
// pill is a clickable toggle: if you've already reacted with that
// emoji, click removes your reaction; otherwise it adds one.

import { cn } from "@/lib/utils";
import type { ReactionAggregate } from "@koven/shared";

export interface ReactionPillsProps {
	reactions: ReactionAggregate[];
	onToggle(reaction: ReactionAggregate): void;
}

export function ReactionPills({ reactions, onToggle }: ReactionPillsProps) {
	if (reactions.length === 0) return null;
	return (
		<div className="flex flex-wrap gap-1 mt-1">
			{reactions.map(r => {
				const reacted = !!r.myReactionId;
				return (
					<button
						key={r.key}
						type="button"
						onClick={() => onToggle(r)}
						title={r.reactors.length <= 5
							? r.reactors.join(", ")
							: `${r.reactors.slice(0, 4).join(", ")} and ${r.reactors.length - 4} more`}
						className={cn(
							"inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs leading-none transition-colors",
							reacted
								? "bg-primary/10 border-primary/40 text-foreground"
								: "bg-secondary border-border text-muted-foreground hover:bg-accent hover:text-foreground"
						)}
					>
						<span className="text-sm leading-none">{r.key}</span>
						<span className="tabular-nums">{r.count}</span>
					</button>
				);
			})}
		</div>
	);
}

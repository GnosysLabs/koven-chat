// Compact reputation badge — five vertical ticks, filled in proportion
// to the user's weight.  Reads as a "level X of 5" indicator, no
// decoding required.  All filled ticks use the same warm accent color;
// adding tier-coded color was confusing (green-to-amber didn't read as
// "more") and the count alone is enough signal.
//
// Renders nothing when the engine hasn't returned data yet; we'd
// rather leave the line clean than flash a placeholder.

import { useReputation } from "@/lib/useReputation";
import { descriptorFor, tickClassForFilled, ticksFor } from "@/lib/reputation";
import { cn } from "@/lib/utils";

export interface RepBadgeProps {
	userId: string;
	className?: string;
	// Show name + weight on hover.  Defaults to true; set false in
	// already-tooltipped contexts (e.g. inside a row with its own
	// title).
	showTooltip?: boolean;
}

const TICKS = 5;

export function RepBadge({ userId, className, showTooltip = true }: RepBadgeProps) {
	const rep = useReputation(userId);
	if (!rep) return null;

	const desc = descriptorFor(rep.weight);
	// Weight is clamped to [0.5, 5] by the engine.  Floor of the
	// 2-decimal-rounded weight maps each whole step to one tick:
	// brand-new users at 0.5 → 0 ticks (no color shown); 1.x → 1 tick
	// (red); 4.x → 4 ticks (green); 5 → 5.  Round-then-floor matches
	// the displayed value so a weight that reads "3.00" never shows
	// only 2 filled ticks (which would happen with raw Math.floor on
	// 2.997).
	const filled = ticksFor(rep.weight, TICKS);
	const tickClass = tickClassForFilled(filled);
	const tooltip = showTooltip
		? `${desc.label} · ${rep.weight.toFixed(2)} — ${desc.description}`
		: undefined;

	return (
		<span
			className={cn("inline-flex items-end gap-px", className)}
			title={tooltip}
			aria-label={`Reputation: ${desc.label} (${filled} of ${TICKS})`}
		>
			{Array.from({ length: TICKS }).map((_, i) => (
				<span
					key={i}
					className={cn(
						"w-[2px] rounded-[1px] transition-colors",
						// Stair-step heights so the bars escalate left-to-right
						// and read as a level meter even at small sizes.
						i === 0 ? "h-1.5"
							: i === 1 ? "h-2"
							: i === 2 ? "h-2.5"
							: i === 3 ? "h-3"
							: "h-3.5",
						i < filled ? tickClass : "bg-muted-foreground/25",
					)}
				/>
			))}
		</span>
	);
}

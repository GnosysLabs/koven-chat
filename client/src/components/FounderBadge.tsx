// Holographic "Founder" badge — surfaced on the first 666 users'
// profiles + inline next to their names in chat / member lists.  The
// badge IS the reward; engine claims a slot atomically on signup
// (and via boot backfill for users who pre-date the feature), client
// reads from a cached founders roster (see lib/founders-cache.ts) and
// renders this component wherever the user shows up.
//
// Two variants:
//   * compact (default) — small pill that sits inline next to a
//     username, mirrors the BotBadge layout.  Tiny inline icon +
//     "#042"; tooltip on hover for full "Founder #42 of 666".
//   * profile — full holographic chip for the profile sheet.  Bigger,
//     animated shimmer, "FOUNDER" wordmark + display-font number.
//     This is the moment-of-presence, the actual flex.
//
// Visual treatment is pure CSS — gradients, animations, no images —
// so it scales crisply at any DPR and ships zero asset bytes.  The
// shimmer loops every 4 seconds, ease-in-out so it doesn't feel
// frantic.  Reduced-motion users get the gradient without the
// animation (respect their preference).

import { Gem } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FounderBadgeProps {
	number: number;
	cap?: number; // Default 666; passed through for the tooltip text.
	variant?: "compact" | "profile";
	className?: string;
}

/** Format a 1-666 number as a 3-digit padded string (#001 .. #666).
 * Padding makes every badge the same width, which matters for the
 * inline variant (consistent column edge in member lists) and reads
 * as "limited edition serial number" on the profile chip. */
function pad(n: number): string {
	if (n < 0 || !Number.isFinite(n)) return "#???";
	return `#${String(Math.floor(n)).padStart(3, "0")}`;
}

export function FounderBadge({
	number,
	cap = 666,
	variant = "compact",
	className,
}: FounderBadgeProps) {
	const tooltip = `Founder ${pad(number)} of ${cap}`;
	if (variant === "profile") {
		return (
			<div
				className={cn(
					// Type-only chip — "FOUNDER" wordmark over the
					// numerical slot.  Dropping the glyph reads
					// classier; the holograph is decoration enough.
					"inline-flex flex-col items-center px-3 py-1.5 rounded-full leading-tight",
					"text-zinc-900",
					"founder-holo founder-holo-profile",
					"shadow-[0_0_24px_-6px_rgba(167,139,250,0.55)]",
					"ring-1 ring-white/20",
					"select-none",
					className,
				)}
				role="img"
				aria-label={tooltip}
				title={tooltip}
			>
				<span className="text-[9px] uppercase tracking-[0.2em] font-semibold opacity-80">
					Founder
				</span>
				<span className="inline-flex items-center gap-1 text-base font-display font-bold tabular-nums tracking-tight">
					<Gem className="h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden />
					{pad(number).slice(1)}
				</span>
			</div>
		);
	}
	// Compact inline variant — sits next to a username at a glance.
	// Gem stands in for the `#` prefix on the inline chip only — the
	// profile chip still uses the `FOUNDER` wordmark + #042 format
	// because there's room for type to do the work there.
	return (
		<span
			className={cn(
				"inline-flex items-center gap-0.5 px-1.5 py-px rounded-full",
				"text-[9px] font-bold tracking-wide tabular-nums",
				"text-zinc-900",
				"founder-holo founder-holo-compact",
				"ring-1 ring-white/15",
				"select-none align-middle",
				className,
			)}
			role="img"
			aria-label={tooltip}
			title={tooltip}
		>
			<Gem className="h-2.5 w-2.5 shrink-0" strokeWidth={2.4} aria-hidden />
			{pad(number).slice(1)}
		</span>
	);
}

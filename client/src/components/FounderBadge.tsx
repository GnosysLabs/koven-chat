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
					// Layout: compact horizontal chip with crystal icon
					// on the left + label/number stacked on the right.
					"inline-flex items-center gap-2.5 px-3 py-1.5 rounded-full",
					// Visible text colour overrides the holograph's
					// gradient; we want the label readable rather than
					// merging into the rainbow.
					"text-white",
					// "Founder" wordmark + animated shimmer.  The
					// gradient + animation live in the inline style
					// below so reduced-motion users can opt out via
					// the prefers-reduced-motion media query (the CSS
					// `animation-name: none` overrides the inline rule
					// when that media query matches — see the @media
					// block we add to index.css).
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
				{/* Crystal icon — diamond outline + center facet.  Pure
				    SVG so it sharpens on retina and inherits the chip's
				    text colour.  viewBox sized so it visually matches
				    the wordmark cap height. */}
				<svg
					viewBox="0 0 24 24"
					className="h-5 w-5 shrink-0 drop-shadow-[0_1px_4px_rgba(255,255,255,0.45)]"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.6"
					strokeLinejoin="round"
					strokeLinecap="round"
					aria-hidden
				>
					<path d="M12 2 L22 9 L12 22 L2 9 Z" />
					<path d="M2 9 L22 9" />
					<path d="M12 2 L8 9 L12 22 L16 9 Z" />
				</svg>
				<div className="flex flex-col leading-tight">
					<span className="text-[9px] uppercase tracking-[0.2em] font-semibold opacity-80">
						Founder
					</span>
					<span className="text-base font-display font-bold tabular-nums tracking-tight">
						{pad(number)}
					</span>
				</div>
			</div>
		);
	}
	// Compact inline variant — sits next to a username at a glance.
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 px-1.5 py-px rounded-full",
				"text-[9px] font-semibold tracking-wide tabular-nums",
				"text-white",
				"founder-holo founder-holo-compact",
				"ring-1 ring-white/15",
				"select-none align-middle",
				className,
			)}
			role="img"
			aria-label={tooltip}
			title={tooltip}
		>
			<svg
				viewBox="0 0 24 24"
				className="h-2.5 w-2.5 shrink-0"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinejoin="round"
				strokeLinecap="round"
				aria-hidden
			>
				<path d="M12 2 L22 9 L12 22 L2 9 Z" />
			</svg>
			{pad(number)}
		</span>
	);
}

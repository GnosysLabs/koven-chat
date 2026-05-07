// Reputation tier mapping — translates the engine's continuous weight
// (0.5–5.0) into named tiers and a 0–5 tick count.
//
// Brand-new users start at 0.5 (zero ticks filled) and earn ticks as
// they accumulate posts + reactions.  Tier breakpoints align with
// the tick-fill thresholds so the named tier and the visual meter
// always agree:
//
//   weight        ticks  color    tier
//   ──────────────────────────────────────
//   0.5 – 0.99      0    —        new
//   1.0 – 1.99      1    red      new
//   2.0 – 2.99      2    orange   active
//   3.0 – 3.99      3    yellow   active
//   4.0 – 4.99      4    green    rooted
//   5.0             5    green    rooted

export type ReputationTier = "new" | "active" | "rooted";

export interface ReputationDescriptor {
	tier: ReputationTier;
	label: string;
	colorClass: string;        // text color tailwind class for tier label
	bgClass: string;           // soft background pill class (10% opacity)
	tickClass: string;         // solid background class for the level-meter ticks
	description: string;       // tooltip blurb explaining what this tier represents
}

// Tier breakpoints aligned to the tick thresholds — a user's named
// tier and their tick color always tell the same story.
//   [0.0, 2.0)  → New     (0–1 ticks, empty or red)
//   [2.0, 4.0)  → Active  (2–3 ticks, orange or yellow)
//   [4.0, 5.0]  → Rooted  (4–5 ticks, green)
const TIER_BREAKPOINTS = [
	{ min: 4.0, tier: "rooted" as const },
	{ min: 2.0, tier: "active" as const },
	{ min: 0.0, tier: "new" as const },
];

const DESCRIPTORS: Record<ReputationTier, ReputationDescriptor> = {
	new: {
		tier: "new",
		label: "New",
		colorClass: "text-foreground",
		bgClass: "bg-amber-500/10",
		tickClass: "bg-amber-500",
		description: "Earning posts and reactions.",
	},
	active: {
		tier: "active",
		label: "Active",
		colorClass: "text-foreground",
		bgClass: "bg-amber-500/10",
		tickClass: "bg-amber-500",
		description: "Posting regularly and getting reactions.",
	},
	rooted: {
		tier: "rooted",
		label: "Rooted",
		colorClass: "text-foreground",
		bgClass: "bg-amber-500/10",
		tickClass: "bg-amber-500",
		description: "Sustained contributor with consistent reactions earned.",
	},
};

export function tierFor(weight: number): ReputationTier {
	for (const b of TIER_BREAKPOINTS) {
		if (weight >= b.min) return b.tier;
	}
	return "new";
}

export function descriptorFor(weight: number): ReputationDescriptor {
	return DESCRIPTORS[tierFor(weight)];
}

/**
 * Tick color for the level meter.  All filled ticks share one color
 * keyed off the count, so the meter's color is a glance-readable
 * summary of where the user sits:
 *
 *   1 filled  → red    (just past the floor; weight ≈ 1)
 *   2 filled  → orange (warming up; weight ≈ 2)
 *   3 filled  → yellow (active; weight ≈ 3)
 *   4–5 filled → green (rooted; weight ≥ 4)
 *
 * 0 filled returns the empty-tick class (caller can default to a
 * muted gray).  Single source of truth so the badge, profile sheet,
 * and DM profile panel all agree.
 */
/**
 * Convert a continuous weight (0.5–5.0) into a 0..total tick count
 * matching the visual meter.  The weight is rounded to 2 decimals
 * BEFORE flooring so the tick count agrees with the user-visible
 * `weight.toFixed(2)` label: e.g. 2.997 reads as "3.00" and fills 3
 * ticks, not 2.  Without this rounding, floating-point weights that
 * display as a clean "3.00" can fill only 2 ticks because their raw
 * value is 2.99-something.
 */
export function ticksFor(weight: number, total = 5): number {
	const rounded = Math.round(weight * 100) / 100;
	return Math.max(0, Math.min(total, Math.floor(rounded)));
}

// Time-gated tier ladder thresholds, mirroring the engine's
// ageGatedCap (engine/src/weight.ts).  We replay the math here so the
// UI can tell the user how long until their next tier unlocks
// without round-tripping to the server.
const TIER_AGE_GATES_DAYS = [1, 7, 30, 60, 90];

/**
 * Given an account age in days, return a human-readable string for
 * how long until the next tier's age gate opens, or null when the
 * user is past every gate (age >= 90 days, weight cap fully unlocked).
 *
 * Note: this only describes the AGE bottleneck.  A user might still
 * be activity-bottlenecked when the gate opens — the engine doesn't
 * promise the tier will fill, only that the ceiling will rise.
 */
export function nextTierUnlockLabel(ageDays: number | undefined): string | null {
	if (ageDays === undefined || ageDays < 0) return null;
	const next = TIER_AGE_GATES_DAYS.find(t => ageDays < t);
	if (next === undefined) return null;
	const remainingDays = next - ageDays;
	if (remainingDays >= 1) {
		const d = Math.ceil(remainingDays);
		return `Next tier unlocks in ${d} day${d === 1 ? "" : "s"}`;
	}
	const remainingHours = remainingDays * 24;
	if (remainingHours >= 1) {
		const h = Math.ceil(remainingHours);
		return `Next tier unlocks in ${h} hour${h === 1 ? "" : "s"}`;
	}
	const remainingMinutes = Math.max(1, Math.ceil(remainingHours * 60));
	return `Next tier unlocks in ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`;
}

export function tickClassForFilled(filled: number): string {
	if (filled >= 4) return "bg-emerald-500";
	if (filled === 3) return "bg-yellow-400";
	if (filled === 2) return "bg-orange-500";
	if (filled === 1) return "bg-red-500";
	return "bg-muted-foreground/25";
}

// Engine response shape.  Mirrors what the engine writes into its
// SQLite weights table; `unseen` is set when the engine has never
// seen the user (in which case weight defaults to 1.0 and
// posts/reactions are absent).
export interface ReputationData {
	user_id: string;
	weight: number;
	posts_30d?: number;
	reactions_90d?: number;
	age_days?: number;
	computed_at?: number;
	unseen?: boolean;
}

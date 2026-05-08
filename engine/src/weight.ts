// Reputation weight per the GOVERNANCE.md formula.  Recomputed for
// every user we've seen on each tick — cheap because all the inputs
// are precomputed indexed counts.
//
//   raw_weight = sqrt(account_age_days × posts_30d × reactions_received_90d)
//   weight     = clamp(raw_weight, 0.5, 5.0)
//
// Brand-new users sit at 0.5 (the floor) — just below the 1.0 baseline
// where their flag/vote starts to matter.  As they accrue age + activity
// + reactions, weight climbs.  Cap is 5.0 so no one accumulates unbounded
// influence.
//
// We use first_seen_ts as a stand-in for account_age_days.  The real
// "account age" would be the user's registration timestamp on the
// homeserver, but we don't always have that — first_seen is the engine's
// honest best knowledge.  Once the engine has been running long enough
// for genuinely-old accounts to age past whatever we'd cap at, this
// approximation washes out.

import {
	countFalseFlagsByUser,
	countPostsSince,
	countReactionsSince,
	readAllUsers,
	writeWeight,
	type WeightRow,
} from "./db";

const DAY_MS = 24 * 60 * 60 * 1000;
// Exported so server.ts can use the same canonical floor when
// answering /api/weight for users we haven't observed yet — keeps
// the "unseen user" response consistent with the computed-default
// path used everywhere else in the engine.
export const WEIGHT_FLOOR = 0.5;
const WEIGHT_CEIL = 5.0;

// Time-gated tier ladder.  Each tier requires a minimum account
// age; activity alone can't push past the gate.  This stops the
// "register → spam → claim high reputation" attack vector: even with
// perfect activity numbers, a fresh account is hard-clamped below
// the next tier until the age threshold passes.
//
// Numbers picked deliberately:
//   - 24h:  cheapest filter; kills first-hour signup-and-flag attacks
//   - 7d:   throwaway brigade accounts typically don't last a week
//   - 30d:  matches the censure window; "you've been around a month"
//   - 60d:  sustained presence
//   - 90d:  peak influence is genuinely earned through persistence
function ageGatedCap(ageDays: number): number {
	if (ageDays < 1)  return 0.99;    // tier 0 only (0 ticks)
	if (ageDays < 7)  return 1.99;    // up to tier 1 (red)
	if (ageDays < 30) return 2.99;    // up to tier 2 (orange)
	if (ageDays < 60) return 3.99;    // up to tier 3 (yellow)
	if (ageDays < 90) return 4.99;    // up to tier 4 (green)
	return WEIGHT_CEIL;                // tier 5 unlocked
}

export function computeWeight(userId: string, firstSeenTs: number, now: number): WeightRow {
	const ageDays = Math.max(0, (now - firstSeenTs) / DAY_MS);
	const posts30d = countPostsSince(userId, now - 30 * DAY_MS);
	const reactions90d = countReactionsSince(userId, now - 90 * DAY_MS);

	// Bootstrap nudge: add 1 to each input so a totally-fresh account
	// (age 0, posts 0, reactions 0) doesn't sqrt to 0 and disappear
	// from the weighted-vote system entirely.  raw at zero-history is
	// sqrt(1·1·1) = 1.0, which the clamp pulls down to the 0.5 floor
	// since the user hasn't actually demonstrated anything yet.  As
	// they accrue activity, raw rises above the floor and tracks
	// reality.
	const raw = Math.sqrt((ageDays + 1) * (posts30d + 1) * (reactions90d + 1));
	// New-user pull-down: until a user has at least a handful of posts,
	// hold them at the floor.  Three posts is a low bar but it still
	// rules out signed-up-but-never-said-anything accounts.  Reactions
	// still matter — they're factored into the raw-weight calculation
	// above — but we don't make a single reaction received a hard
	// prereq, since unreacted-to content is common for niche posters
	// and shouldn't lock someone at the floor forever.
	const hasMinHistory = posts30d >= 3;
	let weight = hasMinHistory
		? Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEIL, raw))
		: WEIGHT_FLOOR;

	// Time gate: even with great activity, hard-cap by account age.
	// See ageGatedCap above for the ladder.
	weight = Math.min(weight, ageGatedCap(ageDays));

	// False-flag penalty: any floor-violation flag this user has
	// submitted in the last 30 days that an admin has reversed gets
	// their weight clamped to the floor for that window.  This is the
	// reputation half of the false-flag punishment (the other half
	// being the auto-suspension at the 2-in-30 / 3-ever threshold,
	// handled at admin-reverse time in server.ts).  Even a single
	// reversed false floor flag is bad enough to wipe out the rest of
	// their weight signal.
	const falseFlagsRecent = countFalseFlagsByUser(userId, now - 30 * DAY_MS);
	if (falseFlagsRecent > 0) weight = WEIGHT_FLOOR;

	return {
		user_id: userId,
		weight,
		posts_30d: posts30d,
		reactions_90d: reactions90d,
		age_days: ageDays,
		computed_at: now,
	};
}

export function tick(now: number = Date.now()): number {
	const users = readAllUsers();
	for (const u of users) {
		writeWeight(computeWeight(u.user_id, u.first_seen_ts, now));
	}
	return users.length;
}

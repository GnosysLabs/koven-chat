// Collapse evaluation — the consensus moderation step.  Runs each
// tick: scans flagged messages, tallies distinct flaggers + their
// summed weights, and emits a `chat.koven.collapse.v1` event into
// the room when thresholds are met.  Idempotent — once a target has
// been collapsed, we skip it forever (one-shot collapse for v1).
//
// Floor violations (CSAM/threats) bypass the threshold check and
// collapse on a single flag.  All other categories are gated by the
// distinct-flagger floor (3) and a per-room dynamic weighted-score
// threshold (10% of active room weight, clamped to [3, 33]).

import { config } from "./config";
import {
	flagsForTarget,
	hasCollapse,
	insertCollapse,
	listFlaggedTargets,
	readWeight,
	roomActiveWeight,
} from "./db";
import { joinRoomIfNeeded, sendBotEvent } from "./synapse";

// Hard floor on number of distinct flaggers.  Independent of room
// size — fewer than 3 doesn't read as "the room agrees" anywhere.
const THRESHOLD_USERS = 3;

// Dynamic weighted-score gate.
//
// The threshold is 10% of the room's active weighted pool — the sum
// of weights for users who've posted in the room in the last 30
// days.  Floors and ceilings keep it sane at extremes:
//
//   - 3.0 floor: in a tiny room (or one with mostly fresh users),
//     three baseline users (weight 1.0 each) is the bare minimum
//     the system will ever accept.  Below that we're not collapsing
//     content on "consensus" — it's a quorum of one or two.
//   - 33.0 ceiling: huge rooms (thousands of active users) would
//     otherwise need an unreachable coalition.  The ceiling caps
//     the gate at a number that's hard but not impossible —
//     ~17 mid-tier flaggers, ~7 high-tier ones.
//
// At a room scale above ~330 active weight (e.g. 165 mid-tier
// posters), the ceiling kicks in.  Below that, the gate scales with
// who's actually around to flag.
const THRESHOLD_PERCENT = 0.10;
const THRESHOLD_FLOOR = 3.0;
const THRESHOLD_CEIL = 33.0;
const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function thresholdWeightFor(roomId: string): number {
	const active = roomActiveWeight(roomId, Date.now() - ACTIVE_WINDOW_MS);
	const raw = active * THRESHOLD_PERCENT;
	return Math.max(THRESHOLD_FLOOR, Math.min(THRESHOLD_CEIL, raw));
}

interface Tally {
	flaggers: Set<string>;
	categories: Set<string>;
	weight: number;
	hasFloor: boolean;
}

function tallyFlags(targetEventId: string): Tally {
	const tally: Tally = {
		flaggers: new Set(),
		categories: new Set(),
		weight: 0,
		hasFloor: false,
	};
	for (const f of flagsForTarget(targetEventId)) {
		// Don't double-count if the same user filed multiple flags on
		// the same target.  Their first flag's weight is what counts.
		if (tally.flaggers.has(f.flagger)) continue;
		tally.flaggers.add(f.flagger);
		tally.categories.add(f.category);
		if (f.category === "floor_violation") tally.hasFloor = true;
		const w = readWeight(f.flagger);
		tally.weight += w?.weight ?? 1.0; // unseen users count as floor weight
	}
	return tally;
}

function shouldCollapse(tally: Tally, thresholdWeight: number): boolean {
	if (tally.hasFloor) return true;
	return (
		tally.flaggers.size >= THRESHOLD_USERS &&
		tally.weight >= thresholdWeight
	);
}

export async function evaluateCollapses(): Promise<number> {
	const targets = listFlaggedTargets();
	let emitted = 0;
	for (const t of targets) {
		if (hasCollapse(t.target_event_id)) continue;
		const tally = tallyFlags(t.target_event_id);
		// Per-room dynamic gate.  Computed once per target so the
		// number that ends up in the collapse event matches what the
		// gate actually used.
		const thresholdWeight = thresholdWeightFor(t.room_id);
		if (!shouldCollapse(tally, thresholdWeight)) continue;

		// Make sure the bot is in the room before trying to send.
		await joinRoomIfNeeded(t.room_id);

		const categories = Array.from(tally.categories);
		const content = {
			target_event_id: t.target_event_id,
			threshold_users: THRESHOLD_USERS,
			threshold_weight: Number(thresholdWeight.toFixed(4)),
			flaggers: Array.from(tally.flaggers),
			weighted_score: Number(tally.weight.toFixed(4)),
			categories,
			timestamp: Date.now(),
			fast_track: tally.hasFloor,
		};
		const eventId = await sendBotEvent(t.room_id, {
			type: "chat.koven.collapse.v1",
			content,
		});
		if (!eventId) continue;

		insertCollapse({
			target_event_id: t.target_event_id,
			room_id: t.room_id,
			collapsed_at: content.timestamp,
			flagger_count: tally.flaggers.size,
			weighted_score: content.weighted_score,
			categories,
		});
		emitted++;
		console.log(
			`engine: collapsed ${t.target_event_id} in ${t.room_id} ` +
			`(${tally.flaggers.size} flaggers, ${content.weighted_score} weight, ` +
			`floor=${tally.hasFloor})`,
		);
	}
	return emitted;
}

// Expose the configured threshold parameters so the UI can reference
// them if it ever needs to render the algorithm explanation.
export const thresholds = {
	users: THRESHOLD_USERS,
	weightFloor: THRESHOLD_FLOOR,
	weightCeil: THRESHOLD_CEIL,
	weightPercent: THRESHOLD_PERCENT,
};

// `config` is imported only to avoid a "unused" warning if we add
// runtime-tunable thresholds later — leave the reference live.
void config;

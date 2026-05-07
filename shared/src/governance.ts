// Koven governance — type definitions for the consensus-moderation
// primitive.  These mirror the custom Matrix event types we'll use on
// the wire (`chat.koven.flag.v1`, etc.) and are also the shape the
// client/server reducers consume internally.
//
// Source-of-truth narrative for the rules these types encode:
//   ../../GOVERNANCE.md

export type UserId = string;     // Matrix user id, e.g. "@alice:eclipse.example"
export type EventId = string;    // Matrix event id, opaque
export type RoomId = string;     // Matrix room id, opaque

// ─── Flag categories ─────────────────────────────────────────────────

export type FlagCategory =
	| "off_topic"
	| "spam"
	| "harassment"
	| "misinformation"
	| "floor_violation";   // CSAM / threat / doxx — fast-tracked, see GOVERNANCE.md

export const FLAG_CATEGORY_SEVERITY: Record<FlagCategory, number> = {
	off_topic: 1,
	spam: 2,
	harassment: 3,
	misinformation: 5,
	floor_violation: 999, // sentinel — handled by the floor pipeline, not the vote engine
};

// ─── Custom Matrix event types (wire payloads) ───────────────────────

export interface FlagEvent {
	type: "chat.koven.flag.v1";
	target_event_id: EventId;
	category: FlagCategory;
	flagger: UserId;
	timestamp: number;        // server-time ms
	rationale?: string;       // optional one-line note from the flagger
}

export interface CollapseEvent {
	type: "chat.koven.collapse.v1";
	target_event_id: EventId;
	threshold_users: number;
	threshold_weight: number;
	flaggers: UserId[];       // distinct flaggers at the moment of collapse
	weighted_score: number;   // sum of weights at collapse
	categories: FlagCategory[];
	timestamp: number;
}

export interface AppealEvent {
	type: "chat.koven.appeal.v1";
	target_event_id: EventId;
	appellant: UserId;
	rationale: string;        // required for appeals
	timestamp: number;
}

export interface CensureEvent {
	type: "chat.koven.censure.v1";
	target_user: UserId;
	points: number;
	source_collapse: EventId; // the collapse event that contributed
	timestamp: number;
	expires_at: number;       // 30 days out by default; tunable per channel
}

// Floor-violation events are produced by the auto-classifier, not by
// users.  They're recorded here so the public mod log includes them,
// but they don't go through the vote engine.
export interface FloorActionEvent {
	type: "chat.koven.floor.v1";
	target_event_id: EventId;
	classifier: "csam" | "threat" | "doxx";
	confidence: number;       // 0..1
	timestamp: number;
	review_due_by: number;    // 72h human review deadline
}

export type GovernanceEvent =
	| FlagEvent
	| CollapseEvent
	| AppealEvent
	| CensureEvent
	| FloorActionEvent;

// ─── Server-computed user state ──────────────────────────────────────

export type CensureLevel =
	| "normal"
	| "slow_mode"          // 1 message / 10s
	| "off_default_feed"   // visible only to opt-in viewers
	| "read_only";         // cannot post

export interface UserCensureState {
	user: UserId;
	points_30d: number;          // rolling sum
	level: CensureLevel;
	level_expires_at: number;    // automatic decay timestamp
	weight: number;              // 1.0..5.0 (see GOVERNANCE.md formula)
}

// ─── Channel-level tunables ──────────────────────────────────────────

export interface ChannelGovernanceConfig {
	room_id: RoomId;
	threshold_pct: number;       // default 0.05; range [0.01, 0.20]
	threshold_floor: number;     // default 3 distinct flaggers minimum
	decay_window_days: number;   // default 30; range [7, 90]
	enabled_categories: FlagCategory[];
}

// Helper: compute the dynamic threshold for a given channel size.
//
// Mirror this exactly in the server-side engine — drift here means
// drift in what the UI predicts vs. what actually happens, which is
// the worst kind of bug for a transparency-critical system.
export function computeThreshold(
	cfg: ChannelGovernanceConfig,
	active_users_last_hour: number,
): { users: number; weight: number } {
	const users = Math.max(
		cfg.threshold_floor,
		Math.ceil(cfg.threshold_pct * active_users_last_hour),
	);
	// Weight threshold = same as user count, in baseline-equivalents.
	return { users, weight: users * 1.0 };
}

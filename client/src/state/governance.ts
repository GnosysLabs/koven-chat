// Governance state — the client-side mirror of the consensus moderation
// engine.  Keyed by message id, tracks the flag/collapse/appeal lifecycle
// for every visible message + the per-user censure rollup.
//
// The reducer is intentionally separate from the chat store: chat
// messages flow on the m.room.message channel, governance events flow
// on the chat.koven.* custom event channels, and they're computed
// independently so a bug in one can't corrupt the other.

import type {
	GovernanceEvent,
	FlagEvent,
	CollapseEvent,
	AppealEvent,
	CensureEvent,
	FloorActionEvent,
	UserCensureState,
	EventId,
	UserId,
	FlagCategory,
} from "@koven/shared";

// ─── Per-message state ───────────────────────────────────────────────

export interface MessageGovernance {
	flags: FlagEvent[];
	collapse: CollapseEvent | null;
	appeal: AppealEvent | null;
	floor: FloorActionEvent | null;
	// Convenience: the set of distinct flagger user ids and the latest
	// weighted score we've heard from the server.  Both can be derived
	// from `flags` but caching them speeds up the row render.
	distinctFlaggers: Set<UserId>;
	weightedScore: number;
}

export const emptyMessageGovernance = (): MessageGovernance => ({
	flags: [],
	collapse: null,
	appeal: null,
	floor: null,
	distinctFlaggers: new Set(),
	weightedScore: 0,
});

// ─── Top-level state ─────────────────────────────────────────────────

export interface GovernanceState {
	// Per-message governance, keyed by Matrix event id of the target.
	byMessage: Map<EventId, MessageGovernance>;
	// Per-user censure rollup, keyed by Matrix user id.
	byUser: Map<UserId, UserCensureState>;
	// Append-only chronological log feeding the public ModLog component.
	// Newest first.  Trimmed to the last N entries client-side; full
	// history is queryable from the server.
	log: GovernanceEvent[];
}

export const initialGovernanceState: GovernanceState = {
	byMessage: new Map(),
	byUser: new Map(),
	log: [],
};

const MAX_LOG_ENTRIES = 5000;

// ─── Reducer ─────────────────────────────────────────────────────────

export function reduceGovernance(
	state: GovernanceState,
	event: GovernanceEvent,
	weightLookup: (user: UserId) => number,
): GovernanceState {
	const log = [event, ...state.log].slice(0, MAX_LOG_ENTRIES);

	switch (event.type) {
		case "chat.koven.flag.v1":
			return { ...state, byMessage: applyFlag(state.byMessage, event, weightLookup), log };
		case "chat.koven.collapse.v1":
			return { ...state, byMessage: applyCollapse(state.byMessage, event), log };
		case "chat.koven.appeal.v1":
			return { ...state, byMessage: applyAppeal(state.byMessage, event), log };
		case "chat.koven.censure.v1":
			return { ...state, byUser: applyCensure(state.byUser, event), log };
		case "chat.koven.floor.v1":
			return { ...state, byMessage: applyFloor(state.byMessage, event), log };
	}
}

function applyFlag(
	byMessage: Map<EventId, MessageGovernance>,
	event: FlagEvent,
	weightLookup: (user: UserId) => number,
): Map<EventId, MessageGovernance> {
	const next = new Map(byMessage);
	const existing = next.get(event.target_event_id) ?? emptyMessageGovernance();
	// Idempotent — replaying the same flag (e.g. on re-sync) doesn't
	// double-count.  Distinct flaggers is the source of truth.
	if (existing.distinctFlaggers.has(event.flagger)) return byMessage;
	const distinctFlaggers = new Set(existing.distinctFlaggers);
	distinctFlaggers.add(event.flagger);
	next.set(event.target_event_id, {
		...existing,
		flags: [...existing.flags, event],
		distinctFlaggers,
		weightedScore: existing.weightedScore + weightLookup(event.flagger),
	});
	return next;
}

function applyCollapse(
	byMessage: Map<EventId, MessageGovernance>,
	event: CollapseEvent,
): Map<EventId, MessageGovernance> {
	const next = new Map(byMessage);
	const existing = next.get(event.target_event_id) ?? emptyMessageGovernance();
	next.set(event.target_event_id, { ...existing, collapse: event });
	return next;
}

function applyAppeal(
	byMessage: Map<EventId, MessageGovernance>,
	event: AppealEvent,
): Map<EventId, MessageGovernance> {
	const next = new Map(byMessage);
	const existing = next.get(event.target_event_id) ?? emptyMessageGovernance();
	next.set(event.target_event_id, { ...existing, appeal: event });
	return next;
}

function applyFloor(
	byMessage: Map<EventId, MessageGovernance>,
	event: FloorActionEvent,
): Map<EventId, MessageGovernance> {
	const next = new Map(byMessage);
	const existing = next.get(event.target_event_id) ?? emptyMessageGovernance();
	next.set(event.target_event_id, { ...existing, floor: event });
	return next;
}

function applyCensure(
	byUser: Map<UserId, UserCensureState>,
	event: CensureEvent,
): Map<UserId, UserCensureState> {
	const next = new Map(byUser);
	const prev = next.get(event.target_user) ?? {
		user: event.target_user,
		points_30d: 0,
		level: "normal" as const,
		level_expires_at: 0,
		weight: 1.0,
	};
	const points = prev.points_30d + event.points;
	next.set(event.target_user, {
		...prev,
		points_30d: points,
		level: levelFor(points),
		// Decay window from this censure event — server is the source of
		// truth, but the client prediction matches the formula in
		// GOVERNANCE.md so the UI doesn't disagree.
		level_expires_at: event.expires_at,
	});
	return next;
}

// Mirror of the table in GOVERNANCE.md.  Edits here must be matched
// in the server engine and the docs — drift is the worst kind of bug.
export function levelFor(points: number): UserCensureState["level"] {
	if (points >= 50) return "read_only";
	if (points >= 25) return "off_default_feed";
	if (points >= 10) return "slow_mode";
	return "normal";
}

// ─── Selectors ───────────────────────────────────────────────────────

export function isMessageCollapsed(g: GovernanceState, eventId: EventId): boolean {
	return Boolean(g.byMessage.get(eventId)?.collapse);
}

export function isMessageFloorRemoved(g: GovernanceState, eventId: EventId): boolean {
	return Boolean(g.byMessage.get(eventId)?.floor);
}

export function flagCountFor(g: GovernanceState, eventId: EventId): number {
	return g.byMessage.get(eventId)?.distinctFlaggers.size ?? 0;
}

export function flagsByCategoryFor(
	g: GovernanceState,
	eventId: EventId,
): Map<FlagCategory, number> {
	const flags = g.byMessage.get(eventId)?.flags ?? [];
	const counts = new Map<FlagCategory, number>();
	for (const flag of flags) {
		counts.set(flag.category, (counts.get(flag.category) ?? 0) + 1);
	}
	return counts;
}

export function userLevel(g: GovernanceState, user: UserId): UserCensureState["level"] {
	return g.byUser.get(user)?.level ?? "normal";
}

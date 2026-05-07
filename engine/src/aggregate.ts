// Translate raw Matrix events out of an /transactions push into the
// rows our reputation calculation cares about.  Anything we don't
// recognize is silently ignored — appservices receive every event
// type the homeserver knows about, including invites, presence, etc.

import {
	createSuspension,
	deletePost,
	deleteReaction,
	findPendingSuspensionByFlag,
	getActiveSuspension,
	insertFlag,
	insertPost,
	insertReaction,
	lookupPostUser,
	markFlagRetracted,
	recordRoomCreation,
	updateSuspensionStatus,
} from "./db";

// Minimal shape of a Matrix client-server event coming through
// /transactions.  We only assert on fields we actually read.
export interface MatrixEvent {
	type: string;
	event_id: string;
	sender: string;
	room_id: string;
	origin_server_ts: number;
	state_key?: string;
	redacts?: string;
	content?: Record<string, unknown> & {
		body?: string;
		msgtype?: string;
		"m.relates_to"?: {
			rel_type?: string;
			event_id?: string;
			key?: string;
		};
	};
}

export function applyEvent(ev: MatrixEvent): void {
	switch (ev.type) {
		case "m.room.message":
			handleMessage(ev);
			return;
		case "m.reaction":
			handleReaction(ev);
			return;
		case "chat.koven.flag.v1":
			handleFlag(ev);
			return;
		case "m.room.redaction":
			handleRedaction(ev);
			return;
		case "m.room.create":
			handleRoomCreate(ev);
			return;
	}
}

function handleRoomCreate(ev: MatrixEvent): void {
	// m.room.create is a state event with state_key="" and the creator
	// is the sender.  We use this to populate the room_creations log
	// the rate-limit gate consults — fires once per room, idempotent
	// via INSERT OR IGNORE.  Visibility comes from the create event
	// content's "preset" or via the room's directory listing later
	// (we don't have it in scope here); default to 'unknown' and
	// upstream callers can refine if needed.
	if (ev.state_key === undefined) return;
	recordRoomCreation({
		room_id: ev.room_id,
		creator_id: ev.sender,
		created_at: ev.origin_server_ts,
	});
}

function handleFlag(ev: MatrixEvent): void {
	const c = ev.content as any;
	const target = c?.target_event_id as string | undefined;
	const category = c?.category as string | undefined;
	if (!target || !category) return;
	insertFlag({
		event_id: ev.event_id,
		target_event_id: target,
		room_id: ev.room_id,
		flagger: ev.sender,
		category,
		rationale: typeof c?.rationale === "string" ? (c.rationale as string) : undefined,
		ts: ev.origin_server_ts,
	});

	// Floor-violation flags suspend the target's account immediately,
	// pending admin review.  We need the target message's author to
	// know who to suspend; lookupPostUser hits the posts index, which
	// covers any non-encrypted message the engine has seen.  Encrypted
	// rooms (DMs) won't have the message indexed, so floor-flagging
	// inside an encrypted DM falls through silently — that's the right
	// outcome since the engine couldn't moderate that room anyway.
	if (category === "floor_violation") {
		const targetUser = lookupPostUser(target);
		if (!targetUser) return;
		// One pending/confirmed suspension at a time per user.  If they
		// already have one open, the new flag is captured in the flags
		// table but doesn't create a duplicate suspension row.
		if (getActiveSuspension(targetUser)) return;
		createSuspension({
			user_id: targetUser,
			reason: "floor_violation",
			flag_event_id: ev.event_id,
			target_event_id: target,
			target_room_id: ev.room_id,
			flagger: ev.sender,
		});
	}
}

function handleMessage(ev: MatrixEvent): void {
	// State events have a state_key — skip those.  Real chat messages
	// don't.
	if (ev.state_key !== undefined) return;
	insertPost({
		event_id: ev.event_id,
		user_id: ev.sender,
		room_id: ev.room_id,
		ts: ev.origin_server_ts,
	});
}

function handleReaction(ev: MatrixEvent): void {
	const rel = ev.content?.["m.relates_to"];
	if (!rel || rel.rel_type !== "m.annotation" || !rel.event_id || !rel.key) return;

	// Only credit the reaction if it targets a post we know about.
	// This filters out reactions on events we never indexed (engine
	// bot's own state events, etc.) and gives us the author of the
	// reacted-to post for the rollup.
	const targetUserId = lookupPostUser(rel.event_id);
	if (!targetUserId) return;

	// Don't credit self-reactions toward your own reputation.  Matrix
	// allows it, but it would obviously be game-able.
	if (targetUserId === ev.sender) return;

	insertReaction({
		event_id: ev.event_id,
		target_user_id: targetUserId,
		reactor_id: ev.sender,
		target_event_id: rel.event_id,
		key: rel.key,
		ts: ev.origin_server_ts,
	});
}

function handleRedaction(ev: MatrixEvent): void {
	// Matrix encodes the target as `redacts` at the top level (v1) or
	// in content (v3+).  Try both.
	const target =
		ev.redacts ??
		(typeof ev.content?.["redacts"] === "string"
			? (ev.content["redacts"] as string)
			: undefined);
	if (!target) return;
	// The redacted event might have been a post, reaction, or flag.
	// IDs are unique so at most one of these matches.  Posts and
	// reactions are timeline content — when redacted, the message
	// itself is gone from rooms so we can drop the row outright.
	// Flags are the public moderation record; retracting a flag is a
	// real governance event, so we mark the row retracted (rather
	// than delete it) so the mod log can show both the original flag
	// and the retraction in chronological order.
	deletePost(target);
	deleteReaction(target);
	const wasFlag = markFlagRetracted(target, ev.origin_server_ts, ev.sender);

	// Floor-violation cascade: if this flag was the one that opened a
	// pending suspension, auto-reverse the suspension now.  The
	// flagger withdrew the accusation, so it's incoherent to keep
	// the target paused waiting on admin review of an accusation
	// that no longer exists.  We use a sentinel reviewer string
	// (not a mxid) so the admin queue can render this as system-
	// initiated rather than as some user's review action — same
	// pattern as `purgeUserState` which uses "self_deactivate".
	// Confirmed suspensions stay confirmed: once an admin signed
	// off, retracting the flag doesn't undo that decision.
	if (wasFlag) {
		const pending = findPendingSuspensionByFlag(target);
		if (pending) {
			updateSuspensionStatus(
				pending.id,
				"reversed",
				"self_retracted",
				"auto-reversed: originating flag was retracted",
			);
		}
	}
}

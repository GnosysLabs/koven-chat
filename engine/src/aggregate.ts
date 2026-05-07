// Translate raw Matrix events out of an /transactions push into the
// rows our reputation calculation cares about.  Anything we don't
// recognize is silently ignored — appservices receive every event
// type the homeserver knows about, including invites, presence, etc.

import {
	createSuspension,
	deleteFlag,
	deletePost,
	deleteReaction,
	getActiveSuspension,
	insertFlag,
	insertPost,
	insertReaction,
	lookupPostUser,
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
	}
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
	// The redacted event might have been a post, reaction, or flag —
	// we don't know which, so blow away all three.  IDs are unique so
	// at most one row exists across the tables.
	deletePost(target);
	deleteReaction(target);
	deleteFlag(target);
}

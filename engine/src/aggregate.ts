// Translate raw Matrix events out of an /transactions push into the
// rows our reputation calculation cares about.  Anything we don't
// recognize is silently ignored — appservices receive every event
// type the homeserver knows about, including invites, presence, etc.

import {
	claimFounderNumber,
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
	markRoomAsDm,
	recordRoomCreation,
	updateSuspensionStatus,
	upsertRoomMember,
} from "./db";
import { fanOutMember, fanOutMessage } from "./notification-fanout";
import { config } from "./config";

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
		// HTML-formatted body — set by clients alongside `body` when
		// the message has rich formatting (mentions, bold, links).
		// Notification fan-out reads this to extract MXIDs from
		// matrix.to mention links.
		formatted_body?: string;
		// Matrix 1.7+ intentional mentions.  Authoritative when
		// present; fan-out's mention detection prefers it over
		// formatted_body / plaintext heuristics.
		"m.mentions"?: { user_ids?: string[] };
		// m.room.member's membership state.  Updated on every
		// member-event we see; populates the room_members index
		// the notification fan-out + DM detection rely on.
		membership?: string;
		// `is_direct: true` on a member-event with membership
		// `invite` flags the invite as a DM (Matrix clients set
		// this when starting a 1:1 conversation).  Notification
		// fan-out reads it to label the row as kind=dm rather
		// than kind=invite — the latter reads as "you joined a
		// community", which is wrong for DM rooms.
		is_direct?: boolean;
		"m.relates_to"?: {
			rel_type?: string;
			event_id?: string;
			key?: string;
			// Reply relation (Matrix 1.4+ formal name).  Notification
			// fan-out reads this to detect reply-to-me events.
			"m.in_reply_to"?: { event_id?: string };
		};
	};
}

export function applyEvent(ev: MatrixEvent): void {
	switch (ev.type) {
		case "m.room.message":
			handleMessage(ev);
			return;
		case "m.room.encrypted":
			// Encrypted messages: we can't read the body but we can
			// still detect DMs (member count) and fan out a `dm`
			// notification with a placeholder snippet.  Mention /
			// reply detection is impossible without decryption, so
			// fanOutMessage handles those silently.  No insertPost
			// because the engine has no plaintext body to index for
			// reply-target lookup later.
			//
			// Fire-and-forget — fanOutMessage is async (may lazy-
			// backfill room_members from Synapse on first contact
			// with a room), but we don't want to hold up the
			// appservice transaction response on a member-list
			// round-trip.
			void fanOutMessage(ev).catch(err => {
				console.warn("fan-out (encrypted): failed", err);
			});
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
		case "m.room.member":
			handleMember(ev);
			return;
	}
}

// ─── Membership tracking ─────────────────────────────────────────────
//
// m.room.member is a state event keyed on the user the membership
// applies to (`state_key`).  We mirror it into `room_members` so the
// notification fan-out can answer "who's in this room right now?"
// without a Synapse round-trip per message event.  Also fans out an
// invite notification when membership transitions to `invite`.
function handleMember(ev: MatrixEvent): void {
	if (ev.state_key === undefined) return; // not a state event (shouldn't happen)
	const membership = ev.content?.membership;
	if (typeof membership !== "string") return;
	upsertRoomMember({
		roomId: ev.room_id,
		userId: ev.state_key,
		membership,
		ts: ev.origin_server_ts,
	});
	// Clients flag DM-flavoured invites with `is_direct: true` on the
	// invite event's content.  Persist the room-level marker so the
	// notification fan-out can tell DMs apart from 2-person private
	// rooms — both have memberCount === 2 but only DMs should fire
	// kind=dm on plain messages.  Idempotent at the DB layer.
	const c = ev.content as { is_direct?: unknown } | undefined;
	if (c?.is_direct === true) {
		markRoomAsDm(ev.room_id);
	}
	fanOutMember(ev);

	// Founder auto-claim safety net.  The signup hook in server.ts
	// claims a slot for everyone who registered through the engine's
	// email-code flow, and the boot backfill catches everyone who
	// was already on Synapse before this feature shipped.  This
	// handler catches the third case: users created directly on
	// Synapse (admin-created accounts, future SSO providers, etc.)
	// who never touched the engine signup path.  Their first
	// observable activity is always an `m.room.member` join, so
	// claiming on `join` membership transitions guarantees we
	// eventually see them.  No-op on retries — claimFounderNumber
	// is idempotent on the user_id PK.  Filter mirrors the boot
	// backfill exclusions: bots, engine appservice user, and the
	// admin service accounts.  We can't see the `admin: true` flag
	// from inside an appservice transaction (that field only appears
	// on the admin API), so admins get filtered by mxid here — the
	// boot backfill is the reliable path for them anyway.
	if (membership === "join") {
		const sk = ev.state_key;
		const colon = sk.indexOf(":");
		const localpart = sk.startsWith("@") && colon > 1 ? sk.slice(1, colon) : "";
		const isExcluded = localpart.startsWith("bot-")
			|| sk === config.engineUserId
			|| (config.synapseAdminUser && localpart === config.synapseAdminUser);
		if (!isExcluded) {
			try {
				claimFounderNumber(sk);
			} catch (err) {
				console.warn(`engine: founder auto-claim for ${sk} threw`, err);
			}
		}
	}
}

function handleRoomCreate(ev: MatrixEvent): void {
	// m.room.create is a state event with state_key="" and the creator
	// is the sender.  We use this to populate the room_creations log
	// the rate-limit gate consults — fires once per room, idempotent
	// via INSERT OR IGNORE.
	//
	// `kind` discriminates regular rooms from Matrix spaces (which
	// carry `content.type === "m.space"`).  Both ladder through the
	// same per-tier daily caps but the counters are independent —
	// creating a server doesn't burn through your channel quota and
	// vice versa.  See engine/src/db.ts countRoomCreationsByUser for
	// the per-kind counter and server.ts /api/internal/can-publish-
	// room for the gate that consults both.
	if (ev.state_key === undefined) return;
	const content = ev.content as { type?: unknown } | undefined;
	const kind: "room" | "space" = content?.type === "m.space" ? "space" : "room";
	recordRoomCreation({
		room_id: ev.room_id,
		creator_id: ev.sender,
		created_at: ev.origin_server_ts,
		kind,
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
	// Notification fan-out — emits one `notifications` row per
	// recipient that should see this in their bell.  See
	// notification-fanout.ts for the kind-priority logic + encrypted-
	// room handling.  Idempotent at the DB layer (UNIQUE on
	// user_id+event_id) so re-delivery doesn't double-emit.
	//
	// Fire-and-forget — fanOutMessage may lazy-backfill room_members
	// from Synapse on first contact with a room, and we don't want
	// the appservice transaction response held up on that round-trip.
	void fanOutMessage(ev).catch(err => {
		console.warn("fan-out: failed", err);
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

// Notification fan-out for the in-app bell.
//
// Called from aggregate.ts as the engine processes the appservice
// transaction stream.  For each event that COULD trigger a
// notification (m.room.message, m.room.member with invite), this
// module:
//
//   1. Resolves potential recipients (joined members of the room,
//      minus the sender and minus bot/engine users).
//   2. Computes per-recipient `kind` based on priority order:
//        invite > dm > mention > reply > system
//   3. Builds a snippet (first 200 chars of body, or placeholder
//      for encrypted messages where the engine can't read content).
//   4. Writes one row per recipient via insertNotification, which
//      is idempotent at the DB layer (UNIQUE(user_id, event_id)).
//
// Encrypted rooms: we get m.room.encrypted events with no readable
// body, only ciphertext.  We can still detect DMs (by member count,
// from m.room.member tracking in `room_members`) and emit a `dm`
// notification with a placeholder snippet.  Mention + reply
// detection require reading the body, so they're skipped silently
// in encrypted rooms — same as Element / SchildiChat / any other
// Matrix client that respects e2ee.

import type { MatrixEvent } from "./aggregate";
import { config } from "./config";
import {
	insertNotification,
	isRoomDm,
	joinedMemberCount,
	listJoinedRoomMembers,
	lookupPostUser,
	upsertRoomMember,
} from "./db";
import { getJoinedMembers } from "./synapse";

// Snippet character cap.  200 keeps the bell list compact while
// still showing enough preview to recognize the conversation.
const SNIPPET_MAX = 200;

// Encrypted message bodies are unreadable to the engine.  Rather
// than ship "(encrypted message)" as a snippet, we leave it null —
// the bell row's kind label ("sent you a DM" / "mentioned you" /
// etc.) already communicates what happened, and a literal
// "(encrypted message)" preview is just visual noise that's
// identical across every encrypted event.

/** Bot users live in the @bot-* appservice namespace; the engine
 * itself is `@${sender_localpart}:${homeserver_name}`.  Neither
 * should receive bell notifications — bots aren't humans, and the
 * engine doesn't have a UI surface to read them. */
function isBotOrEngineUser(mxid: string): boolean {
	if (mxid === config.engineUserId) return true;
	// MXID format: @localpart:server.  Bot namespace is bot-*.
	const at = mxid.indexOf("@");
	const colon = mxid.indexOf(":");
	if (at !== 0 || colon < 2) return false;
	const localpart = mxid.slice(1, colon);
	return localpart.startsWith("bot-");
}

/** Pull the localpart out of a full MXID.  Returns the localpart
 * including the leading `@`, matching how plaintext mentions look in
 * Matrix message bodies (the @-mention picker emits "@alice", not
 * just "alice"). */
function localpartOf(mxid: string): string {
	const colon = mxid.indexOf(":");
	if (colon < 2) return mxid; // malformed; treat opaque
	return mxid.slice(0, colon); // "@alice"
}

/** Escape a string for safe insertion into a regex literal. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve the set of MXIDs a message's text mentions.  Three
 * sources, in priority order — first hit wins per recipient:
 *
 *   1. `content.m.mentions.user_ids` (Matrix 1.7+ intentional
 *      mentions).  Authoritative when present — clients that
 *      support it set this field exactly when the user used the
 *      @-mention picker.
 *   2. `formatted_body` (HTML) <a href="https://matrix.to/#/@user:server">.
 *      Set by Element / FluffyChat / most other clients on the
 *      formatted side.  We extract MXIDs from matrix.to URIs.
 *   3. Plaintext `body` scan: for each room member, look for
 *      `(^|\W)@<localpart>(\W|$)`.  Last-ditch fallback for clients
 *      that emit only the legacy plaintext mention syntax.  Limited
 *      to room members so a stray "@alice" doesn't notify some
 *      unrelated alice.
 *
 * Returns a Set so the caller can dedupe across detection paths. */
function extractMentionTargets(
	ev: MatrixEvent,
	roomMembers: string[],
): Set<string> {
	const targets = new Set<string>();
	const content = (ev.content ?? {}) as Record<string, unknown>;

	// 1. m.mentions.user_ids
	const mentions = content["m.mentions"] as { user_ids?: unknown } | undefined;
	if (mentions && Array.isArray(mentions.user_ids)) {
		for (const u of mentions.user_ids) {
			if (typeof u === "string") targets.add(u);
		}
	}

	// 2. formatted_body matrix.to links
	const formatted = content["formatted_body"];
	if (typeof formatted === "string" && formatted.includes("matrix.to/#/")) {
		// matrix.to URIs that target users start with @.  The hash
		// fragment is URL-encoded in some clients (%40 = @, %3A = :)
		// and raw in others; handle both.
		const matched = formatted.match(/matrix\.to\/#\/(@|%40)[^"'\s<>]+/gi) ?? [];
		for (const m of matched) {
			// Strip the prefix, decode, validate shape.
			const hashPart = m.replace(/^.*matrix\.to\/#\//i, "");
			let mxid: string;
			try {
				mxid = decodeURIComponent(hashPart);
			} catch {
				continue;
			}
			if (mxid.startsWith("@") && mxid.includes(":")) {
				targets.add(mxid);
			}
		}
	}

	// 3. Plaintext @localpart fallback — only matches against actual
	//    room members so we don't accidentally notify users in some
	//    unrelated room with the same localpart.
	const body = typeof content["body"] === "string" ? (content["body"] as string) : "";
	if (body.length > 0 && roomMembers.length > 0) {
		for (const memberMxid of roomMembers) {
			if (targets.has(memberMxid)) continue; // already detected by 1 or 2
			const lp = localpartOf(memberMxid);
			if (lp.length < 2) continue; // no usable localpart
			const re = new RegExp(`(^|\\W)${escapeRegex(lp)}(\\W|$)`);
			if (re.test(body)) targets.add(memberMxid);
		}
	}

	return targets;
}

/** Get the in-reply-to target's author from the engine's posts
 * index, or null if we don't recognise the target.  Replies to
 * messages the engine never indexed (events from before deploy,
 * encrypted-room messages, etc.) silently produce no reply
 * notification — same graceful degrade as the rest of this module. */
function extractReplyTarget(ev: MatrixEvent): string | null {
	const rel = ev.content?.["m.relates_to"];
	const inReplyToId = (rel as { "m.in_reply_to"?: { event_id?: unknown } } | undefined)
		?.["m.in_reply_to"]?.event_id;
	if (typeof inReplyToId !== "string") return null;
	return lookupPostUser(inReplyToId);
}

/** Build the snippet shown in the bell list.  For text messages we
 * take the first SNIPPET_MAX characters of the body.  For replies
 * we strip the "> <@user> quote" fallback prefix Matrix clients
 * insert for non-reply-aware clients to render context, then
 * truncate.  Non-text msgtypes (m.image, m.file) get a typed
 * placeholder.  Encrypted messages (no body) get the encrypted
 * placeholder. */
function buildSnippet(ev: MatrixEvent): string | null {
	// Encrypted: no snippet.  Bell row hides the snippet line when
	// it's null/empty; the kind label is enough.
	if (ev.type === "m.room.encrypted") return null;
	const c = ev.content as Record<string, unknown> | undefined;
	const msgtype = typeof c?.msgtype === "string" ? (c.msgtype as string) : "";
	const body = typeof c?.body === "string" ? (c.body as string) : "";

	// Strip Matrix reply fallback ("> <@user> quoted text\n\nactual reply")
	// — match the literal prefix scheme, not the cleaner formatted
	// reply structure (which lives in formatted_body).
	let stripped = body;
	if (body.startsWith("> ")) {
		const blank = body.indexOf("\n\n");
		if (blank >= 0) stripped = body.slice(blank + 2);
	}

	if (msgtype === "m.text" || msgtype === "m.notice" || msgtype === "m.emote") {
		return stripped.slice(0, SNIPPET_MAX) || null;
	}
	if (msgtype === "m.image") return "(image)";
	if (msgtype === "m.video") return "(video)";
	if (msgtype === "m.audio") return "(audio)";
	if (msgtype === "m.file") return "(file)";
	// Unknown / no body — leave snippet empty rather than ship a
	// useless placeholder.
	if (!body) return null;
	return stripped.slice(0, SNIPPET_MAX);
}

/** Compute notifications for an m.room.message (or m.room.encrypted)
 * event and write rows for every recipient that should see it.
 *
 * `async` because we may need to lazily backfill room_members from
 * Synapse on first contact with a room — see comment around the
 * empty-list branch below.  Caller in aggregate.ts is fire-and-
 * forget (`void fanOutMessage(ev)`) so the appservice transaction
 * response isn't held up by member-list round-trips. */
export async function fanOutMessage(ev: MatrixEvent): Promise<void> {
	// State events shouldn't reach here, but defend anyway.
	if (ev.state_key !== undefined) return;

	const isEncrypted = ev.type === "m.room.encrypted";
	console.log(`[fanout] ev=${ev.event_id} room=${ev.room_id} sender=${ev.sender} type=${ev.type} encrypted=${isEncrypted}`);

	let members = listJoinedRoomMembers(ev.room_id);
	// Self-healing backfill: triggers when the cache is empty (no
	// m.room.member events seen yet for this room) OR when it's
	// clearly stale (the message sender isn't in it, but they must
	// be in the room to have just sent a message there).  The stale
	// case used to slip through silently — once `room_members` had
	// even one row for a room, the empty-cache check stopped firing
	// even though the row count was way below the actual member
	// count, leading to "DM-flavoured" notifications being written
	// to wrong recipients in actually-large rooms.  Refresh against
	// Synapse's admin /members and upsert the live list whenever
	// either condition is true.
	const cacheLooksStale = !members.includes(ev.sender);
	console.log(`[fanout] cached members for ${ev.room_id}: ${members.length} stale=${cacheLooksStale}`);
	if (members.length === 0 || cacheLooksStale) {
		try {
			const live = await getJoinedMembers(ev.room_id);
			console.log(`[fanout] backfill via admin API for ${ev.room_id} → ${live.length} members`);
			if (live.length > 0) {
				const ts = ev.origin_server_ts;
				for (const u of live) {
					upsertRoomMember({ roomId: ev.room_id, userId: u, membership: "join", ts });
				}
				members = live;
			}
		} catch (err) {
			console.warn(`[fanout] backfill of ${ev.room_id} members failed`, err);
		}
		if (members.length === 0) {
			console.log(`[fanout] no members after backfill for ${ev.room_id} — bailing`);
			return;
		}
	}

	const memberCount = members.length;
	// Authoritative DM flag — set when ANY m.room.member event for
	// this room arrived with content.is_direct=true (clients write
	// that flag when they create a 1:1 conversation room).  Replaces
	// the old "memberCount === 2" heuristic, which mis-labelled
	// 2-person private rooms as DMs and fired kind=dm bells on every
	// regular message.
	const isDm = isRoomDm(ev.room_id);

	// Mentions + reply target only resolvable on plaintext events.
	const mentioned = isEncrypted ? new Set<string>() : extractMentionTargets(ev, members);
	const replyTargetId = isEncrypted ? null : extractReplyTarget(ev);

	const snippet = buildSnippet(ev);

	let written = 0;
	console.log(`[fanout] room=${ev.room_id} memberCount=${memberCount} isDm=${isDm} mentioned=${[...mentioned]} replyTarget=${replyTargetId}`);
	for (const recipient of members) {
		// Don't notify the sender about their own message.
		if (recipient === ev.sender) continue;
		// Don't notify bot or engine users.
		if (isBotOrEngineUser(recipient)) continue;

		// Pick the kind: priority order mention > reply > dm >
		// (fall-through, no notification).  Explicit signals win —
		// a 2-person private room is `memberCount === 2` so the DM
		// fallback catches it, but if the message also @-mentions
		// or replies-to the recipient, that's the more accurate
		// label and shouldn't get masked by the implicit DM heuristic.
		// Invite is handled in fanOutMember; system events come from
		// other pathways.
		let kind: "dm" | "mention" | "reply" | null = null;
		if (mentioned.has(recipient)) kind = "mention";
		else if (replyTargetId === recipient) kind = "reply";
		else if (isDm) kind = "dm";

		if (kind === null) {
			console.log(`[fanout] skip ${recipient}: not DM, not mentioned, not reply target`);
			continue;
		}

		console.log(`[fanout] write notification: recipient=${recipient} kind=${kind}`);
		insertNotification({
			userId: recipient,
			eventId: ev.event_id,
			roomId: ev.room_id,
			kind,
			sender: ev.sender,
			snippet,
			createdAt: ev.origin_server_ts,
		});
		written++;
	}
	console.log(`[fanout] ev=${ev.event_id} done: wrote ${written} notifications`);
}

/** Compute notification for an m.room.member event with
 * membership=invite.  Single-recipient (the invited user); other
 * memberships (join/leave/ban/etc.) update the room_members table
 * but don't ring any bells.
 *
 * Distinguishes DM invites from regular room invites via
 * `content.is_direct` — Matrix clients set this flag when they
 * create a 1:1 conversation room and invite the other party.  A DM
 * invite isn't really a "you've been invited to a community"
 * situation; it's "someone started a chat with you," which is the
 * same intent signal as a DM message.  Labelling it kind=dm avoids
 * the "alice invited you in alice" wording (DM rooms are typically
 * named after the other participant — without this fix the bell
 * would show that exact mess). */
export function fanOutMember(ev: MatrixEvent): void {
	if (ev.state_key === undefined) return; // m.room.member always has a state_key
	const content = ev.content as { membership?: unknown; is_direct?: unknown } | undefined;
	const membership = content?.membership;
	if (membership !== "invite") return;
	if (isBotOrEngineUser(ev.state_key)) return; // don't notify bots / engine
	if (ev.state_key === ev.sender) return; // self-invite (rare; defensive)

	const isDirect = content?.is_direct === true;

	insertNotification({
		userId: ev.state_key,
		eventId: ev.event_id,
		roomId: ev.room_id,
		kind: isDirect ? "dm" : "invite",
		sender: ev.sender,
		// Snippet is null for both flavours — the client renders
		// sender / room name it knows about live.  An engine-side
		// room name lookup would be a per-event Synapse round-trip
		// and the client already has it from /sync.
		snippet: null,
		createdAt: ev.origin_server_ts,
	});
}

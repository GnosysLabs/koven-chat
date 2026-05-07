// SQLite schema for the engine.  Stores the raw observations the
// reputation calculation needs — message posts and incoming reactions
// — keyed so we can window them by recency.
//
// Idempotency is handled at write time via INSERT OR IGNORE on the
// event_id PKs, so re-delivery of a transaction (Matrix retries until
// it gets a 200) doesn't double-count anything.
//
// Why not just compute weight from a single events table?  Because
// reactions and posts have different decay windows in the spec
// (90d vs 30d) and storing them separately makes the windowed COUNTs
// trivial.

import { Database } from "bun:sqlite";
import { config } from "./config";

export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");

// Migration — run unconditionally on boot, statements are idempotent.
db.exec(`
	CREATE TABLE IF NOT EXISTS users (
		user_id        TEXT PRIMARY KEY,
		first_seen_ts  INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS posts (
		event_id  TEXT PRIMARY KEY,
		user_id   TEXT NOT NULL,
		room_id   TEXT NOT NULL,
		ts        INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_posts_user_ts ON posts(user_id, ts);

	-- Reactions targeting another user's post.  We dedupe by event_id
	-- (the reaction event itself) and store the target user so the
	-- per-user rollup is a single indexed scan.
	CREATE TABLE IF NOT EXISTS reactions (
		event_id        TEXT PRIMARY KEY,
		target_user_id  TEXT NOT NULL,
		reactor_id      TEXT NOT NULL,
		target_event_id TEXT NOT NULL,
		key             TEXT NOT NULL,
		ts              INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_reactions_target_ts ON reactions(target_user_id, ts);

	-- Reverse index for redactions: when an m.room.redaction strikes a
	-- reaction, we look up which row to delete by the redacted event id.
	-- Posts can be redacted too — same deal.

	-- Latest computed weight per user — replaced on each tick so the
	-- HTTP read path is a single point lookup, no recompute on read.
	CREATE TABLE IF NOT EXISTS weights (
		user_id        TEXT PRIMARY KEY,
		weight         REAL NOT NULL,
		posts_30d      INTEGER NOT NULL,
		reactions_90d  INTEGER NOT NULL,
		age_days       REAL NOT NULL,
		computed_at    INTEGER NOT NULL
	);

	-- Per-flag rows — one per chat.koven.flag.v1 event observed.
	-- Aggregated on each tick to detect collapse-threshold crossings.
	-- Append-only: when a user retracts their flag (by redacting the
	-- flag event), we mark the row with retracted_at + retracted_by
	-- rather than deleting it.  The mod log surfaces both the
	-- original flag and the retraction as distinct entries; the
	-- consensus evaluator filters retracted rows out of its tally so
	-- a withdrawn flag no longer contributes to the collapse score.
	CREATE TABLE IF NOT EXISTS flags (
		event_id        TEXT PRIMARY KEY,
		target_event_id TEXT NOT NULL,
		room_id         TEXT NOT NULL,
		flagger         TEXT NOT NULL,
		category        TEXT NOT NULL,
		rationale       TEXT,
		ts              INTEGER NOT NULL,
		retracted_at    INTEGER,             -- NULL until the flag is retracted
		retracted_by    TEXT                 -- mxid that issued the retracting redaction
	);
	CREATE INDEX IF NOT EXISTS idx_flags_target ON flags(target_event_id);

	-- Targets we've already collapsed.  Idempotency: once collapsed,
	-- we don't re-emit the collapse event even if more flags arrive.
	CREATE TABLE IF NOT EXISTS collapses (
		target_event_id TEXT PRIMARY KEY,
		room_id         TEXT NOT NULL,
		collapsed_at    INTEGER NOT NULL,
		flagger_count   INTEGER NOT NULL,
		weighted_score  REAL NOT NULL,
		categories      TEXT NOT NULL  -- JSON array of FlagCategory
	);

	-- Rooms the engine bot has joined.  Used to skip the join HTTP call
	-- on every event after first contact.
	CREATE TABLE IF NOT EXISTS joined_rooms (
		room_id   TEXT PRIMARY KEY,
		joined_at INTEGER NOT NULL
	);

	-- Per-room creation log.  Populated reactively when the engine
	-- observes m.room.create events on the appservice transaction
	-- stream — that's after the room exists, but the spam-checker
	-- hook in Synapse calls back to the engine BEFORE the create
	-- proceeds, and reads from this table to enforce rate limits.
	-- (The spam-checker can't insert here because the room id isn't
	-- known until Synapse mints it; reactive insertion via the
	-- appservice stream is good enough — the spam-checker's count
	-- includes everything from before the current attempt.)
	CREATE TABLE IF NOT EXISTS room_creations (
		room_id    TEXT PRIMARY KEY,
		creator_id TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		visibility TEXT NOT NULL DEFAULT 'unknown'  -- 'public' | 'private' | 'unknown'
	);
	CREATE INDEX IF NOT EXISTS idx_room_creations_creator_ts
		ON room_creations(creator_id, created_at);

	-- Instance admins.  First user the engine sees gets auto-promoted
	-- on bootstrap (see admins.ts).  Subsequent admins must be
	-- granted by an existing admin via the API.
	CREATE TABLE IF NOT EXISTS admins (
		user_id    TEXT PRIMARY KEY,
		granted_at INTEGER NOT NULL,
		granted_by TEXT             -- NULL when self-bootstrap
	);

	-- Instance-wide configuration as a flat key/value store.  Read
	-- publicly (login page needs it before auth), written only by
	-- admins.
	CREATE TABLE IF NOT EXISTS instance_config (
		key        TEXT PRIMARY KEY,
		value      TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		updated_by TEXT
	);

	-- User-authored bios.  Matrix's profile API has fixed fields
	-- (displayname + avatar_url) and the spec doesn't include a public
	-- bio, so we host them here — public read, owner-only write.  The
	-- DM profile panel and member-profile sheet read from this table.
	CREATE TABLE IF NOT EXISTS user_profiles (
		user_id    TEXT PRIMARY KEY,
		bio        TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);

	-- Floor-violation suspensions.  Created automatically when the
	-- engine observes a chat.koven.flag.v1 with category=floor_violation
	-- (target's account is paused pending admin review), or directly
	-- by the engine itself for a flagger who's submitted too many
	-- reversed floor flags.  Status transitions are append-only via
	-- update of one row: pending → confirmed (account deactivated via
	-- Synapse admin API) or pending → reversed (account restored, and
	-- this row becomes a "false flag" record against the flagger).
	CREATE TABLE IF NOT EXISTS suspensions (
		id              INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id         TEXT NOT NULL,             -- the suspended account
		reason          TEXT NOT NULL,             -- 'floor_violation' | 'repeated_false_floor_flags' | 'repeated_room_collapses'
		flag_event_id   TEXT,                      -- the m.room flag event that triggered this (NULL for repeat-flagger cases)
		target_event_id TEXT,                      -- the message that was floor-flagged
		target_room_id  TEXT,                      -- where it happened
		flagger         TEXT,                      -- who reported it (NULL when reason = 'repeated_false_floor_flags')
		status          TEXT NOT NULL,             -- 'pending' | 'confirmed' | 'reversed' | 'dismissed'
		created_at      INTEGER NOT NULL,
		reviewed_at     INTEGER,                   -- admin action timestamp
		reviewed_by     TEXT,                      -- admin user id who took the action
		admin_note      TEXT                       -- optional context attached at review time
	);
	CREATE INDEX IF NOT EXISTS idx_suspensions_user_status ON suspensions(user_id, status);
	CREATE INDEX IF NOT EXISTS idx_suspensions_status      ON suspensions(status);
	CREATE INDEX IF NOT EXISTS idx_suspensions_flagger     ON suspensions(flagger, status);

	-- Email-to-account binding for the email-code login flow.  One row
	-- per (email, user_id) pair.  Email is unique: an address binds to
	-- exactly one Matrix account on this homeserver.  No password is
	-- stored anywhere; the password Synapse holds is rotated to a fresh
	-- random string on every login (and on every UIA challenge) and
	-- thrown away client-side after use.
	CREATE TABLE IF NOT EXISTS user_emails (
		email        TEXT PRIMARY KEY COLLATE NOCASE,
		user_id      TEXT NOT NULL UNIQUE,
		created_at   INTEGER NOT NULL,
		last_login   INTEGER
	);

	-- One-time login codes.  We store SHA-256 of the code so a DB leak
	-- doesn't immediately expose codes; we also count attempts to gate
	-- brute force (only ~1M possible 6-digit codes).  A row is "spent"
	-- when used_at is non-null OR attempts >= MAX_ATTEMPTS — either
	-- way verifyCode rejects it.  Periodically pruned via cleanup
	-- (called on each request).
	CREATE TABLE IF NOT EXISTS auth_codes (
		id             INTEGER PRIMARY KEY AUTOINCREMENT,
		email          TEXT NOT NULL COLLATE NOCASE,
		code_hash      TEXT NOT NULL,
		expires_at     INTEGER NOT NULL,
		attempts       INTEGER NOT NULL DEFAULT 0,
		used_at        INTEGER,
		created_at     INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_auth_codes_email ON auth_codes(email, created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON auth_codes(expires_at);

	-- User-created bots.  Each row is one Matrix user (mxid lives in
	-- the @bot-* appservice namespace) plus a config blob.  Sensitive
	-- values — the LLM API key and the bot's Synapse access token —
	-- are AES-GCM encrypted at rest via secret_box.ts and stored here
	-- as base64 ciphertext.  Owner is the human Matrix user who
	-- created the bot; only the owner can edit / delete.
	CREATE TABLE IF NOT EXISTS bots (
		id                       INTEGER PRIMARY KEY AUTOINCREMENT,
		mxid                     TEXT NOT NULL UNIQUE,
		owner_id                 TEXT NOT NULL,
		display_name             TEXT NOT NULL,
		avatar_mxc               TEXT,
		-- LLM provider config.
		provider                 TEXT NOT NULL,        -- 'openrouter' | 'openai_compatible'
		api_base                 TEXT NOT NULL,
		api_key_enc              TEXT NOT NULL,        -- sealed via secret_box.ts
		model                    TEXT NOT NULL,
		system_prompt            TEXT NOT NULL DEFAULT '',
		context_window           INTEGER NOT NULL DEFAULT 20,
		-- JSON array of trigger phrases.  When any phrase in the
		-- list appears in a room message (word-boundary, case-
		-- insensitive), the bot reacts as if it had been
		-- @-mentioned.  Empty array means "only respond to
		-- explicit mentions / replies / DMs" -- same behaviour the
		-- bot platform shipped with.
		triggers                 TEXT NOT NULL DEFAULT '[]',
		-- Synapse-side credentials so the engine can act as the bot.
		access_token_enc         TEXT NOT NULL,        -- sealed via secret_box.ts
		device_id                TEXT NOT NULL,
		-- Lifecycle.
		enabled                  INTEGER NOT NULL DEFAULT 1,
		created_at               INTEGER NOT NULL,
		-- Per-bot usage counters (incremented after every LLM call).
		total_prompt_tokens      INTEGER NOT NULL DEFAULT 0,
		total_completion_tokens  INTEGER NOT NULL DEFAULT 0,
		total_calls              INTEGER NOT NULL DEFAULT 0,
		last_used_at             INTEGER
	);
	CREATE INDEX IF NOT EXISTS idx_bots_owner ON bots(owner_id);

	-- User-initiated message deletions.  Append-only audit row written
	-- whenever someone redacts a message that they sent themselves, OR
	-- redacts a bot's message because they own that bot.  Distinct from
	-- the consensus collapse pipeline:
	--
	--   * collapses records community-driven hides: a flag tally
	--     crossed the threshold, the engine emitted a public collapse
	--     event, the message stays attributed to its sender.
	--   * self_deletions records voluntary takedowns: the sender (or
	--     a bot owner) chose to redact their own content.  No flags
	--     were involved; the audit row exists purely so the room
	--     mod log can show '@alice deleted a message' as a transparency
	--     measure.
	--
	-- We don't store the message text — Matrix already deleted it from
	-- the federated history via the redaction event.  The mod log only
	-- needs to surface the who / when / why-kind so other room members
	-- can see that a particular deletion happened.
	CREATE TABLE IF NOT EXISTS self_deletions (
		id              INTEGER PRIMARY KEY AUTOINCREMENT,
		room_id         TEXT NOT NULL,
		target_event_id TEXT NOT NULL,
		-- Who issued the redaction.  Always the human Matrix user who
		-- clicked the trash button — never the bot itself, because the
		-- engine performs the redaction on the bot's behalf when kind
		-- = 'bot_owner'.  Used for "who's accountable" in the mod log.
		redacted_by     TEXT NOT NULL,
		-- The original message's sender mxid.  For kind='self' this
		-- equals redacted_by; for kind='bot_owner' this is the bot's
		-- mxid.  Stored explicitly so the mod log doesn't have to
		-- re-derive it from the bots table at render time (and so the
		-- entry stays meaningful even if the bot is later deleted).
		target_sender   TEXT NOT NULL,
		kind            TEXT NOT NULL,        -- 'self' | 'bot_owner'
		-- For kind='bot_owner': the bots.id at deletion time.  Lets a
		-- future "deletions per bot" stat join cleanly back to the bot
		-- row.  NULL for kind='self'.
		bot_id          INTEGER,
		created_at      INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_self_deletions_room_ts
		ON self_deletions(room_id, created_at DESC);

	-- Founder-initiated kick/ban of a bot member.  The free-speech
	-- protections that block founders from unilaterally removing humans
	-- (rooms enforce kick/ban PL=100 + the consensus pipeline routes
	-- around it) deliberately don't extend to bots: bots aren't people,
	-- a misbehaving bot doesn't have a free-speech interest, and the
	-- room's founder is the right authority to silence it without
	-- spinning up the consensus machinery.  This table records every
	-- such action so the audit trail still exists — the founder can
	-- do it without permission, but the room can see they did.
	CREATE TABLE IF NOT EXISTS bot_membership_actions (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		room_id     TEXT NOT NULL,
		bot_mxid    TEXT NOT NULL,
		-- Bot's owner at the time of the action — captured here so the
		-- mod log can attribute it to "@alice's bot" even after the bot
		-- is later deleted (which would orphan the row from the bots
		-- table).  May be NULL for legacy / orphan cases where the
		-- bot record was already gone when the founder acted.
		bot_owner   TEXT,
		action      TEXT NOT NULL,           -- 'kick' | 'ban'
		founder     TEXT NOT NULL,           -- mxid that issued the action
		created_at  INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_bot_membership_actions_room_ts
		ON bot_membership_actions(room_id, created_at DESC);

	-- Per-bot knowledge files.  Plain-text reference material the
	-- bot owner uploads (FAQs, character bios, project docs).  Each
	-- file's full content is concatenated into the system prompt at
	-- inference time so the LLM can quote / reason against it.  No
	-- chunking + embedding for v1 — most use cases are small enough
	-- that just dumping into context works, and the bot's owner is
	-- paying for the tokens via their own API key, so they self-
	-- regulate by not uploading the entire Wikipedia.  Cascading
	-- delete: knowledge dies with the bot.
	CREATE TABLE IF NOT EXISTS bot_knowledge (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		bot_id      INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
		filename    TEXT NOT NULL,
		content     TEXT NOT NULL,
		bytes       INTEGER NOT NULL,
		uploaded_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_bot_knowledge_bot ON bot_knowledge(bot_id);
`);

// SQLite ships with foreign-key enforcement OFF by default; flip it
// on so the bot_knowledge.bot_id FK actually cascades when we delete
// a bot.  Per-connection setting, set after schema creation so it
// applies for every subsequent statement on this connection.
db.exec("PRAGMA foreign_keys = ON");

// ─── Migrations for existing installs ───────────────────────────────
// `CREATE TABLE IF NOT EXISTS` won't backfill new columns onto a
// table that already exists, so for any column we add post-launch we
// do an explicit "introspect-then-ALTER" pass here.  Cheap (PRAGMA is
// O(columns)) and idempotent.
function ensureColumns(table: string, columns: Array<{ name: string; ddl: string }>): void {
	const have = new Set(
		(db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name),
	);
	for (const col of columns) {
		if (!have.has(col.name)) {
			db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.ddl}`);
		}
	}
}
ensureColumns("flags", [
	{ name: "retracted_at", ddl: "retracted_at INTEGER" },
	{ name: "retracted_by", ddl: "retracted_by TEXT" },
	// Discriminator for the polymorphic flag target.  `'message'` means
	// `target_event_id` is the Matrix event id being flagged (existing
	// behaviour, default).  `'room'` means `target_event_id` is reused
	// as the room id of the target room — `target_event_id` and
	// `room_id` columns will hold the same value for these rows.  Room
	// IDs start with `!` and event IDs start with `$`, so the two
	// namespaces are disjoint and we can keep the unified primary-key
	// shape on the table without sentinels.
	{ name: "target_kind", ddl: "target_kind TEXT NOT NULL DEFAULT 'message'" },
]);
ensureColumns("collapses", [
	// Same discriminator as flags.  `'room'` collapses are the
	// per-room "name removed by community review" pipeline.
	{ name: "target_kind", ddl: "target_kind TEXT NOT NULL DEFAULT 'message'" },
	// For room collapses, the m.room.name value at the moment of
	// collapse — kept so an admin reverse can restore the verbatim
	// original name without a separate lookup against Synapse state.
	// NULL for message collapses.
	{ name: "original_name", ddl: "original_name TEXT" },
	// Mirrors the wire field: true if a floor-violation flag triggered
	// the collapse (single-flag fast-track), false if it crossed the
	// distinct-flagger + weighted-score thresholds.
	{ name: "fast_track", ddl: "fast_track INTEGER NOT NULL DEFAULT 0" },
	// For room collapses, the room's creator (sender of m.room.create)
	// at collapse time.  Stored so the engine can count "how many
	// rooms this user has had collapsed against them" without a
	// per-evaluation network round-trip back to Synapse — pattern
	// signal for the auto-suspend accumulator.  NULL for message
	// collapses + for legacy rows where we couldn't read state.
	{ name: "creator_id", ddl: "creator_id TEXT" },
]);
ensureColumns("bots", [
	// JSON array of trigger phrases — see CREATE TABLE comment above.
	{ name: "triggers", ddl: "triggers TEXT NOT NULL DEFAULT '[]'" },
]);

export type PostRow = {
	event_id: string;
	user_id: string;
	room_id: string;
	ts: number;
};

export type ReactionRow = {
	event_id: string;
	target_user_id: string;
	reactor_id: string;
	target_event_id: string;
	key: string;
	ts: number;
};

export type WeightRow = {
	user_id: string;
	weight: number;
	posts_30d: number;
	reactions_90d: number;
	age_days: number;
	computed_at: number;
};

const upsertUserStmt = db.prepare(`
	INSERT INTO users (user_id, first_seen_ts) VALUES (?, ?)
	ON CONFLICT(user_id) DO NOTHING
`);
const insertPostStmt = db.prepare(`
	INSERT OR IGNORE INTO posts (event_id, user_id, room_id, ts) VALUES (?, ?, ?, ?)
`);
const insertReactionStmt = db.prepare(`
	INSERT OR IGNORE INTO reactions (event_id, target_user_id, reactor_id, target_event_id, key, ts)
	VALUES (?, ?, ?, ?, ?, ?)
`);
const deletePostStmt = db.prepare(`DELETE FROM posts WHERE event_id = ?`);
const deleteReactionStmt = db.prepare(`DELETE FROM reactions WHERE event_id = ?`);
const lookupPostUserStmt = db.prepare(`SELECT user_id FROM posts WHERE event_id = ?`);

export function upsertUser(userId: string, firstSeenTs: number): void {
	upsertUserStmt.run(userId, firstSeenTs);
}

export function insertPost(row: PostRow): void {
	upsertUser(row.user_id, row.ts);
	insertPostStmt.run(row.event_id, row.user_id, row.room_id, row.ts);
}

export function insertReaction(row: ReactionRow): void {
	upsertUser(row.reactor_id, row.ts);
	upsertUser(row.target_user_id, row.ts);
	insertReactionStmt.run(
		row.event_id,
		row.target_user_id,
		row.reactor_id,
		row.target_event_id,
		row.key,
		row.ts,
	);
}

export function lookupPostUser(eventId: string): string | null {
	const row = lookupPostUserStmt.get(eventId) as { user_id: string } | undefined;
	return row?.user_id ?? null;
}

export function deletePost(eventId: string): void {
	deletePostStmt.run(eventId);
}

export function deleteReaction(eventId: string): void {
	deleteReactionStmt.run(eventId);
}

const writeWeightStmt = db.prepare(`
	INSERT INTO weights (user_id, weight, posts_30d, reactions_90d, age_days, computed_at)
	VALUES (?, ?, ?, ?, ?, ?)
	ON CONFLICT(user_id) DO UPDATE SET
		weight        = excluded.weight,
		posts_30d     = excluded.posts_30d,
		reactions_90d = excluded.reactions_90d,
		age_days      = excluded.age_days,
		computed_at   = excluded.computed_at
`);

export function writeWeight(row: WeightRow): void {
	writeWeightStmt.run(
		row.user_id,
		row.weight,
		row.posts_30d,
		row.reactions_90d,
		row.age_days,
		row.computed_at,
	);
}

const readWeightStmt = db.prepare(`SELECT * FROM weights WHERE user_id = ?`);
export function readWeight(userId: string): WeightRow | null {
	return (readWeightStmt.get(userId) as WeightRow | undefined) ?? null;
}

const readAllUserIdsStmt = db.prepare(`SELECT user_id, first_seen_ts FROM users`);
export function readAllUsers(): { user_id: string; first_seen_ts: number }[] {
	return readAllUserIdsStmt.all() as { user_id: string; first_seen_ts: number }[];
}

const countPostsStmt = db.prepare(`SELECT COUNT(*) as n FROM posts WHERE user_id = ? AND ts >= ?`);
export function countPostsSince(userId: string, sinceTs: number): number {
	const row = countPostsStmt.get(userId, sinceTs) as { n: number };
	return row.n;
}

const countReactionsStmt = db.prepare(
	`SELECT COUNT(*) as n FROM reactions WHERE target_user_id = ? AND ts >= ?`,
);
export function countReactionsSince(userId: string, sinceTs: number): number {
	const row = countReactionsStmt.get(userId, sinceTs) as { n: number };
	return row.n;
}

// Sum the current weights of users who have posted in this room
// since a cutoff timestamp.  Drives the per-room dynamic collapse
// threshold: rooms with a bigger active community require bigger
// weighted consensus to collapse a message.
//
// "Active" is measured by post recency, not membership.  A 5000-
// member room where only 30 people actually talk has the threshold
// scaled to those 30, not the 5000 lurkers.  This keeps the gate
// proportional to who's actually around to flag.
const roomActiveWeightStmt = db.prepare(`
	SELECT COALESCE(SUM(w.weight), 0) AS total
	FROM weights w
	WHERE w.user_id IN (
		SELECT DISTINCT user_id FROM posts WHERE room_id = ? AND ts >= ?
	)
`);
export function roomActiveWeight(roomId: string, sinceTs: number): number {
	const row = roomActiveWeightStmt.get(roomId, sinceTs) as { total: number };
	return row.total ?? 0;
}

// ─── Flags ───────────────────────────────────────────────────────────

export type FlagTargetKind = "message" | "room";

export type FlagRow = {
	event_id: string;
	// For target_kind='message' this is the Matrix event id of the
	// flagged message.  For target_kind='room' this is the target room
	// id (Matrix room ids start with `!`, event ids with `$`, so the
	// two namespaces don't collide).
	target_event_id: string;
	room_id: string;
	flagger: string;
	category: string;
	rationale?: string | null;
	ts: number;
	// Defaults to 'message' for backwards compatibility with rows
	// inserted before the room-flag pipeline existed.
	target_kind?: FlagTargetKind;
	// NULL until the flag is retracted (the flagger redacts the
	// chat.koven.flag.v1 event).  Once set, the row is excluded from
	// consensus calculations but kept on disk so the mod log can
	// surface both the original flag and the retraction.
	retracted_at?: number | null;
	retracted_by?: string | null;
};

const insertFlagStmt = db.prepare(`
	INSERT OR IGNORE INTO flags (event_id, target_event_id, room_id, flagger, category, rationale, ts, target_kind)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
// Mark a flag retracted instead of deleting it.  Append-only: the
// row is preserved so the public mod log can show the original flag
// followed by its retraction in chronological order.  The
// `retracted_at IS NULL` guard makes this idempotent — replays of
// the same redaction (Synapse retries until 200) won't overwrite the
// recorded retracter / timestamp.
const markFlagRetractedStmt = db.prepare(`
	UPDATE flags
	SET retracted_at = ?, retracted_by = ?
	WHERE event_id = ? AND retracted_at IS NULL
`);

export function insertFlag(row: FlagRow): void {
	insertFlagStmt.run(
		row.event_id,
		row.target_event_id,
		row.room_id,
		row.flagger,
		row.category,
		row.rationale ?? null,
		row.ts,
		row.target_kind ?? "message",
	);
}

/** Mark a flag as retracted.  Returns true if a non-retracted flag
 * row existed and was updated, false otherwise (no row, or already
 * retracted).  Caller uses the boolean to decide whether to fan out
 * follow-up effects (e.g. auto-cancelling a still-pending floor-
 * violation suspension). */
export function markFlagRetracted(eventId: string, retractedAt: number, retractedBy: string): boolean {
	const r = markFlagRetractedStmt.run(retractedAt, retractedBy, eventId);
	return r.changes > 0;
}

// Distinct flagger/category breakdown for one target — drives the
// collapse threshold check.  Retracted flags are excluded: a
// withdrawn flag shouldn't push the target past the collapse line.
const flagsForTargetStmt = db.prepare(`
	SELECT flagger, category FROM flags
	WHERE target_event_id = ? AND retracted_at IS NULL
`);
export function flagsForTarget(targetEventId: string): { flagger: string; category: string }[] {
	return flagsForTargetStmt.all(targetEventId) as { flagger: string; category: string }[];
}

// All target_event_ids that currently have at least one active
// (non-retracted) flag.  Used by the collapse evaluator to scan
// candidates each tick — a target whose only flags are all
// retracted shouldn't be re-evaluated.  `target_kind` is surfaced so
// the evaluator knows whether to emit a message-collapse or a
// room-collapse on threshold crossing.
const flaggedTargetsStmt = db.prepare(`
	SELECT DISTINCT target_event_id, room_id, target_kind FROM flags
	WHERE retracted_at IS NULL
`);
export function listFlaggedTargets(): {
	target_event_id: string;
	room_id: string;
	target_kind: FlagTargetKind;
}[] {
	return flaggedTargetsStmt.all() as Array<{
		target_event_id: string;
		room_id: string;
		target_kind: FlagTargetKind;
	}>;
}

// All flags submitted in a given room, newest first.  Drives the
// per-room mod log.  Returns retracted rows too — the mod log
// surfaces both the original flag and its retraction.
const flagsForRoomStmt = db.prepare(`
	SELECT * FROM flags WHERE room_id = ? ORDER BY ts DESC
`);
export function flagsForRoom(roomId: string): FlagRow[] {
	return flagsForRoomStmt.all(roomId) as FlagRow[];
}

// ─── Collapses ───────────────────────────────────────────────────────

export type CollapseRow = {
	target_event_id: string;
	room_id: string;
	collapsed_at: number;
	flagger_count: number;
	weighted_score: number;
	categories: string[];
	// Discriminator: 'message' (default) or 'room'.  When 'room', the
	// `target_event_id` and `room_id` columns hold the same value (the
	// target room id).
	target_kind?: FlagTargetKind;
	// For target_kind='room' only: m.room.name verbatim at the moment
	// of collapse, kept so admin reverse can restore it.  NULL/empty
	// for message collapses.
	original_name?: string | null;
	// True if a floor-violation flag triggered the collapse (single-
	// flag fast-track) rather than the distinct-flagger + weighted-
	// score thresholds.  Mirrors the wire field.
	fast_track?: boolean;
	// For target_kind='room' only: the room's creator at collapse
	// time.  Drives the per-creator collapse count for the
	// auto-suspend accumulator — counted via countRoomCollapsesByCreator
	// below.  NULL for message rows + for legacy rows where state
	// wasn't readable.
	creator_id?: string | null;
};

const insertCollapseStmt = db.prepare(`
	INSERT OR IGNORE INTO collapses
	(target_event_id, room_id, collapsed_at, flagger_count, weighted_score, categories, target_kind, original_name, fast_track, creator_id)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const hasCollapseStmt = db.prepare(`SELECT 1 FROM collapses WHERE target_event_id = ?`);

export function insertCollapse(row: CollapseRow): void {
	insertCollapseStmt.run(
		row.target_event_id,
		row.room_id,
		row.collapsed_at,
		row.flagger_count,
		row.weighted_score,
		JSON.stringify(row.categories),
		row.target_kind ?? "message",
		row.original_name ?? null,
		row.fast_track ? 1 : 0,
		row.creator_id ?? null,
	);
}

// Count how many room-target collapses the engine has recorded
// against `creatorId`.  When `sinceTs` is set, only collapses on or
// after that timestamp count — used to pair a "rolling window" check
// alongside the "ever" total in the auto-suspend accumulator.  Excludes
// rows where creator_id is null (couldn't read state at collapse time)
// so the count never inflates from data we're not sure about.
const countRoomCollapsesByCreatorEverStmt = db.prepare(`
	SELECT COUNT(*) AS n FROM collapses
	WHERE target_kind = 'room' AND creator_id = ?
`);
const countRoomCollapsesByCreatorSinceStmt = db.prepare(`
	SELECT COUNT(*) AS n FROM collapses
	WHERE target_kind = 'room' AND creator_id = ? AND collapsed_at >= ?
`);
export function countRoomCollapsesByCreator(creatorId: string, sinceTs?: number): number {
	const row = (sinceTs === undefined
		? countRoomCollapsesByCreatorEverStmt.get(creatorId)
		: countRoomCollapsesByCreatorSinceStmt.get(creatorId, sinceTs)
	) as { n: number } | undefined;
	return row?.n ?? 0;
}

export function hasCollapse(targetEventId: string): boolean {
	return !!hasCollapseStmt.get(targetEventId);
}

// Collapses recorded in a given room, newest first.  Drives the
// per-room mod log.
const collapsesForRoomStmt = db.prepare(`
	SELECT * FROM collapses WHERE room_id = ? ORDER BY collapsed_at DESC
`);
export function collapsesForRoom(roomId: string): CollapseRow[] {
	const rows = collapsesForRoomStmt.all(roomId) as Array<
		Omit<CollapseRow, "categories" | "fast_track"> & { categories: string; fast_track: number }
	>;
	return rows.map(r => ({
		...r,
		categories: JSON.parse(r.categories) as string[],
		fast_track: !!r.fast_track,
	}));
}

// All currently-collapsed rooms, for the public /api/rooms/collapsed
// endpoint the SPA polls to override room-name display + filter
// Explore.  Returns minimal columns so the response is cheap to
// serialise even on instances with thousands of collapses.
const listRoomCollapsesStmt = db.prepare(`
	SELECT target_event_id AS room_id, original_name, collapsed_at, categories, fast_track
	FROM collapses
	WHERE target_kind = 'room'
	ORDER BY collapsed_at DESC
`);
export function listRoomCollapses(): Array<{
	room_id: string;
	original_name: string | null;
	collapsed_at: number;
	categories: string[];
	fast_track: boolean;
}> {
	const rows = listRoomCollapsesStmt.all() as Array<{
		room_id: string;
		original_name: string | null;
		collapsed_at: number;
		categories: string;
		fast_track: number;
	}>;
	return rows.map(r => ({
		...r,
		categories: JSON.parse(r.categories) as string[],
		fast_track: !!r.fast_track,
	}));
}

// Lookup the original name + collapse metadata for a single room.
// Used by the SPA when rendering a room the user is already a member
// of (the room's m.room.name still holds the offensive original; we
// override the display from this row).  Returns null if the room is
// not currently collapsed.
const getRoomCollapseStmt = db.prepare(`
	SELECT target_event_id AS room_id, original_name, collapsed_at, categories, fast_track
	FROM collapses
	WHERE target_kind = 'room' AND target_event_id = ?
`);
export function getRoomCollapse(roomId: string): {
	room_id: string;
	original_name: string | null;
	collapsed_at: number;
	categories: string[];
	fast_track: boolean;
} | null {
	const row = getRoomCollapseStmt.get(roomId) as {
		room_id: string;
		original_name: string | null;
		collapsed_at: number;
		categories: string;
		fast_track: number;
	} | undefined;
	if (!row) return null;
	return {
		...row,
		categories: JSON.parse(row.categories) as string[],
		fast_track: !!row.fast_track,
	};
}

// Remove a room collapse — used by the admin "reverse" flow when an
// admin decides a floor-flagged room shouldn't have been hidden.  The
// flag rows stay (audit trail); only the collapse decision is undone,
// so the SPA stops overriding the display name and Explore re-includes
// the room.  No-op if the row doesn't exist.
const deleteRoomCollapseStmt = db.prepare(`
	DELETE FROM collapses WHERE target_kind = 'room' AND target_event_id = ?
`);
export function deleteRoomCollapse(roomId: string): boolean {
	const r = deleteRoomCollapseStmt.run(roomId);
	return r.changes > 0;
}

// ─── Room creations (rate-limit + reputation gate) ──────────────────

const recordRoomCreationStmt = db.prepare(`
	INSERT OR IGNORE INTO room_creations (room_id, creator_id, created_at, visibility)
	VALUES (?, ?, ?, ?)
`);
const countRoomCreationsByUserStmt = db.prepare(`
	SELECT COUNT(*) AS n FROM room_creations
	WHERE creator_id = ? AND created_at >= ?
`);

/** Record a room creation.  Called from aggregate.ts when the engine
 * observes an m.room.create event on the appservice transaction
 * stream — fires once per room since INSERT OR IGNORE drops repeats.
 * `visibility` is best-effort from the create event content; defaults
 * to 'unknown' when not in scope.  Used by the rate-limit gate below. */
export function recordRoomCreation(opts: {
	room_id: string;
	creator_id: string;
	created_at: number;
	visibility?: "public" | "private" | "unknown";
}): void {
	recordRoomCreationStmt.run(
		opts.room_id,
		opts.creator_id,
		opts.created_at,
		opts.visibility ?? "unknown",
	);
}

/** How many rooms `creatorId` has created at or after `sinceTs`.  The
 * spam-checker calls this each time a user attempts to create a room,
 * with `sinceTs = now - 24h` (or whatever window the engine config
 * dictates).  Returning a number plus the threshold lets the caller
 * compute "how many more they can make today" for the error message. */
export function countRoomCreationsByUser(creatorId: string, sinceTs: number): number {
	const row = countRoomCreationsByUserStmt.get(creatorId, sinceTs) as { n: number } | undefined;
	return row?.n ?? 0;
}

// ─── Joined rooms (engine bot membership cache) ──────────────────────

const isRoomJoinedStmt = db.prepare(`SELECT 1 FROM joined_rooms WHERE room_id = ?`);
const recordRoomJoinedStmt = db.prepare(`
	INSERT OR IGNORE INTO joined_rooms (room_id, joined_at) VALUES (?, ?)
`);

export function isRoomJoined(roomId: string): boolean {
	return !!isRoomJoinedStmt.get(roomId);
}

export function recordRoomJoined(roomId: string): void {
	recordRoomJoinedStmt.run(roomId, Date.now());
}

// ─── Admins ─────────────────────────────────────────────────────────

const isAdminStmt = db.prepare(`SELECT 1 FROM admins WHERE user_id = ?`);
const insertAdminStmt = db.prepare(`
	INSERT OR IGNORE INTO admins (user_id, granted_at, granted_by) VALUES (?, ?, ?)
`);
const countAdminsStmt = db.prepare(`SELECT COUNT(*) as n FROM admins`);
const firstUserStmt = db.prepare(`
	SELECT user_id FROM users ORDER BY first_seen_ts ASC LIMIT 1
`);

export function isAdmin(userId: string): boolean {
	return !!isAdminStmt.get(userId);
}

export function grantAdmin(userId: string, grantedBy: string | null): void {
	insertAdminStmt.run(userId, Date.now(), grantedBy);
}

export function adminCount(): number {
	return (countAdminsStmt.get() as { n: number }).n;
}

export function firstSeenUser(): string | null {
	const row = firstUserStmt.get() as { user_id: string } | undefined;
	return row?.user_id ?? null;
}

// ─── Instance config ────────────────────────────────────────────────

const readConfigStmt = db.prepare(`SELECT key, value FROM instance_config`);
const writeConfigStmt = db.prepare(`
	INSERT INTO instance_config (key, value, updated_at, updated_by)
	VALUES (?, ?, ?, ?)
	ON CONFLICT(key) DO UPDATE SET
		value      = excluded.value,
		updated_at = excluded.updated_at,
		updated_by = excluded.updated_by
`);
const deleteConfigStmt = db.prepare(`DELETE FROM instance_config WHERE key = ?`);

export function readInstanceConfig(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const row of readConfigStmt.all() as { key: string; value: string }[]) {
		out[row.key] = row.value;
	}
	return out;
}

export function writeInstanceConfig(key: string, value: string, updatedBy: string): void {
	writeConfigStmt.run(key, value, Date.now(), updatedBy);
}

export function deleteInstanceConfig(key: string): void {
	deleteConfigStmt.run(key);
}

// ─── User profiles (bios) ───────────────────────────────────────────

const readBioStmt = db.prepare(`SELECT bio FROM user_profiles WHERE user_id = ?`);
const upsertBioStmt = db.prepare(`
	INSERT INTO user_profiles (user_id, bio, updated_at)
	VALUES (?, ?, ?)
	ON CONFLICT(user_id) DO UPDATE SET
		bio        = excluded.bio,
		updated_at = excluded.updated_at
`);
const deleteBioStmt = db.prepare(`DELETE FROM user_profiles WHERE user_id = ?`);

export function readBio(userId: string): string | null {
	const row = readBioStmt.get(userId) as { bio: string } | undefined;
	return row?.bio ?? null;
}

export function writeBio(userId: string, bio: string): void {
	upsertBioStmt.run(userId, bio, Date.now());
}

export function deleteBio(userId: string): void {
	deleteBioStmt.run(userId);
}

// ─── Suspensions ────────────────────────────────────────────────────

export type SuspensionStatus = "pending" | "confirmed" | "reversed" | "dismissed";
export type SuspensionReason =
	| "floor_violation"
	| "repeated_false_floor_flags"
	| "repeated_room_collapses";

export interface SuspensionRow {
	id: number;
	user_id: string;
	reason: SuspensionReason;
	flag_event_id: string | null;
	target_event_id: string | null;
	target_room_id: string | null;
	flagger: string | null;
	status: SuspensionStatus;
	created_at: number;
	reviewed_at: number | null;
	reviewed_by: string | null;
	admin_note: string | null;
}

const insertSuspensionStmt = db.prepare(`
	INSERT INTO suspensions
		(user_id, reason, flag_event_id, target_event_id, target_room_id, flagger, status, created_at)
	VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
`);

const getActiveSuspensionStmt = db.prepare(`
	SELECT * FROM suspensions
	WHERE user_id = ? AND status IN ('pending', 'confirmed')
	ORDER BY created_at DESC
	LIMIT 1
`);

const listPendingSuspensionsStmt = db.prepare(`
	SELECT * FROM suspensions
	WHERE status = 'pending'
	ORDER BY created_at ASC
`);

const getSuspensionByIdStmt = db.prepare(`
	SELECT * FROM suspensions WHERE id = ?
`);

// Find the still-pending suspension (if any) created by a specific
// chat.koven.flag.v1 event.  Used by the flag-retraction handler to
// auto-reverse a suspension whose originating flag was withdrawn
// before an admin reviewed it.
const findPendingSuspensionByFlagStmt = db.prepare(`
	SELECT * FROM suspensions
	WHERE flag_event_id = ? AND status = 'pending'
	LIMIT 1
`);
export function findPendingSuspensionByFlag(flagEventId: string): SuspensionRow | null {
	return (findPendingSuspensionByFlagStmt.get(flagEventId) as SuspensionRow | undefined) ?? null;
}

const updateSuspensionStmt = db.prepare(`
	UPDATE suspensions
	SET status = ?, reviewed_at = ?, reviewed_by = ?, admin_note = ?
	WHERE id = ?
`);

// Counts how many of this user's prior floor flags ended up reversed
// by an admin — i.e. were determined to be false reports.  Used to
// trigger the auto-suspension rule (2-in-30-days, 3-ever).
const countFalseFlagsByUserStmt = db.prepare(`
	SELECT COUNT(*) as n FROM suspensions
	WHERE flagger = ? AND status = 'reversed' AND reason = 'floor_violation'
`);
const countFalseFlagsByUserSinceStmt = db.prepare(`
	SELECT COUNT(*) as n FROM suspensions
	WHERE flagger = ? AND status = 'reversed' AND reason = 'floor_violation' AND created_at >= ?
`);

export function createSuspension(opts: {
	user_id: string;
	reason: SuspensionReason;
	flag_event_id?: string | null;
	target_event_id?: string | null;
	target_room_id?: string | null;
	flagger?: string | null;
}): number {
	const r = insertSuspensionStmt.run(
		opts.user_id,
		opts.reason,
		opts.flag_event_id ?? null,
		opts.target_event_id ?? null,
		opts.target_room_id ?? null,
		opts.flagger ?? null,
		Date.now(),
	);
	return Number(r.lastInsertRowid);
}

export function getActiveSuspension(userId: string): SuspensionRow | null {
	return (getActiveSuspensionStmt.get(userId) as SuspensionRow | undefined) ?? null;
}

export function listPendingSuspensions(): SuspensionRow[] {
	return listPendingSuspensionsStmt.all() as SuspensionRow[];
}

export function getSuspensionById(id: number): SuspensionRow | null {
	return (getSuspensionByIdStmt.get(id) as SuspensionRow | undefined) ?? null;
}

export function updateSuspensionStatus(
	id: number,
	status: SuspensionStatus,
	reviewedBy: string,
	adminNote: string | null,
): void {
	updateSuspensionStmt.run(status, Date.now(), reviewedBy, adminNote, id);
}

export function countFalseFlagsByUser(userId: string, sinceMs?: number): number {
	const row = sinceMs === undefined
		? (countFalseFlagsByUserStmt.get(userId) as { n: number })
		: (countFalseFlagsByUserSinceStmt.get(userId, sinceMs) as { n: number });
	return row.n;
}

// All suspensions (any status) for a given room — used by the
// per-room mod log to render its history.
const suspensionsForRoomStmt = db.prepare(`
	SELECT * FROM suspensions
	WHERE target_room_id = ?
	ORDER BY created_at DESC
`);
export function suspensionsForRoom(roomId: string): SuspensionRow[] {
	return suspensionsForRoomStmt.all(roomId) as SuspensionRow[];
}

// ─── User-initiated message deletions ──────────────────────────────
// Audit rows for the trash-button flow.  Row gets inserted from
// /api/rooms/:room_id/messages/:event_id/delete after the engine has
// successfully redacted the underlying Matrix event.  Append-only —
// the mod log surfaces it forever; nothing else reads from this table.

export type SelfDeletionKind = "self" | "bot_owner";

export interface SelfDeletionRow {
	id: number;
	room_id: string;
	target_event_id: string;
	redacted_by: string;
	target_sender: string;
	kind: SelfDeletionKind;
	bot_id: number | null;
	created_at: number;
}

const insertSelfDeletionStmt = db.prepare(`
	INSERT INTO self_deletions
	(room_id, target_event_id, redacted_by, target_sender, kind, bot_id, created_at)
	VALUES (?, ?, ?, ?, ?, ?, ?)
`);

export function recordSelfDeletion(opts: {
	roomId: string;
	targetEventId: string;
	redactedBy: string;
	targetSender: string;
	kind: SelfDeletionKind;
	botId: number | null;
}): void {
	insertSelfDeletionStmt.run(
		opts.roomId,
		opts.targetEventId,
		opts.redactedBy,
		opts.targetSender,
		opts.kind,
		opts.botId,
		Date.now(),
	);
}

const selfDeletionsForRoomStmt = db.prepare(`
	SELECT * FROM self_deletions
	WHERE room_id = ?
	ORDER BY created_at DESC
`);
export function selfDeletionsForRoom(roomId: string): SelfDeletionRow[] {
	return selfDeletionsForRoomStmt.all(roomId) as SelfDeletionRow[];
}

// ─── Founder bot kick/ban ───────────────────────────────────────────
// Audit rows for the bot kick/ban flow on a room's profile sheet.
// Same shape as self_deletions: append-only, one row per action,
// rendered into the per-room mod log.  The actual Matrix membership
// transition happens via the founder's own access token (PL 100 →
// kick/ban allowed); this table just records that it happened.

export type BotMembershipAction = "kick" | "ban";

export interface BotMembershipActionRow {
	id: number;
	room_id: string;
	bot_mxid: string;
	bot_owner: string | null;
	action: BotMembershipAction;
	founder: string;
	created_at: number;
}

const insertBotMembershipActionStmt = db.prepare(`
	INSERT INTO bot_membership_actions
	(room_id, bot_mxid, bot_owner, action, founder, created_at)
	VALUES (?, ?, ?, ?, ?, ?)
`);

export function recordBotMembershipAction(opts: {
	roomId: string;
	botMxid: string;
	botOwner: string | null;
	action: BotMembershipAction;
	founder: string;
}): void {
	insertBotMembershipActionStmt.run(
		opts.roomId,
		opts.botMxid,
		opts.botOwner,
		opts.action,
		opts.founder,
		Date.now(),
	);
}

const botMembershipActionsForRoomStmt = db.prepare(`
	SELECT * FROM bot_membership_actions
	WHERE room_id = ?
	ORDER BY created_at DESC
`);
export function botMembershipActionsForRoom(roomId: string): BotMembershipActionRow[] {
	return botMembershipActionsForRoomStmt.all(roomId) as BotMembershipActionRow[];
}

// ─── User self-deactivation cleanup ─────────────────────────────────
// Called from the /api/me/purge endpoint right before the client tells
// Synapse to deactivate the account.  Drops:
//
//   - reputation row (their weight is no longer relevant)
//   - bio (they wrote it; no audit purpose)
//   - any active suspension on THEIR account (cancelled, since they're
//     about to be deactivated themselves; no point holding a pending
//     case against them, the admin queue would dangle)
//
// Intentionally LEAVES IN PLACE:
//   - posts / reactions they authored (referenced by the timeline)
//   - flags they submitted (part of the public mod log)
//   - collapses they voted into (community decisions stand)
//   - admin-grant rows (audit trail)
//   - the `users` row itself (first-seen-ts is referenced by other
//     joins; cheaper to leave a bare row than chase foreign keys)
//
// Synapse's `erase: true` on the deactivate call handles the actual
// content scrubbing on the homeserver side: message bodies become
// empty redactions there.  The engine cleanup here is just the
// reputation + suspension half.

const deleteWeightStmt = db.prepare(`DELETE FROM weights WHERE user_id = ?`);
const cancelActiveSuspensionStmt = db.prepare(`
	UPDATE suspensions
	SET status = 'reversed', reviewed_at = ?, reviewed_by = 'self_deactivate', admin_note = 'auto-cancelled on self-deactivation'
	WHERE user_id = ? AND status = 'pending'
`);

export function purgeUserState(userId: string): void {
	deleteWeightStmt.run(userId);
	deleteBioStmt.run(userId);
	cancelActiveSuspensionStmt.run(Date.now(), userId);
	deleteEmailBindingForUserStmt.run(userId);
}

// ─── Email-to-account bindings ──────────────────────────────────────

const lookupEmailStmt = db.prepare(
	`SELECT user_id FROM user_emails WHERE email = ? COLLATE NOCASE`,
);
const lookupEmailByUserStmt = db.prepare(
	`SELECT email FROM user_emails WHERE user_id = ?`,
);
const insertEmailStmt = db.prepare(`
	INSERT INTO user_emails (email, user_id, created_at) VALUES (?, ?, ?)
`);
const touchEmailLoginStmt = db.prepare(`
	UPDATE user_emails SET last_login = ? WHERE email = ? COLLATE NOCASE
`);
const deleteEmailBindingForUserStmt = db.prepare(
	`DELETE FROM user_emails WHERE user_id = ?`,
);

/** Resolve an email to its Matrix user id, or null if unknown. */
export function lookupUserByEmail(email: string): string | null {
	const row = lookupEmailStmt.get(email) as { user_id: string } | undefined;
	return row?.user_id ?? null;
}

/** Reverse lookup, mainly for diagnostics + the "what email am I?" UI. */
export function lookupEmailByUser(userId: string): string | null {
	const row = lookupEmailByUserStmt.get(userId) as { email: string } | undefined;
	return row?.email ?? null;
}

/** Bind an email to a freshly-created Matrix account.  One-shot; the
 * email column is PK and user_id is UNIQUE, so re-binding requires
 * deleting the old row first.  We don't expose unbind in v1.
 */
export function bindEmailToUser(email: string, userId: string): void {
	insertEmailStmt.run(email.toLowerCase(), userId, Date.now());
}

// Idempotent binding for the install-time bootstrap path.  `bin/koven
// bootstrap-admin` calls this through the /api/admin/bootstrap
// endpoint so re-running the script (after a synapse-data wipe, say)
// updates the existing rows in place rather than failing on PK
// conflicts.  Same effective result as bindEmailToUser, but explicit
// about the upsert semantics.
const upsertEmailStmt = db.prepare(`
	INSERT INTO user_emails (email, user_id, created_at) VALUES (?, ?, ?)
	ON CONFLICT(email)   DO UPDATE SET user_id    = excluded.user_id
`);
const upsertEmailByUserStmt = db.prepare(`
	UPDATE user_emails SET email = ?, created_at = ? WHERE user_id = ?
`);
export function bootstrapEmailBinding(email: string, userId: string): void {
	const lower = email.toLowerCase();
	// Two-phase to handle the "user_id already bound to a different
	// email" case: ON CONFLICT(email) only handles dupes on the email
	// column, not on the user_id UNIQUE constraint.  We flip user_id's
	// row first if it exists, then upsert by email.
	upsertEmailByUserStmt.run(lower, Date.now(), userId);
	upsertEmailStmt.run(lower, userId, Date.now());
}

/** Update last_login on a successful auth.  Best-effort; not critical. */
export function touchEmailLogin(email: string): void {
	touchEmailLoginStmt.run(Date.now(), email);
}

// ─── One-time auth codes ────────────────────────────────────────────

// Hash with SHA-256 so a DB read doesn't leak codes; the code itself
// only exists in memory long enough to be sent via email.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

function sha256(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

const insertAuthCodeStmt = db.prepare(`
	INSERT INTO auth_codes (email, code_hash, expires_at, created_at)
	VALUES (?, ?, ?, ?)
`);
const latestActiveCodeStmt = db.prepare(`
	SELECT * FROM auth_codes
	WHERE email = ? COLLATE NOCASE
	  AND used_at IS NULL
	  AND expires_at > ?
	ORDER BY created_at DESC
	LIMIT 1
`);
const incrementAttemptsStmt = db.prepare(`
	UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?
`);
const markCodeUsedStmt = db.prepare(`
	UPDATE auth_codes SET used_at = ? WHERE id = ?
`);
const countRecentCodesStmt = db.prepare(`
	SELECT COUNT(*) AS n FROM auth_codes
	WHERE email = ? COLLATE NOCASE AND created_at >= ?
`);
const cleanupCodesStmt = db.prepare(`
	DELETE FROM auth_codes WHERE expires_at < ?
`);

interface AuthCodeRow {
	id: number;
	email: string;
	code_hash: string;
	expires_at: number;
	attempts: number;
	used_at: number | null;
	created_at: number;
}

const MAX_ATTEMPTS_PER_CODE = 5;
const MAX_CODES_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Generate, store, and return a 6-digit code for `email`.  The code
 * itself is returned to the caller (so it can be emailed); only the
 * SHA-256 hash is persisted.  Rate-limited per email to MAX_CODES_PER_HOUR.
 *
 * Returns { code } on success, or { error } if the rate limit is hit.
 */
export function issueAuthCode(email: string, ttlMs: number): { code: string } | { error: "rate_limited" } {
	cleanupCodesStmt.run(Date.now() - 24 * HOUR_MS); // best-effort sweep
	const recent = countRecentCodesStmt.get(email, Date.now() - HOUR_MS) as { n: number };
	if (recent.n >= MAX_CODES_PER_HOUR) {
		return { error: "rate_limited" };
	}
	// Six digits, leading zeros preserved.  randomInt(1000000) gives us
	// 0..999999 uniformly; pad to 6 chars for display.
	const n = Number(randomBytes(4).readUInt32BE(0)) % 1_000_000;
	const code = String(n).padStart(6, "0");
	insertAuthCodeStmt.run(
		email.toLowerCase(),
		sha256(code),
		Date.now() + ttlMs,
		Date.now(),
	);
	return { code };
}

/**
 * Verify a submitted code against the latest active code for `email`.
 * Constant-time hash compare to defeat timing oracles.  Does NOT mark
 * the code used on success — that's a separate `markAuthCodeUsed` call
 * the caller invokes only after the whole verify-code endpoint has
 * succeeded.  This lets the user retry with a different username
 * after a `username_unavailable` failure without burning their code.
 * On failure increments the attempt counter; once attempts reach
 * MAX_ATTEMPTS_PER_CODE the code is treated as expired by
 * latestActiveCodeStmt.
 *
 * Returns:
 *   { ok: true, codeId }              → code matched (NOT yet consumed)
 *   { error: "no_active_code" }       → no unexpired/unused code on file
 *   { error: "wrong_code" }           → mismatch, attempts incremented
 *   { error: "too_many_attempts" }    → attempts already at the cap
 */
export function verifyAuthCode(email: string, code: string): { ok: true; codeId: number } | { error: "no_active_code" | "wrong_code" | "too_many_attempts" } {
	const row = latestActiveCodeStmt.get(email, Date.now()) as AuthCodeRow | undefined;
	if (!row) return { error: "no_active_code" };
	if (row.attempts >= MAX_ATTEMPTS_PER_CODE) return { error: "too_many_attempts" };

	const expected = Buffer.from(row.code_hash, "hex");
	const provided = Buffer.from(sha256(code), "hex");
	const matched = expected.length === provided.length && timingSafeEqual(expected, provided);
	if (!matched) {
		incrementAttemptsStmt.run(row.id);
		return { error: "wrong_code" };
	}
	return { ok: true, codeId: row.id };
}

/** Mark a previously-verified code as used.  Called by the caller of
 * verifyAuthCode at the end of the success path so retryable failures
 * (taken username, etc.) leave the code valid for another try. */
export function markAuthCodeUsed(codeId: number): void {
	markCodeUsedStmt.run(Date.now(), codeId);
}

// ─── Bots ────────────────────────────────────────────────────────────

export type BotProvider = "openrouter" | "openai_compatible";

export interface BotRow {
	id: number;
	mxid: string;
	owner_id: string;
	display_name: string;
	avatar_mxc: string | null;
	provider: BotProvider;
	api_base: string;
	api_key_enc: string;
	model: string;
	system_prompt: string;
	context_window: number;
	/** Trigger phrases.  Stored on disk as a JSON array (column
	 * type TEXT); helpers below parse on read so callers see a
	 * native string[].  Empty array = "respond only to explicit
	 * mentions / replies / DMs," which is the platform's original
	 * behaviour and the default for newly-created bots. */
	triggers: string[];
	access_token_enc: string;
	device_id: string;
	enabled: number;
	created_at: number;
	total_prompt_tokens: number;
	total_completion_tokens: number;
	total_calls: number;
	last_used_at: number | null;
}

/** Raw shape coming back from the bots table.  Internal helper —
 * `mapBotRow` runs every column through the sanitiser the public
 * helpers (`getBotById`, `listBotsByOwner`, etc.) hand callers. */
interface RawBotRow extends Omit<BotRow, "triggers"> {
	triggers: string;
}

function mapBotRow(raw: RawBotRow | undefined): BotRow | null {
	if (!raw) return null;
	let triggers: string[] = [];
	try {
		const parsed = JSON.parse(raw.triggers ?? "[]");
		if (Array.isArray(parsed)) {
			triggers = parsed.filter((s): s is string => typeof s === "string" && s.length > 0);
		}
	} catch {
		// Corrupt JSON — log and fall back to empty.  The next save
		// will rewrite the column with valid JSON.
		console.warn(`engine: bot ${raw.id} has malformed triggers JSON; treating as empty`);
	}
	return { ...raw, triggers };
}

const insertBotStmt = db.prepare(`
	INSERT INTO bots
		(mxid, owner_id, display_name, avatar_mxc, provider, api_base,
		 api_key_enc, model, system_prompt, context_window,
		 access_token_enc, device_id, enabled, created_at, triggers)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
`);
const listBotsByOwnerStmt = db.prepare(
	`SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at ASC`,
);
const listAllBotMxidsStmt = db.prepare(
	`SELECT mxid FROM bots WHERE enabled = 1`,
);
const listAllEnabledBotsStmt = db.prepare(
	`SELECT * FROM bots WHERE enabled = 1`,
);
const getBotByIdStmt = db.prepare(`SELECT * FROM bots WHERE id = ?`);
const getBotByMxidStmt = db.prepare(`SELECT * FROM bots WHERE mxid = ?`);
const countBotsByOwnerStmt = db.prepare(
	`SELECT COUNT(*) AS n FROM bots WHERE owner_id = ?`,
);
const updateBotStmt = db.prepare(`
	UPDATE bots SET
		display_name   = COALESCE(?, display_name),
		avatar_mxc     = COALESCE(?, avatar_mxc),
		provider       = COALESCE(?, provider),
		api_base       = COALESCE(?, api_base),
		api_key_enc    = COALESCE(?, api_key_enc),
		model          = COALESCE(?, model),
		system_prompt  = COALESCE(?, system_prompt),
		context_window = COALESCE(?, context_window),
		enabled        = COALESCE(?, enabled),
		triggers       = COALESCE(?, triggers)
	WHERE id = ?
`);
const deleteBotStmt = db.prepare(`DELETE FROM bots WHERE id = ?`);
const bumpBotUsageStmt = db.prepare(`
	UPDATE bots SET
		total_prompt_tokens     = total_prompt_tokens + ?,
		total_completion_tokens = total_completion_tokens + ?,
		total_calls             = total_calls + 1,
		last_used_at            = ?
	WHERE id = ?
`);

export function createBot(opts: {
	mxid: string;
	owner_id: string;
	display_name: string;
	provider: BotProvider;
	api_base: string;
	api_key_enc: string;
	model: string;
	system_prompt: string;
	context_window: number;
	access_token_enc: string;
	device_id: string;
	triggers?: string[];
}): BotRow {
	const r = insertBotStmt.run(
		opts.mxid,
		opts.owner_id,
		opts.display_name,
		null,
		opts.provider,
		opts.api_base,
		opts.api_key_enc,
		opts.model,
		opts.system_prompt,
		opts.context_window,
		opts.access_token_enc,
		opts.device_id,
		Date.now(),
		JSON.stringify(opts.triggers ?? []),
	);
	const row = mapBotRow(getBotByIdStmt.get(Number(r.lastInsertRowid)) as RawBotRow);
	if (!row) throw new Error(`createBot: failed to read back inserted row ${r.lastInsertRowid}`);
	return row;
}

export function listBotsByOwner(ownerId: string): BotRow[] {
	return (listBotsByOwnerStmt.all(ownerId) as RawBotRow[])
		.map(r => mapBotRow(r))
		.filter((r): r is BotRow => r !== null);
}

export function listAllBotMxids(): string[] {
	return (listAllBotMxidsStmt.all() as { mxid: string }[]).map(r => r.mxid);
}

export function listAllEnabledBots(): BotRow[] {
	return (listAllEnabledBotsStmt.all() as RawBotRow[])
		.map(r => mapBotRow(r))
		.filter((r): r is BotRow => r !== null);
}

export function getBotById(id: number): BotRow | null {
	return mapBotRow(getBotByIdStmt.get(id) as RawBotRow | undefined);
}

export function getBotByMxid(mxid: string): BotRow | null {
	return mapBotRow(getBotByMxidStmt.get(mxid) as RawBotRow | undefined);
}

export function countBotsByOwner(ownerId: string): number {
	return (countBotsByOwnerStmt.get(ownerId) as { n: number }).n;
}

/**
 * Patch a bot.  Only fields with a non-undefined value are touched
 * (everything else stays put via the COALESCE in the SQL).  Returns
 * the post-update row for echoing back to the caller.
 */
export function updateBot(id: number, patch: {
	display_name?: string;
	avatar_mxc?: string | null;
	provider?: BotProvider;
	api_base?: string;
	api_key_enc?: string;
	model?: string;
	system_prompt?: string;
	context_window?: number;
	enabled?: 0 | 1;
	/** When provided, replaces the whole list (atomic — there's no
	 * "add one" / "remove one" granularity at this layer; the
	 * client always sends the full set). */
	triggers?: string[];
}): BotRow | null {
	updateBotStmt.run(
		patch.display_name ?? null,
		patch.avatar_mxc === undefined ? null : patch.avatar_mxc,
		patch.provider ?? null,
		patch.api_base ?? null,
		patch.api_key_enc ?? null,
		patch.model ?? null,
		patch.system_prompt ?? null,
		patch.context_window ?? null,
		patch.enabled ?? null,
		patch.triggers === undefined ? null : JSON.stringify(patch.triggers),
		id,
	);
	return getBotById(id);
}

// Direct avatar set / clear, bypassing the COALESCE-based updateBot.
// Needed because COALESCE(NULL, avatar_mxc) preserves the existing
// value, so there's no way to *clear* the avatar through updateBot —
// passing `null` is indistinguishable from "don't touch."  The avatar
// endpoint uses this helper for both set (with the mxc:// string)
// and clear (with null) paths.
const setBotAvatarStmt = db.prepare(
	`UPDATE bots SET avatar_mxc = ? WHERE id = ?`,
);
export function setBotAvatarMxc(id: number, avatarMxc: string | null): BotRow | null {
	setBotAvatarStmt.run(avatarMxc, id);
	return getBotById(id);
}

export function deleteBot(id: number): void {
	deleteBotStmt.run(id);
}

export function bumpBotUsage(id: number, promptTokens: number, completionTokens: number): void {
	bumpBotUsageStmt.run(promptTokens, completionTokens, Date.now(), id);
}

// ─── Bot knowledge files ────────────────────────────────────────────

/** Metadata about an uploaded knowledge file.  The full text content
 * is intentionally NOT included here — listings need to stay cheap
 * even if a bot has dozens of MB of reference material attached.
 * Use `getBotKnowledgeContent` to pull the actual text for the
 * inference path. */
export interface BotKnowledgeMeta {
	id: number;
	bot_id: number;
	filename: string;
	bytes: number;
	uploaded_at: number;
}

/** Knowledge file with full text — used by bot_pipeline when
 * building the LLM call's system message. */
export interface BotKnowledgeRow extends BotKnowledgeMeta {
	content: string;
}

const insertBotKnowledgeStmt = db.prepare(`
	INSERT INTO bot_knowledge (bot_id, filename, content, bytes, uploaded_at)
	VALUES (?, ?, ?, ?, ?)
`);
const listBotKnowledgeStmt = db.prepare(
	`SELECT id, bot_id, filename, bytes, uploaded_at FROM bot_knowledge
	 WHERE bot_id = ? ORDER BY uploaded_at ASC`,
);
const getBotKnowledgeContentStmt = db.prepare(
	`SELECT id, bot_id, filename, content, bytes, uploaded_at FROM bot_knowledge
	 WHERE bot_id = ? ORDER BY uploaded_at ASC`,
);
const deleteBotKnowledgeStmt = db.prepare(
	`DELETE FROM bot_knowledge WHERE id = ? AND bot_id = ?`,
);
const totalBotKnowledgeBytesStmt = db.prepare(
	`SELECT COALESCE(SUM(bytes), 0) AS total FROM bot_knowledge WHERE bot_id = ?`,
);

export function addBotKnowledge(
	botId: number,
	filename: string,
	content: string,
): BotKnowledgeMeta {
	const bytes = new TextEncoder().encode(content).length;
	const r = insertBotKnowledgeStmt.run(botId, filename, content, bytes, Date.now());
	return {
		id: Number(r.lastInsertRowid),
		bot_id: botId,
		filename,
		bytes,
		uploaded_at: Date.now(),
	};
}

export function listBotKnowledge(botId: number): BotKnowledgeMeta[] {
	return listBotKnowledgeStmt.all(botId) as BotKnowledgeMeta[];
}

/** Full content for every knowledge file attached to this bot.  Used
 * by the inference path; do NOT call from list endpoints — the rows
 * can be megabytes each. */
export function getBotKnowledgeContent(botId: number): BotKnowledgeRow[] {
	return getBotKnowledgeContentStmt.all(botId) as BotKnowledgeRow[];
}

/** Delete a single knowledge file.  bot_id scoping defends against
 * an owner who somehow learned another owner's file id (shouldn't
 * happen — endpoints check ownership — but defence-in-depth). */
export function deleteBotKnowledge(fileId: number, botId: number): boolean {
	const r = deleteBotKnowledgeStmt.run(fileId, botId);
	return r.changes > 0;
}

export function totalBotKnowledgeBytes(botId: number): number {
	const row = totalBotKnowledgeBytesStmt.get(botId) as { total: number };
	return row.total ?? 0;
}

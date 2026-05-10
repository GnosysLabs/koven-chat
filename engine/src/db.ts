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

	-- Rooms started as DMs.  Populated when an m.room.member event
	-- arrives with content.is_direct = true (the flag clients set
	-- when they create a 1:1 conversation room and invite the other
	-- party).  Used by the notification fan-out to distinguish real
	-- DMs from 2-person private rooms — both have memberCount === 2,
	-- but only DMs should fire the kind=dm bell on plain messages.
	-- One row per DM room; idempotent on re-mark via PRIMARY KEY.
	CREATE TABLE IF NOT EXISTS dm_rooms (
		room_id   TEXT PRIMARY KEY,
		marked_at INTEGER NOT NULL
	);

	-- Instance admins.  First user the engine sees gets auto-promoted
	-- on bootstrap (see admins.ts).  Subsequent admins must be
	-- granted by an existing admin via the API.
	CREATE TABLE IF NOT EXISTS admins (
		user_id    TEXT PRIMARY KEY,
		granted_at INTEGER NOT NULL,
		granted_by TEXT             -- NULL when self-bootstrap
	);

	-- Per-user, per-room notification level.  Three values:
	--   'all'      → fire on every message (kind=message)
	--   'mentions' → fire on DM/mention/reply only (current default)
	--   'muted'    → never fire, even on mentions
	-- Missing row = 'mentions' default.  Read in fanOutMessage to
	-- decide whether to write a notification row for a recipient.
	CREATE TABLE IF NOT EXISTS room_notify_prefs (
		user_id   TEXT NOT NULL,
		room_id   TEXT NOT NULL,
		level     TEXT NOT NULL CHECK (level IN ('all', 'mentions', 'muted')),
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (user_id, room_id)
	);
	CREATE INDEX IF NOT EXISTS idx_room_notify_prefs_user
		ON room_notify_prefs(user_id);

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

	-- Founders log: the first 666 users to sign up.  AUTOINCREMENT
	-- gives atomic sequential numbering with zero race risk;
	-- UNIQUE(user_id) prevents double-claims if the signup hook fires
	-- twice (retry, idempotent boot backfill, etc.); the cap is
	-- enforced at the insert site (claimFounderNumber) rather than in
	-- schema so we keep a paper trail of every claim attempt without
	-- storing rows that don't qualify.  founder_number IS the row id;
	-- a SELECT returns it directly.
	--
	-- Drives the holographic Founder badge surfaced on profiles and
	-- next to usernames in chat — users in this table see their
	-- numerical place in the signup queue ("Founder #042 of 666").
	CREATE TABLE IF NOT EXISTS founders (
		founder_number INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id        TEXT NOT NULL UNIQUE,
		claimed_at     INTEGER NOT NULL
	);

	-- MCP servers attached to each bot.  We're protocol-pure: owners
	-- paste a Streamable-HTTP MCP URL plus optional auth headers
	-- (typical: Authorization: Bearer <pat>).  No catalog, no proxy,
	-- no platform-specific glue — if the user can find an MCP URL
	-- they're qualified to wire up the auth that goes with it.
	-- 'label' is a freeform display name shown in the bot edit UI.
	-- Cascade-delete on bot deletion so a removed bot doesn't leave
	-- orphan rows behind.
	CREATE TABLE IF NOT EXISTS bot_mcp_servers (
		id           INTEGER PRIMARY KEY AUTOINCREMENT,
		bot_id       INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
		label        TEXT NOT NULL DEFAULT '',
		url          TEXT NOT NULL DEFAULT '',
		headers_json TEXT NOT NULL DEFAULT '{}',
		created_at   INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_bot_mcp_servers_bot ON bot_mcp_servers(bot_id);
	-- Note: stdio columns (kind, command, args_json, env_json,
	-- locked_version) are added below via ensureColumns so existing
	-- HTTP-only rows migrate cleanly without a schema rewrite.

	-- Per-user third-party integration secrets — currently just the
	-- Smithery API key (used to query Smithery's MCP server registry
	-- + invoke hosted MCP servers on the user's behalf).  Composite
	-- key on (user_id, integration) lets one user store multiple
	-- integration credentials independently; the value is encrypted
	-- via sealSecret (same crypto as bot api_key_enc) and never
	-- echoed back to the client.
	CREATE TABLE IF NOT EXISTS user_integrations (
		user_id     TEXT NOT NULL,
		integration TEXT NOT NULL,
		secret_enc  TEXT NOT NULL,
		updated_at  INTEGER NOT NULL,
		PRIMARY KEY (user_id, integration)
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

	-- ─── Inbound webhooks per bot ───────────────────────────────────
	-- Each row is a unique URL the bot owner can paste into an
	-- external service (GitHub, Stripe, Linear, n8n, etc.).  Inbound
	-- POSTs to /api/webhooks/in/:token look up the row, optionally
	-- verify HMAC if a secret is set, format the payload, and post
	-- it as the bot in target_room_id.  Cascading delete with the
	-- bot — losing a bot drops its webhooks too.
	--
	-- token: random 32-byte URL-safe base64.  Treated as the
	--        capability for posting; the URL contains it so anyone
	--        with the URL can post unless secret_hmac is also set.
	-- secret_hmac: optional shared secret.  When set, requests must
	--        include an X-Hub-Signature-256 header (sha256=<hex>)
	--        over the raw body.  Matches GitHub standard so most
	--        sources plug in unchanged.
	-- last_delivery / last_error: for the bot owner's debug view.
	CREATE TABLE IF NOT EXISTS bot_webhooks (
		id              INTEGER PRIMARY KEY AUTOINCREMENT,
		bot_id          INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
		token           TEXT NOT NULL UNIQUE,
		secret_hmac     TEXT,
		target_room_id  TEXT NOT NULL,
		label           TEXT NOT NULL DEFAULT '',
		created_at      INTEGER NOT NULL,
		last_delivery   INTEGER,
		last_error      TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_bot_webhooks_bot ON bot_webhooks(bot_id);
	CREATE INDEX IF NOT EXISTS idx_bot_webhooks_token ON bot_webhooks(token);

	-- Per-webhook delivery log, capped to the most recent N rows
	-- (enforced via a trigger below) so a chatty source can't grow
	-- the database unboundedly.  payload_json is the raw incoming
	-- body, posted_text is what we actually sent to the room (or
	-- null if formatting/posting failed), error is the failure
	-- reason if any.  Drives the bot owner's "recent deliveries"
	-- debug view.
	CREATE TABLE IF NOT EXISTS bot_webhook_deliveries (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		webhook_id    INTEGER NOT NULL REFERENCES bot_webhooks(id) ON DELETE CASCADE,
		received_at   INTEGER NOT NULL,
		payload_json  TEXT NOT NULL,
		posted_text   TEXT,
		error         TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_bot_webhook_deliveries_webhook
		ON bot_webhook_deliveries(webhook_id, received_at DESC);

	-- Cap the delivery log per webhook at 100 rows.  A trigger fires
	-- after each insert and deletes the oldest rows beyond the cap.
	-- Cheaper than a periodic janitor sweep + bounds the table size
	-- proportional to webhook count rather than delivery volume.
	CREATE TRIGGER IF NOT EXISTS trg_bot_webhook_deliveries_cap
	AFTER INSERT ON bot_webhook_deliveries
	BEGIN
		DELETE FROM bot_webhook_deliveries
		WHERE webhook_id = NEW.webhook_id
		  AND id NOT IN (
			SELECT id FROM bot_webhook_deliveries
			WHERE webhook_id = NEW.webhook_id
			ORDER BY received_at DESC
			LIMIT 100
		  );
	END;

	-- ─── Bot OUTBOUND webhooks (LLM-callable HTTP tools) ─────────────
	-- The mirror of bot_webhooks: instead of external services posting
	-- IN to the bot, the bot calls OUT to an external HTTP endpoint
	-- when its LLM decides to invoke the tool.  Each row registers as
	-- an OpenAI tool definition in the bot's chatCompletion call (see
	-- engine/src/outbound_webhooks.ts), so the model can reach for it
	-- like any other tool.
	--
	-- name + description are what the LLM sees (and uses to decide
	-- when to call).  url + method describe the HTTP request — url
	-- can contain {param} placeholders that get substituted from the
	-- LLM's args.  params_json is a JSON array of
	-- {name, description, required, in} where the in field is "url"
	-- (path/query substitution) or "body" (POST body field).  headers_json is a
	-- JSON array of {name, value} for static auth headers (the Twilio
	-- Auth Token, GitHub PAT, etc.) — values are stored in plaintext
	-- because the encryption needed for true secret storage adds
	-- complexity disproportionate to the threat model (an attacker
	-- with DB read already has the bot's API key + Matrix token).
	CREATE TABLE IF NOT EXISTS bot_outbound_webhooks (
		id            INTEGER PRIMARY KEY AUTOINCREMENT,
		bot_id        INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
		name          TEXT NOT NULL,
		description   TEXT NOT NULL DEFAULT '',
		method        TEXT NOT NULL DEFAULT 'GET',
		url           TEXT NOT NULL,
		params_json   TEXT NOT NULL DEFAULT '[]',
		headers_json  TEXT NOT NULL DEFAULT '[]',
		created_at    INTEGER NOT NULL,
		last_called   INTEGER,
		last_error    TEXT
	);
	CREATE INDEX IF NOT EXISTS idx_bot_outbound_webhooks_bot
		ON bot_outbound_webhooks(bot_id);

	-- ─── Room membership tracker ─────────────────────────────────────
	-- Updated on every m.room.member state event the engine sees via
	-- the appservice transaction stream.  Used by the notification
	-- engine to:
	--   - decide whether a room is a DM (two members + both joined)
	--   - resolve @localpart in plaintext mentions to a full MXID
	--     present in the room (notification fan-out target lookup)
	--   - detect invite events to fan out an invite notification
	-- Membership values track the Matrix spec literally: 'join' |
	-- 'leave' | 'invite' | 'ban' | 'knock'.  We don't garbage-collect
	-- 'leave' rows because that history is occasionally useful (e.g.
	-- "was this user in the room when X happened") and the table
	-- stays small even for active instances — proportional to active
	-- room participation, not message volume.
	CREATE TABLE IF NOT EXISTS room_members (
		room_id      TEXT NOT NULL,
		user_id      TEXT NOT NULL,
		membership   TEXT NOT NULL,
		last_updated INTEGER NOT NULL,
		PRIMARY KEY (room_id, user_id)
	);
	CREATE INDEX IF NOT EXISTS idx_room_members_room
		ON room_members(room_id, membership);
	CREATE INDEX IF NOT EXISTS idx_room_members_user
		ON room_members(user_id, membership);

	-- ─── In-app notification log ─────────────────────────────────────
	-- One row per (recipient, source-event) pair.  The engine writes
	-- these in real time as it processes the appservice transaction
	-- stream, picking the highest-priority kind that matches the
	-- (recipient, event) pair: invite > dm > mention > reply > system.
	-- Encrypted rooms can only emit 'dm' rows (the engine cannot read
	-- the body to detect mentions/replies); for those the snippet is
	-- a placeholder rather than message content.
	-- The bell UI reads this table via the /api/notifications surface
	-- and posts mark-read / dismiss writes back through the same
	-- endpoints.  See engine/src/server.ts.
	CREATE TABLE IF NOT EXISTS notifications (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id     TEXT NOT NULL,         -- recipient (whose bell this lights up)
		event_id    TEXT NOT NULL,         -- triggering Matrix event id
		room_id     TEXT NOT NULL,
		kind        TEXT NOT NULL CHECK(kind IN ('dm','mention','reply','invite','system')),
		sender      TEXT NOT NULL,         -- who triggered the notification
		snippet     TEXT,                  -- excerpt or placeholder; client also has live data
		created_at  INTEGER NOT NULL,
		read_at     INTEGER,                -- nullable; null = unread
		UNIQUE(user_id, event_id)
	);
	CREATE INDEX IF NOT EXISTS idx_notifications_user_created
		ON notifications(user_id, created_at DESC);
	CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
		ON notifications(user_id, read_at, created_at DESC);
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
	// Spending guardrails.  All three default to 0 = unlimited so
	// existing rows behave unchanged after the migration; the bot
	// owner opts in by setting positive values.
	//
	//   - max_tokens_per_reply: cap on output tokens for ONE LLM
	//     call.  Maps directly to the OpenAI `max_tokens` param.
	//     Bounds individual blowups (a chatty model spinning out
	//     30k-token essays).
	//   - daily_token_limit: cap on total prompt + completion
	//     tokens across all LLM calls in a UTC day.  Bot stops
	//     responding when exceeded until the day rolls over.
	//   - daily_call_limit: cap on total LLM calls in a UTC day.
	//     Bot stops responding when exceeded.  Useful when the
	//     model is cheap-per-call but a single conversation could
	//     run an unbounded number of tool-use iterations.
	{ name: "max_tokens_per_reply", ddl: "max_tokens_per_reply INTEGER NOT NULL DEFAULT 0" },
	{ name: "daily_token_limit",   ddl: "daily_token_limit INTEGER NOT NULL DEFAULT 0" },
	{ name: "daily_call_limit",    ddl: "daily_call_limit INTEGER NOT NULL DEFAULT 0" },
	// Bot privacy gate: when 0, the bot leaves any DM-shaped invite
	// it receives from anyone other than its owner.  Default 1 (open
	// to everyone) so existing bots behave unchanged after the
	// migration; owners opt out from the bot edit form.  Group-room
	// invites are gated separately — only the owner can pull a bot
	// into a group room, regardless of this flag.
	{ name: "accept_dms",          ddl: "accept_dms INTEGER NOT NULL DEFAULT 1" },
]);

// Schema rewrite: bot_mcp_servers used to be Smithery-specific
// `(smithery_qualified_name, config_json)`; we've since dropped
// the catalog and proxy in favour of users pasting raw MCP URLs +
// auth headers.  When we detect the old shape, drop the table —
// the grand total of attachments worth migrating is "however many
// the user had on the day they upgraded," and the new flow takes
// ten seconds to re-add each one.  Idempotent: no-op on installs
// that already have the new columns.
{
	const cols = new Set(
		(db.prepare("PRAGMA table_info(bot_mcp_servers)").all() as Array<{ name: string }>)
			.map(c => c.name),
	);
	if (cols.size > 0 && !cols.has("url")) {
		console.log("engine: rewriting bot_mcp_servers for URL-based attachments (existing rows dropped)");
		db.exec("DROP TABLE bot_mcp_servers");
		db.exec(`
			CREATE TABLE bot_mcp_servers (
				id           INTEGER PRIMARY KEY AUTOINCREMENT,
				bot_id       INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
				label        TEXT NOT NULL DEFAULT '',
				url          TEXT NOT NULL DEFAULT '',
				headers_json TEXT NOT NULL DEFAULT '{}',
				created_at   INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_bot_mcp_servers_bot ON bot_mcp_servers(bot_id);
		`);
	}
}

// Per-bot per-UTC-day rolling usage counters.  Reads on the hot
// path (every mention checks today's usage against the bot's
// limits before firing the LLM call); writes after every LLM
// completion bump the day's row.  Old rows aren't pruned —
// historical accounting is useful for "how much did this bot
// cost last month?" reporting later.  At ~50 bytes per row per
// bot per day, a year of data on 100 bots is ~1.8 MB; not worth
// a janitor.
db.exec(`
	CREATE TABLE IF NOT EXISTS bot_usage_daily (
		bot_id            INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
		day               TEXT NOT NULL,
		calls             INTEGER NOT NULL DEFAULT 0,
		prompt_tokens     INTEGER NOT NULL DEFAULT 0,
		completion_tokens INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (bot_id, day)
	);
`);
ensureColumns("room_creations", [
	// Discriminate between regular chat rooms and Matrix spaces so the
	// publish-rate gate can apply parallel ladders — same per-
	// reputation-tier daily caps, but spaces and rooms each get their
	// own counter so creating a server doesn't burn through your
	// channel quota.  Default 'room' for legacy rows: existing entries
	// from before this migration are treated as rooms (which they
	// mostly were; the few miscategorized space rows age out in 24h).
	{ name: "kind", ddl: "kind TEXT NOT NULL DEFAULT 'room'" },
]);
ensureColumns("bot_mcp_servers", [
	// Stdio-transport support.  Each MCP attachment is either:
	//   kind='http'  → uses url + headers_json (existing behaviour)
	//   kind='stdio' → uses command + args_json + env_json
	// command + args_json hold the npx/uvx invocation the user pasted
	// from the standard `mcpServers` config block.  env_json is the
	// per-attachment environment passed into the spawned subprocess
	// (PERPLEXITY_API_KEY etc.) — engine's own env vars are stripped
	// before spawn so the subprocess only sees what the user supplied.
	// locked_version pins the npm package version at attach time so a
	// silent supply-chain compromise via auto-update can't compromise
	// the bot retroactively.
	{ name: "kind",           ddl: "kind TEXT NOT NULL DEFAULT 'http'" },
	{ name: "command",        ddl: "command TEXT" },
	{ name: "args_json",      ddl: "args_json TEXT NOT NULL DEFAULT '[]'" },
	{ name: "env_json",       ddl: "env_json TEXT NOT NULL DEFAULT '{}'" },
	{ name: "locked_version", ddl: "locked_version TEXT" },
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
	INSERT OR IGNORE INTO room_creations (room_id, creator_id, created_at, visibility, kind)
	VALUES (?, ?, ?, ?, ?)
`);
const countRoomCreationsByUserStmt = db.prepare(`
	SELECT COUNT(*) AS n FROM room_creations
	WHERE creator_id = ? AND created_at >= ? AND kind = ?
`);

/** Record a room creation.  Called from aggregate.ts when the engine
 * observes an m.room.create event on the appservice transaction
 * stream — fires once per row since INSERT OR IGNORE drops repeats.
 * `visibility` is best-effort from the create event content; defaults
 * to 'unknown' when not in scope.  `kind` discriminates regular rooms
 * from Matrix spaces (`type: m.space`) so the rate-limit gate can
 * apply parallel ladders.  Used by the rate-limit gate below. */
export function recordRoomCreation(opts: {
	room_id: string;
	creator_id: string;
	created_at: number;
	visibility?: "public" | "private" | "unknown";
	kind?: "room" | "space";
}): void {
	recordRoomCreationStmt.run(
		opts.room_id,
		opts.creator_id,
		opts.created_at,
		opts.visibility ?? "unknown",
		opts.kind ?? "room",
	);
}

// ─── DM rooms ───────────────────────────────────────────────────────

const markRoomAsDmStmt = db.prepare(`
	INSERT OR IGNORE INTO dm_rooms (room_id, marked_at) VALUES (?, ?)
`);
const isRoomDmStmt = db.prepare(`SELECT 1 FROM dm_rooms WHERE room_id = ? LIMIT 1`);

/** Mark a room as a DM.  Called from the appservice transaction
 * handler whenever an m.room.member event with content.is_direct=true
 * lands.  Idempotent — once a room is flagged, repeats are no-ops.
 * The flag never gets cleared: a room that started as a DM stays a
 * DM forever for notification purposes (matches Element's behaviour). */
export function markRoomAsDm(roomId: string): void {
	markRoomAsDmStmt.run(roomId, Date.now());
}

/** True when this room was started as a DM (we've previously seen an
 * is_direct=true membership event for it).  Used by the notification
 * fan-out to decide whether to fire kind=dm on plain messages. */
export function isRoomDm(roomId: string): boolean {
	return !!isRoomDmStmt.get(roomId);
}

/** How many rooms (or spaces) `creatorId` has created of the given
 * `kind` at or after `sinceTs`.  The spam-checker calls this each
 * time a user attempts to publish, with `sinceTs = now - 24h` and
 * `kind` matching the publish target — rooms and spaces have parallel
 * counters so creating a server doesn't burn the channel quota.
 * Returning a number plus the threshold lets the caller compute "how
 * many more they can make today" for the error message. */
export function countRoomCreationsByUser(
	creatorId: string,
	sinceTs: number,
	kind: "room" | "space" = "room",
): number {
	const row = countRoomCreationsByUserStmt.get(creatorId, sinceTs, kind) as { n: number } | undefined;
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
const deleteAdminStmt = db.prepare(`DELETE FROM admins WHERE user_id = ?`);
const countAdminsStmt = db.prepare(`SELECT COUNT(*) as n FROM admins`);
const listAdminsStmt = db.prepare(`
	SELECT user_id, granted_at, granted_by
	FROM admins
	ORDER BY granted_at ASC
`);
const firstUserStmt = db.prepare(`
	SELECT user_id FROM users ORDER BY first_seen_ts ASC LIMIT 1
`);

export function isAdmin(userId: string): boolean {
	return !!isAdminStmt.get(userId);
}

export function grantAdmin(userId: string, grantedBy: string | null): void {
	insertAdminStmt.run(userId, Date.now(), grantedBy);
}

/** Remove a user from the admins table.  Idempotent: deleting a row
 * that doesn't exist is a no-op.  Caller is responsible for the
 * "don't drop the last admin" + "self-demote-as-only-admin" guards
 * — see /api/admins/revoke in server.ts for the policy. */
export function revokeAdmin(userId: string): void {
	deleteAdminStmt.run(userId);
}

export function adminCount(): number {
	return (countAdminsStmt.get() as { n: number }).n;
}

/** Return every admin row, oldest grant first.  Drives the Settings
 * → Instance admin-management UI so existing admins can see who else
 * has the keys + when each was promoted. */
export function listAdmins(): Array<{
	user_id: string;
	granted_at: number;
	granted_by: string | null;
}> {
	return listAdminsStmt.all() as Array<{
		user_id: string;
		granted_at: number;
		granted_by: string | null;
	}>;
}

export function firstSeenUser(): string | null {
	const row = firstUserStmt.get() as { user_id: string } | undefined;
	return row?.user_id ?? null;
}

// ─── Per-room notification preferences ──────────────────────────────

export type RoomNotifyLevel = "all" | "mentions" | "muted";

const getRoomNotifyLevelStmt = db.prepare(`
	SELECT level FROM room_notify_prefs WHERE user_id = ? AND room_id = ?
`);
const setRoomNotifyLevelStmt = db.prepare(`
	INSERT INTO room_notify_prefs (user_id, room_id, level, updated_at)
	VALUES (?, ?, ?, ?)
	ON CONFLICT(user_id, room_id) DO UPDATE
		SET level = excluded.level, updated_at = excluded.updated_at
`);
const deleteRoomNotifyLevelStmt = db.prepare(`
	DELETE FROM room_notify_prefs WHERE user_id = ? AND room_id = ?
`);
const listRoomNotifyLevelsStmt = db.prepare(`
	SELECT room_id, level FROM room_notify_prefs WHERE user_id = ?
`);

/** Read the user's notification level for one room.  Returns the
 * default 'mentions' when no row exists — saves the caller from
 * having to fall through to the default everywhere. */
export function getRoomNotifyLevel(userId: string, roomId: string): RoomNotifyLevel {
	const row = getRoomNotifyLevelStmt.get(userId, roomId) as
		| { level: RoomNotifyLevel }
		| undefined;
	return row?.level ?? "mentions";
}

/** Write the user's notification level for one room.  Pass 'mentions'
 * to clear the override (deletes the row, falls back to default).
 * Other values upsert. */
export function setRoomNotifyLevel(userId: string, roomId: string, level: RoomNotifyLevel): void {
	if (level === "mentions") {
		deleteRoomNotifyLevelStmt.run(userId, roomId);
		return;
	}
	setRoomNotifyLevelStmt.run(userId, roomId, level, Date.now());
}

/** Return every overridden room → level mapping for one user.  Drives
 * the client's bulk-load on app boot so the AccountSwitcher / sidebar
 * can render mute indicators without per-room round-trips. */
export function listRoomNotifyLevels(userId: string): Array<{
	room_id: string;
	level: RoomNotifyLevel;
}> {
	return listRoomNotifyLevelsStmt.all(userId) as Array<{
		room_id: string;
		level: RoomNotifyLevel;
	}>;
}

/** Atomically set the same notification level on every room in
 * `roomIds` for one user.  Wrapped in a single SQLite transaction
 * so the result is all-or-nothing — either every row gets the new
 * level or the database is unchanged.  Used by the space tile's
 * "Set notifications for all rooms" submenu, which previously
 * fired N parallel single-room PUTs and could leave the user in a
 * partially-applied state if any of them failed. */
export function setRoomNotifyLevelBulk(
	userId: string,
	roomIds: string[],
	level: RoomNotifyLevel,
): number {
	if (roomIds.length === 0) return 0;
	const ts = Date.now();
	const tx = db.transaction((ids: string[]) => {
		let n = 0;
		for (const id of ids) {
			if (level === "mentions") {
				deleteRoomNotifyLevelStmt.run(userId, id);
			} else {
				setRoomNotifyLevelStmt.run(userId, id, level, ts);
			}
			n++;
		}
		return n;
	});
	return tx(roomIds);
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

// ─── Per-user integration secrets ───────────────────────────────────
//
// Encrypted credentials for third-party integrations the user has
// opted into.  Currently used for Smithery (MCP server registry +
// hosted MCP server invocation).  The `secret_enc` column holds a
// sealSecret-encrypted blob; sealSecret/unsealSecret are the same
// pair used for bot api_key_enc.  Nothing in this table ever
// returns to the client in its original form — endpoints that
// "report" a configured integration return a presence boolean only.

const upsertUserIntegrationStmt = db.prepare(`
	INSERT INTO user_integrations (user_id, integration, secret_enc, updated_at)
	VALUES (?, ?, ?, ?)
	ON CONFLICT(user_id, integration) DO UPDATE SET
		secret_enc = excluded.secret_enc,
		updated_at = excluded.updated_at
`);
const readUserIntegrationStmt = db.prepare(
	`SELECT secret_enc FROM user_integrations WHERE user_id = ? AND integration = ?`,
);
const deleteUserIntegrationStmt = db.prepare(
	`DELETE FROM user_integrations WHERE user_id = ? AND integration = ?`,
);
const hasUserIntegrationStmt = db.prepare(
	`SELECT 1 FROM user_integrations WHERE user_id = ? AND integration = ? LIMIT 1`,
);

/** Store an encrypted integration secret for `userId`.  Replaces any
 * existing value for the same (user, integration) pair. */
export function setUserIntegrationSecret(
	userId: string,
	integration: string,
	secretEnc: string,
): void {
	upsertUserIntegrationStmt.run(userId, integration, secretEnc, Date.now());
}

/** Read the encrypted blob — caller is responsible for unsealSecret.
 * Returns null when no row exists. */
export function getUserIntegrationSecretEnc(
	userId: string,
	integration: string,
): string | null {
	const row = readUserIntegrationStmt.get(userId, integration) as
		| { secret_enc: string }
		| undefined;
	return row?.secret_enc ?? null;
}

export function clearUserIntegrationSecret(userId: string, integration: string): void {
	deleteUserIntegrationStmt.run(userId, integration);
}

/** Cheap presence check.  Used by the integrations-status endpoint
 * to report `{ configured: true|false }` without ever decrypting
 * the value. */
export function hasUserIntegration(userId: string, integration: string): boolean {
	return !!hasUserIntegrationStmt.get(userId, integration);
}

// ─── Per-bot MCP servers ────────────────────────────────────────────
//
// Each bot has zero or more MCP servers attached.  We're protocol-
// pure: a row is just a Streamable-HTTP URL plus optional auth
// headers.  No catalog, no proxy, no platform-specific glue.  The
// runtime opens each server with `new StreamableHTTPClientTransport(
// url, { requestInit: { headers } })` — see engine/src/mcp/bot_tools.ts.

export type BotMcpServerKind = "http" | "stdio";

/** An MCP server attached to a bot.  Two transport flavours, dispatched
 * on `kind`.  HTTP attachments are hosted endpoints; stdio attachments
 * are subprocess invocations (sandboxed via bwrap, see
 * engine/src/mcp/sandbox.ts). */
export interface BotMcpServer {
	id: number;
	bot_id: number;
	label: string;
	kind: BotMcpServerKind;
	created_at: number;
	/** kind='http' fields. */
	url: string;
	/** HTTP headers added to every MCP request.  Typical use:
	 * `{ "Authorization": "Bearer <pat>" }`.  Empty when the server
	 * is anonymously accessible. */
	headers: Record<string, string>;
	/** kind='stdio' fields. */
	command: string | null;
	args: string[];
	env: Record<string, string>;
	/** Pinned npm package version (e.g. "1.2.3") if we resolved one
	 * at attach time — protects against silent supply-chain compromise
	 * via auto-update.  Null when we couldn't resolve (non-npm package,
	 * private registry, network blip at attach). */
	locked_version: string | null;
}

interface RawBotMcpServerRow {
	id: number;
	bot_id: number;
	label: string;
	kind: string;
	url: string;
	headers_json: string;
	command: string | null;
	args_json: string;
	env_json: string;
	locked_version: string | null;
	created_at: number;
}

const MCP_ROW_COLS = "id, bot_id, label, kind, url, headers_json, command, args_json, env_json, locked_version, created_at";

const insertBotMcpServerStmt = db.prepare(`
	INSERT INTO bot_mcp_servers (bot_id, label, kind, url, headers_json, command, args_json, env_json, locked_version, created_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	RETURNING id
`);
const updateBotMcpServerStmt = db.prepare(`
	UPDATE bot_mcp_servers SET
		label          = COALESCE(?, label),
		url            = COALESCE(?, url),
		headers_json   = COALESCE(?, headers_json),
		command        = COALESCE(?, command),
		args_json      = COALESCE(?, args_json),
		env_json       = COALESCE(?, env_json),
		locked_version = COALESCE(?, locked_version)
	WHERE id = ?
`);
const listBotMcpServersStmt = db.prepare(`
	SELECT ${MCP_ROW_COLS}
	FROM bot_mcp_servers
	WHERE bot_id = ?
	ORDER BY created_at ASC
`);
const getBotMcpServerStmt = db.prepare(`
	SELECT ${MCP_ROW_COLS}
	FROM bot_mcp_servers
	WHERE id = ?
`);
const deleteBotMcpServerStmt = db.prepare(
	`DELETE FROM bot_mcp_servers WHERE id = ?`,
);

function safeJsonObject(raw: string | null | undefined, label: string): Record<string, string> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(parsed)) {
				if (typeof v === "string") out[k] = v;
			}
			return out;
		}
	} catch {
		console.warn(`db: ${label} malformed JSON object, ignoring`);
	}
	return {};
}

function safeJsonStringArray(raw: string | null | undefined, label: string): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === "string");
	} catch {
		console.warn(`db: ${label} malformed JSON array, ignoring`);
	}
	return [];
}

function mapMcpRow(raw: RawBotMcpServerRow | undefined): BotMcpServer | null {
	if (!raw) return null;
	const kind: BotMcpServerKind = raw.kind === "stdio" ? "stdio" : "http";
	return {
		id: raw.id,
		bot_id: raw.bot_id,
		label: raw.label,
		kind,
		url: raw.url,
		headers: safeJsonObject(raw.headers_json, `bot_mcp_servers ${raw.id} headers_json`),
		command: raw.command,
		args: safeJsonStringArray(raw.args_json, `bot_mcp_servers ${raw.id} args_json`),
		env: safeJsonObject(raw.env_json, `bot_mcp_servers ${raw.id} env_json`),
		locked_version: raw.locked_version,
		created_at: raw.created_at,
	};
}

/** Attach an MCP server to a bot.  Returns the row's id.  Caller picks
 * the kind: 'http' for hosted Streamable-HTTP endpoints, 'stdio' for
 * subprocess invocations (npx / uvx / etc.).  Unused fields for the
 * chosen kind should be left empty. */
export function addBotMcpServer(opts: {
	bot_id: number;
	label: string;
	kind: BotMcpServerKind;
	url?: string;
	headers?: Record<string, string>;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	locked_version?: string;
}): number {
	const r = insertBotMcpServerStmt.get(
		opts.bot_id,
		opts.label,
		opts.kind,
		opts.url ?? "",
		JSON.stringify(opts.headers ?? {}),
		opts.command ?? null,
		JSON.stringify(opts.args ?? []),
		JSON.stringify(opts.env ?? {}),
		opts.locked_version ?? null,
		Date.now(),
	) as { id: number };
	return r.id;
}

/** Edit an attached server in place.  Pass undefined for any field
 * that should be left alone; the SQL COALESCE preserves it.  Used
 * by PATCH /api/bots/:id/mcp/:mcpId to let users rotate auth tokens
 * or rename the label without re-attaching. */
export function updateBotMcpServer(id: number, patch: {
	label?: string;
	url?: string;
	headers?: Record<string, string>;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	locked_version?: string;
}): BotMcpServer | null {
	updateBotMcpServerStmt.run(
		patch.label ?? null,
		patch.url ?? null,
		patch.headers === undefined ? null : JSON.stringify(patch.headers),
		patch.command ?? null,
		patch.args === undefined ? null : JSON.stringify(patch.args),
		patch.env === undefined ? null : JSON.stringify(patch.env),
		patch.locked_version ?? null,
		id,
	);
	return getBotMcpServerById(id);
}

export function listBotMcpServers(botId: number): BotMcpServer[] {
	return (listBotMcpServersStmt.all(botId) as RawBotMcpServerRow[])
		.map(mapMcpRow)
		.filter((r): r is BotMcpServer => r !== null);
}

export function getBotMcpServerById(id: number): BotMcpServer | null {
	return mapMcpRow(getBotMcpServerStmt.get(id) as RawBotMcpServerRow | undefined);
}

export function deleteBotMcpServer(id: number): void {
	deleteBotMcpServerStmt.run(id);
}

// ─── Bot inbound webhooks ────────────────────────────────────────────
//
// Each bot can have N webhooks; each webhook has a unique URL token,
// optional HMAC secret, and a target room.  Inbound POSTs to
// /api/webhooks/in/:token look up the row, optionally verify HMAC,
// format the payload, and post via the bot's matrix client into the
// target room.  Per-webhook delivery log capped at 100 rows by a
// trigger declared in the schema migration block above.

export interface BotWebhookRow {
	id: number;
	bot_id: number;
	token: string;
	secret_hmac: string | null;
	target_room_id: string;
	label: string;
	created_at: number;
	last_delivery: number | null;
	last_error: string | null;
}

export interface BotWebhookDeliveryRow {
	id: number;
	webhook_id: number;
	received_at: number;
	payload_json: string;
	posted_text: string | null;
	error: string | null;
}

const insertBotWebhookStmt = db.prepare(`
	INSERT INTO bot_webhooks (
		bot_id, token, secret_hmac, target_room_id, label, created_at
	) VALUES (?, ?, ?, ?, ?, ?)
	RETURNING id, bot_id, token, secret_hmac, target_room_id, label,
	          created_at, last_delivery, last_error
`);

const listBotWebhooksStmt = db.prepare(`
	SELECT id, bot_id, token, secret_hmac, target_room_id, label,
	       created_at, last_delivery, last_error
	FROM bot_webhooks
	WHERE bot_id = ?
	ORDER BY created_at ASC
`);

const getBotWebhookByTokenStmt = db.prepare(`
	SELECT id, bot_id, token, secret_hmac, target_room_id, label,
	       created_at, last_delivery, last_error
	FROM bot_webhooks
	WHERE token = ?
`);

const getBotWebhookByIdStmt = db.prepare(`
	SELECT id, bot_id, token, secret_hmac, target_room_id, label,
	       created_at, last_delivery, last_error
	FROM bot_webhooks
	WHERE id = ? AND bot_id = ?
`);

const deleteBotWebhookStmt = db.prepare(`
	DELETE FROM bot_webhooks WHERE id = ? AND bot_id = ?
`);

const updateBotWebhookStatusStmt = db.prepare(`
	UPDATE bot_webhooks
	SET last_delivery = ?, last_error = ?
	WHERE id = ?
`);

const insertBotWebhookDeliveryStmt = db.prepare(`
	INSERT INTO bot_webhook_deliveries (
		webhook_id, received_at, payload_json, posted_text, error
	) VALUES (?, ?, ?, ?, ?)
`);

const listBotWebhookDeliveriesStmt = db.prepare(`
	SELECT id, webhook_id, received_at, payload_json, posted_text, error
	FROM bot_webhook_deliveries
	WHERE webhook_id = ?
	ORDER BY received_at DESC
	LIMIT ?
`);

/** Create a new webhook for `botId`.  Caller is responsible for
 * generating the random token (32 bytes URL-safe base64) and the
 * optional HMAC secret — keeping that in the caller lets the
 * endpoint return the secret to the user EXACTLY ONCE without ever
 * persisting the plaintext beyond storage. */
export function insertBotWebhook(opts: {
	botId: number;
	token: string;
	secretHmac: string | null;
	targetRoomId: string;
	label: string;
}): BotWebhookRow {
	return insertBotWebhookStmt.get(
		opts.botId,
		opts.token,
		opts.secretHmac,
		opts.targetRoomId,
		opts.label,
		Date.now(),
	) as BotWebhookRow;
}

/** All webhooks for a bot, oldest first. */
export function listBotWebhooks(botId: number): BotWebhookRow[] {
	return listBotWebhooksStmt.all(botId) as BotWebhookRow[];
}

/** Look up a webhook by its URL token.  Used by the inbound
 * endpoint to resolve which bot + room a delivery belongs to. */
export function getBotWebhookByToken(token: string): BotWebhookRow | null {
	const row = getBotWebhookByTokenStmt.get(token) as BotWebhookRow | undefined;
	return row ?? null;
}

/** Look up a webhook by id, scoped to a specific bot — guards
 * against cross-bot id enumeration in the CRUD endpoints. */
export function getBotWebhookById(id: number, botId: number): BotWebhookRow | null {
	const row = getBotWebhookByIdStmt.get(id, botId) as BotWebhookRow | undefined;
	return row ?? null;
}

/** Delete a webhook (and its deliveries via cascade).  Returns the
 * number of rows actually removed so callers can detect "tried to
 * delete a webhook that didn't belong to this bot." */
export function deleteBotWebhook(id: number, botId: number): number {
	const r = deleteBotWebhookStmt.run(id, botId);
	return Number(r.changes);
}

/** Append a delivery log entry + bump the parent webhook's
 * last_delivery / last_error fields so the bot owner's debug view
 * can show "last failed at X with error Y" without needing to query
 * the deliveries table for the latest row. */
export function recordBotWebhookDelivery(opts: {
	webhookId: number;
	payloadJson: string;
	postedText: string | null;
	error: string | null;
}): void {
	const ts = Date.now();
	insertBotWebhookDeliveryStmt.run(
		opts.webhookId,
		ts,
		opts.payloadJson,
		opts.postedText,
		opts.error,
	);
	updateBotWebhookStatusStmt.run(ts, opts.error, opts.webhookId);
}

/** Recent deliveries for the debug view, newest first.  Capped at
 * 50 by default; the table itself is capped at 100 by a trigger so
 * even a request for limit=999 returns at most 100. */
export function listBotWebhookDeliveries(
	webhookId: number,
	limit: number = 50,
): BotWebhookDeliveryRow[] {
	return listBotWebhookDeliveriesStmt.all(webhookId, limit) as BotWebhookDeliveryRow[];
}

// ─── Bot OUTBOUND webhooks (LLM-callable HTTP tools) ─────────────

/** A single LLM-callable parameter on an outbound webhook.  `in`
 * decides where the value goes: "url" → substituted into {placeholder}
 * tokens in the URL string, falling back to query-string append for
 * unmatched params; "body" → sent in the JSON body (POST only). */
export interface OutboundParam {
	name: string;
	description: string;
	required: boolean;
	in: "url" | "body";
}

/** A static HTTP header attached to every call (auth tokens etc.). */
export interface OutboundHeader {
	name: string;
	value: string;
}

export interface BotOutboundWebhookRow {
	id: number;
	bot_id: number;
	name: string;
	description: string;
	method: "GET" | "POST";
	url: string;
	params_json: string;   // JSON-encoded OutboundParam[]
	headers_json: string;  // JSON-encoded OutboundHeader[]
	created_at: number;
	last_called: number | null;
	last_error: string | null;
}

const insertBotOutboundWebhookStmt = db.prepare(`
	INSERT INTO bot_outbound_webhooks (
		bot_id, name, description, method, url, params_json, headers_json, created_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	RETURNING id, bot_id, name, description, method, url, params_json,
	          headers_json, created_at, last_called, last_error
`);

const listBotOutboundWebhooksStmt = db.prepare(`
	SELECT id, bot_id, name, description, method, url, params_json,
	       headers_json, created_at, last_called, last_error
	FROM bot_outbound_webhooks
	WHERE bot_id = ?
	ORDER BY created_at ASC
`);

const getBotOutboundWebhookByIdStmt = db.prepare(`
	SELECT id, bot_id, name, description, method, url, params_json,
	       headers_json, created_at, last_called, last_error
	FROM bot_outbound_webhooks
	WHERE id = ? AND bot_id = ?
`);

const updateBotOutboundWebhookStmt = db.prepare(`
	UPDATE bot_outbound_webhooks
	SET name         = COALESCE(?, name),
	    description  = COALESCE(?, description),
	    method       = COALESCE(?, method),
	    url          = COALESCE(?, url),
	    params_json  = COALESCE(?, params_json),
	    headers_json = COALESCE(?, headers_json)
	WHERE id = ? AND bot_id = ?
`);

const deleteBotOutboundWebhookStmt = db.prepare(`
	DELETE FROM bot_outbound_webhooks WHERE id = ? AND bot_id = ?
`);

const recordBotOutboundCallStmt = db.prepare(`
	UPDATE bot_outbound_webhooks
	SET last_called = ?, last_error = ?
	WHERE id = ?
`);

/** Create a new outbound webhook (LLM-callable HTTP tool) for a bot. */
export function insertBotOutboundWebhook(opts: {
	botId: number;
	name: string;
	description: string;
	method: "GET" | "POST";
	url: string;
	params: OutboundParam[];
	headers: OutboundHeader[];
}): BotOutboundWebhookRow {
	return insertBotOutboundWebhookStmt.get(
		opts.botId,
		opts.name,
		opts.description,
		opts.method,
		opts.url,
		JSON.stringify(opts.params),
		JSON.stringify(opts.headers),
		Date.now(),
	) as BotOutboundWebhookRow;
}

export function listBotOutboundWebhooks(botId: number): BotOutboundWebhookRow[] {
	return listBotOutboundWebhooksStmt.all(botId) as BotOutboundWebhookRow[];
}

export function getBotOutboundWebhookById(
	id: number,
	botId: number,
): BotOutboundWebhookRow | null {
	const row = getBotOutboundWebhookByIdStmt.get(id, botId) as BotOutboundWebhookRow | undefined;
	return row ?? null;
}

export function updateBotOutboundWebhook(
	id: number,
	botId: number,
	patch: {
		name?: string;
		description?: string;
		method?: "GET" | "POST";
		url?: string;
		params?: OutboundParam[];
		headers?: OutboundHeader[];
	},
): void {
	updateBotOutboundWebhookStmt.run(
		patch.name ?? null,
		patch.description ?? null,
		patch.method ?? null,
		patch.url ?? null,
		patch.params !== undefined ? JSON.stringify(patch.params) : null,
		patch.headers !== undefined ? JSON.stringify(patch.headers) : null,
		id,
		botId,
	);
}

export function deleteBotOutboundWebhook(id: number, botId: number): number {
	const r = deleteBotOutboundWebhookStmt.run(id, botId);
	return r.changes;
}

/** Stamp the call counter + last error after each invocation.
 * `error` null on success.  Used by the deliveries-style debug view. */
export function recordBotOutboundCall(id: number, error: string | null): void {
	recordBotOutboundCallStmt.run(Date.now(), error, id);
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
	/** Spending guardrails — see migration in the schema block.
	 * 0 means "no limit" for all three. */
	max_tokens_per_reply: number;
	daily_token_limit: number;
	daily_call_limit: number;
	/** Whether this bot accepts DM-shaped invites from non-owners.
	 * 1 = open to anyone (default, matches pre-migration behaviour),
	 * 0 = bot leaves any DM invite from a user other than its owner.
	 * Group-room invites have a separate, stricter rule: only the
	 * owner can pull a bot into a group room, regardless of this flag. */
	accept_dms: number;
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
		 access_token_enc, device_id, enabled, created_at, triggers,
		 max_tokens_per_reply, daily_token_limit, daily_call_limit)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
`);
const listBotsByOwnerStmt = db.prepare(
	`SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at ASC`,
);
const listAllBotMxidsStmt = db.prepare(
	`SELECT mxid FROM bots WHERE enabled = 1`,
);
const listAllBotsPublicStmt = db.prepare(
	`SELECT mxid, display_name, avatar_mxc, owner_id, accept_dms FROM bots WHERE enabled = 1 ORDER BY display_name COLLATE NOCASE ASC`,
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
		display_name         = COALESCE(?, display_name),
		avatar_mxc           = COALESCE(?, avatar_mxc),
		provider             = COALESCE(?, provider),
		api_base             = COALESCE(?, api_base),
		api_key_enc          = COALESCE(?, api_key_enc),
		model                = COALESCE(?, model),
		system_prompt        = COALESCE(?, system_prompt),
		context_window       = COALESCE(?, context_window),
		enabled              = COALESCE(?, enabled),
		triggers             = COALESCE(?, triggers),
		max_tokens_per_reply = COALESCE(?, max_tokens_per_reply),
		daily_token_limit    = COALESCE(?, daily_token_limit),
		daily_call_limit     = COALESCE(?, daily_call_limit),
		accept_dms           = COALESCE(?, accept_dms)
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
	max_tokens_per_reply?: number;
	daily_token_limit?: number;
	daily_call_limit?: number;
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
		opts.max_tokens_per_reply ?? 0,
		opts.daily_token_limit ?? 0,
		opts.daily_call_limit ?? 0,
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

export interface PublicBotEntry {
	mxid: string;
	display_name: string;
	avatar_mxc: string | null;
	owner_id: string;
	/** True iff the bot's `accept_dms` flag is on (1).  Lets callers
	 * (the StartDmSheet) hide bots that opted out of cross-user DMs
	 * without exposing the underlying integer column directly. */
	accept_dms: boolean;
}

/** Public roster entry — one row per enabled bot with just the
 * fields safe to expose unauthenticated.  Powers the invite picker's
 * "show local bots even before they're in any room" behaviour, which
 * Synapse's user-directory can't do for fresh bots that haven't
 * joined anything yet.  We also include owner_id and accept_dms here
 * (both are already publicly inferrable: owner_id via /api/bots/by-mxid,
 * accept_dms via "try to DM and watch the bot leave") so the InviteSheet
 * + StartDmSheet can pre-filter the dropdown rather than offering
 * non-functional rows the user clicks just to get rejected. */
export function listAllBotsPublic(): PublicBotEntry[] {
	return (listAllBotsPublicStmt.all() as Array<{
		mxid: string;
		display_name: string;
		avatar_mxc: string | null;
		owner_id: string;
		accept_dms: number;
	}>).map(r => ({
		mxid: r.mxid,
		display_name: r.display_name,
		avatar_mxc: r.avatar_mxc,
		owner_id: r.owner_id,
		accept_dms: r.accept_dms !== 0,
	}));
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
	max_tokens_per_reply?: number;
	daily_token_limit?: number;
	daily_call_limit?: number;
	accept_dms?: 0 | 1;
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
		patch.max_tokens_per_reply ?? null,
		patch.daily_token_limit ?? null,
		patch.daily_call_limit ?? null,
		patch.accept_dms ?? null,
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
	// Mirror into today's rolling-usage row so the daily-limit
	// guardrails see this call.  Cheap upsert on (bot_id, day);
	// we deliberately keep it inside the same helper so callers
	// can't update lifetime stats and forget today's.
	bumpBotDailyUsage(id, promptTokens, completionTokens);
}

// ─── Per-bot daily usage (rolling) ─────────────────────────────────
//
// Used to enforce the bot's `daily_token_limit` / `daily_call_limit`
// guardrails.  Day key is `YYYY-MM-DD` in UTC so a single global day
// boundary applies regardless of where the bot's owner happens to
// be — we'd rather have predictable ledger boundaries than a
// timezone-aware accounting that drifts with DST.

/** Today's UTC date as `YYYY-MM-DD`.  Stable across the engine
 * process for any callers that need to reuse the same key in a hot
 * loop. */
export function utcDayKey(now: number = Date.now()): string {
	return new Date(now).toISOString().slice(0, 10);
}

const getBotDailyUsageStmt = db.prepare(
	`SELECT calls, prompt_tokens, completion_tokens
	   FROM bot_usage_daily
	  WHERE bot_id = ? AND day = ?`,
);
const upsertBotDailyUsageStmt = db.prepare(`
	INSERT INTO bot_usage_daily (bot_id, day, calls, prompt_tokens, completion_tokens)
	VALUES (?, ?, ?, ?, ?)
	ON CONFLICT(bot_id, day) DO UPDATE SET
		calls             = bot_usage_daily.calls             + excluded.calls,
		prompt_tokens     = bot_usage_daily.prompt_tokens     + excluded.prompt_tokens,
		completion_tokens = bot_usage_daily.completion_tokens + excluded.completion_tokens
`);

export interface BotDailyUsage {
	calls: number;
	prompt_tokens: number;
	completion_tokens: number;
}

/** Return today's accumulated usage for a bot.  Defaults to zeros
 * when the row doesn't exist yet (the first call of the day) — keeps
 * the limit-check call site branch-free. */
export function getBotDailyUsage(id: number, day: string = utcDayKey()): BotDailyUsage {
	const row = getBotDailyUsageStmt.get(id, day) as
		| { calls: number; prompt_tokens: number; completion_tokens: number }
		| undefined;
	return row ?? { calls: 0, prompt_tokens: 0, completion_tokens: 0 };
}

/** Bump today's usage row.  All four counters are added (calls
 * always +1 on a successful LLM call; tokens come from the response
 * usage block).  Atomic upsert so concurrent mentions can't lose
 * each other's increments. */
export function bumpBotDailyUsage(
	id: number,
	promptTokens: number,
	completionTokens: number,
	day: string = utcDayKey(),
): void {
	upsertBotDailyUsageStmt.run(id, day, 1, promptTokens, completionTokens);
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

// ─── Room members ─────────────────────────────────────────────────
//
// Real-time membership index, populated from m.room.member state
// events.  Used by the notification engine for DM detection +
// localpart→mxid resolution.  See aggregate.ts handleMember.

const upsertRoomMemberStmt = db.prepare(`
	INSERT INTO room_members (room_id, user_id, membership, last_updated)
	VALUES (?, ?, ?, ?)
	ON CONFLICT(room_id, user_id) DO UPDATE SET
		membership   = excluded.membership,
		last_updated = excluded.last_updated
`);

const joinedMembersStmt = db.prepare(`
	SELECT user_id FROM room_members
	WHERE room_id = ? AND membership = 'join'
`);

const joinedMemberCountStmt = db.prepare(`
	SELECT COUNT(*) AS n FROM room_members
	WHERE room_id = ? AND membership = 'join'
`);

export function upsertRoomMember(opts: {
	roomId: string;
	userId: string;
	membership: string;
	ts: number;
}): void {
	upsertRoomMemberStmt.run(opts.roomId, opts.userId, opts.membership, opts.ts);
}

/** All currently-joined members of a room.  Used by the notification
 * fan-out to know who to potentially notify on a message event. */
export function listJoinedRoomMembers(roomId: string): string[] {
	const rows = joinedMembersStmt.all(roomId) as Array<{ user_id: string }>;
	return rows.map(r => r.user_id);
}

/** Joined member count for DM detection.  Two-and-only-two joined
 * members + room is_direct = DM, but we don't have is_direct on the
 * engine side; member count is the strongest signal we have without
 * per-user account data. */
export function joinedMemberCount(roomId: string): number {
	const row = joinedMemberCountStmt.get(roomId) as { n: number } | undefined;
	return row?.n ?? 0;
}

// ─── Notifications ────────────────────────────────────────────────
//
// In-app notification log.  Written by the notification fan-out in
// aggregate.ts whenever an event matches a recipient's notification
// criteria; read/marked/cleared via the /api/notifications surface.

const insertNotificationStmt = db.prepare(`
	INSERT OR IGNORE INTO notifications
		(user_id, event_id, room_id, kind, sender, snippet, created_at)
	VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const listNotificationsStmt = db.prepare(`
	SELECT id, user_id, event_id, room_id, kind, sender, snippet, created_at, read_at
	FROM notifications
	WHERE user_id = ? AND created_at < ?
	ORDER BY created_at DESC
	LIMIT ?
`);

const unreadCountStmt = db.prepare(`
	SELECT COUNT(*) AS n FROM notifications
	WHERE user_id = ? AND read_at IS NULL
`);

const markNotificationReadStmt = db.prepare(`
	UPDATE notifications SET read_at = ?
	WHERE id = ? AND user_id = ? AND read_at IS NULL
`);

const markAllNotificationsReadStmt = db.prepare(`
	UPDATE notifications SET read_at = ?
	WHERE user_id = ? AND read_at IS NULL
`);

const markRoomNotificationsReadStmt = db.prepare(`
	UPDATE notifications SET read_at = ?
	WHERE user_id = ? AND room_id = ? AND read_at IS NULL
`);

const deleteNotificationStmt = db.prepare(`
	DELETE FROM notifications WHERE id = ? AND user_id = ?
`);

const deleteAllNotificationsStmt = db.prepare(`
	DELETE FROM notifications WHERE user_id = ?
`);

export interface NotificationRow {
	id: number;
	user_id: string;
	event_id: string;
	room_id: string;
	kind: "dm" | "mention" | "reply" | "invite" | "system" | "message";
	sender: string;
	snippet: string | null;
	created_at: number;
	read_at: number | null;
}

/** Insert a notification.  Idempotent — UNIQUE(user_id, event_id)
 * absorbs the duplicate when a re-delivered transaction or a
 * backfill scan tries to write the same row again.  Caller should
 * have already filtered out self-notifications (recipient == sender)
 * and bot recipients. */
export function insertNotification(opts: {
	userId: string;
	eventId: string;
	roomId: string;
	kind: NotificationRow["kind"];
	sender: string;
	snippet: string | null;
	createdAt: number;
}): void {
	insertNotificationStmt.run(
		opts.userId,
		opts.eventId,
		opts.roomId,
		opts.kind,
		opts.sender,
		opts.snippet,
		opts.createdAt,
	);
}

const recentUnreadFromSenderStmt = db.prepare(`
	SELECT created_at FROM notifications
	WHERE user_id = ? AND room_id = ? AND sender = ? AND read_at IS NULL
	ORDER BY created_at DESC
	LIMIT 1
`);

/** Look up the timestamp of the most recent UNREAD notification for
 * a (recipient, room, sender) triple.  Returns null when there isn't
 * one.
 *
 * Used by the fan-out path to coalesce bursts: voice/video calls in
 * encrypted DMs trickle ~1 m.call.candidates event per ~1.5s, all of
 * which look identical to the engine (m.room.encrypted with no
 * readable content) and would otherwise turn into a steady drip of
 * "Alice sent you a DM" bell entries through the entire call.
 *
 * The bell semantically already says "you have unread in this room";
 * adding another row for the same sender within the same minute
 * doesn't tell the user anything they don't already know — they'll
 * see the latest message when they open the room.  Real chat bursts
 * (someone fires off five DMs in a row) get exactly one bell row
 * and one OS notification, which matches the user's mental model. */
export function recentUnreadFromSender(
	userId: string,
	roomId: string,
	sender: string,
): number | null {
	const row = recentUnreadFromSenderStmt.get(userId, roomId, sender) as
		| { created_at: number }
		| undefined;
	return row?.created_at ?? null;
}

/** Paginated list, newest first.  `before` is the exclusive upper
 * bound on `created_at` — pass Number.MAX_SAFE_INTEGER for the first
 * page, then the last row's `created_at` for the next. */
export function listNotifications(opts: {
	userId: string;
	limit: number;
	before: number;
}): NotificationRow[] {
	return listNotificationsStmt.all(opts.userId, opts.before, opts.limit) as NotificationRow[];
}

export function unreadNotificationCount(userId: string): number {
	const row = unreadCountStmt.get(userId) as { n: number } | undefined;
	return row?.n ?? 0;
}

/** Returns true if a row was updated (notification existed + was
 * unread); false if it didn't exist, was already read, or belonged
 * to a different user.  Caller can treat `false` as a no-op success
 * — the desired end state ("user no longer sees this as unread") is
 * already true regardless. */
export function markNotificationRead(opts: {
	id: number;
	userId: string;
	readAt: number;
}): boolean {
	const r = markNotificationReadStmt.run(opts.readAt, opts.id, opts.userId);
	return r.changes > 0;
}

export function markAllNotificationsRead(userId: string, readAt: number): number {
	const r = markAllNotificationsReadStmt.run(readAt, userId);
	return Number(r.changes);
}

/** Mark every unread notification in `roomId` as read for `userId`.
 * Used by the bell when the user enters a room while focused — they
 * see messages land in real time, so accumulating unread for the
 * room they're literally watching reads as broken UX.  Returns the
 * count updated. */
export function markRoomNotificationsRead(opts: {
	userId: string;
	roomId: string;
	readAt: number;
}): number {
	const r = markRoomNotificationsReadStmt.run(opts.readAt, opts.userId, opts.roomId);
	return Number(r.changes);
}

export function deleteNotification(opts: { id: number; userId: string }): boolean {
	const r = deleteNotificationStmt.run(opts.id, opts.userId);
	return r.changes > 0;
}

export function deleteAllNotifications(userId: string): number {
	const r = deleteAllNotificationsStmt.run(userId);
	return Number(r.changes);
}

// ─── Founders ────────────────────────────────────────────────────────
//
// Lifetime cap on Founder badge claims.  First 666 users to sign up
// get an entry; everyone after is a regular user with no badge.
// The number is dramatic but deliberate (and matches the upstream
// product framing) — the cap exists in code rather than SQL so the
// table itself can store the canonical historical log without
// silently rejecting the 667th row at the DB layer.
const FOUNDER_CAP = 666;

const insertFounderStmt = db.prepare(`
	INSERT OR IGNORE INTO founders (user_id, claimed_at)
	VALUES (?, ?)
`);

const getFounderNumberStmt = db.prepare(`
	SELECT founder_number FROM founders WHERE user_id = ?
`);

const founderCountStmt = db.prepare(`
	SELECT COUNT(*) AS n FROM founders
`);

const allFoundersStmt = db.prepare(`
	SELECT user_id, founder_number FROM founders
	ORDER BY founder_number ASC
`);

/** Atomically claim a founder number for `userId` if there's still
 * room under the FOUNDER_CAP.  Returns the assigned number on a
 * fresh claim, the existing number if this user already has one
 * (idempotent — safe to call twice on signup retries), or null if
 * the cap has been reached.
 *
 * Uses a transaction so the count check and insert can't race
 * across two simultaneous signups landing at slot 666 vs 667.
 * SQLite's transaction is the cheapest serialization point for the
 * engine's single-process model.  AUTOINCREMENT gives us the
 * sequential id without needing to compute it; the count is just a
 * gate against admitting more rows than we want. */
export function claimFounderNumber(userId: string): number | null {
	// Fast path: already a founder.  Skips the transaction entirely
	// when this user is in the table — the common case for the
	// idempotent backfill / retry paths.
	const existing = getFounderNumberStmt.get(userId) as
		| { founder_number: number }
		| undefined;
	if (existing) return existing.founder_number;

	const tx = db.transaction((uid: string): number | null => {
		const row = founderCountStmt.get() as { n: number };
		if (row.n >= FOUNDER_CAP) return null;
		insertFounderStmt.run(uid, Date.now());
		const r = getFounderNumberStmt.get(uid) as
			| { founder_number: number }
			| undefined;
		return r?.founder_number ?? null;
	});
	return tx(userId);
}

/** Look up an existing founder number; null if this user isn't a
 * founder.  Cheap point query — used by the profile API and the
 * batch-roster endpoint. */
export function getFounderNumber(userId: string): number | null {
	const row = getFounderNumberStmt.get(userId) as
		| { founder_number: number }
		| undefined;
	return row?.founder_number ?? null;
}

/** Total founders claimed.  Drives the "X of 666" denominator on the
 * client badge tooltip, and the boot-backfill gate that only runs
 * when the table is empty. */
export function getFounderCount(): number {
	const row = founderCountStmt.get() as { n: number };
	return row.n;
}

/** Full ordered list of founders for the bulk-roster endpoint.
 * Tiny payload — capped at FOUNDER_CAP rows, two short fields each
 * — so the client can fetch once at boot and render badges from a
 * local Map without per-message round trips. */
export function listFounders(): { user_id: string; founder_number: number }[] {
	return allFoundersStmt.all() as { user_id: string; founder_number: number }[];
}

export const FOUNDER_CAP_PUBLIC = FOUNDER_CAP;

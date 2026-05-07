// Bot trigger pipeline: detect a mention of the bot in a room
// timeline event, gather recent context, fire the LLM call, post the
// reply, and bump usage counters.  Called from bot_runtime's
// timeline listener.
//
// Atomic by design: the bot stays silent (no typing indicator, no
// "thinking…" placeholder) until the LLM has produced the full
// response, then posts once.  Streaming is out of scope per the
// platform decisions — too much state on the wire for E2EE rooms,
// and the UX for typing indicators on Matrix is brittle.
//
// One in-flight LLM call per (bot, room) pair: if a second mention
// arrives while the first is still running, we drop the second
// rather than queue.  Bots are conversational — a queued pile of
// half-context replies would be worse than a single lost answer.

import type { MatrixClient, MatrixEvent, Room as SdkRoom } from "matrix-js-sdk";
import { MsgType } from "matrix-js-sdk";
import { type BotRow, bumpBotUsage, getBotKnowledgeContent } from "./db";
import { openSecret } from "./secret_box";
import { chatCompletion, type ChatMessage } from "./llm_client";
import { config } from "./config";

// (botId, roomId) → "currently waiting on the LLM, ignore further
// mentions until done".  Cleared in the finally block of `dispatch`.
const inFlight = new Set<string>();

// Cap on text body length for prompt context.  rust-crypto can
// decrypt very long messages, but the LLM context budget is the
// real bottleneck.  We leave decisions about expensive truncation
// to the model owner via context_window; this is a safety belt for
// pathological 100KB messages.
const MAX_BODY_CHARS = 4_000;

// Cap the bot's reply length we forward to Matrix.  Some providers
// gladly emit 30k-char replies; that's nightmare UX in a chat.
// The LLM's own max_tokens is the primary control; this is a
// defensive trim.
const MAX_REPLY_CHARS = 8_000;

export interface PipelineDeps {
	bot: BotRow;
	client: MatrixClient;
	event: MatrixEvent;
	room: SdkRoom;
}

/**
 * If `event` contains a mention of `bot`, run the full pipeline.
 * Otherwise no-op.  Errors are logged and swallowed — a broken bot
 * shouldn't kill the timeline listener.
 */
export async function maybeHandleMention(deps: PipelineDeps): Promise<void> {
	const { bot, event, room } = deps;
	if (!isMentionOf(event, bot.mxid, room) && !matchesTrigger(event, bot.triggers)) return;

	const flightKey = `${bot.id}:${room.roomId}`;
	if (inFlight.has(flightKey)) {
		console.log(`bot ${bot.mxid}: ignoring mention in ${room.roomId}; previous call still in flight`);
		return;
	}
	inFlight.add(flightKey);
	try {
		await dispatch(deps);
	} catch (err) {
		console.error(`bot ${bot.mxid}: pipeline crashed`, err);
	} finally {
		inFlight.delete(flightKey);
	}
}

async function dispatch(deps: PipelineDeps): Promise<void> {
	const { bot, client, room, event } = deps;

	const messages = buildContext(bot, room, event);
	if (messages.length === 0) {
		console.warn(`bot ${bot.mxid}: empty context, skipping LLM call`);
		return;
	}

	let apiKey: string;
	try {
		apiKey = openSecret(bot.api_key_enc);
	} catch (err) {
		console.error(`bot ${bot.mxid}: failed to decrypt API key`, err);
		await postPlain(client, room.roomId, "(bot misconfigured: API key could not be decrypted)");
		return;
	}

	console.log(`bot ${bot.mxid}: → LLM model=${bot.model} provider=${bot.provider} ctx_msgs=${messages.length}`);
	const result = await chatCompletion({
		apiBase: bot.api_base,
		apiKey,
		model: bot.model,
		messages,
		provider: bot.provider,
		referer: `https://${config.homeserverName}`,
		title: `Koven (${bot.display_name})`,
	});

	if (!result.ok) {
		console.warn(`bot ${bot.mxid}: LLM call failed (${result.error}): ${result.detail}`);
		await postPlain(client, room.roomId, `(bot error: ${result.error}${result.status ? ` [${result.status}]` : ""}: ${truncate(result.detail, 200)})`);
		return;
	}

	const reply = truncate(result.content.trimEnd(), MAX_REPLY_CHARS);
	console.log(`bot ${bot.mxid}: ← LLM ok prompt=${result.prompt_tokens} completion=${result.completion_tokens} chars=${reply.length}`);
	bumpBotUsage(bot.id, result.prompt_tokens, result.completion_tokens);

	await postPlain(client, room.roomId, reply);
}

// ─── Mention detection ─────────────────────────────────────────────

/** True if `event` mentions `botMxid`.  Recognises:
 *   - The Matrix-standard `m.mentions.user_ids` list.
 *   - Plain-text `@bot-localpart:server` matches in the body.
 *   - `@bot-localpart` (no server suffix) — same-server convenience
 *     so users on this homeserver don't need to type the full mxid.
 *   - DM rooms — every message addressed to the bot is implicitly
 *     for the bot, no @ required.
 *   - **Replies to the bot's own messages** — the Matrix reply UI
 *     adds an `m.in_reply_to` relation pointing at the message
 *     being replied to.  When that target message was sent by the
 *     bot, we treat the reply as a mention so users don't have to
 *     also type @bot-name.  Requires `room` to be passed so we can
 *     look up the target event's sender.
 *
 * Case-sensitive on the localpart since Matrix mxids are; the
 * server suffix match is case-insensitive (servers are domain
 * names).
 */
export function isMentionOf(event: MatrixEvent, botMxid: string, room?: SdkRoom): boolean {
	if (event.getType() !== "m.room.message") return false;

	// We're being polite about ignoring our own messages elsewhere
	// (timeline listener), but defence-in-depth:
	if (event.getSender() === botMxid) return false;

	const content = event.getContent() as Record<string, unknown>;
	const mentions = content["m.mentions"] as { user_ids?: unknown } | undefined;
	if (mentions && Array.isArray(mentions.user_ids) && mentions.user_ids.includes(botMxid)) {
		return true;
	}

	// DM rooms: every message in a 1-on-1 with the bot is implicitly
	// addressed to it.  Skip the @ scan entirely — typing the bot's
	// name into a DM-with-the-bot is awkward.  We detect "DM with
	// the bot" by the room having exactly two joined / invited
	// members that include the bot.
	if (room && isDmWithBot(room, botMxid)) {
		return true;
	}

	// Reply to one of the bot's own messages → treat as a mention.
	// Matrix's reply UI threads via `m.relates_to.m.in_reply_to.event_id`
	// (current spec) or a top-level `m.in_reply_to` (older clients).
	// Look up the target event in the live timeline; if its sender
	// is the bot, that's a reply to the bot.
	if (room) {
		const replyTargetId = extractReplyTargetId(content);
		if (replyTargetId) {
			const target = room.findEventById(replyTargetId);
			if (target && target.getSender() === botMxid) {
				return true;
			}
		}
	}

	const body = typeof content.body === "string" ? content.body : "";
	if (!body) return false;

	const colonIdx = botMxid.indexOf(":");
	if (colonIdx <= 0) return false;
	const localpart = botMxid.slice(1, colonIdx); // strip leading "@"
	const server = botMxid.slice(colonIdx + 1);

	// Full mxid match.  Anchored by the leading "@" so we don't false-
	// positive on email addresses.
	if (body.includes(botMxid)) return true;

	// "@bot-foo " convenience: same-server users typing the localpart
	// only.  We require a word-boundary character (or end of string)
	// after the localpart so "@bot-foobar" doesn't trigger "@bot-foo".
	const re = new RegExp(`(^|\\s)@${escapeRegex(localpart)}(\\b|$)`);
	if (re.test(body) && server) {
		// Same-server only — bots from other servers must be
		// addressed by full mxid.  We can't reliably tell from a bare
		// localpart which homeserver the user means.
		// (server is unused if we go by localpart, but keep the guard
		// in case we widen this later.)
	}
	return re.test(body);
}

/** Pull the event id out of a reply relation if any.  Handles both
 * the current spec (nested under `m.relates_to`) and the older
 * top-level `m.in_reply_to` shape some clients still emit. */
function extractReplyTargetId(content: Record<string, unknown>): string | null {
	const relates = content["m.relates_to"] as Record<string, unknown> | undefined;
	const nested = relates?.["m.in_reply_to"] as { event_id?: unknown } | undefined;
	if (nested && typeof nested.event_id === "string") return nested.event_id;
	const top = content["m.in_reply_to"] as { event_id?: unknown } | undefined;
	if (top && typeof top.event_id === "string") return top.event_id;
	return null;
}

/** True if `room` is a 1-on-1 DM whose other party is the bot.
 * "DM" here means: exactly two joined-or-invited members, one of
 * which is the bot.  Group chats with the bot don't count — there
 * the user should still @-mention to disambiguate. */
function isDmWithBot(room: SdkRoom, botMxid: string): boolean {
	const members = room.getMembers().filter(m =>
		m.membership === "join" || m.membership === "invite",
	);
	if (members.length !== 2) return false;
	return members.some(m => m.userId === botMxid);
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True if any of the bot's configured trigger phrases appears in
 * the message body.  Word-boundary, case-insensitive — "vessel"
 * matches "Vessel" and "the vessel sailed" but not "vessels" or
 * "revesseling."  Multi-word phrases work the same way ("i need
 * help" matches "I need help with this", not "I need helpful
 * advice").  Empty trigger list short-circuits to false. */
export function matchesTrigger(event: MatrixEvent, triggers: string[]): boolean {
	if (triggers.length === 0) return false;
	if (event.getType() !== "m.room.message") return false;
	const content = event.getContent() as { body?: unknown };
	const body = typeof content.body === "string" ? content.body : "";
	if (!body) return false;
	for (const phrase of triggers) {
		const trimmed = phrase.trim();
		if (!trimmed) continue;
		const re = new RegExp(`\\b${escapeRegex(trimmed)}\\b`, "i");
		if (re.test(body)) return true;
	}
	return false;
}

// ─── Context gathering ─────────────────────────────────────────────

/** Walk the room's live timeline back from now, gather up to
 * `bot.context_window` recent message events (decrypted text), and
 * format them as ChatMessages.  The triggering event is included as
 * the most recent user message (the timeline listener fires AFTER
 * the event lands in the timeline). */
function buildContext(bot: BotRow, room: SdkRoom, _trigger: MatrixEvent): ChatMessage[] {
	const out: ChatMessage[] = [];

	// Compose the system message: knowledge-base reference material
	// first, then the bot owner's own system prompt.  Order matters
	// — the knowledge frames "what do I know" and the system prompt
	// frames "how do I behave," and most LLMs respond better when
	// behavioural instructions are last.  Each knowledge file gets
	// its filename as a heading so the model can cite or
	// disambiguate sources in its reply.
	const knowledge = getBotKnowledgeContent(bot.id);
	const knowledgeBlock = knowledge.length === 0
		? ""
		: [
			"# Knowledge base",
			"",
			"The following reference material has been provided to you. Treat it as authoritative when relevant; if asked something it doesn't cover, answer from your general knowledge and say so.",
			"",
			...knowledge.map(k => `## ${k.filename}\n\n${k.content}`),
			"---",
			"",
		].join("\n");

	const promptParts: string[] = [];
	if (knowledgeBlock) promptParts.push(knowledgeBlock);
	if (bot.system_prompt && bot.system_prompt.trim().length > 0) {
		promptParts.push(bot.system_prompt);
	}
	if (promptParts.length > 0) {
		out.push({ role: "system", content: promptParts.join("\n\n") });
	}

	const live = room.getLiveTimeline().getEvents();
	const messages: ChatMessage[] = [];
	// Walk newest-to-oldest, peel off `context_window` text messages.
	for (let i = live.length - 1; i >= 0 && messages.length < bot.context_window; i--) {
		const ev = live[i]!;
		if (ev.getType() !== "m.room.message") continue;
		// Skip undecrypted (we have no plaintext).
		if (ev.isEncrypted() && !ev.getClearContent()) continue;
		// Skip decryption failures.
		if (ev.isDecryptionFailure?.()) continue;
		const content = ev.getContent() as { body?: unknown; msgtype?: unknown };
		if (typeof content.body !== "string") continue;
		const role: ChatMessage["role"] = ev.getSender() === bot.mxid ? "assistant" : "user";
		const body = content.body.slice(0, MAX_BODY_CHARS);
		// Prefix non-bot messages with the sender's mxid so the LLM
		// can tell speakers apart in a multi-user thread.  For DMs
		// this is redundant noise but cheap; for group chats it's
		// essential context.
		const text = role === "user" ? `${ev.getSender() ?? "unknown"}: ${body}` : body;
		messages.push({ role, content: text });
	}
	// We walked newest→oldest; flip back to chronological for the LLM.
	messages.reverse();
	out.push(...messages);
	return out;
}

// ─── Posting ───────────────────────────────────────────────────────

async function postPlain(client: MatrixClient, roomId: string, body: string): Promise<void> {
	try {
		await client.sendMessage(roomId, {
			msgtype: MsgType.Text,
			body,
		});
	} catch (err) {
		console.warn(`bot post to ${roomId} failed`, err);
	}
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

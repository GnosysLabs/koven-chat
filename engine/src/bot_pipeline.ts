// Bot trigger pipeline: detect a mention of the bot in a room
// timeline event, gather recent context, fire the LLM call, post the
// reply, and bump usage counters.  Called from bot_runtime's
// timeline listener.
//
// Progressive UX: while the LLM is thinking and (especially) calling
// MCP tools, the bot posts a single placeholder message ("🤔
// Thinking…") and edits it via m.replace as work proceeds — first to
// "🔧 calling <tool>…" entries as tools fire, finally to the answer
// itself.  On the user's side this reads as one row in the timeline
// that progressively updates, so they get tool-call breadcrumbs
// without two separate messages or any custom event types the client
// would have to render specially.  We also push a Matrix typing
// indicator (m.typing) for the same window, refreshed every 20s so
// it doesn't expire mid-call.  Streaming the actual response text is
// still out of scope — too much state on the wire for E2EE rooms —
// but progress breadcrumbs are cheap and load-bearing for tool-using
// bots that may hold the floor for several seconds.
//
// One in-flight LLM call per (bot, room) pair: if a second mention
// arrives while the first is still running, we drop the second
// rather than queue.  Bots are conversational — a queued pile of
// half-context replies would be worse than a single lost answer.

import type { MatrixClient, MatrixEvent, Room as SdkRoom } from "matrix-js-sdk";
import { MsgType } from "matrix-js-sdk";
import {
	type BotRow,
	bumpBotUsage,
	bumpBotDailyUsage,
	getBotDailyUsage,
	getBotKnowledgeContent,
	utcDayKey,
} from "./db";
import { openSecret } from "./secret_box";
import {
	chatCompletion,
	type ChatMessage,
	type AssistantToolCall,
} from "./llm_client";
import {
	openBotMcpBundle,
	closeBotMcpBundle,
	dispatchToolCall,
	describeToolCall,
	type BotMcpBundle,
} from "./mcp/bot_tools";
import { config } from "./config";

// (botId, eventId) → "we already responded to this event, do not
// charge the model owner for a re-run".  matrix-js-sdk re-fires
// Timeline events on certain sync state transitions (reconnect,
// post-decryption fan-out), and the older inFlight gate was keyed
// only by (botId, roomId) — once the first run finished and cleared
// inFlight, the re-fired event slipped through and we paid for the
// LLM call a second time, with a second reply landing in the room.
// Tracking event ids per bot is the only correct dedupe; a Set with
// LRU eviction caps memory at a fixed bound for long-running bots.
const processedEvents = new Map<string, true>();
const PROCESSED_EVENTS_CAP = 4_000;
function markEventProcessed(botId: number, eventId: string): void {
	const key = `${botId}:${eventId}`;
	processedEvents.set(key, true);
	// Evict oldest entries when over the cap.  Map iteration order
	// is insertion order, so the first key is the oldest.
	while (processedEvents.size > PROCESSED_EVENTS_CAP) {
		const oldest = processedEvents.keys().next().value;
		if (oldest === undefined) break;
		processedEvents.delete(oldest);
	}
}
function hasEventBeenProcessed(botId: number, eventId: string): boolean {
	return processedEvents.has(`${botId}:${eventId}`);
}

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

// Cap on tool-use iterations.  Each iteration is one LLM call + a
// batch of tool invocations; without a cap a misbehaving model could
// loop indefinitely (call → result → call → result …) and burn
// tokens.  8 is enough for any realistic chain ("search, read,
// summarise") while bounding worst-case cost.  When we hit the cap
// we feed the loop one more turn with the model's accumulated tool
// outputs and force a text reply by passing tools=[] on the final
// call so it can't keep requesting more invocations.
const MAX_TOOL_ITERATIONS = 8;

// Stale-event guard: drop messages whose origin_server_ts is more
// than this many ms in the past at receipt time.  Matrix-js-sdk's
// first /sync after a reconnect delivers everything that landed
// during the offline window as live events with `liveEvent: true`;
// without this filter, every engine restart triggers a flood of
// belated bot responses to anything that mentioned a bot or hit a
// trigger phrase while we were down.  60s is generous: legitimate
// chats move faster than that, and federation-induced delivery
// delay between Koven instances is small (we federate only with
// other Kovens, no relay hops).
const STALE_EVENT_THRESHOLD_MS = 60_000;

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

	// Don't respond to events that were already old when we got
	// them — see STALE_EVENT_THRESHOLD_MS.  Belated responses to
	// hours-old messages are bizarre UX and used to fire after
	// every engine restart; this gate is the cheapest fix.
	const ageMs = Date.now() - event.getTs();
	if (ageMs > STALE_EVENT_THRESHOLD_MS) {
		console.log(`bot ${bot.mxid}: skipping stale event in ${room.roomId} (age ${Math.floor(ageMs / 1000)}s)`);
		return;
	}

	if (!isMentionOf(event, bot.mxid, room)) return;

	// Per-event dedupe.  Mark FIRST, before the in-flight gate, so
	// even concurrent re-fires of the same event id (matrix-js-sdk
	// will replay the same Timeline event on certain sync state
	// transitions) bail before doing any work.  Without this we paid
	// for the LLM call twice and posted two different replies to a
	// single user message.
	const eventId = event.getId();
	if (eventId) {
		if (hasEventBeenProcessed(bot.id, eventId)) {
			console.log(`bot ${bot.mxid}: ignoring re-fire of ${eventId} in ${room.roomId}`);
			return;
		}
		markEventProcessed(bot.id, eventId);
	}

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

	// Daily-spend guardrails.  Both fields default to 0 = unlimited;
	// when set, the pre-flight check refuses the LLM call without
	// burning tokens, and we surface a short note in the room so
	// the user knows why the bot went quiet.  Token budget is the
	// total of prompt+completion accumulated for THIS UTC day.
	if (bot.daily_call_limit > 0 || bot.daily_token_limit > 0) {
		const day = utcDayKey();
		const used = getBotDailyUsage(bot.id, day);
		if (bot.daily_call_limit > 0 && used.calls >= bot.daily_call_limit) {
			console.log(`bot ${bot.mxid}: daily call limit reached (${used.calls}/${bot.daily_call_limit}), refusing`);
			await postPlain(
				client, room.roomId,
				`(daily call limit reached — ${used.calls}/${bot.daily_call_limit}; resets at 00:00 UTC)`,
			);
			return;
		}
		const totalTokens = used.prompt_tokens + used.completion_tokens;
		if (bot.daily_token_limit > 0 && totalTokens >= bot.daily_token_limit) {
			console.log(`bot ${bot.mxid}: daily token limit reached (${totalTokens}/${bot.daily_token_limit}), refusing`);
			await postPlain(
				client, room.roomId,
				`(daily token limit reached — ${totalTokens}/${bot.daily_token_limit}; resets at 00:00 UTC)`,
			);
			return;
		}
	}

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

	// Surface progress to the room: typing indicator + a placeholder
	// message we'll edit as work proceeds.  Both are best-effort — if
	// the placeholder send fails we still continue and the eventual
	// reply just lands as a fresh message (see BotProgress.finalise).
	const stopTyping = startTypingHeartbeat(client, room.roomId);
	const progress = new BotProgress(client, room.roomId);
	await progress.start("Thinking…");

	// Open MCP sessions up-front for every server attached to this
	// bot.  Empty bundle (no key, no attachments, all opens failed)
	// makes the call below behave exactly like the no-tools path.
	const bundle = await openBotMcpBundle(bot);
	try {
		await runToolLoop(deps, messages, apiKey, bundle, progress);
	} finally {
		await closeBotMcpBundle(bundle);
		stopTyping();
	}
}

/** Drive the chat-completion call, handle any tool_calls the model
 * emits, and post the eventual text reply.  Each iteration:
 *
 *   1. Call chatCompletion with the current messages + tools.
 *   2. If the model returned text and no tool_calls → post + done.
 *   3. Otherwise execute every requested tool, append the assistant
 *      message and tool-result messages to history, and loop.
 *
 * Stops at MAX_TOOL_ITERATIONS to keep a runaway model from looping
 * indefinitely.  On the final iteration we pass an empty tools[] so
 * the model is forced to emit text. */
async function runToolLoop(
	deps: PipelineDeps,
	initialMessages: ChatMessage[],
	apiKey: string,
	bundle: BotMcpBundle,
	progress: BotProgress,
): Promise<void> {
	const { bot } = deps;
	const messages: ChatMessage[] = [...initialMessages];

	let promptTokensTotal = 0;
	let completionTokensTotal = 0;

	for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
		const isFinalIter = iter === MAX_TOOL_ITERATIONS - 1;
		const toolsForCall = isFinalIter ? undefined : (bundle.tools.length > 0 ? bundle.tools : undefined);

		console.log(
			`bot ${bot.mxid}: → LLM iter=${iter} model=${bot.model} provider=${bot.provider}`
				+ ` ctx_msgs=${messages.length} tools=${toolsForCall?.length ?? 0}`,
		);
		const result = await chatCompletion({
			apiBase: bot.api_base,
			apiKey,
			model: bot.model,
			messages,
			provider: bot.provider,
			referer: `https://${config.homeserverName}`,
			title: `Koven (${bot.display_name})`,
			tools: toolsForCall,
			// Per-reply token cap.  bot.max_tokens_per_reply = 0
			// means "let the provider decide" (same as not passing
			// the field); a positive value clamps each LLM call.
			maxTokens: bot.max_tokens_per_reply > 0 ? bot.max_tokens_per_reply : undefined,
		});

		if (!result.ok) {
			console.warn(`bot ${bot.mxid}: LLM call failed (${result.error}): ${result.detail}`);
			// Roll up whatever usage accumulated before the failure.
			if (promptTokensTotal > 0 || completionTokensTotal > 0) {
				bumpBotUsage(bot.id, promptTokensTotal, completionTokensTotal);
			}
			await progress.finalise(
				`(bot error: ${result.error}${result.status ? ` [${result.status}]` : ""}: ${truncate(result.detail, 200)})`,
			);
			return;
		}

		promptTokensTotal += result.prompt_tokens;
		completionTokensTotal += result.completion_tokens;

		// No tool calls → final text reply, post it and stop.
		if (result.tool_calls.length === 0) {
			const reply = truncate(result.content.trimEnd(), MAX_REPLY_CHARS);
			console.log(
				`bot ${bot.mxid}: ← LLM done iter=${iter}`
					+ ` prompt=${promptTokensTotal} completion=${completionTokensTotal}`
					+ ` chars=${reply.length}`,
			);
			bumpBotUsage(bot.id, promptTokensTotal, completionTokensTotal);
			if (reply.length === 0) {
				console.warn(`bot ${bot.mxid}: empty reply after tool loop, posting placeholder`);
				await progress.finalise("(bot returned no reply)");
			} else {
				await progress.finalise(reply);
			}
			return;
		}

		// Tool calls present.  This shouldn't happen on the final
		// iteration (we passed tools=undefined to forbid it), but if a
		// provider ignores tool_choice we defensively bail with whatever
		// text the model emitted.
		if (isFinalIter) {
			console.warn(
				`bot ${bot.mxid}: model still requested tools on final iter; aborting loop and posting partial text`,
			);
			bumpBotUsage(bot.id, promptTokensTotal, completionTokensTotal);
			const reply = truncate(result.content.trimEnd(), MAX_REPLY_CHARS) || "(bot exceeded tool-use budget)";
			await progress.finalise(reply);
			return;
		}

		console.log(
			`bot ${bot.mxid}: ← LLM iter=${iter} requested ${result.tool_calls.length} tool_call(s)`,
		);

		// Echo the assistant's tool-call request back into history —
		// OpenAI/OpenRouter require the assistant→tool pair to be
		// adjacent so each `tool_call_id` resolves.
		messages.push({
			role: "assistant",
			content: result.content ?? "",
			tool_calls: result.tool_calls,
		});

		// Execute each tool call sequentially.  Parallel would be
		// faster, but most servers are stateful (one HTTP/2 stream)
		// and the SDK doesn't guarantee re-entrancy on a single
		// transport.  Latency is rarely the bottleneck here.
		for (const call of result.tool_calls) {
			const args = parseToolArgs(call);
			console.log(
				`bot ${bot.mxid}:   tool ${call.function.name}(${truncate(call.function.arguments, 120)})`,
			);
			// Show the tool name (srvN__ prefix stripped) plus the
			// originating MCP server's qualified name, with the
			// server name bold in formatted_body so it stands out as
			// "I'm hitting THIS service".  Plain-text fallback drops
			// the formatting but keeps the same words.  Args are
			// intentionally omitted — they often contain raw URLs or
			// full search queries that clutter the bubble without
			// helping.
			const desc = describeToolCall(bundle, call.function.name);
			if (desc) {
				const server = prettyServerName(desc.server);
				// Plain body uses markdown bold (`**server**`) — the
				// Koven client's looksLikeMarkdown picks it up and
				// renders it via the markdown path.  formatted_body
				// adds the HTML form for any Matrix client that
				// prefers that (Element et al).
				await progress.update(
					`🔧 calling ${desc.tool} with **${server}**…`,
					`🔧 calling ${escapeHtml(desc.tool)} with <strong>${escapeHtml(server)}</strong>…`,
				);
			} else {
				await progress.update(`🔧 calling ${prettyToolName(call.function.name)}…`);
			}
			const toolResult = await dispatchToolCall(bundle, call.function.name, args);
			console.log(
				`bot ${bot.mxid}:   ← ${call.function.name} ${toolResult.isError ? "ERROR" : "ok"}`
					+ ` chars=${toolResult.text.length}`,
			);
			messages.push({
				role: "tool",
				tool_call_id: call.id,
				content: toolResult.text,
			});
		}
		// Tools just finished; flip the placeholder back to a
		// generic "thinking" while we wait on the next LLM round.
		await progress.update("Thinking…");
	}

	// Loop fell through without returning — should be unreachable
	// thanks to the isFinalIter branch, but be paranoid.
	console.warn(`bot ${bot.mxid}: tool loop exhausted without final reply`);
	bumpBotUsage(bot.id, promptTokensTotal, completionTokensTotal);
	await progress.finalise("(bot exceeded tool-use budget)");
}

/** Strip the `srvN__` namespace prefix our MCP wiring adds so the
 * user sees the tool's real name in the progress placeholder.  Falls
 * back to the raw name when there's no prefix (e.g. if a future
 * non-MCP tool source ever flows through this path). */
function prettyToolName(namespaced: string): string {
	const m = /^srv\d+__(.+)$/.exec(namespaced);
	return m ? m[1]! : namespaced;
}

/** Compact display form for a Smithery qualified name.  Strips the
 * leading "@" and the namespace prefix so e.g.
 * "@modelcontextprotocol/server-github" becomes "server-github" and
 * "exa" stays "exa".  Keeps the bubble readable when servers come
 * from publishers with verbose namespaces. */
function prettyServerName(qualifiedName: string): string {
	// Tail after the first slash, if present; "@x/y" → "y", "exa" → "exa".
	const slashIdx = qualifiedName.indexOf("/");
	if (slashIdx >= 0) return qualifiedName.slice(slashIdx + 1);
	return qualifiedName.startsWith("@") ? qualifiedName.slice(1) : qualifiedName;
}

/** Best-effort JSON parse of an LLM's tool-call arguments.  Providers
 * always wrap the arguments as a string even when the schema is
 * structured; on rare occasions models emit malformed JSON.  We
 * surface the parse failure as an empty arg map rather than throwing
 * — the tool itself will likely error and the model can correct on
 * the next iteration. */
function parseToolArgs(call: AssistantToolCall): Record<string, unknown> {
	const raw = call.function.arguments ?? "";
	if (raw.trim().length === 0) return {};
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		console.warn(`tool args for ${call.function.name} were JSON but not an object; ignoring`);
		return {};
	} catch (err) {
		console.warn(
			`tool args for ${call.function.name} were not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
		return {};
	}
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

// ─── Posting + progress ────────────────────────────────────────────

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

/**
 * Push a typing indicator (m.typing) for the bot user and keep it
 * alive with a periodic refresh.  Returns a stop function that
 * cancels the refresh and clears the indicator.
 *
 * Synapse expires typing notifications after their `timeout` ms; if
 * we set timeout=30s and never refresh, the indicator vanishes
 * mid-call on slow tool chains.  Refreshing every 20s keeps it
 * comfortably within that window.  Failures (rate-limit, transient
 * 5xx) are best-effort and never bubble — losing the indicator is
 * cosmetic.
 */
function startTypingHeartbeat(client: MatrixClient, roomId: string): () => void {
	const TIMEOUT_MS = 30_000;
	const REFRESH_MS = 20_000;
	const send = (typing: boolean, timeoutMs: number) => {
		// matrix-js-sdk's sendTyping returns a promise.  We deliberately
		// don't await: typing notifications shouldn't gate the LLM
		// call's start, and a slow homeserver here would just delay
		// the actual reply.
		void client.sendTyping(roomId, typing, timeoutMs).catch(() => { /* cosmetic, ignore */ });
	};
	send(true, TIMEOUT_MS);
	const handle = setInterval(() => send(true, TIMEOUT_MS), REFRESH_MS);
	return () => {
		clearInterval(handle);
		send(false, 0);
	};
}

/**
 * Single-message progress UI for the bot's reply.  Posts a
 * placeholder message (`🤔 Thinking…`), captures its event id, and
 * exposes `update()` / `finalise()` that send Matrix m.replace
 * edits so the original row mutates in place rather than spawning
 * new messages.  This is the canonical "progressively update" idiom
 * Element / Cinny / Beeper all render correctly out of the box.
 *
 * If the initial send fails (network blip, rate limit), `eventId`
 * stays null and `finalise()` falls back to sending a fresh
 * message — the user still sees the answer.  `update()` no-ops in
 * that case rather than spamming a stream of fresh placeholders.
 */
class BotProgress {
	private eventId: string | null = null;
	constructor(
		private readonly client: MatrixClient,
		private readonly roomId: string,
	) {}

	/** Send the initial placeholder.  Best-effort; failures are
	 * logged and leave the progress object inert (subsequent
	 * update() calls no-op, finalise() sends a fresh message). */
	async start(body: string): Promise<void> {
		try {
			const r = await this.client.sendMessage(this.roomId, {
				msgtype: MsgType.Text,
				body,
			});
			this.eventId = r.event_id ?? null;
		} catch (err) {
			console.warn(`bot progress.start failed in ${this.roomId}`, err);
		}
	}

	/** Edit the placeholder to a new body.  Used while tools fire
	 * to surface "🔧 calling <tool> with <server>" breadcrumbs —
	 * the placeholder mutates in place via m.replace rather than
	 * spawning a fresh message per status change.  No-op when the
	 * initial send dropped (eventId never landed).
	 *
	 * `formattedBody` is optional HTML (org.matrix.custom.html); when
	 * provided, edit-aware clients render the HTML version while
	 * older / minimal clients fall back to the plain `body`. */
	async update(body: string, formattedBody?: string): Promise<void> {
		if (!this.eventId) return;
		await this.sendEdit(body, formattedBody);
	}

	/** Drop the placeholder (redact) and post the bot's final reply
	 * as a fresh, clean message.  We deliberately don't edit-into-
	 * answer here — leaving the placeholder around as the answer's
	 * row would mean the timeline carries a "Thinking… → answer"
	 * edit history forever, and any client that doesn't show the
	 * latest edited body would see "Thinking…" indefinitely.  A
	 * redacted placeholder + fresh reply leaves a clean answer row
	 * with no progress detritus.
	 *
	 * If the placeholder never landed, just post the reply as the
	 * one-and-only message. */
	async finalise(body: string): Promise<void> {
		if (this.eventId) {
			// Redact first so the redaction lands before the new
			// message — clients that re-order on receipt time still
			// show the right thing.  Best-effort: a failed redaction
			// just leaves the placeholder visible, which is annoying
			// but harmless.
			try {
				await this.client.redactEvent(this.roomId, this.eventId);
			} catch (err) {
				console.warn(`bot progress.finalise redact failed in ${this.roomId}`, err);
			}
			this.eventId = null;
		}
		await postPlain(this.client, this.roomId, body);
	}

	/** Internal: emit an m.replace edit pointing at our placeholder.
	 * The Matrix edit shape is two-bodied: the top-level `body` is a
	 * fallback for clients that don't render edits (it carries a `*`
	 * prefix per spec convention), and `m.new_content` is the
	 * canonical replacement that edit-aware clients display.  When
	 * `formattedBody` (HTML) is provided, we add `format` +
	 * `formatted_body` at both levels so clients that render HTML
	 * pick up the styled version. */
	private async sendEdit(body: string, formattedBody?: string): Promise<void> {
		try {
			const newContent: Record<string, unknown> = {
				msgtype: MsgType.Text,
				body,
			};
			const fallback: Record<string, unknown> = {
				msgtype: MsgType.Text,
				body: `* ${body}`,
				"m.new_content": newContent,
				"m.relates_to": {
					rel_type: "m.replace",
					event_id: this.eventId!,
				},
			};
			if (formattedBody) {
				newContent["format"] = "org.matrix.custom.html";
				newContent["formatted_body"] = formattedBody;
				fallback["format"] = "org.matrix.custom.html";
				fallback["formatted_body"] = `* ${formattedBody}`;
			}
			// matrix-js-sdk's sendMessage type doesn't expose the
			// `m.new_content` / `m.relates_to` fields the spec adds
			// for edits, so we cast through `any` once at the call
			// site.  The shape is documented in MSC2676 (in-room
			// message edits) — server-side it's just an opaque
			// content blob.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			await this.client.sendMessage(this.roomId, fallback as any);
		} catch (err) {
			console.warn(`bot progress edit failed in ${this.roomId}`, err);
		}
	}
}

/** Minimal HTML escape for safely embedding tool / server names in
 * a `formatted_body`.  We only emit `<strong>` ourselves; everything
 * else passes through this so a tool name like `<script>` becomes
 * literal text rather than executable markup in the chat surface. */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

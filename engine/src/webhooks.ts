// Inbound webhook delivery pipeline.
//
// Single entry point: deliverWebhook(row, headers, rawBody, requestUrl).
// Steps:
//
//   1. Detect the source by signature header or payload shape
//      (github / twilio / slack / stripe / generic).
//   2. Parse the body using the right content-type rules
//      (JSON / form-urlencoded / raw text).
//   3. Verify the source's signing scheme against the webhook's
//      stored secret (GitHub: X-Hub-Signature-256 HMAC-SHA256;
//      Twilio: X-Twilio-Signature HMAC-SHA1 of URL+sorted-params).
//   4. Format the parsed payload into a markdown chat message.
//   5. Post via the bot's matrix-js-sdk client into the target room.
//   6. Log success/failure to bot_webhook_deliveries.
//
// Returns DeliveryResult with an optional `reply` field — sources
// that expect a specific response shape (Twilio expects 200 +
// text/xml + TwiML) get that reply; everything else returns
// {ok:true} JSON from the HTTP handler.

import { createHmac, timingSafeEqual } from "node:crypto";
import { getRunningBot } from "./bot_manager";
import { processWebhookViaLlm } from "./bot_pipeline";
import {
	getBotById,
	recordBotWebhookDelivery,
	type BotWebhookRow,
} from "./db";

/** Outcome of a single delivery attempt.  Returned to the HTTP
 * handler so it can pick the right status code (200 ok, 401 hmac
 * fail, 503 transient post failure, etc.).  Optional `reply`
 * overrides the default JSON response for sources that expect a
 * source-specific shape (e.g. Twilio expects TwiML XML). */
export type DeliveryResult =
	| { status: "ok"; reply?: SourceReply }
	| { status: "hmac_invalid" }
	| { status: "bot_not_running" }
	| { status: "post_failed"; detail: string };

/** Source-specific HTTP reply body.  Twilio etc. don't accept JSON. */
export interface SourceReply {
	contentType: string;
	body: string;
}

/** Detected source of an inbound webhook.  Drives signature scheme,
 * payload-shape parsing, formatting, and reply shape. */
type Source = "github" | "twilio" | "slack" | "stripe" | "generic";

const MAX_BODY_BYTES = 1_000_000; // 1MB, enforced upstream by the HTTP handler too.

// ─── Source detection ─────────────────────────────────────────────

/** Auto-detect the source.  Header-based hints win because they're
 * cheaper than re-parsing the body, and most sources include a
 * distinctive signature header even on unsigned requests. */
function detectSource(headers: Headers, rawBody: string): Source {
	if (headers.get("x-twilio-signature")) return "twilio";
	if (headers.get("stripe-signature")) return "stripe";
	if (headers.get("x-slack-signature")) return "slack";
	if (headers.get("x-github-event") || headers.get("x-hub-signature-256")) return "github";

	// Fallback: peek at the body shape for unsigned probes.
	// Twilio inbound SMS comes as form-urlencoded with MessageSid;
	// even without the signature header, that shape is unmistakable.
	const ct = (headers.get("content-type") ?? "").toLowerCase();
	if (ct.includes("application/x-www-form-urlencoded")) {
		const params = new URLSearchParams(rawBody);
		if (params.has("MessageSid")) return "twilio";
	}

	return "generic";
}

// ─── Signature verification ───────────────────────────────────────

/** Verify GitHub-style `X-Hub-Signature-256` header.  Format:
 * "sha256=<hex>" where <hex> is HMAC-SHA256(secret, rawBody).  Uses
 * timingSafeEqual to avoid leaking the comparison via timing. */
function verifyGithubHmac(secret: string, rawBody: string, header: string | undefined): boolean {
	if (!header) return false;
	const m = header.match(/^sha256=([a-f0-9]+)$/i);
	if (!m) return false;
	const provided = Buffer.from(m[1]!, "hex");
	const expected = createHmac("sha256", secret).update(rawBody).digest();
	if (provided.length !== expected.length) return false;
	return timingSafeEqual(provided, expected);
}

/** Verify Twilio's `X-Twilio-Signature` header.
 *
 * Twilio's scheme: HMAC-SHA1, base64-encoded, computed over the
 * request's full URL (including query string) concatenated with the
 * form parameters sorted alphabetically by key, each key directly
 * followed by its value (no separator between pairs).
 *
 * The `secret` here is the Twilio Auth Token from the user's Twilio
 * console — the user pastes it into the webhook's signing-secret
 * field same as a GitHub HMAC secret.  Different scheme, same
 * field. */
function verifyTwilioHmac(
	secret: string,
	requestUrl: string,
	rawBody: string,
	header: string | undefined,
): boolean {
	if (!header) return false;
	const params = new URLSearchParams(rawBody);
	const sortedKeys = [...params.keys()].sort();
	let canonical = requestUrl;
	for (const k of sortedKeys) {
		// URLSearchParams collapses multi-value keys into the first
		// occurrence on .get(); use getAll + concat to match Twilio's
		// canonicalisation when a key repeats (rare for inbound SMS).
		for (const v of params.getAll(k)) {
			canonical += k + v;
		}
	}
	const expected = createHmac("sha1", secret).update(canonical).digest("base64");
	// Constant-time compare on the base64 strings.  Lengths match by
	// construction (HMAC-SHA1 is always 20 bytes → 28-char base64).
	const a = Buffer.from(header);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

// ─── Body parsing ─────────────────────────────────────────────────

/** Parse the raw body into something formatPayload can render.
 * JSON gets parsed, form-urlencoded becomes a Record<string,string>,
 * everything else stays as the raw string. */
function parseBody(headers: Headers, rawBody: string): unknown {
	const ct = (headers.get("content-type") ?? "").toLowerCase();
	if (ct.includes("application/json") || ct.includes("text/json")) {
		try {
			return JSON.parse(rawBody);
		} catch {
			return rawBody;
		}
	}
	if (ct.includes("application/x-www-form-urlencoded")) {
		const params = new URLSearchParams(rawBody);
		const obj: Record<string, string> = {};
		for (const [k, v] of params.entries()) obj[k] = v;
		return obj;
	}
	// Some sources send JSON with no Content-Type — try as JSON
	// before giving up to the raw-string formatter.
	try {
		return JSON.parse(rawBody);
	} catch {
		return rawBody;
	}
}

// ─── Source-aware formatting ──────────────────────────────────────

/** Format an incoming payload into a markdown chat message.  The
 * `source` hint lets us hand-format known shapes; unknown sources
 * fall through to a generic JSON code block. */
export function formatPayload(payload: unknown, source: Source = "generic"): string {
	// ---- Twilio inbound SMS ----
	// Form fields: From, To, Body, MessageSid, NumMedia, etc.
	// Surface the message conversationally — phone number → SMS body.
	if (source === "twilio" && typeof payload === "object" && payload !== null) {
		const p = payload as Record<string, string>;
		const from = p.From ?? "?";
		const to = p.To ?? "?";
		const body = p.Body ?? "";
		const mediaCount = Number(p.NumMedia ?? "0");
		const mediaNote = mediaCount > 0 ? ` *(+ ${mediaCount} media)*` : "";
		// Wrap From in code so phone numbers don't get auto-linked or
		// styled as @mentions by Matrix clients.
		return `📱 SMS from \`${from}\` → \`${to}\`${mediaNote}\n\n${body || "_(no body)_"}`;
	}

	if (typeof payload === "object" && payload !== null) {
		const p = payload as Record<string, unknown>;

		// ---- GitHub push ----
		const pusher = p.pusher as { name?: string } | undefined;
		const repository = p.repository as { full_name?: string; html_url?: string } | undefined;
		const commits = Array.isArray(p.commits) ? p.commits : null;
		const refRaw = typeof p.ref === "string" ? p.ref : "";
		if (pusher?.name && repository?.full_name && commits) {
			const branch = refRaw.replace(/^refs\/heads\//, "") || refRaw;
			const n = commits.length;
			const word = n === 1 ? "commit" : "commits";
			const repo = repository.full_name;
			const url = repository.html_url ?? `https://github.com/${repo}`;
			return `🟢 **${pusher.name}** pushed ${n} ${word} to \`${branch}\` of [${repo}](${url})`;
		}

		// ---- GitHub pull request ----
		const pr = p.pull_request as
			| { number?: number; title?: string; html_url?: string; user?: { login?: string } }
			| undefined;
		if (typeof p.action === "string" && pr && pr.number && pr.title) {
			const verb = p.action;
			const author = pr.user?.login ?? "someone";
			const url = pr.html_url ?? "";
			const repoName = repository?.full_name ?? "";
			return `🔀 **${author}** ${verb} PR [#${pr.number} ${pr.title}](${url})${repoName ? ` in \`${repoName}\`` : ""}`;
		}

		// ---- GitHub issue ----
		const issue = p.issue as
			| { number?: number; title?: string; html_url?: string; user?: { login?: string } }
			| undefined;
		if (typeof p.action === "string" && issue && issue.number && issue.title) {
			const verb = p.action;
			const author = issue.user?.login ?? "someone";
			const url = issue.html_url ?? "";
			const repoName = repository?.full_name ?? "";
			return `🐞 **${author}** ${verb} issue [#${issue.number} ${issue.title}](${url})${repoName ? ` in \`${repoName}\`` : ""}`;
		}
	}

	// ---- Generic fallback ----
	// Pretty-printed code block, capped at 1500 chars so a giant
	// payload doesn't make a wall of text in chat.
	let json: string;
	try {
		json = JSON.stringify(payload, null, 2);
	} catch {
		json = String(payload);
	}
	const TRUNCATE = 1500;
	if (json.length > TRUNCATE) {
		json = json.slice(0, TRUNCATE) + "\n[...truncated, see deliveries log for full body]";
	}
	return "```json\n" + json + "\n```";
}

// ─── Source-specific HTTP replies ────────────────────────────────

/** Twilio expects its webhook to respond with TwiML (XML) — an empty
 * `<Response/>` means "I got the message, do nothing".  Returning
 * JSON here makes Twilio mark the webhook as failing with an error
 * "11200 — HTTP retrieval failure" or similar. */
const TWILIO_EMPTY_TWIML =
	`<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`;

function replyForSource(source: Source): SourceReply | undefined {
	if (source === "twilio") {
		return { contentType: "text/xml; charset=utf-8", body: TWILIO_EMPTY_TWIML };
	}
	return undefined;
}

// ─── Main entry point ─────────────────────────────────────────────

/** Single attempt to deliver a webhook.  Returns the outcome so the
 * HTTP handler can pick a status code; logs to bot_webhook_deliveries
 * regardless of outcome so the bot owner can debug failures.
 *
 * `requestUrl` is the FULL URL the source posted to (scheme + host +
 * path + query) — needed for Twilio signature verification, which
 * canonicalises over the URL plus form params. */
export async function deliverWebhook(opts: {
	webhook: BotWebhookRow;
	headers: Headers;
	rawBody: string;
	requestUrl: string;
}): Promise<DeliveryResult> {
	const { webhook, headers, rawBody, requestUrl } = opts;

	const source = detectSource(headers, rawBody);

	// Signature check: scheme depends on detected source.  When the
	// webhook has a stored secret, signatures are required (else we
	// reject — could be probe/spam).  When no secret is stored, we
	// skip verification entirely (the webhook is "open" — fine for
	// internal cron jobs etc., not recommended for public sources).
	if (webhook.secret_hmac) {
		let ok = false;
		switch (source) {
			case "github":
			case "generic":
				ok = verifyGithubHmac(webhook.secret_hmac, rawBody, headers.get("x-hub-signature-256") ?? undefined);
				break;
			case "twilio":
				ok = verifyTwilioHmac(
					webhook.secret_hmac,
					requestUrl,
					rawBody,
					headers.get("x-twilio-signature") ?? undefined,
				);
				break;
			case "slack":
			case "stripe":
				// Not yet implemented — fall through to "invalid" so the
				// owner sees the failure in the deliveries log instead of
				// silently accepting unverified payloads.
				ok = false;
				break;
		}
		if (!ok) {
			return { status: "hmac_invalid" };
		}
	}

	// Body size belt-and-braces (HTTP layer rejects earlier).
	if (rawBody.length > MAX_BODY_BYTES) {
		recordBotWebhookDelivery({
			webhookId: webhook.id,
			payloadJson: rawBody.slice(0, 200) + "...[truncated]",
			postedText: null,
			error: `body too large (${rawBody.length} bytes, max ${MAX_BODY_BYTES})`,
		});
		return { status: "post_failed", detail: "body too large" };
	}

	const parsed = parseBody(headers, rawBody);
	const message = formatPayload(parsed, source);

	const bot = getBotById(webhook.bot_id);
	if (!bot) {
		recordBotWebhookDelivery({
			webhookId: webhook.id,
			payloadJson: rawBody,
			postedText: null,
			error: "bot row missing",
		});
		return { status: "bot_not_running" };
	}
	const running = getRunningBot(webhook.bot_id);
	if (!running) {
		recordBotWebhookDelivery({
			webhookId: webhook.id,
			payloadJson: rawBody,
			postedText: null,
			error: "bot not currently running",
		});
		return { status: "bot_not_running" };
	}

	// Run the formatted payload through the bot's LLM so the system
	// prompt + behaviour instructions actually shape the response.
	// Without this the bot just dumps a raw payload into the room
	// regardless of how the owner configured it ("paraphrase
	// inbound SMS in a friendly tone" etc. would be ignored).
	//
	// The LLM bridge handles its own posting, daily-limit checks,
	// and usage accounting — we just hand it the formatted message
	// and the target room.  Returns the posted text on success or
	// null on LLM failure (in which case it already posted an error
	// note to the room and we record that in the deliveries log).
	let postedText: string | null;
	try {
		postedText = await processWebhookViaLlm({
			bot,
			client: running.client,
			targetRoomId: webhook.target_room_id,
			inboundMessage: message,
		});
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		recordBotWebhookDelivery({
			webhookId: webhook.id,
			payloadJson: rawBody,
			postedText: message,
			error: `llm bridge failed: ${detail}`,
		});
		return { status: "post_failed", detail };
	}

	recordBotWebhookDelivery({
		webhookId: webhook.id,
		payloadJson: rawBody,
		// Log what the LLM actually posted (when successful), or fall
		// back to the formatted payload if the LLM bridge bailed —
		// either way the deliveries log shows what reached the room.
		postedText: postedText ?? message,
		error: postedText === null ? "llm bridge returned no reply" : null,
	});
	return { status: "ok", reply: replyForSource(source) };
}

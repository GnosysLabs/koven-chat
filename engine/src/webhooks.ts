// Inbound webhook delivery pipeline.
//
// Single entry point: deliverWebhook(row, headers, rawBody).  Handles:
//
//   1. Optional HMAC verification (X-Hub-Signature-256, GitHub-compat).
//   2. Auto-detect the payload's source (GitHub for now; extensible).
//   3. Format the payload into a markdown message string.
//   4. Post that message via the bot's matrix-js-sdk client into the
//      configured target room.
//   5. Log the delivery to bot_webhook_deliveries (success or failure).
//
// Error handling: any failure logs to the deliveries table with the
// `error` field set + bumps last_error on the parent webhook row, and
// the function still returns gracefully (the caller decides the HTTP
// response).  Posting via the bot's own client (vs. the engine's
// appservice user) keeps the bot's identity intact in encrypted rooms
// — the bot's crypto state is already loaded at that point, so megolm
// session sharing works out of the box.

import { createHmac, timingSafeEqual } from "node:crypto";
import { getRunningBot } from "./bot_manager";
import {
	getBotById,
	recordBotWebhookDelivery,
	type BotWebhookRow,
} from "./db";

/** Outcome of a single delivery attempt.  Returned to the HTTP
 * handler so it can pick the right status code (200 ok, 401 hmac
 * fail, 503 transient post failure, 502 wrong bot id, etc.). */
export type DeliveryResult =
	| { status: "ok" }
	| { status: "hmac_invalid" }
	| { status: "bot_not_running" }
	| { status: "post_failed"; detail: string };

const MAX_BODY_BYTES = 1_000_000; // 1MB, enforced upstream by the HTTP handler too.

/** Verify GitHub-style `X-Hub-Signature-256` header.  Format:
 * "sha256=<hex>" where <hex> is HMAC-SHA256(secret, rawBody).  Uses
 * timingSafeEqual to avoid leaking the comparison via timing.  Returns
 * true iff the signature is present AND valid. */
function verifyHmacSha256(secret: string, rawBody: string, header: string | undefined): boolean {
	if (!header) return false;
	const m = header.match(/^sha256=([a-f0-9]+)$/i);
	if (!m) return false;
	const provided = Buffer.from(m[1]!, "hex");
	const expected = createHmac("sha256", secret).update(rawBody).digest();
	if (provided.length !== expected.length) return false;
	return timingSafeEqual(provided, expected);
}

/** Format an incoming payload into a markdown message.  Currently
 * supports:
 *
 *   - GitHub push events — recognises the {pusher, commits,
 *     repository} shape and renders a one-line summary.
 *   - Generic JSON fallback — pretty-printed JSON inside a markdown
 *     code block, capped at 1500 chars (rooms with longer payloads
 *     get truncated with a "[...]" suffix; the full payload stays in
 *     the deliveries log for debugging).
 *
 * New presets can be added by detecting their distinctive payload
 * shape inside this function and returning a hand-formatted string.
 * Order matters — first match wins, generic fallback is last. */
export function formatPayload(payload: unknown): string {
	// ---- GitHub push ----
	// Distinctive fields: pusher.name, head_commit, repository.full_name.
	// Drives "🟢 alice pushed 3 commits to main of repo".  Branch comes
	// out of `ref` ("refs/heads/<branch>"); commit count from `commits`.
	if (typeof payload === "object" && payload !== null) {
		const p = payload as Record<string, unknown>;
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

		// ---- GitHub pull request opened/closed ----
		// Distinctive: `action` plus `pull_request` object.
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

	// ---- Generic JSON fallback ----
	// Pretty-printed code block.  Truncated at 1500 chars so a giant
	// payload doesn't make a wall of text in chat — the full body
	// stays in the deliveries log for debugging.
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

/** Single attempt to deliver a webhook.  Returns the outcome so the
 * HTTP handler can pick a status code; logs to bot_webhook_deliveries
 * regardless of outcome so the bot owner can debug failures. */
export async function deliverWebhook(opts: {
	webhook: BotWebhookRow;
	headers: Headers;
	rawBody: string;
}): Promise<DeliveryResult> {
	const { webhook, headers, rawBody } = opts;

	// HMAC check first — if the secret is set, an invalid signature
	// means we don't even log the payload (could be probe/spam).
	if (webhook.secret_hmac) {
		const sig = headers.get("x-hub-signature-256") ?? undefined;
		if (!verifyHmacSha256(webhook.secret_hmac, rawBody, sig)) {
			return { status: "hmac_invalid" };
		}
	}

	// Body size check.  The HTTP layer should reject earlier but
	// belt-and-braces here so a misconfigured proxy can't slip a
	// huge payload through.
	if (rawBody.length > MAX_BODY_BYTES) {
		recordBotWebhookDelivery({
			webhookId: webhook.id,
			payloadJson: rawBody.slice(0, 200) + "...[truncated]",
			postedText: null,
			error: `body too large (${rawBody.length} bytes, max ${MAX_BODY_BYTES})`,
		});
		return { status: "post_failed", detail: "body too large" };
	}

	// Parse + format.  Invalid JSON falls through to formatPayload
	// with the raw string, which gets the generic code-block
	// treatment.
	let parsed: unknown = rawBody;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		// keep `parsed` as the raw string; format will still render it.
	}
	const message = formatPayload(parsed);

	// Look up the bot's running matrix client.  If the bot isn't
	// currently running (engine restart in progress, bot disabled,
	// crashed earlier), we log the delivery as failed and tell the
	// caller — the source can retry, and the next /sync of the
	// bot might pick up the missed signal via other channels.
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

	// Post the formatted text into the target room as the bot.
	// Use sendEvent rather than sendMessage so the body shape is
	// fully under our control (msgtype + body + format/formatted_body
	// for markdown rendering by clients that respect it).
	try {
		// matrix-js-sdk's sendEvent typing for the third arg is the
		// content shape derived from the second arg (event type) — for
		// "m.room.message" that's a tagged union.  Cast through `any`
		// to avoid having to construct the discriminated union here;
		// the runtime accepts any well-formed m.room.message body.
		await (running.client as unknown as {
			sendEvent(roomId: string, eventType: string, content: Record<string, unknown>): Promise<unknown>;
		}).sendEvent(webhook.target_room_id, "m.room.message", {
			msgtype: "m.notice",
			body: stripMarkdown(message),
			format: "org.matrix.custom.html",
			formatted_body: markdownToHtml(message),
		});
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		recordBotWebhookDelivery({
			webhookId: webhook.id,
			payloadJson: rawBody,
			postedText: message,
			error: `matrix send failed: ${detail}`,
		});
		return { status: "post_failed", detail };
	}

	recordBotWebhookDelivery({
		webhookId: webhook.id,
		payloadJson: rawBody,
		postedText: message,
		error: null,
	});
	return { status: "ok" };
}

/** Cheap markdown → plaintext fallback for the m.room.message `body`
 * field.  Renderers that don't support `formatted_body` show this.
 * Strips bold/italic markers, link syntax (keeps the label text),
 * code-block fences (keeps the inner text), and inline backticks. */
function stripMarkdown(md: string): string {
	return md
		.replace(/```[a-z]*\n([\s\S]*?)\n```/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

/** Cheap markdown → HTML for `formatted_body`.  Covers the subset
 * the formatter actually emits: bold (`**x**`), inline code
 * (backtick), code blocks, and links.  Not a general markdown
 * parser — we control both ends so we don't need one. */
function markdownToHtml(md: string): string {
	// Escape HTML special chars first so user-controlled bits don't
	// inject markup.  The transformations below only run against
	// the escaped string.
	const escape = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	let html = escape(md);
	// Code blocks first (must run before single-backtick to avoid
	// matching their fence backticks).
	html = html.replace(/```([a-z]*)\n([\s\S]*?)\n```/g, (_m, _lang, body: string) =>
		`<pre><code>${body}</code></pre>`,
	);
	html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
	html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
	html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
	html = html.replace(/\n/g, "<br>");
	return html;
}

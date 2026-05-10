// Outbound HTTP "tool" webhooks for bots.
//
// Mirror of bot_webhooks.ts but in the opposite direction: instead
// of external services posting IN to the bot, the bot's LLM calls
// OUT to an HTTP endpoint when it decides to invoke the tool.
//
// Each row in bot_outbound_webhooks becomes one OpenAI tool
// definition surfaced in the bot's chatCompletion() call (alongside
// any MCP tools attached to the bot).  When the model invokes one,
// dispatchOutboundCall() builds the HTTP request from the row's
// template + the model's args, fires it, and returns the response
// body as a string the model can read on its next turn.
//
// Shape of an outbound webhook row:
//   - name        — the LLM tool name (e.g. "fetch_news")
//   - description — what the LLM uses to decide WHEN to call
//   - method      — "GET" or "POST"
//   - url         — may contain {placeholder} tokens; substituted
//                   from args.  Unmatched url-scope params get
//                   appended as ?key=value query string.
//   - params      — JSON array of {name, description, required, in}
//                   where `in` is "url" or "body".  Renders as the
//                   tool's JSON-schema `properties`.
//   - headers     — JSON array of {name, value} static headers
//                   (Authorization, X-Api-Key, etc.).

import {
	getBotOutboundWebhookById,
	listBotOutboundWebhooks,
	recordBotOutboundCall,
	type BotOutboundWebhookRow,
	type OutboundHeader,
	type OutboundParam,
} from "./db";
import type { ToolDefinition } from "./llm_client";

const TOOL_PREFIX = "wh";
const TOOL_SEPARATOR = "__";

// Cap the response body size we return to the LLM.  Long upstream
// responses blow the model's context budget; truncate with a clear
// suffix so the model knows it's incomplete.
const MAX_RESPONSE_CHARS = 8_000;

// Per-call HTTP timeout.  Generous enough for slow upstream APIs
// (n8n cold starts, etc.) but bounded so a hung endpoint doesn't
// pin the bot pipeline for the full 60s LLM timeout.
const OUTBOUND_TIMEOUT_MS = 25_000;

export interface BotOutboundBundle {
	/** Tool definitions to merge into chatCompletion()'s tools[]. */
	tools: ToolDefinition[];
	/** Routing table: namespaced tool name → row.  Used by dispatch
	 * to look up the URL/method/headers for a given LLM call. */
	routes: Map<number, BotOutboundWebhookRow>;
}

/** Build the tool definitions for every outbound webhook on a bot.
 * Empty bundle when the bot has no outbound webhooks — mirrors the
 * MCP bundle shape so the caller can merge them blindly. */
export function loadBotOutboundBundle(botId: number): BotOutboundBundle {
	const rows = listBotOutboundWebhooks(botId);
	if (rows.length === 0) return { tools: [], routes: new Map() };

	const tools: ToolDefinition[] = [];
	const routes = new Map<number, BotOutboundWebhookRow>();

	for (const row of rows) {
		try {
			const params = parseParams(row.params_json);
			tools.push({
				type: "function",
				function: {
					name: namespaceToolName(row.id, row.name),
					description: row.description || `HTTP ${row.method} ${row.url}`,
					parameters: paramsToJsonSchema(params),
				},
			});
			routes.set(row.id, row);
		} catch (err) {
			console.warn(
				`bot ${botId}: outbound webhook "${row.name}" (id=${row.id}) malformed; skipping`,
				err,
			);
		}
	}

	return { tools, routes };
}

/** Dispatch one outbound webhook invocation.  Builds the HTTP
 * request from the row + the model's args, fires it, and returns
 * the response body as a string for the LLM to read.  Errors are
 * returned as result strings (NOT thrown) so the model can see the
 * failure and decide whether to retry / give up. */
export async function dispatchOutboundCall(
	bundle: BotOutboundBundle,
	namespacedName: string,
	args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
	const parsed = parseToolName(namespacedName);
	if (!parsed) {
		return {
			text: `Error: tool name "${namespacedName}" is not in the expected "${TOOL_PREFIX}<id>${TOOL_SEPARATOR}<name>" format.`,
			isError: true,
		};
	}
	const row = bundle.routes.get(parsed.rowId);
	if (!row) {
		return {
			text: `Error: no outbound webhook route for prefix "${TOOL_PREFIX}${parsed.rowId}".`,
			isError: true,
		};
	}

	let params: OutboundParam[];
	let headers: OutboundHeader[];
	try {
		params = parseParams(row.params_json);
		headers = parseHeaders(row.headers_json);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		recordBotOutboundCall(row.id, `malformed config: ${detail}`);
		return { text: `Error: outbound webhook "${row.name}" config is malformed: ${detail}`, isError: true };
	}

	// Build the request.  URL-scope params: substitute into
	// {placeholder} tokens; remaining url-scope params append as
	// query string.  Body-scope params: collect into JSON body
	// (POST only — GET requests ignore body params with a warning
	// to the model).
	const urlParams: Record<string, string> = {};
	const bodyParams: Record<string, unknown> = {};
	for (const p of params) {
		const v = args[p.name];
		if (v === undefined || v === null) {
			if (p.required) {
				return {
					text: `Error: outbound webhook "${row.name}" required parameter "${p.name}" is missing.`,
					isError: true,
				};
			}
			continue;
		}
		if (p.in === "url") urlParams[p.name] = String(v);
		else bodyParams[p.name] = v;
	}

	let resolvedUrl: string;
	try {
		resolvedUrl = renderUrl(row.url, urlParams);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { text: `Error: outbound webhook "${row.name}" URL render failed: ${detail}`, isError: true };
	}

	const reqHeaders: Record<string, string> = {};
	for (const h of headers) {
		if (h.name && h.value) reqHeaders[h.name] = h.value;
	}

	let body: string | undefined;
	if (row.method === "POST") {
		// Send body even if empty for consistent parsing on the
		// other side.  Skip the Content-Type header if the user
		// already specified one (some APIs care about charset etc.).
		body = JSON.stringify(bodyParams);
		if (!hasHeaderCi(reqHeaders, "content-type")) {
			reqHeaders["Content-Type"] = "application/json";
		}
	} else if (Object.keys(bodyParams).length > 0) {
		console.warn(
			`bot outbound: webhook "${row.name}" is GET but model passed body params; ignoring`,
			Object.keys(bodyParams),
		);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);

	let res: Response;
	try {
		res = await fetch(resolvedUrl, {
			method: row.method,
			headers: reqHeaders,
			body,
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		const detail = (err as { name?: string }).name === "AbortError"
			? `timeout (no response in ${OUTBOUND_TIMEOUT_MS}ms)`
			: err instanceof Error ? err.message : String(err);
		recordBotOutboundCall(row.id, detail);
		console.warn(`bot outbound: webhook "${row.name}" (id=${row.id}) failed: ${detail}`);
		return {
			text: `Error: outbound webhook "${row.name}" call failed: ${detail}`,
			isError: true,
		};
	}
	clearTimeout(timer);

	const text = await res.text().catch(() => "");
	if (!res.ok) {
		const detail = `HTTP ${res.status}: ${truncate(text, 300)}`;
		recordBotOutboundCall(row.id, detail);
		console.warn(`bot outbound: webhook "${row.name}" (id=${row.id}) returned ${res.status}`);
		return {
			text: `Error: outbound webhook "${row.name}" returned HTTP ${res.status}.\n\nResponse body:\n${truncate(text, MAX_RESPONSE_CHARS)}`,
			isError: true,
		};
	}

	recordBotOutboundCall(row.id, null);
	const trimmed = truncate(text, MAX_RESPONSE_CHARS);
	console.log(
		`bot outbound: webhook "${row.name}" (id=${row.id}) ok — ${text.length} chars`
			+ (text.length > MAX_RESPONSE_CHARS ? ` (truncated to ${MAX_RESPONSE_CHARS})` : ""),
	);
	return { text: trimmed, isError: false };
}

/** Pretty name + LLM-friendly arg list for the progress placeholder.
 * Returns null when the namespaced name doesn't parse / no route. */
export function describeOutboundCall(
	bundle: BotOutboundBundle,
	namespacedName: string,
): { name: string; method: string; url: string } | null {
	const parsed = parseToolName(namespacedName);
	if (!parsed) return null;
	const row = bundle.routes.get(parsed.rowId);
	if (!row) return null;
	return { name: row.name, method: row.method, url: row.url };
}

/** Whether a namespaced tool name looks like an outbound webhook
 * call (`wh<id>__<name>`).  Used by the bot pipeline to decide
 * which dispatcher to route to. */
export function isOutboundToolName(namespaced: string): boolean {
	return parseToolName(namespaced) !== null;
}

/** Convenience for callers that already have the row by id. */
export function getBotOutboundWebhookForCall(
	botId: number,
	id: number,
): BotOutboundWebhookRow | null {
	return getBotOutboundWebhookById(id, botId);
}

// ─── Helpers ──────────────────────────────────────────────────────

function namespaceToolName(rowId: number, name: string): string {
	return `${TOOL_PREFIX}${rowId}${TOOL_SEPARATOR}${sanitizeToolName(name)}`;
}

interface ParsedToolName {
	rowId: number;
	name: string;
}

function parseToolName(namespaced: string): ParsedToolName | null {
	if (!namespaced.startsWith(TOOL_PREFIX)) return null;
	const sepIdx = namespaced.indexOf(TOOL_SEPARATOR);
	if (sepIdx <= TOOL_PREFIX.length) return null;
	const idStr = namespaced.slice(TOOL_PREFIX.length, sepIdx);
	const rowId = Number(idStr);
	if (!Number.isInteger(rowId) || rowId <= 0) return null;
	const name = namespaced.slice(sepIdx + TOOL_SEPARATOR.length);
	if (name.length === 0) return null;
	return { rowId, name };
}

/** Strip characters that violate OpenAI's tool name regex
 * (^[a-zA-Z0-9_-]{1,64}$).  We don't validate hard at write time
 * because the user might paste names with spaces / hyphens; this
 * normalises them at registration time. */
function sanitizeToolName(name: string): string {
	const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56);
	return cleaned.length > 0 ? cleaned : "tool";
}

function parseParams(json: string): OutboundParam[] {
	const parsed = JSON.parse(json);
	if (!Array.isArray(parsed)) throw new Error("params must be an array");
	return parsed.map(p => ({
		name: String(p.name ?? ""),
		description: String(p.description ?? ""),
		required: p.required === true,
		in: p.in === "body" ? "body" : "url",
	}));
}

function parseHeaders(json: string): OutboundHeader[] {
	const parsed = JSON.parse(json);
	if (!Array.isArray(parsed)) throw new Error("headers must be an array");
	return parsed.map(h => ({
		name: String(h.name ?? ""),
		value: String(h.value ?? ""),
	}));
}

/** Convert OutboundParam[] into an OpenAI-shape JSON schema object
 * (`type: "object"`, `properties`, `required`).  Every param is
 * typed string for v1 — keeps the LLM-side shape predictable
 * regardless of how the upstream API consumes the value. */
function paramsToJsonSchema(params: OutboundParam[]): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const p of params) {
		if (!p.name) continue;
		properties[p.name] = {
			type: "string",
			description: p.description || `${p.in === "url" ? "URL" : "body"} parameter`,
		};
		if (p.required) required.push(p.name);
	}
	return {
		type: "object",
		properties,
		...(required.length > 0 ? { required } : {}),
	};
}

/** Substitute {placeholder} tokens in `template` with values from
 * `args`.  Any args left over after substitution are appended as a
 * URL-encoded query string (keeps the GET-with-extra-params shape
 * working even when the user didn't put a placeholder for every
 * param).  Throws if a {placeholder} reference has no value. */
function renderUrl(template: string, args: Record<string, string>): string {
	const used = new Set<string>();
	const substituted = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key: string) => {
		const v = args[key];
		if (v === undefined) {
			throw new Error(`URL placeholder {${key}} has no matching arg`);
		}
		used.add(key);
		return encodeURIComponent(v);
	});
	const leftover = Object.entries(args).filter(([k]) => !used.has(k));
	if (leftover.length === 0) return substituted;
	const join = substituted.includes("?") ? "&" : "?";
	const qs = leftover
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");
	return `${substituted}${join}${qs}`;
}

function hasHeaderCi(headers: Record<string, string>, name: string): boolean {
	const lower = name.toLowerCase();
	for (const k of Object.keys(headers)) {
		if (k.toLowerCase() === lower) return true;
	}
	return false;
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n) + `\n…[truncated, ${s.length - n} more chars]`;
}

// Typed client for the engine's per-bot outbound-webhook surface.
//
// Outbound webhooks are LLM-callable HTTP tools — the bot's pipeline
// registers each row as an OpenAI tool definition, and when the
// model invokes it the engine fires the configured HTTP request and
// hands the response back to the model.
//
// Endpoints:
//   GET    /api/bots/:id/outbound-webhooks            — list
//   POST   /api/bots/:id/outbound-webhooks            — create
//   PATCH  /api/bots/:id/outbound-webhooks/:wid       — update
//   DELETE /api/bots/:id/outbound-webhooks/:wid       — delete
//
// Auth: bot-owner-scoped via the user's matrix access token (same
// shape as the inbound webhooks API).

import { ENGINE_URL } from "@/lib/urls";

export interface OutboundParam {
	name: string;
	description: string;
	required: boolean;
	/** "url" → substituted into URL placeholders / appended as query
	 * string.  "body" → sent in the JSON body (POST only). */
	in: "url" | "body";
}

export interface OutboundHeader {
	name: string;
	value: string;
}

/** Wire shape returned by the engine.  params + headers are JSON-
 * encoded strings for storage; we parse them on the way in via
 * decodeOutbound() so callers get typed arrays. */
export interface OutboundWebhookRow {
	id: number;
	bot_id: number;
	name: string;
	description: string;
	method: "GET" | "POST";
	url: string;
	params_json: string;
	headers_json: string;
	created_at: number;
	last_called: number | null;
	last_error: string | null;
}

/** Caller-friendly variant with params + headers parsed. */
export interface OutboundWebhook {
	id: number;
	bot_id: number;
	name: string;
	description: string;
	method: "GET" | "POST";
	url: string;
	params: OutboundParam[];
	headers: OutboundHeader[];
	created_at: number;
	last_called: number | null;
	last_error: string | null;
}

function authHeaders(accessToken: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${accessToken}`,
	};
}

function decodeOutbound(row: OutboundWebhookRow): OutboundWebhook {
	let params: OutboundParam[] = [];
	let headers: OutboundHeader[] = [];
	try { params = JSON.parse(row.params_json) as OutboundParam[]; } catch { /* keep default */ }
	try { headers = JSON.parse(row.headers_json) as OutboundHeader[]; } catch { /* keep default */ }
	return {
		id: row.id,
		bot_id: row.bot_id,
		name: row.name,
		description: row.description,
		method: row.method,
		url: row.url,
		params,
		headers,
		created_at: row.created_at,
		last_called: row.last_called,
		last_error: row.last_error,
	};
}

export async function listBotOutboundWebhooks(
	accessToken: string,
	botId: number,
): Promise<OutboundWebhook[]> {
	const r = await fetch(`${ENGINE_URL}/api/bots/${botId}/outbound-webhooks`, {
		headers: authHeaders(accessToken),
	});
	if (!r.ok) throw new Error(`listBotOutboundWebhooks: HTTP ${r.status}`);
	const body = (await r.json()) as { outbound_webhooks?: OutboundWebhookRow[] };
	return (body.outbound_webhooks ?? []).map(decodeOutbound);
}

export async function createBotOutboundWebhook(opts: {
	accessToken: string;
	botId: number;
	name: string;
	description: string;
	method: "GET" | "POST";
	url: string;
	params: OutboundParam[];
	headers: OutboundHeader[];
}): Promise<OutboundWebhook> {
	const { accessToken, botId, ...payload } = opts;
	const r = await fetch(`${ENGINE_URL}/api/bots/${botId}/outbound-webhooks`, {
		method: "POST",
		headers: authHeaders(accessToken),
		body: JSON.stringify(payload),
	});
	if (!r.ok) {
		const err = (await r.json().catch(() => ({}))) as { error?: string };
		throw new Error(err.error ?? `createBotOutboundWebhook: HTTP ${r.status}`);
	}
	const body = (await r.json()) as { outbound_webhook: OutboundWebhookRow };
	return decodeOutbound(body.outbound_webhook);
}

export async function updateBotOutboundWebhook(opts: {
	accessToken: string;
	botId: number;
	webhookId: number;
	patch: Partial<{
		name: string;
		description: string;
		method: "GET" | "POST";
		url: string;
		params: OutboundParam[];
		headers: OutboundHeader[];
	}>;
}): Promise<OutboundWebhook> {
	const r = await fetch(
		`${ENGINE_URL}/api/bots/${opts.botId}/outbound-webhooks/${opts.webhookId}`,
		{
			method: "PATCH",
			headers: authHeaders(opts.accessToken),
			body: JSON.stringify(opts.patch),
		},
	);
	if (!r.ok) {
		const err = (await r.json().catch(() => ({}))) as { error?: string };
		throw new Error(err.error ?? `updateBotOutboundWebhook: HTTP ${r.status}`);
	}
	const body = (await r.json()) as { outbound_webhook: OutboundWebhookRow };
	return decodeOutbound(body.outbound_webhook);
}

export async function deleteBotOutboundWebhook(opts: {
	accessToken: string;
	botId: number;
	webhookId: number;
}): Promise<void> {
	const r = await fetch(
		`${ENGINE_URL}/api/bots/${opts.botId}/outbound-webhooks/${opts.webhookId}`,
		{
			method: "DELETE",
			headers: authHeaders(opts.accessToken),
		},
	);
	if (!r.ok) throw new Error(`deleteBotOutboundWebhook: HTTP ${r.status}`);
}

// Typed client for the engine's per-bot inbound-webhook surface.
//
// Endpoints:
//   GET    /api/bots/:id/webhooks                 — list (no secrets)
//   POST   /api/bots/:id/webhooks                 — create (returns secret ONCE)
//   DELETE /api/bots/:id/webhooks/:wid            — delete
//   GET    /api/bots/:id/webhooks/:wid/deliveries — recent debug log
//
// Auth: every call is bot-owner-scoped via the user's matrix
// access token (same shape as bots.ts's other CRUD).  See
// engine/src/server.ts for the matching handlers.
//
// On create: the engine generates the URL token and (if requested)
// an HMAC secret, and returns the secret in plaintext exactly
// once.  Caller must surface it to the user immediately — the
// stored copy isn't readable back.

import { ENGINE_URL } from "@/lib/urls";

/** Public summary of a webhook (no secret material). */
export interface WebhookSummary {
	id: number;
	bot_id: number;
	token: string;
	has_secret: boolean;
	target_room_id: string;
	label: string;
	created_at: number;
	last_delivery: number | null;
	last_error: string | null;
}

/** Returned only on create — includes the freshly-generated secret
 * (when `generate_secret` was true).  Never returned by any other
 * endpoint; the engine doesn't store it in a recoverable form. */
export interface WebhookCreated {
	id: number;
	bot_id: number;
	token: string;
	secret: string | null;
	target_room_id: string;
	label: string;
	created_at: number;
}

export interface WebhookDelivery {
	id: number;
	webhook_id: number;
	received_at: number;
	payload_json: string;
	posted_text: string | null;
	error: string | null;
}

function authHeaders(accessToken: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${accessToken}`,
	};
}

/** Full inbound URL for a webhook token.  The user pastes this into
 * the source service (GitHub webhook URL, Stripe endpoint, n8n HTTP
 * Request node, etc.).  Lives on the client side because ENGINE_URL
 * varies between dev / prod / Tauri-bundle. */
export function webhookUrlFor(token: string): string {
	return `${ENGINE_URL || ""}/api/webhooks/in/${encodeURIComponent(token)}`;
}

export async function listBotWebhooks(
	accessToken: string,
	botId: number,
): Promise<WebhookSummary[]> {
	const r = await fetch(`${ENGINE_URL}/api/bots/${botId}/webhooks`, {
		headers: authHeaders(accessToken),
	});
	if (!r.ok) throw new Error(`listBotWebhooks: HTTP ${r.status}`);
	const body = (await r.json()) as { webhooks?: WebhookSummary[] };
	return body.webhooks ?? [];
}

export async function createBotWebhook(opts: {
	accessToken: string;
	botId: number;
	targetRoomId: string;
	label: string;
	generateSecret: boolean;
}): Promise<WebhookCreated> {
	const r = await fetch(`${ENGINE_URL}/api/bots/${opts.botId}/webhooks`, {
		method: "POST",
		headers: authHeaders(opts.accessToken),
		body: JSON.stringify({
			target_room_id: opts.targetRoomId,
			label: opts.label,
			generate_secret: opts.generateSecret,
		}),
	});
	if (!r.ok) {
		const err = (await r.json().catch(() => ({}))) as { error?: string };
		throw new Error(err.error ?? `createBotWebhook: HTTP ${r.status}`);
	}
	const body = (await r.json()) as { webhook: WebhookCreated };
	return body.webhook;
}

export async function deleteBotWebhook(opts: {
	accessToken: string;
	botId: number;
	webhookId: number;
}): Promise<void> {
	const r = await fetch(
		`${ENGINE_URL}/api/bots/${opts.botId}/webhooks/${opts.webhookId}`,
		{
			method: "DELETE",
			headers: authHeaders(opts.accessToken),
		},
	);
	if (!r.ok) throw new Error(`deleteBotWebhook: HTTP ${r.status}`);
}

export async function listBotWebhookDeliveries(opts: {
	accessToken: string;
	botId: number;
	webhookId: number;
}): Promise<WebhookDelivery[]> {
	const r = await fetch(
		`${ENGINE_URL}/api/bots/${opts.botId}/webhooks/${opts.webhookId}/deliveries`,
		{ headers: authHeaders(opts.accessToken) },
	);
	if (!r.ok) throw new Error(`listBotWebhookDeliveries: HTTP ${r.status}`);
	const body = (await r.json()) as { deliveries?: WebhookDelivery[] };
	return body.deliveries ?? [];
}

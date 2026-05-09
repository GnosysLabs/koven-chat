// Client helpers for the bot edit form's "Tools" tab.
//
// We're protocol-pure: an MCP attachment is a Streamable-HTTP URL
// plus optional auth headers (typical: `Authorization: Bearer …`).
// No catalog, no proxy.  If the user can find an MCP URL they're
// qualified to wire up the auth that goes with it.

import { ENGINE_URL } from "@/lib/urls";

export interface BotMcpAttachment {
	id: number;
	bot_id: number;
	label: string;
	url: string;
	/** Auth / custom headers attached to every MCP request. */
	headers: Record<string, string>;
	created_at: number;
}

async function callEngine<T>(
	path: string,
	accessToken: string,
	init: RequestInit = {},
): Promise<T> {
	const r = await fetch(`${ENGINE_URL}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			...(init.headers ?? {}),
		},
	});
	const text = await r.text();
	let body: unknown = {};
	try { body = text ? JSON.parse(text) : {}; } catch { /* keep raw */ }
	if (!r.ok) {
		const err = body as { error?: string; detail?: string };
		throw new Error(err.detail ?? err.error ?? `HTTP ${r.status}`);
	}
	return body as T;
}

export async function listBotMcpServers(
	accessToken: string,
	botId: number,
): Promise<BotMcpAttachment[]> {
	const body = await callEngine<{ servers: BotMcpAttachment[] }>(
		`/api/bots/${botId}/mcp`,
		accessToken,
	);
	return body.servers ?? [];
}

export interface AttachMcpRequest {
	label: string;
	url: string;
	headers?: Record<string, string>;
}

export async function attachBotMcpServer(
	accessToken: string,
	botId: number,
	req: AttachMcpRequest,
): Promise<BotMcpAttachment> {
	const body = await callEngine<{ server: BotMcpAttachment }>(
		`/api/bots/${botId}/mcp`,
		accessToken,
		{ method: "POST", body: JSON.stringify(req) },
	);
	return body.server;
}

export async function patchBotMcpServer(
	accessToken: string,
	botId: number,
	mcpRowId: number,
	patch: Partial<AttachMcpRequest>,
): Promise<BotMcpAttachment> {
	const body = await callEngine<{ server: BotMcpAttachment }>(
		`/api/bots/${botId}/mcp/${mcpRowId}`,
		accessToken,
		{ method: "PATCH", body: JSON.stringify(patch) },
	);
	return body.server;
}

export async function detachBotMcpServer(
	accessToken: string,
	botId: number,
	mcpRowId: number,
): Promise<void> {
	await callEngine<{ ok: true }>(
		`/api/bots/${botId}/mcp/${mcpRowId}`,
		accessToken,
		{ method: "DELETE" },
	);
}

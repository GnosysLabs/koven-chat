// Client helpers for the bot edit form's "Tools" tab.
//
// Two surfaces:
//
//   1. The bot's own MCP attachments — list / attach / detach.
//      Engine: GET / POST / DELETE on /api/bots/:id/mcp.
//
//   2. Smithery catalog browse — proxied through the engine because
//      the registry needs the user's encrypted Smithery API key,
//      which never reaches the client.
//      Engine: GET /api/smithery/search?q=
//              GET /api/smithery/servers/:qualifiedName
//
// Errors are surfaced as `Error` with the engine's `detail` field
// (or `error` code as fallback).  The 503 we get when the user has
// no Smithery key configured is exposed as the dedicated
// `SmitheryKeyMissingError` so the catalog tab can render a nudge to
// Account settings instead of a generic failure message.

import { ENGINE_URL } from "@/lib/urls";

export interface BotMcpAttachment {
	id: number;
	bot_id: number;
	smithery_qualified_name: string;
	config: Record<string, unknown>;
	created_at: number;
}

export interface SmitheryServerSummary {
	qualifiedName: string;
	displayName: string;
	description: string;
	homepage?: string;
	useCount?: number;
	isDeployed?: boolean;
}

export interface SmitheryServerDetail extends SmitheryServerSummary {
	configSchema?: Record<string, unknown>;
	hasHttpTransport: boolean;
}

export interface SmitherySearchResult {
	servers: SmitheryServerSummary[];
	totalCount: number;
}

/** Thrown when the engine reports no Smithery key configured.  The
 * UI catches this specifically to show a "set your key first" nudge
 * rather than the raw "smithery_key_missing" code. */
export class SmitheryKeyMissingError extends Error {
	constructor(detail?: string) {
		super(detail ?? "Smithery API key not configured.");
		this.name = "SmitheryKeyMissingError";
	}
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
		if (err.error === "smithery_key_missing") {
			throw new SmitheryKeyMissingError(err.detail);
		}
		throw new Error(err.detail ?? err.error ?? `HTTP ${r.status}`);
	}
	return body as T;
}

// ─── Bot ↔ server attachments ────────────────────────────────────

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

export async function attachBotMcpServer(
	accessToken: string,
	botId: number,
	qualifiedName: string,
	config?: Record<string, unknown>,
): Promise<BotMcpAttachment> {
	const body = await callEngine<{ server: BotMcpAttachment }>(
		`/api/bots/${botId}/mcp`,
		accessToken,
		{
			method: "POST",
			body: JSON.stringify({ qualified_name: qualifiedName, config: config ?? {} }),
		},
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

// ─── Smithery catalog ─────────────────────────────────────────────

export async function searchSmitheryCatalog(
	accessToken: string,
	query: string,
): Promise<SmitherySearchResult> {
	const params = new URLSearchParams();
	if (query.trim()) params.set("q", query.trim());
	const qs = params.toString();
	return callEngine<SmitherySearchResult>(
		`/api/smithery/search${qs ? `?${qs}` : ""}`,
		accessToken,
	);
}

export async function getSmitheryServerDetail(
	accessToken: string,
	qualifiedName: string,
): Promise<SmitheryServerDetail> {
	return callEngine<SmitheryServerDetail>(
		`/api/smithery/servers/${encodeURIComponent(qualifiedName)}`,
		accessToken,
	);
}

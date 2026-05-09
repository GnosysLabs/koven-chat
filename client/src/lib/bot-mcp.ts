// Client helpers for the bot edit form's "Tools" tab.
//
// Two attachment kinds:
//   kind='http'  → Streamable-HTTP URL + optional auth headers
//                  (typical: `Authorization: Bearer …`).  No catalog,
//                  no proxy.  If the user can find an MCP URL they're
//                  qualified to wire up the auth that goes with it.
//   kind='stdio' → subprocess invocation (`command`, `args`, `env`).
//                  The engine spawns the subprocess inside a bwrap
//                  sandbox with stripped env + per-bot scratch dir.
//                  Pasted directly from a Claude Desktop / Cursor /
//                  Cline `mcpServers` config block via the bulk-import
//                  endpoint.

import { ENGINE_URL } from "@/lib/urls";

export type BotMcpKind = "http" | "stdio";

export interface BotMcpAttachment {
	id: number;
	bot_id: number;
	label: string;
	kind: BotMcpKind;
	created_at: number;
	/** kind='http' fields. */
	url: string;
	/** Auth / custom headers attached to every MCP request. */
	headers: Record<string, string>;
	/** kind='stdio' fields. */
	command: string | null;
	args: string[];
	env: Record<string, string>;
	/** Pinned npm version (e.g. "1.2.3") if we resolved one at attach
	 * time.  Null when pinning didn't apply (non-npm package, private
	 * registry, network blip).  When set, the engine uses this exact
	 * version on every spawn — protects against silent supply-chain
	 * compromise via auto-update. */
	locked_version: string | null;
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

export interface ImportMcpResult {
	servers: BotMcpAttachment[];
	/** Per-server warnings (unknown fields ignored, version not
	 * pinnable, etc.).  Surface to the user verbatim — the parser
	 * is tolerant by design and these tell the user what was actually
	 * stored. */
	warnings: string[];
	/** Per-server errors that prevented attachment (DB failure,
	 * malformed shape we couldn't normalise after parsing). */
	skipped: string[];
}

/** Bulk-attach from a pasted `mcpServers` config block.  Accepts the
 * full Claude Desktop / Cursor / Cline JSON, a bare `{ name: server }`
 * map, or a single bare server object — the engine's parser tolerates
 * all the common shapes (see engine/src/mcp/parse_config.ts).
 *
 * `config` may be either a JSON string or an already-parsed object;
 * we forward as-is.  On success returns every server that was
 * attached, plus warnings for caveats (unknown fields, unpinnable
 * versions). */
export async function importBotMcpServers(
	accessToken: string,
	botId: number,
	config: string | unknown,
): Promise<ImportMcpResult> {
	const body = await callEngine<ImportMcpResult>(
		`/api/bots/${botId}/mcp/import`,
		accessToken,
		{ method: "POST", body: JSON.stringify({ config }) },
	);
	return {
		servers: body.servers ?? [],
		warnings: body.warnings ?? [],
		skipped: body.skipped ?? [],
	};
}

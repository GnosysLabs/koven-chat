// Tolerant parser for MCP server config blocks.
//
// Users paste configs from a wide range of sources (Claude Desktop,
// Cursor, Cline, Windsurf, raw README snippets) and the schemas drift
// in small ways across all of them.  We accept the common variants
// and normalise to a canonical AttachmentInput shape the engine
// stores.
//
// Accepted shapes:
//   1. { "mcpServers": { "<name>": <server> } }   ← Claude Desktop / Cursor
//   2. { "mcp": { "servers": { "<name>": <server> } } }  ← VS Code MCP
//   3. { "servers": { "<name>": <server> } }      ← some clients
//   4. { "<name>": <server>, … }                  ← bare top-level map
//   5. <server>                                   ← single server, no map
//
// Where <server> is one of:
//   - { "command": "...", "args": [...], "env": {...} }                 → stdio
//   - { "type": "stdio", "command": "...", "args": [...], ... }         → stdio
//   - { "type": "http"|"streamable-http"|"sse", "url": "...", "headers": {...} }  → http
//   - { "url": "..." }                                                  → http (inferred)
//
// Unknown fields are silently dropped (commonly: disabled, autostart,
// displayName, description, transport, alwaysAllow, env_substitution).

export interface ParsedAttachment {
	/** Display name for the attachment.  Pulled from the config key
	 * when the input was a map; falls back to a stable hash of the
	 * server-side identity (URL or command) when the user pasted a
	 * bare server config. */
	label: string;
	kind: "http" | "stdio";
	/** kind='http' fields */
	url?: string;
	headers?: Record<string, string>;
	/** kind='stdio' fields */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface ParseResult {
	attachments: ParsedAttachment[];
	/** Per-server warnings (unknown fields silently ignored, etc.) —
	 * surfaced back to the user via the API response so they know
	 * what we did with their paste. */
	warnings: string[];
}

export class McpConfigParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpConfigParseError";
	}
}

/** Parse a JSON-or-object MCP config blob, returning every server
 * the user appears to want attached.  Throws McpConfigParseError on
 * fundamentally unparseable input (not JSON, no recognisable server
 * fields). */
export function parseMcpConfig(input: string | unknown): ParseResult {
	const obj = typeof input === "string" ? safeJsonParse(input) : input;
	if (!isPlainObject(obj)) {
		throw new McpConfigParseError("config must be a JSON object");
	}
	const warnings: string[] = [];
	const map = extractServerMap(obj as Record<string, unknown>, warnings);
	const attachments: ParsedAttachment[] = [];
	for (const [name, raw] of Object.entries(map)) {
		const att = normaliseServer(name, raw, warnings);
		if (att) attachments.push(att);
	}
	if (attachments.length === 0) {
		throw new McpConfigParseError(
			"no MCP servers found in config — expected an `mcpServers` key, a bare server map, or a single server object",
		);
	}
	return { attachments, warnings };
}

function safeJsonParse(s: string): unknown {
	const trimmed = s.trim();
	if (!trimmed) throw new McpConfigParseError("config is empty");
	try {
		return JSON.parse(trimmed);
	} catch (err) {
		throw new McpConfigParseError(`not valid JSON: ${(err as Error).message}`);
	}
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Walk the common wrapper shapes (mcpServers / mcp.servers / servers
 * / bare map / single server) and return a map of name → raw server
 * config.  Names are best-effort: when the user pasted a bare single
 * server, we synthesise a placeholder name. */
function extractServerMap(obj: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
	// Shape 1: { "mcpServers": { name: server, … } }
	if (isPlainObject(obj.mcpServers)) {
		return obj.mcpServers as Record<string, unknown>;
	}
	// Shape 2: { "mcp": { "servers": { name: server, … } } }
	if (isPlainObject(obj.mcp)) {
		const inner = (obj.mcp as Record<string, unknown>).servers;
		if (isPlainObject(inner)) return inner as Record<string, unknown>;
	}
	// Shape 3: { "servers": { name: server, … } }
	if (isPlainObject(obj.servers)) {
		return obj.servers as Record<string, unknown>;
	}
	// Shape 5: bare single server (looks like a server, not a map of servers)
	if (looksLikeServer(obj)) {
		const synthName = inferServerName(obj) ?? "imported-mcp-server";
		return { [synthName]: obj };
	}
	// Shape 4: bare map of servers (every value looks like a server config)
	const allValuesLookLikeServers = Object.values(obj).every(v => isPlainObject(v) && looksLikeServer(v as Record<string, unknown>));
	if (allValuesLookLikeServers && Object.keys(obj).length > 0) {
		return obj;
	}
	warnings.push("could not detect mcpServers wrapper — treating top-level keys as server map");
	return obj;
}

/** Heuristic: does this object look like a single MCP server config?
 * Either has command (stdio) or url (http). */
function looksLikeServer(obj: Record<string, unknown>): boolean {
	return typeof obj.command === "string" || typeof obj.url === "string";
}

/** Best-effort name for a bare server — npm package, command basename,
 * or URL hostname. */
function inferServerName(obj: Record<string, unknown>): string | null {
	if (typeof obj.url === "string") {
		try {
			return new URL(obj.url).hostname.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || null;
		} catch { /* fall through */ }
	}
	if (Array.isArray(obj.args)) {
		// Last arg is often the npm package name (e.g. ["-y", "@chatmcp/server-perplexity-ask"])
		for (let i = obj.args.length - 1; i >= 0; i--) {
			const a = obj.args[i];
			if (typeof a === "string" && /^[@a-z0-9._/-]+$/i.test(a) && !a.startsWith("-")) {
				return a.replace(/^@/, "").replace(/\//g, "-").toLowerCase();
			}
		}
	}
	if (typeof obj.command === "string") {
		return obj.command.split("/").pop()?.toLowerCase() ?? null;
	}
	return null;
}

/** Normalise one server config into our internal AttachmentInput
 * shape.  Returns null when the entry isn't recognisable as a
 * server (caller logs a warning). */
function normaliseServer(name: string, raw: unknown, warnings: string[]): ParsedAttachment | null {
	if (!isPlainObject(raw)) {
		warnings.push(`${name}: not an object, skipping`);
		return null;
	}
	const obj = raw as Record<string, unknown>;
	// Honour explicit disabled flags some clients add.
	if (obj.disabled === true) {
		warnings.push(`${name}: marked disabled in config, skipping`);
		return null;
	}

	const explicitType = typeof obj.type === "string" ? obj.type.toLowerCase() : null;
	const isHttp = explicitType === "http" || explicitType === "streamable-http" || explicitType === "sse"
		|| (typeof obj.url === "string" && !obj.command);
	const isStdio = explicitType === "stdio"
		|| typeof obj.command === "string";

	if (isStdio) {
		const command = String(obj.command ?? "").trim();
		if (!command) {
			warnings.push(`${name}: stdio server missing 'command', skipping`);
			return null;
		}
		const args = Array.isArray(obj.args)
			? obj.args.filter((a): a is string => typeof a === "string")
			: [];
		const env: Record<string, string> = {};
		if (isPlainObject(obj.env)) {
			for (const [k, v] of Object.entries(obj.env)) {
				if (typeof v === "string") env[k] = v;
				else if (typeof v === "number" || typeof v === "boolean") env[k] = String(v);
			}
		}
		return { label: name, kind: "stdio", command, args, env };
	}

	if (isHttp) {
		const url = String(obj.url ?? "").trim();
		if (!url) {
			warnings.push(`${name}: http server missing 'url', skipping`);
			return null;
		}
		const headers: Record<string, string> = {};
		if (isPlainObject(obj.headers)) {
			for (const [k, v] of Object.entries(obj.headers)) {
				if (typeof v === "string") headers[k] = v;
			}
		}
		return { label: name, kind: "http", url, headers };
	}

	warnings.push(`${name}: couldn't detect transport (no 'command' or 'url'), skipping`);
	return null;
}

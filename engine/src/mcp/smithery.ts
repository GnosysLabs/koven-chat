// Smithery URL helpers.
//
// Smithery hosts MCP servers behind URLs of the form:
//
//     https://server.smithery.ai/<qualifiedName>/mcp
//         ?api_key=<user's smithery key>
//         &profile=<profile name, optional>
//         &config=<base64url(json)>     ← per-server config, optional
//
// `qualifiedName` looks like `@modelcontextprotocol/server-github` or
// `exa` (anonymous-namespace style).  The api_key authenticates the
// caller against Smithery's quota; per-server config (e.g. a GitHub
// PAT) gets base64url-encoded JSON in `config`.
//
// We don't talk to Smithery's registry API here — that lives in
// engine/src/mcp/registry.ts (Layer 6).  This module is just URL
// composition for the runtime MCP client.

const SMITHERY_HOST = "https://server.smithery.ai";

export interface SmitheryUrlOpts {
	/** Smithery's package name for the server.  Examples:
	 *   "@modelcontextprotocol/server-github"
	 *   "exa"
	 *   "@upstash/context7-mcp" */
	qualifiedName: string;
	/** Per-user Smithery API key (NOT the per-server credential). */
	apiKey: string;
	/** Optional per-server config blob.  Shape is server-specific —
	 * each server publishes a JSONSchema describing what fields it
	 * accepts (Layer 6 surfaces those in the bot edit UI).  Encoded
	 * as URL-safe base64 of the JSON string. */
	config?: Record<string, unknown>;
	/** Optional Smithery profile name.  Most users have just a
	 * "default" profile; the param is omittable. */
	profile?: string;
}

/** Build the full HTTPS URL for one of a user's Smithery hosted
 * servers, ready to hand to the MCP client transport. */
export function buildSmitheryServerUrl(opts: SmitheryUrlOpts): URL {
	const url = new URL(`${SMITHERY_HOST}/${opts.qualifiedName}/mcp`);
	url.searchParams.set("api_key", opts.apiKey);
	if (opts.profile) url.searchParams.set("profile", opts.profile);
	if (opts.config && Object.keys(opts.config).length > 0) {
		url.searchParams.set("config", base64UrlEncode(JSON.stringify(opts.config)));
	}
	return url;
}

/** URL-safe base64 (RFC 4648 §5) — replace `+` / `/` and strip
 * trailing `=` padding.  Smithery accepts standard base64 too but
 * URL-safe avoids any percent-encoding round-trip surprises. */
function base64UrlEncode(s: string): string {
	const b64 = Buffer.from(s, "utf8").toString("base64");
	return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

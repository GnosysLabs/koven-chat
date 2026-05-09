// Thin wrapper over Smithery's registry HTTP API.
//
// The registry is the user-facing catalog: search by keyword,
// fetch a server's published manifest (description, tags, config
// JSONSchema, deployment status).  It's separate from the runtime
// MCP transport in client.ts — the registry tells you *what's
// available*, then you connect to a specific server with that info.
//
// Auth: registry requests carry the user's per-user Smithery API
// key in the Authorization header.  Required even for public
// listings — Smithery rate-limits anonymous traffic aggressively.
//
// We don't cache results here.  The bot edit form's catalog tab
// queries on user input (debounced) so caching would need
// invalidation logic for marginal gain; the registry is fast.

const REGISTRY_HOST = "https://registry.smithery.ai";
// Cap detail-text fields the registry returns so a misbehaving
// server entry can't blow our response budget.
const MAX_DESCRIPTION_CHARS = 600;
// Default response timeout — registry calls are read-only and
// shouldn't hang the bot edit UI.
const REGISTRY_TIMEOUT_MS = 15_000;

/** A single server entry as exposed by Smithery's catalog.  We pick
 * out only the fields the bot-edit catalog tab actually renders. */
export interface SmitheryServerSummary {
	qualifiedName: string;
	displayName: string;
	description: string;
	homepage?: string;
	useCount?: number;
	isDeployed?: boolean;
}

/** Detailed view — adds the per-server config schema so the UI can
 * render a config form (or, for now, surface required-field hints
 * to the user).  `connections[]` carries the server's transport
 * options; we report whether `http`-style is available since that's
 * what our runtime supports. */
export interface SmitheryServerDetail extends SmitheryServerSummary {
	configSchema?: Record<string, unknown>;
	hasHttpTransport: boolean;
	/** True when Smithery hosts the server (vs. a local-stdio
	 * server).  Remote servers with empty configSchema typically
	 * use Smithery-side OAuth (Reddit, Notion, etc.) — the user
	 * needs to authorize the integration on Smithery's web UI
	 * before the connection will work, and there's no per-call
	 * config we can collect to substitute. */
	remote: boolean;
	/** Public Smithery page for this server, used by the client's
	 * config dialog as the "Configure on Smithery" link.  Always
	 * derived from the qualified name (smithery.ai/server/<name>)
	 * since the registry response doesn't directly include it. */
	smitheryUrl: string;
}

export interface SmitherySearchResult {
	servers: SmitheryServerSummary[];
	totalCount: number;
}

/** Search the catalog.  `query` is free-form; an empty string
 * returns the most-used servers.  Caps page size at 20 — the UI
 * lists a handful in a dropdown, no need to paginate. */
export async function searchSmitheryServers(
	apiKey: string,
	query: string,
	signal?: AbortSignal,
): Promise<SmitherySearchResult> {
	const url = new URL(`${REGISTRY_HOST}/servers`);
	if (query.trim()) url.searchParams.set("q", query.trim());
	url.searchParams.set("pageSize", "20");

	const json = await registryFetch(url, apiKey, signal);
	const rawServers = Array.isArray((json as { servers?: unknown }).servers)
		? (json as { servers: unknown[] }).servers
		: [];
	const servers: SmitheryServerSummary[] = rawServers
		.map(s => normaliseSummary(s))
		.filter((s): s is SmitheryServerSummary => s !== null);
	const totalCount = typeof (json as { pagination?: { totalCount?: number } }).pagination?.totalCount === "number"
		? (json as { pagination: { totalCount: number } }).pagination.totalCount
		: servers.length;
	return { servers, totalCount };
}

/** Fetch the full record for one server, including the config
 * schema and the list of transports it supports. */
export async function getSmitheryServer(
	apiKey: string,
	qualifiedName: string,
	signal?: AbortSignal,
): Promise<SmitheryServerDetail> {
	const url = new URL(`${REGISTRY_HOST}/servers/${encodeURIComponent(qualifiedName)}`);
	const json = await registryFetch(url, apiKey, signal);
	const summary = normaliseSummary(json);
	if (!summary) {
		throw new Error(`Smithery returned no usable record for ${qualifiedName}`);
	}
	const connections = Array.isArray((json as { connections?: unknown }).connections)
		? ((json as { connections: unknown[] }).connections)
		: [];
	const hasHttp = connections.some(c => {
		if (!c || typeof c !== "object") return false;
		const t = (c as { type?: unknown }).type;
		return t === "http" || t === "streamable-http";
	});
	// Prefer the http-connection's configSchema (that's the one the
	// runtime will actually use); fall back to a top-level schema if
	// present on older registry entries.
	const httpConn = connections.find(c =>
		c && typeof c === "object"
		&& ((c as { type?: unknown }).type === "http" || (c as { type?: unknown }).type === "streamable-http"),
	) as { configSchema?: unknown } | undefined;
	const schema = (httpConn?.configSchema && typeof httpConn.configSchema === "object")
		? httpConn.configSchema as Record<string, unknown>
		: ((json as { configSchema?: unknown }).configSchema && typeof (json as { configSchema?: unknown }).configSchema === "object")
			? (json as { configSchema: Record<string, unknown> }).configSchema
			: undefined;
	const remote = (json as { remote?: unknown }).remote === true
		|| typeof (json as { deploymentUrl?: unknown }).deploymentUrl === "string";
	return {
		...summary,
		configSchema: schema,
		hasHttpTransport: hasHttp,
		remote,
		smitheryUrl: `https://smithery.ai/server/${qualifiedName}`,
	};
}

async function registryFetch(url: URL, apiKey: string, signal?: AbortSignal): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
	// If the caller supplied a signal, plumb it through — abort
	// theirs OR the timeout aborts the inner controller.
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", () => controller.abort(), { once: true });
	}
	let res: Response;
	try {
		res = await fetch(url, {
			headers: {
				"Authorization": `Bearer ${apiKey}`,
				"Accept": "application/json",
			},
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`smithery registry ${res.status}: ${body.slice(0, 200) || res.statusText}`);
	}
	return res.json() as Promise<unknown>;
}

function normaliseSummary(raw: unknown): SmitheryServerSummary | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const qualifiedName = typeof r.qualifiedName === "string" ? r.qualifiedName : null;
	if (!qualifiedName) return null;
	return {
		qualifiedName,
		displayName: typeof r.displayName === "string" && r.displayName.trim().length > 0
			? r.displayName
			: qualifiedName,
		description: typeof r.description === "string"
			? r.description.slice(0, MAX_DESCRIPTION_CHARS)
			: "",
		homepage: typeof r.homepage === "string" ? r.homepage : undefined,
		useCount: typeof r.useCount === "number" ? r.useCount : undefined,
		isDeployed: typeof r.isDeployed === "boolean" ? r.isDeployed : undefined,
	};
}

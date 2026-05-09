// MCP client wrapper for the Koven engine.
//
// Wraps `@modelcontextprotocol/sdk`'s Streamable HTTP transport with
// a small surface tuned to how the bot runtime actually uses it:
//
//   - openMcpSession(url)     → connect + handshake + initialize
//   - listMcpTools(session)   → array of OpenAI-shaped tool defs
//   - callMcpTool(session, name, args) → tool result, OR error string
//   - closeMcpSession(session)
//
// Sessions are stateful — the SDK holds a single HTTP/2 stream per
// session and reuses it for every request.  The bot runtime opens one
// session per (bot, server) pair when the bot starts generating, and
// closes them all when the response is done.  We don't pool across
// turns; tool listings are cached one layer up via the registry
// module instead (cheaper than holding open sockets between turns).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const KOVEN_CLIENT_INFO = {
	name: "koven-engine",
	version: "0.0.1",
};

/** Opaque handle returned from openMcpSession.  Holds both the
 * connected SDK client and the transport, so closeMcpSession can
 * tear both down cleanly. */
export interface McpSession {
	client: Client;
	transport: StreamableHTTPClientTransport;
	/** The URL we connected to.  Useful for log messages and for
	 * diagnostics when a tool call fails. */
	url: string;
}

/** OpenAI-shaped tool definition — exactly what we hand to the LLM
 * provider.  We do the schema translation here (vs. in the bot
 * runtime) so callers don't have to know MCP's JSON-RPC shape. */
export interface OpenAITool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters: Record<string, unknown>;  // JSONSchema, opaque to us
	};
}

/** Open a streaming MCP session against a hosted server.  Throws
 * when the URL is malformed, the network is unreachable, or the
 * server's initialize handshake fails.  Caller is responsible for
 * closing the session when done.
 *
 * `headers` (optional) are merged into every request the SDK fires
 * — typical use is passing `{ Authorization: "Bearer <pat>" }` for
 * token-protected servers. */
export async function openMcpSession(
	url: string | URL,
	headers?: Record<string, string>,
): Promise<McpSession> {
	const urlStr = typeof url === "string" ? url : url.toString();
	const transport = new StreamableHTTPClientTransport(new URL(urlStr), {
		// requestInit is forwarded to every fetch the transport
		// makes (initialize, list_tools, call_tool, etc.).
		requestInit: headers && Object.keys(headers).length > 0
			? { headers }
			: undefined,
	});
	const client = new Client(KOVEN_CLIENT_INFO, { capabilities: {} });
	await client.connect(transport);
	return { client, transport, url: urlStr };
}

/** List the server's available tools, translated into the OpenAI
 * `tools[]` shape so the bot runtime can pass them straight through
 * to the chat-completion API. */
export async function listMcpTools(session: McpSession): Promise<OpenAITool[]> {
	const res = await session.client.listTools();
	return res.tools.map(t => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			// MCP tools' inputSchema is already a JSONSchema; OpenAI's
			// `parameters` field expects exactly that.  Empty schema
			// becomes `{ type: "object", properties: {} }` so the LLM
			// understands the call takes no arguments.
			parameters: (t.inputSchema as Record<string, unknown> | undefined)
				?? { type: "object", properties: {} },
		},
	}));
}

/** Result of a single tool invocation.  Mirrors MCP's content-block
 * model — most tools return one or more text blocks; some return
 * structured JSON.  We flatten everything into a single string for
 * the LLM (it's the only consumer right now); callers needing raw
 * structured data should look at McpToolResult.contents directly. */
export interface McpToolResult {
	/** Stringified result suitable for handing back to the LLM as a
	 * `tool` role message.  Concatenates text blocks; serialises
	 * resource / image blocks to a brief placeholder. */
	text: string;
	/** True when the server returned `isError: true` — tool ran but
	 * reported a failure (vs. transport error which throws). */
	isError: boolean;
}

/** Invoke a tool by name.  Throws on transport / protocol failure;
 * returns `{ isError: true }` for tool-reported failures so callers
 * can feed the error message back to the LLM as a tool result. */
export async function callMcpTool(
	session: McpSession,
	name: string,
	args: Record<string, unknown>,
): Promise<McpToolResult> {
	const res = await session.client.callTool({ name, arguments: args });
	const blocks = (res.content ?? []) as Array<{ type: string; text?: string; data?: unknown }>;
	const parts: string[] = [];
	for (const b of blocks) {
		if (b.type === "text" && typeof b.text === "string") {
			parts.push(b.text);
		} else if (b.type === "image") {
			parts.push("[image content]");
		} else if (b.type === "resource") {
			parts.push("[resource]");
		} else {
			// Unknown block type — try to JSON-stringify whatever's there.
			try { parts.push(JSON.stringify(b)); } catch { parts.push(`[${b.type}]`); }
		}
	}
	return {
		text: parts.length > 0 ? parts.join("\n") : "(no content)",
		isError: res.isError === true,
	};
}

/** Close the underlying transport — drops the HTTP stream, flushes
 * any pending writes, releases the session id.  Idempotent: calling
 * twice on the same session is safe (the SDK no-ops). */
export async function closeMcpSession(session: McpSession): Promise<void> {
	try {
		await session.transport.close();
	} catch (err) {
		// Closing a transport that's already torn down throws on
		// some MCP SDK versions.  Not actionable; log and move on.
		console.warn(`mcp: close transport failed for ${session.url}`, err);
	}
}

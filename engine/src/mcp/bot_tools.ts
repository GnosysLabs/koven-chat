// Per-bot MCP tool gathering / routing.
//
// Bridges the stored bot↔server attachments and the LLM tool-use
// loop in bot_pipeline.ts.  Responsibilities:
//
//   1. Open one MCP session per attached server for the bot.
//   2. Concatenate all servers' tool listings into a single OpenAI
//      `tools[]` array, with names namespaced so two servers can
//      both expose e.g. `search` without colliding.
//   3. Route an `AssistantToolCall` from the LLM back to the right
//      session by parsing the namespace prefix.
//   4. Tear all sessions down on demand.
//
// Naming scheme: `srv<id>__<originalToolName>` — the prefix is the
// `bot_mcp_servers.id` row id (a number) so it's compact, unique
// per-bot, and trivially OpenAI-tool-name compliant (the regex is
// `^[a-zA-Z0-9_-]+$`, no `/` or `@` allowed).
//
// We're protocol-pure: no catalog, no proxy, no platform-specific
// glue.  An attached server is a Streamable-HTTP URL plus optional
// headers; we hand both to the MCP SDK's transport.  When a single
// server fails to open we log + skip it so one broken server
// doesn't blank-tool the whole bot.

import {
	openMcpSession,
	openStdioMcpSession,
	listMcpTools,
	callMcpTool,
	closeMcpSession,
	type McpSession,
	type McpToolResult,
} from "./client";
import {
	listBotMcpServers,
	type BotRow,
} from "../db";
import type { ToolDefinition } from "../llm_client";

const TOOL_PREFIX = "srv";
const TOOL_SEPARATOR = "__";

/** One opened MCP session, keyed back to the DB row that produced it
 * so the router can look it up by the namespace prefix. */
export interface BotMcpRoute {
	rowId: number;
	label: string;
	url: string;
	session: McpSession;
}

export interface BotMcpBundle {
	/** Tools to hand to chatCompletion().  Empty when no servers
	 * were usable (no attachments, or all opens failed). */
	tools: ToolDefinition[];
	/** Routing table for tool-call dispatch.  Keyed by row id so
	 * `parseToolName` can index directly. */
	routes: Map<number, BotMcpRoute>;
}

/** Open all MCP sessions for `bot` and assemble a tools[] bundle.
 *
 * Never throws — individual server failures are logged and skipped.
 * The caller MUST eventually invoke `closeBotMcpBundle(bundle)` to
 * release the underlying HTTP streams (do this in a `finally`). */
export async function openBotMcpBundle(bot: BotRow): Promise<BotMcpBundle> {
	const empty: BotMcpBundle = { tools: [], routes: new Map() };

	const attachments = listBotMcpServers(bot.id);
	if (attachments.length === 0) return empty;

	const tools: ToolDefinition[] = [];
	const routes = new Map<number, BotMcpRoute>();

	// Open sequentially rather than Promise.all so one server's
	// handshake blocking the event loop doesn't starve the others;
	// also keeps log output sane.  In practice bots will have ≤3
	// servers attached so the latency cost is fine.
	for (const att of attachments) {
		// Identifier for log messages — for HTTP attachments it's
		// the URL, for stdio it's "command args…".  Keeps the
		// stdio path's logs readable without leaking env vars.
		const labelOrId = att.label || (att.kind === "stdio"
			? `${att.command} ${att.args.join(" ")}`.trim()
			: att.url);
		try {
			// Dispatch on transport kind.  Both functions return the
			// same McpSession shape so downstream code (tools list,
			// tool-call routing) doesn't need to discriminate.
			const session = att.kind === "stdio"
				? await openStdioMcpSession({
					botId: bot.id,
					command: att.command ?? "",
					args: att.args,
					env: att.env,
					label: att.label || labelOrId,
				})
				: await openMcpSession(att.url, att.headers);
			const serverTools = await listMcpTools(session);
			routes.set(att.id, {
				rowId: att.id,
				label: att.label,
				url: att.kind === "stdio" ? `stdio: ${att.command ?? ""}` : att.url,
				session,
			});
			for (const t of serverTools) {
				tools.push({
					type: "function",
					function: {
						name: namespaceToolName(att.id, t.function.name),
						description: prefixDescription(att.label || labelOrId, t.function.description),
						parameters: t.function.parameters,
					},
				});
			}
			console.log(
				`bot ${bot.mxid}: MCP ${labelOrId} ready (${serverTools.length} tools)`,
			);
		} catch (err) {
			console.warn(
				`bot ${bot.mxid}: MCP ${labelOrId} failed to open — skipping`,
				err,
			);
		}
	}

	return { tools, routes };
}

/** Close every session in `bundle`.  Idempotent and best-effort —
 * close failures are logged inside `closeMcpSession`, no exceptions
 * propagate. */
export async function closeBotMcpBundle(bundle: BotMcpBundle): Promise<void> {
	await Promise.all(
		Array.from(bundle.routes.values()).map(r => closeMcpSession(r.session)),
	);
}

/** Dispatch one tool invocation back to the originating server.
 * Returns a stringified result suitable for handing to the LLM as a
 * `tool` role message.  Errors come back as result strings so the
 * model can see them and decide whether to retry / give up. */
export async function dispatchToolCall(
	bundle: BotMcpBundle,
	namespacedName: string,
	args: Record<string, unknown>,
): Promise<McpToolResult> {
	const parsed = parseToolName(namespacedName);
	if (!parsed) {
		return {
			text: `Error: tool name "${namespacedName}" is not in the expected "${TOOL_PREFIX}<id>${TOOL_SEPARATOR}<tool>" format.`,
			isError: true,
		};
	}
	const route = bundle.routes.get(parsed.rowId);
	if (!route) {
		return {
			text: `Error: no MCP server route for prefix "${TOOL_PREFIX}${parsed.rowId}".`,
			isError: true,
		};
	}
	try {
		return await callMcpTool(route.session, parsed.toolName, args);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			text: `Error invoking ${route.label || route.url}/${parsed.toolName}: ${detail}`,
			isError: true,
		};
	}
}

function namespaceToolName(rowId: number, toolName: string): string {
	return `${TOOL_PREFIX}${rowId}${TOOL_SEPARATOR}${toolName}`;
}

/** Pretty-print a namespaced tool name for the bot's progress
 * placeholder: returns the tool's bare name plus a friendly server
 * label.  Returns null when the name doesn't parse / no route
 * matches; caller falls back to the raw name. */
export function describeToolCall(
	bundle: BotMcpBundle,
	namespacedName: string,
): { tool: string; server: string } | null {
	const parsed = parseToolName(namespacedName);
	if (!parsed) return null;
	const route = bundle.routes.get(parsed.rowId);
	if (!route) return null;
	return { tool: parsed.toolName, server: route.label || route.url };
}

interface ParsedToolName {
	rowId: number;
	toolName: string;
}

function parseToolName(namespaced: string): ParsedToolName | null {
	if (!namespaced.startsWith(TOOL_PREFIX)) return null;
	const sepIdx = namespaced.indexOf(TOOL_SEPARATOR);
	if (sepIdx <= TOOL_PREFIX.length) return null;
	const idStr = namespaced.slice(TOOL_PREFIX.length, sepIdx);
	const rowId = Number(idStr);
	if (!Number.isInteger(rowId) || rowId <= 0) return null;
	const toolName = namespaced.slice(sepIdx + TOOL_SEPARATOR.length);
	if (toolName.length === 0) return null;
	return { rowId, toolName };
}

/** Tag the tool description with its server label so the model can
 * reason about provenance ("ask grokipedia vs. ask exa"). */
function prefixDescription(serverLabel: string, original: string | undefined): string {
	const tag = `[${serverLabel}]`;
	if (!original) return tag;
	return `${tag} ${original}`;
}

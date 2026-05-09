// Per-bot MCP tool gathering / routing.
//
// This is the bridge between Layer 4's stored bot↔server attachments
// and the LLM tool-use loop in bot_pipeline.ts.  Responsibilities:
//
//   1. Open one MCP session per attached server for the bot.
//   2. Concatenate all servers' tool listings into a single OpenAI
//      `tools[]` array, with names namespaced so two servers can both
//      expose e.g. `search` without colliding.
//   3. Route an `AssistantToolCall` from the LLM back to the right
//      session by parsing the namespace prefix.
//   4. Tear all sessions down on demand.
//
// Naming scheme: `srv<id>__<originalToolName>` — the prefix is the
// `bot_mcp_servers.id` row id (a number) so it's compact, unique
// per-bot, and trivially OpenAI-tool-name compliant (the regex is
// `^[a-zA-Z0-9_-]+$`, no `/` or `@` allowed which rules out raw
// qualified names like `@modelcontextprotocol/server-github`).
//
// When the bot owner has no Smithery key configured, this module
// returns an empty result — the pipeline continues as the no-tools
// path.  When a single server fails to open we log + skip it; one
// broken server shouldn't blank-tool the whole bot.

import {
	openMcpSession,
	listMcpTools,
	callMcpTool,
	closeMcpSession,
	type McpSession,
	type McpToolResult,
} from "./client";
import { buildSmitheryServerUrl } from "./smithery";
import {
	listBotMcpServers,
	getUserIntegrationSecretEnc,
	type BotRow,
	type BotMcpServer,
} from "../db";
import { openSecret } from "../secret_box";
import type { ToolDefinition } from "../llm_client";

const TOOL_PREFIX = "srv";
const TOOL_SEPARATOR = "__";

/** One opened MCP session, keyed back to the DB row that produced it
 * so the router can look it up by the namespace prefix. */
export interface BotMcpRoute {
	rowId: number;
	qualifiedName: string;
	session: McpSession;
}

export interface BotMcpBundle {
	/** Tools to hand to chatCompletion().  Empty when no servers were
	 * usable (no key, no attachments, or all opens failed). */
	tools: ToolDefinition[];
	/** Routing table for tool-call dispatch.  Keyed by row id (number)
	 * so `parseToolName` can index directly. */
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

	// Decrypt the bot owner's Smithery key.  All of this bot's MCP
	// servers share the same key — that's the locked design decision
	// (per-user, not per-bot, so adding another bot doesn't mean
	// re-pasting the same secret).
	const apiKeyEnc = getUserIntegrationSecretEnc(bot.owner_id, "smithery");
	if (!apiKeyEnc) {
		console.warn(
			`bot ${bot.mxid}: ${attachments.length} MCP server(s) attached but owner has no Smithery key — skipping MCP`,
		);
		return empty;
	}
	let smitheryKey: string;
	try {
		smitheryKey = openSecret(apiKeyEnc);
	} catch (err) {
		console.error(`bot ${bot.mxid}: Smithery key decrypt failed`, err);
		return empty;
	}

	const tools: ToolDefinition[] = [];
	const routes = new Map<number, BotMcpRoute>();

	// Open sequentially rather than Promise.all so one server's
	// handshake blocking the event loop doesn't starve the others;
	// also keeps log output sane.  In practice bots will have ≤3
	// servers attached so the latency cost is fine.
	for (const att of attachments) {
		try {
			const url = buildSmitheryServerUrl({
				qualifiedName: att.smithery_qualified_name,
				apiKey: smitheryKey,
				config: att.config,
			});
			const session = await openMcpSession(url);
			const serverTools = await listMcpTools(session);
			routes.set(att.id, {
				rowId: att.id,
				qualifiedName: att.smithery_qualified_name,
				session,
			});
			for (const t of serverTools) {
				tools.push({
					type: "function",
					function: {
						name: namespaceToolName(att.id, t.function.name),
						description: prefixDescription(att, t.function.description),
						parameters: t.function.parameters,
					},
				});
			}
			console.log(
				`bot ${bot.mxid}: MCP ${att.smithery_qualified_name} ready (${serverTools.length} tools)`,
			);
		} catch (err) {
			console.warn(
				`bot ${bot.mxid}: MCP ${att.smithery_qualified_name} failed to open — skipping`,
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
 * `tool` role message.  When the namespaced name doesn't resolve to a
 * known route we return an error string so the model can see what
 * went wrong (vs. throwing, which would abort the loop). */
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
		// Transport / protocol failure — don't kill the loop; let the
		// model see the error and decide whether to retry / give up.
		const detail = err instanceof Error ? err.message : String(err);
		return {
			text: `Error invoking ${route.qualifiedName}/${parsed.toolName}: ${detail}`,
			isError: true,
		};
	}
}

function namespaceToolName(rowId: number, toolName: string): string {
	return `${TOOL_PREFIX}${rowId}${TOOL_SEPARATOR}${toolName}`;
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

/** Keep the original tool description but tag it with the source
 * server's qualified name so the model can reason about provenance
 * ("ask GitHub vs. ask Notion"). */
function prefixDescription(att: BotMcpServer, original: string | undefined): string {
	const tag = `[${att.smithery_qualified_name}]`;
	if (!original) return tag;
	return `${tag} ${original}`;
}

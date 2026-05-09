// Manual smoke test for the MCP client wrapper.  Connects to a
// Smithery-hosted server, lists its tools, optionally invokes one,
// then closes.  Confirms the Layer 3 plumbing works end-to-end
// before we wire it into the bot runtime in Layer 5.
//
// USAGE
//
//   SMITHERY_API_KEY=... \
//     bun engine/scripts/test-mcp.ts <qualifiedName> [toolName] [argsJson]
//
// EXAMPLES
//
//   # List tools from the reference "everything" server
//   bun engine/scripts/test-mcp.ts "@modelcontextprotocol/server-everything"
//
//   # List + call a tool
//   bun engine/scripts/test-mcp.ts "@modelcontextprotocol/server-everything" \
//     "echo" '{"message":"hello"}'

import {
	openMcpSession,
	listMcpTools,
	callMcpTool,
	closeMcpSession,
} from "../src/mcp/client";
import { buildSmitheryServerUrl } from "../src/mcp/smithery";

async function main() {
	const apiKey = process.env.SMITHERY_API_KEY;
	if (!apiKey) {
		console.error("SMITHERY_API_KEY env var required.");
		process.exit(2);
	}
	const qualifiedName = process.argv[2];
	if (!qualifiedName) {
		console.error("Usage: bun test-mcp.ts <qualifiedName> [toolName] [argsJson]");
		process.exit(2);
	}
	const toolName = process.argv[3];
	const argsJson = process.argv[4];

	const url = buildSmitheryServerUrl({ qualifiedName, apiKey });
	console.log(`[mcp-test] connecting to ${qualifiedName}…`);
	const session = await openMcpSession(url);

	console.log(`[mcp-test] listing tools…`);
	const tools = await listMcpTools(session);
	console.log(`[mcp-test] ${tools.length} tools:`);
	for (const t of tools) {
		console.log(`  - ${t.function.name}: ${t.function.description ?? "(no description)"}`);
	}

	if (toolName) {
		const args = argsJson ? JSON.parse(argsJson) : {};
		console.log(`[mcp-test] calling ${toolName}(${JSON.stringify(args)})…`);
		try {
			const result = await callMcpTool(session, toolName, args);
			console.log(`[mcp-test] result (isError=${result.isError}):\n${result.text}`);
		} catch (err) {
			console.error(`[mcp-test] tool invocation failed:`, err);
		}
	}

	await closeMcpSession(session);
	console.log(`[mcp-test] done.`);
}

main().catch((err) => {
	console.error("[mcp-test] fatal:", err);
	process.exit(1);
});

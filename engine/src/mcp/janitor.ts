// Disk janitor for stdio MCP scratch dirs.
//
// Each bot with stdio attachments gets a per-bot scratch dir at
// /var/lib/koven-mcp/<bot_id>/ that holds npm/uv caches + temp files.
// These accumulate over time as users attach + detach servers; if we
// never clean up, disk fills with cache for bots nobody touches
// anymore.
//
// Runs on engine tick (every config.tickIntervalMs).  Cheap:
//   1. List scratch dir entries (fast — usually <100 dirs).
//   2. For each entry, stat its mtime — if older than IDLE_DAYS AND
//      no MCP attachments reference it, rm -rf.
//   3. Bot-deletion path also calls deleteBotScratchDir directly so
//      orphan cleanup is rare.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { listBotMcpServers } from "../db";

const SCRATCH_ROOT = "/var/lib/koven-mcp";
// Bots whose scratch dirs haven't been touched for this long are
// candidates for cleanup.  npm/uv re-download on next attach is a
// few-second tax; not having unused cache lying around is worth it.
const IDLE_DAYS = 30;
const IDLE_MS = IDLE_DAYS * 24 * 60 * 60 * 1000;

/** Walk the scratch root + delete dirs whose owning bot has no
 * stdio attachments AND whose mtime is older than IDLE_DAYS.  Best-
 * effort: any IO errors are logged and skipped, never thrown. */
export function gcMcpScratchDirs(): void {
	if (!existsSync(SCRATCH_ROOT)) return;
	let entries: string[];
	try {
		entries = readdirSync(SCRATCH_ROOT);
	} catch (err) {
		console.warn(`mcp/janitor: readdir ${SCRATCH_ROOT} failed:`, err);
		return;
	}
	const now = Date.now();
	let removed = 0;
	for (const name of entries) {
		const botId = parseInt(name, 10);
		if (!Number.isFinite(botId)) continue; // not a bot dir
		const dir = join(SCRATCH_ROOT, name);
		try {
			const st = statSync(dir);
			if (!st.isDirectory()) continue;
			// Has the bot still got stdio attachments?  If so, keep
			// the dir — even an idle bot might fire next week and
			// we'd rather not pay the cold-start tax.
			const stdioAtts = listBotMcpServers(botId).filter(a => a.kind === "stdio");
			if (stdioAtts.length > 0) continue;
			// No live attachments AND idle long enough → nuke.
			if (now - st.mtimeMs < IDLE_MS) continue;
			rmSync(dir, { recursive: true, force: true });
			removed++;
		} catch (err) {
			console.warn(`mcp/janitor: stat/rm ${dir} failed:`, err);
		}
	}
	if (removed > 0) {
		console.log(`mcp/janitor: removed ${removed} idle scratch dirs`);
	}
}

/** Delete one bot's scratch dir immediately.  Called from the
 * bot-delete path so a removed bot doesn't leak its cache.  No-op
 * if the dir doesn't exist. */
export function deleteBotScratchDir(botId: number): void {
	const dir = join(SCRATCH_ROOT, String(botId));
	if (!existsSync(dir)) return;
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch (err) {
		console.warn(`mcp/janitor: rm ${dir} failed:`, err);
	}
}

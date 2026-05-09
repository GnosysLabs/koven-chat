// Entry point.  Initializes the DB (side-effect of importing it),
// kicks off the recurring weight + collapse tick, and brings the HTTP
// server up.

import { config } from "./config";
import "./db";
import { startServer } from "./server";
import { tick } from "./weight";
import { gcMcpScratchDirs } from "./mcp/janitor";
import { evaluateCollapses } from "./collapse";
import { bootstrapAdminIfNeeded } from "./admins";
import { startAllBots, stopAllBots } from "./bot_manager";
import { registerAppserviceUser } from "./synapse";

console.log(`engine: starting — homeserver=${config.homeserverUrl} db=${config.dbPath}`);

// Ensure @engine (the appservice's sender_localpart user) actually
// exists on Synapse.  In theory Synapse auto-creates appservice
// sender users on first contact; in practice we've seen homeservers
// where it didn't happen — every operation that masquerades as
// @engine fails with "User not found" / "user not in room", and
// joinRoomIfNeeded / sendBotEvent / repairRoomInvitePL all silently
// degrade.  This was the actual cause of the recurring "[403] You
// don't have permission to invite users" — the PL repair flow
// couldn't write a new state event because @engine didn't exist.
//
// Idempotent: AS-register returns the same shape on a fresh user,
// and on `M_USER_IN_USE` (already registered) we treat the error as
// a success and move on.
{
	const colon = config.engineUserId.indexOf(":");
	const localpart = colon > 1 ? config.engineUserId.slice(1, colon) : "engine";
	void registerAppserviceUser({ username: localpart })
		.then(r => {
			if ("error" in r) {
				const detail = r.detail ?? r.error ?? "";
				if (/M_USER_IN_USE|user_in_use/i.test(detail)) {
					// Already there from a previous boot — fine.
					return;
				}
				console.warn(`engine: ${config.engineUserId} register failed: ${r.error} ${r.detail ?? ""}`);
			} else {
				console.log(`engine: registered ${config.engineUserId} on Synapse`);
			}
		})
		.catch(err => console.warn(`engine: ${config.engineUserId} register threw`, err));
}

startServer();

// Start every enabled bot in the background.  We don't await this —
// bot startup involves /sync and crypto init, which can take seconds.
// Errors are logged inside the manager; the engine stays up either way.
startAllBots().catch(err => console.error("engine: startAllBots failed", err));

// Graceful shutdown: stop bots so they flush sync state + crypto.
const shutdownSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
for (const sig of shutdownSignals) {
	process.on(sig, () => {
		console.log(`engine: caught ${sig}, stopping bots...`);
		stopAllBots()
			.catch(err => console.error("engine: stopAllBots failed", err))
			.finally(() => process.exit(0));
	});
}

let mcpJanitorTickCount = 0;
const MCP_JANITOR_INTERVAL_TICKS = 60; // run roughly every hour at default 1-min tick

async function fullTick(): Promise<void> {
	// Weights first so freshly-arrived flaggers have a current weight
	// when the collapse evaluator reads from the weights table.
	const users = tick();
	// Promote the first user we've seen if no admin exists yet.  Cheap
	// — early-returns once an admin is set.
	bootstrapAdminIfNeeded();
	const collapses = await evaluateCollapses().catch(err => {
		console.error("engine: evaluateCollapses failed", err);
		return 0;
	});
	if (users > 0 || collapses > 0) {
		console.log(`engine: tick — ${users} users, ${collapses} new collapses`);
	}
	// MCP scratch-dir janitor.  Cheap (just stat + readdir) but no
	// reason to run every minute — once an hour is plenty for a
	// 30-day idle window.
	if (++mcpJanitorTickCount >= MCP_JANITOR_INTERVAL_TICKS) {
		mcpJanitorTickCount = 0;
		try {
			gcMcpScratchDirs();
		} catch (err) {
			console.error("engine: mcp scratch-dir GC failed", err);
		}
	}
}

// Run once on boot, then on the configured cadence.
fullTick();
setInterval(fullTick, config.tickIntervalMs);

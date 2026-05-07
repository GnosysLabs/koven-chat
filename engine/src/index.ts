// Entry point.  Initializes the DB (side-effect of importing it),
// kicks off the recurring weight + collapse tick, and brings the HTTP
// server up.

import { config } from "./config";
import "./db";
import { startServer } from "./server";
import { tick } from "./weight";
import { evaluateCollapses } from "./collapse";
import { bootstrapAdminIfNeeded } from "./admins";
import { startAllBots, stopAllBots } from "./bot_manager";

console.log(`engine: starting — homeserver=${config.homeserverUrl} db=${config.dbPath}`);

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
}

// Run once on boot, then on the configured cadence.
fullTick();
setInterval(fullTick, config.tickIntervalMs);

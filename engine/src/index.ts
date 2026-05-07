// Entry point.  Initializes the DB (side-effect of importing it),
// kicks off the recurring weight + collapse tick, and brings the HTTP
// server up.

import { config } from "./config";
import "./db";
import { startServer } from "./server";
import { tick } from "./weight";
import { evaluateCollapses } from "./collapse";
import { bootstrapAdminIfNeeded } from "./admins";

console.log(`engine: starting — homeserver=${config.homeserverUrl} db=${config.dbPath}`);

startServer();

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

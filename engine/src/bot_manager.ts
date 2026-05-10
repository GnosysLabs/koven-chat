// Top-level supervisor for all bot runtimes on this engine.
// Owns the Map<botId, RunningBot> and the start/stop API the rest
// of the engine talks to.
//
//   - On engine boot: start every enabled bot.
//   - On bot create (POST /api/bots): start the new bot.
//   - On bot patch (PATCH): if `enabled` flipped, start or stop.
//   - On bot delete (DELETE): stop the bot first, then drop its row.
//
// Failures inside one bot don't affect the others — each bot's
// startBot() runs in isolation, errors are logged, and the manager
// keeps going.

import { listAllEnabledBots, getBotById } from "./db";
import { startBot, type RunningBot } from "./bot_runtime";

const running = new Map<number, RunningBot>();

/** Start every bot that's currently `enabled = 1` in the DB. */
export async function startAllBots(): Promise<void> {
	const bots = listAllEnabledBots();
	if (bots.length === 0) {
		console.log("bot manager: no enabled bots to start");
		return;
	}
	console.log(`bot manager: starting ${bots.length} bot(s)`);
	// Start in parallel — one slow startup shouldn't gate the others.
	await Promise.all(bots.map(async bot => {
		try {
			const rt = await startBot(bot);
			running.set(bot.id, rt);
		} catch (err) {
			console.error(`bot manager: failed to start ${bot.mxid}`, err);
		}
	}));
}

/** Boot a single bot by id (used after POST /api/bots). */
export async function startOne(botId: number): Promise<void> {
	if (running.has(botId)) return;
	const bot = getBotById(botId);
	if (!bot || !bot.enabled) return;
	try {
		const rt = await startBot(bot);
		running.set(botId, rt);
	} catch (err) {
		console.error(`bot manager: failed to start bot ${botId}`, err);
	}
}

/** Stop a single bot by id (used before DELETE / on disable). */
export async function stopOne(botId: number): Promise<void> {
	const rt = running.get(botId);
	if (!rt) return;
	running.delete(botId);
	try {
		await rt.stop();
	} catch (err) {
		console.warn(`bot manager: stop ${rt.mxid} threw`, err);
	}
}

/** Reconcile a single bot's running state with its DB row.  Useful
 * after a PATCH that toggles `enabled`. */
export async function reconcileOne(botId: number): Promise<void> {
	const bot = getBotById(botId);
	const isRunning = running.has(botId);
	if (!bot) {
		if (isRunning) await stopOne(botId);
		return;
	}
	const wantRunning = bot.enabled === 1;
	if (wantRunning && !isRunning) await startOne(botId);
	else if (!wantRunning && isRunning) await stopOne(botId);
}

/** Stop every running bot (used during graceful shutdown). */
export async function stopAllBots(): Promise<void> {
	const ids = Array.from(running.keys());
	await Promise.all(ids.map(id => stopOne(id)));
}

/** Look up the live RunningBot for a bot id, or null if it's not
 * currently running.  Used by the webhook inbound endpoint so it
 * can post via the bot's matrix-js-sdk client (with the bot's
 * crypto state already loaded — important for posting into
 * encrypted rooms). */
export function getRunningBot(botId: number): RunningBot | null {
	return running.get(botId) ?? null;
}

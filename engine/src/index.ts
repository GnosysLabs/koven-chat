// Entry point.  Initializes the DB (side-effect of importing it),
// kicks off the recurring housekeeping tick, and brings the HTTP
// server up.
//
// The old consensus-moderation pipeline (auto-collapse evaluation)
// used to run from this tick; it's gone now.  Koven moderation is
// admin-driven via standard Matrix kick/ban/redact, with flags
// surfacing to an admin review queue.

import { config } from "./config";
import "./db";
import { startServer } from "./server";
import { gcMcpScratchDirs } from "./mcp/janitor";
import { reapStaleCallParticipants, cleanupQrSessions } from "./db";
import { bootstrapAdminIfNeeded } from "./admins";
import { startAllBots, stopAllBots } from "./bot_manager";
import { adminListLocalUsersByRegistration, registerAppserviceUser } from "./synapse";
import { FOUNDER_CAP_PUBLIC, claimFounderNumber, getFounderCount } from "./db";

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

// One-shot Founders backfill.  When the table is empty (first boot
// after this feature ships) we populate it from Synapse's admin user
// list ordered by registration time, so existing users who signed
// up before the feature get their badges in the correct order
// without needing to re-register.  Idempotent — guarded on the
// table being empty, so subsequent boots no-op.  Failures (admin
// API down, network blip) are non-fatal: the engine stays up and
// new signups still claim through the verify-code path.
{
	const existing = getFounderCount();
	if (existing === 0) {
		console.log(`engine: Founders table empty, backfilling first ${FOUNDER_CAP_PUBLIC} users from Synapse...`);
		void adminListLocalUsersByRegistration(FOUNDER_CAP_PUBLIC)
			.then(users => {
				let claimed = 0;
				for (const u of users) {
					const n = claimFounderNumber(u.user_id);
					if (n !== null) claimed++;
				}
				console.log(`engine: Founders backfill complete — claimed ${claimed} of ${FOUNDER_CAP_PUBLIC} slots`);
			})
			.catch(err => console.error("engine: Founders backfill failed", err));
	} else {
		console.log(`engine: Founders table has ${existing} of ${FOUNDER_CAP_PUBLIC} slots, skipping backfill`);
	}
}

// Start every enabled bot in the background.  We don't await this —
// bot startup involves /sync and crypto init, which can take seconds.
// Errors are logged inside the manager; the engine stays up either way.
startAllBots().catch(err => console.error("engine: startAllBots failed", err));

// Self-register the Cloudflare RealtimeKit webhook so participant
// join/leave events flow back into our `room_call_participants`
// mirror.  PUBLIC_ENGINE_URL is the externally-reachable base of
// this engine (e.g. https://client.koven.chat) — must be set in
// prod for registration to fire.  Idempotent: lists existing
// webhooks first and only POSTs if a matching one isn't found.
import { ensureWebhookRegistered } from "./calls";
import { reapIdleBrowserSessions } from "./browser";
ensureWebhookRegistered({
	publicEngineUrl: process.env.PUBLIC_ENGINE_URL || null,
}).catch(err => console.error("engine: ensureWebhookRegistered failed", err));

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
	// Promote the first user we've seen if no admin exists yet.  Cheap
	// — early-returns once an admin is set.  The previous tick also
	// ran weight recomputation + the consensus-collapse evaluator;
	// both went away when Koven switched to admin-driven moderation.
	bootstrapAdminIfNeeded();
	const reaped = reapStaleCallParticipants();
	if (reaped > 0) console.log(`engine: reaped ${reaped} stale call participant(s)`);
	// Prune expired QR sign-in sessions (2-min TTL each).
	cleanupQrSessions();
	reapIdleBrowserSessions()
		.then(n => { if (n > 0) console.log(`engine: reaped ${n} idle browser session(s)`); })
		.catch(err => console.error("engine: browser session reaper failed", err));
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

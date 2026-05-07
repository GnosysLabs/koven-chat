// Per-bot Matrix runtime.  One matrix-js-sdk client per bot, backed
// by rust-crypto WASM for E2EE — same crypto stack the web client
// already uses, so we know it works against modern Synapse (the
// older matrix-bot-sdk nodejs binding fails on Pydantic-validated
// /upload requests in 1.140+).
//
// What this layer does today:
//   - Open the bot's Synapse session (decrypted access token).
//   - Hydrate the bot's prior crypto IDB from a JSON snapshot on
//     disk so device keys / megolm sessions survive restarts.
//   - Initialise rust-crypto with a per-bot store prefix
//     (`koven-bot-<id>`) so multiple bots in this process don't
//     clobber each other's keys (rust-crypto's IDB schema is
//     single-user; sharing a prefix would corrupt state).
//   - Auto-join any room the bot is invited to.
//   - Decrypt incoming messages so they can be inspected.
//   - Periodically (and on stop) snapshot the bot's crypto IDB back
//     to disk so the next restart has the same keys.
//
// What it does NOT do yet (chunk 3+):
//   - Detect mentions or trigger LLM calls.
//   - Post replies.

// IMPORTANT: dom_shim must run before matrix-js-sdk is imported, so
// IndexedDB / localStorage exist on globalThis when the SDK probes
// for them at module-eval time.  Side-effect import.
import "./dom_shim";

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as sdk from "matrix-js-sdk";
import { ClientEvent, RoomEvent, RoomMemberEvent } from "matrix-js-sdk";
import type { MatrixEvent, Room as SdkRoom } from "matrix-js-sdk";
import { config } from "./config";
import { type BotRow } from "./db";
import { openSecret } from "./secret_box";
import { initBotRustCrypto } from "./init_rust_crypto";
import { loadSnapshot, persistSnapshot } from "./crypto_persistence";
import { maybeHandleMention } from "./bot_pipeline";

/** A live, started bot.  Holds its matrix-js-sdk client so chunk 3
 * can pull it out of the manager and use it to send replies. */
export interface RunningBot {
	id: number;
	mxid: string;
	client: sdk.MatrixClient;
	stop: () => Promise<void>;
}

/** Per-bot persistent-state directory.  Holds:
 *   - crypto-idb.json — JSON snapshot of the bot's rust-crypto
 *     IndexedDB databases.  Re-created on every periodic flush. */
function botStateDir(botId: number): string {
	const root = dirname(config.dbPath);
	return join(root, "bot-state", String(botId));
}

function cryptoSnapshotPath(botId: number): string {
	return join(botStateDir(botId), "crypto-idb.json");
}

/** Per-bot IDB store prefix used by rust-crypto-wasm.  rust-crypto
 * derives database names like `${prefix}::matrix-sdk-crypto-meta`
 * from this; using a unique value per bot keeps each bot's crypto
 * state isolated in the shared global IDB factory. */
function cryptoStorePrefix(botId: number): string {
	return `koven-bot-${botId}`;
}

// How often we flush the crypto IDB snapshot to disk while a bot is
// running.  rust-crypto writes on every encrypted message, so we
// don't want to flush per-write — that'd melt the disk on a chatty
// channel.  20s gives a decent worst-case loss window without
// overwhelming I/O.  The flush also runs unconditionally on stop().
const SNAPSHOT_INTERVAL_MS = 20_000;

/**
 * Start a single bot's runtime.  Resolves once the SDK has come up
 * and the rust crypto stack is initialised.  Throws if the access
 * token is invalid or the engine can't decrypt it.
 *
 * Errors during room-level operations (a malformed invite, a
 * decrypt failure on one event) are logged but don't crash the bot.
 */
export async function startBot(bot: BotRow): Promise<RunningBot> {
	if (!bot.enabled) {
		throw new Error(`bot ${bot.mxid} is disabled; refusing to start`);
	}

	let accessToken: string;
	try {
		accessToken = openSecret(bot.access_token_enc);
	} catch (err) {
		throw new Error(`bot ${bot.mxid}: failed to decrypt access token (${err instanceof Error ? err.message : String(err)})`);
	}

	const stateDir = botStateDir(bot.id);
	await mkdir(stateDir, { recursive: true });

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const idb: IDBFactory = (globalThis as unknown as { indexedDB: any }).indexedDB;

	// Hydrate the crypto IDB from the previous run BEFORE we touch
	// the SDK.  If the file's missing this is a no-op (fresh bot).
	try {
		const restored = await loadSnapshot(idb, cryptoSnapshotPath(bot.id));
		if (restored) console.log(`bot ${bot.mxid}: restored crypto state from disk`);
	} catch (err) {
		console.warn(`bot ${bot.mxid}: failed to restore crypto snapshot (continuing fresh)`, err);
	}

	const client = sdk.createClient({
		baseUrl: config.homeserverUrl,
		accessToken,
		userId: bot.mxid,
		deviceId: bot.device_id,
		// Sync state intentionally stays on the default MemoryStore.
		// Tried IndexedDBStore against fake-indexeddb — the local
		// backend's transaction helper hits "this.db is undefined"
		// inside the to-device queue, so the SDK degrades to
		// MemoryStore anyway and emits a constant retry-loop log on
		// every flush.  The crypto state has its own IDB persistence
		// (see initBotRustCrypto + crypto_persistence below); the
		// sync state is cheap to rebuild from scratch on each boot.
	});

	// Initialise rust-crypto BEFORE startClient so the first /sync
	// has the crypto pipeline ready to decrypt any encrypted events
	// it brings back.  Use a per-bot store prefix so rust-crypto
	// doesn't share IDB names across bots in this process.
	await initBotRustCrypto(client, cryptoStorePrefix(bot.id));

	// Periodic snapshot of the bot's crypto IDB to disk.  Keyed by
	// the per-bot prefix so we only serialise this bot's databases.
	const snapshotTimer = setInterval(() => {
		persistSnapshot(idb, cryptoStorePrefix(bot.id), cryptoSnapshotPath(bot.id))
			.catch((err) => console.warn(`bot ${bot.mxid}: snapshot failed`, err));
	}, SNAPSHOT_INTERVAL_MS);
	// Don't keep the process alive just for this timer.
	if (typeof snapshotTimer.unref === "function") snapshotTimer.unref();

	// Auto-accept invites.  Anyone on the instance can invite a bot
	// to a room they're in; the bot just joins.
	client.on(RoomMemberEvent.Membership, (_event: MatrixEvent, member) => {
		if (member.userId !== bot.mxid) return;
		if (member.membership !== "invite") return;
		const roomId = member.roomId;
		client.joinRoom(roomId)
			.then(() => console.log(`bot ${bot.mxid}: joined ${roomId}`))
			.catch((err) => console.warn(`bot ${bot.mxid}: failed to join ${roomId}`, err));
	});

	// Trigger pipeline: every live message event runs through the
	// mention detector.  If the bot is named, we gather context and
	// fire the LLM call.  Otherwise we just log and move on.
	client.on(RoomEvent.Timeline, (event: MatrixEvent, room: SdkRoom | undefined, toStartOfTimeline: boolean | undefined, _removed: boolean, data: { liveEvent?: boolean }) => {
		if (!room || toStartOfTimeline || !data?.liveEvent) return;
		if (event.getType() !== "m.room.message") return;
		if (event.getSender() === bot.mxid) return;
		if (event.isEncrypted() && !event.getClearContent()) return; // not yet decrypted

		const body = ((event.getContent().body as string | undefined) ?? "(non-text)").slice(0, 80);
		console.log(`bot ${bot.mxid} <- [${room.roomId}] ${event.getSender()}: ${body}`);

		// Fire-and-forget; the pipeline catches its own errors.
		void maybeHandleMention({ bot, client, event, room });
	});

	// Sync state heartbeat — useful for spotting bots that are stuck.
	client.on(ClientEvent.Sync, (state: string) => {
		if (state === "PREPARED" || state === "ERROR") {
			console.log(`bot ${bot.mxid}: sync ${state}`);
		}
	});

	await client.startClient({ initialSyncLimit: 30 });
	console.log(`bot ${bot.mxid}: online`);

	return {
		id: bot.id,
		mxid: bot.mxid,
		client,
		stop: async () => {
			clearInterval(snapshotTimer);
			try {
				client.stopClient();
				client.removeAllListeners();
			} catch (err) {
				console.warn(`bot ${bot.mxid}: stop threw`, err);
			}
			// Final flush — best-effort.  If a bot crashes the
			// process, we lose at most SNAPSHOT_INTERVAL_MS of
			// in-flight key updates; rust-crypto recovers room keys
			// on the next sync via /keys/query + key requests.
			try {
				await persistSnapshot(idb, cryptoStorePrefix(bot.id), cryptoSnapshotPath(bot.id));
			} catch (err) {
				console.warn(`bot ${bot.mxid}: final snapshot failed`, err);
			}
		},
	};
}

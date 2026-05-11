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
import { ClientEvent, MatrixEventEvent, RoomEvent, RoomMemberEvent } from "matrix-js-sdk";
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

	// Invite handler.  Two gates, both bot-owner controlled:
	//
	//   (a) Group-room invites — only the bot's owner can pull a bot
	//       into a group room.  Random users dragging someone else's
	//       bot into their channel was a recurring abuse vector
	//       (cost-griefing the owner's LLM bill, spamming bot tools
	//       in unrelated rooms).  No setting; this rule is absolute.
	//
	//   (b) DM invites — gated by the bot's `accept_dms` flag.
	//       Default true (open to anyone), owner can flip it off in
	//       the bot edit form.  When off, the bot leaves any DM
	//       invite from a non-owner.  When on, anyone can DM the bot.
	//       The owner can always DM their own bot regardless.
	//
	// "Is this a DM invite?" comes from the m.room.member event's
	// `is_direct: true` content flag — the spec way for an inviter to
	// tell receivers "this room is a 1:1 DM."  Matrix clients
	// (Element, Cinny, our own SPA) all set this when they create a
	// DM via the standard flow.  Group-room invites omit it (or set
	// false).  Slightly fuzzy on edge cases (manual /invite without
	// is_direct, federated quirks), but the policy still leans safe:
	// ambiguous → treated as group → owner-only.
	client.on(RoomMemberEvent.Membership, (event: MatrixEvent, member) => {
		if (member.userId !== bot.mxid) return;
		if (member.membership !== "invite") return;
		const roomId = member.roomId;
		const inviter = event.getSender();
		const inviteContent = event.getContent() as { is_direct?: boolean };
		const isDm = inviteContent.is_direct === true;
		const fromOwner = inviter === bot.owner_id;

		// Decision matrix.  rejectReason is non-null iff we should
		// leave the room instead of joining.
		let rejectReason: string | null = null;
		if (isDm) {
			if (!fromOwner && bot.accept_dms === 0) {
				rejectReason = "DM-from-non-owner with accept_dms=off";
			}
		} else {
			// Group room.  Owner-only, period.
			if (!fromOwner) {
				rejectReason = "group-room invite from non-owner";
			}
		}

		if (rejectReason) {
			console.log(
				`bot ${bot.mxid}: declining invite to ${roomId} from ${inviter} (${rejectReason})`,
			);
			// Leave the invite-state room.  The Matrix spec models
			// "decline an invite" as a transition from invite →
			// leave on your own membership; client.leave() does that
			// without ever joining.
			client.leave(roomId).catch((err) => {
				console.warn(`bot ${bot.mxid}: failed to decline invite to ${roomId}`, err);
			});
			return;
		}

		void (async () => {
			try {
				await client.joinRoom(roomId);
				console.log(`bot ${bot.mxid}: joined ${roomId} (invited by ${inviter}${isDm ? ", DM" : ""})`);
				// Discord-style space cascade.  When the invite was to a
				// SPACE (m.space-typed room), the bot also auto-joins
				// every joinable child room so the owner doesn't have
				// to invite the bot to each room separately.  The
				// engine has a symmetric cascade on m.room.member +
				// isSpaceRoom (see server.ts), but doing it ALSO bot-
				// side keeps the bot working even on instances whose
				// engine isn't running the cascade code yet, and is
				// the more reliable signal in any case (no admin-join
				// round-trip; the bot uses its own credentials).
				//
				// Only fires when the joined room is itself a space —
				// regular-room joins fall through with no extra work.
				// Skipped for DMs (single-other-party rooms have no
				// children to cascade to).
				if (isDm) return;
				try {
					const joinedRoom = client.getRoom(roomId);
					const createEvent = joinedRoom?.currentState.getStateEvents("m.room.create", "");
					const roomType = (createEvent?.getContent() as { type?: string } | undefined)?.type;
					if (roomType !== "m.space") return;
					const hier = await client.getRoomHierarchy(roomId, 50, 3, false);
					const rooms = (hier.rooms ?? []) as Array<{
						room_id: string;
						room_type?: string;
						join_rule?: string;
					}>;
					for (const r of rooms) {
						if (r.room_id === roomId) continue;             // skip the space itself
						if (r.room_type === "m.space") continue;         // skip sub-spaces
						const rule = r.join_rule ?? "public";
						if (rule !== "public" && rule !== "knock" && rule !== "restricted") continue;
						try {
							await client.joinRoom(r.room_id);
							console.log(`bot ${bot.mxid}: cascade-joined ${r.room_id} (child of ${roomId})`);
						} catch (err) {
							console.warn(`bot ${bot.mxid}: failed to cascade-join ${r.room_id}`, err);
						}
					}
				} catch (err) {
					console.warn(`bot ${bot.mxid}: space-cascade after joining ${roomId} failed`, err);
				}
			} catch (err) {
				console.warn(`bot ${bot.mxid}: failed to join ${roomId}`, err);
			}
		})();
	});

	// Per-event dedupe so a message that arrives encrypted via
	// Timeline (skipped, then later decrypts and re-emerges via the
	// Decrypted listener below) doesn't fire the mention pipeline
	// twice.  bot_pipeline has its own per-(bot, eventId) guard
	// already, but checking here too saves a routine event-id lookup.
	const seenEventIds = new Set<string>();
	function rememberSeen(eventId: string): void {
		seenEventIds.add(eventId);
		// Cap memory.  500 is generous: most bots see far fewer
		// messages per session, and a slightly busy room churns
		// through this set within an hour.
		if (seenEventIds.size > 500) {
			const oldest = seenEventIds.values().next().value;
			if (oldest) seenEventIds.delete(oldest);
		}
	}

	function routeMessage(event: MatrixEvent, room: SdkRoom): void {
		if (event.getType() !== "m.room.message") return;
		if (event.getSender() === bot.mxid) return;
		const eventId = event.getId();
		if (eventId && seenEventIds.has(eventId)) return;
		if (eventId) rememberSeen(eventId);

		const body = ((event.getContent().body as string | undefined) ?? "(non-text)").slice(0, 80);
		console.log(`bot ${bot.mxid} <- [${room.roomId}] ${event.getSender()}: ${body}`);

		void maybeHandleMention({ bot, client, event, room });
	}

	// Trigger pipeline: every live message event runs through the
	// mention detector.  Encrypted events that haven't decrypted
	// yet are skipped here — they re-enter via the Decrypted
	// listener below once rust-crypto cracks them open.
	client.on(RoomEvent.Timeline, (event: MatrixEvent, room: SdkRoom | undefined, toStartOfTimeline: boolean | undefined, _removed: boolean, data: { liveEvent?: boolean }) => {
		if (!room || toStartOfTimeline || !data?.liveEvent) return;
		if (event.isEncrypted() && !event.getClearContent()) return; // not yet decrypted, wait for Decrypted
		routeMessage(event, room);
	});

	// Encrypted events arrive via Timeline as `m.room.encrypted`;
	// rust-crypto fires Decrypted on each one once the megolm key
	// is available.  Without this listener, DM messages and any
	// other E2EE traffic would silently get dropped — exactly the
	// bug we hit when the bot stopped replying in DMs.
	client.on(MatrixEventEvent.Decrypted, (event: MatrixEvent) => {
		const room = client.getRoom(event.getRoomId() ?? "");
		if (!room) return;
		// On UTD ("Unable To Decrypt") — keys haven't arrived yet —
		// actively request the missing megolm session from the
		// sender's other devices.  rust-crypto retries decryption
		// automatically when the key lands and re-fires Decrypted,
		// at which point the routeMessage call below picks it up
		// for the mention pipeline.  Mirrors the human-side fix in
		// client/src/lib/matrix.ts; same SDK API.
		if (typeof event.isDecryptionFailure === "function" && event.isDecryptionFailure()) {
			const fn = (client as unknown as {
				cancelAndResendEventRoomKeyRequest?: (e: MatrixEvent) => Promise<void>;
			}).cancelAndResendEventRoomKeyRequest;
			if (typeof fn === "function") {
				void fn.call(client, event).catch(err => {
					console.warn(`bot ${bot.mxid}: room-key request for ${event.getId()} failed`, err);
				});
			}
			return;
		}
		routeMessage(event, room);
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

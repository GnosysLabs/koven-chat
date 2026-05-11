// Matrix transport — Koven's chat surface against any Matrix homeserver.
//
// Wraps matrix-js-sdk with a tighter, opinionated surface that reflects
// only what the Koven UI cares about: login, room list, timeline,
// send, and the custom `chat.koven.*` governance events.
//
// Intentionally NOT a one-to-one mapping of matrix-js-sdk — we hide
// the things we don't want the UI thinking about (state events,
// power levels, room.timeline order quirks) and surface the things
// we do (a simple, stable Room/Message shape).

import * as sdk from "matrix-js-sdk";
import { ClientEvent, HttpApiEvent, MatrixEventEvent, NotificationCountType, RoomEvent, RoomMemberEvent, UserEvent } from "matrix-js-sdk";
import { IndexedDBStore } from "matrix-js-sdk/lib/store/indexeddb";
import { CallEventHandlerEvent } from "matrix-js-sdk/lib/webrtc/callEventHandler";
import type { MatrixCall } from "matrix-js-sdk/lib/webrtc/call";
import type {
	Room as SdkRoom,
	MatrixEvent,
	IRoomTimelineData,
} from "matrix-js-sdk";
import type {
	Room,
	Message,
	MessageKind,
	Space,
	SpaceId,
	UserId,
	RoomId,
	EventId,
	FlagCategory,
} from "@koven/shared";
import { ENGINE_URL } from "@/lib/urls";

// Synapse OG-preview response, normalised into a flat shape the UI
// can render without poking through `og:*` keys.  `imageMxc` is a
// raw mxc:// — UI fetches via getMxcBlobUrl like any other media.
export interface UrlPreview {
	url: string;
	title: string;
	description?: string;
	siteName?: string;
	imageMxc?: string;
	imageWidth?: number;
	imageHeight?: number;
}

// Reaction events arrive separately from messages; the App reducer
// aggregates them.  Shape kept small — one event per delivery.
export interface ReactionEvent {
	eventId: EventId;        // the m.reaction event id (for unreact/redact)
	roomId: RoomId;
	targetEventId: EventId;
	key: string;
	sender: UserId;
}

/** Lifted from an m.poll.response event.  `pollId` is the start
 * event id (target of the m.reference relation); `answerIds` is the
 * ordered list of answer ids the voter selected (single-element for
 * single-choice polls). */
export interface PollResponseEvent {
	eventId: EventId;
	roomId: RoomId;
	pollId: EventId;
	voter: UserId;
	answerIds: string[];
	timestamp: number;
}

/** Lifted from an m.poll.end event.  Spec allows shipping final
 * results in `org.matrix.msc3381.poll.results` for the
 * undisclosed case; we forward whatever the sender included. */
export interface PollEndEvent {
	eventId: EventId;
	roomId: RoomId;
	pollId: EventId;
	endedBy: UserId;
	timestamp: number;
	finalCounts?: Record<string, number>;
}

// Flag events.  Same shape philosophy as reactions: one row per flag
// event the timeline carries, store aggregates by target_event_id.
export interface FlagEventLite {
	eventId: EventId;        // the chat.koven.flag.v1 event id (for unflag)
	roomId: RoomId;
	targetEventId: EventId;
	category: FlagCategory;
	sender: UserId;
	rationale?: string;
}

// Collapse events — emitted by the engine into a room's timeline when
// flag thresholds are met.  One per target message.
export interface CollapseEventLite {
	eventId: EventId;        // the chat.koven.collapse.v1 event id
	roomId: RoomId;
	targetEventId: EventId;
	flaggerCount: number;
	weightedScore: number;
	categories: string[];
	timestamp: number;
	fastTrack: boolean;
}

// ─── Stored credentials ──────────────────────────────────────────────

const CREDENTIALS_KEY = "koven:matrix-credentials";

export interface MatrixCredentials {
	homeserver: string;          // e.g. "http://localhost:8008"
	user_id: UserId;             // "@admin:localhost"
	access_token: string;
	device_id: string;
}

export function loadStoredCredentials(): MatrixCredentials | null {
	try {
		const raw = localStorage.getItem(CREDENTIALS_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

export function saveCredentials(creds: MatrixCredentials | null): void {
	if (creds) {
		localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(creds));
	} else {
		localStorage.removeItem(CREDENTIALS_KEY);
	}
}

// ─── Public transport surface ────────────────────────────────────────

export type SyncState = "preparing" | "syncing" | "ready" | "error" | "offline";

/**
 * Delete the rust-crypto IndexedDB stores.  matrix-js-sdk hardcodes
 * these names internally (RUST_SDK_STORE_PREFIX = "matrix-js-sdk")
 * and exposes no public method that just clears them — its
 * `clearStores()` also wipes the regular store, which we don't want.
 * Used as the recovery path when initRustCrypto reports an account
 * mismatch (server reset, user re-registered, etc.).
 *
 * Throws when any of the deletes fails to complete (timed out
 * blocked).  Caller must NOT proceed to initRustCrypto on a
 * thrown wipe — the data is in a "tried to nuke, didn't actually
 * nuke" state and the next initRustCrypto will fail to load it,
 * leaving the user stuck on "Connecting…" forever.
 */
async function wipeRustCryptoIndexedDB(): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const names = ["matrix-js-sdk::matrix-sdk-crypto", "matrix-js-sdk::matrix-sdk-crypto-meta"];
	const results = await Promise.all(names.map(name => deleteDatabaseAwait(name)));
	const failed = names.filter((_, i) => !results[i]);
	if (failed.length > 0) {
		throw new Error(`wipeRustCryptoIndexedDB: failed to delete ${failed.join(", ")} (blocked by open connections that didn't close in 30s)`);
	}
}

/**
 * Wrap `indexedDB.deleteDatabase` in a promise that ACTUALLY resolves
 * after the DB is closed — including the `blocked` retry path where
 * a previous OlmMachine handle hasn't released yet.
 *
 * Why this is load-bearing for account switching:
 *   1. matrix-js-sdk's RustCrypto.stop() calls olmMachine.close(),
 *      which schedules the WASM side to drop the IDB connection.
 *   2. The close is "synchronous" from JS's POV but the underlying
 *      IDBDatabase teardown is async — Chrome/Safari batch close
 *      callbacks across a microtask boundary.
 *   3. If we deleteDatabase(name) right after close(), the request
 *      fires `blocked` instead of `success` because the connection
 *      is still in the process of closing.
 *   4. Default behaviour: silently leak.  The connection eventually
 *      closes, but our `then` already resolved on the `blocked`
 *      event, so the next initRustCrypto opens the OLD database —
 *      which still has the previous user's olm account — and hangs
 *      indefinitely on the account-mismatch error.
 *
 * Fix: when we get `blocked`, wait for a `success` or a hard 30s
 * timeout.  Resolves to `true` on actual deletion, `false` if we
 * timed out without the delete completing.  The CALLER then decides
 * whether to retry or rethrow — running initRustCrypto against a
 * not-actually-wiped store is the worst outcome (silent stale data
 * + stuck-on-Connecting), so callers treat `false` as a hard error.
 */
function deleteDatabaseAwait(name: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const req = indexedDB.deleteDatabase(name);
		let done = false;
		const finishOk = () => {
			if (done) return;
			done = true;
			resolve(true);
		};
		const finishFail = () => {
			if (done) return;
			done = true;
			resolve(false);
		};
		req.onsuccess = finishOk;
		req.onerror = () => {
			// `error` is unusual but not necessarily catastrophic; the
			// caller treats it the same as a successful wipe (the DB
			// might not exist, or the platform refused for a benign
			// reason).
			finishOk();
		};
		req.onblocked = () => {
			console.warn(`indexedDB.deleteDatabase(${name}): blocked by an open connection, waiting up to 30s for it to drain…`);
		};
		// 30s upper bound — we'd rather fail loudly than silently
		// run initRustCrypto against a still-locked DB (which gives
		// the user a permanent "stuck on Connecting…" with no log
		// trail).  The previous 5s + "proceed anyway" path was the
		// account-switch bug.
		setTimeout(() => {
			if (!done) {
				console.error(`indexedDB.deleteDatabase(${name}): timed out after 30s — caller will signal mismatch-recovery instead of running on stale data`);
				finishFail();
			}
		}, 30_000);
	});
}

/**
 * Wipe ALL matrix-js-sdk IndexedDB state for this origin — both the
 * rust-crypto stores and the regular SDK store (rooms, events, sync
 * tokens).  Called from sign-out so the NEXT login (which may be as
 * a completely different user, e.g. account switching) starts from
 * a clean slate.
 *
 * Without this, switching accounts on the same browser triggers the
 * "rust-crypto store mismatch" recovery path on the new login —
 * initRustCrypto throws, we catch it, wipe, and retry.  The catch +
 * wipe + fresh-init sequence takes 30-90s on busy accounts because
 * fresh init regenerates the olm account from scratch (curve25519 +
 * ed25519 keys + ~100 pre-keys, all CPU-bound on the WASM side).
 * Doing the wipe at sign-out time means we pay that cost during a
 * UX moment where the user already expects "signing out…", not on
 * the next login where they're staring at a "Connecting…" screen.
 *
 * matrix-js-sdk picks IndexedDB DB names with the
 * `matrix-js-sdk::` prefix.  We enumerate every existing DB on this
 * origin and drop anything matching that prefix; safer than a fixed
 * list because the SDK has added new stores between minor versions
 * (sliding-sync, key-backup metadata) that a hardcoded list would
 * miss.
 */
export async function wipeAllMatrixIndexedDB(): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	// indexedDB.databases() is supported in all modern browsers we
	// target (Chromium, Safari 14+, Firefox 126+) but not in some
	// older Firefox.  Fall back to the known-name list there.
	let names: string[] = [];
	try {
		const dbs = await (indexedDB as unknown as { databases?(): Promise<{ name?: string }[]> })
			.databases?.() ?? [];
		names = dbs
			.map(d => d.name)
			.filter((n): n is string => typeof n === "string" && n.startsWith("matrix-js-sdk"));
	} catch {
		// fall through
	}
	if (names.length === 0) {
		names = [
			"matrix-js-sdk::matrix-sdk-crypto",
			"matrix-js-sdk::matrix-sdk-crypto-meta",
			"matrix-js-sdk:crypto",
			"matrix-js-sdk:riot-web-sync",
			"matrix-js-sdk:default",
		];
	}
	// Sign-out cleanup is best-effort: if a delete is blocked we
	// can't really do anything user-facing about it (the user is
	// already signing out).  Log failures so a stuck wipe doesn't
	// silently slip through, but don't throw.
	const results = await Promise.all(names.map(name => deleteDatabaseAwait(name)));
	const failed = names.filter((_, i) => !results[i]);
	if (failed.length > 0) {
		console.warn(`wipeAllMatrixIndexedDB: ${failed.length} DBs failed to delete: ${failed.join(", ")}`);
	}
}

export interface MatrixHandlers {
	onSyncState(state: SyncState): void;
	onRoomsUpdated(rooms: Room[]): void;
	onSpacesUpdated(spaces: Space[]): void;
	onMessage(msg: Message, options: { live: boolean }): void;
	// Fires when a redaction event arrives that targets a real
	// message bubble (self-delete, bot-owner-delete, mod kick of a
	// post, etc.).  Distinct from reaction / flag redactions, which
	// have their own dedicated handlers; we don't know which kind
	// the redaction targets up front, so the transport dispatches
	// to all three in parallel and lets each reducer no-op if the
	// id isn't in its map.
	onMessageRedacted(roomId: RoomId, eventId: EventId): void;
	onReaction(reaction: ReactionEvent, options: { live: boolean }): void;
	onReactionRedacted(roomId: RoomId, reactionEventId: EventId): void;
	onFlag(flag: FlagEventLite, options: { live: boolean }): void;
	onFlagRedacted(roomId: RoomId, flagEventId: EventId): void;
	onCollapse(collapse: CollapseEventLite, options: { live: boolean }): void;
	/// Fires for every m.poll.response event on the timeline — one per
	/// vote, including changes (each new response from the same voter
	/// supersedes their previous answer per MSC3381).  Consumer
	/// aggregates by `pollId` and applies "last response per voter
	/// wins" on its side.
	onPollResponse(ev: PollResponseEvent, options: { live: boolean }): void;
	/// Fires when a poll's creator emits m.poll.end.  Final results
	/// freeze; the consumer stops accepting new responses for the poll
	/// at this timestamp.
	onPollEnd(ev: PollEndEvent, options: { live: boolean }): void;
	onMembersUpdated(roomId: RoomId): void;
	/// Fires when m.read receipts change in a room — drives the
	/// "seen by" indicators on chat messages.  Coarse: just the room
	/// id.  Consumer re-queries getMessageSeenBy for the visible
	/// messages.  matrix-js-sdk batches receipt deltas, so this is
	/// firing-rate-acceptable without further debouncing.
	onReceiptsUpdated(roomId: RoomId): void;
	// Fires when a remote party rings us.  The caller in App.tsx
	// renders the incoming-call sheet; accept/decline drives the
	// MatrixCall directly.  Only one inbound call is surfaced at a
	// time (the SDK suppresses overlapping invites for the same room).
	onIncomingCall(call: MatrixCall): void;
	// Fires when matrix-js-sdk's HTTP layer detects that the access
	// token has been invalidated server-side (M_UNKNOWN_TOKEN, soft-
	// logout, device-deleted, admin-revoked session).  Without this
	// callback, the rust-crypto stack retries /keys/query in a tight
	// 401 loop while the SPA stays stuck on "Connecting…" forever —
	// observed when a dev session loaded localStorage creds whose
	// device had been wiped on the homeserver.  Caller (App.tsx)
	// reacts by clearing the persisted creds and bouncing to the
	// login screen so the user has a way out.
	onSessionLoggedOut(): void;
}

/**
 * One-shot login.  Called from the login screen with a homeserver URL,
 * username (localpart or full mxid), and password.  Returns credentials
 * the caller stores and passes to `resume()` on subsequent loads.
 */
export async function loginWithPassword(
	homeserver: string,
	username: string,
	password: string,
): Promise<MatrixCredentials> {
	// Allow the user to type "alice" or "@alice:localhost" — we normalize.
	const tempClient = sdk.createClient({ baseUrl: homeserver });
	const response = await tempClient.login("m.login.password", {
		identifier: { type: "m.id.user", user: username },
		password,
		initial_device_display_name: "Koven Web",
	});
	if (!response.access_token || !response.user_id || !response.device_id) {
		throw new Error("Login response missing required fields");
	}
	return {
		homeserver,
		user_id: response.user_id as UserId,
		access_token: response.access_token,
		device_id: response.device_id,
	};
}

/** Pull a human-readable message out of a Matrix-style error body
 * (`{ error, errcode }`).  Used by the few remaining flows that talk
 * to Synapse directly and want to surface the server's reason rather
 * than a stock HTTP status. */
function messageFromMatrixError(body: Record<string, unknown>, fallback: string): string {
	const errcode = body["errcode"] as string | undefined;
	const error = body["error"] as string | undefined;
	if (error && errcode) return `${error} (${errcode})`;
	if (error) return error;
	return fallback;
}

export class MatrixTransport {
	private client: sdk.MatrixClient | null = null;
	// Per-user IndexedDBStore — persists rooms, timelines, and the
	// /sync token across page reloads so a cold launch doesn't have
	// to re-fetch everything.  matrix-js-sdk's startClient picks up
	// the saved sync token automatically and only fetches the delta.
	// dbName is namespaced by user_id so multi-account users don't
	// stomp each other (and account switch doesn't need a wipe — each
	// account has its own sandbox).
	private store: IndexedDBStore | null = null;
	private handlers: MatrixHandlers;
	private creds: MatrixCredentials | null = null;
	private syncState: SyncState = "preparing";

	// Cache of blob URLs we've fetched for mxc:// URLs.  Modern Synapse
	// (1.100+) requires authenticated media downloads, which means we
	// can't put `mxcUrlToHttp(...)` into an <img src> directly — the
	// browser won't attach the Authorization header.  Instead we fetch
	// the bytes with auth, wrap them in a Blob, and hand the resulting
	// blob:URL to the UI.  Cached per-mxc so we only download each
	// asset once across the app lifetime.  Stored as Promises so
	// concurrent requests for the same mxc share the in-flight fetch.
	private mediaCache = new Map<string, Promise<string>>();
	// Mirror of mediaCache restricted to already-resolved entries.
	// Lets the avatar component synchronously check on mount whether
	// we already have the blob URL — avoids the one-frame flash from
	// the auto-avatar fallback while a Promise resolves.
	private mediaResolved = new Map<string, string>();

	// Ephemeral UIA password.  Set right after a successful email-code
	// login (the engine rotates Synapse's stored password and hands the
	// new value back); read by setupEncryption / deactivateMyAccount to
	// satisfy Synapse's m.login.password UIA stage without ever showing
	// a password field to the user.  Memory-only: never persisted to
	// localStorage / sessionStorage / IndexedDB.  Cleared on stop().
	private uiaPassword: string | null = null;

	// Listeners attached via onIgnoredUsersChanged.  Fired whenever the
	// `m.ignored_user_list` account_data event updates — used by the
	// Settings sheet's blocked-users section and the ChatPane filter so
	// blocking takes visible effect without a refresh.
	private ignoreListeners: Set<() => void> = new Set();

	// Listeners attached via onNsfwPreferenceChanged.  Fired whenever
	// the `chat.koven.nsfw_preference` account_data event updates —
	// either by this client or by another device the same user is
	// signed in on.  Drives App.tsx → Settings sync so flipping the
	// toggle on a phone flips it on the desktop instantly.
	private nsfwPrefListeners: Set<(show: boolean) => void> = new Set();

	// SSSS private key, cached after setup or unlock.  matrix-js-sdk
	// asks for it via the cryptoCallbacks.getSecretStorageKey hook
	// whenever it needs to read or write a secret (cross-signing keys,
	// key backup decryption key).  Cleared on stop().  This is
	// intentionally held in memory only — persisting it would defeat
	// the point of having a separate encryption secret.
	private ssssKey: { keyId: string; privateKey: Uint8Array } | null = null;

	// Optimistic local mirror of `m.direct` for rooms whose membership
	// was just changed in a way that should make them DMs but where the
	// server-side account_data hasn't echoed back through /sync yet.
	// Two flows write here:
	//
	//   * acceptInvite — receiving side of a DM invite.  Synapse's
	//     setAccountData("m.direct", …) returns 200 quickly but the
	//     SDK's local cache only updates when the AccountData event
	//     comes back through sync (a few hundred ms to a few seconds
	//     depending on long-poll timing).  Without this map the room
	//     is misclassified as a regular private room during that
	//     window, lands in the Rooms tile instead of DMs, and looks
	//     to the user like the conversation vanished after they
	//     navigate away from it.
	//
	//   * startDm — sender side, when the inviter creates a fresh DM
	//     room.  Same gap: createRoom returns the new room id, we
	//     setAccountData immediately, but classification reads from a
	//     stale local m.direct until sync.
	//
	// Cleared per-roomId when the m.direct AccountData event echoes
	// back through sync — at that point the SDK's own cache has the
	// truth and we don't need our shim anymore.
	private pendingDmMappings: Map<string, string> = new Map();
	// Set of userIds for whom we've fired a one-shot profile fetch
	// (DM avatar fallback path).
	private peerProfileFetched: Set<string> = new Set();
	// Self-managed avatar override per userId, populated when our
	// fallback profile fetch resolves with an avatar.  The DM
	// avatar resolution path checks this BEFORE falling through to
	// DiceBear so we don't depend on matrix-js-sdk's User event
	// system to wire the new avatar back into the UI (which it
	// inconsistently does — the User object's avatarUrl can be
	// updated without UserEvent.AvatarUrl emitting).
	private resolvedPeerAvatars: Map<string, string> = new Map();

	// Latch flipped by stop().  start() awaits initRustCrypto and
	// startClient — both can take seconds.  React's <StrictMode> double-
	// invokes effects in dev, so a transport can be stopped mid-start.
	// Without this latch the dead start() keeps running, eventually
	// hits `this.client.on(...)` after stop() nulled the client, and
	// throws a misleading "Cannot read properties of null" that App.tsx
	// surfaces as bootError on the live transport.
	private stopped = false;

	constructor(handlers: MatrixHandlers) {
		this.handlers = handlers;
	}

	get currentUserId(): UserId | null {
		return this.creds?.user_id ?? null;
	}

	/** Resume an existing session (or fresh after login). */
	async start(creds: MatrixCredentials): Promise<void> {
		this.stopped = false;
		this.creds = creds;
		// Preemptive store-mismatch check.  Compare the user_id we're
		// about to log in as against the one we last logged in as
		// (stored in localStorage by this same code path).  If they
		// differ, the rust-crypto IndexedDB still has the previous
		// user's olm account — initRustCrypto will throw, we'd catch,
		// wipe, and retry, but the catch + wipe + fresh init takes
		// 30-90s on slow devices because rust-crypto regenerates the
		// olm keypairs from scratch.  Wiping BEFORE initRustCrypto
		// is much faster: indexedDB.deleteDatabase doesn't have to
		// fight the half-loaded WASM-side handle, and initRustCrypto
		// runs once instead of twice.
		//
		// Only triggers when the user actually changed.  The hot path
		// (same user logging in fresh, or restoring an existing
		// session) hits the localStorage read and compare and is
		// done — no IndexedDB churn, no extra latency.
		const LAST_USER_KEY = "koven.lastLoggedInUserId";
		const prev = typeof localStorage !== "undefined"
			? localStorage.getItem(LAST_USER_KEY)
			: null;
		const isUserSwitch = !!(prev && prev !== creds.user_id);
		if (isUserSwitch) {
			console.info(
				"matrix.start: detected user switch (%s → %s), wiping crypto store preemptively",
				prev,
				creds.user_id,
			);
			// Let wipeRustCryptoIndexedDB throw on a blocked wipe.
			// Running initRustCrypto against a not-actually-wiped store
			// silently fails as "stuck on Connecting…" — a thrown
			// error here surfaces as bootError on the SPA, which is
			// recoverable by refreshing.  In practice the App.tsx
			// teardown-await fix means this should never block; the
			// throw is the safety net for cases where something OTHER
			// than the previous transport has the IDB open.
			await wipeRustCryptoIndexedDB();
		}
		try {
			if (typeof localStorage !== "undefined") {
				localStorage.setItem(LAST_USER_KEY, creds.user_id);
			}
		} catch (err) {
			// localStorage might be unavailable in private modes.
			// Non-fatal — start() continues without the cached marker.
			console.warn("matrix.start: lastLoggedInUserId write failed", err);
		}
		// IndexedDBStore for the matrix-js-sdk room/timeline cache.
		// Sandboxed per user_id so multi-account never crosses streams,
		// and a fresh login (no prior data) just opens an empty IDB.
		// Local-part of the mxid is sanitised into the dbName since
		// IndexedDB names tolerate `:` but mixed clients have been
		// burned by it in the past — keep the name conservative.
		const safeUid = creds.user_id.replace(/[^a-zA-Z0-9._-]/g, "_");
		const dbName = `koven_matrixjs_${safeUid}`;
		const buildStore = () => new IndexedDBStore({
			indexedDB: window.indexedDB,
			dbName,
			localStorage: typeof localStorage !== "undefined" ? localStorage : undefined,
		});
		this.store = buildStore();

		const buildClient = () => sdk.createClient({
			baseUrl: creds.homeserver,
			accessToken: creds.access_token,
			userId: creds.user_id,
			deviceId: creds.device_id,
			// Persistent timeline + sync-token cache.  Without this,
			// every cold launch refetches /sync from scratch and the
			// user sees a stale UI for the few seconds it takes to
			// rebuild rooms/timelines in memory.  IndexedDBStore is a
			// MemoryStore subclass with periodic write-through to IDB,
			// so reads stay in-memory fast and writes batch in the
			// background.  Reused across the rust-crypto-mismatch
			// retry path (see initRustCrypto catch below) — same
			// store, same on-disk data, just a fresh client instance.
			store: this.store ?? undefined,
			cryptoCallbacks: {
				// Hand the in-memory SSSS key back to the SDK whenever it
				// asks.  Returns null until setupEncryption / unlockEncryption
				// has been called this session — at which point reads of
				// cross-signing keys, key backup secrets, etc. all start
				// succeeding.  null surfaces as "encrypted secret unavailable"
				// upstream, which is the desired state pre-unlock.
				getSecretStorageKey: async ({ keys }) => {
					if (!this.ssssKey) return null;
					if (!keys[this.ssssKey.keyId]) return null;
					return [this.ssssKey.keyId, this.ssssKey.privateKey];
				},
				cacheSecretStorageKey: (keyId, _info, key) => {
					this.ssssKey = { keyId, privateKey: key };
				},
			},
		});
		this.client = buildClient();
		// IndexedDBStore.startup() rehydrates the in-memory cache from
		// IDB.  MUST be called AFTER createClient and BEFORE
		// startClient (per the SDK docstring).  Returns immediately on
		// first run when there's no saved data; on subsequent runs it
		// fills the rooms map so the UI paints from cache instantly.
		console.time("matrix.start: IndexedDBStore.startup");
		try {
			await this.store.startup();
		} catch (err) {
			// IDB unavailable (private mode, quota exceeded, browser
			// flag) — degrade silently to memory-only.  matrix-js-sdk
			// also has its own degraded-fallback path inside the store;
			// this catch is just for the startup() promise itself.
			console.warn("matrix.start: IndexedDBStore.startup failed, continuing without persistence", err);
		}
		console.timeEnd("matrix.start: IndexedDBStore.startup");

		// Initialize the rust-crypto stack BEFORE startClient so the
		// initial sync's encrypted events route through the crypto
		// decryptor.  Without this, sendEvent into encrypted rooms
		// throws and incoming megolm events stay as ciphertext.
		//
		// IndexedDB-backed store, no storage encryption: matching
		// Element-web's default.  Encrypting the store at rest is a
		// chicken-and-egg problem (where do we store the storage key?)
		// that real solutions defer to OS-level keystores; for a web
		// client the meaningful threat model is server-vs-user, not
		// disk-at-rest, and IndexedDB is already same-origin-isolated.
		//
		// Recovery path: rust-crypto stores its account in IndexedDB
		// keyed by user_id, NOT by device_id.  When a server gets
		// wiped (or a user re-registers) Synapse hands out a fresh
		// device_id, but the IndexedDB store still has the old
		// device's olm account — and rust-crypto refuses to load it
		// with "the account in the store doesn't match the account
		// in the constructor".  When that specific error fires we
		// wipe the rust-crypto IndexedDBs and retry once.  This is
		// safe in our usage: we don't yet support multiple sessions
		// per browser, and key backup means losing the local crypto
		// store doesn't lose message history.
		// Timing markers for the "Connecting…" screen.  initRustCrypto
		// loads the WASM bundle, opens the rust-crypto IndexedDBs, and
		// brings up the olm account — first run on a new device can be
		// several seconds.  console.time tags so the user can pinpoint
		// the bottleneck in DevTools without us guessing.
		console.time("matrix.start: initRustCrypto");
		try {
			await this.client.initRustCrypto();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/account in the (store|constructor)|doesn'?t match/i.test(msg)) {
				console.warn("rust-crypto store mismatch — wiping and retrying", msg);
				await wipeRustCryptoIndexedDB();
				if (this.stopped) {
					console.timeEnd("matrix.start: initRustCrypto");
					return;
				}
				// initRustCrypto leaves the client in a half-init state on
				// failure; recreate from scratch before retrying.
				this.client = buildClient();
				await this.client.initRustCrypto();
			} else {
				console.timeEnd("matrix.start: initRustCrypto");
				throw err;
			}
		}
		console.timeEnd("matrix.start: initRustCrypto");
		// Bail if stop() ran while we were awaiting crypto init.  Without
		// this guard, a stale strict-mode-cleanup'd transport runs the
		// rest of start() and trips over its now-null this.client.
		if (this.stopped || !this.client) return;

		// Wire up automatic key-backup restore.  Without this call,
		// `crypto.restoreKeyBackup()` only runs once during the manual
		// passphrase-unlock flow — meaning any megolm session that
		// landed in backup AFTER the user last unlocked never flows
		// down, and individual UTDs ("🔒 Couldn't decrypt this
		// message") stay broken until the user manually re-unlocks.
		//
		// `checkKeyBackupAndEnable` (rust-crypto API) does two things:
		//   1. Fetches the current backup version from the server and
		//      validates it's signed by a trusted cross-signing key.
		//   2. Marks backup as enabled in the rust crypto stack — from
		//      this point the rust SDK transparently fetches missing
		//      megolm sessions from /room_keys whenever a UTD lands,
		//      and re-fires the Decrypted event when the cleartext
		//      becomes available.
		//
		// Idempotent + cheap (one HTTP GET when backup state is
		// already correct), so safe to call on every start.  Failure
		// is non-fatal — most likely cause is "no backup exists yet"
		// (pre-setup user) which is correctly handled as "no auto-
		// restore until they enable it".
		//
		// We also chain a `restoreKeyBackup()` after enable.  This is
		// the bulk pull from /room_keys → local store, which catches
		// the multi-device case: if THIS device is missing a session
		// that ANOTHER of this user's devices already uploaded to
		// backup, the bulk pull is what gets it down here.  Without
		// this, the auto-pull only fires on freshly-arriving UTDs,
		// not on UTDs already sitting in the timeline from before
		// backup was enabled — which is most of the visible breakage
		// in practice.
		//
		// Both calls require the backup decryption key to be in the
		// rust crypto store.  It IS there if the user has unlocked
		// at least once on this device (loaded via SSSS into the
		// persistent rust IndexedDB during unlockEncryption).  If
		// they haven't, both calls no-op gracefully — no decryption
		// possible until they enter their passphrase, which the
		// EncryptionUnlockSheet flow will prompt for.
		const cryptoApi = this.client.getCrypto();
		if (cryptoApi) {
			void (async () => {
				try {
					await cryptoApi.checkKeyBackupAndEnable();
				} catch (err) {
					console.warn("matrix: checkKeyBackupAndEnable failed (auto-restore won't work this session)", err);
					return;
				}
				try {
					// Bulk pull.  Pulls every backed-up megolm session
					// into the local store; matrix-js-sdk re-fires
					// Decrypted on stuck timeline events as their
					// sessions arrive.  Slow on first run (one HTTP
					// GET per backup chunk), idempotent thereafter.
					const result = await cryptoApi.restoreKeyBackup();
					console.info(
						`matrix: bulk-restored key backup (imported=${result.imported} total=${result.total})`,
					);
				} catch (err) {
					// Most common failure here is "decryption key not
					// available" — the user hasn't unlocked SSSS on
					// this device yet, so we can't read the backup.
					// Fine — the EncryptionUnlockSheet path will
					// prompt and re-run this on success.
					console.warn("matrix: restoreKeyBackup failed (decryption key likely missing)", err);
				}
			})();
		}

		// Encrypted events arrive via Timeline as `m.room.encrypted`.
		// We skip them there (see Timeline handler below) and instead
		// process them here once decryption resolves their cleartext
		// type — which might be m.room.message, m.reaction, m.call.*,
		// chat.koven.flag.v1, anything.  Routing is identical to the
		// Timeline handler, factored into routeDecryptedEvent.
		this.client.on(MatrixEventEvent.Decrypted, (event: MatrixEvent) => {
			const room = this.client?.getRoom(event.getRoomId() ?? "");
			if (!room) return;
			// UTD recovery is handled INSIDE the rust crypto stack —
			// it auto-pulls missing megolm sessions from key backup
			// (enabled via checkKeyBackupAndEnable in start()) and
			// auto-issues m.room_key_request to-device messages to
			// the sender's other devices.  When a key eventually
			// arrives, rust-crypto re-decrypts and re-fires this
			// Decrypted event with the cleartext.  Manual
			// `cancelAndResendEventRoomKeyRequest` from MatrixClient
			// is a libolm-era API the SDK marks `@deprecated Not
			// supported for Rust Cryptography` — it throws inside
			// the SDK on rust-crypto, so we'd be silently swallowing
			// errors with no actual recovery.  Trust the rust stack.
			this.routeDecryptedEvent(event, room, false);
		});

		// Server-side session invalidation (token revoked, device
		// deleted, admin-forced logout, soft-logout).  matrix-js-sdk
		// detects M_UNKNOWN_TOKEN responses and emits this; we use it
		// as the canonical "stop trying, the server doesn't recognize
		// us anymore" signal.  Without this listener, rust-crypto's
		// /keys/query loop just keeps 401-ing forever and the SPA
		// stays stuck on "Connecting…" — observed when a dev session
		// loaded localStorage creds whose device had been wiped on
		// the homeserver.  Once-per-call guarded so the dispatch
		// doesn't fire repeatedly (the SDK can re-emit during the
		// in-flight retry storm before stop() takes effect).
		let sessionDeadFired = false;
		const fireSessionDead = (reason: string) => {
			if (sessionDeadFired) return;
			sessionDeadFired = true;
			console.warn(`matrix: session invalidated (${reason}) — bouncing to login`);
			try {
				this.handlers.onSessionLoggedOut();
			} catch (err) {
				console.warn("matrix: onSessionLoggedOut handler threw", err);
			}
			// Tear down the in-process client so no further requests
			// fire against the dead token while the SPA navigates
			// back to login.  stop() is idempotent, App.tsx will run
			// its own cleanup as soon as the creds prop flips.
			void this.stop();
		};
		this.client.on(HttpApiEvent.SessionLoggedOut, () => {
			fireSessionDead("HttpApiEvent.SessionLoggedOut");
		});

		// Hooks must be in place BEFORE startClient or we miss the
		// initial sync's events.
		this.client.on(ClientEvent.Sync, (state: string) => {
			const mapped: SyncState =
				state === "PREPARED" ? "ready" :
				state === "SYNCING" ? "syncing" :
				state === "RECONNECTING" ? "syncing" :
				state === "STOPPED" ? "offline" :
				state === "ERROR" ? "error" :
				"preparing";
			this.syncState = mapped;
			this.handlers.onSyncState(mapped);
			if (mapped === "ready" || mapped === "syncing") {
				this.emitRoomList();
				this.emitSpaceList();
			}
			if (mapped === "ready") {
				// Self-heal the current device's display name on every
				// boot so the Sessions list distinguishes Web / Desktop /
				// Mobile clients without relying on whatever label the
				// engine wrote at login time.  Idempotent — same input
				// produces the same PUT, which Synapse short-circuits.
				void this.syncOwnDeviceLabel().catch(err =>
					console.warn("matrix: device-label sync failed", err),
				);
				// Re-validate key-backup state on every "ready"
				// transition.  The first call fires from start(); this
				// one catches the case where the user setup or rotated
				// their backup on another device while this session
				// was offline.  Without it, the rust SDK keeps trying
				// against the dead backup version and every UTD
				// stays stuck.
				void this.client?.getCrypto()?.checkKeyBackupAndEnable().catch(err => {
					console.warn("matrix: post-sync checkKeyBackupAndEnable failed", err);
				});
			}
		});

		this.client.on(RoomEvent.Timeline, (
			event: MatrixEvent,
			room: SdkRoom | undefined,
			toStartOfTimeline: boolean | undefined,
			removed: boolean,
			data: IRoomTimelineData,
		) => {
			if (!room || toStartOfTimeline || removed) return;
			const live = !!data.liveEvent;
			const type = event.getType();
			// Encrypted events not yet decrypted — defer until the
			// Decrypted listener fires with the cleartext type.
			// Otherwise we'd add an empty placeholder for things that
			// turn out not to be messages at all (m.call.*, m.reaction,
			// chat.koven.flag.v1, etc.).  Voice/video calls in DMs
			// are the most visible case: every signaling event in the
			// room arrived as m.room.encrypted and got an empty bubble.
			if (type === "m.room.encrypted") return;
			this.routeDecryptedEvent(event, room, live);
		});

		this.client.on(RoomEvent.MyMembership, () => {
			this.emitRoomList();
			this.emitSpaceList();
		});

		// m.space.child / m.space.parent state changes don't fire
		// MyMembership — listen for state events on any room and refresh
		// the space view when one of those types changes.
		// `chat.koven.pinned_rooms` is the Koven-custom state event a
		// space admin uses to pin rooms in that space; refresh both
		// lists when it changes so the new ordering picks up.
		//
		// Also: when a NEW m.space.child arrives on a space we're
		// joined to, auto-join the referenced child room.  Symmetric
		// with joinSpaceWithChildren (which auto-joins children when
		// you first join a space) — keeps the Discord-style "channels
		// you're a server member of all show up automatically"
		// experience working when an admin adds a channel later.
		// Skipped for sub-spaces, tombstoned references, and rooms
		// we've already joined.  Self-emitted events still flow
		// through this listener but the "already a member" guard
		// makes the auto-join an idempotent no-op there.
		this.client.on(RoomEvent.Timeline, (event: MatrixEvent) => {
			const t = event.getType();
			if (
				t === "m.space.child" ||
				t === "m.space.parent" ||
				t === "m.room.create" ||
				t === "chat.koven.pinned_rooms"
			) {
				this.emitSpaceList();
				this.emitRoomList();
			}
			if (t !== "m.space.child") return;
			const parentSpaceId = event.getRoomId();
			const childRoomId = event.getStateKey();
			if (!parentSpaceId || !childRoomId) return;
			const c = this.client;
			if (!c) return;
			// Only act on spaces I'm currently joined to.  An invite-
			// state space's children shouldn't get auto-joined until
			// I actually accept the parent.
			const parent = c.getRoom(parentSpaceId);
			if (parent?.getMyMembership() !== "join") return;
			// Tombstoned reference (admin removed the room from the
			// space) — empty `via` array, skip.
			const content = event.getContent() as { via?: string[] };
			if (!Array.isArray(content.via) || content.via.length === 0) return;
			// Already a member?  Nothing to do.
			const existing = c.getRoom(childRoomId);
			const myMembership = existing?.getMyMembership();
			if (myMembership === "join" || myMembership === "invite") return;
			// Sub-spaces are explicit opt-in — symmetric with
			// joinSpaceWithChildren which doesn't auto-join sub-spaces.
			if (existing?.isSpaceRoom?.()) return;
			// NSFW gate — when the viewer hasn't opted into NSFW
			// content, skip auto-join for children whose m.space.child
			// content is flagged nsfw=true.  Without this, a SFW space
			// admin adding an NSFW room would silently auto-join every
			// member regardless of their preference.  Symmetric with
			// the same skip in joinSpaceWithChildren.  Backwards-compat
			// for older m.space.child events (no nsfw field): we'd
			// auto-join, but the post-join sweep below catches NSFW-
			// flagged rooms and leaves them.
			const nsfwHint = (content as { nsfw?: unknown }).nsfw === true;
			if (nsfwHint && !this.getNsfwPreference()) {
				return;
			}
			void c.joinRoom(childRoomId).then(() => {
				// Post-join NSFW sweep: if the room turned out to be
				// flagged NSFW (state we couldn't see pre-join) and
				// the viewer hasn't opted into NSFW, leave the room.
				if (!this.getNsfwPreference()) {
					const joinedRoom = c.getRoom(childRoomId);
					if (joinedRoom && readKovenNsfw(joinedRoom)) {
						c.leave(childRoomId).catch(err => {
							console.warn(`auto-leave NSFW child ${childRoomId} failed`, err);
						});
						return;
					}
				}
				this.emitRoomList();
			}).catch(err => {
				// Banned, room doesn't exist, etc. — log and move on.
				console.warn(`auto-join on m.space.child(${childRoomId}) failed`, err);
			});
		});

		this.client.on(RoomMemberEvent.Membership, (_event, member) => {
			this.handlers.onMembersUpdated(member.roomId as RoomId);
		});

		// m.read receipts — drives the "seen by" indicators in chat.
		this.client.on(RoomEvent.Receipt, (_event, room) => {
			if (!room) return;
			this.handlers.onReceiptsUpdated(room.roomId as RoomId);
		});

		// notification_count changes — fires on each Room object when
		// /sync delivers an updated `unread_notifications` block.
		//
		// IMPORTANT: matrix-js-sdk's sync layer does NOT re-emit
		// RoomEvent.UnreadNotifications up to the client (see
		// sync.js's reEmit list — it covers Timeline / Receipt /
		// Tags / etc. but NOT UnreadNotifications).  Listening on
		// `client.on(RoomEvent.UnreadNotifications, …)` looks
		// reasonable but is silently dead — the callback never
		// fires.  We have to attach the listener to each Room
		// object directly.  ClientEvent.Room fires when a new room
		// gets added (initial sync, joining a room, accepting an
		// invite); we hook the per-room listener there.
		const wireUnreadListener = (room: SdkRoom) => {
			room.on(RoomEvent.UnreadNotifications, () => this.emitRoomList());
		};
		this.client.on(ClientEvent.Room, wireUnreadListener);
		// Also wire any rooms that already exist at start time (the
		// indexed-DB store hydrated them before our listener was
		// attached, so ClientEvent.Room won't fire for them).
		for (const room of this.client.getRooms()) {
			wireUnreadListener(room);
		}

		// Presence updates — fire onMembersUpdated for every room
		// the user is in so the member-list status dot + grouping
		// stay live as people come / go online.  Walking rooms per
		// event is fine: presence updates aren't that frequent and
		// the room list is small.  CurrentlyActive fires when a
		// user transitions between active and idle inside the
		// "online" presence — also reflected in our 3-bucket model.
		const refreshPresenceFor = (userId: string | undefined) => {
			if (!userId || !this.client) return;
			let touchedDm = false;
			for (const room of this.client.getRooms()) {
				if (!room.getMember(userId)) continue;
				this.handlers.onMembersUpdated(room.roomId as RoomId);
				// If `userId` is the peer of a DM, the DM tile in the
				// room list shows a live presence dot — needs the room
				// list to re-emit so RoomAvatar picks up the new colour.
				const dm = this.client.getAccountData("m.direct" as any);
				const dmMap = (dm?.getContent() ?? {}) as Record<string, string[]>;
				if (Array.isArray(dmMap[userId]) && dmMap[userId].includes(room.roomId)) {
					touchedDm = true;
				}
			}
			if (touchedDm) this.emitRoomList();
		};
		this.client.on(UserEvent.Presence, (_event, user) => refreshPresenceFor(user?.userId));
		this.client.on(UserEvent.CurrentlyActive, (_event, user) => refreshPresenceFor(user?.userId));
		// Re-emit when a DM peer's avatar / display name updates so
		// the room list tile reflects the change.  Bots whose avatars
		// were set after the bot first joined the DM rely on this:
		// the join membership event carries the at-join-time avatar
		// (often empty), but a later getProfileInfo() populates the
		// User object's avatarUrl, which our DM avatar fallback
		// chain reads — without this listener the new avatar wouldn't
		// surface until the next sync round-trip.
		this.client.on(UserEvent.AvatarUrl, (_event, user) => refreshPresenceFor(user?.userId));
		this.client.on(UserEvent.DisplayName, (_event, user) => refreshPresenceFor(user?.userId));

		// 1:1 voice/video — the SDK fires CallEventHandlerEvent.Incoming
		// once when a remote m.call.invite is processed and ringing.
		// We just hand the MatrixCall to the application; UI lifecycle
		// (accept/decline/hangup) is driven through the call object.
		this.client.on(CallEventHandlerEvent.Incoming, (call: MatrixCall) => {
			this.handlers.onIncomingCall(call);
		});

		// Account data fires on every map change in account_data — most
		// of which we don't care about.  We branch on the type:
		//
		//   * m.ignored_user_list — re-broadcast to the Settings sheet's
		//     blocked-users section + ChatPane's per-message filter so
		//     they re-render live.
		//
		//   * m.direct — server-side has now caught up with whatever
		//     setAccountData("m.direct", …) we fired earlier.  Clear
		//     any pendingDmMappings entries that are now in the real
		//     map, then re-emit the room list so DM classification
		//     refreshes.  Without this re-emit, a DM that was being
		//     classified via the optimistic mirror stays in the mirror
		//     (correct but redundant) until something else triggers
		//     emitRoomList; harmless but wasteful.
		this.client.on(ClientEvent.AccountData, (event: MatrixEvent) => {
			const type = event.getType();
			if (type === "m.ignored_user_list") {
				for (const fn of this.ignoreListeners) {
					try { fn(); } catch (err) { console.warn("ignore listener threw", err); }
				}
				return;
			}
			if (type === "m.direct") {
				const content = event.getContent() as Record<string, string[]>;
				const allDmRoomIds = new Set<string>();
				for (const ids of Object.values(content)) {
					if (Array.isArray(ids)) for (const id of ids) allDmRoomIds.add(id);
				}
				for (const roomId of Array.from(this.pendingDmMappings.keys())) {
					if (allDmRoomIds.has(roomId)) this.pendingDmMappings.delete(roomId);
				}
				this.emitRoomList();
				return;
			}
			if (type === "chat.koven.nsfw_preference") {
				// Cross-device sync of the NSFW discovery toggle.  Fires
				// for changes from THIS client (round-trip echo) and
				// from any other device the same user is signed in on.
				// App.tsx subscribes via onNsfwPreferenceChanged and
				// mirrors the value into local Settings so the next
				// render uses it.
				const content = event.getContent() as { show?: unknown };
				const show = content.show === true;
				for (const fn of this.nsfwPrefListeners) {
					try { fn(show); } catch (err) { console.warn("nsfw-pref listener threw", err); }
				}
				return;
			}
		});

		if (this.stopped || !this.client) return;
		// NOTE: we deliberately do NOT call startClient() here anymore.
		// Even fire-and-forget, it kicks off heavy synchronous work the
		// moment Synapse's first /sync response arrives — JSON-parsing
		// thousands of events, decrypting via rust-crypto WASM,
		// dispatching React state updates per-room.  All of that runs
		// on the JS main thread and starves React's commit phase, so
		// the setEncState() that fires after start() resolves DOES
		// land in state but can't paint until the sync work yields.
		// That's the "Connecting… for a minute, then a click forces
		// the encryption sheet to appear" symptom users were hitting
		// — clicks are discrete events React flushes at high priority,
		// which is the only thing that can interrupt the sync hog.
		//
		// The fix is to let the caller decide when sync starts.  start()
		// now returns once the crypto + listeners are wired up; the
		// caller (App.tsx) runs the encryption probe, sets state, lets
		// React commit, THEN calls beginSync().  By that point the
		// user is already past the Connecting screen and either in a
		// setup/unlock sheet or the main UI — sync hogging the thread
		// from there on is acceptable: the existing "Sync: preparing /
		// syncing" banner already explains the wait, and rooms paint
		// progressively as sync emits Timeline events.
	}

	/**
	 * Kick off the sync loop.  Called by App.tsx after the encryption
	 * probe completes and the corresponding UI (setup sheet, unlock
	 * sheet, or the main app for already-unlocked users) has had a
	 * chance to render.  Idempotent + cancellable: re-calling after
	 * start() is fine; if stop() ran first this no-ops.
	 */
	beginSync(): void {
		if (this.stopped || !this.client) return;
		// startClient resolves after the FIRST /sync completes; we
		// don't await it here either, since callers of beginSync don't
		// need a "sync is fully ready" barrier — they listen for
		// SyncState transitions on the transport instead.
		void this.client.startClient({
			// 200 events per room on initial sync (was 30).  Text chat
			// events are tiny — 200 messages per room is a few hundred
			// KB total even on chatty accounts — and the larger initial
			// batch means recent rooms feel fully loaded the moment
			// the SPA paints.  Pairs with the bumped `loadMoreHistory`
			// chunk size so subsequent scrollback hops also feel
			// instant rather than chunked.
			initialSyncLimit: 200,
			// "detached" lets us call redactEvent (unreact, unflag).  The
			// default "chronological" mode keeps pending events on a
			// per-room queue that redactEvent's getPendingEvents helper
			// refuses to read from — see matrix-js-sdk Room.getPendingEvents.
			pendingEventOrdering: sdk.PendingEventOrdering.Detached,
		}).catch(err => {
			console.warn("matrix: startClient failed", err);
		});
	}

	/**
	 * Server-side logout: invalidate the access token AND deactivate
	 * this device on Synapse.  Called from handleSignOut so a user
	 * doesn't accumulate stale devices on every sign-out → sign-in
	 * cycle.  Without this, encrypted messages get encrypted to
	 * those stale devices and recipients get "key backup is not
	 * working" decryption failures because the live device was
	 * never given the megolm session.
	 *
	 * matrix-js-sdk's `client.logout()` POSTs to
	 * `/_matrix/client/v3/logout` which:
	 *   * Invalidates the access token (future requests 401).
	 *   * Removes the device from the user's device list.
	 *   * Triggers a device-list update to other room members so
	 *     their clients stop trying to encrypt to this device.
	 *
	 * Best-effort — we still proceed with the local wipe + nav even
	 * if the server-side call fails (token already expired, network
	 * down, etc.).
	 */
	async logout(): Promise<void> {
		const c = this.client;
		if (!c) return;
		try {
			await c.logout(true /* stopClient */);
		} catch (err) {
			console.warn("transport.logout: server-side logout failed", err);
		}
		// Wipe the persistent matrix-js-sdk cache for THIS user.  Same-
		// user stop()→start() (page refresh) keeps the data for fast
		// re-hydration; an explicit logout means the user is leaving
		// this account, so leaving the cache around would be a
		// privacy footgun on a shared device AND would surface stale
		// rooms the next time they sign in.  Best-effort — failures
		// log and we move on (the local sign-out / token invalidation
		// already happened, the user is leaving regardless).
		if (this.store) {
			try {
				await this.store.deleteAllData();
			} catch (err) {
				console.warn("transport.logout: store.deleteAllData failed", err);
			}
		}
	}

	/**
	 * Tear down the transport and release every resource it holds.
	 *
	 * Async because the IDB-drain step has to actually wait for the
	 * OlmMachine's IndexedDB connection to close — without that wait,
	 * a subsequent start() on this origin opens a stale DB and hangs
	 * on the rust-crypto account-mismatch error.  See {@link
	 * deleteDatabaseAwait} for the gory details.
	 *
	 * Callers that want fire-and-forget can `void transport.stop()`
	 * and not await; the in-memory state cleanup is synchronous so
	 * the React side flips immediately, and only the IDB drain is
	 * waited on by callers that want to start a new transport on the
	 * same origin without a race.
	 *
	 * Idempotent: calling stop() twice is safe — the second call
	 * sees client === null and short-circuits.
	 */
	async stop(): Promise<void> {
		this.stopped = true;
		// Tear down rust-crypto FIRST so the OlmMachine releases its
		// IndexedDB handle.  matrix-js-sdk's MatrixClient.stopClient
		// only stops the /sync loop and event listeners — it does NOT
		// close the underlying CryptoApi.  Without this call, the
		// OlmMachine stays alive in WASM after logout, keeps the
		// matrix-sdk-crypto IDB locked, and the NEXT login's
		// initRustCrypto hangs / fails to wipe the store on user
		// switch.  That was the cause of "stuck on Connecting…" on
		// the second account in the same tab.
		//
		// CryptoApi#stop is documented (in the impl) as safe to call
		// multiple times — it short-circuits when already stopped.
		// Wrapped in try/catch defensively: if a future SDK version
		// makes this throw on already-stopped, we still want the
		// rest of the teardown to run.
		try {
			// CryptoApi public typings don't include stop() in
			// matrix-js-sdk@34, but the rust-crypto implementation
			// does (rust-crypto/rust-crypto.d.ts) and the runtime
			// dispatches to it.  Cast through unknown to call it
			// without weakening the SDK types elsewhere.
			const crypto = this.client?.getCrypto() as
				| { stop?: () => void }
				| undefined;
			crypto?.stop?.();
		} catch (err) {
			console.warn("matrix.stop: getCrypto().stop() threw", err);
		}
		this.client?.stopClient();
		this.client?.removeAllListeners();
		this.client = null;
		// Close the IndexedDBStore connection so the IDB handle drains
		// promptly and a quick stop()→start() doesn't trip over its
		// own open connection.  destroy() is idempotent in matrix-js-sdk
		// — safe to call when already stopped.  Do NOT deleteAllData
		// here; that path is reserved for logout() so same-user
		// refreshes / transient teardowns keep the cache hot.
		if (this.store) {
			try {
				await this.store.destroy();
			} catch (err) {
				console.warn("matrix.stop: store.destroy() threw", err);
			}
			this.store = null;
		}
		const teardownUserId = this.creds?.user_id;
		this.creds = null;
		// Drop the in-memory SSSS key so a stop()→start() cycle
		// re-prompts for unlock.  Not strictly required by the SDK
		// (which has its own cache via the cacheSecretStorageKey hook)
		// but keeps our reasoning simple: the key only lives as long
		// as the transport is running.
		this.ssssKey = null;
		// Revoke any blob URLs we minted so the browser can free their
		// backing memory.  Promises that haven't resolved yet just leak;
		// they'll be GC'd when the awaiting components unmount.
		for (const promise of this.mediaCache.values()) {
			promise.then(URL.revokeObjectURL).catch(() => {});
		}
		this.mediaCache.clear();
		this.mediaResolved.clear();
		this.ignoreListeners.clear();
		this.nsfwPrefListeners.clear();
		this.uiaPassword = null;
		// Don't delete the rust-crypto IDB on stop().  Same-user
		// stop→start cycles (page refresh, transient errors) need
		// the megolm sessions + cross-signing state preserved; only
		// a real account switch should wipe.  start() handles that
		// via the LAST_USER_KEY mismatch check: when start() sees
		// the user changed, it calls wipeRustCryptoIndexedDB(),
		// which now properly awaits the IDB connection drain (see
		// deleteDatabaseAwait) instead of resolving on `blocked`
		// and racing the next initRustCrypto.
		void teardownUserId;
	}

	// ─── UIA password stash ────────────────────────────────────────────

	/** Stash the engine-issued UIA password for this session.  Pass null
	 * to clear (e.g. once it's been used). */
	setUiaPassword(password: string | null): void {
		this.uiaPassword = password;
	}

	/** Read the stashed UIA password, or null if none is currently set. */
	getUiaPassword(): string | null {
		return this.uiaPassword;
	}

	// ─── Encryption ─────────────────────────────────────────────────
	// SSSS (server-side secret storage) holds the user's cross-signing
	// keys and key-backup decryption key, encrypted with a secret only
	// the user holds.  The user-side secret comes from one of two
	// equivalent inputs:
	//
	//   1. A passphrase the user picks (PBKDF2 → 256-bit key)
	//   2. A 48-char base58 recovery key the SDK generates on setup
	//      and the user saves once
	//
	// `setupEncryption` runs once per account, at signup.  It bootstraps
	// cross-signing, sets up SSSS, enables server-side key backup, and
	// returns the recovery key so the UI can show it to the user.
	//
	// `unlockEncryption` runs on every fresh device login.  It takes
	// either input form, derives the SSSS private key, and hands it to
	// the SDK so encrypted DMs / cross-signing / key backup can resume.

	/**
	 * One-time setup at signup.  Idempotent — calling it again with
	 * `setupNewSecretStorage: true` resets and rotates everything.
	 *
	 * Returns the encoded recovery key (a 48-char base58 string).  The
	 * caller MUST display this to the user once and let them save it;
	 * we don't persist it anywhere.
	 */
	async setupEncryption(passphrase: string, accountPassword?: string): Promise<{ recoveryKey: string }> {
		const c = this.requireClient();
		const crypto = c.getCrypto();
		if (!crypto) throw new Error("crypto not initialized");

		// Cross-signing key upload requires UIA (user-interactive auth).
		// On Synapse the m.login.password flow re-validates the user
		// with the password it currently has on file.  In Koven's
		// passwordless email-code flow the engine rotates that password
		// to a fresh random string and stashes it on the transport via
		// setUiaPassword().  Callers can also pass it explicitly (e.g.
		// for a fresh per-call rotation) — explicit param wins.
		const password = accountPassword ?? this.uiaPassword;
		if (!password) {
			throw new Error("UIA password unavailable; call setUiaPassword first");
		}
		const userId = this.creds?.user_id;
		if (!userId) throw new Error("not logged in");
		const authCallback = async (
			makeRequest: (auth: any) => Promise<any>,
		) => {
			// First call usually returns 401 with a UIA session id; we
			// retry with the password flow.  Some Synapse versions
			// accept the auth on the first try if the access token's
			// session is still UIA-validated, so we attempt once with
			// no auth before falling back to password.
			try {
				return await makeRequest(null);
			} catch (err) {
				const uiaError = err as { data?: { session?: string; flows?: unknown } };
				const session = uiaError?.data?.session;
				if (!session) throw err;
				return await makeRequest({
					type: "m.login.password",
					session,
					identifier: { type: "m.id.user", user: userId },
					password,
				});
			}
		};

		await crypto.bootstrapCrossSigning({
			authUploadDeviceSigningKeys: authCallback,
			setupNewCrossSigning: true,
		});

		// Capture the freshly-generated key out of the createSecretStorageKey
		// callback so we can return its encoded form to the caller.
		// `createRecoveryKeyFromPassphrase` wraps the passphrase in
		// PBKDF2 and gives us back both the raw private key (for SDK
		// internals) and the user-displayable encoded form.
		let captured: { privateKey: Uint8Array; encodedPrivateKey: string } | null = null;
		// rust-crypto rejects bootstrapSecretStorage's `setupNewKeyBackup`
		// shortcut with "Password-based backup is not available on this
		// platform" — that flag is a libolm-era convenience.  With the
		// rust stack the correct sequence is: bootstrap SSSS first
		// (so a working secret storage key exists), then call
		// resetKeyBackup() which creates the backup version on the
		// server and stashes the decryption key into the SSSS we just
		// set up.  `getSecretStorageKey` (our cryptoCallbacks hook)
		// returns it the moment resetKeyBackup asks.
		await crypto.bootstrapSecretStorage({
			createSecretStorageKey: async () => {
				const generated = await crypto.createRecoveryKeyFromPassphrase(passphrase);
				captured = {
					privateKey: generated.privateKey,
					encodedPrivateKey: generated.encodedPrivateKey ?? "",
				};
				return generated;
			},
			setupNewSecretStorage: true,
		});

		if (!captured) throw new Error("recovery key not generated");
		const cap = captured as { privateKey: Uint8Array; encodedPrivateKey: string };
		// Cache the key locally so subsequent SDK operations that need
		// SSSS work without re-prompting.  The bootstrap path usually
		// already calls cacheSecretStorageKey, but we belt-and-brace
		// — resetKeyBackup below will block on getSecretStorageKey if
		// the cache isn't populated.
		const keyInfo = await c.secretStorage.getKey();
		if (keyInfo) {
			this.ssssKey = { keyId: keyInfo[0], privateKey: cap.privateKey };
		}

		// Create the server-side megolm key backup.  This stores the
		// backup decryption key inside the SSSS we just set up, so a
		// future device that unlocks SSSS (via passphrase or recovery
		// key) can also restore message history.
		await crypto.resetKeyBackup();

		return { recoveryKey: cap.encodedPrivateKey };
	}

	/**
	 * Restore SSSS access on a fresh device login.  Accepts either the
	 * user's encryption passphrase OR their recovery key — both derive
	 * to the same private key.  Returns `true` on success, `false` if
	 * the input doesn't decrypt the SSSS data (wrong passphrase / typo).
	 */
	async unlockEncryption(passphraseOrRecoveryKey: string): Promise<boolean> {
		const c = this.requireClient();
		const keyInfo = await c.secretStorage.getKey();
		if (!keyInfo) {
			// Nothing to unlock.  Caller should route to setupEncryption.
			return false;
		}
		const [keyId, info] = keyInfo;

		// Try recovery-key form first (base58, 48 chars-ish).  If it
		// doesn't decode, fall through to passphrase derivation.
		const crypto = c.getCrypto();
		if (!crypto) throw new Error("crypto not initialized");

		const cryptoApi = await import("matrix-js-sdk/lib/crypto-api");
		let privateKey: Uint8Array | null = null;
		try {
			privateKey = cryptoApi.decodeRecoveryKey(passphraseOrRecoveryKey);
		} catch {
			// Not a recovery key — try as passphrase.
			if (info.passphrase) {
				privateKey = await cryptoApi.deriveRecoveryKeyFromPassphrase(
					passphraseOrRecoveryKey,
					info.passphrase.salt,
					info.passphrase.iterations,
				);
			}
		}
		if (!privateKey) return false;

		// Verify the derived key matches the stored MAC before we accept
		// it.  checkKey returns true iff the key matches.
		const ok = await c.secretStorage.checkKey(privateKey, info);
		if (!ok) return false;

		this.ssssKey = { keyId, privateKey };

		// Pull cross-signing private keys + key backup decryption key
		// out of SSSS now that we have the unlock key.  This re-trusts
		// this device against the existing cross-signing identity and
		// lets the SDK decrypt the megolm key backup.
		await crypto.bootstrapCrossSigning({});
		await crypto.bootstrapSecretStorage({});
		// Key-backup restore.  Two-phase:
		//   1. Load the backup decryption key from SSSS.  This is the
		//      curve25519 private key that was encrypted under the
		//      user's recovery key at setupEncryption time.
		//   2. Pull every backed-up megolm session from /room_keys
		//      and import them into the local rust-crypto store.
		// Phase 1 failure usually means SSSS is malformed (legacy
		// account, partial setup); phase 2 failure usually means
		// network or no backup exists yet on the server.  We log
		// loudly either way so a regression is visible — silent
		// success that leaves history un-decryptable is the worst
		// failure mode.
		try {
			await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
		} catch (err) {
			console.error("unlockEncryption: failed to load backup decryption key from SSSS — old encrypted messages will fail to decrypt until key forwarding catches up", err);
		}
		try {
			await crypto.restoreKeyBackup();
		} catch (err) {
			console.error("unlockEncryption: restoreKeyBackup failed — old encrypted messages will fail to decrypt", err);
		}
		return true;
	}

	/**
	 * Probe the current encryption state for the signed-in account.
	 * The login UI uses this to decide between three states:
	 *
	 *   - "needs-setup": no SSSS on the server, run signup flow
	 *   - "needs-unlock": SSSS exists but this device can't read it
	 *   - "ready": SSSS is set up and unlocked
	 */
	async encryptionStatus(): Promise<"needs-setup" | "needs-unlock" | "ready"> {
		const c = this.requireClient();
		const crypto = c.getCrypto();
		if (!crypto) return "needs-setup";
		// Two phases of timing — the SSSS account-data probe and the
		// cross-signing status read.  Both run before the first /sync
		// completes, so secretStorage.getKey falls through to a direct
		// HTTP GET rather than reading the synced cache.  If either
		// shows up as the slow phase in the user's console, we know
		// where to optimize.
		console.time("matrix.encryptionStatus: secretStorage.getKey");
		const keyInfo = await c.secretStorage.getKey();
		console.timeEnd("matrix.encryptionStatus: secretStorage.getKey");
		if (!keyInfo) return "needs-setup";
		// Cross-signing readiness is the cleanest "this device is set
		// up" signal — true iff cross-signing private keys are cached
		// locally.  Anything less means we need the user to unlock.
		console.time("matrix.encryptionStatus: getCrossSigningStatus");
		const status = await crypto.getCrossSigningStatus();
		console.timeEnd("matrix.encryptionStatus: getCrossSigningStatus");
		const cached = status.privateKeysCachedLocally;
		if (cached.masterKey && cached.selfSigningKey && cached.userSigningKey) {
			return "ready";
		}
		return "needs-unlock";
	}

	/**
	 * Fetch an mxc:// URL via the authenticated media endpoint and
	 * return a blob: URL we can stuff into <img src>.  Cached per-mxc
	 * so multiple components rendering the same avatar share the
	 * single fetch + blob.
	 */
	async getMxcBlobUrl(mxc: string): Promise<string> {
		const cached = this.mediaCache.get(mxc);
		if (cached) return cached;

		const promise = this.fetchMxcAsBlobUrl(mxc);
		this.mediaCache.set(mxc, promise);
		// On success: also stash in the sync-readable map so the avatar
		// hook can peek without awaiting.  On failure: evict so the
		// next caller retries instead of permanently caching a reject.
		promise.then(
			url => this.mediaResolved.set(mxc, url),
			() => this.mediaCache.delete(mxc),
		);
		return promise;
	}

	/**
	 * Synchronous lookup for a blob URL we've already resolved.
	 * Returns undefined if the mxc was never fetched, is still in
	 * flight, or failed.  Used to seed avatar render state on mount so
	 * cached avatars don't flash through a fallback.
	 */
	peekMxcBlobUrl(mxc: string): string | undefined {
		return this.mediaResolved.get(mxc);
	}

	private async fetchMxcAsBlobUrl(mxc: string): Promise<string> {
		if (!this.client || !this.creds) throw new Error("Transport not started");
		// useAuthentication=true → authenticated media endpoint, which
		// is the only one Synapse 1.100+ serves.
		const url = this.client.mxcUrlToHttp(
			mxc,
			undefined, undefined, undefined,
			false,  // allowDirectLinks
			true,   // allowRedirects (S3 / CDN backends use this)
			true,   // useAuthentication
		);
		if (!url) throw new Error(`Could not resolve mxc URL: ${mxc}`);
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${this.creds.access_token}` },
		});
		if (!response.ok) {
			throw new Error(`Media fetch ${mxc} → ${response.status}`);
		}
		const blob = await response.blob();
		return URL.createObjectURL(blob);
	}

	/**
	 * Resolve a Message's media payload to a blob: URL the UI can render.
	 * For plaintext rooms this is the same as `getMxcBlobUrl`.  For
	 * encrypted rooms we fetch the ciphertext, decrypt with the AES-CTR
	 * key bundled in the event, and wrap the plaintext in a Blob with
	 * the original mime type so <img> / <video> / <audio> handle it.
	 *
	 * Cached per-mxc, same as plain media — re-renders share one fetch
	 * + decrypt and one blob URL.
	 */
	async getAttachmentBlobUrl(spec: {
		mxc: string;
		mimeType?: string;
		encrypted?: import("@koven/shared").MediaEncryption;
	}): Promise<string> {
		// Plaintext: identical to the avatar path.  Synapse-served auth
		// fetch + cached blob URL.
		if (!spec.encrypted) return this.getMxcBlobUrl(spec.mxc);

		const cached = this.mediaCache.get(spec.mxc);
		if (cached) return cached;
		const promise = this.fetchEncryptedAsBlobUrl(spec.encrypted, spec.mimeType);
		this.mediaCache.set(spec.mxc, promise);
		promise.then(
			url => this.mediaResolved.set(spec.mxc, url),
			() => this.mediaCache.delete(spec.mxc),
		);
		return promise;
	}

	private async fetchEncryptedAsBlobUrl(
		enc: import("@koven/shared").MediaEncryption,
		mimeType: string | undefined,
	): Promise<string> {
		if (!this.client || !this.creds) throw new Error("Transport not started");
		const url = this.client.mxcUrlToHttp(
			enc.url,
			undefined, undefined, undefined,
			false, true, true,
		);
		if (!url) throw new Error(`Could not resolve mxc URL: ${enc.url}`);
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${this.creds.access_token}` },
		});
		if (!response.ok) {
			throw new Error(`Encrypted media fetch ${enc.url} → ${response.status}`);
		}
		const ciphertext = await response.arrayBuffer();
		const { decryptAttachment } = await import("matrix-encrypt-attachment");
		const plaintext = await decryptAttachment(ciphertext, enc as any);
		// Wrap in a Blob with the original mime type so the browser
		// renders <img>/<video>/<audio> correctly.  Falls back to
		// octet-stream which still works for download links.
		const blob = new Blob([plaintext], { type: mimeType ?? "application/octet-stream" });
		return URL.createObjectURL(blob);
	}

	/**
	 * Fetch an OpenGraph preview for a URL via Synapse's
	 * /_matrix/client/v3/media/preview_url endpoint.  Synapse fetches
	 * the URL server-side (respecting the IP blacklist we set in
	 * homeserver.yaml so it can't SSRF internal addresses) and returns
	 * the parsed og:* fields.  Image URLs come back as mxc:// pointers
	 * to the bytes Synapse cached for us; the UI feeds those through
	 * `getMxcBlobUrl` exactly like any other authenticated media.
	 *
	 * Cached per-URL on the matrix-js-sdk client; repeat calls within
	 * the SDK's TTL just return the prior promise.  Returns null when
	 * the preview comes back empty (no og:title) or the request fails;
	 * the UI uses that to decide whether to render anything.
	 */
	async previewUrl(url: string): Promise<UrlPreview | null> {
		const c = this.requireClient();
		try {
			const data = await c.getUrlPreview(url, Date.now()) as Record<string, unknown>;
			const title = typeof data["og:title"] === "string" ? (data["og:title"] as string) : "";
			if (!title) return null;
			const desc = typeof data["og:description"] === "string" ? (data["og:description"] as string) : undefined;
			const site = typeof data["og:site_name"] === "string" ? (data["og:site_name"] as string) : undefined;
			const imageMxc = typeof data["og:image"] === "string" ? (data["og:image"] as string) : undefined;
			const w = typeof data["og:image:width"] === "number" ? (data["og:image:width"] as number) : undefined;
			const h = typeof data["og:image:height"] === "number" ? (data["og:image:height"] as number) : undefined;
			return {
				url,
				title,
				description: desc,
				siteName: site,
				imageMxc: imageMxc?.startsWith("mxc://") ? imageMxc : undefined,
				imageWidth: w,
				imageHeight: h,
			};
		} catch {
			// 404 / 403 / bad URL — caller treats null as "no preview".
			return null;
		}
	}

	/**
	 * Upload a file as a message attachment and send the corresponding
	 * `m.room.message` event.  Picks msgtype from mimetype (image/*,
	 * video/*, audio/*, otherwise m.file), captures image dimensions
	 * client-side, and routes through the encrypted-attachment path
	 * when the target room is end-to-end encrypted.
	 */
	/**
	 * Upload an image File and return its mxc:// URI.  Pipes through
	 * the same sanitiser the chat-attachment path uses, so HEIC
	 * inputs come out as PNG and JPEG/PNG come out EXIF-stripped.
	 *
	 * Centralised so every avatar-upload site (room create/update,
	 * space create/update, user profile, bot edit) gets the policy
	 * for free without each one importing imageSanitize directly.
	 */
	async uploadAvatarImage(file: File): Promise<string> {
		const c = this.requireClient();
		const { sanitizeImageForUpload } = await import("@/lib/imageSanitize");
		const sanitized = await sanitizeImageForUpload(file);
		const upload = await c.uploadContent(sanitized, {
			name: sanitized.name,
			type: sanitized.type,
		} as Parameters<typeof c.uploadContent>[1]);
		return upload.content_uri as string;
	}

	async uploadAndSendAttachment(
		roomId: RoomId,
		fileIn: File,
		caption?: string,
	): Promise<EventId> {
		const c = this.requireClient();
		const room = c.getRoom(roomId);
		const isEncrypted = !!room && (room as any).hasEncryptionStateEvent?.() === true;

		// Sanitise images BEFORE we read the rest of the metadata so
		// every downstream computation (msgtype, mimetype, byte size,
		// dimensions, encrypted-attachment ciphertext) reflects the
		// version that will actually hit the wire.  HEIC inputs come
		// out as PNG; static JPEG/PNG come out re-encoded with EXIF
		// stripped; everything else passes through unchanged.  See
		// imageSanitize.ts for the full policy + skip list.
		const { sanitizeImageForUpload } = await import("@/lib/imageSanitize");
		const file = await sanitizeImageForUpload(fileIn);

		const msgtype =
			file.type.startsWith("image/") ? "m.image" :
			file.type.startsWith("video/") ? "m.video" :
			file.type.startsWith("audio/") ? "m.audio" : "m.file";

		// Image dimensions: load into a hidden Image to read width/height.
		// Best-effort — failures here are swallowed since omitting w/h
		// just means the receiver doesn't know the natural size up front.
		const info: Record<string, unknown> = {
			mimetype: file.type || "application/octet-stream",
			size: file.size,
		};
		if (msgtype === "m.image") {
			try {
				const dims = await readImageDimensions(file);
				if (dims) { info.w = dims.width; info.h = dims.height; }
			} catch { /* dimensions are optional */ }
		}

		// For videos: extract a poster frame, capture dimensions /
		// duration, and prepare a thumbnail blob to upload alongside
		// the video.  All best-effort — a failed extraction (codec
		// unsupported, decoder OOM, browser refused the source) just
		// means the receiver falls back to the same broken
		// `preload="metadata"` poster the sender's composer was
		// living with before this fix.  See videoThumbnail.ts for
		// the rationale on doing this client-side.
		let videoThumb: { blob: Blob; width: number; height: number; objectUrl: string } | null = null;
		if (msgtype === "m.video") {
			try {
				const { extractVideoThumbnail } = await import("@/lib/videoThumbnail");
				const t = await extractVideoThumbnail(file);
				if (t) {
					info.w = t.width;
					info.h = t.height;
					info.duration = t.durationMs;
					videoThumb = { blob: t.blob, width: t.width, height: t.height, objectUrl: t.objectUrl };
				}
			} catch (err) {
				console.warn("uploadAndSendAttachment: video thumbnail extraction failed", err);
			}
		}

		// MSC2530 caption form: when the user typed text alongside the
		// attachment, `body` carries the caption and `filename` carries
		// the real filename.  Receivers that know MSC2530 surface the
		// caption underneath the media; older clients just see body
		// (caption) as the message text — better fallback than showing
		// a raw IMG_1234.jpg.  Without a caption we keep the legacy
		// shape (body == filename, no `filename` field).
		const trimmedCaption = caption?.trim();
		const body = trimmedCaption || file.name;
		const includeFilename = !!trimmedCaption;

		// Upload the video poster (if we extracted one) BEFORE the main
		// file so we can stamp the thumbnail mxc into `info` before
		// the event is sent.  Encryption mode matches the parent
		// event — encrypted rooms get an encrypted thumbnail
		// (info.thumbnail_file); plaintext rooms get info.thumbnail_url.
		// Failures are non-fatal: the main upload still goes through,
		// receivers fall back to render-time decode of the video itself.
		if (videoThumb) {
			try {
				const thumbInfoBase = {
					mimetype: "image/jpeg",
					size: videoThumb.blob.size,
					w: videoThumb.width,
					h: videoThumb.height,
				};
				if (isEncrypted) {
					const tBuffer = await videoThumb.blob.arrayBuffer();
					const { encryptAttachment } = await import("matrix-encrypt-attachment");
					const { data: tData, info: tEncInfo } = await encryptAttachment(tBuffer);
					const tUpload = await c.uploadContent(new Blob([tData]), {
						name: `${file.name}.thumb.jpg`,
						type: "application/octet-stream",
					} as any);
					info.thumbnail_file = { ...tEncInfo, url: tUpload.content_uri };
				} else {
					const tUpload = await c.uploadContent(videoThumb.blob, {
						name: `${file.name}.thumb.jpg`,
						type: "image/jpeg",
					} as any);
					info.thumbnail_url = tUpload.content_uri;
				}
				info.thumbnail_info = thumbInfoBase;
			} catch (err) {
				console.warn("uploadAndSendAttachment: thumbnail upload failed", err);
			} finally {
				URL.revokeObjectURL(videoThumb.objectUrl);
			}
		}

		let content: Record<string, unknown>;
		if (isEncrypted) {
			// Encrypt → upload ciphertext → send event with `file:` blob.
			const buffer = await file.arrayBuffer();
			const { encryptAttachment } = await import("matrix-encrypt-attachment");
			const { data, info: encInfo } = await encryptAttachment(buffer);
			const upload = await c.uploadContent(new Blob([data]), {
				name: file.name,
				type: "application/octet-stream",
			} as any);
			content = {
				msgtype,
				body,
				info,
				file: { ...encInfo, url: upload.content_uri },
			};
		} else {
			// Plain: upload directly with the real mime type, send `url`.
			const upload = await c.uploadContent(file, {
				name: file.name,
				type: file.type,
			} as any);
			content = {
				msgtype,
				body,
				info,
				url: upload.content_uri,
			};
		}
		if (includeFilename) content.filename = file.name;

		const res = await c.sendEvent(roomId, "m.room.message" as any, content as any);
		return res.event_id as EventId;
	}

	/** Send a custom (non-`m.room.message`) event to a room.  Used
	 * by the call-ringing system: the caller fires
	 * `chat.koven.call.ring` after joining a DM call, and the
	 * recipient listens for it via the timeline.  Cancel + decline
	 * events use the same path.  Returns the event id so the
	 * caller can reference it later (e.g. cancel referencing the
	 * ring's eventId so the recipient knows which ring to dismiss). */
	async sendCustomEvent(
		roomId: RoomId,
		eventType: string,
		content: Record<string, unknown>,
	): Promise<EventId> {
		const c = this.requireClient();
		const res = await c.sendEvent(roomId, eventType as any, content as any);
		return res.event_id as EventId;
	}

	/** Subscribe to live timeline events of a given type across all
	 *  joined rooms.  Used by the ring listener (which watches for
	 *  `chat.koven.call.ring` / `cancel` / `decline` in any DM).
	 *  Returns an unsubscribe function for the React effect cleanup
	 *  pattern.
	 *
	 *  Only fires for LIVE events (not backfill / pagination /
	 *  redactions), and ignores events the user themselves sent
	 *  (no echo).  Encrypted events that haven't yet been
	 *  decrypted are skipped — the caller would re-read them via
	 *  the matching MatrixEvent.Decrypted path if needed; for
	 *  call-ring purposes we just want the cleartext live ones. */
	onCallEvent(
		callback: (info: {
			roomId: RoomId;
			eventType: string;
			eventId: EventId;
			senderId: UserId;
			content: Record<string, unknown>;
			timestamp: number;
		}) => void,
	): () => void {
		const client = this.client;
		if (!client) return () => { /* no-op */ };
		const myUserId = this.creds?.user_id;
		const handler = (
			event: MatrixEvent,
			room: SdkRoom | undefined,
			toStartOfTimeline: boolean | undefined,
			removed: boolean,
			data: IRoomTimelineData,
		) => {
			if (!room || toStartOfTimeline || removed || !data?.liveEvent) return;
			const t = event.getType();
			if (!t.startsWith("chat.koven.call.")) return;
			const sender = event.getSender();
			if (!sender || sender === myUserId) return; // skip our own echoes
			const eventId = event.getId();
			if (!eventId) return;
			callback({
				roomId: room.roomId as RoomId,
				eventType: t,
				eventId: eventId as EventId,
				senderId: sender as UserId,
				content: (event.getContent() as Record<string, unknown>) ?? {},
				timestamp: event.getTs(),
			});
		};
		client.on(RoomEvent.Timeline, handler);
		return () => {
			try {
				client.off(RoomEvent.Timeline, handler);
			} catch {
				// SDK already torn down — fine.
			}
		};
	}

	/** Send a plain text message to a room. */
	async sendText(roomId: RoomId, body: string): Promise<EventId> {
		const c = this.requireClient();
		const res = await c.sendEvent(roomId, "m.room.message" as any, {
			msgtype: "m.text",
			body,
		} as any);
		return res.event_id as EventId;
	}

	/** Send a text message that replies to an existing one. */
	async replyTo(roomId: RoomId, targetEventId: EventId, body: string): Promise<EventId> {
		const c = this.requireClient();
		// Matrix replies need a "fallback" body that quotes the original
		// for clients that don't render the m.in_reply_to relation.  We
		// keep this minimal — full HTML formatting can come later.
		const res = await c.sendEvent(roomId, "m.room.message" as any, {
			msgtype: "m.text",
			body,
			"m.relates_to": {
				"m.in_reply_to": { event_id: targetEventId },
			},
		} as any);
		return res.event_id as EventId;
	}

	/** Send a new poll into a room.  Writes the stable MSC3381
	 * `m.poll.start` payload at the top level so spec-aware clients
	 * (Element, SchildiChat, Cinny) render it natively, and mirrors
	 * the same content under the unstable prefix for older clients
	 * that haven't migrated. */
	async sendPoll(
		roomId: RoomId,
		opts: {
			question: string;
			answers: string[];
			kind: "disclosed" | "undisclosed";
			maxSelections: number;
			/** Optional auto-close time (server-time ms).  Stored on the
			 * start event under our own namespace; clients treat the
			 * poll as ended after this timestamp even if no m.poll.end
			 * has landed yet. */
			endsAt?: number;
		},
	): Promise<EventId> {
		const c = this.requireClient();
		// Stable IDs for answer ids — Matrix recommends "ascii printable
		// without spaces."  Crypto-random keeps them collision-free
		// across federated participants.
		const answers = opts.answers
			.map((text) => text.trim())
			.filter((text) => text.length > 0)
			.map((text) => ({
				id: cryptoRandomId(),
				"m.text": text,
				"org.matrix.msc1767.text": text, // legacy fallback
			}));
		const pollContent: any = {
			question: {
				"m.text": opts.question,
				"org.matrix.msc1767.text": opts.question,
			},
			kind: opts.kind === "undisclosed" ? "m.poll.undisclosed" : "m.poll.disclosed",
			max_selections: Math.max(1, Math.min(answers.length, opts.maxSelections)),
			answers,
		};
		// Auto-close timestamp lives under our own namespace — MSC3381
		// doesn't define an expiry field, so spec-pure clients (Element)
		// just ignore it and treat the poll as no-limit.  Our clients
		// honour it: voting disables after `ends_at`, and the creator's
		// client auto-fires m.poll.end so the canonical end-event lands
		// for everyone.
		if (typeof opts.endsAt === "number" && Number.isFinite(opts.endsAt)) {
			pollContent["chat.koven.poll.ends_at"] = opts.endsAt;
		}
		// Body fallback for clients that don't render polls — they see
		// the question as a plain text message.  Element does this too.
		const fallbackBody = `${opts.question}\n${opts.answers.map((a, i) => `${i + 1}. ${a}`).join("\n")}`;
		const res = await c.sendEvent(roomId, "m.poll.start" as any, {
			"m.poll.start": pollContent,
			"org.matrix.msc3381.poll.start": pollContent,
			body: fallbackBody,
			"m.text": fallbackBody,
		} as any);
		return res.event_id as EventId;
	}

	/** Cast or change a vote.  Sending a fresh response from the same
	 * voter automatically supersedes the previous one per spec; we
	 * don't redact the old response. */
	async voteOnPoll(
		roomId: RoomId,
		pollEventId: EventId,
		answerIds: string[],
	): Promise<EventId> {
		const c = this.requireClient();
		const responseContent = { answers: answerIds };
		const res = await c.sendEvent(roomId, "m.poll.response" as any, {
			"m.relates_to": {
				rel_type: "m.reference",
				event_id: pollEventId,
			},
			"m.poll.response": responseContent,
			"org.matrix.msc3381.poll.response": responseContent,
		} as any);
		return res.event_id as EventId;
	}

	/** Close a poll (creator-only by spec; we don't enforce that
	 * client-side, the receiver checks the sender against the poll
	 * start's sender). */
	async endPoll(roomId: RoomId, pollEventId: EventId): Promise<EventId> {
		const c = this.requireClient();
		const endText = "The poll has ended.";
		const res = await c.sendEvent(roomId, "m.poll.end" as any, {
			"m.relates_to": {
				rel_type: "m.reference",
				event_id: pollEventId,
			},
			"m.poll.end": {},
			"org.matrix.msc3381.poll.end": {},
			body: endText,
			"m.text": endText,
		} as any);
		return res.event_id as EventId;
	}

	/** Add an emoji reaction to a message. */
	async react(roomId: RoomId, targetEventId: EventId, key: string): Promise<EventId> {
		const c = this.requireClient();
		const res = await c.sendEvent(roomId, "m.reaction" as any, {
			"m.relates_to": {
				rel_type: "m.annotation",
				event_id: targetEventId,
				key,
			},
		} as any);
		return res.event_id as EventId;
	}

	/** Remove a reaction by redacting its event. */
	async unreact(roomId: RoomId, reactionEventId: EventId): Promise<void> {
		const c = this.requireClient();
		await c.redactEvent(roomId, reactionEventId);
	}

	/** Create a new room.  Returns the new room id.
	 *
	 * Discord-style invariant: every group room MUST belong to a
	 * space.  Orphan rooms are forbidden (the engine has its own
	 * defence for federated cases; this is the client-side gate).
	 * DMs use `createDm` instead of this method, so they bypass the
	 * gate naturally.  Calling without a parentSpaceId throws.
	 */
	async createRoom(opts: {
		name: string;
		topic?: string;
		// REQUIRED.  The new room is added as a child of this space
		// immediately after creation (m.space.child on the space +
		// m.space.parent on the room).  Visibility + NSFW +
		// ENCRYPTION are NOT passed in — they're all read from the
		// parent space's state at create time so a room can never
		// drift out of sync with its space's posture.
		//   public space          → public, unencrypted room
		//   private space         → restricted-join (in-space) room
		//   private + e2ee space  → encrypted private room
		//   NSFW space            → chat.koven.nsfw on the room
		// Per-room toggles were removed deliberately: mixing
		// encrypted + unencrypted rooms inside one space produced a
		// confusing moderation surface (some rooms flag-able, some
		// not) that was hard to communicate to users.
		parentSpaceId: SpaceId;
		// Whether the new room exposes a Live channel (voice /
		// video / screen-share bar).  Stamped at create time as
		// `chat.koven.live` state event with `{ enabled: bool }`;
		// readers (RoomVoiceBar / ChatPane) default to ENABLED when
		// the state event is missing.  Pass `false` here to start
		// the room with calls turned off; omit (or `true`) to leave
		// the default-on behavior.  The creator can flip the flag
		// later via RoomEditSheet.
		liveEnabled?: boolean;
		// Optional emoji icon for the room — stamped at create time
		// as the `chat.koven.room_icon` state event, same as
		// RoomEditSheet's iconEmoji path.  Trimmed and capped at
		// 16 chars so a malformed paste can't dump an essay into
		// the state event.  Empty / missing → no icon, MatrixAvatar
		// falls back to the generated tile or uploaded image.
		iconEmoji?: string;
		// Optional avatar uploaded + set as the room's m.room.avatar
		// state event after creation.  Best-effort; failure doesn't
		// roll back the room.
		avatarFile?: File;
	}): Promise<RoomId> {
		const c = this.requireClient();
		// Discord-style: a non-DM room MUST live inside a space.  The
		// UI never opens CreateRoomSheet without a space context, but
		// belt-and-suspenders — any API caller that forgets falls
		// through to this guard rather than producing an orphan room
		// that's invisible to the rest of the app.
		if (!opts.parentSpaceId) {
			throw new Error("Rooms must be created inside a space. Use createDm for 1:1 conversations.");
		}
		// Inherit privacy + NSFW from the parent space.  Reading the
		// space's state at create time keeps the two in lockstep
		// without baking a secondary state machine on the room side.
		// Defaults to public + not-nsfw if the space's state isn't
		// resolvable client-side (extremely rare; the user is in the
		// space they're creating in, so currentState is populated).
		const spaceRoom = c.getRoom(opts.parentSpaceId);
		const spaceJoinRule = (spaceRoom?.currentState
			.getStateEvents("m.room.join_rules", "")
			?.getContent() as { join_rule?: string } | undefined)?.join_rule;
		const inheritedVisibility: "public" | "private" =
			spaceJoinRule === "public" ? "public" : "private";
		const inheritedNsfw =
			(spaceRoom?.currentState
				.getStateEvents("chat.koven.nsfw", "")
				?.getContent() as { enabled?: boolean } | undefined)?.enabled === true;
		// Encryption is inherited from the parent space's
		// chat.koven.space.config state event.  The room create
		// dialog no longer exposes a per-room toggle: encryption
		// is a space-level decision and every child room shares
		// the same posture.  e2ee_required can only be set on
		// private spaces (see createSpace), so an e2ee_required
		// space is necessarily private — no public + encrypted
		// risk to guard against here.
		const spaceConfig = spaceRoom?.currentState
			.getStateEvents("chat.koven.space.config", "")
			?.getContent() as { e2ee_required?: boolean } | undefined;
		const encrypted = spaceConfig?.e2ee_required === true;
		const initialState: any[] = [];
		if (encrypted) {
			initialState.push({
				type: "m.room.encryption",
				state_key: "",
				content: { algorithm: "m.megolm.v1.aes-sha2" },
			});
		}
		// m.space.parent + (for private spaces) restricted join rule.
		// Belt-and-suspenders alongside the engine's force-join cascade:
		// the engine pulls every local member of the parent space into
		// this new room when it sees the m.space.child event below
		// (see engine/src/server.ts), but the restricted rule also
		// lets anyone in the parent space join on their own from
		// federated servers or from clients that connect later.
		initialState.push({
			type: "m.space.parent",
			state_key: opts.parentSpaceId,
			content: { canonical: true, via: [this.serverName()] },
		});
		if (inheritedVisibility === "private") {
			initialState.push({
				type: "m.room.join_rules",
				state_key: "",
				content: {
					join_rule: "restricted",
					allow: [{
						type: "m.room_membership",
						room_id: opts.parentSpaceId,
					}],
				},
			});
		}
		// Inherit NSFW from the parent space.  Stamping at create
		// time keeps Explore + the join cascade consistent with the
		// space's posture, so a single NSFW space can never accidentally
		// host a non-NSFW room (or vice versa).
		if (inheritedNsfw) {
			initialState.push({
				type: "chat.koven.nsfw",
				state_key: "",
				content: { enabled: true },
			});
		}
		// Live-channel toggle.  Only stamp the state event when the
		// caller wants something OTHER than the default-on behavior
		// — `chat.koven.live` missing IS "Live enabled" per the
		// readKovenLiveEnabled fallback.  Writing the event only
		// when explicitly disabled keeps room state lean for the
		// 99% case where Live is on.
		if (opts.liveEnabled === false) {
			initialState.push({
				type: "chat.koven.live",
				state_key: "",
				content: { enabled: false },
			});
		}
		// Room icon emoji.  Same chat.koven.room_icon state event
		// the edit-room flow writes; stamping at create time so a
		// fresh room can land with a chosen emoji in one round trip
		// instead of needing a follow-up state-event call.
		const iconEmojiTrimmed = opts.iconEmoji?.trim().slice(0, 16);
		if (iconEmojiTrimmed) {
			initialState.push({
				type: "chat.koven.room_icon",
				state_key: "",
				content: { emoji: iconEmojiTrimmed },
			});
		}
		// IMPORTANT: don't pass the full inviteList as the `invite`
		// param — Synapse caps it at `rc_invites_per_room.burst_count`
		// (default 10), and exceeding that fails the entire createRoom
		// call with "Cannot invite so many users at once".  In a 14+
		// member space, that means a single oversized invite array
		// blocks room creation entirely.
		//
		// Two-phase instead: createRoom with NO invites (the room is
		// born minimal), then fan out invites serially via /invite
		// after the fact (see post-create block below).  The room is
		// still discoverable via the space's m.space.child link
		// `linkRoomToSpace` writes a few lines down, so space members
		// who haven't been individually invited yet can still find
		// and join via the space's room list while the invites
		// trickle in.
		// Koven PL scheme — two tiers only: creator (PL 100) and
		// everyone else (PL 0).  All administrative actions require
		// the creator; chat AND invites are open to every member.
		// Content moderation goes through the engine's flag /
		// consensus / collapse pipeline, not Matrix redactions / kicks.
		//
		// Passed via `power_level_content_override` so Synapse writes
		// the PL state event as part of room creation, atomically.
		// (Earlier code sent a follow-up sendStateEvent which could
		// fail silently — leaving the room with whatever Synapse's
		// default was for the room version, e.g. invite=50 on older
		// versions, which then 403'd regular members trying to invite.)
		const myUserIdStr = c.getUserId()!;
		const powerLevelContentOverride = {
			users: { [myUserIdStr]: 100 },
			users_default: 0,
			events: {
				"m.room.name": 100,
				"m.room.power_levels": 100,
				"m.room.history_visibility": 100,
				"m.room.canonical_alias": 100,
				"m.room.avatar": 100,
				"m.room.topic": 100,
				"m.room.tombstone": 100,
				"m.room.server_acl": 100,
				"m.room.encryption": 100,
				"m.room.join_rules": 100,
			},
			state_default: 100,
			kick: 100,
			ban: 100,
			redact: 100,
			// Invites: open to all members regardless of room
			// visibility.  "Private" controls who can JOIN without
			// an invitation — not who can issue invitations.
			invite: 0,
			events_default: 0,
		};
		const res = await c.createRoom({
			name: opts.name,
			topic: opts.topic,
			visibility: inheritedVisibility as any,
			preset: (inheritedVisibility === "public" ? "public_chat" : "private_chat") as any,
			initial_state: initialState.length ? initialState : undefined,
			power_level_content_override: powerLevelContentOverride as any,
		});
		const newRoomId = res.room_id as RoomId;

		if (opts.avatarFile) {
			// Mirror of createSpace's avatar path: upload the bytes,
			// then write m.room.avatar pointing at the resulting mxc.
			// Best-effort — a failure here just leaves the room
			// without an avatar (the founder can re-upload from
			// RoomEditSheet).  Don't fail the create over it.
			try {
				const mxc = await this.uploadAvatarImage(opts.avatarFile);
				await c.sendStateEvent(newRoomId, "m.room.avatar" as Parameters<typeof c.sendStateEvent>[1], {
					url: mxc,
				}, "");
			} catch (err) {
				console.warn("createRoom: avatar upload failed", err);
			}
		}

		await this.linkRoomToSpace(opts.parentSpaceId, newRoomId, { nsfw: inheritedNsfw }).catch(err => {
			console.warn("createRoom: failed to link to parent space", err);
		});
		this.emitRoomList();
		this.emitSpaceList();

		// NOTE: no client-side fan-out of space-member invites.
		// linkRoomToSpace (above) wrote an m.space.child state event
		// on the parent space; the engine receives that via its
		// appservice /transactions stream and force-joins every local
		// member of the space to the new child room (see
		// engine/src/server.ts: "Discord-style: when an admin links
		// a room into a space, force-join every local member").
		// That auto-join cascade is rate-limit-aware and works even
		// if the client that created the room disconnects right
		// after.  Trying to invite from here in addition would just
		// race the engine's joins and produce a flurry of "user
		// already in room" errors.

		return newRoomId;
	}

	/** Create a Matrix space (a room with type m.space). */
	async createSpace(opts: {
		name: string;
		topic?: string;
		visibility: "public" | "private";
		avatarFile?: File;          // uploaded + set as space avatar after create
		// Mark the new space as adult-content via the
		// `chat.koven.nsfw` state event.  Same one-way semantics as
		// rooms: once set, it stays set — members joined under the
		// "this is NSFW" assumption can't be quietly un-flagged.
		nsfw?: boolean;
		// Require every child room of this space to be E2EE +
		// private.  Locks the space into "trusted-group" mode:
		// child rooms can't be public, can't be unencrypted,
		// can't be moderated by the engine.  Set once at create
		// time via the `chat.koven.space.config` state event;
		// never undone.  Only valid when `visibility` is
		// "private" — encrypted public rooms are forbidden by
		// governance, so an encrypted space implies private.
		e2eeRequired?: boolean;
		// Optional emoji icon — same `chat.koven.room_icon` state
		// event the room create flow writes.  Stamped after create
		// so the space lands with the chosen emoji in one round
		// trip rather than needing a follow-up updateSpace call.
		iconEmoji?: string;
	}): Promise<SpaceId> {
		const c = this.requireClient();

		// Koven power-level model: two tiers, creator (PL 100) and
		// everyone else (PL 0).  No moderators — content moderation
		// is the community's job via the flag / consensus / collapse
		// pipeline in the engine, not a privileged-user role at the
		// Matrix layer.  Synapse's default scheme assumes a PL-50
		// moderator tier; we override so administrative state needs
		// the creator while invites + chat stay open to all members.
		//
		// Passed via `power_level_content_override` so the PL state
		// event is part of room creation, atomic with the create.
		// (The earlier follow-up sendStateEvent could fail silently
		// — leaving us with Synapse's defaults, e.g. invite=50, which
		// then 403'd regular members trying to invite.)
		const myUserIdStr = c.getUserId()!;
		const powerLevelContentOverride = {
			users: { [myUserIdStr]: 100 },
			users_default: 0,
			events: {
				"m.room.name": 100,
				"m.room.power_levels": 100,
				"m.room.history_visibility": 100,
				"m.room.canonical_alias": 100,
				"m.room.avatar": 100,
				"m.room.topic": 100,
				"m.room.tombstone": 100,
				"m.room.server_acl": 100,
				"m.room.encryption": 100,
				"m.room.join_rules": 100,
				// Hierarchy: only the creator decides what rooms are
				// inside this space.
				"m.space.child": 100,
			},
			state_default: 100,
			kick: 100,
			ban: 100,
			redact: 100,
			invite: 0,
			events_default: 0,
		};
		const res = await c.createRoom({
			name: opts.name,
			topic: opts.topic,
			visibility: opts.visibility as any,
			preset: (opts.visibility === "public" ? "public_chat" : "private_chat") as any,
			creation_content: { type: "m.space" } as any,
			power_level_content_override: powerLevelContentOverride as any,
		});
		const spaceId = res.room_id as SpaceId;
		if (opts.avatarFile) {
			try {
				const mxc = await this.uploadAvatarImage(opts.avatarFile);
				await c.sendStateEvent(spaceId, "m.room.avatar" as any, {
					url: mxc,
				}, "");
			} catch (err) {
				// Avatar set is best-effort — we don't want to fail the
				// whole creation flow if the upload hits an error.
				console.warn("createSpace: avatar upload failed", err);
			}
		}
		if (opts.nsfw) {
			// Best-effort: a failure here just leaves the space
			// unflagged.  The creator can re-mark via space settings;
			// we don't fail the whole creation flow on a state-event
			// hiccup.  Mirror of the createRoom NSFW path.
			try {
				await c.sendStateEvent(
					spaceId,
					"chat.koven.nsfw" as any,
					{ enabled: true },
					"",
				);
			} catch (err) {
				console.warn("createSpace: failed to set nsfw flag", err);
			}
		}
		// Optional emoji icon — same chat.koven.room_icon state
		// event that powers room emojis, just on a space's m.space-
		// typed room.  Best-effort: a failure leaves the space
		// without an emoji and the user can re-set it from
		// SpaceEditSheet.
		const spaceIconEmoji = opts.iconEmoji?.trim().slice(0, 16);
		if (spaceIconEmoji) {
			try {
				await c.sendStateEvent(
					spaceId,
					"chat.koven.room_icon" as any,
					{ emoji: spaceIconEmoji },
					"",
				);
			} catch (err) {
				console.warn("createSpace: failed to set emoji", err);
			}
		}
		// E2EE-required policy: write the space-config state event.
		// Guarded by the visibility check at the SPA-create-dialog
		// layer (UI only enables the toggle for private spaces) AND
		// here, in case any future caller forgets — a public + e2ee
		// space would land child rooms in the public+encrypted state
		// that governance forbids.
		if (opts.e2eeRequired && opts.visibility === "private") {
			try {
				await c.sendStateEvent(
					spaceId,
					"chat.koven.space.config" as any,
					{ e2ee_required: true },
					"",
				);
			} catch (err) {
				// Loud-warn rather than silent: a missed config event
				// means child rooms will NOT be forced to E2EE, which
				// silently breaks the creator's expectation.  The
				// creator can re-apply the policy via space settings
				// (when that UI exists) — until then, this log is the
				// audit trail.
				console.error("createSpace: failed to set e2ee_required flag", err);
			}
		}
		this.emitSpaceList();
		return spaceId;
	}

	/**
	 * Search the homeserver's user directory.  Returns matches the
	 * current user is allowed to discover — typically anyone who shares
	 * a room with them, plus globally-discoverable accounts.
	 */
	async searchUsers(query: string, limit = 10): Promise<{
		userId: UserId;
		displayName?: string;
		avatarUrl?: string;
	}[]> {
		const c = this.requireClient();
		if (!query.trim()) return [];
		const res = await c.searchUserDirectory({ term: query.trim(), limit }) as any;
		const results = (res?.results ?? []) as Array<{
			user_id: string;
			display_name?: string;
			avatar_url?: string;
		}>;
		return results.map(r => ({
			userId: r.user_id as UserId,
			displayName: r.display_name,
			avatarUrl: r.avatar_url,
		}));
	}

	/**
	 * Start a direct message with another user.  Creates an invite-only
	 * room with both members, marks it `is_direct` per the Matrix spec,
	 * and registers it under the current user's `m.direct` account_data
	 * so it shows up under the DMs tile rather than as an orphan room.
	 *
	 * If a DM with this user already exists, the existing room id is
	 * returned instead of creating a duplicate.
	 */
	async startDm(targetUserId: UserId): Promise<RoomId> {
		const c = this.requireClient();
		// Check for an existing DM first.  m.direct is a map of
		// user_id → room_ids the current user has open with that person.
		// Naively returning the first id breaks when the other side has
		// since left+forgotten the room (their delete-DM gesture):
		// Matrix has no way to mutate their account data from our side,
		// so our m.direct keeps pointing at a corpse room while they
		// silently drop our messages.  Validate that the target user
		// still has live membership before reusing the room.
		const direct = (c.getAccountData("m.direct")?.getContent() ?? {}) as Record<string, string[]>;
		const candidates = Array.isArray(direct[targetUserId]) ? direct[targetUserId] : [];
		const stale: RoomId[] = [];
		for (const candidateId of candidates) {
			const room = c.getRoom(candidateId);
			if (!room) continue;                         // never synced — skip
			const member = room.getMember(targetUserId);
			const membership = member?.membership;
			if (membership === "join" || membership === "invite") {
				return candidateId as RoomId;
			}
			stale.push(candidateId as RoomId);
		}
		// Drop dead entries from our own m.direct so subsequent lookups
		// don't keep hitting them.  Best-effort — if account_data write
		// fails we still fall through to creating a fresh DM.
		if (stale.length > 0) {
			const next: Record<string, string[]> = { ...direct };
			const filtered = candidates.filter(id => !stale.includes(id as RoomId));
			if (filtered.length > 0) next[targetUserId] = filtered;
			else delete next[targetUserId];
			await c.setAccountData("m.direct" as any, next as any).catch(err => {
				console.warn("startDm: failed to prune stale m.direct entries", err);
			});
		}

		// DMs are end-to-end encrypted by default.  The 1-on-1 shape
		// means there's no quorum for the consensus moderation layer
		// to act on anyway, so the privacy tradeoff that's awkward in
		// group rooms is the right call here.  Crypto is initialized
		// in start() via initRustCrypto + the cryptoCallbacks bound to
		// SSSS, so by the time this runs the megolm session machinery
		// is up and sendEvent into the encrypted room works.
		const res = await c.createRoom({
			preset: "trusted_private_chat" as any,
			invite: [targetUserId],
			is_direct: true,
			visibility: "private" as any,
			initial_state: [{
				type: "m.room.encryption",
				state_key: "",
				content: { algorithm: "m.megolm.v1.aes-sha2" },
			}] as any,
		});
		const roomId = res.room_id as RoomId;

		// Update m.direct so this room is recognized as a DM by clients.
		const updated: Record<string, string[]> = { ...direct };
		updated[targetUserId] = [...(updated[targetUserId] ?? []), roomId];
		await c.setAccountData("m.direct" as any, updated as any).catch(err => {
			console.warn("startDm: setAccountData failed", err);
		});
		// Optimistic local mirror — see pendingDmMappings docstring.
		// The is_direct member-event fallback in sdkRoomToRoom also
		// covers the sender side, but adding it here too means
		// classification doesn't depend on Synapse stamping is_direct
		// onto the invitee's member event in time for the next emit.
		this.pendingDmMappings.set(roomId, targetUserId);
		this.emitRoomList();
		return roomId;
	}

	// transport.placeCall removed — DM calls go through the
	// RealtimeKit-backed CallProvider system now (see
	// RoomVoiceBar's Join button + lib/call-context.tsx).

	/**
	 * Browse the homeserver's public room directory.  Returns public
	 * spaces and rooms anyone with a homeserver account can discover
	 * and join.  Used by the Explore view; pure read, no client state
	 * mutation.
	 */
	async discoverPublicRooms(opts: { search?: string; limit?: number } = {}): Promise<{
		roomId: RoomId;
		name: string;
		topic?: string;
		avatarUrl?: string;
		memberCount: number;
		isSpace: boolean;
		joinRule: string;
	}[]> {
		const c = this.requireClient();
		const res = await c.publicRooms({
			limit: opts.limit ?? 50,
			filter: opts.search ? { generic_search_term: opts.search } : undefined,
		} as any);
		const chunk = (res.chunk ?? []) as Array<{
			room_id: string;
			name?: string;
			topic?: string;
			avatar_url?: string;
			num_joined_members?: number;
			room_type?: string;
			join_rule?: string;
		}>;
		return chunk.map(r => ({
			roomId: r.room_id as RoomId,
			name: r.name ?? r.room_id,
			topic: r.topic,
			avatarUrl: r.avatar_url,
			memberCount: r.num_joined_members ?? 0,
			isSpace: r.room_type === "m.space",
			joinRule: r.join_rule ?? "public",
		}));
	}

	/**
	 * Public-directory browse, partitioned the way the Explore UI wants
	 * to render it: spaces always show; rooms only show if they aren't
	 * a child of any space in the directory (those rooms surface through
	 * their parent space, not as orphans).
	 *
	 * Implementation: pull the flat directory, then for each public
	 * space ask Synapse for its hierarchy and aggregate every child
	 * room id into a Set.  Filter the rooms list against that Set.
	 * Hierarchy queries run in parallel and tolerate per-space failure
	 * — a missing hierarchy just means we leave that space's children
	 * showing alongside it (better than an empty Explore view).
	 */
	async discoverDirectory(opts: { search?: string; limit?: number } = {}): Promise<{
		spaces: Array<{
			roomId: RoomId; name: string; topic?: string;
			avatarUrl?: string; memberCount: number; joinRule: string;
			// Number of child rooms in the space (excludes the space
			// itself).  Hierarchy fetch failures fall back to 0; a "0
			// rooms" label is mildly misleading there but better than
			// blocking the whole directory render.
			roomCount: number;
		}>;
		soloRooms: Array<{
			roomId: RoomId; name: string; topic?: string;
			avatarUrl?: string; memberCount: number; joinRule: string;
		}>;
	}> {
		const c = this.requireClient();
		const all = await this.discoverPublicRooms(opts);
		const spaceEntries = all.filter(e => e.isSpace);
		const roomEntries = all.filter(e => !e.isSpace);

		// Per-space hierarchy fetch.  Builds two outputs in one pass:
		//   1. The set of room ids belonging to any space (used to
		//      exclude them from the orphan-rooms list)
		//   2. A per-space child count for the directory row label.
		const childIds = new Set<string>();
		const childCount = new Map<string, number>();
		await Promise.all(spaceEntries.map(async (sp) => {
			try {
				// depth=2 covers the typical "space → rooms" structure;
				// nested-space children are handled when their parent
				// surfaces in the directory and we walk it separately.
				const h = await c.getRoomHierarchy(sp.roomId, 100, 2, false);
				let count = 0;
				for (const child of (h.rooms ?? []) as Array<{ room_id: string; room_type?: string }>) {
					if (child.room_id === sp.roomId) continue;
					childIds.add(child.room_id);
					// Don't count nested sub-spaces toward the room count
					// — "rooms" should mean leaf rooms, not other spaces.
					if (child.room_type !== "m.space") count++;
				}
				childCount.set(sp.roomId, count);
			} catch (err) {
				console.warn(`discoverDirectory: hierarchy fetch failed for ${sp.roomId}`, err);
				childCount.set(sp.roomId, 0);
			}
		}));

		return {
			spaces: spaceEntries.map(({ isSpace: _isSpace, ...rest }) => ({
				...rest,
				roomCount: childCount.get(rest.roomId) ?? 0,
			})),
			soloRooms: roomEntries
				.filter(r => !childIds.has(r.roomId))
				.map(({ isSpace: _isSpace, ...rest }) => rest),
		};
	}

	/** Join a room or space by id (or alias).  Idempotent. */
	async joinRoomById(roomIdOrAlias: string): Promise<RoomId> {
		const c = this.requireClient();
		const room = await c.joinRoom(roomIdOrAlias);
		this.emitRoomList();
		this.emitSpaceList();
		return room.roomId as RoomId;
	}

	/**
	 * Best-effort preview of a room or space the user may not yet be a
	 * member of.  Used by the deep-link "Join this {space|room}?"
	 * confirmation card to show the target's name, avatar, member
	 * count, and NSFW flag before the user commits to joining.
	 *
	 * Three sources, tried in order:
	 *   1. A local Room object — when the user was Matrix-invited
	 *      first, the SDK already has the room with name + avatar +
	 *      member list populated.
	 *   2. MSC3266 `getRoomSummary` — Synapse-supported preview API
	 *      that works for any room the local server can see (public
	 *      rooms anywhere, plus invited rooms).
	 *   3. Null — we have nothing.  The caller falls back to showing
	 *      just the id.  Private rooms on remote servers we can't see
	 *      into land here; the user has to join blind.
	 *
	 * The third path is rare in practice: a share link minted on a
	 * Koven instance points at a room ON THAT INSTANCE, and Synapse
	 * always returns summaries for its own rooms.  We'd hit the null
	 * case only for cross-instance / federated invites the local
	 * server hasn't synced state for yet.
	 */
	async previewTarget(idOrAlias: string): Promise<{
		roomId: RoomId;
		name: string;
		topic?: string;
		avatarUrl?: string;
		memberCount?: number;
		isSpace: boolean;
		// NSFW from chat.koven.nsfw — only readable from a local
		// Room (case 1).  getRoomSummary doesn't surface custom
		// state events, so MSC3266-only previews have nsfw=undefined.
		// The caller treats undefined as "unknown, fall back to no-
		// warn"; if the room turns out to be NSFW after join the
		// space-children NSFW gate catches it.
		nsfw?: boolean;
	} | null> {
		const c = this.requireClient();
		// Path 1 — Room is already in the SDK store (invited / partial
		// join / previously left + remembered).  Cheapest path; reads
		// directly from local state, no network.
		const local = c.getRoom(idOrAlias);
		if (local) {
			const create = local.currentState.getStateEvents("m.room.create", "");
			const isSpace = create?.getContent()?.type === "m.space";
			return {
				roomId: local.roomId as RoomId,
				name: local.name || local.roomId,
				topic: local.currentState.getStateEvents("m.room.topic", "")?.getContent().topic,
				avatarUrl: local.getMxcAvatarUrl() ?? undefined,
				memberCount: local.getJoinedMemberCount(),
				isSpace,
				nsfw: readKovenNsfw(local),
			};
		}
		// Path 2 — MSC3266 summary.  Synapse implements this; matrix-
		// js-sdk wraps it as `getRoomSummary`.  Errors fall through
		// (some servers / cross-instance scenarios don't support it).
		try {
			const summary = await c.getRoomSummary(idOrAlias);
			return {
				roomId: (summary.room_id ?? idOrAlias) as RoomId,
				name: summary.name ?? idOrAlias,
				topic: summary.topic,
				avatarUrl: summary.avatar_url ?? undefined,
				memberCount: summary.num_joined_members,
				isSpace: summary.room_type === "m.space",
				// No NSFW signal from MSC3266 — leave undefined.
			};
		} catch (err) {
			console.warn("previewTarget: getRoomSummary failed", err);
			return null;
		}
	}

	/**
	 * Join a space along with every public/joinable child room it
	 * declares — Discord-style "join the server, get all channels".
	 * Uses Matrix's hierarchy API (MSC2946) to enumerate children
	 * recursively.  Per-child failures are ignored: invite-only or
	 * banned children just stay un-joined, the rest succeed.  Returns
	 * { spaceId, joinedChildren } for the caller to surface counts.
	 */
	async joinSpaceWithChildren(spaceIdOrAlias: string): Promise<{
		spaceId: SpaceId;
		joinedChildren: number;
		skippedChildren: number;
		// True iff there were one-or-more NSFW children we declined
		// to auto-join because the viewer hasn't opted into NSFW.  The
		// caller (App.tsx) uses this to surface a follow-up "this
		// space contains NSFW rooms — enable to see them?" prompt.
		skippedNsfwChildren: number;
	}> {
		const c = this.requireClient();
		const root = await c.joinRoom(spaceIdOrAlias);
		const spaceId = root.roomId as SpaceId;
		const nsfwPref = this.getNsfwPreference();

		// Read the parent's m.space.child events directly — Koven
		// linkRoomToSpace mirrors the child's NSFW flag onto the
		// content there, so we can decide pre-join whether to skip
		// each child without having to peek/join it first.  Falls
		// back to "assume not NSFW" for events written by older
		// clients that didn't include the field.
		const childNsfwById = new Map<string, boolean>();
		try {
			const events = root.currentState.getStateEvents("m.space.child") ?? [];
			for (const ev of events) {
				const stateKey = ev.getStateKey();
				if (!stateKey) continue;
				const content = ev.getContent() as { nsfw?: unknown };
				childNsfwById.set(stateKey, content.nsfw === true);
			}
		} catch (err) {
			console.warn("joinSpaceWithChildren: failed to read m.space.child state", err);
		}

		let hierarchy;
		try {
			hierarchy = await c.getRoomHierarchy(spaceId, 50, 3, false);
		} catch (err) {
			console.warn("joinSpaceWithChildren: hierarchy fetch failed", err);
			this.emitRoomList();
			this.emitSpaceList();
			return { spaceId, joinedChildren: 0, skippedChildren: 0, skippedNsfwChildren: 0 };
		}

		const rooms = (hierarchy.rooms ?? []) as Array<{
			room_id: string;
			room_type?: string;
			join_rule?: string;
		}>;

		// Best-effort parallel join of every joinable child.  Skip
		// the space itself + sub-spaces (let the user opt-in by
		// clicking them in Explore).  Discord-style invariant: every
		// room in the space should auto-join, so we accept "public",
		// "knock", AND "restricted" — restricted is the join rule we
		// stamp onto private-in-space rooms at create time, and it
		// resolves to "in the parent space → /join succeeds."
		// Anything else (invite-only, custom rules) is genuinely
		// unjoinable from here and gets skipped.  When the viewer
		// hasn't opted into NSFW, NSFW children skip too.
		let joined = 0;
		let skipped = 0;
		let skippedNsfw = 0;
		await Promise.all(rooms.map(async r => {
			if (r.room_id === spaceId) return;
			if (r.room_type === "m.space") { skipped++; return; }
			const rule = r.join_rule ?? "public";
			if (rule !== "public" && rule !== "knock" && rule !== "restricted") { skipped++; return; }
			if (!nsfwPref && childNsfwById.get(r.room_id) === true) {
				skippedNsfw++;
				return;
			}
			try {
				await c.joinRoom(r.room_id);
				joined++;
			} catch {
				skipped++;
			}
		}));

		// Post-join NSFW sweep — covers rooms whose m.space.child was
		// written by an older client (no nsfw field) but whose own
		// chat.koven.nsfw state is set.  Only runs when the viewer
		// hasn't opted into NSFW.  Auto-leave is jarring but the
		// alternative is silently joining users to adult content; we
		// surface a count so App.tsx can mention the leave in the
		// follow-up prompt.
		if (!nsfwPref) {
			for (const r of rooms) {
				if (r.room_id === spaceId) continue;
				const joinedRoom = c.getRoom(r.room_id);
				if (!joinedRoom) continue;
				if (joinedRoom.getMyMembership() !== "join") continue;
				if (!readKovenNsfw(joinedRoom)) continue;
				try {
					await c.leave(r.room_id);
					skippedNsfw++;
					joined = Math.max(0, joined - 1);
				} catch (err) {
					console.warn(`joinSpaceWithChildren: post-join NSFW leave for ${r.room_id} failed`, err);
				}
			}
		}

		this.emitRoomList();
		this.emitSpaceList();
		return { spaceId, joinedChildren: joined, skippedChildren: skipped, skippedNsfwChildren: skippedNsfw };
	}

	/**
	 * Edit an existing space's mutable fields.  Each piece is sent via
	 * the appropriate Matrix state event, which Synapse only accepts
	 * if the caller's power level meets the room's minimum (50+ by
	 * default).  Visibility flip updates BOTH the join_rule state event
	 * AND the public-directory listing — Synapse treats them as
	 * separate concepts.
	 */
	async updateSpace(opts: {
		spaceId: SpaceId;
		name?: string;
		topic?: string;
		avatarFile?: File;
		clearAvatar?: boolean;
		// Pass an emoji string to set/replace the room icon, "" to
		// clear it, or undefined to leave it as-is.  Stored as a
		// custom `chat.koven.room_icon` state event with `state_key=""`.
		iconEmoji?: string;
		visibility?: "public" | "private";
		// Mark/unmark the space as adult-content via the
		// `chat.koven.nsfw` state event.  true → write { enabled: true };
		// false → write {} (the canonical "cleared" form).  Undefined
		// leaves the state alone.
		nsfw?: boolean;
	}): Promise<void> {
		const c = this.requireClient();
		if (opts.name !== undefined) {
			await c.sendStateEvent(opts.spaceId, "m.room.name" as any, { name: opts.name }, "");
		}
		if (opts.topic !== undefined) {
			await c.sendStateEvent(opts.spaceId, "m.room.topic" as any, { topic: opts.topic }, "");
		}
		if (opts.avatarFile) {
			const mxc = await this.uploadAvatarImage(opts.avatarFile);
			await c.sendStateEvent(opts.spaceId, "m.room.avatar" as any, {
				url: mxc,
			}, "");
		} else if (opts.clearAvatar) {
			await c.sendStateEvent(opts.spaceId, "m.room.avatar" as any, {}, "");
		}
		if (opts.iconEmoji !== undefined) {
			const trimmed = opts.iconEmoji.trim().slice(0, 16);
			await c.sendStateEvent(
				opts.spaceId,
				"chat.koven.room_icon" as any,
				trimmed ? { emoji: trimmed } : {},
				"",
			);
		}
		if (opts.visibility !== undefined) {
			const rule = opts.visibility === "public" ? "public" : "invite";
			await c.sendStateEvent(opts.spaceId, "m.room.join_rules" as any, { join_rule: rule }, "");
			// Public directory listing is independent of join_rule —
			// flip it to match.  Best-effort: a failure here leaves
			// the join rule changed but the directory out of sync,
			// which we surface as a console warning.
			try {
				await c.setRoomDirectoryVisibility(opts.spaceId, opts.visibility as any);
			} catch (err) {
				console.warn("updateSpace: directory visibility update failed", err);
			}
		}
		if (opts.nsfw !== undefined) {
			// One-way: NSFW is permanent.  If the space is already
			// flagged, refuse to clear it client-side.  Members joined
			// under "this is NSFW" — quietly flipping it off would
			// strand them out-of-band.  Defense in depth; the UI also
			// hides the toggle once flagged.
			const room = c.getRoom(opts.spaceId);
			const currentNsfw = room?.currentState
				.getStateEvents("chat.koven.nsfw", "")
				?.getContent()?.enabled === true;
			if (currentNsfw && !opts.nsfw) {
				throw new Error("NSFW marker is permanent and can't be reversed.");
			}
			if (opts.nsfw) {
				await c.sendStateEvent(
					opts.spaceId,
					"chat.koven.nsfw" as any,
					{ enabled: true },
					"",
				);
			}
		}
		this.emitSpaceList();
	}

	/**
	 * Edit an existing room's mutable fields.  Mirrors `updateSpace` —
	 * the underlying state events are identical between rooms and
	 * spaces — but kept distinct so future room-only knobs (encryption,
	 * history visibility, retention) have a natural home without
	 * polluting the space surface.  As with spaces, Synapse rejects
	 * each state event unless the caller's PL meets the room's minimum.
	 */
	async updateRoom(opts: {
		roomId: RoomId;
		name?: string;
		topic?: string;
		avatarFile?: File;
		clearAvatar?: boolean;
		// See updateSpace.iconEmoji — same semantics, same state event.
		iconEmoji?: string;
		// Per-room "Live channel" toggle.  Writes the
		// `chat.koven.live` state event with `{ enabled: bool }`;
		// absent state event = enabled (the default).
		liveEnabled?: boolean;
	}): Promise<void> {
		const c = this.requireClient();
		if (opts.name !== undefined) {
			await c.sendStateEvent(opts.roomId, "m.room.name" as any, { name: opts.name }, "");
		}
		if (opts.topic !== undefined) {
			await c.sendStateEvent(opts.roomId, "m.room.topic" as any, { topic: opts.topic }, "");
		}
		if (opts.avatarFile) {
			const mxc = await this.uploadAvatarImage(opts.avatarFile);
			await c.sendStateEvent(opts.roomId, "m.room.avatar" as any, {
				url: mxc,
			}, "");
		} else if (opts.clearAvatar) {
			await c.sendStateEvent(opts.roomId, "m.room.avatar" as any, {}, "");
		}
		if (opts.iconEmoji !== undefined) {
			const trimmed = opts.iconEmoji.trim().slice(0, 16);
			await c.sendStateEvent(
				opts.roomId,
				"chat.koven.room_icon" as any,
				trimmed ? { emoji: trimmed } : {},
				"",
			);
		}
		if (opts.liveEnabled !== undefined) {
			// Write the state event with the explicit bool.  The reader
			// treats a missing event as enabled, but we always write
			// once toggled so other clients see the intent rather than
			// inferring from absence.
			await c.sendStateEvent(
				opts.roomId,
				"chat.koven.live" as any,
				{ enabled: !!opts.liveEnabled },
				"",
			);
		}
		this.emitRoomList();
	}

	/**
	 * Add an existing room as a child of an existing space.  This is
	 * the symmetric "the channel exists, I want it in this server" gesture
	 * to createRoom-with-parentSpaceId (which creates a new room
	 * already filed under the space).
	 *
	 * Three things happen, all best-effort:
	 *
	 *   1. m.space.child on the space + m.space.parent on the room —
	 *      the canonical hierarchy.  Required.
	 *
	 *   2. If the room is private (join_rule != public), upgrade the
	 *      join_rule to `restricted` with the space as the allow
	 *      list.  Mirrors what createRoom does for new private rooms
	 *      in a space — anyone joined to the space can self-join the
	 *      room without an explicit invite, so members who weren't
	 *      around when we did the link can still walk in later.
	 *      Skipped for public rooms (already openly joinable).
	 *
	 *   3. Invite every current member of the space who isn't already
	 *      in the room.  This dispatches a notification to each one
	 *      and surfaces the room in their invite list immediately.
	 *      Combined with the auto-join-on-m.space.child listener
	 *      below, the experience is "I was in the server, suddenly
	 *      the new channel is just there in my sidebar."
	 *
	 * Per-step failures are logged and skipped — getting half the
	 * way there (state events written but invites refused due to PL)
	 * is better than rolling back the link entirely.
	 */
	async linkRoomToSpace(spaceId: SpaceId, roomId: RoomId, opts?: { nsfw?: boolean }): Promise<void> {
		const c = this.requireClient();
		const via = [this.serverName()];

		// 1. Canonical hierarchy state events.  Mirror the child's NSFW
		//    flag onto the m.space.child content so anyone reading the
		//    parent's state can decide whether to auto-join the child
		//    without having to peek/join it first.  Koven-custom field;
		//    extra fields on m.space.child are spec-allowed and ignored
		//    by stock clients.  See joinSpaceWithChildren + the live
		//    m.space.child auto-join listener for the read paths.
		const childContent: { via: string[]; suggested: boolean; nsfw?: boolean } = {
			via,
			suggested: false,
		};
		if (opts?.nsfw) childContent.nsfw = true;
		await c.sendStateEvent(spaceId, "m.space.child" as any, childContent, roomId);
		try {
			await c.sendStateEvent(roomId, "m.space.parent" as any, { via, canonical: true }, spaceId);
		} catch {
			// Power-level mismatch in the child room is fine; the canonical
			// hierarchy lives on the space side.
		}

		// 2. Join-rule upgrade for private rooms.  Read the current
		//    rule first; only flip if it's "invite" (private default).
		//    "knock" rooms stay knock; public rooms stay public.
		const room = c.getRoom(roomId);
		const currentRule = room?.currentState
			.getStateEvents("m.room.join_rules", "")
			?.getContent()?.join_rule;
		if (currentRule === "invite") {
			try {
				await c.sendStateEvent(
					roomId,
					"m.room.join_rules" as any,
					{
						join_rule: "restricted",
						allow: [{ type: "m.room_membership", room_id: spaceId }],
					},
					"",
				);
			} catch (err) {
				console.warn("linkRoomToSpace: join-rule upgrade failed (likely missing PL)", err);
			}
		}

		// 3. Space-member auto-join is handled engine-side.  When the
		//    m.space.child event we just wrote lands in the engine's
		//    appservice transaction stream, it force-joins every
		//    LOCAL member of the parent space to this new child room
		//    (see engine/src/server.ts: "Discord-style: when an admin
		//    links a room into a space").  Federated members get the
		//    same treatment from their own homeserver's engine
		//    processing the same event.
		//
		//    Doing it engine-side beats client-side for two reasons:
		//      (a) it works even if the linker disconnects right
		//          after the create (the previous client-side loop
		//          held the create-room modal open while serially
		//          inviting dozens of members, which felt broken)
		//      (b) it works for federated members too — the linker's
		//          client can only send /invite for local users, but
		//          each homeserver's engine independently pulls its
		//          own locals in.
		this.emitSpaceList();
		this.emitRoomList();
	}

	private serverName(): string {
		const userId = this.creds?.user_id ?? "";
		const colon = userId.indexOf(":");
		return colon === -1 ? "" : userId.slice(colon + 1);
	}

	/** Send a Koven governance flag event. */
	async flag(
		roomId: RoomId,
		targetEventId: EventId,
		category: FlagCategory,
		rationale?: string,
	): Promise<EventId> {
		const c = this.requireClient();
		const res = await c.sendEvent(roomId, "chat.koven.flag.v1" as any, {
			target_event_id: targetEventId,
			category,
			flagger: this.currentUserId,
			timestamp: Date.now(),
			rationale,
		} as any);
		return res.event_id as EventId;
	}

	/** Withdraw a flag by redacting its event. */
	async unflag(roomId: RoomId, flagEventId: EventId): Promise<void> {
		const c = this.requireClient();
		await c.redactEvent(roomId, flagEventId);
	}

	/**
	 * Mark a room as read by sending a read receipt for its most recent
	 * timeline event.  Synapse only zeros out the room's notification
	 * count after we receipt — without this, the unread indicator would
	 * stay lit forever.  Best-effort; receipt failures are non-fatal.
	 */
	async markAsRead(roomId: RoomId): Promise<void> {
		const c = this.requireClient();
		const room = c.getRoom(roomId);
		if (!room) return;
		// LOCAL-FIRST: zero the room's unread counters immediately
		// via matrix-js-sdk's setUnreadNotificationCount API.  This
		// is the same pattern Element-web uses.
		//
		// CRITICAL: setUnreadNotificationCount fires
		// RoomEvent.UnreadNotifications on the ROOM, but the SDK's
		// sync layer only re-emits a SUBSET of room events up to
		// the client (see sync.js reEmit list — UnreadNotifications
		// is NOT in it).  So the obvious "listen on the client"
		// pattern doesn't work for our local zeroing.  Instead we
		// just call emitRoomList() ourselves right here — we know
		// the count changed because we just changed it.  No event
		// chain to fight with.
		room.setUnreadNotificationCount(NotificationCountType.Total, 0);
		room.setUnreadNotificationCount(NotificationCountType.Highlight, 0);
		this.emitRoomList();
		// Now send the actual receipt to Synapse so:
		//   (a) other users in the room see the user has read up
		//       to this point (drives "seen by" indicators)
		//   (b) other devices owned by this user see consistent
		//       read state across sessions
		// Best-effort — local UI is already correct regardless.
		const events = room.getLiveTimeline().getEvents();
		const latest = events[events.length - 1];
		if (latest) {
			try {
				await c.sendReadReceipt(latest);
			} catch (err) {
				console.warn("markAsRead: sendReadReceipt failed (UI already updated locally)", err);
			}
		}
	}

	/** Who has read this message (excluding the sender)?  Returns
	 * one entry per joined member whose latest read receipt is at
	 * THIS event or any later event in the room's live timeline.
	 *
	 * Cheap — pure in-memory walk over the timeline + matrix-js-sdk's
	 * receipts cache.  Safe to call on every render.  Returns []
	 * when the room or event isn't loaded into memory yet (e.g. a
	 * scrolled-out message that hasn't been backpaginated into the
	 * live timeline).
	 *
	 * Used by:
	 *   • DM "Read" indicator under sent messages
	 *   • Room "seen by N" avatar stack + the modal that expands it */
	getMessageSeenBy(roomId: RoomId, eventId: EventId): { userId: UserId; ts: number }[] {
		const c = this.requireClient();
		const room = c.getRoom(roomId);
		if (!room) return [];
		const sourceEvent = room.findEventById(eventId);
		if (!sourceEvent) return [];
		const events = room.getLiveTimeline().getEvents();
		const eventIdx = events.findIndex(e => e.getId() === eventId);
		if (eventIdx < 0) return [];
		const sender = sourceEvent.getSender();
		// Walk forward from this event collecting m.read receipts;
		// the first occurrence of each user wins (their EARLIEST
		// receipt at-or-after this event).  Each receipt's ts is
		// when they read up to that anchor — close-enough to "when
		// they saw the message" for the UI.
		const seen = new Map<string, number>();
		for (let i = eventIdx; i < events.length; i++) {
			const ev = events[i];
			if (!ev) continue;
			// matrix-js-sdk: getReceiptsForEvent returns the receipts
			// (any type) attached to THIS event's id.  We filter to
			// m.read.
			const receipts = room.getReceiptsForEvent(ev) ?? [];
			for (const r of receipts) {
				if (r.type !== "m.read") continue;
				if (r.userId === sender) continue;
				if (seen.has(r.userId)) continue;
				const ts = (r.data as { ts?: number } | undefined)?.ts;
				seen.set(r.userId, typeof ts === "number" ? ts : Date.now());
			}
		}
		const result: { userId: UserId; ts: number }[] = [];
		for (const [userId, ts] of seen) {
			result.push({ userId: userId as UserId, ts });
		}
		// Most recent first — matches how Telegram orders the seen-by
		// list (latest reader at the top).
		result.sort((a, b) => b.ts - a.ts);
		return result;
	}

	/**
	 * Accept an invite.  Three flavours:
	 *   - DM invite: join + mirror into m.direct so it lands under DMs.
	 *   - Space invite: join the space AND auto-join every public child
	 *     room.  Mirrors what we do when joining a public space from
	 *     Explore — ends up with a populated space rather than an empty
	 *     parent that requires manual room-by-room joining.
	 *   - Regular room invite: just join.
	 */
	async acceptInvite(roomId: RoomId): Promise<{
		// True when the invite was for a space (vs. a regular room or DM).
		isSpace: boolean;
		// For space invites: the count of NSFW child rooms skipped
		// during joinSpaceWithChildren because the viewer hasn't opted
		// into NSFW.  Always 0 for non-space invites.  App.tsx uses
		// this to decide whether to surface a follow-up "this space
		// contains NSFW rooms — enable to see them?" dialog.
		skippedNsfwChildren: number;
	}> {
		const c = this.requireClient();
		const room = c.getRoom(roomId);
		const dmInviter = room?.getDMInviter();
		const isSpaceRoom = room ? this.isSpace(room) : false;

		let skippedNsfwChildren = 0;
		if (isSpaceRoom) {
			const result = await this.joinSpaceWithChildren(roomId);
			skippedNsfwChildren = result.skippedNsfwChildren;
		} else {
			await c.joinRoom(roomId);
		}

		if (dmInviter) {
			const direct = (c.getAccountData("m.direct")?.getContent() ?? {}) as Record<string, string[]>;
			const existing = direct[dmInviter] ?? [];
			if (!existing.includes(roomId)) {
				const next = { ...direct, [dmInviter]: [...existing, roomId] };
				await c.setAccountData("m.direct" as any, next as any).catch(err => {
					console.warn("acceptInvite: setAccountData failed", err);
				});
			}
			// Optimistic mirror so the next emitRoomList classifies
			// this room as a DM even though the SDK's local m.direct
			// hasn't echoed yet.  Cleared by the m.direct AccountData
			// listener once sync catches up.  See the field's docstring
			// for the full rationale.
			this.pendingDmMappings.set(roomId, dmInviter);
		}
		this.emitRoomList();
		return { isSpace: isSpaceRoom, skippedNsfwChildren };
	}

	/**
	 * Pre-accept peek at an invite.  Returns whether the invite is for
	 * a space (vs. a regular room or DM) and whether the room is
	 * flagged NSFW — used by the App.tsx accept handler to decide
	 * whether to show the NSFW confirmation gate before joining.
	 *
	 * Notes on NSFW visibility pre-accept:
	 *   • Synapse only forwards a small whitelist of state events in
	 *     invite_state by default.  For the `chat.koven.nsfw` flag to
	 *     be visible here, the homeserver must include it in
	 *     `room_invite_state_types` (see homeserver.yaml).  When it
	 *     isn't included, this returns nsfw=false even for NSFW rooms,
	 *     and the post-accept dialog kicks in instead.
	 */
	getInviteInfo(roomId: RoomId): { isSpace: boolean; isNsfw: boolean } | null {
		const c = this.client;
		if (!c) return null;
		const room = c.getRoom(roomId);
		if (!room) return null;
		const isSpace = this.isSpace(room);
		const isNsfw = readKovenNsfw(room);
		return { isSpace, isNsfw };
	}

	/**
	 * Invite a user to a room or space.  Best-effort per-target — if
	 * one fails (already joined, banned, no permission), the others
	 * still try.  Returns the per-user outcomes so the UI can surface
	 * partial-success states.
	 */
	async inviteUsers(roomId: RoomId, userIds: UserId[], reason?: string): Promise<{
		invited: UserId[];
		failed: { userId: UserId; error: string }[];
	}> {
		const c = this.requireClient();
		const invited: UserId[] = [];
		const failed: { userId: UserId; error: string }[] = [];

		// Synapse's `rc_invites_per_room` defaults to burst=10,
		// sustained 0.3/sec.  Promise.all over all invitees blows
		// straight past the burst when userIds.length > 10 —
		// downstream invites fail with "Cannot invite so many users
		// at once".  Mirror inviteUsersThrottled's strategy: parallel
		// burst up to `burstCount`, then serial with a gap.
		const burstCount = 8;
		const gapMs = 350;
		const burst = userIds.slice(0, burstCount);
		const rest = userIds.slice(burstCount);

		// Always repair the room's invite PL before firing any
		// invites.  The endpoint is a cheap no-op when invite is
		// already 0 (it reads PL state and returns immediately), and
		// rooms created before the atomic-PL fix carry a stranded
		// invite>0 that would 403 every invite without this.  Doing
		// it here (vs. in the dialog) means it works regardless of
		// which UI surface called inviteUsers — InviteSheet,
		// CreateRoomSheet's post-create fan-out, future surfaces, or
		// programmatic callers like /add-bot.  Awaited because we
		// want the PL fixed before we hit Synapse's auth check.
		// repairAttempted=true after a successful pre-flight skips
		// the post-failure retry below; if pre-flight failed (engine
		// down, network) we still try one retry on 403 in case the
		// engine comes back.
		let repairAttempted = await this.repairRoomInvitePermissions(roomId);

		const tryInvite = async (u: UserId) => {
			try {
				await c.invite(roomId, u, reason);
				invited.push(u);
				return;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// Only the PL-rejection path is self-healable.  Other
				// 403s (banned user, server ACL, etc.) bubble up.
				const isPermissionDenial =
					/permission to invite/i.test(msg)
					|| /M_FORBIDDEN/.test(msg);
				if (!isPermissionDenial) {
					failed.push({ userId: u, error: msg });
					return;
				}
				// Try to repair on first hit; subsequent invites in
				// this same call benefit from the repair without
				// re-attempting it.
				if (!repairAttempted) {
					repairAttempted = true;
					const repaired = await this.repairRoomInvitePermissions(roomId);
					if (repaired) {
						try {
							await c.invite(roomId, u, reason);
							invited.push(u);
							return;
						} catch (retryErr) {
							failed.push({
								userId: u,
								error: retryErr instanceof Error ? retryErr.message : String(retryErr),
							});
							return;
						}
					}
				}
				failed.push({ userId: u, error: msg });
			}
		};

		await Promise.all(burst.map(tryInvite));
		for (const u of rest) {
			await new Promise(resolve => setTimeout(resolve, gapMs));
			await tryInvite(u);
		}

		return { invited, failed };
	}

	/** Ask the engine to fix a room's m.room.power_levels so any
	 * member can issue invites.  See the engine's POST
	 * /api/rooms/:id/repair-permissions for the implementation —
	 * elevates the engine's appservice user via make_room_admin and
	 * rewrites the PL with `invite: 0` (no-op when invite is
	 * already 0).
	 *
	 * Two callers:
	 *   1. inviteUsers' transparent retry on M_FORBIDDEN.
	 *   2. InviteSheet / StartDmSheet's proactive call on open —
	 *      cheap pre-flight so the room is in good shape by the
	 *      time the user actually fires an invite.
	 *
	 * Returns true on success / no-op-needed, false otherwise.
	 * Logs to the console with details so first-time-failure cases
	 * are debuggable in DevTools. */
	async repairRoomInvitePermissions(roomId: RoomId): Promise<boolean> {
		const token = this.creds?.access_token;
		if (!token) return false;
		try {
			const r = await fetch(
				`${ENGINE_URL}/api/rooms/${encodeURIComponent(roomId)}/repair-permissions`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
				},
			);
			const text = await r.text().catch(() => "");
			if (!r.ok) {
				console.warn(
					`repairRoomInvitePermissions ${roomId} → ${r.status}: ${text.slice(0, 200)}`,
				);
				return false;
			}
			let body: { repaired?: boolean } = {};
			try { body = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
			if (body.repaired) {
				console.log(`repairRoomInvitePermissions ${roomId} → repaired`);
			}
			return true;
		} catch (err) {
			console.warn(`repairRoomInvitePermissions ${roomId} threw`, err);
			return false;
		}
	}

	/**
	 * Decline an invite.  Leaves the room (which is how Matrix expresses
	 * "rejected"), then forgets it so it doesn't reappear in the room
	 * list.  Forgetting only works after leaving, so we sequence them.
	 */
	async declineInvite(roomId: RoomId): Promise<void> {
		const c = this.requireClient();
		await c.leave(roomId);
		await c.forget(roomId).catch(() => {/* ok if not supported */});
		this.emitRoomList();
	}

	/**
	 * Pin a room within a space.  This is a space-wide affordance
	 * (visible to everyone in the space), not per-user — the goal is
	 * for a space owner to elevate one or two important rooms above
	 * the rest of the list so they stand out for every member.
	 *
	 * Persisted as a `chat.koven.pinned_rooms` state event on the
	 * space itself, with `state_key=""` and content
	 *   `{ rooms: [roomId1, roomId2, ...] }`
	 * Order in the array is the order rooms render in.  Editing the
	 * event requires PL ≥ 50 in the space (state_default).
	 *
	 * No-op if the room is already pinned.
	 */
	async pinRoomInSpace(spaceId: SpaceId, roomId: RoomId): Promise<void> {
		const c = this.requireClient();
		const current = this.readPinnedRoomIds(spaceId);
		if (current.includes(roomId)) return;
		const next = [...current, roomId];
		await c.sendStateEvent(spaceId, "chat.koven.pinned_rooms" as any, { rooms: next }, "");
		this.emitSpaceList();
		this.emitRoomList();
	}

	async unpinRoomInSpace(spaceId: SpaceId, roomId: RoomId): Promise<void> {
		const c = this.requireClient();
		const current = this.readPinnedRoomIds(spaceId);
		if (!current.includes(roomId)) return;
		const next = current.filter(id => id !== roomId);
		await c.sendStateEvent(spaceId, "chat.koven.pinned_rooms" as any, { rooms: next }, "");
		this.emitSpaceList();
		this.emitRoomList();
	}

	/** Read the current `chat.koven.pinned_rooms` list for a space.
	 * Returns [] if the event is missing, malformed, or the space isn't
	 * in the local store. */
	private readPinnedRoomIds(spaceId: SpaceId): RoomId[] {
		const r = this.client?.getRoom(spaceId);
		if (!r) return [];
		const ev = r.currentState.getStateEvents("chat.koven.pinned_rooms", "");
		if (!ev) return [];
		const content = ev.getContent() as { rooms?: unknown };
		if (!Array.isArray(content.rooms)) return [];
		return content.rooms.filter((id): id is RoomId => typeof id === "string");
	}

	/**
	 * Leave a room or space.  The user's membership is dropped (so the
	 * room disappears from their list and they stop receiving events
	 * from it) and the server-side memory of their membership is
	 * forgotten.  Other members are unaffected — the room continues
	 * without them.  This is the symmetric "I want out" action; for
	 * "destroy this room" creators have `deleteRoom` below.
	 *
	 * Low-level escape hatch.  When called on a space, this leaves
	 * ONLY the space room, not any of its child rooms.  The
	 * Discord-style "leave this whole community" gesture lives in
	 * `leaveSpaceWithChildren` below — that's what App.tsx wires up
	 * to the SpaceEditSheet.  Direct callers of `leaveRoom(spaceId)`
	 * are leaving the space-as-a-room only; mostly useful when the
	 * caller has already enumerated child cleanup themselves.
	 */
	async leaveRoom(roomId: RoomId): Promise<void> {
		const c = this.requireClient();
		await c.leave(roomId);
		await c.forget(roomId).catch(() => {/* ok if not supported */});
		this.emitRoomList();
	}

	/**
	 * Leave a space along with every child room the user joined through
	 * it — symmetric to `joinSpaceWithChildren`.  Matrix's protocol
	 * model treats space membership as independent of child-room
	 * membership ("I can be in #general without being in 'My Server'"),
	 * but that's not how users think about Discord-style communities,
	 * which is what we're building.  Joining a space pulls in all its
	 * channels; leaving should drop them too.
	 *
	 * Two protections against the worst case (user accidentally loses
	 * access to a room they reach through multiple paths):
	 *
	 *   1. Sub-spaces (children with `room_type: m.space`) are NOT
	 *      auto-left.  Mirrors `joinSpaceWithChildren`, which doesn't
	 *      auto-join sub-spaces — they're an explicit opt-in.
	 *
	 *   2. A child room is only left if NO other joined space the user
	 *      is in claims it as a child.  If room X is filed under both
	 *      spaces A and B and the user leaves A, X stays — they still
	 *      have a navigation path to it via B.  This matches the user
	 *      mental model of "rooms belong to a server" while honoring
	 *      Matrix's many-to-many parent reality.
	 *
	 * Per-child failures are logged and counted but never abort the
	 * sequence: getting halfway out is better than getting stuck
	 * half-in.  The space room itself is left LAST so the SDK still
	 * has the parent's local state available while we walk children.
	 */
	async leaveSpaceWithChildren(spaceId: SpaceId): Promise<{
		leftChildren: number;
		skippedChildren: number;
		failedChildren: number;
	}> {
		const c = this.requireClient();
		const me = c.getUserId();
		if (!me) throw new Error("leaveSpaceWithChildren: client has no user id");
		const space = c.getRoom(spaceId);
		if (!space) {
			// Space not in store — fall back to a plain leave on the
			// id and call it done.  Without local state we can't
			// enumerate children.
			await c.leave(spaceId);
			await c.forget(spaceId).catch(() => {});
			this.emitRoomList();
			this.emitSpaceList();
			return { leftChildren: 0, skippedChildren: 0, failedChildren: 0 };
		}

		// Build the set of child room ids declared by m.space.child
		// state events on the space.  An empty `via` array on a child
		// event means it's been "tombstoned" (admin removed the room
		// from the space) — skip those.
		const childIds = new Set<string>();
		const childEvents = space.currentState.getStateEvents("m.space.child") ?? [];
		for (const ev of childEvents) {
			const childId = ev.getStateKey();
			if (!childId) continue;
			const content = ev.getContent() as { via?: string[] };
			if (!Array.isArray(content.via) || content.via.length === 0) continue;
			childIds.add(childId);
		}

		// Build the set of child ids claimed by OTHER joined spaces, so
		// we can skip those and avoid stranding the user.  Walking the
		// SDK's room list once is cheap; we'd otherwise need a per-child
		// lookup that's strictly more work.
		const protectedByOtherSpace = new Set<string>();
		for (const r of c.getRooms()) {
			if (r.roomId === spaceId) continue;
			const isSpace = r.isSpaceRoom?.() ?? false;
			if (!isSpace) continue;
			if (r.getMyMembership() !== "join") continue;
			const otherChildren = r.currentState.getStateEvents("m.space.child") ?? [];
			for (const ev of otherChildren) {
				const childId = ev.getStateKey();
				if (!childId) continue;
				const content = ev.getContent() as { via?: string[] };
				if (!Array.isArray(content.via) || content.via.length === 0) continue;
				protectedByOtherSpace.add(childId);
			}
		}

		let left = 0;
		let skipped = 0;
		let failed = 0;
		// Sequential rather than parallel — Synapse rate-limits /leave,
		// and a thundering herd of leave calls on a 50-channel space
		// gets several of them rejected with 429.  Sequential keeps us
		// well inside the per-user quota and the wall-clock time is
		// fine because we leave child rooms in the user's mental
		// background after they've already navigated away.
		for (const childId of childIds) {
			const child = c.getRoom(childId);
			// Skip sub-spaces — symmetric with joinSpaceWithChildren.
			if (child?.isSpaceRoom?.()) { skipped++; continue; }
			// Skip rooms the user reaches through another joined space.
			if (protectedByOtherSpace.has(childId)) { skipped++; continue; }
			// Skip rooms the user already isn't in (left previously,
			// kicked, never joined to begin with).
			const membership = child?.getMyMembership();
			if (membership !== "join" && membership !== "invite") { skipped++; continue; }
			try {
				await c.leave(childId);
				await c.forget(childId).catch(() => {});
				left++;
			} catch (err) {
				console.warn(`leaveSpaceWithChildren: failed to leave child ${childId}`, err);
				failed++;
			}
		}

		// Leave the space itself last.
		try {
			await c.leave(spaceId);
			await c.forget(spaceId).catch(() => {});
		} catch (err) {
			console.warn(`leaveSpaceWithChildren: failed to leave space ${spaceId}`, err);
			// Re-throw — the user explicitly asked to leave the space;
			// child cleanup having already run is fine but the headline
			// operation failing should bubble up so the UI can show it.
			throw err;
		}

		this.emitRoomList();
		this.emitSpaceList();
		return { leftChildren: left, skippedChildren: skipped, failedChildren: failed };
	}

	/**
	 * Destroy a space along with every room declared as its child.
	 * Walks `childRoomIds` first, calling `deleteRoom` for each
	 * (best-effort — rooms the user can't kick from are skipped and
	 * logged), then deletes the space room itself.  Caller is the
	 * one with the canonical child list, so we don't re-derive it
	 * here from the SDK state.
	 *
	 * In practice every child should succeed: createSpace locks
	 * `m.space.child` to PL 100, so only the creator (or explicit
	 * co-founders) could have added rooms in the first place.  A
	 * `failed` entry usually means the room was deleted out from
	 * under us by another founder, or the user is operating against
	 * a space they imported from elsewhere with looser PLs.
	 */
	async deleteSpace(
		spaceId: RoomId,
		childRoomIds: RoomId[],
	): Promise<{ deletedChildren: RoomId[]; failedChildren: RoomId[] }> {
		const deletedChildren: RoomId[] = [];
		const failedChildren: RoomId[] = [];
		for (const childId of childRoomIds) {
			try {
				await this.deleteRoom(childId);
				deletedChildren.push(childId);
			} catch (err) {
				console.warn(`deleteSpace: child ${childId} delete failed`, err);
				failedChildren.push(childId);
			}
		}
		// Delete the space room itself last so the children's
		// `m.space.parent` references are still valid while we
		// process them (matters for any client that uses parent
		// references for navigation).
		await this.deleteRoom(spaceId);
		return { deletedChildren, failedChildren };
	}

	/**
	 * Destroy a room or space the user created.  Matrix has no
	 * "delete room" primitive — rooms are eternal once created.  The
	 * closest gesture: kick every other member, then leave + forget
	 * yourself.  The room becomes a tomb on the homeserver, no live
	 * members, no future activity, but the event history persists in
	 * server storage.  Functionally equivalent to delete from every
	 * user's POV.
	 *
	 * Caller must have kick + invite power-level on the room (default
	 * for the creator at PL 100).  Member kicks are best-effort: a
	 * single kick failure is logged but doesn't block the rest, since
	 * abandoning the operation half-way leaves a worse state than
	 * pressing on.
	 */
	async deleteRoom(roomId: RoomId): Promise<void> {
		const c = this.requireClient();
		const me = c.getUserId();
		if (!me) throw new Error("deleteRoom: client has no user id");
		const room = c.getRoom(roomId);
		if (!room) throw new Error(`deleteRoom: room ${roomId} not in store`);

		// Strip the room from every parent space's child list BEFORE
		// kicking + leaving.  Without this, the m.space.child state
		// event on each parent space stays pointing at a now-empty
		// room — it shows up in the space as a ghost child tile that
		// nobody can join (Synapse refuses admin-join into a 0-member
		// room with "no servers in the room have been provided").
		// Send `{}` content (Matrix's idiomatic "child removed" — an
		// m.space.child with no `via`) on each parent.  Best-effort:
		// a parent we lack PL on stays linked, but the room itself is
		// still deleted; the broken link can be cleaned up by that
		// parent's admin later.
		const parentEvents = room.currentState.getStateEvents("m.space.parent") ?? [];
		for (const ev of parentEvents) {
			const parentSpaceId = ev.getStateKey();
			if (!parentSpaceId) continue;
			try {
				await c.sendStateEvent(parentSpaceId, "m.space.child" as any, {}, roomId);
			} catch (err) {
				console.warn(`deleteRoom: failed to unlink from space ${parentSpaceId}`, err);
			}
		}

		// Kick everyone except self.  matrix-js-sdk's `kick` takes the
		// reason as an optional second arg; we pass a short marker so
		// kicked members understand why they're seeing a kick event.
		const others = room
			.getMembers()
			.filter(m => m.userId !== me && (m.membership === "join" || m.membership === "invite"));
		for (const m of others) {
			try {
				await c.kick(roomId, m.userId, "Room deleted by creator");
			} catch (err) {
				console.warn(`deleteRoom: failed to kick ${m.userId}`, err);
			}
		}

		// Leave self last so the kicks happen while we still have
		// power-level to issue them.
		await c.leave(roomId);
		await c.forget(roomId).catch(() => {/* ok if not supported */});
		this.emitRoomList();
		this.emitSpaceList();
	}

	/**
	 * Delete a DM from this user's side — the Matrix-native gesture for
	 * "I'm done with this conversation."  Three steps, in order:
	 *
	 *   1. Strip the room from `m.direct` account_data so the bookkeeping
	 *      stays clean.  Without this, future DM lookups against the
	 *      same user would still resolve to the forgotten room and break.
	 *   2. Leave — drops our membership.  Any further messages the other
	 *      party sends in this room never sync to us.
	 *   3. Forget — purges server-side state about our membership.
	 *      Forgetting only works post-leave; we sequence them.
	 *
	 * The other party's copy is unaffected — Matrix has no
	 * "delete-for-everyone" primitive.  If they DM us again, their
	 * client typically opens a fresh room and we receive a new invite.
	 */
	async deleteDm(roomId: RoomId): Promise<void> {
		const c = this.requireClient();
		const directContent = (c.getAccountData("m.direct")?.getContent() ?? {}) as Record<string, string[]>;
		let mutated = false;
		const next: Record<string, string[]> = {};
		for (const [user, rooms] of Object.entries(directContent)) {
			const filtered = (Array.isArray(rooms) ? rooms : []).filter(rid => rid !== roomId);
			if (filtered.length !== (rooms?.length ?? 0)) mutated = true;
			if (filtered.length > 0) next[user] = filtered;
		}
		if (mutated) {
			await c.setAccountData("m.direct" as any, next as any);
		}
		await c.leave(roomId);
		await c.forget(roomId).catch(() => {/* ok if not supported */});
		this.emitRoomList();
	}

	/** Pull the current room list as our shared `Room` shape.  Spaces are filtered out. */
	getRooms(): Room[] {
		if (!this.client) return [];
		return this.client.getRooms()
			.filter(r => !this.isSpace(r))
			// Drop rooms we've already left.  matrix-js-sdk keeps the
			// SdkRoom object in its store after `client.leave()` until
			// `client.forget()` completes (and even then, sometimes
			// briefly).  Without this filter, a deleted/left room
			// lingers in the user's list as a member-less ghost
			// until the next page reload.
			.filter(r => isLiveMembership(r.getMyMembership()))
			.map(r => this.sdkRoomToRoom(r))
			.sort((a, b) => {
				// Sort by most-recent MESSAGE-shaped event so chatty
				// rooms bubble up.  matrix-js-sdk's
				// getLastActiveTimestamp() returns the latest event of
				// ANY kind in the timeline, which means engine-driven
				// state events (m.space.parent / m.space.child writes,
				// member churn from @engine joining rooms, name + topic
				// edits, pinned-room updates, etc.) bump quiet rooms to
				// the top while a room with active conversation but
				// stable state sinks below them.  That was the "sort
				// order makes no logical sense" complaint — events
				// users don't see were driving the order.
				//
				// lastMessageTs walks the live timeline from the tail
				// and returns the ts of the first event whose type is
				// in MESSAGE_LIKE_TYPES.  Cheap in the steady state
				// (the latest event IS a message); only walks deeper on
				// rooms whose tail is dominated by state events.  Pin
				// handling stays space-scoped and applied in the UI
				// layer (RoomList).
				const ta = this.client ? lastMessageTs(this.client.getRoom(a.id)) : 0;
				const tb = this.client ? lastMessageTs(this.client.getRoom(b.id)) : 0;
				if (ta !== tb) return tb - ta;
				return a.name.localeCompare(b.name);
			});
	}

	/** Pull spaces as our shared `Space` shape, sorted alpha. */
	getSpaces(): Space[] {
		if (!this.client) return [];
		return this.client.getRooms()
			.filter(r => this.isSpace(r))
			.filter(r => isLiveMembership(r.getMyMembership()))
			.map(r => this.sdkRoomToSpace(r))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private isSpace(r: SdkRoom): boolean {
		const create = r.currentState.getStateEvents("m.room.create", "");
		return create?.getContent()?.type === "m.space";
	}

	private sdkRoomToSpace(r: SdkRoom): Space {
		const childEvents = r.currentState.getStateEvents("m.space.child");
		const childRoomIds: RoomId[] = [];
		for (const ev of childEvents) {
			const sk = ev.getStateKey();
			const content = ev.getContent();
			// An m.space.child whose content has a "via" array is "active";
			// content === {} is the way Matrix represents a removed child.
			if (sk && content && Array.isArray(content.via) && content.via.length > 0) {
				childRoomIds.push(sk as RoomId);
			}
		}
		const joinRulesEvent = r.currentState.getStateEvents("m.room.join_rules", "");
		const joinRule = joinRulesEvent?.getContent().join_rule;
		// My power level in the space — gates founder/admin UI
		// (Add room, Space settings).  Same shape as Room.myPowerLevel.
		let myPowerLevel: number | undefined;
		const myUserId = this.creds?.user_id;
		if (myUserId) myPowerLevel = r.getMember(myUserId)?.powerLevel ?? 0;
		const createEvent = r.currentState.getStateEvents("m.room.create", "");
		const creatorId = (createEvent?.getSender() ?? undefined) as UserId | undefined;
		// Pinned rooms — space-wide, set by space admins, visible to
		// everyone.  Stored on the space's `chat.koven.pinned_rooms`
		// state event.  Filter the list to ids we still see as live
		// children so a pin doesn't survive room deletion as a stale
		// reference.
		const childIdSet = new Set(childRoomIds);
		const pinnedRoomIds = this.readPinnedRoomIds(r.roomId as SpaceId)
			.filter(id => childIdSet.has(id));
		// Koven-specific config: chat.koven.space.config state event.
		// Currently only carries `e2ee_required` — meaning every child
		// room of this space must be created encrypted + private.
		// Set once at space creation; read here at every space rebuild
		// so the SPA + child-room creation flow can see it.
		const spaceConfig = r.currentState
			.getStateEvents("chat.koven.space.config", "")
			?.getContent() as { e2ee_required?: boolean } | undefined;
		return {
			id: r.roomId as SpaceId,
			name: r.name || r.roomId,
			topic: r.currentState.getStateEvents("m.room.topic", "")?.getContent().topic,
			avatarUrl: r.getMxcAvatarUrl() ?? undefined,
			iconEmoji: readKovenIconEmoji(r),
			kind: joinRule === "public" ? "public" : "private",
			e2eeRequired: spaceConfig?.e2ee_required === true,
			childRoomIds,
			myPowerLevel,
			creatorId,
			pinnedRoomIds,
			nsfw: readKovenNsfw(r),
		};
	}

	/**
	 * Fire-and-forget profile fetch for a DM peer when our local
	 * cache has no avatar for them.  Synapse responds with the
	 * peer's CURRENT profile (display name + avatar mxc), which
	 * matrix-js-sdk applies to the User object — the resulting
	 * UserEvent.AvatarUrl emit re-renders the room list with the
	 * real avatar in place of the DiceBear fallback.
	 *
	 * Used for bot DMs whose avatar was set after the bot first
	 * joined — the join membership event carries the at-join-time
	 * (often empty) avatar, but the live profile has the new one.
	 *
	 * Per-userId once-only; failures are silent (best-effort).
	 */
	private kickPeerProfileFetch(userId: string): void {
		if (this.peerProfileFetched.has(userId)) return;
		this.peerProfileFetched.add(userId);
		const c = this.client;
		if (!c) return;
		c.getProfileInfo(userId).then(profile => {
			let changed = false;
			if (typeof profile.avatar_url === "string" && profile.avatar_url.length > 0) {
				const existing = this.resolvedPeerAvatars.get(userId);
				if (existing !== profile.avatar_url) {
					this.resolvedPeerAvatars.set(userId, profile.avatar_url);
					changed = true;
				}
			}
			// Also update matrix-js-sdk's User object so other code
			// paths (member list, profile sheet) pick up the live
			// data.  Best-effort — don't depend on this for the
			// room-list avatar to render.
			const user = c.getUser(userId);
			if (user) {
				if (typeof profile.avatar_url === "string" && profile.avatar_url !== user.avatarUrl) {
					user.setAvatarUrl(profile.avatar_url);
				}
				if (typeof profile.displayname === "string" && profile.displayname !== user.displayName) {
					user.setDisplayName(profile.displayname);
				}
			}
			// Re-emit so the room mapping re-runs and picks up the
			// new avatar from resolvedPeerAvatars.  Only when we
			// actually got a new value to avoid pointless renders.
			if (changed) this.emitRoomList();
		}).catch(() => {
			// Best-effort: a failed profile fetch just leaves the
			// DiceBear fallback in place.  Don't retry on the same
			// userId — re-add to peerProfileFetched ensures that.
		});
	}

	/**
	 * Read the current user's Matrix-side profile fields.  Bio isn't
	 * here any more — it's stored on the engine (see lib/profile.ts)
	 * since Matrix has no public-bio field and account_data is private.
	 */
	async getMyProfile(): Promise<{
		userId: UserId;
		displayName: string;
		avatarUrl?: string;       // raw mxc://
		homeserver: string;
	}> {
		const c = this.requireClient();
		const userId = (this.creds?.user_id ?? c.getUserId() ?? "") as UserId;
		const profile = await c.getProfileInfo(userId);
		return {
			userId,
			displayName: (profile?.displayname as string | undefined) ?? userId,
			avatarUrl: profile?.avatar_url as string | undefined,
			homeserver: this.creds?.homeserver ?? "",
		};
	}

	/**
	 * Read another user's public profile.  Bio isn't included — it lives
	 * in account_data which is private; making bios visible to others
	 * is a follow-up (would need either a profile room or a custom
	 * pubic profile field).
	 */
	/** Synchronous read of matrix-js-sdk's User cache.  Populated
	 * for everyone we've seen via /sync; returns undefined for
	 * unknown ids (use getUserProfile for the HTTP fetch path).
	 * Used by hooks that want a free fast-path before falling
	 * through to a profile request. */
	getSdkUser(userId: string): { displayName?: string; avatarUrl?: string } | undefined {
		const u = this.client?.getUser(userId);
		if (!u) return undefined;
		return { displayName: u.displayName, avatarUrl: u.avatarUrl ?? undefined };
	}

	async getUserProfile(userId: UserId): Promise<{
		userId: UserId;
		displayName: string;
		avatarUrl?: string;       // raw mxc://
		homeserver: string;
	}> {
		const c = this.requireClient();
		const profile = await c.getProfileInfo(userId);
		const colon = userId.indexOf(":");
		const homeserver = colon === -1 ? "" : userId.slice(colon + 1);
		return {
			userId,
			displayName: (profile?.displayname as string | undefined) ?? userId,
			avatarUrl: profile?.avatar_url as string | undefined,
			homeserver,
		};
	}

	/**
	 * Update the current user's Matrix-side profile fields.  Bio is
	 * intentionally not here — it goes through lib/profile.ts since it
	 * lives on the engine, not on Matrix.
	 */
	async updateMyProfile(opts: {
		displayName?: string;
		avatarFile?: File;          // upload-and-set if provided
		clearAvatar?: boolean;
	}): Promise<{
		// The new avatar mxc — string when uploaded, null when cleared,
		// undefined when the avatar wasn't touched this call.  Lets the
		// caller propagate the change into local state without having
		// to re-fetch the profile.
		avatarUrl: string | null | undefined;
	}> {
		const c = this.requireClient();
		if (opts.displayName !== undefined) {
			await c.setDisplayName(opts.displayName);
		}
		let avatarUrl: string | null | undefined;
		if (opts.avatarFile) {
			avatarUrl = await this.uploadAvatarImage(opts.avatarFile);
			await c.setAvatarUrl(avatarUrl);
		} else if (opts.clearAvatar) {
			avatarUrl = null;
			await c.setAvatarUrl("");
		}
		return { avatarUrl };
	}

	// ─── Block list (m.ignored_user_list) ──────────────────────────────
	// Matrix's native ignore primitive.  When a user id appears in
	// m.ignored_user_list account_data, the SDK drops their events from
	// timelines on the way in and refuses to deliver our outgoing
	// messages to them through DMs.  It's a unilateral, client-side
	// filter: it does NOT feed into reputation or the consensus collapse
	// pipeline.  The block list and the flag system are separate
	// primitives, intentionally.
	//
	// Account data syncs across devices, so blocking on web carries to
	// any other Matrix client the user signs into.

	/** Current ignored user ids from account_data, in insertion order. */
	getIgnoredUsers(): UserId[] {
		const c = this.client;
		if (!c) return [];
		const list = c.getIgnoredUsers() as string[] | undefined;
		return (list ?? []) as UserId[];
	}

	/** True iff `userId` is currently in the ignore list. */
	isUserIgnored(userId: UserId): boolean {
		const c = this.client;
		if (!c) return false;
		return !!c.isUserIgnored(userId);
	}

	/**
	 * Add a user to the ignore list.  Persists into account_data; takes
	 * effect across devices on next sync.  No-op if already ignored.
	 * Refuses to ignore self.
	 */
	async ignoreUser(userId: UserId): Promise<void> {
		const c = this.requireClient();
		if (userId === this.creds?.user_id) {
			throw new Error("Can't block yourself");
		}
		const current = (c.getIgnoredUsers() as string[] | undefined) ?? [];
		if (current.includes(userId)) return;
		await c.setIgnoredUsers([...current, userId]);
	}

	/** Remove a user from the ignore list.  No-op if not currently ignored. */
	async unignoreUser(userId: UserId): Promise<void> {
		const c = this.requireClient();
		const current = (c.getIgnoredUsers() as string[] | undefined) ?? [];
		if (!current.includes(userId)) return;
		await c.setIgnoredUsers(current.filter(u => u !== userId));
	}

	/**
	 * Subscribe to ignore-list updates.  Listener fires after every
	 * `m.ignored_user_list` account_data change (including ones from
	 * other devices that arrive over sync).  Returns an unsubscribe.
	 */
	onIgnoredUsersChanged(listener: () => void): () => void {
		this.ignoreListeners.add(listener);
		return () => { this.ignoreListeners.delete(listener); };
	}

	// ─── NSFW discovery preference (cross-device sync) ───────────────
	//
	// Stored as a `chat.koven.nsfw_preference` account_data event with
	// content `{ show: true | false }`.  Account data is per-user and
	// federates naturally to every device signed in as that user, so
	// flipping the toggle on a phone propagates to the desktop on the
	// next /sync poll.  Default (no event written yet) is false —
	// matches the "off by default, must opt in" stance.

	/**
	 * Read the current NSFW discovery preference.  Returns false when
	 * no event has been written yet (default-off).
	 */
	getNsfwPreference(): boolean {
		const c = this.client;
		if (!c) return false;
		const ev = c.getAccountData("chat.koven.nsfw_preference" as any);
		const content = (ev?.getContent() ?? {}) as { show?: unknown };
		return content.show === true;
	}

	/**
	 * Write the NSFW discovery preference.  Round-trips to the server
	 * and the AccountData listener echoes back, so subscribers (every
	 * other tab, every other device) update on the next /sync.
	 */
	async setNsfwPreference(show: boolean): Promise<void> {
		const c = this.requireClient();
		await c.setAccountData("chat.koven.nsfw_preference" as any, { show } as any);
	}

	/**
	 * Subscribe to NSFW preference updates.  Listener fires after
	 * every `chat.koven.nsfw_preference` account_data change,
	 * including ones from other devices arriving over sync.  Returns
	 * an unsubscribe.
	 */
	onNsfwPreferenceChanged(listener: (show: boolean) => void): () => void {
		this.nsfwPrefListeners.add(listener);
		return () => { this.nsfwPrefListeners.delete(listener); };
	}

	// ─── Self-deactivate ───────────────────────────────────────────────
	// POST /_matrix/client/v3/account/deactivate.  Distinct from the
	// admin-side /_synapse/admin/v1/deactivate path the engine uses for
	// confirmed floor-violation bans (that one needs admin auth and
	// can target any user); this one needs the account password (UIA)
	// and can only target self.
	//
	// `erase: true` instructs Synapse to redact all events the user
	// authored.  We default it on so "delete account" reads as
	// "scrub me from the room histories", not "leave my messages
	// orphaned under a deactivated account."

	/**
	 * Permanently deactivate the current account.  Two-step UIA flow:
	 * a probe POST (no auth) usually returns 401 with a session id,
	 * which we satisfy with `m.login.password`.  Password is read from
	 * the engine-issued UIA stash (setUiaPassword) unless an explicit
	 * value is passed.  After success the access token is invalidated
	 * server-side and any further client requests will 401.
	 */
	async deactivateMyAccount(password?: string, erase: boolean = true): Promise<void> {
		const creds = this.creds;
		if (!creds) throw new Error("not logged in");
		const pw = password ?? this.uiaPassword;
		if (!pw) {
			throw new Error("UIA password unavailable; call setUiaPassword first");
		}
		const url = `${creds.homeserver}/_matrix/client/v3/account/deactivate`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${creds.access_token}`,
		};

		// Step 1: probe for the UIA session.
		const probe = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ erase }),
		});
		const probeJson = (await probe.json().catch(() => ({}))) as Record<string, unknown>;
		if (probe.ok) {
			// Some configs accept without UIA (uncommon); we're done.
			return;
		}
		const session = (probeJson as { session?: string }).session;
		if (!session) {
			throw new Error(messageFromMatrixError(probeJson, `Deactivation failed (${probe.status})`));
		}

		// Step 2: re-POST with password auth filling the UIA stage.
		const finalRes = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				erase,
				auth: {
					type: "m.login.password",
					session,
					identifier: { type: "m.id.user", user: creds.user_id },
					password: pw,
				},
			}),
		});
		if (!finalRes.ok) {
			const body = (await finalRes.json().catch(() => ({}))) as Record<string, unknown>;
			throw new Error(messageFromMatrixError(body, `Deactivation failed (${finalRes.status})`));
		}
	}

	// ─── Session management ────────────────────────────────────────────
	//
	// Lists + revokes the user's other Matrix devices.  Useful surface
	// because Synapse never auto-deactivates devices on its own — every
	// sign-out + sign-in cycle (or every cross-device login) creates a
	// new device, and an undisciplined user can easily accumulate a
	// dozen ghost devices that encrypted messages get fanned out to,
	// leading to "this message can't be decrypted" errors when the live
	// device doesn't have the megolm session for one of the ghosts.
	//
	// We expose two operations:
	//   * listSessions() — all devices for this user, including current.
	//     Used by the Settings → Account → Sessions list.
	//   * revokeOtherSessions() — bulk-deletes everything EXCEPT the
	//     current device, satisfying Synapse's UIA challenge with the
	//     engine-issued ephemeral password (same pattern as
	//     deactivateMyAccount above).

	/**
	 * Async fetch of the current user's device list from Synapse.
	 * Includes the live device count (self included) so the UI can
	 * tell the user "you've got N sessions" and disable the revoke
	 * button when there are no others.
	 */
	/** Push the current client's platform-aware label into Synapse's
	 * device record so the Sessions list shows "Koven Desktop" /
	 * "Koven Mobile" / "Koven Web" instead of every row reading
	 * "Koven Web" regardless of where the user signed in.
	 *
	 * Self-healing: re-runs every successful sync, so existing
	 * sessions get relabelled without an explicit user gesture.
	 * Engine's login-time label is now redundant; the client owns
	 * its own identity. */
	async syncOwnDeviceLabel(): Promise<void> {
		const c = this.requireClient();
		const deviceId = c.getDeviceId();
		if (!deviceId) return;
		const desired = await computeDeviceLabel();
		// Read the current label first — Synapse caches device info
		// in its own DB; matrix-js-sdk's User cache might not have
		// it.  We use getDevice() to read current state.
		try {
			const devices = (await c.getDevices()).devices;
			const me = devices.find(d => d.device_id === deviceId);
			if (me?.display_name === desired) return; // already correct, skip the PUT
			await c.setDeviceDetails(deviceId, { display_name: desired });
		} catch (err) {
			// Non-fatal — Sessions list still works, it just shows
			// whatever stale label was there.
			console.debug("matrix: setDeviceDetails skipped", err);
		}
	}

	async fetchSessions(): Promise<Array<{
		deviceId: string;
		displayName: string | null;
		lastSeenIp: string | null;
		lastSeenTs: number | null;
		isCurrent: boolean;
	}>> {
		const c = this.requireClient();
		const myDeviceId = c.getDeviceId();
		const res = await c.getDevices();
		return res.devices
			// koven-engine-bootstrap is the engine's appservice
			// device — it's how the engine authenticates to perform
			// admin operations (room-directory toggles, force-joins,
			// etc.).  Surfacing it in the user-facing Sessions list
			// is misleading (it isn't a real session the user signed
			// into) and revoking it would break every admin path.
			// Hide it entirely.
			.filter(d => d.display_name !== "koven-engine-bootstrap")
			.map(d => ({
				deviceId: d.device_id,
				displayName: d.display_name ?? null,
				lastSeenIp: d.last_seen_ip ?? null,
				lastSeenTs: d.last_seen_ts ?? null,
				isCurrent: d.device_id === myDeviceId,
			}));
	}

	/**
	 * Revoke every device on this user's account except the one
	 * currently signed in.  Uses Synapse's `delete_devices` endpoint
	 * (POST /_matrix/client/v3/delete_devices) which, like account
	 * deactivation, requires a UIA password challenge.  We satisfy
	 * it with the engine-issued ephemeral password held in
	 * `this.uiaPassword`.
	 *
	 * Returns the count of devices actually revoked.  Throws on UIA
	 * failure or if the engine hasn't seeded a UIA password yet
	 * (caller can route to the error dispatcher and prompt the
	 * user to refresh).
	 */
	async revokeOtherSessions(password?: string): Promise<number> {
		const creds = this.creds;
		const c = this.requireClient();
		if (!creds) throw new Error("not logged in");
		const pw = password ?? this.uiaPassword;
		if (!pw) throw new Error("UIA password unavailable; call setUiaPassword first");

		const myDeviceId = c.getDeviceId();
		const res = await c.getDevices();
		const targets = res.devices
			// Skip the current device (we're signing OUT others) and
			// the engine bootstrap device (revoking it would break
			// every admin operation routed through the appservice).
			// Same filter as fetchSessions above; mirrored here so a
			// caller can't sneak the bootstrap into the revoke list.
			.filter(d =>
				d.device_id !== myDeviceId &&
				d.display_name !== "koven-engine-bootstrap"
			)
			.map(d => d.device_id);
		if (targets.length === 0) return 0;

		const url = `${creds.homeserver}/_matrix/client/v3/delete_devices`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${creds.access_token}`,
		};

		// Step 1: probe.  Synapse refuses without UIA and returns the
		// session id we have to echo back with a password fill.
		const probe = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ devices: targets }),
		});
		if (probe.ok) {
			// Rare but possible if the user already authed recently;
			// device wipe went through on the first call.
			return targets.length;
		}
		const probeJson = (await probe.json().catch(() => ({}))) as Record<string, unknown>;
		const session = (probeJson as { session?: string }).session;
		if (!session) {
			throw new Error(messageFromMatrixError(probeJson, `Revoke failed (${probe.status})`));
		}

		// Step 2: re-POST with the password fill.
		const finalRes = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				devices: targets,
				auth: {
					type: "m.login.password",
					session,
					identifier: { type: "m.id.user", user: creds.user_id },
					password: pw,
				},
			}),
		});
		if (!finalRes.ok) {
			const body = (await finalRes.json().catch(() => ({}))) as Record<string, unknown>;
			throw new Error(messageFromMatrixError(body, `Revoke failed (${finalRes.status})`));
		}
		return targets.length;
	}

	/** Joined members of a room, sorted by power level then name. */
	getRoomMembers(roomId: RoomId): import("@koven/shared").Member[] {
		const c = this.client;
		const room = c?.getRoom(roomId);
		if (!c || !room) return [];
		const myUserId = this.creds?.user_id;
		const joined = room.getMembersWithMembership("join");
		return joined.map(m => {
			// Synapse presence is best-effort; getUser() may return
			// null for members the local client hasn't observed
			// presence for yet.  Treat unknown as "offline" — better
			// to under-promise (show as offline) than over-promise
			// (claim online for someone we haven't heard from).
			const u = c.getUser(m.userId);
			let presence: import("@koven/shared").Member["presence"] = "offline";
			if (u) {
				if (u.presence === "online") {
					// "online" + currentlyActive=false means the user
					// is logged in but idle — bucket as "unavailable"
					// so the UI surfaces the recently-active state
					// distinctly from active-right-now.
					presence = u.currentlyActive ? "online" : "unavailable";
				} else if (u.presence === "unavailable") {
					presence = "unavailable";
				} else if (u.presence === "offline") {
					presence = "offline";
				}
			}
			// Self always renders as online.  Synapse doesn't push
			// your own presence back through /sync the way it pushes
			// other users', so getUser(self) often returns a User
			// with the default "offline" until something triggers a
			// refresh — which made the viewer show up greyed-out in
			// their own member list until they clicked around.  By
			// definition you're connected if you're rendering this,
			// so force it.  Mirrors the bot override above (in
			// MemberList: bots also always read as online).
			if (myUserId && m.userId === myUserId) {
				presence = "online";
			}
			return {
				userId: m.userId as UserId,
				displayName: m.name || m.userId,
				// Raw mxc:// — UI components fetch via getMxcBlobUrl().
				avatarUrl: m.getMxcAvatarUrl() ?? undefined,
				powerLevel: m.powerLevel ?? 0,
				presence,
				statusMessage: u?.presenceStatusMsg ?? undefined,
			};
		}).sort((a, b) => {
			if (a.powerLevel !== b.powerLevel) return b.powerLevel - a.powerLevel;
			return a.displayName.localeCompare(b.displayName);
		});
	}

	/**
	 * Paginate the room's timeline backwards.  matrix-js-sdk's
	 * startClient pulls only `initialSyncLimit` events per room on
	 * initial sync (200 in our config); older history requires
	 * explicit /messages pagination.  Default `limit` of 500 per hop
	 * keeps the network round-trips coarse — for text chat the
	 * payload is small even at 500 events, and a fast scroller blows
	 * through 50-event chunks in under a second.  Combined with the
	 * 1000px scroll trigger threshold in ChatPane, the next batch is
	 * almost always already loaded by the time the user reaches it.
	 *
	 * Returns true if the homeserver had more events to give (i.e.
	 * the timeline grew), false if we hit the start-of-room or
	 * Synapse otherwise refused to extend.  Callers (the ChatPane
	 * scroll handler) use the return value to stop asking once
	 * there's nothing left to fetch.
	 */
	async loadMoreHistory(roomId: RoomId, limit = 500): Promise<boolean> {
		const c = this.requireClient();
		const room = c.getRoom(roomId);
		if (!room) return false;
		const before = room.getLiveTimeline().getEvents().length;
		try {
			await c.scrollback(room, limit);
		} catch (err) {
			console.warn("loadMoreHistory: scrollback failed", err);
			return false;
		}
		const after = room.getLiveTimeline().getEvents().length;
		return after > before;
	}

	/**
	 * All messages currently in the room's live timeline, oldest
	 * first.  Bounded only by what matrix-js-sdk has fetched —
	 * initially `initialSyncLimit` events from /sync, growing as
	 * `loadMoreHistory` paginates older events in.  No artificial
	 * cap (we used to slice to the last 200 here, but that capped
	 * how far users could scroll back even after pagination loaded
	 * thousands of older events into the SDK).
	 */
	getRoomMessages(roomId: RoomId): Message[] {
		const room = this.client?.getRoom(roomId);
		if (!room) return [];
		const events = room.getLiveTimeline().getEvents();
		const msgs: Message[] = [];
		for (const event of events) {
			const m = this.eventToMessage(event, room);
			if (m) msgs.push(m);
		}
		return msgs;
	}

	/** All reaction events currently in a room's timeline, oldest first. */
	getRoomReactions(roomId: RoomId): ReactionEvent[] {
		const room = this.client?.getRoom(roomId);
		if (!room) return [];
		const out: ReactionEvent[] = [];
		for (const event of room.getLiveTimeline().getEvents()) {
			if (event.getType() !== "m.reaction") continue;
			if (event.isRedacted()) continue;
			const r = this.eventToReaction(event, room);
			if (r) out.push(r);
		}
		return out;
	}

	/** All flag events currently in a room's timeline, oldest first. */
	getRoomFlags(roomId: RoomId): FlagEventLite[] {
		const room = this.client?.getRoom(roomId);
		if (!room) return [];
		const out: FlagEventLite[] = [];
		for (const event of room.getLiveTimeline().getEvents()) {
			if (event.getType() !== "chat.koven.flag.v1") continue;
			if (event.isRedacted()) continue;
			const f = this.eventToFlag(event, room);
			if (f) out.push(f);
		}
		return out;
	}

	/** All collapse events currently in a room's timeline, oldest first. */
	getRoomCollapses(roomId: RoomId): CollapseEventLite[] {
		const room = this.client?.getRoom(roomId);
		if (!room) return [];
		const out: CollapseEventLite[] = [];
		for (const event of room.getLiveTimeline().getEvents()) {
			if (event.getType() !== "chat.koven.collapse.v1") continue;
			if (event.isRedacted()) continue;
			const c = this.eventToCollapse(event, room);
			if (c) out.push(c);
		}
		return out;
	}

	// ─── Private helpers ────────────────────────────────────────────

	private requireClient(): sdk.MatrixClient {
		if (!this.client) throw new Error("MatrixTransport not started");
		return this.client;
	}

	// emitRoomList / emitSpaceList are called from dozens of Matrix
	// event handlers (timeline, decryption, membership, sync-state,
	// notifications, …).  During the initial-sync burst those fire
	// in tight bursts as Synapse streams rooms in — emitting on every
	// one of them produces a visible cascade where the sidebar pops a
	// room in, then another sorts above it, then another, until the
	// list settles seconds later.  Especially bad for DMs since the
	// "most recent first" sort means every late-arriving room jumps
	// the queue.
	//
	// Fix: rAF-batched debounce.  All emits within a single animation
	// frame collapse into one onRoomsUpdated call.  During steady-state
	// (user is typing, one event comes in) this is effectively zero
	// added latency — one frame, ~16ms.  During the sync burst it's
	// the difference between visible thrash and a clean single pop.
	//
	// Why not setTimeout / a longer debounce window?  Longer waits add
	// perceptible lag to "I just sent a message and the room order
	// updates."  rAF is the lightest possible throttle that still
	// solves the burst-thrash case.
	private roomListEmitPending: number | null = null;
	private spaceListEmitPending: number | null = null;
	private emitRoomList(): void {
		if (this.roomListEmitPending !== null) return;
		this.roomListEmitPending = requestAnimationFrame(() => {
			this.roomListEmitPending = null;
			this.handlers.onRoomsUpdated(this.getRooms());
		});
	}

	private emitSpaceList(): void {
		if (this.spaceListEmitPending !== null) return;
		this.spaceListEmitPending = requestAnimationFrame(() => {
			this.spaceListEmitPending = null;
			this.handlers.onSpacesUpdated(this.getSpaces());
		});
	}

	private sdkRoomToRoom(r: SdkRoom): Room {
		// DM detection — strict.  matrix-js-sdk's `guessDMUserId()` has a
		// fallback that returns the first summaryHero, which means *any*
		// 2-person room gets misidentified as a DM.  Use the canonical
		// Matrix definition instead: a room is a DM iff it's listed
		// under the user's `m.direct` account data.
		const directContent = (this.client?.getAccountData("m.direct")?.getContent() ?? {}) as Record<string, string[]>;
		let dmUserId: string | undefined;
		for (const [user, roomsForUser] of Object.entries(directContent)) {
			if (Array.isArray(roomsForUser) && roomsForUser.includes(r.roomId)) {
				dmUserId = user;
				break;
			}
		}

		// Sender's-side detection during the m.direct sync gap.  When
		// startDm runs, we createRoom + setAccountData("m.direct", …),
		// but the local m.direct cache only updates once /sync echoes
		// the change back — a few hundred ms later.  In that window
		// the sender's UI would render the new DM as a generic private
		// room (no DmProfilePanel, no delete button).  The createRoom
		// call carries is_direct: true, which Synapse stamps onto the
		// invitee's m.room.member event content, so we can read that
		// directly with no round-trip.
		if (!dmUserId) {
			const myUserId = this.creds?.user_id;
			const memberEvents = r.currentState.getStateEvents("m.room.member");
			for (const ev of memberEvents) {
				const sk = ev.getStateKey();
				if (!sk || sk === myUserId) continue;
				const content = ev.getContent();
				if (content?.is_direct === true) {
					dmUserId = sk;
					break;
				}
			}
		}

		// Pending-invite detection.  An invite-state DM won't be in
		// m.direct yet (we add it on accept), but the inviter flagged
		// it is_direct via getDMInviter().  Treat both as DMs so they
		// surface under the DMs tile.
		const myMembership = r.getMyMembership();
		const isInvite = myMembership === "invite";
		const dmInviter = r.getDMInviter() ?? undefined;
		if (!dmUserId && isInvite && dmInviter) dmUserId = dmInviter;

		// Optimistic DM mirror — covers the post-accept and post-
		// startDm window between calling setAccountData("m.direct", …)
		// and the resulting AccountData event echoing back through
		// /sync.  Without this, an accepted DM is briefly misclassified
		// as a private room and lands under the "Rooms" tile, looking
		// to the user like the conversation disappeared.  Cleared in
		// the m.direct AccountData listener once the real map catches
		// up.
		if (!dmUserId) {
			const pending = this.pendingDmMappings.get(r.roomId);
			if (pending) dmUserId = pending;
		}

		const isDm = !!dmUserId;

		const joinRulesEvent = r.currentState.getStateEvents("m.room.join_rules", "");
		const joinRule = joinRulesEvent?.getContent().join_rule;
		const kind: "dm" | "public" | "private" =
			isDm ? "dm" : (joinRule === "public" ? "public" : "private");

		// m.space.parent state events name the spaces this room is in.
		// We trust the room's self-declaration here; broken-link cases
		// (parent declared but space doesn't list room as child) are
		// rare and the UI can still find the room via Home.
		const parentEvents = r.currentState.getStateEvents("m.space.parent");
		const parentSpaceIds: SpaceId[] = [];
		for (const ev of parentEvents) {
			const sk = ev.getStateKey();
			const content = ev.getContent();
			if (sk && content && Array.isArray(content.via) && content.via.length > 0) {
				parentSpaceIds.push(sk as SpaceId);
			}
		}

		// For DMs, the room itself rarely has its own avatar; the
		// natural identity is the other participant's profile picture.
		// Fallback chain (most-specific → most-current):
		//   1. Room-level m.room.avatar
		//   2. Other party's avatar from their room member event
		//      (snapshot of their profile at join time)
		//   3. Other party's live profile avatar (matrix-js-sdk User
		//      object) — catches the case where the peer changed
		//      their avatar AFTER joining, common for bots whose
		//      owner sets the avatar via the bot edit form post-
		//      creation; the join membership event still carries the
		//      old / empty avatar but the live profile has the new one.
		// Without (3) bots whose avatar was set late render with a
		// generic DiceBear fallback in DM lists.
		let avatarUrl = r.getMxcAvatarUrl() ?? undefined;
		if (isDm && !avatarUrl && dmUserId) {
			const other = r.getMember(dmUserId);
			avatarUrl = other?.getMxcAvatarUrl() ?? undefined;
			if (!avatarUrl) {
				const liveUser = this.client?.getUser(dmUserId);
				avatarUrl = liveUser?.avatarUrl ?? undefined;
			}
			if (!avatarUrl) {
				// Final fallback: our own resolved-avatars map.
				// Populated by kickPeerProfileFetch when a previous
				// mapping pass missed.  When this fires, the room
				// list has already been re-emitted with the new
				// avatar in place — we just read it back from the
				// map.
				avatarUrl = this.resolvedPeerAvatars.get(dmUserId) ?? undefined;
			}
			if (!avatarUrl) {
				// Still nothing — kick a one-shot profile fetch.
				// On resolve we write to resolvedPeerAvatars and
				// emitRoomList(), which re-runs this mapping and
				// picks up the avatar in the branch above.
				this.kickPeerProfileFetch(dmUserId);
			}
		}

		// Inviter for non-DM invites — useful for the request UI.
		// matrix-js-sdk doesn't have a non-DM `getInviter`, so we read
		// the membership event directly.  Resolve the display name too
		// so the request UI can show "Cyph3r invited you" instead of
		// the noisy `@koven-admin:koven.chat invited you`.
		let inviter: UserId | undefined;
		let inviterDisplayName: string | undefined;
		if (isInvite) {
			const me = this.creds?.user_id;
			if (me) {
				const ev = r.currentState.getStateEvents("m.room.member", me);
				inviter = (ev?.getSender() ?? undefined) as UserId | undefined;
				if (inviter) {
					// Three places to find the display name, fall through
					// in priority order:
					//   1. Inviter's own profile-as-seen-by-this-room
					//      (the `displayname` they had when they invited
					//       us; lives in our membership event's content).
					//   2. The inviter's m.room.member event in this
					//      room — invitee can read this even pre-join
					//      since invites carry partial state.
					//   3. The SDK's global User cache — populated from
					//      /sync presence + profile fetches.
					const myMemberContent = ev?.getContent() as
						{ displayname?: unknown } | undefined;
					const inviterMember = r.getMember(inviter);
					const inviterUser = this.client?.getUser(inviter);
					const fromMyEvent =
						typeof myMemberContent?.displayname === "string"
							? undefined // displayname here is OURS, not the inviter's
							: undefined;
					void fromMyEvent;
					inviterDisplayName =
						inviterMember?.name
						?? inviterUser?.displayName
						?? undefined;
				}
			}
		}

		// Federation: room id format is `!localpart:server`.  The host
		// after the colon tells us which homeserver hosts the room.
		// Matching against our own user id's host tells us whether the
		// engine's moderation has any reach here.
		const colon = r.roomId.indexOf(":");
		const homeserver = colon === -1 ? "" : r.roomId.slice(colon + 1);
		const localServer = this.serverName();
		const isFederated = !!homeserver && !!localServer && homeserver !== localServer;

		// My power level in the room — undefined for invites since we
		// don't have member state for ourselves until we join.
		let myPowerLevel: number | undefined;
		const myUserId = this.creds?.user_id;
		if (myUserId && !isInvite) {
			myPowerLevel = r.getMember(myUserId)?.powerLevel ?? 0;
		}

		// Sender of the m.room.create event — the canonical "creator."
		// Drives the Leave-vs-Delete affordance: creators must Delete,
		// everyone else Leaves.  matrix-js-sdk has `getCreator()` but
		// some older versions don't, so read the state event directly
		// for portability.
		const createEvent = r.currentState.getStateEvents("m.room.create", "");
		const creatorId = (createEvent?.getSender() ?? undefined) as UserId | undefined;

		// DM presence — same 3-bucket model the member list uses.  We
		// peek at the SDK's User object directly (rather than walking
		// per-room members) because the room view of presence updates
		// lags by a sync; UserEvent.Presence updates land here first.
		let dmPresence: "online" | "unavailable" | "offline" | undefined;
		if (isDm && dmUserId) {
			const u = this.client?.getUser(dmUserId);
			if (u) {
				if (u.presence === "online") {
					dmPresence = u.currentlyActive ? "online" : "unavailable";
				} else if (u.presence === "unavailable") {
					dmPresence = "unavailable";
				} else {
					dmPresence = "offline";
				}
			}
		}

		return {
			id: r.roomId as RoomId,
			name: r.name || dmUserId || r.roomId,
			topic: r.currentState.getStateEvents("m.room.topic", "")?.getContent().topic,
			// Raw mxc:// — UI components fetch via getMxcBlobUrl().
			avatarUrl,
			iconEmoji: readKovenIconEmoji(r),
			kind,
			memberCount: r.getJoinedMemberCount(),
			// Source of truth: matrix-js-sdk's per-room counters.
			// markAsRead zeroes them locally via
			// setUnreadNotificationCount BEFORE the receipt round-
			// trips, so by the time this mapping runs after a
			// mark-as-read call, the count is already 0.  Element
			// uses this exact pattern.
			unreadCount: r.getUnreadNotificationCount(NotificationCountType.Total) ?? 0,
			highlightCount: r.getUnreadNotificationCount(NotificationCountType.Highlight) ?? 0,
			encrypted: r.hasEncryptionStateEvent(),
			parentSpaceIds,
			dmUserId: isDm ? (dmUserId as UserId | undefined) : undefined,
			dmPresence,
			isInvite: isInvite || undefined,
			inviter,
			inviterDisplayName,
			homeserver,
			isFederated,
			myPowerLevel,
			creatorId,
			nsfw: readKovenNsfw(r),
			liveEnabled: readKovenLiveEnabled(r),
		};
	}

	private eventToCollapse(event: MatrixEvent, room: SdkRoom): CollapseEventLite | null {
		if (event.isRedacted()) return null;
		const content = event.getContent() as any;
		const targetEventId = content?.target_event_id as string | undefined;
		if (!targetEventId) return null;
		const eventId = event.getId();
		if (!eventId) return null;
		return {
			eventId: eventId as EventId,
			roomId: room.roomId as RoomId,
			targetEventId: targetEventId as EventId,
			flaggerCount: typeof content.flaggers === "object" && Array.isArray(content.flaggers)
				? content.flaggers.length
				: (typeof content.threshold_users === "number" ? content.threshold_users : 0),
			weightedScore: typeof content.weighted_score === "number" ? content.weighted_score : 0,
			categories: Array.isArray(content.categories) ? (content.categories as string[]) : [],
			timestamp: typeof content.timestamp === "number" ? content.timestamp : event.getTs(),
			fastTrack: !!content.fast_track,
		};
	}

	private eventToFlag(event: MatrixEvent, room: SdkRoom): FlagEventLite | null {
		if (event.isRedacted()) return null;
		const content = event.getContent() as any;
		const targetEventId = content?.target_event_id as string | undefined;
		const category = content?.category as FlagCategory | undefined;
		if (!targetEventId || !category) return null;
		const sender = event.getSender();
		const eventId = event.getId();
		if (!sender || !eventId) return null;
		return {
			eventId: eventId as EventId,
			roomId: room.roomId as RoomId,
			targetEventId: targetEventId as EventId,
			category,
			sender: sender as UserId,
			rationale: content?.rationale as string | undefined,
		};
	}

	private eventToReaction(event: MatrixEvent, room: SdkRoom): ReactionEvent | null {
		if (event.isRedacted()) return null;
		const content = event.getContent() as any;
		const relatesTo = content?.["m.relates_to"];
		if (!relatesTo || relatesTo.rel_type !== "m.annotation") return null;
		if (!relatesTo.event_id || !relatesTo.key) return null;
		const sender = event.getSender();
		const eventId = event.getId();
		if (!sender || !eventId) return null;
		return {
			eventId: eventId as EventId,
			roomId: room.roomId as RoomId,
			targetEventId: relatesTo.event_id as EventId,
			key: relatesTo.key as string,
			sender: sender as UserId,
		};
	}

	// MSC3381 has both stable + unstable namespaces.  The content lives
	// under one of two top-level keys depending on whether the sender
	// is on the stable spec; we accept either.  Same trick the Element
	// codebase uses.
	private pollContent(content: any): any {
		return content?.["m.poll.start"]
			?? content?.["org.matrix.msc3381.poll.start"]
			?? content?.["m.poll.response"]
			?? content?.["org.matrix.msc3381.poll.response"]
			?? content?.["m.poll.end"]
			?? content?.["org.matrix.msc3381.poll.end"]
			// Some senders inline the spec fields at the top level.
			?? content;
	}

	private eventToPollMessage(event: MatrixEvent, room: SdkRoom): Message | null {
		if (event.isRedacted()) return null;
		const content = event.getContent() as any;
		const pollBody = this.pollContent(content);
		const question = pollBody?.question?.["m.text"]
			?? pollBody?.question?.body
			?? "";
		const answersRaw = pollBody?.answers;
		if (!Array.isArray(answersRaw) || answersRaw.length < 2) return null;
		const answers = answersRaw
			.map((a: any) => ({
				id: typeof a?.id === "string" ? a.id : "",
				text: a?.["m.text"] ?? a?.text ?? a?.body ?? "",
			}))
			.filter((a: { id: string; text: string }) => a.id && a.text);
		if (answers.length < 2) return null;
		const sender = event.getSender();
		const eventId = event.getId();
		const ts = event.getTs();
		if (!sender || !eventId) return null;
		const member = room.getMember(sender);
		const myUserId = this.client?.getUserId() ?? null;
		const pollKind: "disclosed" | "undisclosed" =
			(pollBody?.kind === "m.poll.undisclosed"
				|| pollBody?.kind === "org.matrix.msc3381.poll.undisclosed")
				? "undisclosed"
				: "disclosed";
		const maxSelections = Math.max(1, Math.min(answers.length,
			parseInt(String(pollBody?.max_selections ?? "1"), 10) || 1));
		// Auto-close timestamp — our extension; absent on polls created
		// by spec-only clients (Element) and on Koven polls explicitly
		// set to "no limit."
		const endsAtRaw = pollBody?.["chat.koven.poll.ends_at"];
		const endsAt = typeof endsAtRaw === "number" && Number.isFinite(endsAtRaw)
			? endsAtRaw
			: undefined;
		return {
			id: eventId as EventId,
			roomId: room.roomId as RoomId,
			sender: sender as UserId,
			senderDisplayName: member?.name ?? sender,
			timestamp: ts,
			text: question,
			kind: "poll",
			isSelf: !!myUserId && myUserId === sender,
			poll: {
				question,
				answers,
				kind: pollKind,
				maxSelections,
				endsAt,
			},
		};
	}

	private eventToPollResponse(event: MatrixEvent, room: SdkRoom): PollResponseEvent | null {
		if (event.isRedacted()) return null;
		const content = event.getContent() as any;
		const relatesTo = content?.["m.relates_to"];
		const pollId = relatesTo?.event_id as string | undefined;
		if (!pollId) return null;
		const body = this.pollContent(content);
		const answers = Array.isArray(body?.answers) ? body.answers : [];
		const answerIds = answers
			.filter((id: any) => typeof id === "string")
			.map((id: string) => id);
		const sender = event.getSender();
		const eventId = event.getId();
		if (!sender || !eventId) return null;
		return {
			eventId: eventId as EventId,
			roomId: room.roomId as RoomId,
			pollId: pollId as EventId,
			voter: sender as UserId,
			answerIds,
			timestamp: event.getTs(),
		};
	}

	private eventToPollEnd(event: MatrixEvent, room: SdkRoom): PollEndEvent | null {
		if (event.isRedacted()) return null;
		const content = event.getContent() as any;
		const relatesTo = content?.["m.relates_to"];
		const pollId = relatesTo?.event_id as string | undefined;
		if (!pollId) return null;
		const sender = event.getSender();
		const eventId = event.getId();
		if (!sender || !eventId) return null;
		// Some senders ship final tallies in the end event itself
		// (especially for undisclosed polls).  Forward them when
		// present; otherwise the consumer falls back to live counts.
		const results = content?.["org.matrix.msc3381.poll.results"]
			?? content?.["m.poll.results"];
		const finalCounts = results && typeof results === "object"
			? Object.fromEntries(
				Object.entries(results)
					.filter(([, v]) => typeof v === "number")
					.map(([k, v]) => [k, v as number]),
			)
			: undefined;
		return {
			eventId: eventId as EventId,
			roomId: room.roomId as RoomId,
			pollId: pollId as EventId,
			endedBy: sender as UserId,
			timestamp: event.getTs(),
			finalCounts,
		};
	}

	/**
	 * Type-routes a Matrix event into the right handler.  Called from
	 * both the Timeline listener (cleartext path) and the Decrypted
	 * listener (after rust-crypto resolves an m.room.encrypted into
	 * its actual type).  Centralizing the routing means encrypted
	 * reactions/flags/redactions/messages all reach the same code
	 * path as their cleartext counterparts — no double-listing of
	 * type checks, no encrypted-only paths going stale.
	 */
	private routeDecryptedEvent(event: MatrixEvent, room: SdkRoom, live: boolean): void {
		const type = event.getType();

		// m.replace edit on a message: matrix-js-sdk's relations engine
		// has (by the time we get here) already merged the edit into
		// the original event's content, so calling getContent() on the
		// ORIGINAL now returns m.new_content.  But our App-side
		// message list still holds the pre-edit Message snapshot —
		// nothing re-renders unless we explicitly push the original
		// back through onMessage.  Find the target id, look it up in
		// the live timeline, and re-route it (skipping the edit event
		// itself, which would otherwise spawn a duplicate "*body" row).
		// Bots use this for progressive status updates, so without
		// this path the placeholder freezes on its initial body and
		// nothing updates until the final reply lands.
		if (type === "m.room.message") {
			const c = event.getContent() as { "m.relates_to"?: { rel_type?: unknown; event_id?: unknown } };
			const rel = c["m.relates_to"];
			if (rel?.rel_type === "m.replace" && typeof rel.event_id === "string") {
				const target = room.findEventById(rel.event_id);
				if (target) {
					// Re-emit immediately if the relations engine has
					// already merged the edit into the target (the
					// common case — relations.js runs before the
					// Timeline event reaches us).
					const refreshed = this.eventToMessage(target, room);
					if (refreshed) this.handlers.onMessage(refreshed, { live });
					// Belt-and-suspenders: also subscribe to the
					// target's Replaced event in case the merge runs
					// LATER on this tick or later (rare, but observed
					// during initial sync when many edits land at
					// once).  `once` makes this self-cleaning.
					target.once(MatrixEventEvent.Replaced, () => {
						const r2 = this.eventToMessage(target, room);
						if (r2) this.handlers.onMessage(r2, { live });
					});
				}
				return;
			}
		}

		// Reactions flow on a separate channel — we don't render them
		// as chat messages, the App reducer aggregates them per
		// target message and the UI shows them as pills.
		if (type === "m.reaction") {
			const r = this.eventToReaction(event, room);
			if (r) this.handlers.onReaction(r, { live });
			return;
		}

		// Poll responses + ends flow as their own events; the start
		// event (m.poll.start) IS a message and falls through to
		// eventToMessage below.  Both stable + unstable MSC3381
		// prefixes — Element/SchildiChat still send the unstable form.
		if (type === "m.poll.response" || type === "org.matrix.msc3381.poll.response") {
			const r = this.eventToPollResponse(event, room);
			if (r) this.handlers.onPollResponse(r, { live });
			return;
		}
		if (type === "m.poll.end" || type === "org.matrix.msc3381.poll.end") {
			const e = this.eventToPollEnd(event, room);
			if (e) this.handlers.onPollEnd(e, { live });
			return;
		}

		// Flags travel as their own custom event type.  Same model as
		// reactions: aggregate client-side, render as a pill.
		if (type === "chat.koven.flag.v1") {
			const f = this.eventToFlag(event, room);
			if (f) this.handlers.onFlag(f, { live });
			return;
		}

		// Collapse events emitted by the engine — one per message
		// that's been collapsed by community review.
		if (type === "chat.koven.collapse.v1") {
			const c = this.eventToCollapse(event, room);
			if (c) this.handlers.onCollapse(c, { live });
			return;
		}

		// Redactions can target reactions, flags, or messages.  We
		// dispatch to both reaction- and flag-redaction handlers
		// because we don't know which target type is being struck;
		// the reducers no-op if the id isn't in their map.
		//
		// Pre-v11 rooms carry the target in `event.redacts`; v11+
		// moves it into `content.redacts`.  Check both — Synapse
		// 1.100+ defaults to v11 so newer rooms hit the second path.
		if (type === "m.room.redaction") {
			const ev = event.event as any;
			const content = event.getContent() as any;
			const redactedId =
				(typeof ev.redacts === "string" ? ev.redacts : undefined) ??
				(typeof content?.redacts === "string" ? content.redacts : undefined);
			if (redactedId) {
				// Dispatch to all three target-type reducers in parallel:
				// we don't know whether the redaction targets a message,
				// a reaction, or a flag, and the reducers each no-op if
				// the id isn't in their map.  Without the message-side
				// dispatch the bubble would stay rendered until the user
				// refreshed (matrix-js-sdk applies the redaction to its
				// internal event copy, but our local message-list
				// snapshot is what actually drives the timeline render).
				this.handlers.onMessageRedacted(room.roomId as RoomId, redactedId as EventId);
				this.handlers.onReactionRedacted(room.roomId as RoomId, redactedId as EventId);
				this.handlers.onFlagRedacted(room.roomId as RoomId, redactedId as EventId);
			}
			return;
		}

		const msg = this.eventToMessage(event, room);
		if (msg) this.handlers.onMessage(msg, { live });
	}

	private eventToMessage(event: MatrixEvent, room: SdkRoom): Message | null {
		const type = event.getType();
		// Skip non-message events at this layer.  Governance events
		// and call-signaling events flow through their own channels
		// (or are filtered out entirely); state events aren't surfaced
		// as chat at all.  We don't accept "m.room.encrypted" here —
		// the Timeline listener defers encrypted events until the
		// Decrypted listener fires, by which point getType() returns
		// the cleartext type.
		// Poll-start events become messages too — they don't carry an
		// m.room.message type, so route them through a dedicated path
		// that lifts the question + answers into the Message.poll
		// field.  Keeps the rest of the Message pipeline (timeline
		// ordering, redaction, etc.) reusable for polls.
		if (type === "m.poll.start" || type === "org.matrix.msc3381.poll.start") {
			return this.eventToPollMessage(event, room);
		}
		if (type !== "m.room.message") return null;
		if (event.isRedacted()) return null;

		// Drop m.replace edit events — they're the *edit*, not the
		// edited message.  The original event's getContent() returns
		// the latest m.new_content (matrix-js-sdk merges edits server-
		// side, see makeReplaced in event.js), so the original row
		// already shows the post-edit body; rendering the edit event
		// itself would surface a duplicate "* new body" line in the
		// timeline.  Bots use this for progressive status updates
		// ("Thinking…" → "calling search_web…" → answer); without
		// the filter every status change posts as its own bubble.
		const rawContent = event.getContent() as { "m.relates_to"?: { rel_type?: unknown } };
		if (rawContent["m.relates_to"]?.rel_type === "m.replace") return null;

		const content = event.getContent() as any;
		const sender = event.getSender();
		if (!sender) return null;

		const member = room.getMember(sender);
		const displayName = member?.name ?? sender;

		// Decryption failures: matrix-js-sdk leaves the event in the
		// timeline with content.body set to a raw error string like
		// "** Unable to decrypt: DecryptionError: This message was sent
		// before this device logged in, and key backup is not working. **".
		// Replace with a clean placeholder so the user gets a calm
		// "🔒 …" bubble instead of an alarming wall of stack-trace-ish
		// text.  The renderer dims the bubble (decryptionFailed flag)
		// so it reads as system metadata rather than a real chat
		// message.  We also surface the SDK's specific failure code
		// so the renderer can pick a per-reason explanation — opaque
		// "Couldn't decrypt" tells the user nothing about whether to
		// wait, log in elsewhere, or accept it's gone.
		const decryptionFailed = typeof event.isDecryptionFailure === "function"
			? event.isDecryptionFailure()
			: false;
		const decryptionFailureReason: string | undefined = decryptionFailed
			? ((event as unknown as { decryptionFailureReason?: string | null }).decryptionFailureReason ?? undefined)
			: undefined;

		const msgtype = content.msgtype as string | undefined;
		let kind: MessageKind = "text";
		let mediaMxc: string | undefined;
		let mediaMimeType: string | undefined;
		let mediaName: string | undefined;
		let mediaSize: number | undefined;
		let mediaWidth: number | undefined;
		let mediaHeight: number | undefined;
		let mediaEncrypted: import("@koven/shared").MediaEncryption | undefined;
		let mediaDurationMs: number | undefined;
		let mediaThumbMxc: string | undefined;
		let mediaThumbMimeType: string | undefined;
		let mediaThumbWidth: number | undefined;
		let mediaThumbHeight: number | undefined;
		let mediaThumbEncrypted: import("@koven/shared").MediaEncryption | undefined;
		let text = decryptionFailed
			? formatDecryptionFailure(decryptionFailureReason)
			: (content.body as string | undefined) ?? "";
		let caption: string | undefined;

		const mediaKind: MessageKind | null =
			msgtype === "m.image" ? "image" :
			msgtype === "m.video" ? "video" :
			msgtype === "m.audio" ? "audio" :
			msgtype === "m.file"  ? "file"  : null;

		if (msgtype === "m.emote")  kind = "emote";
		else if (msgtype === "m.notice") kind = "notice";
		else if (mediaKind) {
			kind = mediaKind;
			// Encrypted-room media events use `file: { url, key, iv, ... }`
			// where `url` points at the ciphertext on the homeserver.
			// Plaintext rooms use a top-level `url` directly.  Either
			// way we capture the mxc plus any encryption metadata; the
			// transport's getAttachmentBlobUrl handles the fetch path.
			const enc = content.file as import("@koven/shared").MediaEncryption | undefined;
			if (enc?.url) {
				mediaMxc = enc.url;
				mediaEncrypted = enc;
			} else {
				mediaMxc = content.url as string | undefined;
			}
			const info = content.info as Record<string, unknown> | undefined;
			mediaMimeType = info?.mimetype as string | undefined;
			mediaSize = info?.size as number | undefined;
			mediaWidth = info?.w as number | undefined;
			mediaHeight = info?.h as number | undefined;
			// Duration: m.video / m.audio carry it in info.duration (ms).
			// Lenient cast — some clients send a string; we want a number
			// for math, so reject NaN-shaped values and leave undefined.
			const rawDuration = info?.duration;
			if (typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration > 0) {
				mediaDurationMs = rawDuration;
			}
			// Poster thumbnail.  Mirrors the main media's encryption
			// shape: encrypted rooms put the AES-CTR keys + ciphertext
			// mxc into info.thumbnail_file; plaintext rooms put a bare
			// mxc into info.thumbnail_url.  Either way we surface it via
			// the mediaThumb* fields so the renderer can use it as the
			// <video poster> instead of the WKWebView black square that
			// `<video preload="metadata">` paints.
			const tEnc = info?.thumbnail_file as import("@koven/shared").MediaEncryption | undefined;
			if (tEnc?.url) {
				mediaThumbMxc = tEnc.url;
				mediaThumbEncrypted = tEnc;
			} else if (typeof info?.thumbnail_url === "string") {
				mediaThumbMxc = info.thumbnail_url;
			}
			const tInfo = info?.thumbnail_info as Record<string, unknown> | undefined;
			if (tInfo) {
				mediaThumbMimeType = tInfo.mimetype as string | undefined;
				mediaThumbWidth = typeof tInfo.w === "number" ? tInfo.w : undefined;
				mediaThumbHeight = typeof tInfo.h === "number" ? tInfo.h : undefined;
			}
			// MSC2530: when a media event carries an explicit `filename`
			// field, `body` is the caption and `filename` is the real
			// filename.  Absent `filename`, `body` IS the filename
			// (the legacy/default path Matrix clients have always used).
			//
			// We use this to let users send an image with attached
			// text: the composer's draft goes into body (caption), the
			// File.name goes into filename.  Receivers that don't know
			// about MSC2530 still read body as the message text — which
			// is the right fallback (caption beats a raw IMG_1234.jpg).
			const filenameField = typeof content.filename === "string" ? content.filename : undefined;
			if (filenameField && filenameField !== text) {
				// MSC2530 form: body is the caption.
				mediaName = filenameField;
				caption = text;
			} else {
				// Legacy form: body is the filename.
				mediaName = text || undefined;
			}
			// Media kinds carry their text payload in `caption`, not
			// `text` — the latter is reserved for plain message bodies.
			// Renderer paths fork on `kind`, so blanking `text` here
			// keeps the contract clean and avoids double-rendering.
			text = "";
		}

		// Replies: extract the m.in_reply_to relation and look up the
		// original message in the timeline so we can show its sender +
		// snippet inline above the new bubble.  The body of a reply
		// from Matrix clients includes a "> <@user> original" fallback
		// quote that we strip — the UI shows the quote separately.
		let replyTo: Message["replyTo"] | undefined;
		const inReplyTo = content?.["m.relates_to"]?.["m.in_reply_to"];
		if (inReplyTo?.event_id) {
			const targetId = inReplyTo.event_id as EventId;
			const target = room.findEventById(targetId);
			if (target && !target.isRedacted()) {
				const targetSender = (target.getSender() ?? "") as UserId;
				const targetMember = room.getMember(targetSender);
				const rawBody = ((target.getContent() as any)?.body as string | undefined) ?? "";
				const snippet = rawBody.length > 100 ? rawBody.slice(0, 100) + "…" : rawBody;
				replyTo = {
					eventId: targetId,
					sender: targetSender,
					senderDisplayName: targetMember?.name ?? targetSender,
					snippet,
				};
			} else {
				replyTo = {
					eventId: targetId,
					sender: "" as UserId,
					senderDisplayName: "(message)",
					snippet: "",
				};
			}
			text = stripReplyFallback(text);
		}

		// Pending = anything matrix-js-sdk hasn't confirmed as live
		// timeline yet.  EventStatus is non-null for SENDING /
		// ENCRYPTING / QUEUED / NOT_SENT / CANCELLED — all states
		// where the event id is the SDK's local-echo synthetic
		// (typically `~`-prefixed) rather than a real homeserver
		// event id.  Server-side actions (redact, react, flag) keyed
		// on this id will 404; UI gates them off via this flag.
		// Belt-and-suspenders: we also accept ids that literally
		// start with `~` in case the SDK clears status before the id
		// is replaced (which we've seen happen on flaky networks).
		const sdkStatus = event.status; // null when fully sent
		const eventId = event.getId();
		const pending = sdkStatus !== null || (typeof eventId === "string" && eventId.startsWith("~"));

		return {
			id: eventId as EventId,
			roomId: room.roomId as RoomId,
			sender: sender as UserId,
			senderDisplayName: displayName,
			timestamp: event.getTs(),
			text,
			kind,
			isSelf: sender === this.currentUserId,
			mediaMxc,
			mediaMimeType,
			mediaName,
			mediaSize,
			mediaWidth,
			mediaHeight,
			mediaEncrypted,
			caption,
			edited: !!event.replacingEvent(),
			replyTo,
			pending,
			decryptionFailed: decryptionFailed || undefined,
			decryptionFailureReason,
			mediaDurationMs,
			mediaThumbMxc,
			mediaThumbMimeType,
			mediaThumbWidth,
			mediaThumbHeight,
			mediaThumbEncrypted,
		};
	}

}

/**
 * Strip the "> <@user:server> body" reply fallback prefix that
 * Matrix clients prepend to a reply's body for non-rich clients.
 * The leading lines are recognizable: each starts with "> ", and the
 * block ends with a blank line.
 */
/** Build the device label written to Synapse so the Sessions list
 * tells Web / Desktop / Mobile sessions apart.  Detects the platform
 * from the same signals other parts of the SPA use:
 *   - `__KOVEN_DESKTOP__` window flag (set by the Tauri shell init)
 *   - `mobile-shell` class on <html> (set by the Tauri mobile shell
 *     init script before any SPA JS runs)
 *   - Falls back to "Koven Web" with a small browser hint so two
 *     browser sessions on the same OS read distinguishably. */
async function computeDeviceLabel(): Promise<string> {
	if (typeof window !== "undefined"
		&& (window as { __KOVEN_DESKTOP__?: boolean }).__KOVEN_DESKTOP__ === true
	) {
		return `Koven Desktop${osHint()}`;
	}
	if (typeof document !== "undefined"
		&& document.documentElement.classList.contains("mobile-shell")
	) {
		return `Koven Mobile${osHint()}`;
	}
	return `Koven Web${await browserHint()}`;
}

function osHint(): string {
	const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
	if (/Mac OS X/.test(ua)) return " (macOS)";
	if (/Windows/.test(ua)) return " (Windows)";
	if (/Android/.test(ua)) return " (Android)";
	if (/iPhone|iPad|iPod/.test(ua)) return " (iOS)";
	if (/Linux/.test(ua)) return " (Linux)";
	return "";
}

async function browserHint(): Promise<string> {
	// Brave actively strips itself from navigator.userAgent — UA
	// sniffing always reports Chrome.  Their feature-detection API
	// `navigator.brave.isBrave()` is the only reliable signal,
	// asynchronous, and present only on Brave.  Probe it first; fall
	// through to UA-based brand sniffing for everything else.
	const nav = typeof navigator !== "undefined"
		? (navigator as Navigator & { brave?: { isBrave?(): Promise<boolean> } })
		: undefined;
	if (nav?.brave?.isBrave) {
		try {
			if (await nav.brave.isBrave()) return " (Brave)";
		} catch {
			// Treat probe failure as "not Brave" — UA sniff below.
		}
	}
	const ua = nav?.userAgent ?? "";
	// Order matters — many of these include the upstream brand
	// string further along.  Edg / Arc are checked before Chrome
	// because their UA includes the Chrome brand too.
	if (/Edg\//.test(ua)) return " (Edge)";
	if (/Arc\//i.test(ua)) return " (Arc)";
	if (/Firefox/.test(ua)) return " (Firefox)";
	if (/Chrome/.test(ua)) return " (Chrome)";
	if (/Safari/.test(ua)) return " (Safari)";
	return "";
}

/** Crypto-random URL-safe id used as MSC3381 answer ids on outbound
 * polls.  16 hex chars (~64 bits) is more than enough to avoid
 * collisions across federated participants while staying short
 * enough to read in raw event JSON when debugging. */
function cryptoRandomId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Map a matrix-js-sdk DecryptionFailureCode to the placeholder text
 * we render in the timeline.  Specific reasons get specific guidance
 * — opaque "Couldn't decrypt" tells the user nothing about whether
 * the message will heal, whether they should log in elsewhere, or
 * whether it's gone forever.
 *
 * Reason codes come from
 * matrix-js-sdk/src/crypto-api/index.ts → DecryptionFailureCode.  We
 * accept `string | undefined` to stay loose against SDK changes —
 * unrecognized codes fall through to the generic message rather than
 * crashing the timeline. */
function formatDecryptionFailure(reason: string | undefined): string {
	switch (reason) {
		case "MEGOLM_UNKNOWN_INBOUND_SESSION_ID":
			// Most common case: sender's megolm key never reached this
			// device.  Rust crypto auto-requests it from the sender's
			// other devices and from key backup; usually heals within
			// a few seconds if the sender is online.  Worded so the
			// user knows to wait, not retry.
			return "🔒 Waiting for the sender's key…";
		case "MEGOLM_KEY_WITHHELD":
			return "🔒 The sender's app refused to share the key for this message.";
		case "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE":
			// Sender's policy: only share with verified devices.  Tell
			// the user the actionable fix rather than the protocol
			// detail — verifying happens via the Sessions sheet on a
			// second device they're already logged into.
			return "🔒 Verify this device on your other login to read this message.";
		case "HISTORICAL_MESSAGE_NO_KEY_BACKUP":
		case "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED":
			// Sent before this device existed AND no backup is
			// reachable — the message is permanently lost on this
			// device.  Honest framing beats false hope of an eventual
			// retry.
			return "🔒 Sent before this device — no backup available.";
		case "HISTORICAL_MESSAGE_WORKING_BACKUP":
			// Sent before this device existed but backup IS working —
			// rust-crypto is fetching from /room_keys; will heal once
			// the session arrives.
			return "🔒 Restoring from backup…";
		case "HISTORICAL_MESSAGE_USER_NOT_JOINED":
			return "🔒 You weren't in the room when this was sent.";
		case "SENDER_IDENTITY_PREVIOUSLY_VERIFIED":
		case "UNSIGNED_SENDER_DEVICE":
		case "UNKNOWN_SENDER_DEVICE":
			return "🔒 Sender's identity couldn't be verified.";
		default:
			return "🔒 Couldn't decrypt this message";
	}
}

function stripReplyFallback(body: string): string {
	const lines = body.split("\n");
	let cut = 0;
	while (cut < lines.length && lines[cut]!.startsWith("> ")) cut++;
	while (cut < lines.length && lines[cut] === "") cut++;
	return lines.slice(cut).join("\n");
}

/**
 * Read the Koven-custom `chat.koven.room_icon` state event and pull
 * out a single emoji glyph, if any.  Returns undefined when the event
 * is absent / cleared (empty content) / malformed.  We sanity-check
 * the value to a reasonable length (16 chars covers ZWJ-joined emoji
 * sequences like 👨‍👩‍👧‍👦) so a malicious sender can't dump prose into
 * the field.
 */
/** True for membership states that should keep the room visible in
 * the user's list.  "leave" / "ban" rooms still live in matrix-js-sdk's
 * store after a leave + forget cycle for a brief window; this gate
 * makes sure they don't render as ghost rooms with no members. */
function isLiveMembership(m: string | null): boolean {
	return m === "join" || m === "invite";
}

// Event types we treat as "the user said something" for room-list
// sort-by-recency.  Anything outside this set (state events, receipts,
// engine-driven membership churn, etc.) is excluded so quiet rooms
// don't bubble to the top whenever the engine pokes at them.
const MESSAGE_LIKE_TYPES = new Set([
	"m.room.message",
	"m.room.encrypted",
	"m.sticker",
	"m.poll.start",
	"org.matrix.msc3381.poll.start",
	"m.call.invite",
]);

/** Walk the live timeline from the tail and return the timestamp of
 * the most recent message-shaped event, or 0 when none exist (room
 * has only state activity, never a real message).
 *
 * Cheap in the steady state: the last event in an active conversation
 * IS a message, so the loop exits on the first iteration.  Worst case
 * is a chatty room whose tail has a long burst of state churn (e.g.
 * an admin renaming + re-iconing in a row); we walk back through the
 * burst and stop at the first real message.  Bounded above by the
 * live timeline's natural length (matrix-js-sdk caps it; older
 * messages live in paginated chunks not in scope here). */
function lastMessageTs(r: SdkRoom | null | undefined): number {
	if (!r) return 0;
	const events = r.getLiveTimeline().getEvents();
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (!ev) continue;
		if (MESSAGE_LIKE_TYPES.has(ev.getType())) return ev.getTs();
	}
	return 0;
}

function readKovenIconEmoji(r: SdkRoom): string | undefined {
	const ev = r.currentState.getStateEvents("chat.koven.room_icon", "");
	if (!ev) return undefined;
	const content = ev.getContent() as { emoji?: unknown };
	if (typeof content.emoji !== "string") return undefined;
	const trimmed = content.emoji.trim();
	if (!trimmed) return undefined;
	if (trimmed.length > 16) return undefined;
	return trimmed;
}

// Read the room's NSFW flag from its `chat.koven.nsfw` state event.
// Empty content (the canonical "cleared" form) reads as false.
// Anything but `enabled: true` also reads as false — defensive
// against a malformed write.
function readKovenNsfw(r: SdkRoom): boolean {
	const ev = r.currentState.getStateEvents("chat.koven.nsfw", "");
	if (!ev) return false;
	const content = ev.getContent() as { enabled?: unknown };
	return content.enabled === true;
}

// Read whether the per-room Live channel (voice/video) is enabled.
// State event: `chat.koven.live` with content `{ enabled: bool }`.
// **Default true** — absence of the event means voice is on
// (Discord-shape baseline; admins explicitly turn it off for
// rooms where voice would be noise like #announcements or
// #report-a-bug).  Anything other than `enabled: false` reads as
// true — defensive against partial writes.
function readKovenLiveEnabled(r: SdkRoom): boolean {
	const ev = r.currentState.getStateEvents("chat.koven.live", "");
	if (!ev) return true;
	const content = ev.getContent() as { enabled?: unknown };
	return content.enabled !== false;
}

/**
 * Best-effort image dimension probe.  Loads the file into an off-DOM
 * <img> via an object URL and reads natural width/height once decoded.
 * Resolves to null on any failure (decode error, non-image input,
 * load timeout) so callers can omit the `info.w`/`info.h` fields
 * rather than fail the upload.
 */
async function readImageDimensions(
	file: File,
): Promise<{ width: number; height: number } | null> {
	if (typeof window === "undefined" || !window.URL?.createObjectURL) return null;
	const url = URL.createObjectURL(file);
	try {
		return await new Promise<{ width: number; height: number } | null>((resolve) => {
			const img = new Image();
			img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
			img.onerror = () => resolve(null);
			img.src = url;
		});
	} finally {
		URL.revokeObjectURL(url);
	}
}

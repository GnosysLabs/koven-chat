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
import { ClientEvent, MatrixEventEvent, RoomEvent, RoomMemberEvent } from "matrix-js-sdk";
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
 */
async function wipeRustCryptoIndexedDB(): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const names = ["matrix-js-sdk::matrix-sdk-crypto", "matrix-js-sdk::matrix-sdk-crypto-meta"];
	await Promise.all(names.map(name => new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(name);
		req.onsuccess = () => resolve();
		// Best-effort: in private-browsing modes deleteDatabase can
		// error or block; either way we let the retry through and
		// surface any real failure on the second initRustCrypto call.
		req.onerror = () => resolve();
		req.onblocked = () => resolve();
	})));
}

export interface MatrixHandlers {
	onSyncState(state: SyncState): void;
	onRoomsUpdated(rooms: Room[]): void;
	onSpacesUpdated(spaces: Space[]): void;
	onMessage(msg: Message, options: { live: boolean }): void;
	onReaction(reaction: ReactionEvent, options: { live: boolean }): void;
	onReactionRedacted(roomId: RoomId, reactionEventId: EventId): void;
	onFlag(flag: FlagEventLite, options: { live: boolean }): void;
	onFlagRedacted(roomId: RoomId, flagEventId: EventId): void;
	onCollapse(collapse: CollapseEventLite, options: { live: boolean }): void;
	onMembersUpdated(roomId: RoomId): void;
	// Fires when a remote party rings us.  The caller in App.tsx
	// renders the incoming-call sheet; accept/decline drives the
	// MatrixCall directly.  Only one inbound call is surfaced at a
	// time (the SDK suppresses overlapping invites for the same room).
	onIncomingCall(call: MatrixCall): void;
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

/**
 * Register a new account on the configured homeserver, then return the
 * credentials Synapse responds with (so we can sign the user straight
 * in — no separate login step).
 *
 * Synapse's registration uses User-Interactive Authentication: the
 * first POST returns 401 with a `flows` list and a `session` id; we
 * re-POST with `auth: { type: "m.login.dummy", session }` to satisfy
 * the trivial flow Synapse advertises in dev.  For production we'd
 * need captcha + email/ToS stages here too.
 */
export async function registerWithPassword(
	homeserver: string,
	username: string,
	password: string,
): Promise<MatrixCredentials> {
	const url = `${homeserver}/_matrix/client/v3/register`;
	const baseBody = {
		username,
		password,
		initial_device_display_name: "Koven Web",
		inhibit_login: false,
	};

	// Step 1: probe for the auth flow + session id.  We expect 401 here.
	const probe = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(baseBody),
	});
	const probeJson = await probe.json().catch(() => ({})) as Record<string, unknown>;
	if (probe.ok) {
		// Some servers register without UIA at all — accept the response.
		return registerJsonToCreds(probeJson, homeserver);
	}
	if (probe.status !== 401) {
		throw new Error(messageFromMatrixError(probeJson, `register failed (${probe.status})`));
	}

	const session = probeJson["session"] as string | undefined;
	const flows = probeJson["flows"] as Array<{ stages: string[] }> | undefined;
	if (!session || !flows?.length) {
		throw new Error("Registration auth flow missing session or flows");
	}
	// Pick the simplest single-stage flow we know how to satisfy.
	const dummy = flows.find(f => f.stages.length === 1 && f.stages[0] === "m.login.dummy");
	if (!dummy) {
		const stages = flows.map(f => f.stages.join("+")).join(", ");
		throw new Error(`This server requires registration stages we don't handle yet: ${stages}`);
	}

	// Step 2: re-submit with the dummy auth payload.
	const final = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			...baseBody,
			auth: { type: "m.login.dummy", session },
		}),
	});
	const finalJson = await final.json().catch(() => ({})) as Record<string, unknown>;
	if (!final.ok) {
		throw new Error(messageFromMatrixError(finalJson, `register failed (${final.status})`));
	}
	return registerJsonToCreds(finalJson, homeserver);
}

/**
 * Register a new user, then auto-join the instance's configured
 * default space (if any) plus its public child rooms.  We do this
 * here rather than in App.tsx because App can't tell whether `creds`
 * came from login or signup — and the auto-join only applies to
 * fresh signups.  Best-effort: registration succeeds even if the
 * default-space join fails, so a misconfigured admin doesn't break
 * onboarding.
 */
export async function registerAndJoinDefaults(
	homeserver: string,
	username: string,
	password: string,
): Promise<MatrixCredentials> {
	const creds = await registerWithPassword(homeserver, username, password);

	try {
		const { fetchInstanceConfig } = await import("@/lib/instance");
		const config = await fetchInstanceConfig();
		const defaultSpaceId = config.default_space_id;
		if (!defaultSpaceId) return creds;

		// Spin up a temporary client with the new user's credentials so
		// we can join on their behalf.  Doesn't startClient — we just
		// need single-shot REST calls, no /sync overhead.
		const client = sdk.createClient({
			baseUrl: homeserver,
			accessToken: creds.access_token,
			userId: creds.user_id,
			deviceId: creds.device_id,
		});
		await client.joinRoom(defaultSpaceId);

		// Discord-style: also pull every public child of the space.
		try {
			const hierarchy = await client.getRoomHierarchy(defaultSpaceId, 50, 3, false);
			const rooms = (hierarchy.rooms ?? []) as Array<{
				room_id: string;
				room_type?: string;
				join_rule?: string;
			}>;
			await Promise.all(rooms.map(async r => {
				if (r.room_id === defaultSpaceId) return;
				if (r.room_type === "m.space") return;
				const rule = r.join_rule ?? "public";
				if (rule !== "public" && rule !== "knock") return;
				try { await client.joinRoom(r.room_id); } catch {/* skip */}
			}));
		} catch (err) {
			console.warn("default-space children join failed", err);
		}
	} catch (err) {
		console.warn("default-space join failed", err);
	}

	return creds;
}

function registerJsonToCreds(body: Record<string, unknown>, homeserver: string): MatrixCredentials {
	const access_token = body["access_token"] as string | undefined;
	const user_id = body["user_id"] as string | undefined;
	const device_id = body["device_id"] as string | undefined;
	if (!access_token || !user_id || !device_id) {
		throw new Error("Registration succeeded but response missing token/user/device");
	}
	return {
		homeserver,
		user_id: user_id as UserId,
		access_token,
		device_id,
	};
}

function messageFromMatrixError(body: Record<string, unknown>, fallback: string): string {
	const errcode = body["errcode"] as string | undefined;
	const error = body["error"] as string | undefined;
	if (error && errcode) return `${error} (${errcode})`;
	if (error) return error;
	return fallback;
}

export class MatrixTransport {
	private client: sdk.MatrixClient | null = null;
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

	// SSSS private key, cached after setup or unlock.  matrix-js-sdk
	// asks for it via the cryptoCallbacks.getSecretStorageKey hook
	// whenever it needs to read or write a secret (cross-signing keys,
	// key backup decryption key).  Cleared on stop().  This is
	// intentionally held in memory only — persisting it would defeat
	// the point of having a separate encryption secret.
	private ssssKey: { keyId: string; privateKey: Uint8Array } | null = null;

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
		const buildClient = () => sdk.createClient({
			baseUrl: creds.homeserver,
			accessToken: creds.access_token,
			userId: creds.user_id,
			deviceId: creds.device_id,
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
		try {
			await this.client.initRustCrypto();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (/account in the (store|constructor)|doesn'?t match/i.test(msg)) {
				console.warn("rust-crypto store mismatch — wiping and retrying", msg);
				await wipeRustCryptoIndexedDB();
				if (this.stopped) return;
				// initRustCrypto leaves the client in a half-init state on
				// failure; recreate from scratch before retrying.
				this.client = buildClient();
				await this.client.initRustCrypto();
			} else {
				throw err;
			}
		}
		// Bail if stop() ran while we were awaiting crypto init.  Without
		// this guard, a stale strict-mode-cleanup'd transport runs the
		// rest of start() and trips over its now-null this.client.
		if (this.stopped || !this.client) return;

		// Encrypted events arrive via Timeline as `m.room.encrypted`.
		// We skip them there (see Timeline handler below) and instead
		// process them here once decryption resolves their cleartext
		// type — which might be m.room.message, m.reaction, m.call.*,
		// chat.koven.flag.v1, anything.  Routing is identical to the
		// Timeline handler, factored into routeDecryptedEvent.
		this.client.on(MatrixEventEvent.Decrypted, (event: MatrixEvent) => {
			const room = this.client?.getRoom(event.getRoomId() ?? "");
			if (!room) return;
			this.routeDecryptedEvent(event, room, false);
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
		this.client.on(RoomEvent.Timeline, (event: MatrixEvent) => {
			const t = event.getType();
			if (t === "m.space.child" || t === "m.space.parent" || t === "m.room.create") {
				this.emitSpaceList();
				this.emitRoomList();
			}
		});

		this.client.on(RoomMemberEvent.Membership, (_event, member) => {
			this.handlers.onMembersUpdated(member.roomId as RoomId);
		});

		// 1:1 voice/video — the SDK fires CallEventHandlerEvent.Incoming
		// once when a remote m.call.invite is processed and ringing.
		// We just hand the MatrixCall to the application; UI lifecycle
		// (accept/decline/hangup) is driven through the call object.
		this.client.on(CallEventHandlerEvent.Incoming, (call: MatrixCall) => {
			this.handlers.onIncomingCall(call);
		});

		// Account data fires on every map change in account_data — most
		// of which we don't care about.  We re-broadcast only when the
		// ignored-user list changes, so the Settings sheet's blocked-users
		// section + ChatPane's per-message filter both re-render live.
		this.client.on(ClientEvent.AccountData, (event: MatrixEvent) => {
			if (event.getType() === "m.ignored_user_list") {
				for (const fn of this.ignoreListeners) {
					try { fn(); } catch (err) { console.warn("ignore listener threw", err); }
				}
			}
		});

		if (this.stopped || !this.client) return;
		await this.client.startClient({
			initialSyncLimit: 30,
			// "detached" lets us call redactEvent (unreact, unflag).  The
			// default "chronological" mode keeps pending events on a
			// per-room queue that redactEvent's getPendingEvents helper
			// refuses to read from — see matrix-js-sdk Room.getPendingEvents.
			pendingEventOrdering: sdk.PendingEventOrdering.Detached,
		});
	}

	stop(): void {
		this.stopped = true;
		this.client?.stopClient();
		this.client?.removeAllListeners();
		this.client = null;
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
		this.uiaPassword = null;
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
		try {
			await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
			await crypto.restoreKeyBackup();
		} catch (err) {
			// No key backup yet, or restore failed — non-fatal; new
			// messages will decrypt fine, only history is missing.
			console.warn("unlockEncryption: key backup restore failed", err);
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
		const keyInfo = await c.secretStorage.getKey();
		if (!keyInfo) return "needs-setup";
		// Cross-signing readiness is the cleanest "this device is set
		// up" signal — true iff cross-signing private keys are cached
		// locally.  Anything less means we need the user to unlock.
		const status = await crypto.getCrossSigningStatus();
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
	async uploadAndSendAttachment(roomId: RoomId, file: File): Promise<EventId> {
		const c = this.requireClient();
		const room = c.getRoom(roomId);
		const isEncrypted = !!room && (room as any).hasEncryptionStateEvent?.() === true;

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
				body: file.name,
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
				body: file.name,
				info,
				url: upload.content_uri,
			};
		}

		const res = await c.sendEvent(roomId, "m.room.message" as any, content as any);
		return res.event_id as EventId;
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

	/** Create a new room.  Returns the new room id. */
	async createRoom(opts: {
		name: string;
		topic?: string;
		visibility: "public" | "private";
		encrypted: boolean;
		// If set, the room is added as a child of this space immediately
		// after creation (m.space.child on the space + m.space.parent on
		// the room).  Both are needed for proper Matrix semantics.
		// Additionally, when set:
		//   - All current members of the space are invited to the new
		//     room so they get an immediate notification.
		//   - For private rooms, the join rule is upgraded to
		//     "restricted" with the parent space as the allow-list, so
		//     space members can re-join without invitation if they
		//     ever leave the room (Discord-channel-like semantics).
		parentSpaceId?: SpaceId;
	}): Promise<RoomId> {
		const c = this.requireClient();
		// Public + encrypted is forbidden by Koven's governance model:
		// public rooms must stay readable so the engine can run
		// consensus moderation, and encryption blinds the engine.
		// The CreateRoomSheet UI already gates this; this is the
		// defense-in-depth check for any stale caller.
		if (opts.visibility === "public" && opts.encrypted) {
			throw new Error("Public rooms can't be encrypted — moderation requires the engine to see content.");
		}
		const myUserId = this.creds?.user_id;
		const initialState: any[] = [];
		if (opts.encrypted) {
			initialState.push({
				type: "m.room.encryption",
				state_key: "",
				content: { algorithm: "m.megolm.v1.aes-sha2" },
			});
		}
		// Gather space-member invitees + restricted-join state when
		// the room is being created inside a space.
		const inviteList: UserId[] = [];
		if (opts.parentSpaceId) {
			// Canonical-parent pointer — paired with the m.space.child
			// state on the space side, written below via linkRoomToSpace.
			initialState.push({
				type: "m.space.parent",
				state_key: opts.parentSpaceId,
				content: { canonical: true, via: [this.serverName()] },
			});

			// Restricted join rule for private-in-space rooms.  Layered
			// over private_chat's default (join_rule: invite) so the
			// rule becomes "anyone in the parent space can join, plus
			// anyone explicitly invited."  Public rooms are already
			// joinable by anyone on the homeserver, so restricted there
			// would be a downgrade — skip.
			if (opts.visibility === "private") {
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

			// Pull joined members of the space and invite them (minus
			// ourselves, who'll be in the room as the creator).  Also
			// skip invites that the SDK doesn't have synced yet — those
			// just won't get an explicit invite, but the restricted
			// rule will still let them in.
			const space = c.getRoom(opts.parentSpaceId);
			if (space && myUserId) {
				for (const member of space.getMembersWithMembership("join")) {
					if (member.userId !== myUserId) {
						inviteList.push(member.userId as UserId);
					}
				}
			}
		}
		const res = await c.createRoom({
			name: opts.name,
			topic: opts.topic,
			visibility: opts.visibility as any,
			preset: (opts.visibility === "public" ? "public_chat" : "private_chat") as any,
			invite: inviteList.length > 0 ? inviteList : undefined,
			initial_state: initialState.length ? initialState : undefined,
		});
		const newRoomId = res.room_id as RoomId;

		// Koven PL scheme — see createSpace for the rationale.  Two
		// tiers only: creator (PL 100) and everyone else (PL 0).
		// All administrative actions require the creator; chat is
		// open.  Content moderation goes through the engine's
		// flag / consensus / collapse pipeline, not Matrix redactions
		// or kicks.
		try {
			await c.sendStateEvent(newRoomId, "m.room.power_levels" as any, {
				users: { [c.getUserId()!]: 100 },
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
				invite: opts.visibility === "public" ? 0 : 100,
				events_default: 0,
			}, "");
		} catch (err) {
			console.warn("createRoom: failed to apply Koven PL scheme", err);
		}

		if (opts.parentSpaceId) {
			await this.linkRoomToSpace(opts.parentSpaceId, newRoomId).catch(err => {
				console.warn("createRoom: failed to link to parent space", err);
			});
		}
		this.emitRoomList();
		this.emitSpaceList();
		return newRoomId;
	}

	/** Create a Matrix space (a room with type m.space). */
	async createSpace(opts: {
		name: string;
		topic?: string;
		visibility: "public" | "private";
		avatarFile?: File;          // uploaded + set as space avatar after create
	}): Promise<SpaceId> {
		const c = this.requireClient();
		const res = await c.createRoom({
			name: opts.name,
			topic: opts.topic,
			visibility: opts.visibility as any,
			preset: (opts.visibility === "public" ? "public_chat" : "private_chat") as any,
			creation_content: { type: "m.space" } as any,
		});
		const spaceId = res.room_id as SpaceId;

		// Koven power-level model: two tiers, creator (PL 100) and
		// everyone else (PL 0).  No moderators — content moderation
		// is the community's job via the flag / consensus / collapse
		// pipeline in the engine, not a privileged-user role at the
		// Matrix layer.  Synapse's default scheme assumes a PL-50
		// moderator tier and hands those users power over room
		// settings, kicks, and (relevantly here) the space hierarchy.
		// We override on space creation so:
		//   - Anything administrative (settings, hierarchy, kicks,
		//     invites in private spaces) requires the creator.
		//   - Anything social (sending messages / reactions in child
		//     rooms — this is a space, but the same model applies)
		//     stays at PL 0 / open.
		// Best-effort: a failure here doesn't undo space creation,
		// it just leaves Synapse's looser default in place.  The
		// creator can re-run by re-creating the space, or in a
		// future "fortify existing space" admin gesture.
		try {
			await c.sendStateEvent(spaceId, "m.room.power_levels" as any, {
				users: { [c.getUserId()!]: 100 },
				users_default: 0,
				events: {
					// Every administrative state event is creator-
					// only.  No moderator tier means no reason to
					// leave anything at the Matrix-default PL 50.
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
					// Hierarchy: only the creator decides what rooms
					// are inside this space.
					"m.space.child": 100,
				},
				// Catch-all state floor.  Anything we didn't list
				// above also requires PL 100, so future Matrix /
				// Koven state-event types stay creator-only by
				// default.
				state_default: 100,
				// Kick / ban / redact: creator-only.  In day-to-day
				// Koven these are unused — the UI doesn't offer
				// kick / ban affordances, and message hiding goes
				// through the engine's collapse pipeline rather than
				// Matrix redactions.  Locking them to 100 means
				// nobody but the creator (during a Delete) can fire
				// them, period.
				kick: 100,
				ban: 100,
				redact: 100,
				// Invites: creator-only on private spaces; open on
				// public spaces (anyone can invite a friend to a
				// public space, same as joining themselves).
				invite: opts.visibility === "public" ? 0 : 100,
				// Messages / reactions in chat rooms — this PL applies
				// to non-state events too via events_default.  Open
				// to all members.  (Spaces don't have timelines but
				// the field is required by the schema.)
				events_default: 0,
			}, "");
		} catch (err) {
			console.warn("createSpace: failed to apply Koven PL scheme", err);
		}
		if (opts.avatarFile) {
			try {
				const upload = await c.uploadContent(opts.avatarFile, {
					name: opts.avatarFile.name,
					type: opts.avatarFile.type,
				} as any);
				await c.sendStateEvent(spaceId, "m.room.avatar" as any, {
					url: upload.content_uri as string,
				}, "");
			} catch (err) {
				// Avatar set is best-effort — we don't want to fail the
				// whole creation flow if the upload hits an error.
				console.warn("createSpace: avatar upload failed", err);
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
		this.emitRoomList();
		return roomId;
	}

	/**
	 * Place an outbound 1:1 voice or video call into a room.  Returns
	 * the live MatrixCall so the caller can attach state listeners.
	 *
	 * Voice and video are the same protocol on the wire (m.call.invite
	 * with SDP offer); the only difference is whether we request a
	 * camera track from the user's device.  Either flavor uses WebRTC
	 * peer-to-peer with Synapse acting only as the signaling channel
	 * — no media touches the server.  Encrypted rooms work the same
	 * way; signaling rides through the encrypted timeline.
	 *
	 * Returns null if the SDK refuses to create a call (e.g. no room).
	 * Caller should treat null as a failure and surface a UI error.
	 */
	async placeCall(roomId: RoomId, video: boolean): Promise<MatrixCall | null> {
		const c = this.requireClient();
		const call = c.createCall(roomId);
		if (!call) return null;
		if (video) await call.placeVideoCall();
		else await call.placeVoiceCall();
		return call;
	}

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
	}> {
		const c = this.requireClient();
		const root = await c.joinRoom(spaceIdOrAlias);
		const spaceId = root.roomId as SpaceId;

		let hierarchy;
		try {
			hierarchy = await c.getRoomHierarchy(spaceId, 50, 3, false);
		} catch (err) {
			console.warn("joinSpaceWithChildren: hierarchy fetch failed", err);
			this.emitRoomList();
			this.emitSpaceList();
			return { spaceId, joinedChildren: 0, skippedChildren: 0 };
		}

		const rooms = (hierarchy.rooms ?? []) as Array<{
			room_id: string;
			room_type?: string;
			join_rule?: string;
		}>;

		// Best-effort parallel join of every joinable child.  Skip the
		// space itself, sub-spaces (let the user opt-in by clicking
		// them in Explore), and anything not public/knock — invite-only
		// children would just bounce back with M_FORBIDDEN.
		let joined = 0;
		let skipped = 0;
		await Promise.all(rooms.map(async r => {
			if (r.room_id === spaceId) return;
			if (r.room_type === "m.space") { skipped++; return; }
			const rule = r.join_rule ?? "public";
			if (rule !== "public" && rule !== "knock") { skipped++; return; }
			try {
				await c.joinRoom(r.room_id);
				joined++;
			} catch {
				skipped++;
			}
		}));

		this.emitRoomList();
		this.emitSpaceList();
		return { spaceId, joinedChildren: joined, skippedChildren: skipped };
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
	}): Promise<void> {
		const c = this.requireClient();
		if (opts.name !== undefined) {
			await c.sendStateEvent(opts.spaceId, "m.room.name" as any, { name: opts.name }, "");
		}
		if (opts.topic !== undefined) {
			await c.sendStateEvent(opts.spaceId, "m.room.topic" as any, { topic: opts.topic }, "");
		}
		if (opts.avatarFile) {
			const upload = await c.uploadContent(opts.avatarFile, {
				name: opts.avatarFile.name,
				type: opts.avatarFile.type,
			} as any);
			await c.sendStateEvent(opts.spaceId, "m.room.avatar" as any, {
				url: upload.content_uri as string,
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
		visibility?: "public" | "private";
	}): Promise<void> {
		const c = this.requireClient();
		// Defense-in-depth: refuse to flip an encrypted room to public.
		// Matrix doesn't support disabling encryption once enabled, so
		// the resulting room would be public-yet-unmoderatable.  UI
		// already disables the toggle; this catches anyone bypassing it.
		if (opts.visibility === "public") {
			const room = c.getRoom(opts.roomId);
			if (room && (room as any).hasEncryptionStateEvent?.() === true) {
				throw new Error("Encrypted rooms can't be made public — moderation requires readable content.");
			}
		}
		if (opts.name !== undefined) {
			await c.sendStateEvent(opts.roomId, "m.room.name" as any, { name: opts.name }, "");
		}
		if (opts.topic !== undefined) {
			await c.sendStateEvent(opts.roomId, "m.room.topic" as any, { topic: opts.topic }, "");
		}
		if (opts.avatarFile) {
			const upload = await c.uploadContent(opts.avatarFile, {
				name: opts.avatarFile.name,
				type: opts.avatarFile.type,
			} as any);
			await c.sendStateEvent(opts.roomId, "m.room.avatar" as any, {
				url: upload.content_uri as string,
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
		if (opts.visibility !== undefined) {
			const rule = opts.visibility === "public" ? "public" : "invite";
			await c.sendStateEvent(opts.roomId, "m.room.join_rules" as any, { join_rule: rule }, "");
			try {
				await c.setRoomDirectoryVisibility(opts.roomId, opts.visibility as any);
			} catch (err) {
				console.warn("updateRoom: directory visibility update failed", err);
			}
		}
		this.emitRoomList();
	}

	/** Add an existing room as a child of an existing space. */
	async linkRoomToSpace(spaceId: SpaceId, roomId: RoomId): Promise<void> {
		const c = this.requireClient();
		const via = [this.serverName()];
		await c.sendStateEvent(spaceId, "m.space.child" as any, { via, suggested: false }, roomId);
		// Best-effort reciprocal — fails harmlessly if we don't have PL.
		try {
			await c.sendStateEvent(roomId, "m.space.parent" as any, { via, canonical: true }, spaceId);
		} catch {
			// Power-level mismatch in the child room is fine; the canonical
			// hierarchy lives on the space side.
		}
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
		const events = room.getLiveTimeline().getEvents();
		const latest = events[events.length - 1];
		if (!latest) return;
		try {
			await c.sendReadReceipt(latest);
		} catch (err) {
			// Common cause: matrix-js-sdk skipping duplicate receipts.
			// Refresh the local count anyway in case the server already
			// considered us caught up.
			console.warn("markAsRead: sendReadReceipt failed", err);
		}
		this.emitRoomList();
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
	async acceptInvite(roomId: RoomId): Promise<void> {
		const c = this.requireClient();
		const room = c.getRoom(roomId);
		const dmInviter = room?.getDMInviter();
		const isSpaceRoom = room ? this.isSpace(room) : false;

		if (isSpaceRoom) {
			await this.joinSpaceWithChildren(roomId);
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
		}
		this.emitRoomList();
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
		await Promise.all(userIds.map(async u => {
			try {
				await c.invite(roomId, u, reason);
				invited.push(u);
			} catch (err) {
				failed.push({
					userId: u,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}));
		return { invited, failed };
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
	 * Leave a room or space.  The user's membership is dropped (so the
	 * room disappears from their list and they stop receiving events
	 * from it) and the server-side memory of their membership is
	 * forgotten.  Other members are unaffected — the room continues
	 * without them.  This is the symmetric "I want out" action; for
	 * "destroy this room" creators have `deleteRoom` below.
	 *
	 * Spaces work identically (Matrix treats them as rooms with
	 * `type: m.space`).  No special handling for child rooms — leaving
	 * a space doesn't leave its children; the user keeps anything
	 * they joined directly.
	 */
	async leaveRoom(roomId: RoomId): Promise<void> {
		const c = this.requireClient();
		await c.leave(roomId);
		await c.forget(roomId).catch(() => {/* ok if not supported */});
		this.emitRoomList();
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
				const ta = this.client!.getRoom(a.id)?.getLastActiveTimestamp() ?? 0;
				const tb = this.client!.getRoom(b.id)?.getLastActiveTimestamp() ?? 0;
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
		return {
			id: r.roomId as SpaceId,
			name: r.name || r.roomId,
			topic: r.currentState.getStateEvents("m.room.topic", "")?.getContent().topic,
			avatarUrl: r.getMxcAvatarUrl() ?? undefined,
			iconEmoji: readKovenIconEmoji(r),
			kind: joinRule === "public" ? "public" : "private",
			childRoomIds,
			myPowerLevel,
			creatorId,
		};
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
			const upload = await c.uploadContent(opts.avatarFile, {
				name: opts.avatarFile.name,
				type: opts.avatarFile.type,
			} as any);
			avatarUrl = upload.content_uri as string;
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

	/** Joined members of a room, sorted by power level then name. */
	getRoomMembers(roomId: RoomId): import("@koven/shared").Member[] {
		const room = this.client?.getRoom(roomId);
		if (!room) return [];
		const joined = room.getMembersWithMembership("join");
		return joined.map(m => ({
			userId: m.userId as UserId,
			displayName: m.name || m.userId,
			// Raw mxc:// — UI components fetch via getMxcBlobUrl().
			avatarUrl: m.getMxcAvatarUrl() ?? undefined,
			powerLevel: m.powerLevel ?? 0,
			presence: undefined,         // TODO: wire to client.presence sync
			statusMessage: undefined,
		})).sort((a, b) => {
			if (a.powerLevel !== b.powerLevel) return b.powerLevel - a.powerLevel;
			return a.displayName.localeCompare(b.displayName);
		});
	}

	/** Recent messages for a room, oldest first.  Useful for initial render. */
	getRoomMessages(roomId: RoomId, limit = 200): Message[] {
		const room = this.client?.getRoom(roomId);
		if (!room) return [];
		const events = room.getLiveTimeline().getEvents();
		const msgs: Message[] = [];
		for (const event of events.slice(-limit)) {
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

	private emitRoomList(): void {
		this.handlers.onRoomsUpdated(this.getRooms());
	}

	private emitSpaceList(): void {
		this.handlers.onSpacesUpdated(this.getSpaces());
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
		// Fall back to that when there's no room-level avatar set, and
		// surface dmUserId so the UI can also use it as the auto-avatar
		// seed.
		let avatarUrl = r.getMxcAvatarUrl() ?? undefined;
		if (isDm && !avatarUrl && dmUserId) {
			const other = r.getMember(dmUserId);
			avatarUrl = other?.getMxcAvatarUrl() ?? undefined;
		}

		// Inviter for non-DM invites — useful for the request UI.
		// matrix-js-sdk doesn't have a non-DM `getInviter`, so we read
		// the membership event directly.
		let inviter: UserId | undefined;
		if (isInvite) {
			const me = this.creds?.user_id;
			if (me) {
				const ev = r.currentState.getStateEvents("m.room.member", me);
				inviter = (ev?.getSender() ?? undefined) as UserId | undefined;
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

		return {
			id: r.roomId as RoomId,
			name: r.name || dmUserId || r.roomId,
			topic: r.currentState.getStateEvents("m.room.topic", "")?.getContent().topic,
			// Raw mxc:// — UI components fetch via getMxcBlobUrl().
			avatarUrl,
			iconEmoji: readKovenIconEmoji(r),
			kind,
			memberCount: r.getJoinedMemberCount(),
			unreadCount: r.getUnreadNotificationCount() ?? 0,
			highlightCount: r.getUnreadNotificationCount("highlight" as any) ?? 0,
			encrypted: r.hasEncryptionStateEvent(),
			parentSpaceIds,
			dmUserId: isDm ? (dmUserId as UserId | undefined) : undefined,
			isInvite: isInvite || undefined,
			inviter,
			homeserver,
			isFederated,
			myPowerLevel,
			creatorId,
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

		// Reactions flow on a separate channel — we don't render them
		// as chat messages, the App reducer aggregates them per
		// target message and the UI shows them as pills.
		if (type === "m.reaction") {
			const r = this.eventToReaction(event, room);
			if (r) this.handlers.onReaction(r, { live });
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
		if (type !== "m.room.message") return null;
		if (event.isRedacted()) return null;

		const content = event.getContent() as any;
		const sender = event.getSender();
		if (!sender) return null;

		const member = room.getMember(sender);
		const displayName = member?.name ?? sender;

		const msgtype = content.msgtype as string | undefined;
		let kind: MessageKind = "text";
		let mediaMxc: string | undefined;
		let mediaMimeType: string | undefined;
		let mediaName: string | undefined;
		let mediaSize: number | undefined;
		let mediaWidth: number | undefined;
		let mediaHeight: number | undefined;
		let mediaEncrypted: import("@koven/shared").MediaEncryption | undefined;
		let text = (content.body as string | undefined) ?? "";

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
			// `body` on m.image/m.file is conventionally the filename.
			mediaName = text || undefined;
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

		return {
			id: event.getId() as EventId,
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
			edited: !!event.replacingEvent(),
			replyTo,
		};
	}

}

/**
 * Strip the "> <@user:server> body" reply fallback prefix that
 * Matrix clients prepend to a reply's body for non-rich clients.
 * The leading lines are recognizable: each starts with "> ", and the
 * block ends with a blank line.
 */
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

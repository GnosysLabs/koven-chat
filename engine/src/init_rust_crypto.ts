// Per-bot rust-crypto initialiser.
//
// matrix-js-sdk's `MatrixClient.initRustCrypto()` hardcodes the
// IndexedDB prefix to "matrix-js-sdk", so all bots running in the
// same process would share — and immediately corrupt — each other's
// crypto state (rust-crypto's IDB schema assumes one user per DB,
// not user-namespaced records).  We bypass that public API and call
// the lower-level `RustCrypto.initRustCrypto` directly with a
// per-bot prefix, then wire the resulting backend onto the client
// the same way the SDK does internally.
//
// This reaches into a couple of fields the SDK marks @internal —
// `client.http`, `client.cryptoCallbacks`, `client.cryptoBackend`,
// `client.reEmitter`.  Those are stable across the 34.x line; if a
// future major changes them, we'll need to revisit.

// The rust-crypto subpath isn't in matrix-js-sdk's exports manifest
// (the package has no `exports` field at all), so deep-importing the
// transpiled module path works.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as RustCrypto from "matrix-js-sdk/lib/rust-crypto/index.js";
import { ClientEvent, RoomMemberEvent } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";

// Subset of CryptoEvent constants we re-emit.  We string-literal them
// to avoid importing CryptoEvent (whose path varies between SDK
// builds) — matrix-js-sdk's reEmitter just forwards by name.
const REEMIT_CRYPTO_EVENTS = [
	"crypto.verificationRequestReceived",
	"crypto.userTrustStatusChanged",
	"crypto.keyBackupStatus",
	"crypto.keyBackupSessionsRemaining",
	"crypto.keyBackupFailed",
	"crypto.keyBackupDecryptionKeyCached",
	"crypto.keysChanged",
	"crypto.devicesUpdated",
	"crypto.willUpdateDevices",
];

/**
 * Initialise rust-crypto for a single bot.
 *
 * @param client       — the bot's MatrixClient (already constructed).
 * @param storePrefix  — per-bot IDB prefix, e.g. `koven-bot-7`.
 *                       rust-crypto-wasm derives database names from
 *                       this; using a per-bot value keeps each bot's
 *                       state isolated in the shared global IDB.
 */
export async function initBotRustCrypto(
	client: MatrixClient,
	storePrefix: string,
): Promise<void> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const c = client as unknown as Record<string, any>;

	if (c.cryptoBackend) {
		// Already initialised — nothing to do.  This matches the SDK's
		// own guard so calling twice is safe.
		return;
	}

	const userId = client.getUserId();
	if (!userId) throw new Error("initBotRustCrypto: client has no userId");
	const deviceId = client.getDeviceId();
	if (!deviceId) throw new Error("initBotRustCrypto: client has no deviceId");

	const rustCrypto = await RustCrypto.initRustCrypto({
		logger: c.logger,
		http: c.http,
		userId,
		deviceId,
		secretStorage: client.secretStorage,
		cryptoCallbacks: c.cryptoCallbacks,
		storePrefix,
		// No passphrase → unencrypted IDB.  The IDB itself lives on
		// disk only via our snapshot file (encrypted at rest is a
		// separate, future concern).
		storePassphrase: undefined,
		storeKey: undefined,
	});

	rustCrypto.setSupportedVerificationMethods(c.verificationMethods);
	c.cryptoBackend = rustCrypto;

	// Wire up the same listeners MatrixClient.initRustCrypto installs.
	client.on(RoomMemberEvent.Membership, rustCrypto.onRoomMembership.bind(rustCrypto));
	client.on(ClientEvent.Event, (event) => {
		rustCrypto.onLiveEventFromSync(event);
	});

	// Re-emit crypto events on the client, as the SDK's own init does.
	if (c.reEmitter && typeof c.reEmitter.reEmit === "function") {
		c.reEmitter.reEmit(rustCrypto, REEMIT_CRYPTO_EVENTS);
	}
}

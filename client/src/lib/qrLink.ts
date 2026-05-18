// QR-code device sign-in: client helpers.
//
// "Scan to sign in": a desktop / web session shows a QR code, the
// already-signed-in mobile app scans it and approves, and the engine
// relays a freshly-minted Matrix session back to the desktop.
//
// The user's encryption recovery key never travels in clear: the
// desktop puts an ephemeral ECDH P-256 public key in the QR, the
// mobile derives a shared AES-GCM key against it, encrypts the
// recovery key, and the desktop decrypts it after the engine relays
// the ciphertext.  The engine only ever sees opaque bytes.
//
// Desktop side  : initiateQrLink → pollQrLink → claimRecoveryKey.
// Mobile side   : approveQrLink (parses a scanned QrLinkPayload).
//
// crypto.subtle requires a secure context; all three Koven hosts
// (https web, tauri://, capacitor://) qualify.

import { ENGINE_URL } from "@/lib/urls";
import type {
	QrApproveRequest,
	QrInitiateResponse,
	QrLinkPayload,
	QrStatusResponse,
} from "@koven/shared";

// ─── base64url <-> bytes ────────────────────────────────────────────

function bytesToB64url(bytes: ArrayBuffer | Uint8Array): string {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = "";
	for (const b of u8) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
	const padded = s.replace(/-/g, "+").replace(/_/g, "/")
		+ "=".repeat((4 - (s.length % 4)) % 4);
	const bin = atob(padded);
	const u8 = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
	return u8;
}

// ─── ECDH P-256 + AES-GCM ───────────────────────────────────────────

const ECDH_PARAMS: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };

async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
	return crypto.subtle.generateKey(ECDH_PARAMS, false, ["deriveKey"]);
}

async function exportRawPublicKey(key: CryptoKey): Promise<string> {
	return bytesToB64url(await crypto.subtle.exportKey("raw", key));
}

async function importRawPublicKey(b64url: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		b64urlToBytes(b64url) as BufferSource,
		ECDH_PARAMS,
		false,
		[],
	);
}

/** Derive the shared AES-GCM key from our private key + their public
 * key.  Both sides reach the same key because ECDH is symmetric. */
async function deriveSharedKey(
	ourPrivate: CryptoKey,
	theirPublic: CryptoKey,
): Promise<CryptoKey> {
	return crypto.subtle.deriveKey(
		{ name: "ECDH", public: theirPublic },
		ourPrivate,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

async function aesEncrypt(
	key: CryptoKey,
	plaintext: string,
): Promise<{ iv: string; ciphertext: string }> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const enc = new TextEncoder().encode(plaintext);
	const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
	return { iv: bytesToB64url(iv), ciphertext: bytesToB64url(ct) };
}

async function aesDecrypt(
	key: CryptoKey,
	iv: string,
	ciphertext: string,
): Promise<string> {
	const pt = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: b64urlToBytes(iv) as BufferSource },
		key,
		b64urlToBytes(ciphertext) as BufferSource,
	);
	return new TextDecoder().decode(pt);
}

// ─── Desktop side ───────────────────────────────────────────────────

/** A live QR sign-in attempt held by the desktop while it shows the
 * QR and polls.  `privateKey` and `claimSecret` never leave the
 * desktop, so a photographed QR cannot poll or claim the session. */
export interface QrLinkSession {
	qrId: string;
	claimSecret: string;
	expiresAt: number;
	/** The value to render as a QR image (JSON-encoded QrLinkPayload). */
	qrPayload: string;
	/** Ephemeral ECDH private key, used later to decrypt the relayed
	 * recovery key. */
	privateKey: CryptoKey;
}

/** Open a QR sign-in session: generate an ephemeral keypair, register
 * it with the engine, and return everything the desktop needs to
 * render the QR and poll for approval. */
export async function initiateQrLink(): Promise<QrLinkSession> {
	const pair = await generateEcdhKeyPair();
	const desktopPubKey = await exportRawPublicKey(pair.publicKey);

	const r = await fetch(`${ENGINE_URL}/api/auth/qr/initiate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ desktop_pubkey: desktopPubKey }),
	});
	if (!r.ok) throw new Error(`qr initiate failed: ${r.status}`);
	const body = (await r.json()) as QrInitiateResponse;

	const payload: QrLinkPayload = {
		v: 1,
		qrId: body.qr_id,
		desktopPubKey,
	};
	return {
		qrId: body.qr_id,
		claimSecret: body.claim_secret,
		expiresAt: body.expires_at,
		qrPayload: JSON.stringify(payload),
		privateKey: pair.privateKey,
	};
}

/** Poll the engine for the current state of a QR session.  The
 * `approved` response is returned exactly once; the engine deletes
 * the row on the call that observes it. */
export async function pollQrLink(
	qrId: string,
	claimSecret: string,
): Promise<QrStatusResponse> {
	const r = await fetch(
		`${ENGINE_URL}/api/auth/qr/status?qr_id=${encodeURIComponent(qrId)}`,
		{ headers: { "X-Koven-Qr-Claim": claimSecret } },
	);
	if (!r.ok) throw new Error(`qr status failed: ${r.status}`);
	return (await r.json()) as QrStatusResponse;
}

/** Decrypt the recovery key the mobile app relayed through the engine.
 * Call with the `approved` status response and the session's private
 * key. */
export async function claimRecoveryKey(
	approved: Extract<QrStatusResponse, { status: "approved" }>,
	privateKey: CryptoKey,
): Promise<string> {
	const mobilePublic = await importRawPublicKey(approved.mobile_pubkey);
	const shared = await deriveSharedKey(privateKey, mobilePublic);
	return aesDecrypt(shared, approved.iv, approved.ciphertext);
}

// ─── Mobile side ────────────────────────────────────────────────────

export type ApproveQrResult =
	| { ok: true }
	| { ok: false; error: "expired" | "already_approved" | "network" | "server" };

/** Parse a scanned QR string into a QrLinkPayload, or null if it is
 * not a Koven sign-in QR. */
export function parseQrPayload(raw: string): QrLinkPayload | null {
	try {
		const obj = JSON.parse(raw) as Partial<QrLinkPayload>;
		if (obj.v !== 1) return null;
		if (typeof obj.qrId !== "string" || typeof obj.desktopPubKey !== "string") {
			return null;
		}
		return { v: 1, qrId: obj.qrId, desktopPubKey: obj.desktopPubKey };
	} catch {
		return null;
	}
}

/** Approve a scanned QR sign-in: encrypt the recovery key to the
 * desktop's public key and post it to the engine, authenticated as
 * the current (mobile) user. */
export async function approveQrLink(
	payload: QrLinkPayload,
	recoveryKey: string,
	accessToken: string,
): Promise<ApproveQrResult> {
	let body: QrApproveRequest;
	try {
		const desktopPublic = await importRawPublicKey(payload.desktopPubKey);
		const pair = await generateEcdhKeyPair();
		const shared = await deriveSharedKey(pair.privateKey, desktopPublic);
		const { iv, ciphertext } = await aesEncrypt(shared, recoveryKey);
		body = {
			qr_id: payload.qrId,
			mobile_pubkey: await exportRawPublicKey(pair.publicKey),
			iv,
			ciphertext,
		};
	} catch {
		return { ok: false, error: "server" };
	}

	let r: Response;
	try {
		r = await fetch(`${ENGINE_URL}/api/auth/qr/approve`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${accessToken}`,
			},
			body: JSON.stringify(body),
		});
	} catch {
		return { ok: false, error: "network" };
	}
	if (r.ok) return { ok: true };
	if (r.status === 410 || r.status === 404) return { ok: false, error: "expired" };
	if (r.status === 409) return { ok: false, error: "already_approved" };
	return { ok: false, error: "server" };
}

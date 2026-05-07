// At-rest encryption for sensitive bot config — currently each bot's
// LLM API key and its Synapse access token.  AES-256-GCM authenticated
// encryption, keyed off the instance-wide `BOT_KEY_ENCRYPTION_SECRET`
// (64 hex chars / 32 bytes).  Stored format is one base64 blob per
// secret: iv(12) | tag(16) | ciphertext.
//
// Authenticated mode means a tampered ciphertext fails to decrypt
// (GCM tag mismatch throws), so we don't have to worry about a
// modified DB row producing a silently-wrong key.
//
// Rotating the secret invalidates every stored ciphertext.  We don't
// support rotation in v1 — the operator would have to re-enter all
// bot API keys and let bin/koven re-mint Synapse tokens.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config";

const IV_BYTES = 12;     // GCM standard
const TAG_BYTES = 16;

function key(): Buffer {
	const hex = config.botKeyEncryptionSecret;
	if (!hex) {
		throw new Error(
			"BOT_KEY_ENCRYPTION_SECRET is not configured. " +
			"Run `bin/koven setup` to generate one, or set it manually in .env.",
		);
	}
	if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error("BOT_KEY_ENCRYPTION_SECRET must be 64 hex characters (32 bytes).");
	}
	return Buffer.from(hex, "hex");
}

/**
 * Encrypt `plaintext` for at-rest storage.  Returns a single
 * base64 string the caller can stash in any TEXT column.
 */
export function sealSecret(plaintext: string): string {
	const k = key();
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", k, iv);
	const ct = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, ct]).toString("base64");
}

/**
 * Decrypt a sealed blob.  Throws on any tampering / wrong key /
 * malformed input.  Caller is expected to handle the error
 * (typically: log + 500 + don't try to use the secret).
 */
export function openSecret(sealed: string): string {
	const k = key();
	const buf = Buffer.from(sealed, "base64");
	if (buf.length < IV_BYTES + TAG_BYTES + 1) {
		throw new Error("sealed secret is too short to be valid");
	}
	const iv = buf.subarray(0, IV_BYTES);
	const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
	const ct = buf.subarray(IV_BYTES + TAG_BYTES);
	const decipher = createDecipheriv("aes-256-gcm", k, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([
		decipher.update(ct),
		decipher.final(),
	]).toString("utf8");
}

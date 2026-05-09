// Multi-account credential storage.
//
// We hold an ARRAY of MatrixCredentials in localStorage plus a pointer
// to the active one.  Only one account is "live" (i.e. has a running
// MatrixTransport) at a time — matrix-js-sdk and the rust-crypto IDB
// store don't safely support multiple concurrent OlmMachines on the
// same origin — but the others stay parked in storage so the user can
// flip between them without re-entering credentials.
//
// On signout-of-current the inactive accounts stay in the array; the
// "Sign out all" affordance is a discrete action.
//
// Migration: previous versions stored a single account at the legacy
// `koven:matrix-credentials` key.  loadAccounts() detects that on
// first read and rewrites it into the new shape, then deletes the
// legacy key so we don't end up double-tracking the same account.

import type { MatrixCredentials } from "@/lib/matrix";

const ACCOUNTS_KEY = "koven:accounts:v1";
const ACTIVE_USER_KEY = "koven:active-user-id";
// Legacy key from the single-account era — read-once on first load,
// then rewritten into the array and removed.
const LEGACY_CREDS_KEY = "koven:matrix-credentials";

/** Stored account shape — the live MatrixCredentials plus optional
 * cached display fields so the AccountSwitcher can render without a
 * round-trip on cold boot.  Display fields refresh whenever the
 * account is loaded into a transport (App.tsx hydrates them after
 * getMyProfile). */
export interface StoredAccount extends MatrixCredentials {
	display_name?: string;
	avatar_url?: string;
}

/** Read all stored accounts.  Idempotent migration from the legacy
 * single-cred key on first call.  Returns [] when nothing is stored. */
export function loadAccounts(): StoredAccount[] {
	try {
		const raw = localStorage.getItem(ACCOUNTS_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as StoredAccount[];
			if (Array.isArray(parsed)) return parsed.filter(isValidAccount);
		}
	} catch {
		// fall through to migration
	}
	// Legacy migration.  Read the old key, normalise into an array,
	// write into the new key, drop the old key.  Best-effort: any
	// failure leaves storage untouched and returns [].
	try {
		const legacy = localStorage.getItem(LEGACY_CREDS_KEY);
		if (legacy) {
			const c = JSON.parse(legacy) as MatrixCredentials;
			if (isValidAccount(c)) {
				const accounts: StoredAccount[] = [c];
				localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
				localStorage.setItem(ACTIVE_USER_KEY, c.user_id);
				localStorage.removeItem(LEGACY_CREDS_KEY);
				return accounts;
			}
		}
	} catch {
		/* ignore */
	}
	return [];
}

export function saveAccounts(accounts: StoredAccount[]): void {
	try {
		localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
	} catch (err) {
		console.warn("saveAccounts: localStorage write failed", err);
	}
}

export function loadActiveUserId(): string | null {
	try {
		return localStorage.getItem(ACTIVE_USER_KEY);
	} catch {
		return null;
	}
}

export function saveActiveUserId(userId: string | null): void {
	try {
		if (userId) localStorage.setItem(ACTIVE_USER_KEY, userId);
		else localStorage.removeItem(ACTIVE_USER_KEY);
	} catch (err) {
		console.warn("saveActiveUserId: localStorage write failed", err);
	}
}

/** Insert (or update) an account by user_id, preserving order.  When
 * the user_id is already present, the existing entry is replaced
 * with the new credentials — mirrors the "log in to refresh tokens
 * for an account I've already added" flow.  Returns the updated
 * array; caller is responsible for persisting. */
export function upsertAccount(accounts: StoredAccount[], next: StoredAccount): StoredAccount[] {
	const existing = accounts.findIndex(a => a.user_id === next.user_id);
	if (existing < 0) return [...accounts, next];
	const copy = accounts.slice();
	copy[existing] = { ...accounts[existing], ...next };
	return copy;
}

/** Remove an account by user_id.  Idempotent. */
export function removeAccount(accounts: StoredAccount[], userId: string): StoredAccount[] {
	return accounts.filter(a => a.user_id !== userId);
}

/** Pick the next account to make active when the current one is
 * leaving.  Picks the first remaining account in insertion order, or
 * null when the array is empty.  Centralised so the "what happens
 * after sign-out of the active account" rule is consistent across
 * call sites. */
export function pickNextActive(accounts: StoredAccount[], removingUserId: string): string | null {
	const remaining = accounts.filter(a => a.user_id !== removingUserId);
	return remaining[0]?.user_id ?? null;
}

function isValidAccount(a: unknown): a is StoredAccount {
	if (!a || typeof a !== "object") return false;
	const o = a as Record<string, unknown>;
	return typeof o.homeserver === "string"
		&& typeof o.user_id === "string"
		&& typeof o.access_token === "string"
		&& typeof o.device_id === "string";
}

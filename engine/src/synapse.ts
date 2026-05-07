// Outbound HTTP to Synapse, scoped to the operations the engine bot
// needs to perform: joining rooms it's seen activity in, and sending
// `chat.koven.collapse.v1` events into them.
//
// All requests use appservice authentication: pass the as_token, plus
// `?user_id=@engine:...` to act as the bot.  Synapse trusts the
// appservice to masquerade as users in its declared namespace.

import { config } from "./config";
import { isRoomJoined, recordRoomJoined } from "./db";

interface SendOptions {
	type: string;
	content: Record<string, unknown>;
}

async function asFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const sep = path.includes("?") ? "&" : "?";
	const url = `${config.homeserverUrl}${path}${sep}user_id=${encodeURIComponent(config.engineUserId)}`;
	return fetch(url, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.asToken}`,
			...(init.headers ?? {}),
		},
	});
}

/**
 * Join a room as the engine bot.  Idempotent — Synapse returns 200 on
 * an already-joined room, but we still cache locally so we don't hit
 * the homeserver on every event.  Public rooms self-allow joins;
 * private rooms would need an invite (not handled in v1).
 */
export async function joinRoomIfNeeded(roomId: string): Promise<void> {
	if (isRoomJoined(roomId)) return;
	const r = await asFetch(`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
		method: "POST",
		body: JSON.stringify({}),
	});
	if (r.ok) {
		recordRoomJoined(roomId);
		return;
	}
	// 403 here typically means private room without invite.  Log loudly
	// once so we know which rooms are out of reach, but don't crash.
	const txt = await r.text().catch(() => "");
	console.warn(`engine: join ${roomId} → ${r.status} ${txt.slice(0, 120)}`);
	// Mark as "joined" anyway so we don't keep retrying on every event;
	// a manual re-attempt happens by clearing the joined_rooms row.
	if (r.status === 403) recordRoomJoined(roomId);
}

let txnCounter = 0;
function nextTxnId(): string {
	return `engine-${Date.now()}-${++txnCounter}`;
}

/**
 * Send a regular timeline event as the engine bot.  We use timeline
 * (not state) because state events default to power level 50 and the
 * bot joins rooms with power level 0; a normal event keeps the
 * collapse pipeline working without a power-level handshake.
 */
export async function sendBotEvent(roomId: string, opts: SendOptions): Promise<string | null> {
	const txnId = nextTxnId();
	const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(opts.type)}/${encodeURIComponent(txnId)}`;
	const r = await asFetch(path, {
		method: "PUT",
		body: JSON.stringify(opts.content),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`engine: sendBotEvent ${opts.type} → ${r.status} ${txt.slice(0, 200)}`);
		return null;
	}
	const body = await r.json() as { event_id?: string };
	return body.event_id ?? null;
}

/**
 * Deactivate a Synapse account via the admin API.  Two callers:
 *
 *   - Floor-violation suspension (erase=true): the user's homeserver
 *     account is wiped, they can no longer authenticate, all rooms
 *     auto-kick them, and Synapse emits redactions for their content
 *     on a best-effort basis.  This is the real ban — it doesn't
 *     matter what client they try to use afterward.
 *
 *   - Bot deletion (erase=false): the bot's account is deactivated
 *     and Synapse handles the room departures, but past messages
 *     stay in place attributed to the (now deactivated) account.
 *     The BotsPane delete confirmation explicitly promises this.
 *
 * Requires the engine bot to have admin privileges on the homeserver.
 * The default Synapse setup grants admin to the user that owns the
 * registration_shared_secret-issued admin password; for the engine
 * appservice to call this, the bot user (@engine:server) needs admin
 * status set in the Synapse admin DB:
 *
 *   docker exec koven-synapse \
 *     register_new_matrix_user --admin -u engine ...
 *
 * Or update the users table directly.  Setup script handles this on
 * first run.
 *
 * Returns true on success, false on any error (already-deactivated,
 * missing admin rights, etc.).  Caller logs and proceeds; we don't
 * want a transient Synapse hiccup to leave the engine row in a
 * different state than the homeserver.
 */
export async function deactivateUser(userId: string, erase: boolean = true): Promise<boolean> {
	const path = `/_synapse/admin/v1/deactivate/${encodeURIComponent(userId)}`;
	const r = await asFetch(path, {
		method: "POST",
		body: JSON.stringify({ erase }),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`engine: deactivateUser ${userId} (erase=${erase}) → ${r.status} ${txt.slice(0, 200)}`);
		return false;
	}
	return true;
}

// ─── Admin user-token (real admin, not the appservice) ──────────────
//
// /_synapse/admin/v2/users (PUT) and /_synapse/admin/v1/users/<id>/login
// require a real admin user's access token, not the appservice as_token.
// This is by design on Synapse's side: the AS namespace gives the bot
// power to act as users in its declared range, but not to mint tokens
// for arbitrary accounts or set passwords.  We provision a dedicated
// admin user at install time and store its token in SYNAPSE_ADMIN_TOKEN.

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const url = `${config.homeserverUrl}${path}`;
	return fetch(url, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.synapseAdminToken}`,
			...(init.headers ?? {}),
		},
	});
}

/**
 * Admin-create a Synapse user with a random password (the engine
 * doesn't keep it; on every login we rotate it again).  Idempotent in
 * Synapse's sense: PUT against the same user_id updates rather than
 * conflicts.
 *
 * Returns { ok: true } on success or { error } on failure.  The most
 * common error is M_USER_IN_USE (race between two concurrent signups
 * for the same localpart) which the caller surfaces back to the UI.
 */
export async function adminCreateUser(opts: {
	userId: string;
	password: string;
	displayname?: string;
	email?: string;
}): Promise<{ ok: true } | { error: string; detail?: string }> {
	const path = `/_synapse/admin/v2/users/${encodeURIComponent(opts.userId)}`;
	const body: Record<string, unknown> = {
		password: opts.password,
		admin: false,
		deactivated: false,
		// PUT against /admin/v2/users requires logged_in_via to be unset
		// or omitted on creation; passing it would bind the user to a
		// specific OIDC provider id we don't have.
	};
	if (opts.displayname) body.displayname = opts.displayname;
	if (opts.email) {
		body.threepids = [{ medium: "email", address: opts.email }];
	}
	const r = await adminFetch(path, {
		method: "PUT",
		body: JSON.stringify(body),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`engine: adminCreateUser ${opts.userId} → ${r.status} ${txt.slice(0, 200)}`);
		return { error: `synapse_${r.status}`, detail: txt.slice(0, 300) };
	}
	return { ok: true };
}

/**
 * Set (or replace) a user's email 3PID via the admin API.  Used by
 * the install-time admin bootstrap so the operator's email is bound
 * on Synapse's side too, not just in the engine's user_emails table.
 *
 * Synapse stores 3PIDs as a list; passing `threepids: [{...}]` here
 * REPLACES whatever was there.  Fine for a single email but worth
 * knowing if we ever extend this to manage multiple addresses.
 */
export async function adminSetUserEmail(userId: string, email: string): Promise<boolean> {
	const path = `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`;
	const r = await adminFetch(path, {
		method: "PUT",
		body: JSON.stringify({
			threepids: [{ medium: "email", address: email }],
		}),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`engine: adminSetUserEmail ${userId} → ${r.status} ${txt.slice(0, 200)}`);
		return false;
	}
	return true;
}

/**
 * Rotate a Synapse account's password to a fresh random string.  Used
 * on every login (so the value the client gets is the only one it'll
 * ever see) and right before any UIA challenge fires (so the client
 * has a freshly-known password to satisfy the m.login.password stage).
 *
 * The endpoint is the same as adminCreateUser; Synapse PUT against
 * /admin/v2/users/<id> upserts.  We use a smaller body that only
 * carries `password` so we don't accidentally clobber displayname or
 * 3PIDs.  Returns false on any HTTP error.
 */
export async function adminResetPassword(userId: string, password: string): Promise<boolean> {
	const path = `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`;
	const r = await adminFetch(path, {
		method: "PUT",
		body: JSON.stringify({ password, logout_devices: false }),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`engine: adminResetPassword ${userId} → ${r.status} ${txt.slice(0, 200)}`);
		return false;
	}
	return true;
}

/**
 * Mint a fresh access token by logging in with username + password
 * via the regular `/_matrix/client/v3/login` endpoint.  Used by the
 * email-code flow: we rotate the user's Synapse password to a known
 * random value (adminResetPassword) and then log in with it here.
 *
 * Why not /_synapse/admin/v1/users/<id>/login?  Two reasons:
 *
 *   1. Synapse refuses to let an admin admin-mint a token for
 *      themselves ("Cannot use admin API to login as self") — and
 *      our admin user signs in to Koven web like everyone else.
 *   2. The regular login API doesn't need admin auth, just the
 *      password we just set.  Simpler, fewer privileged calls.
 *
 * Returns { access_token, device_id, user_id } on success, or { error }.
 */
export async function loginAsUser(userId: string, password: string): Promise<
	| { access_token: string; device_id: string; user_id: string }
	| { error: string; detail?: string }
> {
	// Synapse accepts either a localpart or a full mxid in the
	// `m.id.user` identifier; full mxid is unambiguous across
	// homeservers (matters if we ever federate auth).
	const r = await fetch(`${config.homeserverUrl}/_matrix/client/v3/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			type: "m.login.password",
			identifier: { type: "m.id.user", user: userId },
			password,
			initial_device_display_name: "Koven Web",
		}),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`engine: loginAsUser ${userId} → ${r.status} ${txt.slice(0, 200)}`);
		return { error: `synapse_${r.status}`, detail: txt.slice(0, 300) };
	}
	const body = (await r.json()) as {
		access_token?: string;
		device_id?: string;
		user_id?: string;
	};
	if (!body.access_token || !body.device_id || !body.user_id) {
		return { error: "incomplete_login_response" };
	}
	return {
		access_token: body.access_token,
		device_id: body.device_id,
		user_id: body.user_id,
	};
}

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
 * Admin-join a user to a room or space using Synapse's admin
 * `POST /_synapse/admin/v1/join/<roomIdOrAlias>` endpoint.  Synapse
 * mints an `m.room.member` join event with the target user's identity,
 * effectively pulling them into the room without requiring them to
 * issue the join themselves.
 *
 * Required permissions: the admin token must have permission to invite
 * to the room — which on Synapse means either being a member of the
 * room with PL ≥ invite, or the room being publicly joinable
 * (`join_rule == "public"`).  Public rooms always work, so this is
 * what we lean on for default-space auto-join.
 *
 * Idempotent in practice: if the user is already in the room Synapse
 * returns 200 with a benign body.  Errors come back as `{ error }`
 * with the HTTP status preserved so callers can branch.
 */
export async function adminJoinUserToRoom(
	userId: string,
	roomIdOrAlias: string,
): Promise<{ ok: true } | { error: string; detail?: string }> {
	const path = `/_synapse/admin/v1/join/${encodeURIComponent(roomIdOrAlias)}`;
	const r = await adminFetch(path, {
		method: "POST",
		body: JSON.stringify({ user_id: userId }),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		return { error: `synapse_${r.status}`, detail: txt.slice(0, 300) };
	}
	return { ok: true };
}

/**
 * Read the active child room ids of a Matrix space.  Pulls the full
 * state and filters m.space.child events to those that still have a
 * non-empty `via` array — Matrix represents removed children with
 * `content == {}`, so a missing `via` means the child was unset.
 *
 * Returns [] on any error so callers don't have to special-case
 * "couldn't read state" against "no children."
 */
export async function getSpaceChildRoomIds(spaceId: string): Promise<string[]> {
	const path = `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state`;
	const r = await adminFetch(path);
	if (!r.ok) return [];
	const events = (await r.json().catch(() => null)) as
		| Array<{ type?: string; state_key?: string; content?: { via?: unknown } }>
		| null;
	if (!Array.isArray(events)) return [];
	const ids: string[] = [];
	for (const ev of events) {
		if (ev.type !== "m.space.child") continue;
		if (typeof ev.state_key !== "string" || !ev.state_key) continue;
		const via = ev.content?.via;
		if (!Array.isArray(via) || via.length === 0) continue;
		ids.push(ev.state_key);
	}
	return ids;
}

/**
 * Read a room's m.room.join_rules state event.  Returns the
 * `join_rule` string ("public", "invite", "knock", "restricted") or
 * null on error / missing.  Used to skip private children when
 * auto-joining users to a default space — no point in attempting an
 * admin-join that Synapse will reject with M_FORBIDDEN.
 */
export async function getRoomJoinRule(roomId: string): Promise<string | null> {
	const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.join_rules/`;
	const r = await adminFetch(path);
	if (!r.ok) return null;
	const body = (await r.json().catch(() => null)) as { join_rule?: string } | null;
	return typeof body?.join_rule === "string" ? body.join_rule : null;
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
// ─── Per-user media upload + profile avatar ─────────────────────────
//
// Used by the bot platform to set per-bot profile avatars: upload
// the image bytes to Synapse's media repo authenticated AS the bot,
// then set the bot's own `avatar_url` profile field via the standard
// client API.  Synapse won't accept a profile change unless the call
// is authenticated as the user being changed (or by a homeserver
// admin), so the engine reaches in with the bot's stored access
// token rather than the engine's own admin token.

/** Upload `bytes` to Synapse's media repository authenticated by
 * `accessToken`.  Returns the resulting `mxc://` URL on success or
 * { error } on failure.  Caller is responsible for content-type and
 * size validation — Synapse accepts whatever it gets and worries
 * about display in the client. */
export async function uploadMedia(opts: {
	accessToken: string;
	bytes: Uint8Array | ArrayBuffer;
	contentType: string;
	filename?: string;
}): Promise<{ mxc: string } | { error: string; detail?: string }> {
	const url = new URL(`${config.homeserverUrl}/_matrix/media/v3/upload`);
	if (opts.filename) url.searchParams.set("filename", opts.filename);
	const r = await fetch(url, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${opts.accessToken}`,
			"Content-Type": opts.contentType,
		},
		body: opts.bytes as BodyInit,
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`engine: uploadMedia → ${r.status} ${txt.slice(0, 200)}`);
		return { error: `synapse_${r.status}`, detail: txt.slice(0, 300) };
	}
	const body = (await r.json()) as { content_uri?: string };
	if (!body.content_uri) {
		return { error: "incomplete_upload_response" };
	}
	return { mxc: body.content_uri };
}

/** Set the user's profile `avatar_url` to `mxc` (or empty to clear).
 * Authenticated as that user via `accessToken`.  Returns true on
 * success, false on any non-2xx (logged so the operator can check). */
export async function setProfileAvatar(
	accessToken: string,
	userId: string,
	avatarMxc: string,
): Promise<boolean> {
	const r = await fetch(
		`${config.homeserverUrl}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/avatar_url`,
		{
			method: "PUT",
			headers: {
				"Authorization": `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ avatar_url: avatarMxc }),
		},
	);
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`engine: setProfileAvatar ${userId} → ${r.status} ${txt.slice(0, 200)}`);
		return false;
	}
	return true;
}

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

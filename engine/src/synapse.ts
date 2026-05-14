// Outbound HTTP to Synapse, scoped to the operations the engine bot
// needs to perform: joining rooms it's seen activity in, redacting
// events on behalf of users, admin actions, etc.
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
 * bot joins rooms with power level 0; a normal event lets us write
 * without a power-level handshake.
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
 * Deactivate a Synapse account via the admin API.  Callers use
 * `erase=true` so the deactivation is a real wipe — the user can no
 * longer authenticate, all rooms auto-kick them, and Synapse emits
 * redactions for their content on a best-effort basis.
 *
 * Used by bot deletion (owner clicks Delete) and admin moderation
 * actions.  Synapse handles room departures + past-message
 * redactions + profile wipe in one call.
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

// In-memory live token.  Initialised from `config.synapseAdminToken`
// (env / .env), but `adminFetch` will rotate this in place by
// re-logging-in as the admin user whenever Synapse rejects the
// current value with `M_UNKNOWN_TOKEN`.  Avoids requiring an
// operator restart whenever Synapse expires/rotates the token.
let liveAdminToken: string = config.synapseAdminToken;

/// Mint a fresh admin token by logging in as the admin user.
/// Returns null if admin credentials aren't configured (older
/// installs that pre-date the username/password env vars), in
/// which case `adminFetch` falls back to surfacing the 401.
async function refreshAdminToken(): Promise<string | null> {
	if (!config.synapseAdminUser || !config.synapseAdminPassword) {
		console.warn(
			"engine: admin token rejected by Synapse but no SYNAPSE_ADMIN_USER + SYNAPSE_ADMIN_PASSWORD configured to re-mint — re-run `bin/koven bootstrap-admin`",
		);
		return null;
	}
	const url = `${config.homeserverUrl}/_matrix/client/v3/login`;
	const r = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			type: "m.login.password",
			identifier: { type: "m.id.user", user: config.synapseAdminUser },
			password: config.synapseAdminPassword,
			device_id: "koven-engine-admin",
			initial_device_display_name: "Koven engine (admin)",
		}),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.error(
			`engine: admin re-login failed → ${r.status} ${txt.slice(0, 200)}`,
		);
		return null;
	}
	const body = (await r.json().catch(() => null)) as { access_token?: string } | null;
	const token = body?.access_token;
	if (!token) {
		console.error("engine: admin re-login response missing access_token");
		return null;
	}
	console.log("engine: minted fresh admin token via re-login");
	return token;
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
	const url = `${config.homeserverUrl}${path}`;
	const send = (token: string) => fetch(url, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
			...(init.headers ?? {}),
		},
	});

	let r = await send(liveAdminToken);

	// Self-heal on the only failure mode where re-login could plausibly
	// help — Synapse explicitly rejecting our token.  Every other
	// non-2xx status (404, 409, 502, …) means the call is bad for
	// reasons re-login won't fix; surface it to the caller as-is.
	if (r.status === 401 || r.status === 403) {
		// Peek at the body to confirm it's a token problem (vs a per-
		// request authz failure).  Clone so the caller still gets the
		// original response if we don't end up retrying.
		const peek = await r.clone().text().catch(() => "");
		if (/M_UNKNOWN_TOKEN/.test(peek)) {
			const fresh = await refreshAdminToken();
			if (fresh) {
				liveAdminToken = fresh;
				r = await send(liveAdminToken);
			}
		}
	}

	return r;
}

/// One Matrix state-event row, as returned by Synapse's /state APIs.
export interface StateEvent {
	type?: string;
	state_key?: string;
	sender?: string;
	content?: Record<string, unknown>;
}

/**
 * Read a room's full state via Synapse's ADMIN endpoint.  This is
 * the ONLY supported way to read room state from the engine — the
 * client API equivalent (`/_matrix/client/v3/rooms/{id}/state`) is
 * gated by Matrix's "you can only read state for rooms you're in"
 * rule, which silently 403s for any room the engine's admin user
 * isn't a member of.  Across an entire afternoon's worth of
 * features (notification fan-out, auto-join cascade, Explore
 * icons + NSFW flag, default-space child enumeration), every state
 * read silently returned [] / null / false on rooms the admin user
 * wasn't in — until the bugs were noticed individually and fixed.
 *
 * This helper is the permanent fix.  It centralises the choice of
 * endpoint so new state-reading code can't accidentally pick the
 * client API and reintroduce the regression.  If you find yourself
 * about to call `adminFetch("/_matrix/client/v3/rooms/...state")`,
 * use this instead.
 *
 * Returns the parsed state-event array on success.  Returns null
 * (NOT empty array) on any error so callers can distinguish "no
 * matching events" from "couldn't read the room".
 */
export async function readRoomState(roomId: string): Promise<StateEvent[] | null> {
	const path = `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/state`;
	const r = await adminFetch(path);
	if (!r.ok) return null;
	const body = (await r.json().catch(() => null)) as
		| { state?: StateEvent[] }
		| null;
	if (!body || !Array.isArray(body.state)) return null;
	return body.state;
}

/** Lookup a single state event by (type, state_key) from a state
 * array.  Returns the event's `content` (or null when not present).
 * Convenience over `readRoomState(...)?.find(...)` for the common
 * "I just want this one event" case. */
export function pickStateContent(
	state: StateEvent[] | null,
	type: string,
	stateKey: string = "",
): Record<string, unknown> | null {
	if (!state) return null;
	for (const ev of state) {
		if (ev.type === type && ev.state_key === stateKey) {
			return ev.content ?? null;
		}
	}
	return null;
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
 * Concurrency-limited fan-out helper.  Runs `fn` over `items` with at
 * most `concurrency` calls in flight at any moment.  Used by the
 * appservice-transaction cascades (newSpaceChildren → admin-join every
 * space member; newSpaceJoiners → admin-join the new joiner into every
 * child room).  The old serial `for...of` loop took ~50ms × N members
 * to fan out, which is fine at 5 members and felt sluggish past 20.
 *
 * Why not Promise.all everything: at 100 members that's 100 concurrent
 * admin-join requests slammed into one Synapse worker, which produces
 * queue buildup that starves the appservice /transactions response
 * (Bun is single-event-loop, Synapse-side workers are bounded).  A
 * small pool (8) keeps Synapse comfortable while still finishing 100-
 * member fan-outs in ~1s instead of ~6s.
 */
export async function poolAll<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let cursor = 0;
	async function worker() {
		while (true) {
			const idx = cursor++;
			if (idx >= items.length) return;
			// Guarded by the cursor check above.  The cast is to
			// satisfy `noUncheckedIndexedAccess`, which has no way to
			// see that idx < items.length.
			out[idx] = await fn(items[idx] as T, idx);
		}
	}
	const workerCount = Math.min(concurrency, items.length);
	const workers: Promise<void>[] = [];
	for (let i = 0; i < workerCount; i++) workers.push(worker());
	await Promise.all(workers);
	return out;
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
 * Invite a user to a room AS the holder of `accessToken` — a
 * thin wrapper around `POST /_matrix/client/v3/rooms/{roomId}/invite`.
 *
 * Used to pull a bot into a webhook's target room at create time:
 * the bot owner is already in the room (the room picker only lists
 * their joined rooms) so they have invite power; the bot's runtime
 * has an auto-join handler that accepts owner-issued invites
 * (bot_runtime.ts).  Net effect: by the time the webhook is saved,
 * the bot is a member of the target room and the first webhook fire
 * lands cleanly.
 *
 * Idempotent in practice — if the user is already in the room
 * Synapse returns 403 with `M_FORBIDDEN: <user> is already in the
 * room`; we treat that as success.  Same for the user already
 * having a pending invite.  Other failures bubble up so the caller
 * can surface them.
 */
export async function inviteUserToRoom(opts: {
	accessToken: string;
	roomId: string;
	userId: string;
}): Promise<{ ok: true } | { error: string; detail?: string }> {
	const url = `${config.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/invite`;
	let r: Response;
	try {
		r = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${opts.accessToken}`,
			},
			body: JSON.stringify({ user_id: opts.userId }),
		});
	} catch (err) {
		return { error: "network", detail: err instanceof Error ? err.message : String(err) };
	}
	if (r.ok) return { ok: true };
	const txt = await r.text().catch(() => "");
	// Idempotency: "already in the room" / "already invited" are
	// both fine for our use case — the goal state is "user is a
	// member or invited member", which is already true.
	if (r.status === 403 && /already in the room|already invited/i.test(txt)) {
		return { ok: true };
	}
	return { error: `synapse_${r.status}`, detail: txt.slice(0, 300) };
}

/**
 * Promote a user to PL `max(existing_admins) + 1` in a room via
 * Synapse's admin endpoint `POST /_synapse/admin/v1/rooms/{roomId}
 * /make_room_admin`.  Used by the invite-permission self-heal: the
 * engine elevates its own appservice user to enough PL to fix a
 * busted m.room.power_levels (typically a stranded `invite > 0` on
 * a public room) without anyone in the UI having to click a repair
 * button.
 *
 * Caveats:
 *   - Requires at least one existing admin in the room (Synapse
 *     masquerades as them to issue the elevation).
 *   - Permanent: there's no admin endpoint to demote afterwards.
 *     We accept that: the engine's user is a system identity, and
 *     it being a room admin is effectively a Koven-platform invariant.
 *   - Idempotent in practice — calling twice on the same user just
 *     re-emits the elevation event.
 */
export async function makeUserRoomAdmin(
	userId: string,
	roomId: string,
): Promise<{ ok: true } | { error: string; detail?: string }> {
	const path = `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/make_room_admin`;
	const r = await adminFetch(path, {
		method: "POST",
		body: JSON.stringify({ user_id: userId }),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`engine: makeUserRoomAdmin ${userId} in ${roomId} → ${r.status} ${txt.slice(0, 200)}`);
		return { error: `synapse_${r.status}`, detail: txt.slice(0, 300) };
	}
	return { ok: true };
}

/**
 * List every room on the homeserver via the Synapse admin API,
 * paginating through all pages.  Returns a flat array with the
 * fields the orphan-deleter needs (id, name, member count, type,
 * creator, encryption flag).  Synapse's admin/v1/rooms returns up
 * to `limit` rooms per page (default 100, capped at 500); this
 * helper walks `next_token` until exhausted.  At Koven's scale
 * (hundreds of rooms) this is a handful of round-trips.
 */
export async function listAllRooms(): Promise<Array<{
	roomId: string;
	name: string | null;
	roomType: string | null;
	memberCount: number;
	creator: string | null;
	encryption: string | null;
	joinRule: string | null;
}>> {
	const out: Array<{
		roomId: string;
		name: string | null;
		roomType: string | null;
		memberCount: number;
		creator: string | null;
		encryption: string | null;
		joinRule: string | null;
	}> = [];
	let from = 0;
	const limit = 500;
	for (let i = 0; i < 200; i++) {
		// `order_by=name` is stable, `dir=f` is forward; we use `from`
		// (offset) since `next_token` is just an offset string in
		// admin/v1/rooms.  Each page returns `total_rooms` so we know
		// when we've covered everything.
		const path = `/_synapse/admin/v1/rooms?from=${from}&limit=${limit}`;
		const r = await adminFetch(path);
		if (!r.ok) {
			const txt = await r.text().catch(() => "");
			console.warn(`engine: listAllRooms page from=${from} → ${r.status} ${txt.slice(0, 200)}`);
			break;
		}
		const body = (await r.json().catch(() => null)) as {
			rooms?: Array<{
				room_id: string;
				name: string | null;
				room_type: string | null;
				joined_members: number;
				creator: string | null;
				encryption: string | null;
				join_rules: string | null;
			}>;
			next_batch?: number;
			total_rooms?: number;
		} | null;
		if (!body?.rooms || body.rooms.length === 0) break;
		for (const r of body.rooms) {
			out.push({
				roomId: r.room_id,
				name: r.name ?? null,
				roomType: r.room_type ?? null,
				memberCount: r.joined_members ?? 0,
				creator: r.creator ?? null,
				encryption: r.encryption ?? null,
				joinRule: r.join_rules ?? null,
			});
		}
		if (typeof body.next_batch !== "number") break;
		from = body.next_batch;
	}
	return out;
}

/**
 * Hard-delete a room via Synapse's admin DELETE endpoint.  Kicks
 * every member, blocks future joins, and (when `purge: true`)
 * removes the room's history from the database.  Used by the
 * one-time orphan-room cleanup that runs after the Discord-style
 * invariant ships — every room without an m.space.parent (and not
 * a DM, not a space itself) gets purged.
 *
 * Synapse runs the delete as a background task and returns a
 * delete_id immediately; this helper just kicks it off and trusts
 * Synapse to finish.  For our cleanup we don't need to poll the
 * status because the job is idempotent (re-running on a
 * partially-deleted room is fine) and the next listAllRooms()
 * call will reflect the new state once Synapse catches up.
 */
export async function adminDeleteRoom(opts: {
	roomId: string;
	message?: string;
}): Promise<{ ok: true; deleteId?: string } | { error: string; detail?: string }> {
	const path = `/_synapse/admin/v2/rooms/${encodeURIComponent(opts.roomId)}`;
	const r = await adminFetch(path, {
		method: "DELETE",
		body: JSON.stringify({
			block: true,
			purge: true,
			message: opts.message ?? "Room removed by Koven cleanup (orphan rooms are no longer permitted; rejoin via the parent space).",
		}),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`engine: adminDeleteRoom ${opts.roomId} → ${r.status} ${txt.slice(0, 200)}`);
		return { error: `synapse_${r.status}`, detail: txt.slice(0, 300) };
	}
	const body = (await r.json().catch(() => ({}))) as { delete_id?: string };
	return { ok: true, deleteId: body.delete_id };
}

/**
 * Repair a room's m.room.power_levels so any member can issue
 * invites — the invariant Koven's createRoom has always meant to
 * apply but historically wrote as a follow-up sendStateEvent that
 * could fail silently and leave the room with Synapse's default
 * (`invite: 50` on older room versions).
 *
 * Strategy:
 *   1. Read current PL state.  If `invite` is already ≤ 0, no-op.
 *   2. Elevate the engine's appservice user via make_room_admin so
 *      it has enough PL to write the PL state event.
 *   3. PUT a fresh m.room.power_levels with the same content but
 *      `invite: 0`.  Other fields are preserved verbatim — the goal
 *      is the minimum-invasive fix that unblocks the picker, not a
 *      wholesale PL re-write that might trample manual tweaks.
 *
 * Returns:
 *   - { ok: true, repaired: true }  on a successful fix
 *   - { ok: true, repaired: false } when no fix was needed
 *   - { error }                     on any step failure
 */
export async function repairRoomInvitePL(
	roomId: string,
): Promise<
	| { ok: true; repaired: boolean }
	| { error: string; detail?: string }
> {
	const state = await readRoomState(roomId);
	if (!state) {
		return { error: "state_unreadable", detail: "couldn't read room state via admin API" };
	}
	const pl = pickStateContent(state, "m.room.power_levels", "");
	const currentInvite = pl && typeof (pl as Record<string, unknown>).invite === "number"
		? ((pl as { invite: number }).invite)
		: 0;
	if (currentInvite <= 0) {
		// Already open.  This will be the common case after the
		// atomic createRoom fix lands; the self-heal still gets
		// called on every M_FORBIDDEN as a defensive sweep.
		return { ok: true, repaired: false };
	}

	// Step 1a: join @engine to the room.  make_room_admin only
	// sets the target user's PL — it does NOT join them.  Without
	// this we end up at PL 100 but Synapse refuses our state
	// event PUT because non-members can't write to a room they
	// aren't in (M_FORBIDDEN: "user not in room").
	//
	// admin /join is idempotent: returns success when @engine is
	// already a member.  We rely on that being the common case
	// (the engine joins every room with timeline activity via
	// joinRoomIfNeeded), so this admin call is mostly a no-op.
	const join = await adminJoinUserToRoom(config.engineUserId, roomId);
	if ("error" in join) {
		return { error: "engine_join_failed", detail: join.detail ?? join.error };
	}

	// Step 1b: give @engine enough PL to write m.room.power_levels.
	// make_room_admin sets PL to max+1 so we land above the existing
	// creator (typically PL 100) and clear the room's
	// events["m.room.power_levels"] threshold.
	const elevate = await makeUserRoomAdmin(config.engineUserId, roomId);
	if ("error" in elevate) {
		return { error: "elevate_failed", detail: elevate.detail ?? elevate.error };
	}

	// Step 2: PUT the new PL.  Preserve every existing field; only
	// flip `invite`.  Content not present in the original is
	// untouched (so e.g. a custom `events` table survives).
	const newContent: Record<string, unknown> = {
		...(pl as Record<string, unknown> | null ?? {}),
		invite: 0,
	};
	// State event PUT — when state_key is empty, the canonical form
	// is `/state/{eventType}` with NO trailing slash.  An earlier
	// version of this URL had a trailing slash that some Synapse
	// versions interpret as a non-empty zero-length state key, 400ing
	// the request before the auth check even runs.  Belt-and-
	// suspenders: omit the trailing slash entirely.
	const putPath =
		`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels`;
	const r = await asFetch(putPath, {
		method: "PUT",
		body: JSON.stringify(newContent),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`engine: repairRoomInvitePL PUT ${roomId} → ${r.status} ${txt.slice(0, 200)}`);
		return { error: `synapse_${r.status}`, detail: txt.slice(0, 300) };
	}
	console.log(`engine: repaired invite PL on ${roomId} (was ${currentInvite}, now 0)`);
	return { ok: true, repaired: true };
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
	const state = await readRoomState(spaceId);
	if (!state) return [];
	const ids: string[] = [];
	for (const ev of state) {
		if (ev.type !== "m.space.child") continue;
		if (typeof ev.state_key !== "string" || !ev.state_key) continue;
		const via = (ev.content as { via?: unknown } | undefined)?.via;
		if (!Array.isArray(via) || via.length === 0) continue;
		ids.push(ev.state_key);
	}
	return ids;
}

/**
 * True iff the given room id is a Matrix space (m.room.create with
 * `type: "m.space"`).  Used to skip sub-space cascades when
 * auto-joining everyone-in-a-server to its rooms — sub-spaces stay
 * an explicit opt-in, mirroring the client-side
 * joinSpaceWithChildren / leaveSpaceWithChildren rules.
 *
 * Returns false on any error (room unreadable, type field missing,
 * etc.) so the auto-join path defaults to "treat as a regular room"
 * and goes ahead with the join.  Wrong direction would be auto-
 * joining everyone to a sub-space they didn't ask for.
 */
export async function isSpaceRoom(roomId: string): Promise<boolean> {
	const create = pickStateContent(await readRoomState(roomId), "m.room.create");
	return create?.type === "m.space";
}

/**
 * Read the user ids of the room's currently-joined members via
 * Synapse's admin /members endpoint (NOT the client API — see
 * `readRoomState` for the rationale that applies here too: the
 * client API requires room membership we don't always have).
 *
 * Filters to `membership: "join"` and skips @bot-* service users
 * (they're managed via the engine's bot runtime) plus the
 * appservice's own user.
 *
 * Returns [] on any error so callers don't have to special-case.
 */
export async function getJoinedMembers(roomId: string): Promise<string[]> {
	const path = `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`;
	const r = await adminFetch(path);
	if (!r.ok) return [];
	const body = (await r.json().catch(() => null)) as
		| { members?: unknown }
		| null;
	if (!body || !Array.isArray(body.members)) return [];
	const ids: string[] = [];
	for (const m of body.members) {
		if (typeof m !== "string") continue;
		if (/^@bot-/.test(m)) continue;
		if (/^@koven-engine[:_]/.test(m)) continue;
		ids.push(m);
	}
	return ids;
}

/**
 * Like `getJoinedMembers` but INCLUDES bots.  Use for cascades that
 * need to mirror a space's full participant set into child rooms:
 * the human-only filter on the regular helper is correct for
 * member-count UI / call participant lists, but it silently dropped
 * bots out of the "new child → existing members" cascade so new
 * rooms in a space were created without the space's bots in them.
 * This variant still excludes the engine appservice user because it
 * isn't a participant (it joins rooms on its own via joinRoomIfNeeded
 * when it needs to write moderation events).
 */
export async function getAllJoinedMembers(roomId: string): Promise<string[]> {
	const path = `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/members`;
	const r = await adminFetch(path);
	if (!r.ok) return [];
	const body = (await r.json().catch(() => null)) as
		| { members?: unknown }
		| null;
	if (!body || !Array.isArray(body.members)) return [];
	const ids: string[] = [];
	for (const m of body.members) {
		if (typeof m !== "string") continue;
		if (/^@koven-engine[:_]/.test(m)) continue;
		ids.push(m);
	}
	return ids;
}

/**
 * Read a room's current m.room.name + m.room.create from a single
 * /state pull.  Returns null on any error (room not found, network
 * glitch, etc.) so callers don't have to special-case "couldn't read
 * state."  Either field may be undefined inside the result if the
 * corresponding state event is absent (a freshly-created room without
 * an m.room.name yet, for instance).
 */
export async function getRoomNameAndCreator(roomId: string): Promise<{
	name?: string;
	creator?: string;
} | null> {
	const state = await readRoomState(roomId);
	if (!state) return null;
	let name: string | undefined;
	let creator: string | undefined;
	for (const ev of state) {
		if (ev.type === "m.room.name" && ev.state_key === "" && typeof ev.content?.name === "string") {
			name = ev.content.name;
		} else if (ev.type === "m.room.create" && ev.state_key === "" && typeof ev.sender === "string") {
			creator = ev.sender;
		}
		if (name !== undefined && creator !== undefined) break;
	}
	return { name, creator };
}

/**
 * Set a room's listing in the homeserver's public-rooms directory.
 * `'public'` makes it discoverable in Explore + via federation peers'
 * directory queries; `'private'` removes it from both surfaces (the
 * room still works for existing members, just stops being broadcast).
 *
 * Auth uses the admin token rather than the appservice as_token
 * because the directory endpoint is owned by the room (not appservice
 * namespace) — the admin can act on any room.
 */
export async function setRoomDirectoryVisibility(
	roomId: string,
	visibility: "public" | "private",
): Promise<boolean> {
	const path = `/_matrix/client/v3/directory/list/room/${encodeURIComponent(roomId)}`;
	const r = await adminFetch(path, {
		method: "PUT",
		body: JSON.stringify({ visibility }),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(
			`engine: setRoomDirectoryVisibility ${roomId} → ${visibility} failed: ` +
			`${r.status} ${txt.slice(0, 200)}`,
		);
		return false;
	}
	return true;
}

/**
 * Read a room's m.room.join_rules state event.  Returns the
 * `join_rule` string ("public", "invite", "knock", "restricted") or
 * null on error / missing.  Used to skip private children when
 * auto-joining users to a default space — no point in attempting an
 * admin-join that Synapse will reject with M_FORBIDDEN.
 */
export async function getRoomJoinRule(roomId: string): Promise<string | null> {
	const content = pickStateContent(await readRoomState(roomId), "m.room.join_rules");
	const r = content?.join_rule;
	return typeof r === "string" ? r : null;
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
/**
 * List local users sorted by registration time (oldest first), via
 * Synapse's admin API.  Pages through 100-row chunks until the
 * response indicates no more.  Filters out:
 *   - bot users (`@bot-*` namespace)
 *   - the engine's own service account
 *   - guest accounts and deactivated accounts
 *
 * Used by the founder-table boot backfill to populate the first
 * `cap` slots in registration order, so existing users (who signed
 * up before the founder feature shipped) get their numbers
 * assigned correctly without needing to re-register.  Bounded by
 * `cap` so we stop pulling pages once we've seen enough — for a
 * 666-cap, even servers with millions of users only fetch ~7 pages.
 */
export async function adminListLocalUsersByRegistration(
	cap: number,
): Promise<{ user_id: string; creation_ts: number }[]> {
	const out: { user_id: string; creation_ts: number }[] = [];
	const limit = 100;
	let from = 0;
	while (out.length < cap) {
		const path = `/_synapse/admin/v2/users?limit=${limit}&from=${from}`
			+ `&order_by=creation_ts&dir=f&deactivated=false&guests=false`;
		const r = await adminFetch(path, { method: "GET" });
		if (!r.ok) {
			const txt = await r.text().catch(() => "");
			console.warn(`engine: adminListLocalUsersByRegistration → ${r.status} ${txt.slice(0, 200)}`);
			break;
		}
		const body = (await r.json().catch(() => null)) as
			| { users?: Array<{ name?: string; creation_ts?: number; user_type?: string | null }>;
			    next_token?: string | number; total?: number }
			| null;
		const users = Array.isArray(body?.users) ? body!.users : [];
		if (users.length === 0) break;
		for (const u of users as Array<{ name?: string; creation_ts?: number; user_type?: string | null; admin?: boolean }>) {
			if (typeof u.name !== "string") continue;
			if (typeof u.creation_ts !== "number") continue;
			// Skip bot users (appservice-owned, namespace prefix).
			const localpart = u.name.startsWith("@") ? u.name.slice(1).split(":")[0]! : "";
			if (localpart.startsWith("bot-")) continue;
			// Skip the engine's own appservice user by full mxid.
			// `@engine:server` typically has user_type=null on Synapse
			// (appservice senders aren't tagged as bots in the user
			// table), so the user_type filter below misses it; explicit
			// match by config.engineUserId is the only reliable gate.
			if (u.name === config.engineUserId) continue;
			// Skip Synapse admins (the homeserver service account, ops
			// accounts, etc).  These users sign in via the admin API
			// flow rather than being community members in the same
			// sense.  Catches @koven-admin, @koven-svc, and any future
			// admin-flagged service identities without us having to
			// enumerate them.
			if (u.admin === true) continue;
			// user_type is null for normal users, "bot" for some
			// appservice-owned bots, "guest" for guests.  Skip non-null
			// types so only real human accounts get a founder slot.
			if (u.user_type) continue;
			out.push({ user_id: u.name, creation_ts: u.creation_ts });
			if (out.length >= cap) break;
		}
		if (typeof body?.next_token !== "string" && typeof body?.next_token !== "number") break;
		from = typeof body.next_token === "number" ? body.next_token : Number(body.next_token);
		if (!Number.isFinite(from)) break;
	}
	return out;
}

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
export type AdminResetPasswordResult =
	| { ok: true }
	| { ok: false; status: number; detail: string };

// MXID of the engine's own service account, computed once.  Empty if
// SYNAPSE_ADMIN_USER isn't configured, in which case the self-rotation
// guard below is effectively disabled — better than firing on the
// wrong target.
const SERVICE_ACCOUNT_MXID = config.synapseAdminUser
	? `@${config.synapseAdminUser}:${config.homeserverName}`
	: "";

export async function adminResetPassword(
	userId: string,
	password: string,
): Promise<AdminResetPasswordResult> {
	// Defensive guard: refuse to rotate the engine's OWN service-
	// account password.  The engine authenticates every admin call
	// with SYNAPSE_ADMIN_TOKEN — minted for whichever user holds it
	// (the user named in SYNAPSE_ADMIN_USER).  Rotating that user's
	// password breaks two invariants:
	//
	//   1. .env's SYNAPSE_ADMIN_PASSWORD goes stale, so adminFetch's
	//      self-heal path (re-login-as-admin on M_UNKNOWN_TOKEN)
	//      can't recover — one external disturbance and we're
	//      locked out for good.
	//   2. The current `logout_devices: false` keeps the in-memory
	//      token alive across rotations, but that's a fragile
	//      contract — any future code path that passes
	//      `logout_devices: true` (operator manually rotates,
	//      Synapse upgrade default change, etc.) instantly nukes
	//      the engine's auth.
	//
	// In a correctly-configured install this guard never fires:
	// `bin/koven bootstrap-admin` separates the engine's service
	// account (@koven-svc by default) from the operator's email-
	// bound account (@admin / @<derived> by default), and the only
	// caller of this function — the email-code login flow — looks
	// up the email→user_id binding which resolves to the operator,
	// never the service account.
	//
	// If you're seeing this refusal in logs, your install has the
	// operator's email bound directly to the service-account user
	// (the historical pre-split shape).  Fix:
	//
	//   bin/koven migrate-prod-svc-account
	//
	// — provisions a separate service account and swaps the engine's
	// SYNAPSE_ADMIN_TOKEN onto it without touching operator history.
	if (SERVICE_ACCOUNT_MXID && userId === SERVICE_ACCOUNT_MXID) {
		console.error(
			`engine: REFUSED to rotate password for ${userId} — that's this engine's own service account. ` +
			`Operator email is bound to the service-account user (broken historical shape). ` +
			`Run \`bin/koven migrate-prod-svc-account\` to split them.`,
		);
		return {
			ok: false,
			status: 0,
			detail:
				"engine refused to rotate its own service-account password — " +
				"the operator's email is misconfigured.  " +
				"Run `bin/koven migrate-prod-svc-account` to fix.",
		};
	}

	const path = `/_synapse/admin/v2/users/${encodeURIComponent(userId)}`;
	const r = await adminFetch(path, {
		method: "PUT",
		body: JSON.stringify({ password, logout_devices: false }),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`engine: adminResetPassword ${userId} → ${r.status} ${txt.slice(0, 200)}`);
		return { ok: false, status: r.status, detail: txt.slice(0, 200) };
	}
	return { ok: true };
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

/** Mint an access token for `userId` via Synapse's admin-only
 * "login as a user" endpoint — `POST /_synapse/admin/v1/users/{id}/login`.
 *
 * Bypasses the regular `/v3/login` rate limit (which is per-IP and
 * tightens fast under load), so it's the right path for batch
 * scripts that need to mint tokens for many users in quick
 * succession (e.g. dev seeders).  Production code should keep
 * using `loginAsUser`; this helper is for tooling.
 */
export async function adminMintUserToken(userId: string): Promise<
	| { access_token: string; device_id: string }
	| { error: string; detail?: string }
> {
	const path = `/_synapse/admin/v1/users/${encodeURIComponent(userId)}/login`;
	const r = await adminFetch(path, { method: "POST", body: JSON.stringify({}) });
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		return { error: `synapse_${r.status}`, detail: txt.slice(0, 300) };
	}
	const body = (await r.json()) as { access_token?: string; device_id?: string };
	if (!body.access_token) {
		return { error: "no_access_token" };
	}
	return {
		access_token: body.access_token,
		device_id: body.device_id ?? "koven-seed",
	};
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

/**
 * Register a user inside the engine appservice's exclusive `@bot-*`
 * namespace, authenticated with the as_token.
 *
 * Why we can't use the admin API: when a namespace is declared
 * `exclusive: true` in the appservice yaml, Synapse refuses creates
 * for matching localparts via /_synapse/admin/v2/users with
 * M_EXCLUSIVE — only the appservice itself is allowed to mint
 * accounts there.  This is the supported way to do it: a /register
 * call with `type: "m.login.application_service"` and the as_token
 * in Authorization, which Synapse short-circuits past UIA and just
 * provisions the user.
 *
 * Returns the new account's access token + device id (Synapse mints
 * both as part of the register response, which is convenient — no
 * second password-login round-trip).  `displayname` is set in a
 * follow-up profile call because the register endpoint doesn't
 * accept it.
 */
export async function registerAppserviceUser(opts: {
	username: string;             // localpart only (e.g. "bot-jeeves")
	displayname?: string;
}): Promise<
	| { access_token: string; device_id: string; user_id: string }
	| { error: string; detail?: string }
> {
	const url = `${config.homeserverUrl}/_matrix/client/v3/register`;
	const r = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.asToken}`,
		},
		body: JSON.stringify({
			type: "m.login.application_service",
			username: opts.username,
		}),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(
			`engine: registerAppserviceUser ${opts.username} → ${r.status} ${txt.slice(0, 200)}`,
		);
		return { error: `synapse_${r.status}`, detail: txt.slice(0, 300) };
	}
	const body = (await r.json()) as {
		access_token?: string;
		device_id?: string;
		user_id?: string;
	};
	if (!body.access_token || !body.user_id) {
		return { error: "incomplete_register_response" };
	}
	const userId = body.user_id;
	const accessToken = body.access_token;
	// Synapse may omit device_id on AS-register.  Fall back to a
	// stable label so callers always have something to persist.
	const deviceId = body.device_id ?? "koven-bot";

	// Set displayname if requested.  We use the new account's own
	// access token (rather than the as_token) so the profile event
	// is signed by the bot itself.  Failure here is non-fatal — the
	// user can rename the bot via display-name patch later.
	if (opts.displayname) {
		try {
			const dnUrl =
				`${config.homeserverUrl}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`;
			const dnRes = await fetch(dnUrl, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${accessToken}`,
				},
				body: JSON.stringify({ displayname: opts.displayname }),
			});
			if (!dnRes.ok) {
				const txt = await dnRes.text().catch(() => "");
				console.warn(
					`engine: registerAppserviceUser ${opts.username} displayname set → ${dnRes.status} ${txt.slice(0, 200)}`,
				);
			}
		} catch (err) {
			console.warn(`engine: registerAppserviceUser ${opts.username} displayname set threw`, err);
		}
	}

	return {
		access_token: accessToken,
		device_id: deviceId,
		user_id: userId,
	};
}

// ─── Helpers acting under a user's bearer token ─────────────────────
//
// These mirror the appservice helpers above but authenticate as a
// specific human user, using the bearer token they sent us.  The user
// has whatever Matrix-side power level they actually possess — we're
// just relaying their action to Synapse rather than running our own
// admin override.  Two upshots:
//
//   * Authorization is enforced by Synapse, not by us.  If the
//     caller doesn't have the redact/kick/ban PL, Synapse rejects.
//   * The resulting state event is signed by the caller, so the room's
//     timeline correctly attributes the action to them rather than to
//     `@engine`.

async function userFetch(
	bearerToken: string,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	return fetch(`${config.homeserverUrl}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${bearerToken}`,
			...(init.headers ?? {}),
		},
	});
}

/**
 * Redact a message in `roomId` using the caller's access token.  The
 * caller must satisfy Matrix's redaction rules: either be the original
 * sender (always allowed) or hold a power level ≥ the room's
 * `events.m.room.redaction` PL (Koven sets that to 100, so non-senders
 * are effectively excluded — which is the intended behaviour for the
 * trash-button flow: only the sender or a bot's owner-via-bot-token
 * should be redacting their own content).
 *
 * Returns true on 2xx, false on any error (logs a warning).
 */
export async function redactEventAs(opts: {
	bearerToken: string;
	roomId: string;
	eventId: string;
	reason?: string;
}): Promise<boolean> {
	const txnId = `koven-${Date.now()}-${++txnCounter}`;
	const path = `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/redact/${encodeURIComponent(opts.eventId)}/${encodeURIComponent(txnId)}`;
	const r = await userFetch(opts.bearerToken, path, {
		method: "PUT",
		body: JSON.stringify(opts.reason ? { reason: opts.reason } : {}),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`engine: redactEventAs ${opts.roomId}/${opts.eventId} → ${r.status} ${txt.slice(0, 200)}`);
		return false;
	}
	return true;
}

/**
 * Kick or ban a member from a room as the calling user.  Used by the
 * founder bot kick/ban flow — we don't gate it ourselves because
 * Synapse already enforces the room's PL: founder has 100, kick/ban
 * PL is 100 in Koven rooms, so it just works.  If a non-founder calls
 * this, Synapse returns 403.
 *
 * `kind` decides which Matrix endpoint to hit; semantics match the
 * spec: kick removes the user but they can rejoin; ban removes them
 * and prevents rejoin until unbanned.
 */
export async function kickOrBanAs(opts: {
	bearerToken: string;
	roomId: string;
	targetUserId: string;
	kind: "kick" | "ban";
	reason?: string;
}): Promise<boolean> {
	const path = `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/${opts.kind}`;
	const r = await userFetch(opts.bearerToken, path, {
		method: "POST",
		body: JSON.stringify({
			user_id: opts.targetUserId,
			...(opts.reason ? { reason: opts.reason } : {}),
		}),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`engine: ${opts.kind} ${opts.targetUserId} from ${opts.roomId} → ${r.status} ${txt.slice(0, 200)}`);
		return false;
	}
	return true;
}

/**
 * Have a user voluntarily leave a room under their own bearer.  Used
 * by the space-wide bot removal path when the caller is the bot's
 * OWNER (not the space founder) — we can't issue a PL-based kick
 * because the owner has no power in the foreign space, but the bot
 * itself can always leave on its own.  Same end state, different
 * authorization model.
 *
 * Synapse 200s on success; rooms the user isn't in return 403
 * (not a member) which we treat as a no-op success since the
 * desired end state is "not a member" either way.
 */
export async function leaveRoomAs(opts: {
	bearerToken: string;
	roomId: string;
	reason?: string;
}): Promise<boolean> {
	const path = `/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/leave`;
	const r = await userFetch(opts.bearerToken, path, {
		method: "POST",
		body: JSON.stringify(opts.reason ? { reason: opts.reason } : {}),
	});
	if (r.ok) return true;
	// 403 "not a member" is the desired end state already.  Anything
	// else (network, real auth failure, room doesn't exist) is a real
	// error.
	if (r.status === 403) {
		const txt = await r.text().catch(() => "");
		if (txt.includes("not in") || txt.includes("not a member")) return true;
	}
	const txt = await r.text().catch(() => "");
	console.warn(`engine: leave ${opts.roomId} → ${r.status} ${txt.slice(0, 200)}`);
	return false;
}

/**
 * Read a room's Koven icon emoji from the `chat.koven.room_icon`
 * state event.  Returns the trimmed emoji string when set + valid,
 * or null when the event doesn't exist / the content is malformed /
 * Synapse rejects the read (admin token unavailable, room missing,
 * etc.).
 *
 * Used by the Explore-page enrichment endpoint: the public rooms
 * directory chunk only returns standard fields (name, topic,
 * avatar_url, member count), so we have to fetch this state event
 * per-room to mirror what `readKovenIconEmoji` does inside the
 * client SDK.  Admin token bypasses room-membership gating, which
 * matters since the engine may not be joined to every public room
 * yet (e.g. a freshly-created room that hasn't seen its first
 * timeline event the appservice gets pushed into yet).
 */
/**
 * Read the room's NSFW flag from its `chat.koven.nsfw` state event.
 * Used by the Explore-page enrichment endpoint so the directory can
 * filter NSFW rooms for users who haven't opted into adult-content
 * discovery.  Same admin-token pattern as getRoomIconEmoji — the
 * engine isn't necessarily a member of every public room, so we
 * bypass membership-gated /state by going through admin.
 *
 * Returns false on any error or missing/malformed state event;
 * defaulting to "not NSFW" is the safer fallback.
 */
/** One admin /state fetch, both Koven custom state events extracted.
 * Used by /api/explore-meta where each room needs both `chat.koven.
 * nsfw` and `chat.koven.room_icon` — pulling them in a single
 * request halves the round-trips vs. calling getRoomNsfw + the icon
 * fn separately.  Same admin-endpoint fix as getJoinedMembers /
 * getSpaceChildRoomIds: client API `/rooms/{id}/state/<type>` 403s
 * when the engine's admin user isn't in the room, which after the
 * @koven-admin → @koven-svc migration is most rooms — Explore
 * tiles silently fell back to DiceBear because both reads returned
 * null/false. */
export async function getRoomKovenMeta(roomId: string): Promise<{
	iconEmoji: string | null;
	nsfw: boolean;
}> {
	const state = await readRoomState(roomId);
	const icon = pickStateContent(state, "chat.koven.room_icon");
	const nsfw = pickStateContent(state, "chat.koven.nsfw");
	let iconEmoji: string | null = null;
	if (typeof icon?.emoji === "string") {
		const trimmed = icon.emoji.trim();
		if (trimmed && trimmed.length <= 16) iconEmoji = trimmed;
	}
	return { iconEmoji, nsfw: nsfw?.enabled === true };
}

export async function getRoomNsfw(roomId: string): Promise<boolean> {
	return (await getRoomKovenMeta(roomId)).nsfw;
}

export async function getRoomIconEmoji(roomId: string): Promise<string | null> {
	return (await getRoomKovenMeta(roomId)).iconEmoji;
}

/**
 * Read `m.read` receipts for a room, rolled-forward so each event
 * sees every reader whose receipt anchors AT that event OR any
 * later one.  Mirrors `MatrixTransport.getMessageSeenBy` on the
 * web (`client/src/lib/matrix.ts`): from the anchor event, walk
 * forward through the timeline and accumulate the first
 * occurrence of each user.  A user who has read message #50 shows
 * on messages #1-50, not just on #50 — which is the visual the
 * sender actually wants when looking at "seen by".
 *
 * Implementation:
 *   1. Use the admin user's `/sync` to grab both the timeline
 *      (last 250 events — generous so most loaded screens have
 *      coverage) AND the ephemeral `m.receipt` events.
 *   2. Build a `userId → readEventIndex` map from receipts.
 *   3. For each timeline event, the set of readers is every user
 *      whose `readEventIndex` ≥ this event's index.
 *
 * Returns the rolled-forward `{ eventId: [readers] }` map.
 * Bots / services / `@bot-*` are NOT filtered here — the calling
 * endpoint applies the bot-roster filter.
 */
export async function getRoomSeenBy(roomId: string): Promise<Record<string, string[]>> {
	const filter = {
		room: {
			rooms: [roomId],
			// 250 events is enough to cover the typical "scroll-back
			// before the user gives up" window without bloating the
			// /sync response.  The cap is the same shape the web
			// client uses for its in-memory timeline.
			timeline: { limit: 250 },
			state: { types: [] as string[] },
			ephemeral: { types: ["m.receipt"] },
		},
		presence: { types: [] as string[] },
		account_data: { types: [] as string[] },
	};
	const filterJson = encodeURIComponent(JSON.stringify(filter));
	// adminFetch (real Synapse admin user, not the appservice).  The
	// appservice user isn't joined to most rooms — it observes them
	// through namespace claim rather than membership — so its /sync
	// returns nothing.  The admin user IS joined and /sync gives us
	// the full receipt cache.
	const r = await adminFetch(`/_matrix/client/v3/sync?filter=${filterJson}&timeout=0`);
	if (!r.ok) return {};
	const body = (await r.json().catch(() => null)) as {
		rooms?: {
			join?: Record<string, {
				timeline?: { events?: Array<{ event_id?: string }> };
				ephemeral?: { events?: Array<{ type?: string; content?: Record<string, unknown> }> };
			}>;
		};
	} | null;
	const roomData = body?.rooms?.join?.[roomId];
	const timelineEvents = roomData?.timeline?.events ?? [];
	const ephemeralEvents = roomData?.ephemeral?.events ?? [];

	// Map event_id → index (ascending: oldest first per Matrix's
	// timeline convention).
	const eventIndex = new Map<string, number>();
	for (let i = 0; i < timelineEvents.length; i++) {
		const id = timelineEvents[i]?.event_id;
		if (typeof id === "string") eventIndex.set(id, i);
	}

	// Each user has ONE current read receipt; if it shows up more
	// than once in the ephemeral stream, the highest index wins.
	const userReadIndex = new Map<string, number>();
	for (const ev of ephemeralEvents) {
		if (ev?.type !== "m.receipt" || !ev.content) continue;
		for (const [eventId, types] of Object.entries(ev.content)) {
			const reads = (types as Record<string, unknown> | null)?.["m.read"] as
				| Record<string, unknown>
				| undefined;
			if (!reads) continue;
			const idx = eventIndex.get(eventId);
			// Receipts on events that fall outside our 250-event
			// window are silently dropped — they're for messages
			// the iOS client almost certainly hasn't paginated to.
			if (idx === undefined) continue;
			for (const userId of Object.keys(reads)) {
				if (typeof userId !== "string" || !userId.startsWith("@")) continue;
				const existing = userReadIndex.get(userId);
				if (existing === undefined || idx > existing) {
					userReadIndex.set(userId, idx);
				}
			}
		}
	}

	// Roll forward: each event's readers = every user with
	// userReadIndex ≥ this event's index.  Stored eventId→readers.
	const byEvent: Record<string, string[]> = {};
	const allReaders = Array.from(userReadIndex.entries());
	for (let i = 0; i < timelineEvents.length; i++) {
		const eventId = timelineEvents[i]?.event_id;
		if (typeof eventId !== "string") continue;
		const readers = allReaders
			.filter(([, readerIdx]) => readerIdx >= i)
			.map(([userId]) => userId);
		if (readers.length > 0) byEvent[eventId] = readers;
	}
	return byEvent;
}

/**
 * Read a single timeline event's sender + minimal metadata.  Used by
 * the self-delete authorization check: the engine needs to know who
 * originally sent a message before it'll let someone redact it.
 *
 * Authenticated as the appservice (via the as_token / engine user_id
 * — same channel as `sendBotEvent` etc.).  The engine bot is a member
 * of every room the appservice is monitoring, so /event lookups
 * succeed for any timeline message the engine could otherwise observe.
 *
 * Returns null on any error (event not found, room not joinable, etc.)
 * so callers can convert to a 404 / 403.
 */
export async function getEventSender(
	roomId: string,
	eventId: string,
): Promise<{ sender: string; type: string } | null> {
	const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`;
	const r = await asFetch(path);
	if (!r.ok) return null;
	const body = (await r.json().catch(() => null)) as { sender?: string; type?: string } | null;
	if (!body || typeof body.sender !== "string" || typeof body.type !== "string") return null;
	return { sender: body.sender, type: body.type };
}

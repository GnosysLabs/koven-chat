// Engine HTTP client for instance-wide config (branding) and admin
// status.  The login screen reads the config before any user is signed
// in, so all reads here are unauthenticated; writes carry the user's
// Matrix access token so the engine can verify admin rights.

import { ENGINE_URL } from "@/lib/urls";

export interface InstanceConfig {
	name?: string;
	login_background_url?: string;
	login_tagline?: string;
	logo_url?: string;
	// Space new users are auto-joined to (along with its public child
	// rooms) on first signup.  Empty/unset = no default space.
	default_space_id?: string;
	[key: string]: string | undefined;
}

export interface InstanceConfigResponse {
	config: InstanceConfig;
}

/**
 * Resolve a config URL value — paths starting with `/static/` are
 * served by the engine itself; everything else is treated as already
 * absolute.  Lets admins paste either a public URL or rely on the
 * engine's own asset hosting.
 */
export function resolveAssetUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	if (value.startsWith("/static/")) return `${ENGINE_URL}${value}`;
	return value;
}

export async function fetchInstanceConfig(): Promise<InstanceConfig> {
	const r = await fetch(`${ENGINE_URL}/api/instance`, { credentials: "omit" });
	if (!r.ok) throw new Error(`engine /api/instance → ${r.status}`);
	const body = (await r.json()) as InstanceConfigResponse;
	return body.config ?? {};
}

export interface MeResponse {
	user_id: string | null;
	is_admin: boolean;
	// Total admins on the instance.  Surfaced so the Settings → Account
	// "Delete account" path can refuse to deactivate the only admin.
	admin_count?: number;
	is_only_admin?: boolean;
}

export async function fetchAdminStatus(accessToken: string): Promise<MeResponse> {
	const r = await fetch(`${ENGINE_URL}/api/instance/me`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) return { user_id: null, is_admin: false };
	return (await r.json()) as MeResponse;
}

// ─── Admin management ────────────────────────────────────────────────
//
// The engine maintains its own admins table (separate from Synapse
// server admins).  First user the engine sees is auto-promoted on
// bootstrap; everyone else has to be granted explicitly by an
// existing admin.  These helpers wrap the three /api/admins endpoints
// the Settings → Instance UI uses.

export interface AdminRow {
	user_id: string;
	granted_at: number;
	// User who granted the admin row.  Null when the row was set by
	// the bootstrap path (first-user-becomes-admin) — there was no
	// previous admin to attribute the grant to.
	granted_by: string | null;
}

/** Fetch every current admin row, oldest grant first.  Returns null
 * on auth/network failure so the UI can render an empty state rather
 * than crash. */
export async function listAdmins(accessToken: string): Promise<AdminRow[] | null> {
	const r = await fetch(`${ENGINE_URL}/api/admins`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) return null;
	const body = (await r.json()) as { admins: AdminRow[] };
	return body.admins;
}

/** Promote the given user to admin.  Idempotent — granting an
 * already-admin user returns ok with the unchanged count.  `userId`
 * must be a Matrix mxid (`@user:server`); the engine validates the
 * shape and rejects malformed values with M_INVALID_PARAM. */
export async function grantAdminUser(accessToken: string, userId: string): Promise<{ ok: boolean; error?: string }> {
	const r = await fetch(`${ENGINE_URL}/api/admins/grant`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ user_id: userId }),
	});
	if (!r.ok) {
		const body = (await r.json().catch(() => ({}))) as { error?: string };
		return { ok: false, error: body.error ?? `HTTP ${r.status}` };
	}
	return { ok: true };
}

/** Revoke admin from the given user.  Refused with HTTP 409 by the
 * engine when the target is the only remaining admin — caller should
 * surface the error message rather than swallow it.  Idempotent for
 * non-admin targets. */
export async function revokeAdminUser(accessToken: string, userId: string): Promise<{ ok: boolean; error?: string }> {
	const r = await fetch(`${ENGINE_URL}/api/admins/revoke`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ user_id: userId }),
	});
	if (!r.ok) {
		const body = (await r.json().catch(() => ({}))) as { error?: string };
		return { ok: false, error: body.error ?? `HTTP ${r.status}` };
	}
	return { ok: true };
}

/**
 * Self-cleanup hook called immediately before the client asks Synapse
 * to deactivate the account.  Drops any engine-side rows tied to the
 * caller.  Refuses (HTTP 409) if the caller is the only remaining
 * admin (promote another admin first).
 */
export async function purgeMyEngineState(accessToken: string): Promise<{ ok: boolean; error?: string }> {
	const r = await fetch(`${ENGINE_URL}/api/me/purge`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) {
		const body = (await r.json().catch(() => ({}))) as { error?: string };
		return { ok: false, error: body.error ?? `HTTP ${r.status}` };
	}
	return { ok: true };
}

/**
 * Look up which space(s) a given room declares as its parent via
 * `m.space.parent` state events.  Used by the deep-link confirm
 * flow to rewrite "join this room" intents to "join this room's
 * parent space" — Koven's Discord-style invariant says rooms are
 * joined through their space, not directly.
 *
 * Returns [] when the room has no parents (orphan, or
 * state-unreadable on the engine side).  The caller treats an
 * empty list as "fall back to room-direct join."
 */
export async function fetchRoomParents(roomId: string): Promise<string[]> {
	try {
		const r = await fetch(
			`${ENGINE_URL}/api/rooms/${encodeURIComponent(roomId)}/parents`,
		);
		if (!r.ok) return [];
		const body = (await r.json()) as { parents?: unknown };
		if (!Array.isArray(body.parents)) return [];
		return body.parents.filter((p): p is string => typeof p === "string");
	} catch (err) {
		console.warn("fetchRoomParents threw", err);
		return [];
	}
}

// ─── Per-room audit log ──────────────────────────────────────────────

export type ModLogEntry =
	| {
		kind: "flag";
		ts: number;
		event_id: string;
		target_event_id: string;
		flagger: string;
		category: string;
		rationale: string | null;
		// True when the flag was later retracted.  A separate
		// `flag_retracted` entry will appear elsewhere in the feed
		// at the retraction's timestamp; this flag here lets the
		// renderer mark the original entry as withdrawn (e.g.
		// strikethrough) without scanning the rest of the list.
		retracted: boolean;
	}
	| {
		kind: "flag_retracted";
		ts: number;                  // when the retraction happened
		event_id: string;            // the original flag's event id
		target_event_id: string;
		category: string;
		flagger: string;             // who originally flagged
		retracted_by: string;        // mxid that issued the retraction
	}
	| {
		// Voluntary takedown — sender redacted their own message, or
		// a bot's owner redacted the bot's message.  Distinct from
		// `flag_retracted` (which targets the FLAG event, not the
		// message itself).
		kind: "self_deletion";
		ts: number;
		target_event_id: string;
		// Always the human Matrix user who clicked the trash button.
		// For deletion_kind='bot_owner' this is the bot owner, not
		// the bot itself.
		redacted_by: string;
		// The original message's sender.  For deletion_kind='self'
		// this equals redacted_by; for 'bot_owner' this is the
		// bot's mxid.
		target_sender: string;
		deletion_kind: "self" | "bot_owner";
	}
	| {
		// Founder kicked or banned a bot from their room.  Carved
		// out of the consensus model: bots aren't people.  Only the
		// room founder can issue this; only registered bots can
		// be the target.
		kind: "bot_membership";
		ts: number;
		bot_mxid: string;
		// Bot's owner at action time; null only for orphan rows
		// where the bot was already deleted before the founder acted.
		bot_owner: string | null;
		action: "kick" | "ban";
		founder: string;
	};

/**
 * Bulk-fetch the Koven `chat.koven.room_icon` emoji for a list of
 * room ids.  Used by the Explore page to enrich the public rooms
 * directory results: Synapse's /publicRooms chunk doesn't include
 * custom state events, so without this call Explore tiles would
 * fall back to the DiceBear auto-avatar even when the room's
 * founder picked an emoji.
 *
 * Returns a partial map: only rooms with an emoji set appear as
 * keys.  Failures silently drop rooms from the response (engine
 * decides), so the caller defaults to undefined when a key is
 * missing.  Empty-input fast-path skips the fetch entirely.
 */
export async function fetchRoomIcons(
	roomIds: string[],
): Promise<{ icons: Record<string, string>; nsfw: Set<string> }> {
	if (roomIds.length === 0) return { icons: {}, nsfw: new Set() };
	const r = await fetch(`${ENGINE_URL}/api/rooms/icons`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ room_ids: roomIds }),
	});
	if (!r.ok) return { icons: {}, nsfw: new Set() };
	const body = (await r.json()) as { icons?: Record<string, string>; nsfw?: unknown };
	const nsfw = Array.isArray(body.nsfw) ? new Set(body.nsfw as string[]) : new Set<string>();
	return { icons: body.icons ?? {}, nsfw };
}

export async function fetchRoomModLog(roomId: string): Promise<ModLogEntry[]> {
	const r = await fetch(`${ENGINE_URL}/api/rooms/${encodeURIComponent(roomId)}/mod-log`);
	if (!r.ok) return [];
	const body = (await r.json()) as { entries: ModLogEntry[] };
	return body.entries ?? [];
}

/**
 * Self-delete a message.  The engine validates that the caller is
 * either the message's sender or the owner of the sending bot, then
 * performs the redaction under the right access token (caller's for
 * self, bot's stored token for bot-owner) and records a
 * `self_deletion` row in the room's mod log.
 *
 * Throws on 4xx/5xx so callers can show a toast — the most common
 * failure is the engine refusing because the caller doesn't own the
 * target bot.
 */
export async function deleteOwnMessage(
	accessToken: string,
	roomId: string,
	eventId: string,
): Promise<{ ok: true; kind: "self" | "bot_owner" }> {
	const r = await fetch(
		`${ENGINE_URL}/api/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(eventId)}/delete`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
		},
	);
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		throw new Error(`delete failed: ${r.status} ${txt.slice(0, 200)}`);
	}
	return await r.json() as { ok: true; kind: "self" | "bot_owner" };
}

/**
 * Founder-only: kick or ban a bot from a room.  The engine verifies
 * that the caller is the room creator AND the target mxid is a bot
 * registered on this instance.  Either failure returns 403; a Matrix-
 * side rejection (e.g. unusual PL config) returns 502.  On success,
 * the action is recorded as a `bot_membership` mod-log entry.
 */
export async function botKickBan(
	accessToken: string,
	roomId: string,
	botMxid: string,
	action: "kick" | "ban",
): Promise<{ ok: true; action: "kick" | "ban" }> {
	const r = await fetch(
		`${ENGINE_URL}/api/rooms/${encodeURIComponent(roomId)}/bots/${encodeURIComponent(botMxid)}/${action}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
		},
	);
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		throw new Error(`${action} failed: ${r.status} ${txt.slice(0, 200)}`);
	}
	return await r.json() as { ok: true; action: "kick" | "ban" };
}

/**
 * Space-wide kick or ban: silence a bot across the space and every
 * child room in one call.  The engine verifies the caller is the
 * space creator and the target is a bot on this instance; per-room
 * kick is performed with the caller's bearer token via Matrix's
 * normal PL check, so rooms the founder doesn't have PL 100 in
 * (e.g. "Add existing room" with a different creator) are skipped
 * server-side.  Returns counts for both the affected and skipped
 * subsets of rooms.
 */
export async function botKickBanFromSpace(
	accessToken: string,
	spaceId: string,
	botMxid: string,
	action: "kick" | "ban",
): Promise<{ ok: true; action: "kick" | "ban"; succeeded: number; failed: number; total: number }> {
	const r = await fetch(
		`${ENGINE_URL}/api/spaces/${encodeURIComponent(spaceId)}/bots/${encodeURIComponent(botMxid)}/${action}`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
		},
	);
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		throw new Error(`${action} from space failed: ${r.status} ${txt.slice(0, 200)}`);
	}
	return await r.json() as {
		ok: true;
		action: "kick" | "ban";
		succeeded: number;
		failed: number;
		total: number;
	};
}

// ─── Room-target flagging ────────────────────────────────────────────

/** Submit a report against a room as a whole.  Same category set as
 * message reports; the engine records it for admins to act on. */
export async function flagRoom(
	accessToken: string,
	roomId: string,
	category: string,
	rationale?: string,
): Promise<{ ok: boolean; error?: string }> {
	const r = await fetch(`${ENGINE_URL}/api/rooms/${encodeURIComponent(roomId)}/flag`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ category, rationale }),
	});
	if (!r.ok) {
		const body = await r.json().catch(() => ({})) as { error?: string };
		return { ok: false, error: body.error ?? `HTTP ${r.status}` };
	}
	return { ok: true };
}

/** Retract the caller's own active report on a room.  No-op (404) if
 * they had no active report.  Symmetrical with the message-report
 * retract path that fires when the user redacts their
 * chat.koven.flag.v1 event. */
export async function unflagRoom(
	accessToken: string,
	roomId: string,
): Promise<{ ok: boolean; error?: string }> {
	const r = await fetch(`${ENGINE_URL}/api/rooms/${encodeURIComponent(roomId)}/flag`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) {
		const body = await r.json().catch(() => ({})) as { error?: string };
		return { ok: false, error: body.error ?? `HTTP ${r.status}` };
	}
	return { ok: true };
}

export async function updateInstanceConfig(
	accessToken: string,
	patch: Partial<Record<keyof InstanceConfig, string | null>>,
): Promise<InstanceConfig> {
	const r = await fetch(`${ENGINE_URL}/api/instance`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ config: patch }),
	});
	if (!r.ok) {
		const body = await r.json().catch(() => ({})) as { error?: string };
		throw new Error(body.error ?? `engine PUT /api/instance → ${r.status}`);
	}
	const body = (await r.json()) as InstanceConfigResponse;
	return body.config ?? {};
}

async function uploadInstanceImage(
	accessToken: string,
	file: File,
	endpoint: "login-bg" | "logo",
): Promise<InstanceConfig> {
	// Sanitise images before sending: HEIC → PNG conversion + EXIF
	// strip on JPEG/PNG.  Same lazy-loaded helper the chat-attachment
	// + bot/avatar paths use.  Branding images on a public login page
	// are an especially sharp privacy edge — admins routinely use
	// phone photos as login backgrounds, and those carry GPS by
	// default — so keep this consistent with the rest of the surface.
	const { sanitizeImageForUpload } = await import("@/lib/imageSanitize");
	const sanitized = await sanitizeImageForUpload(file);
	const form = new FormData();
	form.append("file", sanitized);
	const r = await fetch(`${ENGINE_URL}/api/instance/${endpoint}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}` },
		body: form,
	});
	if (!r.ok) {
		const body = await r.json().catch(() => ({})) as { error?: string };
		throw new Error(body.error ?? `engine upload → ${r.status}`);
	}
	const body = (await r.json()) as InstanceConfigResponse;
	return body.config ?? {};
}

export function uploadLoginBackground(accessToken: string, file: File): Promise<InstanceConfig> {
	return uploadInstanceImage(accessToken, file, "login-bg");
}

export function uploadLogo(accessToken: string, file: File): Promise<InstanceConfig> {
	return uploadInstanceImage(accessToken, file, "logo");
}

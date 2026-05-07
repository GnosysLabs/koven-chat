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

/**
 * Self-cleanup hook called immediately before the client asks Synapse
 * to deactivate the account.  Drops the user's reputation row + any
 * pending suspension on them.  Refuses (HTTP 409) if the caller is the
 * only remaining admin (promote another admin first).
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

// ─── Suspension state ────────────────────────────────────────────────

export type SuspensionReason =
	| "floor_violation"
	| "repeated_false_floor_flags"
	| "repeated_room_collapses";
export type SuspensionStatus = "pending" | "confirmed" | "reversed" | "dismissed";

export interface SuspensionSummary {
	id: number;
	reason: SuspensionReason;
	status: SuspensionStatus;
	created_at: number;
}

export interface MyStatusResponse {
	user_id: string;
	suspended: boolean;
	suspension: SuspensionSummary | null;
}

/**
 * Probe the engine for the current user's suspension state.  The
 * client polls this on boot (and periodically afterwards) to gate
 * compose / DM creation / room creation when the account is paused.
 * Returns null on auth errors so the caller can degrade gracefully.
 */
export async function fetchMyStatus(accessToken: string): Promise<MyStatusResponse | null> {
	const r = await fetch(`${ENGINE_URL}/api/me/status`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) return null;
	return (await r.json()) as MyStatusResponse;
}

// ─── Admin: floor-violation review queue ─────────────────────────────

export interface PendingSuspension {
	id: number;
	user_id: string;
	reason: SuspensionReason;
	flag_event_id: string | null;
	target_event_id: string | null;
	target_room_id: string | null;
	flagger: string | null;
	status: SuspensionStatus;
	created_at: number;
}

export async function fetchFloorQueue(accessToken: string): Promise<PendingSuspension[]> {
	const r = await fetch(`${ENGINE_URL}/api/admin/floor-queue`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) return [];
	const body = (await r.json()) as { pending: PendingSuspension[] };
	return body.pending ?? [];
}

/** Three review actions:
 *   - confirm: deactivate the reported user, no flagger penalty
 *   - reverse: lift the reported user's suspension AND penalize the
 *              flagger (weight clamp + auto-suspend threshold tick).
 *              Use when the report looks malicious / weaponized.
 *   - dismiss: lift the reported user's suspension, NO flagger
 *              penalty.  Use when the report was a good-faith
 *              mistake — flagger thought it was a violation but
 *              admin disagrees, and there's no malicious intent.
 *
 * The mod log records which action was chosen so users can see how
 * admins are distinguishing between malicious and good-faith cases. */
export type FloorReviewAction = "confirm" | "reverse" | "dismiss";

export async function reviewFloorCase(
	accessToken: string,
	id: number,
	action: FloorReviewAction,
	note?: string,
): Promise<{ ok: boolean; autoSuspendedFlagger?: boolean; deactivated?: boolean; error?: string }> {
	const r = await fetch(`${ENGINE_URL}/api/admin/floor-queue/${id}/${action}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ note: note ?? "" }),
	});
	if (!r.ok) {
		const body = await r.json().catch(() => ({})) as { error?: string };
		return { ok: false, error: body.error ?? `HTTP ${r.status}` };
	}
	const body = await r.json() as { auto_suspended_flagger?: boolean; deactivated?: boolean };
	return {
		ok: true,
		autoSuspendedFlagger: body.auto_suspended_flagger,
		deactivated: body.deactivated,
	};
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
		kind: "collapse";
		ts: number;
		target_event_id: string;
		flagger_count: number;
		weighted_score: number;
		categories: string[];
	}
	| {
		kind: "suspension";
		ts: number;
		id: number;
		user_id: string;
		reason: SuspensionReason;
		flagger: string | null;
		target_event_id: string | null;
		status: SuspensionStatus;
		reviewed_at: number | null;
		reviewed_by: string | null;
	};

export async function fetchRoomModLog(roomId: string): Promise<ModLogEntry[]> {
	const r = await fetch(`${ENGINE_URL}/api/rooms/${encodeURIComponent(roomId)}/mod-log`);
	if (!r.ok) return [];
	const body = (await r.json()) as { entries: ModLogEntry[] };
	return body.entries ?? [];
}

// ─── Room-target flagging (offensive room name pipeline) ─────────────

export interface CollapsedRoom {
	room_id: string;
	collapsed_at: number;
	categories: string[];
	fast_track: boolean;
}

/** Public list of currently-collapsed rooms.  Polled by the SPA on
 * Explore + room-list refresh: the Explore directory hides any room
 * in this list, and any place we render a room name (sidebar, chat
 * header, member sheets) substitutes "Name Removed by Community
 * Review" when the room id matches.  No auth — the override is only
 * meaningful if every client honours it. */
export async function fetchCollapsedRooms(): Promise<CollapsedRoom[]> {
	const r = await fetch(`${ENGINE_URL}/api/rooms/collapsed`);
	if (!r.ok) return [];
	const body = (await r.json()) as { rooms?: CollapsedRoom[] };
	return body.rooms ?? [];
}

/** Submit a flag against a room as a whole.  Same category set as
 * message flags; floor_violation fast-tracks via the engine and opens
 * a suspension on the room's creator pending admin review. */
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

/** Retract the caller's own active flag on a room.  No-op (404) if
 * they had no active flag.  Symmetrical with the message-flag retract
 * path that fires when the user redacts their chat.koven.flag.v1
 * event. */
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
	const form = new FormData();
	form.append("file", file);
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

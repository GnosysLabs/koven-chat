// Engine surface for the per-room voice/video channel feature.
//
// Single endpoint: POST /api/calls/:roomId/join → returns the
// Cloudflare RealtimeKit auth token + meeting id we feed into
// @cloudflare/realtimekit-react to actually connect.  The engine
// handles meeting lazy-create + caching, room-membership check,
// and the Cloudflare API token (which never reaches the client).

import { ENGINE_URL } from "@/lib/urls";
import type { RoomId } from "@koven/shared";

export interface JoinCallResponse {
	meetingId: string;
	authToken: string;
	participantId: string;
	presetName: string;
}

export interface JoinCallError {
	/** Matrix-style error code: "M_NOT_CONFIGURED", "M_FORBIDDEN",
	 * "M_INVALID_PARAM", "M_UNKNOWN" — caller can branch on this for
	 * UX (e.g. hide the Join button entirely when M_NOT_CONFIGURED). */
	errcode: string;
	error: string;
	httpStatus: number;
}

export class CallApiError extends Error {
	readonly errcode: string;
	readonly httpStatus: number;
	constructor(payload: JoinCallError) {
		super(payload.error);
		this.errcode = payload.errcode;
		this.httpStatus = payload.httpStatus;
	}
}

export async function joinCall(opts: {
	accessToken: string;
	roomId: RoomId;
}): Promise<JoinCallResponse> {
	const r = await fetch(
		`${ENGINE_URL}/api/calls/${encodeURIComponent(opts.roomId)}/join`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${opts.accessToken}`,
			},
		},
	);
	const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
	if (!r.ok) {
		throw new CallApiError({
			errcode: typeof body.errcode === "string" ? body.errcode : "M_UNKNOWN",
			error: typeof body.error === "string" ? body.error : `HTTP ${r.status}`,
			httpStatus: r.status,
		});
	}
	return {
		meetingId: String(body.meeting_id ?? ""),
		authToken: String(body.auth_token ?? ""),
		participantId: String(body.participant_id ?? ""),
		presetName: String(body.preset_name ?? ""),
	};
}

export interface CallParticipant {
	userId: string;
	displayName: string;
	avatarUrl: string | null;
	joinedAt: number;
}

export interface ActiveBrowserSession {
	sessionId: string;
	embedUrl: string;
	startedBy: string;
	startedAt: number;
}

export interface ActiveCallState {
	participants: CallParticipant[];
	browserSession: ActiveBrowserSession | null;
}

/** Fetch the live participant list + browser session for a room's
 * voice channel.  Returns empty participants and null browser when
 * no call is active.  Used by RoomVoiceBar to surface the social-
 * signal avatar stack and by CallView for the shared browser. */
export async function listActiveCallState(opts: {
	accessToken: string;
	roomId: RoomId;
}): Promise<ActiveCallState> {
	const r = await fetch(
		`${ENGINE_URL}/api/calls/${encodeURIComponent(opts.roomId)}/active`,
		{
			headers: { Authorization: `Bearer ${opts.accessToken}` },
		},
	);
	if (!r.ok) {
		return { participants: [], browserSession: null };
	}
	const body = (await r.json().catch(() => ({}))) as {
		participants?: Array<{
			user_id: string;
			display_name: string;
			avatar_url: string | null;
			joined_at: number;
		}>;
		browser_session?: {
			session_id: string;
			embed_url: string;
			started_by: string;
			started_at: number;
		} | null;
	};
	const participants = (body.participants ?? []).map(p => ({
		userId: p.user_id,
		displayName: p.display_name,
		avatarUrl: p.avatar_url,
		joinedAt: p.joined_at,
	}));
	const bs = body.browser_session;
	const browserSession = bs ? {
		sessionId: bs.session_id,
		embedUrl: bs.embed_url,
		startedBy: bs.started_by,
		startedAt: bs.started_at,
	} : null;
	return { participants, browserSession };
}

/** Backwards-compatible wrapper for callers that only need the
 * participant list. */
export async function listActiveCallParticipants(opts: {
	accessToken: string;
	roomId: RoomId;
}): Promise<CallParticipant[]> {
	const state = await listActiveCallState(opts);
	return state.participants;
}

/** Tell the engine "I just joined this room's call" — fired
 *  client-side after meeting.joinRoom() resolves.  Self-healing
 *  presence signal: works in dev (where the Cloudflare webhook
 *  isn't registered) and acts as a backstop in prod for cases
 *  where the webhook was missed (foreign meeting id, dropped
 *  delivery).  Idempotent on the engine side. */
export async function pingCallPresenceJoined(opts: {
	accessToken: string;
	roomId: RoomId;
}): Promise<void> {
	await fetch(
		`${ENGINE_URL}/api/calls/${encodeURIComponent(opts.roomId)}/iam-here`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${opts.accessToken}` },
		},
	).catch(() => { /* best-effort */ });
}

/** Counterpart of pingCallPresenceJoined — tell the engine "I'm
 *  out" so the social-signal stack updates immediately on leave
 *  rather than waiting for a webhook timeout. */
export async function pingCallPresenceLeft(opts: {
	accessToken: string;
	roomId: RoomId;
}): Promise<void> {
	await fetch(
		`${ENGINE_URL}/api/calls/${encodeURIComponent(opts.roomId)}/iam-gone`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${opts.accessToken}` },
		},
	).catch(() => { /* best-effort */ });
}

/** Fire-and-forget iam-gone via sendBeacon.  Used by the
 *  beforeunload handler where async fetch won't complete in
 *  time.  sendBeacon queues a POST that the browser guarantees
 *  will be sent even as the page tears down. */
export function pingCallPresenceLeftSync(opts: {
	accessToken: string;
	roomId: RoomId;
}): void {
	const url = `${ENGINE_URL}/api/calls/${encodeURIComponent(opts.roomId)}/iam-gone`;
	// sendBeacon can only send a body, not custom headers.  The
	// engine's iam-gone route reads Authorization from the header,
	// so we fall back to a keepalive fetch which IS allowed during
	// beforeunload (the keepalive flag tells the browser to finish
	// the request after the page dies).
	try {
		fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${opts.accessToken}` },
			keepalive: true,
		}).catch(() => {});
	} catch {
		// Last resort: some browsers may reject keepalive fetch in
		// beforeunload.  Nothing more we can do.
	}
}

// Cloudflare RealtimeKit integration for per-room voice/video.
//
// Each Koven room maps 1:1 to a RealtimeKit Meeting.  The Meeting
// is created lazily — the first user to click Join Voice in a room
// triggers a Create Meeting call to Cloudflare; the resulting
// meeting_id is cached in `room_calls` and reused forever after.
// (RealtimeKit Meetings are persistent virtual rooms — they auto-
// spin a new Session whenever the first participant joins, and
// auto-end the Session shortly after the last participant leaves.
// The Meeting itself never goes away unless we explicitly delete
// it, so caching the id is correct.)
//
// On every Join Voice click, the engine calls Add Participant
// against the cached Meeting id and returns the resulting JWT auth
// token to the client.  The client passes that token to
// @cloudflare/realtimekit-react which then connects directly to
// Cloudflare's SFU — the engine is OUT of the WebRTC path entirely.
//
// Permissions: rather than mint our own access-control layer on
// top, we rely on the Koven access-token-then-room-membership
// check that already gates every other room-scoped endpoint.  If
// the user's Matrix client says they're a member of the room,
// they're allowed to join the call.  Anyone who can read the room
// can hop into voice — same access shape as Discord channels.

import { config } from "./config";
import {
	forgetCallParticipant,
	forgetCallParticipantsByMeeting,
	getRoomCallMeetingId,
	listRoomCallParticipants,
	rememberCallParticipant,
	rememberRoomCall,
	type CallParticipantRow,
} from "./db";

/** Whether the engine has Cloudflare RealtimeKit credentials wired
 * up.  Used by the API layer to short-circuit with a 503 + a
 * "not_configured" error code on instances that haven't set the
 * env vars (so the client can hide the Join Voice button cleanly). */
export function isConfigured(): boolean {
	return (
		config.cfRealtimeAccountId.length > 0
		&& config.cfRealtimeAppId.length > 0
		&& config.cfRealtimeToken.length > 0
	);
}

const API_BASE = "https://api.cloudflare.com/client/v4";

function appUrl(suffix: string): string {
	return `${API_BASE}/accounts/${config.cfRealtimeAccountId}/realtime/kit/${config.cfRealtimeAppId}${suffix}`;
}

function authHeaders(): Record<string, string> {
	return {
		"Authorization": `Bearer ${config.cfRealtimeToken}`,
		"Content-Type": "application/json",
	};
}

interface CfMeeting {
	id: string;
	title: string;
	status: string;
}

interface CfParticipant {
	id: string;
	name: string;
	token: string;            // JWT for the client SDK
	preset_name: string;
	custom_participant_id?: string;
}

interface CfApiError {
	success: false;
	error?: { code: number; message: string };
	errors?: Array<{ code: number; message: string }>;
}

function describeCfError(body: unknown, status: number): string {
	const e = body as CfApiError;
	if (e?.error?.message) return `${e.error.message} (${status})`;
	if (e?.errors?.[0]?.message) return `${e.errors[0].message} (${status})`;
	return `Cloudflare HTTP ${status}`;
}

// ─── REST wrappers ────────────────────────────────────────────────

/** Create a fresh RealtimeKit Meeting.  Returns the meeting id.
 * Title is whatever; we use the Koven room id so the Cloudflare
 * dashboard is grep-able. */
async function cfCreateMeeting(title: string): Promise<string> {
	const r = await fetch(appUrl("/meetings"), {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ title }),
	});
	const body = await r.json().catch(() => ({}));
	if (!r.ok) {
		throw new Error(`cfCreateMeeting: ${describeCfError(body, r.status)}`);
	}
	const data = (body as { data?: CfMeeting }).data;
	if (!data?.id) throw new Error("cfCreateMeeting: response missing data.id");
	return data.id;
}

/** Add a participant to a meeting.  Returns the JWT auth token
 * the client SDK needs to join the session.  Tokens are
 * single-use per the docs — the client should not cache them; a
 * new participant entry is created for every Join Voice click. */
async function cfAddParticipant(opts: {
	meetingId: string;
	name: string;
	customId: string;
	pictureUrl?: string;
}): Promise<CfParticipant> {
	const r = await fetch(appUrl(`/meetings/${opts.meetingId}/participants`), {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			name: opts.name,
			preset_name: config.cfRealtimePreset,
			custom_participant_id: opts.customId,
			...(opts.pictureUrl ? { picture: opts.pictureUrl } : {}),
		}),
	});
	const body = await r.json().catch(() => ({}));
	if (!r.ok) {
		throw new Error(`cfAddParticipant: ${describeCfError(body, r.status)}`);
	}
	const data = (body as { data?: CfParticipant }).data;
	if (!data?.token || !data?.id) {
		throw new Error("cfAddParticipant: response missing data.token or data.id");
	}
	return data;
}

// ─── Public entry point ──────────────────────────────────────────

export interface JoinCallResult {
	/** RealtimeKit Meeting id (stable per Koven room — cached). */
	meetingId: string;
	/** Per-join JWT the client SDK needs to actually connect. */
	authToken: string;
	/** Cloudflare's participant id (echoed back in events). */
	participantId: string;
	/** Preset name applied (so the client knows what features are
	 * granted — host vs participant vs guest etc.). */
	presetName: string;
}

/** Mint a join token for `userId` to enter the voice call in
 * `roomId`.  Lazy-creates the underlying RealtimeKit Meeting on
 * first call for a given room, caches the meeting id thereafter.
 *
 * Caller is responsible for upstream checks:
 *   - room membership (handled by the route handler in server.ts)
 *   - rate limiting (per-user, per-room) if we add one later
 *
 * Throws on Cloudflare API failures so the route handler can
 * return a 503 with a reasonable detail. */
export async function joinCall(opts: {
	roomId: string;
	userId: string;
	displayName: string;
	avatarUrl?: string;
}): Promise<JoinCallResult> {
	if (!isConfigured()) {
		throw new Error("calls: Cloudflare RealtimeKit not configured");
	}

	let meetingId = getRoomCallMeetingId(opts.roomId);
	if (!meetingId) {
		// Lazy-create.  Title is the Koven room id so the Cloudflare
		// dashboard groups the right Meetings to the right rooms;
		// not user-visible.
		meetingId = await cfCreateMeeting(opts.roomId);
		rememberRoomCall({
			roomId: opts.roomId,
			cfMeetingId: meetingId,
			createdBy: opts.userId,
		});
		console.log(`calls: created RealtimeKit Meeting ${meetingId} for room ${opts.roomId} (by ${opts.userId})`);
	}

	const participant = await cfAddParticipant({
		meetingId,
		name: opts.displayName,
		customId: opts.userId,
		pictureUrl: opts.avatarUrl,
	});

	return {
		meetingId,
		authToken: participant.token,
		participantId: participant.id,
		presetName: participant.preset_name,
	};
}

// ─── Webhook handling ─────────────────────────────────────────────

/** Subset of the Cloudflare RealtimeKit webhook payload we care
 * about.  The full payload has more fields (timestamps, region,
 * etc.) but for the social-signal indicator we only need to know
 * who joined / left which Meeting. */
interface CfWebhookEvent {
	event: string;
	meeting?: { id?: string };
	participant?: {
		id?: string;
		name?: string;
		picture?: string;
		custom_participant_id?: string;
	};
}

/** Resolve a Cloudflare Meeting id back to its Koven room id by
 * walking the cached mapping.  Cheap (single indexed SELECT) and
 * eliminates the need to track meeting → room state separately. */
function roomIdForMeeting(cfMeetingId: string): string | null {
	// Reverse lookup helper — small enough to inline rather than
	// add a dedicated DB function for it.  Walks `room_calls` for
	// a row with this meeting id.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { db } = require("./db") as { db: { prepare(s: string): { get(...args: unknown[]): unknown } } };
	const stmt = db.prepare("SELECT room_id FROM room_calls WHERE cf_meeting_id = ?");
	const row = stmt.get(cfMeetingId) as { room_id?: string } | undefined;
	return row?.room_id ?? null;
}

/** Apply one Cloudflare RealtimeKit webhook event to the engine's
 * mirror of who's in voice.  Tolerant of missing fields (we just
 * skip — Cloudflare may add new event shapes we don't recognise). */
export function applyWebhookEvent(ev: CfWebhookEvent): void {
	const meetingId = ev.meeting?.id;
	if (!meetingId) {
		console.warn(`calls webhook: skipping ${ev.event} — no meeting.id in payload`);
		return;
	}

	const roomId = roomIdForMeeting(meetingId);
	if (!roomId) {
		// Webhook for a meeting we don't have cached.  Could happen
		// if a user joined a Meeting we created on another env, or
		// if our DB was wiped.  Safe to ignore.
		console.warn(`calls webhook: ${ev.event} for unknown meeting ${meetingId}`);
		return;
	}

	switch (ev.event) {
		case "meeting.participantJoined": {
			const p = ev.participant;
			if (!p?.id) {
				console.warn(`calls webhook: participantJoined missing participant.id`);
				return;
			}
			rememberCallParticipant({
				roomId,
				cfParticipantId: p.id,
				userId: p.custom_participant_id ?? p.id,
				displayName: p.name ?? "Unknown",
				avatarUrl: p.picture ?? null,
			});
			console.log(`calls: ${p.custom_participant_id ?? p.id} joined room ${roomId}`);
			return;
		}
		case "meeting.participantLeft": {
			const p = ev.participant;
			if (!p?.id) {
				console.warn(`calls webhook: participantLeft missing participant.id`);
				return;
			}
			forgetCallParticipant(p.id);
			console.log(`calls: ${p.custom_participant_id ?? p.id} left room ${roomId}`);
			return;
		}
		case "meeting.ended": {
			// Catch-all: drop every participant for this meeting.
			// Belt-and-braces in case individual participantLeft
			// events are dropped or coalesced when a session ends
			// abruptly (network teardown, host kick-all, etc.).
			forgetCallParticipantsByMeeting(meetingId);
			console.log(`calls: meeting ${meetingId} ended (room ${roomId}) — cleared participants`);
			return;
		}
		default:
			// Unknown / uninteresting event.  RealtimeKit ships
			// recording / livestreaming / chat / transcript / summary
			// events too; we don't subscribe to those, but tolerate
			// them landing here in case a future registration adds
			// more without us updating this switch.
			console.log(`calls webhook: ignoring ${ev.event}`);
			return;
	}
}

// ─── Public read API for active participants ─────────────────────

/** Live participant list for a room, used by the room voice bar's
 * social signal.  Empty array when no call is active. */
export function activeParticipantsFor(roomId: string): CallParticipantRow[] {
	return listRoomCallParticipants(roomId);
}

// ─── Webhook self-registration ───────────────────────────────────

const WEBHOOK_NAME = "koven-engine-call-presence";
const WEBHOOK_EVENTS = [
	"meeting.participantJoined",
	"meeting.participantLeft",
	"meeting.ended",
] as const;

/** Idempotently ensure that a webhook is registered with
 * RealtimeKit pointing at this engine's `cf-webhook/<secret>`
 * endpoint.  Called from boot — listing existing webhooks first
 * and only POSTing if no row matches our name + url + events.
 *
 * Failures are logged + swallowed: a missing webhook just means
 * the social-signal indicator is empty, not that anything else
 * breaks.  Engine still serves Join requests correctly.
 *
 * `publicEngineUrl` is the externally-reachable base of this
 * engine (e.g. https://client.koven.chat).  In dev with no
 * public URL this can be left null and registration is skipped. */
export async function ensureWebhookRegistered(opts: {
	publicEngineUrl: string | null;
}): Promise<void> {
	if (!isConfigured()) return;
	if (!config.cfRealtimeWebhookSecret) {
		console.warn("calls: CF_REALTIME_WEBHOOK_SECRET unset — skipping webhook registration");
		return;
	}
	if (!opts.publicEngineUrl) {
		console.warn("calls: no publicEngineUrl — skipping webhook registration (dev mode)");
		return;
	}

	const targetUrl = `${opts.publicEngineUrl.replace(/\/+$/, "")}/api/calls/cf-webhook/${config.cfRealtimeWebhookSecret}`;

	try {
		// List existing webhooks first.  If one already matches
		// (same name, same url, same events) we're done.
		const listRes = await fetch(appUrl("/webhooks"), { headers: authHeaders() });
		if (!listRes.ok) {
			console.warn(`calls: webhook list failed: ${describeCfError(await listRes.json().catch(() => ({})), listRes.status)}`);
			return;
		}
		const list = (await listRes.json()) as {
			data?: Array<{ id: string; name: string; url: string; events: string[] }>;
		};
		const existing = (list.data ?? []).find(w =>
			w.name === WEBHOOK_NAME
			&& w.url === targetUrl
			&& WEBHOOK_EVENTS.every(e => w.events.includes(e))
		);
		if (existing) {
			console.log(`calls: webhook already registered (id=${existing.id})`);
			return;
		}

		const createRes = await fetch(appUrl("/webhooks"), {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				name: WEBHOOK_NAME,
				url: targetUrl,
				events: WEBHOOK_EVENTS,
				enabled: true,
			}),
		});
		const body = await createRes.json().catch(() => ({}));
		if (!createRes.ok) {
			console.warn(`calls: webhook register failed: ${describeCfError(body, createRes.status)}`);
			return;
		}
		const created = (body as { data?: { id?: string } }).data;
		console.log(`calls: registered RealtimeKit webhook (id=${created?.id}) → ${targetUrl}`);
	} catch (err) {
		console.warn("calls: webhook register threw", err);
	}
}

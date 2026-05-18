// Hyperbeam shared-browser integration for in-call co-browsing.
//
// Each room can have at most one active Hyperbeam session at a time.
// The engine proxies the Hyperbeam REST API so the API key never
// reaches the client.  Clients learn about active sessions via the
// existing /api/calls/:roomId/active poll (augmented with a
// browser_session field).
//
// Lifecycle: any call participant can start a shared browser; the
// session persists until explicitly stopped or the idle reaper
// notices that no call participants remain.  Hyperbeam's own
// timeout.inactive (300s) is the server-side backup.

import { config } from "./config";
import {
	endBrowserSession as dbEndBrowserSession,
	getActiveBrowserSession,
	listActiveBrowserSessions,
	listRoomCallParticipants,
	rememberBrowserSession,
	type BrowserSessionRow,
} from "./db";

const API_BASE = "https://engine.hyperbeam.com/v0";

export function isHyperbeamConfigured(): boolean {
	return config.hyperbeamApiKey.length > 0;
}

function authHeaders(): Record<string, string> {
	return {
		"Authorization": `Bearer ${config.hyperbeamApiKey}`,
		"Content-Type": "application/json",
	};
}

export interface BrowserSessionResult {
	sessionId: string;
	embedUrl: string;
	startedBy: string;
	startedAt: number;
}

/** Create a Hyperbeam VM and record it in the DB.  Returns the
 * existing session if one is already active (idempotent). */
export async function createBrowserSession(opts: {
	roomId: string;
	userId: string;
}): Promise<BrowserSessionResult> {
	const existing = getActiveBrowserSession(opts.roomId);
	if (existing) {
		return {
			sessionId: existing.session_id,
			embedUrl: existing.embed_url,
			startedBy: existing.started_by,
			startedAt: existing.started_at,
		};
	}

	const r = await fetch(`${API_BASE}/vm`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			start_url: "https://www.google.com",
			timeout: {
				absolute: 14400,
				inactive: 300,
			},
		}),
	});
	const body = await r.json().catch(() => ({})) as Record<string, unknown>;
	if (!r.ok) {
		const msg = typeof body.message === "string" ? body.message : `HTTP ${r.status}`;
		throw new Error(`hyperbeam: create VM failed: ${msg}`);
	}

	const sessionId = String(body.session_id ?? "");
	const embedUrl = String(body.embed_url ?? "");
	if (!sessionId || !embedUrl) {
		throw new Error("hyperbeam: response missing session_id or embed_url");
	}

	rememberBrowserSession({
		roomId: opts.roomId,
		sessionId,
		embedUrl,
		startedBy: opts.userId,
	});
	console.log(`hyperbeam: created session ${sessionId} for room ${opts.roomId} (by ${opts.userId})`);

	return {
		sessionId,
		embedUrl,
		startedBy: opts.userId,
		startedAt: Date.now(),
	};
}

/** End the active Hyperbeam session for a room.  Idempotent (no-op
 * if no session is active).  Tells Hyperbeam to destroy the VM and
 * marks the DB row ended. */
export async function destroyBrowserSession(roomId: string): Promise<void> {
	const session = getActiveBrowserSession(roomId);
	if (!session) return;

	dbEndBrowserSession(roomId);
	console.log(`hyperbeam: ended session ${session.session_id} for room ${roomId}`);

	try {
		const r = await fetch(`${API_BASE}/vm/${session.session_id}`, {
			method: "DELETE",
			headers: authHeaders(),
		});
		if (!r.ok && r.status !== 404) {
			console.warn(`hyperbeam: DELETE /vm/${session.session_id} returned ${r.status}`);
		}
	} catch (err) {
		// Best-effort.  The DB row is already ended; Hyperbeam's own
		// inactive timeout handles the orphaned VM.
		console.warn(`hyperbeam: DELETE /vm/${session.session_id} threw`, err);
	}
}

/** Fetch the active browser session for a room (thin DB wrapper). */
export function getActiveSession(roomId: string): BrowserSessionRow | null {
	return getActiveBrowserSession(roomId);
}

/** Reap browser sessions in rooms with no call participants.  Called
 * from the engine tick alongside reapStaleCallParticipants.  Returns
 * the number of sessions reaped. */
export async function reapIdleBrowserSessions(): Promise<number> {
	const active = listActiveBrowserSessions();
	let reaped = 0;
	for (const session of active) {
		const participants = listRoomCallParticipants(session.room_id);
		if (participants.length === 0) {
			await destroyBrowserSession(session.room_id);
			reaped++;
		}
	}
	return reaped;
}

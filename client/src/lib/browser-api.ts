// Engine API surface for shared Hyperbeam browser sessions.
//
// Parallel to calls-api.ts.  The engine proxies the Hyperbeam API
// key, so the client only needs the room id + access token to start
// or stop a session.  Session state is piggybacked on the existing
// /api/calls/:roomId/active poll (parsed in calls-api.ts).

import { ENGINE_URL } from "@/lib/urls";
import type { RoomId } from "@koven/shared";

export interface BrowserSession {
	sessionId: string;
	embedUrl: string;
	startedBy: string;
	startedAt: number;
}

export async function startBrowserSession(opts: {
	accessToken: string;
	roomId: RoomId;
}): Promise<BrowserSession> {
	const r = await fetch(
		`${ENGINE_URL}/api/calls/${encodeURIComponent(opts.roomId)}/browser/start`,
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
		const msg = typeof body.error === "string" ? body.error : `HTTP ${r.status}`;
		throw new Error(msg);
	}
	return {
		sessionId: String(body.session_id ?? ""),
		embedUrl: String(body.embed_url ?? ""),
		startedBy: String(body.started_by ?? ""),
		startedAt: Number(body.started_at ?? 0),
	};
}

export async function stopBrowserSession(opts: {
	accessToken: string;
	roomId: RoomId;
}): Promise<void> {
	const r = await fetch(
		`${ENGINE_URL}/api/calls/${encodeURIComponent(opts.roomId)}/browser/stop`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${opts.accessToken}`,
			},
		},
	);
	if (!r.ok) {
		const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
		const msg = typeof body.error === "string" ? body.error : `HTTP ${r.status}`;
		throw new Error(msg);
	}
}

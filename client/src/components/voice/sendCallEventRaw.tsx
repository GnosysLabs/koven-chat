// Shared helper for client-side components that need to send a
// chat.koven.call.* event into a Matrix room without going through
// the MatrixTransport (which lives inside App's TransportContext
// and isn't always reachable from every call site).  Used by
// IncomingRingListener (decline event) and could be used by any
// future ring-related UI.
//
// Mirror of the same helper inside lib/call-context.tsx — kept in
// a separate file because the call-context helper is a private
// `function sendCallEvent` used internally by the provider, and
// re-exporting it would crack the encapsulation boundary.  Two
// tiny copies are cleaner than one tangled re-export.

import { HOMESERVER_URL } from "@/lib/urls";
import type { RoomId } from "@koven/shared";

export async function sendCallEventRaw(opts: {
	accessToken: string;
	roomId: RoomId;
	eventType: string;
	content: Record<string, unknown>;
}): Promise<string | null> {
	const txnId = `koven-call-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const url = `${HOMESERVER_URL}/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/send/${encodeURIComponent(opts.eventType)}/${encodeURIComponent(txnId)}`;
	try {
		const r = await fetch(url, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${opts.accessToken}`,
			},
			body: JSON.stringify(opts.content),
		});
		if (!r.ok) {
			console.warn(`sendCallEventRaw ${opts.eventType} → ${r.status}`);
			return null;
		}
		const body = (await r.json().catch(() => ({}))) as { event_id?: string };
		return body.event_id ?? null;
	} catch (err) {
		console.warn(`sendCallEventRaw ${opts.eventType} threw`, err);
		return null;
	}
}

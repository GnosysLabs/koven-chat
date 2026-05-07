// Public roster of every bot mxid on this homeserver.  No auth
// required — drives the BOT badge wherever a user is rendered and
// (eventually) the @-autocomplete suggestion list.
//
// We fetch once at boot and refresh on a generous interval; bot
// creation / deletion is rare enough that staleness on the order of
// minutes is acceptable.  The component-level fetch in BotsPane
// gives us up-to-date display names for the management view; this
// cache is only the mxid set used for "is this user a bot?" lookups.

import { ENGINE_URL } from "@/lib/urls";
import type { UserId } from "@koven/shared";

interface AllMxidsResponse {
	bots?: string[];
}

/** Pull the public list of bot mxids from the engine.  Always
 * returns a Set — empty on error so callers can treat it as the
 * default "no badge anywhere" state without tripping over null. */
export async function fetchAllBotMxids(): Promise<Set<UserId>> {
	try {
		const r = await fetch(`${ENGINE_URL}/api/bots/all-mxids`, { credentials: "omit" });
		if (!r.ok) return new Set();
		const body = (await r.json()) as AllMxidsResponse;
		return new Set((body.bots ?? []) as UserId[]);
	} catch {
		return new Set();
	}
}

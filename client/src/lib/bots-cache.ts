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

export interface PublicBotEntry {
	mxid: UserId;
	displayName: string;
	avatarMxc: string | null;
	/** Bot's owner.  Used to gate which bots show up in invite /
	 * DM-start pickers — group invites for non-owners are server-side
	 * rejected anyway, so offering a non-owner's bot in the picker
	 * just produces a click-to-fail UX. */
	ownerId: UserId;
	/** Whether this bot accepts DMs from non-owners.  Drives the
	 * StartDmSheet filter — bots with this off are effectively
	 * private to their owner and shouldn't show up to anyone else. */
	acceptDms: boolean;
}

interface DirectoryResponse {
	bots?: Array<{
		mxid: string;
		display_name: string;
		avatar_mxc: string | null;
		owner_id: string;
		accept_dms: boolean;
	}>;
}

/** Richer roster — display name + avatar + owner_id + accept_dms —
 * used by the invite picker so freshly-created bots show up before
 * they've joined any rooms (Synapse's user directory only indexes
 * users with shared room membership).  Empty on error so the caller
 * can treat the directory search as the canonical source and add
 * bots on top.
 *
 * Filtering is deliberately the caller's job: the InviteSheet wants
 * own-bots-only (group invites are server-side owner-only), while
 * the StartDmSheet wants own + accept_dms.  Returning the full set +
 * letting callers slice it keeps this function dumb. */
export async function fetchBotDirectory(): Promise<PublicBotEntry[]> {
	try {
		const r = await fetch(`${ENGINE_URL}/api/bots/directory`, { credentials: "omit" });
		if (!r.ok) return [];
		const body = (await r.json()) as DirectoryResponse;
		return (body.bots ?? []).map(b => ({
			mxid: b.mxid as UserId,
			displayName: b.display_name,
			avatarMxc: b.avatar_mxc,
			ownerId: b.owner_id as UserId,
			acceptDms: b.accept_dms,
		}));
	} catch {
		return [];
	}
}

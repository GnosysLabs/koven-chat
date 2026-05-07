// mxid display helpers.
//
// Matrix user ids are `@localpart:server`.  Inside one homeserver
// most users only see other users from THAT server, so the `:server`
// suffix on every caption becomes visual noise — same as a username
// in an email being shown as "alice@example.com" inside example.com.
//
// `formatMxid` collapses the suffix when the mxid is on the same
// server as the viewing user; cross-server mxids keep the full form
// so federation users are visibly distinct.

import type { UserId } from "@koven/shared";

/**
 * Drop the `:server` suffix iff `mxid` is on `viewerServer`.  Returns
 * `mxid` unchanged when either input is malformed.
 *
 * @example
 *   formatMxid("@alice:koven.chat", "koven.chat")     // "@alice"
 *   formatMxid("@alice:matrix.org", "koven.chat")     // "@alice:matrix.org"
 *   formatMxid("@alice:koven.chat", null)             // "@alice:koven.chat"
 */
export function formatMxid(mxid: UserId | string, viewerServer: string | null | undefined): string {
	if (!mxid || typeof mxid !== "string") return mxid as string;
	const colon = mxid.indexOf(":");
	if (colon <= 0) return mxid;
	if (!viewerServer) return mxid;
	const server = mxid.slice(colon + 1).toLowerCase();
	if (server !== viewerServer.toLowerCase()) return mxid;
	return mxid.slice(0, colon);
}

/** Pull the homeserver out of a user's own mxid for use as the
 * `viewerServer` argument.  Returns null on a malformed mxid. */
export function serverOf(mxid: UserId | string | null | undefined): string | null {
	if (!mxid || typeof mxid !== "string") return null;
	const colon = mxid.indexOf(":");
	if (colon <= 0) return null;
	return mxid.slice(colon + 1).toLowerCase();
}

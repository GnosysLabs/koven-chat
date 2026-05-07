// Validate Matrix access tokens against Synapse and answer "who is
// this token?".  Used by admin-gated endpoints to verify the caller.
//
// Naive cache: token → user_id with a 60s TTL.  Tokens that fail
// validation aren't cached, so a revoked token starts failing within
// the TTL window.

import { config } from "./config";
import { upsertUser } from "./db";
import { bootstrapAdminIfNeeded } from "./admins";

interface CacheEntry {
	userId: string;
	at: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

/**
 * Resolve a Matrix access token to its owning user id.  Returns null
 * if the token is missing, malformed, or rejected by the homeserver.
 *
 * Side-effect on success: upserts the user into the engine's users
 * table and runs the admin bootstrap.  Without this hook the only
 * signal that a user exists is them posting/reacting in a room the
 * engine bot can observe — but encrypted DMs are invisible to the
 * bot, so a fresh user who only ever DMs would never get ingested
 * and the first-user-becomes-admin promotion would never fire.
 * Routing through whoami means every authenticated engine request
 * registers the caller exactly once (the upsert is idempotent).
 */
export async function whoami(accessToken: string | null | undefined): Promise<string | null> {
	if (!accessToken) return null;

	const cached = cache.get(accessToken);
	if (cached && Date.now() - cached.at < TTL_MS) return cached.userId;

	const r = await fetch(`${config.homeserverUrl}/_matrix/client/v3/account/whoami`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	}).catch(() => null);
	if (!r || !r.ok) return null;
	const body = await r.json().catch(() => null) as { user_id?: string } | null;
	const userId = body?.user_id ?? null;
	if (userId) {
		cache.set(accessToken, { userId, at: Date.now() });
		upsertUser(userId, Date.now());
		bootstrapAdminIfNeeded();
	}
	return userId;
}

/**
 * Pull the bearer token out of an HTTP request.  We accept it from
 * Authorization: Bearer ... or from the X-Matrix-Token fallback for
 * places where a header is awkward (file uploads).  Query params are
 * intentionally not supported — tokens in URLs leak via logs.
 */
export function extractToken(req: Request): string | null {
	const auth = req.headers.get("authorization");
	if (auth?.startsWith("Bearer ")) return auth.slice(7);
	return req.headers.get("x-matrix-token");
}

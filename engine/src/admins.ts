// First-user-becomes-admin bootstrap.  Runs each tick: if the admins
// table is empty AND we've seen at least one user post anything, the
// chronologically-first user is promoted.  Idempotent — once an admin
// exists, this becomes a no-op.
//
// This isn't strictly "first to register" — Synapse doesn't push a
// signal we can hook for that — but "first user the engine sees do
// anything" is close enough in practice and survives engine restarts.

import { adminCount, firstSeenUser, grantAdmin } from "./db";

export function bootstrapAdminIfNeeded(): void {
	if (adminCount() > 0) return;
	const first = firstSeenUser();
	if (!first) return;
	grantAdmin(first, null);
	console.log(`engine: bootstrapped first admin → ${first}`);
}

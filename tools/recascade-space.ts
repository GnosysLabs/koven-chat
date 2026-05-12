// Backfill cascade for an existing space: ensure every joined
// member of the space (humans + bots, excluding the engine
// appservice user) is also joined to every joinable child room.
//
// Why this exists: the live engine cascade fires when a NEW room
// is added to a space, but rooms that existed BEFORE a bot was
// invited (or before this cascade landed) don't have those bots
// in them.  This script is the manual reconciliation pass.
//
// Usage on the VPS:
//   cd /opt/koven-web
//   bun run tools/recascade-space.ts '!spaceIdOrAlias:koven.chat'
//
// Reads SYNAPSE_ADMIN_TOKEN + the homeserver URL from the same
// `.env` the engine uses, so no extra config is needed.
//
// Idempotent: admin-join is a no-op when the user is already a
// member of the target room.  Per-room failures are logged and
// don't abort the run.

import { config } from "../engine/src/config";
import {
	adminJoinUserToRoom,
	getAllJoinedMembers,
	getSpaceChildRoomIds,
	getRoomJoinRule,
	isSpaceRoom,
} from "../engine/src/synapse";

async function main(): Promise<void> {
	const spaceArg = process.argv[2];
	if (!spaceArg) {
		console.error("usage: bun run tools/recascade-space.ts <spaceId>");
		process.exit(2);
	}

	// Accept room aliases too — resolve via the homeserver if the
	// caller passed `#alias:server` instead of `!id:server`.
	let spaceId = spaceArg;
	if (spaceArg.startsWith("#")) {
		const url = `${config.homeserverUrl}/_matrix/client/v3/directory/room/${encodeURIComponent(spaceArg)}`;
		const r = await fetch(url);
		if (!r.ok) {
			console.error(`could not resolve alias ${spaceArg}: ${r.status}`);
			process.exit(1);
		}
		const body = (await r.json()) as { room_id?: string };
		if (!body.room_id) {
			console.error(`alias ${spaceArg} resolved to no room_id`);
			process.exit(1);
		}
		spaceId = body.room_id;
	}

	if (!await isSpaceRoom(spaceId)) {
		console.error(`${spaceId} is not a space room`);
		process.exit(1);
	}

	const members = await getAllJoinedMembers(spaceId);
	const localSuffix = `:${config.homeserverName}`;
	const localMembers = members.filter(m => m.endsWith(localSuffix));
	console.log(`space ${spaceId}: ${localMembers.length} local member(s) (incl. bots)`);

	const childIds = await getSpaceChildRoomIds(spaceId);
	console.log(`space ${spaceId}: ${childIds.length} declared child room(s)`);

	let processedRooms = 0;
	let joinsAttempted = 0;
	let joinsSucceeded = 0;
	let joinsSkipped = 0;
	let joinsFailed = 0;

	for (const childId of childIds) {
		processedRooms++;
		// Skip sub-spaces: the live cascade skips them too (joining
		// a space pulls in rooms but not nested sub-spaces).
		try {
			if (await isSpaceRoom(childId)) {
				console.log(`  ${childId}: sub-space, skipped`);
				continue;
			}
		} catch (err) {
			console.warn(`  ${childId}: isSpaceRoom check failed`, err);
			continue;
		}

		// Only auto-join rooms with rules that admin-join can fill.
		// Public + knock + restricted resolve cleanly; invite-only
		// rooms are intentionally invite-gated.
		const rule = await getRoomJoinRule(childId);
		if (rule !== "public" && rule !== "knock" && rule !== "restricted") {
			console.log(`  ${childId}: join_rule=${rule}, skipped`);
			continue;
		}

		// Snapshot the current child membership so we don't re-issue
		// admin-join for users who are already in.  The admin call
		// IS idempotent (Synapse returns 200 on a no-op), but skipping
		// the HTTP round-trip when we know it's a no-op cuts the run
		// time dramatically on rooms with most users already in.
		const existing = new Set(await getAllJoinedMembers(childId));
		const missing = localMembers.filter(u => !existing.has(u));
		if (missing.length === 0) {
			console.log(`  ${childId}: already complete (${existing.size} members)`);
			continue;
		}

		console.log(`  ${childId}: joining ${missing.length} missing member(s)`);
		for (const userId of missing) {
			joinsAttempted++;
			const r = await adminJoinUserToRoom(userId, childId);
			if ("error" in r) {
				joinsFailed++;
				console.warn(`    ${userId} → ${childId}: ${r.error} ${r.detail ?? ""}`);
			} else {
				joinsSucceeded++;
			}
		}
		joinsSkipped += existing.size;
	}

	console.log("");
	console.log(`done: ${processedRooms} child room(s) processed`);
	console.log(`      ${joinsAttempted} join(s) attempted`);
	console.log(`      ${joinsSucceeded} succeeded`);
	console.log(`      ${joinsFailed} failed`);
}

main().catch(err => {
	console.error("fatal:", err);
	process.exit(1);
});

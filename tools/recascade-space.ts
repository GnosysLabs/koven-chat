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

	const localSuffix = `:${config.homeserverName}`;
	const childIds = await getSpaceChildRoomIds(spaceId);
	console.log(`space ${spaceId}: ${childIds.length} declared child room(s)`);

	// Resolve the FULL local-member set: union of the space's own
	// members and every joined member of every (non-sub-space) child
	// room.  Captures bots that joined a single child room (e.g. the
	// bot playground) without ever joining the parent space, so the
	// cascade reaches them on the way back into every other room.
	const allLocalMembers = new Set<string>();
	for (const m of await getAllJoinedMembers(spaceId)) {
		if (m.endsWith(localSuffix)) allLocalMembers.add(m);
	}
	// Inspect each child room.  Pre-filter sub-spaces so we don't
	// pull their internal members into the parent space's roster.
	const inspectableChildren: string[] = [];
	for (const childId of childIds) {
		try {
			if (await isSpaceRoom(childId)) {
				console.log(`  ${childId}: sub-space, skipped`);
				continue;
			}
		} catch (err) {
			console.warn(`  ${childId}: isSpaceRoom check failed`, err);
			continue;
		}
		const rule = await getRoomJoinRule(childId);
		if (rule !== "public" && rule !== "knock" && rule !== "restricted") {
			console.log(`  ${childId}: join_rule=${rule}, skipped`);
			continue;
		}
		inspectableChildren.push(childId);
		for (const m of await getAllJoinedMembers(childId)) {
			if (m.endsWith(localSuffix)) allLocalMembers.add(m);
		}
	}

	const allMembers = [...allLocalMembers];
	const bots = allMembers.filter(m => /^@bot-/.test(m));
	console.log(`union: ${allMembers.length} local member(s) (${bots.length} bot(s))`);

	let joinsAttempted = 0;
	let joinsSucceeded = 0;
	let joinsFailed = 0;

	// Pass 1: ensure every union-member is also a member of the
	// parent SPACE itself.  Without this step, bots that only ever
	// joined a single child room stay out of the space and the
	// engine's live newSpaceChildren cascade (which keys off the
	// space's membership) would still miss them when a new room is
	// added later.
	const spaceMembers = new Set(await getAllJoinedMembers(spaceId));
	const missingFromSpace = allMembers.filter(u => !spaceMembers.has(u));
	if (missingFromSpace.length > 0) {
		console.log(`space ${spaceId}: joining ${missingFromSpace.length} missing member(s) into the space itself`);
		for (const userId of missingFromSpace) {
			joinsAttempted++;
			const r = await adminJoinUserToRoom(userId, spaceId);
			if ("error" in r) {
				joinsFailed++;
				console.warn(`  ${userId} → space ${spaceId}: ${r.error} ${r.detail ?? ""}`);
			} else {
				joinsSucceeded++;
			}
		}
	}

	// Pass 2: ensure every union-member is in every joinable child
	// room.  admin-join is idempotent, but pre-checking saves a
	// round-trip per already-joined user, which compounds when the
	// union is large.
	for (const childId of inspectableChildren) {
		const existing = new Set(await getAllJoinedMembers(childId));
		const missing = allMembers.filter(u => !existing.has(u));
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
	}

	console.log("");
	console.log(`done: ${inspectableChildren.length} child room(s) processed`);
	console.log(`      ${joinsAttempted} join(s) attempted`);
	console.log(`      ${joinsSucceeded} succeeded`);
	console.log(`      ${joinsFailed} failed`);
}

main().catch(err => {
	console.error("fatal:", err);
	process.exit(1);
});

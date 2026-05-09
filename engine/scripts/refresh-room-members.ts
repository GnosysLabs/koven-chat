// One-shot maintenance script: walk every room the engine has any
// state for, pull the live joined-members list from Synapse, and
// upsert into the local `room_members` table.  Used to recover from
// the bug where the lazy-backfill in fanOutMessage only triggered on
// truly-empty room caches, leaving rooms with partial/stale entries
// permanently undercounted (a few members got noted via live
// m.room.member events; the rest were silently invisible to the
// notification fan-out).
//
// Run-once after deploy:
//   docker compose exec engine bun engine/scripts/refresh-room-members.ts
//
// Idempotent: re-running just re-asserts the live view.  Safe to
// re-run for spot fixes.

import { getJoinedMembers } from "../src/synapse";
import { upsertRoomMember } from "../src/db";
import { db } from "../src/db";

async function main() {
	// Pull every distinct room the engine has any local state for —
	// chronologically pretty cheap, and avoids missing rooms that
	// don't have a `room_creations` entry (rooms that existed before
	// the engine started observing).
	const rows = db
		.prepare(`
			SELECT DISTINCT room_id FROM (
				SELECT room_id FROM room_members
				UNION
				SELECT room_id FROM posts
				UNION
				SELECT room_id FROM notifications
			)
		`)
		.all() as { room_id: string }[];
	const roomIds = rows.map(r => r.room_id);
	console.log(`[refresh-room-members] ${roomIds.length} rooms to refresh`);

	const ts = Date.now();
	let totalMembers = 0;
	let succeeded = 0;
	let failed = 0;
	for (const roomId of roomIds) {
		try {
			const live = await getJoinedMembers(roomId);
			for (const userId of live) {
				upsertRoomMember({ roomId, userId, membership: "join", ts });
			}
			totalMembers += live.length;
			succeeded++;
			console.log(`  ${roomId}: ${live.length} members`);
		} catch (err) {
			failed++;
			console.warn(`  ${roomId}: failed →`, err instanceof Error ? err.message : err);
		}
	}
	console.log(
		`[refresh-room-members] done: ${succeeded} rooms refreshed (${totalMembers} memberships), ${failed} failed`,
	);
}

main().catch((err) => {
	console.error("[refresh-room-members] fatal:", err);
	process.exit(1);
});

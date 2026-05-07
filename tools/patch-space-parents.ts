// One-shot patch: walks the m.space.child events on every space and
// stamps the reciprocal m.space.parent on each child room.  Use this
// when seed data was created before the seed script set both sides
// (the old script only set m.space.child, leaving rooms appearing as
// orphans in the client because we read parent-pointers off rooms).
//
// Idempotent — re-applying the same m.space.parent state event with
// the same content is a no-op other than a state-event timestamp bump.

const HOMESERVER = process.env.HOMESERVER ?? "http://localhost:8008";
const PASSWORD = "seed-password-1234";
const ROOM_FOUNDER = "nora";          // created every seeded room

interface LoginResponse {
	user_id: string;
	access_token: string;
	device_id: string;
}

interface JoinedRoomsResponse {
	joined_rooms: string[];
}

interface RoomState {
	type: string;
	state_key: string;
	content: Record<string, unknown>;
}

async function main(): Promise<void> {
	const login = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			type: "m.login.password",
			identifier: { type: "m.id.user", user: ROOM_FOUNDER },
			password: PASSWORD,
		}),
	});
	if (!login.ok) {
		throw new Error(`login failed: ${login.status} ${await login.text()}`);
	}
	const { user_id, access_token } = (await login.json()) as LoginResponse;
	const homeserver = user_id.slice(user_id.indexOf(":") + 1);
	console.log(`logged in as ${user_id}`);

	// All rooms this user is in; we'll filter to spaces by checking
	// m.room.create.type === "m.space".
	const joined = (await (await fetch(`${HOMESERVER}/_matrix/client/v3/joined_rooms`, {
		headers: { Authorization: `Bearer ${access_token}` },
	})).json()) as JoinedRoomsResponse;

	for (const roomId of joined.joined_rooms) {
		const stateUrl = `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`;
		const state = (await (await fetch(stateUrl, {
			headers: { Authorization: `Bearer ${access_token}` },
		})).json()) as RoomState[];

		const create = state.find(e => e.type === "m.room.create");
		const isSpace = (create?.content as { type?: string } | undefined)?.type === "m.space";
		if (!isSpace) continue;

		const childEvents = state.filter(e => e.type === "m.space.child");
		console.log(`space ${roomId} → ${childEvents.length} child(ren)`);

		for (const child of childEvents) {
			const childId = child.state_key;
			if (!childId) continue;
			// Stamp m.space.parent on the child.  Same canonical=true
			// metadata our client expects.
			const url = `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(childId)}/state/m.space.parent/${encodeURIComponent(roomId)}`;
			const r = await fetch(url, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${access_token}`,
				},
				body: JSON.stringify({ via: [homeserver], canonical: true }),
			});
			if (!r.ok) {
				console.warn(`  ! ${childId}: ${r.status} ${await r.text()}`);
			} else {
				console.log(`  · ${childId} → parent set`);
			}
		}
	}
	console.log("done.");
}

main().catch(err => {
	console.error("patch failed:", err);
	process.exit(1);
});

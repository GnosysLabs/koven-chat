// One-shot dev seeder.  Creates a roster of fake users, a couple of
// public spaces, a handful of channel rooms inside each, and seeds
// each room with chatter so the SPA has something to render.
//
// USAGE (local dev):
//
//   docker compose exec engine bun engine/scripts/seed-fake-data.ts
//
// or from a host shell pointing at a running engine:
//
//   bun engine/scripts/seed-fake-data.ts
//
// SAFETY
//
//   - Refuses to run unless the homeserver name is `localhost` or
//     ends in `.local` / `.localhost` / `.test`.  Prevents an "oops
//     I just dumped 30 fake users into prod" foot-gun.
//   - Idempotent on user creation — running twice doesn't double-
//     create users (Synapse returns the existing row on PUT).
//     Rooms / messages aren't deduped; running twice doubles them
//     up (intended — useful for stress-testing the timeline).
//
// Layout produced (~30 messages, 8 rooms, 2 spaces, 8 users):
//
//   #general / #random / #showcase    (in space "Forge")
//   #cars / #ricers                   (in space "Cars")
//   one orphan room "lounge"
//   two DMs between admin + a couple of fakes

import { config } from "../src/config";
import { adminCreateUser, adminJoinUserToRoom, loginAsUser } from "../src/synapse";

interface FakeUser {
	localpart: string;
	displayName: string;
	bio: string;
}

const FAKE_USERS: FakeUser[] = [
	{ localpart: "alice",   displayName: "alice",        bio: "frontend cat" },
	{ localpart: "bob",     displayName: "bob",          bio: "ops gremlin" },
	{ localpart: "carol",   displayName: "carol",        bio: "infra plumber" },
	{ localpart: "dave",    displayName: "dave",         bio: "backend nerd" },
	{ localpart: "eve",     displayName: "eve",          bio: "security person" },
	{ localpart: "frank",   displayName: "Frank",        bio: "designer ✨" },
	{ localpart: "grace",   displayName: "Grace",        bio: "PM-in-recovery" },
	{ localpart: "harriet", displayName: "Harriet",      bio: "tester. breaks things." },
];

interface SeedSpace {
	name: string;
	topic: string;
	rooms: { name: string; topic: string; messages: string[] }[];
}

const SEED_SPACES: SeedSpace[] = [
	{
		name: "Forge",
		topic: "where we build",
		rooms: [
			{
				name: "general",
				topic: "general chatter",
				messages: [
					"morning everyone",
					"who's pushing today",
					"i thought we agreed to merge friday",
					"lol",
					"anyway, shipping the toggle in 30",
				],
			},
			{
				name: "random",
				topic: "off-topic",
				messages: [
					"new espresso machine just landed at my place 🎉",
					"jealous",
					"recipes pls",
					"22g in, 36g out, 28s",
					"that's gospel right there",
				],
			},
			{
				name: "showcase",
				topic: "ship it / show it",
				messages: [
					"PR up: poll widget v1",
					"looks great, only nit is the spacing under the bar",
					"will fix",
				],
			},
		],
	},
	{
		name: "Cars",
		topic: "wheels & engines",
		rooms: [
			{
				name: "cars",
				topic: "all things automotive",
				messages: [
					"miata is always the answer",
					"sometimes the answer is e30 though",
					"both can be true",
				],
			},
			{
				name: "ricers",
				topic: "tasteful builds, light teasing",
				messages: [
					"new wing dropped",
					"that wing has its own zip code",
					"send pic",
				],
			},
		],
	},
];

const ORPHAN_ROOM = {
	name: "lounge",
	topic: "no parent space, just vibes",
	messages: [
		"first message in the orphan",
		"i like it here. quiet.",
		"chef's kiss 👨‍🍳",
	],
};

function assertSafeHomeserver(): void {
	const name = config.homeserverName.toLowerCase();
	const safe =
		name === "localhost"
		|| name.endsWith(".local")
		|| name.endsWith(".localhost")
		|| name.endsWith(".test");
	if (!safe) {
		console.error(
			`[seed] refusing to run against homeserver '${config.homeserverName}'.`,
		);
		console.error(
			`       seeder is dev-only — homeserver name must be 'localhost' or end in .local / .localhost / .test.`,
		);
		process.exit(2);
	}
}

const PASSWORD = "seed-password-123";
const TXN_COUNTER = { n: 0 };
function nextTxn(): string {
	TXN_COUNTER.n += 1;
	return `seed-${Date.now()}-${TXN_COUNTER.n}`;
}

interface UserSession {
	userId: string;
	accessToken: string;
}

async function ensureUser(user: FakeUser): Promise<UserSession> {
	const userId = `@${user.localpart}:${config.homeserverName}`;
	const create = await adminCreateUser({
		userId,
		password: PASSWORD,
		displayname: user.displayName,
	});
	// Re-running the seeder is fine — Synapse's PUT is upsert.
	if ("error" in create) {
		console.warn(`[seed] adminCreateUser ${userId}: ${create.error} ${create.detail ?? ""}`);
	}
	const login = await loginAsUser(userId, PASSWORD);
	if ("error" in login) {
		throw new Error(`login ${userId}: ${login.error} ${login.detail ?? ""}`);
	}
	console.log(`[seed]   ${userId} ready`);
	return { userId, accessToken: login.access_token };
}

interface CreatedRoom {
	roomId: string;
	name: string;
}

async function createPublicRoom(
	creator: UserSession,
	name: string,
	topic: string,
	opts: { space?: boolean } = {},
): Promise<CreatedRoom> {
	const r = await fetch(`${config.homeserverUrl}/_matrix/client/v3/createRoom`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${creator.accessToken}`,
		},
		body: JSON.stringify({
			name,
			topic,
			visibility: "public",
			preset: "public_chat",
			...(opts.space ? { creation_content: { type: "m.space" } } : {}),
		}),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		throw new Error(`createRoom ${name}: ${r.status} ${txt}`);
	}
	const body = (await r.json()) as { room_id: string };
	console.log(`[seed]   ${opts.space ? "space" : "room "} ${name} → ${body.room_id}`);
	return { roomId: body.room_id, name };
}

async function attachRoomToSpace(
	creator: UserSession,
	spaceId: string,
	roomId: string,
): Promise<void> {
	const path = `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(roomId)}`;
	const r = await fetch(`${config.homeserverUrl}${path}`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${creator.accessToken}`,
		},
		body: JSON.stringify({ via: [config.homeserverName], suggested: true }),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		throw new Error(`attachRoomToSpace: ${r.status} ${txt}`);
	}
}

async function joinAll(roomId: string, users: UserSession[]): Promise<void> {
	for (const u of users) {
		const j = await adminJoinUserToRoom(u.userId, roomId);
		if ("error" in j) {
			console.warn(`[seed]   join ${u.userId} → ${roomId}: ${j.error}`);
		}
	}
}

async function sendMessage(
	user: UserSession,
	roomId: string,
	body: string,
): Promise<void> {
	const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(nextTxn())}`;
	const r = await fetch(`${config.homeserverUrl}${path}`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${user.accessToken}`,
		},
		body: JSON.stringify({ msgtype: "m.text", body }),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		console.warn(`[seed]   send ${user.userId} → ${roomId}: ${r.status} ${txt.slice(0, 100)}`);
	}
}

async function createDm(
	a: UserSession,
	b: UserSession,
	messages: string[],
): Promise<void> {
	const r = await fetch(`${config.homeserverUrl}/_matrix/client/v3/createRoom`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${a.accessToken}`,
		},
		body: JSON.stringify({
			invite: [b.userId],
			is_direct: true,
			preset: "trusted_private_chat",
		}),
	});
	if (!r.ok) {
		const txt = await r.text().catch(() => "");
		throw new Error(`createDm ${a.userId} ↔ ${b.userId}: ${r.status} ${txt}`);
	}
	const body = (await r.json()) as { room_id: string };
	console.log(`[seed]   DM ${a.userId} ↔ ${b.userId} → ${body.room_id}`);
	// Have B accept (admin-join is sufficient).
	await adminJoinUserToRoom(b.userId, body.room_id);
	let turn = 0;
	for (const msg of messages) {
		await sendMessage(turn % 2 === 0 ? a : b, body.room_id, msg);
		turn += 1;
	}
}

async function main(): Promise<void> {
	assertSafeHomeserver();
	console.log(`[seed] homeserver: ${config.homeserverName} (${config.homeserverUrl})`);

	console.log(`[seed] creating ${FAKE_USERS.length} fake users…`);
	const sessions: Record<string, UserSession> = {};
	for (const u of FAKE_USERS) {
		sessions[u.localpart] = await ensureUser(u);
	}
	const allUsers = Object.values(sessions);
	const creator = sessions.alice!; // alice owns the spaces

	for (const spaceDef of SEED_SPACES) {
		console.log(`[seed] building space "${spaceDef.name}"…`);
		const space = await createPublicRoom(creator, spaceDef.name, spaceDef.topic, {
			space: true,
		});
		// Pull every fake user into the space so they show up in
		// member lists / can post in child rooms.
		await joinAll(space.roomId, allUsers.filter(u => u.userId !== creator.userId));

		for (const roomDef of spaceDef.rooms) {
			const room = await createPublicRoom(creator, roomDef.name, roomDef.topic);
			await attachRoomToSpace(creator, space.roomId, room.roomId);
			await joinAll(room.roomId, allUsers.filter(u => u.userId !== creator.userId));
			// Round-robin through the user roster as we send.
			let i = 0;
			for (const msg of roomDef.messages) {
				const sender = allUsers[i % allUsers.length]!;
				await sendMessage(sender, room.roomId, msg);
				i += 1;
			}
		}
	}

	console.log(`[seed] orphan room…`);
	const orphan = await createPublicRoom(creator, ORPHAN_ROOM.name, ORPHAN_ROOM.topic);
	await joinAll(orphan.roomId, allUsers.filter(u => u.userId !== creator.userId));
	let i = 0;
	for (const msg of ORPHAN_ROOM.messages) {
		const sender = allUsers[i % allUsers.length]!;
		await sendMessage(sender, orphan.roomId, msg);
		i += 1;
	}

	console.log(`[seed] DMs…`);
	await createDm(sessions.alice!, sessions.bob!, [
		"hey!",
		"hey, what's up",
		"got a sec to look at the PR?",
		"sure, dropping the link below",
	]);
	await createDm(sessions.carol!, sessions.dave!, [
		"deploy went out",
		"any incidents?",
		"clean so far",
		"🎉",
	]);

	console.log(`[seed] done.`);
	console.log(`[seed] login creds for any fake user: password "${PASSWORD}".`);
}

main().catch(err => {
	console.error("[seed] fatal:", err);
	process.exit(1);
});

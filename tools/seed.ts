// Seed script — populates a freshly-wiped Synapse with a small cast
// of users, two spaces, several rooms inside them, and a backlog of
// chat so the UI isn't empty for screenshots and dev work.
//
// Run with:
//   bun run tools/seed.ts
//
// Assumptions:
//   - Synapse is up at http://localhost:8008 with `enable_registration:
//     true` (homeserver.yaml ships this for dev).
//   - The admin account was registered through the normal signup flow
//     before running this (the script doesn't grant admin — it just
//     makes the world the admin will browse).
//   - Rooms created here are intentionally NOT end-to-end encrypted.
//     Public rooms shouldn't be (the engine bot needs to observe
//     flags), and we don't want to bootstrap SSSS for every seeded
//     user.  If you log in as one of these test users, you'll be
//     prompted to set up encryption — that's the same path a real
//     fresh user takes.

const HOMESERVER = process.env.HOMESERVER ?? "http://localhost:8008";
const PASSWORD = "seed-password-1234";

interface User {
	username: string;
	displayName: string;
	bio?: string;
}

interface Session {
	user: User;
	userId: string;
	accessToken: string;
	deviceId: string;
}

const CAST: User[] = [
	{ username: "nora", displayName: "Nora",  bio: "moderator-in-spirit. brews better tea than she has any right to." },
	{ username: "leo",  displayName: "Leo",   bio: "writes a lot, ships sometimes." },
	{ username: "maya", displayName: "Maya",  bio: "design, type, occasional rant." },
	{ username: "kai",  displayName: "Kai",   bio: "synth + half-finished side projects." },
	{ username: "ivy",  displayName: "Ivy",   bio: "🌿" },
];

interface SpaceSpec {
	name: string;
	topic: string;
	rooms: RoomSpec[];
}
interface RoomSpec {
	name: string;
	topic: string;
	members: string[];      // usernames; first one is the founder
	transcript: Line[];
}
interface Line {
	from: string;            // username
	body: string;
}

const PLAN: SpaceSpec[] = [
	{
		name: "General",
		topic: "Main hangout. Anyone can join.",
		rooms: [
			{
				name: "lounge",
				topic: "couches, coffee, chatter",
				members: ["nora", "leo", "maya", "kai", "ivy"],
				transcript: [
					{ from: "nora", body: "morning everyone. what's on the docket today?" },
					{ from: "leo",  body: "trying to finish the writeup i've been putting off for two weeks" },
					{ from: "maya", body: "icon set redo, and probably one too many coffees" },
					{ from: "kai",  body: "fighting with a sampler. wish me luck." },
					{ from: "nora", body: "luck granted. coffee solidarity, maya." },
					{ from: "ivy",  body: "going for a walk. i'll lurk later." },
				],
			},
			{
				name: "introductions",
				topic: "say hi! who you are, what you're up to.",
				members: ["nora", "leo", "maya", "kai", "ivy"],
				transcript: [
					{ from: "nora", body: "hi all — i help keep the temperature here reasonable. ask me anything." },
					{ from: "leo",  body: "hey. i mostly write and hang out. occasional code." },
					{ from: "maya", body: "designer. type, identity, the occasional poster. nice to meet you." },
					{ from: "kai",  body: "music + tinkering. happy to be here." },
					{ from: "ivy",  body: "i'm ivy. quiet, mostly. plants." },
				],
			},
			{
				name: "off-topic",
				topic: "everything that doesn't fit elsewhere",
				members: ["nora", "leo", "maya", "kai", "ivy"],
				transcript: [
					{ from: "leo",  body: "anyone else watching that new sci-fi show?" },
					{ from: "kai",  body: "the one with the moon? yeah. soundtrack is unreal." },
					{ from: "maya", body: "i haven't started yet. don't spoil." },
					{ from: "leo",  body: "no spoilers, just vibes." },
					{ from: "ivy",  body: "i'm three episodes in. it's slow in a good way." },
				],
			},
		],
	},
	{
		name: "Build Club",
		topic: "weekly project nights, share what you're making.",
		rooms: [
			{
				name: "showcase",
				topic: "post things you made — finished or not",
				members: ["nora", "leo", "maya", "kai"],
				transcript: [
					{ from: "maya", body: "new poster mockup, working title 'soft static'. opinions welcome." },
					{ from: "kai",  body: "love the palette. is the type custom?" },
					{ from: "maya", body: "drawn for this — might release it as a freebie if it cleans up." },
					{ from: "leo",  body: "the negative space on the right is doing a lot of work, in a good way." },
					{ from: "nora", body: "ship it imo." },
				],
			},
			{
				name: "feedback",
				topic: "ask for review, give review",
				members: ["nora", "leo", "maya", "kai"],
				transcript: [
					{ from: "leo",  body: "draft of the essay is up. it's long. apologies." },
					{ from: "nora", body: "i'll read it tonight. probably worth trimming the middle act, just from skimming." },
					{ from: "kai",  body: "i bounced off the intro — feels like it's setting up two essays at once." },
					{ from: "leo",  body: "fair. i'll cut the second framing." },
				],
			},
			{
				name: "tools",
				topic: "share gear, configs, tricks",
				members: ["nora", "leo", "maya", "kai"],
				transcript: [
					{ from: "kai",  body: "anyone got a good drum sampler that isn't 400 dollars" },
					{ from: "maya", body: "i'm partial to the open source one — lighter than it looks." },
					{ from: "kai",  body: "links?" },
					{ from: "maya", body: "sec, i'll dig up my notes" },
				],
			},
		],
	},
];

async function rawHttp(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
	return fetch(`${HOMESERVER}${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
}

async function http<T = unknown>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
	// Honor Synapse's rate-limiter (M_LIMIT_EXCEEDED, HTTP 429).  The
	// response carries `retry_after_ms` — sleep that long, retry once.
	// Two attempts is enough for a seed script; if we'd need more, the
	// rate limit is too aggressive for our load and we should tune
	// homeserver.yaml's rc_registration / rc_message instead.
	let r = await rawHttp(method, path, body, token);
	if (r.status === 429) {
		const data = (await r.clone().json().catch(() => ({}))) as { retry_after_ms?: number };
		const wait = Math.max(500, (data.retry_after_ms ?? 1000) + 200);
		await new Promise(res => setTimeout(res, wait));
		r = await rawHttp(method, path, body, token);
	}
	if (!r.ok) {
		const text = await r.text();
		throw new Error(`${method} ${path} → ${r.status}: ${text}`);
	}
	return (await r.json()) as T;
}

/**
 * Register a user.  Synapse's /register requires a UIA challenge; on
 * `enable_registration_without_verification` the only flow available
 * is `m.login.dummy`, so we go through the two-shot pattern: first
 * call returns 401 with the session id, second call passes dummy auth.
 */
async function register(user: User): Promise<Session> {
	const body = { username: user.username, password: PASSWORD, inhibit_login: false };

	const initial = await rawWithBackoff("POST", "/_matrix/client/v3/register", body);
	let session: string | undefined;
	if (initial.status === 401) {
		const data = (await initial.json()) as { session?: string };
		session = data.session;
	} else if (initial.ok) {
		const data = (await initial.json()) as { user_id: string; access_token: string; device_id: string };
		return { user, userId: data.user_id, accessToken: data.access_token, deviceId: data.device_id };
	}

	const final = await rawWithBackoff("POST", "/_matrix/client/v3/register",
		{ ...body, auth: { type: "m.login.dummy", session } },
	);
	if (final.status === 400) {
		// User already exists — fall back to login.
		return await login(user);
	}
	if (!final.ok) {
		throw new Error(`register ${user.username} → ${final.status}: ${await final.text()}`);
	}
	const data = (await final.json()) as { user_id: string; access_token: string; device_id: string };
	return { user, userId: data.user_id, accessToken: data.access_token, deviceId: data.device_id };
}

/**
 * rawHttp + 429 retry, shared between the JSON-returning http() and
 * the multi-step register() that needs the Response object directly.
 */
async function rawWithBackoff(method: string, path: string, body?: unknown, token?: string): Promise<Response> {
	let r = await rawHttp(method, path, body, token);
	if (r.status === 429) {
		const data = (await r.clone().json().catch(() => ({}))) as { retry_after_ms?: number };
		const wait = Math.max(500, (data.retry_after_ms ?? 1000) + 200);
		await new Promise(res => setTimeout(res, wait));
		r = await rawHttp(method, path, body, token);
	}
	return r;
}

async function login(user: User): Promise<Session> {
	const data = await http<{ user_id: string; access_token: string; device_id: string }>(
		"POST", "/_matrix/client/v3/login",
		{
			type: "m.login.password",
			identifier: { type: "m.id.user", user: user.username },
			password: PASSWORD,
		},
	);
	return { user, userId: data.user_id, accessToken: data.access_token, deviceId: data.device_id };
}

async function setProfile(s: Session): Promise<void> {
	const userId = encodeURIComponent(s.userId);
	await http("PUT", `/_matrix/client/v3/profile/${userId}/displayname`,
		{ displayname: s.user.displayName }, s.accessToken);
}

interface CreateRoomOpts {
	name: string;
	topic: string;
	isSpace?: boolean;
	visibility?: "public" | "private";
	preset?: "public_chat" | "private_chat" | "trusted_private_chat";
	invite?: string[];          // user_ids
}

async function createRoom(s: Session, opts: CreateRoomOpts): Promise<string> {
	const body: Record<string, unknown> = {
		name: opts.name,
		topic: opts.topic,
		visibility: opts.visibility ?? "public",
		preset: opts.preset ?? "public_chat",
		invite: opts.invite,
	};
	if (opts.isSpace) {
		body.creation_content = { type: "m.space" };
	}
	const data = await http<{ room_id: string }>(
		"POST", "/_matrix/client/v3/createRoom", body, s.accessToken,
	);
	return data.room_id;
}

async function linkChild(parent: Session, parentSpaceId: string, childRoomId: string, viaServer: string, child: Session): Promise<void> {
	const sk = encodeURIComponent(childRoomId);
	const parentId = encodeURIComponent(parentSpaceId);
	const childId = encodeURIComponent(childRoomId);
	const skSpace = encodeURIComponent(parentSpaceId);
	// 1. Space → room (the canonical hierarchy lives on the space).
	await http("PUT",
		`/_matrix/client/v3/rooms/${parentId}/state/m.space.child/${sk}`,
		{ via: [viaServer], suggested: false },
		parent.accessToken,
	);
	// 2. Room → space.  Without this, clients that read parent-pointers
	//    off the room (ours included) can't tell the room belongs to
	//    the space and render it as an orphan under "Home".  The room
	//    creator has PL 100 so they can set this state event freely.
	await http("PUT",
		`/_matrix/client/v3/rooms/${childId}/state/m.space.parent/${skSpace}`,
		{ via: [viaServer], canonical: true },
		child.accessToken,
	);
}

async function joinRoom(s: Session, roomId: string): Promise<void> {
	const id = encodeURIComponent(roomId);
	await http("POST", `/_matrix/client/v3/join/${id}`, {}, s.accessToken);
}

async function sendText(s: Session, roomId: string, body: string): Promise<void> {
	const id = encodeURIComponent(roomId);
	const txn = `seed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	await http("PUT",
		`/_matrix/client/v3/rooms/${id}/send/m.room.message/${txn}`,
		{ msgtype: "m.text", body },
		s.accessToken,
	);
}

function serverName(userId: string): string {
	const colon = userId.indexOf(":");
	return colon === -1 ? "" : userId.slice(colon + 1);
}

async function main(): Promise<void> {
	console.log(`seed: targeting ${HOMESERVER}`);

	// 1. Register / log in everyone in the cast.
	const sessions = new Map<string, Session>();
	for (const user of CAST) {
		try {
			const s = await register(user);
			sessions.set(user.username, s);
			await setProfile(s);
			console.log(`  · ${user.username} ready (${s.userId})`);
		} catch (err) {
			console.error(`  ! ${user.username}: ${err}`);
			throw err;
		}
	}

	// 2. For each space spec: founder creates the space, invites others
	//    to join, then creates each child room and stitches the
	//    m.space.child link.
	const homeserver = serverName(sessions.get("nora")!.userId);
	for (const spaceSpec of PLAN) {
		const founder = sessions.get("nora")!;
		const everyoneElse = CAST
			.filter(c => c.username !== founder.user.username)
			.map(c => sessions.get(c.username)!.userId);
		const spaceId = await createRoom(founder, {
			name: spaceSpec.name,
			topic: spaceSpec.topic,
			isSpace: true,
			visibility: "public",
			invite: everyoneElse,
		});
		console.log(`space '${spaceSpec.name}' → ${spaceId}`);

		// Have invitees accept.
		for (const username of CAST.map(c => c.username).filter(u => u !== founder.user.username)) {
			await joinRoom(sessions.get(username)!, spaceId).catch(err => {
				console.warn(`  ! ${username} couldn't join space ${spaceSpec.name}: ${err}`);
			});
		}

		for (const roomSpec of spaceSpec.rooms) {
			const roomFounder = sessions.get(roomSpec.members[0])!;
			const otherInvitees = roomSpec.members.slice(1).map(u => sessions.get(u)!.userId);
			const roomId = await createRoom(roomFounder, {
				name: roomSpec.name,
				topic: roomSpec.topic,
				visibility: "public",
				preset: "public_chat",
				invite: otherInvitees,
			});
			console.log(`  · room '${roomSpec.name}' → ${roomId}`);

			// Stitch into the space (both directions: child + parent).
			await linkChild(founder, spaceId, roomId, homeserver, roomFounder);

			// Have non-founder members accept.
			for (const username of roomSpec.members.slice(1)) {
				await joinRoom(sessions.get(username)!, roomId).catch(err => {
					console.warn(`    ! ${username} couldn't join ${roomSpec.name}: ${err}`);
				});
			}

			// Drain the transcript.  Small delay between sends so
			// timestamps don't collide and the UI groups them naturally.
			for (const line of roomSpec.transcript) {
				const speaker = sessions.get(line.from);
				if (!speaker) {
					console.warn(`    ! unknown speaker '${line.from}' in ${roomSpec.name}`);
					continue;
				}
				await sendText(speaker, roomId, line.body);
				await new Promise(r => setTimeout(r, 25));
			}
		}
	}

	console.log("\nseed: done.  log in as your admin account to see everything.");
	console.log(`  test user passwords: '${PASSWORD}'`);
}

main().catch(err => {
	console.error("seed failed:", err);
	process.exit(1);
});

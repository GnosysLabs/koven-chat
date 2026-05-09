// Regression guard.
//
// Enforces: no engine code reads room state via Matrix's client API.
// Specifically blocks the patterns
//   /_matrix/client/v3/rooms/{id}/state[/...]
//   /_matrix/client/v3/rooms/{id}/members
//   /_matrix/client/v3/rooms/{id}/joined_members
// because those endpoints are gated by Matrix's "you can only read
// state for rooms you're in" rule.  The engine's admin user (the
// SYNAPSE_ADMIN_TOKEN holder) isn't a member of every room — those
// reads silently 403 and our wrapper returns null/[].  An entire
// afternoon of features (notification fan-out, auto-join cascade,
// Explore icons + NSFW, default-space child enumeration) all
// silently no-op'd that way until each was noticed individually
// and fixed.  Permanent fix: route every state read through
// `readRoomState` / `pickStateContent` (Synapse admin /state) and
// every member read through `getJoinedMembers` (Synapse admin
// /members) — both work regardless of admin-user membership.
//
// Allowed exceptions: docstrings / comments referencing the bad
// patterns are FINE.  We only flag string literals and template
// literals that would actually hit the network.
//
// Run via `bun run lint:no-client-state-api` from engine/.
// Returns exit 0 on clean, 1 with a violations report otherwise.

import { Glob } from "bun";

const BAD_PATTERN = /["`']\/_matrix\/client\/v3\/rooms\/[^"`'\s]*\/(state|members|joined_members)/;

// Comment lines reference the bad patterns deliberately (docstrings
// explaining why we DON'T use them).  Skip lines whose trimmed text
// starts with `//`, `*`, or `/*` so we only flag actual code.
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*)/;

const root = new URL("../src/", import.meta.url).pathname;
const glob = new Glob("**/*.ts");

const violations: Array<{ file: string; line: number; text: string }> = [];

for await (const rel of glob.scan(root)) {
	const path = root + rel;
	const text = await Bun.file(path).text();
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (COMMENT_LINE.test(line)) continue;
		if (BAD_PATTERN.test(line)) {
			violations.push({
				file: rel,
				line: i + 1,
				text: line.trim(),
			});
		}
	}
}

if (violations.length > 0) {
	console.error("ERROR: client API state/member reads found in engine code.\n");
	console.error("These 403 silently for rooms the engine admin user is not in.");
	console.error("Use `readRoomState()` / `pickStateContent()` / `getJoinedMembers()`");
	console.error("from synapse.ts instead — those use the Synapse admin endpoints");
	console.error("which work regardless of membership.\n");
	console.error("Violations:");
	for (const v of violations) {
		console.error(`  engine/src/${v.file}:${v.line}: ${v.text}`);
	}
	process.exit(1);
}

console.log("OK: no client-API state/member reads found.");

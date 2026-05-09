// Resolve and pin npm package versions at attach time.
//
// When a user pastes a stdio MCP config like:
//   { "command": "npx", "args": ["-y", "@chatmcp/server-perplexity-ask"], … }
// we want to lock the actual version that gets installed so:
//   1. A subsequent run uses the SAME version, not whatever's "latest"
//      at the time of the run (defends against silent supply-chain
//      compromise via auto-update — the most common npm-attack vector).
//   2. The user's bot's behaviour stays reproducible across runs.
//
// We do this by running `npm view <package> version` at attach time
// and rewriting the args array to pin the version with `@x.y.z`.  If
// the lookup fails (private registry, network blip, non-npm package
// like a github URL) we proceed unpinned and stash a null in the DB
// — caller decides whether to surface a warning.
//
// Pinning is best-effort and ONLY for npx/uvx-style invocations where
// we can confidently identify the package name in args.  Custom
// commands (a user pointing at their own binary on disk) skip pinning
// entirely.

import { spawn } from "node:child_process";

/** Resolve a stdio attachment's args to a pinned-version form, when
 * the command is npx or uvx and the args clearly reference a package.
 * Returns the new args array + the version we pinned to.  When pinning
 * isn't applicable or fails, returns the original args + null version. */
export async function pinStdioPackageVersion(
	command: string,
	args: string[],
): Promise<{ args: string[]; version: string | null }> {
	const cmd = command.split("/").pop() ?? command;

	if (cmd === "npx") {
		return await pinNpxArgs(args);
	}
	// uvx pinning would look similar — `uv pip install <pkg>==1.2.3`
	// but uv handles its own pinning per-call.  For now we leave uvx
	// unpinned and let uv pull the latest each spawn (uv has tighter
	// supply-chain checks than npm by default).
	return { args, version: null };
}

async function pinNpxArgs(args: string[]): Promise<{ args: string[]; version: string | null }> {
	// Find the first non-flag arg that looks like a package name.
	// Skip npx flags (-y, --yes, -p <pkg>, --package <pkg>, -c "cmd").
	let pkgIdx = -1;
	for (let i = 0; i < args.length; i++) {
		const a = args[i] ?? "";
		if (a === "-y" || a === "--yes") continue;
		if (a.startsWith("-")) {
			// Skip a flag's value if it takes one.
			if (a === "-p" || a === "--package" || a === "-c" || a === "--call") {
				i++;
			}
			continue;
		}
		// First positional arg is the package (possibly already
		// versioned with @x.y.z, in which case we leave it alone).
		pkgIdx = i;
		break;
	}
	if (pkgIdx < 0) return { args, version: null };
	const pkgArg = args[pkgIdx]!;

	// Already pinned?  Match `@scope/name@1.2.3` or `name@1.2.3`.
	// Tricky: scoped packages start with @ themselves.  Pinning
	// happens at the LAST @ in the string only when it's not at
	// position 0.
	const lastAt = pkgArg.lastIndexOf("@");
	if (lastAt > 0) {
		// Already has an @version suffix — respect it.
		const version = pkgArg.slice(lastAt + 1);
		return { args, version };
	}

	// Resolve via `npm view <pkg> version`.  Run unsandboxed (safe —
	// just talks to npm registry) with a 10s timeout.
	const version = await resolveNpmPackageVersion(pkgArg);
	if (!version) return { args, version: null };

	const pinned = [...args];
	pinned[pkgIdx] = `${pkgArg}@${version}`;
	return { args: pinned, version };
}

function resolveNpmPackageVersion(pkg: string): Promise<string | null> {
	return new Promise((resolve) => {
		const child = spawn("npm", ["view", pkg, "version", "--json"], {
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH ?? "/usr/bin",
				HOME: process.env.HOME ?? "/tmp",
			},
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			console.warn(`mcp/version_pin: npm view ${pkg} timed out after 10s`);
			resolve(null);
		}, 10_000);
		child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
		child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				console.warn(`mcp/version_pin: npm view ${pkg} failed (code ${code}): ${stderr.trim()}`);
				resolve(null);
				return;
			}
			// `npm view <pkg> version --json` returns either a
			// JSON string ("1.2.3") or an array of strings (when
			// the package has multiple dist-tags resolving to
			// different versions, rare).  Take the last entry as
			// the most-current.
			const trimmed = stdout.trim();
			try {
				const parsed = JSON.parse(trimmed);
				if (typeof parsed === "string") return resolve(parsed);
				if (Array.isArray(parsed) && parsed.length > 0) {
					const last = parsed[parsed.length - 1];
					return resolve(typeof last === "string" ? last : null);
				}
				resolve(null);
			} catch {
				// Sometimes npm prints a bare version with no JSON
				// quoting — accept that too.
				if (/^[\d.]+(-[\w.]+)?$/.test(trimmed)) return resolve(trimmed);
				resolve(null);
			}
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			console.warn(`mcp/version_pin: npm view ${pkg} spawn failed:`, err);
			resolve(null);
		});
	});
}

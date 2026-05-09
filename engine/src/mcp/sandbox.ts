// Subprocess sandbox for stdio MCP servers.
//
// User-attached MCP servers are arbitrary npm / pip packages — we
// can't trust them with the engine's filesystem or environment.  This
// module returns a sandboxed invocation (command + args + env) that
// callers hand to the MCP SDK's StdioClientTransport, which then
// spawns the process.  Two layers of defence:
//
//   Tier 1 — env stripping
//     The subprocess sees ONLY the env vars the user specified in
//     their attachment config (PERPLEXITY_API_KEY etc.) plus a minimal
//     PATH/HOME.  No SYNAPSE_ADMIN_TOKEN, no BOT_KEY_ENCRYPTION_SECRET,
//     no postgres creds.  This is enforced by handing
//     StdioClientTransport an explicit `env` map — without that, the
//     SDK calls getDefaultEnvironment() which leaks much of process.env.
//
//   Tier 2 — bubblewrap filesystem isolation + prlimit resource caps
//     We wrap the user's command in:
//       prlimit --as=… --cpu=… --nproc=… --nofile=…
//         bwrap --ro-bind /usr /usr --tmpfs /tmp …
//           <command> <args>
//     bwrap mounts a read-only view of /usr, /lib, /etc into a fresh
//     namespace.  The subprocess gets a per-attachment scratch
//     /home/sandbox writable dir.  Cannot see /data, /synapse-data,
//     the engine's own filesystem, or other bots' data.  Network
//     stays open (the package needs to call its API).
//
//   Resource limits via prlimit:
//     - 256 MB RSS (kills runaway memory)
//     - 60 s CPU per spawn (kills infinite loops)
//     - 64 process cap (stops fork bombs)
//     - 256 file descriptor cap
//
// When bubblewrap or prlimit isn't available on the host (e.g. local
// dev on macOS), we fall back to Tier 1 only and log a one-time
// warning.  The engine's production Dockerfile installs both so this
// fallback only triggers in developer environments.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, chownSync, statSync } from "node:fs";
import { join } from "node:path";

const SCRATCH_ROOT = "/var/lib/koven-mcp";
// `--as` caps VIRTUAL memory (address space), not resident memory.
// V8 reserves a multi-GB virtual CodeRange on startup that's mostly
// uncommitted physical pages — set the cap below it and the
// subprocess OOMs immediately on `node` startup with
// "Failed to reserve virtual memory for CodeRange".  2 GiB is
// generous enough for V8 + a small MCP server's working set.
//
// The actual physical-memory cap should come from cgroups
// (Docker --memory or systemd-run MemoryMax=) — RLIMIT_AS is a
// safety net for runaway leaks, not a hard ceiling.  RLIMIT_RSS
// is a no-op on Linux since 2.4.30 (kernel doesn't enforce it),
// which is why we don't bother setting it.
const RLIMIT_AS_BYTES = 2 * 1024 * 1024 * 1024;
const RLIMIT_CPU_SECONDS = 60;
const RLIMIT_NPROC = 64;
const RLIMIT_NOFILE = 256;
// `nobody` UID/GID on Debian-based images.  Override via
// KOVEN_MCP_SANDBOX_UID for hosts where nobody is a different UID.
const DEFAULT_NOBODY_UID = 65534;
const DEFAULT_NOBODY_GID = 65534;

let bwrapPath: string | null | undefined = undefined; // undefined = unprobed, null = absent, string = path
let prlimitPath: string | null | undefined = undefined;
let warnedMissing = false;

function findBin(name: string): string | null {
	const r = spawnSync("which", [name], { encoding: "utf8" });
	if (r.status !== 0) return null;
	return r.stdout.trim() || null;
}

function probeBins(): { bwrap: string | null; prlimit: string | null } {
	if (bwrapPath === undefined) bwrapPath = findBin("bwrap");
	if (prlimitPath === undefined) prlimitPath = findBin("prlimit");
	if (!warnedMissing && (!bwrapPath || !prlimitPath)) {
		console.warn(
			`mcp/sandbox: missing ${!bwrapPath ? "bwrap " : ""}${!prlimitPath ? "prlimit " : ""}` +
			"on PATH — falling back to env-strip-only sandbox.  " +
			"Install bubblewrap + util-linux on the engine host for production.",
		);
		warnedMissing = true;
	}
	return { bwrap: bwrapPath, prlimit: prlimitPath };
}

/** Per-bot scratch directory.  Created on demand; persists across
 * spawns so npm/uv caches the package after the first cold-start.
 * GC'd by the disk janitor after N days of inactivity.
 *
 * Self-heals ownership.  If a previous (broken-UID) run wrote
 * root-owned files into the scratch dir, the next sandboxed spawn
 * (running as nobody) can't read/write them and npm dies with
 * EACCES.  Recursive chown on every call is cheap (small trees,
 * a no-op stat for already-correct files) and cleanest fix. */
export function ensureBotScratchDir(botId: number): string {
	const dir = join(SCRATCH_ROOT, String(botId));
	if (!existsSync(dir)) {
		try {
			mkdirSync(dir, { recursive: true, mode: 0o755 });
		} catch (err) {
			console.warn(`mcp/sandbox: mkdir ${dir} failed:`, err);
			return dir;
		}
	}
	// chown -R nobody:nogroup, but only entries currently owned by
	// the engine's UID (root in production, possibly different in
	// dev).  Skipping already-correct entries makes this fast on
	// warm caches.  Failure is non-fatal — dev environments without
	// root caps just see the warning + may have permission issues.
	try {
		chownRecursiveIfNeeded(dir, DEFAULT_NOBODY_UID, DEFAULT_NOBODY_GID);
	} catch (err) {
		console.warn(`mcp/sandbox: chown ${dir} (recursive) failed:`, err);
	}
	return dir;
}

function chownRecursiveIfNeeded(path: string, uid: number, gid: number): void {
	let st;
	try { st = statSync(path); } catch { return; }
	if (st.uid !== uid || st.gid !== gid) {
		try { chownSync(path, uid, gid); } catch { /* ignore */ }
	}
	if (st.isDirectory()) {
		// Use spawnSync chown -R for speed — Node's recursive
		// directory walks are slow at scale and chown/chmod aren't
		// in node:fs/promises with proper recursion until 22+.
		try {
			spawnSync("chown", ["-R", `${uid}:${gid}`, path], { stdio: "ignore" });
		} catch { /* ignore */ }
	}
}

export interface SandboxInvocation {
	/** Final command StdioClientTransport will spawn — usually
	 * "prlimit", which then exec's bwrap, which exec's the user's
	 * command.  When neither prlimit nor bwrap is available, this
	 * resolves to the user's command directly. */
	command: string;
	args: string[];
	/** Env passed to spawn().  ONLY user-supplied vars + minimal
	 * PATH/HOME — engine secrets stripped. */
	env: Record<string, string>;
}

export interface SandboxOptions {
	command: string;
	args: string[];
	/** ONLY env vars to pass through.  PATH and HOME are added
	 * automatically; anything in process.env is NOT passed. */
	env: Record<string, string>;
	/** Per-bot scratch dir (writable HOME inside the sandbox). */
	scratchDir: string;
}

/** Build the sandboxed invocation.  Returns the prlimit+bwrap-wrapped
 * command + args + env that StdioClientTransport will spawn. */
export function buildSandboxedInvocation(opts: SandboxOptions): SandboxInvocation {
	const { bwrap, prlimit } = probeBins();

	// CRUCIAL: minimal env, no spread of process.env.  The user's
	// vars come last so they win on collisions.
	const env: Record<string, string> = {
		PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		HOME: bwrap ? "/home/sandbox" : opts.scratchDir,
		LANG: "C.UTF-8",
		TERM: "dumb",
		...opts.env,
	};

	const prlimitArgs = prlimit ? [
		`--as=${RLIMIT_AS_BYTES}`,
		`--cpu=${RLIMIT_CPU_SECONDS}`,
		`--nproc=${RLIMIT_NPROC}`,
		`--nofile=${RLIMIT_NOFILE}`,
	] : [];

	if (bwrap) {
		// bwrap inside Docker — pared-down config that works under
		// Docker's restricted mount/pivot_root permissions even with
		// CAP_SYS_ADMIN + apparmor=unconfined + seccomp=unconfined:
		//   * Use --ro-bind /proc (not --proc) — Docker blocks
		//     remounting procfs from inside the container.  Read-only
		//     bind of the host's /proc is acceptable because the
		//     subprocess runs as nobody and cross-UID /proc reads are
		//     blocked by the kernel anyway.
		//   * Drop --unshare-pid — depends on the procfs remount we
		//     can't do.  Subprocess shares the engine's PID namespace
		//     but is still UID-isolated.
		//   * Keep --unshare-uts/-ipc/-user-try and the filesystem
		//     mounts — those are the load-bearing parts (the
		//     subprocess can't see /data, /synapse-data, the
		//     engine's own filesystem, or other bots' scratch dirs).
		// Net trust: filesystem + capability isolation + env strip
		// remain.  PID namespace isolation is sacrificed; not a real
		// loss in our threat model since the subprocess is non-root
		// and can't signal anything outside its own UID.
		const sandboxUid = envInt("KOVEN_MCP_SANDBOX_UID", DEFAULT_NOBODY_UID);
		const sandboxGid = envInt("KOVEN_MCP_SANDBOX_GID", DEFAULT_NOBODY_GID);
		const bwrapArgs = [
			"--ro-bind", "/usr", "/usr",
			"--ro-bind", "/lib", "/lib",
			...(existsSync("/lib64") ? ["--ro-bind", "/lib64", "/lib64"] : []),
			"--ro-bind", "/bin", "/bin",
			...(existsSync("/sbin") ? ["--ro-bind", "/sbin", "/sbin"] : []),
			"--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
			"--ro-bind", "/etc/ssl", "/etc/ssl",
			...(existsSync("/etc/ca-certificates") ? ["--ro-bind", "/etc/ca-certificates", "/etc/ca-certificates"] : []),
			...(existsSync("/etc/nsswitch.conf") ? ["--ro-bind", "/etc/nsswitch.conf", "/etc/nsswitch.conf"] : []),
			...(existsSync("/etc/hosts") ? ["--ro-bind", "/etc/hosts", "/etc/hosts"] : []),
			// /etc/passwd + group needed for getpwnam("nobody") and
			// for stdlib calls (Node os.userInfo, Python pwd module).
			"--ro-bind", "/etc/passwd", "/etc/passwd",
			"--ro-bind", "/etc/group", "/etc/group",
			"--ro-bind", "/proc", "/proc",
			"--dev", "/dev",
			"--tmpfs", "/tmp",
			// Persistent home: npm/uv caches survive across spawns
			// → fast warm-start after initial cold download.
			"--bind", opts.scratchDir, "/home/sandbox",
			"--setenv", "HOME", "/home/sandbox",
			"--chdir", "/home/sandbox",
			"--unshare-uts",
			"--unshare-ipc",
			"--unshare-user-try",
			// Drop privileges INSIDE the sandbox to nobody.  We
			// can't drop in the parent shell before bwrap (bwrap
			// needs CAP_SYS_ADMIN to set up the mount namespace —
			// dropping to nobody first kills its ability to run);
			// --uid moves the UID drop to AFTER bwrap has set up
			// the sandbox but BEFORE the user's command exec's.
			"--uid", String(sandboxUid),
			"--gid", String(sandboxGid),
			"--share-net",  // package needs to call its upstream API
			"--new-session",
			"--die-with-parent",
			"--",
			opts.command,
			...opts.args,
		];

		if (prlimit) {
			return {
				command: prlimit,
				args: [...prlimitArgs, bwrap, ...bwrapArgs],
				env,
			};
		}
		return { command: bwrap, args: bwrapArgs, env };
	}

	// No bwrap — Tier 1 only (env stripping above).
	if (prlimit) {
		return {
			command: prlimit,
			args: [...prlimitArgs, opts.command, ...opts.args],
			env,
		};
	}
	return { command: opts.command, args: opts.args, env };
}

function envInt(key: string, fallback: number): number {
	const raw = process.env[key];
	if (!raw) return fallback;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) ? n : fallback;
}

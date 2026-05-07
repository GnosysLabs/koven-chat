// Engine configuration.  Reads tokens out of the registration YAML so
// there's a single source of truth that Synapse and engine both agree
// on.  Everything else has sensible defaults for local dev — production
// values are wired in via env vars by docker-compose.
//
// Production env vars (set by docker-compose):
//   HOMESERVER_URL      — http://synapse:8008 (compose service DNS)
//   HOMESERVER_NAME     — koven.chat (the matrix server_name; what
//                         appears after the colon in user IDs)
//   ENGINE_REGISTRATION — /data/koven-engine.appservice.yaml
//   ENGINE_DB           — /data/engine.sqlite
//   ENGINE_PORT         — 9000
//
// Email auth (one of two transports must be configured):
//
//   Resend (HTTP API):
//     RESEND_API_KEY    : set to use Resend.  Takes precedence over
//                         SMTP if both are configured.
//
//   Generic SMTP (works with any provider: Postmark, SendGrid,
//   Mailgun, Amazon SES, your own Postfix box, etc.):
//     SMTP_HOST         : hostname (e.g. "smtp.postmarkapp.com")
//     SMTP_PORT         : port (default 587 for STARTTLS, 465 for TLS)
//     SMTP_USER         : auth username
//     SMTP_PASSWORD     : auth password (or API token, for providers
//                         that use one as the SMTP password)
//     SMTP_SECURE       : "true" for implicit TLS (port 465),
//                         "false" or unset for STARTTLS (port 587)
//
//   Common to both:
//     EMAIL_FROM        : sender address (default noreply@koven.chat)
//     EMAIL_CODE_TTL_MS : code lifetime in ms (default 10 minutes)
//
//   SYNAPSE_ADMIN_TOKEN : access token for an admin Synapse user.
//                         Required for admin-create / admin-mint-token
//                         calls.  The appservice as_token isn't enough
//                         here: only a real admin user can hit
//                         /_synapse/admin/v2/users.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load repo-root .env regardless of cwd.  Bun auto-loads .env from
// cwd, but `bun run --cwd engine dev` and a plain `cd engine && bun
// run src/index.ts` both set cwd to the engine subdir, where there
// is no .env.  Walking up from this file to the repo root gives us
// a single source of truth and keeps `bun run` invocations from
// having to remember which directory to launch from.
loadRepoRootEnv();

function loadRepoRootEnv(): void {
	try {
		// engine/src/config.ts → engine/src → engine → repo root
		const here = dirname(fileURLToPath(import.meta.url));
		// Walk up looking for .env; stop at the filesystem root.
		let dir = here;
		for (let i = 0; i < 8; i++) {
			const candidate = join(dir, ".env");
			if (existsSync(candidate)) {
				applyDotenv(candidate);
				return;
			}
			const parent = resolve(dir, "..");
			if (parent === dir) return;
			dir = parent;
		}
	} catch {
		// Best-effort.  If env loading fails the engine still boots;
		// missing vars surface as their respective "not configured"
		// errors at runtime.
	}
}

function applyDotenv(path: string): void {
	const text = readFileSync(path, "utf8");
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		// Don't clobber values already set in the real env (Docker
		// compose, host env vars take precedence over .env file).
		if (process.env[key] !== undefined) continue;
		let value = line.slice(eq + 1).trim();
		// Strip a single matching pair of surrounding quotes.
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
}

const REGISTRATION_PATH =
	process.env.ENGINE_REGISTRATION ??
	"/Users/christopher/Dev/Eclipse/synapse-data/koven-engine.appservice.yaml";

// We only need three lines out of the YAML — id, as_token, hs_token —
// so a tiny scanner saves us a dependency on a YAML parser.  If the
// shape ever gets more complex, swap in js-yaml.
function readTokens(path: string): { as_token: string; hs_token: string; sender: string } {
	const text = readFileSync(path, "utf8");
	const grab = (key: string): string => {
		const m = text.match(new RegExp(`^${key}:\\s*(\\S+)\\s*$`, "m"));
		if (!m) throw new Error(`engine: ${key} not found in ${path}`);
		return m[1]!;
	};
	return {
		as_token: grab("as_token"),
		hs_token: grab("hs_token"),
		sender: grab("sender_localpart"),
	};
}

const tokens = readTokens(REGISTRATION_PATH);

export const config = {
	port: Number(process.env.ENGINE_PORT ?? 9000),
	homeserverUrl: process.env.HOMESERVER_URL ?? "http://localhost:8008",
	homeserverName: process.env.HOMESERVER_NAME ?? "localhost",
	dbPath: process.env.ENGINE_DB ?? "/Users/christopher/Dev/Eclipse/koven-web/data/engine.sqlite",
	asToken: tokens.as_token,
	hsToken: tokens.hs_token,
	engineUserId: `@${tokens.sender}:${process.env.HOMESERVER_NAME ?? "localhost"}`,
	tickIntervalMs: Number(process.env.TICK_INTERVAL_MS ?? 60_000),

	// ─── Email auth ─────────────────────────────────────────────────
	emailFrom: process.env.EMAIL_FROM ?? "Koven <noreply@koven.chat>",
	emailCodeTtlMs: Number(process.env.EMAIL_CODE_TTL_MS ?? 10 * 60 * 1000),
	// Resend HTTP API.  If set, takes precedence over SMTP.
	resendApiKey: process.env.RESEND_API_KEY ?? "",
	// Generic SMTP fallback.  Any provider works.  All four host/port/
	// user/password vars must be set together to engage SMTP; if any
	// are missing the email module falls back to the next configured
	// transport (or "not_configured").
	smtpHost: process.env.SMTP_HOST ?? "",
	smtpPort: Number(process.env.SMTP_PORT ?? 587),
	smtpUser: process.env.SMTP_USER ?? "",
	smtpPassword: process.env.SMTP_PASSWORD ?? "",
	smtpSecure: (process.env.SMTP_SECURE ?? "").toLowerCase() === "true",
	// Admin user token used for /_synapse/admin/v2/users (create) and
	// /_synapse/admin/v1/users/<id>/login (mint access token).  The
	// appservice as_token can't hit those endpoints — only a real
	// admin user.  Setup script provisions this on first boot.
	synapseAdminToken: process.env.SYNAPSE_ADMIN_TOKEN ?? tokens.as_token,

	// ─── Bot platform ───────────────────────────────────────────────
	// AES-256-GCM key (64 hex chars / 32 bytes) used to encrypt
	// per-bot secrets at rest: each bot's LLM API key and Synapse
	// access token.  Auto-generated by `bin/koven setup` if blank;
	// rotating it requires re-entering every bot's API key (and
	// re-minting Synapse tokens — which `bin/koven` will offer in a
	// future helper).
	botKeyEncryptionSecret: process.env.BOT_KEY_ENCRYPTION_SECRET ?? "",
	// Hard cap on bots per owner.  Surfaced in the create endpoint as
	// a 409 when exceeded.  Hardcoded for v1; movable to instance
	// config later if values prove contentious.
	maxBotsPerUser: Number(process.env.MAX_BOTS_PER_USER ?? 30),
};

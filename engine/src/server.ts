// HTTP surface of the engine.
//
//   PUT  /_matrix/app/v1/transactions/{txnId}    — Synapse pushes events
//   GET  /_matrix/app/v1/users/{userId}          — namespace ownership probe
//   GET  /_matrix/app/v1/rooms/{roomAlias}       — namespace ownership probe
//   GET  /api/weight/:userId                     — engine-native: reputation read
//   GET  /api/weight                             — bulk read for the active client
//   GET  /api/instance                           — public instance config (login branding)
//   PUT  /api/instance                           — admin-only: update config
//   POST /api/instance/login-bg                  — admin-only: upload login background
//   POST /api/instance/logo                      — admin-only: upload instance logo
//   GET  /api/profile/{userId}                   — public bio read
//   PUT  /api/profile/me                         — owner-only bio write
//   GET  /api/instance/me                        — current admin status (Bearer auth)
//   GET  /static/<filename>                      — public uploaded assets
//
// Synapse authenticates with `?access_token=<hs_token>` (or
// `Authorization: Bearer ...` on newer versions).  Admin-gated endpoints
// validate the caller's Matrix token via /account/whoami.

import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { config } from "./config";
import { applyEvent, type MatrixEvent } from "./aggregate";
import {
	adminCount,
	bindEmailToUser,
	bootstrapEmailBinding,
	collapsesForRoom,
	countBotsByOwner,
	countFalseFlagsByUser,
	createBot,
	createSuspension,
	deleteBio,
	deleteBot,
	deleteInstanceConfig,
	flagsForRoom,
	getActiveSuspension,
	getBotById,
	getBotByMxid,
	getSuspensionById,
	grantAdmin,
	isAdmin,
	issueAuthCode,
	listAllBotMxids,
	listBotsByOwner,
	listPendingSuspensions,
	lookupUserByEmail,
	markAuthCodeUsed,
	purgeUserState,
	readBio,
	readInstanceConfig,
	readWeight,
	setBotAvatarMxc,
	suspensionsForRoom,
	addBotKnowledge,
	listBotKnowledge,
	deleteBotKnowledge,
	totalBotKnowledgeBytes,
	touchEmailLogin,
	updateBot,
	updateSuspensionStatus,
	verifyAuthCode,
	writeBio,
	writeInstanceConfig,
} from "./db";
import { evaluateCollapses } from "./collapse";
import {
	adminCreateUser,
	adminResetPassword,
	adminSetUserEmail,
	deactivateUser,
	loginAsUser,
	setProfileAvatar,
	uploadMedia,
} from "./synapse";
import { openSecret, sealSecret } from "./secret_box";
import { sendLoginCodeEmail } from "./email";
import { extractToken, whoami } from "./auth";
import { extractKnowledgeText } from "./knowledge_extract";
import { reconcileOne, startOne, stopOne } from "./bot_manager";

const DAY_MS = 24 * 60 * 60 * 1000;
// Auto-suspend the flagger if they've had this many floor flags
// reversed by an admin within the rolling window, OR this many
// total ever.  Hardcoded for v1; movable to instance_config later
// if values prove contentious.
const FALSE_FLAG_WINDOW_THRESHOLD = 2;
const FALSE_FLAG_WINDOW_MS = 30 * DAY_MS;
const FALSE_FLAG_TOTAL_THRESHOLD = 3;

const seenTransactions = new Set<string>();

const UPLOADS_DIR = join(dirname(config.dbPath), "uploads");
const STATIC_FILE_RE = /^[a-z0-9]+\.[a-z0-9]+$/i;
const ALLOWED_IMAGE_TYPES = new Set([
	"image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml",
]);
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

// Editable keys; anything else is rejected.  Restricting the set
// avoids the "admin scribbled junk into a key the client doesn't read"
// problem and gives us one place to track UI surface area.
const ALLOWED_CONFIG_KEYS = new Set([
	"name",
	"login_background_url",
	"login_tagline",
	"logo_url",
	"default_space_id",
]);

function isAuthorizedAsHomeserver(req: Request): boolean {
	const url = new URL(req.url);
	const queryToken = url.searchParams.get("access_token");
	if (queryToken && queryToken === config.hsToken) return true;
	const auth = req.headers.get("authorization");
	if (auth?.startsWith("Bearer ") && auth.slice(7) === config.hsToken) return true;
	return false;
}

function corsHeaders(): Record<string, string> {
	return {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Matrix-Token",
	};
}

async function ensureUploadsDir(): Promise<void> {
	if (!existsSync(UPLOADS_DIR)) await mkdir(UPLOADS_DIR, { recursive: true });
}

function extensionFor(mime: string): string | null {
	switch (mime) {
		case "image/png":  return "png";
		case "image/jpeg": return "jpg";
		case "image/jpg":  return "jpg";
		case "image/webp": return "webp";
		case "image/gif":  return "gif";
		case "image/svg+xml": return "svg";
	}
	return null;
}

async function requireAdmin(req: Request): Promise<{ userId: string } | Response> {
	const token = extractToken(req);
	const userId = await whoami(token);
	if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
	if (!isAdmin(userId)) return json({ errcode: "M_FORBIDDEN", error: "admin only" }, { status: 403 });
	return { userId };
}

/**
 * Common admin-image-upload pipeline used by /api/instance/login-bg
 * and /api/instance/logo.  Validates content-type + size, hashes the
 * payload to a stable filename, replaces the previous file pointed at
 * by `configKey`, and writes the new `/static/<filename>` URL into
 * the matching config key.
 */
async function handleAdminImageUpload(req: Request, configKey: string): Promise<Response> {
	const auth = await requireAdmin(req);
	if (auth instanceof Response) return auth;
	let form: Awaited<ReturnType<Request["formData"]>>;
	try {
		form = await req.formData();
	} catch {
		return json({ errcode: "M_BAD_JSON", error: "multipart body required" }, { status: 400 });
	}
	const file = form.get("file");
	if (!(file instanceof File)) {
		return json({ errcode: "M_INVALID_PARAM", error: "file field required" }, { status: 400 });
	}
	if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
		return json({ errcode: "M_INVALID_PARAM", error: `unsupported type: ${file.type}` }, { status: 400 });
	}
	if (file.size > MAX_UPLOAD_BYTES) {
		return json({ errcode: "M_TOO_LARGE", error: "file > 5 MB" }, { status: 413 });
	}
	const ext = extensionFor(file.type);
	if (!ext) return json({ errcode: "M_INVALID_PARAM", error: "extension" }, { status: 400 });

	const bytes = new Uint8Array(await file.arrayBuffer());
	const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 24);
	const filename = `${hash}.${ext}`;
	await ensureUploadsDir();
	await writeFile(join(UPLOADS_DIR, filename), bytes);

	// If the previous file (for this config key) lives in our uploads
	// dir and isn't the one we just wrote, delete it so the dir doesn't
	// fill with orphaned old uploads.
	const prevUrl = readInstanceConfig()[configKey];
	const prevName = prevUrl?.startsWith("/static/") ? prevUrl.slice("/static/".length) : null;
	if (prevName && prevName !== filename && STATIC_FILE_RE.test(prevName)) {
		await unlink(join(UPLOADS_DIR, prevName)).catch(() => {});
	}

	const url = `/static/${filename}`;
	writeInstanceConfig(configKey, url, auth.userId);
	return json({ config: readInstanceConfig() });
}

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "Content-Type": "application/json", ...corsHeaders(), ...(init.headers ?? {}) },
	});
}

// Loose email validation: well-formed enough to be worth sending.
// Resend will tell us if it's actually deliverable.  We mostly want to
// catch obvious typos (missing @, missing TLD) before paying the email
// round-trip.
function isValidEmail(s: string): boolean {
	if (!s || s.length > 254) return false;
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// Username rules — tighter than the full Matrix localpart spec on
// purpose.  Matrix permits a–z 0–9 . _ = - + / up to 255 chars; most
// of those characters are unreadable in a handle, and a 255-char
// username is unreadable too.  We accept only lowercase letters,
// digits, and hyphens; 1..21 chars (Twitter-handle territory).
// Mirrored client-side in Login.tsx.
function isValidLocalpart(s: string): boolean {
	return s.length >= 1 && s.length <= 21 && /^[a-z0-9-]+$/.test(s);
}

// Bot localpart rules: lowercase a–z, 0–9, hyphens; 1..21 chars.
// Mirrors the human-username validation, just slightly tighter (no
// dots / underscores / etc).  The mxid Becomes `@bot-<name>:server`,
// so the full visible localpart is `bot-<name>` with `bot-` always
// the first 4 chars (the appservice namespace claim is `@bot-.*`).
function isValidBotName(s: string): boolean {
	return s.length >= 1 && s.length <= 21 && /^[a-z0-9-]+$/.test(s) && !s.startsWith("-") && !s.endsWith("-");
}

// Strip secrets out of a BotRow before sending to the client.  Token
// encrypted-blobs and the device id are operator-internal; the API
// key the client supplies is never echoed back (they re-paste on
// edit if they want to change it).
function toBotSummary(row: import("./db").BotRow) {
	return {
		id: row.id,
		mxid: row.mxid,
		owner_id: row.owner_id,
		display_name: row.display_name,
		avatar_mxc: row.avatar_mxc,
		provider: row.provider,
		api_base: row.api_base,
		model: row.model,
		system_prompt: row.system_prompt,
		context_window: row.context_window,
		triggers: row.triggers,
		enabled: row.enabled === 1,
		created_at: row.created_at,
		// Usage stats are operator-/owner-readable.
		total_prompt_tokens: row.total_prompt_tokens,
		total_completion_tokens: row.total_completion_tokens,
		total_calls: row.total_calls,
		last_used_at: row.last_used_at,
		// Sentinel so the client knows an API key is on file without
		// receiving the value itself.  The PATCH endpoint accepts an
		// empty string (or omitted field) as "leave the key alone".
		has_api_key: true,
	};
}

/** Coerce arbitrary JSON into a clean trigger array.  Trims, drops
 * empties + duplicates, caps each phrase length + total count, so a
 * malicious or sloppy client can't fill the column with megabytes of
 * junk that the pipeline then has to scan against every message. */
function sanitiseTriggers(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim().slice(0, 100);
		if (!trimmed) continue;
		const lower = trimmed.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		out.push(trimmed);
		if (out.length >= 50) break;
	}
	return out;
}

// 32-byte URL-safe base64 password used for Synapse's stored password
// hash.  Never shown to users; they auth by email code, not password.
// We only ever need it to satisfy UIA challenges, where Synapse
// hashes the value we send and compares against its bcrypt'd copy.
function randomPassword(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export function startServer(): void {
	Bun.serve({
		port: config.port,
		async fetch(req): Promise<Response> {
			const url = new URL(req.url);
			const path = url.pathname;

			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders() });
			}

			// Engine-native API for clients.
			if (req.method === "GET" && path === "/api/weight") {
				const userId = url.searchParams.get("user_id");
				if (!userId) return json({ error: "user_id required" }, { status: 400 });
				const w = readWeight(userId);
				if (!w) return json({ user_id: userId, weight: 1.0, unseen: true });
				return json(w);
			}
			if (req.method === "GET" && path.startsWith("/api/weight/")) {
				const userId = decodeURIComponent(path.slice("/api/weight/".length));
				const w = readWeight(userId);
				if (!w) return json({ user_id: userId, weight: 1.0, unseen: true });
				return json(w);
			}

			// Health check — handy for `curl localhost:9000/healthz`.
			if (req.method === "GET" && path === "/healthz") {
				return json({ ok: true });
			}

			// ─── Instance config + branding ──────────────────────────
			// Public read — login screen needs this before the user is
			// authenticated, so no token check.
			if (req.method === "GET" && path === "/api/instance") {
				return json({ config: readInstanceConfig() });
			}

			// ─── Email-code auth ─────────────────────────────────────
			// Two-step passwordless login: client posts an email, engine
			// emails a one-time code, client posts the code back, engine
			// returns a Synapse access token (creating the account on
			// first contact for that email).  The Matrix password Synapse
			// holds is rotated to a fresh random string on every login;
			// the client gets the new password in the verify response and
			// uses it ONLY for UIA challenges within that session (it
			// never persists to disk).  See /api/auth/uia-password below
			// for refreshing it later in the session.

			// POST /api/auth/request-code { email }
			//   → { ok: true, is_new_account: boolean }     (200)
			//   → { error: "rate_limited" }                 (429)
			//   → { error: "email_disabled" }               (503) when not configured
			//   → { error: "invalid_email" }                (400)
			if (req.method === "POST" && path === "/api/auth/request-code") {
				const body = (await req.json().catch(() => ({}))) as { email?: string };
				const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
				if (!isValidEmail(email)) {
					return json({ error: "invalid_email" }, { status: 400 });
				}
				const issued = issueAuthCode(email, config.emailCodeTtlMs);
				if ("error" in issued) {
					return json({ error: issued.error }, { status: 429 });
				}
				const brandName = readInstanceConfig()["name"] || "Koven";
				const sent = await sendLoginCodeEmail(email, issued.code, {
					brandName,
					ttlMinutes: Math.round(config.emailCodeTtlMs / 60_000),
				});
				if (sent.error === "not_configured") {
					return json({ error: "email_disabled" }, { status: 503 });
				}
				if (sent.error) {
					return json({ error: "send_failed", detail: sent.detail }, { status: 502 });
				}
				const isNew = lookupUserByEmail(email) === null;
				return json({ ok: true, is_new_account: isNew });
			}

			// POST /api/auth/verify-code { email, code, username? }
			//   - existing email → mints a token, returns Matrix creds
			//     plus a fresh `uia_password` the client uses for UIA.
			//   - new email + valid username → admin-creates the account,
			//     binds the email, mints token, returns same shape.
			//   - new email without username → 400 "needs_username".
			if (req.method === "POST" && path === "/api/auth/verify-code") {
				const body = (await req.json().catch(() => ({}))) as {
					email?: string; code?: string; username?: string;
				};
				const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
				const code = typeof body.code === "string" ? body.code.trim() : "";
				const usernameInput = typeof body.username === "string" ? body.username.trim() : "";
				if (!isValidEmail(email) || !/^\d{4,8}$/.test(code)) {
					return json({ error: "invalid_request" }, { status: 400 });
				}

				const verify = verifyAuthCode(email, code);
				if ("error" in verify) {
					return json({ error: verify.error }, { status: 401 });
				}
				// Code is valid but NOT yet consumed; we'll mark it used
				// at the very end of this handler so any retryable
				// failure mid-flow (taken username, etc.) leaves the
				// code valid for another attempt.
				const codeId = verify.codeId;

				let userId = lookupUserByEmail(email);
				if (!userId) {
					// First-time user.  Need a username.
					if (!usernameInput) {
						return json({ error: "needs_username" }, { status: 400 });
					}
					if (!isValidLocalpart(usernameInput)) {
						return json({ error: "invalid_username" }, { status: 400 });
					}
					const candidateMxid = `@${usernameInput}:${config.homeserverName}`;
					// Random 32-byte password; rotated again on every
					// login + UIA challenge.  Never returned to the user
					// (only the rotated value below is returned, so this
					// password effectively only ever exists inside the
					// admin-create call).
					const initialPw = randomPassword();
					const created = await adminCreateUser({
						userId: candidateMxid,
						password: initialPw,
						email,
					});
					if ("error" in created) {
						// Most common: M_USER_IN_USE if the localpart
						// is taken by someone else.  Surface raw detail
						// so the UI can show a helpful message.
						return json({
							error: "username_unavailable",
							detail: created.detail ?? created.error,
						}, { status: 409 });
					}
					bindEmailToUser(email, candidateMxid);
					userId = candidateMxid;
				}

				// Rotate the password to a fresh value, then log in
				// with it via the normal m.login.password flow.  Two
				// effects, one call apart:
				//
				//   - The rotated password becomes both the access-
				//     token-minting credential AND the value the
				//     client uses to satisfy any UIA challenge later
				//     this session.
				//   - Going through /_matrix/client/v3/login (instead
				//     of /_synapse/admin/v1/users/<id>/login) avoids
				//     Synapse's "Cannot use admin API to login as
				//     self" guard, which fires when the admin user
				//     signs themselves in via this same flow.
				const uiaPassword = randomPassword();
				const ok = await adminResetPassword(userId, uiaPassword);
				if (!ok) {
					return json({ error: "password_rotate_failed" }, { status: 502 });
				}

				const token = await loginAsUser(userId, uiaPassword);
				if ("error" in token) {
					return json({ error: token.error, detail: token.detail }, { status: 502 });
				}

				// Everything succeeded.  Burn the code now so it can't
				// be replayed; up to this point any error returned
				// above left it valid for a retry.
				markAuthCodeUsed(codeId);
				touchEmailLogin(email);
				return json({
					ok: true,
					user_id: token.user_id,
					access_token: token.access_token,
					device_id: token.device_id,
					uia_password: uiaPassword,
				});
			}

			// POST /api/admin/bootstrap { email, user_id }
			//
			// Install-time admin provisioning surface called by
			// `bin/koven bootstrap-admin`.  Auth is the engine's
			// appservice token (config.asToken) — an operator-level
			// secret already shared between engine and Synapse via
			// the appservice YAML.  We don't use a real user's
			// access token because at bootstrap time there isn't one
			// yet; the whole point is to seed the first admin.
			//
			// Idempotent: re-running just refreshes the email row
			// and re-grants the admin role (INSERT OR IGNORE).
			//
			// Effect:
			//   - user_emails row binds email → user_id (Koven
			//     web's email-code login uses this for lookups).
			//   - admins row marks the user as instance admin
			//     immediately, without waiting for the first-user
			//     bootstrap to fire on their first message.
			if (req.method === "POST" && path === "/api/admin/bootstrap") {
				const token = extractToken(req);
				if (!token || token !== config.asToken) {
					return json({ errcode: "M_FORBIDDEN", error: "use the appservice token" }, { status: 403 });
				}
				const body = (await req.json().catch(() => ({}))) as {
					email?: string; user_id?: string;
				};
				const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
				const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
				if (!isValidEmail(email)) {
					return json({ error: "invalid_email" }, { status: 400 });
				}
				if (!userId.startsWith("@") || !userId.includes(":")) {
					return json({ error: "invalid_user_id" }, { status: 400 });
				}
				bootstrapEmailBinding(email, userId);
				grantAdmin(userId, null);
				return json({ ok: true, user_id: userId, email });
			}

			// POST /api/auth/uia-password
			// Authed via the user's Matrix access token.  Rotates the
			// Synapse password to a fresh random string and returns it.
			// Called by the client right before any UIA-protected op
			// (encryption setup, account deactivation) so the password
			// never has to live in client storage between operations.
			if (req.method === "POST" && path === "/api/auth/uia-password") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const password = randomPassword();
				const ok = await adminResetPassword(userId, password);
				if (!ok) {
					return json({ error: "password_rotate_failed" }, { status: 502 });
				}
				return json({ password });
			}

			// "Am I an admin?" — used by the client to decide whether
			// to render the admin UI.  Returns 200 with is_admin=false
			// for unauthenticated or non-admin callers (no need to 401).
			if (req.method === "GET" && path === "/api/instance/me") {
				const userId = await whoami(extractToken(req));
				const userIsAdmin = userId ? isAdmin(userId) : false;
				return json({
					user_id: userId,
					is_admin: userIsAdmin,
					// Total admin count, exposed so the Settings → Account
					// "Delete account" path can refuse to deactivate the
					// only remaining admin and instead surface a "promote
					// another admin first" message.  Cheap and only
					// returned on this auth-probe endpoint.
					admin_count: adminCount(),
					is_only_admin: userIsAdmin && adminCount() === 1,
				});
			}

			// Self-cleanup endpoint, called by the client right before
			// it asks Synapse to deactivate the account.  Drops the
			// user's reputation row and active suspension (if any).
			// Audit-trail rows (flags they submitted, collapses they
			// voted into, mod-log entries) are LEFT IN PLACE: those
			// describe community decisions and shouldn't disappear
			// just because the actor walked away.
			//
			// Refuses if the caller is the only admin: deactivating the
			// last admin would make floor-violation review impossible.
			// The client checks /api/instance/me's is_only_admin first,
			// but we re-check here so a stale client can't bypass.
			if (req.method === "POST" && path === "/api/me/purge") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				if (isAdmin(userId) && adminCount() === 1) {
					return json({
						errcode: "M_FORBIDDEN",
						error: "cannot delete the only remaining admin account; promote another admin first",
					}, { status: 409 });
				}
				purgeUserState(userId);
				return json({ ok: true });
			}

			// ─── Suspension state ────────────────────────────────────
			// "Is my account paused?" — the client polls this on boot
			// and periodically.  When suspended, the UI gates compose,
			// DM creation, and room/space creation.  Read remains
			// allowed because Synapse doesn't kick the user out of
			// rooms (deactivation only happens on admin-confirm).
			if (req.method === "GET" && path === "/api/me/status") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const susp = getActiveSuspension(userId);
				return json({
					user_id: userId,
					suspended: !!susp,
					suspension: susp ? {
						id: susp.id,
						reason: susp.reason,
						status: susp.status,
						created_at: susp.created_at,
					} : null,
				});
			}

			// ─── Bots ────────────────────────────────────────────────
			// User-managed AI bots.  Each bot is a real Matrix user in
			// the @bot-* appservice namespace whose access token + LLM
			// API key are AES-GCM encrypted at rest (see secret_box.ts).
			// Owner is the Matrix user who created the bot; only the
			// owner can edit / delete.  Anyone on the instance can see
			// which bots exist (via /api/bots/all-mxids — drives the
			// BOT badge in the UI) and can invite bots to their rooms.

			// GET /api/bots/all-mxids
			// Public read.  Returns every enabled bot's mxid so clients
			// can render the BOT badge without needing per-bot lookups.
			if (req.method === "GET" && path === "/api/bots/all-mxids") {
				return json({ bots: listAllBotMxids() });
			}

			// GET /api/bots/me
			// Authed.  Lists bots owned by the caller, with usage stats
			// but WITHOUT the encrypted secrets (we never echo them).
			if (req.method === "GET" && path === "/api/bots/me") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN" }, { status: 401 });
				return json({ bots: listBotsByOwner(userId).map(toBotSummary) });
			}

			// POST /api/bots
			// Create a bot.  Provisions the Synapse user, mints its
			// access token, encrypts both the LLM key + the Synapse
			// token, and stores the row.  Returns the summary (no
			// secrets).  Caller-supplied `name` becomes the localpart
			// of the mxid as `@bot-<name>:server`.
			if (req.method === "POST" && path === "/api/bots") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN" }, { status: 401 });
				const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

				const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
				const displayName = typeof body.display_name === "string" ? body.display_name.trim() : name;
				const provider = body.provider === "openrouter" || body.provider === "openai_compatible"
					? body.provider : "";
				const apiBase = typeof body.api_base === "string" ? body.api_base.trim() : "";
				const apiKey = typeof body.api_key === "string" ? body.api_key : "";
				const model = typeof body.model === "string" ? body.model.trim() : "";
				const systemPrompt = typeof body.system_prompt === "string" ? body.system_prompt : "";
				const contextWindow = Number.isFinite(body.context_window)
					? Math.max(1, Math.min(100, Math.floor(body.context_window as number)))
					: 20;
				const triggers = sanitiseTriggers(body.triggers);

				if (!isValidBotName(name)) {
					return json({ error: "invalid_name", detail: "Use lowercase a-z, 0-9, and -; up to 21 chars." }, { status: 400 });
				}
				if (!displayName || displayName.length > 100) {
					return json({ error: "invalid_display_name" }, { status: 400 });
				}
				if (!provider) return json({ error: "invalid_provider" }, { status: 400 });
				if (!apiBase) return json({ error: "invalid_api_base" }, { status: 400 });
				if (!apiKey) return json({ error: "invalid_api_key" }, { status: 400 });
				if (!model) return json({ error: "invalid_model" }, { status: 400 });

				if (countBotsByOwner(userId) >= config.maxBotsPerUser) {
					return json({
						error: "bot_limit_reached",
						detail: `Per-user limit is ${config.maxBotsPerUser} bots.`,
					}, { status: 409 });
				}

				const mxid = `@bot-${name}:${config.homeserverName}`;
				if (getBotByMxid(mxid)) {
					return json({ error: "name_taken" }, { status: 409 });
				}

				// Provision the Matrix user, then log in as it to get an
				// access token + device id.  We discard the random
				// password after this step — the engine acts as the bot
				// via the access token from now on.
				const initialPw = randomPassword();
				const created = await adminCreateUser({
					userId: mxid,
					password: initialPw,
					displayname: displayName,
				});
				if ("error" in created) {
					return json({
						error: "synapse_create_failed",
						detail: created.detail ?? created.error,
					}, { status: 502 });
				}
				const token = await loginAsUser(mxid, initialPw);
				if ("error" in token) {
					return json({
						error: "synapse_token_failed",
						detail: token.detail ?? token.error,
					}, { status: 502 });
				}

				let apiKeyEnc: string;
				let accessTokenEnc: string;
				try {
					apiKeyEnc = sealSecret(apiKey);
					accessTokenEnc = sealSecret(token.access_token);
				} catch (err) {
					console.error("engine: failed to seal bot secrets", err);
					return json({ error: "encryption_unavailable" }, { status: 503 });
				}

				const row = createBot({
					mxid,
					owner_id: userId,
					display_name: displayName,
					provider,
					api_base: apiBase,
					api_key_enc: apiKeyEnc,
					model,
					system_prompt: systemPrompt,
					context_window: contextWindow,
					access_token_enc: accessTokenEnc,
					device_id: token.device_id,
					triggers,
				});
				// Boot the runtime in the background — sync + crypto
				// init takes seconds; the API call returns immediately
				// with the new bot's metadata.
				startOne(row.id).catch(err =>
					console.error(`bot manager: startOne(${row.id}) failed`, err),
				);
				return json({ bot: toBotSummary(row) });
			}

			// PATCH /api/bots/:id
			{
				const m = path.match(/^\/api\/bots\/(\d+)$/);
				if (req.method === "PATCH" && m) {
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN" }, { status: 401 });
					const id = Number(m[1]);
					const existing = getBotById(id);
					if (!existing) return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
					if (existing.owner_id !== userId) {
						return json({ errcode: "M_FORBIDDEN", error: "not your bot" }, { status: 403 });
					}
					const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
					const patch: Parameters<typeof updateBot>[1] = {};

					if (typeof body.display_name === "string") {
						const v = body.display_name.trim();
						if (!v || v.length > 100) {
							return json({ error: "invalid_display_name" }, { status: 400 });
						}
						patch.display_name = v;
					}
					if (body.provider === "openrouter" || body.provider === "openai_compatible") {
						patch.provider = body.provider;
					}
					if (typeof body.api_base === "string") {
						const v = body.api_base.trim();
						if (!v) return json({ error: "invalid_api_base" }, { status: 400 });
						patch.api_base = v;
					}
					if (typeof body.api_key === "string" && body.api_key.length > 0) {
						// Empty string means "leave the existing key alone."
						// Any non-empty value is treated as a replacement.
						try {
							patch.api_key_enc = sealSecret(body.api_key);
						} catch {
							return json({ error: "encryption_unavailable" }, { status: 503 });
						}
					}
					if (typeof body.model === "string") {
						const v = body.model.trim();
						if (!v) return json({ error: "invalid_model" }, { status: 400 });
						patch.model = v;
					}
					if (typeof body.system_prompt === "string") {
						patch.system_prompt = body.system_prompt;
					}
					if (Number.isFinite(body.context_window)) {
						patch.context_window = Math.max(1, Math.min(100, Math.floor(body.context_window as number)));
					}
					if (typeof body.enabled === "boolean") {
						patch.enabled = body.enabled ? 1 : 0;
					}
					if (Array.isArray(body.triggers)) {
						patch.triggers = sanitiseTriggers(body.triggers);
					}

					const updated = updateBot(id, patch);
					// If `enabled` flipped (or any other meaningful
					// runtime field changed), reconcile so the
					// background runtime matches the new DB state.
					reconcileOne(id).catch(err =>
						console.error(`bot manager: reconcileOne(${id}) failed`, err),
					);
					return json({ bot: updated ? toBotSummary(updated) : null });
				}
			}

			// DELETE /api/bots/:id
			{
				const m = path.match(/^\/api\/bots\/(\d+)$/);
				if (req.method === "DELETE" && m) {
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN" }, { status: 401 });
					const id = Number(m[1]);
					const existing = getBotById(id);
					if (!existing) return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
					if (existing.owner_id !== userId) {
						return json({ errcode: "M_FORBIDDEN", error: "not your bot" }, { status: 403 });
					}
					// 1. Stop the runtime so it flushes /sync state and
					//    drops its sockets + crypto handles.
					await stopOne(id);

					// 2. Deactivate the bot's Synapse account so Synapse
					//    auto-kicks it from every room it joined.  Without
					//    this the bot persists as an inactive member in
					//    every room it was invited to — exactly the bug
					//    report.  `erase: false` keeps the bot's past
					//    messages attributed (the BotsPane delete
					//    confirmation says so explicitly); pass `true`
					//    here only if we ever want bot-deletion to also
					//    redact prior content.  Logged-but-non-fatal on
					//    Synapse error so a transient admin-API hiccup
					//    doesn't strand the engine row.
					const deactivated = await deactivateUser(existing.mxid, false);
					if (!deactivated) {
						console.warn(
							`engine: bot ${existing.mxid} delete: deactivate failed; deleting engine row anyway`,
						);
					}

					// 3. Drop the engine row.  After this the mxid is
					//    free in the engine's namespace check, but the
					//    Synapse user record sticks around (deactivated)
					//    forever — Synapse doesn't support unclaiming a
					//    localpart.  Re-creating with the same name will
					//    re-activate the same Matrix account via
					//    adminCreateUser's idempotent PUT.
					deleteBot(id);

					// 4. Wipe the bot's on-disk crypto snapshot.  Bot
					//    ids are autoincrement (no reuse), but leaving
					//    the directory leaks disk over many delete +
					//    re-create cycles.
					const stateDir = join(dirname(config.dbPath), "bot-state", String(id));
					await rm(stateDir, { recursive: true, force: true })
						.catch(err => console.warn(`engine: bot ${id} state cleanup failed`, err));

					return json({ ok: true });
				}
			}

			// POST /api/bots/:id/avatar  (multipart "file" field)
			// DELETE /api/bots/:id/avatar
			//
			// Owner-only.  Avatar bytes are uploaded to Synapse's media
			// repo authenticated AS the bot (via the bot's stored access
			// token), then the bot's own profile `avatar_url` is set so
			// the picture shows up everywhere the bot's mxid is rendered
			// — member lists, message rows, federated previews.  The
			// resulting `mxc://` URL is mirrored into bots.avatar_mxc so
			// the client gets it back for instant rendering without
			// waiting for a /sync round-trip.
			{
				const m = path.match(/^\/api\/bots\/(\d+)\/avatar$/);
				if (m) {
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN" }, { status: 401 });
					const id = Number(m[1]);
					const existing = getBotById(id);
					if (!existing) return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
					if (existing.owner_id !== userId) {
						return json({ errcode: "M_FORBIDDEN", error: "not your bot" }, { status: 403 });
					}

					let botToken: string;
					try {
						botToken = openSecret(existing.access_token_enc);
					} catch (err) {
						console.error("engine: bot avatar: failed to decrypt access token", err);
						return json({ error: "encryption_unavailable" }, { status: 503 });
					}

					if (req.method === "POST") {
						let form: Awaited<ReturnType<Request["formData"]>>;
						try {
							form = await req.formData();
						} catch {
							return json({ errcode: "M_BAD_JSON", error: "multipart body required" }, { status: 400 });
						}
						const file = form.get("file");
						if (!(file instanceof File)) {
							return json({ errcode: "M_INVALID_PARAM", error: "file field required" }, { status: 400 });
						}
						if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
							return json({ errcode: "M_INVALID_PARAM", error: `unsupported type: ${file.type}` }, { status: 400 });
						}
						if (file.size > MAX_UPLOAD_BYTES) {
							return json({ errcode: "M_TOO_LARGE", error: "file > 5 MB" }, { status: 413 });
						}

						const bytes = new Uint8Array(await file.arrayBuffer());
						const upload = await uploadMedia({
							accessToken: botToken,
							bytes,
							contentType: file.type,
							filename: file.name || `avatar.${extensionFor(file.type) ?? "png"}`,
						});
						if ("error" in upload) {
							return json({
								error: "synapse_upload_failed",
								detail: upload.detail ?? upload.error,
							}, { status: 502 });
						}

						// Set the bot's profile avatar so every Matrix
						// client renders the new picture; if this fails
						// the upload is already done so we still update
						// the row, but log the inconsistency.
						const set = await setProfileAvatar(botToken, existing.mxid, upload.mxc);
						if (!set) {
							console.warn(`engine: bot ${existing.mxid} avatar uploaded (${upload.mxc}) but profile set failed`);
						}

						const updated = setBotAvatarMxc(id, upload.mxc);
						return json({ bot: updated ? toBotSummary(updated) : null });
					}

					if (req.method === "DELETE") {
						// Best-effort profile clear — if Synapse is
						// unreachable we still drop the local mxc so
						// the bot row reflects the user's intent.
						await setProfileAvatar(botToken, existing.mxid, "");
						const updated = setBotAvatarMxc(id, null);
						return json({ bot: updated ? toBotSummary(updated) : null });
					}
				}
			}

			// GET    /api/bots/:id/knowledge        — list metadata
			// POST   /api/bots/:id/knowledge        — upload a .txt
			// DELETE /api/bots/:id/knowledge/:fid   — drop one file
			//
			// Per-bot reference material the owner attaches to inform
			// the LLM at inference time.  See bot_pipeline's buildContext
			// — every knowledge file's full content gets prepended to
			// the bot's system prompt on every call.  No chunking, no
			// embeddings: simple is fine for the small-doc use case
			// (FAQs, bios, project READMEs), and the bot owner's own
			// API key pays for the tokens so they self-regulate.
			{
				const m = path.match(/^\/api\/bots\/(\d+)\/knowledge(?:\/(\d+))?$/);
				if (m) {
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN" }, { status: 401 });
					const id = Number(m[1]);
					const fileId = m[2] ? Number(m[2]) : null;
					const existing = getBotById(id);
					if (!existing) return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
					if (existing.owner_id !== userId) {
						return json({ errcode: "M_FORBIDDEN", error: "not your bot" }, { status: 403 });
					}

					if (req.method === "GET" && fileId === null) {
						return json({
							files: listBotKnowledge(id),
							total_bytes: totalBotKnowledgeBytes(id),
						});
					}

					if (req.method === "POST" && fileId === null) {
						let form: Awaited<ReturnType<Request["formData"]>>;
						try {
							form = await req.formData();
						} catch {
							return json({ errcode: "M_BAD_JSON", error: "multipart body required" }, { status: 400 });
						}
						const file = form.get("file");
						if (!(file instanceof File)) {
							return json({ errcode: "M_INVALID_PARAM", error: "file field required" }, { status: 400 });
						}
						// 10 MB per upload — applies to the source
						// file (.docx/.pdf/etc.), not the extracted
						// text.  A 10 MB Word doc unpacks to maybe
						// 1 MB of plain text, which is fine.
						if (file.size > 10 * 1024 * 1024) {
							return json({ errcode: "M_TOO_LARGE", error: "file > 10 MB" }, { status: 413 });
						}
						// Extract plain text — handles .txt, .md,
						// .docx, and friends.  See
						// engine/src/knowledge_extract.ts for the
						// supported list.
						const extract = await extractKnowledgeText(file);
						if ("error" in extract) {
							return json({
								errcode: "M_INVALID_PARAM",
								error: extract.error,
								detail: extract.detail,
							}, { status: 400 });
						}
						// Total cap per bot — prevents accidentally
						// jamming a multi-hundred-MB context into
						// every LLM call.  Measured against the
						// extracted text size, not the source-file
						// size, since that's what actually gets
						// tokenised.
						const newBytes = new TextEncoder().encode(extract.text).length;
						const currentTotal = totalBotKnowledgeBytes(id);
						if (currentTotal + newBytes > 50 * 1024 * 1024) {
							return json({
								errcode: "M_TOO_LARGE",
								error: `bot knowledge total > 50 MB (currently ${currentTotal})`,
							}, { status: 413 });
						}
						const meta = addBotKnowledge(
							id,
							extract.filename.slice(0, 255),
							extract.text,
						);
						return json({ file: meta });
					}

					if (req.method === "DELETE" && fileId !== null) {
						const ok = deleteBotKnowledge(fileId, id);
						if (!ok) return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
						return json({ ok: true });
					}
				}
			}

			// ─── Admin: floor-violation review queue ─────────────────
			// Admin sees pending floor-violation suspensions and either
			// confirms (deactivates the account) or reverses (lifts
			// the suspension and triggers the false-flag punishment
			// pipeline against the flagger).
			if (req.method === "GET" && path === "/api/admin/floor-queue") {
				const auth = await requireAdmin(req);
				if (auth instanceof Response) return auth;
				return json({ pending: listPendingSuspensions() });
			}

			// POST /api/admin/floor-queue/:id/confirm
			//      /api/admin/floor-queue/:id/reverse
			{
				const m = path.match(/^\/api\/admin\/floor-queue\/(\d+)\/(confirm|reverse)$/);
				if (req.method === "POST" && m) {
					const auth = await requireAdmin(req);
					if (auth instanceof Response) return auth;
					const id = Number(m[1]);
					const action = m[2] as "confirm" | "reverse";
					const susp = getSuspensionById(id);
					if (!susp) return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
					if (susp.status !== "pending") {
						return json({ errcode: "M_INVALID_PARAM", error: "already reviewed" }, { status: 409 });
					}
					const body = (await req.json().catch(() => ({}))) as { note?: string };
					const note = typeof body.note === "string" ? body.note.slice(0, 1000) : null;

					if (action === "confirm") {
						// Permanent ban via Synapse admin API.  We mark
						// the suspension confirmed regardless of whether
						// the deactivate call succeeds — failure here
						// (admin token misconfigured, account already
						// deactivated) shouldn't block the audit trail.
						// Operator can re-run deactivate manually if needed.
						const ok = await deactivateUser(susp.user_id);
						updateSuspensionStatus(id, "confirmed", auth.userId, note);
						return json({ id, status: "confirmed", deactivated: ok });
					}

					// Reverse: lift the suspension on the wrongly-accused
					// user, then check whether the flagger has now
					// crossed the false-flag auto-suspension threshold.
					updateSuspensionStatus(id, "reversed", auth.userId, note);

					// Skip the false-flag cascade for repeated_false_flag
					// suspensions (the flagger field is null there) and
					// for suspensions where we never recorded a flagger.
					if (susp.reason !== "floor_violation" || !susp.flagger) {
						return json({ id, status: "reversed", auto_suspended_flagger: false });
					}

					// Counts include the row we just reversed.
					const totalReversed = countFalseFlagsByUser(susp.flagger);
					const recentReversed = countFalseFlagsByUser(
						susp.flagger,
						Date.now() - FALSE_FLAG_WINDOW_MS,
					);
					const tripped =
						recentReversed >= FALSE_FLAG_WINDOW_THRESHOLD ||
						totalReversed >= FALSE_FLAG_TOTAL_THRESHOLD;

					let autoSuspended = false;
					if (tripped && !getActiveSuspension(susp.flagger)) {
						createSuspension({
							user_id: susp.flagger,
							reason: "repeated_false_floor_flags",
							flag_event_id: null,
							target_event_id: null,
							target_room_id: null,
							flagger: null,
						});
						autoSuspended = true;
					}
					return json({
						id,
						status: "reversed",
						flagger: susp.flagger,
						flagger_reversed_total: totalReversed,
						flagger_reversed_30d: recentReversed,
						auto_suspended_flagger: autoSuspended,
					});
				}
			}

			// ─── Per-room public mod log ─────────────────────────────
			// Aggregates flags + collapses + suspensions originating in
			// the room into one chronological feed.  Public read; the
			// whole point of the audit log is anyone can inspect it.
			{
				const m = path.match(/^\/api\/rooms\/([^/]+)\/mod-log$/);
				if (req.method === "GET" && m) {
					const roomId = decodeURIComponent(m[1]!);
					// Each flag row may emit one OR two timeline entries:
					//   - the original flag (always emitted)
					//   - a separate "flag_retracted" entry if the
					//     flagger later withdrew the flag (redacted
					//     the chat.koven.flag.v1 event).
					// The mod log is append-only by design — both
					// events are durable rather than the second
					// erasing the first.
					const flags: Array<
						| {
							kind: "flag";
							ts: number;
							event_id: string;
							target_event_id: string;
							flagger: string;
							category: string;
							rationale: string | null;
							retracted: boolean;
						}
						| {
							kind: "flag_retracted";
							ts: number;
							event_id: string;       // the retracted flag's id
							target_event_id: string;
							category: string;
							flagger: string;        // original flagger
							retracted_by: string;   // mxid that issued the redaction
						}
					> = [];
					for (const f of flagsForRoom(roomId)) {
						flags.push({
							kind: "flag",
							ts: f.ts,
							event_id: f.event_id,
							target_event_id: f.target_event_id,
							flagger: f.flagger,
							category: f.category,
							rationale: f.rationale ?? null,
							retracted: !!f.retracted_at,
						});
						if (f.retracted_at && f.retracted_by) {
							flags.push({
								kind: "flag_retracted",
								ts: f.retracted_at,
								event_id: f.event_id,
								target_event_id: f.target_event_id,
								category: f.category,
								flagger: f.flagger,
								retracted_by: f.retracted_by,
							});
						}
					}
					const collapses = collapsesForRoom(roomId).map(c => ({
						kind: "collapse" as const,
						ts: c.collapsed_at,
						target_event_id: c.target_event_id,
						flagger_count: c.flagger_count,
						weighted_score: c.weighted_score,
						categories: c.categories,
					}));
					const suspensions = suspensionsForRoom(roomId).map(s => ({
						kind: "suspension" as const,
						ts: s.created_at,
						id: s.id,
						user_id: s.user_id,
						reason: s.reason,
						flagger: s.flagger,
						target_event_id: s.target_event_id,
						status: s.status,
						reviewed_at: s.reviewed_at,
						reviewed_by: s.reviewed_by,
					}));
					const merged = [...flags, ...collapses, ...suspensions]
						.sort((a, b) => b.ts - a.ts);
					return json({ room_id: roomId, entries: merged });
				}
			}

			// Admin-only: bulk-update keys.  Body shape: { config: { k: v, ... } }.
			// A null/empty value deletes the key (reverts to default).
			if (req.method === "PUT" && path === "/api/instance") {
				const auth = await requireAdmin(req);
				if (auth instanceof Response) return auth;
				const body = (await req.json().catch(() => null)) as
					| { config?: Record<string, string | null> }
					| null;
				if (!body || typeof body.config !== "object" || body.config === null) {
					return json({ errcode: "M_BAD_JSON", error: "config object required" }, { status: 400 });
				}
				for (const [k, v] of Object.entries(body.config)) {
					if (!ALLOWED_CONFIG_KEYS.has(k)) {
						return json({ errcode: "M_INVALID_PARAM", error: `unknown key: ${k}` }, { status: 400 });
					}
					if (v === null || v === "") deleteInstanceConfig(k);
					else writeInstanceConfig(k, String(v), auth.userId);
				}
				return json({ config: readInstanceConfig() });
			}

			// Admin-only: upload a login background image.
			if (req.method === "POST" && path === "/api/instance/login-bg") {
				return handleAdminImageUpload(req, "login_background_url");
			}

			// Admin-only: upload an instance logo (replaces the brand
			// name text on the login screen when set).
			if (req.method === "POST" && path === "/api/instance/logo") {
				return handleAdminImageUpload(req, "logo_url");
			}

			// ─── User profiles (bios) ────────────────────────────────
			// Bios live in a public engine table because Matrix's profile
			// API doesn't include a public bio field — account_data is
			// owner-private, so we'd have no way to surface them in
			// the DM panel or member sheet otherwise.

			// Public read: anyone can fetch anyone's bio.  Empty string
			// when never set (so the response shape is uniform).
			if (req.method === "GET" && path.startsWith("/api/profile/")) {
				const userId = decodeURIComponent(path.slice("/api/profile/".length));
				if (!userId) return json({ errcode: "M_INVALID_PARAM", error: "user_id" }, { status: 400 });
				return json({ user_id: userId, bio: readBio(userId) ?? "" });
			}

			// Owner-only write: requires a Matrix token, sets the bio
			// for whichever user that token belongs to.  Empty body
			// clears the bio.
			if (req.method === "PUT" && path === "/api/profile/me") {
				const token = extractToken(req);
				const userId = await whoami(token);
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const body = (await req.json().catch(() => null)) as { bio?: string } | null;
				if (!body || typeof body.bio !== "string") {
					return json({ errcode: "M_BAD_JSON", error: "bio string required" }, { status: 400 });
				}
				const trimmed = body.bio.slice(0, 300);
				if (trimmed.length === 0) deleteBio(userId);
				else writeBio(userId, trimmed);
				return json({ user_id: userId, bio: trimmed });
			}

			// Public static-asset serving.  Whitelisted to filenames that
			// match the hash pattern we generate — no path traversal.
			if (req.method === "GET" && path.startsWith("/static/")) {
				const name = path.slice("/static/".length);
				if (!STATIC_FILE_RE.test(name)) {
					return new Response("not found", { status: 404, headers: corsHeaders() });
				}
				const f = Bun.file(join(UPLOADS_DIR, name));
				if (!(await f.exists())) {
					return new Response("not found", { status: 404, headers: corsHeaders() });
				}
				return new Response(f, { headers: { ...corsHeaders(), "Cache-Control": "public, max-age=31536000, immutable" } });
			}

			// Everything below is appservice-only and must carry the hs_token.
			if (!isAuthorizedAsHomeserver(req)) {
				return json({ errcode: "M_FORBIDDEN", error: "bad token" }, { status: 401 });
			}

			// Namespace ownership probes — we don't claim users or aliases,
			// so always 404.  Synapse only calls these when something tries
			// to interact with a namespace, never proactively, so this is
			// effectively dead code in normal operation.
			if (req.method === "GET" && path.startsWith("/_matrix/app/v1/users/")) {
				return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
			}
			if (req.method === "GET" && path.startsWith("/_matrix/app/v1/rooms/")) {
				return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
			}

			if (req.method === "PUT" && path.startsWith("/_matrix/app/v1/transactions/")) {
				const txnId = decodeURIComponent(path.slice("/_matrix/app/v1/transactions/".length));
				// Idempotency: Synapse retries until it gets a 200, and may
				// re-send a transaction we've already processed.  The DB
				// layer also dedupes by event id, but short-circuiting here
				// saves the work.
				if (seenTransactions.has(txnId)) return json({});
				const body = (await req.json()) as { events?: MatrixEvent[] };
				const events = body.events ?? [];
				let sawFlag = false;
				for (const ev of events) {
					try {
						applyEvent(ev);
						if (ev.type === "chat.koven.flag.v1") sawFlag = true;
					} catch (err) {
						console.error("engine: applyEvent failed", err, ev);
					}
				}
				// If this batch contained any flags, kick off a collapse
				// evaluation immediately rather than waiting for the next
				// tick.  Don't await — we want the transaction response
				// to go back to Synapse promptly.
				if (sawFlag) {
					evaluateCollapses().catch(err => {
						console.error("engine: post-transaction evaluateCollapses failed", err);
					});
				}
				seenTransactions.add(txnId);
				// Trim the dedup set so it doesn't grow forever — the last
				// few thousand txn ids is plenty given Synapse retries are
				// near-immediate.
				if (seenTransactions.size > 5000) {
					const drop = Array.from(seenTransactions).slice(0, 1000);
					for (const id of drop) seenTransactions.delete(id);
				}
				return json({});
			}

			return json({ errcode: "M_UNRECOGNIZED", path }, { status: 404 });
		},
	});
	console.log(`engine: listening on :${config.port}`);
}

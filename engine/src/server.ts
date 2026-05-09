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
	botMembershipActionsForRoom,
	collapsesForRoom,
	countBotsByOwner,
	countFalseFlagsByUser,
	countRoomCreationsByUser,
	createBot,
	createSuspension,
	deleteAllNotifications,
	deleteBio,
	deleteBot,
	deleteNotification,
	listNotifications,
	lookupPostUser,
	markAllNotificationsRead,
	markNotificationRead,
	markRoomNotificationsRead,
	unreadNotificationCount,
	deleteInstanceConfig,
	deleteRoomCollapse,
	flagsForRoom,
	flagsForTarget,
	getActiveSuspension,
	getBotById,
	getBotByMxid,
	getRoomCollapse,
	getSuspensionById,
	grantAdmin,
	insertFlag,
	isAdmin,
	issueAuthCode,
	listAllBotMxids,
	listBotsByOwner,
	listPendingSuspensions,
	listRoomCollapses,
	lookupUserByEmail,
	markAuthCodeUsed,
	markFlagRetracted,
	purgeUserState,
	readBio,
	readInstanceConfig,
	readWeight,
	recordBotMembershipAction,
	recordSelfDeletion,
	selfDeletionsForRoom,
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
	adminJoinUserToRoom,
	adminResetPassword,
	adminSetUserEmail,
	deactivateUser,
	getEventSender,
	getJoinedMembers,
	getRoomIconEmoji,
	getRoomJoinRule,
	getRoomKovenMeta,
	getRoomNsfw,
	getRoomNameAndCreator,
	getSpaceChildRoomIds,
	isSpaceRoom,
	kickOrBanAs,
	loginAsUser,
	redactEventAs,
	setProfileAvatar,
	setRoomDirectoryVisibility,
	uploadMedia,
} from "./synapse";
import { openSecret, sealSecret } from "./secret_box";
import { sendLoginCodeEmail } from "./email";
import { extractToken, whoami } from "./auth";
import { extractKnowledgeText } from "./knowledge_extract";
import { reconcileOne, startOne, stopOne } from "./bot_manager";
import { WEIGHT_FLOOR } from "./weight";

const DAY_MS = 24 * 60 * 60 * 1000;
// Auto-suspend the flagger if they've had this many floor flags
// reversed by an admin within the rolling window, OR this many
// total ever.  Hardcoded for v1; movable to instance_config later
// if values prove contentious.
const FALSE_FLAG_WINDOW_THRESHOLD = 2;
const FALSE_FLAG_WINDOW_MS = 30 * DAY_MS;
const FALSE_FLAG_TOTAL_THRESHOLD = 3;

const seenTransactions = new Set<string>();

/**
 * Auto-join a brand-new user to the configured default space + every
 * public/knock child room in it.  Best-effort: a failure on any
 * individual room is logged and swallowed so a misconfigured admin
 * can't break signup.  Awaited inline so the user's first /sync after
 * sign-in includes these rooms — fire-and-forget would race against
 * the SPA opening a sync.
 *
 * Sub-spaces are skipped: the user's onboarding lands them in chat
 * rooms with content, not in a layered hierarchy of empty containers.
 * Private children are skipped because Synapse's admin-join API can't
 * pull a user into an invite-only room that the engine admin isn't a
 * member of.
 */
async function autoJoinDefaultSpace(userId: string, spaceId: string): Promise<void> {
	try {
		const spaceJoin = await adminJoinUserToRoom(userId, spaceId);
		if ("error" in spaceJoin) {
			console.warn(
				`engine: default-space join ${userId} → ${spaceId} failed: ${spaceJoin.error} ${spaceJoin.detail ?? ""}`,
			);
			return;
		}

		const childIds = await getSpaceChildRoomIds(spaceId);
		await Promise.all(childIds.map(async childId => {
			const rule = await getRoomJoinRule(childId);
			// "public" auto-joinable; "knock" still needs membership but
			// admin-join works because the admin can override.  Anything
			// else (invite, restricted, private) we skip — admin-join
			// would 403.
			if (rule !== "public" && rule !== "knock") return;
			const r = await adminJoinUserToRoom(userId, childId);
			if ("error" in r) {
				console.warn(
					`engine: default-space child join ${userId} → ${childId} failed: ${r.error} ${r.detail ?? ""}`,
				);
			}
		}));
	} catch (err) {
		console.warn(`engine: autoJoinDefaultSpace ${userId} → ${spaceId} threw`, err);
	}
}

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
	// Integrations — written via PUT /api/instance, never returned by
	// the public GET /api/instance (filtered by SENSITIVE_CONFIG_KEYS
	// below).  Adding a new integration here means adding it to the
	// sensitive set too if it's a credential.
	"giphy_api_key",
]);

// Keys that hold credentials / secrets.  Stripped from the public
// GET /api/instance response — only the admin-only integrations
// endpoint reveals "configured: true|false" without exposing the
// value itself.  ALLOWED_CONFIG_KEYS may contain non-sensitive
// integration keys too; this set is purely about what's safe to
// return unauthenticated.
const SENSITIVE_CONFIG_KEYS = new Set([
	"giphy_api_key",
]);

function publicInstanceConfig(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(readInstanceConfig())) {
		if (SENSITIVE_CONFIG_KEYS.has(k)) continue;
		out[k] = v;
	}
	return out;
}

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
		// Public bio — same storage as a human user (user_profiles
		// row keyed by the bot's mxid).  This is what other members
		// see in the profile sheet when they tap the bot's avatar.
		// Returned as "" when unset so the edit form doesn't have to
		// case-split on null.
		bio: readBio(row.mxid) ?? "",
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

/**
 * Pull the `errcode` out of a Synapse error response body.  Synapse
 * always replies to errors with `{"errcode": "M_*", "error": "human
 * message"}` — but our admin helpers only capture the body as raw text
 * (truncated to 300 chars), so callers that need to branch on the
 * specific failure (e.g. "username actually taken" vs "admin token
 * revoked") have to re-parse.  Returns undefined if the body isn't
 * JSON, isn't an object, or doesn't carry a string errcode — in which
 * case the caller should treat the error as opaque.
 */
function parseSynapseErrcode(body: string | undefined): string | undefined {
	if (!body) return undefined;
	try {
		const parsed = JSON.parse(body) as unknown;
		if (parsed && typeof parsed === "object" && "errcode" in parsed) {
			const e = (parsed as { errcode?: unknown }).errcode;
			if (typeof e === "string") return e;
		}
	} catch {
		// Body wasn't JSON (HTML 502 page, plain text, etc.).
	}
	return undefined;
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
				// Unseen users get the canonical floor (0.5), not a 1.0
				// fallback.  GOVERNANCE.md / weight.ts both define
				// brand-new accounts as sitting at the floor; returning
				// 1.0 here misclassified them in client-side renderers
				// as "1 red tick / above-floor" until the periodic
				// engine tick eventually wrote a real row, which left
				// stale 1.0s in the SPA's reputation cache for up to a
				// minute.
				if (!w) return json({ user_id: userId, weight: WEIGHT_FLOOR, unseen: true });
				return json(w);
			}
			if (req.method === "GET" && path.startsWith("/api/weight/")) {
				const userId = decodeURIComponent(path.slice("/api/weight/".length));
				const w = readWeight(userId);
				if (!w) return json({ user_id: userId, weight: WEIGHT_FLOOR, unseen: true });
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
				// Strips sensitive keys (e.g. giphy_api_key) — this
				// endpoint is unauthenticated so the login screen can
				// load branding without a session.
				return json({ config: publicInstanceConfig() });
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
						// Distinguish "localpart genuinely taken" from
						// every other failure mode (admin token revoked,
						// Synapse 500, network blip, rate limit, etc.).
						// Lying with "username taken" when the real
						// failure was an admin-auth issue cost us hours
						// of debugging once and is unforgivable for the
						// end user — they retype usernames forever
						// while the actual blocker is somewhere else
						// entirely.
						const errcode = parseSynapseErrcode(created.detail);
						if (errcode === "M_USER_IN_USE") {
							return json({ error: "username_unavailable" }, { status: 409 });
						}
						console.warn(
							`engine: signup blocked by Synapse for ${candidateMxid}: ${created.error} ${errcode ?? ""} ${created.detail ?? ""}`,
						);
						return json({
							error: "synapse_error",
							detail: `Homeserver rejected account creation (${created.error}${errcode ? `, ${errcode}` : ""}): ${created.detail ?? "no body"}`,
						}, { status: 502 });
					}
					bindEmailToUser(email, candidateMxid);
					userId = candidateMxid;

					// Auto-join the new user to the instance's default
					// space + its public child rooms (if an admin has
					// configured one).  Best-effort: failures here are
					// logged but never fail signup, so a stale or
					// misconfigured default_space_id can't lock a user
					// out of registering.  Awaited so the user's first
					// /sync after this response already shows the rooms.
					const defaultSpaceId = readInstanceConfig().default_space_id;
					if (defaultSpaceId) {
						await autoJoinDefaultSpace(candidateMxid, defaultSpaceId);
					}
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
				// Rotate with one retry — Synapse's admin/v2 PUT can
				// transiently 502 / 504 under load (rate-limit on
				// admin endpoint, brief upstream blip, etc.) and
				// the operation is idempotent, so retrying once with
				// a small backoff covers most flakes without
				// frustrating the user with a "server hiccup" toast.
				const uiaPassword = randomPassword();
				let resetResult = await adminResetPassword(userId, uiaPassword);
				if (!resetResult.ok) {
					await new Promise(r => setTimeout(r, 250));
					resetResult = await adminResetPassword(userId, uiaPassword);
				}
				if (!resetResult.ok) {
					return json({
						error: "password_rotate_failed",
						// Include Synapse's status + body preview so
						// the client can show something more specific
						// than "server hiccup" when the failure is
						// persistent (admin token revoked, user
						// suspended, Synapse DB issue, etc.).
						detail: `Synapse ${resetResult.status}: ${resetResult.detail}`,
					}, { status: 502 });
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

			// POST /api/internal/can-publish-room { user_id, room_id }
			//
			// Called by the koven-room-gate Synapse module on the
			// `user_may_publish_room` spam-checker hook BEFORE Synapse
			// adds the room to the public-rooms directory.  Returns:
			//
			//   { allowed: true }                           — proceed
			//   { allowed: false, reason: "rate_limited",    — deny
			//     count, threshold, retry_after_sec }
			//   { allowed: false, reason: "suspended" }     — deny
			//   { allowed: false, reason: "low_reputation",  — deny
			//     weight, threshold }
			//
			// Auth: the engine's appservice token (same secret already
			// shared with Synapse via the appservice yaml).  Refused
			// outright if the token doesn't match — this endpoint is
			// not for end-user clients.
			if (req.method === "POST" && path === "/api/internal/can-publish-room") {
				const token = extractToken(req);
				if (!token || token !== config.asToken) {
					return json({ errcode: "M_FORBIDDEN", error: "use the appservice token" }, { status: 403 });
				}
				const body = (await req.json().catch(() => ({}))) as {
					user_id?: string;
					room_id?: string;
				};
				const userId = typeof body.user_id === "string" ? body.user_id : "";
				if (!userId.startsWith("@") || !userId.includes(":")) {
					return json({ errcode: "M_INVALID_PARAM", error: "user_id required" }, { status: 400 });
				}
				// Admins are always allowed to publish.  This also covers
				// the engine's own bot user when the engine reverses a
				// collapse via setRoomDirectoryVisibility — that call
				// fires `user_may_publish_room` too.
				if (isAdmin(userId)) {
					return json({ allowed: true, reason: "admin" });
				}
				// Suspended accounts cannot publish anything new.  A
				// confirmed-suspension user is essentially read-only on
				// the platform; allowing them to elevate visibility on
				// rooms they made before pausing would be incoherent.
				if (getActiveSuspension(userId)) {
					return json({ allowed: false, reason: "suspended" });
				}

				// Determine whether this publish is for a regular room
				// or a Matrix space.  Both ladder through the same
				// per-reputation-tier daily cap, but the counters are
				// independent — creating a server doesn't eat the
				// channel quota and vice versa.  Read failure falls
				// through to "treat as room" (the conservative default)
				// rather than allowing through unchecked.
				const roomId = typeof body.room_id === "string" ? body.room_id : "";
				let kind: "room" | "space" = "room";
				if (roomId) {
					try {
						if (await isSpaceRoom(roomId)) kind = "space";
					} catch (err) {
						console.warn("can-publish-room: isSpaceRoom check failed", err);
					}
				}

				// Reputation-tiered rate limit per rolling 24h window.
				// Default-weight users (0.5, the floor for new accounts)
				// get the strictest cap; bumps to 3 then 10 as their
				// reputation rises.  Offensive-name floods land entirely
				// in the bottom tier so the cap at 1/24h here is the
				// load-bearing rule.  Spaces use the same threshold
				// ladder against their own counter — same defense, parallel
				// budget.
				const w = readWeight(userId);
				const weight = w?.weight ?? 1.0;
				const threshold =
					weight >= 2.0 ? 10
					: weight >= 1.5 ? 3
					: 1;
				const windowMs = 24 * 60 * 60 * 1000;
				const sinceTs = Date.now() - windowMs;
				const recentCount = countRoomCreationsByUser(userId, sinceTs, kind);
				if (recentCount >= threshold) {
					return json({
						allowed: false,
						reason: "rate_limited",
						kind,
						count: recentCount,
						threshold,
						retry_after_sec: Math.ceil(windowMs / 1000),
					});
				}
				return json({
					allowed: true,
					kind,
					weight,
					count: recentCount,
					threshold,
				});
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
				// Same retry posture as verify-code: one retry on
				// transient failure, then surface Synapse's detail
				// for triage if it sticks.
				let resetResult = await adminResetPassword(userId, password);
				if (!resetResult.ok) {
					await new Promise(r => setTimeout(r, 250));
					resetResult = await adminResetPassword(userId, password);
				}
				if (!resetResult.ok) {
					return json({
						error: "password_rotate_failed",
						detail: `Synapse ${resetResult.status}: ${resetResult.detail}`,
					}, { status: 502 });
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

			// ─── Notifications (in-app bell) ─────────────────────────
			// All routes here are authed via Bearer-Matrix-token.
			// The bell pulls a paginated list, polls unread count,
			// and posts mark-read / dismiss writes; the engine fans
			// out events into rows in real time (see
			// notification-fanout.ts).

			// GET /api/notifications?limit=&before=
			//   limit  — defaults to 50, capped at 200
			//   before — exclusive upper bound on created_at (ms);
			//            omit / "0" / negative => first page
			// Returns the user's notifications newest-first.
			if (req.method === "GET" && path === "/api/notifications") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const rawLimit = Number(url.searchParams.get("limit") ?? "50");
				const limit = Number.isFinite(rawLimit)
					? Math.min(200, Math.max(1, Math.floor(rawLimit)))
					: 50;
				const rawBefore = Number(url.searchParams.get("before") ?? "");
				const before = Number.isFinite(rawBefore) && rawBefore > 0
					? rawBefore
					: Number.MAX_SAFE_INTEGER;
				const rows = listNotifications({ userId, limit, before });
				// Normalise to JSON-friendly shapes — read_at stays
				// `null | number`, kind is the typed enum, snippet is
				// `string | null`.  No transform needed today, but
				// kept explicit so future schema additions don't leak
				// internal columns by accident.
				return json({
					notifications: rows.map(r => ({
						id: r.id,
						event_id: r.event_id,
						room_id: r.room_id,
						kind: r.kind,
						sender: r.sender,
						snippet: r.snippet,
						created_at: r.created_at,
						read_at: r.read_at,
					})),
				});
			}

			// GET /api/notifications/unread-count
			// Cheap point query for the bell badge.  Polled every
			// ~30s by the client so it's wired to be a single
			// indexed lookup (idx_notifications_user_unread).
			if (req.method === "GET" && path === "/api/notifications/unread-count") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				return json({ count: unreadNotificationCount(userId) });
			}

			// POST /api/notifications/read-all
			// Idempotent — marks every unread row for this user as
			// read.  Returns the number of rows updated so the
			// client can optimistically zero out its badge.
			if (req.method === "POST" && path === "/api/notifications/read-all") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const updated = markAllNotificationsRead(userId, Date.now());
				return json({ ok: true, updated });
			}

			// POST /api/notifications/read-by-room { room_id }
			// Bulk-marks every unread notification for the given
			// room as read.  Called by the bell client when the
			// user enters a room with the tab focused — they see
			// messages land in real time, so accumulating unread
			// for the room they're literally watching is wrong UX.
			// Idempotent: returns 0 if there's nothing to clear.
			if (req.method === "POST" && path === "/api/notifications/read-by-room") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const body = (await req.json().catch(() => ({}))) as { room_id?: unknown };
				const roomId = typeof body.room_id === "string" ? body.room_id : "";
				if (!roomId.startsWith("!") || !roomId.includes(":")) {
					return json({ errcode: "M_INVALID_PARAM", error: "room_id required" }, { status: 400 });
				}
				const updated = markRoomNotificationsRead({ userId, roomId, readAt: Date.now() });
				return json({ ok: true, updated });
			}

			// POST /api/notifications/dismiss-all
			// Hard-delete every notification for this user.  Used by
			// the "Clear all" affordance in the bell.  Doesn't
			// affect the underlying Matrix events, just the bell
			// log.
			if (req.method === "POST" && path === "/api/notifications/dismiss-all") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const deleted = deleteAllNotifications(userId);
				return json({ ok: true, deleted });
			}

			// POST /api/notifications/:id/read
			// POST /api/notifications/:id/dismiss
			// Both are user-scoped (UPDATE / DELETE both include
			// `user_id = ?` so a known id from another user's
			// notification can't be touched).  Return 200 even when
			// the row didn't exist or was already in the desired
			// state — the desired post-condition is the same and
			// the client doesn't need to error-handle a no-op.
			{
				const m = path.match(/^\/api\/notifications\/(\d+)\/(read|dismiss)$/);
				if (m && req.method === "POST") {
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
					const id = Number(m[1]);
					const action = m[2];
					if (!Number.isInteger(id) || id <= 0) {
						return json({ errcode: "M_INVALID_PARAM", error: "id must be a positive integer" }, { status: 400 });
					}
					if (action === "read") {
						markNotificationRead({ id, userId, readAt: Date.now() });
					} else {
						deleteNotification({ id, userId });
					}
					return json({ ok: true });
				}
			}

			// ─── Bots ────────────────────────────────────────────────
			// User-managed AI bots.  Each bot is a real Matrix user in
			// the @bot-* appservice namespace whose access token + LLM
			// API key are AES-GCM encrypted at rest (see secret_box.ts).
			// Owner is the Matrix user who created the bot; only the
			// owner can edit / delete.  Anyone on the instance can see
			// which bots exist (via /api/bots/all-mxids — drives the
			// BOT badge in the UI) and can invite bots to their rooms.

			// GET /api/me/publish-quota?kind=room|space
			//
			// User-facing version of the internal can-publish-room
			// gate.  The client calls this BEFORE opening the
			// "Create room" / "Create space" dialog so a rate-limited
			// user sees an explanatory popup instead of filling in a
			// form for nothing and getting denied at submit.
			//
			// Same threshold ladder as the internal gate — they have
			// to agree, otherwise the precheck would lie and the
			// real submit would still fail.  Returns
			// { allowed, count, threshold, retry_after_sec, weight }
			// so the modal can show "X / Y today, next slot in Zh."
			if (req.method === "GET" && path === "/api/me/publish-quota") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const kindParam = url.searchParams.get("kind");
				const kind: "room" | "space" = kindParam === "space" ? "space" : "room";
				if (isAdmin(userId)) {
					return json({
						allowed: true,
						kind,
						reason: "admin",
						count: 0,
						threshold: Number.MAX_SAFE_INTEGER,
					});
				}
				if (getActiveSuspension(userId)) {
					return json({
						allowed: false,
						kind,
						reason: "suspended",
						count: 0,
						threshold: 0,
					});
				}
				const w = readWeight(userId);
				const weight = w?.weight ?? 1.0;
				const threshold =
					weight >= 2.0 ? 10
					: weight >= 1.5 ? 3
					: 1;
				const windowMs = 24 * 60 * 60 * 1000;
				const sinceTs = Date.now() - windowMs;
				const recentCount = countRoomCreationsByUser(userId, sinceTs, kind);
				if (recentCount >= threshold) {
					return json({
						allowed: false,
						kind,
						reason: "rate_limited",
						weight,
						count: recentCount,
						threshold,
						retry_after_sec: Math.ceil(windowMs / 1000),
					});
				}
				return json({
					allowed: true,
					kind,
					weight,
					count: recentCount,
					threshold,
				});
			}

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
				// Optional bio — stored in user_profiles keyed by mxid,
				// same table that backs human bios.  Capped at 300 chars
				// to match the human ceiling enforced on PUT /api/profile/me.
				const bio = typeof body.bio === "string" ? body.bio.slice(0, 300).trim() : "";

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
				// Persist the bio against the bot's mxid so other members
				// see it in the profile sheet.  Empty string skips the
				// write — readBio falls through to "no bio" naturally.
				if (bio.length > 0) writeBio(mxid, bio);
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
					// Bio update writes through to user_profiles, parallel
					// path to PUT /api/profile/me.  Empty string clears.
					// `bio` undefined = "leave existing bio alone."
					if (typeof body.bio === "string") {
						const trimmed = body.bio.slice(0, 300).trim();
						if (trimmed.length === 0) deleteBio(existing.mxid);
						else writeBio(existing.mxid, trimmed);
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
			//      /api/admin/floor-queue/:id/reverse   — lift + penalize flagger
			//      /api/admin/floor-queue/:id/dismiss   — lift, no flagger penalty
			//
			// `reverse` and `dismiss` both lift the target user's
			// suspension and undo any room-target collapse the
			// original flag installed.  The difference is what they
			// say about the flagger:
			//   - reverse: "this was a false report, count it against
			//              the flagger's auto-suspend threshold and
			//              clamp their reputation."
			//   - dismiss: "this report was a good-faith mistake, but
			//              the admin disagreed.  No penalty."
			// The mod log records WHICH action the admin chose so
			// users can see who's distinguishing the cases.
			{
				const m = path.match(/^\/api\/admin\/floor-queue\/(\d+)\/(confirm|reverse|dismiss)$/);
				if (req.method === "POST" && m) {
					const auth = await requireAdmin(req);
					if (auth instanceof Response) return auth;
					const id = Number(m[1]);
					const action = m[2] as "confirm" | "reverse" | "dismiss";
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

					// Both reverse and dismiss lift the target user's
					// suspension.  Status differs so the false-flag
					// counter (which only counts `status='reversed'`
					// rows) cleanly excludes good-faith dismissals.
					const newStatus = action === "reverse" ? "reversed" : "dismissed";
					updateSuspensionStatus(id, newStatus, auth.userId, note);

					// Room-target floor cases (`target_room_id` set,
					// `target_event_id` null) also installed a room
					// collapse via the evaluator at flag time.  Undo
					// that here so the SPA stops overriding the name
					// and Explore re-includes the room.  Flag rows
					// stay in place — append-only audit trail — only
					// the collapse decision is reversed.  The Layer 4
					// directory hide is undone in lockstep so the
					// room is rediscoverable via federation again.
					// Same restore behaviour for both reverse and
					// dismiss — the only difference between them is
					// the flagger penalty, not the target restoration.
					let restoredRoom: string | null = null;
					if (
						susp.reason === "floor_violation" &&
						susp.target_room_id &&
						!susp.target_event_id
					) {
						const removed = deleteRoomCollapse(susp.target_room_id);
						if (removed) {
							restoredRoom = susp.target_room_id;
							void setRoomDirectoryVisibility(susp.target_room_id, "public")
								.catch(err => console.warn(
									`engine: directory restore for ${susp.target_room_id} threw`, err,
								));
						}
					}

					// Dismiss path stops here — no flagger penalty,
					// no auto-suspension cascade.  The admin signaled
					// this was a good-faith report that turned out to
					// be wrong, and we trust that judgment.
					if (action === "dismiss") {
						return json({
							id,
							status: "dismissed",
							restored_room: restoredRoom,
						});
					}

					// Reverse-only from here down: false-flag cascade.
					// Skip for repeated_false_flag suspensions (the
					// flagger field is null there) and for any
					// suspension where we never recorded a flagger.
					if (susp.reason !== "floor_violation" || !susp.flagger) {
						return json({
							id,
							status: "reversed",
							restored_room: restoredRoom,
							auto_suspended_flagger: false,
						});
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
						restored_room: restoredRoom,
					});
				}
			}

			// ─── Room-target flags (offensive room name pipeline) ──
			//
			// Submit / retract a flag against the room itself (its name +
			// topic), as opposed to a single message inside it.  Same
			// flag categories as message flags, same consensus pipeline:
			// distinct flaggers above the room's dynamic threshold OR
			// any single floor-violation flag fast-tracks the collapse
			// (handled by collapse.ts).  Floor-violation room flags
			// also create a suspension row pointing at the room's
			// creator — they're the one accountable for the name.
			//
			// Flagging happens over HTTP rather than as a Matrix wire
			// event because room flags need to work from Explore (where
			// the user isn't a room member yet, so they can't send
			// timeline events into it).  The engine still records the
			// chat.koven.flag.v1 event id field as a synthetic id so
			// the audit-trail shape stays uniform with message flags.
			{
				const m = path.match(/^\/api\/rooms\/([^/]+)\/flag$/);
				if (m) {
					const roomId = decodeURIComponent(m[1]!);
					if (!roomId.startsWith("!")) {
						return json({ errcode: "M_INVALID_PARAM", error: "expected matrix room id" }, { status: 400 });
					}
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_MISSING_TOKEN", error: "auth required" }, { status: 401 });
					// Flagging while paused is incoherent — a paused user
					// shouldn't be able to push the consensus pipeline.
					if (getActiveSuspension(userId)) {
						return json({ errcode: "M_FORBIDDEN", error: "account suspended" }, { status: 403 });
					}

					if (req.method === "POST") {
						const body = (await req.json().catch(() => null)) as
							| { category?: unknown; rationale?: unknown }
							| null;
						const category = typeof body?.category === "string" ? body.category : "";
						const rationale = typeof body?.rationale === "string" ? body.rationale.slice(0, 500) : undefined;
						const allowed = new Set([
							"off_topic", "spam", "harassment", "misinformation", "floor_violation",
						]);
						if (!allowed.has(category)) {
							return json({ errcode: "M_INVALID_PARAM", error: "unknown category" }, { status: 400 });
						}
						// Synthetic event id — namespaced so it can't collide
						// with a real Matrix event id (`$...`).  Stored in
						// the `event_id` PK column the existing flag table
						// uses, so retract / mod-log paths work uniformly.
						const flagEventId = `koven-room-flag:${roomId}:${userId}:${Date.now()}`;
						const ts = Date.now();
						insertFlag({
							event_id: flagEventId,
							target_event_id: roomId,   // unified polymorphic key (see db.ts)
							room_id: roomId,
							flagger: userId,
							category,
							rationale,
							ts,
							target_kind: "room",
						});

						// Floor-violation: open a suspension on the room's
						// creator pending admin review.  Same shape as the
						// message-floor path so the existing /api/admin/
						// floor-queue surfaces both kinds in one feed.
						if (category === "floor_violation") {
							const state = await getRoomNameAndCreator(roomId);
							const creator = state?.creator;
							if (creator && !getActiveSuspension(creator)) {
								createSuspension({
									user_id: creator,
									reason: "floor_violation",
									flag_event_id: flagEventId,
									target_event_id: null,        // no message in scope
									target_room_id: roomId,
									flagger: userId,
								});
							}
						}

						// Kick the collapse evaluator immediately so users
						// see the consensus action (when thresholds are
						// already met) without waiting for the next tick.
						void evaluateCollapses().catch(err =>
							console.warn("engine: post-flag collapse eval failed", err),
						);

						return json({ ok: true, event_id: flagEventId, ts });
					}

					if (req.method === "DELETE") {
						// Retract the caller's most recent active flag on
						// this room.  We look up by composite (room_id,
						// flagger, target_kind='room', not retracted) and
						// mark retracted — symmetric with the
						// chat.koven.flag.v1 redaction path for messages.
						const own = flagsForTarget(roomId).find(
							f => f.flagger === userId,
						);
						if (!own) {
							return json({ errcode: "M_NOT_FOUND", error: "no active flag" }, { status: 404 });
						}
						// Need the full row to find the synthetic event_id —
						// flagsForTarget returns a thin projection.  Pull
						// it from the room flag list by matching flagger.
						const rows = flagsForRoom(roomId);
						const row = rows.find(
							r => r.flagger === userId && r.target_kind === "room" && !r.retracted_at,
						);
						if (!row) {
							return json({ errcode: "M_NOT_FOUND", error: "no active flag" }, { status: 404 });
						}
						const ok = markFlagRetracted(row.event_id, Date.now(), userId);
						if (!ok) {
							return json({ errcode: "M_NOT_FOUND", error: "no active flag" }, { status: 404 });
						}
						return json({ ok: true });
					}
				}
			}

			// ─── Bulk room-icon lookup ──────────────────────────────
			// Synapse's /publicRooms directory chunk only returns
			// standard room fields (name, topic, avatar, member count).
			// Koven stores its room emoji in a custom
			// `chat.koven.room_icon` state event, which the directory
			// can't surface — so the Explore page would fall back to
			// the DiceBear avatar instead of the founder-picked emoji.
			//
			// This endpoint takes a list of room ids and returns the
			// icon emoji for every one that has one set, in a single
			// batched call.  Public read because the data it exposes
			// is already public (anyone can join the room and read the
			// state event themselves) — keeping it unauthenticated
			// means the Explore page can show emojis to logged-out
			// visitors too.
			//
			// Bounded to 200 ids per call so a malicious caller can't
			// spin up thousands of parallel state fetches against
			// Synapse.  The Explore page's default page size is 50.
			if (req.method === "POST" && path === "/api/rooms/icons") {
				const body = (await req.json().catch(() => null)) as
					| { room_ids?: unknown }
					| null;
				const roomIds = Array.isArray(body?.room_ids)
					? (body!.room_ids as unknown[]).filter((x): x is string => typeof x === "string")
					: [];
				if (roomIds.length === 0) return json({ icons: {} });
				if (roomIds.length > 200) {
					return json({
						errcode: "M_LIMIT_EXCEEDED",
						error: "max 200 room_ids per request",
					}, { status: 400 });
				}
				// Parallel state fetches.  Synapse handles each in
				// constant time (state read, no walk), and we cap the
				// fan-out via the 200 cap above; on a healthy install
				// 50 concurrent fetches finish in well under a second.
				// Per-room failures are silently dropped — a room with
				// no icon set, or one we can't read state for, just
				// doesn't appear in the response map.
				//
				// Also returns the room's NSFW flag in the same call
				// (one more state read per room, same admin-token).
				// The Explore page uses both — icon for the tile
				// avatar, nsfw to filter the directory and badge the
				// remaining tiles.  Bundling them into one batched
				// call keeps the wire round-trips down vs. spinning
				// up a separate /api/rooms/nsfw endpoint.
				// Single admin /state fetch per room returns both
				// chat.koven.room_icon and chat.koven.nsfw in one
				// shot — see getRoomKovenMeta in synapse.ts.
				const results = await Promise.all(
					roomIds.map(async (id) => {
						const meta = await getRoomKovenMeta(id);
						return [id, meta] as const;
					}),
				);
				const icons: Record<string, string> = {};
				const nsfw: string[] = [];
				for (const [id, meta] of results) {
					if (meta.iconEmoji) icons[id] = meta.iconEmoji;
					if (meta.nsfw) nsfw.push(id);
				}
				return json({ icons, nsfw });
			}

			// ─── Currently-collapsed rooms list (public) ───────────
			// SPA polls this on Explore + room-list refresh to:
			//   1. Hide collapsed rooms from the Explore directory.
			//   2. Override room-name rendering to "Name Removed by
			//      Community Review" everywhere (sidebar, header,
			//      member sheets, etc.) without mutating m.room.name
			//      itself — the original is preserved on the engine
			//      so an admin reverse restores it verbatim.
			// Public read: the override is meaningful only if every
			// client honours it, so unauthenticated GET is fine and
			// federation-friendly.
			if (req.method === "GET" && path === "/api/rooms/collapsed") {
				const rows = listRoomCollapses();
				return json({
					rooms: rows.map(r => ({
						room_id: r.room_id,
						collapsed_at: r.collapsed_at,
						categories: r.categories,
						fast_track: r.fast_track,
						// `original_name` is intentionally NOT included
						// in the public response — surfacing the
						// collapsed name via an unauthenticated endpoint
						// would defeat the purpose of hiding it.  Admins
						// see it via /api/admin/floor-queue when the
						// case is open.
					})),
				});
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
					// Voluntary takedowns: trash-button deletions of own
					// or owned-bot messages.  Distinct from collapses
					// (community-driven) and from flag retractions
					// (which target the FLAG event, not the message).
					const selfDeletions = selfDeletionsForRoom(roomId).map(d => ({
						kind: "self_deletion" as const,
						ts: d.created_at,
						target_event_id: d.target_event_id,
						redacted_by: d.redacted_by,
						target_sender: d.target_sender,
						deletion_kind: d.kind,
					}));
					// Founder-initiated bot removals.  Carved out of the
					// consensus model on principle (bots aren't people)
					// but logged here so the room can see who silenced
					// what.
					const botActions = botMembershipActionsForRoom(roomId).map(a => ({
						kind: "bot_membership" as const,
						ts: a.created_at,
						bot_mxid: a.bot_mxid,
						bot_owner: a.bot_owner,
						action: a.action,
						founder: a.founder,
					}));
					const merged = [...flags, ...collapses, ...suspensions, ...selfDeletions, ...botActions]
						.sort((a, b) => b.ts - a.ts);
					return json({ room_id: roomId, entries: merged });
				}
			}

			// ─── Self-delete a message ──────────────────────────────
			// POST /api/rooms/:roomId/messages/:eventId/delete
			// Lets the caller redact a message they sent, OR a bot's
			// message if they own that bot.  Anything else (someone
			// else's message, a bot they don't own) is 403.
			//
			// The actual redaction is performed by Synapse under the
			// authorizing token — caller's bearer for self, the bot's
			// stored token for bot-owner — so the redaction event is
			// signed by the entity that's allowed to do it.  We never
			// elevate via the appservice as_token here; that would let
			// us redact anything in the room and bypass the room's PL
			// model entirely.
			//
			// On success we write a `self_deletions` row so the room
			// mod log can show "@alice deleted a message" — content
			// stays gone (Matrix's redaction handles that), but the
			// fact a deletion happened stays auditable forever.
			{
				const m = path.match(/^\/api\/rooms\/([^/]+)\/messages\/([^/]+)\/delete$/);
				if (req.method === "POST" && m) {
					const token = extractToken(req);
					const userId = await whoami(token);
					if (!userId || !token) {
						return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
					}
					const roomId = decodeURIComponent(m[1]!);
					const eventId = decodeURIComponent(m[2]!);

					// Resolve the event's sender.  Local-first lookup
					// against the engine's own posts table — the engine
					// indexes every m.room.message it observes via
					// /transactions, so this is the canonical authority
					// for "who sent this" without round-tripping to
					// Synapse.
					//
					// Why not just ask Synapse: /rooms/{id}/event/{id}
					// requires the caller (the engine bot, via the
					// appservice as_token) to be a member of the room.
					// The appservice's `regex .*` namespace makes
					// Synapse FORWARD events to /transactions but does
					// NOT auto-join the bot user, so most user-created
					// rooms aren't readable that way and every delete
					// attempt 404'd.  Posts are recorded eagerly the
					// moment the engine sees them, so the local table
					// is both faster and reliable for any room the
					// engine could observe (which is every non-encrypted
					// room on the homeserver).
					//
					// Fallback to Synapse only when the local table
					// has no row — events from before the engine
					// started indexing, manually-injected events, etc.
					// That fallback still requires bot membership and
					// will 404 the same way; it just lets us keep the
					// pre-existing code path for the rare case it
					// works.
					let senderId: string;
					const localSender = lookupPostUser(eventId);
					if (localSender) {
						senderId = localSender;
						// Type is implicitly m.room.message — the only
						// event kind we record into posts (handleMessage
						// in aggregate.ts skips state events).
					} else {
						const ev = await getEventSender(roomId, eventId);
						if (!ev) {
							return json({ errcode: "M_NOT_FOUND", error: "event not found" }, { status: 404 });
						}
						// Refuse to redact non-message events.  Reactions,
						// flags, redactions themselves all have their own
						// retract paths; routing them through the trash
						// button would let a user retract a flag they
						// didn't submit, etc.
						if (ev.type !== "m.room.message") {
							return json({
								errcode: "M_FORBIDDEN",
								error: "only m.room.message events can be deleted via this endpoint",
							}, { status: 403 });
						}
						senderId = ev.sender;
					}

					// Authorization branch.  `kind` distinguishes which
					// access token performs the redaction and goes into
					// the audit row.
					let kind: "self" | "bot_owner";
					let bearerForRedact: string;
					let botId: number | null = null;
					if (senderId === userId) {
						kind = "self";
						bearerForRedact = token;
					} else {
						const bot = getBotByMxid(senderId);
						if (!bot || bot.owner_id !== userId) {
							return json({
								errcode: "M_FORBIDDEN",
								error: "you can only delete your own messages or messages from bots you own",
							}, { status: 403 });
						}
						kind = "bot_owner";
						botId = bot.id;
						// Bot tokens are sealed at rest; decrypt only
						// long enough to authorize this one redaction.
						bearerForRedact = openSecret(bot.access_token_enc);
					}

					const ok = await redactEventAs({
						bearerToken: bearerForRedact,
						roomId,
						eventId,
						reason: kind === "self" ? "self_delete" : "bot_owner_delete",
					});
					if (!ok) {
						return json({ errcode: "M_UNKNOWN", error: "redaction failed" }, { status: 502 });
					}

					recordSelfDeletion({
						roomId,
						targetEventId: eventId,
						redactedBy: userId,
						targetSender: senderId,
						kind,
						botId,
					});
					return json({ ok: true, kind });
				}
			}

			// ─── Founder bot kick/ban ───────────────────────────────
			// POST /api/rooms/:roomId/bots/:botMxid/kick
			// POST /api/rooms/:roomId/bots/:botMxid/ban
			//
			// Carved out of the consensus model: bots aren't people,
			// so a misbehaving / spammy bot doesn't get the same
			// flag-and-vote protection humans do.  The room's
			// founder can silence one unilaterally.
			//
			// Authorization is double-gated:
			//   1. We resolve the room's m.room.create.creator and
			//      compare against the caller — only the founder
			//      passes.
			//   2. We resolve the target mxid against our `bots` table
			//      — only registered bots are eligible.  Humans (or
			//      federated bots from other instances) are rejected
			//      with 403 even if the founder calls this endpoint.
			// Synapse-side, the actual kick/ban is performed by the
			// founder's bearer token (PL 100 → kick/ban PL 100 → OK).
			// If the room's PL has been customised so the founder is
			// no longer creator-equivalent, Synapse rejects and we
			// return 502.
			{
				const m = path.match(/^\/api\/rooms\/([^/]+)\/bots\/([^/]+)\/(kick|ban)$/);
				if (req.method === "POST" && m) {
					const token = extractToken(req);
					const userId = await whoami(token);
					if (!userId || !token) {
						return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
					}
					const roomId = decodeURIComponent(m[1]!);
					const botMxid = decodeURIComponent(m[2]!);
					const action = m[3] as "kick" | "ban";

					const state = await getRoomNameAndCreator(roomId);
					if (!state || !state.creator) {
						return json({ errcode: "M_NOT_FOUND", error: "room not found" }, { status: 404 });
					}
					if (state.creator !== userId) {
						return json({
							errcode: "M_FORBIDDEN",
							error: "only the room founder can kick/ban bots",
						}, { status: 403 });
					}

					const bot = getBotByMxid(botMxid);
					if (!bot) {
						// Refuse on non-bot targets even from the
						// founder — humans go through the consensus
						// flag flow, full stop.
						return json({
							errcode: "M_FORBIDDEN",
							error: "target is not a bot on this instance",
						}, { status: 403 });
					}

					// Belt-and-suspenders: refuse when the founder is
					// also the bot's owner.  The SPA already hides the
					// kick/ban affordance for owned bots (see
					// ProfileSheet.isMyBot), but a tampered client
					// shouldn't be able to bypass that — banning your
					// own bot is incoherent (manage it from Settings →
					// Bots) and would just lock you out of your own
					// bot's room membership.
					if (bot.owner_id === userId) {
						return json({
							errcode: "M_FORBIDDEN",
							error: "you can't kick or ban a bot you own; manage it from Settings → Bots instead",
						}, { status: 403 });
					}

					const ok = await kickOrBanAs({
						bearerToken: token,
						roomId,
						targetUserId: botMxid,
						kind: action,
						reason: action === "kick"
							? "founder_kick_bot"
							: "founder_ban_bot",
					});
					if (!ok) {
						return json({ errcode: "M_UNKNOWN", error: `${action} failed` }, { status: 502 });
					}

					recordBotMembershipAction({
						roomId,
						botMxid,
						botOwner: bot.owner_id,
						action,
						founder: userId,
					});
					return json({ ok: true, action });
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

			// Admin-only debug: test the stored Giphy key by hitting
			// trending and returning the upstream status + body + the
			// URL it sent (with the api_key masked).  Lets the admin
			// see exactly what Giphy says without grepping engine logs.
			if (req.method === "GET" && path === "/api/instance/giphy-test") {
				const auth = await requireAdmin(req);
				if (auth instanceof Response) return auth;
				const apiKey = readInstanceConfig()["giphy_api_key"]?.trim();
				if (!apiKey) {
					return json({ ok: false, error: "no_key_configured" });
				}
				const upstream = new URL("https://api.giphy.com/v1/gifs/trending");
				upstream.searchParams.set("api_key", apiKey);
				upstream.searchParams.set("limit", "1");
				const masked = `${apiKey.slice(0, 4)}…${apiKey.slice(-4)} (length=${apiKey.length})`;
				try {
					const r = await fetch(upstream);
					const body = await r.text();
					return json({
						ok: r.ok,
						status: r.status,
						key_preview: masked,
						url: upstream.toString().replace(apiKey, "***"),
						upstream_body: body.slice(0, 1000),
					});
				} catch (err) {
					return json({
						ok: false,
						key_preview: masked,
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}

			// Admin-only: report which integrations are configured (by
			// presence of their credential, not its value).  The value
			// itself is never returned over the wire; the admin form
			// uses this to render "Configured / Not configured" badges
			// next to a write-only input.
			if (req.method === "GET" && path === "/api/instance/integrations") {
				const auth = await requireAdmin(req);
				if (auth instanceof Response) return auth;
				const cfg = readInstanceConfig();
				return json({
					integrations: {
						giphy: { configured: !!cfg["giphy_api_key"] },
					},
				});
			}

			// ─── Giphy proxy ─────────────────────────────────────────
			// Forwards search / trending requests to Giphy's API using
			// the instance-wide API key from instance_config.  Keeps
			// the key server-side (never sent to clients).  Returns
			// 503 when the key isn't configured so the SPA can hide
			// the GIF picker.  Auth: any logged-in user — Giphy
			// requests aren't free, so we gate on a valid Matrix
			// access token to avoid unauthenticated clients burning
			// the quota.
			if (req.method === "GET" && (path === "/api/giphy/search" || path === "/api/giphy/trending")) {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const apiKey = readInstanceConfig()["giphy_api_key"]?.trim();
				if (!apiKey) return json({ errcode: "M_NOT_FOUND", error: "giphy_not_configured" }, { status: 503 });
				const params = new URL(req.url).searchParams;
				// Clamp limit to Giphy's accepted range to keep
				// response sizes predictable.
				const limit = Math.max(1, Math.min(50, parseInt(params.get("limit") ?? "24", 10) || 24));
				// pg-13 by default — the brand-side Giphy default;
				// keeps the picker chat-appropriate without forcing
				// G-rated only.  Hardcoded for v1; could become an
				// instance setting later if anyone asks.
				const rating = "pg-13";
				const upstream = new URL(
					path === "/api/giphy/search"
						? "https://api.giphy.com/v1/gifs/search"
						: "https://api.giphy.com/v1/gifs/trending",
				);
				upstream.searchParams.set("api_key", apiKey);
				upstream.searchParams.set("limit", String(limit));
				upstream.searchParams.set("rating", rating);
				if (path === "/api/giphy/search") {
					const q = (params.get("q") ?? "").trim();
					if (!q) return json({ errcode: "M_INVALID_PARAM", error: "q required" }, { status: 400 });
					upstream.searchParams.set("q", q);
				}
				try {
					const r = await fetch(upstream);
					if (!r.ok) {
						// Forward Giphy's own message verbatim — when the
						// admin's seeing 401 it's almost always "wrong
						// key" or "SDK key in API slot," and Giphy's
						// reply spells that out.  Rendered in the
						// picker's error toast so the admin can act
						// without checking server logs.
						const detail = await r.text().catch(() => "");
						return json(
							{
								errcode: "M_UNKNOWN",
								error: `giphy_upstream_${r.status}`,
								detail: detail.slice(0, 500),
							},
							{ status: 502 },
						);
					}
					// Reshape Giphy's response down to the fields the
					// client actually uses.  Avoids leaking irrelevant
					// metadata and keeps the wire format stable if
					// Giphy reorganises their schema.
					const raw = await r.json() as {
						data?: Array<{
							id?: string;
							title?: string;
							images?: {
								fixed_width?: { url?: string; width?: string; height?: string };
								original?: { url?: string; mp4?: string; width?: string; height?: string };
								preview_gif?: { url?: string };
							};
						}>;
					};
					const results = (raw.data ?? []).flatMap(item => {
						const preview = item.images?.fixed_width?.url ?? item.images?.preview_gif?.url;
						const original = item.images?.original?.url;
						if (!item.id || !preview || !original) return [];
						return [{
							id: item.id,
							title: item.title ?? "",
							preview_url: preview,
							original_url: original,
							width: parseInt(item.images?.original?.width ?? "0", 10) || 0,
							height: parseInt(item.images?.original?.height ?? "0", 10) || 0,
						}];
					});
					return json({ results });
				} catch (err) {
					return json(
						{ errcode: "M_UNKNOWN", error: err instanceof Error ? err.message : String(err) },
						{ status: 502 },
					);
				}
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
				const newSpaceChildren: { spaceId: string; childId: string; sender: string }[] = [];
				for (const ev of events) {
					try {
						applyEvent(ev);
						if (ev.type === "chat.koven.flag.v1") sawFlag = true;
						// Capture m.space.child events with non-empty `via` for
						// the post-loop auto-join cascade.  We do the actual
						// joining outside the loop so the transaction response
						// goes back to Synapse without waiting on N admin/v1
						// /join round-trips.
						if (
							ev.type === "m.space.child" &&
							ev.room_id &&
							typeof ev.state_key === "string" && ev.state_key &&
							ev.sender &&
							Array.isArray((ev.content as { via?: unknown })?.via) &&
							((ev.content as { via?: unknown[] }).via ?? []).length > 0
						) {
							newSpaceChildren.push({
								spaceId: ev.room_id,
								childId: ev.state_key,
								sender: ev.sender,
							});
						}
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
				// Discord-style: when an admin links a room into a space
				// (whether by creating-in-space or by adding an existing
				// room), force-join every local member of the space to
				// the new child room.  This used to live only on the
				// linker's client, which meant federated members and
				// anyone whose client was offline silently missed the
				// auto-join.  Doing it engine-side means it works
				// regardless of who's connected — every server's engine
				// independently pulls its OWN local members in.
				//
				// Fired async after we respond to Synapse's transaction
				// so /transactions returns a 200 promptly even when the
				// space has dozens of members.
				if (newSpaceChildren.length > 0) {
					void (async () => {
						for (const { spaceId, childId, sender } of newSpaceChildren) {
							try {
								// Sub-spaces stay explicit opt-in, mirroring
								// the joinSpaceWithChildren rule on the
								// client.  An admin can still file a sub-
								// space under a parent space without
								// dragging every member into the sub-space.
								if (await isSpaceRoom(childId)) continue;
								const members = await getJoinedMembers(spaceId);
								const localSuffix = `:${config.homeserverName}`;
								for (const userId of members) {
									// Only act on local users — admin/v1/join
									// can't cross-federate.  Federated
									// members get auto-joined by their own
									// homeserver's engine processing the
									// same m.space.child event.
									if (!userId.endsWith(localSuffix)) continue;
									// The linker is already in the room
									// (they wrote the m.space.child),
									// adminJoinUserToRoom is idempotent so
									// this is a no-op anyway, but the
									// explicit skip saves a round-trip.
									if (userId === sender) continue;
									const result = await adminJoinUserToRoom(userId, childId);
									if ("error" in result) {
										// Log per-user failures but don't
										// abort — getting most members in is
										// better than rolling back any.
										console.warn(
											`engine: auto-join ${userId} → ${childId} failed:`,
											result.error,
											result.detail ?? "",
										);
									}
								}
							} catch (err) {
								console.error(
									`engine: auto-join cascade for child=${childId} parent=${spaceId} failed`,
									err,
								);
							}
						}
					})();
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

// HTTP surface of the engine.
//
//   PUT  /_matrix/app/v1/transactions/{txnId}    — Synapse pushes events
//   GET  /_matrix/app/v1/users/{userId}          — namespace ownership probe
//   GET  /_matrix/app/v1/rooms/{roomAlias}       — namespace ownership probe
//   GET  /api/instance                           — public instance config (login branding)
//   GET  /api/invite-preview/<target>            — public room/space preview (invite landing)
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
	countBotsByOwner,
	getFlagByEventId,
	listAllFlagsForReportQueue,
	recordInstanceAdminAction,
	type AdminReportRow,
	modActionsForRoom,
	recordModAction,
	setFlagReviewStatus,
	type ModAction,
	createBot,
	deleteAllNotifications,
	deletePushToken,
	upsertPushToken,
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
	flagsForRoom,
	flagsForTarget,
	getBotById,
	getBotByMxid,
	grantAdmin,
	insertFlag,
	isAdmin,
	issueAuthCode,
	listAdmins,
	listRoomNotifyLevels,
	setRoomNotifyLevel,
	setRoomNotifyLevelBulk,
	listAllBotMxids,
	listAllBotsPublic,
	listBotsByOwner,
	lookupUserByEmail,
	markAuthCodeUsed,
	markFlagRetracted,
	markRoomAsDm,
	purgeUserState,
	addBotMcpServer,
	updateBotMcpServer,
	listBotMcpServers,
	getBotMcpServerById,
	deleteBotMcpServer,
	readBio,
	readInstanceConfig,
	recordBotMembershipAction,
	recordSelfDeletion,
	revokeAdmin,
	selfDeletionsForRoom,
	setBotAvatarMxc,
	addBotKnowledge,
	listBotKnowledge,
	deleteBotKnowledge,
	totalBotKnowledgeBytes,
	insertBotWebhook,
	listBotWebhooks,
	getBotWebhookByToken,
	deleteBotWebhook,
	listBotWebhookDeliveries,
	insertBotOutboundWebhook,
	listBotOutboundWebhooks,
	getBotOutboundWebhookById,
	updateBotOutboundWebhook,
	deleteBotOutboundWebhook,
	type OutboundParam,
	type OutboundHeader,
	touchEmailLogin,
	updateBot,
	verifyAuthCode,
	writeBio,
	readSocialLinks,
	writeSocialLinks,
	readBanner,
	writeBanner,
	type SocialLink,
	writeInstanceConfig,
	claimFounderNumber,
	getFounderNumber,
	listFounders,
	FOUNDER_CAP_PUBLIC,
	rememberCallParticipant,
	forgetCallParticipantsByUserInRoom,
	readDiscoverable,
	writeDiscoverable,
	listDiscoverableUsers,
	countDiscoverableUsers,
	isPlatformBanned,
	insertPlatformBan,
	deletePlatformBan,
	listPlatformBans,
	getPlatformBan,
	type PlatformBanRow,
} from "./db";
import { deliverWebhook } from "./webhooks";
import {
	joinCall,
	applyWebhookEvent as applyCallWebhook,
	activeParticipantsFor,
	isConfigured as callsIsConfigured,
} from "./calls";
import {
	adminCreateUser,
	adminDeleteRoom,
	adminJoinUserToRoom,
	adminResetPassword,
	adminSetUserEmail,
	deactivateUser,
	kickUserFromAllRooms,
	lockUser,
	unlockUser,
	getEventSender,
	getJoinedMembers,
	getAllJoinedMembers,
	getRoomIconEmoji,
	getRoomJoinRule,
	getRoomKovenMeta,
	getRoomSeenBy,
	getRoomNsfw,
	getRoomNameAndCreator,
	getSpaceChildRoomIds,
	inviteUserToRoom,
	isSpaceRoom,
	resolveRoomAlias,
	getRoomInvitePreview,
	readPowerLevelForUser,
	kickOrBanAs,
	leaveRoomAs,
	joinRoomIfNeeded,
	listAllRooms,
	loginAsUser,
	pickStateContent,
	poolAll,
	readRoomState,
	registerAppserviceUser,
	repairRoomInvitePL,
	redactEventAs,
	setProfileAvatar,
	uploadMedia,
} from "./synapse";
import { openSecret, sealSecret } from "./secret_box";
import { sendLoginCodeEmail } from "./email";
import { extractToken, whoami } from "./auth";
import { extractKnowledgeText } from "./knowledge_extract";
import { reconcileOne, startOne, stopOne } from "./bot_manager";
import { parseMcpConfig } from "./mcp/parse_config";
import { pinStdioPackageVersion } from "./mcp/version_pin";

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
		// Concurrency 8 to match the appservice-transaction cascades.
		// Default-space onboarding only fires once per new signup, so
		// the bound is mostly for consistency, but at scale (a default
		// space with 50 public rooms × N signups/sec) a Promise.all-
		// everything fan-out could spike Synapse load disproportionate
		// to the actual user-facing benefit.
		await poolAll(childIds, 8, async childId => {
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
		});
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
	"klipy_api_key",
	// Cloudflare Turnstile — site key is public (the login page must
	// embed it to render the widget); secret key is the
	// server-side credential used for siteverify.  Only the secret
	// is in SENSITIVE_CONFIG_KEYS below.
	"turnstile_site_key",
	"turnstile_secret_key",
]);

// Keys that hold credentials / secrets.  Stripped from the public
// GET /api/instance response — only the admin-only integrations
// endpoint reveals "configured: true|false" without exposing the
// value itself.  ALLOWED_CONFIG_KEYS may contain non-sensitive
// integration keys too; this set is purely about what's safe to
// return unauthenticated.
const SENSITIVE_CONFIG_KEYS = new Set([
	"klipy_api_key",
	"turnstile_secret_key",
]);

/** Validate a Cloudflare Turnstile token via siteverify.  Returns
 * true when Cloudflare confirms the token; false on any failure
 * (network error, bad token, expired, secret mismatch, etc.) so
 * callers can hard-fail uniformly without needing to branch on the
 * error category.  We also pass the client's IP when we can extract
 * it — Cloudflare uses it to weight challenge difficulty. */
async function verifyTurnstileToken(
	token: string,
	secret: string,
	req: Request,
): Promise<boolean> {
	try {
		const form = new URLSearchParams();
		form.set("secret", secret);
		form.set("response", token);
		// Best-effort client IP from the proxy headers nginx writes.
		// Cloudflare accepts the field as optional; missing it just
		// means the challenge weight is computed without that signal.
		const xff = req.headers.get("x-forwarded-for");
		const ip = xff?.split(",")[0]?.trim();
		if (ip) form.set("remoteip", ip);
		const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form,
		});
		if (!r.ok) return false;
		const data = (await r.json().catch(() => null)) as { success?: boolean } | null;
		return data?.success === true;
	} catch (err) {
		console.warn("turnstile: siteverify failed", err);
		return false;
	}
}

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
		// PATCH + DELETE are required by bot CRUD (bot edit form
		// sends PATCH /api/bots/:id, webhook delete sends DELETE
		// /api/bots/:id/webhooks/:wid).  Browsers reject the actual
		// request before sending if the preflight doesn't list the
		// method, manifesting as "Failed to fetch" with no useful
		// error in the network tab — confirmed via curl that this
		// list was the gate.
		"Access-Control-Allow-Methods": "GET, PUT, POST, PATCH, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Matrix-Token, X-Koven-Client",
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
 * Per-report visibility check used by the reports queue endpoints.
 *
 * Returns a Map keyed by flag event_id with a boolean: true means
 * the caller is allowed to see (and act on) that report.  Two paths
 * grant visibility:
 *
 *   - space-mod path: caller has PL ≥ 50 in the row's `room_id`
 *     (`m.room.power_levels.users[caller]`, falling back to
 *     `users_default` when not in the map).  This is the standard
 *     admin/moderator path — the people who own the space see the
 *     reports for content in their space.
 *
 *   - instance-floor backstop: caller is a server admin AND the
 *     report's category is `floor_violation`.  Lets the operator
 *     see floor reports from spaces they don't moderate, because
 *     they have legal responsibility for CSAM / credible threats /
 *     doxxing regardless of whether they're in that space's mod
 *     team.  Non-floor reports do NOT cross this boundary — the
 *     server admin is not a super-moderator.
 *
 * Implementation: collects unique reported room ids, fetches PL
 * state for each in parallel via `readRoomState`, then walks the
 * rows applying the two rules.  Room-state reads are batched so
 * one request for the list-all endpoint doesn't fan out to N
 * Synapse admin-API calls; for the count endpoint where N is
 * small in practice the cost is bounded.
 */
async function computeReportVisibility(
	rows: AdminReportRow[],
	callerId: string,
	isInstanceAdmin: boolean,
): Promise<Map<string, boolean>> {
	const visibility = new Map<string, boolean>();
	if (rows.length === 0) return visibility;

	// Collect unique room ids whose PL we need.  Skip rooms we've
	// already determined PL for via a previous row.
	const uniqueRoomIds = new Set<string>();
	for (const row of rows) uniqueRoomIds.add(row.room_id);

	// Parallel PL fetch.  `readRoomState` returns null when the room
	// can't be read (deleted, federated, etc.) — treat that as
	// "caller has no PL" so we err on the side of LESS visibility.
	const plByRoom = new Map<string, number>();
	await Promise.all(Array.from(uniqueRoomIds).map(async (roomId) => {
		const state = await readRoomState(roomId);
		if (!state) {
			plByRoom.set(roomId, 0);
			return;
		}
		const pl = pickStateContent(state, "m.room.power_levels", "") as {
			users?: Record<string, number>;
			users_default?: number;
		} | null;
		const defaultPl = typeof pl?.users_default === "number" ? pl.users_default : 0;
		const callerPl = typeof pl?.users?.[callerId] === "number"
			? pl.users[callerId]!
			: defaultPl;
		plByRoom.set(roomId, callerPl);
	}));

	for (const row of rows) {
		const callerPl = plByRoom.get(row.room_id) ?? 0;
		// Room/space-level reports route to server admin ONLY.  Rationale:
		// if a space admin is the offender (running an abusive room or
		// space), routing the report to them defeats the purpose.  The
		// platform operator is the escalation path of last resort for
		// "this whole room/space shouldn't exist."  Message-level reports
		// stay on the space-mod path because content moderation IS the
		// space's mods' job.
		const isRoomLevelReport = row.target_kind === "room";
		const spaceModPath = !isRoomLevelReport && callerPl >= 50;
		const floorBackstop = isInstanceAdmin && row.category === "floor_violation";
		const roomLevelEscalation = isRoomLevelReport && isInstanceAdmin;
		visibility.set(row.event_id, spaceModPath || floorBackstop || roomLevelEscalation);
	}
	return visibility;
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

/** JSON body parser used by the orphan-room admin endpoints + a few
 * others.  Returns `{}` on malformed bodies so callers can compare
 * fields without a separate try/catch.  Caller still needs to validate
 * the shape of what they pull out. */
async function readJson(req: Request): Promise<Record<string, unknown>> {
	try {
		return (await req.json()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * Find every group room on the homeserver that violates the
 * Discord-style invariant: no m.space.parent state event, not a
 * Matrix space itself (rooms with `type: m.space`), not a 1:1 DM.
 *
 * DM detection uses two signals because m.direct lives on user
 * account_data (not visible to the engine without a Matrix client per
 * user): (1) the room's m.room.create has `is_direct: true`, OR (2)
 * the room has exactly two joined members AND no name set.  Either
 * is a strong "this looks like a DM" signal; we err on the side of
 * NOT classifying as orphan to avoid nuking conversations.
 *
 * Returns one entry per orphan with the fields the operator needs to
 * eyeball the list before pulling the trigger.
 */
async function findOrphanRooms(): Promise<Array<{
	roomId: string;
	name: string | null;
	memberCount: number;
	creator: string | null;
	encryption: string | null;
	joinRule: string | null;
}>> {
	const all = await listAllRooms();
	const orphans: Array<{
		roomId: string;
		name: string | null;
		memberCount: number;
		creator: string | null;
		encryption: string | null;
		joinRule: string | null;
	}> = [];
	for (const r of all) {
		// Skip Matrix spaces themselves — the invariant is about the
		// rooms INSIDE spaces, not the spaces themselves.
		if (r.roomType === "m.space") continue;
		// Read the state once and use it for the orphan + DM checks.
		const state = await readRoomState(r.roomId);
		if (!state) continue; // unreadable; skip rather than risk a wrong delete
		// DM signal #1: m.room.create.is_direct.
		const create = pickStateContent(state, "m.room.create") as { is_direct?: boolean } | null;
		if (create?.is_direct === true) continue;
		// DM signal #2: two-member room with no name.  Catches DMs
		// created via legacy clients that didn't set is_direct.
		if (r.memberCount === 2 && (r.name === null || r.name === "")) continue;
		// Has m.space.parent → not an orphan.  Any non-empty parent
		// counts; the conditional handles state arrays with multiple
		// (legacy) parent events.
		const hasParent = state.some(ev =>
			ev.type === "m.space.parent" &&
			typeof ev.state_key === "string" &&
			ev.state_key.length > 0,
		);
		if (hasParent) continue;
		orphans.push({
			roomId: r.roomId,
			name: r.name,
			memberCount: r.memberCount,
			creator: r.creator,
			encryption: r.encryption,
			joinRule: r.joinRule,
		});
	}
	return orphans;
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
/** Coerce an unknown body field into a non-negative integer in
 * [0, max].  Anything else (negative, NaN, undefined, non-number)
 * collapses to 0, which our schema treats as "unlimited" for the
 * spending guardrails. */
function clampNonNegInt(v: unknown, max: number): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return 0;
	const n = Math.floor(v);
	if (n <= 0) return 0;
	return Math.min(n, max);
}

interface ParsedMcpServerBody {
	label?: string;
	url?: string;
	headers?: Record<string, string>;
}

/** Validate the body shape of POST/PATCH /api/bots/:id/mcp.  Either
 * yields the cleaned-up fields (only properties the caller actually
 * sent) or an error string for the M_INVALID_PARAM response.  We
 * deliberately don't fetch the URL here to validate it — connect-
 * time errors surface in the bot's logs, which is the right place
 * for "your URL is wrong" feedback. */
function parseMcpServerBody(
	body: { label?: unknown; url?: unknown; headers?: unknown },
	opts: { requireUrl: boolean },
): ParsedMcpServerBody | { error: string } {
	const out: ParsedMcpServerBody = {};
	if (body.label !== undefined) {
		if (typeof body.label !== "string") return { error: "label must be a string" };
		const v = body.label.trim();
		if (v.length > 100) return { error: "label too long (max 100 chars)" };
		out.label = v;
	}
	if (body.url !== undefined) {
		if (typeof body.url !== "string") return { error: "url must be a string" };
		const v = body.url.trim();
		if (v.length === 0) return { error: "url required" };
		if (v.length > 2_000) return { error: "url too long" };
		try { new URL(v); } catch { return { error: "url is not a valid URL" }; }
		out.url = v;
	} else if (opts.requireUrl) {
		return { error: "url required" };
	}
	if (body.headers !== undefined) {
		if (typeof body.headers !== "object" || body.headers === null || Array.isArray(body.headers)) {
			return { error: "headers must be a JSON object" };
		}
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
			if (typeof v !== "string") return { error: `header ${k} must be a string` };
			if (k.length === 0 || k.length > 200) return { error: "header name length out of range" };
			if (v.length > 4_000) return { error: `header ${k} value too long` };
			headers[k] = v;
		}
		out.headers = headers;
	}
	return out;
}

function isValidBotName(s: string): boolean {
	return s.length >= 1 && s.length <= 21 && /^[a-z0-9-]+$/.test(s) && !s.startsWith("-") && !s.endsWith("-");
}

interface ParsedOutboundWebhook {
	name: string;
	description: string;
	method: "GET" | "POST";
	url: string;
	params: OutboundParam[];
	headers: OutboundHeader[];
}

/** Validate + normalise the body of POST/PATCH /api/bots/:id/outbound-webhooks.
 * `allowPartial: true` (PATCH path) returns only the fields present
 * — caller passes that to updateBotOutboundWebhook which uses
 * COALESCE-on-NULL to leave the rest alone. */
function parseOutboundWebhookBody(
	body: {
		name?: unknown;
		description?: unknown;
		method?: unknown;
		url?: unknown;
		params?: unknown;
		headers?: unknown;
	} | null,
	opts: { allowPartial?: boolean } = {},
): ParsedOutboundWebhook | { error: string } {
	if (!body) return { error: "request body required" };
	const out: Partial<ParsedOutboundWebhook> = {};

	if (body.name !== undefined) {
		if (typeof body.name !== "string") return { error: "name must be a string" };
		const v = body.name.trim();
		if (v.length === 0) return { error: "name required" };
		if (v.length > 64) return { error: "name too long (max 64 chars)" };
		// OpenAI tool name regex: ^[a-zA-Z0-9_-]+$ — sanitiser in
		// outbound_webhooks.ts will normalise but reject obvious junk
		// here so the saved name matches what the LLM sees.
		if (!/^[a-zA-Z0-9_-]+$/.test(v)) {
			return { error: "name may only contain letters, digits, underscore, hyphen" };
		}
		out.name = v;
	} else if (!opts.allowPartial) {
		return { error: "name required" };
	}

	if (body.description !== undefined) {
		if (typeof body.description !== "string") return { error: "description must be a string" };
		out.description = body.description.trim().slice(0, 500);
	} else if (!opts.allowPartial) {
		out.description = "";
	}

	if (body.method !== undefined) {
		if (body.method !== "GET" && body.method !== "POST") {
			return { error: "method must be GET or POST" };
		}
		out.method = body.method;
	} else if (!opts.allowPartial) {
		out.method = "GET";
	}

	if (body.url !== undefined) {
		if (typeof body.url !== "string") return { error: "url must be a string" };
		const v = body.url.trim();
		if (v.length === 0) return { error: "url required" };
		if (v.length > 2_000) return { error: "url too long" };
		// Allow {placeholder} tokens — strip them before URL parse so
		// the validation accepts templates.
		const probe = v.replace(/\{[a-zA-Z0-9_]+\}/g, "x");
		try { new URL(probe); } catch { return { error: "url is not a valid URL" }; }
		out.url = v;
	} else if (!opts.allowPartial) {
		return { error: "url required" };
	}

	if (body.params !== undefined) {
		if (!Array.isArray(body.params)) return { error: "params must be an array" };
		const params: OutboundParam[] = [];
		for (const raw of body.params) {
			if (typeof raw !== "object" || raw === null) return { error: "params entries must be objects" };
			const p = raw as Record<string, unknown>;
			if (typeof p.name !== "string" || p.name.trim().length === 0) {
				return { error: "param name required" };
			}
			const pname = p.name.trim();
			if (pname.length > 64) return { error: "param name too long (max 64 chars)" };
			if (!/^[a-zA-Z0-9_]+$/.test(pname)) {
				return { error: "param name may only contain letters, digits, underscore" };
			}
			const desc = typeof p.description === "string" ? p.description.trim().slice(0, 200) : "";
			const inField: "url" | "body" = p.in === "body" ? "body" : "url";
			params.push({
				name: pname,
				description: desc,
				required: p.required === true,
				in: inField,
			});
		}
		out.params = params;
	} else if (!opts.allowPartial) {
		out.params = [];
	}

	if (body.headers !== undefined) {
		if (!Array.isArray(body.headers)) return { error: "headers must be an array" };
		const headers: OutboundHeader[] = [];
		for (const raw of body.headers) {
			if (typeof raw !== "object" || raw === null) return { error: "headers entries must be objects" };
			const h = raw as Record<string, unknown>;
			if (typeof h.name !== "string" || h.name.trim().length === 0) {
				return { error: "header name required" };
			}
			if (typeof h.value !== "string") return { error: "header value must be a string" };
			const hname = h.name.trim();
			if (hname.length > 200) return { error: "header name too long" };
			if (h.value.length > 4_000) return { error: "header value too long" };
			headers.push({ name: hname, value: h.value });
		}
		out.headers = headers;
	} else if (!opts.allowPartial) {
		out.headers = [];
	}

	// In allowPartial mode it's fine to have any subset of fields.
	// In full mode the explicit return-on-missing branches above
	// already covered the required ones.
	return out as ParsedOutboundWebhook;
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
		enabled: row.enabled === 1,
		created_at: row.created_at,
		// Spending guardrails — 0 means unlimited for all three.
		max_tokens_per_reply: row.max_tokens_per_reply,
		daily_token_limit: row.daily_token_limit,
		daily_call_limit: row.daily_call_limit,
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
		// Privacy gate — exposed as a boolean to the client even
		// though it lives as 0/1 on disk.  Default-true semantics so
		// pre-migration bots stay open to everyone unless the owner
		// flips it off in the edit form.
		accept_dms: row.accept_dms !== 0,
	};
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

/** URL-safe random token of `bytes` bytes, base64url-encoded.
 * Used for inbound-webhook capability tokens + their optional HMAC
 * secrets.  Same shape + same entropy guarantees as randomPassword
 * above; kept separate so the call sites are self-documenting
 * (passwords vs. webhook tokens have very different lifecycles). */
function randomToken(bytes: number): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return btoa(String.fromCharCode(...buf))
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

			// Health check — handy for `curl localhost:9000/healthz`.
			if (req.method === "GET" && path === "/healthz") {
				return json({ ok: true });
			}

			// ─── Instance config + branding ──────────────────────────
			// Public read — login screen needs this before the user is
			// authenticated, so no token check.
			if (req.method === "GET" && path === "/api/instance") {
				// Strips sensitive keys (e.g. klipy_api_key): this
				// endpoint is unauthenticated so the login screen can
				// load branding without a session.
				return json({ config: publicInstanceConfig() });
			}

			// ─── Invite preview (public) ─────────────────────────────
			// Returns enough metadata for the invite landing page to
			// show "You've been invited to <Space>" before the user has
			// an account.  No auth required; only surfaces public info
			// (name, topic, avatar, member count).
			if (req.method === "GET" && path.startsWith("/api/invite-preview/")) {
				const target = decodeURIComponent(path.slice("/api/invite-preview/".length));
				if (!target) return json({ error: "missing_target" }, { status: 400 });

				let roomId = target;
				if (target.startsWith("#")) {
					const resolved = await resolveRoomAlias(target);
					if (!resolved) return json({ error: "not_found" }, { status: 404 });
					roomId = resolved;
				}

				const preview = await getRoomInvitePreview(roomId);
				if (!preview) return json({ error: "not_found" }, { status: 404 });

				return json({
					room_id: preview.roomId,
					name: preview.name,
					topic: preview.topic,
					avatar_url: preview.avatarUrl,
					member_count: preview.memberCount,
					is_space: preview.isSpace,
				});
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
				const body = (await req.json().catch(() => ({}))) as {
					email?: string;
					turnstile_token?: string;
				};
				const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
				if (!isValidEmail(email)) {
					return json({ error: "invalid_email" }, { status: 400 });
				}
				// Cloudflare Turnstile bot-detection — only enforced
				// when the admin has set BOTH the public site key
				// (which the client uses to render the widget) and
				// the secret key (which we use here for siteverify).
				// When unset, the auth flow runs unchanged so smaller
				// installs that don't want bot protection don't have
				// to do anything.
				//
				// Bypass for the desktop shell: the WebView serves the
				// SPA from `tauri://localhost` / `tauri.localhost`, an
				// origin Cloudflare's site-key validation rejects.  The
				// desktop + iOS clients set `X-Koven-Client: desktop`
				// or `X-Koven-Client: ios` so we can skip the captcha
				// gate without wiring up per-origin Cloudflare configs.
				// Threat-model trade-off: a bot can spoof the header
				// to bypass captcha here, but the email rate-limit +
				// send-failure paths still apply, and bots overwhelmingly
				// target the public web (where this header isn't set).
				const cfg = readInstanceConfig();
				const turnstileSecret = cfg["turnstile_secret_key"]?.trim();
				const turnstileSite = cfg["turnstile_site_key"]?.trim();
				const clientHeader = req.headers.get("x-koven-client") ?? "";
				const isTrustedClient = clientHeader === "desktop" || clientHeader === "ios";
				if (turnstileSecret && turnstileSite && !isTrustedClient) {
					const token = typeof body.turnstile_token === "string"
						? body.turnstile_token.trim()
						: "";
					if (!token) {
						return json(
							{ error: "captcha_required", detail: "Turnstile token missing." },
							{ status: 403 },
						);
					}
					const verifyOk = await verifyTurnstileToken(token, turnstileSecret, req);
					if (!verifyOk) {
						return json(
							{ error: "captcha_failed", detail: "Bot-detection challenge didn't pass — refresh and try again." },
							{ status: 403 },
						);
					}
				}
				// Apple review account: skip sending a real code.
				if (email === "christomatt.89+apple@gmail.com") {
					const isNew = lookupUserByEmail(email) === null;
					return json({ ok: true, is_new_account: isNew });
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

				// Apple review account: accept fixed code "000000".
				const isAppleReview = email === "christomatt.89+apple@gmail.com" && code === "000000";
				const verify = isAppleReview ? null : verifyAuthCode(email, code);
				if (verify && "error" in verify) {
					return json({ error: verify.error }, { status: 401 });
				}
				// Code is valid but NOT yet consumed; we'll mark it used
				// at the very end of this handler so any retryable
				// failure mid-flow (taken username, etc.) leaves the
				// code valid for another attempt.
				const codeId = verify?.codeId ?? null;

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

					// Claim the next Founder slot if any are still
					// available.  Idempotent + non-blocking: returns
					// null past slot 666 (silently no-op'd), and the
					// signup never depends on the result — the badge
					// is decoration, not auth.
					try {
						const n = claimFounderNumber(candidateMxid);
						if (n !== null) {
							console.log(`engine: claimed Founder #${n} for ${candidateMxid}`);
						}
					} catch (err) {
						console.warn(`engine: claimFounderNumber for ${candidateMxid} threw`, err);
					}

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

				if (isPlatformBanned(userId)) {
					return json({
						error: "platform_banned",
						detail: "Your account has been suspended by an instance administrator.",
					}, { status: 403 });
				}

				// Everything succeeded.  Burn the code now so it can't
				// be replayed; up to this point any error returned
				// above left it valid for a retry.
				if (codeId) markAuthCodeUsed(codeId);
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
				// Admins are always allowed to publish.
				if (isAdmin(userId)) {
					return json({ allowed: true, reason: "admin" });
				}

				// Discord-style: no rate-limit on room or space creation.
				// Every room lives inside a space and never appears in
				// Explore directly — only spaces do.
				return json({ allowed: true });
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
			// user's bio + email binding.  Audit-trail rows (flags they
			// submitted, mod-log entries) are LEFT IN PLACE: those
			// describe community decisions and shouldn't disappear
			// just because the actor walked away.
			//
			// Refuses if the caller is the only admin: deactivating the
			// last admin would make moderation impossible.  The client
			// checks /api/instance/me's is_only_admin first, but we
			// re-check here so a stale client can't bypass.
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

			// POST /api/push/register { token, platform }
			// Register a device push token for the authed user.
			// Called by the client on login / app launch.
			if (req.method === "POST" && path === "/api/push/register") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const body = await req.json() as { token?: string; platform?: string };
				const token = body.token;
				const platform = body.platform;
				if (typeof token !== "string" || !token.trim()) {
					return json({ errcode: "M_BAD_JSON", error: "missing token" }, { status: 400 });
				}
				if (platform !== "ios" && platform !== "android" && platform !== "web") {
					return json({ errcode: "M_BAD_JSON", error: "platform must be ios, android, or web" }, { status: 400 });
				}
				upsertPushToken(userId, token.trim(), platform);
				return json({ ok: true });
			}

			// POST /api/push/unregister { token }
			// Remove a specific push token (sign-out on one device).
			if (req.method === "POST" && path === "/api/push/unregister") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const body = await req.json() as { token?: string };
				const token = body.token;
				if (typeof token !== "string" || !token.trim()) {
					return json({ errcode: "M_BAD_JSON", error: "missing token" }, { status: 400 });
				}
				deletePushToken(userId, token.trim());
				return json({ ok: true });
			}

			// POST /api/calls/:roomId/join
			// Mint a Cloudflare RealtimeKit participant token for the
			// caller to join the voice/video channel attached to
			// `roomId`.  Lazy-creates the underlying Meeting on first
			// use (cached forever after).  Each call returns a fresh
			// JWT — these are single-use per the RealtimeKit docs, so
			// the client should call this every time the user clicks
			// Join Voice (not cache it).
			//
			// Membership is enforced via Synapse's admin /members
			// list — only users currently joined to the room can hop
			// in.  Same access shape as Discord: if you can read the
			// room, you can speak in it.
			if (req.method === "POST" && /^\/api\/calls\/[^/]+\/join$/.test(path)) {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const roomId = decodeURIComponent(path.split("/")[3]!);
				if (!roomId.startsWith("!") || !roomId.includes(":")) {
					return json({ errcode: "M_INVALID_PARAM", error: "room_id required in path" }, { status: 400 });
				}
				if (!callsIsConfigured()) {
					return json({
						errcode: "M_NOT_CONFIGURED",
						error: "Cloudflare RealtimeKit credentials not set on this engine",
					}, { status: 503 });
				}
				// Membership check.  Synapse admin /members is the
				// single source of truth; matrix-js-sdk's local view
				// could be stale on a freshly-joined room.
				let members: string[] = [];
				try {
					members = await getJoinedMembers(roomId);
				} catch (err) {
					console.warn(`calls: getJoinedMembers(${roomId}) failed`, err);
					return json({ errcode: "M_UNKNOWN", error: "couldn't verify room membership" }, { status: 502 });
				}
				if (!members.includes(userId)) {
					return json({
						errcode: "M_FORBIDDEN",
						error: "not a member of this room",
					}, { status: 403 });
				}
				// Resolve the caller's display name + avatar from
				// Synapse so RealtimeKit shows the right identity in
				// its participant list (otherwise it'd label them by
				// their full mxid).
				let displayName = userId;
				let avatarUrl: string | undefined;
				try {
					const profileRes = await fetch(
						`${config.homeserverUrl}/_matrix/client/v3/profile/${encodeURIComponent(userId)}`,
					);
					if (profileRes.ok) {
						const p = await profileRes.json() as { displayname?: string; avatar_url?: string };
						if (typeof p.displayname === "string" && p.displayname.length > 0) {
							displayName = p.displayname;
						}
						if (typeof p.avatar_url === "string" && p.avatar_url.length > 0) {
							avatarUrl = p.avatar_url;
						}
					}
				} catch {
					// Best-effort: fall back to the mxid as the
					// participant name.  Avatar is optional anyway.
				}
				// Room name powers the SetupScreen meeting title in the
				// Cloudflare UI Kit.  Best-effort lookup — empty falls
				// back to the room id inside calls.joinCall.
				let roomName: string | undefined;
				try {
					const state = await getRoomNameAndCreator(roomId);
					if (state?.name) roomName = state.name;
				} catch {
					// Best-effort.  An unnamed room shows the mxid as
					// title, same as before.
				}
				try {
					const result = await joinCall({
						roomId,
						roomName,
						userId,
						displayName,
						avatarUrl,
					});
					return json({
						meeting_id: result.meetingId,
						auth_token: result.authToken,
						participant_id: result.participantId,
						preset_name: result.presetName,
					});
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					console.warn(`calls: joinCall(${roomId}, ${userId}) failed`, err);
					return json({
						errcode: "M_UNKNOWN",
						error: detail,
					}, { status: 502 });
				}
			}

			// GET /api/calls/:roomId/active
			// Returns the live participant list for a room's voice
			// channel — drives the social-signal indicator (avatars
			// next to the room in the sidebar + in the room voice
			// bar).  Same membership check as /join: only members
			// can see who's in voice.
			if (req.method === "GET" && /^\/api\/calls\/[^/]+\/active$/.test(path)) {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const roomId = decodeURIComponent(path.split("/")[3]!);
				if (!roomId.startsWith("!") || !roomId.includes(":")) {
					return json({ errcode: "M_INVALID_PARAM", error: "room_id required" }, { status: 400 });
				}
				let members: string[] = [];
				try {
					members = await getJoinedMembers(roomId);
				} catch (err) {
					console.warn(`calls /active: getJoinedMembers(${roomId}) failed`, err);
					return json({ errcode: "M_UNKNOWN", error: "couldn't verify membership" }, { status: 502 });
				}
				if (!members.includes(userId)) {
					return json({ errcode: "M_FORBIDDEN", error: "not a member" }, { status: 403 });
				}
				const rows = activeParticipantsFor(roomId);
				return json({
					participants: rows.map(r => ({
						user_id: r.user_id,
						display_name: r.display_name,
						avatar_url: r.avatar_url,
						joined_at: r.joined_at,
					})),
				});
			}

			// POST /api/dm/delete
			//
			// Server-side scorched-earth deletion of a DM.  Replaces
			// the previous client-side "paginate timeline + redact
			// every event + kick the other party" loop, which on a
			// DM that had a few past calls in it expanded to
			// 40+ events and 10+ minutes of throttled /redact calls.
			//
			// This endpoint calls Synapse's admin purge API directly,
			// which deletes EVERY event in the room server-side in
			// one transaction: messages, redactions, call signaling,
			// state, the lot.  For in-server DMs (both parties on the
			// same homeserver) the room is gone for both parties on
			// their next /sync.  For federated DMs, the local server's
			// copy is wiped and the other server retains its own
			// (Matrix-protocol limitation we can't beat).
			//
			// Validation:
			//   - Caller must be a joined member of the room.
			//   - Room must not be a space (no one accidentally nukes
			//     a community via this endpoint).
			//   - Room must have ≤ 2 joined members (DM shape, modulo
			//     the case where the other party already left).
			//
			// The kick + leave + forget the old client-side path did
			// are unnecessary once the purge runs: the admin API
			// `block: true, purge: true` body flips every membership
			// to leave server-side AND deletes the events, so client-
			// side cleanup is a local cache wipe only.
			{
				if (path === "/api/dm/delete" && req.method === "POST") {
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
					let body: { room_id?: unknown };
					try {
						body = (await req.json()) as { room_id?: unknown };
					} catch {
						return json({ errcode: "M_BAD_JSON", error: "expected JSON body" }, { status: 400 });
					}
					const roomId = typeof body.room_id === "string" ? body.room_id : "";
					if (!roomId.startsWith("!") || !roomId.includes(":")) {
						return json({ errcode: "M_INVALID_PARAM", error: "room_id required" }, { status: 400 });
					}
					// Refuse on spaces.  A DM is by definition not a
					// space; this is the cheapest validation against
					// "user passes a space id and tries to nuke their
					// whole community."
					try {
						if (await isSpaceRoom(roomId)) {
							return json({ errcode: "M_FORBIDDEN", error: "spaces cannot be deleted via this endpoint" }, { status: 403 });
						}
					} catch (err) {
						console.warn(`/api/dm/delete: isSpaceRoom(${roomId}) failed`, err);
						return json({ errcode: "M_UNKNOWN", error: "could not verify room type" }, { status: 502 });
					}
					// Membership gate.  Caller must be IN the room,
					// and the room must have at most 2 joined members
					// (DM shape).  Allowing > 2 would mean someone
					// could nuke any private group room they happen
					// to be in.
					let members: string[] = [];
					try {
						members = await getJoinedMembers(roomId);
					} catch (err) {
						console.warn(`/api/dm/delete: getJoinedMembers(${roomId}) failed`, err);
						return json({ errcode: "M_UNKNOWN", error: "could not verify membership" }, { status: 502 });
					}
					if (!members.includes(userId)) {
						return json({ errcode: "M_FORBIDDEN", error: "not a member of this room" }, { status: 403 });
					}
					if (members.length > 2) {
						return json({ errcode: "M_FORBIDDEN", error: "not a DM (more than 2 joined members)" }, { status: 403 });
					}
					const result = await adminDeleteRoom({
						roomId,
						message: "Conversation deleted by the other party.",
					});
					if ("error" in result) {
						return json({
							errcode: "M_UNKNOWN",
							error: result.error,
							detail: result.detail,
						}, { status: 502 });
					}
					return json({ ok: true });
				}
			}

			// POST /api/rooms/:roomId/delete
			//
			// User-gated hard delete for a single non-space room
			// (channel inside a space).  Mirrors /api/dm/delete but
			// authorises on power-level, not DM shape.  Caller must
			// hold PL ≥ 100 in the room — i.e. be the founder, or
			// have been explicitly promoted to admin by the founder.
			// PL 100 is the right gate because Koven's createRoom
			// always lands the creator at PL 100 (matrix.ts:2780)
			// with users_default 0 for everyone else, so this is the
			// universal "this person owns the room" check.
			//
			// Refuses spaces.  Space deletion has its own endpoint
			// because it needs to walk m.space.child and purge every
			// member of the tree, not just the one room — letting
			// a space pass through here would purge the space-room
			// only and leave its channels orphaned.
			//
			// Action: Synapse admin DELETE /v2/rooms/{id} with
			// block:true and purge:true.  Kicks every member server-
			// side, blocks future re-joins, removes the entire event
			// history from the database.  No matrix-js-sdk client
			// gymnastics required — the homeserver does it all in
			// one async background job.
			{
				const m = path.match(/^\/api\/rooms\/([^/]+)\/delete$/);
				if (req.method === "POST" && m) {
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
					const roomId = decodeURIComponent(m[1]!);
					if (!roomId.startsWith("!") || !roomId.includes(":")) {
						return json({ errcode: "M_INVALID_PARAM", error: "room_id required" }, { status: 400 });
					}
					// Spaces have their own endpoint — refuse here so a
					// stray call doesn't purge the space room and leave
					// its children dangling.
					try {
						if (await isSpaceRoom(roomId)) {
							return json({ errcode: "M_FORBIDDEN", error: "use /api/spaces/:spaceId/delete for spaces" }, { status: 403 });
						}
					} catch (err) {
						console.warn(`/api/rooms/${roomId}/delete: isSpaceRoom failed`, err);
						return json({ errcode: "M_UNKNOWN", error: "could not verify room type" }, { status: 502 });
					}
					// Caller must be in the room.  Without this check a
					// stranger could nuke any room id they happened to
					// learn (room ids aren't secret in Matrix).
					let members: string[] = [];
					try {
						members = await getJoinedMembers(roomId);
					} catch (err) {
						console.warn(`/api/rooms/${roomId}/delete: getJoinedMembers failed`, err);
						return json({ errcode: "M_UNKNOWN", error: "could not verify membership" }, { status: 502 });
					}
					if (!members.includes(userId)) {
						return json({ errcode: "M_FORBIDDEN", error: "not a member of this room" }, { status: 403 });
					}
					// Power-level gate.  Must be PL ≥ 100 (founder/admin)
					// to wield the nuke.  Anything else falls through to
					// "use the regular Leave action."
					let pl: number | null = null;
					try {
						pl = await readPowerLevelForUser(roomId, userId);
					} catch (err) {
						console.warn(`/api/rooms/${roomId}/delete: readPowerLevelForUser failed`, err);
						return json({ errcode: "M_UNKNOWN", error: "could not verify power level" }, { status: 502 });
					}
					if (pl === null) {
						return json({ errcode: "M_UNKNOWN", error: "could not read room state" }, { status: 502 });
					}
					if (pl < 100) {
						return json({ errcode: "M_FORBIDDEN", error: "must be room owner (PL 100) to delete" }, { status: 403 });
					}
					const result = await adminDeleteRoom({
						roomId,
						message: "Channel deleted by the room owner.",
					});
					if ("error" in result) {
						return json({
							errcode: "M_UNKNOWN",
							error: result.error,
							detail: result.detail,
						}, { status: 502 });
					}
					recordInstanceAdminAction({
						actor: userId,
						action: "delete_room_by_owner",
						target: roomId,
					});
					return json({ ok: true });
				}
			}

			// POST /api/spaces/:spaceId/delete
			//
			// User-gated hard delete for an entire space tree.  Walks
			// m.space.child state events on the space, purges every
			// child room via Synapse admin DELETE, then purges the
			// space room itself.  All atomic-per-room on the Synapse
			// side: block:true + purge:true wipes the event history
			// AND kicks all members in one server-side transaction.
			//
			// Authorisation: caller must hold PL ≥ 100 in the SPACE.
			// Koven's createSpace + createRoomInSpace land the
			// founder at PL 100 in both the space and its children
			// (matrix.ts:2780 and :2885-2909), so a space-level
			// founder check transitively covers every child.  The
			// admin token used by adminDeleteRoom bypasses room PL
			// anyway — what matters is whether the caller is
			// authorised to make the call in the first place.
			//
			// Best-effort children: a single failing child does not
			// abort the rest of the loop.  We collect failures in
			// the response so the client can surface them, but we
			// always proceed to delete the space room at the end —
			// getting MOST of the way through is better than rolling
			// back into a half-deleted state.
			{
				const m = path.match(/^\/api\/spaces\/([^/]+)\/delete$/);
				if (req.method === "POST" && m) {
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
					const spaceId = decodeURIComponent(m[1]!);
					if (!spaceId.startsWith("!") || !spaceId.includes(":")) {
						return json({ errcode: "M_INVALID_PARAM", error: "space_id required" }, { status: 400 });
					}
					// Confirm it really is a space.  Same reason as the
					// reverse check in /api/rooms/:roomId/delete: each
					// endpoint owns one shape and refuses the other so a
					// misrouted call can't do the wrong scope of damage.
					try {
						if (!(await isSpaceRoom(spaceId))) {
							return json({ errcode: "M_FORBIDDEN", error: "target is not a space" }, { status: 403 });
						}
					} catch (err) {
						console.warn(`/api/spaces/${spaceId}/delete: isSpaceRoom failed`, err);
						return json({ errcode: "M_UNKNOWN", error: "could not verify room type" }, { status: 502 });
					}
					// Must be a joined member of the space.
					let members: string[] = [];
					try {
						members = await getJoinedMembers(spaceId);
					} catch (err) {
						console.warn(`/api/spaces/${spaceId}/delete: getJoinedMembers failed`, err);
						return json({ errcode: "M_UNKNOWN", error: "could not verify membership" }, { status: 502 });
					}
					if (!members.includes(userId)) {
						return json({ errcode: "M_FORBIDDEN", error: "not a member of this space" }, { status: 403 });
					}
					// Power-level gate on the SPACE.  Founder transitively
					// owns the children (Koven's invariant), so we only
					// need to authorise once.
					let pl: number | null = null;
					try {
						pl = await readPowerLevelForUser(spaceId, userId);
					} catch (err) {
						console.warn(`/api/spaces/${spaceId}/delete: readPowerLevelForUser failed`, err);
						return json({ errcode: "M_UNKNOWN", error: "could not verify power level" }, { status: 502 });
					}
					if (pl === null) {
						return json({ errcode: "M_UNKNOWN", error: "could not read space state" }, { status: 502 });
					}
					if (pl < 100) {
						return json({ errcode: "M_FORBIDDEN", error: "must be space owner (PL 100) to delete" }, { status: 403 });
					}
					// Walk m.space.child to find the children.  Read
					// state BEFORE deleting anything — order matters:
					// children first, space last, so the space's child
					// references are still valid while we process them.
					// Skip child events with empty/missing `via` array,
					// those are "tombstoned" entries the space admin
					// already removed.
					const state = await readRoomState(spaceId);
					const childIds: string[] = [];
					if (state) {
						for (const ev of state) {
							if (ev.type !== "m.space.child") continue;
							const childId = ev.state_key;
							if (!childId) continue;
							const via = (ev.content as { via?: unknown })?.via;
							if (!Array.isArray(via) || via.length === 0) continue;
							childIds.push(childId);
						}
					}

					const failedChildren: Array<{ roomId: string; error: string }> = [];
					const deletedChildren: string[] = [];
					const childMessage = "Parent space deleted by the space owner.";
					for (const childId of childIds) {
						const res = await adminDeleteRoom({ roomId: childId, message: childMessage });
						if ("error" in res) {
							failedChildren.push({ roomId: childId, error: res.error });
						} else {
							deletedChildren.push(childId);
						}
					}
					const spaceRes = await adminDeleteRoom({
						roomId: spaceId,
						message: "Space deleted by the space owner.",
					});
					if ("error" in spaceRes) {
						// Children may have been purged already; surface
						// both halves of the result so the client knows
						// what actually got cleaned.
						return json({
							errcode: "M_UNKNOWN",
							error: spaceRes.error,
							detail: spaceRes.detail,
							deleted_children: deletedChildren,
							failed_children: failedChildren,
						}, { status: 502 });
					}
					recordInstanceAdminAction({
						actor: userId,
						action: "delete_space_by_owner",
						target: spaceId,
						reason: failedChildren.length > 0
							? `partial: ${failedChildren.length} child(ren) failed`
							: null,
					});
					return json({
						ok: true,
						deleted_children: deletedChildren,
						failed_children: failedChildren,
					});
				}
			}

			// POST /api/calls/:roomId/iam-here
			// POST /api/calls/:roomId/iam-gone
			//
			// Client-driven presence pings.  The Cloudflare webhook
			// (cf-webhook/:secret below) is still the primary signal,
			// but it has two failure modes worth defending against:
			//   - In dev the webhook is intentionally not registered
			//     (would clobber prod's), so the local engine never
			//     learns who joined.  Without these pings the dev
			//     bar would always show zero participants.
			//   - In prod, if a meeting was created on a different
			//     engine instance (or this engine's room_calls cache
			//     was wiped), the webhook arrives with an unknown
			//     meeting id and gets discarded.
			// The client fires iam-here in CallProvider's
			// `roomJoined` handler and iam-gone in `roomLeft`, so
			// the engine has a self-healing source of truth that
			// doesn't depend on the webhook.  Both endpoints are
			// idempotent — duplicate pings just refresh the
			// joined_at timestamp.  Auth is the user's normal
			// access token (membership-gated like /active above).
			{
				const m = path.match(/^\/api\/calls\/([^/]+)\/iam-(here|gone)$/);
				if (req.method === "POST" && m) {
					const roomId = decodeURIComponent(m[1]!);
					const verb = m[2]! as "here" | "gone";
					if (!roomId.startsWith("!") || !roomId.includes(":")) {
						return json({ errcode: "M_INVALID_PARAM", error: "room_id required in path" }, { status: 400 });
					}
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
					// Membership check.  We don't want randos pinging
					// "I'm in #general" to spoof the social signal.
					let members: string[] = [];
					try {
						members = await getJoinedMembers(roomId);
					} catch (err) {
						console.warn(`calls /iam-${verb}: getJoinedMembers(${roomId}) failed`, err);
						return json({ errcode: "M_UNKNOWN", error: "couldn't verify membership" }, { status: 502 });
					}
					if (!members.includes(userId)) {
						return json({ errcode: "M_FORBIDDEN", error: "not a member" }, { status: 403 });
					}
					if (verb === "gone") {
						forgetCallParticipantsByUserInRoom({ roomId, userId });
						return json({ ok: true });
					}
					// iam-here.  Resolve the user's display name +
					// avatar from Synapse so the social-signal stack
					// renders a real face, not the bare mxid.
					let displayName = userId;
					let avatarUrl: string | null = null;
					try {
						const profileRes = await fetch(
							`${config.homeserverUrl}/_matrix/client/v3/profile/${encodeURIComponent(userId)}`,
						);
						if (profileRes.ok) {
							const p = await profileRes.json() as { displayname?: string; avatar_url?: string };
							if (typeof p.displayname === "string" && p.displayname.length > 0) displayName = p.displayname;
							if (typeof p.avatar_url === "string" && p.avatar_url.length > 0) avatarUrl = p.avatar_url;
						}
					} catch {
						// Best-effort.  Keep the mxid + null avatar.
					}
					rememberCallParticipant({
						roomId,
						// Distinct namespace from real Cloudflare ids
						// so the read-side dedupe (GROUP BY user_id)
						// collapses both rows into one — and a real
						// webhook arriving later doesn't conflict
						// with our placeholder.
						cfParticipantId: `client:${userId}`,
						userId,
						displayName,
						avatarUrl,
					});
					return json({ ok: true });
				}
			}

			// POST /api/calls/cf-webhook/:secret
			// Cloudflare RealtimeKit webhook receiver.  Auth is the
			// long random `:secret` path segment matching
			// CF_REALTIME_WEBHOOK_SECRET — RealtimeKit doesn't ship
			// an HMAC signing scheme so URL secrecy is the auth.
			// Updates the engine's mirror of who's in voice from
			// participantJoined / participantLeft / meeting.ended
			// events.  Returns 200 quickly so RealtimeKit doesn't
			// retry-storm us.
			{
				const m = path.match(/^\/api\/calls\/cf-webhook\/([A-Za-z0-9_\-]+)$/);
				if (req.method === "POST" && m) {
					const presented = m[1]!;
					const expected = config.cfRealtimeWebhookSecret;
					if (!expected || presented !== expected) {
						// Same response shape as a no-route — don't
						// leak that the path partially matched.
						return new Response("not found", { status: 404, headers: corsHeaders() });
					}
					const body = await req.json().catch(() => null);
					if (!body || typeof body !== "object") {
						return json({ errcode: "M_BAD_JSON" }, { status: 400 });
					}
					try {
						applyCallWebhook(body as Parameters<typeof applyCallWebhook>[0]);
					} catch (err) {
						console.warn("calls webhook: handler threw", err);
						// Still ack — Cloudflare retries on non-2xx;
						// we'd rather lose one event than retry-storm.
					}
					return json({ ok: true });
				}
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
			// Vestigial endpoint kept alive so older client builds
			// don't break.  Returns `allowed: true` unconditionally.
			// Safe to delete once every shipped client is past the
			// cutover.
			if (req.method === "GET" && path === "/api/me/publish-quota") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				return json({ allowed: true });
			}

			// GET /api/bots/all-mxids
			// Public read.  Two arrays:
			//   - bots: every enabled bot's mxid.  Drives the BOT
			//     badge next to usernames, plus any "is this a bot"
			//     check the SPA needs.
			//   - services: non-bot service identities the instance
			//     runs (the engine appservice user, the Synapse
			//     admin user used for /_synapse/admin/v* calls).
			//     The SPA filters these out of the "seen by" stack +
			//     member counts so they don't appear as participants
			//     who happen to read everything (which they do, but
			//     it's a noisy signal users don't want).  Returned
			//     alongside bots in one fetch so the SPA only has to
			//     poll one endpoint to keep both rosters current.
			//
			// Both lists are stable across the instance lifetime
			// (bots change with user CRUD; services come from env),
			// so the 5-minute client poll is plenty.
			if (req.method === "GET" && path === "/api/bots/all-mxids") {
				const services: string[] = [];
				if (config.engineUserId) services.push(config.engineUserId);
				if (config.synapseAdminUser) {
					// synapseAdminUser is stored as a bare localpart
					// in some setups, full mxid in others.  Normalise
					// to the @user:server form before returning.
					const raw = config.synapseAdminUser.trim();
					const mxid = raw.startsWith("@")
						? raw
						: `@${raw}:${config.homeserverName}`;
					if (!services.includes(mxid)) services.push(mxid);
				}
				return json({ bots: listAllBotMxids(), services });
			}

			// POST /api/webhooks/in/:token
			// Unauthenticated inbound webhook endpoint.  The token IS
			// the auth (it's a 32-byte URL-safe random); optional HMAC
			// further locks it down for sources that support signing
			// (X-Hub-Signature-256, GitHub-compat).  See engine/src/
			// webhooks.ts for the delivery pipeline.  Always returns
			// quickly so the source's retry policy doesn't hammer us.
			//
			// Status mapping:
			//   200 — delivered to the room
			//   401 — HMAC signature invalid
			//   404 — unknown token
			//   413 — body > 1MB
			//   503 — bot not currently running OR matrix post failed
			//         (caller may retry)
			{
				const m = path.match(/^\/api\/webhooks\/in\/([A-Za-z0-9_\-]+)$/);
				// Friendly probe for browsers + uptime checks.  Pasting
				// the webhook URL into the address bar is the most
				// natural way to verify "is this URL real" — without
				// this branch a GET falls through every handler and
				// hits the appservice gate, which returns
				// {"errcode":"M_FORBIDDEN","error":"bad token"}.  Looks
				// like a setup error when it's actually just wrong
				// method.  HEAD covers uptime probes.
				if ((req.method === "GET" || req.method === "HEAD") && m) {
					const hook = getBotWebhookByToken(m[1]!);
					if (!hook) {
						return json({ errcode: "M_NOT_FOUND", error: "unknown webhook token" }, { status: 404 });
					}
					if (req.method === "HEAD") {
						return new Response(null, { status: 200, headers: corsHeaders() });
					}
					return json({
						ok: true,
						endpoint: "koven inbound webhook",
						webhook: hook.label || "(unlabeled)",
						accepts: [
							"application/json — generic + GitHub events",
							"application/x-www-form-urlencoded — Twilio inbound SMS, generic forms",
						],
						signing: {
							github: "X-Hub-Signature-256: sha256=<hex HMAC-SHA256>",
							twilio: "X-Twilio-Signature: <base64 HMAC-SHA1 of URL+sorted params> (use Twilio Auth Token as the secret)",
							none: "leave the webhook's signing secret blank to accept unsigned requests",
						},
						hint: "POST your payload to this URL. The source is auto-detected by signature header or payload shape. Twilio receives an empty TwiML <Response/> reply.",
					});
				}
				if (req.method === "POST" && m) {
					const token = m[1]!;
					const hook = getBotWebhookByToken(token);
					if (!hook) {
						return json({ errcode: "M_NOT_FOUND", error: "unknown webhook token" }, { status: 404 });
					}
					// Read raw body once.  Need it as a string for both
					// signature verification (over exact bytes the source
					// signed) and for parsing in the formatter.
					const rawBody = await req.text();
					if (rawBody.length > 1_000_000) {
						return json({ errcode: "M_TOO_LARGE", error: "body > 1MB" }, { status: 413 });
					}
					// Reconstruct the public URL the source posted to
					// (Twilio's signature canonicalisation needs this).
					// Trust the X-Forwarded-* headers from our own reverse
					// proxy (Caddy) — engine isn't directly internet-
					// facing, so these are not user-controllable here.
					const xfProto = req.headers.get("x-forwarded-proto");
					const xfHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
					const reqUrlObj = new URL(req.url);
					const requestUrl = xfHost
						? `${xfProto ?? "https"}://${xfHost}${reqUrlObj.pathname}${reqUrlObj.search}`
						: req.url;
					const result = await deliverWebhook({
						webhook: hook,
						headers: req.headers,
						rawBody,
						requestUrl,
					});
					switch (result.status) {
						case "ok":
							// Source-specific reply (Twilio wants TwiML
							// XML, not JSON) overrides the default
							// {ok:true} when present.
							if (result.reply) {
								return new Response(result.reply.body, {
									status: 200,
									headers: { ...corsHeaders(), "Content-Type": result.reply.contentType },
								});
							}
							return json({ ok: true });
						case "hmac_invalid":
							return json({ errcode: "M_FORBIDDEN", error: "invalid signature" }, { status: 401 });
						case "bot_not_running":
							return json({ errcode: "M_UNAVAILABLE", error: "bot offline" }, { status: 503 });
						case "post_failed":
							return json({ errcode: "M_UNKNOWN", error: result.detail }, { status: 503 });
					}
				}
			}

			// GET /api/bots/directory
			// Public read.  Richer roster (mxid + display_name + avatar)
			// for the invite picker, which needs to surface bots BEFORE
			// they've joined a room — Synapse's user_directory only
			// indexes users that share a public room, so a freshly-
			// created bot is invisible to the directory search.  We
			// fill the gap from our own bot table.
			if (req.method === "GET" && path === "/api/bots/directory") {
				return json({ bots: listAllBotsPublic() });
			}

			// GET /api/bots/by-mxid/:mxid
			// Public read.  Returns the public-safe slice of a bot row
			// keyed by Matrix id.  Used by the profile sheet's "Created
			// by" row — when any user taps a bot's avatar, the sheet
			// fetches the bot here to discover its owner_id, then
			// resolves the owner's Matrix profile (display name + avatar)
			// for the credit line.  No authed scope: bot owner identity
			// is intentionally public, the same way a Discord bot's
			// developer is named on its profile card.
			//
			// Strictly limited fields: mxid + display_name + avatar_mxc
			// + owner_id + bio + created_at.  Secrets (encrypted API
			// key, Synapse access token), provider config, usage stats,
			// and spending guardrails all stay private to the owner's
			// own /api/bots/me view.
			if (req.method === "GET" && path.startsWith("/api/bots/by-mxid/")) {
				const mxid = decodeURIComponent(path.slice("/api/bots/by-mxid/".length));
				if (!mxid.startsWith("@")) {
					return json({ error: "bad_mxid" }, { status: 400 });
				}
				const row = getBotByMxid(mxid);
				if (!row) return json({ error: "not_found" }, { status: 404 });
				return json({
					bot: {
						mxid: row.mxid,
						owner_id: row.owner_id,
						display_name: row.display_name,
						avatar_mxc: row.avatar_mxc,
						bio: readBio(row.mxid) ?? "",
						created_at: row.created_at,
						// Surface accept_dms publicly so the profile
						// sheet can hide the Message button when the
						// bot's owner has DMs disabled — without this
						// the user clicks Message, a DM room gets
						// created, the bot auto-leaves on invite, and
						// they're sitting in an empty room with no
						// indication of why.  accept_dms is policy
						// metadata, not a secret.
						accept_dms: row.accept_dms === 1,
					},
				});
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
				// Spending guardrails.  All three default to 0 = unlimited.
				// Negative or non-finite values fall back to 0; we cap at
				// generous-but-finite ceilings so a misclick can't set a
				// "100 trillion tokens" budget.
				const maxTokensPerReply = clampNonNegInt(body.max_tokens_per_reply, 1_000_000);
				const dailyTokenLimit   = clampNonNegInt(body.daily_token_limit, 1_000_000_000);
				const dailyCallLimit    = clampNonNegInt(body.daily_call_limit, 1_000_000);
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

				// Provision the Matrix user via the appservice register
				// endpoint.  The admin /_synapse/admin/v2/users path
				// can't be used here — Synapse refuses creates inside an
				// appservice's exclusive namespace with M_EXCLUSIVE
				// (which is what the @bot-* range is, see
				// koven-engine.appservice.yaml).  The AS-register call
				// returns access_token + device_id directly, so we
				// don't need a separate password-login round-trip.
				const localpart = mxid.slice(1, mxid.indexOf(":")); // "bot-jeeves"
				const token = await registerAppserviceUser({
					username: localpart,
					displayname: displayName,
				});
				if ("error" in token) {
					return json({
						error: "synapse_create_failed",
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
					max_tokens_per_reply: maxTokensPerReply,
					daily_token_limit: dailyTokenLimit,
					daily_call_limit: dailyCallLimit,
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
					// Spending guardrails — explicitly coerce 0 = unlimited.
					// Only applied when the client actually sent the field
					// (Number.isFinite covers undefined / non-number).
					if (Number.isFinite(body.max_tokens_per_reply)) {
						patch.max_tokens_per_reply = clampNonNegInt(body.max_tokens_per_reply, 1_000_000);
					}
					if (Number.isFinite(body.daily_token_limit)) {
						patch.daily_token_limit = clampNonNegInt(body.daily_token_limit, 1_000_000_000);
					}
					if (Number.isFinite(body.daily_call_limit)) {
						patch.daily_call_limit = clampNonNegInt(body.daily_call_limit, 1_000_000);
					}
					// accept_dms toggle — boolean from the client maps to
					// 0/1 on disk.  Default-true stays true unless the
					// client explicitly sends `false`; sending the field
					// at all (true or false) is what triggers the write.
					if (typeof body.accept_dms === "boolean") {
						patch.accept_dms = body.accept_dms ? 1 : 0;
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

					// 2. Deactivate the bot's Synapse account.  `erase: true`
					//    is the same posture as a human account delete:
					//    Synapse invalidates every access token, kicks
					//    the bot from every room, wipes the profile
					//    (display name + avatar), marks the user as
					//    GDPR-erased so future lookups read as "does
					//    not exist," AND emits redactions for past
					//    messages on a best-effort basis.  Anything
					//    less is half-deletion: a deactivated-but-not-
					//    erased bot leaves its message history pinned
					//    forever, which is what a user who clicks
					//    Delete is trying to NOT do.  Logged-but-non-
					//    fatal on Synapse error so a transient admin-
					//    API hiccup doesn't strand the engine row.
					const deactivated = await deactivateUser(existing.mxid, true);
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

			// GET    /api/bots/:id/webhooks                — list
			// POST   /api/bots/:id/webhooks                — create
			// DELETE /api/bots/:id/webhooks/:wid           — delete
			// GET    /api/bots/:id/webhooks/:wid/deliveries — debug log
			//
			// Inbound-webhook CRUD for bot owners.  Each webhook is a
			// unique URL the owner pastes into an external service
			// (GitHub, Stripe, Linear, n8n, etc.).  Inbound POSTs to
			// the unauthenticated /api/webhooks/in/:token endpoint
			// (above) look up the row, format the payload, and post
			// it via the bot's matrix client into the configured room.
			// Optional HMAC secret locks the URL down so a leaked
			// token alone isn't enough to post.
			//
			// On create we generate the token + (optional) secret and
			// return them ONCE.  The secret is stored hashed-not so
			// the owner has to copy it immediately or regenerate the
			// webhook to get a new one.  (Future improvement: hash
			// the secret with bcrypt and verify against the hash.
			// For v1 we store plaintext to keep HMAC verification
			// path simple.)
			{
				const m = path.match(/^\/api\/bots\/(\d+)\/webhooks(?:\/(\d+)(?:\/(deliveries))?)?$/);
				if (m) {
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN" }, { status: 401 });
					const id = Number(m[1]);
					const wid = m[2] ? Number(m[2]) : null;
					const sub = m[3] ?? null;
					const existing = getBotById(id);
					if (!existing) return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
					if (existing.owner_id !== userId) {
						return json({ errcode: "M_FORBIDDEN", error: "not your bot" }, { status: 403 });
					}

					// GET /api/bots/:id/webhooks
					if (req.method === "GET" && wid === null) {
						// Strip secret_hmac from the response — it's
						// shown ONCE on create and after that the bot
						// owner shouldn't be able to read it back.
						// (They can always delete + recreate to roll.)
						const rows = listBotWebhooks(id).map(r => ({
							id: r.id,
							bot_id: r.bot_id,
							token: r.token,
							has_secret: !!r.secret_hmac,
							target_room_id: r.target_room_id,
							label: r.label,
							created_at: r.created_at,
							last_delivery: r.last_delivery,
							last_error: r.last_error,
						}));
						return json({ webhooks: rows });
					}

					// POST /api/bots/:id/webhooks
					//   { target_room_id, label,
					//     generate_secret?: boolean,
					//     secret?: string  /* user-supplied — Twilio Auth
					//                         Token, etc.  Wins over
					//                         generate_secret if both set. */ }
					if (req.method === "POST" && wid === null) {
						const body = (await req.json().catch(() => null)) as
							| { target_room_id?: unknown; label?: unknown; generate_secret?: unknown; secret?: unknown }
							| null;
						const targetRoomId = typeof body?.target_room_id === "string" ? body.target_room_id.trim() : "";
						const label = typeof body?.label === "string" ? body.label.trim().slice(0, 80) : "";
						const generateSecret = body?.generate_secret === true;
						const providedSecret = typeof body?.secret === "string" ? body.secret.trim() : "";
						if (!targetRoomId.startsWith("!")) {
							return json({
								errcode: "M_INVALID_PARAM",
								error: "target_room_id must start with !",
							}, { status: 400 });
						}
						if (providedSecret && providedSecret.length > 512) {
							return json({
								errcode: "M_INVALID_PARAM",
								error: "secret must be ≤ 512 chars",
							}, { status: 400 });
						}
						// Pull the bot into the target room BEFORE inserting
						// the webhook row.  Without this the webhook
						// would be created in a state where its first
						// inbound POST fails with "bot not in room",
						// because picking a room from the dropdown
						// doesn't auto-invite the bot — the dropdown
						// just lists the OWNER's rooms.  Owner has
						// invite power on their own rooms; bot's
						// runtime auto-joins owner-issued invites
						// (see bot_runtime.ts membership handler).
						// inviteUserToRoom is idempotent — it treats
						// "already in the room" / "already invited"
						// as success.
						const accessToken = extractToken(req);
						if (accessToken) {
							const inviteResult = await inviteUserToRoom({
								accessToken,
								roomId: targetRoomId,
								userId: existing.mxid,
							});
							if ("error" in inviteResult) {
								return json({
									errcode: "M_FORBIDDEN",
									error: `couldn't invite bot to room: ${inviteResult.detail ?? inviteResult.error}`,
								}, { status: 400 });
							}
						}

						// 32 bytes URL-safe base64 → ~43 chars.  Plenty
						// of entropy for a capability token (~256 bits).
						const token = randomToken(32);
						// Resolve the secret: user-provided wins (Twilio
						// Auth Token, etc.), then generate-on-server if
						// requested, else none (open webhook).
						const secret = providedSecret
							? providedSecret
							: generateSecret
								? randomToken(32)
								: null;
						const created = insertBotWebhook({
							botId: id,
							token,
							secretHmac: secret,
							targetRoomId,
							label,
						});
						// Echo the secret back to the caller ONLY when
						// we generated it ourselves — that's the only
						// case where the user needs to see it (to paste
						// into the source service).  For user-provided
						// secrets, the user already has the value and
						// re-displaying it is confusing UX (the banner
						// would tell them to "copy this now" for a
						// secret they pasted in 5 seconds ago).
						return json({
							ok: true,
							webhook: {
								id: created.id,
								bot_id: created.bot_id,
								token: created.token,
								secret: providedSecret ? null : secret,
								target_room_id: created.target_room_id,
								label: created.label,
								created_at: created.created_at,
							},
						});
					}

					// DELETE /api/bots/:id/webhooks/:wid
					if (req.method === "DELETE" && wid !== null && sub === null) {
						const removed = deleteBotWebhook(wid, id);
						if (removed === 0) return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
						return json({ ok: true });
					}

					// GET /api/bots/:id/webhooks/:wid/deliveries
					if (req.method === "GET" && wid !== null && sub === "deliveries") {
						const rows = listBotWebhookDeliveries(wid, 50);
						return json({ deliveries: rows });
					}
				}
			}

			// GET    /api/bots/:id/outbound-webhooks         — list
			// POST   /api/bots/:id/outbound-webhooks         — create
			// PATCH  /api/bots/:id/outbound-webhooks/:wid    — update
			// DELETE /api/bots/:id/outbound-webhooks/:wid    — delete
			//
			// LLM-callable HTTP tools.  Each row registers as an OpenAI
			// tool definition in the bot's chatCompletion call (see
			// engine/src/outbound_webhooks.ts).  When the model invokes
			// one, the engine builds the HTTP request from the row's
			// template + the model's args, fires it, and returns the
			// response body to the LLM as a tool result.
			{
				const m = path.match(/^\/api\/bots\/(\d+)\/outbound-webhooks(?:\/(\d+))?$/);
				if (m) {
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN" }, { status: 401 });
					const id = Number(m[1]);
					const wid = m[2] ? Number(m[2]) : null;
					const existing = getBotById(id);
					if (!existing) return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
					if (existing.owner_id !== userId) {
						return json({ errcode: "M_FORBIDDEN", error: "not your bot" }, { status: 403 });
					}

					if (req.method === "GET" && wid === null) {
						return json({ outbound_webhooks: listBotOutboundWebhooks(id) });
					}

					if (req.method === "POST" && wid === null) {
						const body = (await req.json().catch(() => null)) as
							| {
								name?: unknown;
								description?: unknown;
								method?: unknown;
								url?: unknown;
								params?: unknown;
								headers?: unknown;
							}
							| null;
						const parsed = parseOutboundWebhookBody(body);
						if ("error" in parsed) return json({ errcode: "M_INVALID_PARAM", error: parsed.error }, { status: 400 });
						const created = insertBotOutboundWebhook({
							botId: id,
							name: parsed.name,
							description: parsed.description,
							method: parsed.method,
							url: parsed.url,
							params: parsed.params,
							headers: parsed.headers,
						});
						return json({ outbound_webhook: created });
					}

					if (req.method === "PATCH" && wid !== null) {
						const existing = getBotOutboundWebhookById(wid, id);
						if (!existing) return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
						const body = (await req.json().catch(() => null)) as
							| {
								name?: unknown;
								description?: unknown;
								method?: unknown;
								url?: unknown;
								params?: unknown;
								headers?: unknown;
							}
							| null;
						const parsed = parseOutboundWebhookBody(body, { allowPartial: true });
						if ("error" in parsed) return json({ errcode: "M_INVALID_PARAM", error: parsed.error }, { status: 400 });
						updateBotOutboundWebhook(wid, id, parsed);
						return json({ outbound_webhook: getBotOutboundWebhookById(wid, id) });
					}

					if (req.method === "DELETE" && wid !== null) {
						const removed = deleteBotOutboundWebhook(wid, id);
						if (removed === 0) return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
						return json({ ok: true });
					}
				}
			}

			// GET    /api/bots/:id/mcp           — list attached MCP servers
			// POST   /api/bots/:id/mcp           — attach an MCP server (URL + headers)
			// PATCH  /api/bots/:id/mcp/:mcpId    — edit label / url / headers
			// DELETE /api/bots/:id/mcp/:mcpId    — detach
			//
			// We're protocol-pure: the body is `{ label, url, headers? }`
			// where `url` points at any Streamable-HTTP MCP endpoint
			// and `headers` carries optional auth (typical:
			// `Authorization: Bearer <pat>`).  No catalog, no proxy.
			// At runtime the tool-use loop fetches `tools/list` from
			// each attached server and exposes them to the LLM —
			// see engine/src/mcp/* for the client wiring.
			//
			// SECURITY NOTE: any caller who can mention the bot can
			// invoke its tools, which means anyone in any room with
			// the bot can act with whatever permissions the URL +
			// headers grant.  The UI surfaces this when attaching;
			// the engine just stores what the owner sent.
			{
				const m = path.match(/^\/api\/bots\/(\d+)\/mcp(?:\/(\d+))?$/);
				if (m) {
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN" }, { status: 401 });
					const id = Number(m[1]);
					const mcpId = m[2] ? Number(m[2]) : null;
					const existing = getBotById(id);
					if (!existing) return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
					if (existing.owner_id !== userId) {
						return json({ errcode: "M_FORBIDDEN", error: "not your bot" }, { status: 403 });
					}

					if (req.method === "GET" && mcpId === null) {
						return json({ servers: listBotMcpServers(id) });
					}

					if (req.method === "POST" && mcpId === null) {
						const body = (await req.json().catch(() => ({}))) as {
							label?: unknown;
							url?: unknown;
							headers?: unknown;
						};
						const parsed = parseMcpServerBody(body, { requireUrl: true });
						if ("error" in parsed) {
							return json({ errcode: "M_INVALID_PARAM", error: parsed.error }, { status: 400 });
						}
						const newId = addBotMcpServer({
							bot_id: id,
							label: parsed.label ?? "",
							kind: "http",
							url: parsed.url ?? "",
							headers: parsed.headers,
						});
						const row = getBotMcpServerById(newId);
						return json({ server: row });
					}

					if (req.method === "PATCH" && mcpId !== null) {
						const row = getBotMcpServerById(mcpId);
						if (!row || row.bot_id !== id) {
							return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
						}
						const body = (await req.json().catch(() => ({}))) as {
							label?: unknown;
							url?: unknown;
							headers?: unknown;
						};
						const parsed = parseMcpServerBody(body, { requireUrl: false });
						if ("error" in parsed) {
							return json({ errcode: "M_INVALID_PARAM", error: parsed.error }, { status: 400 });
						}
						const updated = updateBotMcpServer(mcpId, {
							label: parsed.label,
							url: parsed.url,
							headers: parsed.headers,
						});
						return json({ server: updated });
					}

					if (req.method === "DELETE" && mcpId !== null) {
						// Make sure the row actually belongs to this
						// bot — rejects "DELETE /api/bots/<my-bot>/mcp/<some-other-bot's-row>".
						const row = getBotMcpServerById(mcpId);
						if (!row || row.bot_id !== id) {
							return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
						}
						deleteBotMcpServer(mcpId);
						return json({ ok: true });
					}
				}
			}

			// POST /api/bots/:id/mcp/import { config }
			//
			// Tolerant JSON-paste endpoint.  Accepts the standard
			// Claude-Desktop / Cursor / Cline `mcpServers` config
			// block (or several common variants — see
			// engine/src/mcp/parse_config.ts), normalises every
			// server it finds, and creates one bot_mcp_servers row
			// per server.  Stdio-kind attachments get version-pinned
			// at attach time when they're npx-style invocations.
			//
			// Returns { servers: [BotMcpServer], warnings: [string],
			// skipped: [string] } so the UI can show what was added,
			// what was unrecognised, and any per-server caveats
			// (couldn't pin version, unknown fields ignored, etc.).
			{
				const m = path.match(/^\/api\/bots\/(\d+)\/mcp\/import$/);
				if (req.method === "POST" && m) {
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN" }, { status: 401 });
					const id = Number(m[1]);
					const existing = getBotById(id);
					if (!existing) return json({ errcode: "M_NOT_FOUND" }, { status: 404 });
					if (existing.owner_id !== userId) {
						return json({ errcode: "M_FORBIDDEN", error: "not your bot" }, { status: 403 });
					}
					const body = (await req.json().catch(() => null)) as { config?: unknown } | null;
					const cfg = body?.config;
					if (cfg === undefined || cfg === null) {
						return json({ errcode: "M_INVALID_PARAM", error: "config required" }, { status: 400 });
					}
					let parseResult;
					try {
						parseResult = parseMcpConfig(cfg);
					} catch (err) {
						return json({
							errcode: "M_INVALID_PARAM",
							error: err instanceof Error ? err.message : String(err),
						}, { status: 400 });
					}
					const created: ReturnType<typeof getBotMcpServerById>[] = [];
					const skipped: string[] = [];
					for (const att of parseResult.attachments) {
						try {
							let pinnedVersion: string | null = null;
							let finalArgs = att.args ?? [];
							if (att.kind === "stdio" && att.command) {
								const r = await pinStdioPackageVersion(att.command, finalArgs);
								finalArgs = r.args;
								pinnedVersion = r.version;
								if (!pinnedVersion) {
									parseResult.warnings.push(
										`${att.label}: couldn't pin npm version (private package or network blip) — will use whatever's latest at run time`,
									);
								}
							}
							const newId = addBotMcpServer({
								bot_id: id,
								label: att.label,
								kind: att.kind,
								url: att.url,
								headers: att.headers,
								command: att.command,
								args: finalArgs,
								env: att.env,
								locked_version: pinnedVersion ?? undefined,
							});
							created.push(getBotMcpServerById(newId));
						} catch (err) {
							skipped.push(`${att.label}: ${err instanceof Error ? err.message : String(err)}`);
						}
					}
					return json({
						servers: created.filter(s => s !== null),
						warnings: parseResult.warnings,
						skipped,
					});
				}
			}

			// ─── Admin: orphan-room cleanup ──────────────────────────
			// Discord-style invariant: every group room MUST belong to
			// a space.  These endpoints drive the one-time cleanup of
			// pre-invariant orphan rooms (rooms with no m.space.parent
			// that aren't DMs and aren't spaces themselves).
			//
			// GET  /api/admin/orphan-rooms          → dry-run candidate list
			// POST /api/admin/orphan-rooms/delete   → delete the listed candidates
			//
			// The POST gate requires `{ confirm: "DELETE_<count>" }` in
			// the body where <count> matches the number of rooms the
			// caller intends to delete (which must equal what the dry-
			// run last returned).  Two-keys-on-the-launcher: easy to
			// curl, hard to fat-finger.
			if (req.method === "GET" && path === "/api/admin/orphan-rooms") {
				const auth = await requireAdmin(req);
				if (auth instanceof Response) return auth;
				const candidates = await findOrphanRooms();
				return json({
					count: candidates.length,
					rooms: candidates,
				});
			}
			if (req.method === "POST" && path === "/api/admin/orphan-rooms/delete") {
				const auth = await requireAdmin(req);
				if (auth instanceof Response) return auth;
				const body = await readJson(req);
				const candidates = await findOrphanRooms();
				const expected = `DELETE_${candidates.length}`;
				if (body?.confirm !== expected) {
					return json({
						errcode: "M_FORBIDDEN",
						error: `confirm must equal ${JSON.stringify(expected)} (got ${JSON.stringify(body?.confirm ?? null)}); refresh the dry-run if the count drifted`,
					}, { status: 400 });
				}
				const results: Array<{ roomId: string; ok: boolean; detail?: string }> = [];
				for (const c of candidates) {
					const r = await adminDeleteRoom({ roomId: c.roomId });
					if ("error" in r) {
						results.push({ roomId: c.roomId, ok: false, detail: `${r.error}: ${r.detail ?? ""}` });
					} else {
						results.push({ roomId: c.roomId, ok: true });
					}
				}
				const okCount = results.filter(r => r.ok).length;
				console.log(`engine: orphan-rooms delete by ${auth.userId}: ${okCount}/${candidates.length} succeeded`);
				return json({
					attempted: candidates.length,
					succeeded: okCount,
					results,
				});
			}

			// `/api/admin/floor-queue` (+ confirm / reverse / dismiss
			// subroutes) used to live here.  All gone — the consensus
			// pipeline that created suspension rows from floor-
			// violation flags is gone, so there's nothing to confirm
			// or reverse.  Admins act on flags directly now: see the
			// `/api/admin/reports` endpoints + the kick / ban / redact
			// primitives elsewhere in this file.
			{
				const m = path.match(/^\/api\/admin\/floor-queue(\/.*)?$/);
				if (m) {
					return json({ errcode: "M_GONE", error: "floor queue is gone; use /api/admin/reports" }, { status: 410 });
				}
			}

			// ─── Room-target flags (report a room) ─────────────────
			//
			// Submit / retract a flag against the room itself (its name +
			// topic), as opposed to a single message inside it.  Recorded
			// in the flags table; admins review via the report queue.
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

			// ─── Admin management ───────────────────────────────────
			// Admins can promote and demote other users.  Bootstraps
			// to a single admin (admins.ts auto-grants the first user
			// the engine sees), so without this surface a single-admin
			// server stays single-admin forever — fine for solo
			// installs, painful for any team.  These three endpoints
			// are admin-gated; non-admins get a flat 403.

			// GET /api/admins → list of every current admin row.
			// Response shape: { admins: [{ user_id, granted_at,
			// granted_by }] }, oldest grant first (matches the table's
			// natural order).  Used by Settings → Instance to show the
			// roster; the UI also runs Synapse user-search to display
			// nice names and avatars next to each mxid.
			if (req.method === "GET" && path === "/api/admins") {
				const auth = await requireAdmin(req);
				if (auth instanceof Response) return auth;
				return json({ admins: listAdmins() });
			}

			// POST /api/admins/grant { user_id }
			// Promote `user_id` to admin.  No-op when they already
			// have it — INSERT OR IGNORE means the request still
			// returns 200 but doesn't double-write the row.  Doesn't
			// validate that the user actually exists on Synapse — an
			// admin granting on a typo'd mxid wastes a row, not a
			// security event, since isAdmin() resolves only when the
			// mxid+grant both exist.  The Settings UI funnels through
			// user search so typos in practice are rare.
			if (req.method === "POST" && path === "/api/admins/grant") {
				const auth = await requireAdmin(req);
				if (auth instanceof Response) return auth;
				const body = (await req.json().catch(() => null)) as { user_id?: unknown } | null;
				const targetUserId = typeof body?.user_id === "string" ? body.user_id.trim() : "";
				if (!targetUserId.startsWith("@") || !targetUserId.includes(":")) {
					return json({ errcode: "M_INVALID_PARAM", error: "user_id must be a Matrix mxid" }, { status: 400 });
				}
				grantAdmin(targetUserId, auth.userId);
				console.log(`engine: admin grant ${targetUserId} by ${auth.userId}`);
				return json({ ok: true, user_id: targetUserId, admin_count: adminCount() });
			}

			// POST /api/admins/revoke { user_id }
			// Demote `user_id`.  Two safety guards:
			//   1. Refuse to drop the last admin — the server would
			//      become un-administrable until someone re-runs
			//      bin/koven setup or pokes the SQLite directly.
			//   2. Self-revoke is allowed only when at least one OTHER
			//      admin exists (combines with #1 for the same effect,
			//      but #2 lets us return a clearer error).
			// Idempotent: revoking a user who isn't currently an admin
			// returns 200 with admin_count unchanged.
			if (req.method === "POST" && path === "/api/admins/revoke") {
				const auth = await requireAdmin(req);
				if (auth instanceof Response) return auth;
				const body = (await req.json().catch(() => null)) as { user_id?: unknown } | null;
				const targetUserId = typeof body?.user_id === "string" ? body.user_id.trim() : "";
				if (!targetUserId) {
					return json({ errcode: "M_INVALID_PARAM", error: "user_id required" }, { status: 400 });
				}
				if (!isAdmin(targetUserId)) {
					// Idempotent — return 200 with the unchanged count.
					return json({ ok: true, user_id: targetUserId, admin_count: adminCount() });
				}
				if (adminCount() === 1) {
					return json({
						errcode: "M_FORBIDDEN",
						error: "cannot revoke the last admin — promote someone else first",
					}, { status: 409 });
				}
				revokeAdmin(targetUserId);
				console.log(`engine: admin revoke ${targetUserId} by ${auth.userId}`);
				return json({ ok: true, user_id: targetUserId, admin_count: adminCount() });
			}

			// ─── Per-room notification preferences ──────────────────
			// Three levels: 'all' (every message), 'mentions' (default
			// — DM/mention/reply only), 'muted' (nothing).  Stored
			// per-(user, room) in room_notify_prefs; missing row =
			// 'mentions'.  See db.ts for the table; fanOutMessage
			// reads getRoomNotifyLevel before writing notification
			// rows so a 'muted' room is silent and an 'all' room
			// produces a kind=message event for non-mention messages.

			// GET /api/notify-prefs/rooms → { rooms: { [roomId]: level } }
			// Returns ONLY overridden rows; missing keys = default
			// 'mentions'.  Client sends one bulk fetch on boot to
			// hydrate its in-memory cache.
			if (req.method === "GET" && path === "/api/notify-prefs/rooms") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const rows = listRoomNotifyLevels(userId);
				const map: Record<string, string> = {};
				for (const r of rows) map[r.room_id] = r.level;
				return json({ rooms: map });
			}

			// PUT /api/notify-prefs/rooms/:roomId { level }
			// Sets the user's level for a specific room.  Passing
			// 'mentions' clears the override (restores default
			// behaviour) so we don't accumulate dead rows for users
			// who toggle off and back to default.
			{
				const m = path.match(/^\/api\/notify-prefs\/rooms\/(.+)$/);
				if (req.method === "PUT" && m) {
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
					const roomId = decodeURIComponent(m[1]!);
					if (!roomId.startsWith("!")) {
						return json({ errcode: "M_INVALID_PARAM", error: "room id must start with !" }, { status: 400 });
					}
					const body = (await req.json().catch(() => null)) as { level?: unknown } | null;
					const level = body?.level;
					if (level !== "all" && level !== "mentions" && level !== "muted") {
						return json({
							errcode: "M_INVALID_PARAM",
							error: "level must be one of: all, mentions, muted",
						}, { status: 400 });
					}
					setRoomNotifyLevel(userId, roomId, level);
					return json({ ok: true, user_id: userId, room_id: roomId, level });
				}
			}

			// PUT /api/notify-prefs/rooms-bulk { room_ids: [], level }
			// Atomic bulk version of the per-room PUT above.  Wraps
			// every row write in a single SQLite transaction so the
			// result is all-or-nothing — the previous client-side
			// "fire N parallel PUTs" pattern could leave the user
			// in a partially-applied state if any of them failed,
			// and there was no way for the client to know which
			// rooms had taken vs which hadn't.  This endpoint
			// returns the count of rows touched so the client can
			// confirm and re-hydrate its local cache afterwards.
			if (req.method === "PUT" && path === "/api/notify-prefs/rooms-bulk") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const body = (await req.json().catch(() => null)) as
					| { room_ids?: unknown; level?: unknown }
					| null;
				const level = body?.level;
				if (level !== "all" && level !== "mentions" && level !== "muted") {
					return json({
						errcode: "M_INVALID_PARAM",
						error: "level must be one of: all, mentions, muted",
					}, { status: 400 });
				}
				if (!Array.isArray(body?.room_ids)) {
					return json({ errcode: "M_INVALID_PARAM", error: "room_ids must be an array" }, { status: 400 });
				}
				const roomIds: string[] = [];
				for (const id of body.room_ids) {
					if (typeof id !== "string" || !id.startsWith("!")) {
						return json({
							errcode: "M_INVALID_PARAM",
							error: "every room id must be a string starting with !",
						}, { status: 400 });
					}
					roomIds.push(id);
				}
				const updated = setRoomNotifyLevelBulk(userId, roomIds, level);
				return json({ ok: true, updated, level });
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
			// Backfill DM markers from the client.  The SPA classifies
			// DMs locally via m.direct account_data (which the engine
			// can't read without user-context auth); on boot it posts
			// the user's known DM room ids here so the fan-out can
			// distinguish actual DMs from 2-person private rooms.
			//
			// Membership-checked — without this gate, any signed-in
			// user could mark arbitrary rooms as DMs and force the
			// fan-out to fire kind=dm bells on every message in those
			// rooms.  With it, you can only mark rooms you actually
			// participate in.  Forward-going: handleMember catches
			// is_direct=true on new invites; this endpoint is the
			// one-shot bridge for rooms that pre-date that path.
			if (req.method === "POST" && path === "/api/rooms/mark-dms") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const body = (await req.json().catch(() => null)) as
					| { room_ids?: unknown }
					| null;
				const roomIds = Array.isArray(body?.room_ids)
					? (body!.room_ids as unknown[]).filter((x): x is string => typeof x === "string")
					: [];
				if (roomIds.length === 0) return json({ marked: 0 });
				if (roomIds.length > 200) {
					return json(
						{ errcode: "M_LIMIT_EXCEEDED", error: "max 200 room_ids per request" },
						{ status: 400 },
					);
				}
				let marked = 0;
				await Promise.all(
					roomIds.map(async (rid) => {
						try {
							const members = await getJoinedMembers(rid);
							if (!members.includes(userId)) return;
							markRoomAsDm(rid);
							marked++;
						} catch {
							// Silently skip — room gone, federation
							// failure, etc.  Idempotent retry on next
							// boot.
						}
					}),
				);
				return json({ marked });
			}

			// POST /api/rooms/:roomId/repair-permissions
			//
			// Self-heal for the "M_FORBIDDEN: You don't have permission
			// to invite users" 403 a member can hit on rooms whose
			// m.room.power_levels was left with `invite > 0` — typically
			// rooms created before the atomic-PL fix in the client's
			// createRoom path, where the follow-up sendStateEvent could
			// drop silently and leave the room with Synapse's default
			// (`invite: 50` on older room versions).
			//
			// The client calls this after an invite returns 403; the
			// engine elevates its appservice user via make_room_admin
			// and rewrites the PL with `invite: 0`.  The user retries
			// the invite transparently — no UI button.  Caller must be
			// a joined member of the room (otherwise anyone could nudge
			// PLs of any room they know the id of).
			{
				const m = path.match(/^\/api\/rooms\/([^/]+)\/repair-permissions$/);
				if (req.method === "POST" && m) {
					const userId = await whoami(extractToken(req));
					if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
					const roomId = decodeURIComponent(m[1]!);
					try {
						const members = await getJoinedMembers(roomId);
						if (!members.includes(userId)) {
							return json({ errcode: "M_FORBIDDEN", error: "not a member" }, { status: 403 });
						}
					} catch (err) {
						return json({ error: "membership_check_failed", detail: err instanceof Error ? err.message : String(err) }, { status: 502 });
					}
					const result = await repairRoomInvitePL(roomId);
					if ("error" in result) {
						return json({ error: result.error, detail: result.detail }, { status: 502 });
					}
					return json({ ok: true, repaired: result.repaired });
				}
			}

			// GET /api/spaces/:spaceId/children-meta
			//
			// Returns the Koven-custom category list for a space
			// (`chat.koven.space.categories`) plus per-child order +
			// category id (read off each `m.space.child` event on
			// the space).
			//
			// matrix-rust-sdk's Swift FFI doesn't expose generic
			// state-event reads, and the iOS client needs the same
			// grouping the web sidebar shows, so we surface this
			// through the engine the same way we do for
			// `/api/rooms/icons`.  Public read: a space's child
			// relationships are already discoverable to anyone who
			// can peek the space; category names live alongside
			// them and aren't sensitive.
			//
			// Response shape:
			//   { categories: [{id, name}, ...],
			//     rooms: { "!childId:server": { order?, categoryId? }, ... } }
			{
				const m = path.match(/^\/api\/spaces\/([^/]+)\/children-meta$/);
				if (req.method === "GET" && m) {
					const spaceId = decodeURIComponent(m[1]!);
					const state = await readRoomState(spaceId);
					if (!state) return json({ categories: [], rooms: {} });

					const catContent = pickStateContent(state, "chat.koven.space.categories") as
						| { categories?: unknown }
						| null;
					const categories: Array<{ id: string; name: string }> =
						Array.isArray(catContent?.categories)
							? (catContent!.categories as unknown[])
								.filter((c): c is { id: string; name: string } =>
									typeof c === "object" && c !== null
									&& typeof (c as { id?: unknown }).id === "string"
									&& typeof (c as { name?: unknown }).name === "string")
								.map(c => ({ id: c.id, name: c.name }))
							: [];

					const rooms: Record<string, { order?: string; categoryId?: string }> = {};
					for (const ev of state) {
						if (ev.type !== "m.space.child") continue;
						if (typeof ev.state_key !== "string") continue;
						const content = ev.content as Record<string, unknown> | undefined;
						// Cleared child events (no `via`) are no longer
						// in the space; skip so they don't leak into
						// the response.
						if (!content || !Array.isArray(content["via"])) continue;
						const order = typeof content["order"] === "string"
							? (content["order"] as string)
							: undefined;
						const categoryId = typeof content["chat.koven.category"] === "string"
							? (content["chat.koven.category"] as string)
							: undefined;
						rooms[ev.state_key] = { order, categoryId };
					}

					return json({ categories, rooms });
				}
			}

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
				const creators: Record<string, string> = {};
				for (const [id, meta] of results) {
					if (meta.iconEmoji) icons[id] = meta.iconEmoji;
					if (meta.nsfw) nsfw.push(id);
					if (meta.creatorId) creators[id] = meta.creatorId;
				}
				return json({ icons, nsfw, creators });
			}

			// GET /api/rooms/:roomId/seen-by
			//
			// Per-event "seen by" rollup for the iOS client.
			// matrix-rust-sdk's Swift FFI doesn't expose
			// `Room.getReceiptsForEvent` like matrix-js-sdk does on
			// the web — iOS only sees receipts on events that pass
			// the SDK's timeline filter, which means receipts
			// anchored to filtered state events are invisible.  We
			// route iOS through this endpoint so it gets the same
			// receipt map the web has via direct SDK access.
			//
			// Bots, services, and `@bot-*` mxids are filtered server-
			// side so every client gets the same view without
			// having to maintain its own roster.  The current user
			// is NOT excluded — iOS strips itself from the list at
			// render time (it knows its own mxid; the engine
			// doesn't from this unauthenticated call).
			//
			// Response shape: `{ "byEvent": { "$evtid": ["@u1:s",
			// ...], ... } }` — each user appears under the single
			// event their read-receipt currently anchors to,
			// mirroring the per-event view.
			{
				const m = path.match(/^\/api\/rooms\/([^/]+)\/seen-by$/);
				if (req.method === "GET" && m) {
					const roomId = decodeURIComponent(m[1]!);
					const raw = await getRoomSeenBy(roomId);

					const botRoster = new Set(listAllBotMxids());
					const services = new Set<string>();
					if (config.engineUserId) services.add(config.engineUserId);
					if (config.synapseAdminUser) {
						const r = config.synapseAdminUser.trim();
						const mxid = r.startsWith("@") ? r : `@${r}:${config.homeserverName}`;
						services.add(mxid);
					}

					const byEvent: Record<string, string[]> = {};
					for (const [eventId, userIds] of Object.entries(raw)) {
						const filtered = userIds.filter(uid => {
							if (botRoster.has(uid)) return false;
							if (services.has(uid)) return false;
							// Deleted-bot fallback: matrix has no
							// "redact a receipt" verb so stale
							// `@bot-*` receipts persist after the
							// bot row is dropped.  The reserved
							// namespace is bots-only — no human can
							// have it.
							if (uid.startsWith("@bot-")) return false;
							return true;
						});
						if (filtered.length > 0) byEvent[eventId] = filtered;
					}

					return json({ byEvent });
				}
			}

			// GET /api/rooms/:roomId/parents
			//
			// Returns the parent space ids declared on a room via
			// `m.space.parent` state events.  Used by the SPA's
			// deep-link confirm-sheet flow to redirect "join this
			// room" intents to "join this room's parent space" —
			// Koven's Discord-style invariant says rooms are joined
			// via their space, not directly.
			//
			// Public read: room state is already viewable to anyone
			// who can peek the room, and a room's parent-space
			// linkage isn't sensitive (the parent's m.space.child
			// listing is also public).  Returns an empty array for
			// orphan rooms (which still exist for legacy reasons
			// pre-Discord-refactor); the client falls back to "join
			// this room" in that case.
			{
				const m = path.match(/^\/api\/rooms\/([^/]+)\/parents$/);
				if (req.method === "GET" && m) {
					const roomId = decodeURIComponent(m[1]!);
					try {
						const state = await readRoomState(roomId);
						if (!state) return json({ parents: [] });
						const parents: string[] = [];
						for (const ev of state) {
							if (ev.type !== "m.space.parent") continue;
							if (typeof ev.state_key !== "string") continue;
							// Trust m.space.parent only when the
							// space ALSO lists this room as a child
							// (m.space.child on the parent).  That
							// mirrors Matrix's "two-way relationship"
							// convention — a malicious room can
							// falsely claim membership in someone
							// else's space; the canonical link is
							// the parent's m.space.child pointing
							// back at us.  Skipped for now since
							// it adds a Synapse round-trip per
							// parent; we trust the room's claim
							// here, accepting the (small) attack
							// surface of "join a space you didn't
							// expect."  Tighten if it becomes a
							// real problem.
							parents.push(ev.state_key);
						}
						return json({ parents });
					} catch (err) {
						console.warn(`engine: /api/rooms/${roomId}/parents threw`, err);
						return json({ parents: [] });
					}
				}
			}

			// ─── Per-room public mod log ─────────────────────────────
			// Aggregates flags + self-deletions + bot-membership actions
			// originating in the room into one chronological feed.
			// Public read; the whole point of the audit log is anyone
			// can inspect it.
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
					// Voluntary takedowns: trash-button deletions of own
					// or owned-bot messages.  Distinct from flag
					// retractions (which target the FLAG event, not the
					// message).
					const selfDeletions = selfDeletionsForRoom(roomId).map(d => ({
						kind: "self_deletion" as const,
						ts: d.created_at,
						target_event_id: d.target_event_id,
						redacted_by: d.redacted_by,
						target_sender: d.target_sender,
						deletion_kind: d.kind,
					}));
					// Founder-initiated bot removals.  Bots aren't people,
					// so the room's founder is the right authority to
					// silence them — logged here so the room can see who
					// silenced what.
					const botActions = botMembershipActionsForRoom(roomId).map(a => ({
						kind: "bot_membership" as const,
						ts: a.created_at,
						bot_mxid: a.bot_mxid,
						bot_owner: a.bot_owner,
						action: a.action,
						founder: a.founder,
					}));
					// Standard admin moderation primitives (PL ≥ 50).
					// Carved out of the consensus model: humans get
					// kicked / banned / redacted by an authoritative
					// admin, not by group vote.  See mod_actions table
					// in db.ts.
					const modActionsRaw = modActionsForRoom(roomId);
					const modActions = modActionsRaw.map(a => ({
						kind: "mod_action" as const,
						ts: a.created_at,
						action: a.action,
						actor: a.actor,
						target_user: a.target_user,
						target_event_id: a.target_event_id,
						new_power_level: a.new_power_level,
						reason: a.reason,
					}));
					const merged = [...flags, ...selfDeletions, ...botActions, ...modActions]
						.sort((a, b) => b.ts - a.ts);
					return json({
						room_id: roomId,
						entries: merged,
						// Also surface the raw mod_actions rows alongside
						// the merged feed so callers that want to render
						// them in a typed way don't have to discriminate
						// off the union.
						mod_actions: modActionsRaw,
					});
				}
			}

			// ─── Record a moderator action ───────────────────────────
			// POST /api/rooms/:roomId/mod-actions
			//
			// Audit-trail side of standard Matrix admin moderation.  The
			// caller has already (or is about to) perform the underlying
			// Matrix mutation via Synapse directly (kick / ban / redact /
			// PL state event); this endpoint only records the row that
			// the per-room mod log + admin sheet read from.
			//
			// Auth: caller's bearer + PL ≥ 50 in the room.  PL is read
			// off m.room.power_levels via the admin state API (the
			// caller may not be joined yet for unban / redact, and even
			// when joined the client API is gated to current members; the
			// admin endpoint sidesteps both).
			{
				const m = path.match(/^\/api\/rooms\/([^/]+)\/mod-actions$/);
				if (req.method === "POST" && m) {
					const token = extractToken(req);
					const userId = await whoami(token);
					if (!userId || !token) {
						return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
					}
					const roomId = decodeURIComponent(m[1]!);
					const body = (await req.json().catch(() => ({}))) as {
						action?: unknown;
						target_user?: unknown;
						target_event_id?: unknown;
						new_power_level?: unknown;
						reason?: unknown;
					};

					const VALID_ACTIONS: readonly ModAction[] = [
						"kick", "ban", "unban", "redact", "role_change",
					] as const;
					const action = body.action;
					if (typeof action !== "string" || !(VALID_ACTIONS as readonly string[]).includes(action)) {
						return json({
							errcode: "M_INVALID_PARAM",
							error: `action must be one of ${VALID_ACTIONS.join(", ")}`,
						}, { status: 400 });
					}
					const targetUser = typeof body.target_user === "string" ? body.target_user : undefined;
					const targetEventId = typeof body.target_event_id === "string" ? body.target_event_id : undefined;
					const newPowerLevel = typeof body.new_power_level === "number" && Number.isFinite(body.new_power_level)
						? Math.trunc(body.new_power_level)
						: undefined;
					const rawReason = typeof body.reason === "string" ? body.reason.slice(0, 1000) : undefined;

					// Action-specific required-field validation.
					if (action === "kick" || action === "ban" || action === "unban" || action === "role_change") {
						if (!targetUser) {
							return json({
								errcode: "M_INVALID_PARAM",
								error: `${action} requires target_user`,
							}, { status: 400 });
						}
					}
					if (action === "redact") {
						if (!targetEventId) {
							return json({
								errcode: "M_INVALID_PARAM",
								error: "redact requires target_event_id",
							}, { status: 400 });
						}
					}
					if (action === "role_change") {
						if (newPowerLevel === undefined) {
							return json({
								errcode: "M_INVALID_PARAM",
								error: "role_change requires new_power_level",
							}, { status: 400 });
						}
					}

					// PL check.  Read m.room.power_levels via Synapse's
					// admin state API and compare the caller's effective
					// PL against the 50 cutoff.  A missing users entry
					// falls back to users_default (default 0 in spec).
					const state = await readRoomState(roomId);
					if (!state) {
						return json({
							errcode: "M_NOT_FOUND",
							error: "room not found or state unreadable",
						}, { status: 404 });
					}
					const pl = pickStateContent(state, "m.room.power_levels", "") as {
						users?: Record<string, number>;
						users_default?: number;
					} | null;
					const defaultPl = typeof pl?.users_default === "number" ? pl.users_default : 0;
					const callerPl = typeof pl?.users?.[userId] === "number" ? pl.users[userId]! : defaultPl;
					if (callerPl < 50) {
						return json({
							errcode: "M_FORBIDDEN",
							error: "caller PL < 50 in this room",
						}, { status: 403 });
					}

					const rec = recordModAction({
						roomId,
						action: action as ModAction,
						actor: userId,
						targetUser: targetUser ?? null,
						targetEventId: targetEventId ?? null,
						newPowerLevel: newPowerLevel ?? null,
						reason: rawReason ?? null,
					});
					return json({ id: rec.id, created_at: rec.created_at });
				}
			}

			// ─── Reports queue ──────────────────────────────────────
			// Member-submitted flags surface here for triage.  Visibility
			// is per-row, gated by EITHER:
			//
			//   (1) caller has PL ≥ 50 in the reported room (space-mod
			//       path — owners + moderators see reports for content
			//       in spaces they have authority over), OR
			//   (2) caller is a server admin (engine `admins` table) AND
			//       the report's category is `floor_violation` (instance-
			//       wide floor backstop — the operator's legal duty for
			//       CSAM / credible threats / doxxing, regardless of
			//       which space the content lives in).
			//
			// The two conditions overlap when a server admin is also
			// PL ≥ 50 somewhere; they just see those reports once.  A
			// server admin who happens to also be the founder of a
			// space sees their own space's reports via path (1), not
			// via any "server admin sees everything" shortcut — that
			// shortcut doesn't exist on purpose.  The server admin is
			// the platform operator, not a super-moderator.  See
			// docs/MODERATION.md for the rationale.
			//
			// Status starts at 'open'; the visible-to-caller actor
			// flips it to 'dismissed' (no action warranted) or
			// 'actioned' (handled via standard primitives like
			// kick/ban/redact).
			if (req.method === "GET" && path === "/api/admin/reports") {
				const token = extractToken(req);
				const userId = await whoami(token);
				if (!userId) {
					return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				}
				const isInstanceAdmin = isAdmin(userId);
				const allRows = listAllFlagsForReportQueue();
				const visibility = await computeReportVisibility(allRows, userId, isInstanceAdmin);
				const rows = allRows
					.filter(r => visibility.get(r.event_id))
					.map(r => ({
						// Identifier is the flag's Matrix event id (the
						// flags table uses event_id TEXT PRIMARY KEY; there's
						// no separate INTEGER id).  SPA uses this verbatim in
						// the dismiss / action endpoints below.
						event_id: r.event_id,
						room_id: r.room_id,
						flagger: r.flagger,
						target_kind: r.target_kind,
						// For target_kind='message', target_event_id is the
						// flagged message id and target_room_id is null.
						// For target_kind='room', target_event_id is the
						// flagged room id (room ids start with `!`, event
						// ids start with `$`; flag-room rows reuse the
						// target_event_id column for the room id).  The SPA
						// gets the disambiguated shape it expects without
						// having to inspect the leading char.
						target_event_id: r.target_kind === "room" ? null : r.target_event_id,
						target_room_id:  r.target_kind === "room" ? r.target_event_id : null,
						category: r.category,
						rationale: r.rationale,
						created_at: r.ts,
						status: r.review_status,
					}));
				return json({ reports: rows });
			}

			{
				// Flag event ids start with `$` and contain Matrix's
				// usual url-safe charset (alphanum + ./-_=).  Match
				// everything but the trailing /verb so we hand the
				// decoded id verbatim to the DB lookup.
				const m = path.match(/^\/api\/admin\/reports\/([^/]+)\/(dismiss|action)$/);
				if (req.method === "POST" && m) {
					const token = extractToken(req);
					const userId = await whoami(token);
					if (!userId) {
						return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
					}
					const flagEventId = decodeURIComponent(m[1]!);
					const verb = m[2] as "dismiss" | "action";
					const existing = getFlagByEventId(flagEventId);
					if (!existing) {
						return json({
							errcode: "M_NOT_FOUND",
							error: "report not found",
						}, { status: 404 });
					}
					// Per-report visibility check — caller has to be able
					// to SEE this report under the rules above to act on
					// it.  Same gate as the list endpoint: a random user
					// can't dismiss a report just because they know its
					// id.
					const isInstanceAdmin = isAdmin(userId);
					const visibility = await computeReportVisibility([existing], userId, isInstanceAdmin);
					if (!visibility.get(flagEventId)) {
						return json({
							errcode: "M_FORBIDDEN",
							error: "report not visible to caller",
						}, { status: 403 });
					}
					const nextStatus = verb === "dismiss" ? "dismissed" : "actioned";
					setFlagReviewStatus(flagEventId, nextStatus);
					return json({ event_id: flagEventId, status: nextStatus });
				}
			}

			// ─── Open-report count for badge polling ─────────────────
			// Tiny helper so the shield-icon badge in the SpaceBar can
			// show a count without paging through the whole report
			// queue every refresh.  Filtered to reports visible to the
			// caller (same rules as the list endpoint above).  Polled
			// every 60s by anyone who could plausibly have reports to
			// see (any space mod plus all server admins) so this needs
			// to be cheap-ish.
			if (req.method === "GET" && path === "/api/admin/reports/count") {
				const token = extractToken(req);
				const userId = await whoami(token);
				if (!userId) {
					return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				}
				const isInstanceAdmin = isAdmin(userId);
				const openRows = listAllFlagsForReportQueue().filter(r => r.review_status === "open");
				const visibility = await computeReportVisibility(openRows, userId, isInstanceAdmin);
				let open = 0;
				for (const r of openRows) if (visibility.get(r.event_id)) open++;
				return json({ open });
			}

			// ─── Server-admin instance-level toolkit ────────────────
			// These three endpoints are the escalation paths for
			// room-level / space-level reports + floor-violation reports
			// that need platform-side action.  All gated by
			// `requireAdmin` (server admin only).  All write an audit
			// row to `instance_admin_actions` keyed back to the
			// triggering flag (when provided) so the operator's record
			// is intact even after the underlying room is gone.
			//
			// Body shape for all three:
			//   { reason?: string, related_flag?: string }

			// POST /api/admin/rooms/:roomId/delete
			// Hard-delete a room: kicks every member, purges history,
			// prevents the room id from being re-used.  Use for rooms
			// dedicated to floor violation.
			{
				const m = path.match(/^\/api\/admin\/rooms\/([^/]+)\/delete$/);
				if (req.method === "POST" && m) {
					const auth = await requireAdmin(req);
					if (auth instanceof Response) return auth;
					const roomId = decodeURIComponent(m[1]!);
					const body = (await req.json().catch(() => ({}))) as {
						reason?: unknown;
						related_flag?: unknown;
					};
					const reason = typeof body.reason === "string" ? body.reason.slice(0, 1000) : null;
					const relatedFlag = typeof body.related_flag === "string" ? body.related_flag : null;
					const res = await adminDeleteRoom({
						roomId,
						message: reason ?? "Room removed by server admin (floor / room-report action).",
					});
					if ("error" in res) {
						return json({ errcode: "M_UNKNOWN", error: res.error }, { status: 502 });
					}
					const rec = recordInstanceAdminAction({
						actor: auth.userId,
						action: "delete_room",
						target: roomId,
						reason,
						relatedFlag,
					});
					return json({ id: rec.id, created_at: rec.created_at });
				}
			}

			// POST /api/admin/spaces/:spaceId/delete
			// Hard-delete a whole space tree: enumerates m.space.child
			// state events, deletes each child room, then deletes the
			// space room itself.  Best-effort per child — a child that
			// fails to delete (e.g. already gone) doesn't abort the
			// rest.  For "this whole community shouldn't exist" cases.
			{
				const m = path.match(/^\/api\/admin\/spaces\/([^/]+)\/delete$/);
				if (req.method === "POST" && m) {
					const auth = await requireAdmin(req);
					if (auth instanceof Response) return auth;
					const spaceId = decodeURIComponent(m[1]!);
					const body = (await req.json().catch(() => ({}))) as {
						reason?: unknown;
						related_flag?: unknown;
					};
					const reason = typeof body.reason === "string" ? body.reason.slice(0, 1000) : null;
					const relatedFlag = typeof body.related_flag === "string" ? body.related_flag : null;

					// Walk m.space.child to find children.  Read state
					// BEFORE deleting anything — once we start deleting
					// the order of operations matters: children first,
					// space last, so the space's mod log isn't lost
					// while children still reference it.
					const state = await readRoomState(spaceId);
					const childIds: string[] = [];
					if (state) {
						for (const ev of state) {
							if (ev.type !== "m.space.child") continue;
							const childId = ev.state_key;
							if (!childId) continue;
							const via = (ev.content as { via?: unknown })?.via;
							if (!Array.isArray(via) || via.length === 0) continue;
							childIds.push(childId);
						}
					}

					const failed: Array<{ roomId: string; error: string }> = [];
					const childMessage = reason ?? "Parent space removed by server admin (floor / space-report action).";
					for (const childId of childIds) {
						const res = await adminDeleteRoom({ roomId: childId, message: childMessage });
						if ("error" in res) failed.push({ roomId: childId, error: res.error });
					}
					const spaceRes = await adminDeleteRoom({
						roomId: spaceId,
						message: reason ?? "Space removed by server admin (floor / space-report action).",
					});
					if ("error" in spaceRes) {
						return json({
							errcode: "M_UNKNOWN",
							error: spaceRes.error,
							children_failed: failed,
						}, { status: 502 });
					}

					const rec = recordInstanceAdminAction({
						actor: auth.userId,
						action: "delete_space",
						target: spaceId,
						reason,
						relatedFlag,
					});
					return json({
						id: rec.id,
						created_at: rec.created_at,
						children_deleted: childIds.length - failed.length,
						children_failed: failed,
					});
				}
			}

			// POST /api/admin/users/:userId/deactivate
			// Nuke a user account platform-wide.  Synapse erases the
			// profile, pseudonymises message authorship, blocks the
			// mxid from re-registration.  The heaviest single
			// instance-admin action — caller side MUST gate this
			// behind a strong confirm.
			{
				const m = path.match(/^\/api\/admin\/users\/([^/]+)\/deactivate$/);
				if (req.method === "POST" && m) {
					const auth = await requireAdmin(req);
					if (auth instanceof Response) return auth;
					const targetUserId = decodeURIComponent(m[1]!);
					const body = (await req.json().catch(() => ({}))) as {
						reason?: unknown;
						related_flag?: unknown;
					};
					const reason = typeof body.reason === "string" ? body.reason.slice(0, 1000) : null;
					const relatedFlag = typeof body.related_flag === "string" ? body.related_flag : null;

					// Belt-and-braces: refuse to deactivate the actor
					// themselves (they could lock themselves out).  Also
					// refuse to deactivate another server admin via this
					// path — server admin to-server admin actions go
					// through /api/admins/revoke first, then this.
					if (targetUserId === auth.userId) {
						return json({
							errcode: "M_FORBIDDEN",
							error: "cannot deactivate yourself via this path",
						}, { status: 403 });
					}
					if (isAdmin(targetUserId)) {
						return json({
							errcode: "M_FORBIDDEN",
							error: "target is a server admin — revoke admin first via /api/admins/revoke",
						}, { status: 403 });
					}

					const ok = await deactivateUser(targetUserId, /* erase */ true);
					if (!ok) {
						return json({
							errcode: "M_UNKNOWN",
							error: "synapse deactivate refused (user may not exist on this homeserver)",
						}, { status: 502 });
					}
					const rec = recordInstanceAdminAction({
						actor: auth.userId,
						action: "deactivate_user",
						target: targetUserId,
						reason,
						relatedFlag,
					});
					return json({ id: rec.id, created_at: rec.created_at });
				}
			}

			// POST /api/admin/users/:userId/ban
			// Reversible platform-wide ban.  Locks the Synapse account
			// (invalidates sessions, prevents login) and records a
			// platform_bans row.  Unlike deactivation the account and
			// message history are preserved, and the ban can be lifted
			// via the /unban endpoint.
			{
				const m = path.match(/^\/api\/admin\/users\/([^/]+)\/ban$/);
				if (req.method === "POST" && m) {
					const auth = await requireAdmin(req);
					if (auth instanceof Response) return auth;
					const targetUserId = decodeURIComponent(m[1]!);
					const body = (await req.json().catch(() => ({}))) as {
						reason?: unknown;
						related_flag?: unknown;
					};
					const reason = typeof body.reason === "string" ? body.reason.slice(0, 1000) : null;
					const relatedFlag = typeof body.related_flag === "string" ? body.related_flag : null;

					if (targetUserId === auth.userId) {
						return json({
							errcode: "M_FORBIDDEN",
							error: "cannot ban yourself via this path",
						}, { status: 403 });
					}
					if (isAdmin(targetUserId)) {
						return json({
							errcode: "M_FORBIDDEN",
							error: "target is a server admin — revoke admin first via /api/admins/revoke",
						}, { status: 403 });
					}
					if (isPlatformBanned(targetUserId)) {
						return json({
							errcode: "M_ALREADY_EXISTS",
							error: "user is already platform-banned",
							ban: getPlatformBan(targetUserId),
						}, { status: 409 });
					}

					const ok = await lockUser(targetUserId);
					if (!ok) {
						return json({
							errcode: "M_UNKNOWN",
							error: "synapse lock refused (user may not exist on this homeserver)",
						}, { status: 502 });
					}
					// Kick from every room so the user vanishes from all
					// member lists.  Best-effort; lock already prevents
					// any further activity regardless.
					await kickUserFromAllRooms(targetUserId, "Platform ban");
					insertPlatformBan(targetUserId, reason, auth.userId, relatedFlag);
					const rec = recordInstanceAdminAction({
						actor: auth.userId,
						action: "ban_user",
						target: targetUserId,
						reason,
						relatedFlag,
					});
					return json({ id: rec.id, created_at: rec.created_at });
				}
			}

			// POST /api/admin/users/:userId/unban
			// Lift a platform ban.  Unlocks the Synapse account so the
			// user can log in again.
			{
				const m = path.match(/^\/api\/admin\/users\/([^/]+)\/unban$/);
				if (req.method === "POST" && m) {
					const auth = await requireAdmin(req);
					if (auth instanceof Response) return auth;
					const targetUserId = decodeURIComponent(m[1]!);
					const body = (await req.json().catch(() => ({}))) as {
						reason?: unknown;
					};
					const reason = typeof body.reason === "string" ? body.reason.slice(0, 1000) : null;

					if (!isPlatformBanned(targetUserId)) {
						return json({
							errcode: "M_NOT_FOUND",
							error: "user is not platform-banned",
						}, { status: 404 });
					}

					const ok = await unlockUser(targetUserId);
					if (!ok) {
						return json({
							errcode: "M_UNKNOWN",
							error: "synapse unlock refused",
						}, { status: 502 });
					}
					deletePlatformBan(targetUserId);
					const rec = recordInstanceAdminAction({
						actor: auth.userId,
						action: "unban_user",
						target: targetUserId,
						reason,
					});
					return json({ ok: true, id: rec.id, created_at: rec.created_at });
				}
			}

			// GET /api/admin/bans
			// List all currently platform-banned users.
			{
				if (req.method === "GET" && path === "/api/admin/bans") {
					const auth = await requireAdmin(req);
					if (auth instanceof Response) return auth;
					return json({ bans: listPlatformBans() });
				}
			}

			// GET /api/admin/users/:userId/ban-status
			// Check whether a single user is platform-banned.
			{
				const m = path.match(/^\/api\/admin\/users\/([^/]+)\/ban-status$/);
				if (req.method === "GET" && m) {
					const auth = await requireAdmin(req);
					if (auth instanceof Response) return auth;
					const targetUserId = decodeURIComponent(m[1]!);
					const ban = getPlatformBan(targetUserId);
					return json({ banned: !!ban, ban: ban ?? undefined });
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
					//
					// Third fallback: when both resolvers whiff, treat
					// it as a self-delete attempt under the caller's
					// own token.  This is the DM case — E2EE rooms
					// give us no plaintext `posts` row AND the engine
					// bot isn't a member, so neither lookup can ever
					// succeed.  We're not lowering the security bar:
					// Synapse's redaction rules already enforce "only
					// the sender (or someone with redact PL) can
					// redact", so if the caller is lying about owning
					// the event the redaction call below fails and
					// we surface that as a 403.  Bot-owner deletes in
					// E2EE rooms remain unsupported here; the caller
					// would need to know it's their bot's event from
					// outside the room, which we can't verify.
					let senderId: string | null;
					const localSender = lookupPostUser(eventId);
					if (localSender) {
						senderId = localSender;
						// Type is implicitly m.room.message — the only
						// event kind we record into posts (handleMessage
						// in aggregate.ts skips state events).
					} else {
						const ev = await getEventSender(roomId, eventId);
						if (ev) {
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
						} else {
							// Unknown — let the self-delete branch try.
							senderId = null;
						}
					}

					// Authorization branch.  `kind` distinguishes which
					// access token performs the redaction and goes into
					// the audit row.
					let kind: "self" | "bot_owner";
					let bearerForRedact: string;
					let botId: number | null = null;
					const senderUnverified = senderId === null;
					if (senderId === null || senderId === userId) {
						// Self-delete — either we resolved the sender as
						// the caller, or we couldn't resolve at all and
						// are trusting the caller's implicit claim.  In
						// the latter case Synapse will reject the redact
						// if they're lying, which we map to 403 below.
						kind = "self";
						bearerForRedact = token;
						// Pin senderId for the audit row.
						senderId = userId;
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
						// If we trusted the caller's self-claim because
						// we couldn't see the room (E2EE DM, etc.) and
						// Synapse rejected, the most likely reason is
						// that the caller wasn't actually the sender —
						// surface as 403 so the dialog reads correctly.
						if (senderUnverified) {
							return json({
								errcode: "M_FORBIDDEN",
								error: "you can only delete your own messages",
							}, { status: 403 });
						}
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

			// ─── Bot kick/ban/remove from a space ───────────────────
			// POST /api/spaces/:spaceId/bots/:botMxid/kick
			// POST /api/spaces/:spaceId/bots/:botMxid/ban
			//
			// Space-wide bot moderation: silence a bot across the
			// space and every joinable child room in one call,
			// instead of walking every channel manually.  Two
			// authorization paths:
			//
			//   1. Space FOUNDER — uses the founder's bearer with
			//      Matrix's PL-based kick/ban.  Rooms the founder
			//      doesn't have PL 100 in (e.g. an "Add existing
			//      room" link with a different creator) are logged
			//      + skipped, best-effort across the cascade.  Both
			//      `kick` and `ban` are supported.
			//
			//   2. Bot OWNER (when not also the space founder) —
			//      the owner has no PL in a foreign space, so we
			//      can't PL-kick.  Instead, we issue a voluntary
			//      /leave under the BOT's own bearer for each room
			//      — same end state, valid authorization.  Only
			//      `kick` (semantically "remove my bot") is allowed
			//      via this path; `ban` is space-founder-only since
			//      it dictates the space's ban list.
			//
			// Mod-log entries are recorded per affected room so the
			// audit trail mirrors what would have happened if each
			// action had been issued in-room.
			{
				const m = path.match(/^\/api\/spaces\/([^/]+)\/bots\/([^/]+)\/(kick|ban)$/);
				if (req.method === "POST" && m) {
					const token = extractToken(req);
					const userId = await whoami(token);
					if (!userId || !token) {
						return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
					}
					const spaceId = decodeURIComponent(m[1]!);
					const botMxid = decodeURIComponent(m[2]!);
					const action = m[3] as "kick" | "ban";

					// Confirm target IS a space; the per-room endpoint
					// below handles non-space rooms.
					try {
						if (!(await isSpaceRoom(spaceId))) {
							return json({ errcode: "M_INVALID_PARAM", error: "target is not a space" }, { status: 400 });
						}
					} catch {
						return json({ errcode: "M_NOT_FOUND", error: "space not found" }, { status: 404 });
					}

					const spaceState = await getRoomNameAndCreator(spaceId);
					if (!spaceState || !spaceState.creator) {
						return json({ errcode: "M_NOT_FOUND", error: "space not found" }, { status: 404 });
					}

					const bot = getBotByMxid(botMxid);
					if (!bot) {
						return json({
							errcode: "M_FORBIDDEN",
							error: "target is not a bot on this instance",
						}, { status: 403 });
					}

					const isSpaceFounder = spaceState.creator === userId;
					const isBotOwner = bot.owner_id === userId;
					if (!isSpaceFounder && !isBotOwner) {
						return json({
							errcode: "M_FORBIDDEN",
							error: "only the space founder or the bot's owner can remove a bot from the space",
						}, { status: 403 });
					}
					// Bot owners (who aren't the space founder) can only
					// remove their bot; banning would require space PL
					// they don't have, and dictating someone else's ban
					// list isn't theirs to do.
					if (!isSpaceFounder && action === "ban") {
						return json({
							errcode: "M_FORBIDDEN",
							error: "only the space founder can ban a bot from the space; you can remove your bot instead",
						}, { status: 403 });
					}

					// Targets: the space itself, then every declared
					// child room.  Including the space matters for
					// ban (the bot might be a direct space member
					// even if it's never in any child).  Leave/kick
					// on a room the bot isn't in just no-ops at
					// Synapse (or returns 403 "not in room" which we
					// treat as success); ban on a not-yet-member is
					// forward-looking and blocks future joins.
					const childIds = await getSpaceChildRoomIds(spaceId).catch(() => [] as string[]);
					const targets = [spaceId, ...childIds];

					// Pick the authorization strategy.  Space founders
					// PL-kick/ban under their own bearer; bot owners
					// use the BOT's own bearer to /leave each room.
					const useOwnerLeave = !isSpaceFounder && isBotOwner;
					const botBearer = useOwnerLeave ? openSecret(bot.access_token_enc) : null;

					let succeeded = 0;
					let failed = 0;
					for (const roomId of targets) {
						let ok: boolean;
						if (useOwnerLeave && botBearer) {
							ok = await leaveRoomAs({
								bearerToken: botBearer,
								roomId,
								reason: "owner_removed_bot_from_space",
							});
						} else {
							ok = await kickOrBanAs({
								bearerToken: token,
								roomId,
								targetUserId: botMxid,
								kind: action,
								reason: action === "kick"
									? "founder_kick_bot_space"
									: "founder_ban_bot_space",
							});
						}
						if (ok) {
							succeeded++;
							recordBotMembershipAction({
								roomId,
								botMxid,
								botOwner: bot.owner_id,
								action,
								founder: userId,
							});
						} else {
							failed++;
						}
					}
					return json({ ok: true, action, succeeded, failed, total: targets.length });
				}
			}

			// POST /api/rooms/:roomId/bots/:botMxid/kick
			// POST /api/rooms/:roomId/bots/:botMxid/ban
			//
			// Per-room kick/ban.  Retained for non-space rooms +
			// programmatic callers that want surgical action on
			// one room.  The space-wide endpoint above is what the
			// SPA wires to the profile-sheet button now.
			//
			// Bots aren't people: the room's founder can silence a
			// misbehaving / spammy bot unilaterally.
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
						// founder — humans must go through standard
						// admin moderation, full stop.
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

			// Admin-only debug: test the stored Klipy key by hitting
			// trending and returning the upstream status + body + the
			// URL it sent (with the api_key masked).  Lets the admin
			// see exactly what Klipy says without grepping engine logs.
			if (req.method === "GET" && path === "/api/instance/klipy-test") {
				const auth = await requireAdmin(req);
				if (auth instanceof Response) return auth;
				const apiKey = readInstanceConfig()["klipy_api_key"]?.trim();
				if (!apiKey) {
					return json({ ok: false, error: "no_key_configured" });
				}
				// Klipy embeds the API key in the URL path: /api/v1/{KEY}/gifs/trending
				const upstream = new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(apiKey)}/gifs/trending`);
				upstream.searchParams.set("per_page", "1");
				const masked = `${apiKey.slice(0, 4)}…${apiKey.slice(-4)} (length=${apiKey.length})`;
				try {
					const r = await fetch(upstream);
					const body = await r.text();
					return json({
						ok: r.ok,
						status: r.status,
						key_preview: masked,
						url: upstream.toString().replace(encodeURIComponent(apiKey), "***"),
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

			// Auth-only: report which integrations are configured (by
			// presence of their credential, not its value).  The value
			// itself is never returned over the wire; the admin form
			// uses this to render "Configured / Not configured" badges
			// next to a write-only input, AND every member's client
			// uses it to gate composer affordances (the GIF picker
			// only renders when Giphy is configured).  Any logged-in
			// member is allowed since they need the answer to render
			// their own UI; the key remains write-only via the admin
			// PUT endpoint.
			if (req.method === "GET" && path === "/api/instance/integrations") {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const cfg = readInstanceConfig();
				return json({
					integrations: {
						klipy: { configured: !!cfg["klipy_api_key"] },
						// Turnstile counts as configured only when BOTH
						// keys are set — neither half on its own is
						// usable, so the admin form should report it
						// honestly.
						turnstile: {
							configured: !!cfg["turnstile_site_key"] && !!cfg["turnstile_secret_key"],
						},
					},
				});
			}

			// ─── Klipy proxy (GIFs / clips / stickers) ───────────────
			// Forwards search / trending requests to Klipy's API using
			// the instance-wide API key from instance_config.  Keeps
			// the key server-side (never sent to clients).  Returns
			// 503 when the key isn't configured so the SPA can hide
			// the media picker.  Auth: any logged-in user, Klipy
			// requests aren't free so we gate on a valid Matrix
			// access token to avoid unauthenticated clients burning
			// the quota.
			//
			// Endpoints:
			//   GET /api/klipy/trending?kind=gif|sticker|clip
			//   GET /api/klipy/search?kind=gif|sticker|clip&q=...
			//
			// Klipy embeds the API key in the URL PATH instead of as a
			// query param (the Giphy/Tenor convention).  Their
			// endpoints are also per-kind: /gifs/trending,
			// /stickers/trending, /clips/trending.  Engine bridges
			// both differences so the SPA gets one uniform shape:
			// { results: [{ id, kind, title, preview_url,
			// preview_blur, full_url, full_mp4_url, full_webp_url,
			// width, height, mime_type }] }
			if (req.method === "GET" && (path === "/api/klipy/search" || path === "/api/klipy/trending")) {
				const userId = await whoami(extractToken(req));
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const apiKey = readInstanceConfig()["klipy_api_key"]?.trim();
				if (!apiKey) return json({ errcode: "M_NOT_FOUND", error: "klipy_not_configured" }, { status: 503 });
				const params = new URL(req.url).searchParams;
				const kindRaw = (params.get("kind") ?? "gif").toLowerCase();
				const kindToPath: Record<string, "gifs" | "stickers" | "clips"> = {
					gif: "gifs",
					sticker: "stickers",
					clip: "clips",
				};
				const kindPath = kindToPath[kindRaw];
				if (!kindPath) {
					return json({ errcode: "M_INVALID_PARAM", error: "kind must be gif, sticker, or clip" }, { status: 400 });
				}
				// Clamp per_page to Klipy's accepted range (min 8, max 50,
				// default 24).  Same as Giphy's `limit` cap.
				const perPage = Math.max(8, Math.min(50, parseInt(params.get("limit") ?? "24", 10) || 24));
				// pg-13 by default to keep the picker chat-appropriate;
				// admin could lift this to a tunable later.
				const rating = "pg-13";
				const action = path === "/api/klipy/search" ? "search" : "trending";
				const upstream = new URL(
					`https://api.klipy.com/api/v1/${encodeURIComponent(apiKey)}/${kindPath}/${action}`,
				);
				upstream.searchParams.set("per_page", String(perPage));
				upstream.searchParams.set("rating", rating);
				if (action === "search") {
					const q = (params.get("q") ?? "").trim();
					if (!q) return json({ errcode: "M_INVALID_PARAM", error: "q required" }, { status: 400 });
					upstream.searchParams.set("q", q);
				}
				try {
					const r = await fetch(upstream);
					if (!r.ok) {
						const detail = await r.text().catch(() => "");
						return json(
							{
								errcode: "M_UNKNOWN",
								error: `klipy_upstream_${r.status}`,
								detail: detail.slice(0, 500),
							},
							{ status: 502 },
						);
					}
					// Klipy returns TWO different item shapes depending
					// on the media kind:
					//
					//   Tiered (gifs, presumably stickers): `file` is
					//   nested by size tier and format, dimensions live
					//   INSIDE each format object.
					//     file: { hd|md|sm|xs: { gif|webp|jpg|mp4|webm: { url, width, height, size } } }
					//     id is a numeric int
					//
					//   Flat (clips today; possibly more later): `file`
					//   is a single object mapping format → URL string,
					//   with a sibling `file_meta` carrying dimensions
					//   per format.  No size tiers.  No numeric id at
					//   all, slug is the only stable handle.
					//     file:      { mp4: <url>, gif: <url>, webp: <url> }
					//     file_meta: { mp4: { width, height, size }, ... }
					//
					// Detect the shape per item by probing for an object
					// `file.md` (tiered) vs a string `file.mp4` (flat).
					// Normalized output is identical either way:
					//   { id, kind, title, preview_url, preview_blur,
					//     full_url, full_mp4_url, full_webp_url,
					//     width, height, mime_type }
					interface TieredFormat { url?: string; width?: number; height?: number; size?: number }
					interface TieredTier { gif?: TieredFormat; webp?: TieredFormat; jpg?: TieredFormat; mp4?: TieredFormat; webm?: TieredFormat }
					interface FlatMeta { width?: number; height?: number; size?: number }
					interface KlipyItem {
						id?: number | string;
						slug?: string;
						title?: string;
						type?: string;
						blur_preview?: string;
						file?:
							| { hd?: TieredTier; md?: TieredTier; sm?: TieredTier; xs?: TieredTier }
							| { mp4?: string; gif?: string; webp?: string; jpg?: string };
						file_meta?: { mp4?: FlatMeta; gif?: FlatMeta; webp?: FlatMeta; jpg?: FlatMeta };
					}
					const raw = await r.json() as {
						result?: boolean;
						data?: { data?: KlipyItem[] };
					};
					const items = raw.data?.data ?? [];
					const results = items.flatMap(item => {
						if (!item.file) return [];
						// Stable id: prefer numeric id when present;
						// fall back to slug (clips have no numeric id).
						const id = item.id != null ? String(item.id) : (item.slug ?? "");
						if (!id) return [];

						const fileAny = item.file as Record<string, unknown>;
						const isTiered =
							(typeof fileAny.md === "object" && fileAny.md !== null) ||
							(typeof fileAny.sm === "object" && fileAny.sm !== null) ||
							(typeof fileAny.hd === "object" && fileAny.hd !== null);

						let previewUrl: string | undefined;
						let fullUrl: string | undefined;
						let fullMp4Url: string | null = null;
						let fullWebpUrl: string | null = null;
						let width = 0;
						let height = 0;
						const isClip = kindRaw === "clip";
						const isSticker = kindRaw === "sticker";

						if (isTiered) {
							const tiered = item.file as { hd?: TieredTier; md?: TieredTier; sm?: TieredTier };
							const sm = tiered.sm ?? {};
							const md = tiered.md ?? {};
							previewUrl = sm.webp?.url ?? sm.gif?.url ?? sm.jpg?.url;
							if (isSticker) {
								// Stickers prefer webp at md tier so
								// transparency is preserved; gif fallback
								// when md.webp is absent.
								fullUrl = md.webp?.url ?? md.gif?.url;
							} else if (isClip) {
								fullUrl = md.mp4?.url;
							} else {
								fullUrl = md.gif?.url;
							}
							fullMp4Url = md.mp4?.url ?? null;
							fullWebpUrl = md.webp?.url ?? null;
							const dimSource = isClip
								? md.mp4
								: isSticker
									? (md.webp ?? md.gif)
									: md.gif;
							width = dimSource?.width ?? 0;
							height = dimSource?.height ?? 0;
						} else {
							// Flat shape: clips today, possibly stickers
							// or other kinds later if Klipy reshapes.
							const flat = item.file as { mp4?: string; gif?: string; webp?: string; jpg?: string };
							const meta = item.file_meta ?? {};
							previewUrl = flat.webp ?? flat.gif ?? flat.jpg;
							if (isSticker) {
								fullUrl = flat.webp ?? flat.gif;
							} else if (isClip) {
								fullUrl = flat.mp4;
							} else {
								fullUrl = flat.gif;
							}
							fullMp4Url = flat.mp4 ?? null;
							fullWebpUrl = flat.webp ?? null;
							const dimSource = isClip
								? meta.mp4
								: isSticker
									? (meta.webp ?? meta.gif)
									: meta.gif;
							width = dimSource?.width ?? 0;
							height = dimSource?.height ?? 0;
						}

						if (!previewUrl || !fullUrl) return [];

						const mimeType = isClip
							? "video/mp4"
							: isSticker
								? "image/webp"
								: "image/gif";

						return [{
							id,
							kind: kindRaw,
							title: item.title ?? "",
							preview_url: previewUrl,
							preview_blur: item.blur_preview ?? null,
							full_url: fullUrl,
							full_mp4_url: fullMp4Url,
							full_webp_url: fullWebpUrl,
							width,
							height,
							mime_type: mimeType,
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

			// ─── People directory ────────────────────────────────────
			// Public listing of discoverable users for the Explore
			// People tab.  Returns engine-side profile data; the
			// client resolves Matrix display names + avatars.
			if (req.method === "GET" && path === "/api/users/directory") {
				const params = url.searchParams;
				const q = params.get("q")?.trim() || undefined;
				const limit = Math.min(Math.max(parseInt(params.get("limit") ?? "50", 10) || 50, 1), 100);
				const offset = Math.max(parseInt(params.get("offset") ?? "0", 10) || 0, 0);
				const rows = listDiscoverableUsers({ query: q, limit, offset });
				const users = rows.map(r => ({
					user_id: r.user_id,
					bio: r.bio,
					founder_number: r.founder_number ?? null,
					social_links: (() => { try { return JSON.parse(r.social_links); } catch { return []; } })(),
					banner_mxc: r.banner_mxc || null,
				}));
				return json({ users, total: countDiscoverableUsers() });
			}

			// ─── User profiles (bios) ────────────────────────────────
			// Bios live in a public engine table because Matrix's profile
			// API doesn't include a public bio field — account_data is
			// owner-private, so we'd have no way to surface them in
			// the DM panel or member sheet otherwise.

			// Public read: anyone can fetch anyone's bio.  Empty string
			// when never set (so the response shape is uniform).
			// Includes `founder_number` (1-666) for users who claimed
			// a Founder slot, or null otherwise — drives the
			// holographic Founder badge on the profile sheet.
			if (req.method === "GET" && path.startsWith("/api/profile/")) {
				const userId = decodeURIComponent(path.slice("/api/profile/".length));
				if (!userId) return json({ errcode: "M_INVALID_PARAM", error: "user_id" }, { status: 400 });
				return json({
					user_id: userId,
					bio: readBio(userId) ?? "",
					founder_number: getFounderNumber(userId),
					social_links: readSocialLinks(userId),
					banner_mxc: readBanner(userId),
					discoverable: readDiscoverable(userId),
				});
			}

			// Bulk Founders roster — full ordered list of (user_id,
			// founder_number) pairs.  Cheap: at most FOUNDER_CAP_PUBLIC
			// rows of two short fields each (~30KB worst case).  The
			// client fetches this once on boot and caches it locally,
			// then renders inline Founder badges in chat / member lists
			// from the local Map without per-message round trips.
			if (req.method === "GET" && path === "/api/founders") {
				return json({
					founders: listFounders(),
					cap: FOUNDER_CAP_PUBLIC,
				});
			}

			// Owner-only write: requires a Matrix token, updates bio,
			// social links and/or banner for whichever user that token
			// belongs to.  At least one of `bio`, `social_links` or
			// `banner_mxc` must be present.  Empty bio string clears the
			// bio; empty social_links array clears all links; empty
			// banner_mxc clears the banner.
			if (req.method === "PUT" && path === "/api/profile/me") {
				const token = extractToken(req);
				const userId = await whoami(token);
				if (!userId) return json({ errcode: "M_FORBIDDEN", error: "invalid token" }, { status: 401 });
				const body = (await req.json().catch(() => null)) as
					{ bio?: string; social_links?: unknown; banner_mxc?: unknown; discoverable?: unknown } | null;
				if (!body || (typeof body.bio !== "string" && !Array.isArray(body.social_links) && typeof body.banner_mxc !== "string" && typeof body.discoverable !== "boolean")) {
					return json({ errcode: "M_BAD_JSON", error: "bio, social_links, banner_mxc or discoverable required" }, { status: 400 });
				}
				// Clearing the bio writes an empty string rather than
				// deleting the row — the row also carries social_links
				// and banner_mxc, so deleting it would silently drop
				// those alongside the bio.
				if (typeof body.bio === "string") {
					writeBio(userId, body.bio.slice(0, 300));
				}
				if (Array.isArray(body.social_links)) {
					const VALID_PLATFORMS = new Set([
						"bluesky", "cashapp", "discord", "email", "github", "gitlab",
						"instagram", "linktree", "mastodon", "matrix", "reddit", "signal",
						"snapchat", "soundcloud", "spotify", "telegram", "tiktok", "twitch",
						"website", "whatsapp", "x", "youtube",
					]);
					const cleaned = (body.social_links as unknown[])
						.filter((l): l is SocialLink =>
							typeof l === "object" && l !== null
							&& typeof (l as SocialLink).platform === "string"
							&& typeof (l as SocialLink).url === "string"
							&& VALID_PLATFORMS.has((l as SocialLink).platform)
							&& (l as SocialLink).url.length > 0
							&& (l as SocialLink).url.length <= 500,
						)
						.slice(0, 8);
					writeSocialLinks(userId, cleaned);
				}
				if (typeof body.banner_mxc === "string") {
					const banner = body.banner_mxc.trim();
					if (banner !== "" && (!banner.startsWith("mxc://") || banner.length > 255)) {
						return json({ errcode: "M_INVALID_PARAM", error: "banner_mxc" }, { status: 400 });
					}
					writeBanner(userId, banner);
				}
				if (typeof body.discoverable === "boolean") {
					writeDiscoverable(userId, body.discoverable);
				}
				return json({
					user_id: userId,
					bio: readBio(userId) ?? "",
					social_links: readSocialLinks(userId),
					banner_mxc: readBanner(userId),
					discoverable: readDiscoverable(userId),
				});
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
				const newSpaceChildren: { spaceId: string; childId: string; sender: string }[] = [];
				// Newly-joined-a-room events for LOCAL users.  We collect
				// every `m.room.member` join for a user on our homeserver
				// here and post-loop filter for the ones that landed in a
				// space (so non-space joins don't pay an isSpaceRoom
				// round-trip).  When a user joins a space we cascade
				// admin-joins to every joinable child room, mirroring
				// the symmetric "new child → existing members" cascade
				// in newSpaceChildren below.
				const newSpaceJoiners: { userId: string; roomId: string }[] = [];
				const localSuffix = `:${config.homeserverName}`;
				// Rooms we just learned about and haven't joined yet.
				// Eager-join @engine to every room with timeline
				// activity so it's present whenever we later need to
				// write into the room (repair-permissions, etc.).
				// joinRoomIfNeeded is idempotent
				// and DB-cached, so this is a no-op past the first
				// event per room.  We collect the unique room ids
				// here and fire the joins async after responding to
				// Synapse so /transactions stays snappy.
				const roomsToJoin = new Set<string>();
				for (const ev of events) {
					try {
						applyEvent(ev);
						if (ev.room_id) roomsToJoin.add(ev.room_id);
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
						// Collect local-user `m.room.member` joins.  Filter
						// down to spaces after the loop so we don't burn
						// an isSpaceRoom round-trip on every chat message's
						// m.room.member echo.
						if (
							ev.type === "m.room.member" &&
							ev.room_id &&
							typeof ev.state_key === "string" &&
							ev.state_key.startsWith("@") &&
							ev.state_key.endsWith(localSuffix) &&
							(ev.content as { membership?: string })?.membership === "join"
						) {
							newSpaceJoiners.push({
								userId: ev.state_key,
								roomId: ev.room_id,
							});
						}
					} catch (err) {
						console.error("engine: applyEvent failed", err, ev);
					}
				}
				// Flags surface in the admin review queue; there is no
				// engine-side evaluation here.
				// Eager engine-bot joins.  Fire-and-forget so the
				// transaction response goes back to Synapse without
				// waiting on the join round-trips.  Public rooms
				// succeed; private rooms 403 (no invite) and the
				// helper marks them as "tried" in the joined_rooms
				// cache so we don't retry on every subsequent event.
				if (roomsToJoin.size > 0) {
					void (async () => {
						for (const rid of roomsToJoin) {
							try {
								await joinRoomIfNeeded(rid);
							} catch (err) {
								console.warn(`engine: eager-join ${rid} threw`, err);
							}
						}
					})();
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
								// getAllJoinedMembers (not getJoinedMembers)
								// because the cascade needs to include
								// bots: a space's bots should land in
								// every new child room the same way human
								// members do, otherwise creating a room
								// in a space silently leaves the bots
								// out and users have to re-invite them
								// per-room.  The engine appservice user
								// is still excluded inside the helper.
								const members = await getAllJoinedMembers(spaceId);
								const localSuffix = `:${config.homeserverName}`;
								// Filter to the actual targets up-front so
								// the duration log + ok/err tallies reflect
								// real work rather than skipped no-ops.
								const targets = members.filter(
									userId => userId.endsWith(localSuffix) && userId !== sender,
								);
								if (targets.length === 0) continue;
								const startedAt = Date.now();
								let okCount = 0;
								let errCount = 0;
								// Concurrency 8.  See poolAll's comment for
								// why we don't fire all-N in parallel.
								// admin/v1/join can't cross-federate, so
								// federated members get auto-joined by
								// their own homeserver's engine processing
								// the same m.space.child event.
								await poolAll(targets, 8, async userId => {
									const result = await adminJoinUserToRoom(userId, childId);
									if ("error" in result) {
										errCount++;
										// Log per-user failures but don't
										// abort — getting most members in is
										// better than rolling back any.
										console.warn(
											`engine: auto-join ${userId} → ${childId} failed:`,
											result.error,
											result.detail ?? "",
										);
									} else {
										okCount++;
									}
								});
								console.log(
									`engine: cascade fan-out room=${childId} members=${targets.length} ok=${okCount} err=${errCount} duration=${Date.now() - startedAt}ms`,
								);
							} catch (err) {
								console.error(
									`engine: auto-join cascade for child=${childId} parent=${spaceId} failed`,
									err,
								);
							}
						}
					})();
				}
				// Discord-style: when a local user joins a SPACE (not a
				// regular room), force-join them to every joinable child
				// room.  Mirror of the newSpaceChildren cascade above —
				// that one fanned out "new child → existing members",
				// this one fans out "new member → existing children".
				// Together they guarantee that every member of a space
				// ends up in every joinable child regardless of which
				// event arrived first, regardless of client-side timing.
				//
				// The pre-this-change flow relied on the joining client
				// to call joinSpaceWithChildren after joining the space.
				// That worked when the user used Explore (which calls
				// joinSpaceWithChildren explicitly), but the new deep-
				// link confirm-sheet path on a private space races the
				// Synapse membership commit and child-room restricted-
				// join checks — leaving the user in the space with zero
				// rooms, which is what the user reported.
				//
				// Engine-side cascade is reliable because the m.room.member
				// event only reaches us after Synapse fully committed
				// the parent membership, so every subsequent admin-join
				// to a restricted child succeeds.
				if (newSpaceJoiners.length > 0) {
					void (async () => {
						for (const { userId, roomId } of newSpaceJoiners) {
							try {
								// Only cascade for spaces — regular room joins
								// fall through with no extra work.  Sub-spaces
								// inside a space are ALSO m.space, so a user
								// joining a top-level space won't have their
								// sub-space children auto-cascaded; matches
								// the joinSpaceWithChildren rule (sub-spaces
								// stay explicit opt-in).
								const isSpace = await isSpaceRoom(roomId);
								if (!isSpace) continue;
								const childIds = await getSpaceChildRoomIds(roomId);
								console.log(
									`engine: space-join cascade — user=${userId} space=${roomId} children=${childIds.length}`,
								);
								const startedAt = Date.now();
								let okCount = 0;
								let errCount = 0;
								let skipCount = 0;
								await poolAll(childIds, 8, async childId => {
									try {
										// Skip sub-spaces — same rule as
										// newSpaceChildren above.
										if (await isSpaceRoom(childId)) {
											skipCount++;
											return;
										}
										// Only auto-join rooms with rules
										// that make sense for a cascade.
										// Public + knock + restricted all
										// resolve cleanly via admin-join;
										// invite-only children stay invite-
										// gated and require an explicit
										// invitation.
										const rule = await getRoomJoinRule(childId);
										if (rule !== "public" && rule !== "knock" && rule !== "restricted") {
											skipCount++;
											return;
										}
										const result = await adminJoinUserToRoom(userId, childId);
										if ("error" in result) {
											errCount++;
											console.warn(
												`engine: space-join cascade ${userId} → ${childId} failed:`,
												result.error,
												result.detail ?? "",
											);
										} else {
											okCount++;
										}
									} catch (err) {
										errCount++;
										console.warn(
											`engine: space-join cascade child=${childId} failed`,
											err,
										);
									}
								});
								console.log(
									`engine: space-join cascade done user=${userId} space=${roomId} ok=${okCount} err=${errCount} skip=${skipCount} duration=${Date.now() - startedAt}ms`,
								);
							} catch (err) {
								console.error(
									`engine: space-join cascade for user=${userId} space=${roomId} failed`,
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

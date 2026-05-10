// Engine HTTP client for the bot platform.  Mirrors the shape of
// `lib/instance.ts`: thin fetch wrappers that throw on non-2xx, with
// the caller passing in the user's Matrix access token (the engine
// runs whoami against Synapse to identify the owner).
//
// All endpoints here scope to the calling user as the bot owner —
// the engine rejects cross-owner reads / writes.  See
// engine/src/server.ts for the auth check.

import { ENGINE_URL } from "@/lib/urls";

export type BotProvider = "openrouter" | "openai_compatible";

/**
 * Public bot summary — the secret-free view returned by
 * GET /api/bots/me, POST /api/bots, PATCH /api/bots/:id.
 *
 * `has_api_key` is a sentinel: `true` once an API key is set on the
 * row.  The actual key never leaves the engine — the edit form
 * shows `•••••` and only sends a new key when the user explicitly
 * replaces it.
 */
export interface BotSummary {
	id: number;
	mxid: string;
	owner_id: string;
	display_name: string;
	avatar_mxc: string | null;
	provider: BotProvider;
	api_base: string;
	model: string;
	system_prompt: string;
	context_window: number;
	/** Spending guardrails.  All three default to 0 = unlimited. */
	max_tokens_per_reply: number;
	daily_token_limit: number;
	daily_call_limit: number;
	enabled: boolean;
	created_at: number;
	total_prompt_tokens: number;
	total_completion_tokens: number;
	total_calls: number;
	last_used_at: number | null;
	has_api_key: boolean;
	/** Public bio, the same field humans get on their profile.  Stored
	 * in the engine's `user_profiles` table keyed by the bot's mxid;
	 * displayed verbatim in the profile sheet other members see. */
	bio: string;
	/** Privacy gate.  When false, the bot leaves any DM-shaped invite
	 * it receives from anyone other than its owner.  Group-room
	 * invites are gated separately at the engine — only the owner
	 * can pull a bot into a group room, regardless of this flag. */
	accept_dms: boolean;
}

export interface BotCreateRequest {
	name: string;
	display_name: string;
	provider: BotProvider;
	api_base: string;
	api_key: string;
	model: string;
	system_prompt?: string;
	context_window?: number;
	/** Optional public bio.  Capped at 300 chars server-side; empty
	 * string skips the write. */
	bio?: string;
	/** Spending guardrails.  Omit (or 0) for unlimited. */
	max_tokens_per_reply?: number;
	daily_token_limit?: number;
	daily_call_limit?: number;
}

export interface BotPatchRequest {
	display_name?: string;
	provider?: BotProvider;
	api_base?: string;
	// New API key in plaintext.  Sent ONLY when the user explicitly
	// replaces the key — leave undefined to keep the existing one.
	api_key?: string;
	model?: string;
	system_prompt?: string;
	context_window?: number;
	enabled?: boolean;
	/** Replace the public bio.  Empty string clears.  `undefined` (or
	 * field omitted) leaves the existing bio alone. */
	bio?: string;
	/** Spending guardrails — same shape as create.  0 means unlimited. */
	max_tokens_per_reply?: number;
	daily_token_limit?: number;
	daily_call_limit?: number;
	/** Toggle for the DM privacy gate.  Sending the field at all
	 * (true OR false) writes through; omitting it leaves the
	 * existing value alone. */
	accept_dms?: boolean;
}

export interface BotsListResponse {
	bots: BotSummary[];
}

export interface BotResponse {
	bot: BotSummary;
}

export interface BotApiError {
	error: string;
	detail?: string;
}

/**
 * Internal helper: post body, parse JSON, throw a descriptive error on
 * non-2xx so callers can surface a sensible message to the user.
 */
async function callEngine<T>(
	path: string,
	accessToken: string,
	init: RequestInit = {},
): Promise<T> {
	const r = await fetch(`${ENGINE_URL}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			...(init.headers ?? {}),
		},
	});
	let body: unknown;
	const text = await r.text();
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { error: "bad_json", detail: text.slice(0, 200) };
	}
	if (!r.ok) {
		const err = body as BotApiError;
		const msg = err.detail ?? err.error ?? `HTTP ${r.status}`;
		throw new Error(msg);
	}
	return body as T;
}

export async function listMyBots(accessToken: string): Promise<BotSummary[]> {
	const body = await callEngine<BotsListResponse>("/api/bots/me", accessToken);
	return body.bots ?? [];
}

/** Public-safe slice of a bot row, keyed by Matrix id.  Returned by
 * `GET /api/bots/by-mxid/:mxid` — readable by any caller, used by
 * the profile sheet's "Created by" credit row.  Distinct from
 * BotSummary: no usage stats, no provider config, no spending
 * guardrails, no api-key sentinel.  Just the fields a third-party
 * viewer is allowed to see. */
export interface PublicBotInfo {
	mxid: string;
	owner_id: string;
	display_name: string;
	avatar_mxc: string | null;
	bio: string;
	created_at: number;
	/** Whether this bot accepts DM invites from non-owners.  When
	 * false the profile sheet hides the Message button so users
	 * don't fire a DM that the bot will silently auto-leave. */
	accept_dms: boolean;
}

/** Fetch a bot's public-facing info by mxid.  Unauthenticated — the
 * engine endpoint is intentionally open since bot ownership is
 * publicly attributable (same as Discord/Slack bot developer
 * credits).  Throws on non-2xx like the rest of this module; callers
 * should treat 404 as "not a registered bot" and skip the credit
 * row. */
export async function getPublicBotInfo(mxid: string): Promise<PublicBotInfo | null> {
	const r = await fetch(
		`${ENGINE_URL}/api/bots/by-mxid/${encodeURIComponent(mxid)}`,
		{ headers: { "Content-Type": "application/json" } },
	);
	if (r.status === 404) return null;
	const text = await r.text();
	let body: unknown = {};
	try { body = text ? JSON.parse(text) : {}; } catch { /* keep raw */ }
	if (!r.ok) {
		const err = body as BotApiError;
		throw new Error(err.detail ?? err.error ?? `HTTP ${r.status}`);
	}
	return (body as { bot: PublicBotInfo }).bot;
}

export async function createBot(
	accessToken: string,
	req: BotCreateRequest,
): Promise<BotSummary> {
	const body = await callEngine<BotResponse>("/api/bots", accessToken, {
		method: "POST",
		body: JSON.stringify(req),
	});
	return body.bot;
}

export async function patchBot(
	accessToken: string,
	id: number,
	patch: BotPatchRequest,
): Promise<BotSummary> {
	const body = await callEngine<BotResponse>(`/api/bots/${id}`, accessToken, {
		method: "PATCH",
		body: JSON.stringify(patch),
	});
	return body.bot;
}

export async function deleteBot(accessToken: string, id: number): Promise<void> {
	await callEngine<{ ok: true }>(`/api/bots/${id}`, accessToken, {
		method: "DELETE",
	});
}

/** Upload an avatar image for a bot.  The engine forwards the bytes
 * to Synapse's media repo authenticated as the bot, sets the bot's
 * `avatar_url` profile field, and updates `bots.avatar_mxc`.  Returns
 * the updated bot summary so the caller can re-render. */
export async function uploadBotAvatar(
	accessToken: string,
	id: number,
	file: File,
): Promise<BotSummary> {
	// Same image-sanitiser the chat-attachment + room/space avatar
	// paths run: HEIC inputs come out as PNG, EXIF-bearing JPEG/PNG
	// come out re-encoded.  Lazy-imported so the heic-to bundle only
	// downloads when someone actually picks a HEIC.
	const { sanitizeImageForUpload } = await import("@/lib/imageSanitize");
	const sanitized = await sanitizeImageForUpload(file);
	const form = new FormData();
	form.append("file", sanitized);
	const r = await fetch(`${ENGINE_URL}/api/bots/${id}/avatar`, {
		method: "POST",
		headers: {
			// IMPORTANT: don't set Content-Type — the browser fills it
			// in with the multipart boundary parameter.  Hardcoding
			// "multipart/form-data" without the boundary breaks the
			// upload silently with a 400.
			Authorization: `Bearer ${accessToken}`,
		},
		body: form,
	});
	const text = await r.text();
	let body: unknown = {};
	try { body = text ? JSON.parse(text) : {}; } catch { /* keep raw */ }
	if (!r.ok) {
		const err = body as BotApiError;
		throw new Error(err.detail ?? err.error ?? `HTTP ${r.status}`);
	}
	return (body as BotResponse).bot;
}

/** Clear the avatar — Synapse profile reset + null in the DB. */
export async function removeBotAvatar(
	accessToken: string,
	id: number,
): Promise<BotSummary> {
	const body = await callEngine<BotResponse>(`/api/bots/${id}/avatar`, accessToken, {
		method: "DELETE",
	});
	return body.bot;
}

// ─── Knowledge files ───────────────────────────────────────────────

export interface BotKnowledgeFile {
	id: number;
	bot_id: number;
	filename: string;
	bytes: number;
	uploaded_at: number;
}

export interface BotKnowledgeListResponse {
	files: BotKnowledgeFile[];
	total_bytes: number;
}

export async function listBotKnowledge(
	accessToken: string,
	id: number,
): Promise<BotKnowledgeListResponse> {
	return callEngine<BotKnowledgeListResponse>(`/api/bots/${id}/knowledge`, accessToken);
}

/** Upload a single knowledge file (.txt, .md, .docx, etc.).  Engine
 * extracts plain text server-side; the returned metadata includes
 * the filename + size of the extracted text (which can differ from
 * the source file for parsed formats like .docx). */
export async function uploadBotKnowledge(
	accessToken: string,
	id: number,
	file: File,
): Promise<BotKnowledgeFile> {
	const form = new FormData();
	form.append("file", file);
	const r = await fetch(`${ENGINE_URL}/api/bots/${id}/knowledge`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}` },
		body: form,
	});
	const text = await r.text();
	let body: unknown = {};
	try { body = text ? JSON.parse(text) : {}; } catch { /* keep raw */ }
	if (!r.ok) {
		const err = body as BotApiError;
		throw new Error(err.detail ?? err.error ?? `HTTP ${r.status}`);
	}
	return (body as { file: BotKnowledgeFile }).file;
}

export async function deleteBotKnowledge(
	accessToken: string,
	botId: number,
	fileId: number,
): Promise<void> {
	await callEngine<{ ok: true }>(`/api/bots/${botId}/knowledge/${fileId}`, accessToken, {
		method: "DELETE",
	});
}

// ─── Defaults ──────────────────────────────────────────────────────

/** Shared defaults the create form uses to pre-fill the provider's
 * common fields.  Empty model on openai_compatible because there is
 * no canonical default — the user supplies it. */
export const PROVIDER_DEFAULTS: Record<BotProvider, { api_base: string; model: string }> = {
	openrouter: {
		api_base: "https://openrouter.ai/api/v1",
		model: "google/gemini-3.1-flash-lite",
	},
	openai_compatible: {
		api_base: "",
		model: "",
	},
};

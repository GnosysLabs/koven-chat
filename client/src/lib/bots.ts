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
	enabled: boolean;
	created_at: number;
	total_prompt_tokens: number;
	total_completion_tokens: number;
	total_calls: number;
	last_used_at: number | null;
	has_api_key: boolean;
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

// ─── Defaults ──────────────────────────────────────────────────────

/** Shared defaults the create form uses to pre-fill the provider's
 * common fields.  Empty model on openai_compatible because there is
 * no canonical default — the user supplies it. */
export const PROVIDER_DEFAULTS: Record<BotProvider, { api_base: string; model: string }> = {
	openrouter: {
		api_base: "https://openrouter.ai/api/v1",
		// Leading "~" is OpenRouter's auto-route prefix — picks the
		// best available endpoint for this model alias.  Required
		// verbatim; without the tilde OpenRouter rejects with
		// "is not a valid model ID".
		model: "~google/gemini-flash-latest",
	},
	openai_compatible: {
		api_base: "",
		model: "",
	},
};

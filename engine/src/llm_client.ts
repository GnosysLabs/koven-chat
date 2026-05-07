// OpenAI-compatible chat completion client.
//
// Per the bot platform spec (chunk 3) every bot's response is a
// single, atomic call: we POST `${api_base}/chat/completions`, wait
// for the full response, and return the assistant text + usage
// counters.  No streaming.  Both supported providers — OpenRouter
// and "openai_compatible" custom endpoints — speak this shape, so
// one client handles both.
//
// Each call gets a generous-but-bounded timeout so a hung upstream
// can't keep the bot pinned indefinitely (the matrix-js-sdk timeline
// listener has no built-in concurrency cap).

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatCompletionRequest {
	apiBase: string;          // e.g. "https://openrouter.ai/api/v1"
	apiKey: string;           // bearer token (decrypted)
	model: string;            // e.g. "~google/gemini-flash-latest"
	messages: ChatMessage[];  // including system prompt as first entry, if any
	maxTokens?: number;       // optional cap; provider-default if unset
	timeoutMs?: number;       // default 60s
	provider: "openrouter" | "openai_compatible";
	// Surfaced in OpenRouter's analytics dashboard so the bot owner
	// can see which Koven instance is making the calls.  Harmless to
	// set on a vanilla OpenAI-compatible endpoint (most ignore
	// unknown headers).
	referer?: string;
	title?: string;
}

export interface ChatCompletionSuccess {
	ok: true;
	content: string;
	prompt_tokens: number;
	completion_tokens: number;
}

export interface ChatCompletionFailure {
	ok: false;
	error: string;     // short machine-readable code
	detail: string;    // human-readable detail (truncated upstream message)
	status?: number;   // upstream HTTP status if applicable
}

export type ChatCompletionResult = ChatCompletionSuccess | ChatCompletionFailure;

const DEFAULT_TIMEOUT_MS = 60_000;
// Cap how much of an upstream error body we relay.  The detail field
// gets logged + (eventually) shown in the bot owner's UI; we don't
// want a multi-MB HTML error page in there.
const MAX_DETAIL_CHARS = 400;

export async function chatCompletion(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
	const url = joinUrl(req.apiBase, "/chat/completions");

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"Authorization": `Bearer ${req.apiKey}`,
	};
	if (req.provider === "openrouter") {
		// OpenRouter shows these in its dashboard.  Required-ish for
		// good citizenship, optional in the API spec.
		if (req.referer) headers["HTTP-Referer"] = req.referer;
		if (req.title) headers["X-Title"] = req.title;
	}

	const body: Record<string, unknown> = {
		model: req.model,
		messages: req.messages,
		// Atomic — the bot platform deliberately doesn't stream.
		stream: false,
	};
	if (req.maxTokens && req.maxTokens > 0) body.max_tokens = req.maxTokens;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);

	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		if ((err as { name?: string }).name === "AbortError") {
			return { ok: false, error: "timeout", detail: `no response in ${req.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` };
		}
		return { ok: false, error: "network", detail: err instanceof Error ? err.message : String(err) };
	}
	clearTimeout(timer);

	const text = await res.text().catch(() => "");
	if (!res.ok) {
		// Try to surface the provider's error message in human-readable
		// form.  OpenAI-compatible errors are usually `{error: {message: "..."}}`.
		let detail = text.slice(0, MAX_DETAIL_CHARS);
		try {
			const json = JSON.parse(text) as { error?: { message?: string } };
			if (json.error?.message) detail = json.error.message.slice(0, MAX_DETAIL_CHARS);
		} catch {
			// Non-JSON body — keep the truncated raw text.
		}
		return { ok: false, error: "upstream_error", detail, status: res.status };
	}

	let parsed: {
		choices?: Array<{ message?: { content?: string } }>;
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { ok: false, error: "bad_response", detail: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
	}

	const content = parsed.choices?.[0]?.message?.content;
	if (typeof content !== "string" || content.length === 0) {
		return { ok: false, error: "empty_response", detail: "no choices[0].message.content in upstream response" };
	}

	return {
		ok: true,
		content,
		prompt_tokens: parsed.usage?.prompt_tokens ?? 0,
		completion_tokens: parsed.usage?.completion_tokens ?? 0,
	};
}

function joinUrl(base: string, path: string): string {
	const trimmedBase = base.replace(/\/+$/, "");
	const trimmedPath = path.replace(/^\/+/, "");
	return `${trimmedBase}/${trimmedPath}`;
}

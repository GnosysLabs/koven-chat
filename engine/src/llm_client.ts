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

/** OpenAI-shaped chat message.  `tool` role messages carry the
 * result of a tool invocation back into the conversation so the
 * model can see what its own tool call returned. */
export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	/** Present on assistant messages that requested tool invocations.
	 * The runtime echoes them back into history when handing tool
	 * results to the LLM (the SDK requires the assistant->tool pair
	 * to be adjacent for the IDs to resolve). */
	tool_calls?: AssistantToolCall[];
	/** Present on `tool` role messages — matches the id of the
	 * `tool_calls[i]` entry whose result this is. */
	tool_call_id?: string;
}

/** OpenAI tool-call shape — single function-style call the model
 * wants the runtime to execute. */
export interface AssistantToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		/** Stringified JSON of the arguments — OpenAI wraps it as
		 * a string even when the schema is structured. */
		arguments: string;
	};
}

/** OpenAI tool definition.  Matches the shape we already produce
 * in mcp/client.ts → listMcpTools, so MCP tool schemas pass
 * straight through. */
export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters: Record<string, unknown>;
	};
}

export interface ChatCompletionRequest {
	apiBase: string;          // e.g. "https://openrouter.ai/api/v1"
	apiKey: string;           // bearer token (decrypted)
	model: string;            // e.g. "~google/gemini-flash-latest"
	messages: ChatMessage[];  // including system prompt as first entry, if any
	/** Optional tool definitions the LLM may invoke.  When absent,
	 * the call behaves exactly as the no-tools v1 path. */
	tools?: ToolDefinition[];
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
	/** May be empty string when the model only responded with
	 * tool_calls and no user-facing text — the runtime treats that
	 * as "execute the tools, then loop back for the next turn". */
	content: string;
	/** Tool-invocation requests from the model.  Empty when the
	 * model produced a final text reply. */
	tool_calls: AssistantToolCall[];
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
	if (req.tools && req.tools.length > 0) {
		body.tools = req.tools;
		// "auto" lets the model decide whether to invoke a tool or
		// reply directly.  Default for OpenAI/OpenRouter when tools
		// are present, but explicit is clearer and shields against
		// future provider default-changes.
		body.tool_choice = "auto";
	}

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
		choices?: Array<{
			message?: {
				content?: string | null;
				tool_calls?: AssistantToolCall[];
			};
		}>;
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return { ok: false, error: "bad_response", detail: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
	}

	const message = parsed.choices?.[0]?.message;
	if (!message) {
		return { ok: false, error: "empty_response", detail: "no choices[0].message in upstream response" };
	}
	const content = typeof message.content === "string" ? message.content : "";
	const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

	// A response with neither text nor tool calls is a real failure —
	// either the provider returned an empty choice or stopped without
	// a reason.  Earlier behaviour rejected on missing `content`; the
	// new guard preserves that for the no-tools case while letting
	// tool-only responses through.
	if (content.length === 0 && toolCalls.length === 0) {
		return { ok: false, error: "empty_response", detail: "no content and no tool_calls in upstream response" };
	}

	return {
		ok: true,
		content,
		tool_calls: toolCalls,
		prompt_tokens: parsed.usage?.prompt_tokens ?? 0,
		completion_tokens: parsed.usage?.completion_tokens ?? 0,
	};
}

function joinUrl(base: string, path: string): string {
	const trimmedBase = base.replace(/\/+$/, "");
	const trimmedPath = path.replace(/^\/+/, "");
	return `${trimmedBase}/${trimmedPath}`;
}

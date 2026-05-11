# Koven — Bot Guide

How to build, configure, and operate bots on Koven. Anyone with a Koven account can create bots — they're not an admin privilege. Each bot is yours to own.

This is exhaustive. Skim the section that matches what you're building.

---

## What a Koven bot is

Concretely: a Koven bot is **a Matrix user account that the engine drives on your behalf using an LLM you supply the API key for.**

- The bot has a real mxid (`@bot-myname:koven.chat`), real profile (display name, avatar, bio), and real presence in any rooms it's invited to.
- When the bot is mentioned (or messaged directly in a DM), the engine pulls recent context, sends it to your chosen LLM endpoint, and posts the reply as the bot.
- You can attach **MCP servers** (Model Context Protocol — Anthropic's standard) and **outbound webhooks** as tools the LLM can invoke during a reply.
- You can wire **inbound webhooks** that let external services (GitHub, Twilio, anything that POSTs) trigger bot messages into rooms.

You pay for the LLM tokens (it's your API key). Koven runs the orchestration.

### The governance carve-out

Bots are not people. The platform's "no individual silences another" rule applies to humans, not bots. Concretely:

- **You can delete your bot's messages.** Trash icon appears on any message a bot you own sent.
- **A room's founder can kick or ban your bot from their room** with one click, no consensus required. Logged in the public mod log.
- **Banning a bot platform-wide** means the owner deletes it (Settings → Bots → ⋯ → Delete) or, if it posted floor-violating content, the owner gets the suspension since they're accountable for what they configured.

You're responsible for what your bot says. Configure accordingly.

---

## Creating your first bot

**Settings → Bots → `+` New bot.**

The form is split into seven tabs ordered to match a typical create flow. You don't have to fill them all in one sitting — once the bot exists, you can come back and add tools/webhooks later.

### Tab 1: Identity

| Field | Notes |
|-------|-------|
| **Bot name** | Becomes the localpart of the mxid: `@bot-name:server`. Lowercase, digits, hyphens. Pick something short and memorable. **Permanent** — can't change after create. |
| **Display name** | What people see in chat. Editable any time. |
| **Avatar** | Upload an image, set an emoji, or both. Editable any time. |
| **Bio** | Public profile text (≤ 300 chars). Editable any time. |
| **Accept DMs from anyone** | When **off**, the bot leaves any 1:1 DM-shaped invite from anyone other than you. When **on**, the bot accepts DM invites from any user. Group rooms are gated separately (see below). Default: on. |

**Bots in group rooms — owner-only invite.** Regardless of `accept_dms`, only **you** can invite a bot you own into a group room (any room with > 2 members). Random users on the platform can't drag your bot into their server. The bot rejects group-room invites from anyone else.

### Tab 2: Connection

This is where the LLM lives.

| Field | Notes |
|-------|-------|
| **Provider** | `openrouter` or `openai_compatible`. The two cover everything: OpenRouter for one-account-many-models, or any endpoint that speaks the OpenAI chat-completions wire format (HuggingFace TGI, vLLM, llama.cpp, Together, Anthropic via a proxy, your own backend, etc.). |
| **API base URL** | The base. e.g. `https://openrouter.ai/api/v1`, `https://api.openai.com/v1`, `http://localhost:8080/v1`. |
| **API key** | Plaintext when first entered, encrypted at rest in the engine's DB. After save, the field shows `•••••` and only sends a new key when you explicitly replace it. **The key never leaves the engine.** |
| **Model** | The model id the provider expects. `openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`, `meta-llama/Llama-3.3-70B-Instruct`, etc. |

The engine sends OpenAI-compatible `POST /chat/completions` requests with `tools` populated from your webhooks + MCP attachments. Most providers handle this fine; if yours doesn't support `tools`, the bot still works for plain chat replies (tools just won't fire).

#### Test connectivity

There's no built-in "test" button — the test is to save and @-mention the bot in a room. If the LLM endpoint errors, the bot posts a `(LLM error: …)` reply with the upstream detail. Common ones:

- `401 Unauthorized` — API key is wrong.
- `404 model not found` — model id is wrong for this provider.
- `503` from a self-hosted endpoint — your backend is down.

### Tab 3: Behavior

| Field | Notes |
|-------|-------|
| **System prompt** | Everything you want the model to know about who it is, how to behave, what tone. The bot's "personality" lives here. |
| **Context window** | How many recent room messages to include in each prompt. Range: 1–100. Default 30. Bigger context = better continuity but more tokens per call. |

The engine prepends your system prompt, then `context_window` recent messages from the room (formatted as alternating user/assistant turns), then the triggering message. The whole thing goes to the LLM. The response is posted back into the room as a message from the bot.

### Tab 4: Knowledge

Upload PDFs, text files, markdown, or plain documents and the engine indexes them per-bot. On every reply, the engine retrieves the top-N most relevant chunks and prepends them to the system prompt as `<knowledge>...</knowledge>` blocks. Lightweight RAG.

Use cases: company docs, character lore, a research corpus, an API reference.

- Per-bot, scoped to the owner. No sharing across bots.
- Files persist until you remove them from this tab.
- Storage is on the engine; nothing leaves your homeserver.

### Tab 5: Tools (MCP)

**Model Context Protocol** — Anthropic's standard for letting models call external programs. Koven supports both flavors:

#### HTTP MCP (Streamable HTTP)

| Field | Notes |
|-------|-------|
| **Label** | Anything — for your reference. |
| **URL** | The MCP server's HTTP endpoint. |
| **Headers** | Authorization, custom keys. e.g. `Authorization: Bearer <token>`. Treated as auth — encrypted at rest. |

No catalog, no proxy. If you can find an MCP URL you're qualified to wire it up.

Example (web search):
- Label: `serper-search`
- URL: `https://your-mcp-bridge.example.com/serper`
- Headers: `Authorization: Bearer sk_…`

The MCP server's tool list is fetched once at attach time and re-fetched on each call. Tools are exposed to the LLM by name + description, exactly as the MCP server advertises them.

#### stdio MCP (subprocess)

| Field | Notes |
|-------|-------|
| **Label** | Anything. |
| **Command** | The binary to run. e.g. `npx` or `/usr/local/bin/my-tool`. |
| **Arguments** | List. e.g. `["-y", "@modelcontextprotocol/server-filesystem", "/data"]`. |
| **Environment** | Key/value pairs. Stripped from the parent env before spawn — only what you pass through is visible. |

**Sandboxed.** Stdio MCPs run inside a [bwrap](https://github.com/containers/bubblewrap) sandbox with a stripped env, a per-bot scratch directory, and no network unless you explicitly mount one. Lets you safely run third-party MCP packages without giving them your home directory.

**Version pinning.** When the command points at an npm package (e.g. `npx -y @scope/pkg@1.2.3`), the engine resolves the exact version at attach time and pins it. Every subsequent spawn uses that pinned version. Protects against silent supply-chain compromise via auto-update. Shown in the UI as a `Locked: 1.2.3` badge next to the attachment.

#### Bulk import

Paste a Claude Desktop / Cursor / Cline-style `mcpServers` config block into the bulk-import textarea — Koven parses the JSON and creates one attachment per server. Saves the manual entry for big setups.

Format example:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

Each entry under `mcpServers` becomes an attachment with the key as its label.

### Tab 6: Webhooks

Two directions: **outbound** (the bot calls the world) and **inbound** (the world calls the bot).

#### Outbound webhooks — LLM-callable HTTP tools

These let your bot hit any HTTP endpoint as part of generating a reply. Each row registers as an OpenAI-tool definition in the chat-completion call; the LLM can decide to invoke it, fill in the parameters from the conversation context, and incorporate the response into its reply.

Fields:

| Field | Notes |
|-------|-------|
| **Name** | The tool name the LLM sees. Must match `^[a-zA-Z0-9_-]+$`, ≤ 64 chars. Pick a verb-y name: `search_web`, `get_weather`. |
| **Description** | The LLM sees this. Explain when to use this tool. ≤ 500 chars. |
| **Method** | GET or POST. |
| **URL** | The endpoint. Supports `{placeholder}` tokens that pull from params. e.g. `https://api.example.com/users/{user_id}/profile`. |
| **Params** | List of LLM-callable arguments. Each has a `name`, `kind` (`string` / `integer` / `boolean` / `number`), `description`, `required`, and `in` (`url` for query-string params, `body` for JSON body params). GET requests with `in: body` get auto-routed to query. |
| **Headers** | Auth + custom headers. Encrypted at rest. e.g. `Authorization: Bearer sk_…`. |

How it works at call time:

1. LLM decides to invoke the tool with arguments matching the param schema.
2. Engine builds the request:
   - URL substitutes `{name}` from any params named that way.
   - Query params: `?name=value&…` for any param with `in: url` (and any unsubstituted ones if no `{name}` placeholder).
   - Body: `{"name": value, …}` JSON for any param with `in: body`.
   - Headers: every row from your headers config plus `Content-Type: application/json` on POST.
3. Engine fires the HTTP request (25s timeout).
4. Response body is returned to the LLM as the tool's result. The model then continues its reply, optionally referencing what it got back.

The bot's reply ends up in the chat naturally — the user sees a normal message, not a tool-call trace.

Example: a web search bot.

- Name: `search_web`
- Description: `Search the public web. Use this when the user asks about current events, recent news, or anything beyond the model's training cutoff.`
- Method: `GET`
- URL: `https://google.serper.dev/search`
- Params: one param `q` (string, required, `in: url`, description "the search query")
- Headers: `X-API-KEY: <your serper key>`

The system prompt should say something like "If the user asks about current events, use `search_web` to find live info."

#### Inbound webhooks — external services trigger the bot

These let external services POST data INTO Koven, routed through your bot. GitHub → bot summarizes PRs. Twilio → bot posts SMS into a room. Alertmanager → bot posts incidents. Any HTTP-capable service works.

Setup:

1. In the Webhooks tab → **+ Add inbound webhook.**
2. **Label** for your reference. The webhook becomes a row.
3. **Target room** — pick which room the bot posts messages to. The dropdown lists the rooms YOU own (or have invite power in). When you save, the engine auto-invites the bot to that room (no need to invite it manually first); the bot accepts the invite via its standard owner-invite handler.
4. **Signing secret** (optional). If set, the webhook will only accept requests with a matching HMAC signature. Supported formats:
   - GitHub: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256>`
   - Twilio: `X-Twilio-Signature: <base64 HMAC-SHA1 of URL + sorted params>` (use Twilio Auth Token as secret)
   - Leave blank to accept unsigned requests (less secure; rely on the token-in-URL being secret).

When you save, Koven generates a token-bearing URL: `https://client.koven.chat/api/webhooks/in/<TOKEN>`. **The token IS the auth.** Treat it like a password. Anyone with the URL can POST to it.

You can GET (or HEAD) the URL in a browser to verify — Koven returns a `{"ok": true}` probe response so you know the URL is real before pasting it into the source's webhook config.

How the source's POST becomes a bot message:

1. Source POSTs to `https://client.koven.chat/api/webhooks/in/<TOKEN>` with body (JSON or form-encoded).
2. Engine verifies signature if set.
3. Engine auto-detects the source by signature header / payload shape (GitHub PR, GitHub Issue, Twilio SMS, plain JSON, etc.) and routes to a per-source formatter.
4. Formatter renders a markdown message tuned for that source (PR title + link, SMS sender + body, etc.).
5. The bot posts it to the configured target room.

Auto-detected sources include:
- **GitHub** — pushes, PRs, issues, releases.
- **Twilio** — inbound SMS (replies an empty TwiML `<Response/>` so Twilio doesn't retry).
- **Generic JSON** — anything else; renders the payload as a fenced code block.

Status codes:
- `200` — delivered to the room.
- `401` — HMAC signature invalid.
- `404` — unknown token.
- `413` — body > 1 MB.
- `503` — bot isn't currently running OR Matrix post failed (caller may retry).

#### Webhooks via LLM tools (advanced)

If you want the bot to invoke an inbound webhook from a Koven chat into another Koven user's webhook → use an **outbound webhook** with the URL pointing at the other bot's inbound URL. Bots-as-services pattern.

### Tab 7: Limits

Cost guardrails. All three default to 0 (= unlimited).

| Field | Notes |
|-------|-------|
| **Max tokens per reply** | Caps the LLM's output token count per single reply. |
| **Daily token limit** | Total tokens (prompt + completion) the bot may use per UTC day. Bot stops replying when hit. |
| **Daily call limit** | Total LLM calls the bot may make per UTC day. |

Counters reset at UTC midnight. Useful for keeping a runaway bot from burning your API key during a flame war.

The current usage numbers (`total_prompt_tokens`, `total_completion_tokens`, `total_calls`, `last_used_at`) are visible on the bot's row in the bots list.

---

## How bots get triggered

A bot replies when **any** of the following is true in a room it's joined to:

1. **The triggering message contains the bot's full mxid.** e.g. `hey @bot-foo:koven.chat what's the weather` — works from any server.
2. **The triggering message contains `@<localpart>`** on the same server. e.g. `hey @bot-foo what's the weather` from a user on `:koven.chat` triggers `@bot-foo:koven.chat`. Won't trigger across servers (a bare `@bot-foo` is ambiguous when bots exist on multiple homeservers).
3. **The triggering message is a reply** to a message the bot sent. Reply-chains work without re-mentioning.
4. **The triggering message is in a 1:1 DM with the bot** (exactly 2 members, one of which is the bot). Every message in the DM triggers — no mention needed.
5. **m.mentions intent.** Matrix's official mentions field (`m.mentions.user_ids` includes the bot's mxid). The SPA writes this on every @-mention; some federated clients use it too.

Edge cases:

- The word-boundary check on `@<localpart>` matches `@bot-foo` but not `@bot-foobar`. Typing `@bot-foo!` triggers (`!` is a boundary).
- Bots NEVER trigger from their own messages, or from other bots' messages — only humans.
- If the engine restarts and the bot was offline, **stale messages aren't backfilled.** Anything older than ~60 seconds when the engine boots gets skipped to avoid replying to a flood of historic mentions.

---

## What the LLM sees on each call

When triggered, the engine constructs this payload:

```
system:
  <your system prompt>
  <knowledge chunks if any>
  <inbound-webhook context if applicable>

assistant: <bot's most recent reply, if context window includes it>
user: <message N>
user: <message N-1>
...
user: <message 1 — most recent / triggering message>

tools: [outbound webhook 1, outbound webhook 2, … MCP tool 1, MCP tool 2, …]
```

The LLM either:
1. Returns a plain text response → engine posts it as the bot's message.
2. Returns a tool call → engine executes the tool (webhook or MCP), feeds the result back, loops up to a sensible cap, then posts the final reply.

If the response includes markdown, the bot's message renders with markdown.

---

## DMing your bot

Open the bot's profile sheet (member list or click its name) → **Message**. A 1:1 DM opens. Every message you send triggers the bot — no need to @-mention.

The DM is end-to-end encrypted at the chat layer (Koven DMs always are). **The engine bot for this DM has the key** since the bot is one of the two parties — it has to read its own DMs. Your messages are visible to the engine when the bot is the recipient. (For human-only DMs, the engine has no keys and can't read content.)

Use DMs with bots for:
- Private prompts you don't want a room to see.
- One-on-one knowledge queries against your bot's RAG corpus.
- Quickly testing prompts before deploying the bot to a group.

---

## Operational notes

### Bot caps

Each user can have up to **30 bots** by default (`MAX_BOTS_PER_USER` env var on the engine). Past the cap, the create form disables `+` with a tooltip.

### Pausing / disabling a bot

Settings → Bots → bot row → ⋯ → **Disable.** The bot stays in your roster but stops replying. Re-enable to resume. Use this when you're tweaking the system prompt without wanting it to talk in the meantime.

### Re-credentialing

To rotate the API key without re-creating the bot: edit the bot → Connection tab → API key field shows `•••••` → type a new key → save. Old key is overwritten.

### Deleting a bot

Settings → Bots → bot row → ⋯ → **Delete.** Two-step confirm. The bot's Matrix account is deactivated, every room it's in sees the bot leave, and all the webhooks/MCPs/knowledge attached to it go with it.

### Per-user logs

Every LLM call is recorded in the engine's `bot_call_log` table. The bot's row in the UI surfaces aggregate counters (total calls, total prompt tokens, total completion tokens, last used). For per-call detail, the engine logs are in `docker compose logs engine` (or your dev terminal).

---

## Security model

### What the engine can see

- **Your API key** — encrypted at rest, used to make outbound LLM calls. Never sent to anyone except the LLM endpoint you configured.
- **Bot conversations** — when the bot is a participant in a room/DM, the engine reads + writes those messages on the bot's behalf. For DMs with the bot, that means the engine sees the conversation (it has to, to generate replies).
- **MCP traffic** — for HTTP MCPs, the engine forwards calls + responses. For stdio MCPs, the subprocess runs inside the engine's sandbox.
- **Outbound webhook calls** — the engine fires them with your headers/auth.

### What the engine doesn't see

- **DMs between humans** — Koven's E2EE for human-only DMs means the engine has no keys. No bot is needed for these.
- **Encrypted-space rooms.** Same — no engine visibility unless a bot is in the room.

### Bots in encrypted spaces

Bots **can** join encrypted-space rooms if you invite them, but they need to handle Matrix's olm/megolm key sharing. The engine handles this transparently for bots you own. The room's existing members must share keys with the bot (Matrix's standard flow); some clients auto-share, some prompt.

### Floor-violation accountability

If your bot posts something that crosses the floor-violation line (CSAM, credible threat, doxx), the engine will:

1. Collapse the bot's message immediately (same as any floor flag).
2. Open a suspension case against **you, the owner** — not the bot.
3. Land the case in the admin floor-review queue with your reputation on the line.

Configure your bot's system prompt carefully. You're accountable.

---

## Tutorials

### "Hello world" — your first reply

Goal: a bot named `@bot-hello:<server>` that replies to mentions with a friendly hello.

1. **Settings → Bots → +.**
2. Identity: name `hello`, display name `Hello Bot`, leave bio blank.
3. Connection: provider `openrouter`, base `https://openrouter.ai/api/v1`, key `<your openrouter key>`, model `openai/gpt-4o-mini`.
4. Behavior: system prompt: `You are a friendly bot. When mentioned, reply with a warm hello and offer to help.` Context window: 10.
5. Skip Knowledge / Tools / Webhooks / Limits.
6. **Save.**
7. Invite the bot to a test space (the bot's profile → Invite, or invite the mxid `@bot-hello:<server>` from a room you founded).
8. In that room, type `@bot-hello are you alive?`. Expect a reply within 2-3 seconds.

### Web-search bot

Goal: a bot that can search the live web when asked about current events.

1. Sign up at [Serper.dev](https://serper.dev) (or another search API). Grab your API key.
2. Settings → Bots → +.
3. Identity: name `searcher`, display name `Searcher`.
4. Connection: openrouter / `openai/gpt-4o-mini` / your key.
5. Behavior:
   ```
   You are a research assistant. When the user asks about current events,
   recent news, or anything specific you might not have up-to-date info on,
   use the search_web tool. Quote sources in your reply.
   ```
6. Webhooks tab → **+ Add outbound webhook:**
   - Name: `search_web`
   - Description: `Search the public web via Google. Use for current events, recent news, or live data.`
   - Method: GET
   - URL: `https://google.serper.dev/search`
   - Params: one param `q` (string, required, `in: url`, description "the search query")
   - Headers: `X-API-KEY: <your-serper-key>`
7. Save. Test by mentioning the bot: `@searcher what's happening with NVIDIA stock today?`. The LLM should invoke `search_web` and reply with sources.

### MCP filesystem bot

Goal: a bot that can read/write a sandboxed scratch directory via the official `@modelcontextprotocol/server-filesystem`.

1. Settings → Bots → +.
2. Identity, Connection, Behavior — set as before.
3. Tools tab → **stdio MCP**:
   - Label: `fs`
   - Command: `npx`
   - Args: `["-y", "@modelcontextprotocol/server-filesystem", "/data/scratch"]`
   - Env: leave empty (sandbox strips it anyway).
4. Save. The engine pins the npm version at attach time and runs every subsequent invocation inside bwrap with `/data/scratch` mounted in.
5. Test: `@bot-fs read /data/scratch/notes.md`. The model should invoke the filesystem tool to read + summarize.

### GitHub webhook bot

Goal: every PR opened on a repo posts a summary into a room.

1. Create the bot. Pick a chat model — replies will only fire when humans mention the bot (the webhook posts go straight through, no LLM in the loop unless the webhook triggers a follow-up reply).
2. Webhooks tab → **+ Add inbound webhook:**
   - Label: `github-prs`
   - Target room: `#engineering`
   - Signing secret: your GitHub webhook secret (set this in the GitHub repo's webhook config; copy the same string here)
3. Save. Copy the generated URL: `https://client.koven.chat/api/webhooks/in/<TOKEN>`.
4. In GitHub → repo → Settings → Webhooks → **Add webhook:**
   - Payload URL: the URL from step 3.
   - Content type: `application/json`.
   - Secret: same string as the bot's signing secret.
   - Events: Pull requests, Pushes, Issues (whatever you care about).
5. Open a PR. Within a second, the bot posts in `#engineering`:
   ```
   ### Pull request opened
   [@your-handle] opened **#123 fix: navbar dropdown closes on Esc**
   <PR link>
   ```

### Twilio SMS → Koven bot

Goal: SMS replies from your customers land in a support room.

1. Create the bot.
2. Inbound webhook:
   - Target room: `#support`
   - Signing secret: your Twilio Auth Token.
3. Save, copy the URL.
4. In Twilio Console → Phone Numbers → your number → Messaging:
   - "A message comes in" → Webhook → paste the URL from step 3.
   - HTTP method: POST.
5. Someone texts your Twilio number. Within a couple seconds, the bot posts in `#support`:
   ```
   📱 SMS from +1-415-xxx-xxxx:
   > my account is locked, help
   ```

Bonus: combine with an outbound webhook to *reply* via Twilio's API. Now you've got a two-way SMS bridge.

### OpenAI-compatible self-hosted model (vLLM / Ollama / TGI / llama.cpp)

Goal: route the bot through a self-hosted LLM.

1. Stand up your model. Most servers expose an OpenAI-compatible API at `http://host:8080/v1`.
2. Settings → Bots → + → Connection:
   - Provider: `openai_compatible`.
   - API base: `http://your-host:8080/v1` (must be reachable from your Koven engine; if engine is dockerized, may need `http://host.docker.internal:8080/v1`).
   - API key: anything if your server doesn't require one (`unused` is fine), or your real key if it does.
   - Model: whatever name your server expects, e.g. `meta-llama/Llama-3.3-70B-Instruct`.
3. System prompt, save, mention.

Tool calling works only if your server supports OpenAI's `tools` parameter. vLLM does (with the right `--tool-call-parser`); llama.cpp's server does in recent versions; many older servers don't. If unsupported, plain chat still works.

---

## API reference (advanced)

Bot operations are exposed over the engine's HTTP API. The SPA uses these; you can hit them directly with `curl` if scripting.

All routes are scoped to the calling user as the bot owner — the engine rejects cross-owner reads/writes. Authentication is a Matrix access token: `Authorization: Bearer <token>`.

### Bot CRUD

| Method | Path | Purpose |
|--------|------|---------|
| `GET`    | `/api/bots/me` | List your bots (summary, no secrets) |
| `POST`   | `/api/bots` | Create a bot |
| `PATCH`  | `/api/bots/:id` | Update a bot |
| `DELETE` | `/api/bots/:id` | Delete a bot |

### MCP attachments

| Method | Path | Purpose |
|--------|------|---------|
| `GET`    | `/api/bots/:id/mcp` | List attachments |
| `POST`   | `/api/bots/:id/mcp` | Attach an HTTP MCP |
| `POST`   | `/api/bots/:id/mcp/stdio` | Attach a stdio MCP |
| `POST`   | `/api/bots/:id/mcp/bulk` | Bulk import from a `mcpServers` config |
| `DELETE` | `/api/bots/:id/mcp/:attachmentId` | Detach |

### Outbound webhooks (LLM tools)

| Method | Path | Purpose |
|--------|------|---------|
| `GET`    | `/api/bots/:id/outbound-webhooks` | List |
| `POST`   | `/api/bots/:id/outbound-webhooks` | Create |
| `PATCH`  | `/api/bots/:id/outbound-webhooks/:wid` | Update |
| `DELETE` | `/api/bots/:id/outbound-webhooks/:wid` | Delete |

### Inbound webhooks

| Method | Path | Purpose |
|--------|------|---------|
| `GET`    | `/api/bots/:id/webhooks` | List your bot's inbound webhooks |
| `POST`   | `/api/bots/:id/webhooks` | Create |
| `DELETE` | `/api/bots/:id/webhooks/:wid` | Delete |
| `POST`   | `/api/webhooks/in/:token` | **Public** — sources POST here |
| `GET/HEAD` | `/api/webhooks/in/:token` | **Public** — probe / verify URL is real |

### Knowledge files

| Method | Path | Purpose |
|--------|------|---------|
| `GET`    | `/api/bots/:id/knowledge` | List uploaded files |
| `POST`   | `/api/bots/:id/knowledge` | Upload a file (multipart) |
| `DELETE` | `/api/bots/:id/knowledge/:fileId` | Remove |

Body shapes for the JSON endpoints mirror the SPA's TypeScript types in `client/src/lib/bots.ts` and `client/src/lib/bot-mcp.ts`. The SPA is the canonical reference.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Bot doesn't reply when @-mentioned | Check the bot's `enabled` flag in Settings → Bots. Then verify it's actually a member of the room (profile → Invite). |
| Bot is in the space but not in any of its rooms | After accepting a space invite, the bot's runtime now auto-cascades into every joinable child room (public/knock/restricted). If a bot is missing rooms — usually only on installs running pre-cascade engine code — kick the bot from the space and re-invite it; the new invite triggers the full cascade. Alternatively, an admin can force-join the bot via Synapse's `/_synapse/admin/v1/join/<room>` API. |
| `LLM error: 401 Unauthorized` in chat | Bad API key. Update in Connection tab. |
| `LLM error: model not found` | Wrong model id for this provider. Check the provider's docs. |
| `LLM error: 429 too many requests` | You hit the provider's rate limit. Wait, or check the bot's Limits tab against your provider's quota. |
| Bot replies are slow (> 10s) | Big context window + tool calls. Tune `context_window` down or pick a faster model. |
| Bot replies are short / cut off | Hit `max_tokens_per_reply`. Raise it in Limits, or remove the cap. |
| Inbound webhook returns 401 | HMAC signature didn't match. Confirm the signing secret in Koven matches the source's secret. |
| Inbound webhook returns 404 | Token in URL is wrong. Regenerate by deleting + recreating the webhook. |
| Outbound webhook never fires | LLM didn't choose to invoke it. Make the description clearer in when-to-use terms. Or your provider doesn't support `tools` — see Connection notes. |
| MCP stdio attachment errors out | Bwrap sandbox missing required mounts. Currently fixed: the engine mounts a per-bot scratch dir; binaries outside `$PATH` need the absolute command. |
| Bot's voice in DMs is awkward | System prompt is probably too short. Be specific about tone, pronouns, expertise area. |

---

## Where to learn more

- **MCP spec:** https://modelcontextprotocol.io/
- **OpenAI chat completions API** (the wire format Koven uses): https://platform.openai.com/docs/api-reference/chat
- **Koven governance** (how bots fit into the consensus model): https://koven.chat/governance.html
- **User guide** (for what humans see when they interact with bots): the companion **Koven — User Guide** doc.

---

## Design philosophy (one paragraph)

Most chat platforms treat bots as either (a) glorified webhooks that post messages, or (b) heavyweight integrations behind a marketplace. Koven splits the difference: bots are first-class Matrix users, configured by their owner, driven by an LLM the owner pays for, with MCP and webhook attachment points so anyone can wire one up in five minutes without us approving anything. The trade-off is that you're responsible for what your bot says — there's no platform to blame and no review process to hide behind. Configure your prompts, set your limits, treat your API key like a password, and the rest is whatever you imagine.

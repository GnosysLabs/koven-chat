<p align="center">
  <img src="koven-logo.png" alt="Koven" width="420" />
</p>

<p align="center">
  <a href="https://koven.chat">koven.chat</a>
  &nbsp;·&nbsp;
  <a href="https://client.koven.chat">client.koven.chat</a>
  &nbsp;·&nbsp;
  <a href="https://gnosyslabs.xyz">GnosysLabs</a>
</p>

<p align="center">
  <strong>Group chat where admins exist and every moderation action they take is in a public log forever.</strong>
</p>

---

## What Koven is

Group chat — spaces, rooms, DMs, voice + video calls, screen share, bots — built on Matrix + a thin governance layer. Standard admin moderation (kick / ban / redact / set power levels, PL-gated by Synapse) with one preserved differentiator: every admin action lands in the per-room **public mod log**, append-only, readable by every member of the room. Discord shape with one rule the protocol actually enforces: there is no secret moderation.

### Features

- **Spaces and rooms** — Discord-style. A space is a server; rooms are channels inside. Joining a space cascade-joins you into its rooms automatically.
- **Direct messages** — end-to-end encrypted by default (Matrix Megolm). 1:1 only.
- **Live channels (voice + video + screen-share)** — every room can host group calls. DM calls ring once and connect. Powered by Cloudflare RealtimeKit (the SFU); see the setup notes below.
- **Encrypted spaces** — private spaces can opt into "every room E2EE forever" at creation. Permanent, trades moderation for privacy. Use for trusted-group / family / small-team installs.
- **Multi-user bot platform** — anyone with an account can create LLM bots. OpenRouter or any OpenAI-compatible endpoint. MCP servers (stdio sandboxed via bwrap, or HTTP). Inbound + outbound webhooks. You pay for tokens; the platform runs the orchestration.
- **Standard moderation** — admins kick / ban / redact / set roles. PL-based, like Matrix. PL 50 for moderators, PL 100 for space owners; promotions and demotions follow Synapse's PL-≤-own rule.
- **Public mod log** — every moderation action lands in an append-only log readable by every room member. There is no secret moderation. Kicks, bans, redactions, role changes, member-submitted reports, self-deletions, and bot kicks/bans all show up forever, with the actor's mxid and the reason attached.
- **Universal deep links** — `koven://` scheme + `https://client.koven.chat/invite/…` Universal Links open the desktop app directly on macOS, Linux, and Windows. Confirmation card with preview metadata before the user joins.
- **Inline room mentions** — paste a room id, alias, invite URL, or matrix.to link in any message and it renders as a Discord-style pill. Click jumps in.
- **Per-instance, no federation** — Koven instances don't federate with each other or with vanilla Matrix homeservers. Each Koven instance is its own community with its own admin pool and its own mod log. See [No federation](#no-federation) below for the reasoning.

See [docs/MODERATION.md](docs/MODERATION.md) for the moderation model — roles, primitives, reports, the public mod log — spelled out. Two end-user-facing guides also live in `docs/`: [koven-user-guide.md](docs/koven-user-guide.md) (everything members see in the product) and [koven-bot-guide.md](docs/koven-bot-guide.md) (the bot platform end-to-end, including MCP + webhooks).

---

## What's in this repo

The web client, the desktop app (Tauri), the server-side engine (admin moderation audit, profiles, bots, calls, instance config), and a complete self-hosting bundle (Synapse — client-server API only, no federation — Postgres, coturn, plus a choice of Caddy with auto-TLS or host nginx + certbot).

```
                    ┌────────────────────┐
                    │  Caddy (or nginx)  │   TLS + reverse proxy + static SPA host
                    └─────────┬──────────┘
                              │
       ┌──────────────────────┼─────────────────────────────┐
       ▼                      ▼                             ▼
   ┌───────┐              ┌────────┐                  ┌─────────┐
   │  SPA  │              │ engine │                  │ synapse │
   └───┬───┘              └────┬───┘                  └────┬────┘
       │                       │                           │
       │ (calls SDK)           │ (custom events,           ▼
       ▼                       │  appservice)         ┌─────────┐
  ┌──────────────┐             │                     │postgres │
  │  Cloudflare  │◄────────────┘                     └─────────┘
  │  RealtimeKit │   webhook                              ▲
  │     SFU      │   (call presence)                      │
  └──────────────┘                                ┌──────────────┐
                                                  │    coturn    │   STUN/TURN
                                                  └──────────────┘   for legacy
                                                                     Matrix VoIP
```

| Path                   | Role                                                                                                  |
|------------------------|-------------------------------------------------------------------------------------------------------|
| `client/`              | Vite + React + Tailwind web client (the SPA)                                                          |
| `apps/desktop/`        | Tauri 2 desktop bundle (macOS / Linux / Windows)                                                      |
| `engine/`              | Bun service: mod-log audit + reports queue, admin promotion, profiles, bots, calls, instance config   |
| `shared/`              | TypeScript types shared between client and engine                                                     |
| `docker/synapse/`      | Synapse Dockerfile + config templates + `koven-room-gate` Synapse module                              |
| `docker/coturn/`       | coturn config template                                                                                |
| `docker/nginx/`        | Optional nginx config template if you're not using the bundled Caddy                                  |
| `tools/seed.ts`        | Idempotent seed script. Populates a fresh install with users, spaces, rooms, and chat for development |
| `bin/koven`            | Install / setup script                                                                                |

---

## Self-hosting your own instance

Designed for a Linux VPS with Docker + a hostname pointed at it. The full stack — Synapse, Postgres, coturn, the Koven engine, the web client, Caddy fronting it all with auto-renewing Let's Encrypt certs — comes up in three commands once your `.env` is set.

### Prerequisites

- A VPS (anything from a $5 droplet up; 2 GB RAM is comfortable, 1 GB works for small instances).
- **Docker** with Docker Compose v2.
- **`bun` ≥ 1.1** on the host (used to build the web client during setup).
- A domain name + DNS A record(s) pointing at the server's public IP.
- Ports **80**, **443**, and **3478** (UDP+TCP) reachable from the internet.

Optional but recommended:
- A **Cloudflare account** if you want voice / video / screen-share — see below.
- An **SMTP provider** (or Resend) for the passwordless-sign-in emails. The engine works without one in dev but production sign-in needs a working `MAIL_FROM` + provider creds.

### 1. Clone + configure

```sh
git clone https://github.com/GnosysLabs/koven-chat
cd koven-chat
cp .env.example .env
$EDITOR .env
```

You'll edit three sections:

#### a) Domain & TLS

There are three valid layouts. Pick the one that matches your DNS situation:

| Layout                       | `.env` values                                                                                  | DNS |
|------------------------------|------------------------------------------------------------------------------------------------|-----|
| **Apex-only** — chat lives at `koven.example` | `KOVEN_HOSTNAME=koven.example`<br>`SERVER_NAME=koven.example`<br>`ADMIN_EMAIL=you@…`            | `koven.example  A  <vps-ip>` |
| **Apex + subdomain** — app at `client.koven.example`, user IDs `@alice:koven.example` | `KOVEN_HOSTNAME=client.koven.example`<br>`SERVER_NAME=koven.example`<br>`ADMIN_EMAIL=you@…`     | Both `koven.example  A  <vps-ip>` AND `client.koven.example  A  <vps-ip>` |
| **Subdomain-only** — no apex control, user IDs `@alice:client.koven.example` | `KOVEN_HOSTNAME=client.koven.example`<br>`SERVER_NAME=client.koven.example`<br>`ADMIN_EMAIL=you@…` | `client.koven.example  A  <vps-ip>` |

`KOVEN_HOSTNAME` is where the SPA + Synapse actually live. `SERVER_NAME` is what appears after the colon in user IDs. They can be the same (layout 1 + 3) or different (layout 2 — apex serves only `/.well-known/*` plus a redirect).

#### b) Email (passwordless sign-in)

Koven sign-in is passwordless — users get a 6-digit code emailed to them on demand. Configure your provider in `.env`:

```sh
MAIL_PROVIDER=resend           # or "smtp"
MAIL_FROM=hello@koven.example
RESEND_API_KEY=...             # if MAIL_PROVIDER=resend
# or
SMTP_HOST=smtp.fastmail.com    # if MAIL_PROVIDER=smtp
SMTP_PORT=465
SMTP_USER=...
SMTP_PASSWORD=...
```

Without email configured, the engine logs the code to stdout — fine for dev, useless for production.

#### c) Cloudflare RealtimeKit (voice/video/screen-share)

Koven's Live channels (group calls in rooms + DM calls) run on **Cloudflare RealtimeKit** as the selective forwarding unit. Without these credentials the Join Live button is hidden and `/api/calls/*` returns 503 — text + everything else still works, just no calls.

```sh
CF_REALTIME_ACCOUNT_ID=...      # right sidebar of any Cloudflare account page
CF_REALTIME_APP_ID=...          # Realtime → RealtimeKit → New App
CF_REALTIME_TOKEN=...           # Profile → API Tokens → permission "Realtime: Edit"
CF_REALTIME_WEBHOOK_SECRET=...  # openssl rand -hex 32
PUBLIC_ENGINE_URL=https://client.koven.example   # your public hostname
```

Get the first three from the Cloudflare dashboard (free tier works for small instances; check Cloudflare's RealtimeKit pricing for production). The webhook secret is just a long random string the engine uses to authenticate inbound presence webhooks from Cloudflare — generate it yourself.

If you don't want calls at all, leave these blank. Everything else still works.

### 2. Run setup

```sh
./bin/koven setup
```

This:

1. Generates random secrets (Postgres password, Synapse macaroon/form/registration secrets, engine appservice tokens, TURN shared secret, bot-key encryption secret) and writes them back into `.env`. **Idempotent** — existing values are preserved on re-runs.
2. On first run, generates Synapse's signing key (`synapse-data/signing.key`). Synapse needs this to sign its own events; if you lose it Synapse won't boot.
3. Renders Synapse's `homeserver.yaml`, the engine appservice registration, the coturn config, and (if applicable) the nginx config from templates in `docker/`. Re-run after editing `.env` to propagate changes.
4. Builds the web client (`bun install && bun run --cwd client build`). Caddy serves the output from `client/dist`.
5. Renders the Caddyfile (or nginx config, depending on your choice) for your domain layout.

### 3. Bring it up

```sh
docker compose up -d
```

Caddy fetches Let's Encrypt certs for whichever hostname(s) you set. Synapse boots, the engine connects to Synapse as an appservice and registers its Cloudflare webhook. Postgres + coturn start in the background.

Open `https://<your hostname>` and sign up. **The first user to register becomes the instance admin** — no special bootstrap step; the engine promotes you on first authenticated request.

### Verifying it works

- Web client loads at `https://<hostname>`.
- You can register a second account and DM yourself; messages are E2EE.
- Live channel button shows in any room (only if Cloudflare credentials are set).
- `https://<hostname>/.well-known/matrix/client` returns JSON pointing at your Synapse.  (No `/.well-known/matrix/server` or `/.well-known/koven` — Koven instances don't federate; only the client-discovery route is served.)

If any of those fail, `docker compose logs caddy synapse engine` shows what's wrong. The most common gotcha is DNS not propagated yet (Let's Encrypt cert acquisition fails → Caddy keeps retrying every 15 min).

---

## Optional: nginx instead of Caddy

If your host already runs nginx + certbot for other services on the same VPS, you can skip the bundled Caddy.

**Activate the override** in `.env`:

```sh
COMPOSE_FILE=docker-compose.yml:docker-compose.nginx.yml
```

(or pass `-f docker-compose.yml -f docker-compose.nginx.yml` to every `docker compose` invocation if you'd rather not set it persistently). The override skips the Caddy service and binds Synapse + the engine to `127.0.0.1` so only the host nginx can reach them.

**Render the nginx config**:

```sh
./bin/koven setup
```

This produces `docker/nginx/koven.conf` from the template, with your `KOVEN_HOSTNAME`, `SERVER_NAME`, and `ADMIN_EMAIL` filled in.

**Install it** into nginx and ask certbot for certs:

```sh
sudo cp docker/nginx/koven.conf /etc/nginx/sites-available/koven
sudo ln -s /etc/nginx/sites-available/koven /etc/nginx/sites-enabled/koven
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d $KOVEN_HOSTNAME -d $SERVER_NAME \
  --redirect --agree-tos --email $ADMIN_EMAIL --non-interactive
```

(Drop the second `-d` flag for the subdomain-only layout — there's no apex hostname to certify.)

certbot rewrites `/etc/nginx/sites-available/koven` in place to add TLS listen lines and cert paths. Subsequent `./bin/koven setup` re-runs only re-render `docker/nginx/koven.conf` — they don't touch the live `/etc/nginx/sites-available/koven`, so certbot's edits stick. If you change `.env` and want the live config updated, re-cp + re-run certbot (idempotent).

Bring the stack up the same way:

```sh
docker compose up -d
```

---

## No federation

Koven instances **do not federate** — with each other or with any other Matrix server. Each instance is its own bounded community: its own membership, its own admin pool, its own mod log. Cross-instance DMs, cross-instance rooms — none of it exists. A user on one Koven instance can't reach a user on another except by joining that other instance directly.

The reasoning is laid out in [`docs/MODERATION.md`](docs/MODERATION.md#federation-note) under "Federation note." Short version: the "public mod log is the authoritative audit trail for this room" promise depends on the instance being the canonical ledger. Federated rooms would have N ledgers across N instances and no single authority — the audit-trail promise becomes ambiguous on every dimension. Per-instance is a hard requirement of the moderation model, not a default.

Concretely: Synapse runs with `federation_domain_whitelist: []` and no `federation` listener, the reverse proxy serves no `/.well-known/matrix/server` route, and nothing in the codebase branches on "is this a remote room."

---

## Updating

```sh
git pull
./bin/koven setup            # re-render configs, rebuild the SPA
docker compose build         # rebuild engine + Synapse images if changed
docker compose up -d
```

For SPA-only updates (no engine code change), `bun run --cwd client build` is enough — Caddy/nginx serves the new `client/dist` immediately, no container restart.

---

## Desktop apps

Koven Desktop is a Tauri 2 bundle (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux) that wraps the same SPA. Adds:

- Native window chrome + traffic-light controls.
- OS-level deep links (`koven://` scheme + Apple Universal Links for `https://client.koven.chat/invite/…`).
- Signed auto-updater pulling from GitHub Releases.
- Native save-as dialog for file downloads.
- Native toast notifications via Notification Center / Action Center / libnotify.

Releases live at [github.com/GnosysLabs/koven-chat/releases](https://github.com/GnosysLabs/koven-chat/releases). The macOS arm64 build is the only one we ship signed + notarized today; Linux + Windows builds also publish but you'll see Gatekeeper / SmartScreen warnings on first launch.

Build locally (requires Rust + the platform-specific Tauri prereqs):

```sh
cd apps/desktop
bun install
bun run tauri build
```

---

## Bots

Anyone with an account can create LLM bots from Settings → Bots → New. Default cap is 30 bots per user (`MAX_BOTS_PER_USER` env var on the engine to raise/lower).

A bot is a Matrix user the engine drives on your behalf using an LLM API key you supply. Triggers on `@-mention` in a group room, or any message in a 1:1 DM with it. Configurable per-bot:

- **Identity** — display name, avatar, bio, "accept DMs from non-owners" gate.
- **Connection** — OpenRouter or any OpenAI-compatible endpoint (API base, key, model). Keys are encrypted at rest with `BOT_KEY_ENCRYPTION_SECRET`.
- **Behavior** — system prompt, context window (1–100 recent messages included per call).
- **Knowledge** — RAG uploads (PDFs, text, markdown). Retrieved per call.
- **MCP tools** — HTTP MCPs (URL + headers) or stdio MCPs (subprocess, sandboxed via bwrap, env stripped, npm versions auto-pinned).
- **Webhooks** — LLM-callable outbound HTTP tools (with `{placeholder}` URL templates) + inbound webhook endpoints (auto-detected GitHub / Twilio / generic JSON, optional HMAC signing).
- **Limits** — per-reply token cap, daily token cap, daily call cap.

Bot moderation carve-out: an owner can delete their bot's messages directly, and a room's founder can kick or ban a bot from their room with one click (mirrors the PL-100 authority a founder already has, applied to a bot without going through the standard `mod_actions` audit row — bots aren't people). Both gestures are logged in the public mod log.

Detailed guide: see `apps/desktop/koven-bot-guide.md` (the version on the developer's desktop) or read `engine/src/bot_pipeline.ts`.

---

## Dev

Local development without the full Docker stack:

```sh
# Synapse + Postgres still need to be running.  Spin them up via Docker:
docker compose up -d synapse postgres

# In separate terminals:
bun install
bun run dev:engine    # engine on :9000
bun run dev           # vite dev server on https://localhost:1420 (self-signed cert)
```

Vite uses port **1420** (matches Tauri's convention so `tauri.conf.json`'s `devUrl` stays valid). The dev server uses a self-signed TLS cert because the matrix-rust-sdk WASM crypto module needs a secure context — you'll get a browser warning the first time, accept it once and forget.

For a "fresh install from scratch" E2E test, use the full `./bin/koven setup` + `docker compose up -d` path documented above.

### Seeding test data

The `tools/seed.ts` script populates a fresh dev install with synthetic users, spaces, rooms, and chat history so the empty-state isn't blocking:

```sh
bun run tools/seed.ts
```

Idempotent — re-run anytime to top up. Drop the DB to start clean.

---

## Architecture

- **Wire protocol**: [Matrix](https://matrix.org/). Membership, file sharing, profiles, E2EE, power levels — all come from the spec. Koven doesn't reinvent the transport, and the standard moderation primitives (kick / ban / redact / PL) are Synapse's, not Koven's.
- **Audit layer**: Koven-native. The engine watches the appservice stream, indexes every `chat.koven.flag.v1` (report), every self-deletion, every bot-membership action, and every kick/ban/redact/role_change recorded via `POST /api/rooms/:id/mod-actions`. The per-room mod log feed merges them all into one chronological view that the SPA renders into the public mod log sheet.
- **Calls**: Cloudflare RealtimeKit as the SFU. The engine mints per-call participant tokens via Cloudflare's API; the client SDK connects directly to Cloudflare's edge. Synapse + coturn handle Matrix-spec 1:1 VoIP for legacy clients only — Koven Desktop / the SPA use RealtimeKit exclusively.
- **Bots**: matrix-rust-sdk WASM running inside the engine's bun process, one client per bot. OpenAI-shape tool definitions cover both outbound webhooks and MCP attachments; the engine bridges between the two.
- **Encryption**: DMs are end-to-end encrypted (Megolm) by default. Spaces can be created with the `e2ee_required` policy — every child room inherits encryption automatically, permanently. The engine can't index events it can't read; the SPA hides report affordances in encrypted rooms and labels them with a `Lock` badge in the chat header. Standard admin primitives still work in encrypted rooms (Synapse enforces PL regardless of encryption); the audit-row write succeeds, only the per-message report path is hidden.
- **No federation**: Synapse runs without a `federation` listener and with an empty federation whitelist. There is no `koven-federation-gate` module; the decision is "no federation," not "selective federation."

See `engine/src/` for the audit primitives in detail. The interesting files:

- `engine/src/aggregate.ts` — appservice event stream → DB state machine (flags, redactions, role changes).
- `engine/src/server.ts` — the engine's HTTP API, including `/api/rooms/:id/mod-actions`, `/api/rooms/:id/mod-log`, and `/api/admin/reports`.
- `engine/src/bot_pipeline.ts` — bot trigger detection, context gathering, tool-call loop.
- `engine/src/calls.ts` — Cloudflare RealtimeKit token minting.

---

## License

GNU Affero General Public License v3.0 or later. See [`LICENSE`](./LICENSE).

The relicense from MIT happened in 2026-05.  Commits before that point are reachable in git history under the MIT License; everything after the relicense commit, and the combined work, is AGPL v3.

Practical implications:

- You can fork Koven, modify it, and run it (including as a hosted service) — that's the whole point of AGPL.
- If you run a **modified** Koven instance that users interact with over a network, you must make your modified source available to those users. Unmodified deployments don't owe anyone source beyond what's already public here.
- Any derivative work that combines Koven with other code distributes under AGPL v3 too.
- If you want Koven embedded into a closed-source product, that's not compatible with AGPL — talk to <hello@gnosyslabs.xyz>.

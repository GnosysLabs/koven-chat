# How to set up a Koven instance

End-to-end setup guide for self-hosting Koven Chat on your own server.  Covers every supported scenario: which DNS layout you want, whether to use the bundled Caddy or your existing nginx, voice/video on or off, which email provider, plus the verification steps and the common ways setup goes sideways.

The short version is documented in the project README; this guide is the long version with the choices spelled out and the failure modes explained so you can debug without reading source.

---

## Table of contents

1. [Before you start: choose your scenario](#before-you-start-choose-your-scenario)
2. [Prerequisites](#prerequisites)
3. [DNS layout: pick one](#dns-layout-pick-one)
4. [TLS proxy: Caddy or nginx](#tls-proxy-caddy-or-nginx)
5. [Email provider: Resend or SMTP](#email-provider-resend-or-smtp)
6. [Voice/video: Cloudflare RealtimeKit (optional)](#voicevideo-cloudflare-realtimekit-optional)
7. [Scenario A: fresh VPS, Caddy, apex-only domain](#scenario-a-fresh-vps-caddy-apex-only-domain)
8. [Scenario B: fresh VPS, Caddy, apex + subdomain](#scenario-b-fresh-vps-caddy-apex--subdomain)
9. [Scenario C: fresh VPS, Caddy, subdomain-only](#scenario-c-fresh-vps-caddy-subdomain-only)
10. [Scenario D: existing nginx on the VPS](#scenario-d-existing-nginx-on-the-vps)
11. [Scenario E: text only, no calls](#scenario-e-text-only-no-calls)
12. [Scenario F: dev mode on your laptop](#scenario-f-dev-mode-on-your-laptop)
13. [First sign-in and admin promotion](#first-sign-in-and-admin-promotion)
14. [Verification checklist](#verification-checklist)
15. [Updating](#updating)
16. [Backups](#backups)
17. [Troubleshooting](#troubleshooting)
18. [What `.env` actually controls](#what-env-actually-controls)
19. [Tearing down](#tearing-down)

---

## Before you start: choose your scenario

Three orthogonal questions decide your setup path:

1. **Where does chat live?**  At your apex domain (`koven.example`), at a subdomain (`client.koven.example`), or do you only control a subdomain at all?  See [DNS layout](#dns-layout-pick-one).
2. **Who terminates TLS?**  The bundled Caddy container with auto Let's Encrypt, or your existing host nginx with certbot.  See [TLS proxy](#tls-proxy-caddy-or-nginx).
3. **Do you want voice and video?**  Optional.  Requires a Cloudflare RealtimeKit account.  See [Voice/video](#voicevideo-cloudflare-realtimekit-optional).

Pick one answer for each, then skip to the matching scenario section.  All other sections are reference material you can use as needed.

---

## Prerequisites

On the server:

- **A Linux VPS** with public IP.  $5/month droplets work for small instances.  2 GB RAM comfortable, 1 GB workable.
- **Docker** with the Compose v2 plugin.  Run `docker compose version` to confirm.
- **Bun** version 1.1 or newer on the host.  Used to build the web client during setup.  Install with `curl -fsSL https://bun.sh/install | bash`.
- **Git** to clone the repo.
- **`openssl`** and **`envsubst`** (from `gettext`).  Both ship with most distros; install with `apt install openssl gettext` if missing.
- **Inbound ports open**: 80, 443.  Also 3478 UDP+TCP if you ever want legacy Matrix VoIP (not required for Koven Live calls, which use Cloudflare directly).
- **A domain name** with DNS managed somewhere you can add A records.

On your laptop, for the convenience commands later in this guide:

- `ssh` to the server.
- `dig` to verify DNS.

---

## DNS layout: pick one

Koven needs two configuration values that govern URLs: `KOVEN_HOSTNAME` (where the SPA + Synapse actually live) and `SERVER_NAME` (what appears after the colon in Matrix user IDs).  Three valid combinations:

### Layout 1: apex-only

Chat lives at the apex.  User IDs read `@alice:koven.example`.  Simplest layout, but you can't put a marketing site at the apex because the chat client occupies it.

```
KOVEN_HOSTNAME=koven.example
SERVER_NAME=koven.example
```

DNS:
```
koven.example   A   <your VPS IP>
```

### Layout 2: apex + subdomain

Chat lives at a subdomain.  User IDs still read `@alice:koven.example` because the apex serves `/.well-known/matrix/client` so Matrix-shaped clients typing `@alice:koven.example` find the homeserver URL on the subdomain.  (Koven instances don't federate, so the apex doesn't serve `/.well-known/matrix/server` or `/.well-known/koven` — only the local-client discovery route.)  This is the layout used by the public `koven.chat` instance (apex hosts the marketing site, `client.koven.chat` hosts the app).

```
KOVEN_HOSTNAME=client.koven.example
SERVER_NAME=koven.example
```

DNS:
```
koven.example          A   <your VPS IP>
client.koven.example   A   <your VPS IP>
```

### Layout 3: subdomain-only

You don't control the apex (you only have a subdomain to point at the server).  User IDs read `@alice:client.koven.example` because there's no apex to delegate to.

```
KOVEN_HOSTNAME=client.koven.example
SERVER_NAME=client.koven.example
```

DNS:
```
client.koven.example   A   <your VPS IP>
```

> Pick now, not later.  `SERVER_NAME` is permanent: every user ID and every Matrix event bakes it in.  Changing it later means migrating every user to new IDs by hand.

After choosing, wait for DNS to propagate.  Verify with `dig +short <hostname>` from your laptop until it returns your VPS IP.  Let's Encrypt cert acquisition will silently fail otherwise.

---

## TLS proxy: Caddy or nginx

Two choices, depending on whether the VPS is already running nginx for other services.

| Option | When to use | Cert management |
|---|---|---|
| **Bundled Caddy** | Fresh VPS, Koven is the only thing running.  Zero-config TLS, auto-renews. | Caddy fetches Let's Encrypt certs on first boot. |
| **Host nginx + certbot** | VPS already serves other apps with nginx.  You don't want a second proxy. | You run certbot once per hostname. |

Both serve the same SPA from `client/dist` (a bind-mounted volume) and proxy `/_matrix/*`, `/_synapse/*`, `/.well-known/*`, and `/api/*` to the Synapse and engine containers.

If you're unsure, use Caddy.  It's less work.

---

## Email provider: Resend or SMTP

Koven sign-in is passwordless.  Users enter their email, get a 6-digit code, paste it back.  The engine sends those codes via either:

- **Resend** (recommended): one API key, deliverability is solid, free tier covers small instances.  Sign up at <https://resend.com>, verify your sending domain, and grab the API key.
- **SMTP**: any provider that gives you SMTP creds (Fastmail, Postmark, Amazon SES, your own postfix).  Slightly more config.

For dev only: leave both blank.  The engine logs the code to stdout.  Production must have email configured or sign-up fails silently for end users.

`.env` values:

```sh
# Resend
MAIL_PROVIDER=resend
MAIL_FROM=hello@koven.example
RESEND_API_KEY=re_...

# OR SMTP
MAIL_PROVIDER=smtp
MAIL_FROM=hello@koven.example
SMTP_HOST=smtp.fastmail.com
SMTP_PORT=465
SMTP_USER=koven@koven.example
SMTP_PASSWORD=app-specific-password
```

`MAIL_FROM` must be a real address you actually control on a domain Resend (or your SMTP provider) is authorised to send from.  Free Resend accounts can only send from verified domains; verify yours before going live.

---

## Voice/video: Cloudflare RealtimeKit (optional)

Koven Live channels (group calls in rooms, DM calls) run on Cloudflare RealtimeKit as the selective forwarding unit.  Optional: leave the credentials blank and the Join Live button is hidden, `/api/calls/*` returns 503, text + everything else works.

To enable:

1. Sign in to <https://dash.cloudflare.com>.
2. Right sidebar of any account page shows your `Account ID`.
3. Navigate to **Realtime** → **RealtimeKit** → **Create application**.  The app's ID is the `App ID`.
4. **Profile** → **API tokens** → create a token with permission **Realtime: Edit**.  Save the token string.
5. Generate a webhook secret yourself: `openssl rand -hex 32`.

`.env` values:

```sh
CF_REALTIME_ACCOUNT_ID=...
CF_REALTIME_APP_ID=...
CF_REALTIME_TOKEN=...
CF_REALTIME_WEBHOOK_SECRET=...   # the openssl-generated string
PUBLIC_ENGINE_URL=https://client.koven.example
```

`PUBLIC_ENGINE_URL` must match `KOVEN_HOSTNAME` because Cloudflare posts presence webhooks back to `${PUBLIC_ENGINE_URL}/api/webhooks/cloudflare`.

Cloudflare's free tier is fine for small instances.  Check current RealtimeKit pricing for anything bigger than ~20 concurrent participants.

---

## Scenario A: fresh VPS, Caddy, apex-only domain

You have a brand-new server, no other services on it, and `koven.example` should be the chat URL.

### Step 1: log into the VPS

```sh
ssh root@your-vps-ip
```

### Step 2: install Docker and Bun

```sh
# Docker (Debian/Ubuntu).  See docs.docker.com for other distros.
curl -fsSL https://get.docker.com | sh

# Bun
curl -fsSL https://bun.sh/install | bash
exec $SHELL   # reload PATH
```

Confirm:

```sh
docker compose version    # should print v2.x
bun --version             # should print 1.x
```

### Step 3: clone the repo

```sh
cd /opt
git clone https://github.com/GnosysLabs/koven-chat
cd koven-chat
```

### Step 4: configure `.env`

```sh
cp .env.example .env
vim .env
```

Set:

```sh
KOVEN_HOSTNAME=koven.example
SERVER_NAME=koven.example
ADMIN_EMAIL=you@somewhere
```

Plus your email provider block (see [Email provider](#email-provider-resend-or-smtp)) and, optionally, your Cloudflare block (see [Voice/video](#voicevideo-cloudflare-realtimekit-optional)).

Don't fill in the `*_SECRET` values; setup generates them for you.

### Step 5: point DNS

In your registrar's DNS console:

```
koven.example   A   <your VPS IP>
```

Wait for propagation.  Verify from your laptop:

```sh
dig +short koven.example
```

If that returns your VPS IP, you're good.

### Step 6: run setup

```sh
./bin/koven setup
```

This generates random secrets, renders Synapse config, builds the SPA, renders the Caddyfile.  Idempotent; safe to re-run after editing `.env`.

### Step 7: bring it up

```sh
docker compose up -d
```

Caddy fetches Let's Encrypt certs for `koven.example`.  This takes 10–30 seconds on first boot.  Watch progress:

```sh
docker compose logs -f caddy
```

You'll see `certificate obtained successfully` once it's done.

### Step 8: verify

Open `https://koven.example` in a browser.  You should see the login screen.  Register the first account; you'll be the admin (see [First sign-in](#first-sign-in-and-admin-promotion)).

---

## Scenario B: fresh VPS, Caddy, apex + subdomain

Same as Scenario A, but chat lives at `client.koven.example` while user IDs stay `@alice:koven.example`.  The apex still has to point at the same VPS so it can serve `/.well-known/matrix/client` for local-client homeserver discovery — Koven instances don't federate, so the apex serves only that one well-known route (no `/.well-known/matrix/server`, no `/.well-known/koven`).

Differences from Scenario A:

### Step 4 (configure `.env`)

```sh
KOVEN_HOSTNAME=client.koven.example
SERVER_NAME=koven.example
ADMIN_EMAIL=you@somewhere
```

### Step 5 (point DNS)

Two A records:

```
koven.example          A   <your VPS IP>
client.koven.example   A   <your VPS IP>
```

Verify both:

```sh
dig +short koven.example
dig +short client.koven.example
```

### Everything else identical

`./bin/koven setup` and `docker compose up -d` exactly as in Scenario A.  Caddy fetches certs for both hostnames.

Optional: if you want a marketing page at the apex instead of just the `.well-known/matrix/client` route + a redirect to the chat subdomain, serve your own HTML at the apex.  Out of scope for this guide.

---

## Scenario C: fresh VPS, Caddy, subdomain-only

You don't control the apex.  User IDs will read `@alice:client.koven.example`.

Differences from Scenario A:

### Step 4 (configure `.env`)

```sh
KOVEN_HOSTNAME=client.koven.example
SERVER_NAME=client.koven.example
ADMIN_EMAIL=you@somewhere
```

### Step 5 (point DNS)

One A record:

```
client.koven.example   A   <your VPS IP>
```

### Everything else identical

`./bin/koven setup` and `docker compose up -d`.

Caveat: your `SERVER_NAME` will be `client.koven.example` forever.  If you later get the apex and want to migrate to Scenario B, every existing user ID would change.  There's no clean migration, so commit to this layout only if you're sure you'll never control the apex.

---

## Scenario D: existing nginx on the VPS

Your VPS already runs nginx for other apps.  Skip the bundled Caddy and let nginx terminate TLS.

### Step 1–4 (identical to your domain scenario A/B/C)

Use whichever DNS layout from above.

### Step 5: activate the nginx compose override

```sh
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.nginx.yml' >> .env
```

This pins every `docker compose` call to layer the nginx override on top.  The override drops the Caddy service and binds Synapse and the engine to `127.0.0.1` so only the host nginx can reach them.

### Step 6: run setup

```sh
./bin/koven setup
```

Setup renders `docker/nginx/koven.conf` from a template with your hostnames substituted in.  It does **not** install this into nginx for you.

### Step 7: install the nginx config

```sh
sudo cp docker/nginx/koven.conf /etc/nginx/sites-available/koven
sudo ln -sf /etc/nginx/sites-available/koven /etc/nginx/sites-enabled/koven
sudo nginx -t                          # syntax check
sudo systemctl reload nginx
```

### Step 8: request certs from certbot

```sh
# Two-hostname layouts (A or B):
sudo certbot --nginx -d $KOVEN_HOSTNAME -d $SERVER_NAME \
  --redirect --agree-tos --email $ADMIN_EMAIL --non-interactive

# Subdomain-only (C):
sudo certbot --nginx -d $KOVEN_HOSTNAME \
  --redirect --agree-tos --email $ADMIN_EMAIL --non-interactive
```

certbot rewrites `/etc/nginx/sites-available/koven` in place to add TLS listen lines and cert paths.

If you later edit `.env` and re-run `./bin/koven setup`, setup re-renders `docker/nginx/koven.conf` but does not touch the live `/etc/nginx/sites-available/koven`.  certbot's TLS edits stick.  If you need the live config updated to match new `.env` values, re-cp + re-run certbot.

### Step 9: bring it up

```sh
docker compose up -d
```

Synapse and the engine start bound to `127.0.0.1:8008` and `127.0.0.1:9000` respectively.  Host nginx proxies to them.

---

## Scenario E: text only, no calls

Leave the `CF_REALTIME_*` variables blank in `.env`.  Setup detects this and the engine's `/api/calls/*` endpoints return 503; the SPA hides the Join Live button.  Everything else (text, DMs, bots, governance) works.

If you change your mind later, fill in the Cloudflare variables and restart the engine container:

```sh
docker compose restart engine
```

---

## Scenario F: dev mode on your laptop

Not for production.  For hacking on the codebase locally.

```sh
git clone https://github.com/GnosysLabs/koven-chat
cd koven-chat
bun install
cp .env.example .env
$EDITOR .env       # set KOVEN_HOSTNAME=localhost, SERVER_NAME=localhost

# Synapse and Postgres still need to be running:
docker compose up -d synapse postgres

# In separate terminals:
bun run dev:engine    # engine on :9000
bun run dev           # vite dev server on https://localhost:1420
```

The dev server uses port 1420 (matches Tauri's convention) with a self-signed TLS cert.  You'll get a browser warning the first time; accept it once.  Vite needs HTTPS in dev because the matrix-rust-sdk WASM crypto module requires a secure context.

To seed test data (synthetic users, spaces, rooms, chat history):

```sh
bun run tools/seed.ts
```

Idempotent.  Re-run anytime.

---

## First sign-in and admin promotion

The first authenticated user becomes the instance admin.  No special bootstrap step, no CLI flag.  The engine promotes whoever shows up first.

Walk-through:

1. Open `https://<your hostname>`.
2. Enter your email.
3. Check inbox (or the engine logs if you're running without an email provider) for the 6-digit code.
4. Paste the code, set a display name.

You're now `@<localpart>:<SERVER_NAME>` and the engine has flagged you as admin.  Reload the SPA and you'll see an extra **Pending review** entry in Settings (the floor-violation review queue, admin-only).

Add a second account by signing out and signing in with a different email.  Use the second account to test DMs, rooms, invites, etc.

To later promote additional admins, the admin UI exposes a toggle.  Under the hood the engine writes an `is_admin=1` row in its SQLite database.

---

## Verification checklist

After `docker compose up -d`, walk through these to confirm the instance is healthy:

1. **SPA loads**: `https://<hostname>` returns the login screen.
2. **Sign-up works**: you can register an account and receive the email code (or see it in logs if no provider).
3. **DMs work**: register a second account, start a DM with it, send a message.  Both sides see it.
4. **Encryption works**: the DM shows a Lock badge in the chat header.
5. **Live channel button shows**: any room has a Join Live button (only if Cloudflare credentials are configured).
6. **Client well-known**: `https://<SERVER_NAME>/.well-known/matrix/client` returns JSON like `{"m.homeserver":{"base_url":"https://<KOVEN_HOSTNAME>"}}`.  Local-client discovery only; Matrix clients that type `@user:<SERVER_NAME>` use this to find your Synapse.  (No `/.well-known/matrix/server` and no `/.well-known/koven` — Koven instances don't federate.)
7. **Engine alive**: `docker compose logs engine` shows `engine: listening on :9000` and periodic `engine: tick` lines.
8. **Synapse alive**: `docker compose logs synapse` shows `Synapse now listening on TCP port 8008`.
9. **Caddy alive (Caddy variant)**: `docker compose logs caddy` shows `certificate obtained successfully`.  No 5xx errors.

If any step fails, see [Troubleshooting](#troubleshooting).

---

## Updating

For SPA + engine + Synapse updates, on the VPS:

```sh
cd /opt/koven-chat
git pull
./bin/koven setup        # re-renders configs, rebuilds the SPA
docker compose build     # rebuilds engine + Synapse images if their templates changed
docker compose up -d     # restarts only containers whose images changed
```

The database is in a named Docker volume; `docker compose up -d` preserves it across container recreations.

For SPA-only updates (cosmetic UI changes, no engine code change), you can skip the Docker build:

```sh
cd /opt/koven-chat
git pull
bun run --cwd client build
```

Caddy or nginx picks up the new `client/dist` instantly because it's bind-mounted, no restart needed.

For engine-only updates:

```sh
docker compose build engine
docker compose up -d engine
```

Schema migrations run automatically at engine boot via the `ensureColumns` helper in `engine/src/db.ts`.  Never touch the SQLite file by hand.

---

## Backups

Three things to back up:

1. **Postgres data** (all chat history, all user accounts).  Lives in the named volume `postgres_data`.
2. **Engine SQLite** (governance state, bot configs, notifications).  Lives in `./data/engine/engine.sqlite` (bind-mounted, so it's right there on the filesystem).
3. **Synapse signing key**.  Lives at `./synapse-data/signing.key`.  **Don't lose this.**  Synapse signs its own outbound events with this key; rotating it without a clean restart leaves an instance unable to read its own history.

Minimal backup script (run from `/opt/koven-chat`):

```sh
#!/bin/sh
set -e
DEST=/backup/koven-$(date +%F)
mkdir -p "$DEST"

# Postgres: dump while running.
docker compose exec -T postgres pg_dump -U synapse synapse | gzip > "$DEST/synapse.sql.gz"

# Engine SQLite + uploads.  Engine's WAL is checkpointed periodically; a
# crash-consistent copy is fine for our purposes since the engine is
# stateless beyond this file.
cp -a data/engine "$DEST/engine"

# Synapse signing key + homeserver config.
cp -a synapse-data "$DEST/synapse-data"

# Backup the `.env`.  Without it, the homeserver won't validate
# devices on next boot.
cp .env "$DEST/.env"
```

Schedule via cron.  Off-site copy is your problem; rsync to S3 / Backblaze / a separate VPS depending on your threat model.

Restore: stop the stack, replace the volumes/files, start it.  Postgres restore:

```sh
docker compose down
gunzip < /backup/koven-2026-01-01/synapse.sql.gz | docker compose exec -T postgres psql -U synapse synapse
docker compose up -d
```

---

## Troubleshooting

### "Caddy keeps retrying TLS cert acquisition"

DNS hasn't propagated, or your domain points at a different IP.  Verify:

```sh
dig +short <hostname>
```

Returns?  Should match your VPS IP.  If not, fix DNS and wait.  Caddy auto-retries every 15 minutes.

### "Synapse won't start, error about Postgres locale"

Synapse needs `--encoding=UTF8 --locale=C` on Postgres.  If you pre-existed a Postgres volume with different locale, drop it:

```sh
docker compose down
docker volume rm koven-chat_postgres_data
docker compose up -d
```

Destructive; only do this on a fresh install.

### "Engine logs `homeserver unreachable`"

Synapse isn't running, or the engine is hitting the wrong URL.  Check:

```sh
docker compose ps
docker compose logs synapse | tail -50
```

If Synapse is unhealthy, look for the actual error in its logs (usually Postgres connectivity or a malformed homeserver.yaml).

### "Sign-in email never arrives"

Three possibilities:

1. **No email provider configured.**  Check `.env` for `MAIL_PROVIDER`.  If empty, the code goes to engine logs only.
2. **Resend domain not verified.**  Resend free tier only sends from verified domains.  Verify yours in the Resend dashboard.
3. **SMTP creds wrong.**  Check `docker compose logs engine | grep mail`.  Auth failures and connection refusals show there.

### "Sign-in works but Live calls fail with 503"

`CF_REALTIME_*` not set or invalid.  Verify:

```sh
docker compose logs engine | grep cloudflare
```

The engine logs `cloudflare: account=X app=Y token=set` on boot if everything's wired up.

### "I changed `.env` and nothing happened"

`./bin/koven setup` re-renders the config templates, but the running containers don't pick up env changes until restart:

```sh
docker compose up -d   # picks up changed env on next start
# or for one service:
docker compose up -d engine
```

For Caddy specifically (`KOVEN_HOSTNAME` change): the Caddyfile gets re-rendered by setup, but Caddy needs an explicit reload:

```sh
docker compose restart caddy
```

### "I want to wipe everything and start over"

```sh
docker compose down -v        # -v drops volumes too
rm -rf data synapse-data client/dist Caddyfile.runtime
git restore .env.example
cp .env.example .env
```

This destroys all chat history, all users, and all governance state.  Use with intent.

### "I can't message someone on another Koven instance"

That's intentional.  Koven instances don't federate — with each other or with any other Matrix server.  Each instance is its own community.  See [`docs/GOVERNANCE.md#why-koven-doesnt-federate`](GOVERNANCE.md#why-koven-doesnt-federate) for the reasoning, and tell the other user to make an account on your instance (or vice versa) if you want to talk.

---

## What `.env` actually controls

Reference for the variables `bin/koven setup` reads.  Anything you don't set will either get auto-generated (for secrets) or fall back to a sensible default.

| Variable | Required? | What it does |
|---|---|---|
| `KOVEN_HOSTNAME` | yes | Public hostname the SPA + Synapse live at |
| `SERVER_NAME` | yes | Hostname that appears in user IDs (after the `@user:` colon) |
| `ADMIN_EMAIL` | yes | Goes to Let's Encrypt for cert renewal notices |
| `POSTGRES_PASSWORD` | auto-generated | Synapse's Postgres password.  Random 32 hex chars on first run. |
| `SYNAPSE_MACAROON_SECRET` | auto-generated | Macaroon signing secret.  Don't rotate; existing sessions break. |
| `SYNAPSE_FORM_SECRET` | auto-generated | Form secret for fallback Synapse pages.  Random; don't care. |
| `SYNAPSE_REGISTRATION_SECRET` | auto-generated | Used by the engine to mint user accounts.  Random; engine reads from same `.env`. |
| `SYNAPSE_ADMIN_TOKEN` | auto-generated by `bin/koven bootstrap-admin` | Engine talks to Synapse admin API with this.  Run after first `docker compose up`. |
| `KOVEN_ENGINE_AS_TOKEN` | auto-generated | Appservice token Synapse uses to talk back to the engine.  Random. |
| `KOVEN_ENGINE_HS_TOKEN` | auto-generated | Appservice token the engine uses to talk to Synapse.  Random. |
| `BOT_KEY_ENCRYPTION_SECRET` | auto-generated | Encrypts bot LLM API keys at rest.  Don't rotate; existing bots lose their keys. |
| `TURN_SHARED_SECRET` | auto-generated | coturn shared-secret auth.  Only matters if using legacy Matrix VoIP. |
| `MAIL_PROVIDER` | optional | `resend` or `smtp`.  Empty = dev mode (codes to stdout). |
| `MAIL_FROM` | required if `MAIL_PROVIDER` set | Sender address.  Must be on a domain authorised to send. |
| `RESEND_API_KEY` | required if `MAIL_PROVIDER=resend` | From the Resend dashboard. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | required if `MAIL_PROVIDER=smtp` | Standard SMTP creds. |
| `CF_REALTIME_ACCOUNT_ID` | optional | Cloudflare account ID.  Required for calls. |
| `CF_REALTIME_APP_ID` | optional | Cloudflare RealtimeKit app ID.  Required for calls. |
| `CF_REALTIME_TOKEN` | optional | Cloudflare API token, permission `Realtime: Edit`.  Required for calls. |
| `CF_REALTIME_WEBHOOK_SECRET` | optional | Webhook auth secret you generate.  Required for calls. |
| `PUBLIC_ENGINE_URL` | required if calls enabled | Cloudflare posts presence webhooks here.  Must equal `https://<KOVEN_HOSTNAME>`. |
| `COMPOSE_FILE` | optional | `docker-compose.yml:docker-compose.nginx.yml` to use host nginx instead of bundled Caddy. |
| `MAX_BOTS_PER_USER` | optional | Default 30.  Lower if you don't trust users; raise for power users. |

> Auto-generated secrets are written back to `.env` by `bin/koven setup` on first run.  Subsequent re-runs preserve them.  Treat `.env` as sensitive; back it up alongside the database.

---

## Tearing down

If you're winding the instance down (e.g. migrating to new hardware):

```sh
cd /opt/koven-chat
docker compose down            # stop + remove containers, keeps volumes
# or, to nuke the data too:
docker compose down -v
```

Volumes wiped means all chat history and user accounts are gone permanently.  Don't do this casually.

If you're migrating to new hardware, follow the [Backups](#backups) section to capture state, then restore on the new server.

---

## What's next

- End-user docs (using the chat, reacting, creating spaces, calls, bots) are in [`koven-user-guide.md`](koven-user-guide.md) and [`koven-bot-guide.md`](koven-bot-guide.md).
- The governance model (how flagging, collapse, reputation, suspensions work) is in [`GOVERNANCE.md`](GOVERNANCE.md).
- The codebase entry points are in the repo's `README.md` under **Architecture**.

If something here is wrong, missing, or out of date, please send a PR.  This file lives in `docs/` and is the canonical setup guide.

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
  <strong>The first public-square chat platform where censorship requires consensus, not authority.</strong>
</p>

---

## Why Koven

Discord. Reddit. Twitch. Forums going back twenty years. They share one design choice: a small number of moderators wield unilateral, unappealable power over the speech of everyone else.

In practice that power gets abused. Warning-free bans for arbitrary reasons. Quiet shadow bans nobody is told about. Selective enforcement based on whether the mod likes you. Personal grudges turned into permanent removals. Rage-quitting moderators nuking communities they helped build. Whole servers held hostage by power-tripping admins who decide one day they don't want you around.

This isn't a bad-actor problem you can hire your way out of. The shape of the tool produces this outcome. Hand any group of people a banhammer with no oversight, and over time some fraction of them will swing it for reasons that have nothing to do with community welfare. Every chat platform of the last fifteen years has rediscovered this.

Koven removes the banhammer. Every visibility decision is a community vote, weighted by reputation. Every action is logged forever. Reputation comes from contribution, not from being friends with the founder. Sanctions decay automatically. The platform itself does not have moderators.

The community is the moderator.

## How it works

- Anyone can flag any message.
- Hiding a message requires a community vote, weighted by reputation. The vote is gated by both a minimum count of distinct flaggers and a minimum combined weighted score.
- A flag in the `floor_violation` category (CSAM, credible threats, doxxing) bypasses the community vote and immediately collapses the message into a non-revealable hidden state. No "click to view" affordance, no way to expand it. This category is reserved for genuinely-illegal content; abuse of it eats into the flagger's reputation when reviewed.
- Reputation-driven sanctions (slow-mode, off-default-feed, read-only) decay automatically. There is no path from "the community didn't like what you said" to a permanent removal.
- Every flag, every vote, every action is publicly logged forever, append-only.

Admins exist only to keep the server running and configure instance branding (server name, login background, default space). They have no moderation powers built into the protocol. They cannot ban, hide individual messages, or override a community vote.

See [GOVERNANCE.md](GOVERNANCE.md) for the full mechanics.

---

## What's in this repo

The web client + server-side governance engine, plus a complete self-hosting bundle (Synapse with our federation gate, Postgres, coturn, Caddy with auto-TLS).

```
┌─────────────────────┐
│       Caddy         │  TLS + reverse proxy + static SPA host
└──────────┬──────────┘
           │
   ┌───────┼────────┬────────────────┐
   ▼       ▼        ▼                ▼
┌─────┐ ┌──────┐ ┌──────┐      ┌─────────┐
│ SPA │ │engine│ │synapse│ ◄── │ postgres │
└─────┘ └──────┘ └───────┘      └─────────┘
                     │
                     ▼
                 ┌──────┐
                 │coturn│  TURN/STUN for WebRTC NAT traversal
                 └──────┘
```

| Path                   | Role                                                                                                  |
|------------------------|-------------------------------------------------------------------------------------------------------|
| `client/`              | Vite + React + Tailwind web client                                                                    |
| `engine/`              | Bun service: governance, admin, profiles, instance config                                             |
| `shared/`              | TypeScript types shared between client and engine                                                     |
| `docker/synapse/`      | Synapse Dockerfile + config templates + `koven-federation-gate`                                       |
| `docker/coturn/`       | coturn config template                                                                                |
| `tools/seed.ts`        | Idempotent seed script. Populates a fresh install with users, spaces, rooms, and chat for development |
| `bin/koven`            | Install / setup script                                                                                |

## Install

Designed for a Linux VPS with Docker + a hostname pointed at it. Deploys the full stack: Synapse, Postgres, coturn (TURN server for video calls), the Koven engine, and Caddy fronting it all with auto-renewing Let's Encrypt certs.

### Prerequisites

- Docker + Docker Compose (v2)
- `bun` ≥ 1.1 on the host (used to build the web client during setup)
- DNS A record(s) pointing at this server's public IP
- Ports 80, 443, and 3478 (UDP+TCP) reachable from the public internet

There are three valid hosting layouts. Pick the one that matches your DNS situation.

### A. Apex-only (everything at `koven.example`)

Web client, Synapse, federation, and `.well-known` discovery are all served from the apex. User IDs are `@alice:koven.example`. Single DNS record, single cert. Cleanest if you want the apex to *be* the chat product.

```sh
git clone https://github.com/GnosysLabs/koven-chat
cd koven-chat
cp .env.example .env
$EDITOR .env
# set:
#   KOVEN_HOSTNAME=koven.example
#   SERVER_NAME=koven.example
#   ADMIN_EMAIL=you@your-email.tld
./bin/koven setup
docker compose up -d
```

DNS: `koven.example A <vps-ip>`.

### B. Apex + client subdomain

User IDs are `@alice:koven.example` (clean), but the web app and Synapse run on a subdomain like `client.koven.example`. The apex serves only the discovery files (`/.well-known/matrix/*`, `/.well-known/koven`) plus a redirect to the app. Useful if you want the apex available for a marketing or docs site separately, with the chat itself on a subdomain.

```sh
# in .env:
KOVEN_HOSTNAME=client.koven.example
SERVER_NAME=koven.example
ADMIN_EMAIL=you@your-email.tld
```

DNS: both `koven.example A <vps-ip>` *and* `client.koven.example A <vps-ip>`. The apex's only job is the discovery files, but it has to be reachable for federation to find your homeserver.

### C. Subdomain only (no apex control)

Use this if you can't or don't want to point the apex at this VPS. User IDs become `@alice:client.koven.example`, slightly less pretty but everything works without apex DNS.

```sh
# in .env:
KOVEN_HOSTNAME=client.koven.example
SERVER_NAME=client.koven.example
ADMIN_EMAIL=you@your-email.tld
```

DNS: `client.koven.example A <vps-ip>`.

### After `bin/koven setup`

Whichever layout you pick:

```sh
docker compose up -d
```

Caddy fetches Let's Encrypt certs for whichever hostname(s) you used. First user to register on a fresh install becomes the instance admin via the engine's bootstrap.

### What `bin/koven setup` does

1. Generates random secrets (Postgres password, Synapse macaroon/form/registration secrets, engine appservice tokens, TURN shared secret) and writes them back into `.env`. Idempotent: existing values are preserved on re-runs.
2. On first run, generates Synapse's signing key (`synapse-data/signing.key`). Don't lose this file. Federating servers cache it as your homeserver's identity.
3. Renders Synapse's `homeserver.yaml`, the engine appservice registration, and the coturn config from templates in `docker/`. Re-run after editing `.env` to propagate changes.
4. Builds the web client (`bun install && bun run --cwd client build`). Caddy serves the output from `client/dist`.

### First admin

The first user to register on a fresh install automatically becomes the instance admin. There's no special "create the first admin" step. Sign up through the web client like any other user, and the engine promotes you on your first authenticated request.

### Updating

```sh
git pull
./bin/koven setup
docker compose build
docker compose up -d
```

## Federation

Koven instances federate **only with other Koven instances**. No manual whitelisting, no admin friction. Synapse's outgoing federation is gated by the `koven-federation-gate` Python module that ships in our Synapse image. On first contact with a new domain, it probes `https://<domain>/.well-known/koven`. A valid Koven response means allowed (and cached for 10 minutes); anything else is denied.

This means `@alice:other-koven.chat` works the moment you type it, while vanilla Matrix homeservers are silently isolated. Every Koven instance auto-serves `/.well-known/koven` via Caddy so peer discovery is symmetric.

## Dev

For local development on the same machine without the full Docker stack:

```sh
bun install
bun run dev:engine    # engine on :9000
bun run dev           # vite dev server on https://localhost:5173
```

Synapse needs to be running separately. `docker compose up -d synapse postgres` is enough. For E2E testing of an installed-from-scratch flow, see the `bin/koven setup` path documented above.

## Architecture

- **Wire protocol**: Matrix. Federation, voice/video, threading, file sharing all come from the spec. Koven doesn't reinvent the transport.
- **Governance layer**: Koven-native. Consensus moderation primitive, public audit log, weighted reputation engine, automatic decay. All built on top of Matrix events as custom event types (`chat.koven.flag.v1`, `chat.koven.collapse.v1`, `chat.koven.censure.v1`).
- **Encryption**: DMs are end-to-end encrypted by default (Matrix megolm). Encrypted rooms bypass the consensus layer because the engine bot can't observe their content; a federation badge surfaces this in-UI.

See `engine/src/` for the governance primitives in detail.

## License

MIT. See [`LICENSE`](./LICENSE).

# Moderation

How moderation works on Koven as built. This document describes what the protocol enforces today. Design ideas that aren't wired up yet aren't claimed here.

Koven is a standard chat platform with standard Matrix admin moderation, with one preserved differentiator: **the mod log is public and append-only**. Spaces have owners (the `room.creator` at power level 100). Owners can promote others to admin (PL 100) or moderator (PL 50). PL ≥ 50 enables: kick a member from the space, ban a member from the space, redact (remove) any message, and change a user's power level. Kick and ban are space-wide by design (Discord-style) — the action fans out across every room in the space plus the space itself, so a banned user is removed everywhere at once and the per-room mod log of every affected room reflects it. PL transitions are gated by Synapse — Koven doesn't reinvent any of this. Members can still flag messages or rooms; flags surface to admins in an admin-only "Reports" sheet reached from a shield icon in the SpaceBar. Admins act on reports with the standard moderation primitives, then mark the report resolved or dismiss it. Every admin action lands in the per-room public mod log forever. That's the consensus-era idea Koven keeps: admins have power, and what they do with it is visible to everyone in the room.

---

## Roles

A room (or space) has three roles, gated by Matrix power levels. The model is the standard Matrix one; nothing about it is Koven-specific.

| Role       | PL   | Can do                                                                       |
|------------|------|------------------------------------------------------------------------------|
| Member     | 0    | Read, post, react, flag (= submit a report). That's it.                      |
| Moderator  | 50   | Everything a member can. Plus kick from space, ban / unban from space, redact any message, change a user's PL up to their own.  |
| Admin      | 100  | Everything a moderator can. Plus promote / demote other users (within the PL-≤-own rule) and edit room state (name, topic, avatar). |

The user who creates a space lands at PL 100 — they are the **founder**. There is no separate "owner" concept above admin; founder is just "first PL-100 user, and the only one until they promote someone else." Founders can demote themselves, including all the way down to member, if they want to hand a space off.

### Promotions and demotions

A PL change is a normal Matrix `m.room.power_levels` state event. Synapse enforces the standard rule: a caller can set another user's PL only to a value **less than or equal to the caller's own**. A PL-50 moderator can promote a member to PL 50 (peer); they can't grant PL 100. A PL-100 admin can grant anything up to 100.

Demotions follow the same rule mirrored. A caller can demote anyone whose current PL is at-or-below their own, including themselves. A founder can demote themselves to member; the next promotion back up has to come from another admin.

A space with no PL-100 users is allowed by the protocol — Synapse won't refuse it — but it is operationally undesirable, because nobody can promote anyone back. The SPA warns before the last admin demotes themselves. There is no platform-level "you must have at least one admin" check.

Power-level changes against humans go through the standard moderation primitive (see below) and land in the public mod log as `role_change` rows.

---

## Moderation primitives

Five actions, all PL ≥ 50, all backed by standard Matrix mechanisms. Koven doesn't add new transports; it adds an audit trail.

| Primitive       | Scope       | What it does at the Matrix layer                                                   | Reversible?                                          |
|-----------------|-------------|-------------------------------------------------------------------------------------|------------------------------------------------------|
| **kick**        | Space-wide  | `PUT /rooms/{id}/state/m.room.member/{user}` setting membership=`leave`, fanned out across every child room of the space plus the space itself. | Yes — the kicked user can rejoin any room that admits them. |
| **ban**         | Space-wide  | Same path, membership=`ban`, fanned out across the whole space. Target can't rejoin any room in the space until unbanned. | Only via `unban`.                                    |
| **unban**       | Space-wide  | Membership flips `ban` → `leave` across every room in the space.                   | n/a — undoes a previous ban.                         |
| **redact**      | Per-message | `PUT /rooms/{id}/redact/{event}` strips the event's content.                       | No — the content is gone for everyone. The audit row stays.|
| **role_change** | Space-wide  | `PUT /rooms/{id}/state/m.room.power_levels` with a new entry in `users`, fanned out across every child of the parent space plus the space room itself. Roles are server-wide (Discord-style) — promoting someone to Moderator or Admin grants them that PL everywhere in the space. | Yes — issue another `role_change` in the other direction. |

All five route through the SPA's room-member sheet or the ChatPane message toolbar; under the hood the caller's bearer token hits Synapse directly, then the SPA calls `POST /api/rooms/:id/mod-actions` against the engine to record the audit row. The engine re-checks PL ≥ 50 server-side, so a tampered client can't forge an audit row for an action it couldn't actually perform.

For kick / ban / unban / role_change the SPA enumerates `m.space.child` on the parent space, applies the change to each joined child plus the space room, and fires one `mod-actions` POST per room where the call succeeded. Each room's public mod log therefore gets its own row carrying a "Space-wide" reason marker — the trail reads honestly per-room rather than implying a phantom action on a room the caller lacked PL in. Partial failures (rare in practice; Koven admins hold PL ≥ 50 across their space's children) surface as an inline error toast naming the affected count.

The "everything's space-wide" rule has one carve-out worth naming explicitly: Matrix doesn't have a server-level power-level event — PL lives on each room's `m.room.power_levels` — so the fan-out is the implementation of the role concept, not a side-effect of it. A user's PL in any given room is the source of truth for what they can do in that room; the SPA just keeps those values in lockstep across the space.

### Why PL 50 instead of admin-only

The PL-50 cutoff matches the Matrix default for kick/ban/redact. Splitting "trusted moderator" (PL 50) from "space owner" (PL 100) lets a founder hand out enough authority for day-to-day cleanup without giving up the keys to the space. It's the same split Discord uses with the "Manage Messages" / "Manage Channel" permission tiers.

### Reversibility, in detail

- **Kick** is the lightest. The target leaves every room in the space; they can be re-invited or, for public rooms, simply rejoin. Use kick when someone needs to step out — say, to cool down — and you're fine seeing them back tomorrow.
- **Ban** is heavier. Synapse refuses any rejoin attempt in every room of the space until an admin issues `unban`. Use ban for users who shouldn't come back without explicit re-admission.
- **Redact** is permanent for content. The event's body is stripped server-side and there's no undo — Matrix doesn't keep the pre-redaction content anywhere recoverable. The audit row in the mod log, though, stays forever and names both the actor and the original sender. "What was redacted" is gone; "that something was redacted, by whom, when" stays visible.
- **Role change** is fully reversible. Demoting someone is a state event like any other; promoting them back is the same call with a different value. The mod log retains both.

There is no "warn" or "timeout" primitive. If a user needs less than a kick, the moderator can just talk to them — there's nothing for the protocol to enforce in that gap.

---

## Reports

Reports are the member-facing side of moderation. Every registered user can flag any message or any room.

### How a member submits a report

- **Message report.** Hover a message → flag icon → pick a category (Off-topic, Spam, Harassment, Misinformation, Floor violation) and add an optional rationale.
- **Room report.** Flag icon in the chat header, right of the public mod log icon. Same category list, same rationale field.

The wording in the UI is "Report" — the underlying event is still `chat.koven.flag.v1` (the protocol name predates the rename) but to a member the gesture is "send this to admins for review."

Reports against messages travel through the room's timeline as Matrix events. Reports against rooms are submitted over HTTP (`POST /api/rooms/{id}/flag`) so they work from Explore before the reporter has joined — the same surface a flooder is trying to abuse.

Every report immediately appears in the room's public mod log. The mod log is the audit trail; the admin queue is the work queue. They're the same data shaped two different ways.

### What admins see: the Reports sheet

Admins (PL 100 instance-wide — the engine's `is_admin` bit, not the per-room PL) see a shield icon in the SpaceBar, above Settings. A small badge shows the count of open reports. Click it; the **Reports** sheet opens.

The sheet lists every open report across every room on the instance, newest first:

- Reporter mxid.
- Target — either an excerpt of the flagged message, or the room's name.
- Category + rationale.
- Two buttons: **Open in room** (jumps to the room with the offending message scrolled into view) and **Mark resolved** / **Dismiss**.

The expected flow:

1. Admin opens the sheet, sees an open report.
2. Clicks **Open in room**, scrolls to the message, decides whether to act.
3. If action is warranted, uses the standard primitive (kick / ban / redact / change PL) from the message toolbar or the user's profile sheet. That call lands a `mod_action` row in the public mod log.
4. Returns to the sheet, clicks **Mark resolved**. The report transitions from `open` to `actioned`.
5. If no action is warranted, clicks **Dismiss** instead. The report transitions to `dismissed`.

Both terminal states are final-ish: a dismissed report can be reopened by the engine if a future report against the same target arrives, but admins don't re-edit existing rows.

There is no automatic content-classifier today; reports are user-initiated. Operators who want hash-based or model-based pre-screening would have to build that as a separate Synapse module and have it post reports on a bot's behalf.

---

## The public mod log

Every room has a public, append-only mod log. Open it from the **Scale** icon in the chat header. Anyone in the room can read it.

The mod log surfaces, chronologically:

- **Flags / reports** — every flag submitted, every flag retracted. The flagger's mxid is visible.
- **Self-deletions** — sender deleted their own message, or a bot's owner deleted the bot's message. The original sender's mxid is visible.
- **Bot-membership actions** — a founder kicked or banned a bot from the room. The bot, its owner, and the founder are all visible.
- **Mod actions** — kicks, bans, unbans, redactions, and role changes performed by PL-≥-50 users via the standard primitives. The actor, target, action, and (where applicable) reason are visible.

The log is **never edited** and **never deleted**. There is no admin "redact a mod log row" affordance — the row that records a redaction is itself unredactable. This is the consensus-era promise Koven keeps: admins have real authority, but every use of it is in the room's public ledger forever.

A few practical consequences worth being explicit about:

- An admin who consistently silences users with no posted rationale will be visible doing it. The log doesn't enforce justice on its own; it just makes the pattern auditable.
- A founder who hands out PL 50 to friends is doing it on the record. Members can see the role_change row and decide whether they trust the resulting moderator pool.
- A user redacted by an admin can re-post the message — there is nothing in the protocol preventing them — and a second redaction lands a second mod log row. Repeated cycles read as a kick-or-ban warning.

The log does not include flag retraction *as an erasure of the original flag*; the original flag row stays and a separate `flag_retracted` row is appended next to it. Append-only is meant literally.

---

## What this prevents, what it doesn't

**Prevents:**

- Hidden bans. Every ban lands in the per-room public mod log with the actor's mxid and reason. Members can audit who's silencing whom.
- Permabans for trivia. Kick is the default tool for "step out"; ban is reserved for repeat-or-serious cases and is always paired with a visible mod log row, so casual permabans are socially expensive.
- Opaque "the room just got quieter" moderation. Every redaction has an audit row even though the redacted content itself is gone. A reader who comes back tomorrow and finds a thread shorter than they remember can check the log and see what was removed.
- Out-of-band moderation. There is no admin DM channel for "we banned alice, don't tell her why." If alice was banned, the mod log says so.

**Does not prevent:**

- An admin acting unilaterally. PL ≥ 50 is real authority. A single moderator can kick, ban, or redact without consulting anyone else. The check on that power is not a vote; it's that the action is permanently visible to every member of the room.
- A coordinated admin team agreeing to enforce a particular line. They can. The decision is the admin team's; the visibility is the room's.
- A founder appointing themselves a friendly moderator pool. They can. Every promotion is in the log.
- A redaction destroying the content of a message. It does. The audit row remains, the content does not.
- Reports landing on a target who hasn't actually done anything wrong. The dismiss path is exactly that — admins triage reports and discard the ones that don't warrant action. A target who got reported but not acted on sees nothing in the room except (eventually) the report and the dismissal in the public mod log.

Koven is not utopian. It runs standard moderation primitives and trusts admins to use them well. The protocol's contribution is that every use is visible. Sunlight is the check.

---

## Federation note

Koven instances **do not federate** — with each other or with any other Matrix server. Each instance is its own bounded community: its own membership, its own admin pool, its own mod log. Cross-instance DMs, cross-instance rooms, cross-instance reports — none of it exists.

The reasoning hasn't changed since the consensus-moderation era and is laid out in full in the README's "[No federation](../README.md#no-federation)" section and in the setup guide's verification step. Short version: per-instance moderation outcomes plus the public mod log promise depend on the instance being the canonical ledger. A federated room would have N ledgers per N instances, none authoritative, and the "public mod log is the audit trail" claim becomes ambiguous on every dimension.

Operationally: Synapse drops the `federation` listener, `federation_domain_whitelist: []` is set, no `/.well-known/matrix/server` is served, and port 8448 isn't exposed.

---

## Bot moderation

Bots are handled separately. Bots aren't people: the same room-founder authority that lets a PL-100 user kick/ban a human applies to bots too, and on top of that a bot's owner can delete the bot's messages directly. The carve-outs and the rationale are documented in [koven-bot-guide.md](koven-bot-guide.md).

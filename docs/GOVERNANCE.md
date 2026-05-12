# Governance

The mechanics of consensus moderation in Koven, as built. This document describes what the protocol enforces today. Design ideas that aren't wired up yet aren't claimed here.

---

## Core principles

1. **No individual silences anyone for ordinary speech.** Hiding a message in a room requires a community vote that clears both a distinct-flagger gate and a weighted-score gate. No mod with a banhammer; no founder veto.
2. **Everything is logged, forever.** Every flag, every collapse, every suspension is recorded in an append-only per-room public log. No edits, no deletes, no quiet bans.
3. **Reputation-driven sanctions decay.** The reputation system uses rolling 30-day and 90-day windows. Activity ages out; weight drifts back down for users who go silent. There is no path from "the community didn't like what you said" to a permanent removal.
4. **Bans exist for one thing only: confirmed serious-violation content.** CSAM, credible threats, doxxing. A user submits a `floor_violation` flag, an admin reviews, and a confirmed case calls Synapse's deactivate API. Everything else is reversible.

---

## Identity

- Every account is a Matrix user (`@alice:koven.chat`).
- Stable, pseudonymous, portable. Koven needs accountability, not identification.
- All access requires a registered identity. There is no signed-out browse mode for Koven's web client — opening client.koven.chat without a session lands on the sign-in screen. After sign-in, the public **spaces** directory (Explore) is browseable; individual rooms aren't listed there because every room lives inside a space and is reachable through it. Reading a room's messages requires being a logged-in member of that room.
- Sign-in is **passwordless**: users authenticate with a 6-digit code emailed to them on demand (Resend or any SMTP provider, operator's choice). The Matrix account password Synapse stores is rotated to a fresh random string on every sign-in and on every UIA challenge (encryption setup, account deletion). Users never see, type, or recover a password; the email account is the credential. Lose access to the email and the account is unrecoverable. Operators who want a stronger guarantee can layer SSO on top via Synapse's OIDC config.
- Sybil resistance is an operator-side concern: invite-only signup, paid signup, phone gating, or proof-of-personhood. Each Koven instance picks its policy. The protocol's built-in defense is the time-gated reputation ladder (next section): a brand-new account has minimum weight regardless of activity until it ages in.

## Reputation

A user's `weight` determines how much influence their flags carry.

```
raw_weight   =  sqrt(account_age_days × posts_30d × reactions_received_90d)
activity_w   =  clamp(raw_weight, 0.5, 5.0)
weight       =  min(activity_w, age_gated_cap(account_age_days))
```

Activity drives the raw weight up; the age gate is a hard cap that keeps a fresh account from leaping straight to high reputation no matter how active they are. Both have to be satisfied.

**Time-gated tier ladder.** Each tier has a minimum account age. Activity climbs the user toward the next tier in the background; the moment the time gate passes, that accumulated activity applies and the user jumps to whatever tier they qualify for.

| Ticks | Weight range | Color  | Minimum account age |
|-------|--------------|--------|---------------------|
| 0     | 0.5          | empty  | 0 (instant)         |
| 1     | 1.0 to 1.99  | red    | 24 hours            |
| 2     | 2.0 to 2.99  | orange | 7 days              |
| 3     | 3.0 to 3.99  | yellow | 30 days             |
| 4     | 4.0 to 4.99  | green  | 60 days             |
| 5     | 5.0 (cap)    | green  | 90 days             |

- Brand-new accounts sit at the **0.5 floor**. They can flag and vote but each action carries half the weight of an established user. UI shows zero filled ticks.
- The first jump (0.5 to 1.0) requires both 24 hours of age **and** at least three posts. Posts age out of the rolling 30-day window if the user goes silent, so reputation requires sustained presence rather than a one-time burst.
- Reactions received are part of the multiplicative formula but aren't a hard prereq.
- The cap at 5.0 prevents anyone, even decade-old accounts, from accumulating unbounded power.
- A user whose floor-violation flag is **marked as a false report** by an admin (not merely dismissed) gets clamped to the 0.5 floor for 30 days regardless of activity. Two such marks in 30 days, or three ever, also auto-suspend the flagger pending admin review. Cases an admin chooses to **dismiss** (a good-faith mistake) carry no reputation penalty.

## Flagging

Any registered user can flag a **message** or a **room** itself (its name + topic) with one of:

- **Off-topic** (channel-specific, soft signal)
- **Spam**
- **Harassment** (directed at another user)
- **Misinformation** (factual claims demonstrably false)
- **Floor violation** (CSAM, credible threat, or doxx). Bypasses the community vote and routes to admin review. See the Floor section below.

Each flag is recorded as a `chat.koven.flag.v1` event with the flagger, category, and timestamp. The wire format carries a `target_kind: "message" | "room"` discriminator: message flags carry `target_event_id`; room flags carry `target_room_id`. Old clients reading without `target_kind` default to `"message"` for backwards compatibility.

Message flags travel through the room's encrypted (or plaintext) timeline like any other event. Room flags are submitted via HTTP (`POST /api/rooms/{id}/flag`) so they work from the Explore directory before the user has joined — the same surface a flooder is trying to abuse.

The flagging UI surfaces a confirmation dialog before submitting a Floor violation, explaining the consequences of false reports.

## Collapse threshold

A message is **collapsed** (folded behind a "show" link, replaced with category label) when its flags reach two gates simultaneously: a flagger-count gate and a weighted-score gate that scales dynamically with the room's size.

```
distinct_flaggers     =  count of unique users who have flagged
weighted_score        =  sum of (flagger.weight) for distinct flaggers

room_active_weight    =  sum of weights for users who have posted
                         in this room within the last 30 days
threshold_weight      =  clamp(room_active_weight × 0.10, 3.0, 33.0)

collapsed when:  distinct_flaggers >= 3
            AND  weighted_score    >= threshold_weight
```

The **distinct-flagger floor of 3** is hard. Below three distinct people the system never collapses. That's a clique with strong opinions, not consensus.

The **weighted-score gate scales with the room**. It's 10% of the active weighted pool of users posting there, with two clamps:

- A floor of **3.0**. In tiny or low-activity rooms, three baseline users (weight 1.0 each) is the bare minimum the system will ever accept. Below this we wouldn't be measuring "consensus" so much as a couple loud voices.
- A ceiling of **33.0**. Huge rooms (thousands of active users) would otherwise need an unreachable coalition. The ceiling caps the gate at a number that's hard but not impossible: roughly 17 mid-tier flaggers, or 7 high-tier ones.

So at different room scales:

| Active weight (room) | Raw 10% | Effective threshold | Practical coalition size |
|---------------------|---------|---------------------|--------------------------|
| 5                   | 0.5     | 3.0 (floor)         | 3 baseline users         |
| 30                  | 3.0     | 3.0 (floor)         | 3 baseline users         |
| 200                 | 20      | 20.0                | ~10 mid-tier             |
| 2000                | 200     | 33.0 (ceiling)      | ~17 mid-tier             |

The gate scales proportionally with who's actually around to flag, while still preserving the floor (small rooms can self-moderate) and the ceiling (large rooms don't become unmoderable).

A collapsed message is replaced with a placeholder showing the categories that were cited and the flagger count + weighted score that triggered the collapse. The message itself is recoverable by anyone in the room (click "show"); collapse is a soft signal, not deletion.

Floor-violation flags bypass both gates and collapse the message immediately into a **non-revealable** hidden state (no click-to-view affordance). See the Floor section.

## Floor violations

When a user submits a flag with category `floor_violation`, the engine takes four actions in sequence:

1. **Immediate non-revealable collapse.** The flagged message is rendered as a static "Hidden, flagged as a serious violation" banner. Unlike ordinary collapses, there is no expand affordance.
2. **Suspension of the message author.** The author is placed in `pending_review` state. Client-side, the message-composer is disabled and a banner explains why. Server-side, the engine refuses to let them publish a new room or space to the public directory (the `user_may_publish_room` callback rejects suspended users). They can still read, create private rooms, and DM. Full account deactivation only applies on admin confirmation — see step 4.
3. **Public log entry.** The flag, the collapse, and the suspension all show up in the room's public mod log with the flagger's user id attached.
4. **Admin review.** The case lands in the pending-review queue (Settings → Instance → Pending review; visible to admins only). An admin picks one of three outcomes:
   - **Confirm**: the engine calls Synapse's `/_synapse/admin/v1/deactivate/<user_id>`. The account is permanently deactivated server-side; the user can't authenticate from any Matrix client afterward. The suspension row transitions from `pending` to `confirmed`.
   - **Dismiss**: the suspension lifts and the reported user can post again. **No penalty for the flagger.** Use this when the flag was a good-faith mistake — the flagger genuinely believed the content crossed the floor-violation line, but the admin disagrees, and there's no sign of weaponizing. The suspension row transitions to `dismissed`.
   - **Mark as false report**: the suspension lifts AND the originating flagger is penalized (weight clamp + auto-suspension threshold tick — see "False-flag punishment" below). Use this when the report appears malicious or weaponized. The suspension row transitions to `reversed`.

   The admin's choice is recorded in the public mod log so the community can see who's distinguishing malicious from good-faith reports. An admin who always dismisses to avoid drama is publicly visible; so is an admin who marks every reversed case as malicious.

There is no automatic CSAM/threat/doxx classifier today. Detection is user-initiated via the Floor violation flag category. Operators who want hash-based or model-based pre-screening would need to build that as a separate Synapse module or appservice and have it issue floor-violation flags on the engine bot's behalf.

There is no formal appeals process today. A user whose account was confirmed-banned can be restored only by an admin who's willing to reach into the Synapse and engine databases to reverse the deactivation by hand.

## Offensive room names

The flag/collapse pipeline above also applies when the *room itself* is the abuse — a creator gives the room a name that's a slur, a threat, or doxxes a target. The per-message pipeline can't reach a room name, so the room-flag pipeline (`target_kind: "room"`) extends the same primitive to that target.

Four layers run in defense, each closing a different part of the attack surface:

**1. Suspension gate at publish-to-directory.** Synapse's `user_may_publish_room` callback fires on every attempt to publish a room (or space) to the public-rooms directory. The Koven module (`koven-room-gate` in `docker/synapse/modules/`) HTTP-calls the engine, which denies the publish outright for any user with an active suspension (pending or confirmed). Admins are uncapped. There is no reputation-tiered rate limit on room/space creation — that earlier tier table was removed when Koven adopted the Discord-style "rooms inherit from their space" invariant; under that invariant, individual rooms no longer appear in Explore at all (only spaces do), so the room-flood scenario the rate limit guarded against has narrowed to space creation, where the consensus + accumulator pipeline below handles it reactively. Failure modes (engine unreachable) fail open: a flooder slipping through is recoverable via the consensus pipeline; a deadlocked engine that blocks all room creation is worse.

**2. Community consensus on the space or room name itself.** Anyone can flag a space (from its Explore tile) or a room (from its in-room header, Flag icon right of the public mod log Scale icon). The same distinct-flagger floor of 3 and dynamic weighted-score gate that govern message collapse govern name collapse. When the threshold is met:

- The collapsed space's or room's name renders as **"Name Removed by Community Review"** everywhere it appears in the SPA — sidebar, chat header, member sheets, profile mentions. The actual `m.room.name` state event is left untouched; the override is a display concern only, so admin reverse can restore the original verbatim from the engine.
- Synapse's directory listing is flipped from `public` to `private`, removing the entry from local Explore.
- The space or room continues to function for existing members. They can leave; messages still flow if they stay. The collapse silences the *broadcast*, not the conversation.

The placeholder is a deliberate self-documenting artifact. A user seeing "Name Removed by Community Review" in their sidebar knows what happened, can audit the public mod log to see who flagged and why, and can vouch for the original name to admins if they think the collapse was mistaken.

**3. Floor-violation flags on the name.** A flag with category `floor_violation` against the space or room target (e.g. the name is itself a credible threat) bypasses the vote and:

- Immediately collapses the name (single-flag fast-track, same as floor flags on messages).
- Opens a suspension on the *creator* — sender of the original `m.room.create` — pending admin review. The case lands in the same `/api/admin/floor-queue` admins use for message-target floor cases.
- On admin **confirm**: the creator's account is permanently deactivated via Synapse's admin API. Standard floor-violation outcome.
- On admin **reverse**: the suspension lifts, the engine deletes the collapse row, and the directory listing is flipped back to public. Flag rows stay (append-only audit). The original name renders again from `m.room.name`. The flagger eats the standard false-flag penalty if the case ever was floor-class.

(Federation-aware directory hide is moot here: Koven instances don't federate, so there are no peer directories to leak the offensive name into in the first place.  See [Why Koven doesn't federate](#why-koven-doesnt-federate) below.)

Edge case: a space that was already private before being flagged gets re-published to public on admin reverse. That's accepted for v1 — offensive-name attacks land on publicly-discoverable spaces by definition; private-space collapses are exotic.

**4. Repeat-collapse accumulator.** After every space or room collapse, the engine counts how many collapses have been recorded against the same creator overall and within a rolling 30-day window. If either crosses threshold (**3 ever** or **2 in 30 days**), the engine opens a suspension on the creator with a `repeated_room_collapses` reason. The case surfaces in the same admin floor queue as everything else; admins decide whether the pattern warrants deactivation.

The accumulator is the answer to "one bad name is a mistake; ten is a pattern." Floor-fast-tracked collapses skip this accumulator (a suspension was opened on the creator at flag time anyway, and stacking a second case would double-count the same offense).

**Why this layered shape, not a word filter or admin-delete button.** Word blocklists are brittle: someone's slur is someone else's reclaimed identity term. Admin-direct deletion contradicts the platform's premise (community is the moderator). Each layer above is consensus-aligned: Layer 1 is access-protection (suspended users can't publish, period), Layer 2 inherits from the existing flag pipeline, Layer 3 routes the floor-violation case through admin review the same way message-target floor cases go, and Layer 4 is a counter that surfaces a pattern to existing admin review. None of them grant any individual the power to silence speech without the community's say-so, except in the narrow floor-violation category where Koven already grants admins a single-step ban with permanent audit-log visibility.

## Personal block list

Independent of consensus moderation, every user has a Matrix-native block list (`m.ignored_user_list` account data). Adding a user to it hides their messages from your timeline going forward and prevents their DMs from reaching you. The list syncs across devices via account data.

Block is intentionally **separate** from flagging:

- A block is one user's personal filter. It does not contribute to a flag count, does not affect anyone else's view, and does not factor into a target's reputation.
- A flag is a public, weighted signal toward community consensus.

Mixing the two would create a perverse incentive: "block this person" would carry moderation power, and pile-ons would moonlight as bans. Keeping them distinct means a personal "I don't want to read this person" gesture stays personal, and consensus moderation stays consensus-driven.

The blocked-users list is managed in Settings → Account, with a one-click block/unblock from any user's profile.

## Deleting your own messages

A trash icon appears on the message-action toolbar for any message you sent yourself, and for any message sent by a bot you own. Clicking it asks for confirmation, then redacts the underlying Matrix event — the message text disappears for everyone in the room and the row renders as a redaction stub thereafter.

The deletion is recorded in the room's public mod log as a `self_deletion` entry. The text is gone, but the fact that *something was deleted, by whom, when* stays auditable forever. This matches the consensus-collapse pipeline's ethos: the community can always see that an action happened, even when the content of that action is hidden.

Two distinctions matter here:

- **Self-deletion is not a community collapse.** A community collapse means *the room voted you down*; a self-deletion means *you walked it back yourself*. The mod log keeps them visually distinct so a casual reader can tell which is which. Self-deletion bypasses no consensus — it's just the speaker exercising authority over their own content, which they always had.
- **Bot-owner deletion is voluntary on the owner's part, not on the bot's.** The owner of a bot is responsible for its output (they wrote the prompt, they configured the model, they pay for tokens). Letting them redact a message a bot they configured produced is the same authority a human has over their own typing — and gives them a way to fix problems without spinning up the consensus pipeline against a misconfigured bot they're trying to repair.

Self-deletion does not reach back through reactions, reaction history, or anyone's quote of the message in another room — Matrix redaction is local to the original event. Quotes inside *this* room update to render the redacted stub on next reload; quotes someone else made by copy-pasting are theirs to manage.

You can't delete other people's messages — that's the consensus pipeline's job. The engine re-checks server-side: even a tampered client can't redact a message the caller didn't send and doesn't own a bot for.

## Bot moderation

Bots are not people. The free-speech protections that govern this platform — consensus required to silence speech, no admin override on ordinary messages — exist to prevent any individual from suppressing another individual's voice. A bot has no voice in that sense; it's an automated process configured by a human to run an LLM against a prompt. A misbehaving or spammy bot is closer to a misbehaving script than a misbehaving person, and the right authority to stop it is whoever owns the venue it's running in.

Two affordances follow from this:

1. **The bot's owner can delete its messages** (described above). The owner caused the output to exist; they can take it back.
2. **A room's founder can kick or ban a bot from their room.** The kick/ban affordance appears in the bot's profile sheet whenever the viewer is the room creator. It does not require flags, votes, or consensus; the founder presses the button and the bot leaves. The action is logged as a `bot_membership` entry in the room's public mod log (with the bot's mxid, the bot's owner, and the founder's mxid), so other members can see who silenced what.

This is a deliberate carve-out, not a backdoor:

- The founder cannot kick or ban a *human* this way. Human kick/ban requires the consensus pipeline (flags → collapse, or floor-violation → admin review). The kick/ban affordance in the profile sheet only appears for members the engine has registered as bots; trying to call the underlying engine endpoint with a non-bot target returns 403.
- The carve-out is room-scoped. A founder can remove a bot from their own room; they cannot deactivate the bot account or remove it from someone else's room. To remove a bot platform-wide, the bot's owner deletes it from Settings → Bots (their authority over their own bot), or it works through the standard suspension flow if it's posted floor-violating content (the bot's owner gets the suspension, since they're accountable for what they configured).
- Kick is recoverable; ban is not. A kicked bot can rejoin if reinvited; a banned bot is excluded until the founder unbans it. The two-tier choice mirrors how Matrix already works for any participant — we just expose the affordance on bots without the consensus gate.

The mod log surfaces every bot kick and ban indefinitely. A founder who silences a bot pays for it in transparency: every member of the room can see that a particular bot was silenced by a particular person at a particular time. If the founder uses this aggressively or capriciously, the room can see the pattern and decide whether they want to keep using the room.

## Account deletion

Users can permanently delete their own account from Settings → Account. The flow:

1. **Engine cleanup.** Drops the user's reputation row and cancels any pending suspension on them. Posts, reactions, flags, collapses, and mod-log entries they originated stay in place: those describe community decisions, not personal data, and removing them would corrupt the audit trail.
2. **Synapse self-deactivation.** The client calls `POST /_matrix/client/v3/account/deactivate` with the user's password (UIA) and `erase: true`. Synapse retires the username (it can never be re-registered), invalidates all their access tokens, and redacts the contents of every message they've sent room by room.
3. **Last-admin guard.** If the user is the only admin on the instance, deletion is refused server-side until another admin is promoted. Otherwise, floor-violation review on the instance would become impossible.

Deletion is irreversible. The username is gone, the message contents are scrubbed, and there is no undo. Direct conversations on the deactivated user's side disappear; the other party retains their copy of the room (with the user's messages now showing as redactions).

## False-flag punishment

The penalty pipeline only fires when an admin chooses **Mark as false report** on a `floor_violation` suspension — that is, when the admin actively judges the flag as malicious or weaponized rather than a good-faith mistake. **Dismissed** cases (where the admin decided the report was wrong but in good faith) carry no penalty and are explicitly excluded from the threshold counters below.

When the flag IS marked as a false report, the originating flagger is penalized in two ways:

1. **Weight clamp**: their reputation weight is forced to the 0.5 floor for the next 30 days, regardless of their activity history. Their flags during this window count for half a baseline user.
2. **Auto-suspension threshold**: the engine counts the flagger's previous reversed floor flags (status = `reversed` only — `dismissed` rows don't count). If they now have **two reversed flags within 30 days** or **three reversed flags ever**, the engine creates a fresh suspension on the flagger's own account with reason `repeated_false_floor_flags`. They appear in the same admin queue as floor-violation cases. Admin reviews and either confirms (deactivates them), dismisses (clears the auto-suspension, no penalty), or reverses (clears the auto-suspension AND penalizes — though there's no further "second-order flagger" since the engine itself originates these cases with no flagger field).

The first reversed false flag is a one-strike warning that costs the flagger reputation. The second triggers admin scrutiny of the pattern. The third forces it. Each step is gated on the admin's explicit "this was malicious" judgment — the system does not penalize honest mistakes.

This three-way distinction (confirm / dismiss / mark-as-false) is meant to keep two pressures balanced. If every reversed flag carried a penalty, users would stop flagging marginal cases — the cost of being wrong would chill legitimate reporting. If reversed flags carried no penalty at all, users could weaponize floor-violation flags indiscriminately. The dismiss path lets admins say "you were wrong, but you were trying" without nuking the flagger's reputation.

## What admins can and cannot do

A Koven instance has admins. The first user the engine sees on a fresh install is auto-promoted to admin via the bootstrap mechanism in `engine/src/admins.ts`. Subsequent admin appointments would have to be done by hand in the engine database; there is no admin-management UI today.

Admins can:
- Review pending floor-violation cases (message- and room-targeted, plus the engine-generated `repeated_false_floor_flags` and `repeated_room_collapses` cases) and choose one of three outcomes: **confirm** (deactivate the reported account), **dismiss** (lift the suspension, no penalty for the flagger), or **mark as false report** (lift the suspension AND penalize the flagger). The choice is logged.
- Set instance branding via Settings → Instance (server name, login tagline, login background, instance logo, default space for new signups)

Admins explicitly **cannot**:
- Hide ordinary messages from a *human* sender without going through the community flag system. There is no admin "delete" button for human content; the community-vote pipeline is the only path. (Senders can always delete their own messages, and a bot's owner can delete the bot's messages — see *Deleting your own messages* — but this is the speaker exercising authority over their own content, not the admin overriding it.)
- Ban a user for any reason other than confirming a `floor_violation` suspension.
- Override a community-vote collapse.
- Edit the public mod log.

Room **founders** have one additional, narrow carve-out beyond what regular members can do: they can kick or ban a *bot* from a room they founded, without the consensus pipeline. Bots aren't people; see *Bot moderation* for the rationale. Founders cannot kick or ban humans this way — that's still consensus-only.

## Encryption and visibility

Koven enforces a hard rule on room creation and editing:

- **DMs are always encrypted at the chat layer.** They're 1:1 conversations; no consensus moderation applies and the engine has no business reading the content. (Live call media is a separate layer — see *Live calls* below — and is not E2EE.)
- **Encryption is a space-level decision, set once at creation.** At space creation, the founder picks public or private. If private, a second toggle — "End-to-end encryption" — appears. When the founder enables it, the space writes a `chat.koven.space.config` state event with `e2ee_required: true`, and every room subsequently created inside that space is forced encrypted regardless of who creates it. When disabled, every child room is created unencrypted. Per-room encryption toggles do not exist; mixed-encryption spaces aren't a thing. The mental model is "this space is or isn't moderated," and every room inside inherits.
- **Encryption is permanent.** Matrix can't disable encryption on a room once enabled, so the space-level flag is also one-way: a creator who picks "encrypted" at space creation can't loosen the policy later without leaving a permanently encrypted backlog. The toggle exists only at space creation.
- **Public rooms cannot be encrypted.** A public-but-encrypted room would be open to anyone yet invisible to the engine and to admins, which means consensus moderation, the public mod log, and floor-violation review all go silent. That contradicts the platform's premise (public speech needs public accountability), so the encryption toggle is only enabled when the space is private — and the transport refuses any caller who tries to short-circuit this as defense in depth.

Matrix doesn't support disabling encryption on a room once enabled, so a private encrypted room can't later be flipped to public. The visibility toggle in room settings reflects this: encrypted rooms are stuck on private (or you create a fresh public room and migrate by hand).

The flag, mod-log, and floor-violation affordances are also hidden in encrypted rooms client-side. Better to surface no affordance than to let users believe they took an action that won't produce a real review.

URL link previews are likewise disabled in encrypted rooms. Generating a preview means asking Synapse's `/_matrix/media/v3/preview_url` endpoint to fetch the URL, which leaks the URL to the homeserver in plaintext even though the message body is end-to-end encrypted. Since DMs and any private encrypted room are exactly the contexts where users expect the homeserver not to see content, the preview card is hidden. Links remain clickable; they just don't get a card. (A future setting could let users opt back in per-room if they trust their homeserver with that metadata.)

## Live calls

Koven supports voice, video, and screen-share calls in any room. Each room has a Live channel toggle in room settings; when off, the call affordances disappear from that room and existing call sessions can't be rejoined. DMs always have calls available — there's no off switch on a 1:1 conversation. The decision to enable or disable a Live channel sits with the room founder, alongside the existing founder authority to kick or ban a bot from the room.

Calls run on Cloudflare RealtimeKit as the selective forwarding unit. Media (audio, video, screen-share) is **not end-to-end encrypted**: tracks are routed through Cloudflare's edge for the duration of the session, where they could in principle be observed by the SFU operator. The chat layer (Matrix events) and the call layer (Cloudflare media) are separate transports, governed by separate guarantees. A DM has E2EE chat and unencrypted call media. A space room has neither.

The UI surfaces this gap honestly. The Live bar inside a DM reads "voice · video · screen share · not encrypted," so a user entering a DM call can't reasonably believe the call inherits the DM's chat-layer privacy guarantee. In space rooms the "not encrypted" suffix is omitted: nothing in a space room is E2EE in the first place, so flagging only the call would falsely imply the room messages are.

Calls intentionally do not interact with the consensus moderation pipeline:

- A call session has no persistent message log. There's nothing for the engine to record, nothing for the room to flag, nothing for an admin to deactivate.
- A user excluded from a room (kicked or banned at the Matrix layer) loses access to that room's calls as a side effect, since join is gated on room membership. The exclusion happens through whatever pipeline got them out of the room, not a separate call-pipeline.
- A user the community has flagged into suspension (`pending_review` state) can still join a Live channel. Suspension blocks compose, DM creation, and room/space creation — text speech and persistent structures — but not real-time voice. Calls are ephemeral; the consensus tools target persisted speech.

DM calls ring once per outgoing call. The caller's join sends a `chat.koven.call.ring` event to the DM timeline; the recipient's client renders an Incoming Call sheet (with ringtone) for 30 seconds or until the recipient accepts, declines, or the caller cancels. Decline dismisses the recipient's sheet but doesn't block the caller from trying again. There's no missed-call counter and no auto-retry.

Cloudflare retains operational call metadata (session durations, participant ids the engine assigned) per their standard service contract. Koven does not record call sessions to the per-room mod log. Calls are real-time interactions, not a moderation surface.

## Why Koven doesn't federate

Koven instances **do not federate** with each other or with any other Matrix server. Each instance is a self-contained community: its own membership, its own reputation registry, its own consensus moderation outcomes, its own mod log. Cross-instance DMs and cross-instance rooms don't exist; cross-instance reputation doesn't exist.

This is a deliberate design choice, not a configuration default. The reasoning:

**1. Community boundaries get fuzzy under federation.** Koven's whole model is "the community votes on what gets collapsed." When @alice on koven-a flags @bob's message in a room with members from koven-a, koven-b, and koven-c, the consensus question becomes ambiguous: whose vote counts? Just the local instance? Everyone in the room across all instances? There is no honest answer that preserves the "the community decides" promise without contradicting itself on at least one of those readings.

**2. Reputation can't be trusted across servers.** Reputation accumulates with participation in the local engine's view of activity. If koven-b federates in, koven-a's engine has no way to verify or trust koven-b's reputation values for koven-b's users — they're whatever koven-b's engine reports. A bad actor stands up their own Koven instance, grants themselves max reputation, and injects high-weight votes into your community. The "Koven peer" probe gate (when it existed) only verified that the remote was a Koven install, not that its reputation values were trustworthy. Cross-server reputation needs cryptographic provenance plus an out-of-band trust establishment, neither of which Koven provides.

**3. Moderation outcomes diverge per-server.** A collapse on koven-a is local: it flips the SPA's render of the target message to the collapsed placeholder for users connected to koven-a. Koven-b's engine doesn't observe koven-a's collapse, doesn't write a koven-b mod log entry for it, doesn't apply it to koven-b's view of the same federated room. Two communities now see two different versions of "what was moderated." The mod log becomes "per-instance log of what THIS server's community decided," which is a much weaker promise than the canonical record this document otherwise describes.

**4. Operationally, federation grows the attack surface without proportionate benefit.** An open federation port (8448) is a spam/abuse vector; a `/.well-known/matrix/server` route is a discovery signal; remote events have to be authenticated, decrypted, sanitised. None of that work delivers anything users on the local instance can't already do without it.

**Practical consequences for users:**

- `@alice:other-koven.example` mentions don't resolve to clickable profiles.
- matrix.to URLs pointing at users / rooms on other servers go to a dead end.
- Invite flows for users on other servers 4xx at the server and surface as a clean error in the UI.
- DMs with users on other servers stop working at the protocol level — Synapse refuses outbound federation.
- Migration between instances is not free: it requires explicit export/import, not silent cross-instance presence.

**Defense in depth.** Federation isn't just "off by config" — it's off across four layers:

1. Synapse drops the `federation` listener name from its HTTP listener, so it won't accept federation traffic on the port.
2. `federation_domain_whitelist: []` (empty list) makes Synapse explicitly refuse outbound federation to any domain.
3. The reverse proxy serves no `/.well-known/matrix/server` and no `/.well-known/koven` route — remote Matrix servers can't discover the instance.
4. `docker-compose` doesn't expose port 8448 (the dedicated federation port), so even if a layer above misconfigured, there's no public listener.

The `koven-federation-gate` Synapse module (which previously enforced "Koven-to-Koven federation only") has been deleted from the repo. The decision is no longer "selective federation" — it's "no federation."

## What this prevents, what it doesn't

**Prevents:**
- Single-mod tyranny on ordinary speech. Community vote with both flagger-count and weighted-score gates is required to hide any message.
- Quiet bans. Every flag, collapse, and suspension lands in the per-room public mod log.
- Permabans for one bad day. Only floor violations result in bans; everything else decays as the rolling activity windows slide.
- Hidden algorithmic suppression. No algorithm. The math is in this document.
- Offensive-space-name floods. Suspended users can't publish at all; the consensus pipeline cleans the rest reactively; the repeat-collapse accumulator surfaces serial offenders to admin review. (Individual rooms no longer appear in Explore — they live inside spaces — so the directory flood surface has narrowed to space creation, and the per-instance non-federated model means a collapsed name can't leak across to a peer's directory either.)

**Does not prevent:**
- Coordinated brigading by a large hostile group, if they can clear the dynamic threshold for the target room. Mitigated by reputation weighting and the time-gated tier ladder (a fresh account army carries minimum weight); not eliminated.
- Genuine unpopular speech being collapsed by a sufficiently large majority. This is the price of community governance. There is no platform design that lets you say anything to anyone without the room having any say in whether it stays visible.
- False `floor_violation` reports landing the target in suspended state until an admin reviews. The author can't post during the review window. The false-flag punishment described above is the deterrent.
- Admins acting against an individual user via the floor-violation pipeline. Confirming a floor case and deactivating an account is a real power held by a single person. The check on this power is that the action is in the public mod log forever.
- A small window of exposure between when an offensive space is published and when consensus or floor-flag collapse fires. Suspended users are blocked at the publish gate, so prior offenders can't keep flooding, but a first-time publish by an unblemished account will surface to Explore until enough flags arrive. The repeat-collapse accumulator catches sustained patterns but not one-off acts of an otherwise-clean account.
- The Live calls SFU operator (Cloudflare) reading the audio/video/screen-share streams that pass through their edge. Call media is not E2EE; the *Live calls* section says so explicitly and the in-app DM call surface labels it. Users who need fully-private real-time voice should treat the call layer as out-of-scope for the chat-layer encryption guarantees and pick a different tool.
- Real-time abuse during a Live call. Calls produce no message log for the consensus pipeline to work on, and the audio/video stream isn't a moderation surface. There is no "kick from call" affordance — Koven's no-individual-silencing rule applies to calls too; only a confirmed floor-violation case (which targets persisted text, not live audio) can remove a human from anything. In practice, in-call abuse is handled by other participants leaving and reconvening without inviting the harasser. If the bad behavior crosses into text (a threat posted in a chat message), the standard floor-flag → admin-review path still applies.

Koven is not utopian. It moves moderation power from individual mods to a documented, decaying, community-driven process for ordinary speech, and it confines unilateral admin action to a single narrow category (confirmed floor violations) where the action is permanently visible. It does not solve human disagreement.

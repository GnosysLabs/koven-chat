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
- All access requires a registered identity. Reading a room's messages requires being a logged-in member of that room. The public room directory is browseable (you can see what rooms exist and join them), but message content isn't visible to signed-out visitors.
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
- A user whose floor-violation flag is reversed by an admin gets clamped to the 0.5 floor for 30 days regardless of activity. Two reversed false floor flags in 30 days, or three ever, also auto-suspend the flagger pending admin review.

## Flagging

Any registered user can flag any message with one of:

- **Off-topic** (channel-specific, soft signal)
- **Spam**
- **Harassment** (directed at another user)
- **Misinformation** (factual claims demonstrably false)
- **Floor violation** (CSAM, credible threat, or doxx). Bypasses the community vote and routes to admin review. See the Floor section below.

Each flag is a Matrix event of type `chat.koven.flag.v1` with the flagger, target message ID, category, and timestamp. Flags travel through the room's encrypted timeline (in encrypted rooms) or plaintext timeline (otherwise) like any other event.

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
2. **Suspension of the message author.** The author is placed in `pending_review` state. Client-side, this disables compose, DM creation, and room/space creation. They can still read. (Server-side enforcement, in the form of Synapse account deactivation, only applies on admin confirmation, see step 4.)
3. **Public log entry.** The flag, the collapse, and the suspension all show up in the room's public mod log with the flagger's user id attached.
4. **Admin review.** The case lands in the pending-review queue (Settings → Pending review). An admin picks one of two outcomes:
   - **Confirm**: the engine calls Synapse's `/_synapse/admin/v1/deactivate/<user_id>`. The account is permanently deactivated server-side; the user can't authenticate from any Matrix client afterward. The suspension row transitions from `pending` to `confirmed`.
   - **Reverse**: the suspension lifts and the wrongly-accused user can post again. The originating flagger is then penalized (see "False-flag punishment" below).

There is no automatic CSAM/threat/doxx classifier today. Detection is user-initiated via the Floor violation flag category. Operators who want hash-based or model-based pre-screening would need to build that as a separate Synapse module or appservice and have it issue floor-violation flags on the engine bot's behalf.

There is no formal appeals process today. A user whose account was confirmed-banned can be restored only by an admin who's willing to reach into the Synapse and engine databases to reverse the deactivation by hand.

## Personal block list

Independent of consensus moderation, every user has a Matrix-native block list (`m.ignored_user_list` account data). Adding a user to it hides their messages from your timeline going forward and prevents their DMs from reaching you. The list syncs across devices via account data.

Block is intentionally **separate** from flagging:

- A block is one user's personal filter. It does not contribute to a flag count, does not affect anyone else's view, and does not factor into a target's reputation.
- A flag is a public, weighted signal toward community consensus.

Mixing the two would create a perverse incentive: "block this person" would carry moderation power, and pile-ons would moonlight as bans. Keeping them distinct means a personal "I don't want to read this person" gesture stays personal, and consensus moderation stays consensus-driven.

The blocked-users list is managed in Settings → Account, with a one-click block/unblock from any user's profile.

## Account deletion

Users can permanently delete their own account from Settings → Account. The flow:

1. **Engine cleanup.** Drops the user's reputation row and cancels any pending suspension on them. Posts, reactions, flags, collapses, and mod-log entries they originated stay in place: those describe community decisions, not personal data, and removing them would corrupt the audit trail.
2. **Synapse self-deactivation.** The client calls `POST /_matrix/client/v3/account/deactivate` with the user's password (UIA) and `erase: true`. Synapse retires the username (it can never be re-registered), invalidates all their access tokens, and redacts the contents of every message they've sent room by room.
3. **Last-admin guard.** If the user is the only admin on the instance, deletion is refused server-side until another admin is promoted. Otherwise, floor-violation review on the instance would become impossible.

Deletion is irreversible. The username is gone, the message contents are scrubbed, and there is no undo. Direct conversations on the deactivated user's side disappear; the other party retains their copy of the room (with the user's messages now showing as redactions).

## False-flag punishment

When an admin reverses a `floor_violation` suspension, the original flagger is penalized in two ways:

1. **Weight clamp**: their reputation weight is forced to the 0.5 floor for the next 30 days, regardless of their activity history. Their flags during this window count for half a baseline user.
2. **Auto-suspension threshold**: the engine counts the flagger's previous reversed floor flags. If they now have **two reversed flags within 30 days** or **three reversed flags ever**, the engine creates a fresh suspension on the flagger's own account with reason `repeated_false_floor_flags`. They appear in the same admin queue as floor-violation cases. Admin reviews and either confirms (deactivates them) or reverses (clears the auto-suspension).

The first reversed false flag is a one-strike warning that costs the flagger reputation. The second triggers admin scrutiny of the pattern. The third forces it.

## What admins can and cannot do

A Koven instance has admins. The first user the engine sees on a fresh install is auto-promoted to admin via the bootstrap mechanism in `engine/src/admins.ts`. Subsequent admin appointments would have to be done by hand in the engine database; there is no admin-management UI today.

Admins can:
- Review pending floor-violation cases and confirm or reverse them
- Set instance branding via Settings → Instance (server name, login tagline, login background, instance logo, default space for new signups)

Admins explicitly **cannot**:
- Hide ordinary messages without going through the community flag system. There is no admin "delete" button anywhere; the community-vote pipeline is the only path.
- Ban a user for any reason other than confirming a `floor_violation` suspension.
- Override a community-vote collapse.
- Edit the public mod log.

## Encryption and visibility

Koven enforces a hard rule on room creation and editing:

- **DMs are always encrypted.** They're 1:1 conversations; no consensus moderation applies and the engine has no business reading the content.
- **Private rooms can opt into encryption.** Trusted invite-only spaces can choose privacy over moderation reach. Flags submitted there pile up visually but don't trigger collapses or floor-violation review (the engine can't read what was reported).
- **Public rooms cannot be encrypted.** A public-but-encrypted room would be open to anyone yet invisible to the engine and to admins, which means consensus moderation, the public mod log, and floor-violation review all go silent. That contradicts the platform's premise (public speech needs public accountability), so the toggle is disabled in the create-room and room-settings UI, and the transport refuses the request as defense in depth.

Matrix doesn't support disabling encryption on a room once enabled, so a private encrypted room can't later be flipped to public. The visibility toggle in room settings reflects this: encrypted rooms are stuck on private (or you create a fresh public room and migrate by hand).

The flag, mod-log, and floor-violation affordances are also hidden in encrypted rooms client-side. Better to surface no affordance than to let users believe they took an action that won't produce a real review.

URL link previews are likewise disabled in encrypted rooms. Generating a preview means asking Synapse's `/_matrix/media/v3/preview_url` endpoint to fetch the URL, which leaks the URL to the homeserver in plaintext even though the message body is end-to-end encrypted. Since DMs and any private encrypted room are exactly the contexts where users expect the homeserver not to see content, the preview card is hidden. Links remain clickable; they just don't get a card. (A future setting could let users opt back in per-room if they trust their homeserver with that metadata.)

## Federation

Koven instances federate only with other Koven instances. The Synapse module `koven-federation-gate` (in `docker/synapse/modules/`) hooks the spam-checker callback and probes `https://<remote>/.well-known/koven` on first contact with a new homeserver. A valid Koven response means the peer's events are accepted; anything else (vanilla Synapse, 404, malformed JSON) means denied. Cached for 10 minutes on positive matches, 1 minute on negatives. Auto-discovery is symmetric: every Koven install serves `/.well-known/koven` via Caddy.

Encrypted DMs that cross federation boundaries lose the engine's visibility. The engine bot can't read encrypted message content, so flags submitted on encrypted-DM messages don't trigger floor-violation suspensions (the lookup of "who authored the target message" fails). Encrypted DMs are between two endpoints; the consensus moderation primitive applies to plaintext rooms.

## What this prevents, what it doesn't

**Prevents:**
- Single-mod tyranny on ordinary speech. Community vote with both flagger-count and weighted-score gates is required to hide any message.
- Quiet bans. Every flag, collapse, and suspension lands in the per-room public mod log.
- Permabans for one bad day. Only floor violations result in bans; everything else decays as the rolling activity windows slide.
- Hidden algorithmic suppression. No algorithm. The math is in this document.

**Does not prevent:**
- Coordinated brigading by a large hostile group, if they can clear the dynamic threshold for the target room. Mitigated by reputation weighting and the time-gated tier ladder (a fresh account army carries minimum weight); not eliminated.
- Genuine unpopular speech being collapsed by a sufficiently large majority. This is the price of community governance. There is no platform design that lets you say anything to anyone without the room having any say in whether it stays visible.
- False `floor_violation` reports landing the target in suspended state until an admin reviews. The author can't post during the review window. The false-flag punishment described above is the deterrent.
- Admins acting against an individual user via the floor-violation pipeline. Confirming a floor case and deactivating an account is a real power held by a single person. The check on this power is that the action is in the public mod log forever.

Koven is not utopian. It moves moderation power from individual mods to a documented, decaying, community-driven process for ordinary speech, and it confines unilateral admin action to a single narrow category (confirmed floor violations) where the action is permanently visible. It does not solve human disagreement.

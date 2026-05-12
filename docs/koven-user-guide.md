# Koven — User Guide

A complete tour of Koven from a member's perspective. Skim it once when you sign in; come back to the section you need.

---

## What Koven is

Koven is a chat platform built around one rule: **no individual can silence another for ordinary speech.** Anything that hides a message goes through community consensus, and every action is in a public, append-only log anyone in the room can read. No mod with a banhammer; no quiet bans.

Under the hood it's Matrix (the open chat protocol) with a custom governance + product layer on top. You don't need to know what Matrix is to use Koven.

---

## Signing in

Koven is **passwordless**. You enter your email and a 6-digit code arrives in your inbox. Paste the code, you're in. Same flow every time — there's no password to forget, no password manager to update.

**Your account is your email.** If you lose access to the email, you lose the account. Operators can layer SSO on top for instances that need a stronger guarantee.

After your first sign-in Koven walks you through end-to-end encryption setup so your DMs work across devices. The setup screen creates a "recovery key" — **save it somewhere safe**. Without it, signing in on a new device means your old encrypted DMs are unreadable until someone re-shares the keys with you.

---

## The sidebar

Left column, top to bottom:

- **Your avatar.** Click for profile + settings.
- **Compass icon (Explore).** Browse public spaces on this server.
- **Person icon (DMs).** Your direct messages.
- **Bot icon (Bots).** Manage bots you've created (see the bot guide).
- **Space tiles.** One per joined space, with avatar + a notification pill if there's unread activity. Hover for the space name.
- **`+` button.** Create a new space.
- **Gear icon (bottom).** Settings.

Click a space tile and the second column fills with that space's rooms.

---

## Spaces

A **space** is a server (Discord) or workspace (Slack) — a container for related rooms.

### Creating a space

Hit the `+` at the bottom of the sidebar.

- **Name** (required, ≤ 50 chars).
- **Description** (optional). One-line topic.
- **Avatar.** Upload an image, set an emoji icon, or both. Emoji takes priority in the preview.
- **Visibility:**
  - **Public** — appears in Explore, anyone on the server can find and join.
  - **Private** — invite-only. Won't appear in directories.
- **End-to-end encryption** — only available on **private** spaces. When on, every room created inside is automatically end-to-end encrypted, **permanently**. (Encryption can't be turned off later — Matrix limitation.) Comes with trade-offs: no moderation, no flagging, and activity inside doesn't build your reputation. Use for trusted-group / family / small-team installs where you want hard privacy.
- **Mark as NSFW** (if your settings show NSFW). Hides the space from Explore for users who haven't opted into NSFW content. **One-way** — can't be unmarked.

After creation you're the **founder**. Founders can add rooms, edit the space's name/avatar/topic, kick or ban bots from rooms inside the space, and delete the space.

### Joining a space

Four ways:

1. **Explore.** Compass icon → search or browse → click a tile → "Join."
2. **Invite link.** A friend sends you `https://client.koven.chat/invite/<id>` or `koven://invite/<id>`. Click it; if you're already in the space you jump straight in. If not, a confirmation card shows the space's name, avatar, and member count before you commit.
3. **Pasted in a message.** A room or space id pasted in any chat renders as a clickable pill. Same confirmation flow.
4. **A direct Matrix invite from another member.** When someone uses the in-app "Invite" affordance to put you on a space, the invite shows up as a pill at the top of the main view: *"1 Space invite pending · Tap to see details."* Tap it to open a dedicated sheet listing every pending space invite with the inviter, member count, topic, and Accept / Decline per row.  Invite-state spaces never silently appear in your SpaceBar; you see them only after you accept.

When the invite is for an **NSFW-flagged space** and you haven't enabled NSFW content in Settings, the pill calls that out (*"1 NSFW Space invite pending"*) and the sheet hides the name, avatar, and topic behind a placeholder until you explicitly opt in.  Accepting an NSFW invite walks through the same gate dialog (Enable NSFW & accept / Cancel) the existing flag pipeline uses.

When you join a space, **the engine automatically pulls you into every joinable room inside it** — Discord-style "join the server, get all the channels." Public rooms, knockable rooms, and restricted (in-space-members-only) rooms all auto-join. Invite-only rooms inside the space stay invite-gated.

### Leaving a space

Right-click the space tile in the sidebar → **Leave space**. You drop from the space **and every child room you were cascade-joined to in it**, so other members no longer see you as a joined member of those rooms (matching your own view, where the space and its rooms are gone).  You can rejoin later if the space is public or you have an invite link.

### Encrypted spaces

If a space was created with end-to-end encryption, you'll see a green pill on the space's landing page: **"End-to-end encrypted · not moderated."** The trade-off is up front: messages there are private (engine can't read them) but **none of Koven's moderation tools work** — no flagging, no mod log, no reputation gain. The whole space is opaque to the platform. Use only for trusted groups.

---

## Rooms

Rooms are channels inside a space. Discord-style: every room belongs to one space, and the space's posture (public/private, encrypted/not, NSFW/not) is inherited automatically.

### Creating a room

Inside a space you founded, click `+` next to the space's name. The dialog:

- **Name + description** (required name, optional description).
- **Avatar + emoji icon** — same picker as space creation.
- **Live channel toggle.** Default on. When off, the voice/video bar doesn't appear in this room. You can toggle it later from room settings.

Encryption, visibility, NSFW — all inherited from the space, no per-room toggle.

### Room settings

Click the gear icon in the chat header (founder-only). You can:

- Rename, change description, change avatar/emoji.
- Toggle the **Live channel** on/off.
- **Leave** the room.
- **Delete** the room (founder only — kicks everyone, no undo).

### Live channels

Every room has an optional voice/video/screen-share strip at the top. When the channel is **enabled** and at least one person joins, you see a pill at the top showing `Live · N people` and you can join the call with one click.

In DMs the channel is always available and titled "Voice / video call" — see the **Calls** section.

---

## Messaging

### Sending messages

Type in the composer at the bottom, press Enter to send. Shift-Enter for a new line.

Koven supports:

- **Plain text.** Default.
- **Markdown.** Wrap a message in triple-backticks for code, use **bold** / *italic* / `inline code` / lists / blockquotes inline.
- **Emoji.** Type `:smile` for autocomplete, or use the picker (smiley icon).
- **Attachments.** Click the paperclip or drag-and-drop. Images, videos, audio files all preview inline. Documents come through as download links.
- **GIFs.** GIF picker icon in the composer.

### Replying

Hover a message → reply icon (curved arrow). Your reply quotes the original at the top.

### Editing

Hover your own message → pencil icon. Edited messages display an `(edited)` tag.

### Deleting

Hover your own message → trash icon → confirm. The message redacts everywhere in the room (every device, every client). The deletion lands in the room's public mod log as a **Self-deletion** entry (visible to anyone) — the text is gone, but the fact something was deleted is logged forever.

You **cannot** delete other people's messages. That's the consensus pipeline's job (see Flagging).

### Reactions

Hover a message → emoji-plus icon → pick an emoji. Click an existing reaction pill below a message to add/remove your own. Reactions don't notify the sender.

### Mentions

- `@name` autocompletes from room members. Tab to accept.
- The recipient sees a notification highlight.

### Room and space mentions

Paste a `!roomId:server`, `#alias:server`, or a Koven invite/permalink URL in a message. It renders as a clickable pill with the room's name + icon (`#` for room, the grid for space, lock for encrypted). Click it to jump in — already a member, you go directly; not yet a member, the join confirmation card opens.

### Link previews

Drop a URL — if the site has Open Graph metadata, Koven renders a card under your message:

- **Sites with a hero image** (news articles, GitHub repos, YouTube, social posts) → Twitter-style large image on top, title and description below.
- **Sites with small/no image** → compact thumbnail card.
- **Sites without any OG metadata** → text-only card.

YouTube links get an inline player instead of a card. Cards are suppressed in encrypted rooms (the preview would leak the URL to the server, defeating part of the encryption guarantee).

### Files and images

Click an image to open the lightbox. Arrow keys / chevron buttons navigate between images in the room's gallery. Download icon saves a copy.

The **Images icon** in the chat header opens the room's full media gallery — every image and video ever sent.

---

## Direct messages (DMs)

Person icon in the sidebar → `+` → search a user → start.

DMs are **always end-to-end encrypted at the chat layer**. The engine can't read DM messages, and the moderation pipeline doesn't apply (no flagging, no mod log).

DMs list order is currently fixed (most-recently-active first); there's no per-user pinning for DMs.

### Deleting a DM

Open the DM, then in the right-side profile panel click **Delete conversation**.  A confirmation modal explains exactly what's about to happen:

- Every message in the conversation is deleted server-side, atomically, for BOTH of you.
- The other party is removed from the conversation; it disappears from their list on their next sync.
- The action **cannot be undone**.  Media already downloaded to either side's disk (cached attachments) isn't reachable to undo, but the events that referenced it are gone.

If you message that person again afterward, a fresh DM opens; there's no stale conversation to inherit.

### DM calls

Voice and video calls work inside DMs. Click the "Call" button on the Live bar at the top. The other party gets a ringing sheet for 30 seconds — they accept, decline, or you cancel.

**Important:** DM call media is **not** end-to-end encrypted. Audio and video stream through Cloudflare's edge. The Live bar says so explicitly: `voice · video · screen share · not encrypted`. The chat layer of the DM is still E2EE; only the call media isn't.

---

## Live calls

Click the **Join** button on a room's Live bar (or **Call** in a DM). Before entering, the pre-join screen lets you:

- Pick a microphone, camera, speaker.
- Preview your camera.
- Mute mic or turn off camera before joining.

When you accept, Koven prompts for mic + camera permission once per device. After permission is granted, the dropdowns populate with real device names (instead of generic "default").

### In-call controls

Floating bottom toolbar:

- **Mic** toggle.
- **Camera** toggle.
- **Screen share** toggle.
- **Leave** button (red).

### Participants

The grid shows every participant. Click a tile to spotlight that person (everyone else collapses to a thumbnail strip at the bottom). Chevron arrows cycle through spotlights. Click again to un-spotlight.

In DMs the other party is auto-spotlit when they join.

### Picture-in-picture

Leave the room while still in a call → a 240×135 floating panel appears in the corner showing whoever is spotlit. Drag it anywhere. Click to jump back to the call room. Hover for mute/cam/leave/maximize buttons.

### Live calls and moderation

Calls are a real-time/ephemeral surface — they don't go through Koven's consensus pipeline. There's no "kick from call" button (Koven's no-individual-silencing rule applies to calls too). If someone is being abusive in a call, the practical mitigation is for the rest of the participants to leave and reconvene without inviting the harasser.

If their behavior crosses into chat (a threatening text message), the standard floor-flag pipeline still applies.

---

## Flagging (consensus moderation)

The thing that makes Koven different. **You don't trust mods; you trust the room.**

### How it works

- Any registered user can flag a message, a room name, or a space name with one of: **Off-topic**, **Spam**, **Harassment**, **Misinformation**, or **Floor violation** (the serious-stuff category for CSAM / credible threats / doxxing).
- Flags accumulate. When a message reaches **3 distinct flaggers AND** a weighted-score threshold that scales with the room's active population (between 3.0 and 33.0), the message **collapses** — folds behind a "show" link with a placeholder showing the cited categories and the score.
- A collapsed message is **recoverable** by anyone in the room (click "show"). Collapse is a soft signal, not deletion.
- Every flag, every collapse, lands in the room's public mod log.

### Floor violations

The **Floor violation** category is special — it skips the vote and goes straight to admin review:

1. The message is **immediately** collapsed into a non-revealable "Hidden, flagged as serious violation" placeholder. (Unlike normal collapses, no click-to-view.)
2. The author is placed in **suspension** — their composer is disabled and a banner explains why. They can still read but can't post new messages, until an admin reviews the case.
3. An admin reviews and picks one of three outcomes:
   - **Confirm** → the author's account is permanently deactivated.
   - **Dismiss** → suspension lifts. No penalty for the flagger (good-faith mistake).
   - **Mark as false report** → suspension lifts AND the flagger eats a 30-day reputation penalty + possible auto-suspension if they have repeat false reports.

The admin's choice is recorded in the public mod log.

A confirmation dialog appears before submitting a Floor violation — Koven wants to be sure you mean it.

### How to flag a message

Hover a message → flag icon. Pick a category. Add an optional rationale.

### How to flag a room or space

In a room: flag icon in the chat header (right of the mod log icon).
In Explore: flag icon on the space's tile.

### Where flags don't apply

- **Encrypted rooms.** The engine can't read messages there, so flagging would be useless. The UI hides the flag affordance entirely.
- **DMs.** No consensus surface.
- **Federated rooms.** Same limitation — the engine doesn't see content from other servers.
- **Live calls.** Real-time audio/video isn't a moderation surface.

---

## The mod log

Every room has a public, append-only mod log. Open it from the **Scale icon** in the chat header. Anyone in the room can read it.

Entries include:

- Every flag submitted (and any retractions).
- Every message collapse (with flagger count + weighted score that triggered it).
- Every self-deletion (sender deleted their own message, or a bot's owner deleted the bot's message).
- Every floor-violation suspension (with status: pending / confirmed / dismissed / reversed, and the reviewing admin's name).
- Every bot kick or ban a founder did (with the bot's mxid, its owner, and the founder).

The log is **never edited** and **never deleted**. The only check on collective moderation power is sunlight.

---

## Reputation

Each user has a **weight** — a number from 0.5 to 5.0 — that determines how much their flags count.

```
raw_weight = sqrt(account_age_days × posts_30d × reactions_received_90d)
weight     = clamp(raw_weight, 0.5, 5.0)  with an age-gated ceiling
```

You climb the ladder over time:

| Tier | Weight | Color  | Minimum age |
|------|--------|--------|-------------|
| 0    | 0.5    | empty  | 0 (instant) |
| 1    | 1.0+   | red    | 24 hours    |
| 2    | 2.0+   | orange | 7 days      |
| 3    | 3.0+   | yellow | 30 days     |
| 4    | 4.0+   | green  | 60 days     |
| 5    | 5.0    | green  | 90 days     |

Reputation **decays**. The 30-day and 90-day windows are rolling; if you go silent your weight drifts down. No permanent advantages from old activity.

Activity in **encrypted rooms** doesn't count — the engine can't index what it can't read. The Live-bar tooltip in DMs and the green pill on encrypted spaces both spell this out.

Where you see your reputation: profile sheet, next to your name in messages (the dots = filled ticks).

### False-flag penalty

If an admin marks one of your floor-violation flags as a **false report** (not a good-faith mistake — actively weaponized), your weight is clamped to 0.5 for 30 days regardless of activity. Two such marks in 30 days, or three ever, automatically open a suspension case on you.

The deterrent is calibrated: honest mistakes (dismiss path) carry no penalty. Weaponizing the floor flag does.

---

## Blocking users

Independent of consensus moderation — it's a personal filter.

In the user's profile sheet → **Block**. Or right-click a DM → **Block this user**.

Blocking:

- Hides their messages from your timeline going forward.
- Stops them from DMing you.
- Syncs across your devices.
- Does **not** count as a flag, does **not** affect anyone else's view, does **not** affect their reputation.

Manage the list in Settings → Account → Blocked users.

---

## Profiles

Click anyone's name or avatar → profile sheet.

For others: display name, avatar, bio, reputation tier, Koven account age, optional founder number (early users get a perma-displayed ID). Buttons: Start DM, Block, View their owned bots.

For yourself: same plus Edit (display name, avatar, bio).

For bots (more in the bot guide): bot mxid, owner, model, plus — if you're the room's founder — Kick or Ban buttons.

---

## Notifications

Per-room notification levels (room context menu → Notifications):

- **All** — every message notifies.
- **Mentions only** (default) — only when @-mentioned or replied to.
- **Off** — never notifies, room shows no badge.

System-level: Koven uses native OS notifications on macOS, Windows, Linux. They appear in your notification center; clicking jumps to the relevant room.

DMs default to **All** because that's the expected DM behavior.

**What the bell shows:** DMs, @-mentions, and replies to your messages.  Room and space invites used to live there too, but they now have their own dedicated banner + sheet at the top of the app (see *Joining a space*), so the bell stays focused on the things you replied to or got pinged on.

## Presence

Koven shows whether the people in your conversations are around.  Three states:

- **Online** (green dot): actively using the client right now.
- **Away** (amber dot): signed in, but the client has been idle, the tab is in the background, or another window has focus.  Flips automatically after about 5 minutes of inactivity, instantly when you switch tabs or focus a different application.
- **Offline** (no dot): not connected.

You always see yourself as online in your own UI; everyone else sees your real state.  Bots always read as online (they don't go idle).  Encrypted DMs show the per-user dot in the DM row; in regular rooms the member list separates joined members into **Online**, **Away**, **Bots**, and **Offline** sections so you can tell at a glance who's actually around for a real-time conversation.

---

## Deep links

Koven invite + permalink URLs can be shared anywhere — email, Slack, browser bookmark — and clicking them on a machine with Koven Desktop installed launches the app and walks you straight in.

### Share URL formats

- **Invite to a space:** `https://client.koven.chat/invite/<spaceId>` (or alias). The recipient sees a confirmation card with the space's metadata before joining.
- **Permalink to a message:** `https://client.koven.chat/r/<roomId>/<eventId>`. Opens the room and jumps to that message.

### How clicking works

- **In Koven Desktop:** the link is intercepted, the JoinConfirmSheet opens with metadata, you confirm.
- **In a browser:** loads client.koven.chat, signs you in if needed, then joins.
- **On macOS:** clicking any `https://client.koven.chat/invite/...` link in Mail, Messages, or any app launches Koven Desktop directly via Apple Universal Links. No browser detour.
- **Custom scheme:** `koven://invite/<id>` and `koven://r/<roomId>/<eventId>` work the same on Linux and Windows where Universal Links aren't supported.

### Room-link semantics

Koven's Discord-style invariant says rooms are joined through their space, never directly. If you paste or click a link targeting a specific room, the confirmation sheet rewrites it: you join the parent space, and the engine cascade pulls you into every room inside (including the one in the original link).

---

## Settings

Gear icon at the bottom of the sidebar.

- **Account** — display name, avatar, bio, sessions list (devices signed in), blocked users, delete account.
- **Bots** — your bot roster (see the bot guide).
- **Instance** — branding (admin-only): server name, login background, logo, default space new users are auto-joined to.
- **Pending review** (admin-only) — the floor-violation queue.

### Sessions

Each device you sign in on gets its own session. The list shows last-active time + a sensible label (`Koven Web Chrome`, `Koven Desktop macOS`, etc.). Sign out a stale device by hitting the red button next to it.

### Deleting your account

Settings → Account → Delete account (at the bottom, in red).

Flow:

1. Engine clears your reputation row and any pending suspension on you.
2. Synapse retires the username (it can never be re-registered), invalidates every session token, and redacts every message you've ever sent.
3. Posts/flags/collapses/mod-log entries that describe **community decisions** stay — those aren't personal data. The audit trail stays intact.

Irreversible. The username is gone, message contents are scrubbed, no undo. DMs vanish on your side; the other party retains their copy with your messages now showing as redactions.

If you're the only admin on the instance, deletion is refused server-side until another admin is promoted (so floor-violation review doesn't become impossible).

---

## Encryption: the full picture

Koven layers four privacy modes:

| Layer                         | E2EE? | Moderated? | Engine sees content? |
|-------------------------------|-------|------------|----------------------|
| Public space + public room    | No    | Yes        | Yes                  |
| Private space + private room  | No    | Yes        | Yes                  |
| Private + encrypted space     | Yes   | No         | No                   |
| DM (chat layer)               | Yes   | No         | No                   |
| DM (call media)               | No    | n/a        | No (Cloudflare sees) |

- **Public rooms cannot be encrypted.** Public + invisible-to-engine would silence the moderation system entirely.
- **DM chat is always E2EE.** No opt-out.
- **DM call media is NOT E2EE.** Audio + video stream through Cloudflare's edge.
- **Encrypted spaces are permanent.** Matrix can't disable encryption once on.
- **Encrypted rooms have no flag UI, no mod log entries for content, and don't build reputation.**

---

## Live channel checklist

Quick reference for what works where:

- **Public spaces.** Calls available. Not E2EE. Moderation applies to chat (consensus + mod log).
- **Private spaces (no E2EE).** Calls available. Not E2EE. Moderation applies to chat.
- **Private + encrypted spaces.** Calls available. Not E2EE. No moderation.
- **DMs.** Calls available. Chat is E2EE; call media isn't. Ring notification works.

---

## Tips and tricks

- **Pin frequent rooms (space founders only).** Right-click a room in the sidebar → Pin. Pinned rooms stay at the top of that space's list for everyone. Only the space's founder (creator) can pin — regular members see no Pin option. The order is shared across all members of the space.
- **Markdown shortcuts.** \`\`\`code\`\`\` blocks render with syntax highlighting. `>` for blockquotes. Lists with `-` or `1.`
- **Drag-drop.** Drag any file directly onto the chat area to attach.
- **Multi-snap on entry.** Switching to a room scrolls to the bottom automatically — keep posting, you stay pinned to newest.
- **"Jump to newest" pill.** When you scroll up to read older messages, a floating pill appears at the bottom to jump back to the latest. Click to snap.

---

## When something breaks

- **Calls won't connect.** Right-click → Inspect Element → Console tab. Look for `RealtimeKit` errors. Most common: corporate firewall blocking WebRTC, or browser denying mic/cam permission. Re-grant in System Settings → Privacy & Security.
- **Pill / link not resolving.** The room is genuinely private and you're not a member. Synapse won't share the name with non-members. Ask whoever sent the link.
- **Sign-in code didn't arrive.** Check spam. Some providers mark single-purpose codes as suspicious. Operator may have hit their email provider's daily limit on a new install.
- **Encryption setup keeps prompting.** Your recovery key was lost or the local key store was wiped. The setup sheet has a "I lost my key" path; it generates a fresh key and forfeits access to messages older than this device.

---

## Where to learn more

- **Governance (the full rules):** https://koven.chat/governance.html
- **Bot creators:** see the companion **Koven — Bot Guide** for everything about building, wiring, and operating bots.

That's the full user surface. The product is intentionally simple; the unusual depth is in moderation and bots.

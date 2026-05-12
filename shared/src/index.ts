// Shared types for Koven — the chat surface plus the governance layer.
//
// IRC-era types (Network, Buffer, ClientMessage, ServerMessage, etc.)
// were stripped during the Matrix migration.  The chat-domain types here
// are now Matrix-shaped, and the wire protocol is matrix-js-sdk + custom
// `chat.koven.*` event types — there's no Eclipse-bespoke wire format
// any more.

// ─── Domain types (Matrix-shaped) ────────────────────────────────────

export type RoomId = string;     // e.g. "!abc123:eclipse.example"
export type SpaceId = string;    // also a room id — spaces are rooms with type=m.space
export type UserId = string;     // e.g. "@alice:eclipse.example"
export type EventId = string;    // opaque Matrix event id, "$xyz..."

export type RoomKind = "public" | "private" | "dm";

export interface Room {
	id: RoomId;
	name: string;
	topic?: string;
	avatarUrl?: string;
	// Optional emoji icon stored on the room as a Koven-custom state
	// event (`chat.koven.room_icon`).  When set, the UI renders the
	// emoji in place of the avatar/DiceBear fallback so a room can
	// have a single-glyph identity (#general → 🌐) without requiring
	// an uploaded image.
	iconEmoji?: string;
	kind: RoomKind;
	memberCount: number;
	unreadCount: number;
	highlightCount: number;
	encrypted: boolean;          // E2E encrypted? affects governance scope
	// Spaces a room belongs to.  A room can be in zero (orphan, shows
	// under Home) or many spaces.  Populated from m.space.parent state
	// events on the room.
	parentSpaceIds: SpaceId[];
	// For DMs only — the other participant's user id.  Lets the UI
	// show their avatar/identity rather than a generic room one.
	dmUserId?: UserId;
	// For DMs only — Matrix presence of the other participant, in the
	// same 3-bucket model the member list uses.  Drives the live
	// status dot on DM tiles so you can see at a glance who's around
	// without opening each conversation.  Undefined for non-DMs and
	// for DMs where presence hasn't been observed yet.
	dmPresence?: "online" | "unavailable" | "offline";
	// Pending invite state.  When `isInvite` is true, the user has
	// been invited to the room but hasn't joined yet — the UI surfaces
	// it as a request with Accept/Decline buttons rather than a
	// clickable conversation.  `inviter` is who sent the invite.
	isInvite?: boolean;
	inviter?: UserId;
	/** Inviter's display name, when we can resolve it from the room's
	 * member state.  Populated only for invites; the request UI shows
	 * this instead of the raw mxid. */
	inviterDisplayName?: string;
	// Federation: every Matrix room id is `!localpart:homeserver`, so
	// we can tell from the id alone what server hosts it.  The local
	// engine's moderation only applies to rooms hosted by the user's
	// own homeserver — surfacing this in the UI is how we honour the
	// "open federation, but be honest about scope" stance.
	homeserver: string;
	isFederated: boolean;
	// Current user's power level in this room.  Populated for joined
	// rooms; undefined for invites (we don't have full state yet) and
	// for DMs where it's irrelevant.  Used to gate room-settings UI:
	// editing name/topic/avatar/visibility requires PL ≥ 50 by default.
	myPowerLevel?: number;
	// Sender of the original m.room.create event.  The creator can
	// only Delete the room, never Leave it — leaving without
	// promoting a successor would orphan the room with no founder.
	// Other PL-100 admins (delegates) are exempt; they Leave normally.
	creatorId?: UserId;
	// Founder marked this room as adult-content via the
	// `chat.koven.nsfw` state event.  Drives Explore-directory
	// filtering (hidden unless the viewer's "Show NSFW rooms"
	// preference is on) + the NSFW badge on Explore tiles.  Has
	// no effect on joined rooms — once you're in, you're in.
	nsfw: boolean;
	// Whether the per-room voice/video Live channel is enabled.
	// Read from the `chat.koven.live` state event; default true
	// (no event = on, mirroring Discord's "every channel can have
	// voice" baseline).  When false, the RoomVoiceBar at the top
	// of the room is hidden — useful for rooms where voice would
	// be noise (#announcements, #report-a-bug, etc.).  Toggle via
	// the room edit sheet (creator + admins only — state-event PL).
	liveEnabled: boolean;
}

// Spaces are Matrix rooms with `type: "m.space"`.  They don't have
// chat timelines — they're containers whose `m.space.child` state
// events point to member rooms.
export interface Space {
	id: SpaceId;
	name: string;
	topic?: string;
	avatarUrl?: string;
	// Optional emoji icon — see Room.iconEmoji above.  Same custom
	// state event (`chat.koven.room_icon`) since spaces are just
	// rooms with `type: m.space`.
	iconEmoji?: string;
	kind: "public" | "private";
	// True when the space was created with the "all rooms must be
	// E2EE" policy (chat.koven.space.config state event with
	// e2ee_required=true).  Set once at space creation, never
	// unset — Matrix can't disable encryption on a room once on,
	// so loosening this policy retroactively would create a mixed
	// state.  Implies kind="private" (encrypted public rooms are
	// forbidden by governance — see GOVERNANCE.md).  Child-room
	// creation forces encryption + private on every new room.
	e2eeRequired?: boolean;
	// Room ids declared as children via m.space.child.  Source of truth
	// for "rooms in this space" — rooms also list their parents via
	// m.space.parent, but the canonical hierarchy lives on the space.
	childRoomIds: RoomId[];
	// Current user's power level in this space.  Gates founder/admin
	// affordances (Add room, Settings).  Default is 0 for joined-but-
	// not-promoted members; founder is 100.
	myPowerLevel?: number;
	// Sender of the original m.room.create event.  See Room.creatorId.
	creatorId?: UserId;
	// Room ids the space owner has chosen to pin.  Pins are a public
	// affordance — visible to everyone in the space — set via the
	// Koven-custom `chat.koven.pinned_rooms` state event on the space
	// itself.  Order matters: rooms render at the top of the list in
	// this order, with unpinned rooms sorted normally below them.
	// Editing requires PL ≥ 50 in the space (state_default).
	pinnedRoomIds: RoomId[];
	// Founder marked this space as adult-content via
	// `chat.koven.nsfw`.  Same Explore filtering / badge as Room.nsfw.
	nsfw: boolean;
}

// Pending space invite.  Spaces and rooms differ in how pending
// invites surface in the SPA: room invites land in RoomList as
// inline "Requests" rows that already have Accept / Decline / NSFW
// gate handling.  Space invites need their own surface (the SpaceBar
// is a column of icons with no room for inline preview), so this
// type carries everything PendingInvitesSheet renders + everything
// the NSFW gate needs to decide whether to suppress the preview.
//
// `isNsfw` reflects the `chat.koven.nsfw` state event in the
// invite_state Synapse forwards (configured via
// `room_invite_state_types` in homeserver.yaml).  When the
// homeserver omits the type, this falls back to false and the
// post-accept dialog catches it instead, but the preferred path is
// the pre-accept gate driven by this flag.
export interface SpaceInvite {
	id: SpaceId;
	name: string;
	topic?: string;
	avatarUrl?: string;
	memberCount?: number;
	inviter?: UserId;
	isNsfw: boolean;
}

export interface Member {
	userId: UserId;
	displayName: string;
	avatarUrl?: string;
	powerLevel: number;
	// Matrix presence — populated when away-notify-equivalent is on.
	presence?: "online" | "offline" | "unavailable";
	statusMessage?: string;
}

// Mirrors matrix-encrypt-attachment's IEncryptedFile.  Repeated here
// so the shared types don't pull in a client-only dependency.
export interface MediaEncryption {
	url: string;             // mxc:// of the encrypted ciphertext
	key: {
		kty: string;
		key_ops: string[];
		alg: string;
		k: string;
		ext: boolean;
	};
	iv: string;
	v?: string;
	hashes?: { sha256?: string };
}

export type MessageKind =
	| "text"
	| "emote"               // m.emote (the /me of Matrix)
	| "notice"
	| "image"
	| "video"
	| "audio"
	| "file"
	| "poll"                // MSC3381 m.poll.start
	| "system";

/** Poll question + answer set, lifted out of an m.poll.start event.
 * `kind=disclosed` reveals running counts to all voters; `undisclosed`
 * hides them until the poll ends. */
export interface PollDescriptor {
	question: string;
	answers: Array<{ id: string; text: string }>;
	kind: "disclosed" | "undisclosed";
	/** Default 1.  Multiple-choice polls allow up to this many picks. */
	maxSelections: number;
	/** Server time (ms since epoch) when the poll auto-closes.  Set
	 * for undisclosed polls so results actually surface; absent on
	 * disclosed polls where the running counts are visible the whole
	 * time and "no expiry" is the saner default.  When set, clients
	 * disable voting after this time and the creator's client emits
	 * m.poll.end automatically. */
	endsAt?: number;
	/** When true, voters' identities are hidden in the UI — only
	 * aggregate counts are shown.  When false (default), Koven
	 * renders the avatar stack of who voted for what under each
	 * option.  Note: this is presentation-only, NOT a privacy
	 * guarantee — the underlying m.poll.response events still carry
	 * a `sender` and any client (Element, etc.) can read them.
	 * Use undisclosed-until-end for hidden vote *counts*; this flag
	 * just controls voter-identity rendering in Koven. */
	anonymous?: boolean;
}

export interface Message {
	id: EventId;
	roomId: RoomId;
	sender: UserId;
	senderDisplayName: string;
	timestamp: number;       // ms since epoch (server-time)
	text: string;
	kind: MessageKind;
	isHighlight?: boolean;
	isSelf?: boolean;
	// Filled for media messages.  `mediaMxc` is the mxc:// URI on the
	// homeserver — UI components fetch it via the transport's
	// authenticated-media helper rather than stuffing the URL into an
	// <img> tag directly (Synapse 1.100+ requires Authorization
	// headers, which `<img src>` can't send).  When the source room
	// is end-to-end encrypted, `mediaEncrypted` carries the AES-CTR
	// key, IV, and integrity hashes; the transport decrypts the
	// ciphertext into a Blob URL after fetch.
	mediaMxc?: string;
	mediaMimeType?: string;
	mediaName?: string;       // file/image filename (the m.image body)
	mediaSize?: number;       // bytes
	mediaWidth?: number;      // images and videos
	mediaHeight?: number;
	mediaEncrypted?: MediaEncryption;
	// Duration of media in milliseconds.  Set for m.video and m.audio
	// from the event's `info.duration`.  Used for the "1:23" overlay
	// on video tiles + the audio scrubber's total length without
	// having to load the full media just to read its metadata.
	mediaDurationMs?: number;
	// Poster image for m.video events.  The sender extracts a frame
	// at upload time and stamps the resulting mxc into
	// `info.thumbnail_url` (plain rooms) or `info.thumbnail_file`
	// (encrypted rooms, with AES-CTR keys + hashes).  Receivers fetch
	// the poster and render it as `<video poster=…>` so the grid /
	// chat bubble shows a real frame instead of the WKWebView black
	// square that bare `preload="metadata"` paints.
	mediaThumbMxc?: string;
	mediaThumbMimeType?: string;
	mediaThumbWidth?: number;
	mediaThumbHeight?: number;
	mediaThumbEncrypted?: MediaEncryption;
	// True when this message has been edited (via m.replace).  Render
	// with a "(edited)" indicator.
	edited?: boolean;
	// Set on reply messages — the event id + a short text snippet of
	// the message being replied to, plus the original sender's display
	// name.  The snippet is a fallback for when the original isn't in
	// the local timeline (paginated away, etc.).
	replyTo?: {
		eventId: EventId;
		sender: UserId;
		senderDisplayName: string;
		snippet: string;
	};
	// Caption for media messages — separate from the filename (which
	// goes in `mediaName`) per MSC2530.  When the sender attached a
	// file AND typed text in the same compose action, the m.image /
	// m.video / m.file event carries `body` = caption and
	// `filename` = the actual filename; absent the explicit
	// `filename` field, `body` IS the filename and there's no caption.
	// The renderer surfaces this as text underneath the media bubble.
	caption?: string;
	// True iff matrix-js-sdk reported decryption failure for this
	// event.  Renderer uses this to swap the body text out for a
	// friendly placeholder + dim styling, instead of leaking the raw
	// SDK error string ("** Unable to decrypt: …. **") into the
	// timeline.
	decryptionFailed?: boolean;
	// When `decryptionFailed`, the SDK's specific reason code
	// (matrix-js-sdk DecryptionFailureCode enum, kept loose as string
	// so the shared package doesn't have to depend on the SDK).  Lets
	// the renderer pick a per-reason explanation: "waiting for
	// sender's key" vs. "sent before this device existed" vs. "key
	// withheld — verify your device" rather than the same opaque
	// padlock for everything.
	decryptionFailureReason?: string;
	// True for events whose send hasn't been confirmed by the homeserver
	// yet — local echoes still in flight, queued retries after a network
	// drop, encryption-in-progress, or hard-failed sends matrix-js-sdk
	// is keeping around for a manual retry.  The `id` of a pending
	// message is a synthetic SDK-side identifier (typically `~`-prefixed)
	// that no other client or server endpoint knows about, so any
	// server-side action keyed on the id (redaction, reaction, flag)
	// will 404 until the real event id arrives via /sync.  UI components
	// that expose those actions should suppress them while pending.
	pending?: boolean;
	/** Filled when `kind === "poll"`.  Carries the question + answer
	 * set from the m.poll.start content; vote counts and end-state
	 * live in PollAggregate (keyed by event id) so they update without
	 * mutating the timeline message. */
	poll?: PollDescriptor;
}

/** Per-poll aggregate of responses + end-state, keyed by the poll's
 * start event id.  Computed client-side from the timeline (responses
 * carry an m.reference to the start, ends carry the same), the same
 * shape we use for reactions and flags. */
export interface PollAggregate {
	pollId: EventId;
	/** Vote counts by answer id.  For disclosed polls this updates
	 * live; for undisclosed it stays at zero until `endedAt` lands. */
	counts: Record<string, number>;
	/** Per-answer voter lists.  Empty arrays for unvoted answers.
	 * Drives the avatar stack rendered under each option when the
	 * poll isn't anonymous.  Same liveness as `counts` (live for
	 * disclosed, withheld until end for undisclosed). */
	votersByAnswer: Record<string, UserId[]>;
	/** Answer ids the viewer has voted for (empty when not voted). */
	myAnswers: string[];
	/** Event id of the viewer's most recent m.poll.response — used to
	 * change vote (each new response supersedes the previous one
	 * automatically per spec; we keep the id so we could redact if
	 * the server-side aggregation gets out of sync). */
	myResponseEventId?: EventId;
	/** Server time of the m.poll.end event, when one has arrived. */
	endedAt?: number;
	/** Final tallies as snapshotted at end time, lifted from
	 * m.poll.end content.  Falls back to `counts` if the end event
	 * didn't ship explicit results. */
	finalCounts?: Record<string, number>;
	/** User who ended the poll (creator-only per spec). */
	endedBy?: UserId;
}

// Per-message reaction aggregate.  One entry per distinct emoji key.
// Matrix m.reaction events are individually addressable but the UI
// always wants them aggregated, so we collapse on the way in.
export interface ReactionAggregate {
	key: string;             // the emoji or text key, e.g. "👍"
	count: number;
	reactors: UserId[];      // ordered by first reaction time
	// If the current user has reacted with this key, the event id of
	// our own reaction event — needed so we can redact it to "unreact".
	myReactionId?: EventId;
}

// Per-message flag aggregate — visible to everyone in the room as the
// pill next to a message.  Drives the "I see this is flagged, I agree,
// add my flag too" social-proof loop the consensus model depends on.
export interface FlagAggregate {
	count: number;             // distinct flaggers
	flaggers: UserId[];        // ordered by first flag time
	// If the current user flagged this message, the event id of their
	// own flag event — needed so we can redact it to "unflag".
	myFlagId?: EventId;
}

// Per-message collapse marker — the engine emits one of these when a
// flagged message crosses the consensus thresholds.  Presence of an
// entry means "this message is collapsed by community review".
export interface CollapseAggregate {
	targetEventId: EventId;
	collapseEventId: EventId;
	flaggerCount: number;
	weightedScore: number;
	categories: string[];
	timestamp: number;
	fastTrack: boolean;        // true if a floor-violation flag triggered it
}

export interface LinkPreview {
	url: string;
	kind: "image" | "site" | "none";
	title?: string;
	description?: string;
	siteName?: string;
	imageUrl?: string;
	favicon?: string;
}

// ─── Koven governance ────────────────────────────────────────────────

export * from "./governance";

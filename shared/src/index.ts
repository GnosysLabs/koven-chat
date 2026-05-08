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
	| "system";

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
	mediaWidth?: number;      // images only
	mediaHeight?: number;
	mediaEncrypted?: MediaEncryption;
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

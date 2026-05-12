// App state — Matrix-shaped.  Reducer-style; mutations come from the
// MatrixTransport's handlers.
//
// Rooms are keyed by Matrix room id.  Messages are stored per-room,
// chronological.  Membership of the active room is tracked separately
// so the UI can render a member list without re-querying the SDK.

import type { CollapseAggregate, EventId, FlagAggregate, Member, Message, PollAggregate, ReactionAggregate, Room, RoomId, Space, SpaceId, SpaceInvite, UserId } from "@koven/shared";
import type { CollapseEventLite, FlagEventLite, PollEndEvent, PollResponseEvent, ReactionEvent, SyncState } from "@/lib/matrix";

// Per-message reactions, keyed by message event id.
export type ReactionsByMessage = Map<EventId, ReactionAggregate[]>;
// Per-message flags, keyed by message event id.
export type FlagsByMessage = Map<EventId, FlagAggregate>;
// Per-message collapse markers (one per target — engine emits once).
export type CollapsesByMessage = Map<EventId, CollapseAggregate>;
// Per-message poll aggregates, keyed by the poll's start event id.
export type PollsByMessage = Map<EventId, PollAggregate>;
/** Reverse index for last-vote-per-voter: poll id → voter mxid →
 * answer ids.  Each new response from a voter supersedes their
 * previous one per spec; this map lets us back out the previous
 * vote's contribution when re-aggregating counts. */
export type PollVotesIndex = Map<EventId, Map<UserId, string[]>>;

// Reverse index: reaction-event-id → { what it reacted to, what key,
// who sent it }.  Used for removal when a redaction comes in — we
// don't have to scan all aggregates to find the entry.
export interface ReactionRef {
	targetEventId: EventId;
	key: string;
	sender: UserId;
}

// Reverse index for flags: flag-event-id → { target, sender }.
export interface FlagRef {
	targetEventId: EventId;
	sender: UserId;
}

// Reverse index for poll responses: response-event-id → { which poll,
// who voted }.  Used by `poll_response_redacted` to roll back a vote
// when its m.poll.response event is redacted (e.g. the voter manually
// retracted their vote via "Delete message" on the response).  Without
// this, redactions would leave stale counts in pollsByMessage.
export interface PollResponseRef {
	pollId: EventId;
	voter: UserId;
}

// What's selected in the SpaceBar.  Several virtual selections flank
// real user-created spaces:
//   - "explore": homeserver-wide directory of public spaces + rooms
//                the user can browse and join
//   - "dms":     only direct messages
//   - "bots":    the user's bot management view (under DMs in the
//                rail).  Custom AI bots they created — list + create
//                + edit + delete.
//   - "space":   a real Matrix space the user joined or created
// `null` is the brief pre-sync state before we pick a default.
//
// The legacy `{ kind: "rooms" }` (orphan rooms pseudo-space) and the
// short-lived `{ kind: "spaces_overview" }` are both gone: every
// group room belongs to a space (Discord-style invariant), and the
// spaces-list landing was a dead-end empty page users complained
// about getting dumped on.  Mobile users pick spaces from the rail;
// every navigation now lands on a populated surface (dms / a
// specific space / explore).
export type ActiveSpace =
	| { kind: "explore" }
	| { kind: "dms" }
	| { kind: "bots" }
	| { kind: "space"; id: SpaceId }
	| null;

export interface AppState {
	syncState: SyncState;
	rooms: Room[];
	spaces: Space[];
	// Pending SPACE invites (room invites continue to live on the
	// rooms array as `isInvite=true`, surfaced inline in RoomList).
	// Spaces split out because the SpaceBar can't host inline
	// Accept / Decline UI and because letting invite-state spaces
	// fall into `spaces` would re-create the bug where an NSFW space
	// name + avatar surface in SpaceBar before the user has accepted.
	spaceInvites: SpaceInvite[];
	// Map of roomId → user ids currently typing.  Self is excluded
	// at the transport layer.  An empty array (or missing key)
	// means "nobody typing right now", drives whether the chat
	// pane renders its typing indicator row.
	typingByRoom: Map<RoomId, UserId[]>;
	messagesByRoom: Map<RoomId, Message[]>;
	// Set of room ids whose initial timeline page has finished
	// loading.  Distinct from `messagesByRoom.has(roomId)` because
	// the messages-arrived path adds a single live event to a
	// previously-untouched room (e.g. a brand-new invite chunk),
	// which would otherwise misregister as "loaded" while only one
	// event has actually arrived.  ChatPane reads this to suppress
	// "No messages yet." during the brief window between switching
	// into a room and matrix-js-sdk's first timeline batch
	// delivering — without it, every fresh room enter flashes the
	// banner.
	loadedTimelines: Set<RoomId>;
	membersByRoom: Map<RoomId, Member[]>;
	// Mirror of `loadedTimelines` for room membership.  Set the
	// first time `members_loaded` fires for a room id; MemberList
	// reads this to suppress its "No members." flash on first paint.
	loadedMembers: Set<RoomId>;
	reactionsByMessage: ReactionsByMessage;
	reactionRefs: Map<EventId, ReactionRef>;
	flagsByMessage: FlagsByMessage;
	flagRefs: Map<EventId, FlagRef>;
	collapsesByMessage: CollapsesByMessage;
	pollsByMessage: PollsByMessage;
	// Reverse index for "last vote per voter" — see PollVotesIndex.
	// Internal-only; PollCard reads pollsByMessage and never touches
	// this directly.
	pollVotesIndex: PollVotesIndex;
	// Reverse index: response-event-id → { pollId, voter }.  Used to
	// roll back a vote when a poll-response event is redacted; without
	// this the count would stay inflated until the page reloaded.
	pollResponseRefs: Map<EventId, PollResponseRef>;
	// Per-room counter incremented every time matrix-js-sdk fires
	// Room.Receipt.  ChatPane / SeenIndicator components read the
	// counter for the active room to know they need to re-query
	// transport.getMessageSeenBy.  We don't store receipt data
	// itself in state — matrix-js-sdk already owns that — just a
	// version number so React knows when to re-render.
	receiptsVersionByRoom: Map<RoomId, number>;
	activeRoomId: RoomId | null;
	activeSpace: ActiveSpace;
	error: string | null;
}

export const initialState: AppState = {
	syncState: "preparing",
	rooms: [],
	spaces: [],
	spaceInvites: [],
	typingByRoom: new Map(),
	messagesByRoom: new Map(),
	loadedTimelines: new Set(),
	membersByRoom: new Map(),
	loadedMembers: new Set(),
	reactionsByMessage: new Map(),
	reactionRefs: new Map(),
	flagsByMessage: new Map(),
	flagRefs: new Map(),
	collapsesByMessage: new Map(),
	pollsByMessage: new Map(),
	pollVotesIndex: new Map(),
	pollResponseRefs: new Map(),
	receiptsVersionByRoom: new Map(),
	activeRoomId: null,
	// Land on DMs after login.  Spaces overview made the post-login
	// experience disorienting (you'd see a grid of servers but no
	// chat thread); DMs is closer to "what most users do first" and
	// matches Discord's default landing.
	activeSpace: { kind: "dms" },
	error: null,
};

export type Action =
	| { type: "sync_state"; state: SyncState }
	| { type: "rooms_updated"; rooms: Room[] }
	| { type: "spaces_updated"; spaces: Space[] }
	| { type: "space_invites_updated"; invites: SpaceInvite[] }
	| { type: "typing_updated"; roomId: RoomId; userIds: UserId[] }
	| { type: "messages_loaded"; roomId: RoomId; messages: Message[] }
	| { type: "message_arrived"; message: Message; live: boolean }
	| { type: "message_redacted"; roomId: RoomId; eventId: EventId }
	| { type: "members_loaded"; roomId: RoomId; members: Member[] }
	| { type: "reactions_loaded"; reactions: ReactionEvent[]; myUserId: UserId }
	| { type: "reaction_arrived"; reaction: ReactionEvent; myUserId: UserId }
	| { type: "reaction_redacted"; reactionEventId: EventId }
	| { type: "flags_loaded"; flags: FlagEventLite[]; myUserId: UserId }
	| { type: "flag_arrived"; flag: FlagEventLite; myUserId: UserId }
	| { type: "flag_redacted"; flagEventId: EventId }
	| { type: "collapses_loaded"; collapses: CollapseEventLite[] }
	| { type: "collapse_arrived"; collapse: CollapseEventLite }
	| { type: "poll_response_arrived"; response: PollResponseEvent; myUserId: UserId }
	| { type: "poll_response_redacted"; responseEventId: EventId }
	| { type: "poll_end_arrived"; end: PollEndEvent }
	| { type: "set_active_room"; roomId: RoomId | null }
	| { type: "set_active_space"; space: ActiveSpace }
	| { type: "receipts_updated"; roomId: RoomId }
	| { type: "error"; message: string };

export function reduce(state: AppState, action: Action): AppState {
	switch (action.type) {
		case "sync_state":
			return { ...state, syncState: action.state };

		case "rooms_updated":
			return { ...state, rooms: action.rooms };

		case "spaces_updated":
			return { ...state, spaces: action.spaces };

		case "space_invites_updated":
			return { ...state, spaceInvites: action.invites };

		case "typing_updated": {
			// Drop the entry entirely when nobody's typing so a Map
			// lookup of `typingByRoom.get(roomId)` returns undefined
			// instead of an empty array, the chat-pane treats both
			// equivalently but the Map stays bounded by active
			// conversations.
			const next = new Map(state.typingByRoom);
			if (action.userIds.length === 0) {
				next.delete(action.roomId);
			} else {
				next.set(action.roomId, action.userIds);
			}
			return { ...state, typingByRoom: next };
		}

		case "messages_loaded": {
			const next = new Map(state.messagesByRoom);
			next.set(action.roomId, action.messages);
			// Mark the initial-timeline-load complete for this room.
			// Idempotent: subsequent pagination loads also dispatch
			// `messages_loaded` and re-add the same id, which is a
			// no-op on a Set.
			const loaded = new Set(state.loadedTimelines);
			loaded.add(action.roomId);
			return { ...state, messagesByRoom: next, loadedTimelines: loaded };
		}

		case "message_redacted": {
			// Remove the redacted message from the room's timeline so
			// the bubble disappears immediately when a self/bot-owner
			// delete completes.  Without this, matrix-js-sdk applies
			// the redaction internally (event.isRedacted() goes true)
			// but our local message-list snapshot still has the row,
			// so the UI keeps showing it until something else triggers
			// a re-emit (page refresh, room switch).  Reactions and
			// flags have their own redaction reducers; this one is
			// scoped to the actual message-bubble timeline.
			const existing = state.messagesByRoom.get(action.roomId);
			if (!existing) return state;
			const filtered = existing.filter(m => m.id !== action.eventId);
			if (filtered.length === existing.length) return state;
			const next = new Map(state.messagesByRoom);
			next.set(action.roomId, filtered);
			return { ...state, messagesByRoom: next };
		}

		case "message_arrived": {
			const next = new Map(state.messagesByRoom);
			const existing = next.get(action.message.roomId) ?? [];
			// Update-or-insert.  An event id can show up twice for two
			// distinct reasons:
			//
			//   1. Echo of a send we just made — same id, same content,
			//      we want to keep just one entry.
			//   2. Encrypted-then-decrypted — the event first arrives via
			//      Timeline as ciphertext (text "") and later via
			//      MatrixEventEvent.Decrypted with the real body.  In
			//      that case we *must* replace the placeholder, not
			//      drop the update, or the bubble stays empty until a
			//      page refresh re-reads from the SDK's local state.
			//
			// Replacing on duplicate covers both: case 1 is a no-op
			// content-wise, case 2 swaps in the decrypted version.
			const dupIndex = existing.findIndex(m => m.id === action.message.id);
			if (dupIndex !== -1) {
				const updated = existing.slice();
				updated[dupIndex] = action.message;
				next.set(action.message.roomId, updated);
			} else {
				// Insert in chronological order based on timestamp.
				//
				// For plaintext rooms, messages arrive live in the
				// correct order and the insertion point is always the
				// end — the while-loop exits immediately on its first
				// comparison.
				//
				// For encrypted rooms, messages arrive at DECRYPT
				// time, and decryption resolves in any order the rust
				// crypto SDK happens to finish keys in.  An older
				// message that takes 800 ms to decrypt would be
				// appended AFTER a newer message that decrypted in
				// 50 ms — the visible timeline ends up scrambled and
				// then re-arranges itself as the late-decrypts land
				// in the wrong slot.  Appending by send-time instead
				// of decrypt-time pins each message to its real
				// chronological position regardless of decrypt order.
				//
				// Walking from the tail is O(k) where k is the
				// number of newer-than-this messages already in the
				// list.  Live arrivals are O(1); historical
				// backfills + slow decrypts walk further but it's
				// still bounded by the room's local message count
				// (the SDK paginates older history; we only sort the
				// in-memory snapshot).  Ties broken by event id so
				// same-millisecond arrivals are deterministic.
				const updated = existing.slice();
				const incomingTs = action.message.timestamp;
				let i = updated.length - 1;
				while (i >= 0) {
					const cur = updated[i]!;
					if (cur.timestamp < incomingTs) break;
					if (cur.timestamp === incomingTs && cur.id < action.message.id) break;
					i--;
				}
				updated.splice(i + 1, 0, action.message);
				next.set(action.message.roomId, updated);
			}
			return { ...state, messagesByRoom: next };
		}

		case "members_loaded": {
			const loaded = new Set(state.loadedMembers);
			loaded.add(action.roomId);
			const next = new Map(state.membersByRoom);
			next.set(action.roomId, action.members);
			return { ...state, membersByRoom: next, loadedMembers: loaded };
		}

		case "reactions_loaded": {
			// Replay them through reaction_arrived so the aggregation
			// logic lives in one place.  Order matters — earlier
			// reactions get their reactor recorded first.
			let next: AppState = state;
			for (const r of action.reactions) {
				next = applyReaction(next, r, action.myUserId);
			}
			return next;
		}

		case "reaction_arrived":
			return applyReaction(state, action.reaction, action.myUserId);

		case "reaction_redacted":
			return applyReactionRedaction(state, action.reactionEventId);

		case "flags_loaded": {
			let next: AppState = state;
			for (const f of action.flags) {
				next = applyFlag(next, f, action.myUserId);
			}
			return next;
		}

		case "flag_arrived":
			return applyFlag(state, action.flag, action.myUserId);

		case "flag_redacted":
			return applyFlagRedaction(state, action.flagEventId);

		case "collapses_loaded": {
			let next: AppState = state;
			for (const c of action.collapses) {
				next = applyCollapse(next, c);
			}
			return next;
		}

		case "collapse_arrived":
			return applyCollapse(state, action.collapse);

		case "poll_response_arrived":
			return applyPollResponse(state, action.response, action.myUserId);

		case "poll_response_redacted":
			return applyPollResponseRedaction(state, action.responseEventId);

		case "poll_end_arrived":
			return applyPollEnd(state, action.end);

		case "set_active_room":
			return { ...state, activeRoomId: action.roomId };

		case "set_active_space":
			// Switching spaces clears the active room — next render will
			// pick the first available room in the new view, or land on
			// an empty pane.
			return { ...state, activeSpace: action.space, activeRoomId: null };

		case "receipts_updated": {
			// Bump the version counter for this room.  ChatPane's
			// per-message SeenIndicator components subscribe to it
			// and re-query transport.getMessageSeenBy when it
			// changes.  The actual receipt data lives in matrix-
			// js-sdk; we only track the version to know when to
			// re-render.
			const next = new Map(state.receiptsVersionByRoom);
			next.set(action.roomId, (next.get(action.roomId) ?? 0) + 1);
			return { ...state, receiptsVersionByRoom: next };
		}

		case "error":
			return { ...state, error: action.message };
	}
}

function applyReaction(state: AppState, r: ReactionEvent, myUserId: UserId): AppState {
	// Idempotent — re-deliveries during reconnect shouldn't double-count.
	if (state.reactionRefs.has(r.eventId)) return state;

	const reactionsByMessage = new Map(state.reactionsByMessage);
	const reactionRefs = new Map(state.reactionRefs);
	reactionRefs.set(r.eventId, { targetEventId: r.targetEventId, key: r.key, sender: r.sender });

	const existing = reactionsByMessage.get(r.targetEventId) ?? [];
	const idx = existing.findIndex(a => a.key === r.key);
	const cur = idx === -1 ? null : existing[idx]!;
	if (!cur) {
		reactionsByMessage.set(r.targetEventId, [
			...existing,
			{
				key: r.key,
				count: 1,
				reactors: [r.sender],
				myReactionId: r.sender === myUserId ? r.eventId : undefined,
			},
		]);
	} else {
		// Same user, same key — Matrix lets a client send it twice, but
		// it's still one vote.  Skip the count bump.
		if (cur.reactors.includes(r.sender)) {
			return { ...state, reactionRefs };
		}
		const nextList = [...existing];
		nextList[idx] = {
			...cur,
			count: cur.count + 1,
			reactors: [...cur.reactors, r.sender],
			myReactionId: r.sender === myUserId ? r.eventId : cur.myReactionId,
		};
		reactionsByMessage.set(r.targetEventId, nextList);
	}
	return { ...state, reactionsByMessage, reactionRefs };
}

function applyReactionRedaction(state: AppState, reactionEventId: EventId): AppState {
	const ref = state.reactionRefs.get(reactionEventId);
	if (!ref) return state;

	const reactionsByMessage = new Map(state.reactionsByMessage);
	const reactionRefs = new Map(state.reactionRefs);
	reactionRefs.delete(reactionEventId);

	const list = reactionsByMessage.get(ref.targetEventId);
	if (!list) return { ...state, reactionRefs };

	const idx = list.findIndex(a => a.key === ref.key);
	if (idx === -1) return { ...state, reactionRefs };

	const cur = list[idx]!;
	if (cur.count <= 1) {
		// Last reactor with this key — remove the entry entirely.
		const nextList = list.slice(0, idx).concat(list.slice(idx + 1));
		if (nextList.length === 0) reactionsByMessage.delete(ref.targetEventId);
		else reactionsByMessage.set(ref.targetEventId, nextList);
	} else {
		const nextList = [...list];
		nextList[idx] = {
			...cur,
			count: cur.count - 1,
			reactors: cur.reactors.filter(u => u !== ref.sender),
			myReactionId: cur.myReactionId === reactionEventId ? undefined : cur.myReactionId,
		};
		reactionsByMessage.set(ref.targetEventId, nextList);
	}
	return { ...state, reactionsByMessage, reactionRefs };
}

function applyFlag(state: AppState, f: FlagEventLite, myUserId: UserId): AppState {
	if (state.flagRefs.has(f.eventId)) return state;

	const flagsByMessage = new Map(state.flagsByMessage);
	const flagRefs = new Map(state.flagRefs);
	flagRefs.set(f.eventId, { targetEventId: f.targetEventId, sender: f.sender });

	const cur = flagsByMessage.get(f.targetEventId);
	if (!cur) {
		flagsByMessage.set(f.targetEventId, {
			count: 1,
			flaggers: [f.sender],
			myFlagId: f.sender === myUserId ? f.eventId : undefined,
		});
	} else {
		// One flag per user per message — re-flagging by the same user
		// shouldn't double-count.
		if (cur.flaggers.includes(f.sender)) {
			return { ...state, flagRefs };
		}
		flagsByMessage.set(f.targetEventId, {
			count: cur.count + 1,
			flaggers: [...cur.flaggers, f.sender],
			myFlagId: f.sender === myUserId ? f.eventId : cur.myFlagId,
		});
	}
	return { ...state, flagsByMessage, flagRefs };
}

function applyCollapse(state: AppState, c: CollapseEventLite): AppState {
	// First-write-wins: the engine emits one collapse per target.  If
	// somehow we receive a duplicate, we ignore it.
	if (state.collapsesByMessage.has(c.targetEventId)) return state;
	const collapsesByMessage = new Map(state.collapsesByMessage);
	collapsesByMessage.set(c.targetEventId, {
		targetEventId: c.targetEventId,
		collapseEventId: c.eventId,
		flaggerCount: c.flaggerCount,
		weightedScore: c.weightedScore,
		categories: c.categories,
		timestamp: c.timestamp,
		fastTrack: c.fastTrack,
	});
	return { ...state, collapsesByMessage };
}

/** Recompute a poll's counts + per-answer voter lists from scratch
 * given its voter→answers map.  Cheap (votes are bounded by member
 * count) and avoids subtle desync bugs from incremental adjustments.
 *
 * Voter lists are sorted by mxid for stable rendering — the avatar
 * stack would otherwise reshuffle on every vote change. */
function recomputePollTallies(
	votes: Map<UserId, string[]>,
): { counts: Record<string, number>; votersByAnswer: Record<string, UserId[]> } {
	const counts: Record<string, number> = {};
	const votersByAnswer: Record<string, UserId[]> = {};
	for (const [voter, answers] of votes.entries()) {
		for (const a of answers) {
			counts[a] = (counts[a] ?? 0) + 1;
			(votersByAnswer[a] ??= []).push(voter);
		}
	}
	for (const a of Object.keys(votersByAnswer)) {
		votersByAnswer[a]!.sort();
	}
	return { counts, votersByAnswer };
}

function applyPollResponse(
	state: AppState,
	r: PollResponseEvent,
	myUserId: UserId,
): AppState {
	const pollVotesIndex = new Map(state.pollVotesIndex);
	const pollsByMessage = new Map(state.pollsByMessage);
	const pollResponseRefs = new Map(state.pollResponseRefs);
	const existing = pollsByMessage.get(r.pollId) ?? {
		pollId: r.pollId,
		counts: {},
		votersByAnswer: {},
		myAnswers: [],
		myResponseEventId: undefined,
	} as PollAggregate;

	// Late responses after the poll's been ended are ignored per spec.
	if (existing.endedAt && r.timestamp > existing.endedAt) return state;

	const voters = new Map(pollVotesIndex.get(r.pollId) ?? new Map<UserId, string[]>());
	// "Last response per voter wins."  Only adopt this response if its
	// timestamp is newer than the voter's previous one — out-of-order
	// delivery (federation backfill) shouldn't clobber a fresher vote.
	const prevTimestamp = (existing as any)._lastVoteTs?.[r.voter] as number | undefined;
	if (prevTimestamp !== undefined && r.timestamp < prevTimestamp) return state;

	// Empty answer set means "withdraw vote" per spec.  Treat the same.
	if (r.answerIds.length === 0) {
		voters.delete(r.voter);
	} else {
		voters.set(r.voter, r.answerIds);
	}
	pollVotesIndex.set(r.pollId, voters);

	const { counts, votersByAnswer } = recomputePollTallies(voters);
	const myAnswers = r.voter === myUserId
		? r.answerIds
		: existing.myAnswers;
	const myResponseEventId = r.voter === myUserId
		? r.eventId
		: existing.myResponseEventId;
	pollsByMessage.set(r.pollId, {
		...existing,
		counts,
		votersByAnswer,
		myAnswers,
		myResponseEventId,
	});
	// Track per-voter latest timestamp via a private field so we can
	// reject older deliveries above.  Stays in the aggregate so it
	// survives reducer pure-function semantics.
	const aggWithTs = pollsByMessage.get(r.pollId) as PollAggregate & {
		_lastVoteTs?: Record<UserId, number>;
	};
	aggWithTs._lastVoteTs = {
		...(aggWithTs._lastVoteTs ?? {}),
		[r.voter]: r.timestamp,
	};

	// Index this response so a future redaction can roll the vote
	// back.  We only need to remember the LATEST response event id
	// per voter — earlier responses have been superseded, so even if
	// one of those older event ids gets redacted, the current vote
	// is unaffected.  Map.set overwrites, which is the behavior we
	// want.
	pollResponseRefs.set(r.eventId, { pollId: r.pollId, voter: r.voter });

	return { ...state, pollsByMessage, pollVotesIndex, pollResponseRefs };
}

/** A poll-response event got redacted (voter manually deleted their
 * own m.poll.response, or an admin redacted it).  Removes the
 * voter's contribution to the poll if this redacted event was their
 * latest response.  No-op if we never indexed the response (e.g.
 * already superseded by a newer one — only the latest is in
 * pollResponseRefs). */
function applyPollResponseRedaction(state: AppState, responseEventId: EventId): AppState {
	const ref = state.pollResponseRefs.get(responseEventId);
	if (!ref) return state;
	const pollResponseRefs = new Map(state.pollResponseRefs);
	pollResponseRefs.delete(responseEventId);

	const pollVotesIndex = new Map(state.pollVotesIndex);
	const voters = new Map(pollVotesIndex.get(ref.pollId) ?? new Map<UserId, string[]>());
	voters.delete(ref.voter);
	pollVotesIndex.set(ref.pollId, voters);

	const pollsByMessage = new Map(state.pollsByMessage);
	const existing = pollsByMessage.get(ref.pollId);
	if (!existing) return { ...state, pollResponseRefs, pollVotesIndex };

	const { counts, votersByAnswer } = recomputePollTallies(voters);
	pollsByMessage.set(ref.pollId, {
		...existing,
		counts,
		votersByAnswer,
		// Clear the viewer's vote echo if the redaction was theirs.
		myAnswers: existing.myResponseEventId === responseEventId ? [] : existing.myAnswers,
		myResponseEventId: existing.myResponseEventId === responseEventId
			? undefined
			: existing.myResponseEventId,
	});
	return { ...state, pollsByMessage, pollVotesIndex, pollResponseRefs };
}

function applyPollEnd(state: AppState, e: PollEndEvent): AppState {
	const pollsByMessage = new Map(state.pollsByMessage);
	const existing = pollsByMessage.get(e.pollId) ?? {
		pollId: e.pollId,
		counts: {},
		votersByAnswer: {},
		myAnswers: [],
	} as PollAggregate;

	// First-end wins.  A later end event from the same creator is a
	// no-op (the spec doesn't define re-opening polls).
	if (existing.endedAt) return state;

	pollsByMessage.set(e.pollId, {
		...existing,
		endedAt: e.timestamp,
		endedBy: e.endedBy,
		// finalCounts: prefer the sender-provided snapshot for
		// undisclosed polls; fall back to live counts (the only
		// authoritative number we have for disclosed).
		finalCounts: e.finalCounts ?? existing.counts,
	});
	return { ...state, pollsByMessage };
}

function applyFlagRedaction(state: AppState, flagEventId: EventId): AppState {
	const ref = state.flagRefs.get(flagEventId);
	if (!ref) return state;

	const flagsByMessage = new Map(state.flagsByMessage);
	const flagRefs = new Map(state.flagRefs);
	flagRefs.delete(flagEventId);

	const cur = flagsByMessage.get(ref.targetEventId);
	if (!cur) return { ...state, flagRefs };

	if (cur.count <= 1) {
		flagsByMessage.delete(ref.targetEventId);
	} else {
		flagsByMessage.set(ref.targetEventId, {
			count: cur.count - 1,
			flaggers: cur.flaggers.filter(u => u !== ref.sender),
			myFlagId: cur.myFlagId === flagEventId ? undefined : cur.myFlagId,
		});
	}
	return { ...state, flagsByMessage, flagRefs };
}

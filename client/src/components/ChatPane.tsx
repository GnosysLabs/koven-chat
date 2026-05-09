// Chat pane — messages of the active room + send input.  Bubble-style
// layout: avatar + display name shown once per consecutive group of
// messages from the same sender (within 5 minutes); each message
// renders in its own rounded bubble.  Self messages use the primary
// bubble color; everyone else uses the muted card color.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CollapseAggregate, EventId, FlagAggregate, FlagCategory, Member, Message, PollAggregate, ReactionAggregate, Room, RoomId, UserId } from "@koven/shared";
import { cn } from "@/lib/utils";
import { COLLAPSED_NAME } from "@/lib/collapsedRooms";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { ReactionPills } from "@/components/ReactionPills";
import { MessageActions } from "@/components/MessageActions";
import { BotBadge } from "@/components/BotBadge";
import {
	MentionAutocomplete,
	activeMentionToken,
	scoreCandidate,
	type AutocompleteCandidate,
} from "@/components/MentionAutocomplete";
import { serverOf } from "@/lib/mxid";
import { FlagDialog } from "@/components/FlagDialog";
import { DeleteMessageDialog } from "@/components/DeleteMessageDialog";
import { firstLink, linkify } from "@/lib/linkify";
import { renderWithMentions } from "@/lib/mentionRender";
import { findYouTubeMatches, stripYouTubeUrls } from "@/lib/youtube";
import { YouTubeEmbed } from "@/components/YouTubeEmbed";
import { GifPicker } from "@/components/GifPicker";
import { PollCard } from "@/components/PollCard";
import { CreatePollDialog } from "@/components/CreatePollDialog";
import { GallerySheet } from "@/components/GallerySheet";
import { MarkdownContent } from "@/components/MarkdownContent";

// Heuristic: does this body have any markdown shape?  Cheap regex
// pass — looks for headings, lists, fenced code, emphasis, links,
// blockquotes.  Used to skip the markdown renderer for short
// vanilla messages so a one-liner like "ok" doesn't pay for AST
// parsing.
function looksLikeMarkdown(s: string): boolean {
	if (!s) return false;
	// Heading on its own line, fenced code, list bullet, or numbered
	// list at line start.
	if (/(^|\n)(#{1,6} |[*\-+] |\d+\. |> |```)/.test(s)) return true;
	// Inline emphasis or links anywhere.
	if (/\*\*[^\n*]+\*\*|__[^\n_]+__|\*[^\n*]+\*|_[^\n_]+_|`[^`\n]+`|\[[^\]]+\]\([^)]+\)/.test(s)) return true;
	return false;
}

/** iMessage / Telegram-style emoji-only sizing.
 *
 * Returns 1, 2, or 3 when the message is purely emoji (modulo
 * whitespace) and short enough to qualify for the "blow it up" treat-
 * ment; null otherwise.  Returns null for 4+ emojis (treat as a normal
 * bubble) so a long sticker-spam message doesn't dominate the column.
 *
 * Uses Intl.Segmenter to count graphemes properly — a single emoji
 * like 👨‍👩‍👧 is a ZWJ sequence of multiple codepoints, but counts as
 * one visual character.  Anything with letters or digits is rejected
 * up-front so "ok 👍" stays bubbled. */
function emojiOnlyCount(text: string): 1 | 2 | 3 | null {
	const t = text.trim();
	if (!t) return null;
	// Fast disqualifier: any letter or digit anywhere → not emoji-only.
	if (/[\p{L}\p{N}]/u.test(t)) return null;
	// Need a Segmenter to count user-perceived characters; fall back
	// to length-bound bail-out on the rare engine without it.
	const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
	if (!Segmenter) return null;
	const seg = new Segmenter(undefined, { granularity: "grapheme" });
	let count = 0;
	for (const { segment } of seg.segment(t)) {
		if (/^\s+$/.test(segment)) continue;
		// Each non-whitespace grapheme must contain at least one
		// pictographic codepoint to qualify.  Filters out punctuation-
		// only "messages" like "!!!", which would otherwise pass the
		// no-letters-no-digits check.
		if (!/\p{Extended_Pictographic}/u.test(segment)) return null;
		count++;
		if (count > 3) return null;
	}
	return count === 1 || count === 2 || count === 3 ? count : null;
}
import { useMatrixAttachment } from "@/lib/useMatrixAttachment";
import { useMatrixMedia } from "@/lib/useMatrixMedia";
import { useUrlPreview } from "@/lib/useUrlPreview";
import { useTransport } from "@/lib/transportContext";
import { messageMentionsUser } from "@/lib/mention";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, BarChart3, CornerDownRight, Download, EyeOff, File as FileIcon, Flag, Globe, Images, Lock, Network, Paperclip, Phone, Scale, Settings, UserPlus, Video, X } from "lucide-react";

export interface ChatPaneProps {
	room: Room | null;
	messages: Message[];
	memberAvatars: Map<string, string | undefined>;   // userId → mxc URL
	reactionsByMessage: Map<EventId, ReactionAggregate[]>;
	flagsByMessage: Map<EventId, FlagAggregate>;
	collapsesByMessage: Map<EventId, CollapseAggregate>;
	onSendMessage(text: string, replyTo: EventId | null): void;
	// Upload + send a file attachment.  Returns once the event has been
	// dispatched; the parent handles errors via the global error
	// dispatcher.  Optional — when omitted the attach button is hidden.
	onSendAttachment?(file: File, replyTo: EventId | null, caption: string | null): Promise<void>;
	onReact(eventId: EventId, emoji: string): void;
	onUnreact(reaction: ReactionAggregate): void;
	onFlag(eventId: EventId, category: FlagCategory, rationale?: string): void | Promise<void>;
	onUnflag(flagEventId: EventId): void | Promise<void>;
	onAcceptInvite(roomId: EventId): void | Promise<void>;
	onDeclineInvite(roomId: EventId): void | Promise<void>;
	onInvite(roomId: EventId): void;
	onEditRoom(roomId: EventId): void;
	// Place a 1:1 voice or video call into the active room.  Only
	// surfaced for DMs in the header — the parent decides whether to
	// pass a no-op (e.g. while another call is already in progress).
	onPlaceCall(roomId: EventId, video: boolean): void;
	// True when a call is in progress anywhere in the app — the
	// header hides the Call buttons so we can't double-place.
	callInProgress: boolean;
	// Engine-reported suspension state for the current user.  When
	// true, the compose row, call buttons, and invite affordance are
	// disabled.  Read remains allowed.  The full-width banner above
	// the app explains the situation.
	isSuspended: boolean;
	// Open the per-room public mod log dialog.
	onOpenModLog(roomId: EventId): void;
	// Submit a room-target flag (the offensive-room-name pipeline) —
	// rendered as a Flag icon right of the mod log icon in the header.
	// Optional: when omitted (DMs, encrypted rooms, etc.) the icon is
	// hidden.  Throws on engine-side rejection so the dialog can show
	// the error inline.
	onFlagRoom?(roomId: EventId, category: FlagCategory, rationale?: string): void | Promise<void>;
	// Display-name override.  When this set contains the active room
	// id, the header renders "Name Removed by Community Review" in
	// place of the room name.  Same set the SPA-wide RoomList +
	// SpaceLanding consume.
	collapsedRoomIds?: Set<string>;
	// mxids that should render with a BOT badge next to their name
	// (sender labels, reply-quote labels).  Default empty Set means
	// no badges — safe pre-fetch state.
	botMxids?: Set<string>;
	// Subset of botMxids the viewer owns — used to gate the trash
	// button on bot messages.  Empty Set means the viewer has no
	// bots; non-empty means show Delete on rows whose sender is in
	// here.  Always passed as a Set so MessageRow can do O(1) lookups
	// without re-deriving from BotSummary[].
	myOwnedBotMxids?: Set<string>;
	// True once the active room's initial timeline page has finished
	// loading.  When false, ChatPane suppresses the "No messages yet"
	// banner — without this, switching into a fresh room flashes the
	// banner during the brief window between activeRoomId changing
	// and matrix-js-sdk delivering the first timeline batch through
	// the reducer.  The parent threads this from a Set of
	// known-loaded room ids.
	messagesLoaded?: boolean;
	// Self-delete a message.  Returns once the engine has redacted
	// the underlying Matrix event AND written the audit row.  Errors
	// bubble up to the parent error dispatcher.  Optional — when
	// omitted, the trash icon is never shown (e.g. logged-out, DM
	// with limited capabilities, etc.).
	onDeleteMessage?(eventId: EventId): Promise<void>;
	// Joined members of the active room.  Drives the @-mention
	// autocomplete in the compose box.  Optional; when omitted only
	// bot mxids are suggestible.
	members?: Member[];
	// Viewer's own server (e.g. "koven.chat") — drives the same-
	// server mxid shorthand on insert: `@bot-foo` instead of
	// `@bot-foo:koven.chat`.  Pulled from the current user's mxid
	// upstream.
	viewerServer?: string | null;
	// Paginate the room's timeline backwards (older history).  Called
	// by the scroll handler when the user reaches near the top of
	// the loaded timeline.  Returns true if more events landed,
	// false at the start-of-room.  Caller is responsible for
	// re-emitting the message list to state after success.
	onLoadMoreHistory?(roomId: RoomId): Promise<boolean>;
	// Per-room version counter that bumps on every Room.Receipt event
	// matrix-js-sdk delivers for this room.  Drives re-renders of the
	// SeenIndicator components on each message (which re-query
	// transport.getMessageSeenBy when the version changes).  Optional;
	// defaults to 0 — without it the indicators just won't update
	// live, but the initial render is still correct.
	receiptsVersion?: number;
	// Viewer's MXID — drives the @-mention highlight on incoming
	// messages (Discord-style left-border + tinted bg when the row
	// pings the viewer, including reply-to-me).  Optional; falls
	// back to no highlighting when omitted.
	viewerUserId?: UserId;
	// Click handler for the mention pills rendered inline in
	// message bodies — should open the targeted user's profile
	// sheet.  Optional; without it the pills still render but
	// clicks are no-ops.
	onOpenProfile?(userId: UserId): void;
	// Bearer token used for the engine's Giphy proxy (search /
	// trending).  Required for the GIF picker to work; absent or
	// empty keeps the picker hidden even if the integration is
	// configured.
	accessToken?: string;
	// True when the instance admin has set a Giphy API key — drives
	// the GIF picker affordance next to the paperclip.  Optional;
	// defaults to "off" so instances without Giphy don't see the
	// button at all.
	giphyEnabled?: boolean;
	// Per-message poll aggregates, keyed by the poll's start event id.
	// Drives the live vote counts + viewer-selected-answers state on
	// PollCard.  Mirror of the App reducer's `pollsByMessage` map.
	pollsByMessage?: Map<EventId, PollAggregate>;
	// Send a new poll into this room.  Receives the question / answer
	// list / disclosure flag / max-selection from the create dialog;
	// resolves once the m.poll.start event has been dispatched.
	// Optional — when omitted, the composer's poll button hides.
	onCreatePoll?(opts: {
		question: string;
		answers: string[];
		kind: "disclosed" | "undisclosed";
		maxSelections: number;
		/** Optional auto-close time (ms since epoch).  Set when the
		 * creator picked a finite duration in the create dialog. */
		endsAt?: number;
	}): Promise<void> | void;
	// Cast / change a vote on a poll.  Empty `answerIds` withdraws
	// the vote.  Receives the poll start event id (== the message id).
	onVoteOnPoll?(pollId: EventId, answerIds: string[]): Promise<void> | void;
	// End a poll.  Creator-only by spec; the receiving end ignores
	// end-events from anyone except the start sender.
	onEndPoll?(pollId: EventId): Promise<void> | void;
}

// Threshold for "this message is part of the same group as the
// previous one" — same sender + this many ms or less since the prior
// message.  Five minutes feels right for chat; longer than typical
// rapid-fire bursts, shorter than separate sessions.
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function ChatPane({
	room, messages, memberAvatars, reactionsByMessage, flagsByMessage, collapsesByMessage,
	onSendMessage, onSendAttachment, onReact, onUnreact, onFlag, onUnflag, onAcceptInvite, onDeclineInvite, onInvite, onEditRoom,
	onPlaceCall, callInProgress, isSuspended, onOpenModLog, onFlagRoom, collapsedRoomIds,
	botMxids,
	myOwnedBotMxids,
	onDeleteMessage,
	messagesLoaded,
	members,
	viewerServer,
	onLoadMoreHistory,
	receiptsVersion,
	viewerUserId,
	onOpenProfile,
	accessToken,
	giphyEnabled,
	pollsByMessage,
	onCreatePoll,
	onVoteOnPoll,
	onEndPoll,
}: ChatPaneProps) {
	// Consensus flagging only works where the local engine can act:
	//   - DMs are 1-on-1 — no quorum to gather, no consensus to reach.
	//   - Federated rooms live on a different homeserver; our engine
	//     bot can't join them, so flags pile up visually but no
	//     collapse ever fires.
	//   - Encrypted rooms hide message content from the engine (and
	//     from any admin reviewing a floor case), so the moderation
	//     pipeline is hollow there — the admin queue would surface
	//     reports they can't read.  Better to not offer the affordance
	//     than to let users believe they took action that won't
	//     produce a real review.
	// Hiding the affordance everywhere it can't bite avoids misleading
	// users into thinking they took action.
	const flaggable = !!room && room.kind !== "dm" && !room.isFederated && !room.encrypted;
	const [roomFlagOpen, setRoomFlagOpen] = useState(false);
	// Gallery sheet — opens from the header's Images icon, shows every
	// image/video shared in the room as a grid + lightbox.
	const [galleryOpen, setGalleryOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const [replyTarget, setReplyTarget] = useState<Message | null>(null);
	// Pending attachment: the user picked a file but hasn't hit send yet.
	// We don't auto-send on pick so they can pair the attachment with a
	// caption, change their mind, or attach a different file.
	const [pendingAttachment, setPendingAttachment] = useState<File | null>(null);
	const [uploading, setUploading] = useState(false);
	// Modal state for the create-poll dialog.  Triggered from the
	// composer button; close on submit (the dialog handles the close
	// itself once the m.poll.start send resolves).
	const [pollDialogOpen, setPollDialogOpen] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const composeInputRef = useRef<HTMLTextAreaElement | null>(null);
	// Auto-grow the composer to fit its content (Discord-style).  Runs
	// on every draft change: clear the inline height so scrollHeight
	// reflects the natural content height, then write that back as the
	// new height.  CSS `max-h` clamps the upper bound — once we hit
	// the cap, the textarea's own `overflow-y-auto` takes over and
	// scrolls instead of growing.  useLayoutEffect (not useEffect) so
	// the height update happens before paint and there's no flash of
	// the wrong size.
	useLayoutEffect(() => {
		const el = composeInputRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [draft]);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const scrollContentRef = useRef<HTMLDivElement | null>(null);
	// Cursor position in the compose box.  Tracked separately from
	// `draft` because keyboard shortcuts (Tab, Enter for send) fire
	// before React syncs the input's selectionStart.  Updated on
	// every keystroke, focus, and click.
	const [cursor, setCursor] = useState(0);
	// @-mention autocomplete state.  selectedIndex resets to 0 on
	// every query change so arrow-down behaves intuitively.
	const [mentionIndex, setMentionIndex] = useState(0);

	// Whether the timeline should auto-scroll to bottom when content
	// changes.  Starts true on every room enter; flipped false when
	// the user manually scrolls up past the bottom-stick threshold so
	// reading older history doesn't keep yanking them down to the
	// latest message.  Re-armed when they scroll back to (or near)
	// the bottom themselves.
	const followBottomRef = useRef(true);
	const prevRoomIdRef = useRef<string | undefined>(undefined);

	// Room change: re-arm the lock and snap to bottom now.  We don't
	// know the final scrollHeight here (images / avatars decode
	// async) but the ResizeObserver below catches every subsequent
	// growth and re-snaps.  `prevRoomIdRef` distinguishes "fresh
	// room enter" from "messages.length changed in the same room."
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const isRoomChange = prevRoomIdRef.current !== room?.id;
		prevRoomIdRef.current = room?.id;
		if (isRoomChange) {
			followBottomRef.current = true;
		}
		if (followBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [messages.length, room?.id]);

	// Continuous re-snap on content resize.  ResizeObserver fires
	// every time the inner content's height changes — the most
	// common cases are async image / avatar decodes growing rows
	// AFTER we already set scrollTop, paginated history loading
	// from getRoomMessages, and reactions / flags getting added to
	// existing rows.  As long as `followBottomRef.current` is true
	// (user hasn't scrolled up), we keep the viewport pinned to the
	// new bottom regardless of what's growing or how long it takes.
	//
	// Wrapper element exists only because ResizeObserver on the
	// scroll container itself watches the BORDER box (clientHeight),
	// not scrollHeight.  Observing the inner content gives us the
	// timeline's true rendered height.
	useEffect(() => {
		const inner = scrollContentRef.current;
		const el = scrollRef.current;
		if (!inner || !el) return;
		const ro = new ResizeObserver(() => {
			if (followBottomRef.current && scrollRef.current) {
				scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
			}
		});
		ro.observe(inner);
		return () => ro.disconnect();
	}, []);

	// Watch user scroll position to maintain followBottomRef + drive
	// the "load more history when scrolled near the top" pagination
	// fetch.  Flip followBottom false when scrolled above the
	// bottom-stick threshold; flip true when back inside it.  100px
	// feels generous — matches the visual "I'm basically at the
	// bottom" intuition without requiring exact pixel-perfect
	// anchoring.
	const loadingMoreRef = useRef(false);
	const noMoreHistoryRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const onScroll = () => {
			const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
			followBottomRef.current = distance < 100;

			// Pagination trigger.  matrix-js-sdk's startClient pulls
			// only ~30 events per room initially; without this the
			// user can't scroll past the initial batch even though
			// Synapse has the full history.  Fire when the user
			// reaches the top 200px AND we're not already loading.
			// The noMoreHistoryRef Set caches "this room has no more
			// history" so we don't keep firing requests at the start
			// of the room.
			if (
				el.scrollTop < 200 &&
				!loadingMoreRef.current &&
				room &&
				onLoadMoreHistory &&
				!noMoreHistoryRef.current.has(room.id)
			) {
				loadingMoreRef.current = true;
				// Capture pre-fetch geometry so we can restore the
				// user's visual scroll position after the SDK
				// prepends older events to the timeline.  Without
				// this the viewport would yank to the top because
				// scrollHeight grew but scrollTop stayed where it
				// was.  scrollHeight - scrollTop = "distance from
				// the bottom"; preserving that across the resize
				// keeps the user looking at exactly the same row.
				const distFromBottom = el.scrollHeight - el.scrollTop;
				const roomId = room.id;
				onLoadMoreHistory(roomId)
					.then((gotMore) => {
						if (!gotMore) noMoreHistoryRef.current.add(roomId);
						// Restore scroll position after the React
						// re-render commits the new (taller) timeline.
						// rAF fires after layout, when scrollHeight
						// reflects the prepended content.
						requestAnimationFrame(() => {
							const cur = scrollRef.current;
							if (!cur) return;
							cur.scrollTop = cur.scrollHeight - distFromBottom;
						});
					})
					.finally(() => {
						loadingMoreRef.current = false;
					});
			}
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [room?.id, onLoadMoreHistory]);

	// Global hover tracking for the message-action toolbar.
	//
	// Failed approaches and why:
	//   - CSS `:hover` (Tailwind group-hover): unreliable in WKWebView
	//     when a Radix Popover opens/closes inside the row — the
	//     underlying `:hover` state stays sticky on close.
	//   - React onMouseEnter / onMouseLeave: React synthetic events
	//     drop `leave` events unreliably in WKWebView when the cursor
	//     moves quickly between sibling rows.
	//   - React onPointerEnter / onPointerLeave: same React-synthetic
	//     indirection, same failure mode.  Plus pointer events have
	//     documented WKWebView reliability problems (WebKit bug
	//     #187545, Tauri WRY #175 — events fire when window is
	//     backgrounded, miss when window is focused, etc.)
	//   - Native pointermove on the scroll container: still missed
	//     events when cursor crossed out of the container quickly.
	//
	// What works: native `mousemove` listener on `document`.  Document-
	// level events fire most reliably in every WKWebView build because
	// they're the lowest-level mouse handler the browser exposes — the
	// quirks above are about per-element bubbling/capture, not about
	// document seeing mousemove at all.  On every move we hit-test
	// `e.target` for the nearest `[data-message-id]` ancestor; if
	// none, the cursor is outside any message and we clear the state.
	// `mouseleave` on the document handles the "cursor left the window
	// entirely" case (e.g. moved to the macOS title bar).
	//
	// `mousemove` instead of `pointermove`: mouse events are the OG
	// and are more universally implemented in older WebKit branches
	// than pointer events.
	const [hoveredMessageId, setHoveredMessageId] = useState<EventId | null>(null);
	useEffect(() => {
		const onMove = (e: MouseEvent) => {
			const t = e.target as HTMLElement | null;
			const msgEl = t?.closest("[data-message-id]");
			const id = (msgEl?.getAttribute("data-message-id") ?? null) as EventId | null;
			setHoveredMessageId(prev => (prev === id ? prev : id));
		};
		const onLeave = () => setHoveredMessageId(null);
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseleave", onLeave);
		return () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseleave", onLeave);
		};
	}, []);

	// Clear the reply target + any pending attachment when the user
	// switches rooms — those are scoped to the previous conversation.
	useEffect(() => {
		setReplyTarget(null);
		setPendingAttachment(null);
		setUploading(false);
	}, [room?.id]);

	if (!room) {
		return (
			<div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
				Pick a room from the sidebar.
			</div>
		);
	}

	// ─── @-mention autocomplete ────────────────────────────────────
	// Look at the cursor position inside the draft.  If we're sitting
	// in an active "@..." token, compute matching room members + bots
	// and surface the popover.

	const mentionToken = activeMentionToken(draft, cursor);

	// userId → display name lookup, for the SeenIndicator's
	// avatar-stack tooltip + the "seen by" modal list.  Falls back
	// to localpart when a member has no displayname set.
	const memberNamesByUserId = useMemo<Map<string, string>>(() => {
		const m = new Map<string, string>();
		for (const member of (members ?? [])) {
			m.set(member.userId, member.displayName ?? localpartOf(member.userId));
		}
		return m;
	}, [members]);

	const allCandidates = useMemo<AutocompleteCandidate[]>(() => {
		const seen = new Set<string>();
		const out: AutocompleteCandidate[] = [];
		// Only suggest people who are actually in this room.  We used
		// to also fall through to the global botMxids set so users
		// could "mention a bot to invite it", but the engine ignores
		// any mention of a bot that isn't in the room — so the
		// suggestion was a dead end AND it surfaced unrelated bots
		// from rooms the viewer wasn't even in.  Clean signal: the
		// dropdown shows who you can actually @ here.
		for (const m of members ?? []) {
			if (seen.has(m.userId)) continue;
			seen.add(m.userId);
			out.push({
				userId: m.userId as UserId,
				displayName: m.displayName || m.userId,
				avatarUrl: m.avatarUrl,
				isBot: !!botMxids?.has(m.userId),
			});
		}
		return out;
	}, [members, botMxids]);

	const matches = useMemo<AutocompleteCandidate[]>(() => {
		if (!mentionToken) return [];
		const q = mentionToken.query;
		const scored = allCandidates
			.map(c => ({ c, score: scoreCandidate(c, q) }))
			.filter(s => s.score > 0)
			.sort((a, b) => b.score - a.score);
		return scored.slice(0, 8).map(s => s.c);
	}, [allCandidates, mentionToken]);

	// Reset the highlighted row whenever the match set changes.
	useEffect(() => { setMentionIndex(0); }, [mentionToken?.query, matches.length]);

	const acceptMention = (c: AutocompleteCandidate) => {
		if (!mentionToken) return;
		// Same-server short form: drop ":server" when it matches the
		// viewer's server.  Cross-server keeps the full mxid so it
		// stays unambiguous.
		const insertedMxid = (() => {
			if (!viewerServer) return c.userId;
			const cs = serverOf(c.userId);
			if (cs && cs === viewerServer.toLowerCase()) {
				const colon = c.userId.indexOf(":");
				return colon > 0 ? c.userId.slice(0, colon) : c.userId;
			}
			return c.userId;
		})();
		const before = draft.slice(0, mentionToken.start);
		const after = draft.slice(cursor);
		const next = `${before}${insertedMxid} ${after}`;
		setDraft(next);
		// After paint, restore focus and place the caret right after
		// the inserted mxid + trailing space.
		const newCursor = mentionToken.start + insertedMxid.length + 1;
		requestAnimationFrame(() => {
			const el = composeInputRef.current;
			if (!el) return;
			el.focus();
			try {
				el.setSelectionRange(newCursor, newCursor);
			} catch {
				// some input types reject setSelectionRange; fine to ignore
			}
			setCursor(newCursor);
		});
	};

	function send() {
		// Attachment send: any text in the composer travels as a
		// caption on the same event (MSC2530 — body becomes the
		// caption, filename carries the real filename).  Receivers
		// that know MSC2530 render caption under the media; older
		// clients fall back to showing body as the message text.
		if (pendingAttachment && onSendAttachment) {
			const file = pendingAttachment;
			const replyToId = replyTarget?.id ?? null;
			const captionText = draft.trim();
			setUploading(true);
			onSendAttachment(file, replyToId, captionText || null)
				.then(() => {
					setPendingAttachment(null);
					setReplyTarget(null);
					setDraft("");
				})
				.finally(() => setUploading(false));
			return;
		}
		const text = draft.trim();
		if (!text) return;
		onSendMessage(text, replyTarget?.id ?? null);
		setDraft("");
		setReplyTarget(null);
	}

	function pickAttachment(file: File) {
		setPendingAttachment(file);
	}

	// GIFs from the Giphy picker bypass the preview/caption flow:
	// users expect a one-click "send" the way Discord does it,
	// and a second confirm step would feel like friction.  Caption
	// support could come back if anyone asks; reply-to is preserved
	// since it was already targeted before the picker opened.
	async function sendGif(file: File) {
		if (!onSendAttachment) return;
		const replyToId = replyTarget?.id ?? null;
		setUploading(true);
		try {
			await onSendAttachment(file, replyToId, null);
			setReplyTarget(null);
		} finally {
			setUploading(false);
		}
	}

	function toggleReaction(message: Message, key: string) {
		const list = reactionsByMessage.get(message.id) ?? [];
		const existing = list.find(a => a.key === key);
		if (existing?.myReactionId) {
			onUnreact(existing);
		} else {
			onReact(message.id, key);
		}
	}

	return (
		<div className="flex-1 flex flex-col min-w-0">
			<header className="h-12 px-4 flex items-center justify-between gap-3 border-b border-border bg-muted/30">
				<div className="flex items-center gap-2 min-w-0">
					<MatrixAvatar
						mxc={room.avatarUrl}
						emoji={room.kind !== "dm" ? room.iconEmoji : undefined}
						seed={room.kind === "dm" ? (room.dmUserId ?? room.id) : room.id}
						kind={
							room.kind === "dm"
								? (room.dmUserId && botMxids?.has(room.dmUserId) ? "bot" : "user")
								: "room"
						}
						className={cn(
							"h-7 w-7 shrink-0",
							room.kind === "dm" ? "rounded-full" : "rounded-md",
						)}
					/>
					<div className="flex flex-col min-w-0">
						<span className="text-sm font-semibold truncate flex items-center gap-1.5">
							<span className={cn(
								"truncate",
								// Italicise the placeholder so it visually
								// reads as system-imposed, not as a user-
								// chosen room name.
								collapsedRoomIds?.has(room.id) && "italic text-muted-foreground",
							)}>
								{collapsedRoomIds?.has(room.id) ? COLLAPSED_NAME : room.name}
							</span>
							{room.kind === "dm" && room.dmUserId && botMxids?.has(room.dmUserId) && (
								<BotBadge />
							)}
						</span>
						{/* Topic stays hidden when the room is collapsed —
						    the topic field can carry the same kind of
						    abuse the name does, so we suppress both. */}
						{room.topic && !collapsedRoomIds?.has(room.id) && (
							<span className="text-xs text-muted-foreground truncate max-w-[60ch]">{room.topic}</span>
						)}
					</div>
				</div>
				<div className="flex items-center gap-2 shrink-0">
					{room.kind === "public" && (
						<RoomBadge
							icon={<Globe className="h-3 w-3" />}
							label="Public"
							tone="default"
							title="Anyone on the homeserver can find and join."
						/>
					)}
					{room.kind === "private" && (
						<RoomBadge
							icon={<EyeOff className="h-3 w-3" />}
							label="Private"
							tone="default"
							title="Invite-only. Won't appear in room directories."
						/>
					)}
					{room.encrypted && (
						<RoomBadge
							icon={<Lock className="h-3 w-3" />}
							label="Encrypted"
							tone="success"
							title="End-to-end encrypted. Koven moderation does not apply in this room."
						/>
					)}
					{room.nsfw && (
						<RoomBadge
							icon={<AlertTriangle className="h-3 w-3" />}
							label="NSFW"
							tone="danger"
							title="Marked as adult content. Hidden from Explore for users who haven't opted into NSFW discovery."
						/>
					)}
					{room.isFederated && (
						<RoomBadge
							icon={<Network className="h-3 w-3" />}
							label={`On ${room.homeserver}`}
							tone="warn"
							title={`This room is hosted on ${room.homeserver}, not your home server. The local moderation engine does not apply here — flags and reputation are local-only.`}
						/>
					)}
					{room.kind === "dm" && !room.isInvite && !callInProgress && (
						<>
							<button
								type="button"
								onClick={() => onPlaceCall(room.id as EventId, false)}
								className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
								title="Voice call"
								aria-label="Voice call"
							>
								<Phone className="h-4 w-4" />
							</button>
							<button
								type="button"
								onClick={() => onPlaceCall(room.id as EventId, true)}
								className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
								title="Video call"
								aria-label="Video call"
							>
								<Video className="h-4 w-4" />
							</button>
						</>
					)}
					{room.kind !== "dm" && !room.isInvite && (
						<button
							type="button"
							onClick={() => onInvite(room.id as EventId)}
							className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
							title="Invite people"
							aria-label="Invite people"
						>
							<UserPlus className="h-4 w-4" />
						</button>
					)}
					{!room.isInvite && (
						// Media gallery — DM-friendly + encrypted-friendly
						// (unlike mod log + flag, which need the engine
						// to see content).  Lightbox-fronted grid of
						// every image/video already loaded in the room.
						<button
							type="button"
							onClick={() => setGalleryOpen(true)}
							className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
							title="Shared media"
							aria-label="Shared media"
						>
							<Images className="h-4 w-4" />
						</button>
					)}
					{room.kind !== "dm" && !room.isInvite && !room.encrypted && (
						// Mod log is public — anyone in the room can audit.
						// Hidden in encrypted rooms because the engine
						// can't see message content there, so the log
						// would only ever show empty / metadata noise.
						<button
							type="button"
							onClick={() => onOpenModLog(room.id as EventId)}
							className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
							title="Public mod log"
							aria-label="Public mod log"
						>
							<Scale className="h-4 w-4" />
						</button>
					)}
					{onFlagRoom && room.kind !== "dm" && !room.isInvite && !room.encrypted && (
						// Flag the room itself (its name + topic), not a
						// single message inside it.  Same gating as the
						// mod log icon — hidden in DMs and encrypted
						// rooms where the consensus pipeline can't act.
						// Already-collapsed rooms still show the flag
						// affordance: users may want to pile on with a
						// floor flag (turning a community-vote collapse
						// into a creator suspension) and the engine
						// dedupes our own flag idempotently.
						<button
							type="button"
							onClick={() => setRoomFlagOpen(true)}
							className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
							title="Flag this room"
							aria-label="Flag this room"
						>
							<Flag className="h-4 w-4" />
						</button>
					)}
					{room.kind !== "dm" && !room.isInvite && (room.myPowerLevel ?? 0) >= 50 && (
						<button
							type="button"
							onClick={() => onEditRoom(room.id as EventId)}
							className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
							title="Room settings"
							aria-label="Room settings"
						>
							<Settings className="h-4 w-4" />
						</button>
					)}
				</div>
			</header>

			<div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
				{/* Inner content wrapper exists ONLY so the
				    ResizeObserver in the auto-scroll effect has a
				    single observable element whose size reflects the
				    full timeline height (including async image
				    decodes).  Without it the observer would only
				    track the first message row.  Layout-neutral —
				    block-level div, no margins/padding. */}
				<div ref={scrollContentRef}>
				{!messagesLoaded ? (
					// Initial timeline still loading.  Render nothing
					// rather than flashing "No messages yet." — the
					// banner only fires when we've genuinely confirmed
					// the room is empty (load completed, list length 0).
					null
				) : messages.length === 0 ? (
					<div className="text-xs text-muted-foreground italic mt-8 text-center">No messages yet.</div>
				) : (
					messages.map((m, i) => {
						const prev = messages[i - 1];
						const sameGroup =
							!!prev &&
							prev.sender === m.sender &&
							m.timestamp - prev.timestamp <= GROUP_WINDOW_MS &&
							!m.replyTo; // a reply is always its own visual group
						return (
							<MessageRow
								key={m.id}
								message={m}
								avatarMxc={memberAvatars.get(m.sender)}
								continuesGroup={sameGroup}
								isFirst={i === 0}
								flaggable={flaggable}
								roomEncrypted={!!room.encrypted}
								reactions={reactionsByMessage.get(m.id) ?? []}
								flags={flagsByMessage.get(m.id)}
								collapse={collapsesByMessage.get(m.id)}
								isDm={room.kind === "dm"}
								receiptsVersion={receiptsVersion ?? 0}
								memberAvatars={memberAvatars}
								memberNames={memberNamesByUserId}
								mentionsViewer={
									!m.isSelf && !!viewerUserId && messageMentionsUser(m, viewerUserId)
								}
								onMentionClick={(userId) => onOpenProfile?.(userId)}
								pollAggregate={pollsByMessage?.get(m.id)}
								viewerUserId={viewerUserId}
								onPollVote={onVoteOnPoll}
								onPollEnd={onEndPoll}
								onReact={(emoji) => toggleReaction(m, emoji)}
								onReply={() => setReplyTarget(m)}
								onFlag={(category, rationale) => onFlag(m.id, category, rationale)}
								onTogglePillFlag={() => {
									const cur = flagsByMessage.get(m.id);
									if (cur?.myFlagId) onUnflag(cur.myFlagId);
									// If the user hasn't flagged yet, the pill click
									// is handled inline (opens the flag dialog) — see
									// MessageRow below.
								}}
								isBot={!!botMxids?.has(m.sender)}
								// True when the sender is a bot the viewer owns —
								// drives the flag→delete swap on the action toolbar
								// (you can't flag your own bot's output, you delete
								// it instead).  Computed at the parent because
								// `myOwnedBotMxids` lives up here; cheap O(1) lookup.
								isOwnedBot={!!myOwnedBotMxids?.has(m.sender)}
								isHovered={hoveredMessageId === m.id}
								onToggleReactionPill={(reaction) => {
									if (reaction.myReactionId) onUnreact(reaction);
									else onReact(m.id, reaction.key);
								}}
								// Delete button is shown only when:
								//   - parent supplied a handler, AND
								//   - the message isn't already collapsed/redacted
								//     (deleting an already-deleted message is a
								//     no-op that errors at the engine), AND
								//   - the viewer is the sender OR owns the bot
								//     that sent it.
								// Bot ownership comes from the App-level set; the
								// engine re-checks server-side, so a tampered SPA
								// can't actually delete other users' content.
								onDelete={
									onDeleteMessage && !collapsesByMessage.get(m.id) && (
										m.isSelf || !!myOwnedBotMxids?.has(m.sender)
									)
										// Suppress delete on pending (local-echo)
										// events — their id is a SDK-synthetic
										// stand-in until /sync acks the real
										// homeserver event id, so a redaction
										// would 404 with M_NOT_FOUND.  Once the
										// event flips to confirmed, the row
										// re-renders with pending=false and the
										// trash icon comes back automatically.
										&& !m.pending
										// Return the promise (don't `void` it) so
										// the DeleteAction dialog can await the
										// real network call and surface errors
										// inline if the engine rejects (403 for
										// "not your bot", 502 for redaction
										// failure, network drop).
										? () => onDeleteMessage(m.id)
										: undefined
								}
							/>
						);
					})
				)}
				</div>
			</div>

			{room.isInvite ? (
				<div className="border-t border-border p-4 flex items-center gap-3">
					<div className="flex-1 text-xs text-muted-foreground leading-snug">
						<span className="text-foreground font-medium">
							{room.inviterDisplayName
								|| (room.inviter ? localpartOf(room.inviter) : "")
								|| (room.dmUserId ? localpartOf(room.dmUserId) : "")
								|| "Someone"}
						</span>{" "}
						{room.kind === "dm" ? "wants to chat with you." : `invited you to ${room.name}.`}{" "}
						Accept to view and reply.
					</div>
					<div className="flex gap-2 shrink-0">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => onDeclineInvite(room.id as EventId)}
						>
							Decline
						</Button>
						<Button
							type="button"
							size="sm"
							onClick={() => onAcceptInvite(room.id as EventId)}
						>
							Accept
						</Button>
					</div>
				</div>
			) : (
			<div className="border-t border-border p-3">
				{replyTarget && (
					<div className="mb-2 flex items-start gap-2 px-3 py-1.5 rounded-md bg-muted/60 border border-border text-xs">
						<CornerDownRight className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
						<div className="flex-1 min-w-0">
							<div className="text-muted-foreground">
								Replying to <span className="text-foreground font-medium">{replyTarget.senderDisplayName}</span>
							</div>
							<div className="text-muted-foreground truncate">{replyTarget.text || "(media)"}</div>
						</div>
						<button
							type="button"
							onClick={() => setReplyTarget(null)}
							className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
							aria-label="Cancel reply"
							title="Cancel reply"
						>
							<X className="h-3.5 w-3.5" />
						</button>
					</div>
				)}
				{pendingAttachment && (
					<PendingAttachmentChip
						file={pendingAttachment}
						uploading={uploading}
						onRemove={() => setPendingAttachment(null)}
					/>
				)}
				<form
					onSubmit={e => { e.preventDefault(); if (!isSuspended) send(); }}
					className="flex gap-2 items-end"
				>
					{onSendAttachment && (
						<>
							<input
								ref={fileInputRef}
								type="file"
								className="hidden"
								onChange={e => {
									const file = e.target.files?.[0];
									if (file) pickAttachment(file);
									// Reset so the same file can be re-picked
									// after a remove + re-attach.
									e.target.value = "";
								}}
								disabled={isSuspended || uploading}
							/>
							<button
								type="button"
								onClick={() => fileInputRef.current?.click()}
								disabled={isSuspended || uploading || !!pendingAttachment}
								className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
								title="Attach a file"
								aria-label="Attach a file"
							>
								<Paperclip className="h-4 w-4" />
							</button>
						</>
					)}
					{onCreatePoll && (
						// Poll button — opens the create-poll modal.  Sits
						// between the paperclip and the GIF pill so the
						// "media-ish actions" cluster reads as one group.
						<button
							type="button"
							onClick={() => setPollDialogOpen(true)}
							disabled={isSuspended || uploading || !!pendingAttachment}
							className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
							title="Create a poll"
							aria-label="Create a poll"
						>
							<BarChart3 className="h-4 w-4" />
						</button>
					)}
					{onSendAttachment && giphyEnabled && accessToken && (
						// GIF picker — Discord-style "GIF" text pill.  Sized
						// to h-8 so it shares a baseline with the paperclip
						// button (which is h-4 icon + p-2 = 32px); items-end
						// on the surrounding form keeps both anchored to
						// the bottom of the multi-line composer.
						<GifPicker
							accessToken={accessToken}
							disabled={isSuspended || uploading || !!pendingAttachment}
							onPick={sendGif}
						>
							<button
								type="button"
								disabled={isSuspended || uploading || !!pendingAttachment}
								className={cn(
									"h-8 px-2 rounded-md inline-flex items-center justify-center",
									"text-[10px] font-bold tracking-wide",
									"text-muted-foreground hover:text-foreground hover:bg-accent",
									"border border-foreground/20 hover:border-foreground/40",
									"transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
								)}
								title="Send a GIF"
								aria-label="Send a GIF"
							>
								GIF
							</button>
						</GifPicker>
					)}
					<div className="relative flex-1">
						{mentionToken && matches.length > 0 && (
							<MentionAutocomplete
								query={mentionToken.query}
								candidates={matches}
								selectedIndex={mentionIndex}
								onSelect={acceptMention}
								onHover={i => setMentionIndex(i)}
							/>
						)}
						<textarea
							ref={composeInputRef}
							value={draft}
							rows={1}
							onChange={e => {
								setDraft(e.target.value);
								setCursor(e.target.selectionStart ?? e.target.value.length);
							}}
							onSelect={e => {
								// Track caret moves driven by mouse / arrow keys
								// without text changes — keeps the autocomplete
								// trigger in sync.
								setCursor((e.target as HTMLTextAreaElement).selectionStart ?? draft.length);
							}}
							onKeyDown={e => {
								if (mentionToken && matches.length > 0) {
									if (e.key === "ArrowDown") {
										e.preventDefault();
										setMentionIndex(i => (i + 1) % matches.length);
										return;
									}
									if (e.key === "ArrowUp") {
										e.preventDefault();
										setMentionIndex(i => (i - 1 + matches.length) % matches.length);
										return;
									}
									if (e.key === "Enter" || e.key === "Tab") {
										e.preventDefault();
										const c = matches[mentionIndex] ?? matches[0];
										if (c) acceptMention(c);
										return;
									}
									if (e.key === "Escape") {
										e.preventDefault();
										// Force-close by moving the caret past
										// the "@..." token.
										setCursor(draft.length);
										return;
									}
								}
								// Discord-style multi-line composer: plain Enter
								// submits, Shift+Enter inserts a newline.  IME
								// composition (CJK, voice input) is gated by
								// `isComposing` so picking a candidate with Enter
								// doesn't accidentally fire a send.
								if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
									e.preventDefault();
									if (!isSuspended && !uploading) send();
								}
							}}
							placeholder={
								isSuspended
									? "Posting paused while your account is under review"
									: uploading
										? "Sending…"
										: pendingAttachment
											? "Add a caption…"
											: replyTarget
												? `Reply to ${replyTarget.senderDisplayName}`
												: `Message ${room.name}`
							}
							// Disabled during upload so Enter doesn't double-submit
							// or queue another message while the previous one's
							// attachment is still being uploaded.
							disabled={isSuspended || uploading}
							autoFocus={!isSuspended}
							className={cn(
								// Match the Input component's visual style so the
								// composer slot looks identical at single-line
								// (one row).  Auto-grow handled by the layout
								// effect below — reset height to auto, then
								// set to scrollHeight, capped at max-h.
								"flex w-full rounded-md border border-foreground/15 bg-transparent px-3 py-1.5 text-base shadow-sm transition-colors",
								"hover:border-foreground/25",
								"placeholder:text-muted-foreground",
								// Tone down the focus accent on dark themes — `--ring`
							// resolves to the bright theme primary, which next
							// to the muted bubble row felt over-saturated.  Plain
							// `ring-1` plus a 50%-alpha primary border is enough
							// affordance without lighting up the whole composer.
							"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring",
							"dark:focus-visible:ring-primary/40 dark:focus-visible:border-primary/40",
								"disabled:cursor-not-allowed disabled:opacity-50",
								"md:text-sm",
								// Disable the manual resize handle — auto-grow
								// drives height; a manual handle would fight it.
								"resize-none",
								// Prevent overflow scrollbar flash while resizing
								// — overflow only kicks in once we hit max-h.
								"overflow-y-auto",
								// Cap the height so a 50-line paste doesn't eat
								// the chat.  Tracks Discord — about 12 rows.
								"max-h-[50vh]",
								// Snug single-line baseline.  leading-normal +
								// py-1.5 lands at ~36px to match the Input
								// component's h-9.
								"leading-normal min-h-9",
							)}
						/>
					</div>
					{/* Send button removed — Enter on the input submits the
					    form, same flow modern chat clients (Discord,
					    Telegram, iMessage) use.  The placeholder swaps to
					    "Sending…" while an attachment uploads so we still
					    have a visible "in flight" indicator. */}
				</form>
			</div>
			)}

			{/* Create-poll modal.  Lives outside the form so its dialog
			    portal isn't trapped under the composer's tab order;
			    only renders when the parent provided onCreatePoll. */}
			{onCreatePoll && (
				<CreatePollDialog
					open={pollDialogOpen}
					onOpenChange={setPollDialogOpen}
					onSubmit={async (opts) => { await onCreatePoll(opts); }}
				/>
			)}

			{/* Flag-this-room dialog.  Opens from the Flag icon in the
			    header (right of the mod log Scale icon).  Same shared
			    FlagDialog as the per-message version with target="room"
			    so the copy is room-specific. */}
			{onFlagRoom && (
				<FlagDialog
					open={roomFlagOpen}
					onOpenChange={setRoomFlagOpen}
					target="room"
					onSubmit={async (category, rationale) => {
						await onFlagRoom(room.id as EventId, category, rationale);
					}}
				/>
			)}

			<GallerySheet
				open={galleryOpen}
				onOpenChange={setGalleryOpen}
				messages={messages}
				roomName={room.name}
			/>
		</div>
	);
}

function MessageRow({
	message, avatarMxc, continuesGroup, isFirst, flaggable, roomEncrypted,
	reactions, flags, collapse, onReact, onReply, onFlag, onTogglePillFlag, onToggleReactionPill, isBot,
	isOwnedBot, isHovered, onDelete,
	isDm, receiptsVersion, memberAvatars, memberNames, mentionsViewer, onMentionClick,
	pollAggregate, viewerUserId, onPollVote, onPollEnd,
}: {
	message: Message;
	avatarMxc: string | undefined;
	continuesGroup: boolean;
	isFirst: boolean;
	flaggable: boolean;
	// Whether the room is end-to-end encrypted.  Drives URL-preview
	// suppression: previewing in encrypted rooms would leak the URL
	// to Synapse via /preview_url, defeating part of the encryption
	// promise.  Element handles this with a per-user opt-in; we
	// match by defaulting off in encrypted rooms with no opt-in for
	// now (can be added later if anyone asks).
	roomEncrypted: boolean;
	reactions: ReactionAggregate[];
	flags: FlagAggregate | undefined;
	collapse: CollapseAggregate | undefined;
	// True when the message sender is a registered bot — drives the
	// BOT pill rendered next to the sender label.  The badge is the
	// only visual difference from a human's message; nothing else
	// changes, so users still mention bots and react to bot messages
	// the same way.
	isBot: boolean;
	// True when the message sender is a bot the VIEWER owns.  Hides
	// the flag affordance on the action toolbar — flagging your own
	// bot's output is incoherent (you control its prompt + config;
	// just delete the message instead).  The trash icon is already
	// gated by `onDelete` from the parent on the same condition, so
	// the visual swap is "flag, except on your own bots, where it's
	// trash."
	isOwnedBot: boolean;
	onReact(emoji: string): void;
	onReply(): void;
	onFlag(category: FlagCategory, rationale?: string): void | Promise<void>;
	onTogglePillFlag(): void;
	onToggleReactionPill(reaction: ReactionAggregate): void;
	// Authoritative "is the cursor currently over this row?" signal,
	// computed in ChatPane via a single native pointermove listener
	// on the scroll container.  See the comment there for why this
	// has to live above the row instead of using per-row React events.
	isHovered: boolean;
	// Trash button handler.  Provided only for rows the viewer is
	// allowed to delete (own message OR owned-bot message); the
	// gating logic lives in ChatPane.  When omitted, no trash icon.
	// Returns a promise so MessageActions's DeleteAction dialog can
	// await the real network call and show errors inline (403, 502,
	// network) without flickering closed first.
	onDelete?(): void | Promise<void>;
	// Drives the SeenIndicator on this row's bubble — DM gets a
	// "Read 2:41 PM" / nothing pair under the bubble; non-DM rooms
	// get a small avatar stack + count next to the bubble that
	// expands to a list modal on click.  isDm distinguishes the
	// two render styles; receiptsVersion forces a re-render when
	// matrix-js-sdk delivers a new Room.Receipt; memberAvatars +
	// memberNames feed the avatar stack.  Only meaningful on
	// `isSelf` rows; the indicator no-ops for others' messages.
	isDm: boolean;
	receiptsVersion: number;
	memberAvatars: Map<string, string | undefined>;
	memberNames: Map<string, string>;
	// True when the row pings the viewer — direct @-mention or
	// reply to a message the viewer authored.  Drives the Discord-
	// style left-border accent + faint background tint on the row.
	mentionsViewer: boolean;
	// Click handler for inline mention pills in this row's bubble.
	// Routes to App.tsx's profile sheet via ChatPane's onOpenProfile.
	onMentionClick(userId: string): void;
	// Live poll aggregate for this row, when message.kind === "poll".
	// Drives the bars + per-answer counts + viewer's selected answers.
	pollAggregate?: PollAggregate;
	// Viewer's user id — PollCard uses it to gate the creator-only
	// "End poll" affordance.
	viewerUserId?: UserId;
	// Cast / change a vote on this row's poll (when applicable).
	onPollVote?(pollId: EventId, answerIds: string[]): void | Promise<void>;
	onPollEnd?(pollId: EventId): void | Promise<void>;
}) {
	const [flagDialogOpen, setFlagDialogOpen] = useState(false);
	const [expanded, setExpanded] = useState(false);
	// Popover state stays local to the row — only relevant for THIS
	// row's React picker.  Combined with the parent-supplied
	// `isHovered` to keep the toolbar visible while the user picks
	// an emoji (otherwise the toolbar would fade out the moment they
	// move the cursor up to the popover content).
	const [reactOpen, setReactOpen] = useState(false);
	// Same pattern for the delete-confirmation dialog: the trash
	// button lives inside the hover-gated toolbar, but the dialog
	// itself MUST stay mounted while open even though the user's
	// cursor has moved off the message row to interact with it.
	// First attempt put the Dialog inside MessageActions, which
	// unmounted the moment the row un-hovered (making the dialog
	// "pop up then disappear after a second"); lifting the open
	// state to the row level + including it in `showActions` keeps
	// both the toolbar and the dialog rendered until the user
	// commits or cancels.
	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
	const showActions = isHovered || reactOpen || deleteDialogOpen;
	const handleDelete = onDelete ? () => setDeleteDialogOpen(true) : undefined;
	const myFlagId = flags?.myFlagId;
	// You can't flag your own messages — both because the consensus
	// vote is meaningless on yourself and because it'd let users
	// silence themselves accidentally.  We still render the flag pill
	// (count of flags FROM others) so a user can see they've been
	// reported, but the action surface (hover button + click-to-open
	// dialog from the pill) is gated.
	//
	// Same gate applies to bots the viewer owns: the owner controls
	// the bot's prompt and configuration, so flagging is the wrong
	// remedy — they should just delete the message.  The trash icon
	// (provided by ChatPane via `onDelete` on the same condition)
	// takes its place on the toolbar.
	const canFlag = flaggable && !message.isSelf && !isOwnedBot;
	function handlePillClick() {
		if (!canFlag) return;
		// Click on the flag pill: if you've already flagged, withdraw
		// (immediate); otherwise open the flag dialog so you can pick
		// a category and "+1" the existing flag.
		if (myFlagId) onTogglePillFlag();
		else setFlagDialogOpen(true);
	}
	// Floor-violation (fastTrack) collapses are hard-hidden — these are
	// CSAM / threats / doxx by classifier, and the whole point of the
	// floor pipeline is that this content is never re-served.  No
	// click-to-view affordance, no way for `expanded` to flip true.
	const isCollapsed = !!collapse && (collapse.fastTrack || !expanded);
	// Spacing rules:
	//   - First row in the scroll: no top margin.
	//   - Same-sender continuation: small (4px) — bubbles read as a unit.
	//   - New sender / new group: generous (16px) for visual separation.
	const topMargin = isFirst ? "" : continuesGroup ? "mt-1" : "mt-4";

	// Discord-style mention highlight: left accent border + faint
	// background wash spanning the full row.  Subtle but unmissable
	// when scrolling — the eye catches the colored bar in peripheral
	// vision even when the row's text is below the fold.  Negative
	// horizontal margin + matching padding stretches the wash to the
	// scroll-container edges so it doesn't read as a "card" stuck
	// inside the timeline.
	const mentionHighlight = mentionsViewer
		? "-mx-4 px-4 border-l-2 border-primary bg-primary/5"
		: "";

	// Emotes (`/me`) render as a single italic line with no bubble — same
	// shape as Matrix m.emote.  Avatar still gutters them so the layout
	// doesn't shift.
	if (message.kind === "emote") {
		return (
			<div
				data-message-id={message.id}
				className={cn("flex gap-3 items-start py-1", topMargin, mentionHighlight)}
			>
				<AvatarSlot mxc={avatarMxc} seed={message.sender} hidden={continuesGroup} isBot={isBot} />
				<div className="flex-1 min-w-0 pt-1 text-sm italic text-muted-foreground flex items-center gap-2">
					{isCollapsed ? (
						<CollapsedBubble collapse={collapse!} onExpand={() => setExpanded(true)} />
					) : (
						<span>* <span className="text-foreground/80">{message.senderDisplayName}</span> {message.text}</span>
					)}
					{flaggable && flags && flags.count > 0 && (
						<FlagPill
							count={flags.count}
							hasFlagged={!!myFlagId}
							onClick={handlePillClick}
						/>
					)}
					{showActions && (
						<MessageActions
							onReact={onReact}
							onReply={onReply}
							onFlagClick={() => setFlagDialogOpen(true)}
							showFlag={canFlag}
							onDelete={handleDelete}
							reactOpen={reactOpen}
							onReactOpenChange={setReactOpen}
						/>
					)}
				</div>
				{canFlag && (
					<FlagDialog
						open={flagDialogOpen}
						onOpenChange={setFlagDialogOpen}
						onSubmit={onFlag}
					/>
				)}
				{onDelete && (
					<DeleteMessageDialog
						open={deleteDialogOpen}
						onOpenChange={setDeleteDialogOpen}
						onConfirm={onDelete}
					/>
				)}
			</div>
		);
	}

	return (
		<div
			data-message-id={message.id}
			className={cn("flex gap-3 items-start", topMargin, mentionHighlight)}
		>
			<AvatarSlot mxc={avatarMxc} seed={message.sender} hidden={continuesGroup} isBot={isBot} />
			<div className="flex-1 min-w-0">
				{!continuesGroup && (
					<div className={cn(
						"text-xs font-medium mb-1.5 flex items-baseline gap-1.5",
						message.isSelf ? "text-primary" : "text-foreground"
					)}>
						<span>{message.senderDisplayName}</span>
						{isBot && <BotBadge />}
						{/* Subtle timestamp to the right of the
						    username — same row line as Discord /
						    Slack / iMessage's group headers.  Only
						    shown on the FIRST message of a sender's
						    consecutive run; collapsed-group
						    successors inherit it from the header
						    above and don't re-render to keep the
						    timeline clean.  Muted at 60% so it
						    reads as metadata, not content. */}
						<span className="text-[10px] font-normal text-muted-foreground/60 tabular-nums">
							{formatChatTimestamp(message.timestamp)}
						</span>
					</div>
				)}
				{message.replyTo && <ReplyQuote replyTo={message.replyTo} />}
				{/* Bubble + actions sit on a single line — actions appear
				    just to the right of the bubble on hover, vertically
				    centered against it. */}
				<div className="flex items-center gap-2">
					{isCollapsed ? (
						<CollapsedBubble collapse={collapse!} onExpand={() => setExpanded(true)} />
					) : (
						<MessageBubble
						message={message}
						memberNames={memberNames}
						onMentionClick={onMentionClick}
						pollAggregate={pollAggregate}
						viewerUserId={viewerUserId}
						onPollVote={onPollVote}
						onPollEnd={onPollEnd}
					/>
					)}
					{/* Seen-by indicator on YOUR sent messages.  In a
					    DM, renders a small "Read · time" line; in a
					    room, renders an avatar stack + count that
					    opens a modal listing every reader. */}
					{message.isSelf && !message.pending && !isCollapsed && (
						<SeenIndicator
							roomId={message.roomId}
							eventId={message.id}
							isDm={isDm}
							receiptsVersion={receiptsVersion}
							memberAvatars={memberAvatars}
							memberNames={memberNames}
						/>
					)}
					{flaggable && flags && flags.count > 0 && (
						<FlagPill
							count={flags.count}
							hasFlagged={!!myFlagId}
							onClick={handlePillClick}
						/>
					)}
					{collapse && expanded && (
						<button
							type="button"
							onClick={() => setExpanded(false)}
							className="text-[10px] text-muted-foreground hover:text-foreground underline"
						>
							hide
						</button>
					)}
					{showActions && (
						<MessageActions
							onReact={onReact}
							onReply={onReply}
							onFlagClick={() => setFlagDialogOpen(true)}
							showFlag={canFlag}
							onDelete={handleDelete}
							reactOpen={reactOpen}
							onReactOpenChange={setReactOpen}
							className="shrink-0"
						/>
					)}
				</div>
				{!isCollapsed && message.kind === "text" && !roomEncrypted && (
					// Link preview rides under the bubble for plain text
					// messages only.  Skipped on attachments / collapses /
					// emotes to keep those layouts clean.  Also skipped
					// in encrypted rooms — see roomEncrypted prop above.
					<UrlPreviewSlot text={message.text} />
				)}
				{!isCollapsed && (
					<ReactionPills reactions={reactions} onToggle={onToggleReactionPill} />
				)}
			</div>
			{canFlag && (
				<FlagDialog
					open={flagDialogOpen}
					onOpenChange={setFlagDialogOpen}
					onSubmit={onFlag}
				/>
			)}
			{onDelete && (
				<DeleteMessageDialog
					open={deleteDialogOpen}
					onOpenChange={setDeleteDialogOpen}
					onConfirm={onDelete}
				/>
			)}
		</div>
	);
}

function CollapsedBubble({ collapse, onExpand }: { collapse: CollapseAggregate; onExpand(): void }) {
	// Floor-violation collapses are non-revealable.  Render a static
	// banner — no onClick, no "click to view" hint, no hover affordance.
	if (collapse.fastTrack) {
		return (
			<div
				className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs italic text-muted-foreground bg-muted/50 border border-dashed border-destructive/40"
				title="This message was hidden by the platform's floor-violation rules and cannot be revealed."
			>
				<Flag className="h-3 w-3 text-destructive/70" />
				<span>Hidden — flagged as a serious violation</span>
			</div>
		);
	}
	return (
		<button
			type="button"
			onClick={onExpand}
			className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-xs italic text-muted-foreground bg-muted/50 border border-dashed border-border hover:bg-muted transition-colors"
			title="Click to view the original content"
		>
			<Flag className="h-3 w-3" />
			<span>{`Collapsed by community review · ${collapse.flaggerCount} flaggers · weight ${collapse.weightedScore.toFixed(2)}`}</span>
			<span className="not-italic text-[10px] opacity-70">(click to view)</span>
		</button>
	);
}

function FlagPill({ count, hasFlagged, onClick }: { count: number; hasFlagged: boolean; onClick(): void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={hasFlagged ? "You flagged this · click to withdraw" : `${count} ${count === 1 ? "flag" : "flags"} · click to add yours`}
			className={cn(
				"shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs transition-colors",
				hasFlagged
					? "border-destructive/60 bg-destructive/10 text-destructive hover:bg-destructive/15"
					: "border-border bg-muted/40 text-muted-foreground hover:bg-accent"
			)}
		>
			<Flag className="h-3 w-3" />
			<span className="tabular-nums">{count}</span>
		</button>
	);
}

function ReplyQuote({ replyTo }: { replyTo: NonNullable<Message["replyTo"]> }) {
	return (
		<div className="mb-1 flex items-start gap-2 max-w-[60ch] pl-3 border-l-2 border-primary/40 text-xs text-muted-foreground">
			<div className="min-w-0 flex-1 py-0.5">
				<div className="text-foreground/80 font-medium leading-tight">
					{replyTo.senderDisplayName}
				</div>
				<div className="truncate leading-tight">
					{replyTo.snippet || "(message)"}
				</div>
			</div>
		</div>
	);
}

function AvatarSlot({ mxc, seed, hidden, isBot }: { mxc?: string; seed: string; hidden: boolean; isBot: boolean }) {
	// Reserve the avatar gutter even when collapsed so subsequent
	// messages line up under the avatar above.  Saves a layout shift
	// and gives a clean indented column for grouped runs.
	if (hidden) return <div className="w-8 shrink-0" />;
	return (
		<MatrixAvatar
			mxc={mxc}
			seed={seed}
			kind={isBot ? "bot" : "user"}
			className="h-8 w-8 mt-0.5"
		/>
	);
}


function RoomBadge({ icon, label, tone, title }: {
	icon: React.ReactNode;
	label: string;
	tone: "default" | "success" | "warn" | "danger";
	title?: string;
}) {
	return (
		<span
			title={title ?? label}
			className={cn(
				"inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border",
				tone === "success"
					? "border-emerald-500/30 text-emerald-500/90 bg-emerald-500/5"
				: tone === "warn"
					? "border-amber-500/30 text-amber-500/90 bg-amber-500/5"
				: tone === "danger"
					? "border-destructive/40 text-destructive bg-destructive/10"
				: "border-border text-muted-foreground bg-background/40"
			)}
		>
			{icon}
			{label}
		</span>
	);
}

function MessageBubble({
	message,
	memberNames,
	onMentionClick,
	pollAggregate,
	viewerUserId,
	onPollVote,
	onPollEnd,
}: {
	message: Message;
	memberNames: Map<string, string>;
	onMentionClick(userId: string): void;
	pollAggregate?: PollAggregate;
	viewerUserId?: UserId;
	onPollVote?(pollId: EventId, answerIds: string[]): void | Promise<void>;
	onPollEnd?(pollId: EventId): void | Promise<void>;
}) {
	if (message.kind === "poll" && message.poll) {
		return (
			<PollCard
				message={message}
				aggregate={pollAggregate}
				viewerUserId={viewerUserId}
				onVote={(answerIds) => onPollVote?.(message.id, answerIds)}
				onEnd={() => onPollEnd?.(message.id)}
			/>
		);
	}
	// `whitespace-pre-wrap` only applied to the plain-text path —
	// markdown paragraphs/lists handle their own whitespace, and
	// keeping pre-wrap on top of them would re-introduce the literal
	// blank lines between blocks.
	const baseBubble = "inline-block max-w-[60ch] px-3 py-2 rounded-xl text-sm leading-snug break-words";
	// On light themes `--primary` is already a dark surface, so the
	// bubble reads fine.  On dark themes `--primary` is the bright
	// theme-accent (e.g. neon pink, vivid cyan) which washes out
	// emoji and overwhelms the eye on a long thread.  Drop the bg to
	// 50% alpha and switch text to plain foreground on dark — alpha-
	// composites against the chat background to a muted theme tint
	// while staying recognisable as "your colour."
	// `bubble-self` carries the dark-mode text colour fallback rule
	// from index.css — Midnight's primary is near-white, so the
	// `bg-primary/50` paint composites to a light grey where the
	// default `text-foreground` (also near-white) reads as poor
	// contrast.  The CSS rule scopes a dark text colour to Midnight
	// only; coloured dark themes (Plum, Forest, Aurora, etc.) keep
	// `text-foreground` since their bubble bg has actual colour.
	const selfBubble = "bg-primary text-primary-foreground dark:bg-primary/50 dark:text-foreground bubble-self";
	const otherBubble = "bg-muted text-foreground";

	// Image + video render flush — no surrounding bubble.  The
	// previous design wrapped them in the same colored bubble we use
	// for text messages, which on self-sent messages painted a
	// 4px-thick cyan frame around every shared photo and read as
	// "this image has been highlighted/selected" rather than "this is
	// my message".  Discord, Slack, and Element all render media
	// without a bubble for the same reason; the rounded corners on
	// the media itself are framing enough.  Caption (MSC2530) renders
	// underneath as a normal text bubble so the visual hierarchy
	// stays consistent — image first, your words second.
	if (message.kind === "image" && message.mediaMxc) {
		return (
			<div className="inline-flex flex-col gap-1.5 max-w-md">
				<AttachmentImage message={message} />
				{message.caption && (
					<div className={cn(baseBubble, message.isSelf ? selfBubble : otherBubble, "self-start")}>
						{message.caption}
					</div>
				)}
			</div>
		);
	}

	if (message.kind === "video" && message.mediaMxc) {
		return (
			<div className="inline-flex flex-col gap-1.5 max-w-md">
				<AttachmentVideo message={message} />
				{message.caption && (
					<div className={cn(baseBubble, message.isSelf ? selfBubble : otherBubble, "self-start")}>
						{message.caption}
					</div>
				)}
			</div>
		);
	}

	if (message.kind === "audio" && message.mediaMxc) {
		return (
			<div className={cn(baseBubble, "p-1.5", message.isSelf ? selfBubble : otherBubble)}>
				<AttachmentAudio message={message} />
			</div>
		);
	}

	if (message.kind === "file" && message.mediaMxc) {
		// Files render as a thumbnail card (no surrounding bubble) so a
		// wall of mixed attachments has consistent footprint with images.
		return <AttachmentFileCard message={message} />;
	}

	// iMessage-style "jumbo emoji": 1-3 emoji-only messages shed the
	// bubble and render at a much larger size.  Skipped once we hit 4+
	// because at that point it's stickerspam and dominating the column
	// becomes obnoxious.  Edited badge is preserved at normal size so
	// the (edited) hint still reads as text.
	const jumboCount = emojiOnlyCount(message.text);
	if (jumboCount !== null) {
		const sizeClass =
			jumboCount === 1 ? "text-7xl" :
			jumboCount === 2 ? "text-6xl" :
			"text-5xl";
		return (
			<div className={cn(
				"inline-flex flex-col gap-0.5",
				// Match the bubble's max-width semantics so the line
				// can wrap into 2 if 3 large glyphs don't fit on the
				// row, but otherwise paint with no chrome.
				"max-w-[60ch]",
			)}>
				<div className={cn(sizeClass, "leading-none break-words")}>
					{message.text}
				</div>
				{message.edited && (
					<span className="text-[10px] text-muted-foreground">(edited)</span>
				)}
			</div>
		);
	}

	// YouTube embeds: pull every YouTube URL out of the body, render
	// the surviving text through the normal pipeline (with the URLs
	// stripped so they don't print alongside the embed), and append
	// each video as its own player below the bubble.  Markdown
	// messages skip this — markdown already has its own URL handling
	// and the embed/markdown interaction isn't worth the complexity
	// for v1.
	const isMarkdown = looksLikeMarkdown(message.text);
	const youtubeMatches = isMarkdown ? [] : findYouTubeMatches(message.text);
	const strippedText = youtubeMatches.length > 0
		? stripYouTubeUrls(message.text, youtubeMatches)
		: message.text;
	const hasBubbleContent = strippedText.length > 0;
	const editedBadge = message.edited ? (
		<span className={cn(
			"ml-1.5 text-[10px]",
			message.isSelf ? "text-primary-foreground/60" : "text-muted-foreground",
		)}>
			(edited)
		</span>
	) : null;

	return (
		<div className="inline-flex flex-col gap-1.5 max-w-md">
			{(hasBubbleContent || isMarkdown) && (
				<div className={cn(
					baseBubble,
					message.isSelf ? selfBubble : otherBubble,
					// Plain-text path keeps Matrix's literal newlines via
					// pre-wrap.  Markdown owns its own whitespace.
					!isMarkdown && "whitespace-pre-wrap",
				)}>
					{isMarkdown ? (
						<MarkdownContent text={message.text} tone={message.isSelf ? "self" : "other"} />
					) : (
						renderWithMentions({
							text: strippedText,
							members: memberNames,
							onMentionClick,
							tone: message.isSelf ? "self" : "other",
						})
					)}
					{editedBadge}
				</div>
			)}
			{youtubeMatches.map((m, i) => (
				<YouTubeEmbed
					key={`${m.videoId}-${i}`}
					videoId={m.videoId}
					startSeconds={m.startSeconds}
				/>
			))}
			{!hasBubbleContent && !isMarkdown && message.edited && (
				// All-YouTube body with no surviving text still wants
				// the (edited) badge somewhere — tuck it under the
				// last embed.
				<span className="text-[10px] text-muted-foreground self-start">
					(edited)
				</span>
			)}
		</div>
	);
}


// ─── Attachment renderers ────────────────────────────────────────────
// All four use useMatrixAttachment to get an authenticated + (when
// needed) decrypted blob: URL.  While the fetch is in flight they
// render a tiny placeholder so the layout doesn't jump.

function AttachmentImage({ message }: { message: Message }) {
	const url = useMatrixAttachment(message);
	if (!url) {
		return (
			<div className="w-64 h-40 rounded-lg bg-muted-foreground/10 animate-pulse" />
		);
	}
	return (
		<img
			src={url}
			alt={message.mediaName ?? "attachment"}
			className="max-w-md max-h-80 rounded-lg block"
		/>
	);
}

function AttachmentVideo({ message }: { message: Message }) {
	const url = useMatrixAttachment(message);
	if (!url) {
		return (
			<div className="w-72 h-44 rounded-lg bg-muted-foreground/10 animate-pulse" />
		);
	}
	return (
		<video
			src={url}
			controls
			className="max-w-md max-h-80 rounded-lg block"
		/>
	);
}

function AttachmentAudio({ message }: { message: Message }) {
	const url = useMatrixAttachment(message);
	return (
		<div className="flex flex-col gap-1 min-w-[14rem] max-w-xs">
			<div className="text-[11px] font-medium truncate px-1">
				{message.mediaName ?? "Audio"}
			</div>
			{url ? (
				<audio src={url} controls className="w-full h-10" />
			) : (
				<div className="h-10 rounded bg-muted-foreground/10 animate-pulse" />
			)}
		</div>
	);
}

// Thumbnail-style card for non-image/video/audio files.  Matches the
// visual footprint of an image attachment (~14rem wide) so a mixed
// stack of attachments doesn't look ragged.  Whole card is one tap
// target: clicking downloads.
function AttachmentFileCard({ message }: { message: Message }) {
	const url = useMatrixAttachment(message);
	const name = message.mediaName ?? "Attachment";
	const sizeLabel = message.mediaSize ? formatBytes(message.mediaSize) : "";
	// Pull a 3-or-4-letter extension out of the filename for the badge.
	// Fallbacks: top-level mime ("audio", "text") then a generic glyph.
	const ext =
		(name.match(/\.([A-Za-z0-9]{1,5})$/)?.[1] ??
			message.mediaMimeType?.split("/")?.[0] ??
			"FILE")
			.toUpperCase()
			.slice(0, 4);
	const containerCn = cn(
		"group relative flex flex-col w-56 rounded-xl overflow-hidden border transition-colors",
		message.isSelf
			? "border-primary-foreground/20 bg-primary text-primary-foreground hover:bg-primary/90"
			: "border-border bg-muted text-foreground hover:bg-muted/80",
	);
	const inner = (
		<>
			{/* Preview area: file glyph + extension badge.  Fixed aspect
			    so this lines up next to image thumbnails. */}
			<div
				className={cn(
					"relative aspect-[4/3] flex items-center justify-center",
					message.isSelf ? "bg-primary-foreground/10" : "bg-muted-foreground/10",
				)}
			>
				<FileIcon
					className={cn(
						"h-10 w-10",
						message.isSelf ? "text-primary-foreground/70" : "text-muted-foreground",
					)}
				/>
				<span
					className={cn(
						"absolute bottom-2 right-2 text-[9px] font-semibold tracking-wider px-1.5 py-0.5 rounded",
						message.isSelf
							? "bg-primary-foreground/20 text-primary-foreground"
							: "bg-card/90 text-foreground border border-border",
					)}
				>
					{ext}
				</span>
				{url && (
					<span
						className={cn(
							"absolute inset-0 flex items-center justify-center",
							"opacity-0 group-hover:opacity-100 transition-opacity",
							message.isSelf ? "bg-primary/40" : "bg-foreground/10",
						)}
					>
						<Download className="h-5 w-5" />
					</span>
				)}
			</div>
			{/* Filename + size strip. */}
			<div className="px-2.5 py-1.5 min-w-0">
				<div className="text-xs font-medium truncate">{name}</div>
				{sizeLabel && (
					<div
						className={cn(
							"text-[10px] tabular-nums",
							message.isSelf ? "text-primary-foreground/70" : "text-muted-foreground",
						)}
					>
						{sizeLabel}
					</div>
				)}
			</div>
		</>
	);
	if (!url) {
		// Pre-fetch placeholder.  Same shape so layout is stable.
		return <div className={containerCn}>{inner}</div>;
	}
	return (
		<a
			href={url}
			download={name}
			className={containerCn}
			title={`Download ${name}`}
			aria-label={`Download ${name}`}
		>
			{inner}
		</a>
	);
}

// Compose-row preview for a file the user has selected but hasn't
// sent yet.  Image files render as a small square thumbnail (object-
// URL preview); everything else gets a file glyph + extension badge
// in the same square footprint.  Filename + size live to the right.
function PendingAttachmentChip({
	file, uploading, onRemove,
}: {
	file: File;
	uploading: boolean;
	onRemove(): void;
}) {
	const isImage = file.type.startsWith("image/");
	// Object URL is created once per file and revoked when the chip
	// unmounts (or the file changes).  Skipped for non-images to avoid
	// pinning the bytes for nothing.
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	useEffect(() => {
		if (!isImage) {
			setPreviewUrl(null);
			return;
		}
		const url = URL.createObjectURL(file);
		setPreviewUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [file, isImage]);

	const ext =
		(file.name.match(/\.([A-Za-z0-9]{1,5})$/)?.[1] ??
			file.type.split("/")[0] ??
			"FILE")
			.toUpperCase()
			.slice(0, 4);

	return (
		<div className="mb-2 flex items-center gap-3 px-2 py-2 rounded-md bg-muted/60 border border-border text-xs">
			<div className="relative h-12 w-12 shrink-0 rounded-md overflow-hidden bg-muted-foreground/10 flex items-center justify-center">
				{previewUrl ? (
					<img
						src={previewUrl}
						alt=""
						className="h-full w-full object-cover"
					/>
				) : (
					<>
						<FileIcon className="h-5 w-5 text-muted-foreground" />
						<span className="absolute bottom-0.5 right-0.5 text-[8px] font-semibold tracking-wider px-1 py-px rounded bg-card/90 text-foreground border border-border leading-none">
							{ext}
						</span>
					</>
				)}
			</div>
			<div className="flex-1 min-w-0">
				<div className="text-foreground font-medium truncate">
					{file.name}
				</div>
				<div className="text-muted-foreground tabular-nums">
					{formatBytes(file.size)}
					{file.type ? ` · ${file.type}` : ""}
				</div>
			</div>
			<button
				type="button"
				onClick={onRemove}
				disabled={uploading}
				className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 disabled:opacity-50"
				aria-label="Remove attachment"
				title="Remove attachment"
			>
				<X className="h-4 w-4" />
			</button>
		</div>
	);
}

// Detect a URL in a message body and, if Synapse returns OG metadata
// for it, render a Discord-style preview card under the bubble.  Skips
// rendering entirely when there's no URL or no preview was returned —
// no flicker, no empty cards.
//
// Suppressed for YouTube URLs — those render as native iframe embeds
// in MessageBubble; an OG card alongside the player would be redundant.
function UrlPreviewSlot({ text }: { text: string }) {
	const youtubeMatches = findYouTubeMatches(text);
	const textWithoutYouTube = youtubeMatches.length > 0
		? stripYouTubeUrls(text, youtubeMatches)
		: text;
	const url = firstLink(textWithoutYouTube);
	const preview = useUrlPreview(url);
	const imageUrl = useMatrixMedia(preview?.imageMxc);
	if (!url || !preview) return null;

	const host = (() => {
		try { return new URL(preview.url).hostname.replace(/^www\./, ""); }
		catch { return preview.siteName ?? ""; }
	})();

	// Two-column card when there's a thumbnail; full-width when there
	// isn't.  The accent border on the left mirrors Discord/Slack and
	// signals "this is metadata about a link, not a message itself."
	const hasImage = !!imageUrl;
	return (
		<a
			href={preview.url}
			target="_blank"
			rel="noopener noreferrer"
			className={cn(
				"mt-1.5 block max-w-md rounded-md overflow-hidden bg-muted/40 border border-border",
				"border-l-2 border-l-primary/70",
				"hover:bg-muted/60 transition-colors",
			)}
		>
			<div className={cn("flex", hasImage ? "gap-3" : "")}>
				<div className="flex-1 min-w-0 px-3 py-2 space-y-0.5">
					{(preview.siteName ?? host) && (
						<div className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">
							{preview.siteName ?? host}
						</div>
					)}
					<div className="text-sm font-medium leading-snug line-clamp-2">
						{preview.title}
					</div>
					{preview.description && (
						<div className="text-xs text-muted-foreground leading-snug line-clamp-2">
							{preview.description}
						</div>
					)}
				</div>
				{hasImage && (
					<div className="shrink-0 w-24 h-24 bg-muted-foreground/10">
						<img
							src={imageUrl}
							alt=""
							className="w-full h-full object-cover"
						/>
					</div>
				)}
			</div>
		</a>
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Compact timestamp for the username line.  Same shape Discord /
 * Slack / iMessage use: time-of-day for messages today, "Yesterday
 * HH:MM" for yesterday, "MMM D" for older within the year, "MMM D,
 * YYYY" for older still.  Locale-aware via toLocaleTimeString /
 * toLocaleDateString — respects 12h/24h preferences set at the OS
 * level. */
function formatChatTimestamp(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	const isYesterday = d.toDateString() === yesterday.toDateString();
	const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	if (sameDay) return time;
	if (isYesterday) return `Yesterday ${time}`;
	if (d.getFullYear() === now.getFullYear()) {
		return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ` ${time}`;
	}
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Strip the leading `@` and the `:server` suffix off a Matrix MXID,
 * leaving just the localpart.  Fallback display when a member has no
 * displayname set.  Idempotent on already-bare strings. */
function localpartOf(mxid: string): string {
	const at = mxid.indexOf("@");
	const colon = mxid.indexOf(":");
	if (at !== 0 || colon < 2) return mxid;
	return mxid.slice(1, colon);
}

/** Seen-by indicator on a sent message.
 *
 *   - DM: a small "Read · 2:41 PM" line (when at least one other
 *     party has read past this message).  Hidden until the read
 *     receipt arrives — sender doesn't need to see "Sent" on every
 *     message they just sent.
 *   - Group room: an avatar stack (max 4 visible) + count.  Click
 *     opens a modal listing every reader with timestamp.
 *
 * Re-renders when `receiptsVersion` bumps (which happens every time
 * matrix-js-sdk delivers a Room.Receipt for the active room).
 * Calls transport.getMessageSeenBy on every render — cheap, in-
 * memory matrix-js-sdk lookup; no network. */
function SeenIndicator({
	roomId,
	eventId,
	isDm,
	receiptsVersion,
	memberAvatars,
	memberNames,
}: {
	roomId: RoomId;
	eventId: EventId;
	isDm: boolean;
	receiptsVersion: number;
	memberAvatars: Map<string, string | undefined>;
	memberNames: Map<string, string>;
}) {
	const transport = useTransport();
	const [open, setOpen] = useState(false);

	// receiptsVersion in deps via useMemo so we re-query when it
	// bumps.  matrix-js-sdk owns the actual receipt cache; we just
	// trigger a re-read.
	const seen = useMemo(() => {
		if (!transport) return [];
		return transport.getMessageSeenBy(roomId, eventId);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [transport, roomId, eventId, receiptsVersion]);

	if (seen.length === 0) return null;

	if (isDm) {
		// DM: show "Read · 2:41 PM" subtle text.  Most recent reader's
		// timestamp (in DMs there's only one possible reader anyway).
		const ts = seen[0]!.ts;
		return (
			<span className="text-[10px] text-muted-foreground/70 tabular-nums whitespace-nowrap">
				Read · {formatChatTimestamp(ts)}
			</span>
		);
	}

	// Group room: avatar stack + count, click → modal.
	const visible = seen.slice(0, 4);
	const moreCount = seen.length - visible.length;

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className={cn(
					"inline-flex items-center gap-1",
					"px-1.5 py-0.5 rounded-full",
					"text-[10px] text-muted-foreground/70",
					"hover:bg-accent hover:text-foreground transition-colors",
				)}
				aria-label={`Seen by ${seen.length} ${seen.length === 1 ? "person" : "people"}`}
			>
				{/* Avatars stack horizontally with negative margin so
				    they overlap slightly — same convention Slack /
				    Linear / Telegram use for compact reader lists. */}
				<span className="flex -space-x-1">
					{visible.map(s => (
						<MatrixAvatar
							key={s.userId}
							mxc={memberAvatars.get(s.userId) ?? undefined}
							seed={s.userId}
							kind="user"
							className="h-4 w-4 rounded-full ring-1 ring-background"
						/>
					))}
				</span>
				{moreCount > 0 && <span className="tabular-nums">+{moreCount}</span>}
			</button>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-xs max-h-[80vh] flex flex-col gap-0 p-0 overflow-hidden">
					<DialogHeader className="px-4 pt-4 pb-3 border-b border-border/50">
						<DialogTitle className="text-base">
							Seen by {seen.length}
						</DialogTitle>
					</DialogHeader>
					<div className="flex-1 overflow-y-auto py-1">
						{seen.map(s => (
							<div
								key={s.userId}
								className="px-4 py-2 flex items-center gap-3"
							>
								<MatrixAvatar
									mxc={memberAvatars.get(s.userId) ?? undefined}
									seed={s.userId}
									kind="user"
									className="h-8 w-8 rounded-full shrink-0"
								/>
								<div className="flex-1 min-w-0">
									<div className="text-sm font-medium truncate">
										{memberNames.get(s.userId) ?? localpartOf(s.userId)}
									</div>
								</div>
								<div className="text-[10px] text-muted-foreground tabular-nums shrink-0">
									{formatChatTimestamp(s.ts)}
								</div>
							</div>
						))}
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

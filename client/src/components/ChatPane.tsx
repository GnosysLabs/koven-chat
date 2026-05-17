// Chat pane — messages of the active room + send input.  Bubble-style
// layout: avatar + display name shown once per consecutive group of
// messages from the same sender (within 5 minutes); each message
// renders in its own rounded bubble.  Self messages use the primary
// bubble color; everyone else uses the muted card color.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDrag } from "@use-gesture/react";
import type { EventId, FlagAggregate, FlagCategory, Member, Message, PollAggregate, ReactionAggregate, Room, RoomId, UserId } from "@koven/shared";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { ReactionPills } from "@/components/ReactionPills";
import { MessageActions } from "@/components/MessageActions";
import { BotBadge } from "@/components/BotBadge";
import { RoomVoiceBar } from "@/components/voice/RoomVoiceBar";
import { InCallPane } from "@/components/voice/InCallPane";
import { useCall } from "@/lib/call-context";
import { joinCall as joinCallApi, CallApiError } from "@/lib/calls-api";
import { FounderBadge } from "@/components/FounderBadge";
import { getCachedFounderNumber } from "@/lib/founders-cache";
import {
	MentionAutocomplete,
	activeMentionToken,
	scoreCandidate,
	type AutocompleteCandidate,
} from "@/components/MentionAutocomplete";
import { serverOf } from "@/lib/mxid";
import { FlagDialog } from "@/components/FlagDialog";
import { DeleteMessageDialog } from "@/components/DeleteMessageDialog";
import { AdminRedactDialog } from "@/components/AdminRedactDialog";
import { MediaContextMenu } from "@/components/MediaContextMenu";
import { MessageContextMenu } from "@/components/MessageContextMenu";
import { firstLink, linkify } from "@/lib/linkify";
import { renderWithMentions } from "@/lib/mentionRender";
import { buildMessageUrl, parseShareLinkUrl } from "@/lib/inviteLink";
import { findYouTubeMatches, isYouTubeUrl, stripYouTubeUrls } from "@/lib/youtube";
import { YouTubeEmbed } from "@/components/YouTubeEmbed";
import { MediaPicker } from "@/components/MediaPicker";
import { PollCard } from "@/components/PollCard";
import { CreatePollDialog } from "@/components/CreatePollDialog";
import { GallerySheet } from "@/components/GallerySheet";
import { MarkdownContent } from "@/components/MarkdownContent";
import { isMobileShell } from "@/lib/mobile";
import { hapticImpact } from "@/lib/haptics";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { MobileReactionSheet } from "@/components/MobileReactionSheet";

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
import { useMatrixAttachment, useMatrixVideoPoster } from "@/lib/useMatrixAttachment";
import { useMatrixMedia } from "@/lib/useMatrixMedia";
import { autoAvatarUrl } from "@/lib/avatar";
import { useUrlPreview } from "@/lib/useUrlPreview";
import type { UrlPreview } from "@/lib/matrix";
import { useTransport } from "@/lib/transportContext";
import { messageMentionsUser } from "@/lib/mention";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AlertTriangle, ArrowDown, ArrowUp, BarChart3, Check, CheckCheck, CornerDownRight, Download, EyeOff, File as FileIcon, Flag, Images, Lock, Maximize2, MessageSquare as MessageSquareIcon, Minimize2, Paperclip, Pause, Play, Plus, Reply, Scale, Settings, X } from "lucide-react";

export interface ChatPaneProps {
	room: Room | null;
	messages: Message[];
	memberAvatars: Map<string, string | undefined>;   // userId → mxc URL
	reactionsByMessage: Map<EventId, ReactionAggregate[]>;
	flagsByMessage: Map<EventId, FlagAggregate>;
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
	// Open the per-room public mod log dialog.
	onOpenModLog(roomId: EventId): void;
	// Submit a room-target report.  Rendered as a Flag icon right of
	// the mod log icon in the header.  Optional: when omitted (DMs,
	// encrypted rooms, etc.) the icon is hidden.  Throws on engine-
	// side rejection so the dialog can show the error inline.
	onFlagRoom?(roomId: EventId, category: FlagCategory, rationale?: string): void | Promise<void>;
	// mxids that should render with a BOT badge next to their name
	// (sender labels, reply-quote labels).  Default empty Set means
	// no badges — safe pre-fetch state.
	botMxids?: Set<string>;
	// Service identities (engine appservice user, Synapse admin
	// user) the SPA filters from "seen by" rosters so they don't
	// appear as participants who read everything.  Distinct from
	// botMxids: these aren't bots, just platform components that
	// happen to be Matrix users on the homeserver.
	serviceMxids?: Set<string>;
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
	// Admin-redact handler.  Distinct from `onDeleteMessage` (which is
	// authored-by-viewer or owned-bot-message only): this fires for
	// admins (PL ≥ 50) acting on someone else's content.  Should
	// perform the Synapse redact + record the mod_action audit row.
	// Optional; when omitted, the Shield admin-redact icon is never
	// shown.  See also `canModerateRoom` below — both required for the
	// affordance to surface.
	onAdminRedactMessage?(eventId: EventId): Promise<void>;
	// True when the viewer has PL ≥ 50 in the active room.  Combined
	// with onAdminRedactMessage to gate the shield icon next to the
	// hover toolbar on rows the viewer doesn't own.
	canModerateRoom?: boolean;
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
	// Right-click message context menu callbacks.  onSendDm opens
	// (or creates) a DM with the targeted user; onBlockSender adds
	// them to the m.ignored_user_list.  Both optional — context menu
	// items that need them are filtered out when missing.
	onSendDm?(userId: UserId): void | Promise<void>;
	onBlockSender?(userId: UserId): void | Promise<void>;
	// Bearer token used for the engine's Klipy proxy (search /
	// trending).  Required for the media picker to work; absent or
	// empty keeps the picker hidden even if the integration is
	// configured.
	accessToken?: string;
	// True when the instance admin has set a Klipy API key, drives
	// the GIF / clip / sticker picker affordance next to the
	// paperclip.  Optional; defaults to "off" so instances without
	// Klipy don't see the button at all.
	klipyEnabled?: boolean;
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
		/** Hide voter identities in the UI (default false). */
		anonymous?: boolean;
	}): Promise<void> | void;
	// Cast / change a vote on a poll.  Empty `answerIds` withdraws
	// the vote.  Receives the poll start event id (== the message id).
	onVoteOnPoll?(pollId: EventId, answerIds: string[]): Promise<void> | void;
	// End a poll.  Creator-only by spec; the receiving end ignores
	// end-events from anyone except the start sender.
	onEndPoll?(pollId: EventId): Promise<void> | void;
	// Mxids currently typing in this room (self always excluded
	// at the transport layer).  Empty / undefined hides the
	// indicator.  Updates live via state.typingByRoom which the
	// transport maintains from m.typing ephemeral events.
	typingUserIds?: UserId[];
	// Called when the local user starts or stops typing.  Fires
	// once on the first keystroke (debounced; doesn't re-fire on
	// every char), again every ~5s while still typing to keep the
	// indicator alive server-side, and with false on send / idle /
	// blur / room change.  Best-effort, the parent forwards to
	// transport.setMyTyping which itself is best-effort.
	onTypingChange?(isTyping: boolean): void;
	// Permalink scroll target.  When set, ChatPane scrolls to the
	// referenced event (paginating older history backwards if it
	// isn't loaded yet) and pulses a brief highlight on the row so
	// the user can see where they landed.  Cleared via
	// onScrolledToEvent once consumed.  Cross-room intents are
	// gated on `roomId` matching the active room — if a user
	// permalink-clicks into a different room, the parent flips the
	// active room first and ChatPane's next mount sees the target.
	scrollToEvent?: { roomId: RoomId; eventId: EventId } | null;
	onScrolledToEvent?(): void;
}

// Threshold for "this message is part of the same group as the
// previous one" — same sender + this many ms or less since the prior
// message.  Five minutes feels right for chat; longer than typical
// rapid-fire bursts, shorter than separate sessions.
const GROUP_WINDOW_MS = 5 * 60 * 1000;

// Stable empty array for the `reactions` prop on MessageRow.  Using
// `reactionsByMessage.get(id) ?? []` inline creates a fresh [] every
// render, which would defeat React.memo's reaction-array comparison on
// every render for every message without reactions (i.e. most messages).
const EMPTY_REACTIONS: ReactionAggregate[] = [];

// Pagination triggers when the user scrolls within this many pixels
// of the top of loaded history.  600px is roughly one viewport height
// on mobile and well under the threshold for "user notices a slight
// content shift" — pagination commits and `overflow-anchor: auto`
// keeps their visible content stable.
const TOP_PAGINATION_PX = 600;

// "Near the bottom" threshold.  Within this many px of the actual
// bottom, the user is considered to want stick-to-bottom behaviour:
// new messages arriving at the end will scroll into view.  Outside
// this threshold the user is "reading history" and we leave the
// scroll position alone.
const BOTTOM_STICKY_PX = 100;

// "Scrolled meaningfully back from the bottom" — drives the
// Jump-to-newest button visibility.  Higher than BOTTOM_STICKY_PX so
// the button doesn't flicker in and out near the bottom edge.
const JUMP_TO_NEWEST_PX = 200;

// Cap for the multi-attachment composer.  10 mirrors Discord's
// per-message attachment limit and stops a "select all 250 files in
// this folder" mistake from spamming the room with 250 events.
const MAX_PENDING_ATTACHMENTS = 10;

export function ChatPane({
	room, messages, memberAvatars, reactionsByMessage, flagsByMessage,
	onSendMessage, onSendAttachment, onReact, onUnreact, onFlag, onUnflag, onAcceptInvite, onDeclineInvite, onInvite, onEditRoom,
	onOpenModLog, onFlagRoom,
	botMxids,
	serviceMxids,
	myOwnedBotMxids,
	onDeleteMessage,
	onAdminRedactMessage,
	canModerateRoom,
	messagesLoaded,
	members,
	viewerServer,
	onLoadMoreHistory,
	receiptsVersion,
	viewerUserId,
	onOpenProfile,
	onSendDm,
	onBlockSender,
	accessToken,
	klipyEnabled,
	pollsByMessage,
	onCreatePoll,
	onVoteOnPoll,
	onEndPoll,
	typingUserIds,
	onTypingChange,
	scrollToEvent,
	onScrolledToEvent,
}: ChatPaneProps) {
	// Reporting only works where the engine can read messages:
	//   - DMs are 1-on-1 — there's no admin to forward a report to.
	//   - Encrypted rooms hide message content from the engine, so
	//     admins reviewing a report can't see the underlying message.
	//     Better to hide the affordance than to surface unreadable
	//     reports to the admin queue.
	const flaggable = !!room && room.kind !== "dm" && !room.encrypted;
	const [roomFlagOpen, setRoomFlagOpen] = useState(false);
	// Gallery sheet — opens from the header's Images icon, shows every
	// image/video shared in the room as a grid + lightbox.
	const [galleryOpen, setGalleryOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const [replyTarget, setReplyTarget] = useState<Message | null>(null);

	// Typing-indicator throttle.  Matrix's `m.typing` events carry an
	// embedded timeout (10s, see transport.setMyTyping); we fire
	// isTyping=true on the first keystroke after an idle period and
	// re-up every 5s while the user keeps typing, then fire false on
	// send / clear / idle 3s / room change / unmount.  Two refs:
	// `lastTypingSentAt` for the 5s throttle, `typingIdleTimer` for
	// the 3s post-keystroke "they stopped" deadline.  Bare refs
	// rather than state because changing them shouldn't re-render.
	const lastTypingSentAtRef = useRef(0);
	const typingIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const onTypingChangeRef = useRef(onTypingChange);
	useEffect(() => { onTypingChangeRef.current = onTypingChange; }, [onTypingChange]);
	const stopTypingNow = useCallback(() => {
		if (typingIdleTimerRef.current) {
			clearTimeout(typingIdleTimerRef.current);
			typingIdleTimerRef.current = null;
		}
		if (lastTypingSentAtRef.current > 0) {
			lastTypingSentAtRef.current = 0;
			onTypingChangeRef.current?.(false);
		}
	}, []);
	const noteTypingActivity = useCallback(() => {
		const now = Date.now();
		// Re-up the upstream "is typing" every 5s.  First keystroke
		// (lastTypingSentAt === 0) always fires; subsequent ones
		// only refresh if 5s have passed since the last send.
		if (now - lastTypingSentAtRef.current > 5000) {
			lastTypingSentAtRef.current = now;
			onTypingChangeRef.current?.(true);
		}
		// Reset the idle countdown.  3s with no further keystrokes
		// flips us to isTyping=false; if the user resumes typing
		// before then the noteTypingActivity call above kicks the
		// throttle back into life on the next 5s boundary.
		if (typingIdleTimerRef.current) clearTimeout(typingIdleTimerRef.current);
		typingIdleTimerRef.current = setTimeout(() => {
			lastTypingSentAtRef.current = 0;
			onTypingChangeRef.current?.(false);
		}, 3000);
	}, []);
	// Stop typing immediately when the active room changes or the
	// pane unmounts.  Without this, switching rooms with the
	// composer focused would strand an isTyping=true on the
	// previous room until its 10s server-side timeout expired.
	useEffect(() => {
		return () => stopTypingNow();
	}, [room?.id, stopTypingNow]);
	// Pending attachments: the user picked one or more files but hasn't
	// hit send yet.  Up to MAX_PENDING_ATTACHMENTS at once; each file
	// posts as its OWN m.room.message event in pick order — no album
	// grouping, no metadata UI, just a row of thumbnails the user can
	// remove individually before sending.  Optional caption in the
	// composer goes out as a separate text message AFTER the media so
	// the timeline reads attachments-then-comment.
	const [pendingAttachments, setPendingAttachments] = useState<File[]>([]);
	const [uploading, setUploading] = useState(false);
	// Modal state for the create-poll dialog.  Triggered from the
	// composer button; close on submit (the dialog handles the close
	// itself once the m.poll.start send resolves).
	const [pollDialogOpen, setPollDialogOpen] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	// Mobile composer collapses paperclip / poll / GIF behind a `+`
	// button (iMessage app-picker convention).  Open state lives here
	// so menu items can close the popover after picking.
	const [composerMenuOpen, setComposerMenuOpen] = useState(false);
	// GIF / clip / sticker sheet open state.  Lives here (not inside
	// MediaPicker) so the sheet outlives the "+" menu popover: the menu
	// item that opens it closes the menu, which would unmount a picker
	// nested inside the menu's content.
	const [gifSheetOpen, setGifSheetOpen] = useState(false);
	const composerMenuPointerHandledRef = useRef(false);
	const composeInputRef = useRef<HTMLTextAreaElement | null>(null);
	const toggleComposerMenu = useCallback(() => {
		void hapticImpact("light");
		setComposerMenuOpen(open => !open);
	}, []);
	// Auto-grow the composer to fit its content (Discord-style).  Runs
	// on every draft change: clear the inline height so scrollHeight
	// reflects the natural content height, then write that back as the
	// new height.
	//
	// CRITICAL: cap by the CSS `max-h-[50vh]`.  Setting `el.style.height`
	// inline OVERRIDES the CSS max-height — without the manual clamp,
	// a huge pasted message (or a draft you forgot you typed days ago,
	// since drafts persist in component state across room switches)
	// blew the textarea's height past the viewport, leaving zero
	// room for the scroll container above it.  Symptom: "scroll is
	// broken in this one room only" with no obvious cause, since the
	// composer's growth is the only per-room layout the user can
	// inadvertently trigger.  Reading the computed maxHeight keeps
	// us honest if the cap class ever changes.
	//
	// useLayoutEffect (not useEffect) so the height update happens
	// before paint and there's no flash of the wrong size.
	useLayoutEffect(() => {
		const el = composeInputRef.current;
		if (!el) return;
		el.style.height = "auto";
		const maxHeightStr = window.getComputedStyle(el).maxHeight;
		const maxHeight = parseFloat(maxHeightStr);
		const cap = Number.isFinite(maxHeight) && maxHeight > 0
			? maxHeight
			: window.innerHeight * 0.5;
		el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
	}, [draft]);
	// The actual native scroll container — a plain `<div>` with
	// `overflow-y: auto`, `flex-direction: column-reverse`, and
	// `overflow-anchor: auto`.  No virtualization library: the
	// browser does off-screen culling via `content-visibility: auto`
	// on each row (set in `renderTimelineRow`), and position
	// preservation across prepends comes from `overflow-anchor`
	// combined with column-reverse's natural "anchored to the
	// bottom" scroll semantics.  See the comments on the JSX below
	// for the full reasoning.
	const scrollRef = useRef<HTMLDivElement | null>(null);
	// Sentinel elements at the visual bottom and visual top of the
	// scroll content.  We watch them with `IntersectionObserver`
	// instead of reading `scrollTop` — `scrollTop` semantics under
	// `flex-direction: column-reverse` differ between browsers (and
	// the WebKit/iOS implementation in particular goes NEGATIVE), so
	// arithmetic on it is a portability trap.  The observers give us
	// a binary "is this element in the viewport (with margin)?"
	// signal that works identically everywhere.
	//
	//   - `bottomSentinelRef` — placed as the FIRST child of the
	//     scroll container, which `column-reverse` puts at the
	//     visual BOTTOM.  Drives the at-bottom state (Jump-to-newest
	//     button visibility) and the mobile keyboard-dismiss
	//     behaviour, and is the scroll target for both the initial
	//     room mount and the Jump-to-newest button (via
	//     `scrollIntoView`).
	//
	//   - `topSentinelRef` — placed as the LAST child of the scroll
	//     container, which `column-reverse` puts at the visual TOP.
	//     When the user scrolls within `TOP_PAGINATION_PX` of it (via
	//     `rootMargin`), pagination fires.
	const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
	const topSentinelRef = useRef<HTMLDivElement | null>(null);
	const roomId = room?.id;
	// Active-call gate.  Discord-style: voice and chat are SEPARATE
	// views even when they share a room.  We only swap the message
	// area for the call surface when the user has explicitly
	// entered the "call view" (true after they hit Join, false
	// after they click the room name in the sidebar).  When false,
	// chat renders normally and the floating PIP gives them one-
	// click access back to the call view.
	const call = useCall();
	const isInActiveCallRoom =
		!!call.activeCall &&
		call.activeCall.roomId === room?.id &&
		call.inCallView &&
		(call.phase === "prejoin" || call.phase === "joined" || call.phase === "connecting");
	// Cursor position in the compose box.  Tracked separately from
	// `draft` because keyboard shortcuts (Tab, Enter for send) fire
	// before React syncs the input's selectionStart.  Updated on
	// every keystroke, focus, and click.
	const [cursor, setCursor] = useState(0);
	// @-mention autocomplete state.  selectedIndex resets to 0 on
	// every query change so arrow-down behaves intuitively.
	const [mentionIndex, setMentionIndex] = useState(0);

	// ─── Scroll state ──────────────────────────────────────────────
	// Everything in here drives a single native <div> with
	// `flex-direction: column-reverse` + `overflow-anchor: auto`.
	// The browser handles position preservation across prepends; we
	// only need to track at-bottom for the Jump-to-newest affordance
	// and fire pagination when the user scrolls near the (visual) top.
	const prevRoomIdRef = useRef<string | undefined>(undefined);
	const wasInCallViewRef = useRef(false);
	// At-bottom tracking.  `wasAtBottomRef` is the synchronous read
	// for handlers running outside the React commit cycle (currently
	// just the room-change reset).  `scrolledUp` is the React-state
	// mirror that drives the Jump-to-newest button — flipped from the
	// scroll-event handler with a debounce against the JUMP_TO_NEWEST
	// threshold so the button doesn't flicker around the edge.
	const wasAtBottomRef = useRef(true);
	const [scrolledUp, setScrolledUp] = useState(false);

	// Pagination state.  `loadingMoreRef` is the synchronous gate
	// (scroll handler reads it without waiting on React commit);
	// `loadingMore` is the React mirror that drives the pulsing-
	// favicon loader.  `noMoreHistoryRef` caches rooms whose Synapse
	// timeline we've walked to the start so we don't keep firing
	// /messages for nothing.
	const loadingMoreRef = useRef(false);
	const noMoreHistoryRef = useRef<Set<string>>(new Set());
	const [loadingMore, setLoadingMore] = useState(false);
	// Mirror of `noMoreHistoryRef.has(activeRoomId)` into React state
	// so the "Beginning of room" indicator below the timeline knows
	// when to show.  Updated together with the ref whenever
	// `loadOlderHistory` resolves with `gotMore = false`, and
	// re-synced from the ref on room change.
	const [atStartOfRoom, setAtStartOfRoom] = useState(false);

	// Reverse the messages array for the column-reverse render path.
	// In `flex-direction: column-reverse`, the FIRST child in DOM is
	// at the visual BOTTOM of the flex container — and the browser's
	// scroll-anchoring keeps the scroll position pinned to the
	// bottom when content is added at the start of the DOM (which is
	// where new messages go).  Without column-reverse we'd have to
	// imperatively scrollTop=scrollHeight on every new message and
	// fight the user's gesture; with it the browser does the right
	// thing for free.
	//
	// Memoised on the messages array reference so we don't burn the
	// reverse() cost on every render — only when the messages prop
	// genuinely changes.
	const reversedMessages = useMemo(() => [...messages].reverse(), [messages]);

	const scrollToBottom = useCallback((behavior: "auto" | "smooth" = "auto") => {
		// `scrollIntoView` on the bottom sentinel works regardless of
		// `column-reverse`'s scrollTop semantics — the browser just
		// brings the element into view, period.  Block "end" puts it
		// flush at the bottom edge of the scroll viewport.
		bottomSentinelRef.current?.scrollIntoView({ behavior, block: "end" });
	}, []);

	const loadOlderHistory = useCallback(() => {
		const activeRoomId = room?.id as RoomId | undefined;
		if (!activeRoomId || !onLoadMoreHistory) return false;
		if (loadingMoreRef.current) return false;
		if (noMoreHistoryRef.current.has(activeRoomId)) return false;

		loadingMoreRef.current = true;
		setLoadingMore(true);
		void onLoadMoreHistory(activeRoomId)
			.then((gotMore) => {
				if (!gotMore) {
					noMoreHistoryRef.current.add(activeRoomId);
					if (activeRoomId === room?.id) setAtStartOfRoom(true);
				}
			})
			.finally(() => {
				loadingMoreRef.current = false;
				setLoadingMore(false);
			});
		return true;
	}, [onLoadMoreHistory, room?.id]);

	// Reset at-bottom tracking on room change / call-view exit.  In
	// column-reverse layout `scrollTop=0` IS the visual bottom — the
	// freshly-mounted scroll container starts at the bottom by
	// default, so we don't have to imperatively scroll there.  We
	// just have to make sure the at-bottom state (wasAtBottomRef,
	// scrolledUp, atStartOfRoom) reflects that until the
	// IntersectionObserver below has had a chance to fire.
	useLayoutEffect(() => {
		const isRoomChange = prevRoomIdRef.current !== room?.id;
		const becameVisible = wasInCallViewRef.current && !isInActiveCallRoom;
		prevRoomIdRef.current = room?.id;
		wasInCallViewRef.current = isInActiveCallRoom;
		if (isRoomChange || becameVisible) {
			wasAtBottomRef.current = true;
			setScrolledUp(false);
			setAtStartOfRoom(noMoreHistoryRef.current.has(room?.id ?? ""));
		}
	}, [room?.id, isInActiveCallRoom]);

	// Pagination — fires when the top sentinel comes within
	// `TOP_PAGINATION_PX` of the viewport's top edge.  We extend the
	// observer's viewport upward by that margin, so the sentinel
	// intersects EARLY (preload before the user hits the actual
	// top).  Using IntersectionObserver instead of arithmetic on
	// `scrollTop` makes this work identically across browsers — the
	// `column-reverse` `scrollTop`-goes-negative gotcha on WebKit
	// would otherwise break us.
	useEffect(() => {
		if (!messagesLoaded || isInActiveCallRoom) return;
		const root = scrollRef.current;
		const target = topSentinelRef.current;
		if (!root || !target) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting && !loadingMoreRef.current) {
						loadOlderHistory();
					}
				}
			},
			{ root, rootMargin: `${TOP_PAGINATION_PX}px 0px 0px 0px` },
		);
		observer.observe(target);
		return () => observer.disconnect();
	}, [messagesLoaded, isInActiveCallRoom, loadOlderHistory]);

	// At-bottom tracking — observes the bottom sentinel for visibility
	// in the viewport.  Drives the Jump-to-newest button (visible
	// when sentinel is NOT in view) and triggers the mobile keyboard
	// dismiss the first time the user leaves the bottom.  The
	// `rootMargin: ${JUMP_TO_NEWEST_PX}px 0 0 0` extension on the
	// bottom side means "still considered at bottom while within
	// JUMP_TO_NEWEST_PX of it" — avoids the button flickering as the
	// user scrolls a few pixels back from the absolute bottom.
	useEffect(() => {
		if (!messagesLoaded || isInActiveCallRoom) return;
		const root = scrollRef.current;
		const target = bottomSentinelRef.current;
		if (!root || !target) return;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const isAtBottom = entry.isIntersecting;
					const wasAtBottom = wasAtBottomRef.current;
					wasAtBottomRef.current = isAtBottom;
					setScrolledUp(prev => (prev === !isAtBottom ? prev : !isAtBottom));
					// Mobile keyboard dismiss the moment the user
					// scrolls AWAY from the bottom — once you're
					// reading history, the keyboard just gets in the
					// way.  Fires once per "leaving the bottom"
					// transition.
					if (isMobileShell && wasAtBottom && !isAtBottom) {
						composeInputRef.current?.blur();
					}
				}
			},
			{ root, rootMargin: `0px 0px ${JUMP_TO_NEWEST_PX}px 0px` },
		);
		observer.observe(target);
		return () => observer.disconnect();
	}, [messagesLoaded, isInActiveCallRoom, isMobileShell]);

	// ─── Permalink scroll-to-event ─────────────────────────────────
	// When the parent hands us a `scrollToEvent` target (typically
	// from a /r/<roomId>/<eventId> share-link click), find the row
	// by `data-message-id` and call native `scrollIntoView` to bring
	// it on-screen, then pulse a 2-second highlight so the user can
	// see where they landed.  Two-phase:
	//
	//   1. If the event is already in the loaded `messages` list,
	//      scrollIntoView with smooth behavior on the next animation
	//      frame (after React has committed the layout — content-
	//      visibility:auto means the row may not be painted yet).
	//   2. If it's not loaded, fire loadOlderHistory to paginate
	//      older events in.  The effect re-runs on the new messages
	//      array; keeps walking back up to MAX_SCROLL_PAGINATIONS
	//      times before giving up.
	//
	// Both terminal paths (found-and-scrolled / gave-up) call
	// onScrolledToEvent so the parent clears its pending state and
	// the effect doesn't fire again on subsequent renders.
	const [flashingEventId, setFlashingEventId] = useState<EventId | null>(null);
	const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const scrollTargetKeyRef = useRef<string | null>(null);
	const scrollAttemptsRef = useRef(0);
	const MAX_SCROLL_PAGINATIONS = 10;
	useEffect(() => {
		if (!scrollToEvent) {
			scrollTargetKeyRef.current = null;
			scrollAttemptsRef.current = 0;
			return;
		}
		if (!room || scrollToEvent.roomId !== room.id) return;

		const key = `${scrollToEvent.roomId}/${scrollToEvent.eventId}`;
		if (scrollTargetKeyRef.current !== key) {
			// New target — reset the pagination counter so we get a
			// fresh budget per click.
			scrollTargetKeyRef.current = key;
			scrollAttemptsRef.current = 0;
		}

		const idx = messages.findIndex(m => m.id === scrollToEvent.eventId);
		if (idx >= 0) {
			const id = scrollToEvent.eventId;
			const raf = requestAnimationFrame(() => {
				const row = scrollRef.current?.querySelector(
					`[data-message-id="${CSS.escape(id)}"]`,
				);
				if (row instanceof HTMLElement) {
					row.scrollIntoView({ block: "center", behavior: "smooth" });
				}
				setFlashingEventId(id);
				if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
				flashTimerRef.current = setTimeout(
					() => setFlashingEventId(null),
					2000,
				);
			});
			onScrolledToEvent?.();
			return () => cancelAnimationFrame(raf);
		}

		// Not loaded — try to paginate older history in.  Bail if
		// we've already burned the budget, hit the start of the
		// room, or another pagination is in flight (the scroll-
		// handler pagination loop will re-fire us when more
		// messages commit).
		if (scrollAttemptsRef.current >= MAX_SCROLL_PAGINATIONS) {
			console.warn("scrollToEvent: gave up after pagination cap", scrollToEvent);
			onScrolledToEvent?.();
			return;
		}
		if (noMoreHistoryRef.current.has(scrollToEvent.roomId)) {
			console.warn("scrollToEvent: hit start of room without finding event", scrollToEvent);
			onScrolledToEvent?.();
			return;
		}
		if (loadingMoreRef.current || !onLoadMoreHistory) return;
		scrollAttemptsRef.current += 1;
		loadOlderHistory();
	}, [scrollToEvent, room, messages, onLoadMoreHistory, onScrolledToEvent, loadOlderHistory]);
	useEffect(() => () => {
		if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
	}, []);

	// Global hover tracking for the message-action toolbar.
	//
	// Why not React state: every desktop mousemove inside the chat
	// pane would call `setState` → React commit → re-render every
	// visible MessageRow that carries an `isHovered` prop.  On Tauri
	// (WKWebView / WebView2 / WebKitGTK), scroll and JS share the
	// main thread, so a state update during a scroll frame stalls
	// the scroll.  On iOS Capacitor the listener never fires (touch
	// has no hover), but desktop users were paying the full re-render
	// cost on every cursor-pixel of trackpad / mousewheel scrolling.
	// Result: scroll felt janky on desktop, smooth on mobile, same
	// SPA.  We now write hover state directly to the DOM via a
	// `data-row-hovered` attribute on the hovered row's wrapper, and
	// drive visibility from CSS.  React never re-renders for hover.
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
	// What works: native `mousemove` listener on `document` plus
	// imperative DOM attribute toggling.  Document-level events fire
	// most reliably in every WKWebView build (the quirks above are
	// about per-element bubbling/capture, not about document seeing
	// mousemove at all).  `mouseleave` on the document handles the
	// "cursor left the window entirely" case (e.g. moved to the
	// macOS title bar).
	//
	// `mousemove` instead of `pointermove`: mouse events are the OG
	// and are more universally implemented in older WebKit branches
	// than pointer events.
	const hoveredRowElRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		const setHovered = (el: HTMLElement | null) => {
			const prev = hoveredRowElRef.current;
			if (prev === el) return;
			if (prev) prev.removeAttribute("data-row-hovered");
			if (el) el.setAttribute("data-row-hovered", "true");
			hoveredRowElRef.current = el;
		};
		const onMove = (e: MouseEvent) => {
			const t = e.target as HTMLElement | null;
			const msgEl = (t?.closest("[data-message-id]") ?? null) as HTMLElement | null;
			setHovered(msgEl);
		};
		const onLeave = () => setHovered(null);
		document.addEventListener("mousemove", onMove, { passive: true });
		document.addEventListener("mouseleave", onLeave, { passive: true });
		return () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseleave", onLeave);
			// Clear any lingering attribute on unmount so an orphan
			// `[data-row-hovered]` doesn't leak into the next mount.
			if (hoveredRowElRef.current) {
				hoveredRowElRef.current.removeAttribute("data-row-hovered");
				hoveredRowElRef.current = null;
			}
		};
	}, []);

	// Clear the reply target + any pending attachments when the user
	// switches rooms — those are scoped to the previous conversation.
	useEffect(() => {
		setReplyTarget(null);
		setPendingAttachments([]);
		setUploading(false);
	}, [room?.id]);

	if (!room) {
		return (
			<div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
				Pick a room from the sidebar.
			</div>
		);
	}
	const activeRoom = room;
	// True when this DM's other party is a bot.  Bots can't join live
	// calls, so the voice bar is suppressed for bot DMs.
	const isBotDm = room.kind === "dm" && !!room.dmUserId && !!botMxids?.has(room.dmUserId);

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
		// Sending always clears the typing indicator immediately, no
		// reason to wait for the idle timer when the conversation
		// already has fresh content from this user.
		stopTypingNow();
		// Attachment send: each pending file posts as its OWN
		// m.room.message event in pick order.  No album grouping —
		// the user said "post them to the chat normally," so each
		// file is a standalone media event the room treats like any
		// other.  Reply-to attaches only to the FIRST event so a
		// thread reply still threads (the rest are loose siblings),
		// and any composer text is sent as a separate trailing text
		// message after every upload resolves so the timeline reads
		// thumbnails-then-comment.
		if (pendingAttachments.length > 0 && onSendAttachment) {
			const files = pendingAttachments;
			const replyToId = replyTarget?.id ?? null;
			const captionText = draft.trim();
			setUploading(true);
			void (async () => {
				try {
					for (let i = 0; i < files.length; i++) {
						const file = files[i]!;
						// Reply-to only on the first event — see above.
						await onSendAttachment(file, i === 0 ? replyToId : null, null);
					}
					if (captionText) {
						// Send the caption as a normal text message after
						// the media.  No reply-to on the caption since
						// reply-to is already carried by the first media
						// event; double-threading would be confusing.
						onSendMessage(captionText, null);
					}
					setPendingAttachments([]);
					setReplyTarget(null);
					setDraft("");
				} finally {
					setUploading(false);
				}
			})();
			return;
		}
		const text = draft.trim();
		if (!text) return;
		onSendMessage(text, replyTarget?.id ?? null);
		setDraft("");
		setReplyTarget(null);
	}

	function pickAttachments(files: File[]) {
		// Append (don't replace) so picking files in two separate
		// gestures stacks instead of overwriting.  Capped at
		// MAX_PENDING_ATTACHMENTS — the slice is silent when the
		// user picks more than the cap; the file picker doesn't have
		// a clean way to surface "you picked too many" mid-flow, so
		// we just take the first N and rely on the visible chip count
		// to communicate the cap.
		setPendingAttachments(prev => {
			const room = MAX_PENDING_ATTACHMENTS - prev.length;
			if (room <= 0) return prev;
			return [...prev, ...files.slice(0, room)];
		});
	}

	// Media picks from the Klipy picker (GIFs / clips / stickers)
	// bypass the preview/caption flow: users expect a one-click
	// "send" the way Discord does it, and a second confirm step
	// would feel like friction.  Caption support could come back if
	// anyone asks; reply-to is preserved since it was already
	// targeted before the picker opened.  MIME type on the File
	// drives the resulting Matrix msgtype (m.image for gif/webp,
	// m.video for mp4).
	async function sendMedia(file: File) {
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

	// Renders a single timeline row.
	//
	// We deliberately do NOT use `content-visibility: auto` here.
	// Matrix initial-sync brings ~30-200 events and pagination is
	// bounded, so all rows are laid out by default; the browser
	// handles native scroll without measurement loops.  An earlier
	// version DID set `content-visibility: auto` + a 120px intrinsic-
	// size placeholder for soft virtualization, but on macOS WKWebView
	// (Tauri desktop) that caused visible repaint ghosts mid-scroll —
	// the placeholder height differs from the actual row height, so
	// every freshly-revealed row briefly painted twice (estimate then
	// real).  Leaving rows always-laid-out trades a small upfront
	// layout cost for consistent, ghost-free scrolling.
	//
	// The outer wrapper carries `data-message-id` for both the
	// permalink scroll-to-event lookup (querySelector by message id)
	// and as a backstop for the document-level mousemove hover
	// hit-test (MessageRow sets it internally too, but a duplicate
	// on the wrapper is harmless).
	function renderTimelineRow(m: Message, index: number) {
		const prev = index > 0 ? messages[index - 1] : undefined;
		const sameGroup =
			!!prev &&
			prev.sender === m.sender &&
			m.timestamp - prev.timestamp <= GROUP_WINDOW_MS &&
			!m.replyTo;
		const separator = computeDateSeparator(prev?.timestamp, m.timestamp);
		return (
			<div
				key={m.id}
				data-index={index}
				data-message-id={m.id}
				className="-mx-4 px-4"
			>
				{separator && <DateSeparator label={separator} />}
				<MessageRow
					message={m}
					avatarMxc={memberAvatars.get(m.sender)}
					continuesGroup={sameGroup}
					isFirst={index === 0}
					flaggable={flaggable}
					roomEncrypted={!!activeRoom.encrypted}
					reactions={reactionsByMessage.get(m.id) ?? EMPTY_REACTIONS}
					flags={flagsByMessage.get(m.id)}
					isDm={activeRoom.kind === "dm"}
					isBotDm={isBotDm}
					receiptsVersion={receiptsVersion ?? 0}
					memberAvatars={memberAvatars}
					memberNames={memberNamesByUserId}
					mentionsViewer={
						!m.isSelf && !!viewerUserId && messageMentionsUser(m, viewerUserId)
					}
					onMentionClick={(userId) => onOpenProfile?.(userId)}
					onOpenSenderProfile={(userId) => onOpenProfile?.(userId)}
					botMxids={botMxids}
					serviceMxids={serviceMxids}
					pollAggregate={pollsByMessage?.get(m.id)}
					viewerUserId={viewerUserId}
					onPollVote={onVoteOnPoll}
					onPollEnd={onEndPoll}
					onReact={(emoji) => toggleReaction(m, emoji)}
					onReply={() => setReplyTarget(m)}
					roomId={activeRoom.id}
					onSendDmToSender={onSendDm
						? () => { void onSendDm(m.sender as UserId); }
						: undefined}
					onBlockSender={onBlockSender
						? () => { void onBlockSender(m.sender as UserId); }
						: undefined}
					onFlag={(category, rationale) => onFlag(m.id, category, rationale)}
					isBot={!!botMxids?.has(m.sender)}
					isOwnedBot={!!myOwnedBotMxids?.has(m.sender)}
					isFlashing={flashingEventId === m.id}
					onToggleReactionPill={(reaction) => {
						if (reaction.myReactionId) onUnreact(reaction);
						else onReact(m.id, reaction.key);
					}}
					onDelete={
						onDeleteMessage && (
							m.isSelf || !!myOwnedBotMxids?.has(m.sender)
						)
							&& !m.pending
							? () => onDeleteMessage(m.id)
							: undefined
					}
					onAdminRedact={
						onAdminRedactMessage
							&& canModerateRoom
							&& activeRoom.kind !== "dm"
							&& !m.isSelf
							&& !myOwnedBotMxids?.has(m.sender)
							&& !m.pending
								? () => onAdminRedactMessage(m.id)
								: undefined
					}
				/>
			</div>
		);
	}

	return (
		// `min-h-0` is load-bearing: without it, this flex column's
		// implicit min-height is the sum of its children's content
		// heights, which OVERRIDES the `flex-1 overflow-y-auto` on
		// the scroll container below.  Result: the scroll container
		// expands to fit ALL messages, leaving nothing to scroll.
		// The bug only shows on first paint — any window resize
		// triggers a layout recalc that gets it right, which is the
		// telltale "resize fixes it" symptom.  min-h-0 lets the flex
		// child shrink below content, so flex-1 + overflow-y-auto
		// constrain to the available height as intended.
		<div className="flex-1 flex flex-col min-w-0 min-h-0">
			<div className="shrink-0">
			{/* Suppress the chat-room header when the call view is on
			    top — the header relates to the room's chat (name,
			    settings, mod log, flag) and would just be a tease
			    while the user's looking at the call surface.  Same
			    visual rule as hiding the right sidebar in call
			    view: give the call as much real estate as possible. */}
			{!isInActiveCallRoom && (
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
							<span className="truncate">{room.name}</span>
							{room.kind === "dm" && room.dmUserId && botMxids?.has(room.dmUserId) && (
								<BotBadge />
							)}
						</span>
						{!isMobileShell && room.topic && (
							<span className="text-xs text-muted-foreground truncate max-w-[60ch]">{room.topic}</span>
						)}
					</div>
				</div>
				<div className={cn("flex items-center shrink-0", isMobileShell ? "gap-1" : "gap-2")}>
					{room.kind === "private" && !isMobileShell && (
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
							title="End-to-end encrypted. The engine can't read these messages, so reporting and the mod log are silent here."
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
					{/* The "On <homeserver>" federated-room badge is gone.
					    Koven instances no longer federate, so every
					    room is local by construction — see
					    docs/GOVERNANCE.md. */}
					{/* Old MatrixCall Phone + Video buttons removed.
					    DMs now use the same Live channel system as
					    rooms — see RoomVoiceBar below.  Calling a DM
					    sends a ring event the recipient picks up
					    via IncomingRingSheet. */}
					{/* Per-room invites removed by Discord-style invariant:
					    membership flows space → cascade → all rooms.  To
					    add someone, invite them to the parent space (the
					    space invite link / right-click menu).  Keeping
					    the prop wired so DM-startup gestures elsewhere
					    that reuse the InviteSheet still work. */}
					{!room.isInvite && (
						// Media gallery — DM-friendly + encrypted-friendly
						// (unlike mod log + flag, which need the engine
						// to see content).  Lightbox-fronted grid of
						// every image/video already loaded in the room.
						<button
							type="button"
							onClick={() => setGalleryOpen(true)}
							className={cn(
									isMobileShell ? "size-11 flex items-center justify-center" : "p-1",
									"rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
								)}
							title="Shared media"
							aria-label="Shared media"
						>
							<Images className={isMobileShell ? "h-5 w-5" : "h-4 w-4"} />
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
							className={cn(
									isMobileShell ? "size-11 flex items-center justify-center" : "p-1",
									"rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
								)}
							title="Public mod log"
							aria-label="Public mod log"
						>
							<Scale className={isMobileShell ? "h-5 w-5" : "h-4 w-4"} />
						</button>
					)}
					{onFlagRoom && room.kind !== "dm" && !room.isInvite && !room.encrypted && (
						// Report the room itself (its name + topic), not a
						// single message inside it.  Same gating as the
						// mod log icon — hidden in DMs and encrypted
						// rooms where the engine can't read content.
						<button
							type="button"
							onClick={() => setRoomFlagOpen(true)}
							className={cn(
									isMobileShell ? "size-11 flex items-center justify-center" : "p-1",
									"rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
								)}
							title="Report this room"
							aria-label="Report this room"
						>
							<Flag className={isMobileShell ? "h-5 w-5" : "h-4 w-4"} />
						</button>
					)}
					{room.kind !== "dm" && !room.isInvite && (room.myPowerLevel ?? 0) >= 50 && (
						<button
							type="button"
							onClick={() => onEditRoom(room.id as EventId)}
							className={cn(
									isMobileShell ? "size-11 flex items-center justify-center" : "p-1",
									"rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
								)}
							title="Room settings"
							aria-label="Room settings"
						>
							<Settings className={isMobileShell ? "h-5 w-5" : "h-4 w-4"} />
						</button>
					)}
				</div>
			</header>
			)}

			{/* Voice channel bar.  DMs use the same surface as group
			    rooms now — same Join button, same avatar stack —
			    with the difference that joining a DM call sends a
			    ring event the recipient picks up via
			    IncomingRingSheet.  The bar hides itself when the
			    engine reports M_NOT_CONFIGURED so instances
			    without RealtimeKit creds wired up don't see
			    broken UI.  Per-room `liveEnabled` lets admins
			    suppress it for non-DM rooms where voice would be
			    noise (#announcements, #report-a-bug); reader
			    defaults to true.  DMs ignore `liveEnabled` since
			    1:1 calls aren't a "channel" the user opts in/out of. */}
			{accessToken && !isBotDm && (room.kind === "dm" || room.liveEnabled !== false) && (
				<RoomVoiceBar
					roomId={room.id}
					roomName={room.name}
					accessToken={accessToken}
					isDm={room.kind === "dm"}
				/>
			)}
			</div>

			{isInActiveCallRoom ? (
				/* In-call view replaces the normal chat surface for
				   the call's room.  Renders pre-join (camera preview
				   + device pickers), the connecting spinner, or the
				   participant grid based on the CallProvider's phase
				   machine.  Audio + meeting state live at App level
				   so leaving the room mid-call doesn't drop the call. */
				<InCallPane roomName={room.name} />
			) : (<>
			<div className="relative flex-1 min-h-0 overflow-hidden">
			{/* Timeline.  A plain native scroll container relying on
			    one CSS trick: `flex-direction: column-reverse`
			    puts the FIRST child in DOM at the visual BOTTOM of
			    the container, and reverses the scroll-anchor
			    semantics so scrollTop=0 is the visual bottom
			    (newest message).  When a new message arrives we
			    render it as the first child (since
			    `reversedMessages` reverses the array) and the
			    browser's natural scroll-anchoring keeps the user
			    at the bottom if they were already there — no
			    imperative scrollTo on our side.  When older
			    messages prepend (pagination), they become the LAST
			    children visually at the top, ABOVE the user's
			    viewport — scrollTop unchanged. */}
			{messagesLoaded && messages.length > 0 ? (
				// ─── Unified column-reverse path (mobile + desktop) ───────
				// `flex-direction: column-reverse` puts the FIRST child in
				// DOM at the visual BOTTOM, and the browser's
				// `overflow-anchor: auto` keeps the user pinned to the
				// bottom when new messages prepend.  No imperative
				// scrollIntoView, no "stick to bottom" logic, no initial-
				// scroll trick — the browser does all three for free.
				//
				// Tradeoff: there have been reports of Chromium-family
				// wheel-event quirks at the scrollable extremes in
				// column-reverse containers.  If users on Windows
				// WebView2 hit one, branch this path back to a normal-
				// column variant for `__KOVEN_PLATFORM__ === "windows"`
				// specifically; macOS WKWebView, Linux WebKitGTK, and
				// iOS WKWebView all handle this layout cleanly.
				<div
					ref={scrollRef}
					className="absolute inset-0 overflow-y-auto overflow-x-hidden px-4 pb-3"
					style={{
						display: "flex",
						flexDirection: "column-reverse",
						WebkitOverflowScrolling: "touch",
						overflowAnchor: "auto",
						touchAction: "pan-y",
					}}
				>
					<div ref={bottomSentinelRef} aria-hidden style={{ height: 1, flexShrink: 0 }} />
					{reversedMessages.map((m, reversedIndex) => {
						const arrayIndex = messages.length - 1 - reversedIndex;
						return renderTimelineRow(m, arrayIndex);
					})}
					{loadingMore && (
						<div
							className="flex items-center justify-center py-4"
							aria-live="polite"
							aria-label="Loading older messages"
						>
							<img
								src="/favicon.png"
								alt=""
								className="size-8 animate-pulse"
								style={{ filter: "drop-shadow(0 0 16px rgba(0,0,0,0.4))" }}
							/>
						</div>
					)}
					{!loadingMore && atStartOfRoom && (
						<div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
							Beginning of {room.kind === "dm" ? "conversation" : `#${room.name}`}
						</div>
					)}
					<div ref={topSentinelRef} aria-hidden style={{ height: 1, flexShrink: 0 }} />
				</div>
			) : !messagesLoaded ? (
				// Initial timeline still landing — show the same pulsing
				// favicon throbber the pagination loader uses, sized up
				// and centred in the chat area.  Replaces the blank gap
				// users used to see while matrix-js-sdk delivered the
				// first batch, which made messages appear to "pop in
				// one by one" as they hydrated.  Cleared automatically
				// once the parent flips `messagesLoaded` true (see
				// App.tsx's loadedTimelines Set).
				<div
					className="absolute inset-0 flex items-center justify-center"
					aria-live="polite"
					aria-label="Loading messages"
				>
					<img
						src="/favicon.png"
						alt=""
						className="size-12 animate-pulse"
						style={{ filter: "drop-shadow(0 0 24px rgba(0,0,0,0.5))" }}
					/>
				</div>
			) : (
				isMobileShell ? (
					<div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
						<div className="size-16 rounded-2xl bg-foreground/[0.06] flex items-center justify-center">
							<MessageSquareIcon className="size-7 text-muted-foreground" strokeWidth={1.8} />
						</div>
						<div className="text-[17px] font-medium text-foreground">No messages yet</div>
						<p className="text-[15px] text-muted-foreground max-w-[260px] leading-snug">
							Say hi to start the conversation.
						</p>
					</div>
				) : (
					<div className="text-xs text-muted-foreground italic mt-8 text-center">No messages yet.</div>
				)
			)}
			{/* "Jump to newest" floating button — Discord / Slack
			    pattern.  Appears at the bottom-center of the chat
			    surface when Virtuoso reports the user is no longer
			    at the bottom.  Click → smooth-scroll to the last
			    item.  Hidden again as soon as atBottomStateChange
			    fires with `true`. */}
			{scrolledUp && (
				<button
					type="button"
					onClick={() => scrollToBottom("smooth")}
					className={cn(
						"absolute bottom-3 left-1/2 -translate-x-1/2",
						"flex items-center gap-1.5 px-3 py-1.5 rounded-full",
						"bg-card border border-border shadow-lg text-xs font-medium",
						"text-foreground hover:bg-accent transition-colors",
					)}
					aria-label="Jump to newest message"
					title="Jump to newest message"
				>
					<ArrowDown className="h-3.5 w-3.5" />
					Jump to newest
				</button>
			)}
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
			<div
				data-composer-wrapper
				className={cn(
					"border-t",
					isMobileShell
						// Mobile: translucent material that matches the
						// MobileTopBar / MobileTabBar so the composer
						// feels like part of the system chrome.  Extends
						// through env(safe-area-inset-bottom) so the
						// home-indicator strip blends in.
						? "bg-card/70 backdrop-blur-2xl backdrop-saturate-150 border-foreground/10 px-3 pt-2"
						: "border-border p-3",
				)}
				style={
					isMobileShell
						// Read from `--composer-pb` (defined in index.css).
						// Two signals collapse this to 0 while the soft
						// keyboard is up: (1) html.kb-open via Capacitor's
						// keyboardWillShow event (see nativeShell.ts), and
						// (2) :focus-within on this wrapper as a CSS-only
						// fallback for non-Capacitor mobile browsers and
						// cold-launch races.  Without the collapse there's
						// a ~34pt black band between the textarea and the
						// keyboard, because iOS's env(safe-area-inset-bottom)
						// keeps reporting the home-indicator inset even
						// when the keyboard covers it.
						? { paddingBottom: "var(--composer-pb)" }
						: undefined
				}
			>
				<TypingIndicator
					userIds={typingUserIds ?? []}
					members={members ?? null}
				/>
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
				{pendingAttachments.length > 0 && (
					<PendingAttachmentsRow
						files={pendingAttachments}
						uploading={uploading}
						onRemove={(idx) => setPendingAttachments(prev => prev.filter((_, i) => i !== idx))}
					/>
				)}
				<form
					onSubmit={e => { e.preventDefault(); send(); }}
					className="flex gap-2 items-end"
				>
					{/* Hidden file input — referenced by both desktop
					    inline button and the mobile "+" picker. */}
					{onSendAttachment && (
						<input
							ref={fileInputRef}
							type="file"
							multiple
							className="hidden"
							onChange={e => {
								setComposerMenuOpen(false);
								const list = e.target.files;
								if (list && list.length > 0) {
									pickAttachments(Array.from(list));
								}
								e.target.value = "";
							}}
							disabled={uploading}
						/>
					)}
					{isMobileShell ? (
						// iMessage-style attachments picker.  All
						// media/poll/GIF entries live behind a single
						// "+" button so the composer doesn't crowd the
						// row.  Tap → popover; choose → action fires,
						// popover dismisses.  The GIF sheet renders as a
						// sibling of the menu (not a child) so it outlives
						// the menu closing when its entry is tapped.
						<>
						<Popover open={composerMenuOpen} onOpenChange={setComposerMenuOpen}>
							<PopoverAnchor asChild>
								<button
									type="button"
									disabled={uploading}
									aria-label="Add attachment"
									aria-haspopup="dialog"
									aria-expanded={composerMenuOpen}
									onPointerDown={(e) => {
										e.preventDefault();
										composerMenuPointerHandledRef.current = true;
										toggleComposerMenu();
									}}
									onClick={(e) => {
										e.preventDefault();
										if (composerMenuPointerHandledRef.current) {
											composerMenuPointerHandledRef.current = false;
											return;
										}
										toggleComposerMenu();
									}}
									onKeyDown={(e) => {
										if (e.key !== "Enter" && e.key !== " ") return;
										e.preventDefault();
										toggleComposerMenu();
									}}
									className={cn(
										"shrink-0 size-9 rounded-full",
										"text-foreground bg-foreground/[0.08] active:bg-foreground/[0.16]",
										"flex items-center justify-center transition-colors",
										"disabled:opacity-40 disabled:cursor-not-allowed",
									)}
								>
									<Plus className="size-[20px]" strokeWidth={2.5} />
								</button>
							</PopoverAnchor>
							<PopoverContent
								side="top"
								align="start"
								onOpenAutoFocus={(e) => e.preventDefault()}
								onCloseAutoFocus={(e) => e.preventDefault()}
								className="w-56 p-1"
							>
								{onSendAttachment && (
									<button
										type="button"
										disabled={pendingAttachments.length >= MAX_PENDING_ATTACHMENTS}
										onClick={() => {
											void hapticImpact("light");
											fileInputRef.current?.click();
										}}
										className={cn(
											"w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-[15px]",
											"hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
										)}
									>
										<Paperclip className="size-[18px] text-muted-foreground" />
										<span>Photos &amp; Files</span>
									</button>
								)}
								{onCreatePoll && (
									<button
										type="button"
										disabled={pendingAttachments.length > 0}
										onClick={() => {
											setComposerMenuOpen(false);
											void hapticImpact("light");
											setPollDialogOpen(true);
										}}
										className={cn(
											"w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-[15px]",
											"hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
										)}
									>
										<BarChart3 className="size-[18px] text-muted-foreground" />
										<span>Poll</span>
									</button>
								)}
								{onSendAttachment && klipyEnabled && accessToken && (
									<button
										type="button"
										disabled={pendingAttachments.length > 0}
										onClick={() => {
											setComposerMenuOpen(false);
											void hapticImpact("light");
											setGifSheetOpen(true);
										}}
										className={cn(
											"w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-[15px]",
											"hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
										)}
									>
										<span className="inline-flex items-center justify-center size-[18px] text-[10px] font-bold tracking-wide text-muted-foreground border border-current rounded-sm">
											GIF
										</span>
										<span>GIF</span>
									</button>
								)}
							</PopoverContent>
						</Popover>
						{onSendAttachment && klipyEnabled && accessToken && (
							<MediaPicker
								accessToken={accessToken}
								open={gifSheetOpen}
								onOpenChange={setGifSheetOpen}
								onPick={sendMedia}
							/>
						)}
						</>
					) : (
						<>
							{onSendAttachment && (
								<button
									type="button"
									onClick={() => fileInputRef.current?.click()}
									disabled={uploading || pendingAttachments.length >= MAX_PENDING_ATTACHMENTS}
									className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
									title={
										pendingAttachments.length >= MAX_PENDING_ATTACHMENTS
											? `Up to ${MAX_PENDING_ATTACHMENTS} files per message`
											: "Attach files"
									}
									aria-label="Attach files"
								>
									<Paperclip className="h-4 w-4" />
								</button>
							)}
							{onCreatePoll && (
								<button
									type="button"
									onClick={() => setPollDialogOpen(true)}
									disabled={uploading || pendingAttachments.length > 0}
									className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
									title="Create a poll"
									aria-label="Create a poll"
								>
									<BarChart3 className="h-4 w-4" />
								</button>
							)}
							{onSendAttachment && klipyEnabled && accessToken && (
								<MediaPicker
									accessToken={accessToken}
									disabled={uploading || pendingAttachments.length > 0}
									onPick={sendMedia}
								>
									<button
										type="button"
										disabled={uploading || pendingAttachments.length > 0}
										className={cn(
											"h-8 px-2 rounded-md inline-flex items-center justify-center shrink-0",
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
								</MediaPicker>
							)}
						</>
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
								const next = e.target.value;
								setDraft(next);
								setCursor(e.target.selectionStart ?? next.length);
								// Typing-indicator throttle.  An empty
								// draft means the user cleared the
								// composer (backspaced everything out
								// or pasted then deleted), which is a
								// "stopped typing" signal even if the
								// idle timer hasn't fired yet.
								if (next.length === 0) {
									stopTypingNow();
								} else {
									noteTypingActivity();
								}
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
									if (!uploading) send();
								}
							}}
							placeholder={
								uploading
									? "Sending…"
									: pendingAttachments.length > 0
										? "Add a caption…"
										: replyTarget
											? `Reply to ${replyTarget.senderDisplayName}`
											: `Message ${room.name}`
							}
							// Disabled during upload so Enter doesn't double-submit
							// or queue another message while the previous one's
							// attachment is still being uploaded.
							disabled={uploading}
							// Desktop: focus on chat open so the user
							// can start typing immediately.  Mobile:
							// don't pop the iOS keyboard when entering
							// a chat — Discord / iMessage convention.
							// User taps the composer when ready to type.
							autoFocus={!isMobileShell}
							className={cn(
								"flex w-full transition-colors",
								"placeholder:text-muted-foreground",
								"disabled:cursor-not-allowed disabled:opacity-50",
								"resize-none overflow-y-auto",
								"leading-normal",
								// Cap the height so a 50-line paste doesn't eat
								// the chat.  Tracks Discord — about 12 rows.
								"max-h-[50vh]",
								isMobileShell
									// iOS-style pill: tinted fill, no border, generous padding.
									? "rounded-[18px] bg-foreground/[0.08] focus:bg-foreground/[0.12] border-0 px-4 py-2 text-[16px] min-h-9 outline-none ring-0 focus:outline-none focus:ring-0"
									// Desktop: shadcn Input-matched look with focus ring.
									: cn(
										"rounded-md border border-foreground/15 bg-transparent px-3 py-1.5 text-base shadow-sm",
										"hover:border-foreground/25",
										// Tone down the focus accent on dark themes — `--ring`
										// resolves to the bright theme primary, which next
										// to the muted bubble row felt over-saturated.  Plain
										// `ring-1` plus a 50%-alpha primary border is enough
										// affordance without lighting up the whole composer.
										"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring",
										"dark:focus-visible:ring-primary/40 dark:focus-visible:border-primary/40",
										"md:text-sm",
										"min-h-9",
									),
							)}
						/>
					</div>
					{/* Desktop: no send button — Enter submits the
					    form (same flow Discord / Telegram / iMessage
					    use).  Mobile: an iOS-style paper-arrow send
					    button surfaces when the draft has content or
					    attachments are pending.  Tap-to-send is the
					    primary affordance on touch; the placeholder
					    "Sending…" doubles as the in-flight state. */}
					{isMobileShell && (draft.trim().length > 0 || pendingAttachments.length > 0) && (
						<button
							type="submit"
							disabled={uploading}
							onClick={() => void hapticImpact("medium")}
							aria-label="Send"
							className={cn(
								"shrink-0 size-9 rounded-full",
								"bg-primary text-primary-foreground",
								"flex items-center justify-center",
								"active:opacity-80 transition-opacity",
								"disabled:opacity-50",
							)}
						>
							<ArrowUp className="size-5" strokeWidth={2.75} />
						</button>
					)}
				</form>
			</div>
			)}
			</>)}

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

// The actual MessageRow implementation.  Exported below as `MessageRow`
// after being wrapped in React.memo with `messageRowPropsEqual` — the
// wrap is what fixes the scroll-history jank on iOS.  Without it, every
// prepended pagination batch (or any parent-state change that rebuilds
// the `messages` array reference) re-renders EVERY MessageRow on
// screen.  On mobile that's the entire loaded timeline because the
// mobile path doesn't virtualize — see commit 7104465.  On iOS
// WKWebView, those re-renders happen mid-touch-momentum and break
// scrolling through history.
function MessageRowComponent({
	message, avatarMxc, continuesGroup, isFirst, flaggable, roomEncrypted,
	reactions, flags, onReact, onReply, onFlag, onToggleReactionPill, isBot,
	isOwnedBot, isFlashing, onDelete, onAdminRedact,
	isDm, isBotDm, receiptsVersion, memberAvatars, memberNames, mentionsViewer, onMentionClick, botMxids, serviceMxids,
	pollAggregate, viewerUserId, onPollVote, onPollEnd,
	roomId, onSendDmToSender, onBlockSender,
	onOpenSenderProfile,
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
	onToggleReactionPill(reaction: ReactionAggregate): void;
	// True while the permalink-scroll highlight pulse is active on
	// this specific row.  Drives a 2-second tinted background +
	// left-accent border so the user sees where they landed after
	// clicking a message link.
	isFlashing: boolean;
	// Trash button handler.  Provided only for rows the viewer is
	// allowed to delete (own message OR owned-bot message); the
	// gating logic lives in ChatPane.  When omitted, no trash icon.
	// Returns a promise so MessageActions's DeleteAction dialog can
	// await the real network call and show errors inline (403, 502,
	// network) without flickering closed first.
	onDelete?(): void | Promise<void>;
	// Admin redact handler.  Provided only for rows where the viewer
	// is a room admin (PL ≥ 50) AND the row isn't theirs / their own
	// bot's.  Calls into the parent's handler which performs the
	// Synapse redact + records the audit row.  Confirmation copy lives
	// inline (window.confirm) — the row doesn't get its own confirm
	// dialog because the action is targeted at someone else's
	// content and the operator is already an admin (no UI guardrail
	// beyond a single confirm).
	onAdminRedact?(): void | Promise<void>;
	// Drives the SeenIndicator on this row's bubble — DM gets a
	// "Read 2:41 PM" / nothing pair under the bubble; non-DM rooms
	// get a small avatar stack + count next to the bubble that
	// expands to a list modal on click.  isDm distinguishes the
	// two render styles; receiptsVersion forces a re-render when
	// matrix-js-sdk delivers a new Room.Receipt; memberAvatars +
	// memberNames feed the avatar stack.  Only meaningful on
	// `isSelf` rows; the indicator no-ops for others' messages.
	isDm: boolean;
	// True when this is a 1:1 DM whose other party is a registered bot.
	// Bots never emit read receipts, so the WhatsApp-style "delivered /
	// read" check on sent rows would sit stuck on the single grey check
	// forever and read as "the bot is ignoring you."  Used to suppress
	// the SeenIndicator entirely on these rows.
	isBotDm: boolean;
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
	// Bot mxids in the room.  Forwarded to SeenIndicator so bot read
	// receipts don't show up in the "seen by" stack — that count is
	// for real readers, not the engine's auto-syncing bot clients.
	botMxids?: Set<string>;
	// Service identities (engine appservice, Synapse admin user).
	// Filtered out of the seen-by stack alongside bots for the same
	// reason: they read everything because of how the platform is
	// architected, not because they're participating.
	serviceMxids?: Set<string>;
	// Live poll aggregate for this row, when message.kind === "poll".
	// Drives the bars + per-answer counts + viewer's selected answers.
	pollAggregate?: PollAggregate;
	// Viewer's user id — PollCard uses it to gate the creator-only
	// "End poll" affordance.
	viewerUserId?: UserId;
	// Cast / change a vote on this row's poll (when applicable).
	onPollVote?(pollId: EventId, answerIds: string[]): void | Promise<void>;
	onPollEnd?(pollId: EventId): void | Promise<void>;
	// Right-click context menu wiring.  roomId is needed to build
	// the matrix.to message link; the callbacks come from ChatPane,
	// which has the transport reference.
	roomId: string;
	onSendDmToSender?(): void;
	onBlockSender?(): void;
	// Click handler for the sender's avatar + display name in the
	// row header.  Opens the sender's profile sheet.  Wired from
	// ChatPane down to App.tsx's onOpenProfile so the same sheet
	// the mention pills + member list use is reused here.  Optional
	// because some embedding contexts (e.g. read-only previews) may
	// not want clickable identities.
	onOpenSenderProfile?(userId: UserId): void;
}) {
	const [flagDialogOpen, setFlagDialogOpen] = useState(false);
	// Right-click context menu state.  Cursor-positioned, dismissed
	// via the generic ContextMenu primitive's outside-mousedown handler.
	const [ctxMenuPos, setCtxMenuPos] = useState<{ x: number; y: number } | null>(null);
	// Touch gesture stack: long-press for context menu + horizontal
	// swipe-right to reply.  Driven by useDrag from @use-gesture/react
	// for unified pointer handling.  The previous hand-rolled
	// touchstart/touchmove version had no drag affordance: the row
	// didn't follow the finger, so the swipe felt invisible until
	// the haptic + commit fired and users thought it was broken.
	// Now the row visibly translates with the finger up to a soft
	// cap, rubber-bands past it, and snaps back on release.
	const rowRef = useRef<HTMLDivElement | null>(null);
	// Reply-arrow affordance revealed in the gap as the row swipes
	// right.  Counter-translated against the row so it stays pinned at
	// the screen's leading edge while the message slides away from it.
	const replyIconRef = useRef<HTMLDivElement | null>(null);
	const longPressTimerRef = useRef<number | null>(null);
	const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
	const swipeRepliedRef = useRef(false);
	const SWIPE_REPLY_THRESHOLD = 56;
	const SWIPE_SOFT_CAP = 96;
	const dragBind = useDrag(({ first, last, active, movement: [mx, my], xy, tap, cancel }) => {
		// Touches near the left edge belong to the PushSlot back-swipe.
		// Cancel immediately so use-gesture releases the pointer and the
		// parent slot can capture it.
		if (first && isMobileShell && xy[0] < 44) {
			cancel();
			return;
		}
		// Touchdown: arm the long-press timer at the press anchor.
		// 500ms threshold matches iOS Messages.
		if (first) {
			longPressStartRef.current = { x: xy[0], y: xy[1] };
			swipeRepliedRef.current = false;
			longPressTimerRef.current = window.setTimeout(() => {
				void hapticImpact("medium");
				const start = longPressStartRef.current;
				if (start) setCtxMenuPos(start);
				longPressTimerRef.current = null;
			}, 500);
		}
		// Any meaningful movement disqualifies the long-press.
		if (longPressTimerRef.current !== null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
			window.clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
		// Cleanup on release runs FIRST — and unconditionally.  Earlier
		// version short-circuited on `tap` before this block, which left
		// the long-press timer armed past the tap's release; the timer
		// then fired 500ms later and the context menu opened from what
		// the user had registered as a normal tap.
		if (last) {
			if (longPressTimerRef.current !== null) {
				window.clearTimeout(longPressTimerRef.current);
				longPressTimerRef.current = null;
			}
			longPressStartRef.current = null;
		}
		// Taps + no-ref: skip the drag visuals.  Tap is mutually
		// exclusive with a committed swipe (use-gesture only marks
		// `tap` when movement stayed below its tap threshold), so we
		// don't need to commit a reply here.
		if (tap || !rowRef.current) return;
		// Rightward drag only.  Vertical pan is left to the browser
		// via touch-action: pan-y on the row, so iOS scroll still
		// works naturally.  Soft cap at 96px with light rubber-banding
		// past it so the row visibly resists past the commit threshold
		// without hard-stopping (which feels broken on iOS).
		const dx = Math.max(0, mx);
		const tx = dx <= SWIPE_SOFT_CAP
			? dx
			: SWIPE_SOFT_CAP + (dx - SWIPE_SOFT_CAP) * 0.3;
		// Reply-arrow progress: 0 until the swipe starts, 1 once it has
		// reached the commit threshold (icon fully opaque + full size).
		const p = Math.min(1, dx / SWIPE_REPLY_THRESHOLD);
		const icon = replyIconRef.current;
		if (active) {
			rowRef.current.style.transform = `translateX(${tx}px)`;
			rowRef.current.style.transition = "none";
			if (icon) {
				icon.style.transition = "none";
				icon.style.opacity = String(p);
				// Counter-translate so the arrow holds its screen
				// position while the message slides out from over it.
				icon.style.transform = `translateX(${-tx}px) scale(${0.6 + 0.4 * p})`;
			}
		} else {
			rowRef.current.style.transform = "";
			rowRef.current.style.transition = "transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";
			if (icon) {
				icon.style.transition = "opacity 160ms ease, transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)";
				icon.style.opacity = "0";
				icon.style.transform = "translateX(0px) scale(0.6)";
			}
		}
		if (last && dx >= SWIPE_REPLY_THRESHOLD && !swipeRepliedRef.current) {
			swipeRepliedRef.current = true;
			void hapticImpact("light");
			onReply();
		}
	}, {
		pointer: { touch: true },
	});
	// Popover state stays local to the row — only relevant for THIS
	// row's React picker.  Exposed via `actionsLocked` below so the
	// toolbar stays visible after the cursor leaves the row to click
	// inside the popover.
	const [reactOpen, setReactOpen] = useState(false);
	// Same pattern for the delete-confirmation dialog: the trash
	// button lives inside the hover-revealed toolbar, but the dialog
	// itself MUST stay mounted while open even though the user's
	// cursor has moved off the message row to interact with it.
	// First attempt put the Dialog inside MessageActions, which
	// unmounted the moment the row un-hovered (making the dialog
	// "pop up then disappear after a second"); lifting the open
	// state to the row level + folding it into `actionsLocked` keeps
	// both the toolbar AND the dialog rendered until the user
	// commits or cancels.
	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
	// Admin-redact dialog state lives at the row level for the same
	// reason as deleteDialogOpen: the toolbar fades on hover-out, so
	// a confirmation Dialog mounted inside it would unmount the moment
	// the user moved their cursor off the row.  Lifting it here + into
	// `actionsLocked` keeps the toolbar AND the dialog visible until
	// the operator commits or cancels.
	const [adminRedactDialogOpen, setAdminRedactDialogOpen] = useState(false);
	// Hover toolbar is desktop-only — on touch, :hover sticks after
	// any tap and the toolbar floats permanently, looking broken.
	// Mobile users get the same actions via long-press (handled by
	// the touch handlers below) which opens MessageContextMenu.
	//
	// `actionsLocked` keeps the toolbar visible regardless of hover
	// when an inline dialog or popover is open.  Hover itself drives
	// visibility via a CSS rule keyed on `[data-row-hovered]` set on
	// this row's outer wrapper by the document-level mousemove
	// listener in ChatPane (no React state involved, so scrolling
	// over rows on desktop doesn't trigger re-renders).
	const actionsLocked = !isMobileShell && (reactOpen || deleteDialogOpen || adminRedactDialogOpen);
	const handleDelete = onDelete ? () => setDeleteDialogOpen(true) : undefined;
	const handleAdminRedact = onAdminRedact
		? () => setAdminRedactDialogOpen(true)
		: undefined;
	// You can't report your own messages.  Same gate applies to bots
	// the viewer owns: the owner controls the bot's prompt and config,
	// so reporting is the wrong remedy — they should just delete the
	// message.  The trash icon (provided by ChatPane via `onDelete` on
	// the same condition) takes its place on the toolbar.
	const canFlag = flaggable && !message.isSelf && !isOwnedBot;
	// Vertical-rhythm rules.  Symmetric vertical padding (`py-`) so
	// every row has equal breathing room above AND below — the
	// timeline reads as steady rhythm and the gutter doubles as the
	// landing zone for absolutely-positioned reaction pills.
	//
	// Row padding tuned for Discord-style "tight stack on same sender,
	// breathing space between groups."
	//
	//   - Continuation row pt: pt-0 (0px) — bubbles touch directly,
	//     same-sender stack reads as one continuous thread.
	//   - New-group row pt:    pt-4 (16px) — clear group separator.
	//   - pb when reactions present: pb-7 (28px) — landing zone for
	//     the absolutely-positioned reaction pills (pill height ~24px
	//     + 4px breathing room).  Without this the pills overlay the
	//     next row's bubble.
	//   - pb when no reactions:    pb-0.5 (2px) — minimal gap, lets
	//     same-sender stacks pack as tightly as possible.  Adding a
	//     reaction grows the row by ~26px which IS a real layout
	//     shift, but it matches what every other chat client (Slack,
	//     Discord, iMessage) does on reaction toggle and is what
	//     makes "no reactions" stacks feel natural.
	const hasReactions = reactions.length > 0;
	// Mobile: tighter rhythm.  The reaction pills now flow inside
	// the seen-row wrapper underneath the bubble (instead of being
	// absolutely positioned and needing a reserved `pb-7` landing
	// zone), so the row never needs the extra 26px of bottom gutter
	// for reactions.  New-group top is also pulled in from 16px →
	// 8px since mobile viewports waste vertical space fast.
	const rowPadding = isMobileShell
		? cn(continuesGroup ? "pt-0" : "pt-2", hasReactions ? "pb-2" : "pb-0.5")
		: cn(
			continuesGroup ? "pt-0" : "pt-4",
			hasReactions ? "pb-7" : "pb-0.5",
		);

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
	// Permalink-arrival pulse.  When the user clicks a /r/<room>/<event>
	// link, ChatPane scrolls this row into view and flips `isFlashing`
	// true for 2 seconds.  We render a brief tinted background +
	// left-accent border so the eye snaps to the destination.  Layered
	// independently of `mentionHighlight`: if a message both pings the
	// viewer AND is the permalink target, both highlights stack and
	// the accent border just gets brighter (primary on primary).
	const flashHighlight = isFlashing
		? "-mx-4 px-4 border-l-2 border-primary bg-primary/15 transition-colors duration-500"
		: "";

	// Emotes (`/me`) render as a single italic line with no bubble — same
	// shape as Matrix m.emote.  Avatar still gutters them so the layout
	// doesn't shift.
	if (message.kind === "emote") {
		return (
			<div
				data-message-id={message.id}
				data-actions-locked={actionsLocked ? "true" : undefined}
				className={cn("flex gap-3 items-start", rowPadding, mentionHighlight, flashHighlight)}
			>
				<AvatarSlot
				mxc={avatarMxc}
				seed={message.sender}
				hidden={continuesGroup}
				isBot={isBot}
				onClick={onOpenSenderProfile ? () => onOpenSenderProfile(message.sender as UserId) : undefined}
			/>
				<div className="flex-1 min-w-0 pt-1 text-sm italic text-muted-foreground flex items-center gap-2">
					<span>* <span className="text-foreground/80">{message.senderDisplayName}</span> {message.text}</span>
					{/* Always-mounted to avoid React commits on hover —
					    visibility is driven by the row's data-row-hovered
					    attribute via CSS (see .actions-slot rule in
					    index.css).  See the comment near the document-
					    level mousemove listener in ChatPane for why hover
					    state lives in the DOM, not React. */}
					{!isMobileShell && (
						<div className="actions-slot opacity-0 pointer-events-none">
							<MessageActions
								onReact={onReact}
								onReply={onReply}
								onFlagClick={() => setFlagDialogOpen(true)}
								showFlag={canFlag}
								onDelete={handleDelete}
								onAdminRedact={handleAdminRedact}
								reactOpen={reactOpen}
								onReactOpenChange={setReactOpen}
							/>
						</div>
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
				{onAdminRedact && (
					<AdminRedactDialog
						open={adminRedactDialogOpen}
						onOpenChange={setAdminRedactDialogOpen}
						onConfirm={onAdminRedact}
					/>
				)}
			</div>
		);
	}

	return (
		<div
			data-message-id={message.id}
			data-actions-locked={actionsLocked ? "true" : undefined}
			className={cn(
				"relative flex gap-3 items-start",
				rowPadding,
				mentionHighlight,
				flashHighlight,
				// On mobile, suppress native text-selection +
				// the iOS Copy / Look Up / Translate callout so
				// our long-press handler can fire cleanly with
				// haptic feedback.  Without this, WebKit intercepts
				// the press, selects the word, and pops its native
				// menu before the JS timer fires — user gets the
				// native menu instead of our context menu.  Desktop
				// keeps selection enabled (cursor / copy via Cmd-C
				// is the standard expectation there).
				isMobileShell && "select-none [-webkit-user-select:none] [-webkit-touch-callout:none] touch-pan-y",
			)}
			onContextMenu={(e) => {
				// Suppress when right-clicking inside an interactive
				// element that has its own context menu (media, links).
				// Those handlers stopPropagation, so this only fires
				// for clicks on the bubble's "empty" area / text.
				e.preventDefault();
				e.stopPropagation();
				setCtxMenuPos({ x: e.clientX, y: e.clientY });
			}}
			ref={rowRef}
			{...dragBind()}
		>
			{isMobileShell && (
				<div
					ref={replyIconRef}
					aria-hidden
					className="absolute left-1 inset-y-0 flex items-center pointer-events-none"
					style={{ opacity: 0 }}
				>
					<div className="flex items-center justify-center size-9 rounded-full bg-foreground/10">
						<Reply className="size-[18px] text-primary" strokeWidth={2.5} />
					</div>
				</div>
			)}
			<AvatarSlot
				mxc={avatarMxc}
				seed={message.sender}
				hidden={continuesGroup}
				isBot={isBot}
				onClick={onOpenSenderProfile ? () => onOpenSenderProfile(message.sender as UserId) : undefined}
			/>
			<div className="flex-1 min-w-0">
				{!continuesGroup && (
					<div className={cn(
						"text-xs font-medium mb-1.5 flex items-baseline gap-1.5",
						message.isSelf ? "text-primary" : "text-foreground"
					)}>
						{onOpenSenderProfile ? (
							<button
								type="button"
								onClick={() => onOpenSenderProfile(message.sender as UserId)}
								className="hover:underline focus:outline-none focus-visible:underline cursor-pointer"
								aria-label={`View ${message.senderDisplayName}'s profile`}
							>
								{message.senderDisplayName}
							</button>
						) : (
							<span>{message.senderDisplayName}</span>
						)}
						{isBot && <BotBadge />}
						{(() => {
							// Founder badge inline next to the name —
							// only renders when the sender is in the
							// cached roster (the first 666 signups).
							// Bots can't be founders, so we skip the
							// lookup when isBot is true.
							if (isBot) return null;
							const fn = getCachedFounderNumber(message.sender);
							return fn !== null ? <FounderBadge number={fn} /> : null;
						})()}
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
				{/* Bubble + sidecar.  Reactions are NOT in this row's
				    flow — they're position:absolute below the bubble
				    so adding/removing them never changes the row's
				    height.  The row gets generous symmetric vertical
				    padding (see rowPadding above) which doubles as
				    the visual gutter where reactions land; even with
				    one row of pills, reactions render INSIDE that
				    gutter rather than pushing the next message down. */}
				<div className="relative flex items-start gap-2">
					{/* Bubble column.  `relative` + `w-fit` so the absolute
					    reaction-pills child anchors to the bubble's
					    bottom-left corner specifically, not the row's
					    bottom-left (which would be pulled down by the
					    right column's reserved-toolbar height + seen-by
					    line and produce the "pills hang 18px below the
					    bubble" symptom).  `w-fit` ensures the column's
					    width = the bubble's actual rendered width, so
					    pills sit flush under the bubble even on short
					    messages where flex would otherwise stretch the
					    column wider. */}
					<div className="relative w-fit flex flex-col min-w-0">
						<MessageBubble
							message={message}
							memberNames={memberNames}
							memberAvatars={memberAvatars}
							onMentionClick={onMentionClick}
							pollAggregate={pollAggregate}
							viewerUserId={viewerUserId}
							onPollVote={onPollVote}
							onPollEnd={onPollEnd}
							isBot={isBot}
						/>
						{message.kind === "text" && !roomEncrypted && (
							// Link preview rides under the bubble for plain text
							// messages only.  Skipped on attachments / emotes
							// to keep those layouts clean.  Also skipped in
							// encrypted rooms — see roomEncrypted prop above.
							<UrlPreviewSlot text={message.text} />
						)}
						{/* Desktop: reactions float absolute beneath the
						    bubble at the left edge.  Mobile: rendered
						    inside the seen-row wrapper below so they
						    sit in line with the seen-by avatars. */}
						{reactions.length > 0 && !isMobileShell && (
							<div className="absolute left-0 top-full">
								<ReactionPills reactions={reactions} onToggle={onToggleReactionPill} />
							</div>
						)}
						{/* Right column LIVES INSIDE the bubble column on
						    purpose — its absolute positioning needs to
						    anchor to the bubble's right edge, and the
						    bubble column is `w-fit` (exactly the bubble
						    width).  Putting it as a sibling of the
						    bubble column would anchor `left-full` to
						    the row's full width — which on a wide
						    chat lands the toolbar way past the right
						    sidebar.  Inside the bubble column,
						    `left-full` is the bubble's right edge.
						    Reservation rationale: the reserved
						    toolbar slot (~32px) + SeenIndicator
						    (~14px) used to pull every row to ~50px
						    when in row flow, leaving an 18px gap
						    below every bubble.  Now the bubble alone
						    defines row height. */}
						<div
							className={cn(
								"flex flex-row items-center gap-2",
								// Desktop: anchor next to the bubble's
								// right edge — shrink-0 + whitespace-
								// nowrap keep the toolbar + seen-by
								// indicator on a single line beside
								// the bubble.
								// Mobile: flow underneath the bubble.
								// Reactions + seen-by share this row;
								// flex-wrap so a long reaction strip
								// wraps gracefully instead of pushing
								// the seen avatars off-screen.
								// Self → right-aligned to match the
								// sent bubble's right edge; non-self →
								// left-aligned under the received
								// bubble.
								isMobileShell
									// Always left-aligned beneath the
									// bubble to match Koven's left-
									// aligned bubble column.
									? "mt-0.5 flex-wrap justify-start"
									: "absolute top-0 left-full ml-2 shrink-0 whitespace-nowrap",
							)}
						>
						{/* Mobile: reactions in line with seen-by.
						    Limited to the most-recent 4 (slice from
						    the tail) so the row stays inside the
						    bubble's width on phone-sized viewports. */}
						{isMobileShell && reactions.length > 0 && (
							<ReactionPills
								reactions={reactions.slice(-4)}
								onToggle={onToggleReactionPill}
							/>
						)}
						{/* Seen-by indicator on YOUR sent messages.
						    DM checks rendered separately on mobile
						    (as a bubble sibling, to the right).
						    Group receipts: desktop only. */}
						{message.isSelf && !message.pending && !isBotDm && !isMobileShell && (
							<SeenIndicator
								roomId={message.roomId}
								eventId={message.id}
								isDm={isDm}
								receiptsVersion={receiptsVersion}
								memberAvatars={memberAvatars}
								memberNames={memberNames}
								botMxids={botMxids}
								serviceMxids={serviceMxids}
							/>
						)}
						{/* Action toolbar slot.  Always mounted (even when
						    not hovered) so the row's height stays
						    constant and React never re-renders the row
						    on hover.  Visibility is driven by the row's
						    `data-row-hovered` attribute (set by the
						    document-level mousemove listener in
						    ChatPane) plus `data-actions-locked` (set by
						    actionsLocked above) via the .actions-slot
						    CSS rule in index.css.  Default state is
						    opacity-0 + pointer-events-none so the
						    invisible toolbar can't intercept clicks.
						    h-8 matches MessageActions' button row
						    height (h-7 + padding) so the reserved
						    gutter between bubbles stays consistent
						    whether the toolbar is visible or not.
						    Mobile gets the actions via long-press
						    menu instead — the slot would bloat every
						    mobile row by 32px so we skip it. */}
						{!isMobileShell && (
							<div className="actions-slot min-h-8 flex items-start opacity-0 pointer-events-none">
								<MessageActions
									onReact={onReact}
									onReply={onReply}
									onFlagClick={() => setFlagDialogOpen(true)}
									showFlag={canFlag}
									onDelete={handleDelete}
									onAdminRedact={handleAdminRedact}
									reactOpen={reactOpen}
									onReactOpenChange={setReactOpen}
									className="shrink-0"
								/>
							</div>
						)}
					</div>
				</div>
				{isMobileShell && isDm && message.isSelf && !message.pending && !isBotDm && (
					<div className="self-end pb-1">
						<SeenIndicator
							roomId={message.roomId}
							eventId={message.id}
							isDm={isDm}
							receiptsVersion={receiptsVersion}
							memberAvatars={memberAvatars}
							memberNames={memberNames}
							botMxids={botMxids}
							serviceMxids={serviceMxids}
						/>
					</div>
				)}
			</div>
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
			{onAdminRedact && (
				<AdminRedactDialog
					open={adminRedactDialogOpen}
					onOpenChange={setAdminRedactDialogOpen}
					onConfirm={onAdminRedact}
				/>
			)}
			{ctxMenuPos && (
				<MessageContextMenu
					x={ctxMenuPos.x}
					y={ctxMenuPos.y}
					message={message}
					roomId={roomId}
					isSelf={!!message.isSelf}
					flaggable={canFlag}
					onReply={onReply}
					onReact={() => setReactOpen(true)}
					onCopyText={() => {
						const t = message.text ?? "";
						if (t) void navigator.clipboard.writeText(t);
					}}
					// Suppress "Copy message link" inside DMs.  A DM
					// permalink necessarily identifies both parties to
					// anyone it's pasted in front of — and unlike room
					// permalinks (where the room is the context), there's
					// no meaningful "click to navigate to that
					// conversation" UX for non-participants either, since
					// they can't see the DM at all.  Easier to just not
					// offer the link.
					onCopyLink={isDm ? undefined : () => {
						void navigator.clipboard.writeText(buildMessageUrl(roomId, message.id));
					}}
					onDelete={onDelete && !message.pending ? () => setDeleteDialogOpen(true) : undefined}
					onFlag={canFlag ? () => setFlagDialogOpen(true) : undefined}
					// "Send DM to sender" is meaningless inside a DM —
					// you ARE the DM with them.  Suppress so the menu
					// doesn't suggest opening another conversation
					// when this one already exists.
					onSendDmToSender={isDm ? undefined : onSendDmToSender}
					onBlockSender={onBlockSender}
					onClose={() => setCtxMenuPos(null)}
				/>
			)}
			{/* Mobile-only React picker.  Desktop anchors the picker to
			    the SmilePlus button inside MessageActions, which is hover-
			    gated and never mounts on mobile.  The proper mobile shape
			    is a bottom sheet: full-width, slides up, swipe-down or
			    tap-backdrop to dismiss.  Picker fills the sheet. */}
			{isMobileShell && (
				<MobileReactionSheet
					open={reactOpen}
					onClose={() => setReactOpen(false)}
					onPick={(emoji) => {
						onReact(emoji);
						setReactOpen(false);
					}}
				/>
			)}
		</div>
	);
}

const MessageRow = memo(MessageRowComponent, messageRowPropsEqual);

// Custom equality check for MessageRow.  Compares only the props that
// actually drive what's rendered; intentionally IGNORES the identity of
// the callback props because `renderTimelineRow` in ChatPane creates
// fresh inline arrows on every parent render (they close over the
// per-row `m`).  Comparing those by identity would invalidate every
// row on every parent re-render and defeat the memo entirely.
//
// The callbacks' captured `m` is contained in `message`, which we DO
// compare by reference.  As long as `message` is reference-equal, the
// stale closure does exactly what a fresh one would have done — the
// transport/handler functions they delegate to (onOpenProfile,
// onSendDm, etc.) are stable across the chat session.
//
// For optional callbacks, only PRESENCE matters here, because that's
// what gates the conditional UI inside the row (trash icon, redact
// icon, "DM" / "Block" context-menu items).
function messageRowPropsEqual(
	prev: Parameters<typeof MessageRowComponent>[0],
	next: Parameters<typeof MessageRowComponent>[0],
): boolean {
	// Data props: any change re-renders.
	if (prev.message !== next.message) return false;
	if (prev.avatarMxc !== next.avatarMxc) return false;
	if (prev.continuesGroup !== next.continuesGroup) return false;
	if (prev.isFirst !== next.isFirst) return false;
	if (prev.flaggable !== next.flaggable) return false;
	if (prev.roomEncrypted !== next.roomEncrypted) return false;
	if (prev.flags !== next.flags) return false;
	if (prev.isBot !== next.isBot) return false;
	if (prev.isOwnedBot !== next.isOwnedBot) return false;
	if (prev.isFlashing !== next.isFlashing) return false;
	if (prev.isDm !== next.isDm) return false;
	if (prev.isBotDm !== next.isBotDm) return false;
	if (prev.receiptsVersion !== next.receiptsVersion) return false;
	if (prev.memberAvatars !== next.memberAvatars) return false;
	if (prev.memberNames !== next.memberNames) return false;
	if (prev.mentionsViewer !== next.mentionsViewer) return false;
	if (prev.botMxids !== next.botMxids) return false;
	if (prev.serviceMxids !== next.serviceMxids) return false;
	if (prev.pollAggregate !== next.pollAggregate) return false;
	if (prev.viewerUserId !== next.viewerUserId) return false;
	if (prev.roomId !== next.roomId) return false;
	// `reactions` empty-case is reference-stable (EMPTY_REACTIONS), but
	// the non-empty path can still receive a freshly-built array from
	// the parent.  Length + per-element identity captures the cases
	// that matter (add/remove/swap an aggregate) without a deep walk.
	if (prev.reactions.length !== next.reactions.length) return false;
	for (let i = 0; i < prev.reactions.length; i++) {
		if (prev.reactions[i] !== next.reactions[i]) return false;
	}
	// Optional callbacks: presence matters, identity does not.
	if (!!prev.onDelete !== !!next.onDelete) return false;
	if (!!prev.onAdminRedact !== !!next.onAdminRedact) return false;
	if (!!prev.onSendDmToSender !== !!next.onSendDmToSender) return false;
	if (!!prev.onBlockSender !== !!next.onBlockSender) return false;
	if (!!prev.onOpenSenderProfile !== !!next.onOpenSenderProfile) return false;
	if (!!prev.onPollVote !== !!next.onPollVote) return false;
	if (!!prev.onPollEnd !== !!next.onPollEnd) return false;
	return true;
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

function AvatarSlot({ mxc, seed, hidden, isBot, onClick }: {
	mxc?: string;
	seed: string;
	hidden: boolean;
	isBot: boolean;
	// Click handler — opens the sender's profile sheet.  Optional;
	// when omitted, the avatar renders as a non-interactive image
	// (preserves backward-compat for any caller that doesn't have a
	// profile-open callback to pass).
	onClick?(): void;
}) {
	// Reserve the avatar gutter even when collapsed so subsequent
	// messages line up under the avatar above.  Saves a layout shift
	// and gives a clean indented column for grouped runs.
	if (hidden) return <div className="w-8 shrink-0" />;
	const avatar = (
		<MatrixAvatar
			mxc={mxc}
			seed={seed}
			kind={isBot ? "bot" : "user"}
			className="h-8 w-8 mt-0.5"
		/>
	);
	if (!onClick) return avatar;
	return (
		<button
			type="button"
			onClick={onClick}
			className="shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary hover:opacity-90 transition-opacity"
			aria-label="View profile"
		>
			{avatar}
		</button>
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
	isBot,
	memberAvatars,
}: {
	message: Message;
	memberNames: Map<string, string>;
	onMentionClick(userId: string): void;
	pollAggregate?: PollAggregate;
	viewerUserId?: UserId;
	onPollVote?(pollId: EventId, answerIds: string[]): void | Promise<void>;
	onPollEnd?(pollId: EventId): void | Promise<void>;
	memberAvatars: Map<string, string | undefined>;
	// Bots stream their replies as a sequence of m.replace edits so the
	// LLM's tokens land in real-time, which means the resulting message
	// always carries `edited: true` once the stream completes.  The
	// "(edited)" badge in that case is noise: it reads as "the bot
	// went back and changed its message" when nothing of the sort
	// happened.  Suppress the badge entirely when the sender is a bot.
	isBot: boolean;
}) {
	// Effective edited state for badge rendering: bots are always
	// "not edited" from the user's perspective even when the SDK
	// reports `edited: true` thanks to streaming-token replaces.
	const showEdited = message.edited && !isBot;
	if (message.kind === "poll" && message.poll) {
		return (
			<PollCard
				message={message}
				aggregate={pollAggregate}
				viewerUserId={viewerUserId}
				onVote={(answerIds) => onPollVote?.(message.id, answerIds)}
				onEnd={() => onPollEnd?.(message.id)}
				memberAvatars={memberAvatars}
				memberNames={memberNames}
			/>
		);
	}
	// `whitespace-pre-wrap` only applied to the plain-text path —
	// markdown paragraphs/lists handle their own whitespace, and
	// keeping pre-wrap on top of them would re-introduce the literal
	// blank lines between blocks.
	// On mobile cap against the viewport directly (vw) so the bubble
	// can't out-grow the screen — the desktop `60ch` cap is character-
	// based and doesn't constrain on phones (and `%` resolves against
	// the bubble's `w-fit` parent which is itself content-sized).
	const baseBubble = cn(
		"inline-block px-3 py-2 rounded-2xl text-[15px] leading-snug break-words",
		isMobileShell ? "max-w-[72vw]" : "max-w-[60ch] text-sm rounded-xl",
	);
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
				isMobileShell ? "max-w-[78%]" : "max-w-[60ch]",
			)}>
				<div className={cn(sizeClass, "leading-none break-words")}>
					{message.text}
				</div>
				{showEdited && (
					<span className="text-[10px] text-muted-foreground">(edited)</span>
				)}
			</div>
		);
	}

	// YouTube embeds.  Rule: only the FIRST URL in the body gets to
	// be the message's embed slot, and YouTube competes for it
	// against the OG preview card (UrlPreviewSlot) — only one embed
	// per message, period.  If the first URL is a YouTube link we
	// render its player and strip the URL from the body; if it's
	// anything else we don't embed any YouTube even if a later URL
	// is one (UrlPreviewSlot handles the first URL instead).
	// Markdown messages skip this — markdown owns its own link
	// rendering and the embed/markdown interaction isn't worth the
	// complexity for v1.
	const isMarkdown = looksLikeMarkdown(message.text);
	const firstUrl = isMarkdown ? null : firstLink(message.text);
	const firstUrlIsYouTube = !!firstUrl && isYouTubeUrl(firstUrl);
	const youtubeMatches = firstUrlIsYouTube
		? findYouTubeMatches(message.text)  // capped at 1 by MAX_INLINE_EMBEDS
		: [];
	const strippedText = youtubeMatches.length > 0
		? stripYouTubeUrls(message.text, youtubeMatches)
		: message.text;
	const hasBubbleContent = strippedText.length > 0;
	const editedBadge = showEdited ? (
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
			{!hasBubbleContent && !isMarkdown && showEdited && (
				// All-YouTube body with no surviving text still wants
				// the (edited) badge somewhere, tuck it under the
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

/**
 * Right-click handlers for an in-timeline media element.  Returns the
 * onContextMenu prop to attach to the rendered media node and a
 * `menu` ReactNode the parent splices in alongside the media — when
 * the user has right-clicked, `menu` resolves to the MediaContextMenu
 * portalled onto document.body; otherwise it's null.
 *
 * Disabled when there's no resolved URL yet (initial load
 * placeholders) — without a URL there's nothing to download or copy.
 */
function useMediaContextMenu(url: string | null | undefined, filename: string) {
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	const onContextMenu = (e: React.MouseEvent) => {
		if (!url) return;
		e.preventDefault();
		e.stopPropagation();
		setPos({ x: e.clientX, y: e.clientY });
	};
	const menu = pos && url ? (
		<MediaContextMenu
			x={pos.x}
			y={pos.y}
			url={url}
			filename={filename}
			onClose={() => setPos(null)}
		/>
	) : null;
	return { onContextMenu, menu };
}

function AttachmentImage({ message }: { message: Message }) {
	const url = useMatrixAttachment(message);
	const { onContextMenu, menu } = useMediaContextMenu(url, message.mediaName ?? "attachment");
	// Reserve the exact final box from the sender-supplied dimensions
	// in `info.w` / `info.h` (carried on the Message as
	// `mediaWidth` / `mediaHeight`).  Without this, the <img> starts
	// at 0×0 pre-load and expands to its natural size when the bytes
	// arrive — which on a Virtuoso list triggers a re-measure on the
	// row, shifting every neighbouring row up or down by the delta.
	// During a fast scroll past several media messages, those
	// re-measures compound into the layout thrashing visible in the
	// "glitchychat" recording.  Browsers honour `width` + `height`
	// attributes on <img> as an aspect-ratio AND a layout reservation:
	// the box paints at the correct size from first commit, the image
	// data fills in inside it without changing layout.
	//
	// Visual bounds match the previous `max-w-md max-h-80` (Tailwind
	// = 448 / 320 px).  Senders that omit dimensions (legacy clients,
	// bridge bots) fall back to the skeleton's footprint — strictly
	// no-worse than the previous behaviour.
	const { displayWidth, displayHeight } = useMemo(() => {
		const naturalW = message.mediaWidth ?? 0;
		const naturalH = message.mediaHeight ?? 0;
		if (!naturalW || !naturalH) return { displayWidth: 256, displayHeight: 160 };
		const MAX_W = 448, MAX_H = 320;
		const aspect = naturalW / naturalH;
		let w = Math.min(naturalW, MAX_W);
		let h = w / aspect;
		if (h > MAX_H) {
			h = MAX_H;
			w = h * aspect;
		}
		return { displayWidth: Math.round(w), displayHeight: Math.round(h) };
	}, [message.mediaWidth, message.mediaHeight]);
	if (!url) {
		return (
			<div
				className="rounded-lg bg-muted-foreground/10 animate-pulse"
				style={{ width: displayWidth, height: displayHeight, maxWidth: "100%", aspectRatio: `${displayWidth}/${displayHeight}` }}
			/>
		);
	}
	return (
		<>
			<img
				src={url}
				alt={message.mediaName ?? "attachment"}
				width={displayWidth}
				height={displayHeight}
				className={cn("rounded-lg block", isMobileShell && "pointer-events-none")}
				style={{ maxWidth: "100%", height: "auto", aspectRatio: `${displayWidth}/${displayHeight}` }}
				onContextMenu={isMobileShell ? undefined : onContextMenu}
			/>
			{menu}
		</>
	);
}

function formatVideoTime(seconds: number): string {
	const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
	const m = Math.floor(safe / 60);
	const s = safe % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

// Fully custom video player surface: glass play button, a draggable
// scrubber, a time readout, and an expand/collapse control.  Native
// `<video controls>` is deliberately not used: in the iOS WKWebView
// shell its fullscreen and picture-in-picture buttons are dead, so we
// own the whole control layer and route "expand" to an in-app lightbox
// instead of the platform fullscreen path.
function VideoPlayer({
	url,
	poster,
	videoRef,
	mediaStyle,
	displayWidth,
	displayHeight,
	autoPlay,
	initialTime,
	expanded,
	onExpand,
	onCollapse,
}: {
	url: string;
	poster?: string;
	videoRef: React.MutableRefObject<HTMLVideoElement | null>;
	mediaStyle: React.CSSProperties;
	displayWidth: number;
	displayHeight: number;
	autoPlay?: boolean;
	initialTime?: number;
	expanded?: boolean;
	onExpand?: () => void;
	onCollapse?: () => void;
}) {
	const [playing, setPlaying] = useState(false);
	const [started, setStarted] = useState(false);
	const [hovered, setHovered] = useState(false);
	const [scrubbing, setScrubbing] = useState(false);
	const [currentTime, setCurrentTime] = useState(initialTime ?? 0);
	const [duration, setDuration] = useState(0);
	const trackRef = useRef<HTMLDivElement | null>(null);

	function togglePlay() {
		const v = videoRef.current;
		if (!v) return;
		if (v.paused) {
			v.play().catch(() => { /* play() can reject under autoplay policy, harmless */ });
		} else {
			v.pause();
		}
	}

	// Map a pointer x-coordinate onto the track's width and seek there.
	function seekToClientX(clientX: number) {
		const v = videoRef.current;
		const track = trackRef.current;
		if (!v || !track || !Number.isFinite(v.duration) || v.duration <= 0) return;
		const rect = track.getBoundingClientRect();
		const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		const t = frac * v.duration;
		v.currentTime = t;
		setCurrentTime(t);
	}

	function onScrubPointerDown(e: React.PointerEvent) {
		e.preventDefault();
		e.stopPropagation();
		setScrubbing(true);
		e.currentTarget.setPointerCapture(e.pointerId);
		seekToClientX(e.clientX);
	}
	function onScrubPointerMove(e: React.PointerEvent) {
		if (!scrubbing) return;
		seekToClientX(e.clientX);
	}
	function onScrubPointerUp(e: React.PointerEvent) {
		if (!scrubbing) return;
		setScrubbing(false);
		if (e.currentTarget.hasPointerCapture(e.pointerId)) {
			e.currentTarget.releasePointerCapture(e.pointerId);
		}
	}

	const pct = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
	// Bottom bar is always shown in the lightbox.  Inline it appears
	// once playback has started: on touch (no hover) it stays put, on
	// desktop it follows hover, and it is always shown while paused or
	// mid-scrub so the user can grab the scrubber.
	const showBar = expanded || (started && (isMobileShell || hovered || !playing || scrubbing));

	return (
		<div
			className="relative inline-block group/video"
			style={{ maxWidth: "100%" }}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			<video
				ref={videoRef}
				src={url}
				poster={poster}
				preload="metadata"
				width={displayWidth}
				height={displayHeight}
				className="rounded-lg block cursor-pointer"
				style={mediaStyle}
				autoPlay={autoPlay}
				onClick={togglePlay}
				onPlay={() => { setPlaying(true); setStarted(true); }}
				onPause={() => setPlaying(false)}
				onEnded={() => setPlaying(false)}
				onTimeUpdate={(e) => { if (!scrubbing) setCurrentTime(e.currentTarget.currentTime); }}
				onLoadedMetadata={(e) => {
					setDuration(e.currentTarget.duration);
					// Resume from where the inline player left off when
					// opening (or vice versa when collapsing).
					if (initialTime && initialTime > 0) {
						e.currentTarget.currentTime = initialTime;
						setCurrentTime(initialTime);
					}
				}}
				playsInline
			/>
			{!playing && (
				<button
					type="button"
					onClick={togglePlay}
					aria-label="Play video"
					// Glassmorphic centred play button for the paused
					// state.  `pointer-events-none` on the outer span +
					// an explicit pointer-events-auto on the inner
					// circle so only the circle is clickable; otherwise
					// the button would intercept clicks on the rest of
					// the video and the scrubber underneath it.
					className="absolute inset-0 flex items-center justify-center pointer-events-none"
				>
					<span
						className={cn(
							"pointer-events-auto h-14 w-14 rounded-full flex items-center justify-center",
							"bg-background/30 backdrop-blur-md ring-1 ring-white/20",
							"shadow-[0_2px_12px_rgba(0,0,0,0.35)]",
							"transition-all duration-150",
							"group-hover/video:bg-background/45 group-hover/video:scale-105",
						)}
					>
						<Play className="h-6 w-6 text-white fill-white translate-x-0.5" />
					</span>
				</button>
			)}
			{showBar && (
				<div
					// Custom control bar.  stopPropagation so taps on the
					// bar do not bubble to the video's click-to-toggle.
					className="absolute inset-x-0 bottom-0 flex items-center gap-2.5 rounded-b-lg px-2.5 pb-2 pt-6 bg-gradient-to-t from-black/75 via-black/35 to-transparent"
					onClick={(e) => e.stopPropagation()}
				>
					<button
						type="button"
						onClick={togglePlay}
						aria-label={playing ? "Pause video" : "Play video"}
						className="shrink-0 text-white/90 hover:text-white transition-colors"
					>
						{playing
							? <Pause className="h-4 w-4 fill-white" />
							: <Play className="h-4 w-4 fill-white translate-x-px" />}
					</button>
					<div
						// Padded hit area so the thin track is easy to
						// grab on touch; the visible track sits inside.
						className="relative flex-1 py-2 cursor-pointer touch-none"
						onPointerDown={onScrubPointerDown}
						onPointerMove={onScrubPointerMove}
						onPointerUp={onScrubPointerUp}
						onPointerCancel={onScrubPointerUp}
					>
						<div ref={trackRef} className="relative h-1 w-full rounded-full bg-white/25">
							<div className="absolute inset-y-0 left-0 rounded-full bg-white" style={{ width: `${pct}%` }} />
							<div
								className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.5)]"
								style={{ left: `${pct}%` }}
							/>
						</div>
					</div>
					<span className="shrink-0 text-[11px] tabular-nums text-white/90">
						{formatVideoTime(currentTime)} / {formatVideoTime(duration)}
					</span>
					{(onExpand || onCollapse) && (
						<button
							type="button"
							onClick={expanded ? onCollapse : onExpand}
							aria-label={expanded ? "Exit fullscreen" : "Fullscreen"}
							className="shrink-0 text-white/90 hover:text-white transition-colors"
						>
							{expanded
								? <Minimize2 className="h-4 w-4" />
								: <Maximize2 className="h-4 w-4" />}
						</button>
					)}
				</div>
			)}
		</div>
	);
}

function AttachmentVideo({ message }: { message: Message }) {
	const url = useMatrixAttachment(message);
	// Sender-supplied poster (info.thumbnail_*).  Instant paint
	// while the actual video bytes stream in.  Older messages
	// without an embedded poster get the legacy
	// black-square-then-first-frame behaviour, which is what
	// shipped before this fix landed.
	const poster = useMatrixVideoPoster(message);
	const { onContextMenu, menu } = useMediaContextMenu(url, message.mediaName ?? "video");
	const inlineVideoRef = useRef<HTMLVideoElement | null>(null);
	const lightboxVideoRef = useRef<HTMLVideoElement | null>(null);
	// `null` = closed.  When open it carries the inline player's
	// position + play state so the lightbox resumes seamlessly.
	const [lightbox, setLightbox] = useState<{ time: number; wasPlaying: boolean } | null>(null);

	// Reserve the exact final box from sender-supplied dimensions.
	// Prefer the video's own w/h (info.w / info.h on m.video); fall
	// back to the thumbnail's dimensions if the main media frame
	// didn't include them (some bridges).  See AttachmentImage above
	// for the full reasoning — without this, the row resizes when
	// poster decodes and again when video metadata loads.
	const { displayWidth, displayHeight } = useMemo(() => {
		const naturalW = message.mediaWidth ?? message.mediaThumbWidth ?? 0;
		const naturalH = message.mediaHeight ?? message.mediaThumbHeight ?? 0;
		if (!naturalW || !naturalH) return { displayWidth: 288, displayHeight: 176 };
		const MAX_W = 448, MAX_H = 320;
		const aspect = naturalW / naturalH;
		let w = Math.min(naturalW, MAX_W);
		let h = w / aspect;
		if (h > MAX_H) {
			h = MAX_H;
			w = h * aspect;
		}
		return { displayWidth: Math.round(w), displayHeight: Math.round(h) };
	}, [message.mediaWidth, message.mediaHeight, message.mediaThumbWidth, message.mediaThumbHeight]);

	function openLightbox() {
		const v = inlineVideoRef.current;
		const time = v ? v.currentTime : 0;
		const wasPlaying = v ? !v.paused : false;
		if (v && !v.paused) v.pause();
		setLightbox({ time, wasPlaying });
	}
	function closeLightbox() {
		// Carry the lightbox position back to the inline player.
		const lv = lightboxVideoRef.current;
		const iv = inlineVideoRef.current;
		if (lv && iv && Number.isFinite(lv.currentTime)) {
			iv.currentTime = lv.currentTime;
		}
		setLightbox(null);
	}

	const mediaStyle = { maxWidth: "100%" as const, height: "auto" as const, aspectRatio: `${displayWidth}/${displayHeight}` };
	if (!url) {
		if (poster) {
			return (
				<img
					src={poster}
					alt={message.mediaName ?? "video"}
					width={displayWidth}
					height={displayHeight}
					className="rounded-lg block"
					style={mediaStyle}
				/>
			);
		}
		return (
			<div
				className="rounded-lg bg-muted-foreground/10 animate-pulse"
				style={{ width: displayWidth, height: displayHeight, maxWidth: "100%", aspectRatio: `${displayWidth}/${displayHeight}` }}
			/>
		);
	}
	return (
		<div className="inline-block" style={{ maxWidth: "100%" }} onContextMenu={isMobileShell ? undefined : onContextMenu}>
			<VideoPlayer
				url={url}
				poster={poster}
				videoRef={inlineVideoRef}
				mediaStyle={mediaStyle}
				displayWidth={displayWidth}
				displayHeight={displayHeight}
				onExpand={openLightbox}
			/>
			{menu}
			<DialogPrimitive.Root open={!!lightbox} onOpenChange={(o) => { if (!o) closeLightbox(); }}>
				<DialogPrimitive.Portal>
					<DialogPrimitive.Overlay className="fixed inset-0 z-[70] bg-black/90 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
					<DialogPrimitive.Content
						className="fixed inset-0 z-[70] outline-none flex items-center justify-center p-4 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
						aria-describedby={undefined}
						// Tapping the dark backdrop (the Content itself,
						// not the centred player) closes the lightbox.
						onClick={(e) => { if (e.target === e.currentTarget) closeLightbox(); }}
					>
						<DialogPrimitive.Title className="sr-only">
							{message.mediaName ?? "Video"}
						</DialogPrimitive.Title>
						{lightbox && (
							<VideoPlayer
								url={url}
								poster={poster}
								videoRef={lightboxVideoRef}
								mediaStyle={{ maxWidth: "92vw", maxHeight: "85vh", width: "auto", height: "auto", aspectRatio: `${displayWidth}/${displayHeight}` }}
								displayWidth={displayWidth}
								displayHeight={displayHeight}
								autoPlay={lightbox.wasPlaying}
								initialTime={lightbox.time}
								expanded
								onCollapse={closeLightbox}
							/>
						)}
						<button
							type="button"
							onClick={closeLightbox}
							aria-label="Close"
							className="absolute rounded-full bg-white/10 p-2 text-white/90 backdrop-blur-md transition-colors hover:bg-white/20 hover:text-white"
							style={{ top: "calc(env(safe-area-inset-top) + 12px)", right: "calc(env(safe-area-inset-right) + 12px)" }}
						>
							<X className="h-5 w-5" />
						</button>
					</DialogPrimitive.Content>
				</DialogPrimitive.Portal>
			</DialogPrimitive.Root>
		</div>
	);
}

function AttachmentAudio({ message }: { message: Message }) {
	const url = useMatrixAttachment(message);
	const { onContextMenu, menu } = useMediaContextMenu(url, message.mediaName ?? "audio");
	return (
		<div
			className="flex flex-col gap-1 min-w-[14rem] max-w-xs"
			onContextMenu={onContextMenu}
		>
			<div className="text-[11px] font-medium truncate px-1">
				{message.mediaName ?? "Audio"}
			</div>
			{url ? (
				<audio src={url} controls className="w-full h-10" />
			) : (
				<div className="h-10 rounded bg-muted-foreground/10 animate-pulse" />
			)}
			{menu}
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
	const { onContextMenu, menu } = useMediaContextMenu(url, name);
	if (!url) {
		// Pre-fetch placeholder.  Same shape so layout is stable.
		return <div className={containerCn}>{inner}</div>;
	}
	// Whole card is the click target: clicking opens the same
	// download flow the right-click menu's Download item triggers,
	// so the affordance is obvious without forcing the user to
	// right-click for the most common action.  Right-click still
	// works on top of the click handler; e.preventDefault inside
	// onContextMenu blocks the native menu before it appears.
	return (
		<>
			<button
				type="button"
				onClick={async () => {
					const { downloadMediaUrl } = await import("@/lib/downloadMedia");
					await downloadMediaUrl(url, name);
				}}
				onContextMenu={onContextMenu}
				className={cn(containerCn, "text-left")}
				title={`Download ${name}`}
				aria-label={`Download ${name}`}
			>
				{inner}
			</button>
			{menu}
		</>
	);
}

// Compose-row preview for one or more files the user has selected but
// hasn't sent yet.  Renders as a horizontal row of thumbnail squares
// — image/video files show their own bytes via an object URL, anything
// else falls back to a file glyph + extension badge.  No filename, no
// byte count, no MIME chip: the user said "just thumbnails," and a
// grid of names + sizes was reading as a directory listing instead of
// "here's what I'm about to send."
//
// Each thumbnail has a hover-revealed X overlay that removes that file
// from the pending list.  The X stays visible while uploading is true
// so the user can still cancel mid-send if it's stuck — but disabled
// so it can't fire while the underlying array is being drained.
function PendingAttachmentsRow({
	files, uploading, onRemove,
}: {
	files: File[];
	uploading: boolean;
	onRemove(index: number): void;
}) {
	return (
		<div className="mb-2 flex flex-wrap gap-2 px-1">
			{files.map((file, idx) => (
				<PendingAttachmentThumb
					key={`${file.name}-${file.size}-${idx}`}
					file={file}
					uploading={uploading}
					onRemove={() => onRemove(idx)}
				/>
			))}
		</div>
	);
}

function PendingAttachmentThumb({
	file, uploading, onRemove,
}: {
	file: File;
	uploading: boolean;
	onRemove(): void;
}) {
	const isImage = file.type.startsWith("image/");
	const isVideo = file.type.startsWith("video/");
	// HEIC needs special handling: Chrome and Firefox can't decode it
	// natively, so a plain object URL points at bytes the <img> tag
	// renders as a broken icon.  We run the same heic-to conversion
	// the upload pipeline uses to get a previewable PNG blob, then
	// substitute its object URL for the thumbnail.  Safari (which
	// CAN decode HEIC) still goes through this path — the conversion
	// is fast and the trade-off (consistent preview across browsers)
	// is worth the extra ms.
	const isHeic = file.type === "image/heic"
		|| file.type === "image/heif"
		|| /\.(heic|heif)$/i.test(file.name);
	// Object URL is created once per file and revoked when the chip
	// unmounts (or the file changes).  Skipped for non-image/video
	// files to avoid pinning the bytes for nothing.
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	// Tracks whether the previewUrl points at an extracted JPEG
	// thumbnail (true for videos) vs. the source bytes themselves
	// (true for images).  Drives the renderer below: video previews
	// render as <img> (fast, paints reliably across browsers);
	// image previews render as <img> too but unwrapped.  Without
	// this flag the UI couldn't tell whether to show a play badge
	// over the still.
	const [previewIsVideoStill, setPreviewIsVideoStill] = useState(false);
	useEffect(() => {
		if (!isImage && !isVideo) {
			setPreviewUrl(null);
			setPreviewIsVideoStill(false);
			return;
		}
		let cancelled = false;
		let revokeUrl: string | null = null;
		const setUp = async () => {
			if (isVideo) {
				// Decode a real frame from the local file via canvas.
				// The previous `<video preload="metadata">` pattern
				// rendered black in WKWebView (the desktop app);
				// extracting + showing as <img> is reliable across
				// every supported renderer.  Bytes the upload
				// pipeline will need anyway (it embeds the same
				// thumbnail into the m.video event's
				// info.thumbnail_*), so this isn't wasted work.
				try {
					const { extractVideoThumbnail } = await import("@/lib/videoThumbnail");
					const t = await extractVideoThumbnail(file);
					if (cancelled) {
						if (t) URL.revokeObjectURL(t.objectUrl);
						return;
					}
					if (t) {
						revokeUrl = t.objectUrl;
						setPreviewUrl(t.objectUrl);
						setPreviewIsVideoStill(true);
						return;
					}
				} catch (err) {
					console.warn("PendingAttachmentThumb: video thumbnail decode failed", err);
				}
				// Decode failed: fall through to a generic file glyph
				// by leaving previewUrl null.  Upload still works.
				if (!cancelled) {
					setPreviewUrl(null);
					setPreviewIsVideoStill(false);
				}
				return;
			}
			let blob: Blob = file;
			if (isHeic) {
				try {
					const { heicTo } = await import("heic-to");
					blob = await heicTo({ blob: file, type: "image/png" });
				} catch (err) {
					// Conversion failed (corrupt file, OOM, etc.) — fall
					// through to a generic file glyph by clearing the
					// preview URL.  Upload still proceeds; only the
					// thumbnail is degraded.
					console.warn("PendingAttachmentThumb: HEIC preview decode failed", err);
					if (!cancelled) {
						setPreviewUrl(null);
						setPreviewIsVideoStill(false);
					}
					return;
				}
			}
			if (cancelled) return;
			const url = URL.createObjectURL(blob);
			revokeUrl = url;
			setPreviewUrl(url);
			setPreviewIsVideoStill(false);
		};
		void setUp();
		return () => {
			cancelled = true;
			if (revokeUrl) URL.revokeObjectURL(revokeUrl);
		};
	}, [file, isImage, isVideo, isHeic]);

	const ext =
		(file.name.match(/\.([A-Za-z0-9]{1,5})$/)?.[1] ??
			file.type.split("/")[0] ??
			"FILE")
			.toUpperCase()
			.slice(0, 4);

	return (
		<div className="relative group h-20 w-20 shrink-0 rounded-md overflow-hidden bg-muted/60 border border-border flex items-center justify-center">
			{previewUrl && (isImage || (isVideo && previewIsVideoStill)) && (
				<img
					src={previewUrl}
					alt=""
					className="h-full w-full object-cover"
				/>
			)}
			{previewUrl && isVideo && previewIsVideoStill && (
				// Play-glyph overlay so video stills are visually
				// distinct from image attachments at chip size.
				// Pointer-events:none so the wrapping button still
				// receives clicks (remove on hover).
				<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
					<div className="bg-background/70 rounded-full p-1">
						<Play className="h-3 w-3 fill-foreground text-foreground" />
					</div>
				</div>
			)}
			{previewUrl && isVideo && !previewIsVideoStill && (
				// Fallback path: decode failed, but we still have the
				// raw object URL.  Use the legacy <video> approach so
				// at least SOMETHING renders rather than the file
				// glyph.  Cosmetic only; the upload itself still
				// includes whatever thumbnail extraction managed,
				// or none if both attempts failed.
				<video
					src={previewUrl}
					className="h-full w-full object-cover"
					muted
					playsInline
					preload="metadata"
				/>
			)}
			{!previewUrl && (
				<>
					<FileIcon className="h-6 w-6 text-muted-foreground" />
					<span className="absolute bottom-1 right-1 text-[8px] font-semibold tracking-wider px-1 py-px rounded bg-card/90 text-foreground border border-border leading-none">
						{ext}
					</span>
				</>
			)}
			<button
				type="button"
				onClick={onRemove}
				disabled={uploading}
				className={cn(
					"absolute top-0.5 right-0.5 p-1 rounded-full bg-background/80 backdrop-blur-sm",
					"text-foreground hover:bg-destructive hover:text-destructive-foreground transition-colors",
					"opacity-0 group-hover:opacity-100 focus:opacity-100",
					"disabled:opacity-40 disabled:cursor-not-allowed",
				)}
				aria-label="Remove attachment"
				title="Remove attachment"
			>
				<X className="h-3 w-3" />
			</button>
		</div>
	);
}

// Detect a URL in a message body and, if Synapse returns OG metadata
// for it, render a Discord-style preview card under the bubble.  Skips
// rendering entirely when there's no URL or no preview was returned —
// no flicker, no empty cards.
//
// Embed-slot competition: only the FIRST URL in source order gets an
// embed.  If that first URL is YouTube, MessageBubble already rendered
// the iframe player; this slot suppresses to keep the rule "one embed
// per message".  If the first URL is non-YouTube, we preview it here
// (and any later YouTube URLs in the same message stay as plain links).
function UrlPreviewSlot({ text }: { text: string }) {
	const url = firstLink(text);
	const firstUrlIsYouTube = !!url && isYouTubeUrl(url);
	// Skip the OG card for share URLs the message body already
	// rendered as an inline room-mention pill.  The pill conveys
	// the target's name + scope, an extra card showing "Koven /
	// CLIENT.KOVEN.CHAT / Welcome to Koven" beneath is just visual
	// noise (and a redundant Synapse OG round-trip).  We treat any
	// URL the share-link parser recognises as "already pilled" and
	// suppress the preview slot entirely.
	const firstUrlIsShareLink = !!url && parseShareLinkUrl(url) !== null;
	// Pass null to useUrlPreview when YouTube or our own share link
	// wins the slot so we don't spend a Synapse OG-preview round-
	// trip we'd just discard.
	const preview = useUrlPreview(firstUrlIsYouTube || firstUrlIsShareLink ? null : url);
	const imageUrl = useMatrixMedia(preview?.imageMxc);
	if (!url || firstUrlIsYouTube || firstUrlIsShareLink || !preview) return null;

	const host = (() => {
		try { return new URL(preview.url).hostname.replace(/^www\./, ""); }
		catch { return preview.siteName ?? ""; }
	})();

	// Three layout modes, Twitter-card style:
	//
	//   "hero"    — image dominates, sitting on top of the card with
	//               the text stack below.  Twitter's
	//               summary_large_image.  Used when the OG image is
	//               large enough to read at width (>= 400 px reported)
	//               OR clearly landscape (aspect >= 1.3).
	//
	//   "compact" — small square thumbnail on the right, text on the
	//               left.  Twitter's summary.  Used when an image
	//               exists but is small, portrait, or has no reported
	//               dimensions (safer default than ballooning a
	//               favicon to hero size).
	//
	//   "text"    — no image at all.  Card shrinks to just the metadata
	//               block.
	//
	// We trust Synapse's parsed `og:image:width` / `og:image:height`
	// here.  Servers that don't expose them collapse to "compact" so
	// the worst case is a tiny image rendered as a 96px thumbnail —
	// never an icon stretched to fill a hero slot.
	const layout: "hero" | "compact" | "text" = (() => {
		if (!imageUrl) return "text";
		const w = preview.imageWidth ?? 0;
		const h = preview.imageHeight ?? 0;
		if (w >= 400 || (w > 0 && h > 0 && w / h >= 1.3)) return "hero";
		return "compact";
	})();

	return (
		<a
			href={preview.url}
			target="_blank"
			rel="noopener noreferrer"
			className={cn(
				"mt-1.5 block max-w-md rounded-xl overflow-hidden bg-muted/40 border border-border",
				"hover:bg-muted/60 hover:border-border/80 transition-colors",
				// No left accent stripe in the new design — Twitter /
				// modern social cards rely on the rounded outline +
				// hover state alone to signal "external link card."
			)}
		>
			{layout === "hero" && (
				<>
					{/* 2:1 hero with object-cover so portrait-leaning
					    images crop centrally rather than letterboxing
					    inside the card.  bg-muted-foreground/10 fills
					    the box while the image is still streaming. */}
					<div className="aspect-[2/1] w-full bg-muted-foreground/10 overflow-hidden">
						<img
							src={imageUrl}
							alt=""
							loading="lazy"
							className="w-full h-full object-cover block"
						/>
					</div>
					<div className="px-3 py-2.5 space-y-1">
						<UrlPreviewText preview={preview} host={host} />
					</div>
				</>
			)}
			{layout === "compact" && (
				<div className="flex gap-3">
					<div className="flex-1 min-w-0 px-3 py-2.5 space-y-1">
						<UrlPreviewText preview={preview} host={host} />
					</div>
					<div className="shrink-0 w-24 h-24 bg-muted-foreground/10 overflow-hidden">
						<img
							src={imageUrl ?? ""}
							alt=""
							loading="lazy"
							className="w-full h-full object-cover block"
						/>
					</div>
				</div>
			)}
			{layout === "text" && (
				<div className="px-3 py-2.5 space-y-1">
					<UrlPreviewText preview={preview} host={host} />
				</div>
			)}
		</a>
	);
}

/** Shared text block for the three preview layouts.  Keeps the
 * site / title / description rules in one place so the hero and
 * compact variants stay visually consistent. */
function UrlPreviewText({ preview, host }: { preview: UrlPreview; host: string }) {
	return (
		<>
			{(preview.siteName ?? host) && (
				<div className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">
					{preview.siteName ?? host}
				</div>
			)}
			<div className="text-sm font-semibold leading-snug line-clamp-2 text-foreground">
				{preview.title}
			</div>
			{preview.description && (
				<div className="text-xs text-muted-foreground leading-snug line-clamp-3">
					{preview.description}
				</div>
			)}
		</>
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
	botMxids,
	serviceMxids,
}: {
	roomId: RoomId;
	eventId: EventId;
	isDm: boolean;
	receiptsVersion: number;
	memberAvatars: Map<string, string | undefined>;
	memberNames: Map<string, string>;
	// Read receipts from bot mxids in this set are excluded from
	// the seen-by stack.  The engine keeps every bot's matrix-js-sdk
	// client live + syncing, so they emit read receipts for every
	// message they receive.  The user cares about who actually
	// READ the message — i.e. real humans — not which automated
	// processes happen to also be in the room.
	botMxids?: Set<string>;
	// Service identities (engine appservice, Synapse admin user)
	// also filtered: same rationale as bots, plus the @-prefix
	// regex doesn't catch their non-bot localparts (@engine,
	// @koven-svc), so we need the explicit set.
	serviceMxids?: Set<string>;
}) {
	const transport = useTransport();
	const [open, setOpen] = useState(false);

	// receiptsVersion in deps via useMemo so we re-query when it
	// bumps.  matrix-js-sdk owns the actual receipt cache; we just
	// trigger a re-read.  Bot receipts are filtered post-query
	// rather than inside getMessageSeenBy because the transport
	// doesn't carry the bot roster — it lives one level up.
	const seen = useMemo(() => {
		if (!transport) return [];
		const all = transport.getMessageSeenBy(roomId, eventId);
		// Engine appservice user reads everything for moderation /
		// fanout — its receipts would always show up on every
		// message, which is meaningless to a human reader.  Filter it
		// out unconditionally.  Bot receipts are also filtered when
		// we know the roster (botMxids), but the engine appservice
		// isn't in that roster (it's a service identity, not a bot).
		const filtered = all.filter(s => {
			// Service identities (engine appservice, Synapse admin
			// user) read everything as a matter of platform
			// architecture; their receipts are noise.
			if (serviceMxids && serviceMxids.has(s.userId)) return false;
			// Current bot roster.
			if (botMxids && botMxids.has(s.userId)) return false;
			// Mxid-pattern fallback for deleted bots.  Their old
			// m.read receipts persist server-side after the engine
			// row is dropped (Matrix has no "redact a receipt"
			// verb), so they'd otherwise keep haunting historical
			// messages.  Bot mxids are reserved-namespace localparts
			// in our Synapse config; no human can have one.
			if (/^@bot-/.test(s.userId)) return false;
			return true;
		});
		return filtered;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [transport, roomId, eventId, receiptsVersion, botMxids, serviceMxids]);

	if (isDm) {
		// DM: WhatsApp / iMessage-style tick marks.  The parent
		// mounts us only on self + non-pending rows, so by the time
		// we render the message is sent to Synapse:
		//   - seen.length === 0 → delivered but not yet read by the
		//     other party → single grey check
		//   - seen.length > 0   → read → double green check, with
		//     the read timestamp in the tooltip
		// The double-check colour follows the room's accent rather
		// than a hardcoded emerald so themed instances still look
		// consistent; emerald is a sensible default for the dark
		// theme Koven ships with.
		if (seen.length === 0) {
			return (
				<span
					className="inline-flex items-center text-muted-foreground/60 ml-0.5"
					title="Delivered"
					aria-label="Delivered"
				>
					<Check className="h-3.5 w-3.5" strokeWidth={2.5} />
				</span>
			);
		}
		const ts = seen[0]!.ts;
		return (
			<span
				className="inline-flex items-center text-emerald-500 ml-0.5"
				title={`Read · ${formatChatTimestamp(ts)}`}
				aria-label={`Read at ${formatChatTimestamp(ts)}`}
			>
				<CheckCheck className="h-3.5 w-3.5" strokeWidth={2.5} />
			</span>
		);
	}

	// Group rooms keep the empty-state null behaviour: nothing
	// to show if no one else has read the message yet.
	if (seen.length === 0) return null;

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
				    Linear / Telegram use for compact reader lists.
				    Hand-rolled here (no MatrixAvatar) because WKWebView
				    in Tauri silently collapses <img> elements to 0px
				    wide inside flex containers regardless of any CSS
				    width / explicit HTML width attribute we set on
				    them — the only reliable workaround is to swap the
				    <img> for a <div> with background-image, which has
				    no intrinsic dimensions and no flex-basis quirk.
				    Same image bytes either way; bypasses the IMG
				    element entirely so WebKit has nothing to argue
				    with.  Blink renders both forms identically. */}
				<span className="inline-flex">
					{visible.map((s, i) => (
						<SeenAvatarChip
							key={s.userId}
							mxc={memberAvatars.get(s.userId) ?? undefined}
							seed={s.userId}
							leadingOverlap={i > 0}
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

/** Compact avatar tile for the seen-by stack.  Renders as a fixed-
 * size <div> with the avatar pulled in via background-image instead
 * of an <img>, because Tauri's WKWebView collapses <img> elements
 * to 0px wide when they sit inside flex containers — even with
 * inline style width and HTML width attributes set, WebKit picks
 * its flex-basis from the image's intrinsic dimensions and ignores
 * everything else.  background-image has no intrinsic dimensions,
 * so the inline width/height is the only sizing input and the
 * avatar always renders.  Blob URLs from useMatrixMedia work the
 * same as in <img src=...>; falls through to the DiceBear fallback
 * when no mxc is available.  `leadingOverlap` shifts every avatar
 * after the first 4px to the left, mirroring `-space-x-1` without
 * relying on Tailwind's child-combinator selector (which also has
 * had quirky WebKit interactions in older builds). */
function SeenAvatarChip({
	mxc,
	seed,
	leadingOverlap,
}: {
	mxc?: string;
	seed: string;
	leadingOverlap: boolean;
}) {
	const blobUrl = useMatrixMedia(mxc);
	const fallbackUrl = autoAvatarUrl(seed, "user");
	const url = blobUrl ?? (mxc ? null : fallbackUrl);
	return (
		<div
			aria-hidden
			style={{
				width: 16,
				height: 16,
				marginLeft: leadingOverlap ? -4 : 0,
				backgroundImage: url ? `url(${JSON.stringify(url)})` : undefined,
				backgroundSize: "cover",
				backgroundPosition: "center",
				backgroundColor: url ? undefined : "hsl(var(--muted))",
			}}
			className="rounded-full ring-1 ring-background shrink-0"
		/>
	);
}

// Small "Alice is typing…" row that sits just above the composer.
// Renders nothing when nobody's typing so the composer doesn't shift
// up and down on every empty/non-empty flip.  Display-name resolution
// goes through the room's member list with a localpart fallback for
// users we haven't synced membership data for yet (rare; only briefly
// during initial sync after a fresh sign-in).
function TypingIndicator({
	userIds,
	members,
}: {
	userIds: UserId[];
	members: Member[] | null;
}) {
	if (!userIds || userIds.length === 0) return null;
	const nameFor = (uid: UserId): string => {
		const m = members?.find(mm => mm.userId === uid);
		if (m?.displayName) return m.displayName;
		return localpartOf(uid);
	};
	const names = userIds.slice(0, 3).map(nameFor);
	let label: string;
	if (userIds.length === 1) {
		label = `${names[0]} is typing`;
	} else if (userIds.length === 2) {
		label = `${names[0]} and ${names[1]} are typing`;
	} else if (userIds.length === 3) {
		label = `${names[0]}, ${names[1]}, and ${names[2]} are typing`;
	} else {
		label = `${names[0]}, ${names[1]}, and ${userIds.length - 2} others are typing`;
	}
	return (
		<div className="mb-2 px-1 flex items-center gap-2 text-[11px] text-muted-foreground leading-none">
			<span className="inline-flex gap-0.5" aria-hidden>
				<span className="block h-1 w-1 rounded-full bg-current animate-typing-dot" style={{ animationDelay: "0ms" }} />
				<span className="block h-1 w-1 rounded-full bg-current animate-typing-dot" style={{ animationDelay: "150ms" }} />
				<span className="block h-1 w-1 rounded-full bg-current animate-typing-dot" style={{ animationDelay: "300ms" }} />
			</span>
			<span className="truncate">
				{label}<span aria-hidden>…</span>
			</span>
		</div>
	);
}

// ── Date separators ──────────────────────────────────────────────
//
// Inline timeline markers shown between message groups when there's
// a meaningful gap.  iOS Messages convention: every day boundary
// gets a date label (Today / Yesterday / weekday / full date), and
// significant within-day gaps (>1 hour) get a time stamp.  Combined
// into a single centered label so the timeline still scans cleanly.

const SEPARATOR_TIME_GAP_MS = 60 * 60_000; // 1 hour

function computeDateSeparator(prevTs: number | undefined, currentTs: number): string | null {
	if (!currentTs) return null;
	const current = new Date(currentTs);
	if (prevTs === undefined) return formatSeparator(current);
	const prev = new Date(prevTs);
	const sameDay = prev.toDateString() === current.toDateString();
	if (!sameDay) return formatSeparator(current);
	if (currentTs - prevTs > SEPARATOR_TIME_GAP_MS) {
		return current.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	}
	return null;
}

function formatSeparator(d: Date): string {
	const today = new Date();
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	const dayLabel =
		d.toDateString() === today.toDateString()      ? "Today"
		: d.toDateString() === yesterday.toDateString() ? "Yesterday"
		: (today.getTime() - d.getTime() < 7 * 24 * 60 * 60_000)
			? d.toLocaleDateString(undefined, { weekday: "long" })
			: d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
	const timeLabel = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	return `${dayLabel} ${timeLabel}`;
}

function DateSeparator({ label }: { label: string }) {
	return (
		<div className="w-full flex items-center justify-center py-2 select-none">
			<span className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground/80 text-center">
				{label}
			</span>
		</div>
	);
}

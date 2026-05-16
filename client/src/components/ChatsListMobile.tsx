// ChatsListMobile — iOS Messages-style DM list shown on the Chats
// tab.  Replaces the desktop RoomList for `isMobileShell &&
// activeSpace.kind === "dms"`.  Pattern follows iOS Messages: large
// title at the top, list of conversations with avatar + name +
// timestamp on one row, last-message preview on the next, blue dot
// indicator for unread.
//
// HIG calibration (components.md + Apple's Messages reference):
//   - 34pt Large Title "Chats".  Compose / start-DM action lives in
//     the trailing slot of the same row (Apple Mail / Messages put
//     compose here, not in the nav bar).
//   - Row height ~72pt (52pt avatar + 10pt vertical padding either
//     side).  Comfortably above the 44pt touch-target minimum.
//   - Unread dot: 10pt circle, system-blue, in the LEADING margin
//     before the avatar.  Stays in flow so non-unread rows align
//     their avatars 14pt further left (iOS does this — the dot
//     "pushes" content right by exactly its width).
//   - Name: 17pt regular, semibold when unread.
//   - Timestamp: 13pt secondary, right-aligned.
//   - Preview: 15pt secondary, 2 lines max truncated.
//   - Empty state: centered icon + heading + body + primary action.
//
// Last-message preview reads from the live timeline via
// `transport.getRoomMessages` (in-memory; no network call).

import { useEffect, useMemo, useRef, useState } from "react";
import { useDrag } from "@use-gesture/react";
import { MessageSquare, Lock, BellOff, PenSquare, ChevronRight } from "lucide-react";
import type { Message, Room, RoomId, UserId } from "@koven/shared";
import type { MatrixTransport } from "@/lib/matrix";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { hapticImpact, hapticNotification } from "@/lib/haptics";
import { cn } from "@/lib/utils";

// `--primary` is the user's theme tint (midnight → near-white, plum
// → purple, daylight → dark, etc.) — use it for any "active app
// accent" colour so the chat list reflects the chosen theme rather
// than a hardcoded iOS blue.  System red stays hardcoded — destructive
// is universal across themes (Apple's HIG keeps `.systemRed` constant
// the same way).
const IOS_RED = "#FF3B30";

// Swipe-to-delete geometry (iOS Messages calibration).  The Delete
// action rests at 84pt wide once the row is held open; a swipe that
// drags the row more than 55% of its own width past that commits the
// delete outright (the full-swipe shortcut iMessage gives you).
const DELETE_ACTION_WIDTH = 84;
const SWIPE_DELETE_COMMIT = 0.55;

interface ChatsListMobileProps {
	rooms: Room[];
	transport: MatrixTransport | null;
	currentUserId: UserId;
	botMxids: Set<UserId>;
	// True once initial sync has reached `syncing` or `ready` — at
	// that point matrix-js-sdk has fanned the user's joined rooms
	// into `state.rooms`.  While the sync is still in `preparing`,
	// the rooms array is genuinely empty (but not because the user
	// has none — just because they haven't arrived yet).  Without
	// this gate, the EmptyState "No chats yet" flashes for the
	// brief window between sign-in and the first room dispatch.
	roomsLoaded: boolean;
	onSelectRoom(id: RoomId): void;
	onCreateRoom(): void;
	onAcceptInvite(id: RoomId): Promise<void> | void;
	onDeclineInvite(id: RoomId): Promise<void> | void;
	// Leave the DM.  Wired to transport.leaveRoom in App.tsx; the row
	// unmounts once the membership change drops the room from state.
	onDeleteRoom(id: RoomId): Promise<void> | void;
}

export function ChatsListMobile({
	rooms, transport, currentUserId, botMxids, roomsLoaded,
	onSelectRoom, onCreateRoom,
	onAcceptInvite, onDeclineInvite, onDeleteRoom,
}: ChatsListMobileProps) {
	// At most one row's Delete action is open at a time (iOS Messages
	// behaviour) — opening another, scrolling, or tapping a row all
	// close whatever was open.
	const [swipedRoomId, setSwipedRoomId] = useState<RoomId | null>(null);
	const { invites, dms } = useMemo(() => {
		const dmRooms = rooms.filter(r => r.kind === "dm");
		// Invites first; the rest sorted by last-active descending
		// (iOS Messages convention).
		const inv = dmRooms
			.filter(r => r.isInvite)
			.sort((a, b) => (b.lastActiveTs ?? 0) - (a.lastActiveTs ?? 0));
		const joined = dmRooms
			.filter(r => !r.isInvite)
			.sort((a, b) => (b.lastActiveTs ?? 0) - (a.lastActiveTs ?? 0));
		return { invites: inv, dms: joined };
	}, [rooms]);

	function selectRoom(id: RoomId) {
		void hapticImpact("light");
		onSelectRoom(id);
	}

	function startDm() {
		void hapticImpact("medium");
		onCreateRoom();
	}

	return (
		// Transparent so the page inherits body::before's
		// --bg-gradient — same colour tones the desktop chat pane
		// uses, instead of a flat bg-background.
		<div
			className="flex-1 min-h-0 overflow-y-auto"
			onScroll={() => { if (swipedRoomId) setSwipedRoomId(null); }}
		>
			<div
				className="pt-2"
				style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 80px)" }}
			>
				{/* Large-title row.  Compose button lives at the
				    trailing edge — same spot Apple Mail puts its
				    compose pen.  Keeps the action one tap away
				    without competing with the notification bell in
				    the nav bar. */}
				<div className="flex items-center justify-between py-3 px-4">
					<h1 className="text-[34px] font-bold tracking-[-0.022em] leading-[1.1] text-foreground">
						Chats
					</h1>
					<button
						type="button"
						onClick={startDm}
						aria-label="Start a new chat"
						className={cn(
							"size-10 rounded-full flex items-center justify-center",
							"bg-foreground/[0.08] active:bg-foreground/[0.16] transition-colors",
						)}
					>
						<PenSquare className="size-[18px]" strokeWidth={2.25} />
					</button>
				</div>

				{/* Invites section — shown only when there's at
				    least one.  Section header is the iOS uppercase
				    13pt label; rows have inline Accept/Decline
				    pills below the standard avatar+name layout. */}
				{invites.length > 0 && (
					<div className="mb-5">
						<div className="px-5 pb-1.5 text-[13px] uppercase tracking-wider text-muted-foreground font-medium">
							{invites.length === 1 ? "Invite" : `Invites · ${invites.length}`}
						</div>
						<div>
							{invites.map((room, idx) => {
								const inviteSeed = room.dmUserId ?? room.inviter;
								return (
									<InviteRow
										key={room.id}
										room={room}
										isBot={!!inviteSeed && botMxids.has(inviteSeed as UserId)}
										onAccept={onAcceptInvite}
										onDecline={onDeclineInvite}
										showDivider={idx > 0}
									/>
								);
							})}
						</div>
					</div>
				)}

				{!roomsLoaded ? (
					// Pulsing favicon throbber until matrix-js-sdk's
					// initial sync has fanned the user's rooms into
					// state.rooms.  Replaces the brief "No chats yet"
					// flash that used to happen between sign-in and
					// the first room dispatch, when the rooms array
					// was empty but not actually empty.
					<div
						className="flex items-center justify-center py-24"
						aria-live="polite"
						aria-label="Loading chats"
					>
						<img
							src="/favicon.png"
							alt=""
							className="size-12 animate-pulse"
							style={{ filter: "drop-shadow(0 0 24px rgba(0,0,0,0.5))" }}
						/>
					</div>
				) : dms.length === 0 && invites.length === 0 ? (
					<EmptyState onStart={startDm} />
				) : dms.length > 0 ? (
					<div>
						{dms.map((room, idx) => (
							<ChatRow
								key={room.id}
								room={room}
								transport={transport}
								currentUserId={currentUserId}
								isBot={!!room.dmUserId && botMxids.has(room.dmUserId)}
								onClick={() => selectRoom(room.id)}
								onDelete={() => onDeleteRoom(room.id)}
								open={swipedRoomId === room.id}
								onOpenChange={(o) => setSwipedRoomId(o ? room.id : null)}
								showDivider={idx > 0}
							/>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}

function ChatRow({
	room, transport, currentUserId, isBot, onClick, onDelete, open, onOpenChange, showDivider,
}: {
	room: Room;
	transport: MatrixTransport | null;
	currentUserId: UserId;
	isBot: boolean;
	onClick(): void;
	onDelete(): Promise<void> | void;
	open: boolean;
	onOpenChange(open: boolean): void;
	showDivider: boolean;
}) {
	// Live-timeline read.  In-memory; cheap.  Returns [] if the
	// transport hasn't initialised this room yet (mid-sync).
	const last = transport?.getRoomMessages(room.id)?.slice(-1)[0];
	const preview = formatPreview(last, currentUserId);
	const time = formatRelativeTime(last?.timestamp ?? room.lastActiveTs);

	const unread = room.unreadCount ?? 0;
	const hasHighlight = (room.highlightCount ?? 0) > 0;
	const isMuted = false; // notify-level isn't on the Room type; future hook

	const cardRef = useRef<HTMLButtonElement | null>(null);
	const deleteRef = useRef<HTMLButtonElement | null>(null);
	// `open` mirrored into a ref so the drag handler reads the latest
	// value without re-binding useDrag every render.
	const openRef = useRef(open);
	openRef.current = open;
	// Set true once a drag travels far enough to count as a swipe, so
	// the click that fires on release doesn't also open the chat.
	const movedRef = useRef(false);
	const [deleting, setDeleting] = useState(false);

	// Slide the row to `x` (<= 0) and grow the Delete action to fill
	// the gap it opens.  Written straight to the DOM so the drag stays
	// 1:1 with the finger — no React re-render per pointer move.
	function setX(x: number, animate: boolean) {
		const card = cardRef.current;
		const del = deleteRef.current;
		const ease = "cubic-bezier(0.2, 0.8, 0.2, 1)";
		if (card) {
			card.style.transition = animate ? `transform 240ms ${ease}` : "none";
			card.style.transform = `translateX(${x}px)`;
		}
		if (del) {
			del.style.transition = animate ? `width 240ms ${ease}` : "none";
			del.style.width = `${Math.max(0, -x)}px`;
		}
	}

	// React to external open / close: a sibling row opening or the
	// list scrolling flips `open` false and slides this row home.
	useEffect(() => {
		setX(open ? -DELETE_ACTION_WIDTH : 0, true);
	}, [open]);

	async function commitDelete() {
		if (deleting) return;
		setDeleting(true);
		void hapticNotification("warning");
		try {
			await onDelete();
			// Row unmounts once the room leaves state.rooms.
		} catch {
			setDeleting(false);
			onOpenChange(false);
		}
	}

	const dragBind = useDrag(({ first, active, last: released, movement: [mx], tap }) => {
		if (first) movedRef.current = false;
		if (Math.abs(mx) > 6) movedRef.current = true;
		if (tap) return;
		const card = cardRef.current;
		if (!card) return;
		// Anchor the drag to wherever the row was resting.
		const base = openRef.current ? -DELETE_ACTION_WIDTH : 0;
		let x = base + mx;
		// No travel past the closed position — resist a rightward pull.
		if (x > 0) x = x * 0.16;
		const width = card.offsetWidth || window.innerWidth;
		if (active) {
			setX(x, false);
			return;
		}
		if (released) {
			if (-x > width * SWIPE_DELETE_COMMIT) {
				// Full swipe past the commit line: slide off and leave.
				setX(-width, true);
				void hapticImpact("medium");
				void commitDelete();
				return;
			}
			const shouldOpen = -x > DELETE_ACTION_WIDTH * 0.5;
			setX(shouldOpen ? -DELETE_ACTION_WIDTH : 0, true);
			if (shouldOpen !== openRef.current) {
				if (shouldOpen) void hapticImpact("light");
				onOpenChange(shouldOpen);
			}
		}
	}, { axis: "x", pointer: { touch: true }, filterTaps: true });

	return (
		<>
			{showDivider && <div className="ml-[68px] h-px bg-foreground/[0.08]" aria-hidden />}
			<div className="relative overflow-hidden">
				{/* Delete action — sits in the gap the row opens as it
				    slides left, growing from 0 width so it never peeks
				    out from under a closed row. */}
				<button
					ref={deleteRef}
					type="button"
					onClick={() => void commitDelete()}
					disabled={deleting}
					aria-label={`Delete chat with ${room.name || "Untitled"}`}
					className="absolute inset-y-0 right-0 flex items-center justify-center overflow-hidden text-white text-[15px] font-medium"
					style={{ width: 0, backgroundColor: IOS_RED }}
				>
					<span className="whitespace-nowrap px-3">
						{deleting ? "Deleting…" : "Delete"}
					</span>
				</button>
				<button
					ref={cardRef}
					type="button"
					{...dragBind()}
					onClick={() => {
						// A swipe that ended in a stray click must not
						// also open the chat; an open row taps closed.
						if (movedRef.current) { movedRef.current = false; return; }
						if (openRef.current) { onOpenChange(false); return; }
						onClick();
					}}
					className="relative w-full flex items-stretch gap-3 pl-4 pr-3 py-2.5 active:bg-foreground/[0.06] transition-colors touch-pan-y"
				>
					{/* Leading unread dot.  Absolutely positioned in the
					    row's leading padding so it overlays without
					    affecting avatar position — every row's avatar
					    starts at the same x.  Matches iOS Messages,
					    where read rows don't have any reserved space
					    for the dot. */}
					{unread > 0 && (
						<span
							className={cn(
								"absolute left-1 top-1/2 -translate-y-1/2 block size-[10px] rounded-full",
								hasHighlight ? "" : "bg-primary",
							)}
							style={hasHighlight ? { backgroundColor: IOS_RED } : undefined}
							aria-label={`${unread} unread`}
						/>
					)}

					{/* Avatar.  DM, so circular.  Presence dot is part
					    of MatrixAvatar siblings — wrapped here so the
					    DM presence dot lands cleanly on the bottom-right. */}
					<div className="relative shrink-0 self-center">
						<MatrixAvatar
							mxc={room.avatarUrl}
							seed={room.dmUserId ?? room.id}
							kind={isBot ? "bot" : "user"}
							className="h-[52px] w-[52px] rounded-full"
						/>
						{room.dmPresence === "online" && (
							<span
								className="absolute -bottom-0.5 -right-0.5 size-[14px] rounded-full ring-[3px] ring-background"
								style={{ backgroundColor: "#34C759" }}
								aria-label="Online"
							/>
						)}
						{room.dmPresence === "unavailable" && (
							<span
								className="absolute -bottom-0.5 -right-0.5 size-[14px] rounded-full ring-[3px] ring-background"
								style={{ backgroundColor: "#FF9F0A" }}
								aria-label="Idle"
							/>
						)}
					</div>

					{/* Content column.  Two lines: name + time (top),
					    preview (bottom).  text-left because the parent
					    button centers text by default. */}
					<div className="flex-1 min-w-0 text-left flex flex-col justify-center gap-0.5">
						<div className="flex items-center gap-1.5">
							<span className={cn(
								"text-[17px] truncate leading-tight",
								unread > 0 ? "font-semibold text-foreground" : "font-medium text-foreground",
							)}>
								{room.name || "Untitled"}
							</span>
							{room.encrypted && (
								<Lock className="size-[13px] shrink-0 text-muted-foreground" strokeWidth={2.25} />
							)}
							{isMuted && (
								<BellOff className="size-[13px] shrink-0 text-muted-foreground" strokeWidth={2.25} />
							)}
							<span className="ml-auto shrink-0 text-[13px] text-muted-foreground tabular-nums">
								{time}
							</span>
						</div>
						<div className="text-[15px] leading-snug text-muted-foreground line-clamp-2">
							{preview}
						</div>
					</div>
					<ChevronRight
						className="self-center shrink-0 size-[18px] text-muted-foreground/40 -mr-1"
						strokeWidth={2.5}
						aria-hidden
					/>
				</button>
			</div>
		</>
	);
}

function InviteRow({
	room, isBot, onAccept, onDecline, showDivider,
}: {
	room: Room;
	isBot: boolean;
	onAccept(id: RoomId): Promise<void> | void;
	onDecline(id: RoomId): Promise<void> | void;
	showDivider: boolean;
}) {
	const [pending, setPending] = useState<"accept" | "decline" | null>(null);

	async function handle(kind: "accept" | "decline") {
		if (pending) return;
		setPending(kind);
		void hapticImpact("medium");
		try {
			if (kind === "accept") await onAccept(room.id);
			else await onDecline(room.id);
			void hapticNotification("success");
			// Don't reset pending — the row will unmount once the
			// invite is removed from state.rooms.
		} catch {
			void hapticNotification("error");
			setPending(null);
		}
	}

	return (
		<>
			{showDivider && <div className="ml-[68px] h-px bg-foreground/[0.08]" aria-hidden />}
			<div className="flex flex-col gap-2.5 px-4 py-3">
				<div className="flex items-center gap-3">
					<MatrixAvatar
						mxc={room.avatarUrl}
						seed={room.dmUserId ?? room.inviter ?? room.id}
						kind={isBot ? "bot" : "user"}
						className="h-[52px] w-[52px] rounded-full shrink-0"
					/>
					<div className="flex-1 min-w-0">
						<div className="text-[17px] font-semibold text-foreground truncate leading-tight">
							{room.name || "Someone"}
						</div>
						<div className="text-[15px] text-muted-foreground leading-snug">
							{room.inviter ? "Invited you to chat" : "Sent you a chat request"}
						</div>
					</div>
				</div>
				<div className="flex gap-2 pl-[64px]">
					<button
						type="button"
						onClick={() => handle("decline")}
						disabled={!!pending}
						className={cn(
							"flex-1 h-9 rounded-full text-[15px] font-medium",
							"bg-foreground/[0.08] active:bg-foreground/[0.14] transition-colors",
							"disabled:opacity-50",
						)}
						style={{ color: IOS_RED }}
					>
						{pending === "decline" ? "Declining…" : "Decline"}
					</button>
					<button
						type="button"
						onClick={() => handle("accept")}
						disabled={!!pending}
						className={cn(
							"flex-1 h-9 rounded-full text-[15px] font-semibold",
							"bg-primary text-primary-foreground",
							"active:opacity-80 transition-opacity",
							"disabled:opacity-50",
						)}
					>
						{pending === "accept" ? "Accepting…" : "Accept"}
					</button>
				</div>
			</div>
		</>
	);
}

function EmptyState({ onStart }: { onStart(): void }) {
	return (
		<div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
			<div className="size-16 rounded-2xl bg-foreground/[0.06] flex items-center justify-center">
				<MessageSquare className="size-7 text-muted-foreground" strokeWidth={1.8} />
			</div>
			<div className="text-[17px] font-medium text-foreground">No chats yet</div>
			<p className="text-[15px] text-muted-foreground max-w-[260px] leading-snug">
				Start a direct message with someone and your conversations will show up here.
			</p>
			<button
				type="button"
				onClick={onStart}
				className={cn(
					"mt-2 h-11 px-5 rounded-full",
					"bg-primary text-primary-foreground",
					"text-[15px] font-semibold",
					"active:opacity-80 transition-opacity",
				)}
			>
				Start a chat
			</button>
		</div>
	);
}

// ── Helpers ───────────────────────────────────────────────────────

function formatPreview(msg: Message | undefined, currentUserId: UserId): string {
	if (!msg) return "Start the conversation";
	const isSelf = msg.sender === currentUserId || msg.isSelf;
	const prefix = isSelf ? "You: " : "";
	const body = formatMessageBody(msg);
	return prefix + body;
}

function formatMessageBody(msg: Message): string {
	switch (msg.kind) {
		case "image":  return "📷 Photo";
		case "video":  return "🎥 Video";
		case "audio":  return "🎤 Voice message";
		case "file":   return "📄 File";
		case "poll":   return "📊 Poll";
		case "emote":  return msg.text ? `* ${msg.text}` : "Action";
		default: {
			const t = msg.text?.trim();
			return t && t.length > 0 ? t : "Message";
		}
	}
}

// iOS Messages-style relative-time stamp:
//   < 1 min     → "now"
//   today       → "9:42 AM"
//   yesterday   → "Yesterday"
//   < 7 days    → weekday abbrev ("Mon")
//   older       → locale short date ("5/13/26")
function formatRelativeTime(ts: number | undefined): string {
	if (!ts) return "";
	const now = Date.now();
	const diff = now - ts;
	const min = 60_000;
	if (diff < min) return "now";

	const d = new Date(ts);
	const today = new Date();
	const sameDay = d.toDateString() === today.toDateString();
	if (sameDay) {
		return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	}

	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	if (d.toDateString() === yesterday.toDateString()) return "Yesterday";

	const week = 7 * 24 * 60 * 60_000;
	if (diff < week) {
		return d.toLocaleDateString(undefined, { weekday: "short" });
	}
	return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
}

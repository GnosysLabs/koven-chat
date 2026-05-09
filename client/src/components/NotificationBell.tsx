// NotificationBell — bell icon with unread badge + click-to-open
// list sheet.  Mounted in MobileTopBar's right slot and (later) in
// the desktop chat-header gutter.
//
// State + polling lives in `useNotifications` (state/use-notifications.ts);
// this component is pure presentation + click-to-open + click-to-
// navigate.  The hook handles auth, retries, optimistic updates,
// the works.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bell, Trash2, AtSign, Reply, MessageSquare, Mail, Bell as SystemIcon, Check } from "lucide-react";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { setRoomNotifyLevel } from "@/lib/notifyPrefs";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { NotificationEntry, NotificationKind } from "@/lib/notifications-api";
import type { UseNotificationsResult } from "@/state/use-notifications";
import { useBellOffset } from "@/state/bell-offset";

interface NotificationBellProps {
	notifications: UseNotificationsResult;
	/// Called when the user taps an entry.  Receives the room id —
	/// the bell doesn't know the route shape, the host does.  The
	/// host typically dispatches `set_active_room` and (best-effort)
	/// scrolls to the event_id.  Bell closes after invocation.
	onOpenRoom(roomId: string, eventId: string): void;
	/// Optional resolver: turn an MXID into a display name.  Falls
	/// back to localpart-of-MXID if unset or returns null.
	resolveDisplayName?(userId: string): string | null;
	/// Optional resolver: turn a room id into a name.  Falls back to
	/// "Room" if unset.
	resolveRoomName?(roomId: string): string | null;
	/// Visual treatment for the trigger button itself (the dialog
	/// content is identical across variants):
	///   - "icon"  — 40x40 inline icon button.  Mobile top-bar
	///               right-slot, fits the chrome height.
	///   - "fab"   — 56x56 fixed-position glass circle that
	///               anchors itself to the bottom-right viewport
	///               corner, lifted with a drop shadow and
	///               glassmorphic surface to match the mobile
	///               tab-bar pill.  Used on desktop where the
	///               app doesn't have a permanent top bar.
	/// Default: "icon".
	variant?: "icon" | "fab";
	/// Engine access token, used by the right-click context menu's
	/// "Mute source room" action.  Without it the menu still shows
	/// Open + Mark as read but the mute item is hidden.
	accessToken?: string;
}

export function NotificationBell({
	notifications,
	onOpenRoom,
	resolveDisplayName,
	resolveRoomName,
	variant = "icon",
	accessToken,
}: NotificationBellProps) {
	const [open, setOpen] = useState(false);
	const { unreadCount, entries, error, refresh, markRead, markAllRead, dismissAll } = notifications;
	// Extra px the FAB needs to lift to clear sticky pane footers
	// (e.g. the bot edit form's Cancel/Create buttons).  Drives the
	// `bottom` calc below; ignored for the icon variant which sits in
	// flow inside the mobile top bar and never overlaps anything.
	const bellOffset = useBellOffset();

	async function handleOpenChange(next: boolean) {
		setOpen(next);
		if (next) {
			// 1. Refresh the list so it's current (polled count
			//    flagged "new stuff" but cached entries may predate it).
			// 2. Then mark everything read on the server — opening the
			//    panel IS reading them.  No separate "Mark all read"
			//    button needed; if the user pulled the panel up, they
			//    saw what's in it.  Only unread → read flips happen here;
			//    rows aren't deleted, so the user can still scroll
			//    history of past notifications.
			await refresh();
			void markAllRead();
		}
	}

	async function handleGroupClick(group: NotificationGroup) {
		// Mark every unread entry in the group as read.  Fire-and-
		// forget — navigation shouldn't block on the round-trip, the
		// optimistic local updates have already flipped the state.
		for (const e of group.entries) {
			if (e.read_at === null) void markRead(e.id);
		}
		// Open the latest event in the room — that's the one the user
		// most likely wants to land on, and the older grouped events
		// are usually still visible just above it in the timeline.
		onOpenRoom(group.room_id, group.latest.event_id);
		setOpen(false);
	}

	const triggerButton =
		variant === "fab" ? (
			<button
				type="button"
				onClick={() => handleOpenChange(!open)}
				aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
				// Inline style for position — Tailwind's arbitrary-
				// value path for `right-[calc(env(...)+...)]` was
				// silently dropping the rule on some build paths,
				// leaving the FAB at right:auto and getting captured
				// by an ancestor's containing block.  Plain CSS
				// values are unambiguous, work everywhere, and don't
				// depend on Tailwind's JIT picking up the class.
				// safe-area-* is no-op on desktop (returns 0px)
				// and only matters on touch-laptops with hardware
				// inset, so the calc() is harmless there.
				style={{
					position: "fixed",
					bottom: `calc(env(safe-area-inset-bottom, 0px) + 1.5rem + ${bellOffset}px)`,
					right: "calc(env(safe-area-inset-right, 0px) + 1.5rem)",
					zIndex: 40,
					transition: "bottom 150ms ease",
				}}
				className={cn(
					// 56x56 round button.  Same diameter Discord /
					// Slack use for their floating bubbles; large
					// enough to hit comfortably with a mouse, small
					// enough to read as a control rather than a card.
					"h-14 w-14 rounded-full flex items-center justify-center",
					// Glassmorphic surface — uses themed tokens so it
					// adapts to every palette (light + dark).  Card
					// color at moderate alpha gives a frosted theme
					// surface; border-border picks up the matching
					// edge token.  Previously this was hardcoded white
					// alpha, which was invisible on light themes and
					// identical across every dark theme.
					"bg-card/70 backdrop-blur-2xl backdrop-saturate-150",
					"border border-border",
					"text-foreground",
					"shadow-lg",
					"hover:bg-card/85 active:bg-card active:scale-95",
					"transition-all duration-150",
				)}
			>
				<Bell className="h-5 w-5" strokeWidth={2.2} />
				{unreadCount > 0 ? (
					<span
						aria-hidden
						className={cn(
							// Solid red dot — count number was visual
							// noise; "there's something" is enough info,
							// the panel itself shows what.
							//
							// Position: dot center sits ON the bell's
							// circumference at the 1-o'clock position,
							// so half the dot is inside the visible
							// circle and half outside.  For a 56px
							// round button (radius 28), the circle's
							// edge at 45° is at offset (8px, 8px) from
							// the top-right corner; with a 10px dot
							// (radius 5) the centering math gives top:3
							// right:3 to land on that edge.  Negative
							// offsets would push the dot fully outside
							// the bell; positive offsets >5 push it
							// fully inside.
							"absolute top-[3px] right-[3px]",
							"h-2.5 w-2.5",
							"rounded-full bg-destructive",
							// Ring picks up the page background so the
							// dot reads as floating over the FAB rather
							// than welded to the rim.  Previously hard-
							// coded near-black, which broke on light
							// themes and any theme whose canvas wasn't
							// midnight-blue.
							"ring-2 ring-background",
						)}
					/>
				) : null}
			</button>
		) : (
			<button
				type="button"
				onClick={() => handleOpenChange(!open)}
				aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
				className={cn(
					"h-10 w-10 rounded-full flex items-center justify-center",
					"text-foreground active:bg-muted relative",
				)}
			>
				<Bell className="h-5 w-5" />
				{unreadCount > 0 ? (
					<span
						aria-hidden
						className={cn(
							// Same half-in/half-out treatment as the
							// FAB.  40px round button (radius 20),
							// 8px dot (radius 4): edge at 45° sits
							// at top:2 right:2 from the top-right
							// corner — center on the circumference,
							// half inside the bell, half outside.
							"absolute top-[2px] right-[2px]",
							"h-2 w-2",
							"rounded-full bg-destructive",
						)}
					/>
				) : null}
			</button>
		);

	// FAB renders into a portal at document.body so its
	// `position: fixed` actually pins to the viewport.  Without the
	// portal, an ancestor in App.tsx with `transform` (Tailwind
	// `transition-*`, `scale-*`, `translate-*`, etc.) creates a new
	// containing block and "fixed" gets scoped to that ancestor —
	// the FAB then anchors to a flex container's bottom-right
	// corner instead of the viewport's, which is exactly what
	// happens in our layout (the bell ended up in the bottom-left
	// of the screen, tucked under SpaceBar's sign-out icon, before
	// this fix).  The icon variant doesn't need this — it sits
	// inline in the MobileTopBar's right slot, no fixed positioning
	// involved.
	const trigger =
		variant === "fab" && typeof document !== "undefined"
			? createPortal(triggerButton, document.body)
			: triggerButton;

	// Panel body — header + list + footer.  Same JSX rendered into
	// either the FAB's anchored chatbot panel OR the icon variant's
	// modal Dialog.  Factored out so the two render paths share
	// identical content (and stay that way as the bell evolves).
	const panelBody = (
		<>
			<header className="px-4 pt-4 pb-3 border-b border-border/50 flex items-center gap-2 shrink-0">
				<Bell className="h-4 w-4" />
				<div className="text-base font-semibold">Notifications</div>
			</header>

			{entries.length === 0 ? (
				<div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16 gap-2">
					<Bell className="h-8 w-8 text-muted-foreground/40" />
					<div className="text-sm text-muted-foreground">
						{error ? "Couldn't load notifications" : "No notifications"}
					</div>
					{error ? (
						<p className="text-xs text-destructive/80 max-w-[260px] leading-snug font-mono break-words">
							{error}
						</p>
					) : unreadCount > 0 ? (
						<p className="text-xs text-muted-foreground/70 max-w-[260px] leading-snug">
							{unreadCount} unread but the list came back empty —
							check DevTools / Network for /api/notifications.
						</p>
					) : (
						<p className="text-xs text-muted-foreground/70 max-w-[260px] leading-snug">
							DMs, @-mentions, replies to your messages, and room invites
							will show up here.
						</p>
					)}
				</div>
			) : (
				<div className="flex-1 overflow-y-auto">
					{groupNotifications(entries).map(group => (
						<NotificationRow
							key={group.key}
							group={group}
							onClick={() => handleGroupClick(group)}
							onMarkRead={group.hasUnread ? () => {
								for (const e of group.entries) {
									if (e.read_at === null) void markRead(e.id);
								}
							} : undefined}
							onMuteRoom={accessToken ? () => {
								void setRoomNotifyLevel(accessToken, group.room_id, "muted");
							} : undefined}
							senderName={
								resolveDisplayName?.(group.sender) ??
								localpartOf(group.sender)
							}
							roomName={resolveRoomName?.(group.room_id) ?? null}
						/>
					))}
				</div>
			)}

			{/* Footer — single destructive action (Clear all).  Mark-
			    all-read is implicit on panel open, so a button for it
			    is redundant noise.  Clear all stays because hard-
			    delete is a different intent than "I've seen these." */}
			{entries.length > 0 ? (
				<div className="border-t border-border/50 p-2 flex items-center justify-end shrink-0">
					<button
						type="button"
						onClick={() => void dismissAll()}
						className={cn(
							"flex items-center gap-1.5 px-3 py-1.5 rounded-md",
							"text-xs font-medium text-muted-foreground",
							"hover:bg-accent hover:text-foreground",
						)}
					>
						<Trash2 className="h-3.5 w-3.5" />
						Clear all
					</button>
				</div>
			) : null}
		</>
	);

	return (
		<>
			{trigger}

			{variant === "fab" ? (
				// Chatbot-style anchored panel — pops up just above
				// the FAB, anchored to the same bottom-right corner.
				// Renders into a portal at body so neither the
				// trigger's React ancestors nor any layout
				// containing-block trapping interferes with the
				// fixed positioning.  The panel ignores the rest of
				// the page (no backdrop overlay) — Intercom / Crisp
				// pattern, fits a passive notification surface that
				// shouldn't gate interaction.
				<ChatbotPanel
					open={open}
					onClose={() => handleOpenChange(false)}
					bellOffsetPx={bellOffset}
				>
					{panelBody}
				</ChatbotPanel>
			) : (
				<Dialog open={open} onOpenChange={handleOpenChange}>
					<DialogContent
						className={cn(
							"sm:max-w-md max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden",
						)}
					>
						<DialogHeader className="sr-only">
							<DialogTitle>Notifications</DialogTitle>
							<DialogDescription>
								Recent mentions, replies, DMs, and invites.
							</DialogDescription>
						</DialogHeader>
						{panelBody}
					</DialogContent>
				</Dialog>
			)}
		</>
	);
}

/** Anchored panel that renders just above the bottom-right corner of
 * the viewport (where the FAB lives).  Glass surface + drop shadow
 * matching the FAB.  Click-outside and Escape close it.  Self-renders
 * a slide-in transition on mount; on close, returns null immediately
 * (no exit animation — parent's `open` toggle is the source of truth
 * and chasing exit-animation lifecycle on top of optimistic state
 * felt heavier than the visual gain).
 *
 * Lives in a portal at document.body so the host's React ancestors
 * (which may have transforms or contain-* properties) can't capture
 * the fixed positioning. */
function ChatbotPanel({
	open,
	onClose,
	children,
	bellOffsetPx,
}: {
	open: boolean;
	onClose(): void;
	children: React.ReactNode;
	/** Extra px the FAB has been pushed up by (sticky pane footers,
	 * etc).  Panel sits above the FAB so it gets the same lift. */
	bellOffsetPx: number;
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	const [mounted, setMounted] = useState(false);

	// Slide-in: render with translateY(8px)+opacity:0 on first paint,
	// then flip to the final values on the next frame.  Browser sees
	// a transition-able state change and animates it.
	useEffect(() => {
		if (!open) {
			setMounted(false);
			return;
		}
		const id = requestAnimationFrame(() => setMounted(true));
		return () => cancelAnimationFrame(id);
	}, [open]);

	// Click-outside: anything outside the panel (or any descendant
	// of the panel) closes.  We deliberately ignore clicks on the
	// FAB itself by checking aria-label — the bell button toggles
	// open/closed via its own onClick, and an outside-click handler
	// firing on the same gesture would race the toggle and leave
	// the panel stuck.
	useEffect(() => {
		if (!open) return;
		const onMouseDown = (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			if (ref.current && ref.current.contains(target)) return;
			// Don't close if the click landed on the bell button
			// itself — let the bell's onClick handle the toggle.
			const closestButton = target.closest('button[aria-label^="Notifications"]');
			if (closestButton) return;
			onClose();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("mousedown", onMouseDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open, onClose]);

	if (!open || typeof document === "undefined") return null;

	return createPortal(
		<div
			ref={ref}
			role="dialog"
			aria-label="Notifications"
			style={{
				position: "fixed",
				// Sit above the FAB.  FAB is at bottom: 1.5rem with
				// height 56px; we add the height + a 12px gap so
				// the panel never overlaps the bell.
				bottom: `calc(env(safe-area-inset-bottom, 0px) + 1.5rem + 56px + 12px + ${bellOffsetPx}px)`,
				right: "calc(env(safe-area-inset-right, 0px) + 1.5rem)",
				width: "min(380px, calc(100vw - 3rem))",
				// max-height reserves ~5rem at the bottom (FAB clearance,
				// 5.75rem to be exact) and ~5.5rem at the top — keeps
				// the panel comfortably inset from the viewport edges
				// on shorter windows where the previous `100dvh - 6rem`
				// crammed it within a few px of the top.
				maxHeight: "min(640px, calc(100dvh - 11rem))",
				zIndex: 41, // one above the FAB so it can't sit behind
				transform: mounted ? "translateY(0)" : "translateY(8px)",
				opacity: mounted ? 1 : 0,
				transition: "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 180ms",
			}}
			className={cn(
				"flex flex-col rounded-2xl overflow-hidden",
				// Themed glass surface — popover bg at 95% alpha so
				// each palette (light + dark) gets its own variant
				// while the backdrop-blur preserves the frosted feel.
				// Previously hardcoded a midnight HSL + force-midnight
				// scope, which made the panel identical regardless of
				// the user's theme choice.
				"bg-popover/95 text-popover-foreground",
				"backdrop-blur-2xl backdrop-saturate-150",
				"border border-border",
				"shadow-2xl",
			)}
		>
			{children}
		</div>,
		document.body,
	);
}

/** Bucket of notifications that share (sender, kind, room).  We
 * collapse runs of similar pings into one row so a burst of DMs
 * from the same person reads as "Alice sent you 4 DMs" instead of
 * four near-identical rows in the bell list. */
interface NotificationGroup {
	key: string;
	sender: string;
	kind: NotificationKind;
	room_id: string;
	/** Always non-empty; sorted newest-first. */
	entries: NotificationEntry[];
	count: number;
	/** The newest entry — drives the snippet, timestamp, and event_id
	 * we navigate to on click. */
	latest: NotificationEntry;
	/** True when AT LEAST ONE entry in the group is unread.  The
	 * row's accent + dot mirror this so a partially-read group still
	 * reads as "needs attention." */
	hasUnread: boolean;
}

/** Group flat notification entries by (sender, kind, room).  Each
 * group's entries are sorted newest-first; the resulting list of
 * groups is sorted by the latest entry's timestamp so the row order
 * still tracks "most recent ping at the top." */
function groupNotifications(entries: NotificationEntry[]): NotificationGroup[] {
	const buckets = new Map<string, NotificationGroup>();
	for (const e of entries) {
		// Invites are inherently single-event (one m.room.member per
		// invite), so they don't really benefit from grouping; keep
		// them in their own bucket per entry id to avoid stomping
		// invites from the same sender into one row.
		const key = e.kind === "invite"
			? `invite|${e.id}`
			: `${e.sender}|${e.kind}|${e.room_id}`;
		let g = buckets.get(key);
		if (!g) {
			g = {
				key,
				sender: e.sender,
				kind: e.kind,
				room_id: e.room_id,
				entries: [],
				count: 0,
				latest: e,
				hasUnread: false,
			};
			buckets.set(key, g);
		}
		g.entries.push(e);
		if (e.read_at === null) g.hasUnread = true;
	}
	for (const g of buckets.values()) {
		g.entries.sort((a, b) => b.created_at - a.created_at);
		g.count = g.entries.length;
		g.latest = g.entries[0]!;
	}
	return [...buckets.values()].sort((a, b) => b.latest.created_at - a.latest.created_at);
}

function NotificationRow({
	group,
	onClick,
	onMarkRead,
	onMuteRoom,
	senderName,
	roomName,
}: {
	group: NotificationGroup;
	onClick(): void;
	// Per-row context-menu actions.  Both optional so callers in
	// limited contexts (no transport / no engine token) can render
	// the row without the menu items.
	onMarkRead?(): void;
	onMuteRoom?(): void;
	senderName: string;
	roomName: string | null;
}) {
	const { Icon, label } = kindRendering(group.kind, group.count);
	const [ctxMenuPos, setCtxMenuPos] = useState<{ x: number; y: number } | null>(null);

	return (
		<button
			type="button"
			onClick={onClick}
			onContextMenu={(e) => {
				if (!onMarkRead && !onMuteRoom) return;
				e.preventDefault();
				e.stopPropagation();
				setCtxMenuPos({ x: e.clientX, y: e.clientY });
			}}
			className={cn(
				"w-full text-left px-4 py-3 flex items-start gap-3",
				"border-b border-border/30 last:border-b-0",
				"hover:bg-accent/40 active:bg-accent/60",
				"transition-colors",
				group.hasUnread && "bg-primary/[0.04]",
			)}
		>
			{/* Kind icon column */}
			<div className={cn(
				"shrink-0 mt-0.5 h-7 w-7 rounded-full flex items-center justify-center relative",
				group.hasUnread ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
			)}>
				<Icon className="h-3.5 w-3.5" />
				{group.count > 1 && (
					// Tiny badge over the icon when the bucket has more
					// than one entry — at-a-glance signal "this is more
					// than one ping" before the eye even reaches the label.
					<span
						className={cn(
							"absolute -top-1 -right-1 min-w-[1rem] h-4 px-1 rounded-full",
							"text-[9px] font-semibold leading-none flex items-center justify-center",
							"bg-primary text-primary-foreground",
						)}
						aria-hidden
					>
						{group.count > 99 ? "99+" : group.count}
					</span>
				)}
			</div>

			{/* Message column */}
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-1.5 text-xs">
					<span className="font-medium text-foreground truncate">
						{senderName}
					</span>
					<span className="text-muted-foreground shrink-0">
						{label}
						{/* DMs: no "in <room>" — DM rooms are
						    typically named after the other
						    participant, so "alice sent you a DM
						    in alice" reads as nonsense.  Mentions
						    / replies / invites: append room name
						    when we have one (the room is the
						    relevant context, not the sender). */}
						{group.kind !== "dm" && roomName ? ` in ${roomName}` : ""}
					</span>
				</div>
				{group.latest.snippet ? (
					<div className="mt-0.5 text-sm text-foreground/90 line-clamp-2 break-words">
						{group.latest.snippet}
					</div>
				) : null}
				<div className="mt-1 text-[10px] text-muted-foreground">
					{formatRelativeTime(group.latest.created_at)}
				</div>
			</div>

			{/* Unread dot */}
			{group.hasUnread ? (
				<div className="shrink-0 mt-2 h-2 w-2 rounded-full bg-primary" aria-hidden />
			) : null}
			{ctxMenuPos && (onMarkRead || onMuteRoom) && (
				<NotificationContextMenu
					x={ctxMenuPos.x}
					y={ctxMenuPos.y}
					hasUnread={group.hasUnread}
					onOpen={onClick}
					onMarkRead={onMarkRead}
					onMuteRoom={onMuteRoom}
					onClose={() => setCtxMenuPos(null)}
				/>
			)}
		</button>
	);
}

function NotificationContextMenu({
	x, y, hasUnread, onOpen, onMarkRead, onMuteRoom, onClose,
}: {
	x: number;
	y: number;
	hasUnread: boolean;
	onOpen(): void;
	onMarkRead?(): void;
	onMuteRoom?(): void;
	onClose(): void;
}) {
	const items: ContextMenuItem[] = [
		{ label: "Open", icon: <MessageSquare className="h-4 w-4" />, onClick: onOpen },
	];
	if (hasUnread && onMarkRead) {
		items.push({ label: "Mark as read", icon: <Check className="h-4 w-4" />, onClick: onMarkRead });
	}
	if (onMuteRoom) {
		items.push({ kind: "divider" });
		items.push({ label: "Mute source room", icon: <Bell className="h-4 w-4" />, onClick: onMuteRoom });
	}
	return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}

function kindRendering(kind: NotificationKind, count: number = 1): { Icon: typeof Bell; label: string } {
	// Singular vs grouped phrasing.  Reads naturally as "Poptart sent
	// you 4 DMs" / "Alice mentioned you 3 times" / "Bob replied to
	// you 2 times" rather than the awkward "Alice mentioned you (4)".
	if (count > 1) {
		switch (kind) {
			case "mention": return { Icon: AtSign,        label: `mentioned you ${count} times` };
			case "reply":   return { Icon: Reply,         label: `replied to you ${count} times` };
			case "dm":      return { Icon: MessageSquare, label: `sent you ${count} DMs` };
			case "invite":  return { Icon: Mail,          label: "invited you" };
			case "system":  return { Icon: SystemIcon,    label: "system" };
			// "message" — fired by the per-room "all messages"
			// notification level.  Reads naturally as "Bob sent 3
			// messages" since the recipient opted into following
			// every message in this room.
			case "message": return { Icon: MessageSquare, label: `sent ${count} messages` };
		}
	}
	switch (kind) {
		case "mention": return { Icon: AtSign,         label: "mentioned you" };
		case "reply":   return { Icon: Reply,          label: "replied to you" };
		case "dm":      return { Icon: MessageSquare,  label: "sent you a DM" };
		case "invite":  return { Icon: Mail,           label: "invited you" };
		case "system":  return { Icon: SystemIcon,     label: "system" };
		case "message": return { Icon: MessageSquare,  label: "sent a message" };
	}
}

function localpartOf(mxid: string): string {
	const at = mxid.indexOf("@");
	const colon = mxid.indexOf(":");
	if (at !== 0 || colon < 2) return mxid;
	return mxid.slice(1, colon);
}

/** Compact "2m" / "1h" / "Apr 5" relative time.  Avoids pulling in
 * a date library; the bell list shows times to the minute granularity
 * which a simple branch handles fine. */
function formatRelativeTime(ts: number): string {
	const diff = Date.now() - ts;
	if (diff < 0) return "just now";
	const sec = Math.floor(diff / 1000);
	if (sec < 60) return "just now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const days = Math.floor(hr / 24);
	if (days < 7) return `${days}d ago`;
	// Older than a week — show actual date, no year (current year is
	// fine; on year change we drop into "Jan 1" which reads fine).
	return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

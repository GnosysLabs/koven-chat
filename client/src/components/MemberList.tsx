// Member list — the right sidebar of a room.  Three-section split:
// "Online" (humans active or recently active), "Bots" (always-on
// services, called out as their own bucket so it's clear what's a
// person vs. a service), and "Offline" (humans we haven't seen
// recently).  No power-level grouping — Koven doesn't have a
// moderator tier (community moderation lives in the engine), so PL
// distinctions other than "creator" don't carry meaning in the UI.
// Bots don't emit Matrix presence reliably; the engine keeps them
// connected so we treat them as a peer category to online humans.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { RepBadge } from "@/components/RepBadge";
import { BotBadge } from "@/components/BotBadge";
import { Ban, UserX } from "lucide-react";
import type { Member } from "@koven/shared";

export interface MemberListProps {
	// `null` = the room's member list hasn't loaded yet (e.g. just
	// switched into the room, member-summary fetch in flight).
	// `[]` = loaded, room is genuinely empty.
	// The distinction matters because the empty-state placeholder
	// ("No members.") would otherwise flash for the brief window
	// between activeRoomId changing and `members_loaded` dispatching.
	members: Member[] | null;
	currentUserId: string | null;
	onSelectMember(userId: string): void;
	// mxids in this Set render with a BOT pill next to the name AND
	// override their presence to "online" (bots are always live as
	// long as the engine is up).  Optional.
	botMxids?: Set<string>;
	// True when the viewer is the founder of the active room — gates
	// the right-click "Kick / Ban bot" menu.  Mirrors the same gate
	// that surfaces the founder-only kick/ban controls in
	// ProfileSheet's "Room moderation" section.
	canKickBanBots?: boolean;
	// Invoked when the founder picks Kick or Ban from the right-click
	// menu on a bot row.  Caller wires this to the same engine
	// endpoint as ProfileSheet's bot moderation buttons.  Includes
	// bots the viewer owns — Settings → Bots is for managing the
	// bot's identity / config across rooms; the right-click menu is
	// the per-room presence gesture, and "remove my bot from this
	// room without deleting it globally" is a legitimate action.
	onBotKickBan?(action: "kick" | "ban", botMxid: string): void | Promise<void>;
}

/** Effective presence for a member.  Bots always read as online;
 * everyone else uses the SDK-reported value (or "offline" if we
 * haven't observed presence for them yet). */
function effectivePresence(m: Member, isBot: boolean): "online" | "unavailable" | "offline" {
	if (isBot) return "online";
	return m.presence ?? "offline";
}

/** Online section catches both "online" (active right now) and
 * "unavailable" (logged in but idle).  Both feel like "they're
 * around"; offline is the only meaningfully different bucket. */
function isInOnlineSection(p: ReturnType<typeof effectivePresence>): boolean {
	return p === "online" || p === "unavailable";
}

export function MemberList({
	members,
	currentUserId,
	onSelectMember,
	botMxids,
	canKickBanBots,
	onBotKickBan,
}: MemberListProps) {
	// Right-click menu state: { x, y, botMxid } when open, null when
	// closed.  The menu is portalled to document.body so it can
	// escape the right-sidebar's clipping bounds.  We position it at
	// the cursor coordinates from the contextmenu event.
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		botMxid: string;
	} | null>(null);
	const [busyAction, setBusyAction] = useState<"kick" | "ban" | null>(null);

	function openContextMenu(e: React.MouseEvent, botMxid: string) {
		// Only intercept right-clicks on actual bots when the viewer
		// has the founder gate.  Anywhere else the browser's default
		// context menu wins.
		if (!canKickBanBots || !onBotKickBan) return;
		e.preventDefault();
		e.stopPropagation();
		setContextMenu({ x: e.clientX, y: e.clientY, botMxid });
	}

	async function handleAction(action: "kick" | "ban") {
		if (!contextMenu || !onBotKickBan || busyAction) return;
		const target = contextMenu.botMxid;
		setBusyAction(action);
		try {
			await onBotKickBan(action, target);
			setContextMenu(null);
		} catch {
			// Caller surfaces the error; we just leave the menu open
			// so the user can retry or dismiss.
		} finally {
			setBusyAction(null);
		}
	}
	// Pre-load: render the chrome (header, scroll container) but
	// nothing inside.  Avoids flashing "No members." or a header
	// reading "Members · 0" while the fetch is still in flight.
	if (members === null) {
		return (
			<aside className="w-56 border-l border-border bg-card flex flex-col">
				<div className="px-4 h-12 flex items-center border-b border-border">
					<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
						Members
					</span>
				</div>
				<div className="flex-1 overflow-y-auto py-2" />
			</aside>
		);
	}

	const decorated = members.map(m => {
		const isBot = !!botMxids?.has(m.userId);
		return { m, isBot, presence: effectivePresence(m, isBot) };
	});

	// Within a section: alphabetical by display name.  Power level is
	// intentionally not part of the sort — see the file header.
	const sortRows = (a: typeof decorated[number], b: typeof decorated[number]) =>
		a.m.displayName.localeCompare(b.m.displayName);

	// Three buckets: bots get their own section between online and
	// offline.  Bots are excluded from the online bucket so we don't
	// double-count them.
	const bots    = decorated.filter(d => d.isBot).sort(sortRows);
	const online  = decorated.filter(d => !d.isBot &&  isInOnlineSection(d.presence)).sort(sortRows);
	const offline = decorated.filter(d => !d.isBot && !isInOnlineSection(d.presence)).sort(sortRows);

	return (
		<aside className="w-56 border-l border-border bg-card flex flex-col">
			<div className="px-4 h-12 flex items-center border-b border-border">
				<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
					Members &middot; {members.length}
				</span>
			</div>
			<div className="flex-1 overflow-y-auto py-2">
				{members.length === 0 ? (
					<div className="text-xs text-muted-foreground px-4 py-3">No members.</div>
				) : (
					<>
						{online.length > 0 && (
							<Section label="Online" count={online.length}>
								{online.map(d => (
									<MemberRow
										key={d.m.userId}
										member={d.m}
										isSelf={d.m.userId === currentUserId}
										isBot={d.isBot}
										presence={d.presence}
										onClick={() => onSelectMember(d.m.userId)}
									/>
								))}
							</Section>
						)}
						{bots.length > 0 && (
							<Section label="Bots" count={bots.length}>
								{bots.map(d => (
									<MemberRow
										key={d.m.userId}
										member={d.m}
										isSelf={d.m.userId === currentUserId}
										isBot={d.isBot}
										presence={d.presence}
										onClick={() => onSelectMember(d.m.userId)}
										onContextMenu={(e) => openContextMenu(e, d.m.userId)}
									/>
								))}
							</Section>
						)}
						{offline.length > 0 && (
							<Section label="Offline" count={offline.length} muted>
								{offline.map(d => (
									<MemberRow
										key={d.m.userId}
										member={d.m}
										isSelf={d.m.userId === currentUserId}
										isBot={d.isBot}
										presence={d.presence}
										onClick={() => onSelectMember(d.m.userId)}
									/>
								))}
							</Section>
						)}
					</>
				)}
			</div>
			{contextMenu && (
				<BotContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					busyAction={busyAction}
					onAction={handleAction}
					onClose={() => setContextMenu(null)}
				/>
			)}
		</aside>
	);
}

/** Floating two-item menu (Kick / Ban) anchored to the cursor's
 * coordinates.  Portalled to document.body so it can render above
 * the right sidebar's clipping bounds and over the chat pane.
 *
 * Dismissed by:
 *   - Escape
 *   - mousedown anywhere outside the menu (any button — left, right,
 *     middle).  Right-click especially: if you right-click again on
 *     a different row we want the menu to relocate, not stack.
 *   - Successful action (handled by the parent via onAction →
 *     onClose).
 */
function BotContextMenu({
	x,
	y,
	busyAction,
	onAction,
	onClose,
}: {
	x: number;
	y: number;
	busyAction: "kick" | "ban" | null;
	onAction(action: "kick" | "ban"): void;
	onClose(): void;
}) {
	const ref = useRef<HTMLDivElement | null>(null);

	// Outside-click + Escape dismissal.  We listen on `mousedown`
	// rather than `click` so a fresh right-click on another row
	// closes us before that row's onContextMenu handler fires —
	// otherwise the second open would race the first close and the
	// menu would flicker shut.
	useEffect(() => {
		const onDown = (e: MouseEvent) => {
			if (!ref.current) return;
			if (ref.current.contains(e.target as Node)) return;
			onClose();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [onClose]);

	if (typeof document === "undefined") return null;

	// Clamp x/y so the menu doesn't escape the viewport on right-
	// edge or bottom-edge clicks.  Approx menu size is 160x76; using
	// generous slack so we don't have to measure.
	const menuW = 168;
	const menuH = 80;
	const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
	const vh = typeof window !== "undefined" ? window.innerHeight : 800;
	const left = Math.min(x, vw - menuW - 8);
	const top = Math.min(y, vh - menuH - 8);

	return createPortal(
		<div
			ref={ref}
			role="menu"
			style={{ position: "fixed", left, top, zIndex: 60 }}
			className={cn(
				"min-w-[10.5rem] rounded-md border border-border bg-popover text-popover-foreground shadow-md",
				"py-1 text-sm",
			)}
			// Block the native context menu on the menu itself —
			// otherwise a second right-click inside the menu would
			// open a nested browser context menu over our menu.
			onContextMenu={(e) => e.preventDefault()}
		>
			<button
				type="button"
				role="menuitem"
				onClick={() => onAction("kick")}
				disabled={!!busyAction}
				className={cn(
					"w-full px-3 py-1.5 text-left flex items-center gap-2",
					"text-amber-500 hover:bg-amber-500/10 disabled:opacity-50",
				)}
			>
				<UserX className="h-4 w-4" />
				{busyAction === "kick" ? "Kicking…" : "Kick bot"}
			</button>
			<button
				type="button"
				role="menuitem"
				onClick={() => onAction("ban")}
				disabled={!!busyAction}
				className={cn(
					"w-full px-3 py-1.5 text-left flex items-center gap-2",
					"text-destructive hover:bg-destructive/10 disabled:opacity-50",
				)}
			>
				<Ban className="h-4 w-4" />
				{busyAction === "ban" ? "Banning…" : "Ban bot"}
			</button>
		</div>,
		document.body,
	);
}

function Section({
	label, count, muted, children,
}: {
	label: string;
	count: number;
	muted?: boolean;
	children: React.ReactNode;
}) {
	return (
		<section className="mb-3">
			<h3 className="px-4 mb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
				{label} &middot; {count}
			</h3>
			<ul className={muted ? "opacity-70" : undefined}>{children}</ul>
		</section>
	);
}

function MemberRow({
	member, isSelf, isBot, presence, onClick, onContextMenu,
}: {
	member: Member;
	isSelf: boolean;
	isBot: boolean;
	presence: "online" | "unavailable" | "offline";
	onClick(): void;
	// Right-click handler.  Set on bot rows when the viewer is the
	// room founder; opens the kick/ban menu (see openContextMenu in
	// MemberList).  Undefined elsewhere — the browser's default
	// context menu wins on those rows.
	onContextMenu?(e: React.MouseEvent): void;
}) {
	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				onContextMenu={onContextMenu}
				className={cn(
					"w-full px-4 py-1 flex items-center gap-2 text-sm text-left hover:bg-accent transition-colors",
					isSelf && "font-medium",
					presence === "offline" && "text-muted-foreground",
				)}
				title={member.userId}
			>
				<Avatar member={member} isBot={isBot} presence={presence} />
				<span className="flex-1 truncate flex items-center gap-1.5">
					<span className="truncate">{member.displayName}</span>
					{isBot && <BotBadge />}
				</span>
				{!isBot && <RepBadge userId={member.userId} />}
			</button>
		</li>
	);
}

function Avatar({
	member, isBot, presence,
}: {
	member: Member;
	isBot: boolean;
	presence: "online" | "unavailable" | "offline";
}) {
	// Status dot overlays the bottom-right of the avatar.  Color
	// codes:
	//   - online      = solid green (active right now)
	//   - unavailable = amber (logged in but idle / recently
	//                   active — the matrix-spec equivalent of
	//                   "away")
	//   - offline     = empty / grey ring (don't draw a dot at all,
	//                   keeps the avatar gutter quiet for the
	//                   majority case in most rooms)
	const dotClass =
		presence === "online" ? "bg-green-500"
		: presence === "unavailable" ? "bg-amber-500"
		: null;
	return (
		<span className="relative shrink-0">
			<MatrixAvatar
				mxc={member.avatarUrl}
				seed={member.userId}
				kind={isBot ? "bot" : "user"}
				className={cn(
					"h-6 w-6",
					presence === "offline" && !isBot && "grayscale opacity-70",
				)}
			/>
			{dotClass && (
				<span
					className={cn(
						"absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-card",
						dotClass,
					)}
					aria-hidden
				/>
			)}
		</span>
	);
}

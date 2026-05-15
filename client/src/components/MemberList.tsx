// Member list — the right sidebar of a room.  Three-section split:
// "Online" (humans active or recently active), "Bots" (always-on
// services, called out as their own bucket so it's clear what's a
// person vs. a service), and "Offline" (humans we haven't seen
// recently).  Sections are still presence-based, not role-based —
// rooms are small enough that a separate "Admins" bucket would
// fragment the roster more than it would help.  Role badges
// (admin star, moderator shield) render inline on the row instead,
// driven by Member.powerLevel.
// Bots don't emit Matrix presence reliably; the engine keeps them
// connected so we treat them as a peer category to online humans.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { BotBadge } from "@/components/BotBadge";
import { Ban, Copy, Crown, MessageSquare, Shield, ShieldOff, User, UserX } from "lucide-react";
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
	// Optional banner image: when the active room has a custom
	// avatar (Room.avatarUrl, raw mxc) AND no iconEmoji override,
	// render it prominently at the top of the sidebar above the
	// member list.  Skipped for emoji-iconed rooms (the emoji is
	// already shown in the chat header) and for rooms with no
	// avatar at all (DiceBear fallback isn't worth a banner).
	roomAvatarUrl?: string;
	// Used as the alt text + the visual seed for the (intentionally
	// unused, since we only render the banner when a real mxc is
	// set) DiceBear fallback inside MatrixAvatar.
	roomId?: string;
	roomName?: string;
	// mxids in this Set render with a BOT pill next to the name AND
	// override their presence to "online" (bots are always live as
	// long as the engine is up).  Optional.
	botMxids?: Set<string>;
	// mxids to omit from the rendered list entirely.  Used to hide
	// system identities like the appservice's @engine bot — it's
	// joined to every room so it can write moderation events, but
	// it's a platform identity not a participant and shouldn't show
	// up next to humans.
	hiddenUserIds?: Set<string>;
	// True when there's a parent space context available for the active
	// room.  Required for either bot-moderation path; without a parent
	// space the right-click kick/ban affordance is hidden because the
	// engine endpoint works only at space scope.
	canKickBanBots?: boolean;
	// True iff the viewer is the founder of the active room's parent
	// space.  Distinguishes the two right-click affordances:
	//
	//   - founder (any bot)     → "Kick from space" / "Ban from space"
	//   - bot owner (own bot)   → "Remove from space"
	//
	// When neither holds for a given bot row, the moderation menu
	// section is suppressed entirely.
	isSpaceFounder?: boolean;
	// Set of bot mxids the viewer owns.  Used to label / authorize
	// the "Remove my bot from space" path for non-founder owners.
	// Optional; when omitted, treated as empty (the right-click
	// owner path is unavailable).
	myOwnedBotMxids?: Set<string>;
	// Invoked when the user picks Kick / Ban / Remove from the
	// right-click menu on a bot row.  Caller wires this to the
	// space-wide engine endpoint; the action string maps to the
	// engine's `kick` / `ban` action (Remove is sent as `kick`).
	onBotKickBan?(action: "kick" | "ban", botMxid: string): void | Promise<void>;
	// Invoked when the user picks "Send DM" from the right-click
	// menu.  Caller routes to the existing transport.startDm /
	// active-room flow.
	onStartDm?(userId: string): void | Promise<void>;

	// ─── Standard admin moderation (PL ≥ 50) ─────────────────────
	// Enables the kick / ban / role-change items on HUMAN rows.  Bots
	// keep their existing space-wide path above (onBotKickBan).
	canModerateRoom?: boolean;
	onKickMember?(userId: string, reason?: string): void | Promise<void>;
	onBanMember?(userId: string, reason?: string): void | Promise<void>;
	onPromoteToMod?(userId: string): void | Promise<void>;
	onPromoteToAdmin?(userId: string): void | Promise<void>;
	onResetRole?(userId: string): void | Promise<void>;
}

/** Effective presence for a member.  Bots always read as online;
 * everyone else uses the SDK-reported value (or "offline" if we
 * haven't observed presence for them yet). */
function effectivePresence(m: Member, isBot: boolean): "online" | "unavailable" | "offline" {
	if (isBot) return "online";
	return m.presence ?? "offline";
}

/** Four sections in display order: Online (green), Away (amber,
 * idle / hidden tab / blurred window), Bots, Offline.  Away is
 * surfaced separately rather than folded into Online so the room
 * roster signals who's actually around right now vs. who's
 * technically logged in but unresponsive, which matters for
 * coordinating real-time conversation.  Per-user dot colour is
 * unchanged: green for online, amber for unavailable, nothing for
 * offline. */
function isOnlinePresence(p: ReturnType<typeof effectivePresence>): boolean {
	return p === "online";
}

function isAwayPresence(p: ReturnType<typeof effectivePresence>): boolean {
	return p === "unavailable";
}

export function MemberList({
	members,
	currentUserId,
	onSelectMember,
	botMxids,
	hiddenUserIds,
	canKickBanBots,
	isSpaceFounder,
	myOwnedBotMxids,
	onBotKickBan,
	onStartDm,
	roomAvatarUrl,
	roomId,
	roomName,
	canModerateRoom,
	onKickMember,
	onBanMember,
	onPromoteToMod,
	onPromoteToAdmin,
	onResetRole,
}: MemberListProps) {
	// Right-click menu state.  Stored as the targeted member +
	// cursor coords; null when the menu is closed.  We portal the
	// menu to document.body so it can escape the right-sidebar's
	// clipping bounds and overflow over the chat pane.
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		userId: string;
		isBot: boolean;
		isSelf: boolean;
		isMyBot: boolean;
	} | null>(null);
	const [busyAction, setBusyAction] = useState<string | null>(null);

	function openContextMenu(
		e: React.MouseEvent,
		row: { userId: string; isBot: boolean; isSelf: boolean },
	) {
		e.preventDefault();
		e.stopPropagation();
		const isMyBot = row.isBot && !!myOwnedBotMxids?.has(row.userId);
		setContextMenu({ x: e.clientX, y: e.clientY, ...row, isMyBot });
	}

	async function handleAction(action: MemberAction) {
		if (!contextMenu || busyAction) return;
		const target = contextMenu.userId;

		// Confirm gates for the destructive / permission-altering
		// branches.  Each variant gets its own copy so admins know
		// exactly what they're about to do.
		const confirmCopy: Partial<Record<MemberAction, string>> = {
			kick_member:    `Kick ${target} from the entire space? They'll be removed from every room in this space.`,
			ban_member:     `Ban ${target} from the entire space? They'll be removed from every room and won't be able to rejoin until unbanned.`,
			promote_mod:    `Promote ${target} to Moderator across the entire space (PL 50)? They'll be able to kick/ban/redact in every room.`,
			promote_admin:  `Promote ${target} to Admin across the entire space (PL 100)? They'll be able to moderate you back and edit space settings.`,
			reset_role:     `Reset ${target} to a regular member across the entire space (PL 0)?`,
		};
		const copy = confirmCopy[action];
		if (copy && typeof window !== "undefined" && !window.confirm(copy)) {
			return;
		}

		setBusyAction(action);
		try {
			if (action === "dm" && onStartDm) {
				await onStartDm(target);
			} else if (action === "profile") {
				onSelectMember(target);
			} else if (action === "copy") {
				try { await navigator.clipboard.writeText(target); } catch { /* no-op */ }
			} else if ((action === "kick" || action === "ban") && onBotKickBan) {
				await onBotKickBan(action, target);
			} else if (action === "kick_member" && onKickMember) {
				await onKickMember(target);
			} else if (action === "ban_member" && onBanMember) {
				await onBanMember(target);
			} else if (action === "promote_mod" && onPromoteToMod) {
				await onPromoteToMod(target);
			} else if (action === "promote_admin" && onPromoteToAdmin) {
				await onPromoteToAdmin(target);
			} else if (action === "reset_role" && onResetRole) {
				await onResetRole(target);
			}
			setContextMenu(null);
		} catch {
			// Caller surfaces the error; we just leave the menu open
			// so the user can retry or dismiss.
		} finally {
			setBusyAction(null);
		}
	}
	// Pre-load: render the chrome (banner if applicable, header,
	// scroll container) but no rows inside.  Banner stays during
	// load so the sidebar's vertical layout doesn't jump when
	// members arrive.
	if (members === null) {
		return (
			<aside className="w-56 border-l border-border bg-card flex flex-col">
				{roomAvatarUrl && (
					<div className="px-4 pt-4 pb-3 border-b border-border flex flex-col items-center gap-2">
						<MatrixAvatar
							mxc={roomAvatarUrl}
							seed={roomId ?? ""}
							kind="user"
							className="h-32 w-32 rounded-md"
						/>
						{roomName && (
							<div className="text-sm font-medium text-foreground text-center truncate w-full" title={roomName}>
								{roomName}
							</div>
						)}
					</div>
				)}
				<div className="px-4 h-12 flex items-center border-b border-border">
					<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
						Members
					</span>
				</div>
				<div className="flex-1 overflow-y-auto py-2" />
			</aside>
		);
	}

	// Drop hidden mxids before any sorting / sectioning so the
	// "Members · N" header count and the section counts match
	// what's actually rendered.  Used today for the appservice's
	// @engine bot which is joined to every room but shouldn't show
	// up next to humans — it's a platform identity, not a peer.
	const visibleMembers = hiddenUserIds && hiddenUserIds.size > 0
		? members.filter(m => !hiddenUserIds.has(m.userId))
		: members;

	const decorated = visibleMembers.map(m => {
		const isBot = !!botMxids?.has(m.userId);
		return { m, isBot, presence: effectivePresence(m, isBot) };
	});

	// Within a section: alphabetical by display name.  Power level is
	// intentionally not part of the sort — see the file header.
	const sortRows = (a: typeof decorated[number], b: typeof decorated[number]) =>
		a.m.displayName.localeCompare(b.m.displayName);

	// Four buckets: Online → Away → Bots → Offline.  Bots are
	// excluded from the human buckets so they don't double-count.
	const bots    = decorated.filter(d => d.isBot).sort(sortRows);
	const online  = decorated.filter(d => !d.isBot && isOnlinePresence(d.presence)).sort(sortRows);
	const away    = decorated.filter(d => !d.isBot && isAwayPresence(d.presence)).sort(sortRows);
	const offline = decorated.filter(d => !d.isBot && !isOnlinePresence(d.presence) && !isAwayPresence(d.presence)).sort(sortRows);

	return (
		<aside className="w-56 border-l border-border bg-card flex flex-col">
			{/* Room avatar banner.  Only rendered when the active
			    room has a real uploaded image (mxc).  Square, full
			    sidebar width, rounded; the centred-image proportion
			    matches Discord / Telegram / Slack's room-info pane
			    so users coming from those clients read it the same
			    way.  Below the image we put the room name as a
			    secondary cue — useful in long sessions where the
			    chat header has scrolled out of casual view.  The
			    block is fixed-height (no scroll inside this section)
			    so the member list below still scrolls cleanly. */}
			{roomAvatarUrl && (
				<div className="px-4 pt-4 pb-3 border-b border-border flex flex-col items-center gap-2">
					<MatrixAvatar
						mxc={roomAvatarUrl}
						seed={roomId ?? ""}
						kind="user"
						className="h-32 w-32 rounded-md"
					/>
					{roomName && (
						<div className="text-sm font-medium text-foreground text-center truncate w-full" title={roomName}>
							{roomName}
						</div>
					)}
				</div>
			)}
			<div className="px-4 h-12 flex items-center border-b border-border">
				<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
					Members &middot; {visibleMembers.length}
				</span>
			</div>
			<div className="flex-1 overflow-y-auto py-2">
				{visibleMembers.length === 0 ? (
					<div className="text-xs text-muted-foreground px-4 py-3">No members.</div>
				) : (
					<>
						{online.length > 0 && (
							<Section label="Online" count={online.length}>
								{online.map(d => {
									const isSelf = d.m.userId === currentUserId;
									return (
										<MemberRow
											key={d.m.userId}
											member={d.m}
											isSelf={isSelf}
											isBot={d.isBot}
											presence={d.presence}
											onClick={() => onSelectMember(d.m.userId)}
											onContextMenu={(e) => openContextMenu(e, { userId: d.m.userId, isBot: d.isBot, isSelf })}
										/>
									);
								})}
							</Section>
						)}
						{away.length > 0 && (
							<Section label="Away" count={away.length}>
								{away.map(d => {
									const isSelf = d.m.userId === currentUserId;
									return (
										<MemberRow
											key={d.m.userId}
											member={d.m}
											isSelf={isSelf}
											isBot={d.isBot}
											presence={d.presence}
											onClick={() => onSelectMember(d.m.userId)}
											onContextMenu={(e) => openContextMenu(e, { userId: d.m.userId, isBot: d.isBot, isSelf })}
										/>
									);
								})}
							</Section>
						)}
						{bots.length > 0 && (
							<Section label="Bots" count={bots.length}>
								{bots.map(d => {
									const isSelf = d.m.userId === currentUserId;
									return (
										<MemberRow
											key={d.m.userId}
											member={d.m}
											isSelf={isSelf}
											isBot={d.isBot}
											presence={d.presence}
											onClick={() => onSelectMember(d.m.userId)}
											onContextMenu={(e) => openContextMenu(e, { userId: d.m.userId, isBot: d.isBot, isSelf })}
										/>
									);
								})}
							</Section>
						)}
						{offline.length > 0 && (
							<Section label="Offline" count={offline.length} muted>
								{offline.map(d => {
									const isSelf = d.m.userId === currentUserId;
									return (
										<MemberRow
											key={d.m.userId}
											member={d.m}
											isSelf={isSelf}
											isBot={d.isBot}
											presence={d.presence}
											onClick={() => onSelectMember(d.m.userId)}
											onContextMenu={(e) => openContextMenu(e, { userId: d.m.userId, isBot: d.isBot, isSelf })}
										/>
									);
								})}
							</Section>
						)}
					</>
				)}
			</div>
			{contextMenu && (
				<MemberContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					isBot={contextMenu.isBot}
					isSelf={contextMenu.isSelf}
					isMyBot={contextMenu.isMyBot}
					isSpaceFounder={!!isSpaceFounder}
					canKickBan={!!canKickBanBots && !!onBotKickBan}
					canDm={!!onStartDm}
					canModerateRoom={!!canModerateRoom}
					canKickMember={!!onKickMember}
					canBanMember={!!onBanMember}
					canPromoteToMod={!!onPromoteToMod}
					canPromoteToAdmin={!!onPromoteToAdmin}
					canResetRole={!!onResetRole}
					busyAction={busyAction}
					onAction={handleAction}
					onClose={() => setContextMenu(null)}
				/>
			)}
		</aside>
	);
}

type MemberAction =
	| "dm"
	| "profile"
	| "copy"
	// Bot-targeted, space-wide.  Wired through onBotKickBan.
	| "kick"
	| "ban"
	// Human-targeted, room-scoped admin moderation (PL ≥ 50).
	| "kick_member"
	| "ban_member"
	| "promote_mod"
	| "promote_admin"
	| "reset_role";

/** Floating context menu for member rows.  Items vary by target:
 *
 *   - Anyone (non-self): View profile, Send DM (when canDm),
 *     Copy user ID
 *   - Self: View profile, Copy user ID (no DM-yourself)
 *   - Bot + viewer is space founder (target is NOT viewer's own bot):
 *     extra Kick / Ban from space moderation items
 *   - Bot + target IS viewer's own bot + viewer is NOT the space
 *     founder: "Remove from space" item (issued as a `kick` action
 *     that the engine resolves into a voluntary leave under the
 *     bot's own token)
 *
 * Portalled to document.body so it can render above the right
 * sidebar's clipping bounds and over the chat pane.  Dismissed by
 * Escape, outside mousedown (any button — right-click again on a
 * different row relocates the menu rather than stacking), or a
 * successful action.
 */
function MemberContextMenu({
	x,
	y,
	isBot,
	isSelf,
	isMyBot,
	isSpaceFounder,
	canKickBan,
	canDm,
	canModerateRoom,
	canKickMember,
	canBanMember,
	canPromoteToMod,
	canPromoteToAdmin,
	canResetRole,
	busyAction,
	onAction,
	onClose,
}: {
	x: number;
	y: number;
	isBot: boolean;
	isSelf: boolean;
	isMyBot: boolean;
	isSpaceFounder: boolean;
	canKickBan: boolean;
	canDm: boolean;
	canModerateRoom: boolean;
	canKickMember: boolean;
	canBanMember: boolean;
	canPromoteToMod: boolean;
	canPromoteToAdmin: boolean;
	canResetRole: boolean;
	busyAction: string | null;
	onAction(action: MemberAction): void;
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

	// Cursor clamp.  Menu is roughly 180x{40 per item}; assume up
	// to 6 items (~240px) and clamp generously so it never escapes
	// the viewport.
	const menuW = 200;
	const menuH = 240;
	const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
	const vh = typeof window !== "undefined" ? window.innerHeight : 800;
	const left = Math.min(x, vw - menuW - 8);
	const top = Math.min(y, vh - menuH - 8);

	const showDm = !isSelf && canDm;
	// Founder branch: full Kick / Ban affordance against ANY bot in
	// the space — including the founder's own.  A founder who also
	// owns the bot wanting it out of their own space is a real case
	// (e.g. retiring a moderation bot from a community without
	// deleting it instance-wide), and the engine endpoint handles
	// it through the PL-based kick path identically.
	const showFounderKickBan = isBot && !isSelf && canKickBan && isSpaceFounder;
	// Owner branch: "Remove my bot from this space" for bot owners
	// who aren't also the space founder.  Mutually exclusive with
	// showFounderKickBan — if the viewer is the founder we don't
	// double-up.
	const showOwnerRemove = isBot && !isSelf && canKickBan && isMyBot && !isSpaceFounder;
	// Standard admin moderation branch: surfaced when the viewer has
	// PL ≥ 50 in the room AND the target is a human (not a bot — bots
	// have their own space-wide path above) AND not the viewer
	// themselves.  Each individual item is then guarded by its own
	// can* handler so callers can omit handlers without flipping the
	// whole branch off.
	const showAdminModeration =
		!isBot
		&& !isSelf
		&& canModerateRoom
		&& (canKickMember || canBanMember || canPromoteToMod || canPromoteToAdmin || canResetRole);

	return createPortal(
		<div
			ref={ref}
			role="menu"
			style={{ position: "fixed", left, top, zIndex: 60 }}
			className={cn(
				"min-w-[12rem] rounded-md border border-border bg-popover text-popover-foreground shadow-md",
				"py-1 text-sm",
			)}
			// Block the native context menu on the menu itself —
			// otherwise a second right-click inside the menu would
			// open a nested browser context menu over our menu.
			onContextMenu={(e) => e.preventDefault()}
		>
			<MenuItem
				icon={<User className="h-4 w-4" />}
				label="View profile"
				onClick={() => onAction("profile")}
				disabled={!!busyAction}
			/>
			{showDm && (
				<MenuItem
					icon={<MessageSquare className="h-4 w-4" />}
					label={busyAction === "dm" ? "Opening…" : "Send direct message"}
					onClick={() => onAction("dm")}
					disabled={!!busyAction}
				/>
			)}
			<MenuItem
				icon={<Copy className="h-4 w-4" />}
				label={busyAction === "copy" ? "Copied" : "Copy username"}
				onClick={() => onAction("copy")}
				disabled={!!busyAction}
			/>
			{showFounderKickBan && (
				<>
					<div className="my-1 h-px bg-border" aria-hidden />
					<MenuItem
						icon={<UserX className="h-4 w-4" />}
						label={busyAction === "kick" ? "Kicking…" : "Kick bot from space"}
						onClick={() => onAction("kick")}
						disabled={!!busyAction}
						tone="warn"
					/>
					<MenuItem
						icon={<Ban className="h-4 w-4" />}
						label={busyAction === "ban" ? "Banning…" : "Ban bot from space"}
						onClick={() => onAction("ban")}
						disabled={!!busyAction}
						tone="danger"
					/>
				</>
			)}
			{showOwnerRemove && (
				<>
					<div className="my-1 h-px bg-border" aria-hidden />
					<MenuItem
						icon={<UserX className="h-4 w-4" />}
						label={busyAction === "kick" ? "Removing…" : "Remove my bot from space"}
						onClick={() => onAction("kick")}
						disabled={!!busyAction}
						tone="warn"
					/>
				</>
			)}
			{showAdminModeration && (
				<>
					<div className="my-1 h-px bg-border" aria-hidden />
					{canPromoteToMod && (
						<MenuItem
							icon={<Shield className="h-4 w-4" />}
							label={busyAction === "promote_mod" ? "Promoting…" : "Promote to Moderator"}
							onClick={() => onAction("promote_mod")}
							disabled={!!busyAction}
						/>
					)}
					{canPromoteToAdmin && (
						<MenuItem
							icon={<Crown className="h-4 w-4" />}
							label={busyAction === "promote_admin" ? "Promoting…" : "Promote to Admin"}
							onClick={() => onAction("promote_admin")}
							disabled={!!busyAction}
						/>
					)}
					{canResetRole && (
						<MenuItem
							icon={<ShieldOff className="h-4 w-4" />}
							label={busyAction === "reset_role" ? "Resetting…" : "Reset to Member"}
							onClick={() => onAction("reset_role")}
							disabled={!!busyAction}
						/>
					)}
					{canKickMember && (
						<MenuItem
							icon={<UserX className="h-4 w-4" />}
							label={busyAction === "kick_member" ? "Kicking…" : "Kick from space"}
							onClick={() => onAction("kick_member")}
							disabled={!!busyAction}
							tone="warn"
						/>
					)}
					{canBanMember && (
						<MenuItem
							icon={<Ban className="h-4 w-4" />}
							label={busyAction === "ban_member" ? "Banning…" : "Ban from space"}
							onClick={() => onAction("ban_member")}
							disabled={!!busyAction}
							tone="danger"
						/>
					)}
				</>
			)}
		</div>,
		document.body,
	);
}

/** Single context-menu row.  Tone drives the colour: default for
 * neutral actions (View profile, DM, Copy), warn for kick (recoverable),
 * danger for ban (destructive). */
function MenuItem({
	icon, label, onClick, disabled, tone = "default",
}: {
	icon: React.ReactNode;
	label: string;
	onClick(): void;
	disabled: boolean;
	tone?: "default" | "warn" | "danger";
}) {
	const toneClass =
		tone === "warn" ? "text-amber-500 hover:bg-amber-500/10"
		: tone === "danger" ? "text-destructive hover:bg-destructive/10"
		: "hover:bg-accent";
	return (
		<button
			type="button"
			role="menuitem"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"w-full px-3 py-1.5 text-left flex items-center gap-2 disabled:opacity-50",
				toneClass,
			)}
		>
			{icon}
			{label}
		</button>
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
	// Role badge — small icon next to the name reflecting the
	// member's effective power level in this room.  Roles are space-
	// wide in Koven (promotions fan out across every child + the
	// space itself), so the room-level PL we observe here is the
	// same value across the whole space in normal operation.  An
	// admin (founder or anyone they promoted to PL 100) gets a gold
	// star; a moderator (50 ≤ PL < 100) gets an amber shield.
	// Members and bots without an explicit PL bump (PL < 50, which
	// is the users_default of 0 for the vast majority) get nothing
	// so the roster doesn't look like a parade of icons.
	const role: "admin" | "mod" | null =
		member.powerLevel >= 100 ? "admin"
		: member.powerLevel >= 50 ? "mod"
		: null;
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
				title={member.userId.replace(/:.*$/, "")}
			>
				<Avatar member={member} isBot={isBot} presence={presence} />
				<span className="flex-1 truncate flex items-center gap-1.5">
					<span className="truncate">{member.displayName}</span>
					{role === "admin" && (
						// Wrapping span carries the tooltip — lucide SVGs
						// don't reliably pass a child <title> across
						// versions, so a `title` attribute on a wrapper is
						// the portable hover-text surface.
						<span title={`Admin · PL ${member.powerLevel}`} aria-label="Admin" className="inline-flex shrink-0">
							<Crown className="h-3.5 w-3.5 text-amber-400 fill-amber-400/80" />
						</span>
					)}
					{role === "mod" && (
						<span title={`Moderator · PL ${member.powerLevel}`} aria-label="Moderator" className="inline-flex shrink-0">
							<Shield className="h-3.5 w-3.5 text-amber-500 fill-amber-500/20" />
						</span>
					)}
					{isBot && <BotBadge />}
				</span>
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

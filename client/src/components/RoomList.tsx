// Second column — the room list scoped to whatever's selected in the
// SpaceBar.
//   - Home: every DM the user is in, plus rooms not assigned to any
//     space ("orphan" rooms).
//   - A specific space: only rooms whose parentSpaceIds include that
//     space's id.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { COLLAPSED_NAME } from "@/lib/collapsedRooms";
import type { Room, RoomId, Space, UserId } from "@koven/shared";
import { BellOff, Check, Copy, EyeOff, Globe, Lock, Pin, Plus, UserX, X } from "lucide-react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { RoomRowContextMenu } from "@/components/RoomRowContextMenu";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { getRoomNotifyLevel, onNotifyPrefsChanged } from "@/lib/notifyPrefs";
import type { ActiveSpace } from "@/state/store";
import type { MatrixTransport } from "@/lib/matrix";

export interface RoomListProps {
	rooms: Room[];
	spaces: Space[];
	activeSpace: ActiveSpace;
	activeRoomId: RoomId | null;
	// Current user's mxid.  Used to gate the "+ create room" button
	// inside a space — only the space creator should be able to
	// surface that affordance.  See the create-room-in-space gate
	// below for why: non-creators can technically create a new room,
	// but the m.space.child link state event requires PL 100, so the
	// link silently fails and they end up with an orphan room they
	// thought they put in the space.  Hide the button to stop the
	// footgun before it produces orphans.
	currentUserId: UserId;
	onSelectRoom(roomId: RoomId): void;
	onCreateRoom(): void;
	onAcceptInvite(roomId: RoomId): void | Promise<void>;
	onDeclineInvite(roomId: RoomId): void | Promise<void>;
	// Pin / unpin a room within a space.  Space-scoped: pins are
	// visible to everyone in the space and require state-event
	// permission to set.  Only meaningful when activeSpace is a real
	// user-created space.  Receives the space id so the transport
	// knows where to write the `chat.koven.pinned_rooms` event.
	onPinRoom?(spaceId: string, roomId: RoomId): void | Promise<void>;
	onUnpinRoom?(spaceId: string, roomId: RoomId): void | Promise<void>;
	// Set of room ids the engine reports as collapsed (offensive room
	// name pipeline).  Sidebar entries for these rooms render with the
	// "Name Removed by Community Review" placeholder instead of the
	// verbatim name.
	collapsedRoomIds?: Set<string>;
	// True once matrix-js-sdk's initial /sync has produced a populated
	// rooms list at least once.  RoomList suppresses the "No rooms in
	// this space yet" hint while false — without this gate, switching
	// space tabs (or first-paint after sign-in) flashes the empty
	// hint for a frame before the reducer fans the rooms in.
	roomsLoaded?: boolean;
	// Transport + access token are needed for the right-click context
	// menu's actions (notification-level prefs, leave room, etc.).
	// Both optional so RoomList can still render in test / preview
	// contexts where there's no live transport — context menu items
	// that need them are filtered out when missing.
	transport?: MatrixTransport | null;
	accessToken?: string | null;
	// Action callbacks driven by the right-click menu — open the
	// edit-room sheet, open a user profile (DM rows), etc.  Owned
	// by App.tsx since they manipulate App-level overlay state.
	onEditRoom?(roomId: RoomId): void;
	onOpenProfile?(userId: UserId): void;
	// Set of mxids known to be bots.  Used by the per-row avatar
	// to pick the right DiceBear style for bot DMs (kind="bot" →
	// bottts robot fallback) instead of the default kind="user"
	// fun-emoji face.  Without this the DM sidebar shows a yellow
	// smiley for a bot DM while the same conversation's chat
	// header + profile show the bot robot — visibly inconsistent.
	botMxids?: Set<UserId>;
}

// PL gate for editing the space's `chat.koven.pinned_rooms` state
// event.  Matches the rest of the UI (Settings sheet, Add Room) which
// also use ≥ 50.  Koven's createSpace sets state_default to 100, so in
// practice this still resolves to founder-only on Koven-created spaces;
// the looser gate matters for spaces created outside our flow.
const PIN_PL_THRESHOLD = 50;

export function RoomList({
	rooms, spaces, activeSpace, activeRoomId, currentUserId,
	onSelectRoom, onCreateRoom, onAcceptInvite, onDeclineInvite,
	onPinRoom, onUnpinRoom, collapsedRoomIds,
	roomsLoaded, transport, accessToken,
	onEditRoom, onOpenProfile, botMxids,
}: RoomListProps) {
	const activeSpaceObj = activeSpace?.kind === "space"
		? spaces.find(s => s.id === activeSpace.id) ?? null
		: null;
	const pinnedRoomIds = activeSpaceObj?.pinnedRoomIds ?? [];
	const pinnedRoomIdSet = new Set(pinnedRoomIds);
	const canManagePins = !!activeSpaceObj && (activeSpaceObj.myPowerLevel ?? 0) >= PIN_PL_THRESHOLD;

	const visibleRooms = filterRooms(rooms, activeSpace);
	// Pending invites bubble to the top of the list as request rows
	// with inline Accept/Decline buttons; "joined" rooms render as the
	// usual clickable conversation rows below.
	const inviteRooms = visibleRooms.filter(r => r.isInvite);
	const joinedRooms = sortWithPinnedFirst(
		visibleRooms.filter(r => !r.isInvite),
		pinnedRoomIds,
	);
	const header = headerFor(activeSpace, spaces);

	const pinHandler = (roomId: RoomId) => {
		if (!activeSpaceObj || !onPinRoom) return undefined;
		const spaceId = activeSpaceObj.id;
		return () => onPinRoom(spaceId, roomId);
	};
	const unpinHandler = (roomId: RoomId) => {
		if (!activeSpaceObj || !onUnpinRoom) return undefined;
		const spaceId = activeSpaceObj.id;
		return () => onUnpinRoom(spaceId, roomId);
	};

	// Showcase the active space's uploaded avatar at the top of the
	// room list, parallel to MemberList's room-banner.  Skipped for
	// emoji-iconed spaces (the emoji already shows in the SpaceBar
	// tile + the existing h-12 header below) and for spaces without
	// a custom avatar (DiceBear fallback isn't worth a banner).
	const showSpaceBanner = !!(
		activeSpaceObj
		&& activeSpaceObj.avatarUrl
		&& !activeSpaceObj.iconEmoji
	);

	// Gate the "+ create room" button inside a space to the space
	// creator only.  Non-creators don't have PL 100 in the parent
	// space, so `m.space.child` linking would 403 and produce an
	// orphan room — better to hide the button entirely than to let
	// people create rooms that silently fail to land in the space.
	// Discord-style invariant: rooms can only be born inside a
	// space.  The Rooms tile (orphans pseudo-space) loses its +
	// entirely.  DMs keep the + because they bypass the rule.
	const canCreateRoomHere =
		activeSpace?.kind === "dms"
		|| (activeSpace?.kind === "space"
			&& activeSpaceObj?.creatorId === currentUserId);

	return (
		<aside className="w-60 shrink-0 border-r border-border bg-card flex flex-col">
			{showSpaceBanner && activeSpaceObj && (
				<div className="px-4 pt-4 pb-3 border-b border-border flex justify-center">
					<MatrixAvatar
						mxc={activeSpaceObj.avatarUrl}
						seed={activeSpaceObj.id}
						kind="space"
						className="h-40 w-40 rounded-lg"
					/>
				</div>
			)}
			<div className="px-4 h-12 flex items-center justify-between border-b border-border">
				<span className="font-semibold text-sm truncate" title={header}>{header}</span>
				{canCreateRoomHere && (
					<button
						type="button"
						onClick={onCreateRoom}
						className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
						aria-label={activeSpace?.kind === "dms" ? "Start a DM" : "Create room"}
						title={
							activeSpace?.kind === "dms" ? "Start a direct message"
							: activeSpace?.kind === "space" ? "Create room in this space"
							: "Create room"
						}
					>
						<Plus className="h-4 w-4" />
					</button>
				)}
			</div>
			<nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
				{inviteRooms.length > 0 && (
					<div className="mb-2 space-y-1.5">
						<div className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
							Requests · {inviteRooms.length}
						</div>
						{inviteRooms.map(room => (
							<InviteRow
								key={room.id}
								room={room}
								onAccept={() => onAcceptInvite(room.id)}
								onDecline={() => onDeclineInvite(room.id)}
								onCopyId={() => {
									void navigator.clipboard.writeText(room.id);
								}}
								onBlockInviter={room.inviter && transport ? () => {
									transport.ignoreUser(room.inviter as UserId).catch(err => {
										console.warn("InviteRow: block inviter failed", err);
									});
								} : undefined}
							/>
						))}
					</div>
				)}

				{joinedRooms.length === 0 && inviteRooms.length === 0 ? (
					// Empty hint is suppressed until the initial sync
					// has actually produced a rooms list.  Otherwise
					// every fresh-app-boot or space-switch flashes the
					// "No rooms in this space yet" copy for a frame
					// before the rooms fan in from the reducer.
					roomsLoaded ? (
						<div className="text-xs text-muted-foreground px-2 py-4 leading-relaxed">
							{emptyHintFor(activeSpace)}
						</div>
					) : null
				) : (
					joinedRooms.map(room => {
						const isPinned = pinnedRoomIdSet.has(room.id);
						const isCollapsed = !!collapsedRoomIds?.has(room.id);
						return (
							<RoomRow
								key={room.id}
								room={room}
								active={room.id === activeRoomId}
								pinned={isPinned}
								collapsed={isCollapsed}
								onSelect={() => onSelectRoom(room.id)}
								onPin={canManagePins && !isPinned ? pinHandler(room.id) : undefined}
								onUnpin={canManagePins && isPinned ? unpinHandler(room.id) : undefined}
								// Right-click context menu wiring.  Each
								// row owns its own menu state so multiple
								// rooms can have hover affordances without
								// stomping each other's open menus.
								currentUserId={currentUserId}
								transport={transport ?? null}
								accessToken={accessToken ?? null}
								activeSpaceId={activeSpaceObj?.id ?? null}
								canManagePins={canManagePins}
								onEditRoom={onEditRoom}
								onOpenProfile={onOpenProfile}
								isBotPeer={
									room.kind === "dm" && !!room.dmUserId && !!botMxids?.has(room.dmUserId)
								}
							/>
						);
					})
				)}
			</nav>
		</aside>
	);
}

// Reorder a room list so any room whose id appears in `pinnedIds`
// floats to the top, in the order the space owner set on the
// `chat.koven.pinned_rooms` event.  Unpinned rooms keep the order
// they came in with (last-active descending, applied upstream).
function sortWithPinnedFirst(rooms: Room[], pinnedIds: string[]): Room[] {
	if (pinnedIds.length === 0) return rooms;
	const byId = new Map(rooms.map(r => [r.id, r]));
	const pinned: Room[] = [];
	for (const id of pinnedIds) {
		const r = byId.get(id);
		if (r) pinned.push(r);
	}
	const pinnedSet = new Set(pinned.map(r => r.id));
	const rest = rooms.filter(r => !pinnedSet.has(r.id));
	return [...pinned, ...rest];
}

function filterRooms(rooms: Room[], activeSpace: ActiveSpace): Room[] {
	if (!activeSpace) return [];
	if (activeSpace.kind === "explore") return [];
	if (activeSpace.kind === "bots") return [];
	if (activeSpace.kind === "dms") return rooms.filter(r => r.kind === "dm");
	if (activeSpace.kind === "spaces_overview") return [];
	const id = activeSpace.id;
	return rooms.filter(r => r.parentSpaceIds.includes(id));
}

function headerFor(activeSpace: ActiveSpace, spaces: Space[]): string {
	if (!activeSpace) return "";
	if (activeSpace.kind === "explore") return "Explore";
	if (activeSpace.kind === "bots") return "Bots";
	if (activeSpace.kind === "dms") return "Direct messages";
	if (activeSpace.kind === "spaces_overview") return "Spaces";
	const space = spaces.find(s => s.id === activeSpace.id);
	return space?.name ?? "Space";
}

function emptyHintFor(activeSpace: ActiveSpace): string {
	if (!activeSpace) return "";
	if (activeSpace.kind === "explore") {
		return "Browse public spaces in the main pane. Joined ones show up in your sidebar.";
	}
	if (activeSpace.kind === "dms") {
		return "No direct messages yet. Start a DM with someone and it'll show up here.";
	}
	return "No rooms in this space yet. Use the + above to create one.";
}

// Room tile avatar: DiceBear "shapes" fallback for normal rooms, user
// avatar for DMs, with a small badge in the bottom-right corner.  For
// rooms the badge is the access-type glyph (public/private) so the
// kind stays at-a-glance readable; for DMs it's a presence dot mirroring
// the member-list pattern (green = online, amber = idle, nothing when
// offline) so you can tell who's around without opening each chat.
function RoomAvatar({ room, isBotPeer }: { room: Room; isBotPeer?: boolean }) {
	// For DMs, seed with the other user's id so the auto-avatar reflects
	// THEIR identity (not the room's), and round to a circle since it's
	// effectively a person avatar.
	const isDm = room.kind === "dm";
	const seed = isDm ? (room.dmUserId ?? room.id) : room.id;
	// DiceBear style: bots → bottts robot (matches the chat header /
	// profile sheet which both pass kind="bot"), humans → fun-emoji
	// face, rooms/spaces → shapes.  Without isBotPeer, every DM
	// (including bot DMs) used kind="user" and the sidebar showed a
	// yellow smiley while the same conversation's chat header / profile
	// showed a robot — visibly inconsistent.
	const dmKind = isBotPeer ? "bot" : "user";
	return (
		<div className="relative shrink-0">
			<MatrixAvatar
				mxc={room.avatarUrl}
				emoji={isDm ? undefined : room.iconEmoji}
				seed={seed}
				kind={isDm ? dmKind : "room"}
				className={isDm ? "h-7 w-7 rounded-full" : "h-7 w-7 rounded-md"}
			/>
			{isDm
				? <DmPresenceDot presence={room.dmPresence} />
				: (
					<span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-card border border-border flex items-center justify-center text-muted-foreground">
						<AccessGlyph room={room} className="h-2.5 w-2.5" />
					</span>
				)}
		</div>
	);
}

function AccessGlyph({ room, className }: { room: Room; className?: string }) {
	if (room.kind === "private") return <EyeOff className={className} aria-hidden />;
	return <Globe className={className} aria-hidden />;
}

/** Small status overlay for DM avatars.  Green when the peer is
 * online, amber when idle ("unavailable"), nothing at all when
 * offline / unknown — matches the member-list dot exactly so the two
 * surfaces feel consistent. */
function DmPresenceDot({ presence }: { presence: Room["dmPresence"] }) {
	const cls =
		presence === "online" ? "bg-green-500"
		: presence === "unavailable" ? "bg-amber-500"
		: null;
	if (!cls) return null;
	return (
		<span
			className={cn(
				"absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card",
				cls,
			)}
			aria-label={presence === "online" ? "Online" : "Idle"}
		/>
	);
}

function RoomRow({
	room, active, pinned, collapsed, onSelect, onPin, onUnpin,
	currentUserId, transport, accessToken, activeSpaceId, canManagePins,
	onEditRoom, onOpenProfile, isBotPeer,
}: {
	room: Room;
	active: boolean;
	// Pin state is space-scoped, passed in from RoomList rather than
	// read off the room — the same room can be pinned in one space
	// and not in another (rooms can belong to multiple spaces).
	pinned: boolean;
	// True when the room is in the engine's collapsed-rooms list.  The
	// row still renders (you might be a member who needs to leave),
	// but with the "Name Removed by Community Review" placeholder in
	// place of the verbatim name.
	collapsed: boolean;
	onSelect(): void;
	// Either onPin or onUnpin is provided when the current user has
	// permission to manage pins in the active space.  Both undefined
	// means "no pin button at all" — the row is read-only.  The pinned
	// indicator still shows on the avatar regardless of permission, so
	// every member sees which rooms are pinned.
	onPin?(): void;
	onUnpin?(): void;
	// Right-click context menu wiring.
	currentUserId: UserId;
	transport: MatrixTransport | null;
	accessToken: string | null;
	activeSpaceId: string | null;
	canManagePins: boolean;
	onEditRoom?(roomId: RoomId): void;
	onOpenProfile?(userId: UserId): void;
	// True when this is a DM whose peer is a known bot — flips the
	// avatar's DiceBear fallback style from fun-emoji ("user") to
	// bottts ("bot") so the sidebar matches the rest of the UI.
	isBotPeer?: boolean;
}) {
	// Right-click menu state.  Cursor-positioned, dismissed via the
	// generic ContextMenu primitive's outside-mousedown handler.
	const [ctxMenuPos, setCtxMenuPos] = useState<{ x: number; y: number } | null>(null);
	// Per-row mute indicator.  Reads from the in-memory cache; the
	// useState forces a re-render when the cache fires its change
	// event, so toggling mute via the context menu updates the icon
	// instantly without waiting for the next sync cycle.
	const [notifyLevel, setNotifyLevel] = useState(() => getRoomNotifyLevel(room.id));
	useEffect(() => {
		const unsub = onNotifyPrefsChanged(() => {
			setNotifyLevel(getRoomNotifyLevel(room.id));
		});
		setNotifyLevel(getRoomNotifyLevel(room.id));
		return unsub;
	}, [room.id]);
	const isMuted = notifyLevel === "muted";

	// Founder + edit gates for the context menu.  Founder = creatorId
	// match.  Edit gates on PL >= 50 (matches the Settings sheet's
	// own gate).
	const isFounder = !!room.creatorId && room.creatorId === currentUserId;
	const canEdit = (room.myPowerLevel ?? 0) >= 50;

	// Pin affordance: button always visible (and clickable) when the
	// room is pinned and the user can unpin; faded-in on row hover when
	// the user can pin but the room isn't pinned yet.  When the user
	// has no pin permission, the button is hidden entirely but a
	// non-interactive solid pin indicator still renders on pinned rooms
	// so every member can tell at a glance which rooms are pinned.
	const canTogglePin = pinned ? !!onUnpin : !!onPin;
	const handlePinClick = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (pinned) onUnpin?.();
		else onPin?.();
	};
	// Source of truth: matrix-js-sdk's per-room unread counter,
	// which markAsRead zeros locally via setUnreadNotificationCount
	// before any receipt round-trips.  No presentation-layer
	// suppression needed — the count itself is the truth.
	const hasUnread = room.unreadCount > 0 || room.highlightCount > 0;
	// Reserve room on the right for the pin icon (always when pinned;
	// also when the user can pin, since the slot needs to be there for
	// the hover affordance).  Avoids overlap with the unread dot.
	const reservePinSlot = pinned || canTogglePin;
	return (
		<div
			className={cn(
				"group relative rounded-md transition-colors",
				active ? "bg-accent" : "hover:bg-accent/60",
			)}
			onContextMenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
				setCtxMenuPos({ x: e.clientX, y: e.clientY });
			}}
		>
			<button
				type="button"
				onClick={onSelect}
				data-room-row=""
				className={cn(
					"w-full flex items-center gap-2 py-1.5 pl-2 text-sm text-left min-w-0",
					reservePinSlot ? "pr-8" : "pr-2",
					active ? "text-foreground" : "text-foreground/90",
					// Muted rooms render with reduced text contrast +
					// a small mute icon to communicate "this room is
					// silenced" at a glance, the way Discord does.
					isMuted && "text-muted-foreground/70",
				)}
				title={collapsed ? COLLAPSED_NAME : room.name}
			>
				<RoomAvatar room={room} isBotPeer={isBotPeer} />
				<span className="flex-1 truncate flex items-center gap-1.5 min-w-0">
					<span className={cn(
						"truncate",
						hasUnread && !isMuted && "font-semibold",
						// Italicise + dim the placeholder so collapsed
						// rooms are visually distinct from regular ones —
						// they exist in the user's room list (they're
						// still a member) but the elevated styling makes
						// it obvious the name was redacted by review.
						collapsed && "italic text-muted-foreground",
					)}>
						{collapsed ? COLLAPSED_NAME : room.name}
					</span>
					{isMuted && (
						<BellOff className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Muted" />
					)}
					{room.encrypted && (
						<Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
					)}
				</span>
				{hasUnread && !isMuted && (
					<span
						className={cn(
							"shrink-0 h-2 w-2 rounded-full",
							room.highlightCount > 0 ? "bg-primary" : "bg-muted-foreground/60",
						)}
						aria-label={`${room.unreadCount} unread`}
					/>
				)}
			</button>
			{pinned && !canTogglePin && (
				// Read-only pin marker for members who can't manage pins —
				// just a visual indicator that this room was pinned by an
				// admin so the elevated rooms still stand out for them.
				<span
					className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-primary pointer-events-none"
					aria-label="Pinned"
					title="Pinned by space admin"
				>
					<Pin className="h-3.5 w-3.5 fill-current" aria-hidden />
				</span>
			)}
			{canTogglePin && (
				<button
					type="button"
					onClick={handlePinClick}
					aria-label={pinned ? "Unpin room" : "Pin room"}
					title={pinned ? "Unpin from top" : "Pin to top"}
					className={cn(
						"absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded transition-opacity",
						"hover:bg-background/80",
						pinned
							? "opacity-100 text-primary"
							: "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground",
					)}
				>
					<Pin
						className={cn("h-3.5 w-3.5", pinned && "fill-current")}
						aria-hidden
					/>
				</button>
			)}
			{ctxMenuPos && transport && accessToken && (
				<RoomRowContextMenu
					x={ctxMenuPos.x}
					y={ctxMenuPos.y}
					room={room}
					currentUserId={currentUserId}
					accessToken={accessToken}
					activeSpaceId={activeSpaceId as RoomId | null}
					isPinned={pinned}
					canManagePins={canManagePins}
					isFounder={isFounder}
					canEdit={canEdit}
					onMarkRead={() => {
						transport.markAsRead(room.id).catch(err => {
							console.warn("RoomRow: markAsRead failed", err);
						});
					}}
					onMarkUnread={() => {
						// matrix-js-sdk doesn't have a direct "mark
						// unread" API yet; the in-progress MSC2867
						// path is gated.  Best-effort no-op here:
						// just pop a console warn so we don't lie
						// about the action having succeeded.  When
						// the SDK adds first-class support, swap to
						// transport.markAsUnread(room.id).
						console.warn("RoomRow: markAsUnread is not yet implemented");
					}}
					onCopyId={() => {
						void navigator.clipboard.writeText(room.id).catch(err => {
							console.warn("RoomRow: copy room id failed", err);
						});
					}}
					onEdit={onEditRoom ? () => onEditRoom(room.id) : undefined}
					onPin={onPin}
					onUnpin={onUnpin}
					onLeave={() => {
						transport.leaveRoom(room.id).catch(err => {
							console.warn("RoomRow: leave failed", err);
						});
					}}
					onDelete={isFounder ? () => {
						// Defer to leave for now — proper room
						// deletion is a Synapse-admin path that
						// requires extra plumbing.  The Founder-only
						// "Delete" wording is the safest near-term
						// approximation: leaving as the only PL=100
						// member tombstones the room for the engine.
						transport.leaveRoom(room.id).catch(err => {
							console.warn("RoomRow: delete (leave) failed", err);
						});
					} : undefined}
					onOpenProfile={room.kind === "dm" && room.dmUserId && onOpenProfile
						? () => onOpenProfile(room.dmUserId as UserId)
						: undefined}
					onBlockDmUser={room.kind === "dm" && room.dmUserId
						? () => {
							const target = room.dmUserId as UserId;
							transport.ignoreUser(target).catch(err => {
								console.warn("RoomRow: block user failed", err);
							});
						}
						: undefined}
					onClose={() => setCtxMenuPos(null)}
				/>
			)}
		</div>
	);
}

function InviteRow({
	room, onAccept, onDecline, onBlockInviter, onCopyId,
}: {
	room: Room;
	onAccept(): void | Promise<void>;
	onDecline(): void | Promise<void>;
	onBlockInviter?(): void;
	onCopyId?(): void;
}) {
	const [ctxMenuPos, setCtxMenuPos] = useState<{ x: number; y: number } | null>(null);
	// NSFW pill — surfaces the room's adult-content flag pre-accept
	// so the viewer can decide before joining.  Note: visibility of
	// `room.nsfw` on an *invite* depends on Synapse forwarding the
	// `chat.koven.nsfw` state event in invite_state (see homeserver.yaml
	// `room_invite_state_types`).  When the homeserver doesn't forward
	// it, the badge stays hidden pre-accept and the confirmation gate
	// in App.tsx kicks in post-accept instead.
	const isNsfw = !!room.nsfw;
	// Prefer the inviter's display name; fall back to the localpart of
	// their mxid if we couldn't resolve a profile (which happens for
	// federated invites where we haven't synced the inviter's profile
	// yet); fall back to "Someone" only when we have neither.  The full
	// `@user:server` was reading as noise — Element / Discord both
	// surface display names here.
	const inviterLabel =
		room.inviterDisplayName
		?? localpartFromMxid(room.inviter)
		?? localpartFromMxid(room.dmUserId)
		?? "Someone";
	// DMs: the row's primary label IS the inviter's display name
	// already, so repeating their full @mxid below would just
	// truncate noisily.  Use a clean verb-only subtitle for those.
	// Non-DMs: keep the inviter + action so the user can tell who
	// invited them, but allow the text to wrap to a second line
	// (line-clamp-2) instead of getting chopped at the first colon.
	const isDm = room.kind === "dm";
	return (
		<div
			className={cn(
				"rounded-md border p-2 space-y-1.5",
				isNsfw ? "border-rose-500/40 bg-rose-500/5" : "border-border bg-card/60",
			)}
			onContextMenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
				setCtxMenuPos({ x: e.clientX, y: e.clientY });
			}}
		>
			<div className="flex items-start gap-2 min-w-0">
				<RoomAvatar room={room} />
				<div className="min-w-0 flex-1">
					<div className="text-sm font-medium truncate flex items-center gap-1.5">
						<span className="truncate">{room.name}</span>
						{isNsfw && (
							<span
								className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide bg-rose-500/15 text-rose-500 border border-rose-500/30"
								title="This room is flagged as NSFW"
							>
								NSFW
							</span>
						)}
					</div>
					{isDm ? (
						<div className="text-[11px] text-muted-foreground truncate">
							Wants to chat
						</div>
					) : (
						<div className="text-[11px] text-muted-foreground line-clamp-2 break-words">
							<span className="font-medium text-foreground/80">{inviterLabel}</span> invited you
						</div>
					)}
				</div>
			</div>
			<div className="flex gap-1">
				<button
					type="button"
					onClick={() => onAccept()}
					className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 transition-colors"
				>
					<Check className="h-3 w-3" /> Accept
				</button>
				<button
					type="button"
					onClick={() => onDecline()}
					className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
				>
					<X className="h-3 w-3" /> Decline
				</button>
			</div>
			{ctxMenuPos && <InviteContextMenu
				x={ctxMenuPos.x}
				y={ctxMenuPos.y}
				onAccept={() => { void onAccept(); }}
				onDecline={() => { void onDecline(); }}
				onCopyId={onCopyId}
				onBlockInviter={onBlockInviter}
				onClose={() => setCtxMenuPos(null)}
			/>}
		</div>
	);
}

function InviteContextMenu({
	x, y, onAccept, onDecline, onCopyId, onBlockInviter, onClose,
}: {
	x: number;
	y: number;
	onAccept(): void;
	onDecline(): void;
	onCopyId?(): void;
	onBlockInviter?(): void;
	onClose(): void;
}) {
	const items: ContextMenuItem[] = [
		{ label: "Accept", icon: <Check className="h-4 w-4" />, onClick: onAccept },
		{ label: "Decline", icon: <X className="h-4 w-4" />, onClick: onDecline },
	];
	if (onCopyId || onBlockInviter) {
		items.push({ kind: "divider" });
		if (onCopyId) {
			items.push({ label: "Copy room ID", icon: <Copy className="h-4 w-4" />, onClick: onCopyId });
		}
		if (onBlockInviter) {
			items.push({
				label: "Block inviter",
				icon: <UserX className="h-4 w-4" />,
				danger: true,
				onClick: onBlockInviter,
			});
		}
	}
	return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}

/** Pull the localpart out of a Matrix user id ("@alice:server" → "alice").
 * Returns undefined when given undefined or a malformed value, so callers
 * can chain it through `??` to a default. */
function localpartFromMxid(mxid: string | undefined): string | undefined {
	if (!mxid) return undefined;
	if (!mxid.startsWith("@")) return mxid;
	const colon = mxid.indexOf(":");
	return colon > 1 ? mxid.slice(1, colon) : mxid.slice(1);
}

// Second column — the room list scoped to whatever's selected in the
// SpaceBar.
//   - Home: every DM the user is in, plus rooms not assigned to any
//     space ("orphan" rooms).
//   - A specific space: only rooms whose parentSpaceIds include that
//     space's id.

import { cn } from "@/lib/utils";
import { COLLAPSED_NAME } from "@/lib/collapsedRooms";
import type { Room, RoomId, Space } from "@koven/shared";
import { Check, EyeOff, Globe, Lock, Pin, Plus, X } from "lucide-react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import type { ActiveSpace } from "@/state/store";

export interface RoomListProps {
	rooms: Room[];
	spaces: Space[];
	activeSpace: ActiveSpace;
	activeRoomId: RoomId | null;
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
}

// PL gate for editing the space's `chat.koven.pinned_rooms` state
// event.  Matches the rest of the UI (Settings sheet, Add Room) which
// also use ≥ 50.  Koven's createSpace sets state_default to 100, so in
// practice this still resolves to founder-only on Koven-created spaces;
// the looser gate matters for spaces created outside our flow.
const PIN_PL_THRESHOLD = 50;

export function RoomList({
	rooms, spaces, activeSpace, activeRoomId,
	onSelectRoom, onCreateRoom, onAcceptInvite, onDeclineInvite,
	onPinRoom, onUnpinRoom, collapsedRoomIds,
	roomsLoaded,
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

	return (
		<aside className="w-60 shrink-0 border-r border-border bg-card flex flex-col">
			<div className="px-4 h-12 flex items-center justify-between border-b border-border">
				<span className="font-semibold text-sm truncate" title={header}>{header}</span>
				{activeSpace?.kind !== "explore" && (
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
	if (activeSpace.kind === "rooms") {
		// Orphans pseudo-space: every joined room not assigned to any
		// space, excluding DMs (which live in their own tile).
		return rooms.filter(r => r.kind !== "dm" && r.parentSpaceIds.length === 0);
	}
	const id = activeSpace.id;
	return rooms.filter(r => r.parentSpaceIds.includes(id));
}

function headerFor(activeSpace: ActiveSpace, spaces: Space[]): string {
	if (!activeSpace) return "";
	if (activeSpace.kind === "explore") return "Explore";
	if (activeSpace.kind === "bots") return "Bots";
	if (activeSpace.kind === "dms") return "Direct messages";
	if (activeSpace.kind === "rooms") return "Rooms";
	const space = spaces.find(s => s.id === activeSpace.id);
	return space?.name ?? "Space";
}

function emptyHintFor(activeSpace: ActiveSpace): string {
	if (!activeSpace) return "";
	if (activeSpace.kind === "explore") {
		return "Browse public spaces and rooms in the main pane. Joined ones show up under Rooms / Spaces.";
	}
	if (activeSpace.kind === "dms") {
		return "No direct messages yet. Start a DM with someone and it'll show up here.";
	}
	if (activeSpace.kind === "rooms") {
		return "No unsorted rooms. Create one or join one and it'll show up here.";
	}
	return "No rooms in this space yet. Use the + above to create one.";
}

// Room tile avatar: DiceBear "shapes" fallback for normal rooms, user
// avatar for DMs, with a small badge in the bottom-right corner.  For
// rooms the badge is the access-type glyph (public/private) so the
// kind stays at-a-glance readable; for DMs it's a presence dot mirroring
// the member-list pattern (green = online, amber = idle, nothing when
// offline) so you can tell who's around without opening each chat.
function RoomAvatar({ room }: { room: Room }) {
	// For DMs, seed with the other user's id so the auto-avatar reflects
	// THEIR identity (not the room's), and round to a circle since it's
	// effectively a person avatar.
	const isDm = room.kind === "dm";
	const seed = isDm ? (room.dmUserId ?? room.id) : room.id;
	return (
		<div className="relative shrink-0">
			<MatrixAvatar
				mxc={room.avatarUrl}
				emoji={isDm ? undefined : room.iconEmoji}
				seed={seed}
				kind={isDm ? "user" : "room"}
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
}) {
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
		>
			<button
				type="button"
				onClick={onSelect}
				className={cn(
					"w-full flex items-center gap-2 py-1.5 pl-2 text-sm text-left min-w-0",
					reservePinSlot ? "pr-8" : "pr-2",
					active ? "text-foreground" : "text-foreground/90",
				)}
				title={collapsed ? COLLAPSED_NAME : room.name}
			>
				<RoomAvatar room={room} />
				<span className="flex-1 truncate flex items-center gap-1.5 min-w-0">
					<span className={cn(
						"truncate",
						hasUnread && "font-semibold",
						// Italicise + dim the placeholder so collapsed
						// rooms are visually distinct from regular ones —
						// they exist in the user's room list (they're
						// still a member) but the elevated styling makes
						// it obvious the name was redacted by review.
						collapsed && "italic text-muted-foreground",
					)}>
						{collapsed ? COLLAPSED_NAME : room.name}
					</span>
					{room.encrypted && (
						<Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
					)}
				</span>
				{hasUnread && (
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
		</div>
	);
}

function InviteRow({
	room, onAccept, onDecline,
}: {
	room: Room;
	onAccept(): void | Promise<void>;
	onDecline(): void | Promise<void>;
}) {
	const inviterLabel = room.inviter ?? room.dmUserId ?? "Someone";
	const subtitle = room.kind === "dm"
		? "wants to chat"
		: `invited you to ${room.name}`;
	return (
		<div className="rounded-md border border-border bg-card/60 p-2 space-y-1.5">
			<div className="flex items-center gap-2 min-w-0">
				<RoomAvatar room={room} />
				<div className="min-w-0 flex-1">
					<div className="text-sm font-medium truncate">{room.name}</div>
					<div className="text-[11px] text-muted-foreground truncate">
						<span className="font-medium text-foreground/80">{inviterLabel}</span> {subtitle}
					</div>
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
		</div>
	);
}

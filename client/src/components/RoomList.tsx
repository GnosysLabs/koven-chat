// Second column — the room list scoped to whatever's selected in the
// SpaceBar.
//   - Home: every DM the user is in, plus rooms not assigned to any
//     space ("orphan" rooms).
//   - A specific space: only rooms whose parentSpaceIds include that
//     space's id.

import { cn } from "@/lib/utils";
import type { Room, RoomId, Space } from "@koven/shared";
import { Check, EyeOff, Globe, Lock, Plus, User, X } from "lucide-react";
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
}

export function RoomList({
	rooms, spaces, activeSpace, activeRoomId,
	onSelectRoom, onCreateRoom, onAcceptInvite, onDeclineInvite,
}: RoomListProps) {
	const visibleRooms = filterRooms(rooms, activeSpace);
	// Pending invites bubble to the top of the list as request rows
	// with inline Accept/Decline buttons; "joined" rooms render as the
	// usual clickable conversation rows below.
	const inviteRooms = visibleRooms.filter(r => r.isInvite);
	const joinedRooms = visibleRooms.filter(r => !r.isInvite);
	const header = headerFor(activeSpace, spaces);

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
					<div className="text-xs text-muted-foreground px-2 py-4 leading-relaxed">
						{emptyHintFor(activeSpace)}
					</div>
				) : (
					joinedRooms.map(room => (
						<button
							key={room.id}
							type="button"
							onClick={() => onSelectRoom(room.id)}
							className={cn(
								"w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left hover:bg-accent transition-colors",
								room.id === activeRoomId && "bg-accent text-accent-foreground"
							)}
						>
							<RoomAvatar room={room} />
							<span className="truncate flex-1">{room.name}</span>
							{room.encrypted && (
								<Lock
									className="h-3.5 w-3.5 shrink-0 text-emerald-500/80"
									aria-label="End-to-end encrypted"
								/>
							)}
							{room.unreadCount > 0 && room.id !== activeRoomId && (
								// Suppress the dot for the currently-open room.
								// Synapse takes a beat to register our read
								// receipt; during that window unreadCount is
								// still > 0, but the user is literally looking
								// at the conversation — flagging it as "you
								// have unread here" is just noise.
								<span
									className={cn(
										"shrink-0 h-2 w-2 rounded-full",
										room.highlightCount > 0 ? "bg-destructive" : "bg-primary",
									)}
									aria-label={room.highlightCount > 0 ? "Mentions" : "Unread"}
								/>
							)}
						</button>
					))
				)}
			</nav>
		</aside>
	);
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
// avatar for DMs, with a small access-type badge in the bottom-right
// corner so public/private/DM stays at-a-glance readable.
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
			<span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-card border border-border flex items-center justify-center text-muted-foreground">
				<AccessGlyph room={room} className="h-2.5 w-2.5" />
			</span>
		</div>
	);
}

function AccessGlyph({ room, className }: { room: Room; className?: string }) {
	if (room.kind === "dm") return <User className={className} aria-hidden />;
	if (room.kind === "private") return <EyeOff className={className} aria-hidden />;
	return <Globe className={className} aria-hidden />;
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

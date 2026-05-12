// Thin left column — the "spaces dock".  Mirrors Element's leftmost
// rail: user avatar at top (opens profile), Home button, one tile per
// joined space, "+" to create a space, and Settings/Sign out at the
// bottom.  Selection here drives what the RoomList shows.

import { forwardRef, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { Room, Space, SpaceId, UserId } from "@koven/shared";
import { Bot, Compass, EyeOff, Globe, Plus, Settings, User } from "lucide-react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { AccountSwitcher } from "@/components/AccountSwitcher";
import { SpaceTileContextMenu } from "@/components/SpaceTileContextMenu";
import { buildInviteUrl } from "@/lib/inviteLink";
import type { StoredAccount } from "@/lib/accounts";
import type { ActiveSpace } from "@/state/store";
import type { MatrixTransport } from "@/lib/matrix";
import {
	DndContext, PointerSensor, useSensor, useSensors,
	closestCenter, type DragEndEvent,
} from "@dnd-kit/core";
import {
	SortableContext, useSortable, verticalListSortingStrategy,
	arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export interface SpaceBarProps {
	currentUserId: string | null;
	// Three-valued: `undefined` = profile fetch hasn't returned yet
	// (suppress the avatar tile to avoid a DiceBear flash);
	// `null` = probe completed, user has no avatar set;
	// `string` = real mxc URL.  The first paint after sign-in is
	// `undefined`, then flips to one of the other two once
	// `transport.getMyProfile()` resolves.
	currentUserAvatarMxc?: string | null;
	// Multi-account state.  When >1 account is present the avatar
	// opens the AccountSwitcher popover (switch / add / sign-out
	// each); single-account collapses the popover to its primary
	// affordance (open profile) so the UX doesn't grow steps for
	// users who only have one login.
	accounts?: StoredAccount[];
	onSwitchAccount?(userId: string): void;
	onAddAccount?(): void;
	onSignOutAccount?(userId: string): void;
	spaces: Space[];
	// All joined rooms — used to compute the per-tile unread indicators.
	// We don't filter here; each tile picks the slice it cares about.
	rooms: Room[];
	activeSpace: ActiveSpace;
	onSelectExplore(): void;
	onSelectDms(): void;
	onSelectBots(): void;
	onSelectSpace(spaceId: string): void;
	/** Open the create-space modal.  Pre-flight rate-limit check is
	 * the parent's responsibility — this fires unconditionally on
	 * click, parent decides whether to actually open the modal. */
	onOpenCreateSpace(): void;
	onOpenProfile(): void;
	onOpenSettings(): void;
	// Right-click context-menu plumbing for space tiles.  Optional
	// so SpaceBar still renders in test contexts where the transport
	// isn't available — context menu won't show.
	transport?: MatrixTransport | null;
	accessToken?: string | null;
	onMarkAllReadInSpace?(spaceId: SpaceId): void;
	onEditSpace?(spaceId: SpaceId): void;
	onManageCategories?(spaceId: SpaceId): void;
	onAddRoomToSpace?(spaceId: SpaceId): void;
	onAddExistingRoomToSpace?(spaceId: SpaceId): void;
	onLeaveSpace?(spaceId: SpaceId): void;
	onDeleteSpace?(spaceId: SpaceId): void;
	// Drag-and-drop reorder of the SpaceBar.  Receives the new ordered
	// list of space ids after a drop; caller persists to account_data
	// via `transport.setMySpaceOrder`.  Optional — when omitted, tiles
	// aren't draggable (the rail is per-user, no PL gate needed, so
	// the parent always passes a handler when transport is connected).
	onReorderSpaces?(spaceIds: SpaceId[]): Promise<void> | void;
}

export function SpaceBar({
	currentUserId,
	currentUserAvatarMxc,
	accounts,
	onSwitchAccount,
	onAddAccount,
	onSignOutAccount,
	spaces,
	rooms,
	activeSpace,
	onSelectExplore,
	onSelectDms,
	onSelectBots,
	onSelectSpace,
	onOpenCreateSpace,
	onOpenProfile,
	onOpenSettings,
	transport,
	accessToken,
	onMarkAllReadInSpace,
	onEditSpace,
	onManageCategories,
	onAddRoomToSpace,
	onAddExistingRoomToSpace,
	onLeaveSpace,
	onDeleteSpace,
	onReorderSpaces,
}: SpaceBarProps) {
	const showSwitcher = !!(accounts && onSwitchAccount && onAddAccount && onSignOutAccount);
	// Per-tile right-click menu.  Single state object {space, x, y}
	// rather than per-tile state because only one menu can be open
	// at a time anyway.
	const [spaceCtxMenu, setSpaceCtxMenu] = useState<{ space: Space; x: number; y: number } | null>(null);
	const exploreActive = activeSpace?.kind === "explore";
	const dmsActive = activeSpace?.kind === "dms";
	const botsActive = activeSpace?.kind === "bots";

	// Per-tile attention indicators.  A "dot" surfaces on a tile when
	// something inside wants the user's attention — pending invite or
	// unread messages.  We don't show the dot on the *active* tile
	// since the user is already looking at the relevant view.
	const dmAttention = useMemo(() => {
		if (dmsActive) return false;
		return rooms.some(r => r.kind === "dm" && (r.isInvite || r.unreadCount > 0 || r.highlightCount > 0));
	}, [rooms, dmsActive]);

	// dnd-kit setup for reordering space tiles.  6px activation
	// distance so a normal tile click never accidentally starts a
	// drag.  Single SortableContext over the spaces list.
	const sensors = useSensors(useSensor(PointerSensor, {
		activationConstraint: { distance: 6 },
	}));
	function handleDragEnd(e: DragEndEvent) {
		const { active, over } = e;
		if (!over || active.id === over.id || !onReorderSpaces) return;
		const oldIdx = spaces.findIndex(s => s.id === active.id);
		const newIdx = spaces.findIndex(s => s.id === over.id);
		if (oldIdx < 0 || newIdx < 0) return;
		const next = arrayMove(spaces, oldIdx, newIdx).map(s => s.id as SpaceId);
		void onReorderSpaces(next);
	}

	const spaceTiles = spaces.map(space => {
		const active = activeSpace?.kind === "space" && activeSpace.id === space.id;
		// Attention dot for spaces: any child room with an
		// unread, highlight, or pending invite — but only
		// when this space isn't currently selected.
		const spaceAttention = !active && rooms.some(r =>
			r.parentSpaceIds.includes(space.id) &&
			(r.isInvite || r.unreadCount > 0 || r.highlightCount > 0),
		);
		return (
			<SortableSpaceTile
				key={space.id}
				space={space}
				active={active}
				dot={spaceAttention}
				draggable={!!onReorderSpaces}
				onClick={() => onSelectSpace(space.id)}
				onContextMenu={(e) => {
					e.preventDefault();
					e.stopPropagation();
					setSpaceCtxMenu({ space, x: e.clientX, y: e.clientY });
				}}
			/>
		);
	});

	return (
		<aside className="w-[68px] shrink-0 bg-card border-r border-border flex flex-col items-center py-2 gap-2">
			{showSwitcher ? (
				<AccountSwitcher
					accounts={accounts!}
					activeUserId={currentUserId}
					currentUserAvatarMxc={currentUserAvatarMxc}
					onSwitch={onSwitchAccount!}
					onAddAccount={onAddAccount!}
					onSignOutAccount={onSignOutAccount!}
					onOpenProfile={onOpenProfile}
				/>
			) : (
				<button
					type="button"
					onClick={onOpenProfile}
					className="rounded-full focus:outline-none focus:ring-2 focus:ring-primary"
					title={currentUserId ?? "Profile"}
					aria-label="Profile"
				>
					{currentUserAvatarMxc === undefined ? (
						<span
							className="block h-10 w-10 rounded-full bg-muted"
							aria-hidden
						/>
					) : (
						<MatrixAvatar
							mxc={currentUserAvatarMxc ?? undefined}
							seed={currentUserId ?? "self"}
							className="h-10 w-10"
						/>
					)}
				</button>
			)}

			<TileButton
				active={exploreActive}
				onClick={onSelectExplore}
				title="Explore — browse public spaces and rooms"
				ariaLabel="Explore"
			>
				<Compass className="h-5 w-5" />
			</TileButton>

			<TileButton
				active={dmsActive}
				onClick={onSelectDms}
				title="Direct messages"
				ariaLabel="Direct messages"
				dot={dmAttention}
			>
				<User className="h-5 w-5" />
			</TileButton>

			<TileButton
				active={botsActive}
				onClick={onSelectBots}
				title="Bots — your custom AI bots"
				ariaLabel="Bots"
			>
				<Bot className="h-5 w-5" />
			</TileButton>

			<div className="flex-1 w-full overflow-y-auto flex flex-col items-center gap-2">
				{onReorderSpaces ? (
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						onDragEnd={handleDragEnd}
					>
						<SortableContext
							items={spaces.map(s => s.id)}
							strategy={verticalListSortingStrategy}
						>
							{spaceTiles}
						</SortableContext>
					</DndContext>
				) : (
					spaceTiles
				)}
				<TileButton
					title="Create a space"
					ariaLabel="Create a space"
					onClick={onOpenCreateSpace}
				>
					<Plus className="h-5 w-5" />
				</TileButton>
			</div>

			<div className="flex flex-col items-center gap-1 pb-1">
				<IconButton onClick={onOpenSettings} title="Settings" ariaLabel="Settings">
					<Settings className="h-4 w-4" />
				</IconButton>
				{/* Sign-out moved into the AccountSwitcher popover at the
				    top of the rail — covers per-account sign-out (when
				    multiple are stored) plus the single-account
				    "sign out" affordance.  Removing it here avoids two
				    sign-out buttons on the same screen. */}
			</div>
			{spaceCtxMenu && transport && accessToken && currentUserId && (
				<SpaceTileContextMenu
					x={spaceCtxMenu.x}
					y={spaceCtxMenu.y}
					space={spaceCtxMenu.space}
					currentUserId={currentUserId as UserId}
					accessToken={accessToken}
					roomsInSpace={rooms.filter(r => roomBelongsToSpace(r, spaceCtxMenu.space))}
					onMarkAllRead={() => {
						const ids = rooms
							.filter(r => roomBelongsToSpace(r, spaceCtxMenu.space))
							.map(r => r.id);
						for (const rid of ids) {
							transport.markAsRead(rid).catch(err => {
								console.warn(`SpaceBar: markAsRead ${rid} failed`, err);
							});
						}
						onMarkAllReadInSpace?.(spaceCtxMenu.space.id);
					}}
					onCopyId={() => {
						void navigator.clipboard.writeText(spaceCtxMenu.space.id);
					}}
					onCopyInviteLink={() => {
						void navigator.clipboard.writeText(buildInviteUrl(spaceCtxMenu.space.id));
					}}
					onEdit={onEditSpace ? () => onEditSpace(spaceCtxMenu.space.id) : undefined}
					onManageCategories={onManageCategories ? () => onManageCategories(spaceCtxMenu.space.id) : undefined}
					onAddRoom={onAddRoomToSpace ? () => onAddRoomToSpace(spaceCtxMenu.space.id) : undefined}
					onAddExistingRoom={onAddExistingRoomToSpace ? () => onAddExistingRoomToSpace(spaceCtxMenu.space.id) : undefined}
					onLeave={() => {
						if (onLeaveSpace) onLeaveSpace(spaceCtxMenu.space.id);
						else transport.leaveRoom(spaceCtxMenu.space.id).catch(err => {
							console.warn("SpaceBar: leave space failed", err);
						});
					}}
					onDelete={onDeleteSpace ? () => onDeleteSpace(spaceCtxMenu.space.id) : undefined}
					onClose={() => setSpaceCtxMenu(null)}
				/>
			)}
		</aside>
	);
}

/** Resolve "is this room a member of this space?" using BOTH sides
 * of the m.space.child / m.space.parent pair.  Most rooms only get
 * the m.space.child link written (on the space, by whoever added the
 * room), because writing m.space.parent on the room itself requires
 * power level on the room.  Trusting only one direction misses the
 * majority of real-world rooms. */
function roomBelongsToSpace(room: Room, space: Space): boolean {
	return space.childRoomIds.includes(room.id) || room.parentSpaceIds.includes(space.id);
}

interface TileButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	active?: boolean;
	ariaLabel: string;
	// When true, render a small primary-colored dot in the top-right
	// corner of the tile to flag attention (unread / invite).  Caller
	// is responsible for suppressing the dot when the tile is active —
	// "look here" doesn't apply to the view you're already on.
	dot?: boolean;
}

const TileButton = forwardRef<HTMLButtonElement, TileButtonProps>(
	({ active, ariaLabel, children, className, dot, ...rest }, ref) => (
		<button
			ref={ref}
			type="button"
			aria-label={ariaLabel}
			className={cn(
				"relative h-10 w-10 rounded-xl flex items-center justify-center transition-all",
				"text-muted-foreground hover:text-foreground hover:bg-accent",
				active && "bg-primary/15 text-foreground",
				className,
			)}
			{...rest}
		>
			{/* Selection rail — thin pill on the left edge when active. */}
			<span
				className={cn(
					"absolute left-[-10px] top-1/2 -translate-y-1/2 w-1 rounded-r-full bg-primary transition-all",
					active ? "h-6 opacity-100" : "h-0 opacity-0"
				)}
				aria-hidden
			/>
			{children}
			{dot && (
				<span
					className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-card"
					aria-hidden
				/>
			)}
		</button>
	),
);
TileButton.displayName = "TileButton";

/** Sortable wrapper around `TileButton`.  When `draggable` is false
 * (caller doesn't pass `onReorderSpaces`) we render a plain
 * TileButton so pointer events fall through normally — useful for
 * test contexts or any environment without a live transport. */
function SortableSpaceTile({
	space, active, dot, draggable, onClick, onContextMenu,
}: {
	space: Space;
	active: boolean;
	dot: boolean;
	draggable: boolean;
	onClick(): void;
	onContextMenu(e: React.MouseEvent): void;
}) {
	const sortable = useSortable({ id: space.id, disabled: !draggable });
	const style = {
		transform: CSS.Transform.toString(sortable.transform),
		transition: sortable.transition,
		opacity: sortable.isDragging ? 0.5 : 1,
	};
	if (!draggable) {
		return (
			<TileButton
				active={active}
				dot={dot}
				onClick={onClick}
				onContextMenu={onContextMenu}
				title={space.name}
				ariaLabel={space.name}
			>
				<SpaceTileAvatar space={space} />
			</TileButton>
		);
	}
	return (
		<div ref={sortable.setNodeRef} style={style} {...sortable.attributes} {...sortable.listeners}>
			<TileButton
				active={active}
				dot={dot}
				onClick={onClick}
				onContextMenu={onContextMenu}
				title={space.name}
				ariaLabel={space.name}
			>
				<SpaceTileAvatar space={space} />
			</TileButton>
		</div>
	);
}

function IconButton({
	children, onClick, title, ariaLabel, dot, dotClass,
}: {
	children: React.ReactNode;
	onClick(): void;
	title: string;
	ariaLabel: string;
	// Optional attention dot in the top-right corner.  Used by the
	// admin shield to flag a non-empty review queue.
	dot?: boolean;
	dotClass?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			aria-label={ariaLabel}
			className="relative h-8 w-8 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
		>
			{children}
			{dot && (
				<span
					className={cn(
						"absolute top-0.5 right-0.5 h-2 w-2 rounded-full ring-2 ring-card",
						dotClass ?? "bg-primary",
					)}
					aria-hidden
				/>
			)}
		</button>
	);
}

function SpaceTileAvatar({ space }: { space: Space }) {
	// Spaces fall back to the DiceBear "glass" style — heavier-weight
	// gradient blobs that read as "container" rather than "person".
	// Public/private glyph in the bottom-right corner because every
	// room in this space inherits the visibility — surfacing it on
	// the space tile (rather than per-room) reads as "this is a
	// public/private SERVER" the way Discord communicates server
	// privacy.
	return (
		<div className="relative">
			<MatrixAvatar
				mxc={space.avatarUrl}
				emoji={space.iconEmoji}
				seed={space.id}
				kind="space"
				className="h-9 w-9 rounded-lg"
			/>
			<span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-card border border-border flex items-center justify-center text-muted-foreground">
				{space.kind === "private"
					? <EyeOff className="h-2.5 w-2.5" aria-hidden />
					: <Globe className="h-2.5 w-2.5" aria-hidden />}
			</span>
		</div>
	);
}

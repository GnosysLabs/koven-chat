// Thin left column — the "spaces dock".  Mirrors Element's leftmost
// rail: user avatar at top (opens profile), Home button, one tile per
// joined space, "+" to create a space, and Settings/Sign out at the
// bottom.  Selection here drives what the RoomList shows.

import { forwardRef, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { Room, Space } from "@koven/shared";
import { Bot, Compass, Hash, LogOut, Plus, Settings, ShieldAlert, User } from "lucide-react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import type { ActiveSpace } from "@/state/store";

export interface SpaceBarProps {
	currentUserId: string | null;
	// Three-valued: `undefined` = profile fetch hasn't returned yet
	// (suppress the avatar tile to avoid a DiceBear flash);
	// `null` = probe completed, user has no avatar set;
	// `string` = real mxc URL.  The first paint after sign-in is
	// `undefined`, then flips to one of the other two once
	// `transport.getMyProfile()` resolves.
	currentUserAvatarMxc?: string | null;
	spaces: Space[];
	// All joined rooms — used to compute the per-tile unread indicators.
	// We don't filter here; each tile picks the slice it cares about.
	rooms: Room[];
	activeSpace: ActiveSpace;
	onSelectExplore(): void;
	onSelectDms(): void;
	onSelectBots(): void;
	onSelectRooms(): void;
	onSelectSpace(spaceId: string): void;
	/** Open the create-space modal.  Pre-flight rate-limit check is
	 * the parent's responsibility — this fires unconditionally on
	 * click, parent decides whether to actually open the modal. */
	onOpenCreateSpace(): void;
	onOpenProfile(): void;
	onOpenSettings(): void;
	onSignOut(): void;
	// Admin-only surfaces.  When `onOpenReview` is omitted the shield
	// button is hidden entirely; non-admins shouldn't see it at all,
	// even with a zero-count badge.  Pending count drives the red dot.
	onOpenReview?(): void;
	pendingReviewCount?: number;
}

export function SpaceBar({
	currentUserId,
	currentUserAvatarMxc,
	spaces,
	rooms,
	activeSpace,
	onSelectExplore,
	onSelectDms,
	onSelectBots,
	onSelectRooms,
	onSelectSpace,
	onOpenCreateSpace,
	onOpenProfile,
	onOpenSettings,
	onSignOut,
	onOpenReview,
	pendingReviewCount = 0,
}: SpaceBarProps) {
	const exploreActive = activeSpace?.kind === "explore";
	const dmsActive = activeSpace?.kind === "dms";
	const botsActive = activeSpace?.kind === "bots";
	const roomsActive = activeSpace?.kind === "rooms";

	// Per-tile attention indicators.  A "dot" surfaces on a tile when
	// something inside wants the user's attention — pending invite or
	// unread messages.  We don't show the dot on the *active* tile
	// since the user is already looking at the relevant view.
	const dmAttention = useMemo(() => {
		if (dmsActive) return false;
		return rooms.some(r => r.kind === "dm" && (r.isInvite || r.unreadCount > 0 || r.highlightCount > 0));
	}, [rooms, dmsActive]);
	const roomsAttention = useMemo(() => {
		if (roomsActive) return false;
		return rooms.some(r =>
			r.kind !== "dm" &&
			r.parentSpaceIds.length === 0 &&
			(r.isInvite || r.unreadCount > 0 || r.highlightCount > 0),
		);
	}, [rooms, roomsActive]);
	return (
		<aside className="w-[68px] shrink-0 bg-card border-r border-border flex flex-col items-center py-2 gap-2">
			<button
				type="button"
				onClick={onOpenProfile}
				className="rounded-full focus:outline-none focus:ring-2 focus:ring-primary"
				title={currentUserId ?? "Profile"}
				aria-label="Profile"
			>
				{currentUserAvatarMxc === undefined ? (
					// Profile probe still in flight — render a neutral
					// muted disc instead of the DiceBear fallback that
					// MatrixAvatar would otherwise produce for a
					// no-mxc seed.  Same dimensions as the real
					// avatar so layout doesn't shift on resolve.
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

			<TileButton
				active={roomsActive}
				onClick={onSelectRooms}
				title="Rooms — joined rooms not in any space"
				ariaLabel="Rooms"
				dot={roomsAttention}
			>
				<Hash className="h-5 w-5" />
			</TileButton>

			<div className="flex-1 w-full overflow-y-auto flex flex-col items-center gap-2">
				{spaces.map(space => {
					const active = activeSpace?.kind === "space" && activeSpace.id === space.id;
					// Attention dot for spaces: any child room with an
					// unread, highlight, or pending invite — but only
					// when this space isn't currently selected.
					const spaceAttention = !active && rooms.some(r =>
						r.parentSpaceIds.includes(space.id) &&
						(r.isInvite || r.unreadCount > 0 || r.highlightCount > 0),
					);
					return (
						<TileButton
							key={space.id}
							active={active}
							onClick={() => onSelectSpace(space.id)}
							title={space.name}
							ariaLabel={space.name}
							dot={spaceAttention}
						>
							<SpaceTileAvatar space={space} />
						</TileButton>
					);
				})}
				<TileButton
					title="Create a space"
					ariaLabel="Create a space"
					onClick={onOpenCreateSpace}
				>
					<Plus className="h-5 w-5" />
				</TileButton>
			</div>

			<div className="flex flex-col items-center gap-1 pb-1">
				{onOpenReview && (
					<IconButton
						onClick={onOpenReview}
						title={
							pendingReviewCount > 0
								? `Pending review (${pendingReviewCount})`
								: "Pending review"
						}
						ariaLabel="Pending review"
						dot={pendingReviewCount > 0}
						dotClass="bg-destructive"
					>
						<ShieldAlert className="h-4 w-4" />
					</IconButton>
				)}
				<IconButton onClick={onOpenSettings} title="Settings" ariaLabel="Settings">
					<Settings className="h-4 w-4" />
				</IconButton>
				<IconButton onClick={onSignOut} title="Sign out" ariaLabel="Sign out">
					<LogOut className="h-4 w-4" />
				</IconButton>
			</div>
		</aside>
	);
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
	return (
		<MatrixAvatar
			mxc={space.avatarUrl}
			emoji={space.iconEmoji}
			seed={space.id}
			kind="space"
			className="h-9 w-9 rounded-lg"
		/>
	);
}

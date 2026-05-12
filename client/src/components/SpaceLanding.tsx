// Landing view rendered in the chat pane when a space is selected but
// no room within it is active.  Mirrors Element's SpaceRoomView Landing
// phase:
//   - Big square avatar + welcome heading
//   - Topic and member count
//   - Action row: Add room, Invite (stubbed), Settings (stubbed)
//   - Below: a directory of rooms in the space — each clickable to enter
//
// When the space has zero rooms we substitute a friendlier empty state
// with prominent "Add rooms" / "Invite people" tiles instead of the
// directory.

import type { Room, RoomId, Space } from "@koven/shared";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { cn } from "@/lib/utils";
import { Hash, Lock, Plus, Settings, User, UserPlus } from "lucide-react";

// Which kind of "space" this landing is rendering for.  DMs and Rooms
// are virtual (no real Matrix space behind them) and want different
// chrome — different avatar, different action set.
export type SpaceLandingVariant = "real" | "dms" | "rooms";

export interface SpaceLandingProps {
	space: Space;
	rooms: Room[];                     // rooms in this space (already filtered)
	variant?: SpaceLandingVariant;     // defaults to "real"
	onAddRoom(): void;
	// Open the picker that adds a room the user is already in to this
	// space.  Distinct from `onAddRoom` (which creates a brand-new room
	// inside the space) — many users have rooms that exist outside any
	// server and want to file them under one without recreating.
	onAddExistingRoom?(): void;
	onInvite(): void;
	onOpenSettings(): void;
	onSelectRoom(roomId: RoomId): void;
	onStartDm?(): void;                // only used in the dms variant
}

export function SpaceLanding({
	space, rooms, variant = "real", onAddRoom, onAddExistingRoom, onInvite, onOpenSettings, onSelectRoom, onStartDm,
}: SpaceLandingProps) {
	const heading = variant === "real" ? `Welcome to ${space.name}` : space.name;
	// Founder / mod actions — gated on Matrix power level.  PL ≥ 50 is
	// the standard threshold for sending state events (which is what
	// "Add room" and "Settings" both end up doing under the hood); a
	// regular member at PL 0 sees neither button.  Variants that
	// aren't a real space (DMs, Rooms tile) ignore the power-level
	// check since they aren't backed by a Matrix space at all.
	const canModerateSpace = variant === "real" && (space.myPowerLevel ?? 0) >= 50;
	const showAddRoom = variant === "rooms" || canModerateSpace;
	const showInvite = variant === "real";
	const showSettings = canModerateSpace;
	const showStartDm = variant === "dms";
	// onSelectRoom is unused since we no longer render a directory
	// here — rooms are picked from the sidebar.  Reference it to keep
	// the prop part of the contract without firing a TS unused warn.
	void onSelectRoom;
	void rooms;

	return (
		<div className="flex-1 overflow-y-auto flex items-center justify-center">
			<div className="max-w-3xl mx-auto px-6 py-8 w-full flex items-center justify-center">
				<header className="flex flex-col items-center text-center">
					<LandingAvatar space={space} variant={variant} />
					<h1 className="text-2xl font-semibold mb-1">{heading}</h1>
					{space.topic && (
						<p className="text-sm text-muted-foreground max-w-md">{space.topic}</p>
					)}
					{variant === "dms" && (
						<div className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/5 text-emerald-500/90 text-[11px] font-medium">
							<Lock className="h-3 w-3" />
							End-to-end encrypted
						</div>
					)}
					{/* E2EE-required space pill.  Shown alongside / instead
					    of the DM pill above when the space was created
					    with the "all rooms encrypted" policy.  The title
					    spells out the full trade so the user can see why
					    flag / mod-log / reputation affordances are missing
					    inside this space — and why we wanted them to
					    understand the cost up front. */}
					{variant === "real" && space.e2eeRequired && (
						<div
							className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/5 text-emerald-500/90 text-[11px] font-medium"
							title="Every room in this space is end-to-end encrypted. The engine can't read messages here, so Koven moderation doesn't apply — there's no flag affordance, no community collapse, no public mod log entries. Activity in encrypted rooms also doesn't count toward your reputation score, since reputation is built from posts the engine can index."
						>
							<Lock className="h-3 w-3" />
							End-to-end encrypted &middot; not moderated
						</div>
					)}
					{(showAddRoom || showInvite || showSettings || showStartDm) && (
						<div className="flex flex-col items-center gap-1.5 mt-3">
							{/* Primary row: ambient actions (Start DM,
							    Invite, Settings) — the things you do
							    on a healthy, populated space.  Add-
							    room actions live below as their own
							    row since they're a setup gesture
							    rather than ongoing-management. */}
							{(showStartDm || showInvite || showSettings) && (
								<div className="flex items-center gap-1.5">
									{showStartDm && onStartDm && (
										<HeaderAction icon={<UserPlus className="h-4 w-4" />} label="Start a DM" onClick={onStartDm} />
									)}
									{showInvite && (
										<HeaderAction icon={<UserPlus className="h-4 w-4" />} label="Invite" onClick={onInvite} />
									)}
									{showSettings && (
										<HeaderAction icon={<Settings className="h-4 w-4" />} label="Settings" onClick={onOpenSettings} />
									)}
								</div>
							)}
							{/* Secondary row: room-creation gestures.
							    Stacked under the primary row to read
							    as "build out the space" rather than
							    "use the space." */}
							{showAddRoom && (
								<div className="flex items-center gap-1.5">
									<HeaderAction icon={<Plus className="h-4 w-4" />} label="Add new room" onClick={onAddRoom} />
									{/* "Add existing room" intentionally absent.
									    Under the Discord-style invariant every
									    room is born inside a space and stays
									    there; re-parenting an orphan is dead
									    semantics (no orphans exist).  The
									    prop + dialog plumbing is left wired
									    but unreached — kept for now in case
									    we reuse it for cross-space room
									    moves later. */}
								</div>
							)}
						</div>
					)}
				</header>
			</div>
		</div>
	);
}

function HeaderAction({
	icon, label, onClick, comingSoon,
}: {
	icon: React.ReactNode;
	label: string;
	onClick(): void;
	comingSoon?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={comingSoon}
			title={comingSoon ? `${label} (coming soon)` : label}
			className={cn(
				"inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border",
				"bg-background hover:bg-accent transition-colors",
				"disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-background"
			)}
		>
			{icon}
			{label}
		</button>
	);
}

function LandingAvatar({ space, variant }: { space: Space; variant: SpaceLandingVariant }) {
	if (variant === "dms") {
		return (
			<div className="h-20 w-20 rounded-2xl bg-primary/15 flex items-center justify-center mb-4">
				<User className="h-9 w-9 text-primary" />
			</div>
		);
	}
	if (variant === "rooms") {
		return (
			<div className="h-20 w-20 rounded-2xl bg-primary/15 flex items-center justify-center mb-4">
				<Hash className="h-9 w-9 text-primary" />
			</div>
		);
	}
	return (
		<MatrixAvatar
			mxc={space.avatarUrl}
			// Custom emoji icon takes precedence over the uploaded
			// avatar in MatrixAvatar's resolver — matches the
			// SpaceBar treatment, so a space the user picked an
			// emoji for renders the same glyph everywhere it's
			// represented in chrome.
			emoji={space.iconEmoji}
			seed={space.id}
			kind="space"
			className="h-20 w-20 rounded-2xl mb-4"
		/>
	);
}

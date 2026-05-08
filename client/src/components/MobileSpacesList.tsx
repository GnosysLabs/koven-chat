// MobileSpacesList — the "Spaces" tab landing screen.  Shows
// every joined space as a row (avatar + name + unread roll-up);
// tapping a row drills into that space's room list.  Replaces
// the desktop SpaceBar's role on mobile, where a permanent left
// rail of avatars doesn't fit.
//
// Pure list — empty / loading / error states are deliberately
// simple because spaces sync arrives along with the rest of the
// rooms; if the user has zero joined spaces, the empty state
// nudges them toward Explore.

import { ArrowRight } from "lucide-react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import type { Space, Room } from "@koven/shared";
import { cn } from "@/lib/utils";

interface MobileSpacesListProps {
	spaces: Space[];
	/// Used to compute the per-space unread roll-up.
	rooms: Room[];
	onSelectSpace(spaceId: string): void;
	onSelectExplore(): void;
}

export function MobileSpacesList({
	spaces,
	rooms,
	onSelectSpace,
	onSelectExplore,
}: MobileSpacesListProps) {
	if (spaces.length === 0) {
		return (
			<div className="flex-1 flex flex-col items-center justify-center text-center px-6 gap-3">
				<div className="text-foreground font-semibold">No spaces yet</div>
				<p className="text-sm text-muted-foreground max-w-[280px]">
					Spaces are public or private communities of rooms.  Find one in
					Explore, or ask someone to invite you.
				</p>
				<button
					type="button"
					onClick={onSelectExplore}
					className={cn(
						"mt-2 inline-flex items-center gap-1.5 px-4 py-2",
						"rounded-full bg-primary text-primary-foreground text-sm font-medium",
					)}
				>
					Browse Explore
					<ArrowRight className="h-4 w-4" />
				</button>
			</div>
		);
	}

	return (
		<div className="flex-1 overflow-y-auto">
			<div className="px-4 pt-3 pb-2 text-[11px] font-bold tracking-wider uppercase text-muted-foreground">
				Your Spaces
			</div>
			{spaces.map(space => {
				const childRooms = rooms.filter(r => space.childRoomIds.includes(r.id));
				const unread = childRooms.filter(r => r.unreadCount > 0).length;
				const memberCount = childRooms.reduce(
					(max, r) => Math.max(max, r.memberCount ?? 0),
					0,
				);
				return (
					<button
						key={space.id}
						type="button"
						onClick={() => onSelectSpace(space.id)}
						className={cn(
							"w-full flex items-center gap-3 px-4 py-3",
							"min-h-[68px] text-left",
							"transition-colors active:bg-accent",
							"border-b border-border/40",
						)}
					>
						<MatrixAvatar
							mxc={space.avatarUrl ?? undefined}
							seed={space.id}
							kind="room"
							className="h-12 w-12 rounded-xl shrink-0"
						/>
						<div className="flex-1 min-w-0">
							<div className="text-base font-semibold text-foreground truncate">
								{space.name}
							</div>
							<div className="text-xs text-muted-foreground truncate">
								{childRooms.length} {childRooms.length === 1 ? "room" : "rooms"}
								{memberCount > 0 ? ` · up to ${memberCount} members` : ""}
							</div>
						</div>
						{unread > 0 ? (
							<span className="ml-auto inline-flex items-center justify-center min-w-[22px] h-[22px] px-2 rounded-full bg-destructive text-destructive-foreground text-[11px] font-bold">
								{unread > 99 ? "99+" : unread}
							</span>
						) : (
							<ArrowRight className="h-4 w-4 text-muted-foreground/50 shrink-0" />
						)}
					</button>
				);
			})}
		</div>
	);
}

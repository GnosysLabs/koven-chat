// SpacesListMobile — the "Spaces" tab landing on mobile.  Shows the
// user's joined spaces as an iOS HIG list; tapping a row drills into
// that space's home (SpaceHomeMobile).
//
// HIG calibration:
//   - 34pt Large Title at the top.  Stays static for now (no scroll-
//     collapse to compact title yet — that's an iOS-26 polish for
//     later when we wire scroll observation).
//   - List rows: 17pt primary title + 13pt secondary (member count
//     + room count) + chevron.  Avatar leads at 48pt rounded-2xl.
//   - Row height 64pt — fits 44pt min target + comfortable padding.
//   - Hairline dividers between rows (iOS "inset grouped" feel).
//   - Press state: `active:bg-foreground/5` for tactile feedback.
//   - Haptic light-impact on tap.
//
// The screen sits BETWEEN the MobileTopBar and MobileTabBar — those
// already paint their own translucent material.  Content scrolls
// behind both (with bottom padding clearance for the tab bar pill).

import { useMemo } from "react";
import { ChevronRight, LayoutGrid } from "lucide-react";
import type { Space, Room } from "@koven/shared";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { hapticImpact } from "@/lib/haptics";

interface SpacesListMobileProps {
	spaces: Space[];
	rooms: Room[];
	onOpenSpace(spaceId: string): void;
}

export function SpacesListMobile({ spaces, rooms, onOpenSpace }: SpacesListMobileProps) {
	// Sort spaces alphabetically — same convention the SpaceBar
	// uses on desktop.  Cheap; could swap to last-active later.
	const sorted = useMemo(
		() => [...spaces].sort((a, b) => a.name.localeCompare(b.name)),
		[spaces],
	);

	// Pre-aggregate per-space counts so each row doesn't iterate the
	// full rooms list again on every render.
	const roomCountBySpace = useMemo(() => {
		const m = new Map<string, number>();
		for (const r of rooms) {
			for (const sid of r.parentSpaceIds) {
				m.set(sid, (m.get(sid) ?? 0) + 1);
			}
		}
		return m;
	}, [rooms]);

	function selectSpace(id: string) {
		void hapticImpact("light");
		onOpenSpace(id);
	}

	return (
		// No own bg — lets the parent overlay's --bg-gradient (and
		// behind it body::before) show through, so this surface
		// inherits the user's theme colour tones the way the chat
		// pane does.
		<div className="flex-1 min-h-0 overflow-y-auto">
			{/* Pad the bottom so the last row clears the floating tab
			    bar (49pt pill + 8pt margin + safe-area-bottom). */}
			<div
				className="px-4 pt-2"
				style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 80px)" }}
			>
				<h1 className="text-[34px] font-bold tracking-[-0.022em] leading-[1.1] text-foreground py-3">
					Spaces
				</h1>

				{sorted.length === 0 ? (
					<EmptyState />
				) : (
					<div className="rounded-2xl bg-card/60 backdrop-blur-xl border border-foreground/10 overflow-hidden">
						{sorted.map((s, idx) => (
							<SpaceRow
								key={s.id}
								space={s}
								roomCount={roomCountBySpace.get(s.id) ?? 0}
								onClick={() => selectSpace(s.id)}
								// Hairline between rows, inset to match
								// iOS "Settings" grouped-list look — the
								// avatar's left edge defines the inset.
								showDivider={idx > 0}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function SpaceRow({
	space, roomCount, onClick, showDivider,
}: {
	space: Space;
	roomCount: number;
	onClick(): void;
	showDivider: boolean;
}) {
	const memberLabel = space.kind === "private"
		? "Private"
		: `${roomCount} ${roomCount === 1 ? "room" : "rooms"}`;
	return (
		<>
			{showDivider && (
				<div className="ml-[76px] h-px bg-foreground/8" aria-hidden />
			)}
			<button
				type="button"
				onClick={onClick}
				className="w-full flex items-center gap-3 px-4 py-3 active:bg-foreground/[0.06] transition-colors"
			>
				<MatrixAvatar
					mxc={space.avatarUrl}
					emoji={space.iconEmoji}
					seed={space.id}
					kind="room"
					className="h-12 w-12 rounded-2xl shrink-0"
				/>
				<div className="flex-1 min-w-0 text-left">
					<div className="text-[17px] font-medium text-foreground truncate">
						{space.name || "Untitled space"}
					</div>
					<div className="text-[13px] text-muted-foreground truncate">
						{space.topic ? space.topic : memberLabel}
					</div>
				</div>
				<ChevronRight className="h-5 w-5 text-muted-foreground/60 shrink-0" strokeWidth={2.5} />
			</button>
		</>
	);
}

function EmptyState() {
	return (
		<div className="flex flex-col items-center justify-center gap-3 py-20 px-6 text-center">
			<div className="size-16 rounded-2xl bg-foreground/[0.06] flex items-center justify-center">
				<LayoutGrid className="size-7 text-muted-foreground" strokeWidth={1.8} />
			</div>
			<div className="text-[17px] font-medium text-foreground">No spaces yet</div>
			<p className="text-[15px] text-muted-foreground max-w-[260px] leading-snug">
				Spaces group rooms by community. Join one from Explore or wait for an invite.
			</p>
		</div>
	);
}

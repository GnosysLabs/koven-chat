// SpacesListMobile — the "Spaces" tab landing on mobile.  Shows the
// user's joined spaces as an iOS HIG list; tapping a row drills into
// that space's home (SpaceHomeMobile).  Long-pressing a row opens the
// same context menu the desktop SpaceBar offers on right-click.

import { useRef, useMemo, useState } from "react";
import { ChevronRight, LayoutGrid, Plus } from "lucide-react";
import type { Space, Room, UserId } from "@koven/shared";
import type { MatrixTransport } from "@/lib/matrix";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { SpaceTileContextMenu } from "@/components/SpaceTileContextMenu";
import { buildInviteUrl } from "@/lib/inviteLink";
import { hapticImpact } from "@/lib/haptics";

interface SpacesListMobileProps {
	spaces: Space[];
	rooms: Room[];
	currentUserId: UserId;
	accessToken: string;
	transport: MatrixTransport | null;
	onOpenSpace(spaceId: string): void;
	onEditSpace?(spaceId: string): void;
	onManageCategories?(spaceId: string): void;
	onAddRoom?(spaceId: string): void;
	onLeaveSpace?(spaceId: string): void;
	onDeleteSpace?(spaceId: string): void;
	onMarkAllReadInSpace?(spaceId: string): void;
	onCreateSpace?(): void;
}

export function SpacesListMobile({
	spaces, rooms, currentUserId, accessToken, transport,
	onOpenSpace, onEditSpace, onManageCategories, onAddRoom,
	onLeaveSpace, onDeleteSpace, onMarkAllReadInSpace, onCreateSpace,
}: SpacesListMobileProps) {
	const sorted = useMemo(
		() => [...spaces].sort((a, b) => a.name.localeCompare(b.name)),
		[spaces],
	);

	const roomCountBySpace = useMemo(() => {
		const m = new Map<string, number>();
		for (const r of rooms) {
			for (const sid of r.parentSpaceIds) {
				m.set(sid, (m.get(sid) ?? 0) + 1);
			}
		}
		return m;
	}, [rooms]);

	const [ctxMenu, setCtxMenu] = useState<{ space: Space; x: number; y: number } | null>(null);

	function selectSpace(id: string) {
		void hapticImpact("light");
		onOpenSpace(id);
	}

	function roomsInSpace(space: Space): Room[] {
		return rooms.filter(r =>
			space.childRoomIds.includes(r.id) || r.parentSpaceIds.includes(space.id),
		);
	}

	return (
		<div className="flex-1 min-h-0 overflow-y-auto">
			<div
				className="pt-2"
				style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 80px)" }}
			>
				<div className="flex items-center justify-between py-3 px-4">
					<h1 className="text-[34px] font-bold tracking-[-0.022em] leading-[1.1] text-foreground">
						Spaces
					</h1>
					{onCreateSpace && (
						<button
							type="button"
							onClick={() => { void hapticImpact("light"); onCreateSpace(); }}
							className="size-10 rounded-full bg-primary flex items-center justify-center active:opacity-80 transition-opacity"
							aria-label="Create a space"
						>
							<Plus className="size-5 text-primary-foreground" strokeWidth={2.5} />
						</button>
					)}
				</div>

				{sorted.length === 0 ? (
					<EmptyState onCreateSpace={onCreateSpace} />
				) : (
					<div>
						{sorted.map((s, idx) => (
							<SpaceRow
								key={s.id}
								space={s}
								roomCount={roomCountBySpace.get(s.id) ?? 0}
								onClick={() => selectSpace(s.id)}
								onLongPress={(pos) => setCtxMenu({ space: s, ...pos })}
								showDivider={idx > 0}
							/>
						))}
					</div>
				)}
			</div>

			{ctxMenu && transport && (
				<SpaceTileContextMenu
					x={ctxMenu.x}
					y={ctxMenu.y}
					space={ctxMenu.space}
					currentUserId={currentUserId}
					accessToken={accessToken}
					roomsInSpace={roomsInSpace(ctxMenu.space)}
					onMarkAllRead={() => {
						const ids = roomsInSpace(ctxMenu.space).map(r => r.id);
						for (const rid of ids) {
							transport.markAsRead(rid).catch(err => {
								console.warn(`SpacesListMobile: markAsRead ${rid} failed`, err);
							});
						}
						onMarkAllReadInSpace?.(ctxMenu.space.id);
					}}
					onCopyId={() => {
						void navigator.clipboard.writeText(ctxMenu.space.id);
					}}
					onCopyInviteLink={() => {
						void navigator.clipboard.writeText(buildInviteUrl(ctxMenu.space.id));
					}}
					onEdit={onEditSpace ? () => onEditSpace(ctxMenu.space.id) : undefined}
					onManageCategories={onManageCategories ? () => onManageCategories(ctxMenu.space.id) : undefined}
					onAddRoom={onAddRoom ? () => onAddRoom(ctxMenu.space.id) : undefined}
					onLeave={() => {
						if (onLeaveSpace) onLeaveSpace(ctxMenu.space.id);
						else transport.leaveRoom(ctxMenu.space.id).catch(err => {
							console.warn("SpacesListMobile: leave space failed", err);
						});
					}}
					onDelete={onDeleteSpace ? () => onDeleteSpace(ctxMenu.space.id) : undefined}
					onClose={() => setCtxMenu(null)}
				/>
			)}
		</div>
	);
}

function SpaceRow({
	space, roomCount, onClick, onLongPress, showDivider,
}: {
	space: Space;
	roomCount: number;
	onClick(): void;
	onLongPress(pos: { x: number; y: number }): void;
	showDivider: boolean;
}) {
	const timerRef = useRef<number | null>(null);
	const startRef = useRef<{ x: number; y: number } | null>(null);
	const firedRef = useRef(false);

	function onTouchStart(e: React.TouchEvent) {
		const t = e.touches[0];
		if (!t) return;
		startRef.current = { x: t.clientX, y: t.clientY };
		firedRef.current = false;
		timerRef.current = window.setTimeout(() => {
			timerRef.current = null;
			firedRef.current = true;
			void hapticImpact("medium");
			onLongPress(startRef.current!);
		}, 500);
	}

	function onTouchMove(e: React.TouchEvent) {
		if (timerRef.current === null) return;
		const t = e.touches[0];
		if (!t || !startRef.current) return;
		if (Math.abs(t.clientX - startRef.current.x) > 8 || Math.abs(t.clientY - startRef.current.y) > 8) {
			window.clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}

	function onTouchEnd() {
		if (timerRef.current !== null) {
			window.clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		startRef.current = null;
	}

	const memberLabel = space.kind === "private"
		? "Private"
		: `${roomCount} ${roomCount === 1 ? "room" : "rooms"}`;
	return (
		<>
			{showDivider && (
				<div className="ml-[68px] h-px bg-foreground/[0.08]" aria-hidden />
			)}
			<button
				type="button"
				onClick={() => { if (!firedRef.current) onClick(); }}
				onTouchStart={onTouchStart}
				onTouchMove={onTouchMove}
				onTouchEnd={onTouchEnd}
				onTouchCancel={onTouchEnd}
				className="w-full flex items-center gap-3 pl-4 pr-3 py-2.5 active:bg-foreground/[0.06] transition-colors select-none [-webkit-user-select:none] [-webkit-touch-callout:none]"
			>
				<MatrixAvatar
					mxc={space.avatarUrl}
					emoji={space.iconEmoji}
					seed={space.id}
					kind="room"
					className="h-[52px] w-[52px] rounded-2xl shrink-0"
				/>
				<div className="flex-1 min-w-0 text-left">
					<div className="text-[17px] font-medium text-foreground truncate leading-tight">
						{space.name || "Untitled space"}
					</div>
					<div className="text-[15px] text-muted-foreground leading-snug line-clamp-2">
						{space.topic ? space.topic : memberLabel}
					</div>
				</div>
				<ChevronRight
					className="self-center shrink-0 size-[18px] text-muted-foreground/40 -mr-1"
					strokeWidth={2.5}
					aria-hidden
				/>
			</button>
		</>
	);
}

function EmptyState({ onCreateSpace }: { onCreateSpace?(): void }) {
	return (
		<div className="flex flex-col items-center justify-center gap-3 py-20 px-6 text-center">
			<div className="size-16 rounded-2xl bg-foreground/[0.06] flex items-center justify-center">
				<LayoutGrid className="size-7 text-muted-foreground" strokeWidth={1.8} />
			</div>
			<div className="text-[17px] font-medium text-foreground">No spaces yet</div>
			<p className="text-[15px] text-muted-foreground max-w-[260px] leading-snug">
				Spaces group rooms by community. Create one or wait for an invite.
			</p>
			{onCreateSpace && (
				<button
					type="button"
					onClick={() => { void hapticImpact("light"); onCreateSpace(); }}
					className="mt-2 px-5 py-2.5 rounded-full bg-primary text-primary-foreground text-[15px] font-medium active:opacity-80 transition-opacity"
				>
					Create a space
				</button>
			)}
		</div>
	);
}

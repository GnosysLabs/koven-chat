// SpaceHomeMobile — drill-in view shown when the user taps a space
// from SpacesListMobile.  Header summarises the space (avatar, name,
// topic, member/encryption pills, founder actions), and the body
// lists the rooms in the space as an iOS HIG list.  Tapping a room
// dispatches `set_active_room` and the ChatPane takes over.
//
// HIG calibration:
//   - Centered hero header — large avatar, name in Title 2 weight,
//     topic as 15pt secondary, optional E2EE pill.
//   - Action chips inline below the header (Add Room / Invite /
//     Settings) — only the ones the user has permission to use.
//   - Rooms list: iOS inset-grouped style.  Each row: rounded-md
//     avatar + 17pt room name + 13pt secondary (member count /
//     unread).  Unread badge mirrors the chat-pane convention.

import { useRef, useMemo, useState } from "react";
import type { Room, RoomId, Space, UserId } from "@koven/shared";
import { ChevronRight, Hash, Lock, Plus, Settings, UserPlus } from "lucide-react";
import type { MatrixTransport } from "@/lib/matrix";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { RoomRowContextMenu } from "@/components/RoomRowContextMenu";
import { groupRoomsByCategory } from "@/components/RoomList";
import { hapticImpact } from "@/lib/haptics";
import { cn } from "@/lib/utils";

interface SpaceHomeMobileProps {
	space: Space;
	rooms: Room[];                  // pre-filtered: rooms whose parentSpaceIds contains space.id
	currentUserId: UserId;
	accessToken: string;
	transport: MatrixTransport | null;
	onSelectRoom(roomId: RoomId): void;
	onAddRoom?(): void;
	onInvite?(): void;
	onOpenSettings?(): void;
	onEditRoom?(roomId: RoomId): void;
	onLeaveRoom?(roomId: RoomId): void;
	onDeleteRoom?(roomId: RoomId): void;
}

export function SpaceHomeMobile({
	space, rooms, currentUserId, accessToken, transport,
	onSelectRoom, onAddRoom, onInvite, onOpenSettings,
	onEditRoom, onLeaveRoom, onDeleteRoom,
}: SpaceHomeMobileProps) {
	// PL gates: same threshold the desktop SpaceLanding uses.  PL ≥ 50
	// is Matrix's default for sending state events, which is what every
	// admin action eventually boils down to.
	const canModerate = (space.myPowerLevel ?? 0) >= 50;
	const showAddRoom = canModerate && !!onAddRoom;
	const showSettings = canModerate && !!onOpenSettings;
	const showInvite = !!onInvite;

	// Respect the admin's category groupings + per-room order key
	// from the parent space's m.space.child events.  Same logic the
	// desktop sidebar uses — single source of truth means founders
	// don't have to keep separate orderings in their head.
	const groups = useMemo(() => groupRoomsByCategory(rooms, space), [rooms, space]);

	const [ctxMenu, setCtxMenu] = useState<{ room: Room; x: number; y: number } | null>(null);

	function selectRoom(id: RoomId) {
		void hapticImpact("light");
		onSelectRoom(id);
	}

	return (
		// Transparent so the parent overlay's --bg-gradient shows
		// through — same approach as SpacesListMobile.
		<div className="flex-1 min-h-0 overflow-y-auto">
			<div
				className="pt-4"
				style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 80px)" }}
			>
				{/* ── Header card ───────────────────────────────────── */}
				<div className="flex flex-col items-center text-center pt-2 pb-6 px-4">
					<MatrixAvatar
						mxc={space.avatarUrl}
						emoji={space.iconEmoji}
						seed={space.id}
						kind="room"
						className="h-20 w-20 rounded-3xl shadow-lg shadow-black/30"
					/>
					<h1 className="mt-3 text-[24px] font-bold tracking-tight text-foreground leading-tight">
						{space.name || "Untitled space"}
					</h1>
					{space.topic && (
						<p className="mt-1 text-[15px] text-muted-foreground leading-snug max-w-[280px]">
							{space.topic}
						</p>
					)}
					<div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
						{space.kind === "private" && (
							<MetaPill tone="neutral">Private</MetaPill>
						)}
					</div>

					{(showAddRoom || showInvite || showSettings) && (
						<div className="mt-5 flex items-center justify-center gap-2">
							{showAddRoom && (
								<ActionChip icon={<Plus className="h-4 w-4" />} onClick={onAddRoom!}>
									Add room
								</ActionChip>
							)}
							{showInvite && (
								<ActionChip icon={<UserPlus className="h-4 w-4" />} onClick={onInvite!}>
									Invite
								</ActionChip>
							)}
							{showSettings && (
								<ActionChip icon={<Settings className="h-4 w-4" />} onClick={onOpenSettings!}>
									Settings
								</ActionChip>
							)}
						</div>
					)}
				</div>

				{/* ── Grouped rooms list ────────────────────────────── */}
				{rooms.length === 0 ? (
					<div className="px-4">
						<div className="px-1 pb-1 text-[13px] uppercase tracking-wider text-muted-foreground font-medium">
							Rooms
						</div>
						<EmptyRooms />
					</div>
				) : (
					groups
						.filter(g => g.rooms.length > 0)
						.map((group, gi) => (
							<div key={group.id ?? "uncategorised"} className={gi > 0 ? "mt-5" : undefined}>
								<div className="px-5 pb-1.5 text-[13px] uppercase tracking-wider text-muted-foreground font-medium">
									{group.name ?? (groups.filter(g => g.rooms.length > 0).length === 1 ? "Rooms" : "General")}
								</div>
								<div>
									{group.rooms.map((r, idx) => (
										<RoomRow
											key={r.id}
											room={r}
											onClick={() => selectRoom(r.id)}
											onLongPress={(pos) => setCtxMenu({ room: r, ...pos })}
											showDivider={idx > 0}
										/>
									))}
								</div>
							</div>
						))
				)}
			</div>

			{ctxMenu && transport && (
				<RoomRowContextMenu
					x={ctxMenu.x}
					y={ctxMenu.y}
					room={ctxMenu.room}
					currentUserId={currentUserId}
					accessToken={accessToken}
					activeSpaceId={space.id}
					isFounder={ctxMenu.room.creatorId === currentUserId}
					canEdit={(space.myPowerLevel ?? 0) >= 50}
					onMarkRead={() => {
						transport.markAsRead(ctxMenu.room.id).catch(err => {
							console.warn(`SpaceHomeMobile: markAsRead failed`, err);
						});
					}}
					onMarkUnread={() => {}}
					onCopyId={() => {
						void navigator.clipboard.writeText(ctxMenu.room.id);
					}}
					onEdit={onEditRoom ? () => onEditRoom(ctxMenu.room.id) : undefined}
					onLeave={() => {
						if (onLeaveRoom) onLeaveRoom(ctxMenu.room.id);
						else transport.leaveRoom(ctxMenu.room.id).catch(err => {
							console.warn("SpaceHomeMobile: leave room failed", err);
						});
					}}
					onDelete={onDeleteRoom ? () => onDeleteRoom(ctxMenu.room.id) : undefined}
					onClose={() => setCtxMenu(null)}
				/>
			)}
		</div>
	);
}

function RoomRow({
	room, onClick, onLongPress, showDivider,
}: {
	room: Room;
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

	const unread = room.unreadCount ?? 0;
	const hasHighlight = (room.highlightCount ?? 0) > 0;
	return (
		<>
			{showDivider && <div className="ml-[68px] h-px bg-foreground/[0.08]" aria-hidden />}
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
					mxc={room.avatarUrl}
					emoji={room.iconEmoji}
					seed={room.id}
					kind="room"
					className="h-[52px] w-[52px] rounded-xl shrink-0"
				/>
				<div className="flex-1 min-w-0 text-left">
					<div className="flex items-center gap-1.5">
						{room.encrypted && (
							<Lock className="h-3 w-3 text-muted-foreground shrink-0" strokeWidth={2.5} />
						)}
						<div className={cn(
							"text-[17px] truncate leading-tight",
							unread > 0 ? "font-semibold text-foreground" : "font-medium text-foreground",
						)}>
							{room.name || (
								<span className="inline-flex items-center gap-1">
									<Hash className="h-3.5 w-3.5" /> Unnamed room
								</span>
							)}
						</div>
					</div>
					<div className="text-[15px] text-muted-foreground leading-snug line-clamp-2">
						{room.topic
							? room.topic
							: `${room.memberCount} ${room.memberCount === 1 ? "member" : "members"}`}
					</div>
				</div>
				{unread > 0 ? (
					<UnreadBadge count={unread} highlight={hasHighlight} />
				) : (
					<ChevronRight
						className="self-center shrink-0 size-[18px] text-muted-foreground/40 -mr-1"
						strokeWidth={2.5}
						aria-hidden
					/>
				)}
			</button>
		</>
	);
}

function UnreadBadge({ count, highlight }: { count: number; highlight: boolean }) {
	return (
		<span
			className={cn(
				"shrink-0 min-w-[22px] h-[22px] px-1.5 rounded-full",
				"text-[12px] font-bold leading-none",
				"flex items-center justify-center",
				highlight ? "bg-destructive text-destructive-foreground" : "bg-foreground/15 text-foreground",
			)}
		>
			{count > 99 ? "99+" : count}
		</span>
	);
}

function MetaPill({ tone, icon, children }: {
	tone: "emerald" | "neutral";
	icon?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<span className={cn(
			"inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium",
			tone === "emerald"
				? "border border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
				: "border border-foreground/15 bg-foreground/[0.06] text-muted-foreground",
		)}>
			{icon}{children}
		</span>
	);
}

function ActionChip({ icon, children, onClick }: {
	icon: React.ReactNode;
	children: React.ReactNode;
	onClick(): void;
}) {
	return (
		<button
			type="button"
			onClick={() => { void hapticImpact("light"); onClick(); }}
			className={cn(
				"inline-flex items-center gap-1.5 px-3 h-9 rounded-full",
				"bg-foreground/[0.08] hover:bg-foreground/[0.12] active:bg-foreground/[0.16]",
				"text-[14px] font-medium text-foreground",
				"transition-colors duration-150",
			)}
		>
			{icon}
			<span>{children}</span>
		</button>
	);
}

function EmptyRooms() {
	return (
		<div className="rounded-2xl bg-card/40 border border-foreground/10 px-6 py-10 text-center">
			<div className="text-[15px] text-muted-foreground leading-snug">
				No rooms here yet.  Founders can add one with the button above.
			</div>
		</div>
	);
}

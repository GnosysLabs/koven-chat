// Second column — the room list scoped to whatever's selected in the
// SpaceBar.
//   - DMs: every DM the user is in, sorted by recency (last-active
//     conversation bubbles up — DMs aren't admin-managed, so recency
//     is the natural sort).
//   - A specific space: only rooms whose parentSpaceIds include that
//     space's id, rendered in admin-dictated order grouped by
//     category.  The order comes from each room's
//     `m.space.child.order` field on the parent space; the category
//     id comes from `m.space.child.chat.koven.category`; the
//     category display order comes from the parent space's
//     `chat.koven.space.categories` state event.

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { Room, RoomId, Space, UserId } from "@koven/shared";
import { BellOff, ChevronDown, ChevronRight, Check, Copy, Lock, Plus, UserX, X } from "lucide-react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { RoomRowContextMenu } from "@/components/RoomRowContextMenu";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { getRoomNotifyLevel, onNotifyPrefsChanged } from "@/lib/notifyPrefs";
import type { ActiveSpace } from "@/state/store";
import type { MatrixTransport } from "@/lib/matrix";
import {
	DndContext, PointerSensor, useSensor, useSensors,
	closestCenter, DragOverlay,
	type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import {
	SortableContext, useSortable, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { orderKeyBetween } from "@/lib/orderKeys";

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
	// Right-click → "Delete conversation" on a DM row routes here
	// instead of calling transport.leaveRoom directly.  The parent
	// opens the bilateral-purge confirmation dialog (shared with the
	// DmProfilePanel's "Delete conversation" button); confirming
	// inside that dialog is what actually fires transport.deleteDm.
	// A right-click that ran the server-side purge without
	// confirmation would be too easy to misfire on a destructive,
	// irreversible action.
	onRequestDeleteDm?(roomId: RoomId): void;
	// Set of mxids known to be bots.  Used by the per-row avatar
	// to pick the right DiceBear style for bot DMs (kind="bot" →
	// bottts robot fallback) instead of the default kind="user"
	// fun-emoji face.  Without this the DM sidebar shows a yellow
	// smiley for a bot DM while the same conversation's chat
	// header + profile show the bot robot — visibly inconsistent.
	botMxids?: Set<UserId>;
	// Subset of bot mxids the viewer owns.  Used to suppress the
	// "Block user" right-click affordance on DM rows whose peer is
	// the viewer's own bot — blocking your own bot is incoherent
	// (you control its prompt/config and the m.ignored_user_list
	// entry would just confuse the bot's ability to address you).
	myOwnedBotMxids?: Set<UserId>;
	// Admin drag-and-drop handler.  Called when an admin drags a room
	// to a new position in the categorised list — either within its
	// current category or into a different one.  Receives the moved
	// room's id, the precomputed order key for its new position, and
	// the destination category id (`null` for the implicit
	// uncategorised bucket).  Optional — when omitted, rooms aren't
	// draggable.  The caller is responsible for the PL gate (only
	// admins should pass a handler).
	onMoveRoom?(spaceId: RoomId, roomId: RoomId, order: string, category: string | null): Promise<void> | void;
}

// Power-level threshold for editing space-wide state events
// (`m.space.child`, `chat.koven.space.categories`).  Matches the
// state_default Synapse uses out of the box; Koven's createSpace
// sets it to 100 so in practice founder-only on Koven-created
// spaces.
const ADMIN_PL_THRESHOLD = 50;

export function RoomList({
	rooms, spaces, activeSpace, activeRoomId, currentUserId,
	onSelectRoom, onCreateRoom, onAcceptInvite, onDeclineInvite,
	roomsLoaded, transport, accessToken,
	onEditRoom, onOpenProfile, onRequestDeleteDm, botMxids,
	myOwnedBotMxids,
	onMoveRoom,
}: RoomListProps) {
	const activeSpaceObj = activeSpace?.kind === "space"
		? spaces.find(s => s.id === activeSpace.id) ?? null
		: null;

	const visibleRooms = filterRooms(rooms, activeSpace);
	// Pending invites bubble to the top of the list as request rows
	// with inline Accept/Decline buttons; "joined" rooms render as the
	// usual clickable conversation rows below.
	const inviteRooms = visibleRooms.filter(r => r.isInvite);
	const joinedRooms = visibleRooms.filter(r => !r.isInvite);
	const header = headerFor(activeSpace, spaces);

	// Per-space groups (categories) — only meaningful inside a real
	// space.  DMs render as a single flat list so the recency sort
	// below applies uniformly.
	const groups = activeSpace?.kind === "space" && activeSpaceObj
		? groupRoomsByCategory(joinedRooms, activeSpaceObj)
		: null;
	// DMs and the home pseudo-spaces sort by recency; rooms in a
	// real space sort by admin order inside groupRoomsByCategory.
	const flatDmList = activeSpace?.kind === "dms"
		? joinedRooms.slice().sort((a, b) => recencyOf(b) - recencyOf(a))
		: joinedRooms;
	// Admin drag-and-drop gate: only PL ≥ 50 in the active space, and
	// only when the parent supplied an `onMoveRoom` handler (App.tsx
	// hands it down whenever a real space is active).  Non-admins see
	// no drag affordances — drag handles are hidden + pointer events
	// fall through to normal click.
	const canDragRooms = activeSpace?.kind === "space"
		&& !!activeSpaceObj
		&& (activeSpaceObj.myPowerLevel ?? 0) >= ADMIN_PL_THRESHOLD
		&& !!onMoveRoom;

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
							{emptyHintFor(activeSpace, canCreateRoomHere)}
						</div>
					) : null
				) : groups ? (
					// Categorised render for a real space — uncategorised
					// bucket first (no header, Discord-style), then each
					// admin-defined category with its header.
					<RoomGroupedList
						groups={groups}
						spaceId={activeSpaceObj!.id}
						activeRoomId={activeRoomId}
						currentUserId={currentUserId}
						transport={transport ?? null}
						accessToken={accessToken ?? null}
						onSelectRoom={onSelectRoom}
						onEditRoom={onEditRoom}
						onOpenProfile={onOpenProfile}
						onRequestDeleteDm={onRequestDeleteDm}
						botMxids={botMxids}
						canDrag={canDragRooms}
						onMoveRoom={onMoveRoom}
					/>
				) : (
					// Flat list for DMs (already recency-sorted) and any
					// non-space pseudo-tab that bypasses categorisation.
					flatDmList.map(room => (
						<RoomRow
							key={room.id}
							room={room}
							active={room.id === activeRoomId}
							onSelect={() => onSelectRoom(room.id)}
							currentUserId={currentUserId}
							transport={transport ?? null}
							accessToken={accessToken ?? null}
							activeSpaceId={activeSpaceObj?.id ?? null}
							onEditRoom={onEditRoom}
							onOpenProfile={onOpenProfile}
							onRequestDeleteDm={onRequestDeleteDm}
							isBotPeer={
								room.kind === "dm" && !!room.dmUserId && !!botMxids?.has(room.dmUserId)
							}
							isMyBotPeer={
								room.kind === "dm" && !!room.dmUserId && !!myOwnedBotMxids?.has(room.dmUserId)
							}
						/>
					))
				)}
			</nav>
		</aside>
	);
}

/** Last-active timestamp of a room.  Source of truth for DM
 * recency sort.  Falls back to 0 when missing so rooms without
 * a known ts anchor at the bottom. */
function recencyOf(room: Room): number {
	return room.lastActiveTs || 0;
}

export interface RoomGroup {
	/** `null` for the implicit "Uncategorised" bucket rendered above
	 * the admin-defined categories (Discord-style); a category id from
	 * `Space.categories` otherwise. */
	id: string | null;
	/** Display label for the group header.  Null for the uncategorised
	 * bucket — its rooms render without a header at the top of the
	 * list. */
	name: string | null;
	rooms: Room[];
}

/** Split a flat room list into the categorised groups the sidebar
 * renders.  The order inside each group follows the room's
 * `m.space.child.order` field (lexicographic ascending), with
 * unkeyed rooms falling to the bottom alphabetically — that way a
 * fresh space with no admin order yet still renders predictably.
 *
 * Categories that exist in `space.categories` but have no rooms
 * still appear so admins can drop rooms into them via drag-and-
 * drop later.  Categories referenced by some room but missing from
 * the space.categories list (orphan reference, e.g. category was
 * renamed/deleted) fall through to the uncategorised group so the
 * room doesn't vanish from the sidebar. */
export function groupRoomsByCategory(rooms: Room[], space: Space): RoomGroup[] {
	const spaceId = space.id;
	const known = new Set(space.categories.map(c => c.id));
	const uncategorised: Room[] = [];
	const byCategory = new Map<string, Room[]>();
	for (const cat of space.categories) byCategory.set(cat.id, []);

	for (const room of rooms) {
		const meta = room.spaceChildMeta?.[spaceId];
		const catId = meta?.category;
		if (catId && known.has(catId)) {
			byCategory.get(catId)!.push(room);
		} else {
			uncategorised.push(room);
		}
	}

	const sortRooms = (list: Room[]) => {
		list.sort((a, b) => {
			const ao = a.spaceChildMeta?.[spaceId]?.order;
			const bo = b.spaceChildMeta?.[spaceId]?.order;
			// Rooms with an explicit order key sort before those without.
			// Both with: lexicographic.  Both without: alphabetical.
			if (ao !== undefined && bo === undefined) return -1;
			if (ao === undefined && bo !== undefined) return 1;
			if (ao !== undefined && bo !== undefined && ao !== bo) {
				return ao < bo ? -1 : 1;
			}
			return a.name.localeCompare(b.name);
		});
	};
	sortRooms(uncategorised);
	for (const list of byCategory.values()) sortRooms(list);

	const groups: RoomGroup[] = [];
	groups.push({ id: null, name: null, rooms: uncategorised });
	for (const cat of space.categories) {
		groups.push({ id: cat.id, name: cat.name, rooms: byCategory.get(cat.id)! });
	}
	return groups;
}

function filterRooms(rooms: Room[], activeSpace: ActiveSpace): Room[] {
	if (!activeSpace) return [];
	if (activeSpace.kind === "explore") return [];
	if (activeSpace.kind === "bots") return [];
	if (activeSpace.kind === "dms") return rooms.filter(r => r.kind === "dm");
	const id = activeSpace.id;
	return rooms.filter(r => r.parentSpaceIds.includes(id));
}

function headerFor(activeSpace: ActiveSpace, spaces: Space[]): string {
	if (!activeSpace) return "";
	if (activeSpace.kind === "explore") return "Explore";
	if (activeSpace.kind === "bots") return "Bots";
	if (activeSpace.kind === "dms") return "Direct messages";
	const space = spaces.find(s => s.id === activeSpace.id);
	return space?.name ?? "Space";
}

function emptyHintFor(activeSpace: ActiveSpace, canCreate: boolean): string {
	if (!activeSpace) return "";
	if (activeSpace.kind === "explore") {
		return "Browse public spaces in the main pane. Joined ones show up in your sidebar.";
	}
	if (activeSpace.kind === "dms") {
		return "No direct messages yet. Start a DM with someone and it'll show up here.";
	}
	// In-space empty state.  Only the space creator sees the
	// "create one" CTA — non-creators can't actually create rooms
	// (m.space.child linking 403s without PL 100), and telling them
	// to use a `+` they don't have is confusing.  Show a neutral
	// "waiting on the founder" message instead.
	if (canCreate) {
		return "No rooms in this space yet. Use the + above to create one.";
	}
	return "No rooms in this space yet. The founder hasn't added any channels — they'll show up here when they do.";
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
			{/* DMs get a presence dot; rooms get nothing in the
			    bottom-right corner anymore.  Public/private now
			    lives on the SPACE tile (see SpaceTileAvatar in
			    SpaceBar.tsx) since every room in a space inherits
			    its visibility — duplicating the glyph per-room
			    just added noise. */}
			{isDm && <DmPresenceDot presence={room.dmPresence} />}
		</div>
	);
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

/** Renders a list of `RoomGroup`s — the uncategorised bucket at the
 * top with no header, then each admin-defined category with a
 * collapse/expand header.  Empty categories still render (header
 * only) so admins always have a drop target via drag-and-drop.
 *
 * When `canDrag` is true (caller passed `onMoveRoom` AND viewer has
 * the PL), every room becomes a sortable item.  dnd-kit manages a
 * single `DndContext` across all categories so a room can be dragged
 * BETWEEN categories with the same gesture (Discord pattern).
 *
 * For non-admins (or non-space tabs) we render without the DnD
 * wrapper so pointer events fall through normally — clicks land on
 * the row button, no drag activation distance to fight. */
function RoomGroupedList({
	groups, spaceId, activeRoomId,
	currentUserId, transport, accessToken,
	onSelectRoom, onEditRoom, onOpenProfile, onRequestDeleteDm, botMxids,
	canDrag, onMoveRoom,
}: {
	groups: RoomGroup[];
	spaceId: RoomId;
	activeRoomId: RoomId | null;
	currentUserId: UserId;
	transport: MatrixTransport | null;
	accessToken: string | null;
	onSelectRoom(roomId: RoomId): void;
	onEditRoom?(roomId: RoomId): void;
	onOpenProfile?(userId: UserId): void;
	onRequestDeleteDm?(roomId: RoomId): void;
	botMxids?: Set<UserId>;
	canDrag: boolean;
	onMoveRoom?(spaceId: RoomId, roomId: RoomId, order: string, category: string | null): Promise<void> | void;
}) {
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	const toggle = (id: string) => {
		setCollapsed(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id); else next.add(id);
			return next;
		});
	};

	// Drag state — what's currently being dragged, used by DragOverlay
	// to render a floating preview of the lifted row.
	const [activeDragId, setActiveDragId] = useState<string | null>(null);

	// ─── Optimistic move overrides ─────────────────────────────────
	// dnd-kit animates a dragged item back to its original position
	// when the drop completes, BEFORE the parent's onMoveRoom promise
	// has round-tripped to the homeserver and the new `m.space.child`
	// state event has echoed back through /sync.  Without an
	// optimistic layer, the user sees:
	//   1. drop the room
	//   2. row animates back to where it started (dnd-kit unwinds)
	//   3. ~200ms later the state event lands, parent re-renders, row
	//      "pops" into its new position
	// The fix is to record the predicted (order, category) of the
	// dragged room locally and apply it to props.groups in render —
	// the parent's eventual prop update is then a no-op visually
	// because the local override already moved the row.  Once props
	// reflect the override, we clear it (and on RPC failure, we clear
	// it too, surfacing the actual server state).
	const [pendingMoves, setPendingMoves] = useState<
		Map<RoomId, { order: string; category: string | null }>
	>(new Map());

	// Apply pending overrides to props.groups.  In the steady state
	// (no pending moves) this returns `groups` unchanged so the perf
	// path is identical.  When overrides are present we flatten,
	// patch each overridden room's `spaceChildMeta[spaceId]`, and
	// regroup using the same logic the parent uses (categories list
	// is reconstructed from the input groups themselves — we don't
	// have direct access to `Space.categories` here but we don't
	// need it: the parent already grouped, and we just need to
	// re-sort/re-bucket).
	const effectiveGroups = useMemo<RoomGroup[]>(() => {
		if (pendingMoves.size === 0) return groups;

		// Synthesise the categories list from the non-null groups in
		// input order.  Preserves admin-defined ordering of categories.
		const categories: Array<{ id: string; name: string }> = [];
		for (const g of groups) {
			if (g.id !== null && g.name !== null) categories.push({ id: g.id, name: g.name });
		}
		const knownCategories = new Set(categories.map(c => c.id));

		// Flatten + patch.  Cloning shallowly so we don't mutate the
		// Room objects the parent owns.
		const patched: Room[] = [];
		for (const g of groups) {
			for (const r of g.rooms) {
				const ov = pendingMoves.get(r.id);
				if (!ov) {
					patched.push(r);
					continue;
				}
				patched.push({
					...r,
					spaceChildMeta: {
						...(r.spaceChildMeta ?? {}),
						[spaceId]: {
							order: ov.order,
							category: ov.category ?? undefined,
						},
					},
				});
			}
		}

		// Re-bucket.  Mirrors groupRoomsByCategory's logic but keyed
		// off the synthesised category list rather than a Space object.
		const uncategorised: Room[] = [];
		const byCategory = new Map<string, Room[]>();
		for (const c of categories) byCategory.set(c.id, []);
		for (const room of patched) {
			const meta = room.spaceChildMeta?.[spaceId];
			const catId = meta?.category;
			if (catId && knownCategories.has(catId)) byCategory.get(catId)!.push(room);
			else uncategorised.push(room);
		}

		const sortRooms = (list: Room[]) => {
			list.sort((a, b) => {
				const ao = a.spaceChildMeta?.[spaceId]?.order;
				const bo = b.spaceChildMeta?.[spaceId]?.order;
				if (ao !== undefined && bo === undefined) return -1;
				if (ao === undefined && bo !== undefined) return 1;
				if (ao !== undefined && bo !== undefined && ao !== bo) return ao < bo ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
		};
		sortRooms(uncategorised);
		for (const list of byCategory.values()) sortRooms(list);

		const out: RoomGroup[] = [{ id: null, name: null, rooms: uncategorised }];
		for (const c of categories) out.push({ id: c.id, name: c.name, rooms: byCategory.get(c.id)! });
		return out;
	}, [groups, pendingMoves, spaceId]);

	// Clear overrides whose target state has landed in props.  Runs
	// every time `groups` changes — the moment the homeserver echo
	// produces a render where the room's actual order/category matches
	// the override, we can stop overriding (and the next subsequent
	// drag will start clean).
	useEffect(() => {
		if (pendingMoves.size === 0) return;
		let next: Map<RoomId, { order: string; category: string | null }> | null = null;
		for (const g of groups) {
			for (const r of g.rooms) {
				const ov = pendingMoves.get(r.id);
				if (!ov) continue;
				const meta = r.spaceChildMeta?.[spaceId];
				const sameOrder = meta?.order === ov.order;
				// Group id `null` is the uncategorised bucket; equate it
				// to the override's `null` category.
				const sameCategory = (g.id ?? null) === (ov.category ?? null);
				if (sameOrder && sameCategory) {
					if (!next) next = new Map(pendingMoves);
					next.delete(r.id);
				}
			}
		}
		if (next) setPendingMoves(next);
	}, [groups, spaceId, pendingMoves]);

	const activeDraggedRoom = useMemo(() => {
		if (!activeDragId) return null;
		for (const g of effectiveGroups) {
			const r = g.rooms.find(r => r.id === activeDragId);
			if (r) return r;
		}
		return null;
	}, [activeDragId, effectiveGroups]);

	// 6px activation distance — far enough that a normal click on a
	// room row never accidentally starts a drag.  dnd-kit's default
	// is 0 (instant), which fights every click.
	const sensors = useSensors(useSensor(PointerSensor, {
		activationConstraint: { distance: 6 },
	}));

	// Lookup: which group does each room id live in?  Used by the
	// drop handler to figure out the destination category + the
	// new neighbour anchors for the order-key computation.  Built
	// off effectiveGroups so drag-end math sees the (already-applied)
	// optimistic positions for any earlier pending moves.
	const groupByRoomId = useMemo(() => {
		const m = new Map<string, RoomGroup>();
		for (const g of effectiveGroups) {
			for (const r of g.rooms) m.set(r.id, g);
		}
		return m;
	}, [effectiveGroups]);

	function handleDragStart(e: DragStartEvent) {
		setActiveDragId(String(e.active.id));
	}

	function handleDragEnd(e: DragEndEvent) {
		setActiveDragId(null);
		const { active, over } = e;
		if (!over || !onMoveRoom) return;
		const draggedId = String(active.id) as RoomId;
		// `over.id` is either another room's id (drop on a sibling)
		// or a group sentinel of the shape "group:<id>" (drop on a
		// category header or empty body).  Translate either into a
		// destination group + insertion index.
		const overIdStr = String(over.id);
		let destGroup: RoomGroup | undefined;
		let destIdx: number;
		if (overIdStr.startsWith("group:")) {
			const groupKey = overIdStr.slice("group:".length);
			destGroup = effectiveGroups.find(g => (g.id ?? "__uncategorised__") === groupKey);
			destIdx = destGroup?.rooms.length ?? 0;
		} else {
			const overRoomId = overIdStr;
			destGroup = groupByRoomId.get(overRoomId);
			if (!destGroup) return;
			destIdx = destGroup.rooms.findIndex(r => r.id === overRoomId);
		}
		if (!destGroup) return;

		// Compute the order key of the new slot.  Anchors are the rooms
		// IMMEDIATELY before and after the insertion point in the
		// destination group, EXCLUDING the dragged room itself (if it's
		// already in this group at a different index).
		const without = destGroup.rooms.filter(r => r.id !== draggedId);
		const insertAt = Math.min(destIdx, without.length);
		const before = without[insertAt - 1];
		const after = without[insertAt];
		const beforeKey = before?.spaceChildMeta?.[spaceId]?.order;
		const afterKey = after?.spaceChildMeta?.[spaceId]?.order;
		let newKey: string;
		try {
			newKey = orderKeyBetween(beforeKey, afterKey);
		} catch (err) {
			console.warn("order-key generation failed; keeping original order", err);
			return;
		}

		// Optimistic local apply BEFORE we kick the RPC — so the row
		// settles at its new position the instant dnd-kit's transform
		// unwinds (rather than animating back to its origin and then
		// popping forward when the homeserver echo lands).  The local
		// override gets cleared by either:
		//   (a) the useEffect above, when props.groups echoes the new
		//       order/category back to us, or
		//   (b) the .catch() below, when the RPC rejects (e.g. PL
		//       dropped between drag start and drop, network failure).
		const destCategory = destGroup.id;
		setPendingMoves(prev => {
			const next = new Map(prev);
			next.set(draggedId, { order: newKey, category: destCategory });
			return next;
		});

		const result = onMoveRoom(spaceId, draggedId, newKey, destCategory);
		if (result && typeof (result as Promise<unknown>).then === "function") {
			(result as Promise<unknown>).catch(() => {
				setPendingMoves(prev => {
					if (!prev.has(draggedId)) return prev;
					const next = new Map(prev);
					next.delete(draggedId);
					return next;
				});
			});
		}
	}

	const body = (
		<>
			{effectiveGroups.map((group) => {
				const headerKey = group.id ?? "__uncategorised__";
				const isOpen = !collapsed.has(headerKey);
				const showHeader = !!group.name;
				if (!showHeader && group.rooms.length === 0) return null;
				return (
					<div key={headerKey} className="mb-1 last:mb-0">
						{showHeader && (
							<button
								type="button"
								onClick={() => toggle(headerKey)}
								className="w-full flex items-center gap-1 px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
							>
								{isOpen
									? <ChevronDown className="h-3 w-3" />
									: <ChevronRight className="h-3 w-3" />}
								<span className="truncate">{group.name}</span>
							</button>
						)}
						{isOpen && (
							<CategoryDropZone
								groupKey={headerKey}
								rooms={group.rooms}
								canDrag={canDrag}
							>
								{group.rooms.map(room => (
									canDrag ? (
										<DraggableRoomRow
											key={room.id}
											room={room}
											active={room.id === activeRoomId}
											onSelect={() => onSelectRoom(room.id)}
											currentUserId={currentUserId}
											transport={transport}
											accessToken={accessToken}
											activeSpaceId={spaceId}
											onEditRoom={onEditRoom}
											onOpenProfile={onOpenProfile}
											onRequestDeleteDm={onRequestDeleteDm}
											isBotPeer={
												room.kind === "dm" && !!room.dmUserId && !!botMxids?.has(room.dmUserId)
											}
										/>
									) : (
										<RoomRow
											key={room.id}
											room={room}
											active={room.id === activeRoomId}
											onSelect={() => onSelectRoom(room.id)}
											currentUserId={currentUserId}
											transport={transport}
											accessToken={accessToken}
											activeSpaceId={spaceId}
											onEditRoom={onEditRoom}
											onOpenProfile={onOpenProfile}
											onRequestDeleteDm={onRequestDeleteDm}
											isBotPeer={
												room.kind === "dm" && !!room.dmUserId && !!botMxids?.has(room.dmUserId)
											}
										/>
									)
								))}
							</CategoryDropZone>
						)}
					</div>
				);
			})}
		</>
	);

	if (!canDrag) return body;

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
			onDragCancel={() => setActiveDragId(null)}
		>
			{body}
			<DragOverlay>
				{activeDraggedRoom ? (
					<div className="opacity-90">
						<RoomRow
							room={activeDraggedRoom}
							active={false}
							onSelect={() => { /* preview-only */ }}
							currentUserId={currentUserId}
							transport={null}
							accessToken={null}
							activeSpaceId={spaceId}
							isBotPeer={
								activeDraggedRoom.kind === "dm" && !!activeDraggedRoom.dmUserId
								&& !!botMxids?.has(activeDraggedRoom.dmUserId)
							}
						/>
					</div>
				) : null}
			</DragOverlay>
		</DndContext>
	);
}

/** Wraps each category's room list in a SortableContext.  Even
 * empty categories get one so they're a valid drop target when an
 * admin drags a room into a freshly-created category. */
function CategoryDropZone({
	groupKey, rooms, canDrag, children,
}: {
	groupKey: string;
	rooms: Room[];
	canDrag: boolean;
	children: React.ReactNode;
}) {
	const items = useMemo(() => {
		const ids: string[] = rooms.map(r => r.id);
		// Sentinel for the empty drop zone — without an item id in the
		// SortableContext, an empty category can't accept drops at all.
		// dnd-kit treats the sentinel as a drop target whose id we
		// recognise in the parent's handleDragEnd via the "group:"
		// prefix.
		ids.push(`group:${groupKey}`);
		return ids;
	}, [rooms, groupKey]);
	// `flex flex-col gap-0.5` gives a 2px separator between consecutive
	// rows so the active room's background doesn't visually merge with
	// the rows above and below it (was a steady-state UX papercut —
	// fixing the same issue in both branches keeps drag + non-drag
	// rendering identical).  dnd-kit's verticalListSortingStrategy
	// is approximate anyway, so the tiny gap doesn't visibly throw
	// off its swap thresholds.
	if (!canDrag) return <div className="flex flex-col gap-0.5">{children}</div>;
	return (
		<SortableContext items={items} strategy={verticalListSortingStrategy}>
			<div className="flex flex-col gap-0.5">{children}</div>
			{rooms.length === 0 && (
				// Empty category gets a visible-but-discreet drop hint.
				// `useSortable` on the group sentinel id makes it an
				// addressable drop target; styling is intentionally
				// minimal so it doesn't shout in the steady state.
				<EmptyCategorySentinel groupKey={groupKey} />
			)}
		</SortableContext>
	);
}

function EmptyCategorySentinel({ groupKey }: { groupKey: string }) {
	const sortable = useSortable({ id: `group:${groupKey}` });
	const style = {
		transform: CSS.Transform.toString(sortable.transform),
		transition: sortable.transition,
	};
	return (
		<div
			ref={sortable.setNodeRef}
			style={style}
			className="text-[10px] text-muted-foreground/60 italic px-2 py-2"
		>
			Drag a channel here
		</div>
	);
}

/** Sortable wrapper around `RoomRow`.  Sets up the dnd-kit drag
 * source + provides a tiny drag handle on the left edge of the row
 * (visible only on hover for admins).  The whole row is the drag
 * target so admins can grab anywhere; the handle is just a visual
 * affordance. */
function DraggableRoomRow(props: React.ComponentProps<typeof RoomRow>) {
	const sortable = useSortable({ id: props.room.id });
	// While dragging, the floating DragOverlay portal renders the row
	// at the cursor.  We make the source slot invisible (opacity 0)
	// but keep it in layout so:
	//   - dnd-kit can still measure the source's rect (the DragOverlay
	//     uses it to size + position the floating clone — collapsing
	//     the source via `display: none` zeroes the rect and leaves
	//     the overlay invisible, which was the "drag does nothing"
	//     symptom);
	//   - sibling rows don't reflow until the drag actually resolves,
	//     so the visual cue is "lifted row floats above; everything
	//     else holds steady until you drop".
	// Previous `opacity: 0.4` left a visible faded copy behind which
	// read as a confusing duplicate; opacity: 0 keeps the slot but
	// removes the ghost.
	const style = {
		transform: CSS.Transform.toString(sortable.transform),
		transition: sortable.transition,
		opacity: sortable.isDragging ? 0 : 1,
	};
	return (
		<div
			ref={sortable.setNodeRef}
			style={style}
			{...sortable.attributes}
			{...sortable.listeners}
		>
			<RoomRow {...props} />
		</div>
	);
}

function RoomRow({
	room, active, onSelect,
	currentUserId, transport, accessToken, activeSpaceId,
	onEditRoom, onOpenProfile, onRequestDeleteDm, isBotPeer, isMyBotPeer,
}: {
	room: Room;
	active: boolean;
	onSelect(): void;
	// Right-click context menu wiring.
	currentUserId: UserId;
	transport: MatrixTransport | null;
	accessToken: string | null;
	activeSpaceId: string | null;
	onEditRoom?(roomId: RoomId): void;
	onOpenProfile?(userId: UserId): void;
	onRequestDeleteDm?(roomId: RoomId): void;
	// True when this is a DM whose peer is a known bot — flips the
	// avatar's DiceBear fallback style from fun-emoji ("user") to
	// bottts ("bot") so the sidebar matches the rest of the UI.
	isBotPeer?: boolean;
	// True when this is a DM whose peer is a bot the viewer owns.
	// Suppresses the right-click "Block user" affordance — see the
	// reasoning on RoomListProps.myOwnedBotMxids.
	isMyBotPeer?: boolean;
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

	// Source of truth: matrix-js-sdk's per-room unread counter,
	// which markAsRead zeros locally via setUnreadNotificationCount
	// before any receipt round-trips.  No presentation-layer
	// suppression needed — the count itself is the truth.
	const hasUnread = room.unreadCount > 0 || room.highlightCount > 0;
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
					"w-full flex items-center gap-2 py-1.5 pl-2 pr-2 text-sm text-left min-w-0",
					active ? "text-foreground" : "text-foreground/90",
					// Muted rooms render with reduced text contrast +
					// a small mute icon to communicate "this room is
					// silenced" at a glance, the way Discord does.
					isMuted && "text-muted-foreground/70",
				)}
				title={room.name}
			>
				<RoomAvatar room={room} isBotPeer={isBotPeer} />
				<span className="flex-1 truncate flex items-center gap-1.5 min-w-0">
					<span className={cn(
						"truncate",
						hasUnread && !isMuted && "font-semibold",
					)}>
						{room.name}
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
			{ctxMenuPos && transport && accessToken && (
				<RoomRowContextMenu
					x={ctxMenuPos.x}
					y={ctxMenuPos.y}
					room={room}
					currentUserId={currentUserId}
					accessToken={accessToken}
					activeSpaceId={activeSpaceId as RoomId | null}
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
					onLeave={() => {
						// DMs route through the shared bilateral-delete
						// dialog (server-side purge for both parties).
						// The old behaviour, transport.leaveRoom on the
						// row, only left the caller's side, the other
						// party retained the full conversation.  Non-DM
						// rooms keep the normal one-sided leave.
						if (room.kind === "dm" && onRequestDeleteDm) {
							onRequestDeleteDm(room.id);
							return;
						}
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
					onBlockDmUser={room.kind === "dm" && room.dmUserId && !isMyBotPeer
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

// Right-click context menu for room rows in the sidebar.
//
// Same component handles regular rooms AND DMs — the items list
// branches on room.kind so DMs get DM-specific affordances (View
// profile, Block) while regular rooms get founder/admin items
// (Edit, Pin/Unpin, Delete).  Per-viewer item filtering keeps the
// menu honest: nobody sees actions they can't perform.

import { useMemo } from "react";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import {
	Bell, BellOff, Check, Copy, Eye, EyeOff, LogOut, MessageSquare,
	Pencil, Pin, PinOff, Trash2, User as UserIcon, UserX,
} from "lucide-react";
import type { Room, UserId, RoomId, SpaceId } from "@koven/shared";
import {
	getRoomNotifyLevel as getCachedNotifyLevel,
	setRoomNotifyLevel as setCachedNotifyLevel,
	type RoomNotifyLevel,
} from "@/lib/notifyPrefs";

export interface RoomRowContextMenuProps {
	x: number;
	y: number;
	room: Room;
	currentUserId: UserId;
	accessToken: string;
	// Pin state for the active space — only meaningful when the row
	// is being viewed inside a real space (not Home / DMs / Rooms).
	// `null` when there's no active space context.
	activeSpaceId: SpaceId | null;
	isPinned: boolean;
	canManagePins: boolean;
	// Founder = creatorId match.  Drives Edit + Delete visibility.
	isFounder: boolean;
	// Higher PL gates Edit (PL >= 50 historically).  We use a single
	// pre-computed boolean from the parent so this component stays
	// stateless about Matrix PL semantics.
	canEdit: boolean;
	// Action handlers — wired by the parent (RoomList → App).
	onMarkRead(): void;
	onMarkUnread(): void;
	onCopyId(): void;
	onEdit?(): void;
	onPin?(): void;
	onUnpin?(): void;
	onLeave(): void;
	onDelete?(): void;
	// DM-only:
	onOpenProfile?(): void;
	onBlockDmUser?(): void;
	onClose(): void;
}

export function RoomRowContextMenu({
	x, y, room, currentUserId: _currentUserId, accessToken, activeSpaceId,
	isPinned, canManagePins, isFounder, canEdit,
	onMarkRead, onMarkUnread, onCopyId,
	onEdit, onPin, onUnpin, onLeave, onDelete,
	onOpenProfile, onBlockDmUser,
	onClose,
}: RoomRowContextMenuProps) {
	const isDm = room.kind === "dm";
	const hasUnread = room.unreadCount > 0 || room.highlightCount > 0;
	const currentLevel: RoomNotifyLevel = getCachedNotifyLevel(room.id);

	const items = useMemo<ContextMenuItem[]>(() => {
		const out: ContextMenuItem[] = [];

		// Read state.  Mark read when there's something to mark; mark
		// unread when the room is fully read (matches the toggle UX
		// every other client uses).
		if (hasUnread) {
			out.push({
				label: "Mark as read",
				icon: <Check className="h-4 w-4" />,
				onClick: onMarkRead,
			});
		} else {
			out.push({
				label: "Mark as unread",
				icon: <Eye className="h-4 w-4" />,
				onClick: onMarkUnread,
			});
		}

		// Notification level — submenu of radio items.
		//
		// DMs get a two-way pick: All messages / Mute.  "Only
		// mentions" is meaningless in a 2-person conversation
		// (there's only one other person; every message they send is
		// implicitly for you), and the engine's fanout already
		// hard-codes kind=dm on every DM message regardless of stored
		// level — so showing the user a "Mentions only" option that
		// did nothing was confusing and wrong.  All-messages is the
		// effective default for DMs whether the stored level is
		// "all" or "mentions" (engine treats both the same here),
		// so we render the radio as "All messages" checked when
		// either is set, and only flip the check off when the room
		// is muted.
		//
		// Regular rooms still get the three-way pick.
		const setLevel = async (level: RoomNotifyLevel) => {
			await setCachedNotifyLevel(accessToken, room.id, level);
		};
		const dmAllChecked = currentLevel === "all" || currentLevel === "mentions";
		const notifyItems: ContextMenuItem[] = isDm
			? [
				{
					label: "All messages",
					icon: <Bell className="h-4 w-4" />,
					checked: dmAllChecked,
					// Setting "all" instead of clearing to default
					// ("mentions") keeps the explicit-opt-in shape:
					// the user picked it, the row exists, the engine
					// honours it.  Functionally identical for DMs
					// either way, but the explicit row makes the
					// "yes I deliberately want all messages here"
					// intent legible if we ever change DM defaults.
					onClick: () => setLevel("all"),
				},
				{
					label: "Mute",
					icon: <BellOff className="h-4 w-4" />,
					checked: currentLevel === "muted",
					onClick: () => setLevel("muted"),
				},
			]
			: [
				{
					label: "All messages",
					icon: <Bell className="h-4 w-4" />,
					checked: currentLevel === "all",
					onClick: () => setLevel("all"),
				},
				{
					label: "Only mentions",
					icon: <UserIcon className="h-4 w-4" />,
					checked: currentLevel === "mentions",
					onClick: () => setLevel("mentions"),
				},
				{
					label: "Mute",
					icon: <BellOff className="h-4 w-4" />,
					checked: currentLevel === "muted",
					onClick: () => setLevel("muted"),
				},
			];
		out.push({
			kind: "submenu",
			label: "Notifications",
			icon: notifyIconFor(currentLevel),
			items: notifyItems,
		});

		out.push({ kind: "divider" });

		// DM-specific: view the other person's profile.
		if (isDm && onOpenProfile) {
			out.push({
				label: "View profile",
				icon: <UserIcon className="h-4 w-4" />,
				onClick: onOpenProfile,
			});
		}

		// Copy affordances.
		out.push({
			label: isDm ? "Copy user ID" : "Copy room ID",
			icon: <Copy className="h-4 w-4" />,
			onClick: onCopyId,
		});
		// "Copy invite link" intentionally absent for rooms — invite
		// links are space-only (Discord-style invariant: you invite
		// people to the server, not to a single channel).  The space
		// tile context menu retains its own "Copy invite link" entry.

		// Pin / Unpin — only meaningful inside a real space, only
		// available to users with manage-pins PL.
		if (!isDm && activeSpaceId && canManagePins) {
			if (isPinned) {
				out.push({
					label: "Unpin from this space",
					icon: <PinOff className="h-4 w-4" />,
					onClick: () => onUnpin?.(),
				});
			} else {
				out.push({
					label: "Pin to this space",
					icon: <Pin className="h-4 w-4" />,
					onClick: () => onPin?.(),
				});
			}
		}

		// Edit room — PL gated.  Only shown for rooms (not DMs); DMs
		// don't have editable properties at this layer.
		if (!isDm && canEdit && onEdit) {
			out.push({
				label: "Edit room…",
				icon: <Pencil className="h-4 w-4" />,
				onClick: onEdit,
			});
		}

		out.push({ kind: "divider" });

		// Block — DMs only.  Adds the other party to m.ignored_user_list.
		if (isDm && onBlockDmUser) {
			out.push({
				label: "Block user",
				icon: <UserX className="h-4 w-4" />,
				danger: true,
				onClick: onBlockDmUser,
			});
		}

		// Leave / Delete.  Founders can delete (which leaves +
		// tombstones the room); everyone else just leaves.  DMs use
		// the "Delete conversation" wording instead of "Leave room"
		// — matches what users actually expect when they end a chat.
		if (isFounder && !isDm && onDelete) {
			out.push({
				label: "Delete room",
				icon: <Trash2 className="h-4 w-4" />,
				danger: true,
				onClick: onDelete,
			});
		} else {
			out.push({
				label: isDm ? "Delete conversation" : "Leave room",
				icon: <LogOut className="h-4 w-4" />,
				danger: true,
				onClick: onLeave,
			});
		}

		return out;
	}, [
		hasUnread, currentLevel, isDm, activeSpaceId, isPinned, canManagePins,
		isFounder, canEdit,
		onMarkRead, onMarkUnread, onCopyId,
		onEdit, onPin, onUnpin, onLeave, onDelete,
		onOpenProfile, onBlockDmUser,
		room.id, accessToken,
	]);

	return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}

function notifyIconFor(level: RoomNotifyLevel): React.ReactNode {
	switch (level) {
		case "all": return <Bell className="h-4 w-4" />;
		case "muted": return <BellOff className="h-4 w-4" />;
		default: return <UserIcon className="h-4 w-4" />;
	}
}

// Right-click context menu for space tiles in the SpaceBar (left rail).
//
// Per-viewer item filtering: founders see Edit / Add room / Delete;
// non-founders see Leave.  Bulk notification level applies to every
// joined room in the space — fast way for the user to mute / follow
// an entire community in one gesture.

import { useMemo } from "react";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import {
	Bell, BellOff, Check, Copy, LogOut, Pencil, Plus, Trash2, User as UserIcon,
} from "lucide-react";
import type { Room, Space, UserId } from "@koven/shared";
import {
	setRoomNotifyLevelBulk,
	type RoomNotifyLevel,
} from "@/lib/notifyPrefs";

export interface SpaceTileContextMenuProps {
	x: number;
	y: number;
	space: Space;
	currentUserId: UserId;
	accessToken: string;
	// Rooms in this space — used for the bulk "set notifications for
	// every room in this space" actions + the Mark All Read action.
	roomsInSpace: Room[];
	onMarkAllRead(): void;
	onCopyId(): void;
	onCopyInviteLink(): void;
	onEdit?(): void;
	onAddRoom?(): void;
	onAddExistingRoom?(): void;
	onLeave(): void;
	onDelete?(): void;
	onClose(): void;
}

export function SpaceTileContextMenu({
	x, y, space, currentUserId, accessToken, roomsInSpace,
	onMarkAllRead, onCopyId, onCopyInviteLink,
	onEdit, onAddRoom, onAddExistingRoom, onLeave, onDelete,
	onClose,
}: SpaceTileContextMenuProps) {
	const isFounder = !!space.creatorId && space.creatorId === currentUserId;

	const items = useMemo<ContextMenuItem[]>(() => {
		const out: ContextMenuItem[] = [];

		// Mark all rooms in this space as read.  The handler walks
		// roomsInSpace and fires markAsRead on each.
		out.push({
			label: "Mark all rooms as read",
			icon: <Check className="h-4 w-4" />,
			disabled: roomsInSpace.length === 0,
			onClick: onMarkAllRead,
		});

		// Bulk notification level — submenu.  Sets the same level on
		// every joined room in this space.  Per-room overrides set
		// later still win; this is purely a convenience for "I want
		// to follow / mute this whole community."
		const setBulk = async (level: RoomNotifyLevel) => {
			const ids = roomsInSpace.map(r => r.id);
			await setRoomNotifyLevelBulk(accessToken, ids, level);
		};
		out.push({
			kind: "submenu",
			label: "Set notifications for all rooms",
			icon: <Bell className="h-4 w-4" />,
			disabled: roomsInSpace.length === 0,
			items: [
				{
					label: "All messages",
					icon: <Bell className="h-4 w-4" />,
					onClick: () => setBulk("all"),
				},
				{
					label: "Only mentions",
					icon: <UserIcon className="h-4 w-4" />,
					onClick: () => setBulk("mentions"),
				},
				{
					label: "Mute",
					icon: <BellOff className="h-4 w-4" />,
					onClick: () => setBulk("muted"),
				},
			],
		});

		out.push({ kind: "divider" });

		out.push({
			label: "Copy space ID",
			icon: <Copy className="h-4 w-4" />,
			onClick: onCopyId,
		});
		out.push({
			label: "Copy invite link",
			icon: <Copy className="h-4 w-4" />,
			onClick: onCopyInviteLink,
		});

		// Founder-only management items.
		if (isFounder) {
			out.push({ kind: "divider" });
			if (onEdit) {
				out.push({
					label: "Edit space…",
					icon: <Pencil className="h-4 w-4" />,
					onClick: onEdit,
				});
			}
			if (onAddRoom) {
				out.push({
					label: "Create room here…",
					icon: <Plus className="h-4 w-4" />,
					onClick: onAddRoom,
				});
			}
			if (onAddExistingRoom) {
				out.push({
					label: "Add existing room…",
					icon: <Plus className="h-4 w-4" />,
					onClick: onAddExistingRoom,
				});
			}
		}

		out.push({ kind: "divider" });

		// Leave / Delete.  Founders get Delete (destructive); non-
		// founders just leave.
		if (isFounder && onDelete) {
			out.push({
				label: "Delete space",
				icon: <Trash2 className="h-4 w-4" />,
				danger: true,
				onClick: onDelete,
			});
		} else {
			out.push({
				label: "Leave space",
				icon: <LogOut className="h-4 w-4" />,
				danger: true,
				onClick: onLeave,
			});
		}

		return out;
	}, [
		isFounder, roomsInSpace, accessToken,
		onMarkAllRead, onCopyId, onCopyInviteLink,
		onEdit, onAddRoom, onAddExistingRoom, onLeave, onDelete,
	]);

	void space;
	void currentUserId;

	return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}

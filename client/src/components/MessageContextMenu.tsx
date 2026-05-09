// Right-click context menu for message bubbles in the chat timeline.
// Mirrors the hover-revealed MessageActions toolbar + adds extras
// (Copy text, Copy message link, Quote) so the row's full action
// surface is reachable without depending on hover — important for
// touchpad users and for the desktop shell where right-click is the
// canonical "give me a menu" gesture.

import { useMemo } from "react";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import {
	Copy, Flag, Link2, Quote, Reply, Smile, Trash2, UserX, MessageSquare,
} from "lucide-react";
import type { Message } from "@koven/shared";

export interface MessageContextMenuProps {
	x: number;
	y: number;
	message: Message;
	roomId: string;
	// Whether the viewer is the author.  Drives Edit/Delete vs.
	// Flag/Block visibility — you can't flag your own message, you
	// can't delete others'.
	isSelf: boolean;
	// Whether the room supports flagging.  Mirrors ChatPane's
	// `flaggable` (public, non-DM, non-encrypted, non-federated).
	flaggable: boolean;
	// Action handlers — most mirror MessageActions.
	onReply(): void;
	onReact(): void;
	onCopyText(): void;
	onCopyLink(): void;
	onQuote(): void;
	onDelete?(): void;
	onFlag?(): void;
	onBlockSender?(): void;
	onSendDmToSender?(): void;
	onClose(): void;
}

export function MessageContextMenu({
	x, y, message, isSelf, flaggable,
	onReply, onReact, onCopyText, onCopyLink, onQuote,
	onDelete, onFlag, onBlockSender, onSendDmToSender,
	onClose,
}: MessageContextMenuProps) {
	const hasText = !!message.text && message.kind !== "image" && message.kind !== "video"
		&& message.kind !== "audio" && message.kind !== "file";

	const items = useMemo<ContextMenuItem[]>(() => {
		const out: ContextMenuItem[] = [];

		out.push({
			label: "Reply",
			icon: <Reply className="h-4 w-4" />,
			onClick: onReply,
		});
		out.push({
			label: "React…",
			icon: <Smile className="h-4 w-4" />,
			onClick: onReact,
		});

		out.push({ kind: "divider" });

		if (hasText) {
			out.push({
				label: "Copy text",
				icon: <Copy className="h-4 w-4" />,
				onClick: onCopyText,
			});
			out.push({
				label: "Quote in reply",
				icon: <Quote className="h-4 w-4" />,
				onClick: onQuote,
			});
		}
		out.push({
			label: "Copy message link",
			icon: <Link2 className="h-4 w-4" />,
			onClick: onCopyLink,
		});

		// Self vs other actions.
		if (isSelf && onDelete) {
			out.push({ kind: "divider" });
			out.push({
				label: "Delete message",
				icon: <Trash2 className="h-4 w-4" />,
				danger: true,
				onClick: onDelete,
			});
		}
		if (!isSelf) {
			const otherActions: ContextMenuItem[] = [];
			if (onSendDmToSender) {
				otherActions.push({
					label: "Send DM to sender",
					icon: <MessageSquare className="h-4 w-4" />,
					onClick: onSendDmToSender,
				});
			}
			if (flaggable && onFlag) {
				otherActions.push({
					label: "Flag message…",
					icon: <Flag className="h-4 w-4" />,
					onClick: onFlag,
				});
			}
			if (onBlockSender) {
				otherActions.push({
					label: "Block sender",
					icon: <UserX className="h-4 w-4" />,
					danger: true,
					onClick: onBlockSender,
				});
			}
			if (otherActions.length > 0) {
				out.push({ kind: "divider" });
				for (const a of otherActions) out.push(a);
			}
		}

		return out;
	}, [
		hasText, isSelf, flaggable,
		onReply, onReact, onCopyText, onCopyLink, onQuote,
		onDelete, onFlag, onBlockSender, onSendDmToSender,
	]);

	return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}

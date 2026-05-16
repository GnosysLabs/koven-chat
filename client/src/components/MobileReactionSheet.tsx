// Mobile bottom sheet for reacting to a message.  Opened from the
// long-press menu's "React…" item (see ChatPane → MessageContextMenu).
// Desktop uses a Radix Popover anchored to the SmilePlus button in
// MessageActions, but on phones a 360x450 anchored popover fills most
// of the viewport without respecting any sensible safe area, and the
// anchor point is meaningless under a finger.
//
// The sheet shell (portal, scrim, drag-to-dismiss, keyboard tracking)
// lives in MobileSheet; this component just drops the Discord-style
// emoji grid inside it.

import { MobileSheet } from "@/components/MobileSheet";
import { MobileEmojiGrid } from "@/components/MobileEmojiGrid";

export interface MobileReactionSheetProps {
	open: boolean;
	onClose(): void;
	onPick(emoji: string): void;
}

export function MobileReactionSheet({ open, onClose, onPick }: MobileReactionSheetProps) {
	return (
		<MobileSheet open={open} onClose={onClose} ariaLabel="Pick a reaction">
			<div className="pb-3">
				<MobileEmojiGrid onPick={onPick} />
			</div>
		</MobileSheet>
	);
}

// MobileTopBar — branding strip pinned above the active panel on
// the mobile shell.  Sits between the iOS status bar (handled by
// safe-area padding here) and the active panel.
//
// Layout (always 48pt content area + safe-area-inset-top):
//
//   ┌──────────────────────────────────────────────────┐
//   │  [☰ / ←]              ◆                          │
//   └──────────────────────────────────────────────────┘
//
// The left slot is conditional:
//   • Back arrow when there's somewhere to go back to (i.e. in a
//     room → returns to that space's room list).
//   • Hamburger otherwise — opens the spaces / DMs drawer so the
//     user can jump laterally.  Same iOS / Material convention:
//     back-stack nav lives on the left, lateral nav lives on the
//     left when there's no back nav.
//
// The right slot is reserved for per-view actions (call button,
// room settings) and is empty by default — the spacer keeps the
// favicon visually centred regardless of which left affordance
// is showing.

import type { ReactNode } from "react";
import { ChevronLeft, Menu } from "lucide-react";
import { cn } from "@/lib/utils";

interface MobileTopBarProps {
	onBack?: () => void;
	onMenu?: () => void;
	/// Optional element rendered in the right slot.  Slot is always
	/// 40x40 (same dimensions as the left slot) so the centred logo
	/// stays balanced regardless of whether the slot is populated.
	rightSlot?: ReactNode;
}

export function MobileTopBar({ onBack, onMenu, rightSlot }: MobileTopBarProps) {
	return (
		<div
			className={cn(
				"shrink-0 flex items-center px-2",
				"bg-background border-b border-border",
				"pt-[env(safe-area-inset-top)]",
			)}
			style={{ minHeight: "calc(48px + env(safe-area-inset-top))" }}
		>
			<div className="w-10 h-10 flex items-center justify-start">
				{onBack ? (
					<button
						type="button"
						onClick={onBack}
						aria-label="Back"
						className="h-10 w-10 rounded-full flex items-center justify-center text-foreground active:bg-muted"
					>
						<ChevronLeft className="h-6 w-6" />
					</button>
				) : onMenu ? (
					<button
						type="button"
						onClick={onMenu}
						aria-label="Open menu"
						className="h-10 w-10 rounded-full flex items-center justify-center text-foreground active:bg-muted"
					>
						<Menu className="h-5 w-5" />
					</button>
				) : null}
			</div>

			<div className="flex-1 flex items-center justify-center min-w-0">
				<img
					src="/favicon.png"
					alt="Koven"
					className="h-7 w-7 select-none pointer-events-none"
					draggable={false}
				/>
			</div>

			{/* Right slot — same width as the left slot so the
			    favicon stays visually centred even when only one
			    side has a button.  When `rightSlot` is set (e.g.
			    notification bell), it renders here; otherwise we
			    show an empty 40x40 spacer. */}
			<div className="w-10 h-10 flex items-center justify-end">
				{rightSlot ?? null}
			</div>
		</div>
	);
}

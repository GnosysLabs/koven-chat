// MobileTopBar — translucent iOS-style nav bar pinned above the
// active panel on the mobile shell.
//
// Layout (44pt content area + safe-area-inset-top):
//
//   ┌──────────────────────────────────────────────────┐
//   │  [← / ☰]      Title / ◆      [bell / etc]        │
//   └──────────────────────────────────────────────────┘
//
// - Left slot: back-chevron when there's somewhere to pop to,
//   hamburger when there's lateral nav available, empty otherwise.
//   Same iOS / Material convention as the previous version.
// - Center: text title when provided, branded favicon when not.
//   The favicon fallback is intentional for screens that still want
//   brand chrome rather than a contextual title.
// - Right: per-view actions slot (notification bell, etc.).
//
// HIG calibration:
//   - 44pt content row (iOS standard, was 48pt).
//   - Translucent `bg-card/70 backdrop-blur-2xl` (matches the tab bar).
//   - 0.5pt hairline at the bottom.
//   - Title: 17pt semibold (iOS "Title" style).
//   - Back chevron: 22pt at stroke 2.5, tinted with `--primary` so
//     it respects the user's selected theme (midnight → white,
//     plum → purple, etc.).  iOS HIG says use the app's tint colour
//     for nav-bar interactive glyphs — for Koven the tint is the
//     theme primary, not a hardcoded system blue.

import type { ReactNode } from "react";
import { ChevronLeft, Menu } from "lucide-react";
import { hapticImpact } from "@/lib/haptics";
import { cn } from "@/lib/utils";

interface MobileTopBarProps {
	onBack?: () => void;
	onMenu?: () => void;
	/// Centered title.  Renders 17pt semibold.  When omitted the bar
	/// shows the brand favicon instead (for screens that prefer brand
	/// chrome to a contextual title).
	title?: string;
	/// Optional element rendered in the right slot.  The slot is
	/// always 40x40 (same dimensions as the left slot) so the centred
	/// title / favicon stays balanced regardless of whether the slot
	/// is populated.
	rightSlot?: ReactNode;
}

export function MobileTopBar({ onBack, onMenu, title, rightSlot }: MobileTopBarProps) {
	return (
		<div
			className={cn(
				"shrink-0 flex items-center px-2",
				// Translucent material — same recipe as MobileTabBar so
				// the two bars feel like one system.  Theme-aware via
				// bg-card so light themes get a light translucent bar.
				// `backdrop-saturate-150` pairs the blur with the
				// saturation boost native UIBlurEffect applies, so
				// content tinting through reads vivid not washed.
				"bg-card/70 backdrop-blur-2xl backdrop-saturate-150",
				"border-b border-foreground/10",
				"pt-[env(safe-area-inset-top)]",
			)}
			style={{ minHeight: "calc(44px + env(safe-area-inset-top))" }}
		>
			<div className="w-10 h-10 flex items-center justify-start">
				{onBack ? (
					<button
						type="button"
						onClick={() => { void hapticImpact("light"); onBack(); }}
						aria-label="Back"
						className="h-10 w-10 rounded-full flex items-center justify-center text-primary active:opacity-60 transition-opacity"
					>
						<ChevronLeft className="h-[26px] w-[26px]" strokeWidth={2.5} />
					</button>
				) : onMenu ? (
					<button
						type="button"
						onClick={() => { void hapticImpact("light"); onMenu(); }}
						aria-label="Open menu"
						className="h-10 w-10 rounded-full flex items-center justify-center text-foreground active:opacity-60 transition-opacity"
					>
						<Menu className="h-[22px] w-[22px]" strokeWidth={2.25} />
					</button>
				) : null}
			</div>

			<div className="flex-1 flex items-center justify-center min-w-0 px-2">
				{title ? (
					<h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground truncate">
						{title}
					</h1>
				) : (
					<img
						src="/favicon.png"
						alt="Koven"
						className="h-7 w-7 select-none pointer-events-none"
						draggable={false}
					/>
				)}
			</div>

			<div className="w-10 h-10 flex items-center justify-end">
				{rightSlot ?? null}
			</div>
		</div>
	);
}

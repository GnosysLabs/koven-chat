// MobileTabBar — floating glassmorphic pill anchored above the home
// indicator.  Replaces the edge-to-edge docked tab bar with an
// isolated capsule that hovers over content; reads as iOS 26 / modern
// app design (Apple Music, recent Telegram updates) rather than the
// utilitarian dock pattern.
//
// Four tabs:
//
//   • Chats   — DMs + orphan rooms (one-on-one / small groups)
//   • Spaces  — list of joined spaces; drilling in shows that
//               space's channel list (RoomList)
//   • Explore — discover new public rooms / spaces
//   • Me      — profile + settings + sign out
//
// 5-tab is iOS's hard ceiling; 4 keeps the targets a comfortable
// thumb-width apart on every iPhone screen size.  Bots is
// desktop-only by design (gatekept earlier) so it doesn't need
// a tab here.
//
// Layout note: the outer <nav> still occupies vertical space so the
// `bottom: calc(env(safe-area-inset-bottom) + 56px)` in App.tsx's
// content overlays continues to work — the parent doesn't have to
// know we changed style.  Inside the nav we just paint a centered
// pill on a transparent background.

import type { ReactNode } from "react";
import { MessageSquare, Compass, LayoutGrid, User } from "lucide-react";
import { cn } from "@/lib/utils";

export type MobileTab = "chats" | "spaces" | "explore" | "me";

interface MobileTabBarProps {
	active: MobileTab;
	onChange(tab: MobileTab): void;
	/// Optional unread counts per tab — drawn as red dots on the
	/// icons.  Zero / undefined hides the dot.
	unreadByTab?: Partial<Record<MobileTab, number>>;
}

interface TabDef {
	key: MobileTab;
	label: string;
	icon: ReactNode;
}

const TABS: TabDef[] = [
	{ key: "chats",   label: "Chats",   icon: <MessageSquare className="h-[18px] w-[18px]" strokeWidth={2.2} /> },
	{ key: "spaces",  label: "Spaces",  icon: <LayoutGrid    className="h-[18px] w-[18px]" strokeWidth={2.2} /> },
	{ key: "explore", label: "Explore", icon: <Compass       className="h-[18px] w-[18px]" strokeWidth={2.2} /> },
	{ key: "me",      label: "Me",      icon: <User          className="h-[18px] w-[18px]" strokeWidth={2.2} /> },
];

export function MobileTabBar({ active, onChange, unreadByTab }: MobileTabBarProps) {
	return (
		<nav
			aria-label="Primary"
			// Outer wrapper is transparent + non-blocking padding so
			// the parent layout (App.tsx reserves 56px for this) still
			// works.  The pill itself is the visual element.
			className={cn(
				"shrink-0 flex items-end justify-center",
				"px-3 pt-1 pb-1",
				// Safe-area-bottom margin pushes the pill above the
				// home indicator.  Margin (not padding) so the
				// transparent gap below the pill is just blurred
				// content, not a coloured strip.
				"mb-[env(safe-area-inset-bottom)]",
			)}
		>
			<div
				className={cn(
					// Pill geometry.  Full-width within the side
					// padding, capped so it doesn't stretch on iPad-
					// width screens.
					"relative w-full max-w-md",
					"flex items-stretch gap-0.5",
					"rounded-full p-1",
					// Glassmorphism: translucent bg + blur + a hairline
					// border.  Saturate boost makes blurred content
					// underneath read as colour rather than mud.
					"bg-white/[0.07] dark:bg-white/[0.06]",
					"backdrop-blur-2xl backdrop-saturate-150",
					"border border-white/10",
					// Subtle drop-shadow grounds the floating element
					// without competing with the active-tab highlight.
					"shadow-[0_8px_28px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.08)]",
				)}
			>
				{TABS.map(t => {
					const isActive = active === t.key;
					const unread = unreadByTab?.[t.key] ?? 0;
					return (
						<button
							key={t.key}
							type="button"
							onClick={() => onChange(t.key)}
							aria-current={isActive ? "page" : undefined}
							aria-label={t.label}
							className={cn(
								"flex-1 flex flex-col items-center justify-center gap-0.5",
								// 40px tap target — combined with the
								// pill's p-1 and the nav's pt-1/pb-1 the
								// total nav height matches the 56px slot
								// the parent layout reserves in App.tsx.
								"min-h-[40px] py-1 px-1",
								// Per-tab active chip: filled bg behind
								// active, transparent on the rest.
								// rounded-full so it nests inside the pill.
								"rounded-full transition-all duration-150",
								"select-none",
								isActive
									? "bg-white/[0.12] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
									: "text-muted-foreground active:bg-white/[0.04]",
							)}
						>
							<div className="relative">
								{t.icon}
								{unread > 0 ? (
									<span
										className={cn(
											"absolute -top-1.5 -right-1.5",
											"min-w-[14px] h-3.5 px-1",
											"rounded-full bg-destructive text-destructive-foreground",
											"text-[9px] font-bold leading-none",
											"flex items-center justify-center",
											// Ring matches the pill's bg so
											// the dot reads as floating
											// above icon, not glued to it.
											"ring-2 ring-[#1a1a1d]",
										)}
									>
										{unread > 99 ? "99+" : unread}
									</span>
								) : null}
							</div>
							<span className={cn(
								"text-[10px] leading-none font-medium tracking-wide",
							)}>
								{t.label}
							</span>
						</button>
					);
				})}
			</div>
		</nav>
	);
}

// MobileTabBar — solid tab bar that leans into the iOS home-
// indicator strip rather than fighting it.  The bar's bg-card extends
// through the safe-area zone at the bottom, and each tab button
// shares the same colour with rounded top corners — so each tab
// reads as a piece of the bar that pokes up into the content.
//
// Replaces an earlier floating-glass pill design.  The pill always
// fought the persistent home-indicator strip iOS / the Tauri mobile
// shell paints below it; this version embraces the strip and treats
// it as the bar's foundation.
//
// Four tabs:
//
//   • Chats   — DMs + orphan rooms (one-on-one / small groups)
//   • Spaces  — list of joined spaces; drilling in shows that
//               space's channel list (RoomList)
//   • Explore — discover new public rooms / spaces
//   • Me      — profile + settings + sign out
//
// Layout note: the outer <nav> still occupies vertical space so the
// `bottom: calc(env(safe-area-inset-bottom) + 56px)` in App.tsx's
// content overlays continues to work — the parent doesn't have to
// know we changed style.

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
			className={cn(
				"shrink-0 w-full",
				// Solid bar surface that extends through the safe-area
				// zone at the bottom — `pb-[env(...)]` keeps the
				// home-indicator strip painted in the same colour as
				// the bar so they read as one piece.
				"bg-card",
				"pb-[env(safe-area-inset-bottom)]",
				// Top hairline separates the bar from chat content
				// scrolling above it without painting a heavy line.
				"border-t border-border",
			)}
		>
			<div className="flex items-stretch gap-1 px-1 pt-1">
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
								"flex-1 flex flex-col items-center justify-center gap-1",
								// Total tab height ~52px, paired with
								// the nav's pt-1 + the safe-area pb so
								// the parent's 56px reserve still
								// clears the bar.
								"min-h-[52px] py-1.5 px-1",
								// Rounded top corners only — flat at
								// the bottom so the tab merges into
								// the bar without a visible seam.
								"rounded-t-2xl transition-colors duration-150",
								"select-none",
								isActive
									// Active tab: tinted accent fill so
									// the rounded shape pops out of
									// the bar AND the colour distin-
									// guishes it from the inactive
									// tabs that share the bar's bg.
									? "bg-accent text-foreground"
									: "text-muted-foreground active:bg-accent/50",
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
											// Ring matches the bar's bg
											// so the dot reads as
											// floating above the icon.
											"ring-2 ring-card",
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

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
// Five tabs:
//
//   • Chats   — DMs only (1:1 conversations)
//   • Rooms   — orphan rooms not assigned to any space (small groups
//               that don't belong to a community)
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
import { MessageSquare, Compass, Hash, LayoutGrid, User } from "lucide-react";
import { cn } from "@/lib/utils";

export type MobileTab = "chats" | "rooms" | "spaces" | "explore" | "me";

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
	{ key: "rooms",   label: "Rooms",   icon: <Hash          className="h-[18px] w-[18px]" strokeWidth={2.2} /> },
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
				// Bg-background = the same colour the safe-area /
				// home-indicator strip paints with.  We do NOT pad
				// for the safe area inside the bar — that just adds a
				// big visible gap below the labels.  Instead the
				// bar ends right under its content, and the OS-
				// reserved strip below paints with the body's
				// bg-background (= bar's bg) and reads as a seamless
				// continuation of the bar.
				"bg-background",
				// Top corners rounded on the container itself.
				// Buttons inside stay flat.
				"rounded-t-3xl",
				// Top hairline separates the bar from chat content
				// scrolling above it.
				"border-t border-border",
			)}
		>
			<div className="flex items-stretch px-1">
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
								// Generous top padding gives the icons
								// room to breathe under the bar's
								// rounded top edge; bottom stays tight
								// so labels sit close to the safe-area
								// strip below.
								"pt-3 pb-1.5 px-1",
								"transition-colors duration-150",
								"select-none",
								// No per-button bg fill — only the
								// glyph + label colour signals which
								// tab is active.  Keeps the bar
								// reading as a single solid surface
								// with the buttons just sitting on it.
								isActive ? "text-primary" : "text-muted-foreground",
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
											"ring-2 ring-background",
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

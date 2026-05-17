// MobileTabBar — translucent edge-to-edge iOS tab bar (iOS 15-25
// style, pre-Liquid-Glass).  Tried a floating Liquid Glass pill;
// the edge-to-edge form reads better against Koven's chat surfaces.
//
// Four tabs:
//   • Chats   — DMs (1:1 conversations)
//   • Spaces  — list of joined spaces, drill in to see rooms
//   • Explore — discover public spaces / rooms
//   • Me      — profile + settings + sign out
//
// Hidden in a chat (App.tsx gates rendering on `!state.activeRoomId`).
//
// HIG calibration:
//   - 49pt content row.
//   - Translucent bg-card/70 + backdrop-blur-2xl + saturate-150 lets
//     content tint through the material (the half of iOS Materials
//     that pairs with the blur — without the saturation boost the
//     blur reads washed-out).
//   - 0.5pt top hairline.
//   - The translucent strip extends through env(safe-area-inset-bottom)
//     so the bar reads as one continuous piece down to the screen edge.
//   - Active state: stroke 2.5 + 27pt + text-foreground; inactive
//     stroke 1.9 + 25pt + text-muted-foreground.  Label semibold when
//     active, medium when not.

import type { ReactNode } from "react";
import { Mail, Compass, LayoutGrid, User } from "lucide-react";
import { hapticImpact } from "@/lib/haptics";
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
	render(active: boolean): ReactNode;
}

const ICON_SIZE_ACTIVE = 27;
const ICON_SIZE_INACTIVE = 25;

function tabIcon(Comp: typeof Mail, active: boolean): ReactNode {
	return (
		<Comp
			width={active ? ICON_SIZE_ACTIVE : ICON_SIZE_INACTIVE}
			height={active ? ICON_SIZE_ACTIVE : ICON_SIZE_INACTIVE}
			strokeWidth={active ? 2.5 : 1.9}
			className="block transition-[width,height,stroke-width] duration-150"
		/>
	);
}

const TABS: TabDef[] = [
	{ key: "chats",   label: "DMs",     render: (a) => tabIcon(Mail,          a) },
	{ key: "spaces",  label: "Spaces",  render: (a) => tabIcon(LayoutGrid,    a) },
	{ key: "explore", label: "Explore", render: (a) => tabIcon(Compass,       a) },
	{ key: "me",      label: "Me",      render: (a) => tabIcon(User,          a) },
];

export function MobileTabBar({ active, onChange, unreadByTab }: MobileTabBarProps) {
	return (
		<nav
			aria-label="Primary"
			className={cn(
				"shrink-0 w-full",
				// Translucent material — bg-card carries the theme so
				// light themes get a light-translucent bar, dark themes
				// dark-translucent.  Saturation boost is the missing
				// half of iOS Materials — without it the backdrop blur
				// reads washed-out next to native bars.
				"bg-card/70 backdrop-blur-2xl backdrop-saturate-150",
				"border-t border-foreground/10",
			)}
			style={{
				// Extend the translucent material down through the
				// home-indicator safe-area zone so the bar reads as
				// one continuous piece rather than ending above a
				// solid-bg strip.
				paddingBottom: "env(safe-area-inset-bottom)",
			}}
		>
			<div className="flex items-stretch px-1 h-[49px]">
				{TABS.map(t => {
					const isActive = active === t.key;
					const unread = unreadByTab?.[t.key] ?? 0;
					return (
						<button
							key={t.key}
							type="button"
							onClick={() => { if (!isActive) void hapticImpact("light"); onChange(t.key); }}
							aria-current={isActive ? "page" : undefined}
							aria-label={t.label}
							className={cn(
								"flex-1 flex flex-col items-center justify-center gap-0.5",
								"py-1 px-1",
								"transition-colors duration-150",
								"select-none active:opacity-60",
								isActive ? "text-foreground" : "text-muted-foreground",
							)}
						>
							<div className="relative">
								{t.render(isActive)}
								{unread > 0 ? (
									<span
										className={cn(
											"absolute -top-1 -right-1.5",
											"min-w-[16px] h-4 px-1",
											"rounded-full bg-destructive text-destructive-foreground",
											"text-[10px] font-bold leading-none",
											"flex items-center justify-center",
											"ring-2 ring-card",
										)}
									>
										{unread > 99 ? "99+" : unread}
									</span>
								) : null}
							</div>
							<span className={cn(
								"text-[10px] leading-none tracking-wide",
								isActive ? "font-semibold" : "font-medium",
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

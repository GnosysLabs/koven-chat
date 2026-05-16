// MobileMeScreen — iOS HIG "Me" tab landing.  Three pillars: clarity
// (every glyph + row reads at a glance), deference (the user's
// identity dominates; chrome recedes), depth (grouped inset cards
// layered over the tab's background).
//
// Layout (top → bottom):
//   1. Large title "Me" — 34pt bold, leading-edge aligned, sits in
//      the scrolling content so it collapses to the compact nav-bar
//      title on scroll.
//   2. Hero: 96pt avatar centred, 22pt semibold display name, 13pt
//      muted handle.  Tap target opens Profile.
//   3. Grouped list — "Account" (View Profile, Settings) with a
//      single bottom-rounded card.  "Session" (Sign out destructive)
//      as a standalone card.
//
// Touch targets: 44pt minimum (44pt hero rows, 56pt list rows).
// Body: 17pt regular.  Caption: 13pt secondary.  Tint: theme primary.
// Haptic: selection on every row tap so iOS muscle-memory fires.

import type { ReactNode } from "react";
import { ChevronRight, User as UserIcon, Settings as SettingsIcon, LogOut } from "lucide-react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { cn } from "@/lib/utils";
import { hapticSelection } from "@/lib/haptics";
import { formatMxid, serverOf } from "@/lib/mxid";

interface MobileMeScreenProps {
	userId: string | null;
	avatarMxc?: string | null;
	displayName?: string | null;
	onOpenProfile(): void;
	onOpenSettings(): void;
	onSignOut(): void;
}

export function MobileMeScreen({
	userId,
	avatarMxc,
	displayName,
	onOpenProfile,
	onOpenSettings,
	onSignOut,
}: MobileMeScreenProps) {
	const localpart = userId?.startsWith("@")
		? userId.slice(1).split(":")[0] ?? userId
		: userId ?? "—";
	const shownName = displayName?.trim() || localpart;
	// The @handle, suffix-collapsed when it's on the user's own server
	// (always true here — this is the user's own id).
	const handle = userId ? formatMxid(userId, serverOf(userId)) : "";

	function tap(action: () => void) {
		void hapticSelection();
		action();
	}

	return (
		<div className="flex-1 overflow-y-auto pb-8">
			{/* Large title.  Lives inside the scroll so it visually
			    "collapses" as the user scrolls; the contextual nav-bar
			    title in MobileTopBar takes over on scroll. */}
			<div className="px-4 pt-3">
				<h1 className="text-[34px] font-bold tracking-[-0.022em] leading-[1.1] text-foreground py-3">
					Me
				</h1>
			</div>

			{/* Hero — avatar centred, name + handle below.  Tappable
			    surface opens the user's own profile push view. */}
			<button
				type="button"
				onClick={() => tap(onOpenProfile)}
				className={cn(
					"w-full flex flex-col items-center gap-3 px-5 pt-2 pb-6",
					"transition-opacity active:opacity-70",
				)}
				aria-label="Open your profile"
			>
				{userId ? (
					<MatrixAvatar
						mxc={avatarMxc ?? undefined}
						seed={userId}
						kind="user"
						className="h-24 w-24 rounded-full shrink-0 ring-1 ring-foreground/10"
					/>
				) : (
					<div className="h-24 w-24 rounded-full bg-muted shrink-0" />
				)}
				<div className="flex flex-col items-center gap-0.5 max-w-full">
					<div className="text-[22px] font-semibold tracking-[-0.01em] text-foreground truncate max-w-[280px] leading-tight">
						{shownName}
					</div>
					<div className="text-[13px] text-muted-foreground font-mono truncate max-w-[280px]">
						{handle}
					</div>
				</div>
			</button>

			{/* Account group — grouped inset card.  Theme adapts via
			    `bg-card`; hairline separators between rows render via
			    the row's own bottom border, last-of-type drops it. */}
			<GroupLabel>Account</GroupLabel>
			<GroupCard>
				<MeRow
					icon={<UserIcon className="h-[22px] w-[22px]" strokeWidth={2} />}
					label="View Profile"
					onClick={() => tap(onOpenProfile)}
				/>
				<MeRow
					icon={<SettingsIcon className="h-[22px] w-[22px]" strokeWidth={2} />}
					label="Settings"
					onClick={() => tap(onOpenSettings)}
					last
				/>
			</GroupCard>

			{/* Session group — destructive in its own card per HIG
			    (destructive actions visually separated from neutral
			    rows so a misread doesn't trigger Sign out). */}
			<GroupLabel>Session</GroupLabel>
			<GroupCard>
				<MeRow
					icon={<LogOut className="h-[22px] w-[22px]" strokeWidth={2} />}
					label="Sign Out"
					onClick={() => tap(onSignOut)}
					danger
					last
				/>
			</GroupCard>
		</div>
	);
}

function GroupLabel({ children }: { children: ReactNode }) {
	// 13pt uppercase muted label sits 8pt above each card, indented to
	// match the card's content (20pt from the screen edge so the label
	// aligns with the row text inside).
	return (
		<div className="px-5 pt-6 pb-1.5 text-[13px] font-medium uppercase tracking-[0.06em] text-muted-foreground/80">
			{children}
		</div>
	);
}

function GroupCard({ children }: { children: ReactNode }) {
	// Grouped-inset card: 16pt screen-edge margin, 14pt rounded
	// corners, hairline border, card background so light + dark
	// themes both read with depth.
	return (
		<div className="mx-4 rounded-[14px] overflow-hidden bg-card/85 border border-foreground/10 shadow-sm">
			{children}
		</div>
	);
}

function MeRow({
	icon,
	label,
	danger,
	last,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	danger?: boolean;
	last?: boolean;
	onClick(): void;
}) {
	// 44pt minimum touch target; we use 52pt for visual breathing
	// room.  Icon column is 32pt wide so a tinted SF-Symbol-equivalent
	// reads as a balanced leading glyph.  Hairline separator between
	// rows; last row drops it.
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"w-full flex items-center gap-3 pl-4 pr-3.5",
				"min-h-[52px] text-left",
				"transition-colors active:bg-foreground/5",
				!last && "border-b border-foreground/10",
			)}
		>
			<div
				className={cn(
					"shrink-0 flex items-center justify-center w-8",
					danger ? "text-destructive" : "text-primary",
				)}
			>
				{icon}
			</div>
			<div className="flex-1 min-w-0">
				<div
					className={cn(
						"text-[17px] truncate",
						danger ? "text-destructive font-medium" : "text-foreground",
					)}
				>
					{label}
				</div>
			</div>
			{!danger && (
				<ChevronRight className="h-[18px] w-[18px] text-muted-foreground/50 shrink-0" strokeWidth={2.5} />
			)}
		</button>
	);
}

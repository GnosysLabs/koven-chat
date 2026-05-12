// MobileMeScreen — the "Me" tab landing.  Shows the user's
// identity at the top, then a list of tappable rows that open
// existing sheets/dialogs (Profile, Settings, Sign out).  iOS-
// native pattern: the bottom-tab "you" surface is a real screen,
// not a hamburger sub-menu — easier to scan, easier to add
// future surfaces (Sessions, Theme picker, Notifications) as
// dedicated rows.

import type { ReactNode } from "react";
import { ChevronRight, User as UserIcon, Settings as SettingsIcon, LogOut } from "lucide-react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { cn } from "@/lib/utils";

interface MobileMeScreenProps {
	userId: string | null;
	avatarMxc?: string | null;
	onOpenProfile(): void;
	onOpenSettings(): void;
	onSignOut(): void;
}

export function MobileMeScreen({
	userId,
	avatarMxc,
	onOpenProfile,
	onOpenSettings,
	onSignOut,
}: MobileMeScreenProps) {
	const localpart = userId?.startsWith("@")
		? userId.slice(1).split(":")[0] ?? userId
		: userId ?? "—";

	return (
		<div className="flex-1 overflow-y-auto">
			{/* Identity card — large avatar + name.  Tappable surface
			    that opens the user's own profile sheet, mirroring
			    how the SpaceBar avatar tile behaves on desktop. */}
			<button
				type="button"
				onClick={onOpenProfile}
				className={cn(
					"w-full flex items-center gap-4 p-4",
					"text-left transition-colors active:bg-accent",
					"border-b border-border/40",
				)}
			>
				{userId ? (
					<MatrixAvatar
						mxc={avatarMxc ?? undefined}
						seed={userId}
						kind="user"
						className="h-16 w-16 rounded-full shrink-0"
					/>
				) : (
					<div className="h-16 w-16 rounded-full bg-muted shrink-0" />
				)}
				<div className="flex-1 min-w-0">
					<div className="text-lg font-semibold text-foreground truncate">
						{localpart}
					</div>
					<div className="text-xs text-muted-foreground truncate font-mono">
						{userId ?? ""}
					</div>
				</div>
				<ChevronRight className="h-5 w-5 text-muted-foreground/60 shrink-0" />
			</button>

			<SectionLabel>Account</SectionLabel>
			<MeRow
				icon={<UserIcon className="h-5 w-5" />}
				label="View profile"
				sublabel="Your public profile, bio, and avatar"
				onClick={onOpenProfile}
			/>
			<MeRow
				icon={<SettingsIcon className="h-5 w-5" />}
				label="Settings"
				sublabel="Theme, content filters, sessions, account"
				onClick={onOpenSettings}
			/>

			<SectionLabel>Session</SectionLabel>
			<MeRow
				icon={<LogOut className="h-5 w-5" />}
				label="Sign out"
				danger
				onClick={onSignOut}
			/>

			<div className="h-8" />
		</div>
	);
}

function SectionLabel({ children }: { children: ReactNode }) {
	return (
		<div className="px-4 pt-5 pb-1 text-[11px] font-bold tracking-wider uppercase text-muted-foreground">
			{children}
		</div>
	);
}

function MeRow({
	icon,
	label,
	sublabel,
	danger,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	sublabel?: string;
	danger?: boolean;
	onClick(): void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"w-full flex items-center gap-3 px-4 py-3",
				"min-h-[56px] text-left",
				"transition-colors active:bg-accent",
				"border-b border-border/40",
				danger ? "text-destructive" : "text-foreground",
			)}
		>
			<div className="shrink-0 flex items-center justify-center w-7">
				{icon}
			</div>
			<div className="flex-1 min-w-0">
				<div className="text-sm font-medium truncate">{label}</div>
				{sublabel ? (
					<div className="text-xs text-muted-foreground truncate">{sublabel}</div>
				) : null}
			</div>
			<ChevronRight className="h-4 w-4 text-muted-foreground/60 shrink-0" />
		</button>
	);
}

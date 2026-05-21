// MobileSettingsScreen — iOS HIG settings push view.  Root list +
// internal push stack for sub-screens (Sessions, Blocked, Instance,
// Delete Account).  The root path follows iOS Settings conventions:
//
//   - Each section is a grouped-inset card with 13pt section labels
//     above.
//   - List rows are 44pt min height, 17pt body text, system tint
//     for value/chevron on the right.
//   - Switches use the platform Switch (radix shadcn variant).
//   - Destructive actions sit in their own bottom card with red text.
//
// Sub-screens (Blocked Users, Sessions, Delete Account) are their
// own HIG-native push views — see MobileBlockedUsersScreen,
// MobileSessionsScreen, MobileDeleteAccountScreen.  Instance admin
// still embeds the desktop sections because that surface is dense,
// admin-gated, and a HIG reskin is a separate pass.

import { useEffect, useState } from "react";
import { ChevronRight, Check, Eye, Palette, Shield, Monitor, QrCode, Wrench, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import type { Settings, Theme } from "@/state/settings";
import { THEMES } from "@/state/settings";
import { MobileBlockedUsersScreen } from "@/components/MobileBlockedUsersScreen";
import { MobileSessionsScreen } from "@/components/MobileSessionsScreen";
import { MobileDeleteAccountScreen } from "@/components/MobileDeleteAccountScreen";
import { MobileLinkDeviceScreen } from "@/components/MobileLinkDeviceScreen";
import { InstanceAdminSection } from "@/components/InstanceAdminSection";
import { AdminManagementSection } from "@/components/AdminManagementSection";
import { BannedUsersSection } from "@/components/BannedUsersSection";
import { fetchAdminStatus, type InstanceConfig } from "@/lib/instance";
import { fetchUserProfile, updateMyProfileData } from "@/lib/profile";
import { hapticImpact } from "@/lib/haptics";
import { isCapacitor } from "@/lib/nativeShell";
import type { MatrixTransport } from "@/lib/matrix";
import type { UserId } from "@koven/shared";
import {
	NavBar,
	NavBackButton,
	GroupLabel,
	GroupCard,
	GroupFooter,
	PushSlot,
} from "@/components/mobile/Chrome";

export interface MobileSettingsScreenProps {
	settings: Settings;
	onSettingsChange(next: Settings): void;
	accessToken: string | null;
	transport: MatrixTransport | null;
	currentUserId: UserId | null;
	ignoredUsers: Set<UserId>;
	onBack(): void;
	onSignOut(): void;
	onSignedOut(): void;
	onConfigChange?: (config: InstanceConfig) => void;
}

type SubScreen =
	| "appearance"
	| "blocked"
	| "sessions"
	| "linkdevice"
	| "instance"
	| "delete";

export function MobileSettingsScreen({
	settings,
	onSettingsChange,
	accessToken,
	transport,
	currentUserId,
	ignoredUsers,
	onBack,
	onSignOut,
	onSignedOut,
	onConfigChange,
}: MobileSettingsScreenProps) {
	const [sub, setSub] = useState<SubScreen | null>(null);
	const [isAdmin, setIsAdmin] = useState(false);
	const [discoverable, setDiscoverable] = useState(true);

	useEffect(() => {
		if (!accessToken) { setIsAdmin(false); return; }
		let cancelled = false;
		fetchAdminStatus(accessToken)
			.then(r => { if (!cancelled) setIsAdmin(!!r.is_admin); })
			.catch(() => { if (!cancelled) setIsAdmin(false); });
		return () => { cancelled = true; };
	}, [accessToken]);

	useEffect(() => {
		if (!currentUserId) return;
		let cancelled = false;
		fetchUserProfile(currentUserId)
			.then(p => { if (!cancelled) setDiscoverable(p.discoverable !== false); })
			.catch(() => {});
		return () => { cancelled = true; };
	}, [currentUserId]);

	function push(s: SubScreen) {
		void hapticImpact("light");
		setSub(s);
	}

	function pop() {
		void hapticImpact("light");
		setSub(null);
	}

	const activeTheme = THEMES.find(t => t.id === settings.theme) ?? THEMES[0]!;
	const blockedCount = ignoredUsers.size;

	/* ─── Root settings list ──────────────────────────────────────────
	   The root always renders; each sub-screen is overlaid via
	   PushSlot so back-navigation plays a clean fade-out animation
	   instead of an instant unmount. */
	return (
		<div className="relative flex flex-col h-full overflow-hidden">
			<div
				className={cn(
					"flex flex-col h-full mobile-push-underlayer",
					sub !== null && "is-pushed",
				)}
			>
			<NavBar
				left={<NavBackButton onClick={onBack} />}
				title="Settings"
			/>

			<div className="flex-1 overflow-y-auto pb-10">

				{/* ─── Preferences ─────────────────────────────────── */}
				<GroupLabel>Preferences</GroupLabel>
				<GroupCard>
					<DisclosureRow
						icon={<Palette className="h-[20px] w-[20px]" strokeWidth={2.1} />}
						iconBg="bg-pink-500"
						label="Appearance"
						value={activeTheme.label}
						onClick={() => push("appearance")}
						last
					/>
				</GroupCard>

				{/* ─── Privacy & Sessions ──────────────────────────── */}
				{accessToken && (
					<>
						<GroupLabel>Privacy</GroupLabel>
						<GroupCard>
							<SwitchRow
								icon={<Eye className="h-[20px] w-[20px]" strokeWidth={2.1} />}
								iconBg="bg-green-500"
								label="Discoverable"
								checked={discoverable}
								onCheckedChange={(checked) => {
									setDiscoverable(checked);
									if (accessToken) {
										updateMyProfileData(accessToken, { discoverable: checked })
											.catch(() => setDiscoverable(!checked));
									}
								}}
							/>
							<DisclosureRow
								icon={<Shield className="h-[20px] w-[20px]" strokeWidth={2.1} />}
								iconBg="bg-slate-500"
								label="Blocked Users"
								value={blockedCount === 0 ? "None" : String(blockedCount)}
								onClick={() => push("blocked")}
							/>
							<DisclosureRow
								icon={<Monitor className="h-[20px] w-[20px]" strokeWidth={2.1} />}
								iconBg="bg-blue-500"
								label="Active Sessions"
								onClick={() => push("sessions")}
								last={!isCapacitor()}
							/>
							{isCapacitor() && (
								<DisclosureRow
									icon={<QrCode className="h-[20px] w-[20px]" strokeWidth={2.1} />}
									iconBg="bg-indigo-500"
									label="Link a Device"
									onClick={() => push("linkdevice")}
									last
								/>
							)}
						</GroupCard>
					</>
				)}

				{/* ─── Admin (gated) ───────────────────────────────── */}
				{isAdmin && accessToken && (
					<>
						<GroupLabel>Admin</GroupLabel>
						<GroupCard>
							<DisclosureRow
								icon={<Wrench className="h-[20px] w-[20px]" strokeWidth={2.1} />}
								iconBg="bg-purple-500"
								label="Instance"
								onClick={() => push("instance")}
								last
							/>
						</GroupCard>
					</>
				)}

				{/* ─── Danger zone ─────────────────────────────────── */}
				{accessToken && (
					<>
						<GroupLabel>Danger Zone</GroupLabel>
						<GroupCard>
							<ActionRow
								icon={<Trash2 className="h-[20px] w-[20px]" strokeWidth={2.1} />}
								iconBg="bg-destructive"
								label="Delete Account"
								destructive
								onClick={() => push("delete")}
								last
							/>
						</GroupCard>
					</>
				)}

				{/* Build / version line — tiny secondary text at the very
				    bottom matches what iOS Settings does ("Koven 0.x"). */}
				<div className="px-5 pt-8 text-center text-[11px] text-muted-foreground/60">
					Koven
				</div>
			</div>
			</div>

			{/* Sub-screens.  Each PushSlot defers unmount until its
			    exit animation finishes, so popping back to the root
			    plays a fade-out instead of an instant disappear. */}
			<PushSlot visible={sub === "appearance"} onPop={pop}>
				<AppearanceSubScreen
					settings={settings}
					onSettingsChange={onSettingsChange}
					onBack={pop}
				/>
			</PushSlot>
			<PushSlot visible={sub === "blocked"} onPop={pop}>
				<MobileBlockedUsersScreen
					transport={transport ?? null}
					ignoredUsers={ignoredUsers}
					onBack={pop}
				/>
			</PushSlot>
			<PushSlot visible={sub === "sessions"} onPop={pop}>
				{accessToken ? (
					<MobileSessionsScreen
						accessToken={accessToken}
						transport={transport ?? null}
						onBack={pop}
					/>
				) : (
					<SubScreenShell title="Sessions" onBack={pop}>
						<EmptyHint label="Sign in required" />
					</SubScreenShell>
				)}
			</PushSlot>
			<PushSlot visible={sub === "linkdevice"} onPop={pop}>
				<MobileLinkDeviceScreen
					transport={transport ?? null}
					accessToken={accessToken}
					onBack={pop}
				/>
			</PushSlot>
			<PushSlot visible={sub === "instance"} onPop={pop}>
				{/* Instance admin: dense forms (branding fields,
				    integration secrets, admin roster).  The forms
				    themselves keep the desktop-component shape —
				    porting ~870 lines of Inputs / Labels / file
				    uploads would be duplication for very little
				    return on an admin-only surface — but they sit
				    inside HIG grouped-inset cards with iOS-style
				    section labels so the chrome matches the rest
				    of the mobile settings stack. */}
				<SubScreenShell title="Instance" onBack={pop}>
					<div className="pb-10">
						<GroupLabel>Branding &amp; Configuration</GroupLabel>
						<GroupCard>
							<div className="px-4 py-4">
								{accessToken && (
									<InstanceAdminSection
										accessToken={accessToken}
										transport={transport ?? null}
										onConfigChange={onConfigChange}
									/>
								)}
							</div>
						</GroupCard>
						<GroupFooter>
							Settings here apply instance-wide — every user on this homeserver sees them. The Save buttons inside each subsection commit changes independently.
						</GroupFooter>

						{accessToken && currentUserId && (
							<>
								<GroupLabel>Administrators</GroupLabel>
								<GroupCard>
									<div className="px-4 py-4">
										<AdminManagementSection
											accessToken={accessToken}
											transport={transport ?? null}
											currentUserId={currentUserId}
										/>
									</div>
								</GroupCard>
								<GroupFooter>
									Promote another user to admin before stepping back from this role — instance moderation breaks down if there's nobody to review reports.
								</GroupFooter>
							</>
						)}

						{accessToken && (
							<>
								<GroupLabel>Platform bans</GroupLabel>
								<GroupCard>
									<div className="px-4 py-4">
										<BannedUsersSection
											accessToken={accessToken}
											transport={transport ?? null}
										/>
									</div>
								</GroupCard>
							</>
						)}
					</div>
				</SubScreenShell>
			</PushSlot>
			<PushSlot visible={sub === "delete"} onPop={pop}>
				{accessToken ? (
					<MobileDeleteAccountScreen
						accessToken={accessToken}
						transport={transport ?? null}
						onBack={pop}
						onSignedOut={onSignedOut}
					/>
				) : (
					<SubScreenShell title="Delete Account" onBack={pop}>
						<EmptyHint label="Sign in required" />
					</SubScreenShell>
				)}
			</PushSlot>
		</div>
	);
}

function AppearanceSubScreen({
	settings,
	onSettingsChange,
	onBack,
}: {
	settings: Settings;
	onSettingsChange(next: Settings): void;
	onBack(): void;
}) {
	return (
		<SubScreenShell title="Appearance" onBack={onBack}>
			<div className="pb-8">
				<GroupLabel>Dark</GroupLabel>
				<GroupCard>
					<ThemeGrid
						themes={THEMES.filter(t => t.mode === "dark")}
						activeId={settings.theme}
						onPick={id => {
							void hapticImpact("light");
							onSettingsChange({ ...settings, theme: id });
						}}
					/>
				</GroupCard>

				<GroupLabel>Light</GroupLabel>
				<GroupCard>
					<ThemeGrid
						themes={THEMES.filter(t => t.mode === "light")}
						activeId={settings.theme}
						onPick={id => {
							void hapticImpact("light");
							onSettingsChange({ ...settings, theme: id });
						}}
					/>
				</GroupCard>
			</div>
		</SubScreenShell>
	);
}

/* ── Sub-screen shell ────────────────────────────────────────────── */

function SubScreenShell({
	title,
	onBack,
	children,
}: {
	title: string;
	onBack(): void;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col h-full">
			<NavBar
				left={<NavBackButton onClick={onBack} />}
				title={title}
			/>
			<div className="flex-1 overflow-y-auto">
				{children}
			</div>
		</div>
	);
}

/* ── Theme grid ──────────────────────────────────────────────────── */

function ThemeGrid({ themes, activeId, onPick }: {
	themes: typeof THEMES;
	activeId: Theme;
	onPick(id: Theme): void;
}) {
	return (
		<div className="grid grid-cols-4 gap-x-3 gap-y-4 px-4 py-4">
			{themes.map(t => (
				<button
					key={t.id}
					type="button"
					onClick={() => onPick(t.id)}
					title={t.label}
					aria-label={t.label}
					className="flex flex-col items-center gap-1.5 active:opacity-70 transition-opacity"
				>
					<span
						className={cn(
							"relative h-14 w-14 rounded-full transition-all",
							activeId === t.id
								? "ring-2 ring-primary ring-offset-2 ring-offset-card shadow-md"
								: "ring-1 ring-foreground/15",
						)}
						style={{ backgroundImage: t.swatch }}
					>
						{activeId === t.id && (
							<span className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-full">
								<Check className="h-5 w-5 text-white" strokeWidth={3} />
							</span>
						)}
					</span>
					<span
						className={cn(
							"text-[11px] tracking-wide",
							activeId === t.id ? "text-foreground font-medium" : "text-muted-foreground",
						)}
					>
						{t.label}
					</span>
				</button>
			))}
		</div>
	);
}

/* ── Row primitives ──────────────────────────────────────────────── */

function DisclosureRow({
	icon,
	iconBg,
	label,
	subtitle,
	value,
	onClick,
	last,
}: {
	icon: React.ReactNode;
	iconBg: string;
	label: string;
	subtitle?: string;
	value?: string;
	onClick(): void;
	last?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"w-full flex items-center gap-3 pl-3 pr-3.5 py-2.5",
				"min-h-[52px] text-left",
				"transition-colors active:bg-foreground/5",
				!last && "border-b border-foreground/10",
			)}
		>
			<IconBadge bg={iconBg}>{icon}</IconBadge>
			<div className="flex-1 min-w-0">
				<div className="text-[17px] text-foreground truncate">{label}</div>
				{subtitle ? (
					<div className="text-[12px] text-muted-foreground truncate leading-snug mt-0.5">
						{subtitle}
					</div>
				) : null}
			</div>
			{value ? (
				<span className="text-[15px] text-muted-foreground truncate max-w-[120px]">
					{value}
				</span>
			) : null}
			<ChevronRight className="h-[18px] w-[18px] text-muted-foreground/50 shrink-0" strokeWidth={2.5} />
		</button>
	);
}

function ActionRow({
	icon,
	iconBg,
	label,
	destructive,
	onClick,
	last,
}: {
	icon: React.ReactNode;
	iconBg: string;
	label: string;
	destructive?: boolean;
	onClick(): void;
	last?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"w-full flex items-center gap-3 pl-3 pr-3.5 py-2.5",
				"min-h-[52px] text-left",
				"transition-colors active:bg-foreground/5",
				!last && "border-b border-foreground/10",
			)}
		>
			<IconBadge bg={iconBg}>{icon}</IconBadge>
			<div className="flex-1 min-w-0">
				<div
					className={cn(
						"text-[17px] truncate font-medium",
						destructive ? "text-destructive" : "text-foreground",
					)}
				>
					{label}
				</div>
			</div>
		</button>
	);
}

function SwitchRow({
	icon,
	iconBg,
	label,
	checked,
	onCheckedChange,
	last,
}: {
	icon: React.ReactNode;
	iconBg: string;
	label: string;
	checked: boolean;
	onCheckedChange(checked: boolean): void;
	last?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex items-center gap-3 pl-3 pr-3.5 py-2.5",
				"min-h-[52px]",
				!last && "border-b border-foreground/10",
			)}
		>
			<IconBadge bg={iconBg}>{icon}</IconBadge>
			<div className="flex-1 min-w-0">
				<div className="text-[17px] text-foreground truncate">{label}</div>
			</div>
			<Switch checked={checked} onCheckedChange={onCheckedChange} />
		</div>
	);
}

function IconBadge({ bg, children }: { bg: string; children: React.ReactNode }) {
	return (
		<div
			className={cn(
				"shrink-0 h-7 w-7 rounded-[7px] flex items-center justify-center text-white",
				bg,
			)}
		>
			{children}
		</div>
	);
}

function EmptyHint({ label }: { label: string }) {
	return (
		<div className="text-center text-[15px] text-muted-foreground italic mt-8">
			{label}
		</div>
	);
}


// App-level settings dialog — opens from the sidebar footer cog.
// Two-column layout mirroring Element: a thin sidebar of tab labels on
// the left, the active tab's content on the right.  Most settings are
// localStorage-persisted; the Instance tab is admin-gated and writes
// to the engine's config endpoints.

import { useEffect, useState } from "react";
import {
	Dialog,
	DialogContent,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Settings, Theme } from "@/state/settings";
import { THEMES } from "@/state/settings";
import { Check, Palette, User, Wrench, type LucideIcon } from "lucide-react";
import { InstanceAdminSection } from "@/components/InstanceAdminSection";
import { AccountSection } from "@/components/AccountSection";
import { fetchAdminStatus } from "@/lib/instance";
import type { MatrixTransport } from "@/lib/matrix";
import type { UserId } from "@koven/shared";

export interface AppSettingsSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	settings: Settings;
	onSettingsChange(next: Settings): void;
	accessToken?: string | null;
	// Transport is needed by the Instance admin section to enumerate
	// public spaces for the default-space picker.
	transport?: MatrixTransport | null;
	// Live ignore-list state for the Account tab's blocked-users list.
	ignoredUsers?: Set<UserId>;
	// Self-deactivation success → drop credentials in the parent.
	onSignedOut?(): void;
}

interface TabDef {
	id: string;
	label: string;
	icon: LucideIcon;
}

export function AppSettingsSheet({ open, onOpenChange, settings, onSettingsChange, accessToken, transport, ignoredUsers, onSignedOut }: AppSettingsSheetProps) {
	const [activeTab, setActiveTab] = useState("appearance");
	const [isAdmin, setIsAdmin] = useState(false);

	function update<K extends keyof Settings>(key: K, value: Settings[K]) {
		onSettingsChange({ ...settings, [key]: value });
	}

	// Re-check admin status whenever the dialog opens.  Cheap and
	// covers the case where someone gets promoted while the app is
	// running.
	useEffect(() => {
		if (!open || !accessToken) { setIsAdmin(false); return; }
		let cancelled = false;
		fetchAdminStatus(accessToken)
			.then(r => { if (!cancelled) setIsAdmin(r.is_admin); })
			.catch(() => { if (!cancelled) setIsAdmin(false); });
		return () => { cancelled = true; };
	}, [open, accessToken]);

	const tabs: TabDef[] = [
		{ id: "appearance", label: "Appearance", icon: Palette },
	];
	if (accessToken) {
		tabs.push({ id: "account", label: "Account", icon: User });
	}
	if (isAdmin && accessToken) {
		// Pending review lives in its own dialog now (shield icon
		// above Settings in the SpaceBar) so admins see the queue
		// count at a glance.  Instance branding stays here.
		tabs.push({ id: "instance", label: "Instance", icon: Wrench });
	}
	// If the active tab vanished (e.g., user lost admin), fall back to
	// the first tab on next render.
	if (!tabs.some(t => t.id === activeTab) && tabs[0]) {
		setActiveTab(tabs[0].id);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-3xl p-0 gap-0 overflow-hidden">
				<div className="flex h-[560px] max-h-[80vh]">
					{/* Left rail */}
					<aside className="w-44 shrink-0 border-r border-border bg-muted/30 flex flex-col">
						<div className="px-4 h-12 flex items-center border-b border-border">
							<span className="text-sm font-semibold">Settings</span>
						</div>
						<nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
							{tabs.map(tab => {
								const Icon = tab.icon;
								const active = tab.id === activeTab;
								return (
									<button
										key={tab.id}
										type="button"
										onClick={() => setActiveTab(tab.id)}
										className={cn(
											"w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left transition-colors",
											active
												? "bg-accent text-accent-foreground font-medium"
												: "text-muted-foreground hover:text-foreground hover:bg-accent/50",
										)}
									>
										<Icon className="h-3.5 w-3.5 shrink-0" />
										<span className="truncate">{tab.label}</span>
									</button>
								);
							})}
						</nav>
					</aside>

					{/* Right content */}
					<div className="flex-1 flex flex-col min-w-0">
						<div className="px-6 h-12 flex items-center border-b border-border">
							<h2 className="text-sm font-semibold">{tabs.find(t => t.id === activeTab)?.label ?? "Settings"}</h2>
						</div>
						<div className="flex-1 overflow-y-auto px-6 py-5">
							{activeTab === "appearance" && (
								<div className="space-y-6">
									<div>
										<div className="text-sm font-medium">Theme</div>
										<p className="text-xs text-muted-foreground leading-snug mt-0.5">
											Pick the look that fits your vibe. Applies instantly.
										</p>
									</div>

									<ThemeGroup
										label="Dark"
										themes={THEMES.filter(t => t.mode === "dark")}
										activeId={settings.theme}
										onPick={(id) => update("theme", id)}
									/>

									<ThemeGroup
										label="Light"
										themes={THEMES.filter(t => t.mode === "light")}
										activeId={settings.theme}
										onPick={(id) => update("theme", id)}
									/>
								</div>
							)}

							{activeTab === "account" && accessToken && (
								<AccountSection
									accessToken={accessToken}
									transport={transport ?? null}
									ignoredUsers={ignoredUsers ?? new Set()}
									onSignedOut={() => {
										// Close the sheet first; the parent's
										// sign-out will unmount most of this
										// tree on the next paint anyway.
										onOpenChange(false);
										onSignedOut?.();
									}}
									settings={settings}
									onSettingsChange={onSettingsChange}
								/>
							)}

							{activeTab === "instance" && accessToken && (
								<InstanceAdminSection accessToken={accessToken} transport={transport ?? null} />
							)}
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function ThemeGroup({ label, themes, activeId, onPick }: {
	label: string;
	themes: typeof THEMES;
	activeId: Theme;
	onPick(id: Theme): void;
}) {
	return (
		<section>
			<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
				{label}
			</div>
			<div className="grid grid-cols-5 gap-3 max-w-md">
				{themes.map(t => (
					<ThemeSwatch
						key={t.id}
						label={t.label}
						swatch={t.swatch}
						selected={activeId === t.id}
						onClick={() => onPick(t.id)}
					/>
				))}
			</div>
		</section>
	);
}

function ThemeSwatch({ selected, onClick, swatch, label }: {
	selected: boolean;
	onClick(): void;
	swatch: string;
	label: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={label}
			aria-label={label}
			className="group flex flex-col items-center gap-1.5"
		>
			<span
				className={cn(
					"relative h-12 w-12 rounded-full transition-all",
					// Use ring (box-shadow) instead of border so the ring sits
					// outside the swatch's background-image and stays a clean,
					// uninterrupted circle.
					selected
						? "ring-2 ring-primary ring-offset-2 ring-offset-background scale-105 shadow-md"
						: "ring-1 ring-border group-hover:ring-2 group-hover:ring-foreground/50"
				)}
				style={{ backgroundImage: swatch }}
			>
				{selected && (
					<span className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-full">
						<Check className="h-4 w-4 text-white" strokeWidth={3} />
					</span>
				)}
			</span>
			<span className={cn(
				"text-[10px] tracking-wide transition-colors",
				selected ? "text-foreground font-medium" : "text-muted-foreground"
			)}>
				{label}
			</span>
		</button>
	);
}

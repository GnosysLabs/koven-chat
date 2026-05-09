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
import { Check, Monitor, Palette, User, Wrench, type LucideIcon } from "lucide-react";
import { InstanceAdminSection } from "@/components/InstanceAdminSection";
import { AccountSection } from "@/components/AccountSection";
import { SessionsSection } from "@/components/SessionsSection";
import { fetchAdminStatus } from "@/lib/instance";
import { ensureNotificationPermission } from "@/lib/notifications";
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
		// Sessions = device list + bulk-revoke.  Sits next to Account
		// because it's about the user's sign-in state, but distinct
		// because the affordance set is wholly different (no
		// blocked-users / delete-account ops, just a device manager).
		tabs.push({ id: "sessions", label: "Sessions", icon: Monitor });
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

									{/* Debug: diagnostic notification trigger.
									    Bypasses the onMessage gate (live-only,
									    not-self, mention/DM/reply) so we can
									    bisect "is the gate broken" vs. "is the
									    Tauri / browser plumbing broken".  If
									    this button fires a notification, the
									    plumbing's fine; if not, lib/
									    notifications is the problem (Tauri
									    permission, plugin import, browser SW
									    registration, etc.).  Remove once
									    notifications are confirmed working. */}
									<NotificationDebug />
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

							{activeTab === "sessions" && accessToken && (
								<SessionsSection
									accessToken={accessToken}
									transport={transport ?? null}
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

function NotificationDebug() {
	const [steps, setSteps] = useState<DebugStep[]>([]);
	const [pending, setPending] = useState(false);

	async function fire() {
		setPending(true);
		const log: DebugStep[] = [];
		const push = (s: DebugStep) => {
			log.push(s);
			setSteps([...log]);
		};

		// Step 1 — permission.
		push({ label: "Browser permission", state: "pending", detail: "asking…" });
		const perm = await ensureNotificationPermission();
		log[log.length - 1] = {
			label: "Browser permission",
			state: perm === "granted" ? "ok" : "fail",
			detail:
				perm === "granted" ? "granted" :
				perm === "denied"  ? "denied — re-enable in browser site settings (lock icon → Notifications)" :
				"default — accept the prompt next time",
		};
		setSteps([...log]);
		if (perm !== "granted") {
			pushPlatformHints(push);
			setPending(false);
			return;
		}

		// Step 2 — SW registration.
		push({ label: "Service worker", state: "pending", detail: "checking registration…" });
		let reg: ServiceWorkerRegistration | null = null;
		if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
			try {
				reg = await Promise.race([
					navigator.serviceWorker.ready,
					new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
				]);
			} catch (err) {
				log[log.length - 1] = {
					label: "Service worker",
					state: "fail",
					detail: `error: ${err instanceof Error ? err.message : String(err)}`,
				};
				setSteps([...log]);
			}
		}
		log[log.length - 1] = reg
			? { label: "Service worker", state: "ok", detail: `active scope: ${reg.scope}` }
			: { label: "Service worker", state: "warn", detail: "not registered — falling back to page-side Notification()" };
		setSteps([...log]);

		// Step 3 — SW showNotification path (preferred everywhere).
		if (reg) {
			push({ label: "SW showNotification", state: "pending", detail: "calling…" });
			try {
				await reg.showNotification("Koven test (SW path)", {
					body: "If you see this, the SW path works.",
					tag: "koven-debug-sw",
					icon: "/favicon.png",
				});
				log[log.length - 1] = {
					label: "SW showNotification",
					state: "ok",
					detail: "promise resolved — OS should display now",
				};
			} catch (err) {
				log[log.length - 1] = {
					label: "SW showNotification",
					state: "fail",
					detail: err instanceof Error ? err.message : String(err),
				};
			}
			setSteps([...log]);
		}

		// Step 4 — page-side Notification constructor.  Some browsers
		// (Chromium especially) only deliver this path when the page
		// already has notifications permission AND the OS-level
		// notification toggle for the browser is on; comparing both
		// success states helps distinguish browser-blocked vs. OS-
		// blocked vs. user-dismissed-the-banner.
		push({ label: "Page Notification()", state: "pending", detail: "calling…" });
		try {
			if (typeof Notification === "undefined") {
				log[log.length - 1] = {
					label: "Page Notification()",
					state: "warn",
					detail: "constructor not available in this runtime",
				};
			} else {
				const n = new Notification("Koven test (page path)", {
					body: "If you see this, the page-side path works.",
					tag: "koven-debug-page",
					icon: "/favicon.png",
				});
				// Listen for show / error so we can report them.
				let resolved = false;
				await new Promise<void>((resolve) => {
					n.addEventListener("show", () => {
						if (resolved) return;
						resolved = true;
						log[log.length - 1] = {
							label: "Page Notification()",
							state: "ok",
							detail: "show event fired — OS displayed it",
						};
						setSteps([...log]);
						resolve();
					});
					n.addEventListener("error", (e) => {
						if (resolved) return;
						resolved = true;
						log[log.length - 1] = {
							label: "Page Notification()",
							state: "fail",
							detail: `error event: ${(e as { message?: string }).message ?? "(no detail)"}`,
						};
						setSteps([...log]);
						resolve();
					});
					// 1.5s timeout — if neither show nor error fires,
					// the OS silently swallowed it (Focus mode, OS-level
					// disabled).  This is the most useful signal.
					setTimeout(() => {
						if (resolved) return;
						resolved = true;
						log[log.length - 1] = {
							label: "Page Notification()",
							state: "warn",
							detail: "no show / error event in 1.5s — OS likely suppressed (Focus / DnD / app disabled in OS settings)",
						};
						setSteps([...log]);
						resolve();
					}, 1500);
				});
			}
		} catch (err) {
			log[log.length - 1] = {
				label: "Page Notification()",
				state: "fail",
				detail: err instanceof Error ? err.message : String(err),
			};
			setSteps([...log]);
		}

		pushPlatformHints(push);
		setPending(false);
	}

	return (
		<section className="border-t border-border/40 pt-4 mt-4">
			<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
				Debug
			</div>
			<div className="flex items-center justify-between gap-3 mb-3">
				<div className="flex-1 min-w-0">
					<div className="text-sm font-medium">Test notifications</div>
					<div className="text-xs text-muted-foreground leading-snug mt-0.5">
						Walks every path and reports which one (if any) fired.
					</div>
				</div>
				<button
					type="button"
					onClick={fire}
					disabled={pending}
					className={cn(
						"shrink-0 px-3 py-1.5 rounded-md text-xs font-medium",
						"bg-primary text-primary-foreground",
						"disabled:opacity-50",
					)}
				>
					{pending ? "Running…" : "Run"}
				</button>
			</div>

			{steps.length > 0 && (
				<ul className="space-y-1.5">
					{steps.map((s, i) => (
						<li key={i} className="flex items-start gap-2 text-[11px] leading-snug">
							<span
								className={cn(
									"shrink-0 mt-0.5 inline-block w-3 text-center",
									s.state === "ok" && "text-emerald-500",
									s.state === "fail" && "text-destructive",
									s.state === "warn" && "text-amber-500",
									s.state === "pending" && "text-muted-foreground",
									s.state === "info" && "text-muted-foreground",
								)}
								aria-hidden
							>
								{s.state === "ok" ? "✓"
									: s.state === "fail" ? "✗"
									: s.state === "warn" ? "!"
									: s.state === "info" ? "·"
									: "…"}
							</span>
							<span className="flex-1 min-w-0 break-words">
								<span className="font-medium">{s.label}:</span>{" "}
								<span className="text-muted-foreground">{s.detail}</span>
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

interface DebugStep {
	label: string;
	state: "ok" | "fail" | "warn" | "pending" | "info";
	detail: string;
}

/** Append OS-specific guidance — useful when every code path reports
 * "ok" but the user still sees nothing on screen.  That combo is
 * almost always an OS-level suppression we can't detect from JS. */
function pushPlatformHints(push: (s: DebugStep) => void): void {
	const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
	const isMac = /Mac OS X/.test(ua);
	const isWin = /Windows/.test(ua);
	const isLinux = !isMac && !isWin && /Linux/.test(ua);

	if (isMac) {
		push({
			label: "macOS check",
			state: "info",
			detail: "System Settings → Notifications → (your browser). Make sure 'Allow Notifications' is on AND a banner / alert style is selected. Focus / Do Not Disturb suppresses delivery silently.",
		});
	} else if (isWin) {
		push({
			label: "Windows check",
			state: "info",
			detail: "Settings → System → Notifications → ensure Notifications are on AND your browser is in the list with toggles enabled. Focus assist suppresses delivery silently.",
		});
	} else if (isLinux) {
		push({
			label: "Linux check",
			state: "info",
			detail: "GNOME / KDE both gate notifications per-app; check the desktop notification settings. Some Wayland sessions strip notifications from background tabs.",
		});
	}
	push({
		label: "Browser-level check",
		state: "info",
		detail: "Click the lock icon in the URL bar → Notifications → Allow. Even with site permission granted, a parent OS-level disable will silently swallow.",
	});
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

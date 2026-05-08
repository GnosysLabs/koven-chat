// Settings → Sessions tab.
//
// Lists every Matrix device on the user's account and offers a
// "Sign out all other sessions" button.  Synapse never auto-
// deactivates devices, and our email-code login flow creates a
// fresh device every sign-in — so a user who's gone through a
// few sign-out / sign-in cycles ends up with a half-dozen ghost
// devices.  Encrypted messages get fanned out to every active
// device the sender's client knows about; if the live device
// doesn't have the megolm session for one of the ghosts (and
// most won't), the recipient hits "couldn't decrypt this
// message" errors.  Cleaning the device list up front prevents
// that whole class of bug.
//
// Bulk-revoke uses Synapse's UIA-protected delete_devices
// endpoint.  The engine has already issued a fresh ephemeral
// password for this session and stashed it on the transport, so
// the modal doesn't need a password input — we just satisfy the
// challenge with the cached value.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { LogOut, Monitor, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MatrixTransport } from "@/lib/matrix";
import { fetchUiaPassword } from "@/lib/auth";

interface SessionRow {
	deviceId: string;
	displayName: string | null;
	lastSeenIp: string | null;
	lastSeenTs: number | null;
	isCurrent: boolean;
}

export interface SessionsSectionProps {
	accessToken: string;
	transport: MatrixTransport | null;
}

export function SessionsSection({ accessToken, transport }: SessionsSectionProps) {
	const [sessions, setSessions] = useState<SessionRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [revoking, setRevoking] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [reloadKey, setReloadKey] = useState(0);

	// Pull device list on mount + after every revoke.  Don't poll —
	// the list only changes from explicit gestures (this UI, or a
	// remote sign-out from another client), and a stale read of N
	// minutes is fine to fix with a manual refresh.
	useEffect(() => {
		if (!transport) return;
		let cancelled = false;
		setError(null);
		void transport.fetchSessions()
			.then(rows => {
				if (cancelled) return;
				// Sort: current device first, then most-recently-seen
				// last-active devices, then anything without a
				// last_seen_ts at the bottom.
				rows.sort((a, b) => {
					if (a.isCurrent && !b.isCurrent) return -1;
					if (b.isCurrent && !a.isCurrent) return 1;
					return (b.lastSeenTs ?? 0) - (a.lastSeenTs ?? 0);
				});
				setSessions(rows);
			})
			.catch(err => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
			});
		return () => { cancelled = true; };
	}, [transport, reloadKey]);

	const otherCount = sessions?.filter(s => !s.isCurrent).length ?? 0;

	async function doRevoke() {
		if (!transport) return;
		setRevoking(true);
		setError(null);
		try {
			// Engine-issued ephemeral UIA password — same pattern as
			// the deactivate-account flow.  Refreshes on every call
			// so a stale value from a long-idle session gets replaced
			// before we hand it to Synapse.
			const pw = await fetchUiaPassword(accessToken);
			transport.setUiaPassword(pw);
			await transport.revokeOtherSessions(pw);
			transport.setUiaPassword(null);
			setConfirming(false);
			setReloadKey(k => k + 1);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRevoking(false);
		}
	}

	return (
		<div className="space-y-6">
			<section className="space-y-3">
				<div>
					<div className="text-sm font-medium">Active sessions</div>
					<p className="text-xs text-muted-foreground leading-snug mt-0.5">
						Every browser, app, or device signed into your account. Encrypted messages are sent to all of them — clearing stale sessions reduces the chance of decryption failures and locks out anyone signed in elsewhere.
					</p>
				</div>

				{sessions === null ? (
					<div className="text-xs text-muted-foreground italic border border-border rounded px-3 py-3 bg-muted/30">
						Loading sessions…
					</div>
				) : sessions.length === 0 ? (
					<div className="text-xs text-muted-foreground italic border border-border rounded px-3 py-3 bg-muted/30">
						No sessions found.
					</div>
				) : (
					<ul className="space-y-1.5">
						{sessions.map(s => (
							<li
								key={s.deviceId}
								className={cn(
									"flex items-start justify-between gap-3 px-3 py-2 rounded-md border",
									s.isCurrent
										? "border-primary/40 bg-primary/5"
										: "border-border bg-muted/30",
								)}
							>
								<div className="flex items-start gap-2.5 min-w-0">
									<Monitor className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
									<div className="min-w-0">
										<div className="text-sm font-medium flex items-center gap-2 flex-wrap">
											{s.displayName || s.deviceId}
											{s.isCurrent && (
												<span className="text-[10px] uppercase tracking-wide text-primary bg-primary/15 px-1.5 py-0.5 rounded">
													This device
												</span>
											)}
										</div>
										<div className="text-xs text-muted-foreground leading-snug mt-0.5 font-mono">
											{s.deviceId}
										</div>
										{(s.lastSeenIp || s.lastSeenTs) && (
											<div className="text-xs text-muted-foreground leading-snug mt-0.5">
												{s.lastSeenIp && <span className="font-mono">{s.lastSeenIp}</span>}
												{s.lastSeenIp && s.lastSeenTs && " · "}
												{s.lastSeenTs && new Date(s.lastSeenTs).toLocaleString()}
											</div>
										)}
									</div>
								</div>
							</li>
						))}
					</ul>
				)}

				{error && (
					<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
						{error}
					</div>
				)}
			</section>

			{/* Bulk revoke.  Lives in its own section with a divider so
			    it doesn't read as part of the list above and the
			    destructive nature is upfront. */}
			<section className="space-y-3 pt-6 border-t border-border">
				<div>
					<div className="text-sm font-medium flex items-center gap-2">
						<ShieldAlert className="h-3.5 w-3.5 text-destructive" />
						Sign out of other sessions
					</div>
					<p className="text-xs text-muted-foreground leading-snug mt-0.5">
						Revokes every session except this one.
					</p>
				</div>

				{!confirming ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setConfirming(true)}
						disabled={!transport || otherCount === 0 || revoking}
						className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
					>
						<LogOut className="h-3.5 w-3.5 mr-1.5" />
						{otherCount === 0
							? "No other sessions to sign out"
							: `Sign out ${otherCount} other ${otherCount === 1 ? "session" : "sessions"}`}
					</Button>
				) : (
					<div className="space-y-2">
						<p className="text-xs text-foreground">
							This will end every session except this one. Anyone signed in elsewhere will be logged out and will need to sign in again.
						</p>
						<div className="flex gap-2">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => setConfirming(false)}
								disabled={revoking}
							>
								Cancel
							</Button>
							<Button
								type="button"
								variant="destructive"
								size="sm"
								onClick={doRevoke}
								disabled={revoking}
							>
								{revoking ? "Signing out…" : "Confirm sign-out"}
							</Button>
						</div>
					</div>
				)}
			</section>
		</div>
	);
}

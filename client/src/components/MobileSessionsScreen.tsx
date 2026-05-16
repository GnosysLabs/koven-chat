// MobileSessionsScreen — HIG sub-screen for the Matrix device list.
// Mirrors SessionsSection's data flow (fetch on mount, bulk-revoke
// via UIA password obtained through fetchUiaPassword) but rendered
// as a native grouped-inset list with the current device pinned
// first + a destructive "Sign Out Other Sessions" row at the
// bottom.
//
// Why not reuse SessionsSection?  The desktop component renders its
// own confirmation copy + button cluster inside a dialog-flavoured
// layout (small fonts, rounded muted boxes).  On mobile we want
// 17pt rows and a HIG destructive confirmation, so the styling
// diverges enough that re-implementing the ~80 lines of logic is
// cleaner than wrestling the desktop component into a different
// shape.

import { useEffect, useState } from "react";
import { Laptop, Smartphone, Tablet, Monitor as MonitorIcon } from "lucide-react";
import { fetchUiaPassword } from "@/lib/auth";
import { hapticImpact, hapticNotification, hapticSelection } from "@/lib/haptics";
import type { MatrixTransport } from "@/lib/matrix";
import { cn } from "@/lib/utils";
import {
	NavBar,
	NavBackButton,
	GroupLabel,
	GroupCard,
	GroupFooter,
	ErrorBanner,
} from "@/components/mobile/Chrome";

interface SessionRow {
	deviceId: string;
	displayName: string | null;
	lastSeenIp: string | null;
	lastSeenTs: number | null;
	isCurrent: boolean;
}

export interface MobileSessionsScreenProps {
	accessToken: string;
	transport: MatrixTransport | null;
	onBack(): void;
}

export function MobileSessionsScreen({
	accessToken,
	transport,
	onBack,
}: MobileSessionsScreenProps) {
	const [sessions, setSessions] = useState<SessionRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [revoking, setRevoking] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [reloadKey, setReloadKey] = useState(0);

	useEffect(() => {
		if (!transport) return;
		let cancelled = false;
		setError(null);
		void transport.fetchSessions()
			.then(rows => {
				if (cancelled) return;
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
		void hapticImpact("medium");
		setRevoking(true);
		setError(null);
		try {
			const pw = await fetchUiaPassword(accessToken);
			transport.setUiaPassword(pw);
			await transport.revokeOtherSessions(pw);
			transport.setUiaPassword(null);
			void hapticNotification("success");
			setConfirming(false);
			setReloadKey(k => k + 1);
		} catch (err) {
			void hapticNotification("error");
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRevoking(false);
		}
	}

	const currentSession = sessions?.find(s => s.isCurrent);
	const otherSessions = sessions?.filter(s => !s.isCurrent) ?? [];

	return (
		<div className="flex flex-col h-full">
			<NavBar
				left={<NavBackButton onClick={() => { void hapticSelection(); onBack(); }} />}
				title="Sessions"
			/>

			<div className="flex-1 overflow-y-auto pb-10">
				{sessions === null ? (
					<div className="flex items-center justify-center pt-24 text-[15px] text-muted-foreground">
						Loading sessions…
					</div>
				) : (
					<>
						{currentSession && (
							<>
								<GroupLabel>This Device</GroupLabel>
								<GroupCard>
									<SessionRowView session={currentSession} last />
								</GroupCard>
							</>
						)}

						{otherSessions.length > 0 && (
							<>
								<GroupLabel>Other Sessions</GroupLabel>
								<GroupCard>
									{otherSessions.map((s, idx) => (
										<SessionRowView
											key={s.deviceId}
											session={s}
											last={idx === otherSessions.length - 1}
										/>
									))}
								</GroupCard>
								<GroupFooter>
									Encrypted messages fan out to every signed-in device. Old or unrecognised sessions can cause "couldn't decrypt" errors and should be removed.
								</GroupFooter>
							</>
						)}

						<GroupLabel>Bulk Sign Out</GroupLabel>
						<GroupCard>
							{!confirming ? (
								<button
									type="button"
									onClick={() => {
										if (otherCount === 0) return;
										void hapticSelection();
										setConfirming(true);
									}}
									disabled={otherCount === 0 || revoking}
									className={cn(
										"w-full text-left px-4 min-h-[52px]",
										"text-[17px] font-medium",
										"transition-colors active:bg-foreground/5",
										otherCount === 0
											? "text-muted-foreground"
											: "text-destructive",
										"disabled:opacity-60",
									)}
								>
									{otherCount === 0
										? "No Other Sessions to Sign Out"
										: `Sign Out ${otherCount} Other ${otherCount === 1 ? "Session" : "Sessions"}`}
								</button>
							) : (
								<div className="px-4 py-3 space-y-3">
									<p className="text-[14px] leading-relaxed text-foreground">
										This will end every session except this one. Anyone signed in elsewhere will be logged out and need to sign in again.
									</p>
									<div className="flex gap-2 -mx-1">
										<button
											type="button"
											onClick={() => { void hapticSelection(); setConfirming(false); }}
											disabled={revoking}
											className="flex-1 h-10 rounded-[10px] bg-foreground/5 text-foreground text-[15px] font-medium active:bg-foreground/10 transition-colors"
										>
											Cancel
										</button>
										<button
											type="button"
											onClick={doRevoke}
											disabled={revoking}
											className="flex-1 h-10 rounded-[10px] bg-destructive text-destructive-foreground text-[15px] font-semibold active:opacity-80 transition-opacity disabled:opacity-60"
										>
											{revoking ? "Signing out…" : "Confirm Sign Out"}
										</button>
									</div>
								</div>
							)}
						</GroupCard>

						{error && <ErrorBanner message={error} />}
					</>
				)}
			</div>
		</div>
	);
}

function SessionRowView({ session, last }: { session: SessionRow; last: boolean }) {
	// Best-effort device icon — match common platform strings the
	// Matrix display_name carries.  Falls through to a generic
	// monitor for anything unrecognised.
	const name = (session.displayName ?? "").toLowerCase();
	const Icon = /iphone|android|mobile/.test(name)
		? Smartphone
		: /ipad|tablet/.test(name)
			? Tablet
			: /mac|windows|linux|firefox|chrome|safari|edge/.test(name)
				? Laptop
				: MonitorIcon;

	const lastSeen = session.lastSeenTs
		? new Date(session.lastSeenTs).toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		})
		: null;

	return (
		<div
			className={cn(
				"flex items-start gap-3 px-3 py-3 min-h-[64px]",
				!last && "border-b border-foreground/10",
			)}
		>
			<div className="shrink-0 mt-0.5 text-muted-foreground">
				<Icon className="h-[22px] w-[22px]" strokeWidth={1.9} />
			</div>
			<div className="flex-1 min-w-0">
				<div className="text-[17px] text-foreground truncate leading-tight">
					{session.displayName || session.deviceId}
				</div>
				<div className="text-[13px] text-muted-foreground font-mono truncate mt-0.5">
					{session.deviceId}
				</div>
				{(session.lastSeenIp || lastSeen) && (
					<div className="text-[13px] text-muted-foreground/80 truncate mt-0.5">
						{lastSeen}
						{lastSeen && session.lastSeenIp && " · "}
						{session.lastSeenIp && (
							<span className="font-mono">{session.lastSeenIp}</span>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

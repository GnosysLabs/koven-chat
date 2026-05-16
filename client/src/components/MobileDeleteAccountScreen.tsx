// MobileDeleteAccountScreen — HIG-styled destructive flow for
// permanent account deactivation.  Mirrors AccountSection's delete
// machine (idle → confirming → running) but rendered as a native
// push view with iOS confirmation patterns:
//   - Warning copy in a grouped card with each consequence on its
//     own row.
//   - Acknowledgement switch inline at the bottom of the warning
//     card (mirrors iOS "I understand…" toggles).
//   - Final action surfaced as a destructive (red-tinted) row that
//     stays disabled until the ack switch is on.
//   - "Only admin" gate replaces the entire flow with an amber
//     warning when the user is the lone instance admin.
//
// The delete flow itself is identical to desktop:
//   1. Engine purge (clears account-side rows, re-checks only-admin)
//   2. Fetch ephemeral UIA password
//   3. Deactivate Matrix account with erase=true

import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { fetchUiaPassword } from "@/lib/auth";
import { fetchAdminStatus, purgeMyEngineState } from "@/lib/instance";
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

export interface MobileDeleteAccountScreenProps {
	accessToken: string;
	transport: MatrixTransport | null;
	onBack(): void;
	// Fired after a successful deactivation so the parent can drop
	// credentials and route back to login.
	onSignedOut(): void;
}

export function MobileDeleteAccountScreen({
	accessToken,
	transport,
	onBack,
	onSignedOut,
}: MobileDeleteAccountScreenProps) {
	const [isOnlyAdmin, setIsOnlyAdmin] = useState<boolean | null>(null);
	const [ack, setAck] = useState(false);
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchAdminStatus(accessToken)
			.then(r => { if (!cancelled) setIsOnlyAdmin(!!r.is_only_admin); })
			.catch(() => { if (!cancelled) setIsOnlyAdmin(false); });
		return () => { cancelled = true; };
	}, [accessToken]);

	async function runDelete() {
		if (!transport) return;
		void hapticImpact("heavy");
		setRunning(true);
		setError(null);
		try {
			const purge = await purgeMyEngineState(accessToken);
			if (!purge.ok) {
				throw new Error(purge.error ?? "engine cleanup failed");
			}
			const uiaPassword = await fetchUiaPassword(accessToken);
			transport.setUiaPassword(uiaPassword);
			try {
				await transport.deactivateMyAccount(undefined, true);
			} finally {
				transport.setUiaPassword(null);
			}
			void hapticNotification("success");
			onSignedOut();
		} catch (err) {
			void hapticNotification("error");
			setError(err instanceof Error ? err.message : String(err));
			setRunning(false);
		}
	}

	return (
		<div className="flex flex-col h-full">
			<NavBar
				left={<NavBackButton onClick={() => { void hapticSelection(); onBack(); }} />}
				title="Delete Account"
			/>

			<div className="flex-1 overflow-y-auto pb-10">
				{isOnlyAdmin === null ? (
					/* Probe in flight — render nothing rather than
					   flashing the destructive flow before the gate
					   resolves. */
					<div className="flex items-center justify-center pt-24 text-[15px] text-muted-foreground">
						Checking permissions…
					</div>
				) : isOnlyAdmin ? (
					<>
						<div className="px-5 pt-7 pb-3 flex flex-col items-center gap-2.5">
							<div className="h-14 w-14 rounded-full bg-amber-500/15 flex items-center justify-center">
								<ShieldAlert className="h-7 w-7 text-amber-500" strokeWidth={2.1} />
							</div>
							<h2 className="text-[22px] font-semibold text-foreground tracking-[-0.01em]">
								You're the Only Admin
							</h2>
						</div>
						<GroupCard className="bg-amber-500/10 border-amber-500/30">
							<div className="px-4 py-3 text-[15px] leading-relaxed text-foreground">
								Promote another admin before deleting your account, or report review on this instance will become impossible.
							</div>
						</GroupCard>
					</>
				) : (
					<>
						{/* Hero — destructive intent communicated in
						    the iconography rather than buried in
						    copy.  Matches iOS' pattern for irreversible
						    actions (e.g. "Erase All Content & Settings"). */}
						<div className="px-5 pt-7 pb-3 flex flex-col items-center gap-2.5">
							<div className="h-14 w-14 rounded-full bg-destructive/15 flex items-center justify-center">
								<ShieldAlert className="h-7 w-7 text-destructive" strokeWidth={2.1} />
							</div>
							<h2 className="text-[22px] font-semibold text-foreground tracking-[-0.01em] text-center">
								Permanent Deletion
							</h2>
							<p className="text-[15px] text-muted-foreground text-center px-2 leading-snug max-w-[320px]">
								Deactivates your account on the homeserver and erases the contents of every message you've sent. This cannot be undone.
							</p>
						</div>

						<GroupLabel>What Happens</GroupLabel>
						<GroupCard>
							<Consequence text="Your username is permanently retired." />
							<Consequence text="The contents of every message you've sent are erased on the homeserver." />
							<Consequence text="Direct conversations on your side disappear; the other party retains their copy." />
							<Consequence text="Reports you submitted stay in the audit log." last />
						</GroupCard>

						<GroupLabel>Confirmation</GroupLabel>
						<GroupCard>
							<div className="flex items-center gap-3 px-4 py-3 min-h-[52px]">
								<div className="flex-1 min-w-0 text-[15px] leading-snug text-foreground">
									I understand this is permanent and cannot be reversed.
								</div>
								<Switch
									checked={ack}
									onCheckedChange={(v) => { void hapticSelection(); setAck(v); }}
									disabled={running}
								/>
							</div>
						</GroupCard>

						<div className="mx-4 mt-6">
							<button
								type="button"
								onClick={runDelete}
								disabled={!ack || running}
								className={cn(
									"w-full h-12 rounded-[14px] flex items-center justify-center gap-2",
									"text-[17px] font-semibold",
									"bg-destructive text-destructive-foreground",
									"active:opacity-80 transition-opacity",
									"disabled:opacity-40",
								)}
							>
								{running ? "Deactivating…" : "Permanently Delete Account"}
							</button>
						</div>

						<GroupFooter>
							Your homeserver will receive an erase request via the Matrix deactivate flow. Federated copies of your messages on other servers will be requested for redaction but may persist.
						</GroupFooter>

						{error && <ErrorBanner message={error} />}
					</>
				)}
			</div>
		</div>
	);
}

function Consequence({ text, last }: { text: string; last?: boolean }) {
	return (
		<div
			className={cn(
				"flex items-start gap-2.5 px-4 py-2.5 min-h-[44px]",
				!last && "border-b border-foreground/10",
			)}
		>
			<span className="shrink-0 mt-2 h-1.5 w-1.5 rounded-full bg-destructive" />
			<span className="text-[15px] leading-relaxed text-foreground">{text}</span>
		</div>
	);
}

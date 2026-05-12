// Admin reports queue.  Replaces the old consensus-era floor-review
// sheet.  Lists member-submitted flags (from the `flags` table on the
// engine) so instance admins can triage them by hand — there's no
// vote / collapse / suspension pipeline anymore, just standard Matrix
// moderation primitives.
//
// Each row shows reporter + category + rationale + target (message
// id or room id) plus two actions:
//
//   - Mark resolved  → POST /api/admin/reports/:id/action
//   - Dismiss        → POST /api/admin/reports/:id/dismiss
//
// The admin already performed the underlying mutation (kick / ban /
// redact / role change) via the room's member list or message
// toolbar; closing a report here is purely the triage side.

import { useEffect, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	fetchAdminReports,
	dismissReport,
	markReportActioned,
	type AdminReport,
} from "@/lib/instance";
import { Flag, ExternalLink, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AdminReportsSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	accessToken: string;
	// "Open in room" — wired to App's navigateToRoom + scroll-to-event
	// plumbing.  When the report targets a message we pass the event
	// id too so the sheet caller can jump straight to it.  Optional:
	// when omitted the row just doesn't surface the link.
	onOpenTarget?(roomId: string, eventId?: string): void;
	// Notify the parent that the open-count may have changed (after a
	// successful dismiss / action).  Parent re-polls or decrements its
	// cached badge.  Optional.
	onCountChanged?(openCount: number): void;
}

export function AdminReportsSheet({
	open, onOpenChange, accessToken, onOpenTarget, onCountChanged,
}: AdminReportsSheetProps) {
	const [reports, setReports] = useState<AdminReport[] | null>(null);
	const [busyId, setBusyId] = useState<number | null>(null);
	// Local "filter to open only" toggle.  Default true — admins
	// almost always want the queue (the closed-set view is occasional
	// auditing).  Cheap client-side filter; engine returns the full
	// set in one shot.
	const [showOpenOnly, setShowOpenOnly] = useState(true);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setReports(null);
		fetchAdminReports(accessToken).then(list => {
			if (!cancelled) setReports(list);
		});
		return () => { cancelled = true; };
	}, [open, accessToken]);

	async function applyStatus(id: number, kind: "dismiss" | "action") {
		if (busyId) return;
		setBusyId(id);
		try {
			if (kind === "dismiss") await dismissReport(accessToken, id);
			else await markReportActioned(accessToken, id);
			// Local optimistic update — flip the row's status so the
			// "show open only" filter immediately hides it without a
			// full refetch.
			setReports(prev => prev?.map(r =>
				r.id === id
					? { ...r, status: kind === "dismiss" ? "dismissed" : "actioned" }
					: r,
			) ?? prev);
			const remaining = (reports ?? []).filter(r => r.id !== id && r.status === "open").length;
			onCountChanged?.(remaining);
		} catch (err) {
			console.warn("admin reports: applyStatus failed", err);
		} finally {
			setBusyId(null);
		}
	}

	const visible = (reports ?? []).filter(r => !showOpenOnly || r.status === "open");
	const openCount = (reports ?? []).filter(r => r.status === "open").length;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
				<DialogHeader>
					<DialogTitle>Admin reports</DialogTitle>
					<DialogDescription>
						Member-submitted reports awaiting admin triage.  Use the
						room member list or message toolbar to kick / ban /
						redact, then mark the report resolved here.
					</DialogDescription>
				</DialogHeader>

				<div className="flex items-center justify-between text-xs text-muted-foreground py-1">
					<span>
						{openCount} open
						{reports && reports.length > openCount && (
							<> · {reports.length - openCount} closed</>
						)}
					</span>
					<label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
						<input
							type="checkbox"
							checked={showOpenOnly}
							onChange={(e) => setShowOpenOnly(e.target.checked)}
							className="h-3 w-3"
						/>
						Open only
					</label>
				</div>

				<div className="flex-1 overflow-y-auto -mx-6 px-6">
					{reports === null ? null : visible.length === 0 ? (
						<div className="text-sm text-muted-foreground italic py-6 text-center border border-dashed border-border rounded">
							{showOpenOnly
								? "No open reports.  Nice."
								: "No reports recorded yet."}
						</div>
					) : (
						<ol className="space-y-2">
							{visible.map(r => (
								<ReportRow
									key={r.id}
									r={r}
									busy={busyId === r.id}
									onDismiss={() => applyStatus(r.id, "dismiss")}
									onAction={() => applyStatus(r.id, "action")}
									onOpenTarget={onOpenTarget}
								/>
							))}
						</ol>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function ReportRow({
	r, busy, onDismiss, onAction, onOpenTarget,
}: {
	r: AdminReport;
	busy: boolean;
	onDismiss(): void;
	onAction(): void;
	onOpenTarget?(roomId: string, eventId?: string): void;
}) {
	const time = new Date(r.created_at).toLocaleString();
	const isClosed = r.status !== "open";
	return (
		<li className={cn(
			"px-3 py-2 rounded border border-border bg-card/50",
			isClosed && "opacity-60",
		)}>
			<div className="flex items-start gap-3">
				<Flag className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
				<div className="flex-1 min-w-0 text-xs leading-snug">
					<div className="flex items-center gap-2 flex-wrap">
						<span className="font-medium">{labelForCategory(r.category)}</span>
						<span className="text-muted-foreground">
							{r.target_kind === "room" ? "room report" : "message report"}
						</span>
						{r.status !== "open" && (
							<span className={cn(
								"uppercase tracking-wide text-[9px] font-medium px-1 py-px rounded",
								r.status === "actioned"
									? "bg-emerald-500/20 text-emerald-500"
									: "bg-muted text-muted-foreground",
							)}>
								{r.status}
							</span>
						)}
					</div>
					<div className="mt-1 text-muted-foreground">
						<span>Reporter: </span>
						<span className="font-medium text-foreground">{r.flagger}</span>
					</div>
					{r.rationale && (
						<div className="mt-1 italic text-muted-foreground">"{r.rationale}"</div>
					)}
					<div className="mt-1 text-muted-foreground font-mono text-[10px] break-all">
						{r.target_kind === "room"
							? <>Room: {r.target_room_id ?? r.room_id}</>
							: <>Room: {r.room_id} · Event: {r.target_event_id ?? "?"}</>}
					</div>
					<div className="text-[10px] text-muted-foreground/70 mt-1 tabular-nums">{time}</div>

					<div className="mt-2 flex items-center gap-2 flex-wrap">
						{onOpenTarget && (
							<button
								type="button"
								onClick={() => {
									const eventId = r.target_kind === "message" ? r.target_event_id ?? undefined : undefined;
									const roomId = r.target_kind === "room"
										? (r.target_room_id ?? r.room_id)
										: r.room_id;
									onOpenTarget(roomId, eventId);
								}}
								className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-card hover:bg-accent text-[11px]"
							>
								<ExternalLink className="h-3 w-3" />
								Open in room
							</button>
						)}
						{!isClosed && (
							<>
								<button
									type="button"
									disabled={busy}
									onClick={onAction}
									className="inline-flex items-center gap-1 px-2 py-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 text-[11px] disabled:opacity-50"
								>
									<Check className="h-3 w-3" />
									{busy ? "Marking…" : "Mark resolved"}
								</button>
								<button
									type="button"
									disabled={busy}
									onClick={onDismiss}
									className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-card hover:bg-accent text-[11px] disabled:opacity-50"
								>
									<X className="h-3 w-3" />
									{busy ? "Dismissing…" : "Dismiss"}
								</button>
							</>
						)}
					</div>
				</div>
			</div>
		</li>
	);
}

function labelForCategory(c: string): string {
	switch (c) {
		case "off_topic":       return "Off-topic";
		case "spam":            return "Spam";
		case "harassment":      return "Harassment";
		case "misinformation":  return "Misinformation";
		case "floor_violation": return "Serious violation";
		default:                return c;
	}
}

// Reports queue.  Lists member-submitted flags (from the `flags`
// table on the engine) for the people empowered to act on them.
// The visibility rule is two-path (enforced server-side; this UI
// just renders what the engine returns):
//
//   - space-mod path: viewers with PL ≥ 50 in the reported room see
//     reports for that room.
//   - instance-floor backstop: server admins additionally see
//     `floor_violation` reports across every space (their legal duty
//     for CSAM / credible threats / doxxing, even when the report is
//     in a space they don't moderate).
//
// Each row shows reporter + category + rationale + target (message
// id or room id) plus a routing pill telling the viewer WHY they're
// seeing it — either the space's name (mod path) or a "FLOOR ·
// instance" badge (floor backstop).  Two actions per row:
//
//   - Mark resolved  → POST /api/admin/reports/:id/action
//   - Dismiss        → POST /api/admin/reports/:id/dismiss
//
// The actor already performed the underlying mutation (kick / ban /
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
import { Flag, ExternalLink, Check, X, AlertTriangle, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Room, Space } from "@koven/shared";

export interface AdminReportsSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	accessToken: string;
	// Local rooms + spaces — used to render the per-row routing pill.
	// If the report's room is one the viewer has PL ≥ 50 in, the pill
	// names that room's space; otherwise the row is only visible via
	// the floor backstop and the pill reads "FLOOR · instance".
	rooms: Room[];
	spaces: Space[];
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
	open, onOpenChange, accessToken, rooms, spaces, onOpenTarget, onCountChanged,
}: AdminReportsSheetProps) {
	const [reports, setReports] = useState<AdminReport[] | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
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

	async function applyStatus(eventId: string, kind: "dismiss" | "action") {
		if (busyId) return;
		setBusyId(eventId);
		try {
			if (kind === "dismiss") await dismissReport(accessToken, eventId);
			else await markReportActioned(accessToken, eventId);
			// Local optimistic update — flip the row's status so the
			// "show open only" filter immediately hides it without a
			// full refetch.
			setReports(prev => prev?.map(r =>
				r.event_id === eventId
					? { ...r, status: kind === "dismiss" ? "dismissed" : "actioned" }
					: r,
			) ?? prev);
			const remaining = (reports ?? []).filter(r => r.event_id !== eventId && r.status === "open").length;
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
					<DialogTitle>Reports</DialogTitle>
					<DialogDescription>
						Reports about content in spaces you moderate, plus
						floor-violation reports across the instance if you're
						a server admin.  Use the room member list or message
						toolbar to kick / ban / redact, then mark the report
						resolved here.
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
									key={r.event_id}
									r={r}
									busy={busyId === r.event_id}
									rooms={rooms}
									spaces={spaces}
									onDismiss={() => applyStatus(r.event_id, "dismiss")}
									onAction={() => applyStatus(r.event_id, "action")}
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
	r, busy, rooms, spaces, onDismiss, onAction, onOpenTarget,
}: {
	r: AdminReport;
	busy: boolean;
	rooms: Room[];
	spaces: Space[];
	onDismiss(): void;
	onAction(): void;
	onOpenTarget?(roomId: string, eventId?: string): void;
}) {
	const time = new Date(r.created_at).toLocaleString();
	const isClosed = r.status !== "open";
	// Routing pill — why is this report visible to the viewer?
	//
	// We can't observe the engine's filter decision directly, but the
	// rules are: (1) viewer has PL ≥ 50 in the reported room → space
	// mod path; (2) viewer is server admin AND category=floor_violation
	// → floor backstop.  When the room is in our local roster AND we
	// hold PL ≥ 50 there, this is (1); otherwise the only remaining
	// way the engine could have returned this row is (2).  No need to
	// know server-admin status — the engine wouldn't have returned a
	// non-floor row to us unless we're PL 50+ in that room (which we
	// also wouldn't have if the room weren't in our roster).
	const reportedRoomId = r.target_kind === "room"
		? (r.target_room_id ?? r.room_id)
		: r.room_id;
	const room = rooms.find(rr => rr.id === reportedRoomId);
	const viewerPl = room?.myPowerLevel ?? 0;
	const isSpaceModPath = viewerPl >= 50;
	// Find the parent space's name for the space-mod label.  Koven's
	// invariant is one parent space per room, so parentSpaceIds[0] is
	// the right pointer when the room IS a child of a space.  When
	// the reported "room" IS a space itself (target_kind="room" on
	// a space), fall back to looking up the space by its own id.
	let spaceLabel: string | undefined;
	if (isSpaceModPath && room) {
		const parentId = room.parentSpaceIds[0];
		if (parentId) {
			spaceLabel = spaces.find(s => s.id === parentId)?.name;
		} else {
			// Could be a flagged space itself — its id IS a space id.
			spaceLabel = spaces.find(s => s.id === room.id)?.name;
		}
	}
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
						{isSpaceModPath ? (
							<span
								title="You see this report because you have PL ≥ 50 in the reported room"
								className="inline-flex items-center gap-1 uppercase tracking-wide text-[9px] font-medium px-1.5 py-px rounded bg-amber-500/15 text-amber-500"
							>
								<Shield className="h-2.5 w-2.5" />
								{spaceLabel ?? "your space"}
							</span>
						) : (
							<span
								title="You see this report because you're a server admin and it's a floor-violation report"
								className="inline-flex items-center gap-1 uppercase tracking-wide text-[9px] font-medium px-1.5 py-px rounded bg-destructive/15 text-destructive"
							>
								<AlertTriangle className="h-2.5 w-2.5" />
								Floor · instance
							</span>
						)}
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

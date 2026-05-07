// Admin-only "Pending review" surface in Settings → Instance.  Lists
// suspensions waiting for admin action: floor-violation reports filed
// against a user's content, plus auto-suspensions of repeat false
// flaggers (the engine creates those once a flagger crosses the
// 2-in-30-days or 3-ever reversal threshold).
//
// Two actions per case:
//   - Confirm: the engine calls Synapse's deactivate admin API, which
//     permanently bans the account.  Suspension row marked "confirmed".
//   - Reverse: suspension lifts, the wrongly-accused user can post
//     again.  If the originating flagger has now crossed the false-
//     flag threshold via this reversal, the engine cascades and
//     auto-suspends them too — they show up in this same list on the
//     next refresh.
//
// We don't try to surface message content in-line — the engine
// doesn't have it (encrypted DMs are invisible; even non-encrypted
// message bodies aren't indexed by the engine).  The admin clicks
// through to the room to read context if they need it.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { fetchFloorQueue, reviewFloorCase, type FloorReviewAction, type PendingSuspension } from "@/lib/instance";
import type { MatrixTransport } from "@/lib/matrix";
import { ExternalLink, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FloorReviewSectionProps {
	accessToken: string;
	transport: MatrixTransport | null;
	// Fires after every successful confirm/reverse so the parent can
	// refresh any out-of-band derived state (the shield badge in the
	// SpaceBar tracks queue length and needs to drop the dot when
	// the last case is cleared).  Optional; safe to omit.
	onQueueChanged?(): void;
}

export function FloorReviewSection({ accessToken, transport: _transport, onQueueChanged }: FloorReviewSectionProps) {
	const [queue, setQueue] = useState<PendingSuspension[] | null>(null);
	const [busy, setBusy] = useState<number | null>(null);    // suspension id currently being acted on
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	// Per-case admin note input.  Keyed by suspension id; reset after
	// either action succeeds.
	const [notes, setNotes] = useState<Record<number, string>>({});

	async function refresh() {
		const list = await fetchFloorQueue(accessToken);
		setQueue(list);
	}

	useEffect(() => {
		let cancelled = false;
		fetchFloorQueue(accessToken).then(list => {
			if (!cancelled) setQueue(list);
		});
		return () => { cancelled = true; };
	}, [accessToken]);

	async function act(id: number, action: FloorReviewAction) {
		setBusy(id);
		setError(null);
		setInfo(null);
		const note = notes[id]?.trim() || undefined;
		const r = await reviewFloorCase(accessToken, id, action, note);
		setBusy(null);
		if (!r.ok) {
			setError(r.error ?? "Action failed.");
			return;
		}
		// Clear this case's note.
		setNotes(prev => {
			const next = { ...prev };
			delete next[id];
			return next;
		});
		if (action === "confirm") {
			setInfo(r.deactivated
				? "Account confirmed banned and deactivated on the homeserver."
				: "Suspension confirmed locally, but Synapse deactivate failed — check engine logs.");
		} else if (action === "reverse") {
			setInfo(r.autoSuspendedFlagger
				? "Marked as a false report. The flagger has crossed the false-flag threshold and is now auto-suspended pending review."
				: "Marked as a false report. The reported user has been restored; the flagger is penalized.");
		} else {
			// dismiss
			setInfo("Dismissed in good faith. The reported user is restored; no penalty for the flagger.");
		}
		await refresh();
		onQueueChanged?.();
	}

	if (queue === null) {
		return <div className="text-sm text-muted-foreground">Loading review queue…</div>;
	}

	return (
		<section className="space-y-4">
			<div>
				<p className="text-xs text-muted-foreground leading-snug">
					Suspensions awaiting admin action. <strong className="text-foreground">Confirm</strong> permanently deactivates the reported account. <strong className="text-foreground">Dismiss</strong> restores the account with no penalty for either side — use when the report was a good-faith mistake. <strong className="text-foreground">Mark as false report</strong> restores the account and penalizes the flagger; if they cross the false-flag threshold (2 in 30 days, 3 ever) they're auto-suspended pending review. The mod log records which action you chose.
				</p>
			</div>

			{error && (
				<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
					{error}
				</div>
			)}
			{info && !error && (
				<div className="text-xs text-emerald-500/90 border border-emerald-500/30 bg-emerald-500/5 rounded px-3 py-2">
					{info}
				</div>
			)}

			{queue.length === 0 ? (
				<div className="text-sm text-muted-foreground italic py-6 text-center border border-dashed border-border rounded">
					Nothing pending. The queue is clear.
				</div>
			) : (
				<ul className="space-y-3">
					{queue.map(c => (
						<CaseCard
							key={c.id}
							c={c}
							busy={busy === c.id}
							note={notes[c.id] ?? ""}
							onNoteChange={(v) => setNotes(prev => ({ ...prev, [c.id]: v }))}
							onConfirm={() => act(c.id, "confirm")}
							onDismiss={() => act(c.id, "dismiss")}
							onReverse={() => act(c.id, "reverse")}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

function CaseCard({
	c, busy, note, onNoteChange, onConfirm, onDismiss, onReverse,
}: {
	c: PendingSuspension;
	busy: boolean;
	note: string;
	onNoteChange(v: string): void;
	onConfirm(): void;
	onDismiss(): void;
	onReverse(): void;
}) {
	const isFloor = c.reason === "floor_violation";
	const created = new Date(c.created_at);
	const headlineLabel =
		c.reason === "floor_violation" ? "Floor-violation report"
		: c.reason === "repeated_room_collapses" ? "Repeat room collapses"
		: "Repeat false flagger";

	return (
		<li className="border border-border rounded-md p-3 space-y-2 bg-card">
			<div className="flex items-start gap-3">
				<div className="shrink-0 mt-0.5">
					<ShieldAlert className={cn(
						"h-4 w-4",
						isFloor ? "text-destructive" : "text-amber-500",
					)} />
				</div>
				<div className="flex-1 min-w-0">
					<div className="text-sm font-medium">
						{headlineLabel}
					</div>
					<div className="text-[10px] text-muted-foreground tabular-nums">
						Filed {created.toLocaleString()}
					</div>
				</div>
			</div>

			<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs items-center pl-7">
				<span className="text-muted-foreground">Suspended:</span>
				<UserPill userId={c.user_id} />
				{isFloor && c.flagger && (
					<>
						<span className="text-muted-foreground">Flagged by:</span>
						<UserPill userId={c.flagger} />
					</>
				)}
				{c.target_room_id && (
					<>
						<span className="text-muted-foreground">Room:</span>
						<span className="font-mono text-[10px] truncate">{c.target_room_id}</span>
					</>
				)}
				{c.target_event_id && (
					<>
						<span className="text-muted-foreground">Message:</span>
						<a
							href={`https://matrix.to/#/${c.target_room_id ?? ""}/${c.target_event_id}`}
							target="_blank"
							rel="noopener noreferrer"
							className="font-mono text-[10px] truncate text-primary hover:underline inline-flex items-center gap-1"
						>
							{c.target_event_id} <ExternalLink className="h-3 w-3 shrink-0" />
						</a>
					</>
				)}
			</div>

			<div className="pl-7 space-y-1.5">
				<input
					type="text"
					value={note}
					onChange={(e) => onNoteChange(e.target.value)}
					placeholder="Optional note (e.g. why you confirmed or reversed)"
					maxLength={500}
					disabled={busy}
					className="flex h-8 w-full rounded-md border border-input bg-transparent px-3 py-1 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
				/>
				<div className="flex gap-2 justify-end flex-wrap">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={onDismiss}
						disabled={busy}
						title="Lift the suspension. Use when the report was a good-faith mistake — flagger is not penalized."
					>
						Dismiss
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={onReverse}
						disabled={busy}
						title="Lift the suspension AND penalize the flagger. Use when the report appears malicious or weaponized."
						className="border-amber-500/50 text-amber-500 hover:bg-amber-500/10 hover:text-amber-500"
					>
						Mark as false report
					</Button>
					<Button
						type="button"
						size="sm"
						onClick={onConfirm}
						disabled={busy}
						className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
					>
						{busy ? "Working…" : "Confirm ban"}
					</Button>
				</div>
			</div>
		</li>
	);
}

function UserPill({ userId }: { userId: string }) {
	return (
		<span className="inline-flex items-center gap-1.5 min-w-0">
			<MatrixAvatar
				seed={userId}
				className="h-4 w-4"
			/>
			<span className="font-mono text-[10px] truncate">{userId}</span>
		</span>
	);
}

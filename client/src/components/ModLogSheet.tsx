// Per-room public mod log.  Shown from a button in the ChatPane
// header.  Reads /api/rooms/:id/mod-log on open and renders the
// merged chronological feed of:
//
//   - flags (every flag submitted in this room: who flagged whom,
//     under what category, when)
//   - collapses (every message that crossed the consensus threshold
//     and got hidden)
//   - suspensions (floor-violation suspensions filed in this room,
//     with their current status)
//
// Public read by design.  The whole governance philosophy depends on
// the audit trail being inspectable by anyone in the community: the
// only check on collective moderation power is sunlight.

import { useEffect, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { fetchRoomModLog, type ModLogEntry } from "@/lib/instance";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { Flag, Hammer, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ModLogSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	roomId: string;
}

export function ModLogSheet({ open, onOpenChange, roomId }: ModLogSheetProps) {
	const [entries, setEntries] = useState<ModLogEntry[] | null>(null);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setEntries(null);
		fetchRoomModLog(roomId).then(list => {
			if (!cancelled) setEntries(list);
		});
		return () => { cancelled = true; };
	}, [open, roomId]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
				<DialogHeader>
					<DialogTitle>Mod log</DialogTitle>
					<DialogDescription>
						Public, append-only record of every flag, collapse, and suspension that's happened in this room.
					</DialogDescription>
				</DialogHeader>

				<div className="flex-1 overflow-y-auto -mx-6 px-6">
					{entries === null ? (
						<div className="text-sm text-muted-foreground py-6 text-center">Loading…</div>
					) : entries.length === 0 ? (
						<div className="text-sm text-muted-foreground italic py-6 text-center border border-dashed border-border rounded">
							No moderation events recorded in this room yet.
						</div>
					) : (
						<ol className="space-y-2">
							{entries.map((e, i) => <Entry key={i} e={e} />)}
						</ol>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function Entry({ e }: { e: ModLogEntry }) {
	const time = new Date(e.ts).toLocaleString();

	if (e.kind === "flag") {
		return (
			<li className="flex items-start gap-3 px-3 py-2 rounded border border-border bg-card/50">
				<Flag className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
				<div className="flex-1 min-w-0 text-xs leading-snug">
					<div>
						<span className="font-medium">Flag</span>
						<span className="text-muted-foreground"> · {labelForCategory(e.category)}</span>
					</div>
					<div className="flex items-center gap-1 mt-0.5">
						<span className="text-muted-foreground">By</span>
						<UserInline userId={e.flagger} />
					</div>
					{e.rationale && (
						<div className="text-muted-foreground mt-1 italic">"{e.rationale}"</div>
					)}
					<div className="text-[10px] text-muted-foreground/70 mt-1 tabular-nums">{time}</div>
				</div>
			</li>
		);
	}

	if (e.kind === "collapse") {
		return (
			<li className="flex items-start gap-3 px-3 py-2 rounded border border-border bg-amber-500/5">
				<Hammer className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
				<div className="flex-1 min-w-0 text-xs leading-snug">
					<div className="font-medium">Message collapsed</div>
					<div className="text-muted-foreground mt-0.5">
						{e.flagger_count} flagger{e.flagger_count === 1 ? "" : "s"}, weighted score {e.weighted_score.toFixed(2)}
					</div>
					<div className="text-muted-foreground">
						Categories: {e.categories.map(labelForCategory).join(", ")}
					</div>
					<div className="text-[10px] text-muted-foreground/70 mt-1 tabular-nums">{time}</div>
				</div>
			</li>
		);
	}

	// suspension
	const statusColor =
		e.status === "confirmed" ? "text-destructive"
		: e.status === "reversed"  ? "text-muted-foreground line-through"
		: "text-amber-500";
	const reasonLabel = e.reason === "floor_violation"
		? "Floor-violation suspension"
		: "Repeat-false-flagger suspension";
	return (
		<li className="flex items-start gap-3 px-3 py-2 rounded border border-destructive/30 bg-destructive/5">
			<ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-destructive" />
			<div className="flex-1 min-w-0 text-xs leading-snug">
				<div className="font-medium">{reasonLabel}</div>
				<div className={cn("mt-0.5", statusColor)}>Status: {e.status}</div>
				<div className="flex items-center gap-1 mt-0.5">
					<span className="text-muted-foreground">Suspended:</span>
					<UserInline userId={e.user_id} />
				</div>
				{e.flagger && (
					<div className="flex items-center gap-1 mt-0.5">
						<span className="text-muted-foreground">Filed by:</span>
						<UserInline userId={e.flagger} />
					</div>
				)}
				{e.reviewed_at && e.reviewed_by && (
					<div className="flex items-center gap-1 mt-0.5">
						<span className="text-muted-foreground">Reviewed by:</span>
						<UserInline userId={e.reviewed_by} />
						<span className="text-muted-foreground/70 ml-1">at {new Date(e.reviewed_at).toLocaleString()}</span>
					</div>
				)}
				<div className="text-[10px] text-muted-foreground/70 mt-1 tabular-nums">Filed {time}</div>
			</div>
		</li>
	);
}

function UserInline({ userId }: { userId: string }) {
	return (
		<span className="inline-flex items-center gap-1 min-w-0">
			<MatrixAvatar seed={userId} className="h-4 w-4" />
			<span className="font-mono text-[10px] truncate">{userId}</span>
		</span>
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

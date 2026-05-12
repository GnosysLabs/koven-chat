// Per-room public mod log.  Shown from a button in the ChatPane
// header.  Reads /api/rooms/:id/mod-log on open and renders the
// merged chronological feed of every recorded admin / self action:
//
//   - flags (every report submitted in this room: who reported what,
//     under what category, when)
//   - self-deletions (sender redacted their own message, or a bot
//     owner redacted the bot's)
//   - bot-membership actions (founder kicked / banned a bot)
//
// Public read by design — the audit trail is inspectable by anyone
// in the community.

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
import { Ban, Flag, FlagOff, Trash2, UserX } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MatrixTransport } from "@/lib/matrix";
import { useResolvedUser } from "@/lib/useResolvedUser";
import { createContext, useContext } from "react";

// Threading the transport through every UserInline call site by hand
// would be noisy.  Lifting it into a context lets every nested
// `useResolvedUser` hook find it without prop drilling.  Set once at
// the sheet root.
const TransportContext = createContext<MatrixTransport | null>(null);

export interface ModLogSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	roomId: string;
	/** Drives display-name + avatar resolution for every user
	 * referenced in the log.  Optional — without it the sheet
	 * still renders, just falls back to the bare localpart. */
	transport?: MatrixTransport | null;
}

export function ModLogSheet({ open, onOpenChange, roomId, transport }: ModLogSheetProps) {
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

	// Don't pop the Dialog open until the mod-log fetch lands.  The
	// older "open immediately, show Loading… inside" path produced
	// a jarring two-frame transition: the empty sheet sliding in
	// from the bottom with a placeholder, then the body filling in.
	// Latching `hasMounted` ON after the first ready means a fast
	// scroll-jiggle inside the sheet doesn't flicker the visibility
	// while React is still committing renders.  Matches the
	// ProfileSheet gating pattern.
	const ready = entries !== null;
	const [hasMounted, setHasMounted] = useState(false);
	useEffect(() => {
		if (!open) {
			setHasMounted(false);
		} else if (ready && !hasMounted) {
			setHasMounted(true);
		}
	}, [open, ready, hasMounted]);
	const dialogOpen = open && (ready || hasMounted);

	return (
		<Dialog open={dialogOpen} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
				<DialogHeader>
					<DialogTitle>Mod log</DialogTitle>
					<DialogDescription>
						Public, append-only record of moderation activity in this room — reports, self-deletions, and bot kicks/bans.
					</DialogDescription>
				</DialogHeader>

				<TransportContext.Provider value={transport ?? null}>
					<div className="flex-1 overflow-y-auto -mx-6 px-6">
						{entries === null ? null : entries.length === 0 ? (
							<div className="text-sm text-muted-foreground italic py-6 text-center border border-dashed border-border rounded">
								No moderation events recorded in this room yet.
							</div>
						) : (
							<ol className="space-y-2">
								{entries.map((e, i) => <Entry key={i} e={e} />)}
							</ol>
						)}
					</div>
				</TransportContext.Provider>
			</DialogContent>
		</Dialog>
	);
}

function Entry({ e }: { e: ModLogEntry }) {
	const time = new Date(e.ts).toLocaleString();

	if (e.kind === "flag") {
		// A retracted flag stays in the timeline (the log is
		// append-only) but reads as historical: dimmed, strike-
		// throughed, with a small "retracted" tag.  The actual
		// retraction event is rendered as its own `flag_retracted`
		// entry elsewhere in the feed.
		return (
			<li className={cn(
				"flex items-start gap-3 px-3 py-2 rounded border border-border bg-card/50",
				e.retracted && "opacity-60",
			)}>
				<Flag className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
				<div className="flex-1 min-w-0 text-xs leading-snug">
					<div className={cn(e.retracted && "line-through")}>
						<span className="font-medium">Flag</span>
						<span className="text-muted-foreground"> · {labelForCategory(e.category)}</span>
					</div>
					<div className="flex items-center gap-1 mt-0.5">
						<span className="text-muted-foreground">By</span>
						<UserInline userId={e.flagger} />
					</div>
					{e.rationale && (
						<div className={cn(
							"text-muted-foreground mt-1 italic",
							e.retracted && "line-through",
						)}>"{e.rationale}"</div>
					)}
					<div className="text-[10px] text-muted-foreground/70 mt-1 tabular-nums flex items-center gap-2">
						<span>{time}</span>
						{e.retracted && (
							<span className="uppercase tracking-wide text-[9px] font-medium bg-muted px-1 py-px rounded">
								Retracted
							</span>
						)}
					</div>
				</div>
			</li>
		);
	}

	if (e.kind === "flag_retracted") {
		// Sibling event to the original flag — the moment the
		// flagger withdrew it.  Same width / rhythm as a flag entry
		// so the timeline stays visually balanced; the FlagOff icon
		// + "Flag retracted" header carries the meaning.
		const sameMxid = e.flagger === e.retracted_by;
		return (
			<li className="flex items-start gap-3 px-3 py-2 rounded border border-border bg-card/50">
				<FlagOff className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
				<div className="flex-1 min-w-0 text-xs leading-snug">
					<div>
						<span className="font-medium">Flag retracted</span>
						<span className="text-muted-foreground"> · {labelForCategory(e.category)}</span>
					</div>
					<div className="flex items-center gap-1 mt-0.5">
						<span className="text-muted-foreground">By</span>
						<UserInline userId={e.retracted_by} />
						{!sameMxid && (
							<>
								<span className="text-muted-foreground">(originally flagged by</span>
								<UserInline userId={e.flagger} />
								<span className="text-muted-foreground">)</span>
							</>
						)}
					</div>
					<div className="text-[10px] text-muted-foreground/70 mt-1 tabular-nums">{time}</div>
				</div>
			</li>
		);
	}

	if (e.kind === "self_deletion") {
		// Voluntary takedown.  Two sub-cases distinguished by
		// deletion_kind: 'self' (sender deleted their own message)
		// or 'bot_owner' (a bot's owner deleted the bot's message).
		const isBotOwnerDelete = e.deletion_kind === "bot_owner";
		return (
			<li className="flex items-start gap-3 px-3 py-2 rounded border border-border bg-muted/30">
				<Trash2 className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
				<div className="flex-1 min-w-0 text-xs leading-snug">
					<div className="font-medium">
						{isBotOwnerDelete ? "Bot message deleted by owner" : "Message deleted by sender"}
					</div>
					{isBotOwnerDelete ? (
						<>
							<div className="flex items-center gap-1 mt-0.5">
								<span className="text-muted-foreground">Bot:</span>
								<UserInline userId={e.target_sender} />
							</div>
							<div className="flex items-center gap-1 mt-0.5">
								<span className="text-muted-foreground">Owner:</span>
								<UserInline userId={e.redacted_by} />
							</div>
						</>
					) : (
						<div className="flex items-center gap-1 mt-0.5">
							<span className="text-muted-foreground">By:</span>
							<UserInline userId={e.redacted_by} />
						</div>
					)}
					<div className="text-[10px] text-muted-foreground/70 mt-1 tabular-nums">{time}</div>
				</div>
			</li>
		);
	}

	if (e.kind === "bot_membership") {
		// Founder-only kick / ban of a bot.  Bot-membership actions
		// are unilateral by design, so framing them with destructive
		// red would over-state what's happening.  Amber for kick
		// (recoverable: bot can rejoin if reinvited), red for ban
		// (sticky until a manual unban).
		const isKick = e.action === "kick";
		const Icon = isKick ? UserX : Ban;
		return (
			<li className={cn(
				"flex items-start gap-3 px-3 py-2 rounded border",
				isKick
					? "border-amber-500/30 bg-amber-500/5"
					: "border-destructive/30 bg-destructive/5",
			)}>
				<Icon className={cn(
					"h-4 w-4 shrink-0 mt-0.5",
					isKick ? "text-amber-500" : "text-destructive",
				)} />
				<div className="flex-1 min-w-0 text-xs leading-snug">
					<div className="font-medium">
						Bot {isKick ? "kicked" : "banned"} by founder
					</div>
					<div className="flex items-center gap-1 mt-0.5">
						<span className="text-muted-foreground">Bot:</span>
						<UserInline userId={e.bot_mxid} />
					</div>
					{e.bot_owner && (
						<div className="flex items-center gap-1 mt-0.5">
							<span className="text-muted-foreground">Owner:</span>
							<UserInline userId={e.bot_owner} />
						</div>
					)}
					<div className="flex items-center gap-1 mt-0.5">
						<span className="text-muted-foreground">By:</span>
						<UserInline userId={e.founder} />
					</div>
					<div className="text-[10px] text-muted-foreground/70 mt-1 tabular-nums">{time}</div>
				</div>
			</li>
		);
	}

	// Exhaustiveness guard: every ModLogEntry variant should have been
	// handled above.  If a new kind lands in the API without a render
	// here we drop it silently rather than crash the sheet.
	return null;
}

function UserInline({ userId }: { userId: string }) {
	const transport = useContext(TransportContext);
	const resolved = useResolvedUser(transport, userId);
	// Two display layers:
	//   - Avatar: real mxc when we've resolved the profile, otherwise
	//     MatrixAvatar's DiceBear fallback (deterministic per id, so
	//     it doesn't flip during the resolution round-trip).
	//   - Label: display name when known, localpart otherwise.  Drops
	//     the `@user:server` mono-font handle entirely — it was visual
	//     noise that didn't help the reader.
	const localpart = userId.startsWith("@") && userId.includes(":")
		? userId.slice(1, userId.indexOf(":"))
		: userId;
	const label = resolved?.displayName ?? localpart;
	return (
		<span
			className="inline-flex items-center gap-1 min-w-0"
			title={userId}
		>
			<MatrixAvatar
				mxc={resolved?.avatarMxc}
				seed={userId}
				className="h-4 w-4"
			/>
			<span className="text-[11px] font-medium truncate">{label}</span>
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

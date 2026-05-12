// Inline poll renderer.  Lives where a regular MessageBubble would
// live for a kind="poll" message.  Reads the question + answer set
// from the message itself, the live counts + viewer's own vote from
// the PollAggregate.
//
// States:
//   - active disclosed: clickable options + bars + counts
//   - active undisclosed: clickable options without counts (final
//     reveal happens at end)
//   - ended: read-only, "Final results" badge, full counts visible
//   - voting in progress: pending click is disabled until response
//     event echoes back through sync (or 1.5s, whichever first —
//     gives the click instant feedback without waiting on federation)
//
// Auto-close (poll.endsAt):
//   - When set and the wall clock has passed it, voting locks for
//     everyone and the card renders the same way an explicit
//     m.poll.end would render — except `endedAt` only flips after
//     the canonical end-event arrives on the timeline.
//   - The creator's client schedules a setTimeout to auto-fire
//     m.poll.end at expiry so the canonical event lands for every
//     other client (and federation backfills correctly).
//   - Other clients just hide voting after expiry; they wait for
//     the m.poll.end propagation to flip `endedAt` and reveal final
//     results in undisclosed polls.

import { useEffect, useRef, useState } from "react";
import { BarChart3, CheckCircle2 } from "lucide-react";
import type { Message, PollAggregate, UserId } from "@koven/shared";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { cn } from "@/lib/utils";

interface PollCardProps {
	message: Message;
	aggregate: PollAggregate | undefined;
	viewerUserId: UserId | undefined;
	onVote(answerIds: string[]): void | Promise<void>;
	onEnd(): void | Promise<void>;
	// Member maps for rendering voter avatars under each option.
	// Both come from the room's loaded member roster; mxids that
	// aren't in either map fall back to MatrixAvatar's seed-based
	// DiceBear avatar + the bare mxid label.
	memberAvatars: Map<string, string | undefined>;
	memberNames: Map<string, string>;
}

export function PollCard({ message, aggregate, viewerUserId, onVote, onEnd, memberAvatars, memberNames }: PollCardProps) {
	const [submitting, setSubmitting] = useState(false);
	// Re-render once a minute so countdown text stays accurate without
	// per-card timers leaking memory.  Module-shared interval would be
	// nicer; the cardinality of polls in a room is small enough that
	// per-card is fine for v1.
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const id = window.setInterval(() => setTick(t => t + 1), 30_000);
		return () => window.clearInterval(id);
	}, []);
	void tick;

	const poll = message.poll;
	if (!poll) return null;
	const pollDef = poll;
	const isCreator = !!viewerUserId && message.sender === viewerUserId;

	// "Ended" combines two signals:
	//   1. canonical: m.poll.end has arrived (aggregate.endedAt set)
	//   2. local: pollDef.endsAt has passed wall-clock time
	// Either suffices for "voting locked" UX; only (1) reveals
	// undisclosed counts (we don't know the final tallies otherwise).
	const now = Date.now();
	const expired = !!pollDef.endsAt && now >= pollDef.endsAt;
	const ended = !!aggregate?.endedAt;
	const votingLocked = ended || expired;

	// Creator auto-end: when wall-clock passes endsAt and we haven't
	// already seen an m.poll.end, the creator's client fires it so
	// the canonical event lands for every other participant.  Guarded
	// by a ref so a re-render mid-call doesn't double-send.
	const autoEndedRef = useRef(false);
	useEffect(() => {
		if (!isCreator) return;
		if (ended) return;
		if (!pollDef.endsAt) return;
		if (autoEndedRef.current) return;
		const remaining = pollDef.endsAt - Date.now();
		if (remaining <= 0) {
			autoEndedRef.current = true;
			void onEnd();
			return;
		}
		const id = window.setTimeout(() => {
			autoEndedRef.current = true;
			void onEnd();
		}, remaining);
		return () => window.clearTimeout(id);
	}, [isCreator, ended, pollDef.endsAt, onEnd]);

	const counts = ended
		? (aggregate?.finalCounts ?? aggregate?.counts ?? {})
		: (aggregate?.counts ?? {});
	const totalVotes = Object.values(counts).reduce((s, n) => s + n, 0);
	const myAnswers = aggregate?.myAnswers ?? [];
	// Disclosed counts are always visible.  Undisclosed counts only
	// reveal once the canonical end-event has landed — local expiry
	// alone isn't enough because we don't have the sender's final
	// tallies until then.
	const showCounts = ended || pollDef.kind === "disclosed";
	const multi = pollDef.maxSelections > 1;
	// Voter-avatar rendering: gated on (a) the creator picking
	// non-anonymous, and (b) showCounts being true (we don't reveal
	// who voted for what until counts are visible — undisclosed polls
	// stay opaque on both dimensions until end).
	const showVoters = !pollDef.anonymous && showCounts;
	const votersByAnswer = aggregate?.votersByAnswer ?? {};
	const MAX_VISIBLE_VOTERS = 5;

	async function pickAnswer(answerId: string) {
		if (votingLocked || submitting) return;
		let next: string[];
		if (multi) {
			// Multi-select toggle: clicking a picked option clears it,
			// clicking an unpicked one adds it (overflow drops the
			// oldest pick).  The toggle is the explicit affordance for
			// multi polls — there's no separate clear button.
			if (myAnswers.includes(answerId)) {
				next = myAnswers.filter(a => a !== answerId);
			} else if (myAnswers.length < pollDef.maxSelections) {
				next = [...myAnswers, answerId];
			} else {
				next = [...myAnswers.slice(1), answerId];
			}
		} else {
			// Single-select: clicking your CURRENT pick is a no-op —
			// the previous "click your pick to withdraw" behavior was
			// a vote-loss footgun (users double-click or hover-click
			// their own row and accidentally retract their vote, with
			// no warning).  An explicit "Clear my vote" button below
			// is now the only path to withdraw.  Clicking a DIFFERENT
			// option still switches.
			if (myAnswers[0] === answerId) return;
			next = [answerId];
		}
		setSubmitting(true);
		try {
			await onVote(next);
		} finally {
			setSubmitting(false);
		}
	}

	async function clearMyVote() {
		if (votingLocked || submitting) return;
		if (myAnswers.length === 0) return;
		setSubmitting(true);
		try {
			// Empty answers = withdraw per spec.
			await onVote([]);
		} finally {
			setSubmitting(false);
		}
	}

	async function endPoll() {
		if (votingLocked || submitting) return;
		setSubmitting(true);
		try {
			await onEnd();
		} finally {
			setSubmitting(false);
		}
	}

	// Header label — distinguishes the four states the card can be in.
	const headerLabel = ended
		? "Final results"
		: expired
			? "Closing…"
			: pollDef.kind === "undisclosed"
				? "Hidden until ended"
				: "Poll";

	return (
		<div className="inline-block max-w-[60ch] w-full px-4 py-3 rounded-xl bg-muted/60 border border-border">
			<div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
				<BarChart3 className="h-3 w-3" />
				<span>{headerLabel}</span>
				{multi && !ended && <span>· choose up to {pollDef.maxSelections}</span>}
			</div>
			<div className="text-sm font-semibold mb-3 break-words">{pollDef.question}</div>
			<div className="space-y-1.5">
				{pollDef.answers.map(a => {
					const count = counts[a.id] ?? 0;
					const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
					const picked = myAnswers.includes(a.id);
					const isWinner = ended && totalVotes > 0 && count === Math.max(...Object.values(counts));
					const voters = votersByAnswer[a.id] ?? [];
					return (
						<div key={a.id}>
							<button
								type="button"
								disabled={votingLocked || submitting}
								onClick={() => void pickAnswer(a.id)}
								className={cn(
									"relative w-full text-left px-3 py-2 rounded-md border transition-colors overflow-hidden",
									"flex items-center justify-between gap-3",
									picked
										? "border-primary/60 bg-primary/10"
										: "border-border bg-background/40 hover:bg-accent/40",
									votingLocked && "cursor-default",
									submitting && "opacity-70",
								)}
							>
								{showCounts && (
									<div
										className={cn(
											"absolute inset-y-0 left-0 transition-[width] duration-300",
											picked ? "bg-primary/20" : "bg-foreground/10",
										)}
										style={{ width: `${pct}%` }}
										aria-hidden
									/>
								)}
								<span className="relative flex items-center gap-2 min-w-0">
									{picked && (
										<CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />
									)}
									<span className="text-sm truncate">{a.text}</span>
									{isWinner && (
										<span className="text-[10px] font-medium text-primary ml-1 shrink-0">
											Winner
										</span>
									)}
								</span>
								{showCounts && (
									<span className="relative text-[11px] tabular-nums text-muted-foreground shrink-0">
										{count} {count === 1 ? "vote" : "votes"} · {pct}%
									</span>
								)}
							</button>
							{showVoters && voters.length > 0 && (
								// Voter stack — small avatars + a "+N more"
								// chip when the list overflows.  Hovering a
								// row shows the voter's display name as a
								// tooltip; we don't render the full names
								// inline because long display names blow
								// up the row height on rooms with talkative
								// posters.
								<div className="flex items-center gap-1 mt-1 ml-1">
									<div className="flex -space-x-1.5">
										{voters.slice(0, MAX_VISIBLE_VOTERS).map(v => (
											// Wrap in a span so we can set the
											// title attribute (MatrixAvatar
											// doesn't forward arbitrary props).
											<span key={v} title={memberNames.get(v) ?? v}>
												<MatrixAvatar
													mxc={memberAvatars.get(v)}
													seed={v}
													kind="user"
													className="h-4 w-4 rounded-full ring-1 ring-muted/60"
												/>
											</span>
										))}
									</div>
									{voters.length > MAX_VISIBLE_VOTERS && (
										<span className="text-[10px] text-muted-foreground ml-1">
											+{voters.length - MAX_VISIBLE_VOTERS} more
										</span>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>
			<div className="flex items-center justify-between mt-3 pt-2 border-t border-border/60 text-[10px] text-muted-foreground gap-2">
				<span className="truncate">
					{showCounts
						? `${totalVotes} ${totalVotes === 1 ? "vote" : "votes"} total`
						: ended
							? ""
							: "Vote to see results when the poll ends"}
				</span>
				<span className="flex items-center gap-3 shrink-0">
					{!ended && pollDef.endsAt && (
						<span className={cn(expired && "text-amber-500/90")}>
							{formatTimeRemaining(pollDef.endsAt - now)}
						</span>
					)}
					{!votingLocked && myAnswers.length > 0 && (
						// Explicit withdraw — only visible after voting.
						// Replaces the old "click your pick to retract"
						// pattern which caused accidental vote loss when
						// users double-clicked or hover-clicked their
						// own row.
						<button
							type="button"
							onClick={() => void clearMyVote()}
							disabled={submitting}
							className="text-muted-foreground hover:text-foreground disabled:opacity-50"
						>
							Clear my vote
						</button>
					)}
					{!votingLocked && isCreator && (
						<button
							type="button"
							onClick={() => void endPoll()}
							disabled={submitting}
							className="text-destructive/80 hover:text-destructive disabled:opacity-50"
						>
							End poll
						</button>
					)}
				</span>
			</div>
		</div>
	);
}

/** "Closes in 3h", "Closes in 12m", "Closing…", etc.  Coarse-grained
 * (no seconds) so the per-minute re-render tick is sufficient. */
function formatTimeRemaining(ms: number): string {
	if (ms <= 0) return "Closing…";
	const totalMinutes = Math.floor(ms / 60_000);
	if (totalMinutes < 60) return `Closes in ${Math.max(1, totalMinutes)}m`;
	const hours = Math.floor(totalMinutes / 60);
	if (hours < 24) {
		const minutes = totalMinutes % 60;
		return minutes === 0 ? `Closes in ${hours}h` : `Closes in ${hours}h ${minutes}m`;
	}
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours === 0
		? `Closes in ${days}d`
		: `Closes in ${days}d ${remainingHours}h`;
}

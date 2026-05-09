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

import { useState } from "react";
import { BarChart3, CheckCircle2 } from "lucide-react";
import type { Message, PollAggregate, UserId } from "@koven/shared";
import { cn } from "@/lib/utils";

interface PollCardProps {
	message: Message;
	aggregate: PollAggregate | undefined;
	viewerUserId: UserId | undefined;
	onVote(answerIds: string[]): void | Promise<void>;
	onEnd(): void | Promise<void>;
}

export function PollCard({ message, aggregate, viewerUserId, onVote, onEnd }: PollCardProps) {
	const [submitting, setSubmitting] = useState(false);
	const poll = message.poll;
	if (!poll) return null;
	// Local capture: TS narrowing doesn't propagate into the inner
	// async closures (`pickAnswer` references `poll.maxSelections`)
	// so we hoist a `definitely-defined` reference for the closures
	// to use.
	const pollDef = poll;

	const isCreator = !!viewerUserId && message.sender === viewerUserId;
	const ended = !!aggregate?.endedAt;
	const counts = ended
		? (aggregate?.finalCounts ?? aggregate?.counts ?? {})
		: (aggregate?.counts ?? {});
	const totalVotes = Object.values(counts).reduce((s, n) => s + n, 0);
	const myAnswers = aggregate?.myAnswers ?? [];
	const showCounts = ended || poll.kind === "disclosed";
	const multi = poll.maxSelections > 1;

	async function pickAnswer(answerId: string) {
		if (ended || submitting) return;
		let next: string[];
		if (multi) {
			// Toggle: remove if present, otherwise add up to the cap.
			if (myAnswers.includes(answerId)) {
				next = myAnswers.filter(a => a !== answerId);
			} else if (myAnswers.length < pollDef.maxSelections) {
				next = [...myAnswers, answerId];
			} else {
				// At cap: replace the oldest pick with this one so the
				// click does something visible instead of silently no-op.
				next = [...myAnswers.slice(1), answerId];
			}
		} else {
			// Single-choice: clicking the current pick clears the vote
			// (matches Element); clicking another switches to it.
			next = myAnswers[0] === answerId ? [] : [answerId];
		}
		setSubmitting(true);
		try {
			await onVote(next);
		} finally {
			setSubmitting(false);
		}
	}

	async function endPoll() {
		if (ended || submitting) return;
		setSubmitting(true);
		try {
			await onEnd();
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="inline-block max-w-[60ch] w-full px-4 py-3 rounded-xl bg-muted/60 border border-border">
			<div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
				<BarChart3 className="h-3 w-3" />
				<span>{ended ? "Final results" : poll.kind === "undisclosed" ? "Hidden until ended" : "Poll"}</span>
				{multi && !ended && <span>· choose up to {poll.maxSelections}</span>}
			</div>
			<div className="text-sm font-semibold mb-3 break-words">{poll.question}</div>
			<div className="space-y-1.5">
				{poll.answers.map(a => {
					const count = counts[a.id] ?? 0;
					const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
					const picked = myAnswers.includes(a.id);
					const isWinner = ended && totalVotes > 0 && count === Math.max(...Object.values(counts));
					return (
						<button
							key={a.id}
							type="button"
							disabled={ended || submitting}
							onClick={() => void pickAnswer(a.id)}
							className={cn(
								"relative w-full text-left px-3 py-2 rounded-md border transition-colors overflow-hidden",
								"flex items-center justify-between gap-3",
								picked
									? "border-primary/60 bg-primary/10"
									: "border-border bg-background/40 hover:bg-accent/40",
								ended && "cursor-default",
								submitting && "opacity-70",
							)}
						>
							{showCounts && (
								// Bar fill underneath the label — width
								// matches the answer's vote share.  Sits
								// behind the text via `absolute` + a low-
								// alpha bg so the label stays readable.
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
					);
				})}
			</div>
			<div className="flex items-center justify-between mt-3 pt-2 border-t border-border/60 text-[10px] text-muted-foreground">
				<span>
					{showCounts
						? `${totalVotes} ${totalVotes === 1 ? "vote" : "votes"} total`
						: ended
							? ""
							: "Vote to see results when the poll ends"}
				</span>
				{!ended && isCreator && (
					<button
						type="button"
						onClick={() => void endPoll()}
						disabled={submitting}
						className="text-destructive/80 hover:text-destructive disabled:opacity-50"
					>
						End poll
					</button>
				)}
			</div>
		</div>
	);
}

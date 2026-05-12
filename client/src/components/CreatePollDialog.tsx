// Modal for composing a new poll.  Triggered from the chat composer's
// poll button; on submit hands the question + answers + duration off
// to the caller, which sends the m.poll.start event via the
// transport.
//
// Defaults:
//   - 2 answer slots (the minimum for a poll to make sense)
//   - "disclosed" (running counts visible to all)
//   - single-select (max_selections = 1, hardcoded)
//   - duration = "no limit" when disclosed, "24h" when undisclosed
//
// Limits:
//   - up to 8 answers (plenty for any plausible poll, keeps the
//     start-event payload small)
//   - 240 chars per question, 120 per answer (matches Element)
//
// "Show running results" + duration interaction:
//   - Disclosed: counts are always visible, so a "no limit" poll
//     still surfaces useful information at any time.  Users can pick
//     any preset OR no-limit.
//   - Undisclosed: counts are hidden until the poll ends.  No-limit
//     would mean results never surface — so we force a real
//     duration; the "no limit" option is hidden when undisclosed,
//     and selecting "no limit" then unchecking disclosed snaps the
//     selection back to 24h.

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface CreatePollDialogProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	onSubmit(opts: {
		question: string;
		answers: string[];
		kind: "disclosed" | "undisclosed";
		maxSelections: number;
		endsAt?: number;
		anonymous?: boolean;
	}): Promise<void> | void;
}

const MAX_ANSWERS = 8;
const MAX_QUESTION_LEN = 240;
const MAX_ANSWER_LEN = 120;

type DurationKey = "1h" | "24h" | "3d" | "7d" | "none";

const DURATION_OPTIONS: Array<{ key: DurationKey; label: string; ms: number | null }> = [
	{ key: "1h",  label: "1 hour",  ms: 60 * 60 * 1000 },
	{ key: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
	{ key: "3d",  label: "3 days",  ms: 3 * 24 * 60 * 60 * 1000 },
	{ key: "7d",  label: "7 days",  ms: 7 * 24 * 60 * 60 * 1000 },
	{ key: "none", label: "No limit", ms: null },
];

export function CreatePollDialog({ open, onOpenChange, onSubmit }: CreatePollDialogProps) {
	const [question, setQuestion] = useState("");
	const [answers, setAnswers] = useState<string[]>(["", ""]);
	const [disclosed, setDisclosed] = useState(true);
	// Anonymity is OFF by default — Koven shows the small avatar
	// stack of who voted for what under each option, which makes
	// polls feel like real conversation ("oh, Alice picked option B
	// too").  Creators who explicitly want a private poll opt in.
	const [anonymous, setAnonymous] = useState(false);
	const [duration, setDuration] = useState<DurationKey>("none");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Snap "no limit" → 24h whenever the poll becomes undisclosed —
	// undisclosed polls never reveal results without a finite end,
	// so "no limit" + undisclosed is a no-result-ever footgun.
	useEffect(() => {
		if (!disclosed && duration === "none") setDuration("24h");
	}, [disclosed, duration]);

	function reset() {
		setQuestion("");
		setAnswers(["", ""]);
		setDisclosed(true);
		setAnonymous(false);
		setDuration("none");
		setError(null);
	}

	function close() {
		onOpenChange(false);
		// Defer reset until after the close animation so the form
		// doesn't visibly clear before fading out.
		setTimeout(reset, 150);
	}

	function updateAnswer(i: number, value: string) {
		setAnswers(prev => prev.map((a, j) => j === i ? value : a));
	}

	function addAnswer() {
		if (answers.length >= MAX_ANSWERS) return;
		setAnswers(prev => [...prev, ""]);
	}

	function removeAnswer(i: number) {
		// Always preserve the 2-answer minimum.
		if (answers.length <= 2) return;
		setAnswers(prev => prev.filter((_, j) => j !== i));
	}

	const trimmedQuestion = question.trim();
	const filledAnswers = answers.map(a => a.trim()).filter(a => a.length > 0);
	const canSubmit =
		trimmedQuestion.length > 0 &&
		filledAnswers.length >= 2 &&
		!submitting;

	async function submit() {
		if (!canSubmit) return;
		setSubmitting(true);
		setError(null);
		try {
			const durationMs = DURATION_OPTIONS.find(d => d.key === duration)?.ms ?? null;
			await onSubmit({
				question: trimmedQuestion,
				answers: filledAnswers,
				kind: disclosed ? "disclosed" : "undisclosed",
				maxSelections: 1,
				endsAt: durationMs !== null ? Date.now() + durationMs : undefined,
				anonymous,
			});
			close();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Create poll</DialogTitle>
					<DialogDescription>
						Ask a question and let the room vote.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="poll-question">Question</Label>
						<Input
							id="poll-question"
							value={question}
							onChange={(e) => setQuestion(e.target.value)}
							placeholder="What should we order for lunch?"
							maxLength={MAX_QUESTION_LEN}
							autoFocus
						/>
					</div>

					<div className="space-y-1.5">
						<Label>Options</Label>
						<div className="space-y-2">
							{answers.map((a, i) => (
								<div key={i} className="flex gap-2">
									<Input
										value={a}
										onChange={(e) => updateAnswer(i, e.target.value)}
										placeholder={`Option ${i + 1}`}
										maxLength={MAX_ANSWER_LEN}
									/>
									{answers.length > 2 && (
										<Button
											type="button"
											variant="ghost"
											size="icon"
											onClick={() => removeAnswer(i)}
											aria-label={`Remove option ${i + 1}`}
											className="text-muted-foreground hover:text-destructive shrink-0"
										>
											<Trash2 className="h-4 w-4" />
										</Button>
									)}
								</div>
							))}
							{answers.length < MAX_ANSWERS && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={addAnswer}
									className="w-full"
								>
									<Plus className="h-3.5 w-3.5 mr-1.5" />
									Add option
								</Button>
							)}
						</div>
					</div>

					<label className="flex items-center justify-between gap-3 cursor-pointer">
						<div>
							<div className="text-sm">Show running results</div>
							<div className="text-[10px] text-muted-foreground leading-snug">
								{disclosed
									? "Voters see counts as soon as they're cast."
									: "Counts stay hidden until the poll ends."}
							</div>
						</div>
						<input
							type="checkbox"
							checked={disclosed}
							onChange={(e) => setDisclosed(e.target.checked)}
							className="h-4 w-4 accent-primary"
						/>
					</label>

					<label className="flex items-center justify-between gap-3 cursor-pointer">
						<div>
							<div className="text-sm">Anonymous</div>
							<div className="text-[10px] text-muted-foreground leading-snug">
								{anonymous
									? "Voter names are hidden in Koven's UI."
									: "Voter avatars appear under each option."}
							</div>
						</div>
						<input
							type="checkbox"
							checked={anonymous}
							onChange={(e) => setAnonymous(e.target.checked)}
							className="h-4 w-4 accent-primary"
						/>
					</label>

					<div className="space-y-1.5">
						<Label>Duration</Label>
						<div className="flex flex-wrap gap-1.5">
							{DURATION_OPTIONS
								// Hide "No limit" when undisclosed — without a
								// finite end, the results never surface, which
								// defeats the point of the poll.
								.filter(d => disclosed || d.key !== "none")
								.map(d => (
									<button
										key={d.key}
										type="button"
										onClick={() => setDuration(d.key)}
										className={cn(
											"px-2.5 py-1 rounded-md text-xs border transition-colors",
											duration === d.key
												? "border-primary bg-primary/10 text-foreground"
												: "border-border text-muted-foreground hover:text-foreground hover:bg-accent",
										)}
									>
										{d.label}
									</button>
								))}
						</div>
						<p className="text-[10px] text-muted-foreground leading-snug">
							{duration === "none"
								? "Poll stays open until you end it manually."
								: `Poll closes automatically in ${
									DURATION_OPTIONS.find(d => d.key === duration)?.label.toLowerCase()
								}. You can also end it early.`}
						</p>
					</div>

					{error && (
						<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
							{error}
						</div>
					)}
				</div>

				<DialogFooter>
					<Button type="button" variant="ghost" onClick={close} disabled={submitting}>
						Cancel
					</Button>
					<Button type="button" onClick={submit} disabled={!canSubmit}>
						{submitting ? "Sending…" : "Create poll"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

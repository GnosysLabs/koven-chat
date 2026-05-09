// Modal for composing a new poll.  Triggered from the chat composer's
// poll button; on submit hands the question + answers off to the
// caller, which sends the m.poll.start event via the transport.
//
// Defaults:
//   - 2 answer slots (the minimum for a poll to make sense)
//   - "disclosed" (running counts visible to all)
//   - single-select (max_selections = 1)
//
// Limits:
//   - up to 8 answers (plenty for any plausible poll, keeps the
//     start-event payload small)
//   - 240 chars per question, 120 per answer (matches Element)

import { useState } from "react";
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

interface CreatePollDialogProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	onSubmit(opts: {
		question: string;
		answers: string[];
		kind: "disclosed" | "undisclosed";
		maxSelections: number;
	}): Promise<void> | void;
}

const MAX_ANSWERS = 8;
const MAX_QUESTION_LEN = 240;
const MAX_ANSWER_LEN = 120;

export function CreatePollDialog({ open, onOpenChange, onSubmit }: CreatePollDialogProps) {
	const [question, setQuestion] = useState("");
	const [answers, setAnswers] = useState<string[]>(["", ""]);
	const [disclosed, setDisclosed] = useState(true);
	const [multipleChoice, setMultipleChoice] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function reset() {
		setQuestion("");
		setAnswers(["", ""]);
		setDisclosed(true);
		setMultipleChoice(false);
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
			await onSubmit({
				question: trimmedQuestion,
				answers: filledAnswers,
				kind: disclosed ? "disclosed" : "undisclosed",
				// Multiple-choice caps at the answer count; spec needs
				// max_selections >= 1 and <= len(answers).
				maxSelections: multipleChoice ? filledAnswers.length : 1,
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

					<div className="space-y-2">
						<label className="flex items-center justify-between gap-3 cursor-pointer">
							<div>
								<div className="text-sm">Show running results</div>
								<div className="text-[10px] text-muted-foreground leading-snug">
									{disclosed
										? "Voters see counts as soon as they're cast."
										: "Counts stay hidden until you end the poll."}
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
								<div className="text-sm">Allow multiple choices</div>
								<div className="text-[10px] text-muted-foreground leading-snug">
									Voters can pick more than one option.
								</div>
							</div>
							<input
								type="checkbox"
								checked={multipleChoice}
								onChange={(e) => setMultipleChoice(e.target.checked)}
								className="h-4 w-4 accent-primary"
							/>
						</label>
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

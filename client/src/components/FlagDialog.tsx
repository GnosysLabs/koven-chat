// Flag-this-message dialog.  Lives outside MessageActions because two
// surfaces can open it: the hover-toolbar's flag button and the
// always-visible flag pill on already-flagged messages (so users who
// agree with an existing flag can pile on).

import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AlertTriangle } from "lucide-react";
import type { FlagCategory } from "@koven/shared";

const FLAG_OPTIONS: { category: Exclude<FlagCategory, "floor_violation">; label: string; description: string }[] = [
	{ category: "off_topic",      label: "Off-topic",       description: "Doesn't fit this room." },
	{ category: "spam",           label: "Spam",            description: "Promotional or unrelated." },
	{ category: "harassment",     label: "Harassment",      description: "Insults or targeted attacks." },
	{ category: "misinformation", label: "Misinformation",  description: "Knowingly false or misleading." },
];

export interface FlagDialogProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	onSubmit(category: FlagCategory, rationale?: string): void | Promise<void>;
}

export function FlagDialog({ open, onOpenChange, onSubmit }: FlagDialogProps) {
	const [category, setCategory] = useState<FlagCategory | null>(null);
	const [rationale, setRationale] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// "form" = picking a category + rationale.  "confirm" = serious-
	// violation confirmation step shown after the user selects the
	// floor_violation category and clicks Flag.  Acknowledgement
	// required because false reports in this category carry severe
	// consequences (immediate suspension of the target, plus
	// reputation damage and potential auto-suspension of the false
	// flagger after threshold).
	const [step, setStep] = useState<"form" | "confirm">("form");

	function reset() {
		setCategory(null);
		setRationale("");
		setError(null);
		setPending(false);
		setStep("form");
	}

	async function doSubmit() {
		if (!category) return;
		setPending(true);
		setError(null);
		try {
			await onSubmit(category, rationale.trim() || undefined);
			reset();
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPending(false);
		}
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (!category) return;
		// Floor-violation flags require an explicit confirmation step.
		// Other categories submit immediately.
		if (category === "floor_violation" && step !== "confirm") {
			setStep("confirm");
			return;
		}
		await doSubmit();
	}

	return (
		<Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
			<DialogContent className="sm:max-w-md">
				{step === "confirm" ? (
					<>
						<DialogHeader>
							<DialogTitle className="flex items-center gap-2 text-destructive">
								<AlertTriangle className="h-4 w-4" />
								Confirm serious-violation report
							</DialogTitle>
							<DialogDescription>
								Read this carefully before submitting.
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-3 text-sm">
							<p>This category is reserved for content that is one of:</p>
							<ul className="list-disc pl-5 space-y-1 text-muted-foreground text-xs">
								<li>Child sexual abuse material (CSAM)</li>
								<li>A credible, specific threat of violence</li>
								<li>Personal information published without consent (doxxing)</li>
							</ul>
							<p>Submitting this report will:</p>
							<ul className="list-disc pl-5 space-y-1 text-muted-foreground text-xs">
								<li>Immediately collapse the message into a non-revealable hidden state.</li>
								<li>Suspend the message author's account pending admin review.</li>
								<li>Be permanently logged in this room's public mod log with your username attached.</li>
							</ul>
							<p className="text-destructive">If an admin reviews this report and finds it was a false alarm:</p>
							<ul className="list-disc pl-5 space-y-1 text-destructive/80 text-xs">
								<li>Your reputation drops to the floor for the next 30 days.</li>
								<li>Two reversed false reports within 30 days, or three ever, will auto-suspend your own account pending admin review.</li>
							</ul>
							<p className="text-xs text-muted-foreground">
								If the content is just rude, off-topic, or factually wrong, go back and pick a different category. The community vote handles those.
							</p>
						</div>
						{error && (
							<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
								{error}
							</div>
						)}
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								onClick={() => setStep("form")}
								disabled={pending}
								autoFocus
							>
								Back
							</Button>
							<Button
								type="button"
								onClick={doSubmit}
								disabled={pending}
								className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
							>
								{pending ? "Submitting…" : "I understand, submit"}
							</Button>
						</DialogFooter>
					</>
				) : (
				<>
				<DialogHeader>
					<DialogTitle>Flag this message</DialogTitle>
					<DialogDescription>
						Flags from multiple weighted users collapse a post pending review. Pick the closest reason.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={submit} className="space-y-4">
					<div className="space-y-1.5">
						{FLAG_OPTIONS.map(opt => (
							<CategoryRow
								key={opt.category}
								label={opt.label}
								description={opt.description}
								selected={category === opt.category}
								onClick={() => setCategory(opt.category)}
							/>
						))}
						<div className="pt-2 mt-2 border-t border-border">
							<CategoryRow
								label="Serious violation"
								description="CSAM, doxxing, credible threat. Bypasses voting."
								selected={category === "floor_violation"}
								onClick={() => setCategory("floor_violation")}
								destructive
								icon={<AlertTriangle className="h-4 w-4" />}
							/>
						</div>
					</div>

					<div className="space-y-1.5">
						<label htmlFor="flag-rationale" className="text-xs font-medium">
							Add context <span className="text-muted-foreground font-normal">(optional)</span>
						</label>
						<textarea
							id="flag-rationale"
							value={rationale}
							onChange={(e) => setRationale(e.target.value)}
							placeholder="Anything reviewers should know about why this is a problem"
							maxLength={280}
							rows={2}
							className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
						/>
						<div className="text-[10px] text-muted-foreground text-right tabular-nums">
							{rationale.length} / 280
						</div>
					</div>

					{error && (
						<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
							{error}
						</div>
					)}

					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
							Cancel
						</Button>
						<Button type="submit" disabled={!category || pending}>
							{pending ? "Flagging…" : category === "floor_violation" ? "Continue" : "Flag"}
						</Button>
					</DialogFooter>
				</form>
				</>
				)}
			</DialogContent>
		</Dialog>
	);
}

function CategoryRow({
	label, description, selected, onClick, destructive, icon,
}: {
	label: string;
	description: string;
	selected: boolean;
	onClick(): void;
	destructive?: boolean;
	icon?: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"w-full text-left px-3 py-2 rounded-md border transition-colors",
				selected
					? destructive
						// Construction-orange instead of destructive red.
						// Safety-cone hue reads as "caution" without the
						// alarm-bell contrast issue red has on dark themes.
						? "border-amber-500/60 bg-amber-500/10"
						: "border-primary bg-primary/5"
					: "border-border hover:bg-accent",
			)}
		>
			<div className={cn(
				"flex items-center gap-2 text-sm font-medium",
				destructive && "text-amber-500",
			)}>
				{icon}
				{label}
			</div>
			<div className="text-xs text-muted-foreground leading-snug mt-0.5">
				{description}
			</div>
		</button>
	);
}

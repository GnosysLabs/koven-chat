// FlagButton — the user-facing primitive for the consensus moderation
// engine.  Click → pick a category → emit a chat.koven.flag.v1 event.
// No ban button anywhere in the codebase by design (see GOVERNANCE.md).

import { useState } from "react";
import type { FlagCategory } from "@koven/shared";

const CATEGORY_LABELS: Record<FlagCategory, string> = {
	off_topic: "Off topic",
	spam: "Spam",
	harassment: "Harassment",
	misinformation: "Misinformation",
	floor_violation: "CSAM / Threat / Doxx",
};

const CATEGORY_DESCRIPTIONS: Record<FlagCategory, string> = {
	off_topic: "Doesn't fit this channel's subject",
	spam: "Repetitive, automated, or commercial",
	harassment: "Directed cruelty toward a specific person",
	misinformation: "Factually false claim presented as fact",
	floor_violation: "Illegal content. Reviewed and removed automatically.",
};

export interface FlagButtonProps {
	messageId: string;
	disabled?: boolean;
	alreadyFlaggedByYou?: boolean;
	onFlag(category: FlagCategory, rationale?: string): void;
}

export function FlagButton({
	messageId,
	disabled,
	alreadyFlaggedByYou,
	onFlag,
}: FlagButtonProps) {
	const [open, setOpen] = useState(false);
	const [category, setCategory] = useState<FlagCategory | null>(null);
	const [rationale, setRationale] = useState("");

	if (alreadyFlaggedByYou) {
		return (
			<span
				className="text-[11px] text-muted-foreground italic"
				title="You've already flagged this message — flags are one-per-user-per-message."
			>
				flagged
			</span>
		);
	}

	if (!open) {
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				disabled={disabled}
				className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
				aria-label={`Flag message ${messageId}`}
			>
				⚑ flag
			</button>
		);
	}

	return (
		<div className="border border-border rounded-md p-3 mt-1 space-y-2 bg-card text-xs max-w-sm">
			<div className="text-muted-foreground">Why are you flagging this?</div>
			<div className="space-y-1">
				{(Object.keys(CATEGORY_LABELS) as FlagCategory[]).map(c => (
					<label key={c} className="flex items-start gap-2 cursor-pointer hover:bg-accent rounded p-1">
						<input
							type="radio"
							name={`flag-${messageId}`}
							value={c}
							checked={category === c}
							onChange={() => setCategory(c)}
							className="mt-0.5"
						/>
						<div>
							<div className="font-medium">{CATEGORY_LABELS[c]}</div>
							<div className="text-muted-foreground text-[11px]">{CATEGORY_DESCRIPTIONS[c]}</div>
						</div>
					</label>
				))}
			</div>
			<input
				type="text"
				placeholder="Optional one-line rationale"
				value={rationale}
				onChange={e => setRationale(e.target.value)}
				maxLength={140}
				className="w-full px-2 py-1 rounded border border-border bg-background text-foreground text-xs"
			/>
			<div className="flex gap-2 justify-end pt-1">
				<button
					type="button"
					onClick={() => { setOpen(false); setCategory(null); setRationale(""); }}
					className="px-3 py-1 rounded text-xs text-muted-foreground hover:text-foreground"
				>
					Cancel
				</button>
				<button
					type="button"
					disabled={!category}
					onClick={() => {
						if (!category) return;
						onFlag(category, rationale.trim() || undefined);
						setOpen(false);
						setCategory(null);
						setRationale("");
					}}
					className="px-3 py-1 rounded text-xs bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					Submit flag
				</button>
			</div>
			<div className="text-[10px] text-muted-foreground italic pt-1 border-t border-border">
				Your flag will be public and recorded in the mod log with your username.
			</div>
		</div>
	);
}

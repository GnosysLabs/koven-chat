// Report-this-message dialog.  Opens from the message hover-toolbar
// Flag button + the right-click context menu, and (with target="room")
// from the room-header Flag icon.  Submits a chat.koven.flag.v1 event
// that the engine records for admins to act on; this dialog itself
// just collects the category + optional rationale.

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
	// Same dialog handles both message reports (default) and room-target
	// reports.  The discriminator just flips title + copy so the user
	// knows whether they're reporting a single message or the room as
	// a whole.
	target?: "message" | "room";
}

export function FlagDialog({ open, onOpenChange, onSubmit, target = "message" }: FlagDialogProps) {
	const [category, setCategory] = useState<FlagCategory | null>(null);
	const [rationale, setRationale] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function reset() {
		setCategory(null);
		setRationale("");
		setError(null);
		setPending(false);
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
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

	return (
		<Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						{target === "room" ? "Report this room to admins" : "Report this message to admins"}
					</DialogTitle>
					<DialogDescription>
						{target === "room"
							? "Admins review reports and can take action against the room or its members. Pick the closest reason."
							: "Admins review reports and can take action against the message or its sender. Pick the closest reason."}
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
								description="CSAM, doxxing, credible threat of violence."
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
							placeholder="Anything admins should know about why this is a problem"
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
							{pending ? "Reporting…" : "Report"}
						</Button>
					</DialogFooter>
				</form>
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

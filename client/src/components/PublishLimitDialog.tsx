// "You've reached your daily limit for creating rooms / spaces"
// pop-up.  Shown when the SPA pre-checks the engine's publish quota
// and gets back `allowed: false, reason: "rate_limited"`.
//
// Why this exists: until this dialog landed, hitting the cap meant
// filling in the create-room / create-space form, hitting Submit,
// and getting a Synapse-side denial.  Frustrating.  Now we do the
// quota check the moment the user clicks the "+" button and surface
// the limit + ladder + retry-after up front.
//
// Educational, not punitive: the body explains the per-reputation-
// tier ladder so users understand what unlocks.  Same caps the
// engine actually enforces.

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { PublishQuota } from "@/lib/instance";

export interface PublishLimitDialogProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	quota: PublishQuota | null;
}

export function PublishLimitDialog({ open, onOpenChange, quota }: PublishLimitDialogProps) {
	if (!quota) return null;
	const noun = quota.kind === "space" ? "space" : "room";
	const nounPlural = quota.kind === "space" ? "spaces" : "rooms";
	const retryHours = quota.retry_after_sec
		? Math.max(1, Math.ceil(quota.retry_after_sec / 3600))
		: 24;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Daily {noun}-creation limit reached</DialogTitle>
					<DialogDescription>
						You&rsquo;ve created {quota.count} {quota.count === 1 ? noun : nounPlural} in the last 24 hours, which is the cap for your current reputation. The window is rolling — your next slot opens within ~{retryHours} {retryHours === 1 ? "hour" : "hours"}.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<div className="text-sm font-medium">How the cap scales</div>
					<div className="rounded-md border border-border overflow-hidden">
						<TierRow
							label="New"
							hint="Default for new accounts"
							cap="1 / 24h"
							active={quota.threshold === 1}
						/>
						<TierRow
							label="Active"
							hint="Posts + reactions earned"
							cap="3 / 24h"
							active={quota.threshold === 3}
							borderTop
						/>
						<TierRow
							label="Rooted"
							hint="Long-term contributor"
							cap="10 / 24h"
							active={quota.threshold === 10}
							borderTop
						/>
					</div>
					<p className="text-xs text-muted-foreground leading-relaxed">
						Rooms and spaces each have their own counter, so making a space doesn&rsquo;t use up your room quota and vice versa.
					</p>
				</div>

				<DialogFooter>
					<Button type="button" onClick={() => onOpenChange(false)}>OK</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function TierRow({
	label, hint, cap, active, borderTop,
}: {
	label: string;
	hint: string;
	cap: string;
	active: boolean;
	borderTop?: boolean;
}) {
	return (
		<div
			className={
				"flex items-center justify-between gap-3 px-3 py-2 " +
				(borderTop ? "border-t border-border " : "") +
				(active ? "bg-primary/10" : "")
			}
		>
			<div className="min-w-0">
				<div className="text-sm font-medium flex items-center gap-2">
					{label}
					{active && (
						<span className="text-[10px] uppercase tracking-wide text-primary bg-primary/15 px-1.5 py-0.5 rounded">
							You
						</span>
					)}
				</div>
				<div className="text-xs text-muted-foreground leading-snug">{hint}</div>
			</div>
			<div className="text-sm font-mono shrink-0">{cap}</div>
		</div>
	);
}

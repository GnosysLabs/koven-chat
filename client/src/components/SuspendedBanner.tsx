// Full-width banner shown across the top of the app when the engine
// reports the current account as suspended.  Two reasons surface here:
//
//   - floor_violation: someone reported one of this user's messages as
//     a serious-violation case (CSAM, credible threat, doxxing).  The
//     account is paused while an admin reviews.
//   - repeated_false_floor_flags: this user has had multiple of their
//     own floor-violation reports reversed by admins; the false-flag
//     threshold tripped, so the engine paused them pending review.
//
// In both cases the user can still read but can't compose, DM, or
// create rooms/spaces — the gating is enforced at the ChatPane and
// sheet entry-points.

import { ShieldAlert } from "lucide-react";
import type { SuspensionSummary } from "@/lib/instance";

export interface SuspendedBannerProps {
	suspension: SuspensionSummary;
}

export function SuspendedBanner({ suspension }: SuspendedBannerProps) {
	const created = new Date(suspension.created_at);
	const reasonText = suspension.reason === "floor_violation"
		? "A message you posted was reported as a serious violation (CSAM, credible threat, or doxxing)."
		: "Multiple of your own serious-violation reports have been overturned. Your account is paused while an admin reviews the pattern.";

	return (
		<div className="bg-destructive/15 border-b border-destructive/40 text-destructive">
			<div className="px-4 py-2.5 flex items-start gap-3">
				<ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
				<div className="flex-1 min-w-0 text-xs leading-snug">
					<div className="font-semibold mb-0.5">Account suspended pending review</div>
					<div className="text-destructive/90">
						{reasonText} You can still read, but posting, DMs, and room creation are paused. An admin will review and either restore your account or confirm a permanent ban.
					</div>
					<div className="text-destructive/70 mt-1">
						Suspended {created.toLocaleString()}.
					</div>
				</div>
			</div>
		</div>
	);
}

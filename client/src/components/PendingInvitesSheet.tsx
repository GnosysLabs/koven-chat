// Pending space invites surface: lists every pending space invite
// with full preview metadata (name, topic, avatar, inviter, member
// count) and per-row Accept / Decline buttons.
//
// Accept routes through the parent's `onAccept`, which is wired to
// the existing `acceptInviteWithGate` in App.tsx.  That helper
// surfaces the NSFW gate (NsfwAcceptDialog) when the invite is
// flagged NSFW and the viewer hasn't opted in, and runs the engine
// cascade-on-join via acceptInvite → joinSpaceWithChildren.  So
// from this sheet's perspective Accept is a single call and all the
// NSFW / cascade logic stays in one place.
//
// Decline calls `transport.declineInvite` (== `c.leave`), which is
// the Matrix-spec way to refuse an invite.  Idempotent.
//
// NSFW preview behaviour: when the viewer hasn't opted into NSFW
// content, NSFW invite rows hide the avatar + topic and replace the
// name with a generic "NSFW space" label.  The inviter mxid stays
// visible so the user can tell who's poking them.  This keeps the
// sheet from being a vector for attacker-named NSFW spaces leaking
// content to a non-NSFW viewer just because they opened the
// pending-invites surface.

import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { AlertTriangle, EyeOff, LayoutGrid, Users } from "lucide-react";
import type { SpaceInvite, SpaceId } from "@koven/shared";

export interface PendingInvitesSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	invites: SpaceInvite[];
	nsfwOptedIn: boolean;
	// Accept handler.  Parent wires this to acceptInviteWithGate so
	// the existing NSFW dialog + cascade-on-join pipeline still runs.
	// Awaited so the row can show a per-invite "Accepting…" state.
	onAccept(id: SpaceId): Promise<void> | void;
	// Decline handler.  Parent wires this to transport.declineInvite
	// (== Matrix leave from invite-state).  Idempotent on success.
	onDecline(id: SpaceId): Promise<void> | void;
}

export function PendingInvitesSheet({
	open, onOpenChange, invites, nsfwOptedIn, onAccept, onDecline,
}: PendingInvitesSheetProps) {
	// Per-row in-flight state so the user can see which Accept /
	// Decline call is running.  Keyed on space id; both buttons on
	// the same row read this so the entire row goes "Working…" while
	// either action is mid-flight.
	const [busyId, setBusyId] = useState<SpaceId | null>(null);

	async function handleAccept(id: SpaceId) {
		setBusyId(id);
		try {
			await onAccept(id);
		} finally {
			setBusyId(b => b === id ? null : b);
		}
	}

	async function handleDecline(id: SpaceId) {
		setBusyId(id);
		try {
			await onDecline(id);
		} finally {
			setBusyId(b => b === id ? null : b);
		}
	}

	// Auto-close when the last invite is processed away.  Caller
	// already controls the open prop based on invites.length, but
	// this guard keeps the dialog from staying open against an empty
	// list if the user accepted / declined every row.
	if (open && invites.length === 0) {
		queueMicrotask(() => onOpenChange(false));
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Pending space invites</DialogTitle>
					<DialogDescription>
						Accept to join the space and all of its rooms.  Decline to refuse.
					</DialogDescription>
				</DialogHeader>

				<ul className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
					{invites.map(invite => {
						const hideNsfwPreview = invite.isNsfw && !nsfwOptedIn;
						const displayName = hideNsfwPreview
							? "NSFW space"
							: invite.name;
						const showTopic = !hideNsfwPreview && invite.topic;
						const rowBusy = busyId === invite.id;

						return (
							<li
								key={invite.id}
								className="rounded-md border border-border bg-card/40 p-3"
							>
								<div className="flex items-start gap-3">
									{hideNsfwPreview ? (
										// Redacted avatar slot.  Same dimensions as
										// MatrixAvatar so the row height matches
										// the SFW case.  EyeOff icon signals "we're
										// deliberately not showing this until you
										// opt in," which the NSFW gate handles on
										// Accept.
										<div className="h-12 w-12 rounded-lg bg-muted flex items-center justify-center shrink-0">
											<EyeOff className="h-5 w-5 text-muted-foreground" />
										</div>
									) : (
										<MatrixAvatar
											mxc={invite.avatarUrl}
											seed={invite.id}
											kind="space"
											className="h-12 w-12 rounded-lg shrink-0"
										/>
									)}

									<div className="flex-1 min-w-0 space-y-1">
										<div className="flex items-center gap-2 flex-wrap">
											<span className="text-sm font-medium truncate">
												{displayName}
											</span>
											{invite.isNsfw && (
												<span className="text-[10px] font-semibold uppercase tracking-wide bg-orange-500/15 text-orange-500 px-1.5 py-0.5 rounded">
													NSFW
												</span>
											)}
										</div>

										<div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
											<LayoutGrid className="h-3 w-3" />
											<span>Space</span>
											{typeof invite.memberCount === "number" && (
												<>
													<span>·</span>
													<Users className="h-3 w-3" />
													<span>{invite.memberCount} member{invite.memberCount === 1 ? "" : "s"}</span>
												</>
											)}
										</div>

										{invite.inviter && (
											<div className="text-xs text-muted-foreground truncate">
												Invited by <span className="font-medium text-foreground/80">{invite.inviter}</span>
											</div>
										)}

										{showTopic && (
											<div className="text-xs text-muted-foreground line-clamp-2">
												{invite.topic}
											</div>
										)}

										{hideNsfwPreview && (
											<div className="text-xs text-muted-foreground flex items-start gap-1.5">
												<AlertTriangle className="h-3 w-3 mt-0.5 shrink-0 text-orange-500" />
												<span>
													This space is flagged as NSFW and you haven&apos;t opted in.
													The name, avatar, and topic are hidden until you accept.
												</span>
											</div>
										)}
									</div>
								</div>

								<div className="flex justify-end gap-2 mt-3">
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => handleDecline(invite.id)}
										disabled={rowBusy}
									>
										Decline
									</Button>
									<Button
										type="button"
										size="sm"
										onClick={() => handleAccept(invite.id)}
										disabled={rowBusy}
									>
										{rowBusy ? "Working…" : "Accept"}
									</Button>
								</div>
							</li>
						);
					})}
				</ul>
			</DialogContent>
		</Dialog>
	);
}

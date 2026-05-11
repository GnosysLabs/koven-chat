// Pre-join confirmation card for deep links.
//
// Opens when a user clicks a koven:// / Universal Link / invite URL
// targeting a space or room they aren't currently a member of.
// Shows whatever metadata we can pull from the local Matrix store
// or the homeserver's MSC3266 summary API so the user can see what
// they're being asked to join before committing.  Already-member
// cases skip this dialog entirely and navigate directly (the parent
// is responsible for the membership check before opening this).
//
// NSFW: when the target is flagged NSFW *and* the viewer hasn't
// opted into NSFW visibility, the card adds a warning line.  The
// existing nsfwGate state still runs for the matrix-side invite
// flow; this card is the deep-link mirror.
//
// Cancel exits without joining.  Join calls the parent's onConfirm
// which runs the actual joinRoomById / joinSpaceWithChildren +
// navigation.  Pending state is held by the parent because the
// join itself can take a second or two to round-trip Synapse +
// settle the space's child-room cascade.

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { AlertTriangle, Globe, Lock, Users } from "lucide-react";

export interface JoinConfirmSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	// Preview metadata — may be null when previewTarget couldn't
	// resolve anything (rare: federated rooms the local server has
	// no state for).  In that case we render a minimal card with
	// just the id so the user can decide whether to join blind.
	preview: {
		roomId: string;
		name: string;
		topic?: string;
		avatarUrl?: string;
		memberCount?: number;
		isSpace: boolean;
		nsfw?: boolean;
	} | null;
	// Raw id / alias from the URL — shown as the fallback name when
	// preview is null.
	fallbackId: string;
	// True while previewTarget is in flight.  When true the card
	// shows a skeleton so the user gets immediate feedback that the
	// click registered.
	loading: boolean;
	// True while the join itself is running.  Disables the Cancel
	// button (so we don't leave a half-joined state) and changes
	// the Join button label to "Joining…".
	joining: boolean;
	// Surface from the parent: the deep-link join can fail (private
	// rooms the user isn't allow-listed for, federation timeouts,
	// suspended users, …).  Caller passes the error string here; we
	// render it under the metadata block.
	error: string | null;
	// User has opted into NSFW visibility in their preferences.
	// Drives whether the NSFW warning is shown — opted-in users
	// don't need the extra friction since they've already accepted
	// NSFW content site-wide.
	nsfwOptedIn: boolean;
	onConfirm(): Promise<void> | void;
}

export function JoinConfirmSheet({
	open, onOpenChange, preview, fallbackId, loading, joining, error, nsfwOptedIn, onConfirm,
}: JoinConfirmSheetProps) {
	// Title + lead-in line.  Match the kind (space / room) we know
	// from preview when available, fall back to "this" when blind —
	// "Join this?" is awkward but better than misleadingly saying
	// "Join this room" for what might be a space.
	const isSpace = preview?.isSpace ?? false;
	const title = preview
		? (isSpace ? "Join this space?" : "Join this room?")
		: "Join this?";
	const displayName = preview?.name ?? fallbackId;
	const showNsfwWarn = preview?.nsfw === true && !nsfwOptedIn;

	return (
		<Dialog open={open} onOpenChange={(o) => { if (!o && !joining) onOpenChange(false); }}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>
						{preview
							? (isSpace
								? "You'll join this space and any channels inside it that you can see."
								: "You'll join this room and start receiving its messages.")
							: "Couldn't load preview details. You can still join, but you won't see the name or member count until you're in."}
					</DialogDescription>
				</DialogHeader>

				{/* Metadata block — avatar + name + member count.
				    Loading state uses pulse-skeletons so the layout
				    doesn't jump when real data lands. */}
				<div className="flex items-center gap-3 rounded-md border border-border p-3 bg-card/40">
					{loading ? (
						<>
							<div className="h-12 w-12 rounded-md bg-muted animate-pulse shrink-0" />
							<div className="flex-1 space-y-2 min-w-0">
								<div className="h-4 w-32 bg-muted animate-pulse rounded" />
								<div className="h-3 w-20 bg-muted animate-pulse rounded" />
							</div>
						</>
					) : (
						<>
							<MatrixAvatar
								mxc={preview?.avatarUrl}
								seed={preview?.roomId ?? fallbackId}
								kind={isSpace ? "space" : "room"}
								className={isSpace ? "h-12 w-12 rounded-lg" : "h-12 w-12 rounded-md"}
							/>
							<div className="flex-1 min-w-0">
								<div className="text-sm font-medium truncate">{displayName}</div>
								<div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
									{isSpace ? (
										<><Globe className="h-3 w-3" /> Space</>
									) : (
										<><Lock className="h-3 w-3" /> Room</>
									)}
									{typeof preview?.memberCount === "number" && (
										<>
											<span aria-hidden>·</span>
											<span className="inline-flex items-center gap-1">
												<Users className="h-3 w-3" />
												{preview.memberCount} {preview.memberCount === 1 ? "member" : "members"}
											</span>
										</>
									)}
								</div>
								{preview?.topic && (
									<div className="text-xs text-muted-foreground mt-1 line-clamp-2">
										{preview.topic}
									</div>
								)}
							</div>
						</>
					)}
				</div>

				{/* NSFW warning — only when target is flagged AND
				    viewer hasn't opted in.  Treated as informational
				    here; the Join button still works.  The viewer's
				    preference flips automatically after they confirm,
				    same shape as the matrix-invite NSFW gate. */}
				{showNsfwWarn && (
					<div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-500/90">
						<AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
						<div>
							<div className="font-medium">Marked as NSFW</div>
							<div className="text-amber-500/70 mt-0.5">Joining flips on NSFW visibility for your account.</div>
						</div>
					</div>
				)}

				{error && (
					<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
						{error}
					</div>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={joining}
					>
						Cancel
					</Button>
					<Button
						type="button"
						onClick={() => { void onConfirm(); }}
						disabled={joining || loading}
					>
						{joining ? "Joining…" : "Join"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}


// Right-sidebar profile panel that replaces the member list for DM
// rooms.  A DM has exactly two participants and the current user is
// already obvious — the only useful thing to show is the OTHER
// participant's identity + reputation, so we render it inline instead
// of a generic two-row member list.

import { useEffect, useState } from "react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { BotBadge } from "@/components/BotBadge";
import { useReputation } from "@/lib/useReputation";
import { descriptorFor, tickClassForFilled, ticksFor } from "@/lib/reputation";
import { fetchUserBio } from "@/lib/profile";
import { formatMxid, serverOf } from "@/lib/mxid";
import type { MatrixTransport } from "@/lib/matrix";
import type { UserId } from "@koven/shared";
import { AlertTriangle, Ban, Trash2, UserCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type DeleteProgressPhase = "paginating" | "redacting" | "kicking" | "cleanup";

export interface DmProfilePanelProps {
	otherUserId: UserId;
	transport: MatrixTransport | null;
	// Live ignore-list state so the block/unblock button reflects the
	// current m.ignored_user_list.  Updates as account_data syncs.
	ignoredUsers: Set<UserId>;
	// Click handler for the row, so the user can still open the full
	// profile dialog if they want.
	onOpenProfile(userId: UserId): void;
	// Delete this DM for BOTH parties: redact every message, kick the
	// other participant, then leave + forget + clear m.direct on our
	// side.  The optional progress callback lets the parent forward
	// per-phase updates so this panel's confirmation modal can show
	// "Deleting 142 / 5000" instead of a blank spinner on long
	// conversations.
	onDeleteDm(onProgress?: (phase: DeleteProgressPhase, done: number, total: number) => void): Promise<void>;
	// Whether the other user is a registered bot — drives the BOT
	// pill rendered next to their name and suppresses the reputation
	// block (bots don't accrue rep).
	isBot?: boolean;
}

export function DmProfilePanel({ otherUserId, transport, ignoredUsers, onOpenProfile, onDeleteDm, isBot }: DmProfilePanelProps) {
	// `userId` lives on the profile record so we can detect "the
	// cached profile is stale because we switched DMs" — without it,
	// switching from a DM with @alice to a DM with @bob would render
	// alice's avatar/name briefly before bob's fetch returns.
	const [profile, setProfile] = useState<{
		userId: UserId;
		displayName: string;
		avatarUrl?: string;
		homeserver: string;
	} | null>(null);
	const [bio, setBio] = useState("");
	// Confirmation modal state.  The button on the panel opens the
	// dialog; the dialog owns its own Confirm + Cancel buttons.  A
	// modal rather than inline because bilateral deletion is a
	// genuinely-irreversible action (every message redacted for the
	// other party, they get kicked) and the extra context of a
	// dedicated surface is worth the click.
	const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);
	// Progress reported from transport.deleteDm so the modal can show
	// the current phase + counter instead of a blind spinner on a
	// thousand-message DM.  Null while idle.
	const [deleteProgress, setDeleteProgress] = useState<{
		phase: DeleteProgressPhase;
		done: number;
		total: number;
	} | null>(null);
	const [blocking, setBlocking] = useState(false);
	const [blockError, setBlockError] = useState<string | null>(null);
	const isBlocked = ignoredUsers.has(otherUserId);

	useEffect(() => {
		if (!transport) return;
		let cancelled = false;
		// Stale-while-revalidate: only blank the profile when we're
		// switching to a DIFFERENT user.  Re-rendering for the same
		// user (e.g. ignoredUsers updated) keeps the existing data on
		// screen so the right pane doesn't blink.
		if (profile?.userId !== otherUserId) {
			setProfile(null);
			setBio("");
		}
		// Matrix profile (display name, avatar) and engine bio in
		// parallel — they're independent calls and showing one without
		// the other is fine if the slower one fails.
		Promise.all([
			transport.getUserProfile(otherUserId).catch(() => null),
			fetchUserBio(otherUserId).catch(() => ""),
		]).then(([p, fetchedBio]) => {
			if (cancelled) return;
			setProfile({
				userId: otherUserId,
				displayName: p?.displayName ?? otherUserId,
				avatarUrl: p?.avatarUrl,
				homeserver: p?.homeserver ?? "",
			});
			setBio(fetchedBio);
		});
		return () => { cancelled = true; };
		// `profile?.userId` is read for the staleness check but
		// shouldn't drive re-runs — the effect already retriggers on
		// otherUserId change, which is the only thing that should
		// invalidate the cached profile.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [otherUserId, transport]);

	// Reset the dialog state when the DM target changes, switching to
	// a different DM should never inherit a half-armed delete.
	useEffect(() => {
		setDeleteDialogOpen(false);
		setDeleting(false);
		setDeleteProgress(null);
	}, [otherUserId]);

	async function doDelete() {
		setDeleting(true);
		setDeleteProgress({ phase: "paginating", done: 0, total: 0 });
		try {
			await onDeleteDm((phase, done, total) => {
				setDeleteProgress({ phase, done, total });
			});
		} finally {
			setDeleting(false);
			setDeleteProgress(null);
			setDeleteDialogOpen(false);
		}
	}

	async function toggleBlock() {
		if (!transport) return;
		setBlocking(true);
		setBlockError(null);
		try {
			if (isBlocked) {
				await transport.unignoreUser(otherUserId);
			} else {
				await transport.ignoreUser(otherUserId);
			}
			// Parent's ignoredUsers state updates via the transport's
			// account_data subscription — no need to flip local state.
		} catch (err) {
			setBlockError(err instanceof Error ? err.message : String(err));
		} finally {
			setBlocking(false);
		}
	}

	// Pre-load: render the chrome but no body content.  Without this
	// gate, the panel would paint with a DiceBear avatar (because
	// `profile?.avatarUrl` is undefined while the fetch is pending),
	// the mxid as the display name, and "Reputation unavailable."
	// for the rep block — then snap to the real values once
	// Promise.all resolves.  Holding back the body avoids that
	// triple-flash.  The avatar/name still render once `profile` is
	// non-null AND matches the current `otherUserId` — same gate
	// keeps stale values off-screen during DM switches.
	const haveProfile = !!profile && profile.userId === otherUserId;

	return (
		<aside className="w-56 border-l border-border bg-card flex flex-col">
			<div className="px-4 h-12 flex items-center border-b border-border">
				<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
					Profile
				</span>
			</div>
			<div className="flex-1 overflow-y-auto p-4">
				{haveProfile && (<>
				<button
					type="button"
					onClick={() => onOpenProfile(otherUserId)}
					className="w-full flex flex-col items-center text-center gap-3 group"
				>
					<MatrixAvatar
						mxc={profile?.avatarUrl}
						seed={otherUserId}
						kind={isBot ? "bot" : "user"}
						className="h-20 w-20 group-hover:ring-2 group-hover:ring-primary/40 transition-all"
					/>
					<div className="min-w-0 max-w-full">
						<div className="text-sm font-semibold truncate group-hover:text-primary transition-colors flex items-center justify-center gap-1.5">
							<span className="truncate">{profile?.displayName ?? otherUserId}</span>
							{isBot && <BotBadge compact={false} />}
						</div>
						<div className="text-[10px] text-muted-foreground font-mono truncate" title={otherUserId}>
							{formatMxid(otherUserId, serverOf(transport?.currentUserId ?? null))}
						</div>
					</div>
				</button>

				{bio.trim() && (
					<p className="mt-4 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
						{bio}
					</p>
				)}

				{!isBot && (
					<div className="mt-5 pt-4 border-t border-border">
						<ReputationBlock userId={otherUserId} />
					</div>
				)}

				<div className="mt-5 pt-4 border-t border-border">
					<button
						type="button"
						onClick={toggleBlock}
						disabled={blocking}
						className={cn(
							"w-full flex items-center justify-center gap-2 px-2 py-1.5 rounded text-xs transition-colors",
							isBlocked
								? "text-muted-foreground hover:text-foreground hover:bg-accent"
								: "text-muted-foreground hover:text-destructive hover:bg-destructive/10",
							"disabled:opacity-50 disabled:cursor-not-allowed",
						)}
					>
						{isBlocked ? (
							<>
								<UserCheck className="h-3.5 w-3.5" />
								Unblock user
							</>
						) : (
							<>
								<Ban className="h-3.5 w-3.5" />
								Block user
							</>
						)}
					</button>
					{blockError && (
						<p className="mt-1.5 text-[10px] text-destructive leading-snug px-1">
							{blockError}
						</p>
					)}
				</div>

				<div className="mt-2">
					<button
						type="button"
						onClick={() => setDeleteDialogOpen(true)}
						className={cn(
							"w-full flex items-center justify-center gap-2 px-2 py-1.5 rounded text-xs",
							"text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors",
						)}
					>
						<Trash2 className="h-3.5 w-3.5" />
						Delete conversation
					</button>
				</div>

				<DeleteConversationDialog
					open={deleteDialogOpen}
					onOpenChange={(o) => {
						// Don't let the user close mid-delete.  Cleanup in
						// doDelete's finally clears the dialog itself.
						if (!o && deleting) return;
						setDeleteDialogOpen(o);
					}}
					otherDisplayName={profile?.displayName ?? otherUserId}
					deleting={deleting}
					progress={deleteProgress}
					onConfirm={doDelete}
				/>
				</>)}
			</div>
		</aside>
	);
}

function ReputationBlock({ userId }: { userId: string }) {
	const rep = useReputation(userId);
	// While the reputation hook is still resolving, render nothing
	// rather than flashing "Reputation unavailable." — the engine
	// usually responds within ~50ms, so the flash is annoyingly
	// visible.  The italic-fallback text only really applies to a
	// genuine engine outage; that case will rectify on the next
	// hook re-fetch and is rare enough we accept a momentary blank
	// over a wrong-looking "unavailable" pop-in.
	if (!rep) {
		return null;
	}
	const desc = descriptorFor(rep.weight);
	// Floor → 0 ticks (brand-new user just past 0.5); cap → 5.
	// ticksFor() rounds to 2 decimals before flooring so the count
	// always agrees with the displayed `weight.toFixed(2)`.
	const filled = ticksFor(rep.weight);
	return (
		<div className="space-y-2">
			<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
				Reputation
			</div>
			<div className="flex items-center gap-2">
				<LevelTicks filled={filled} total={5} tickClass={tickClassForFilled(filled)} />
				<span className="text-xs font-medium">{desc.label}</span>
				<span className="text-[10px] text-muted-foreground tabular-nums ml-auto">
					{rep.weight.toFixed(2)}
				</span>
			</div>
			<dl className="flex flex-col gap-1.5">
				<MetricCell label="Posts" sub="30d" value={String(rep.posts_30d ?? 0)} />
				<MetricCell label="Reactions" sub="90d" value={String(rep.reactions_90d ?? 0)} />
				<MetricCell label="Age" sub="days" value={rep.age_days !== undefined ? rep.age_days.toFixed(1) : "—"} />
			</dl>
		</div>
	);
}

function LevelTicks({ filled, total, tickClass }: { filled: number; total: number; tickClass: string }) {
	return (
		<span className="inline-flex items-end gap-px">
			{Array.from({ length: total }).map((_, i) => (
				<span
					key={i}
					className={`w-[3px] rounded-[1px] ${
						i === 0 ? "h-2"
							: i === 1 ? "h-2.5"
							: i === 2 ? "h-3"
							: i === 3 ? "h-3.5"
							: "h-4"
					} ${i < filled ? tickClass : "bg-muted-foreground/25"}`}
				/>
			))}
		</span>
	);
}

function DeleteConversationDialog({
	open,
	onOpenChange,
	otherDisplayName,
	deleting,
	progress,
	onConfirm,
}: {
	open: boolean;
	onOpenChange(open: boolean): void;
	otherDisplayName: string;
	deleting: boolean;
	progress: { phase: DeleteProgressPhase; done: number; total: number } | null;
	onConfirm(): void | Promise<void>;
}) {
	// Status copy.  The work is now a single server-side purge call
	// (engine /api/dm/delete) instead of a client-side paginate +
	// per-event redact loop, so a per-event counter would be
	// meaningless: the round-trip is one HTTP call, the rest is
	// trivial cache cleanup.  Just narrate the two coarse stages.
	let statusLine: string | null = null;
	if (progress) {
		statusLine = progress.phase === "cleanup"
			? "Finishing up…"
			: "Deleting conversation…";
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<AlertTriangle className="h-4 w-4 text-destructive" />
						Delete this conversation?
					</DialogTitle>
					<DialogDescription>
						This deletes the conversation for BOTH you and {otherDisplayName}.
					</DialogDescription>
				</DialogHeader>

				<ul className="text-xs text-muted-foreground space-y-1.5 list-disc list-inside leading-relaxed">
					<li>Every message in this DM is redacted on the server.  Their content is wiped from both sides.</li>
					<li>{otherDisplayName} is removed from the conversation.  It disappears from their conversation list too.</li>
					<li>This <strong className="text-foreground">cannot be undone</strong>.  Sent media is unrecoverable once redacted.</li>
				</ul>

				{statusLine && (
					<div className="text-xs text-muted-foreground border border-border rounded-md px-3 py-2 bg-muted/40">
						{statusLine}
					</div>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={deleting}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						onClick={onConfirm}
						disabled={deleting}
					>
						{deleting ? "Deleting…" : "Delete for both"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function MetricCell({ label, sub, value }: { label: string; sub: string; value: string }) {
	return (
		<div className="flex items-baseline justify-between rounded-md bg-muted/40 border border-border px-2.5 py-1.5">
			<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
				{label}
				<span className="lowercase font-normal text-muted-foreground/70"> · {sub}</span>
			</div>
			<div className="text-sm font-semibold tabular-nums">{value}</div>
		</div>
	);
}

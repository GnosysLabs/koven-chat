// Profile sheet — used for two distinct cases:
//   1. The current user views/edits their own profile (display name,
//      bio, avatar are editable; metadata + reputation read-only).
//   2. The current user views another member's profile from the
//      MemberList (everything read-only; bio is omitted because it's
//      stored in account_data and isn't readable across users).
//
// The mode is determined by `viewedUserId` against the transport's
// current user — same component, two paint passes.

import { useEffect, useMemo, useRef, useState } from "react";
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
import { Ban, Camera, Trash2, UserCheck } from "lucide-react";
import type { MatrixTransport } from "@/lib/matrix";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { useReputation } from "@/lib/useReputation";
import { descriptorFor, nextTierUnlockLabel, tickClassForFilled, ticksFor } from "@/lib/reputation";
import { fetchUserBio, updateMyBio } from "@/lib/profile";
import type { UserId } from "@koven/shared";

export interface ProfileSheetProps {
	// User whose profile is being shown.  `null` keeps the dialog closed.
	// When this matches the transport's current user, the sheet renders
	// in editable mode; otherwise read-only.
	viewedUserId: UserId | null;
	onClose(): void;
	transport: MatrixTransport | null;
	// Matrix access token for the current user — needed to save bio
	// changes via the engine in self-edit mode.
	accessToken?: string | null;
	// Live ignore-list state.  Drives the block/unblock affordance in
	// read-only mode; ignored entirely when isSelf.
	ignoredUsers?: Set<UserId>;
	// Self-edit callback: fires after a successful save with the new
	// avatar mxc (string), null if cleared, or undefined if untouched.
	// App.tsx uses this to update the SpaceBar tile without refresh.
	onSelfProfileSaved?(avatarMxc: string | null | undefined): void;
}

interface BaseProfile {
	userId: string;
	displayName: string;
	avatarUrl?: string;
	homeserver: string;
}

export function ProfileSheet({ viewedUserId, onClose, transport, accessToken, ignoredUsers, onSelfProfileSaved }: ProfileSheetProps) {
	const isSelf = useMemo(() => {
		if (!viewedUserId || !transport) return false;
		return transport.currentUserId === viewedUserId;
	}, [viewedUserId, transport]);

	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [blocking, setBlocking] = useState(false);
	const isBlocked = !!(viewedUserId && ignoredUsers?.has(viewedUserId));

	const [profile, setProfile] = useState<BaseProfile | null>(null);
	const [displayName, setDisplayName] = useState("");
	const [bio, setBio] = useState("");

	// Avatar state: existing URL we render unless replaced by a fresh
	// upload (kept as a File until Save), or cleared.
	const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
	const [pendingAvatarPreview, setPendingAvatarPreview] = useState<string | null>(null);
	const [clearAvatar, setClearAvatar] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	const open = !!viewedUserId;

	useEffect(() => {
		if (!open || !transport || !viewedUserId) return;
		let cancelled = false;
		setLoading(true);
		setError(null);
		setPendingAvatar(null);
		setPendingAvatarPreview(null);
		setClearAvatar(false);

		// Matrix profile (display name, avatar) and engine bio fetched
		// in parallel — bio lives on the engine since Matrix has no
		// public-bio field, so we get it from a separate call regardless
		// of self-vs-other.
		const matrixFetcher = isSelf
			? transport.getMyProfile()
			: transport.getUserProfile(viewedUserId as UserId);

		Promise.all([matrixFetcher, fetchUserBio(viewedUserId)])
			.then(([p, fetchedBio]) => {
				if (cancelled) return;
				setProfile(p);
				setDisplayName(p.displayName);
				setBio(fetchedBio);
				setLoading(false);
			})
			.catch(err => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			});
		return () => { cancelled = true; };
	}, [open, transport, viewedUserId, isSelf]);

	// Clean up object URLs we made for previews.
	useEffect(() => {
		return () => {
			if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview);
		};
	}, [pendingAvatarPreview]);

	function pickAvatar(file: File) {
		if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview);
		setPendingAvatar(file);
		setPendingAvatarPreview(URL.createObjectURL(file));
		setClearAvatar(false);
	}

	async function toggleBlock() {
		if (!transport || !viewedUserId || isSelf) return;
		setBlocking(true);
		setError(null);
		try {
			if (isBlocked) {
				await transport.unignoreUser(viewedUserId);
			} else {
				await transport.ignoreUser(viewedUserId);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBlocking(false);
		}
	}

	async function save() {
		if (!transport || !isSelf) return;
		setPending(true);
		setError(null);
		try {
			const { avatarUrl } = await transport.updateMyProfile({
				displayName: displayName.trim(),
				avatarFile: pendingAvatar ?? undefined,
				clearAvatar: !pendingAvatar && clearAvatar,
			});
			// Bio lives on the engine — saved separately, requires the
			// Matrix token so the engine can verify ownership via whoami.
			if (accessToken) {
				await updateMyBio(accessToken, bio.trim());
			}
			onSelfProfileSaved?.(avatarUrl);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	const hasRealAvatar = !!(pendingAvatarPreview || (!clearAvatar && profile?.avatarUrl));

	return (
		<Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
			<DialogContent className={isSelf ? "sm:max-w-lg" : "sm:max-w-md"}>
				<DialogHeader>
					<DialogTitle>{isSelf ? "Profile" : "Member"}</DialogTitle>
					<DialogDescription>
						{isSelf
							? "Visible to anyone you share a room with."
							: profile?.userId ?? "Loading…"}
					</DialogDescription>
				</DialogHeader>

				{loading || !profile ? (
					<div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
				) : isSelf ? (
					// ─── Self-edit layout ──────────────────────────────────
					// Two-column: avatar/buttons on the left, name + bio on
					// the right.  Metadata sits below in another two-column
					// grid so the dialog fits without scrolling on most
					// laptop screens.
					<div className="space-y-4">
						<div className="grid grid-cols-[auto_1fr] gap-5">
							<div className="flex flex-col items-center gap-2">
								{pendingAvatarPreview ? (
									<img
										src={pendingAvatarPreview}
										alt=""
										className="h-20 w-20 rounded-full object-cover bg-muted"
									/>
								) : (
									<MatrixAvatar
										mxc={clearAvatar ? undefined : profile.avatarUrl}
										seed={profile.userId}
										className="h-20 w-20"
									/>
								)}
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => fileInputRef.current?.click()}
								>
									<Camera className="h-3.5 w-3.5 mr-1.5" />
									{hasRealAvatar ? "Change" : "Upload"}
								</Button>
								{hasRealAvatar ? (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="text-muted-foreground hover:text-destructive h-7"
										onClick={() => {
											if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview);
											setPendingAvatar(null);
											setPendingAvatarPreview(null);
											setClearAvatar(true);
										}}
									>
										<Trash2 className="h-3.5 w-3.5 mr-1.5" />
										Remove
									</Button>
								) : (
									<span className="text-[10px] text-muted-foreground italic text-center max-w-[88px] leading-snug">
										Auto-generated
									</span>
								)}
							</div>

							<div className="space-y-3 min-w-0">
								<div className="space-y-1.5">
									<Label htmlFor="profile-displayname">Display name</Label>
									<Input
										id="profile-displayname"
										value={displayName}
										onChange={(e) => setDisplayName(e.target.value)}
										maxLength={100}
										placeholder="Your name"
									/>
									<div className="text-[10px] font-mono text-muted-foreground truncate">
										{profile.userId}
									</div>
								</div>

								<div className="space-y-1.5">
									<Label htmlFor="profile-bio">Bio <span className="text-muted-foreground font-normal">(optional)</span></Label>
									<textarea
										id="profile-bio"
										value={bio}
										onChange={(e) => setBio(e.target.value)}
										maxLength={300}
										rows={2}
										placeholder="A line or two about yourself"
										className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
									/>
									<div className="text-[10px] text-muted-foreground text-right tabular-nums">
										{bio.length} / 300
									</div>
								</div>
							</div>

							<input
								ref={fileInputRef}
								type="file"
								accept="image/*"
								className="hidden"
								onChange={(e) => {
									const file = e.target.files?.[0];
									if (file) pickAvatar(file);
									e.target.value = "";
								}}
							/>
						</div>

						{/* Reputation gets the full row now that user id lives
						    inline under the display name and the Status
						    placeholder is gone. */}
						<div className="pt-3 border-t border-border">
							<ReputationRow userId={profile.userId} isSelf />
						</div>

						{error && (
							<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
								{error}
							</div>
						)}
					</div>
				) : (
					// ─── Read-only member view ────────────────────────────
					// Compact single-column — there's no editing surface
					// here, so the layout stays narrow and quick to scan.
					<div className="space-y-4">
						<div className="flex items-center gap-4">
							<MatrixAvatar
								mxc={profile.avatarUrl}
								seed={profile.userId}
								className="h-16 w-16"
							/>
							<div className="min-w-0 flex-1">
								<div className="text-base font-semibold truncate">{profile.displayName}</div>
								<div className="text-xs text-muted-foreground font-mono truncate">{profile.userId}</div>
							</div>
						</div>

						{bio.trim() && (
							<p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
								{bio}
							</p>
						)}

						<div className="pt-2 border-t border-border">
							<ReputationRow userId={profile.userId} />
						</div>

						{error && (
							<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
								{error}
							</div>
						)}
					</div>
				)}

				<DialogFooter>
					{!isSelf && viewedUserId && (
						<Button
							type="button"
							variant="ghost"
							onClick={toggleBlock}
							disabled={blocking || loading}
							className={isBlocked ? "text-muted-foreground" : "text-destructive hover:text-destructive"}
						>
							{isBlocked ? (
								<><UserCheck className="h-3.5 w-3.5 mr-1.5" />{blocking ? "Unblocking…" : "Unblock"}</>
							) : (
								<><Ban className="h-3.5 w-3.5 mr-1.5" />{blocking ? "Blocking…" : "Block"}</>
							)}
						</Button>
					)}
					<Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
						{isSelf ? "Cancel" : "Close"}
					</Button>
					{isSelf && (
						<Button type="button" onClick={save} disabled={loading || pending}>
							{pending ? "Saving…" : "Save"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// Reputation breakdown — vertical-tick level meter (matching the
// sidebar visual), tier label, weight, then a clean key/value list of
// the underlying counters.  Description sits below as muted context.
//
// When viewing your own profile we also show how long until the next
// age-gate unlocks (omitted on others' profiles — feels like
// surveillance to call out where someone is on their tier ladder).
//
// Falls back to a one-liner if the engine hasn't returned data yet.
function ReputationRow({ userId, isSelf }: { userId: string; isSelf?: boolean }) {
	const rep = useReputation(userId);
	if (!rep) {
		return (
			<div className="flex items-baseline justify-between gap-3 text-xs">
				<span className="text-muted-foreground">Reputation</span>
				<span className="text-muted-foreground italic">Engine offline</span>
			</div>
		);
	}
	const desc = descriptorFor(rep.weight);
	// Floor 0: brand-new users at weight 0.5 see zero ticks filled.
	// ticksFor() rounds to 2 decimals before flooring so the count
	// always agrees with the displayed `weight.toFixed(2)`.
	const filled = ticksFor(rep.weight);
	const unlockLabel = isSelf ? nextTierUnlockLabel(rep.age_days) : null;

	return (
		<div className="space-y-2">
			<div className="text-xs text-muted-foreground">Reputation</div>
			<div className="flex items-center gap-2.5 flex-wrap">
				<LevelTicks filled={filled} total={5} tickClass={tickClassForFilled(filled)} />
				<span className="font-medium text-sm">{desc.label}</span>
				<span className="text-xs text-muted-foreground tabular-nums">{rep.weight.toFixed(2)}</span>
				{unlockLabel && (
					<span className="text-[11px] text-muted-foreground italic">
						· {unlockLabel}
					</span>
				)}
			</div>
			<dl className="grid grid-cols-3 gap-2 text-[11px]">
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

function MetricCell({ label, sub, value }: { label: string; sub: string; value: string }) {
	return (
		<div className="rounded-md bg-muted/40 border border-border px-2 py-1.5">
			<div className="text-[10px] uppercase tracking-wide text-muted-foreground">
				{label} <span className="lowercase font-normal">· {sub}</span>
			</div>
			<div className="text-sm font-semibold tabular-nums">{value}</div>
		</div>
	);
}

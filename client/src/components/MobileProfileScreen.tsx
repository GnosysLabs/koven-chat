// MobileProfileScreen — iOS HIG push view for the user's own
// profile.  Read mode by default; flips into edit mode via the
// nav-bar "Edit" action.  Edit mode's nav bar swaps to
// "Cancel" / "Save" (Save bolded only when there are unsaved
// changes), per iOS Settings / Contacts convention.
//
// Mirrors ProfileSheet's self-edit data flow (Matrix profile +
// engine bio fetched in parallel, save touches both endpoints),
// but renders as a full push view rather than a centred dialog —
// the dialog form factor is desktop-only after this rewrite.

import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Trash2 } from "lucide-react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { FounderBadge } from "@/components/FounderBadge";
import { getFounderCap } from "@/lib/founders-cache";
import { fetchUserProfile, updateMyBio } from "@/lib/profile";
import { hapticImpact, hapticSelection } from "@/lib/haptics";
import type { MatrixTransport } from "@/lib/matrix";
import type { UserId } from "@koven/shared";
import { cn } from "@/lib/utils";
import {
	NavBar,
	NavBackButton,
	NavTextButton,
	GroupLabel,
	GroupCard,
	ErrorBanner,
} from "@/components/mobile/Chrome";

export interface MobileProfileScreenProps {
	transport: MatrixTransport | null;
	accessToken: string | null;
	userId: UserId;
	onBack(): void;
	// Fired after a successful save so the parent can refresh the
	// SpaceBar tile / Me hero without a round-trip.
	onSaved?(avatarMxc: string | null | undefined): void;
}

interface BaseProfile {
	userId: string;
	displayName: string;
	avatarUrl?: string;
	homeserver: string;
}

export function MobileProfileScreen({
	transport,
	accessToken,
	userId,
	onBack,
	onSaved,
}: MobileProfileScreenProps) {
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const [profile, setProfile] = useState<BaseProfile | null>(null);
	const [displayName, setDisplayName] = useState("");
	const [bio, setBio] = useState("");
	const [founderNumber, setFounderNumber] = useState<number | null>(null);

	// Originals captured per-fetch so Cancel reverts to the
	// last-saved (or last-loaded) state without a re-fetch.
	const originalDisplayNameRef = useRef("");
	const originalBioRef = useRef("");

	// Pending avatar — kept in component state until Save commits it
	// via transport.updateMyProfile.  `clearAvatar` flag covers the
	// "Remove" case (no file picked, but we want to null out the
	// current avatar).
	const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
	const [pendingAvatarPreview, setPendingAvatarPreview] = useState<string | null>(null);
	const [clearAvatar, setClearAvatar] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	// Fetch on mount.  We bind cancel so a fast back-press doesn't
	// land the state setters on an unmounted screen.
	useEffect(() => {
		if (!transport) return;
		let cancelled = false;
		setLoading(true);
		setError(null);
		Promise.all([transport.getMyProfile(), fetchUserProfile(userId)])
			.then(([p, fp]) => {
				if (cancelled) return;
				setProfile(p);
				setDisplayName(p.displayName);
				setBio(fp.bio);
				setFounderNumber(fp.founder_number);
				originalDisplayNameRef.current = p.displayName;
				originalBioRef.current = fp.bio;
				setLoading(false);
			})
			.catch(err => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			});
		return () => { cancelled = true; };
	}, [transport, userId]);

	useEffect(() => {
		return () => {
			if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview);
		};
	}, [pendingAvatarPreview]);

	const dirty = useMemo(() => {
		if (!profile) return false;
		if (displayName.trim() !== originalDisplayNameRef.current.trim()) return true;
		if (bio.trim() !== originalBioRef.current.trim()) return true;
		if (pendingAvatar) return true;
		if (clearAvatar) return true;
		return false;
	}, [profile, displayName, bio, pendingAvatar, clearAvatar]);

	function pickAvatar(file: File) {
		if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview);
		setPendingAvatar(file);
		setPendingAvatarPreview(URL.createObjectURL(file));
		setClearAvatar(false);
	}

	function enterEdit() {
		void hapticSelection();
		setEditing(true);
	}

	function cancelEdit() {
		void hapticSelection();
		setDisplayName(originalDisplayNameRef.current);
		setBio(originalBioRef.current);
		if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview);
		setPendingAvatar(null);
		setPendingAvatarPreview(null);
		setClearAvatar(false);
		setError(null);
		setEditing(false);
	}

	async function save() {
		if (!transport) return;
		void hapticImpact("medium");
		setPending(true);
		setError(null);
		try {
			const { avatarUrl } = await transport.updateMyProfile({
				displayName: displayName.trim(),
				avatarFile: pendingAvatar ?? undefined,
				clearAvatar: !pendingAvatar && clearAvatar,
			});
			if (accessToken) {
				await updateMyBio(accessToken, bio.trim());
			}
			onSaved?.(avatarUrl);
			setProfile(prev => prev ? {
				...prev,
				displayName: displayName.trim(),
				avatarUrl: pendingAvatar
					? avatarUrl ?? prev.avatarUrl
					: clearAvatar
						? undefined
						: prev.avatarUrl,
			} : prev);
			originalDisplayNameRef.current = displayName.trim();
			originalBioRef.current = bio.trim();
			if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview);
			setPendingAvatar(null);
			setPendingAvatarPreview(null);
			setClearAvatar(false);
			setEditing(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	const hasRealAvatar = !!(pendingAvatarPreview || (!clearAvatar && profile?.avatarUrl));

	return (
		<div className="flex flex-col h-full">
			{/* iOS-style nav bar — 44pt content + safe-area-inset-top,
			    translucent material matching the rest of the mobile
			    chrome.  Left / centre / right slots; in edit mode the
			    left slot swaps from a back chevron to a Cancel button
			    and the right slot from Edit to Save. */}
			<NavBar
				left={editing
					? <NavTextButton label="Cancel" onClick={cancelEdit} disabled={pending} />
					: <NavBackButton onClick={() => { void hapticSelection(); onBack(); }} />
				}
				title={editing ? "Edit Profile" : "Profile"}
				right={editing
					? <NavTextButton
						label={pending ? "Saving…" : "Save"}
						onClick={save}
						disabled={!dirty || pending || loading}
						bold
					/>
					: <NavTextButton label="Edit" onClick={enterEdit} disabled={loading} />
				}
			/>

			<div className="flex-1 overflow-y-auto pb-10">
				{loading || !profile ? (
					<div className="flex items-center justify-center pt-24 text-[15px] text-muted-foreground">
						Loading…
					</div>
				) : !editing ? (
					/* ─── Read mode ─────────────────────────────────── */
					<div>
						<div className="flex flex-col items-center px-5 pt-6 pb-7 gap-3">
							<MatrixAvatar
								mxc={profile.avatarUrl}
								seed={profile.userId}
								kind="user"
								className="h-28 w-28 rounded-full ring-1 ring-foreground/10"
							/>
							<div className="flex flex-col items-center gap-1 max-w-full">
								<div className="text-[22px] font-semibold tracking-[-0.01em] text-foreground leading-tight text-center px-4 max-w-[320px] break-words">
									{profile.displayName}
								</div>
								<div className="text-[13px] text-muted-foreground font-mono truncate max-w-[280px]">
									{profile.userId}
								</div>
								{founderNumber !== null && (
									<div className="mt-1.5">
										<FounderBadge
											number={founderNumber}
											cap={getFounderCap()}
											variant="profile"
										/>
									</div>
								)}
							</div>
						</div>

						{bio.trim() ? (
							<>
								<GroupLabel>Bio</GroupLabel>
								<GroupCard>
									<div className="px-4 py-3 text-[15px] leading-relaxed text-foreground whitespace-pre-wrap">
										{bio}
									</div>
								</GroupCard>
							</>
						) : null}

						<GroupLabel>{bio.trim() ? "Visibility" : "Profile"}</GroupLabel>
						<GroupCard>
							<div className="px-4 py-3 text-[13px] leading-snug text-muted-foreground">
								Visible to anyone you share a room with. Tap Edit to change your display name, bio, or avatar.
							</div>
						</GroupCard>
					</div>
				) : (
					/* ─── Edit mode ─────────────────────────────────── */
					<div>
						{/* Avatar editor — centred large preview, with
						    Change / Remove rendered as text buttons
						    underneath in the system tint.  No nested
						    card; matches iOS Contacts edit form. */}
						<div className="flex flex-col items-center px-5 pt-6 pb-5 gap-3">
							{pendingAvatarPreview ? (
								<img
									src={pendingAvatarPreview}
									alt=""
									className="h-28 w-28 rounded-full object-cover ring-1 ring-foreground/10"
								/>
							) : (
								<MatrixAvatar
									mxc={clearAvatar ? undefined : profile.avatarUrl}
									seed={profile.userId}
									kind="user"
									className="h-28 w-28 rounded-full ring-1 ring-foreground/10"
								/>
							)}
							<div className="flex items-center gap-5">
								<button
									type="button"
									onClick={() => { void hapticSelection(); fileInputRef.current?.click(); }}
									className="inline-flex items-center gap-1.5 text-[15px] font-medium text-primary active:opacity-60 transition-opacity"
								>
									<Camera className="h-4 w-4" strokeWidth={2.25} />
									{hasRealAvatar ? "Change Photo" : "Add Photo"}
								</button>
								{hasRealAvatar && (
									<button
										type="button"
										onClick={() => {
											void hapticSelection();
											if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview);
											setPendingAvatar(null);
											setPendingAvatarPreview(null);
											setClearAvatar(true);
										}}
										className="inline-flex items-center gap-1.5 text-[15px] font-medium text-destructive active:opacity-60 transition-opacity"
									>
										<Trash2 className="h-4 w-4" strokeWidth={2.25} />
										Remove
									</button>
								)}
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

						<GroupLabel>Display Name</GroupLabel>
						<GroupCard>
							<input
								type="text"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								maxLength={100}
								placeholder="Your name"
								className={cn(
									"w-full px-4 py-3 bg-transparent",
									"text-[17px] text-foreground placeholder:text-muted-foreground",
									"focus:outline-none",
								)}
								autoCapitalize="words"
								autoCorrect="off"
								spellCheck={false}
							/>
						</GroupCard>

						<GroupLabel>Bio</GroupLabel>
						<GroupCard>
							<textarea
								value={bio}
								onChange={(e) => setBio(e.target.value)}
								maxLength={300}
								rows={3}
								placeholder="A line or two about yourself"
								className={cn(
									"w-full px-4 py-3 bg-transparent",
									"text-[17px] text-foreground placeholder:text-muted-foreground",
									"focus:outline-none resize-none",
								)}
							/>
							<div className="px-4 pb-2 text-[11px] text-muted-foreground text-right tabular-nums">
								{bio.length} / 300
							</div>
						</GroupCard>

						<GroupLabel>Matrix ID</GroupLabel>
						<GroupCard>
							<div className="px-4 py-3 text-[15px] text-muted-foreground font-mono break-all">
								{profile.userId}
							</div>
						</GroupCard>
					</div>
				)}

				{error && <ErrorBanner message={error} />}
			</div>
		</div>
	);
}


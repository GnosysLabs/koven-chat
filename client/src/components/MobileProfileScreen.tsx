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
import { Camera, Image as ImageIcon, Trash2 } from "lucide-react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { ProfileBanner } from "@/components/ProfileBanner";
import { FounderBadge } from "@/components/FounderBadge";
import { getFounderCap } from "@/lib/founders-cache";
import { fetchUserProfile, updateMyProfileData, type SocialLink } from "@/lib/profile";
import { SOCIAL_PLATFORMS, PLATFORM_PLACEHOLDERS, SocialIcon } from "@/components/SocialIcons";
import { hapticImpact, hapticNotification } from "@/lib/haptics";
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
	const [socialLinks, setSocialLinks] = useState<SocialLink[]>([]);
	const [founderNumber, setFounderNumber] = useState<number | null>(null);

	// Originals captured per-fetch so Cancel reverts to the
	// last-saved (or last-loaded) state without a re-fetch.
	const originalDisplayNameRef = useRef("");
	const originalBioRef = useRef("");
	const originalSocialLinksRef = useRef<SocialLink[]>([]);

	// Inline "add link" form state for the edit mode links section.
	const [addLinkOpen, setAddLinkOpen] = useState(false);
	const [newLinkPlatform, setNewLinkPlatform] = useState(SOCIAL_PLATFORMS[0].id);
	const [newLinkUrl, setNewLinkUrl] = useState("");

	// Pending avatar — kept in component state until Save commits it
	// via transport.updateMyProfile.  `clearAvatar` flag covers the
	// "Remove" case (no file picked, but we want to null out the
	// current avatar).
	const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
	const [pendingAvatarPreview, setPendingAvatarPreview] = useState<string | null>(null);
	const [clearAvatar, setClearAvatar] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	// Banner state mirrors the avatar state above — saved mxc plus
	// the pending File / preview / clear flag used while editing.
	const [bannerMxc, setBannerMxc] = useState<string | null>(null);
	const [pendingBanner, setPendingBanner] = useState<File | null>(null);
	const [pendingBannerPreview, setPendingBannerPreview] = useState<string | null>(null);
	const [clearBanner, setClearBanner] = useState(false);
	const bannerInputRef = useRef<HTMLInputElement | null>(null);

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
				setSocialLinks(fp.social_links);
				setBannerMxc(fp.banner_mxc);
				setFounderNumber(fp.founder_number);
				originalDisplayNameRef.current = p.displayName;
				originalBioRef.current = fp.bio;
				originalSocialLinksRef.current = fp.social_links;
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

	useEffect(() => {
		return () => {
			if (pendingBannerPreview) URL.revokeObjectURL(pendingBannerPreview);
		};
	}, [pendingBannerPreview]);

	const dirty = useMemo(() => {
		if (!profile) return false;
		if (displayName.trim() !== originalDisplayNameRef.current.trim()) return true;
		if (bio.trim() !== originalBioRef.current.trim()) return true;
		if (pendingAvatar) return true;
		if (clearAvatar) return true;
		if (pendingBanner) return true;
		if (clearBanner) return true;
		if (JSON.stringify(socialLinks) !== JSON.stringify(originalSocialLinksRef.current)) return true;
		return false;
	}, [profile, displayName, bio, pendingAvatar, clearAvatar, pendingBanner, clearBanner, socialLinks]);

	function pickAvatar(file: File) {
		if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview);
		setPendingAvatar(file);
		setPendingAvatarPreview(URL.createObjectURL(file));
		setClearAvatar(false);
	}

	function pickBanner(file: File) {
		if (pendingBannerPreview) URL.revokeObjectURL(pendingBannerPreview);
		setPendingBanner(file);
		setPendingBannerPreview(URL.createObjectURL(file));
		setClearBanner(false);
	}

	function enterEdit() {
		void hapticImpact("light");
		setEditing(true);
	}

	function cancelEdit() {
		void hapticImpact("light");
		setDisplayName(originalDisplayNameRef.current);
		setBio(originalBioRef.current);
		setSocialLinks(originalSocialLinksRef.current);
		if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview);
		if (pendingBannerPreview) URL.revokeObjectURL(pendingBannerPreview);
		setPendingAvatar(null);
		setPendingAvatarPreview(null);
		setClearAvatar(false);
		setPendingBanner(null);
		setPendingBannerPreview(null);
		setClearBanner(false);
		setAddLinkOpen(false);
		setNewLinkUrl("");
		setNewLinkPlatform(SOCIAL_PLATFORMS[0].id);
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
			// Banner upload to the media repo, or "" to clear it.
			let nextBannerMxc: string | undefined;
			if (pendingBanner) {
				nextBannerMxc = await transport.uploadAvatarImage(pendingBanner);
			} else if (clearBanner) {
				nextBannerMxc = "";
			}
			if (accessToken) {
				await updateMyProfileData(accessToken, {
					bio: bio.trim(),
					social_links: socialLinks,
					...(nextBannerMxc !== undefined ? { banner_mxc: nextBannerMxc } : {}),
				});
			}
			void hapticNotification("success");
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
			originalSocialLinksRef.current = socialLinks;
			setBannerMxc(nextBannerMxc !== undefined
				? (nextBannerMxc === "" ? null : nextBannerMxc)
				: bannerMxc);
			if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview);
			if (pendingBannerPreview) URL.revokeObjectURL(pendingBannerPreview);
			setPendingAvatar(null);
			setPendingAvatarPreview(null);
			setClearAvatar(false);
			setPendingBanner(null);
			setPendingBannerPreview(null);
			setClearBanner(false);
			setAddLinkOpen(false);
			setNewLinkUrl("");
			setNewLinkPlatform(SOCIAL_PLATFORMS[0].id);
			setEditing(false);
		} catch (err) {
			void hapticNotification("error");
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	const hasRealAvatar = !!(pendingAvatarPreview || (!clearAvatar && profile?.avatarUrl));
	const hasRealBanner = !!(pendingBannerPreview || (!clearBanner && bannerMxc));

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
					: <NavBackButton onClick={onBack} />
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
						<ProfileBanner mxc={bannerMxc} className="h-40" />
						{/* relative z-10 lifts the avatar block above the
						    banner: the banner's mask makes it a stacking
						    context that would otherwise paint over (and
						    fade into) the avatar where the block overlaps. */}
						<div className={cn(
							"relative z-10 flex items-center gap-4 px-5 pb-4",
							bannerMxc ? "-mt-14 pt-4" : "pt-6",
						)}>
							<MatrixAvatar
								mxc={profile.avatarUrl}
								seed={profile.userId}
								kind="user"
								className={cn(
									"h-20 w-20 shrink-0 rounded-full",
									bannerMxc ? "ring-4 ring-background" : "ring-1 ring-foreground/10",
								)}
							/>
							<div className="flex-1 min-w-0">
								<div className="text-[22px] font-semibold tracking-[-0.01em] text-foreground leading-tight break-words">
									{profile.displayName}
								</div>
								<div className="text-[14px] text-muted-foreground leading-snug truncate">
									{userId.includes(":") ? `@${userId.slice(1, userId.indexOf(":"))}` : userId}
								</div>
							</div>
							{founderNumber !== null && (
								<div className="shrink-0 self-center">
									<FounderBadge
										number={founderNumber}
										cap={getFounderCap()}
										variant="profile"
									/>
								</div>
							)}
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

						{socialLinks.length > 0 && (
							<>
								<GroupLabel>Links</GroupLabel>
								<GroupCard>
									<div className="flex flex-wrap gap-2 px-4 py-3">
										{socialLinks.map((link) => (
											<a
												key={link.platform}
												href={link.platform === "email" ? `mailto:${link.url}` : link.url}
												target={link.platform === "email" ? undefined : "_blank"}
												rel="noopener noreferrer"
												className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
												title={SOCIAL_PLATFORMS.find(p => p.id === link.platform)?.label ?? link.platform}
											>
												<SocialIcon platform={link.platform} className="h-5 w-5" />
											</a>
										))}
									</div>
								</GroupCard>
							</>
						)}

					</div>
				) : (
					/* ─── Edit mode ─────────────────────────────────── */
					<div>
						{/* Banner editor — full-bleed image with Change /
						    Remove text buttons, iOS Contacts style. */}
						<div className="flex flex-col">
							{hasRealBanner ? (
								<ProfileBanner
									mxc={clearBanner ? null : bannerMxc}
									previewSrc={pendingBannerPreview}
									className="h-40"
								/>
							) : (
								<div className="h-40 bg-muted/40 flex items-center justify-center text-[13px] text-muted-foreground">
									No banner
								</div>
							)}
							<div className="flex items-center justify-center gap-5 pt-3">
								<button
									type="button"
									onClick={() => { void hapticImpact("light"); bannerInputRef.current?.click(); }}
									className="inline-flex items-center gap-1.5 text-[15px] font-medium text-primary active:opacity-60 transition-opacity"
								>
									<ImageIcon className="h-4 w-4" strokeWidth={2.25} />
									{hasRealBanner ? "Change Banner" : "Add Banner"}
								</button>
								{hasRealBanner && (
									<button
										type="button"
										onClick={() => {
											void hapticImpact("light");
											if (pendingBannerPreview) URL.revokeObjectURL(pendingBannerPreview);
											setPendingBanner(null);
											setPendingBannerPreview(null);
											setClearBanner(true);
										}}
										className="inline-flex items-center gap-1.5 text-[15px] font-medium text-destructive active:opacity-60 transition-opacity"
									>
										<Trash2 className="h-4 w-4" strokeWidth={2.25} />
										Remove
									</button>
								)}
							</div>
							<input
								ref={bannerInputRef}
								type="file"
								accept="image/*"
								className="hidden"
								onChange={(e) => {
									const file = e.target.files?.[0];
									if (file) pickBanner(file);
									e.target.value = "";
								}}
							/>
						</div>
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
									onClick={() => { void hapticImpact("light"); fileInputRef.current?.click(); }}
									className="inline-flex items-center gap-1.5 text-[15px] font-medium text-primary active:opacity-60 transition-opacity"
								>
									<Camera className="h-4 w-4" strokeWidth={2.25} />
									{hasRealAvatar ? "Change Photo" : "Add Photo"}
								</button>
								{hasRealAvatar && (
									<button
										type="button"
										onClick={() => {
											void hapticImpact("light");
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

						<GroupLabel>Links <span className="normal-case font-normal text-muted-foreground">(optional)</span></GroupLabel>
						<GroupCard>
							<div className="divide-y divide-border">
								{socialLinks.map((link, i) => (
									<div key={i} className="flex items-center gap-3 px-4 py-2.5">
										<SocialIcon platform={link.platform} className="h-4 w-4 shrink-0 text-muted-foreground" />
										<div className="flex-1 min-w-0">
											<span className="text-[15px] text-foreground">{SOCIAL_PLATFORMS.find(p => p.id === link.platform)?.label ?? link.platform}</span>
											<span className="text-[13px] text-muted-foreground font-mono ml-2 truncate">{link.url.length > 32 ? link.url.slice(0, 32) + "…" : link.url}</span>
										</div>
										<button
											type="button"
											onClick={() => { void hapticImpact("light"); setSocialLinks(prev => prev.filter((_, j) => j !== i)); }}
											className="shrink-0 text-muted-foreground hover:text-destructive text-xl leading-none transition-colors"
											aria-label={`Remove ${link.platform} link`}
										>
											×
										</button>
									</div>
								))}

								{addLinkOpen ? (
									<div className="px-4 py-2.5 space-y-2">
										<div className="flex items-center gap-2">
											<SocialIcon platform={newLinkPlatform} className="h-4 w-4 shrink-0 text-muted-foreground" />
											<select
												value={newLinkPlatform}
												onChange={e => { setNewLinkPlatform(e.target.value); setNewLinkUrl(""); }}
												className="flex-1 bg-transparent text-[15px] focus:outline-none"
											>
												{SOCIAL_PLATFORMS.map(p => (
													<option key={p.id} value={p.id}>{p.label}</option>
												))}
											</select>
										</div>
										<input
											type={newLinkPlatform === "email" ? "email" : "url"}
											value={newLinkUrl}
											onChange={e => setNewLinkUrl(e.target.value)}
											placeholder={PLATFORM_PLACEHOLDERS[newLinkPlatform] ?? "https://…"}
											className="w-full bg-transparent text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-none"
											autoCapitalize="none"
											autoCorrect="off"
											spellCheck={false}
										/>
										<div className="flex items-center gap-3">
											<button
												type="button"
												onClick={() => {
													const url = newLinkUrl.trim();
													if (url) { setSocialLinks(prev => [...prev, { platform: newLinkPlatform, url }]); setNewLinkUrl(""); }
													setAddLinkOpen(false);
												}}
												className="text-[15px] text-primary font-medium"
											>
												Add
											</button>
											<button
												type="button"
												onClick={() => { setAddLinkOpen(false); setNewLinkUrl(""); }}
												className="text-[15px] text-muted-foreground"
											>
												Cancel
											</button>
										</div>
									</div>
								) : socialLinks.length < 8 ? (
									<button
										type="button"
										onClick={() => { void hapticImpact("light"); setAddLinkOpen(true); setNewLinkUrl(""); setNewLinkPlatform(SOCIAL_PLATFORMS[0].id); }}
										className="flex items-center gap-2 px-4 py-2.5 text-[15px] text-primary w-full text-left"
									>
										<span className="text-xl leading-none">+</span>
										Add link
									</button>
								) : null}
							</div>
						</GroupCard>
				</div>
				)}

				{error && <ErrorBanner message={error} />}
			</div>
		</div>
	);
}


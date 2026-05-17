// Profile sheet — used for two distinct cases:
//   1. The current user views/edits their own profile (display name,
//      bio, avatar editable; metadata read-only).
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
import { Ban, Camera, Image as ImageIcon, MessageSquare, Pencil, Trash2, UserCheck, UserX } from "lucide-react";
import type { MatrixTransport } from "@/lib/matrix";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { ProfileBanner } from "@/components/ProfileBanner";
import { BotBadge } from "@/components/BotBadge";
import { fetchUserProfile, updateMyProfileData, type SocialLink } from "@/lib/profile";
import { SOCIAL_PLATFORMS, PLATFORM_PLACEHOLDERS, SocialIcon } from "@/components/SocialIcons";
import { FounderBadge } from "@/components/FounderBadge";
import { getFounderCap } from "@/lib/founders-cache";
import { formatMxid, serverOf } from "@/lib/mxid";
import { getPublicBotInfo } from "@/lib/bots";
import type { UserId } from "@koven/shared";
import { cn } from "@/lib/utils";

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
	// True when the viewed user is a registered bot — drives the BOT
	// pill.
	isBot?: boolean;
	// Open / create a DM with the viewed user.  Hidden when omitted
	// or when the viewer is looking at their own profile.  Caller is
	// responsible for closing this sheet + navigating to the new
	// room — we just hand back the target id.
	onStartDm?(userId: UserId): void | Promise<void>;
	// True iff the viewer is the founder of the parent space of the
	// room from which this sheet was opened.  Combined with `isBot`
	// it gates the full Kick / Ban affordance: bots are managed
	// unilaterally by the space founder.  Anyone else sees no
	// kick/ban buttons.  When omitted, defaults to false.
	canKickBanBots?: boolean;
	// True iff the viewer owns the bot they're looking at.  When
	// combined with `canRemoveOwnBot`, surfaces a "Remove from
	// space" button for owners viewing their own bot in a space
	// they don't moderate (we can't issue a PL-based kick under
	// their token; the engine resolves it as a voluntary leave under
	// the bot's token instead).  When the viewer is the space
	// founder AND the bot owner, the founder controls take priority
	// and own-bot suppression no longer hides the controls — they
	// can still kick/ban their own bot from their own space if they
	// want to.
	isMyBot?: boolean;
	// True iff there's a parent space context for the active room.
	// Required for the "Remove from space" owner affordance — without
	// a parent space the engine has no scope to act on.
	canRemoveOwnBot?: boolean;
	// Kick/ban/remove handler.  Receives the action + the bot's mxid
	// (the `viewedUserId` at click time) so the parent can pick the
	// right engine endpoint.  Invoked from either the founder
	// Kick/Ban controls or the owner Remove control; "Remove" sends
	// `kick` and lets the engine resolve it to a voluntary leave
	// under the bot's own token.
	onBotMembership?(action: "kick" | "ban", botMxid: UserId): void | Promise<void>;
	// Open another user's profile from inside this sheet.  Used by the
	// "Created by" credit row on bot profiles — clicking the bot's
	// owner pivots the sheet to show that owner's profile instead of
	// the bot's.  Parent (App.tsx) drives the actual viewedUserId
	// state; we just hand back the target.  When omitted, the credit
	// row renders non-interactive (still informative, just no nav).
	onViewProfile?(userId: UserId): void;
}

interface BaseProfile {
	userId: string;
	displayName: string;
	avatarUrl?: string;
	homeserver: string;
}

export function ProfileSheet({ viewedUserId, onClose, transport, accessToken, ignoredUsers, onSelfProfileSaved, isBot, onStartDm, canKickBanBots, isMyBot, canRemoveOwnBot, onBotMembership, onViewProfile }: ProfileSheetProps) {
	const isSelf = useMemo(() => {
		if (!viewedUserId || !transport) return false;
		return transport.currentUserId === viewedUserId;
	}, [viewedUserId, transport]);

	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [blocking, setBlocking] = useState(false);
	// In-flight Kick / Ban state.  Single state machine — only one
	// action can be running at a time, and the buttons disable
	// themselves while pending so a double-click can't fire two
	// kicks back-to-back.
	const [botActionPending, setBotActionPending] = useState<"kick" | "ban" | null>(null);
	const isBlocked = !!(viewedUserId && ignoredUsers?.has(viewedUserId));
	// Founder branch: full Kick/Ban affordance.  Shown to the space
	// founder for ANY bot in the space — including bots they own.
	// "I'm the space founder AND I happen to own this bot" is a real
	// case (the founder spun up a moderation bot and now wants it
	// gone from this space without deleting the bot itself), and the
	// engine endpoint handles it cleanly via the PL-based kick path.
	// Pulling on it doesn't delete the bot from the instance, just
	// from this space.
	const showFounderBotControls = !!(isBot && canKickBanBots && onBotMembership && viewedUserId && !isSelf);
	// Owner branch: "Remove from space" for bot owners viewing their
	// own bot in a space they DON'T moderate.  Mutually exclusive
	// with the founder branch above (`!canKickBanBots`) so a founder-
	// who-also-owns gets the full Kick/Ban affordance, not the
	// reduced single-action one.  Engine resolves the kick action
	// into a voluntary leave under the bot's own token, so no PL
	// in the space is required.
	const showOwnerRemoveControl = !!(isBot && isMyBot && canRemoveOwnBot && !canKickBanBots && onBotMembership && viewedUserId && !isSelf);

	async function handleBotAction(action: "kick" | "ban") {
		if (!viewedUserId || !onBotMembership || botActionPending) return;
		// Friction proportional to consequence: kick is reversible
		// (bot can rejoin if reinvited), ban is sticky, remove is
		// the owner pulling their own bot out (low friction).  All
		// still route through window.confirm so a misclick on hover
		// doesn't silently change membership.
		const isOwnerRemove = showOwnerRemoveControl && action === "kick";
		const prompt = isOwnerRemove
			? "Remove your bot from this space?"
			: `${action === "kick" ? "Kick" : "Ban"} this bot from the space?`;
		if (!window.confirm(prompt)) return;
		setBotActionPending(action);
		setError(null);
		try {
			await onBotMembership(action, viewedUserId);
			// On success, close the sheet — the bot's no longer in the
			// room, so a profile-sheet view of them within this room is
			// stale by definition.
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBotActionPending(null);
		}
	}

	const [profile, setProfile] = useState<BaseProfile | null>(null);
	const [displayName, setDisplayName] = useState("");
	const [bio, setBio] = useState("");
	const [socialLinks, setSocialLinks] = useState<SocialLink[]>([]);
	const originalSocialLinksRef = useRef<SocialLink[]>([]);
	// Controls the inline "add link" form expansion.
	const [addLinkOpen, setAddLinkOpen] = useState(false);
	const [newLinkPlatform, setNewLinkPlatform] = useState(SOCIAL_PLATFORMS[0].id);
	const [newLinkUrl, setNewLinkUrl] = useState("");
	// Founder slot for the viewed user (1..666, null if they didn't
	// claim one).  Drives the holographic Founder chip on the sheet.
	const [founderNumber, setFounderNumber] = useState<number | null>(null);
	// Self-profile editing.  When viewing your OWN profile the sheet
	// opens in read-only mode (same view everyone else sees) and only
	// flips into the edit form when the user clicks the pencil button
	// in the header.  Cancel + Save both return to read-only without
	// closing the dialog.  Originals stored separately so Cancel can
	// revert any in-flight edits to whatever was last fetched.
	const [editing, setEditing] = useState(false);
	const originalDisplayNameRef = useRef("");
	const originalBioRef = useRef("");
	// Bot creator (only meaningful when isBot && !isMyBot && !isSelf).
	// Three-valued like rep: undefined = not yet fetched (suppress
	// the row), null = fetched but not a registered bot or fetch
	// failed (skip row), populated = render the credit line.  Lookup
	// path: GET /api/bots/by-mxid → owner_id → transport.getUserProfile
	// for the owner's display name + avatar.
	const [creator, setCreator] = useState<
		| { userId: UserId; displayName: string; avatarUrl?: string }
		| null
		| undefined
	>(undefined);
	// Bot's DM policy.  Only meaningful when isBot.  Tri-valued:
	// undefined = not yet fetched (suppress the Message button to
	// avoid offering an action we don't yet know is allowed),
	// false = bot's owner has DMs disabled (hide Message button),
	// true = open to anyone (show Message button).  Populated from
	// the same getPublicBotInfo() fetch that populates `creator`.
	const [botAcceptsDms, setBotAcceptsDms] = useState<boolean | undefined>(undefined);

	// Avatar state: existing URL we render unless replaced by a fresh
	// upload (kept as a File until Save), or cleared.
	const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
	const [pendingAvatarPreview, setPendingAvatarPreview] = useState<string | null>(null);
	const [clearAvatar, setClearAvatar] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);

	// Banner state.  `bannerMxc` is the saved banner, fetched with the
	// rest of the profile; the pending* fields mirror the avatar
	// pattern above — a freshly-picked File kept until Save, its
	// preview URL, and a clear flag.
	const [bannerMxc, setBannerMxc] = useState<string | null>(null);
	const [pendingBanner, setPendingBanner] = useState<File | null>(null);
	const [pendingBannerPreview, setPendingBannerPreview] = useState<string | null>(null);
	const [clearBanner, setClearBanner] = useState(false);
	const bannerInputRef = useRef<HTMLInputElement | null>(null);

	const open = !!viewedUserId;

	useEffect(() => {
		if (!open || !transport || !viewedUserId) return;
		let cancelled = false;
		setError(null);
		setPendingAvatar(null);
		setPendingAvatarPreview(null);
		setClearAvatar(false);
		setPendingBanner(null);
		setPendingBannerPreview(null);
		setClearBanner(false);

		// Stale-while-revalidate: only flip into the loading state +
		// blank the per-user state slots if we don't already have
		// data for THIS user.  When the sheet is reopened for a
		// profile we've fetched before, the previous values are
		// still in state and match `viewedUserId` — keep showing
		// them while we silently refetch in the background.
		// Otherwise (first open, or switching to a different user)
		// the prior values are wrong and we genuinely have nothing
		// to render until the fetch resolves.
		//
		// Critical: blanking creator unconditionally on every open
		// caused the dialog to close + reopen for bots (the
		// `creator !== undefined` gate failed mid-cycle) — visible
		// as multiple flashes when reopening a bot profile.  The
		// fresh-data branch must hold creator + rep + everything
		// stable across the silent refetch.
		const haveFreshDataForThisUser = profile?.userId === viewedUserId;
		if (!haveFreshDataForThisUser) {
			setLoading(true);
			setCreator(undefined);
			setBotAcceptsDms(undefined);
		}

		// Matrix profile (display name, avatar) and engine bio fetched
		// in parallel — bio lives on the engine since Matrix has no
		// public-bio field, so we get it from a separate call regardless
		// of self-vs-other.
		const matrixFetcher = isSelf
			? transport.getMyProfile()
			: transport.getUserProfile(viewedUserId as UserId);

		// Two-way Promise.all: Matrix profile + engine bio fetched in
		// parallel.  fetchUserProfile carries both bio AND
		// founder_number in one response; replaces the standalone
		// fetchUserBio call so we only round-trip the engine's
		// /api/profile endpoint once.
		Promise.all([
			matrixFetcher,
			fetchUserProfile(viewedUserId),
		])
			.then(([p, fetchedProfile]) => {
				if (cancelled) return;
				setProfile(p);
				setDisplayName(p.displayName);
				setBio(fetchedProfile.bio);
				setSocialLinks(fetchedProfile.social_links);
				setBannerMxc(fetchedProfile.banner_mxc);
				setFounderNumber(fetchedProfile.founder_number);
				setLoading(false);
				// Cache the just-fetched values so a later Cancel
				// can revert any in-flight edits back to this state
				// without re-fetching.
				originalDisplayNameRef.current = p.displayName;
				originalBioRef.current = fetchedProfile.bio;
				originalSocialLinksRef.current = fetchedProfile.social_links;
				// Reset editing flag — opening the sheet for a new
				// user always starts in read-only mode regardless of
				// whether the previous viewing was mid-edit.
				setEditing(false);
			})
			.catch(err => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			});

		// Bot creator lookup runs in parallel with (but separately
		// from) the main fetch.  We don't gate the body paint on it:
		// the credit row is supplementary, and a slow engine
		// shouldn't block the rest of the sheet.  Skipped entirely
		// for non-bot views and for self-edit (showing "Created by
		// you" on your own bot would be useless noise).
		if (isBot && !isSelf) {
			(async () => {
				try {
					const botInfo = await getPublicBotInfo(viewedUserId);
					if (cancelled || !botInfo) {
						if (!cancelled) {
							setCreator(null);
							// Treat unknown-bot as DMs-closed so we don't
							// offer the Message button against a bot the
							// engine doesn't know about (would silently
							// fail anyway).
							setBotAcceptsDms(false);
						}
						return;
					}
					if (!cancelled) setBotAcceptsDms(botInfo.accept_dms);
					// Resolve the owner's Matrix profile for the avatar +
					// display name.  Failures here surface as null, not
					// an error — we still want the bot's profile to
					// render even if the engine knows the owner_id but
					// Synapse hiccups on the lookup.
					try {
						const ownerProfile = await transport.getUserProfile(botInfo.owner_id as UserId);
						if (cancelled) return;
						setCreator({
							userId: botInfo.owner_id as UserId,
							displayName: ownerProfile.displayName,
							avatarUrl: ownerProfile.avatarUrl,
						});
					} catch (err) {
						console.warn("ProfileSheet: bot owner profile fetch failed", err);
						if (!cancelled) {
							// Fall back to mxid as the display name so we
							// at least credit SOMEONE — better than
							// silently hiding the row.
							setCreator({
								userId: botInfo.owner_id as UserId,
								displayName: botInfo.owner_id,
								avatarUrl: undefined,
							});
						}
					}
				} catch (err) {
					console.warn("ProfileSheet: bot info fetch failed", err);
					if (!cancelled) {
						setCreator(null);
						setBotAcceptsDms(false);
					}
				}
			})();
		} else {
			setCreator(null);
			// Non-bot view: leave botAcceptsDms in its default
			// (undefined) state — the Message button gating only
			// applies to bots, so the human-DM path is unaffected.
		}
		return () => { cancelled = true; };
		// `profile` intentionally not in deps — including it would re-
		// run the fetch every time the fetch resolves (we just set
		// profile in there), creating a loop.  We only want this to
		// fire when the SHEET opens or the target user changes.
		// `isBot` is in deps because the creator-lookup branch reads
		// it to decide whether to fire the engine call.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, transport, viewedUserId, isSelf, isBot]);

	// Clean up object URLs we made for previews.
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
			// Banner: upload a freshly-picked file to the media repo,
			// or "" to clear it.  undefined = banner left untouched.
			let nextBannerMxc: string | undefined;
			if (pendingBanner) {
				nextBannerMxc = await transport.uploadAvatarImage(pendingBanner);
			} else if (clearBanner) {
				nextBannerMxc = "";
			}
			// Bio, social links + banner live on the engine, saved together.
			if (accessToken) {
				await updateMyProfileData(accessToken, {
					bio: bio.trim(),
					social_links: socialLinks,
					...(nextBannerMxc !== undefined ? { banner_mxc: nextBannerMxc } : {}),
				});
			}
			onSelfProfileSaved?.(avatarUrl);
			// Update the local profile snapshot so the read-only view
			// (which we're about to flip back into) renders the new
			// avatar / displayname without needing a re-fetch.
			setProfile(prev => prev ? {
				...prev,
				displayName: displayName.trim(),
				avatarUrl: pendingAvatar
					? avatarUrl ?? prev.avatarUrl
					: clearAvatar
						? undefined
						: prev.avatarUrl,
			} : prev);
			// Cache the saved values as the new originals — a later
			// Edit + Cancel cycle reverts to THIS state, not the one
			// we loaded with at sheet open.
			originalDisplayNameRef.current = displayName.trim();
			originalBioRef.current = bio.trim();
			originalSocialLinksRef.current = socialLinks;
			// Reflect the saved banner so the read-only view we flip
			// back to renders it without a refetch.
			setBannerMxc(nextBannerMxc !== undefined
				? (nextBannerMxc === "" ? null : nextBannerMxc)
				: bannerMxc);
			// Discard any pending avatar / banner preview blobs so they
			// aren't kept alive past the save.
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
			// Flip back to read-only view, leave the dialog open so
			// the user can confirm their changes look right.
			setEditing(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	function cancelEdit() {
		// Revert in-flight edits to whatever was last fetched / saved.
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

	const hasRealAvatar = !!(pendingAvatarPreview || (!clearAvatar && profile?.avatarUrl));
	const hasRealBanner = !!(pendingBannerPreview || (!clearBanner && bannerMxc));

	// Defer mounting the dialog until the data is FULLY ready.
	// `loading` going false isn't enough on its own — if any fetch
	// in the Promise.all rejects, the .catch flips `loading` false
	// but leaves `profile` null, which in turn keeps the body's
	// "Loading…" branch active.  Net effect: dialog opens with a
	// stuck "Loading…" forever.
	//
	// Gate on the same conditions the body's render branch checks,
	// so the dialog mounts only when the body would render the
	// real content.  When data is missing (still fetching, or
	// fetch failed), the dialog stays closed — silent on success
	// path, silent on error path.  Errors get surfaced via the
	// parent's existing error banner rather than a stuck dialog.
	// Have-everything-ready check.  Used as the FIRST-time gate;
	// once the dialog opens, we latch it open via `hasMounted`
	// below so subsequent state shifts (bot cache backfilling,
	// silent stale-while-revalidate refetches, etc.) can't cause
	// the dialog to close + reopen mid-life.  That close+reopen
	// was the "flashing the ui a bunch" symptom on bot profiles.
	const computedReady =
		open
		&& !loading
		&& !!profile
		&& profile.userId === viewedUserId
		// Bot profiles also wait on the creator-lookup so the
		// "Created by" row appears in the same paint as the rest of
		// the body — `creator === undefined` means the lookup is
		// still in flight.  null is fine (no creator found, row
		// suppressed) but undefined IS the loading state.  Skipped
		// for non-bot views since they never query the creator
		// branch.
		&& (!isBot || creator !== undefined);
	// Latch: flips true the first time `computedReady` goes true
	// for the current `open` lifecycle, resets to false when
	// `open` flips back to false.  Means a single close+reopen
	// cycle within one viewing won't fire a re-mount animation.
	const [hasMounted, setHasMounted] = useState(false);
	useEffect(() => {
		if (!open) {
			setHasMounted(false);
		} else if (computedReady && !hasMounted) {
			setHasMounted(true);
		}
	}, [open, computedReady, hasMounted]);
	const dialogOpen = open && (computedReady || hasMounted);

	return (
		<Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) onClose(); }}>
			<DialogContent className={isSelf && editing ? "sm:max-w-lg" : "sm:max-w-md"}>
				<DialogHeader>
					<DialogTitle className="flex items-center justify-between gap-2 pr-6">
						<span>Profile</span>
						{/* Edit button — visible only on your own
						    profile in read-only mode.  Flips into the
						    edit form without closing the dialog.
						    `pr-6` on the title row clears the dialog's
						    built-in close affordance in the top-right
						    corner so the Edit button doesn't crash
						    into it. */}
						{isSelf && !editing && (
							<button
								type="button"
								onClick={() => setEditing(true)}
								className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
								aria-label="Edit profile"
							>
								<Pencil className="h-3.5 w-3.5" />
								Edit
							</button>
						)}
					</DialogTitle>
					{/* Non-self profiles keep an sr-only description: the
					    member's name + avatar already head the body, and
					    surfacing the raw mxid here was visual clutter. */}
					<DialogDescription className={isSelf ? undefined : "sr-only"}>
						{isSelf
							? "Visible to anyone you share a room with."
							: profile?.displayName ? `${profile.displayName}'s profile` : "Profile"}
					</DialogDescription>
				</DialogHeader>

				{/* Show loading until profile + bio have resolved.
				    Stale-while-revalidate: when reopening for the
				    same user we already have data for, skip the
				    loading state and let the cached values paint
				    instantly. */}
				{!profile || profile.userId !== viewedUserId ? (
					<div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
				) : isSelf && editing ? (
					// ─── Self-edit layout ──────────────────────────────────
					// Two-column: avatar/buttons on the left, name + bio on
					// the right.  Metadata sits below in another two-column
					// grid so the dialog fits without scrolling on most
					// laptop screens.
					<div className="space-y-4">
						{/* Banner editor — wide image with Upload / Change /
						    Remove controls, mirroring the avatar block below. */}
						<div className="space-y-2">
							{hasRealBanner ? (
								<ProfileBanner
									mxc={clearBanner ? null : bannerMxc}
									previewSrc={pendingBannerPreview}
									className="h-24 rounded-lg"
								/>
							) : (
								<div className="h-24 rounded-lg border border-dashed border-input bg-muted/30 flex items-center justify-center text-xs text-muted-foreground">
									No banner yet
								</div>
							)}
							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => bannerInputRef.current?.click()}
								>
									<ImageIcon className="h-3.5 w-3.5 mr-1.5" />
									{hasRealBanner ? "Change banner" : "Upload banner"}
								</Button>
								{hasRealBanner && (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="text-muted-foreground hover:text-destructive h-7"
										onClick={() => {
											if (pendingBannerPreview) URL.revokeObjectURL(pendingBannerPreview);
											setPendingBanner(null);
											setPendingBannerPreview(null);
											setClearBanner(true);
										}}
									>
										<Trash2 className="h-3.5 w-3.5 mr-1.5" />
										Remove
									</Button>
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

						{/* ─── Social links edit ─────────────────────────────
						    Only added links are shown (no empty rows).  A
						    collapsed "+ Add link" button at the bottom expands
						    into a platform picker + URL field inline. */}
						<div className="space-y-2">
							<Label>Links <span className="text-muted-foreground font-normal">(optional)</span></Label>

							{socialLinks.length > 0 && (
								<div className="space-y-1">
									{socialLinks.map((link, i) => (
										<div key={i} className="flex items-center gap-2 text-sm">
											<SocialIcon platform={link.platform} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
											<span className="flex-1 truncate text-muted-foreground">
												<span className="text-foreground">{SOCIAL_PLATFORMS.find(p => p.id === link.platform)?.label ?? link.platform}</span>
												{" · "}
												<span className="font-mono text-xs">{link.url.length > 40 ? link.url.slice(0, 40) + "…" : link.url}</span>
											</span>
											<button
												type="button"
												onClick={() => setSocialLinks(prev => prev.filter((_, j) => j !== i))}
												className="shrink-0 text-muted-foreground hover:text-destructive transition-colors text-base leading-none"
												aria-label={`Remove ${link.platform} link`}
											>
												×
											</button>
										</div>
									))}
								</div>
							)}

							{!addLinkOpen && socialLinks.length < 8 && (
								<button
									type="button"
									onClick={() => { setAddLinkOpen(true); setNewLinkUrl(""); setNewLinkPlatform(SOCIAL_PLATFORMS[0].id); }}
									className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
								>
									<span className="text-base leading-none">+</span> Add link
								</button>
							)}

							{addLinkOpen && (
								<div className="flex items-center gap-2">
									<SocialIcon platform={newLinkPlatform} className="h-4 w-4 shrink-0 text-muted-foreground" />
									<select
										value={newLinkPlatform}
										onChange={e => { setNewLinkPlatform(e.target.value); setNewLinkUrl(""); }}
										className="rounded border border-input bg-transparent px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring shrink-0"
									>
										{SOCIAL_PLATFORMS.map(p => (
											<option key={p.id} value={p.id}>{p.label}</option>
										))}
									</select>
									<input
										type={newLinkPlatform === "email" ? "email" : "url"}
										value={newLinkUrl}
										onChange={e => setNewLinkUrl(e.target.value)}
										placeholder={PLATFORM_PLACEHOLDERS[newLinkPlatform] ?? "https://…"}
										className="flex-1 min-w-0 rounded border border-input bg-transparent px-2 py-1 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
										onKeyDown={e => {
											if (e.key === "Enter") {
												e.preventDefault();
												const url = newLinkUrl.trim();
												if (url) {
													setSocialLinks(prev => [...prev, { platform: newLinkPlatform, url }]);
													setNewLinkUrl("");
													setAddLinkOpen(false);
												}
											}
										}}
									/>
									<button
										type="button"
										onClick={() => {
											const url = newLinkUrl.trim();
											if (url) {
												setSocialLinks(prev => [...prev, { platform: newLinkPlatform, url }]);
												setNewLinkUrl("");
											}
											setAddLinkOpen(false);
										}}
										className="shrink-0 text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
									>
										Add
									</button>
									<button
										type="button"
										onClick={() => { setAddLinkOpen(false); setNewLinkUrl(""); }}
										className="shrink-0 text-muted-foreground hover:text-foreground text-base leading-none"
										aria-label="Cancel"
									>
										×
									</button>
								</div>
							)}
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
					<div>
						<ProfileBanner mxc={bannerMxc} previewSrc={bannerMxc ? undefined : "/default-banner.png"} className="h-40 rounded-t-lg" />
						<div className={cn(
							"relative z-10 flex items-center gap-4 px-5 pb-4",
							bannerMxc ? "-mt-14 pt-4" : "-mt-14 pt-4",
						)}>
							<MatrixAvatar
								mxc={profile.avatarUrl}
								seed={profile.userId}
								kind={isBot ? "bot" : "user"}
								className={cn(
									"h-20 w-20 shrink-0 rounded-full",
									"ring-4 ring-background",
								)}
							/>
							<div className="flex-1 min-w-0">
								<div className="text-[22px] font-semibold tracking-[-0.01em] text-foreground leading-tight break-words">
									{profile.displayName}
									{isBot && <BotBadge compact={false} />}
								</div>
								<div className="text-[14px] text-muted-foreground leading-snug truncate">
									{profile.userId.includes(":") ? `@${profile.userId.slice(1, profile.userId.indexOf(":"))}` : profile.userId}
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

						<div className="px-5 space-y-4">
							{bio.trim() ? (
								<p className="text-[15px] leading-relaxed text-foreground whitespace-pre-wrap">
									{bio}
								</p>
							) : (
								<p className="text-[15px] text-muted-foreground/60 italic">
									This user hasn't added a bio yet.
								</p>
							)}

							{socialLinks.length > 0 ? (
								<div className="flex flex-wrap gap-2">
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
							) : (
								<p className="text-[15px] text-muted-foreground/60 italic">
									No links added yet.
								</p>
							)}
						</div>

						{isBot && creator && (
							// "Created by" credit row.  Renders the
							// owner's avatar + display name with a
							// tappable target so viewers can pivot to
							// the owner's profile.  Suppressed for
							// self-edit (showing "Created by you" on
							// your own bot is noise) and for non-bot
							// profiles (humans don't have a creator).
							//
							// Falls back to a non-interactive row when
							// no onViewProfile callback is wired.
							<div className="pt-2 border-t border-border">
								<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
									Created by
								</div>
								{onViewProfile ? (
									<button
										type="button"
										onClick={() => onViewProfile(creator.userId)}
										className="flex items-center gap-2 w-full text-left rounded-md hover:bg-accent/40 -m-1 p-1 transition-colors"
									>
										<MatrixAvatar
											mxc={creator.avatarUrl}
											seed={creator.userId}
											kind="user"
											className="h-7 w-7"
										/>
										<div className="min-w-0">
											<div className="text-sm truncate">{creator.displayName}</div>
											<div className="text-[11px] text-muted-foreground font-mono truncate" title={creator.userId}>
												{formatMxid(creator.userId, serverOf(transport?.currentUserId ?? null))}
											</div>
										</div>
									</button>
								) : (
									<div className="flex items-center gap-2">
										<MatrixAvatar
											mxc={creator.avatarUrl}
											seed={creator.userId}
											kind="user"
											className="h-7 w-7"
										/>
										<div className="min-w-0">
											<div className="text-sm truncate">{creator.displayName}</div>
											<div className="text-[11px] text-muted-foreground font-mono truncate" title={creator.userId}>
												{formatMxid(creator.userId, serverOf(transport?.currentUserId ?? null))}
											</div>
										</div>
									</div>
								)}
							</div>
						)}

						{error && (
							<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
								{error}
							</div>
						)}

						{showFounderBotControls && (
							// Founder-only bot controls live in their OWN
							// section above the footer, not inline with
							// Block / Message / DM.  Stacking them in the
							// DialogFooter pushed Message off the right
							// edge on narrow profile sheets — and
							// "moderation in this room" is a different
							// kind of action than "manage my relationship
							// with this user," so visually separating
							// them reads cleaner anyway.
							//
							// Bots are managed unilaterally by the space
							// founder; a misbehaving bot can be silenced
							// without going through the report queue.
							// Two buttons
							// rather than a single dropdown because the
							// affordance is rare enough that signposting
							// both options inline is clearer than a
							// hidden menu.
							<div className="pt-3 border-t border-border space-y-2">
								<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
									Space moderation
								</div>
								<div className="flex gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => handleBotAction("kick")}
										disabled={!!botActionPending || loading}
										className="flex-1 text-amber-500 hover:text-amber-500 border-amber-500/40"
										title="Kick this bot from every room in the space (it can rejoin if reinvited)"
									>
										<UserX className="h-3.5 w-3.5 mr-1.5" />
										{botActionPending === "kick" ? "Kicking…" : "Kick bot from space"}
									</Button>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => handleBotAction("ban")}
										disabled={!!botActionPending || loading}
										className="flex-1 text-destructive hover:text-destructive border-destructive/40"
										title="Ban this bot from every room in the space (it cannot rejoin until unbanned)"
									>
										<Ban className="h-3.5 w-3.5 mr-1.5" />
										{botActionPending === "ban" ? "Banning…" : "Ban bot from space"}
									</Button>
								</div>
							</div>
						)}
						{showOwnerRemoveControl && (
							// Owner-side affordance: pull your own bot out
							// of a space you don't moderate.  The engine
							// resolves the kick action into a voluntary
							// leave under the bot's own token, so no PL
							// in the space is required — owners can
							// always pull their bots back.  Single button
							// because there's only one action here; ban
							// would require space PL that owners don't
							// have.
							<div className="pt-3 border-t border-border space-y-2">
								<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
									Your bot
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => handleBotAction("kick")}
									disabled={!!botActionPending || loading}
									className="w-full text-amber-500 hover:text-amber-500 border-amber-500/40"
									title="Remove your bot from every room in this space"
								>
									<UserX className="h-3.5 w-3.5 mr-1.5" />
									{botActionPending === "kick" ? "Removing…" : "Remove from space"}
								</Button>
							</div>
						)}
					</div>
				)}

				<DialogFooter>
					{/* Block is a personal-noise filter for human users:
					    drop their messages from your timeline, refuse
					    their DMs.  Bots aren't blockable in that sense
					    — they're system identities tied to a specific
					    room.  If you want a bot gone, kick or ban it
					    from the room (founder-only, in the Room
					    moderation section above the footer).  Hiding
					    the Block button on bots avoids implying
					    it's the right gesture and accidentally
					    silencing notifications across rooms when the
					    user actually wanted "remove from this room." */}
					{!isSelf && viewedUserId && !isBot && (
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
					{/* Bot DM-policy gate: hide Message when the bot's
					    owner has `accept_dms` disabled.  The bot would
					    auto-leave any DM invite from a non-owner
					    anyway (bot_runtime.ts membership handler), so
					    offering the button there leads to a confusing
					    empty-room experience.  Owner (`isMyBot`) and
					    DMs-open bots (`botAcceptsDms === true`) keep
					    the button.  Non-bot DMs are unaffected (the
					    gate only applies when isBot). */}
					{!isSelf && viewedUserId && onStartDm && !isBlocked
						&& (!isBot || isMyBot || botAcceptsDms === true)
						&& (
							<Button
								type="button"
								onClick={() => onStartDm(viewedUserId)}
								disabled={loading || pending}
								className="gap-1.5"
							>
								<MessageSquare className="h-3.5 w-3.5" />
								Message
							</Button>
						)}
					{/* Self-edit mode keeps an explicit Cancel because
					    the dialog has unsaved-edit state — the X
					    closes too, but Cancel reads as "discard
					    these changes" alongside the Save button.
					    Cancel reverts to the read-only view (without
					    closing the dialog) and discards any in-flight
					    edits via cancelEdit's reset. */}
					{isSelf && editing && (
						<>
							<Button type="button" variant="ghost" onClick={cancelEdit} disabled={pending}>
								Cancel
							</Button>
							<Button type="button" onClick={save} disabled={loading || pending}>
								{pending ? "Saving…" : "Save"}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}


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
import { Ban, Camera, MessageSquare, Trash2, UserCheck, UserX } from "lucide-react";
import type { MatrixTransport } from "@/lib/matrix";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { BotBadge } from "@/components/BotBadge";
import { loadReputation } from "@/lib/useReputation";
import type { ReputationData } from "@/lib/reputation";
import { descriptorFor, nextTierUnlockLabel, tickClassForFilled, ticksFor } from "@/lib/reputation";
import { fetchUserBio, fetchUserProfile, updateMyBio } from "@/lib/profile";
import { FounderBadge } from "@/components/FounderBadge";
import { getFounderCap } from "@/lib/founders-cache";
import { formatMxid, serverOf } from "@/lib/mxid";
import { getPublicBotInfo } from "@/lib/bots";
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
	// True when the viewed user is a registered bot — drives the BOT
	// pill and suppresses the reputation block.
	isBot?: boolean;
	// Open / create a DM with the viewed user.  Hidden when omitted
	// or when the viewer is looking at their own profile.  Caller is
	// responsible for closing this sheet + navigating to the new
	// room — we just hand back the target id.
	onStartDm?(userId: UserId): void | Promise<void>;
	// True iff the viewer is the founder of the room from which this
	// sheet was opened.  Combined with `isBot` it gates the
	// Kick / Ban affordance: bots aren't people, so the room founder
	// can silence one without the consensus pipeline.  Anyone else
	// (regular members, founders viewing humans) sees no kick/ban
	// buttons.  When omitted, defaults to false — read-only views
	// outside a room context (DMs, member-of-no-particular-room) skip
	// the affordance entirely.
	canKickBanBots?: boolean;
	// True iff the viewer owns the bot they're looking at.  Suppresses
	// the kick/ban affordance even when canKickBanBots is true —
	// kicking your own bot is incoherent (just delete it from
	// Settings → Bots if you don't want it around), and banning it
	// would lock yourself out of your own bot's room membership.
	// Founder-of-room + bot's own owner is the same person → still
	// no kick/ban; clean separation between "manage the bot" and
	// "police bots in my room."
	isMyBot?: boolean;
	// Kick/ban handler.  Receives the action + the bot's mxid (the
	// `viewedUserId` at click time) so the parent can pick the right
	// engine endpoint.  Not invoked unless `canKickBanBots && isBot`,
	// so callers don't need to re-validate.
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

export function ProfileSheet({ viewedUserId, onClose, transport, accessToken, ignoredUsers, onSelfProfileSaved, isBot, onStartDm, canKickBanBots, isMyBot, onBotMembership, onViewProfile }: ProfileSheetProps) {
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
	const showBotControls = !!(isBot && canKickBanBots && !isMyBot && onBotMembership && viewedUserId && !isSelf);

	async function handleBotAction(action: "kick" | "ban") {
		if (!viewedUserId || !onBotMembership || botActionPending) return;
		// Friction proportional to consequence: kick is reversible
		// (bot can rejoin if reinvited), ban is sticky.  Both still
		// route through window.confirm so a misclick on hover doesn't
		// silently silence a bot.
		const verb = action === "kick" ? "Kick" : "Ban";
		if (!window.confirm(`${verb} this bot from the room?`)) return;
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
	// Founder slot for the viewed user (1..666, null if they didn't
	// claim one).  Drives the holographic Founder chip on the sheet.
	const [founderNumber, setFounderNumber] = useState<number | null>(null);
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
	// Reputation fetched in the same Promise.all as profile + bio so
	// the body has all three before any of it paints.  Three-valued:
	//   undefined — fetch hasn't returned yet (suppress body render),
	//   null      — fetched, engine returned no data (show "Engine offline"),
	//   ReputationData — fetched + populated.
	const [rep, setRep] = useState<ReputationData | null | undefined>(undefined);

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
		setError(null);
		setPendingAvatar(null);
		setPendingAvatarPreview(null);
		setClearAvatar(false);
		setCreator(undefined);

		// Stale-while-revalidate: only flip into the loading state if
		// we don't already have data for THIS user.  When the sheet
		// is reopened for a profile we've fetched before (most often
		// the user's own profile), `profile` is still in state from
		// the previous open and matches `viewedUserId` — keep showing
		// it while we silently refetch in the background.  Otherwise
		// (first open, or switching to a different user) we genuinely
		// have nothing to render and the loading state is correct.
		const haveFreshDataForThisUser = profile?.userId === viewedUserId;
		if (!haveFreshDataForThisUser) {
			setLoading(true);
			// Reset rep to undefined too so the body waits for the
			// new user's rep fetch to land.  Without this, switching
			// from one profile to another would briefly show the
			// previous user's rep block until the new fetch resolved.
			setRep(undefined);
		}

		// Matrix profile (display name, avatar) and engine bio fetched
		// in parallel — bio lives on the engine since Matrix has no
		// public-bio field, so we get it from a separate call regardless
		// of self-vs-other.
		const matrixFetcher = isSelf
			? transport.getMyProfile()
			: transport.getUserProfile(viewedUserId as UserId);

		// Three-way Promise.all: Matrix profile, engine bio, AND
		// reputation are all required before the body paints.
		// Without the rep wait the sheet would render a brief
		// "Engine offline" rep block and then snap to the populated
		// version — exactly the jarring flash the user reported.
		// Reputation fetch failures resolve as `null` so we don't
		// gate the whole sheet on a transient engine outage.
		// fetchUserProfile carries both bio AND founder_number in one
		// response; replaces the standalone fetchUserBio call so we
		// only round-trip the engine's /api/profile endpoint once.
		Promise.all([
			matrixFetcher,
			fetchUserProfile(viewedUserId),
			loadReputation(viewedUserId).catch(() => null),
		])
			.then(([p, fetchedProfile, fetchedRep]) => {
				if (cancelled) return;
				setProfile(p);
				setDisplayName(p.displayName);
				setBio(fetchedProfile.bio);
				setFounderNumber(fetchedProfile.founder_number);
				setRep(fetchedRep);
				setLoading(false);
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
						if (!cancelled) setCreator(null);
						return;
					}
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
					if (!cancelled) setCreator(null);
				}
			})();
		} else {
			setCreator(null);
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
	const dialogOpen =
		open
		&& !loading
		&& !!profile
		&& profile.userId === viewedUserId
		&& rep !== undefined;

	return (
		<Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) onClose(); }}>
			<DialogContent className={isSelf ? "sm:max-w-lg" : "sm:max-w-md"}>
				<DialogHeader>
					<DialogTitle>{isSelf ? "Profile" : "Member"}</DialogTitle>
					<DialogDescription>
						{isSelf
							? "Visible to anyone you share a room with."
							: profile?.userId ?? "Loading…"}
					</DialogDescription>
				</DialogHeader>

				{/* Show loading until ALL three of profile + bio + rep
				    have resolved (rep === undefined means the fetch
				    is still in flight; null means fetched and engine
				    returned nothing).  Without the rep gate the body
				    renders with an "Engine offline" rep block briefly,
				    then snaps to the populated version once the rep
				    fetch lands — three jarring phases in a row.
				    Stale-while-revalidate: when reopening for the same
				    user we already have profile data for, skip the
				    loading state and let the cached profile + cached
				    rep paint instantly. */}
				{!profile || profile.userId !== viewedUserId || rep === undefined ? (
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
									<div className="text-[10px] font-mono text-muted-foreground truncate" title={profile.userId}>
										{formatMxid(profile.userId, serverOf(transport?.currentUserId ?? null))}
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

						{founderNumber !== null && (
							// Self view of the holographic Founder chip —
							// users want to see their own badge too, not
							// just other people's.  Sits between the
							// edit form and the rep block, same vertical
							// rhythm as the read-only view.
							<div>
								<FounderBadge
									number={founderNumber}
									cap={getFounderCap()}
									variant="profile"
								/>
							</div>
						)}

						{/* Reputation gets the full row now that user id lives
						    inline under the display name and the Status
						    placeholder is gone. */}
						<div className="pt-3 border-t border-border">
							<ReputationRow rep={rep ?? null} isSelf />
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
								kind={isBot ? "bot" : "user"}
								className="h-16 w-16"
							/>
							<div className="min-w-0 flex-1">
								<div className="text-base font-semibold truncate flex items-center gap-1.5">
									<span className="truncate">{profile.displayName}</span>
									{isBot && <BotBadge compact={false} />}
								</div>
								<div className="text-xs text-muted-foreground font-mono truncate" title={profile.userId}>
									{formatMxid(profile.userId, serverOf(transport?.currentUserId ?? null))}
								</div>
							</div>
						</div>

						{founderNumber !== null && (
							// Holographic Founder chip — sits between the
							// identity row and the bio so it reads as
							// part of "who is this person", not metadata
							// buried below the rep block.
							<div>
								<FounderBadge
									number={founderNumber}
									cap={getFounderCap()}
									variant="profile"
								/>
							</div>
						)}

						{bio.trim() && (
							<p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
								{bio}
							</p>
						)}

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

						{!isBot && (
							<div className="pt-2 border-t border-border">
								<ReputationRow rep={rep ?? null} />
							</div>
						)}

						{error && (
							<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
								{error}
							</div>
						)}

						{showBotControls && (
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
							// Bots aren't covered by the consensus
							// protections that gate human kick/ban — a
							// misbehaving bot can be silenced by the
							// room's founder unilaterally.  Two buttons
							// rather than a single dropdown because the
							// affordance is rare enough that signposting
							// both options inline is clearer than a
							// hidden menu.
							<div className="pt-3 border-t border-border space-y-2">
								<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
									Room moderation
								</div>
								<div className="flex gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => handleBotAction("kick")}
										disabled={!!botActionPending || loading}
										className="flex-1 text-amber-500 hover:text-amber-500 border-amber-500/40"
										title="Kick this bot from the room (it can rejoin if reinvited)"
									>
										<UserX className="h-3.5 w-3.5 mr-1.5" />
										{botActionPending === "kick" ? "Kicking…" : "Kick bot"}
									</Button>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => handleBotAction("ban")}
										disabled={!!botActionPending || loading}
										className="flex-1 text-destructive hover:text-destructive border-destructive/40"
										title="Ban this bot from the room (it cannot rejoin until unbanned)"
									>
										<Ban className="h-3.5 w-3.5 mr-1.5" />
										{botActionPending === "ban" ? "Banning…" : "Ban bot"}
									</Button>
								</div>
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
					{!isSelf && viewedUserId && onStartDm && !isBlocked && (
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
					    these changes" alongside the Save button. */}
					{isSelf && (
						<>
							<Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
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

// Reputation breakdown — vertical-tick level meter (matching the
// sidebar visual), tier label, weight, then a clean key/value list of
// the underlying counters.  Description sits below as muted context.
//
// When viewing your own profile we also show how long until the next
// age-gate unlocks (omitted on others' profiles — feels like
// surveillance to call out where someone is on their tier ladder).
//
// Falls back to a one-liner if the engine hasn't returned data yet.
function ReputationRow({ rep, isSelf }: { rep: ReputationData | null; isSelf?: boolean }) {
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

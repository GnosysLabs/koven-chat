// Right-sidebar profile panel that replaces the member list for DM
// rooms.  A DM has exactly two participants and the current user is
// already obvious — the only useful thing to show is the OTHER
// participant's identity, so we render it inline instead of a generic
// two-row member list.

import { useEffect, useState } from "react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { BotBadge } from "@/components/BotBadge";
import { fetchUserProfile, type SocialLink } from "@/lib/profile";
import { SOCIAL_PLATFORMS, SocialIcon } from "@/components/SocialIcons";
import { ProfileBanner } from "@/components/ProfileBanner";
import type { MatrixTransport } from "@/lib/matrix";
import type { UserId } from "@koven/shared";
import { Ban, Trash2, UserCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { serverOf, formatMxid } from "@/lib/mxid";

export interface DmProfilePanelProps {
	otherUserId: UserId;
	transport: MatrixTransport | null;
	// Live ignore-list state so the block/unblock button reflects the
	// current m.ignored_user_list.  Updates as account_data syncs.
	ignoredUsers: Set<UserId>;
	// Click handler for the row, so the user can still open the full
	// profile dialog if they want.
	onOpenProfile(userId: UserId): void;
	// Open the shared bilateral-delete confirmation dialog (owned by
	// App.tsx).  The dialog runs the actual transport.deleteDm call
	// on confirm; this panel just opens it.  Shared with the sidebar
	// right-click context menu's "Delete conversation" item so both
	// entry points hit the same gate.
	onRequestDelete(): void;
	// Whether the other user is a registered bot — drives the BOT
	// pill rendered next to their name.
	isBot?: boolean;
	// Whether the bot in question is one the VIEWER owns.  Hides the
	// Block button entirely: blocking your own bot is incoherent (you
	// already control its prompt + config, and the m.ignored_user_list
	// entry would just confuse the bot's own ability to address you).
	// "Delete conversation" still works — that's how you end a DM
	// thread with your own bot if you want to start fresh.
	isMyBot?: boolean;
}

export function DmProfilePanel({ otherUserId, transport, ignoredUsers, onOpenProfile, onRequestDelete, isBot, isMyBot }: DmProfilePanelProps) {
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
	const [socialLinks, setSocialLinks] = useState<SocialLink[]>([]);
	const [bannerMxc, setBannerMxc] = useState<string | null>(null);
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
			setSocialLinks([]);
			setBannerMxc(null);
		}
		// Matrix profile (display name, avatar) and engine profile
		// (bio + social links) fetched in parallel.
		Promise.all([
			transport.getUserProfile(otherUserId).catch(() => null),
			fetchUserProfile(otherUserId).catch(() => null),
		]).then(([p, ep]) => {
			if (cancelled) return;
			setProfile({
				userId: otherUserId,
				displayName: p?.displayName ?? otherUserId,
				avatarUrl: p?.avatarUrl,
				homeserver: p?.homeserver ?? "",
			});
			setBio(ep?.bio ?? "");
			setSocialLinks(ep?.social_links ?? []);
			setBannerMxc(ep?.banner_mxc ?? null);
		});
		return () => { cancelled = true; };
		// `profile?.userId` is read for the staleness check but
		// shouldn't drive re-runs — the effect already retriggers on
		// otherUserId change, which is the only thing that should
		// invalidate the cached profile.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [otherUserId, transport]);

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
	// `profile?.avatarUrl` is undefined while the fetch is pending) and
	// the mxid as the display name, then snap to the real values once
	// the profile fetch resolves.  Holding back the body avoids the
	// flash.  The avatar/name still render once `profile` is non-null
	// AND matches the current `otherUserId` — same gate keeps stale
	// values off-screen during DM switches.
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
				<ProfileBanner mxc={bannerMxc} className="h-16 rounded-lg mb-4" />
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
						<div className="text-xs text-muted-foreground font-mono truncate">
							{formatMxid(otherUserId, serverOf(transport?.currentUserId ?? null))}
						</div>
					</div>
				</button>

				{bio.trim() && (
					<p className="mt-4 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
						{bio}
					</p>
				)}

				{socialLinks.length > 0 && (
					<div className="mt-3 flex flex-wrap gap-1">
						{socialLinks.map((link) => (
							<a
								key={link.platform}
								href={link.platform === "email" ? `mailto:${link.url}` : link.url}
								target={link.platform === "email" ? undefined : "_blank"}
								rel="noopener noreferrer"
								className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
								title={SOCIAL_PLATFORMS.find(p => p.id === link.platform)?.label ?? link.platform}
							>
								<SocialIcon platform={link.platform} className="h-3.5 w-3.5" />
							</a>
						))}
					</div>
				)}

				{!isMyBot && (
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
				)}

				<div className="mt-2">
					<button
						type="button"
						onClick={onRequestDelete}
						className={cn(
							"w-full flex items-center justify-center gap-2 px-2 py-1.5 rounded text-xs",
							"text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors",
						)}
					>
						<Trash2 className="h-3.5 w-3.5" />
						Delete conversation
					</button>
				</div>
				</>)}
			</div>
		</aside>
	);
}


// Mobile push-view for viewing another user's profile. Mirrors the
// read-mode layout of MobileProfileScreen so own-profile and
// other-profile look identical on mobile.

import { useEffect, useState } from "react";
import { Ban, MessageSquare, UserCheck, UserX } from "lucide-react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { ProfileBanner } from "@/components/ProfileBanner";
import { FounderBadge } from "@/components/FounderBadge";
import { getFounderCap } from "@/lib/founders-cache";
import { fetchUserProfile, type SocialLink } from "@/lib/profile";
import { SOCIAL_PLATFORMS, SocialIcon } from "@/components/SocialIcons";
import { BotBadge } from "@/components/BotBadge";
import type { MatrixTransport } from "@/lib/matrix";
import type { UserId } from "@koven/shared";
import { cn } from "@/lib/utils";
import {
	NavBar,
	NavBackButton,
	GroupLabel,
	GroupCard,
} from "@/components/mobile/Chrome";

export interface MobileOtherProfileScreenProps {
	transport: MatrixTransport | null;
	accessToken: string | null;
	userId: UserId;
	onBack(): void;
	ignoredUsers?: Set<UserId>;
	isBot?: boolean;
	onStartDm?(userId: UserId): void | Promise<void>;
	canKickBanBots?: boolean;
	isMyBot?: boolean;
	canRemoveOwnBot?: boolean;
	onBotMembership?(action: "kick" | "ban", botMxid: UserId): void | Promise<void>;
	onViewProfile?(userId: UserId): void;
}

interface ProfileData {
	userId: string;
	displayName: string;
	avatarUrl?: string;
	homeserver: string;
}

export function MobileOtherProfileScreen({
	transport,
	accessToken,
	userId,
	onBack,
	ignoredUsers,
	isBot,
	onStartDm,
	canKickBanBots,
	isMyBot,
	canRemoveOwnBot,
	onBotMembership,
	onViewProfile,
}: MobileOtherProfileScreenProps) {
	const [loading, setLoading] = useState(true);
	const [profile, setProfile] = useState<ProfileData | null>(null);
	const [bio, setBio] = useState("");
	const [socialLinks, setSocialLinks] = useState<SocialLink[]>([]);
	const [bannerMxc, setBannerMxc] = useState<string | null>(null);
	const [founderNumber, setFounderNumber] = useState<number | null>(null);
	const [blocking, setBlocking] = useState(false);
	const [botActionPending, setBotActionPending] = useState<"kick" | "ban" | null>(null);
	const [error, setError] = useState<string | null>(null);

	const isBlocked = !!(ignoredUsers?.has(userId));
	const showFounderBotControls = !!(isBot && canKickBanBots && onBotMembership);
	const showOwnerRemoveControl = !!(isBot && isMyBot && !canKickBanBots && canRemoveOwnBot && onBotMembership);

	useEffect(() => {
		if (!transport) return;
		let cancelled = false;
		setLoading(true);
		setError(null);

		Promise.all([
			transport.getUserProfile(userId),
			fetchUserProfile(userId),
		])
			.then(([p, fp]) => {
				if (cancelled) return;
				setProfile(p);
				setBio(fp.bio ?? "");
				setSocialLinks(fp.social_links ?? []);
				setBannerMxc(fp.banner_mxc ?? null);
				setFounderNumber(fp.founder_number ?? null);
			})
			.catch((err) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => { if (!cancelled) setLoading(false); });

		return () => { cancelled = true; };
	}, [userId, transport]);

	async function toggleBlock() {
		if (!transport || blocking) return;
		setBlocking(true);
		try {
			if (isBlocked) {
				await transport.unignoreUser(userId);
			} else {
				await transport.ignoreUser(userId);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBlocking(false);
		}
	}

	async function handleBotAction(action: "kick" | "ban") {
		if (!onBotMembership || botActionPending) return;
		setBotActionPending(action);
		try {
			await onBotMembership(action, userId);
			onBack();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBotActionPending(null);
		}
	}

	return (
		<div className="flex flex-col h-full bg-background">
			<NavBar
				left={<NavBackButton onClick={onBack} />}
				title="Profile"
			/>

			<div className="flex-1 overflow-y-auto">
				{loading && !profile ? (
					<div className="flex items-center justify-center pt-24 text-[15px] text-muted-foreground">
						Loading…
					</div>
				) : profile ? (
					<div>
						<ProfileBanner
							mxc={bannerMxc}
							previewSrc={bannerMxc ? undefined : "/default-banner.png"}
							className="h-40"
						/>
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

						<GroupLabel>Bio</GroupLabel>
						<GroupCard>
							<div className="px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap">
								{bio.trim() ? (
									<span className="text-foreground">{bio}</span>
								) : (
									<span className="text-muted-foreground/60 italic">This user hasn't added a bio yet.</span>
								)}
							</div>
						</GroupCard>

						<GroupLabel>Links</GroupLabel>
						<GroupCard>
							{socialLinks.length > 0 ? (
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
							) : (
								<div className="px-4 py-3 text-[15px] text-muted-foreground/60 italic">
									No links added yet.
								</div>
							)}
						</GroupCard>

						{error && (
							<div className="mx-4 mt-4 text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
								{error}
							</div>
						)}

						{showFounderBotControls && (
							<>
								<GroupLabel>Space moderation</GroupLabel>
								<GroupCard>
									<div className="flex gap-2 px-4 py-3">
										<button
											type="button"
											onClick={() => handleBotAction("kick")}
											disabled={!!botActionPending || loading}
											className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-[15px] font-medium text-amber-500 active:opacity-60 transition-opacity disabled:opacity-40"
										>
											<UserX className="h-4 w-4" />
											{botActionPending === "kick" ? "Kicking…" : "Kick from space"}
										</button>
										<button
											type="button"
											onClick={() => handleBotAction("ban")}
											disabled={!!botActionPending || loading}
											className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-md text-[15px] font-medium text-destructive active:opacity-60 transition-opacity disabled:opacity-40"
										>
											<Ban className="h-4 w-4" />
											{botActionPending === "ban" ? "Banning…" : "Ban from space"}
										</button>
									</div>
								</GroupCard>
							</>
						)}

						{showOwnerRemoveControl && (
							<>
								<GroupLabel>Your bot</GroupLabel>
								<GroupCard>
									<button
										type="button"
										onClick={() => handleBotAction("kick")}
										disabled={!!botActionPending || loading}
										className="flex items-center justify-center gap-1.5 w-full px-4 py-3 text-[15px] font-medium text-amber-500 active:opacity-60 transition-opacity disabled:opacity-40"
									>
										<UserX className="h-4 w-4" />
										{botActionPending === "kick" ? "Removing…" : "Remove from space"}
									</button>
								</GroupCard>
							</>
						)}

						<div className="px-4 pt-6 pb-8 space-y-3">
							{onStartDm && !isBlocked && (
								<button
									type="button"
									onClick={() => onStartDm(userId)}
									disabled={loading}
									className="flex items-center justify-center gap-2 w-full py-3 rounded-xl bg-foreground text-background text-[15px] font-semibold active:opacity-80 transition-opacity disabled:opacity-40"
								>
									<MessageSquare className="h-4 w-4" />
									Message
								</button>
							)}
							{!isBot && (
								<button
									type="button"
									onClick={toggleBlock}
									disabled={blocking || loading}
									className={cn(
										"flex items-center justify-center gap-2 w-full py-3 rounded-xl text-[15px] font-semibold active:opacity-80 transition-opacity disabled:opacity-40",
										isBlocked ? "text-muted-foreground" : "text-destructive",
									)}
								>
									{isBlocked ? (
										<><UserCheck className="h-4 w-4" />{blocking ? "Unblocking…" : "Unblock"}</>
									) : (
										<><Ban className="h-4 w-4" />{blocking ? "Blocking…" : "Block"}</>
									)}
								</button>
							)}
						</div>
					</div>
				) : null}
			</div>
		</div>
	);
}

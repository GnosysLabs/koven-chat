// MobileBlockedUsersScreen — HIG sub-screen for managing the
// Matrix m.ignored_user_list.  Mirrors the desktop blocked-users
// section in AccountSection but rendered as native grouped rows:
// avatar + display name + mxid line, with a tinted Unblock action
// inline on the right.
//
// Behaviour deliberately matches the desktop section:
//   - Optimistic local hide while the unignore round-trips.
//   - No undo toast — once unblocked, the user just disappears
//     from this list.  Re-blocking happens through the member
//     profile sheet on either platform.
//
// Why not reuse AccountSection?  AccountSection bundles three
// independent surfaces (NSFW switch, blocked list, delete-account
// flow) into one panel meant for a desktop settings dialog.  On
// mobile each of those is its own push, so the blocked list
// renders without the other two — embedding AccountSection here
// would double-render NSFW + delete-account UI inside a screen
// titled "Blocked".

import { useEffect, useState } from "react";
import { UserCheck } from "lucide-react";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { hapticImpact, hapticSelection } from "@/lib/haptics";
import { formatMxid, serverOf } from "@/lib/mxid";
import type { MatrixTransport } from "@/lib/matrix";
import type { UserId } from "@koven/shared";
import { cn } from "@/lib/utils";
import {
	NavBar,
	NavBackButton,
	GroupLabel,
	GroupCard,
	GroupFooter,
	ErrorBanner,
} from "@/components/mobile/Chrome";

interface CachedProfile {
	userId: UserId;
	displayName: string;
	avatarUrl?: string;
}

export interface MobileBlockedUsersScreenProps {
	transport: MatrixTransport | null;
	ignoredUsers: Set<UserId>;
	onBack(): void;
}

export function MobileBlockedUsersScreen({
	transport,
	ignoredUsers,
	onBack,
}: MobileBlockedUsersScreenProps) {
	const [profiles, setProfiles] = useState<Map<UserId, CachedProfile>>(new Map());
	const [unblocking, setUnblocking] = useState<UserId | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Resolve display names + avatars for every blocked user.
	// Failures fall back to the raw mxid as the display name so
	// the row still renders informatively.  Cached on the
	// transport, so flipping back to this screen later is free.
	useEffect(() => {
		if (!transport) return;
		let cancelled = false;
		const missing: UserId[] = [];
		for (const id of ignoredUsers) {
			if (!profiles.has(id)) missing.push(id);
		}
		if (missing.length === 0) return;
		(async () => {
			const next = new Map(profiles);
			await Promise.all(missing.map(async id => {
				try {
					const p = await transport.getUserProfile(id);
					next.set(id, {
						userId: id,
						displayName: p.displayName,
						avatarUrl: p.avatarUrl,
					});
				} catch {
					next.set(id, { userId: id, displayName: id });
				}
			}));
			if (!cancelled) setProfiles(next);
		})();
		return () => { cancelled = true; };
		// `profiles` intentionally excluded — including it would
		// re-fire every time we cache another profile, looping.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [transport, ignoredUsers]);

	async function unblock(userId: UserId) {
		if (!transport) return;
		void hapticImpact("light");
		setUnblocking(userId);
		setError(null);
		try {
			await transport.unignoreUser(userId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setUnblocking(null);
		}
	}

	const blocked = Array.from(ignoredUsers);
	const viewerServer = serverOf(transport?.currentUserId ?? null);

	return (
		<div className="flex flex-col h-full">
			<NavBar
				left={<NavBackButton onClick={() => { void hapticSelection(); onBack(); }} />}
				title="Blocked"
			/>

			<div className="flex-1 overflow-y-auto pb-10">
				<GroupLabel>Blocked Users</GroupLabel>

				{blocked.length === 0 ? (
					<>
						<GroupCard>
							<div className="px-4 py-5 text-center text-[15px] text-muted-foreground italic">
								You haven't blocked anyone.
							</div>
						</GroupCard>
						<GroupFooter>
							Blocking hides someone's messages from your timeline and stops their DMs from reaching you. Open a member's profile to block them.
						</GroupFooter>
					</>
				) : (
					<>
						<GroupCard>
							{blocked.map((id, idx) => {
								const p = profiles.get(id);
								const last = idx === blocked.length - 1;
								return (
									<div
										key={id}
										className={cn(
											"w-full flex items-center gap-3 pl-3 pr-3 py-2.5",
											"min-h-[60px]",
											!last && "border-b border-foreground/10",
										)}
									>
										<MatrixAvatar
											mxc={p?.avatarUrl}
											seed={id}
											kind="user"
											className="h-10 w-10 rounded-full shrink-0"
										/>
										<div className="flex-1 min-w-0">
											<div className="text-[17px] text-foreground truncate leading-tight">
												{p?.displayName ?? id}
											</div>
											<div className="text-[13px] text-muted-foreground font-mono truncate mt-0.5">
												{formatMxid(id, viewerServer)}
											</div>
										</div>
										<button
											type="button"
											onClick={() => unblock(id)}
											disabled={unblocking === id}
											className={cn(
												"shrink-0 inline-flex items-center gap-1 px-3 h-8",
												"rounded-full bg-primary/10 text-primary text-[14px] font-medium",
												"active:bg-primary/20 transition-colors",
												"disabled:opacity-50",
											)}
										>
											<UserCheck className="h-3.5 w-3.5" strokeWidth={2.25} />
											{unblocking === id ? "…" : "Unblock"}
										</button>
									</div>
								);
							})}
						</GroupCard>
						<GroupFooter>
							Block is a personal filter — admins don't see it. To get admins involved, report instead.
						</GroupFooter>
					</>
				)}

				{error && <ErrorBanner message={error} />}
			</div>
		</div>
	);
}

// Platform bans management.  Lists every currently banned user and
// lets admins lift bans.  Sits alongside AdminManagementSection in the
// Settings > Instance tab.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { Ban } from "lucide-react";
import {
	fetchPlatformBans,
	adminUnbanUser,
	type PlatformBan,
} from "@/lib/instance";
import { formatMxid } from "@/lib/mxid";
import type { MatrixTransport } from "@/lib/matrix";

export interface BannedUsersSectionProps {
	accessToken: string;
	transport: MatrixTransport | null;
}

export function BannedUsersSection({ accessToken, transport }: BannedUsersSectionProps) {
	const [bans, setBans] = useState<PlatformBan[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [pendingMxid, setPendingMxid] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [profiles, setProfiles] = useState<Map<string, { displayName?: string; avatarUrl?: string }>>(new Map());

	async function refresh() {
		try {
			const list = await fetchPlatformBans(accessToken);
			setLoadError(null);
			setBans(list);
		} catch {
			setLoadError("Couldn't load the banned-users list.");
		}
	}

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [accessToken]);

	useEffect(() => {
		if (!bans || !transport) return;
		let cancelled = false;
		const toResolve = bans.filter(b => !profiles.has(b.user_id));
		if (toResolve.length === 0) return;
		Promise.allSettled(
			toResolve.map(b =>
				transport.getUserProfile(b.user_id as any).then(p => ({
					userId: b.user_id,
					displayName: p.displayName,
					avatarUrl: p.avatarUrl,
				})),
			),
		).then(results => {
			if (cancelled) return;
			const next = new Map(profiles);
			for (const r of results) {
				if (r.status === "fulfilled") {
					next.set(r.value.userId, {
						displayName: r.value.displayName,
						avatarUrl: r.value.avatarUrl,
					});
				}
			}
			setProfiles(next);
		});
		return () => { cancelled = true; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [bans, transport]);

	async function handleUnban(userId: string) {
		if (pendingMxid) return;
		if (typeof window !== "undefined" && !window.confirm(
			`Lift the platform ban on ${userId}? They will be able to sign in again.`,
		)) return;
		setPendingMxid(userId);
		setError(null);
		try {
			await adminUnbanUser(accessToken, userId);
			setBans(prev => (prev ?? []).filter(b => b.user_id !== userId));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPendingMxid(null);
		}
	}

	if (loadError) {
		return (
			<div className="space-y-2">
				<Label className="text-sm font-medium">Platform bans</Label>
				<p className="text-xs text-destructive">{loadError}</p>
			</div>
		);
	}

	if (bans === null) {
		return (
			<div className="space-y-2">
				<Label className="text-sm font-medium">Platform bans</Label>
				<p className="text-xs text-muted-foreground">Loading...</p>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<div>
				<Label className="text-sm font-medium">Platform bans</Label>
				<p className="text-xs text-muted-foreground mt-0.5">
					Users banned from the entire instance. Banned users cannot sign in until unbanned.
				</p>
			</div>

			{error && (
				<p className="text-xs text-destructive">{error}</p>
			)}

			{bans.length === 0 ? (
				<p className="text-xs text-muted-foreground italic py-2">No platform bans.</p>
			) : (
				<ul className="space-y-2">
					{bans.map(ban => {
						const p = profiles.get(ban.user_id);
						const busy = pendingMxid === ban.user_id;
						return (
							<li
								key={ban.user_id}
								className="flex items-center gap-3 p-2 rounded border border-border bg-card/50"
							>
								<MatrixAvatar
									mxc={p?.avatarUrl}
									seed={ban.user_id}
									className="h-8 w-8 shrink-0"
								/>
								<div className="flex-1 min-w-0">
									<div className="text-sm font-medium truncate">
										{p?.displayName ?? formatMxid(ban.user_id, null)}
									</div>
									<div className="text-[11px] text-muted-foreground truncate">
										{ban.user_id}
									</div>
									{ban.reason && (
										<div className="text-[11px] text-muted-foreground italic mt-0.5 truncate">
											{ban.reason}
										</div>
									)}
									<div className="text-[10px] text-muted-foreground/70 mt-0.5 tabular-nums">
										Banned {new Date(ban.banned_at).toLocaleDateString()}
										{ban.banned_by ? ` by ${formatMxid(ban.banned_by, null)}` : ""}
									</div>
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => handleUnban(ban.user_id)}
									disabled={busy}
									className="shrink-0 text-amber-500 hover:text-amber-500 border-amber-500/40"
								>
									<Ban className="h-3.5 w-3.5 mr-1" />
									{busy ? "Unbanning..." : "Unban"}
								</Button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

// Admin-only roster management.  Lists every current admin row,
// lets an existing admin promote any directory-discoverable user to
// admin, and exposes a per-row remove button (refused server-side
// when the target is the only remaining admin — see /api/admins/revoke
// for the policy).
//
// Sits alongside InstanceAdminSection in the Settings → Instance tab.
// Kept as a separate component because the concerns barely overlap:
// branding is a static-config form, admin management is a list +
// search picker that needs its own debounced fetch.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { cn } from "@/lib/utils";
import { Trash2, ShieldCheck, Plus } from "lucide-react";
import {
	listAdmins,
	grantAdminUser,
	revokeAdminUser,
	type AdminRow,
} from "@/lib/instance";
import type { MatrixTransport } from "@/lib/matrix";

export interface AdminManagementSectionProps {
	accessToken: string;
	transport: MatrixTransport | null;
	// Current viewer's mxid — used to flag the "this is you" row in
	// the list and to gate the self-revoke affordance (still allowed
	// when there's at least one other admin).
	currentUserId: string;
}

interface DirectoryResult {
	userId: string;
	displayName?: string;
	avatarUrl?: string;
}

export function AdminManagementSection({ accessToken, transport, currentUserId }: AdminManagementSectionProps) {
	const [admins, setAdmins] = useState<AdminRow[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	// Search picker state — mirrors StartDmSheet's debounced
	// directory-search loop so the affordance feels consistent.
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<DirectoryResult[]>([]);
	const [searching, setSearching] = useState(false);
	const queryDebounceRef = useRef<number | null>(null);

	const [pendingMxid, setPendingMxid] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);

	const adminMxidSet = useMemo(
		() => new Set((admins ?? []).map(a => a.user_id)),
		[admins],
	);

	async function refresh() {
		const list = await listAdmins(accessToken);
		if (list === null) {
			setLoadError("Couldn't load the admin list — try reopening Settings.");
			return;
		}
		setLoadError(null);
		setAdmins(list);
	}

	// Initial load + reload whenever the access token rotates.
	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [accessToken]);

	// Debounced directory search — copy of the StartDmSheet pattern.
	// Filters out anyone who's already an admin so the picker can't
	// produce no-op grants, and skips the current viewer (you can't
	// promote yourself, you already have it).
	useEffect(() => {
		if (!transport) return;
		if (queryDebounceRef.current) window.clearTimeout(queryDebounceRef.current);
		const trimmed = query.trim();
		if (!trimmed) {
			setResults([]);
			setSearching(false);
			return;
		}
		setSearching(true);
		queryDebounceRef.current = window.setTimeout(async () => {
			try {
				const matches = await transport.searchUsers(trimmed, 8);
				const filtered = matches.filter(m => !adminMxidSet.has(m.userId));
				setResults(filtered.map(m => ({
					userId: m.userId,
					displayName: m.displayName,
					avatarUrl: m.avatarUrl,
				})));
			} catch (err) {
				console.warn("admin search threw", err);
				setResults([]);
			} finally {
				setSearching(false);
			}
		}, 250);
		return () => {
			if (queryDebounceRef.current) window.clearTimeout(queryDebounceRef.current);
		};
	}, [query, transport, adminMxidSet]);

	async function promote(userId: string) {
		setError(null);
		setInfo(null);
		setPendingMxid(userId);
		try {
			const r = await grantAdminUser(accessToken, userId);
			if (!r.ok) {
				setError(r.error ?? "Promotion failed.");
				return;
			}
			setInfo(`${userId} is now an admin.`);
			setQuery("");
			setResults([]);
			await refresh();
		} finally {
			setPendingMxid(null);
		}
	}

	async function demote(userId: string) {
		setError(null);
		setInfo(null);
		setPendingMxid(userId);
		try {
			const r = await revokeAdminUser(accessToken, userId);
			if (!r.ok) {
				// Engine returns "cannot revoke the last admin — promote
				// someone else first" with HTTP 409.  Surface verbatim
				// so the admin understands why it bounced.
				setError(r.error ?? "Demotion failed.");
				return;
			}
			setInfo(userId === currentUserId
				? "You're no longer an admin.  Settings will refresh on next open."
				: `${userId} is no longer an admin.`);
			await refresh();
		} finally {
			setPendingMxid(null);
		}
	}

	// Free-form mxid promote: lets an admin promote a user who isn't
	// in the directory (e.g. federated user, or a fresh account that
	// hasn't shown up yet) by typing the full @user:server id and
	// clicking the explicit add button.  Validation matches the
	// engine's M_INVALID_PARAM check so we fail fast in-UI.
	const trimmedQuery = query.trim();
	const looksLikeMxid = trimmedQuery.startsWith("@") && trimmedQuery.includes(":");
	const canPromoteRaw = looksLikeMxid && !adminMxidSet.has(trimmedQuery) && trimmedQuery !== currentUserId;

	return (
		<section className="space-y-4">
			<div>
				<div className="flex items-center gap-2">
					<ShieldCheck className="h-4 w-4 text-primary" />
					<h3 className="text-sm font-semibold">Admins</h3>
				</div>
				<p className="text-xs text-muted-foreground mt-1 leading-snug">
					Admins manage instance branding, the floor-violation review queue, and can promote or demote other admins.  At least one admin must always exist.
				</p>
			</div>

			{loadError ? (
				<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
					{loadError}
				</div>
			) : null}

			{/* Current roster */}
			<div className="border border-border rounded-md divide-y divide-border">
				{admins === null ? (
					<div className="text-xs text-muted-foreground p-3">Loading…</div>
				) : admins.length === 0 ? (
					<div className="text-xs text-muted-foreground p-3">No admins yet.</div>
				) : (
					admins.map(a => {
						const isSelf = a.user_id === currentUserId;
						const onlyAdmin = admins.length === 1;
						const removeDisabled = onlyAdmin || pendingMxid === a.user_id;
						return (
							<div key={a.user_id} className="flex items-center gap-3 px-3 py-2">
								<MatrixAvatar
									seed={a.user_id}
									kind="user"
									className="h-7 w-7"
								/>
								<div className="min-w-0 flex-1">
									<div className="text-sm truncate flex items-center gap-1.5">
										<span className="truncate">{a.user_id}</span>
										{isSelf && (
											<span className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded bg-primary/15 text-primary">
												You
											</span>
										)}
									</div>
									<div className="text-[10px] text-muted-foreground">
										{a.granted_by
											? <>Granted by <span className="font-medium">{a.granted_by}</span> · {formatDate(a.granted_at)}</>
											: <>Founding admin · {formatDate(a.granted_at)}</>}
									</div>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="text-muted-foreground hover:text-destructive"
									disabled={removeDisabled}
									title={onlyAdmin ? "Promote someone else first — at least one admin must remain" : (isSelf ? "Step down from admin" : "Revoke admin")}
									onClick={() => demote(a.user_id)}
								>
									<Trash2 className="h-3.5 w-3.5 mr-1" /> {isSelf ? "Step down" : "Revoke"}
								</Button>
							</div>
						);
					})
				)}
			</div>

			{/* Add new admin */}
			<div className="space-y-2">
				<Label htmlFor="admin-search">Promote a user</Label>
				<Input
					id="admin-search"
					value={query}
					onChange={(e) => { setQuery(e.target.value); setError(null); setInfo(null); }}
					placeholder="Search by name or paste @user:server"
					autoComplete="off"
				/>

				{/* Free-form mxid path — click adds without picking. */}
				{canPromoteRaw && results.length === 0 && !searching && (
					<Button
						type="button"
						size="sm"
						onClick={() => promote(trimmedQuery)}
						disabled={pendingMxid === trimmedQuery}
					>
						<Plus className="h-3.5 w-3.5 mr-1.5" />
						{pendingMxid === trimmedQuery ? "Promoting…" : `Promote ${trimmedQuery}`}
					</Button>
				)}

				{/* Search results — directory matches not already admin. */}
				{(searching || results.length > 0) && (
					<div className="border border-border rounded-md max-h-[200px] overflow-y-auto divide-y divide-border">
						{searching && results.length === 0 ? (
							<div className="text-xs text-muted-foreground p-3">Searching…</div>
						) : (
							results.map(r => (
								<button
									key={r.userId}
									type="button"
									onClick={() => promote(r.userId)}
									disabled={pendingMxid === r.userId}
									className={cn(
										"w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors",
										pendingMxid === r.userId && "opacity-60",
									)}
								>
									<MatrixAvatar
										mxc={r.avatarUrl}
										seed={r.userId}
										kind="user"
										className="h-7 w-7"
									/>
									<div className="min-w-0 flex-1">
										<div className="text-sm truncate">{r.displayName ?? r.userId}</div>
										<div className="text-[10px] text-muted-foreground truncate">{r.userId}</div>
									</div>
									<span className="text-[11px] text-primary font-medium shrink-0">
										{pendingMxid === r.userId ? "Promoting…" : "Promote"}
									</span>
								</button>
							))
						)}
					</div>
				)}
			</div>

			{error && (
				<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
					{error}
				</div>
			)}
			{info && !error && (
				<div className="text-xs text-emerald-500/90 border border-emerald-500/30 bg-emerald-500/5 rounded px-3 py-2">
					{info}
				</div>
			)}
		</section>
	);
}

function formatDate(ms: number): string {
	try {
		return new Date(ms).toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	} catch {
		return "—";
	}
}

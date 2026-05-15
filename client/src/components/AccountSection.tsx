// Account settings: blocked users + permanent account deletion.
//
// Two distinct primitives sharing one tab because both are
// account-scoped (not per-room) and both involve people the user is
// trying to step away from.
//
// 1. BLOCKED USERS. Matrix-native ignore (m.ignored_user_list). A
//    one-sided client filter: messages from these users no longer
//    render in your timeline. Block is a personal filter, separate
//    from the reports admins act on.
//
// 2. DELETE ACCOUNT. POST /_matrix/client/v3/account/deactivate via
//    UIA password. Synapse is asked to erase the account's events
//    (`erase: true` is the default), and the engine drops any
//    remaining account-side rows via /api/me/purge before the
//    deactivate call goes out. Refused if the user is the only
//    remaining admin.
//
//    UIA: with email-code auth there's no user-known password, so the
//    delete flow fetches a fresh ephemeral UIA password from the
//    engine right before submitting (the engine rotates Synapse's
//    stored password to the new value via admin API). The password
//    lives in transport memory for the few seconds the deactivate
//    call takes, then is cleared.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Ban, ShieldAlert, Trash2, UserCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { serverOf, formatMxid } from "@/lib/mxid";
import type { MatrixTransport } from "@/lib/matrix";
import type { UserId } from "@koven/shared";
import type { Settings } from "@/state/settings";
import { fetchAdminStatus, purgeMyEngineState } from "@/lib/instance";
import { fetchUiaPassword } from "@/lib/auth";

export interface AccountSectionProps {
	accessToken: string;
	transport: MatrixTransport | null;
	ignoredUsers: Set<UserId>;
	// Fired after a successful self-deactivation so the parent can
	// drop credentials and route back to login.
	onSignedOut(): void;
	// Per-device user settings, passed through so this tab can host
	// account-level discovery/content prefs (NSFW gate, etc.) next
	// to the blocked-users + delete-account primitives that already
	// live here.
	settings: Settings;
	onSettingsChange(next: Settings): void;
}

export function AccountSection({ accessToken, transport, ignoredUsers, onSignedOut, settings, onSettingsChange }: AccountSectionProps) {
	const serverName = serverOf(transport?.currentUserId ?? null) ?? "koven.chat";
	const blocked = useMemo(() => Array.from(ignoredUsers), [ignoredUsers]);
	const [unblockingUser, setUnblockingUser] = useState<UserId | null>(null);
	const [unblockError, setUnblockError] = useState<string | null>(null);

	// Deletion flow.  Three distinct UI states:
	//   "idle":       just a "Delete account" button
	//   "confirming": ack-checkbox + final-confirm
	//   "running":    request in flight
	const [deleteState, setDeleteState] = useState<"idle" | "confirming" | "running">("idle");
	const [deleteAck, setDeleteAck] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);

	// Only-admin gate.  Pulled from /api/instance/me on mount.  When
	// the user is the lone admin we surface a "promote another admin
	// first" message instead of the delete button.
	const [isOnlyAdmin, setIsOnlyAdmin] = useState<boolean | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchAdminStatus(accessToken)
			.then(r => { if (!cancelled) setIsOnlyAdmin(!!r.is_only_admin); })
			.catch(() => { if (!cancelled) setIsOnlyAdmin(false); });
		return () => { cancelled = true; };
	}, [accessToken]);

	async function unblock(userId: UserId) {
		if (!transport) return;
		setUnblockingUser(userId);
		setUnblockError(null);
		try {
			await transport.unignoreUser(userId);
		} catch (err) {
			setUnblockError(err instanceof Error ? err.message : String(err));
		} finally {
			setUnblockingUser(null);
		}
	}

	async function runDelete() {
		if (!transport) return;
		setDeleteState("running");
		setDeleteError(null);
		try {
			// 1. Engine cleanup first (this is also where we re-check
			//    the only-admin gate; the engine will refuse with 409 if
			//    the cached UI state was stale).
			const purge = await purgeMyEngineState(accessToken);
			if (!purge.ok) {
				throw new Error(purge.error ?? "engine cleanup failed");
			}
			// 2. Fetch a fresh UIA password from the engine.  This
			//    rotates Synapse's stored password for this user to a
			//    new random string we know, lets us satisfy the
			//    m.login.password UIA stage on the deactivate call,
			//    and never leaves transport memory.
			const uiaPassword = await fetchUiaPassword(accessToken);
			transport.setUiaPassword(uiaPassword);
			try {
				await transport.deactivateMyAccount(undefined, true);
			} finally {
				transport.setUiaPassword(null);
			}
			// 3. Drop credentials and bounce back to login.  Anything
			//    else the app does post-deactivation will 401 anyway.
			onSignedOut();
		} catch (err) {
			setDeleteError(err instanceof Error ? err.message : String(err));
			setDeleteState("confirming");
		}
	}

	return (
		<div className="space-y-8">
			{/* ─── Content ──────────────────────────────────────────
			    Discovery preferences that aren't tied to a single
			    room or DM.  Currently just the NSFW gate; future
			    knobs (autoplay, link previews, mature-language
			    filter) would land here too. */}
			<section className="space-y-3">
				<div>
					<div className="text-sm font-medium">Content</div>
					<p className="text-xs text-muted-foreground leading-snug mt-0.5">
						Choose what's discoverable in Explore. This doesn't affect spaces you've already joined — once you're in, you're in.
					</p>
				</div>
				<div className="flex items-start justify-between gap-4 px-3 py-3 rounded-md border border-border bg-muted/30">
					<div className="flex-1 min-w-0">
						<div className="text-sm font-medium">Show NSFW spaces</div>
						<p className="text-xs text-muted-foreground leading-snug mt-0.5">
							Adult-content spaces stay hidden from search and browse until you turn this on.
						</p>
					</div>
					<Switch
						checked={!!settings.showNsfw}
						onCheckedChange={(checked) => onSettingsChange({ ...settings, showNsfw: checked })}
					/>
				</div>
			</section>

			{/* ─── Blocked users ──────────────────────────────────── */}
			<section className="space-y-3">
				<div>
					<div className="text-sm font-medium">Blocked users</div>
					<p className="text-xs text-muted-foreground leading-snug mt-0.5">
						Hides their messages from your timeline and stops their DMs from reaching you. Block is a personal filter; admins don't see it. To get admins involved, report instead.
					</p>
				</div>

				{blocked.length === 0 ? (
					<div className="text-xs text-muted-foreground italic border border-border rounded px-3 py-3 bg-muted/30">
						You haven't blocked anyone.
					</div>
				) : (
					<ul className="space-y-1.5">
						{blocked.map(userId => (
							<li
								key={userId}
								className="flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-border bg-muted/30"
							>
								<span className="font-mono text-xs truncate">{formatMxid(userId, serverName)}</span>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => unblock(userId)}
									disabled={unblockingUser === userId}
									className="text-muted-foreground hover:text-foreground"
								>
									<UserCheck className="h-3.5 w-3.5 mr-1.5" />
									{unblockingUser === userId ? "Unblocking…" : "Unblock"}
								</Button>
							</li>
						))}
					</ul>
				)}
				{unblockError && (
					<p className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
						{unblockError}
					</p>
				)}
			</section>

			{/* ─── Delete account ─────────────────────────────────── */}
			<section className="space-y-3 pt-6 border-t border-border">
				<div>
					<div className="text-sm font-medium flex items-center gap-1.5">
						<ShieldAlert className="h-3.5 w-3.5 text-destructive" />
						Delete account
					</div>
					<p className="text-xs text-muted-foreground leading-snug mt-0.5">
						Permanently deactivates your account on the homeserver and asks Synapse to erase the contents of every message you've authored. The username is retired and can't be reused. This cannot be undone.
					</p>
				</div>

				{isOnlyAdmin === null ? (
					// Probe in flight — render nothing rather than
					// flashing the Delete button (which would imply
					// "go ahead, delete") followed by the
					// only-admin warning a moment later when the
					// fetch lands.  The delete account flow is
					// destructive, so a one-frame "click here to
					// destroy your account" before "wait, you can't"
					// is the wrong UX even if it's brief.
					null
				) : isOnlyAdmin ? (
					<div className="text-xs border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400 rounded px-3 py-2 leading-relaxed">
						You're the only admin on this instance. Promote another admin before deleting your account, or report review on this instance will become impossible.
					</div>
				) : deleteState === "idle" ? (
					<Button
						type="button"
						variant="destructive"
						size="sm"
						onClick={() => { setDeleteState("confirming"); setDeleteError(null); }}
					>
						<Trash2 className="h-3.5 w-3.5 mr-1.5" />
						Delete account
					</Button>
				) : (
					<div className={cn(
						"space-y-3 border rounded-md px-3 py-3",
						"border-destructive/40 bg-destructive/5",
					)}>
						<ul className="text-xs leading-relaxed text-muted-foreground space-y-1 list-disc list-inside">
							<li>Your username (Matrix ID) is permanently retired.</li>
							<li>The contents of every message you've sent are erased on the homeserver.</li>
							<li>Direct conversations on your side disappear; the other party retains their copy.</li>
							<li>Reports you submitted stay in the audit log.</li>
						</ul>

						<label className="flex items-start gap-2 text-xs">
							<input
								type="checkbox"
								checked={deleteAck}
								onChange={e => setDeleteAck(e.target.checked)}
								className="mt-0.5"
								disabled={deleteState === "running"}
							/>
							<span className="leading-snug">
								I understand this is permanent and cannot be reversed.
							</span>
						</label>

						{deleteError && (
							<p className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
								{deleteError}
							</p>
						)}

						<div className="flex gap-2">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => {
									setDeleteState("idle");
									setDeleteAck(false);
									setDeleteError(null);
								}}
								disabled={deleteState === "running"}
							>
								Cancel
							</Button>
							<Button
								type="button"
								variant="destructive"
								size="sm"
								onClick={runDelete}
								disabled={!deleteAck || deleteState === "running"}
							>
								<Ban className="h-3.5 w-3.5 mr-1.5" />
								{deleteState === "running" ? "Deactivating…" : "Permanently delete account"}
							</Button>
						</div>
					</div>
				)}
			</section>
		</div>
	);
}

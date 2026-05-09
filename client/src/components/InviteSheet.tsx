// Multi-user invite dialog.  Used by the space landing's "Invite"
// button and the chat header's invite affordance.  Search is the
// same homeserver-directory backend that StartDmSheet uses; the
// difference is multi-select — you can stage several recipients and
// fire all the invites at once.

import { useEffect, useRef, useState } from "react";
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
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import type { MatrixTransport } from "@/lib/matrix";
import type { RoomId, UserId } from "@koven/shared";
import { fetchBotDirectory, type PublicBotEntry } from "@/lib/bots-cache";
import { BotBadge } from "@/components/BotBadge";

interface DirectoryResult {
	userId: UserId;
	displayName?: string;
	avatarUrl?: string;
	isBot?: boolean;
}

export interface InviteSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	transport: MatrixTransport | null;
	roomId: RoomId | null;
	roomName: string;
	isSpace?: boolean;
}

export function InviteSheet({ open, onOpenChange, transport, roomId, roomName, isSpace }: InviteSheetProps) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<DirectoryResult[]>([]);
	const [selected, setSelected] = useState<DirectoryResult[]>([]);
	const [searching, setSearching] = useState(false);
	// Inline validation for the empty-selection case.  We no longer
	// surface invite-progress / success here because send() closes the
	// modal immediately and fires invites in the background — see the
	// long comment in send() for the rationale.
	const [error, setError] = useState<string | null>(null);
	const queryDebounceRef = useRef<number | null>(null);
	// Snapshot of the local bot roster, fetched on open.  We merge
	// matching bots into the directory results so freshly-created
	// bots are pickable before they've joined any rooms (Synapse's
	// user_directory only indexes users with shared room membership).
	const [botRoster, setBotRoster] = useState<PublicBotEntry[]>([]);

	// Reset everything whenever the dialog opens for a new target.
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setResults([]);
		setSelected([]);
		setError(null);
		// Refresh the bot roster on every open so bots created after
		// the page loaded still show up.  Cheap unauthenticated
		// fetch; failure leaves the roster empty (search falls back
		// to directory only).
		void fetchBotDirectory().then(setBotRoster);
		// Proactive permission repair: rooms created before the
		// atomic-PL fix can carry a stranded invite>0 power level
		// that 403s any non-creator's invite.  Fire-and-forget the
		// repair endpoint on open so the PL is good by the time the
		// user clicks Invite.  No-ops on already-correct rooms.
		if (transport && roomId) {
			void transport.repairRoomInvitePermissions(roomId);
		}
	}, [open, roomId, transport]);

	// Debounced search on the homeserver's user directory.  Filters
	// out the current user and anyone already staged in `selected`.
	useEffect(() => {
		if (!open || !transport) return;
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
				const me = transport.currentUserId;
				const selectedIds = new Set(selected.map(s => s.userId));
				const lower = trimmed.toLowerCase();
				// Bots first: substring match against display name AND
				// localpart so "jeev" finds "Jeeves" / "@bot-jeeves".
				// Synapse's directory often misses bots that haven't
				// shared a room yet, so this is the canonical source
				// for them.
				const directoryIds = new Set(matches.map(m => m.userId));
				const botMatches: DirectoryResult[] = botRoster
					.filter(b => {
						if (b.mxid === me || selectedIds.has(b.mxid) || directoryIds.has(b.mxid)) return false;
						// Group invites for non-owner bots are
						// rejected engine-side (see bot_runtime
						// auto-decline).  Hide them from the picker
						// rather than letting users click into a
						// silent failure.  Self can't be the bot's
						// owner if me is null (signed-out / unknown),
						// so be defensive about that too.
						if (!me || b.ownerId !== me) return false;
						return b.displayName.toLowerCase().includes(lower)
							|| b.mxid.toLowerCase().includes(lower);
					})
					.slice(0, 8)
					.map(b => ({
						userId: b.mxid,
						displayName: b.displayName,
						avatarUrl: b.avatarMxc ?? undefined,
						isBot: true,
					}));
				const directoryMatches = matches
					.filter(m => m.userId !== me && !selectedIds.has(m.userId));
				setResults([...botMatches, ...directoryMatches]);
			} catch (err) {
				console.warn("searchUsers failed", err);
				setResults([]);
			} finally {
				setSearching(false);
			}
		}, 250);
		return () => {
			if (queryDebounceRef.current) window.clearTimeout(queryDebounceRef.current);
		};
	}, [query, open, transport, selected, botRoster]);

	function addUser(u: DirectoryResult) {
		setSelected(s => s.some(x => x.userId === u.userId) ? s : [...s, u]);
		setQuery("");
		setResults([]);
	}

	function removeUser(userId: UserId) {
		setSelected(s => s.filter(u => u.userId !== userId));
	}

	function addRawUserId() {
		const trimmed = query.trim();
		if (!trimmed.startsWith("@") || !trimmed.includes(":")) return;
		addUser({ userId: trimmed as UserId });
	}

	function send() {
		if (!transport || !roomId) return;
		const targets: UserId[] = [...selected.map(s => s.userId)];
		// Allow firing without clicking a search result if the user
		// pasted a full @user:server id directly.
		const rawTrimmed = query.trim();
		if (rawTrimmed.startsWith("@") && rawTrimmed.includes(":") &&
			!targets.includes(rawTrimmed as UserId)) {
			targets.push(rawTrimmed as UserId);
		}
		if (targets.length === 0) {
			setError("Pick someone to invite first.");
			return;
		}
		// Close immediately and fan out invites in the background.
		// Reasoning: inviteUsers is rate-limit-aware (a burst of N
		// parallel /invite calls then a serial path with sleep gaps),
		// so for a 30-person invite it can take 10+ seconds.  Holding
		// the modal open the whole time felt frozen.  The recipient-
		// side experience is identical either way (invites land via
		// /sync as soon as Synapse processes them); the local user
		// just doesn't have to stare at a spinner.
		//
		// Per-invitee failures are surfaced as errors in the engine
		// + browser console.  If the whole batch fails (e.g. lost
		// network, room deleted), nothing visible happens — that's
		// the cost of fire-and-forget; we'd need a global toast
		// system to do better.  For now this matches Discord's
		// behaviour, which also closes the invite picker on send
		// and just trusts it.
		const t = transport;
		void (async () => {
			try {
				const res = await t.inviteUsers(roomId, targets);
				if (res.failed.length > 0) {
					console.warn(
						`InviteSheet: ${res.failed.length}/${targets.length} invites failed`,
						res.failed,
					);
				}
			} catch (err) {
				console.warn("InviteSheet: invite batch threw", err);
			}
		})();
		onOpenChange(false);
	}

	const targetWord = isSpace ? "space" : "room";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Invite to {roomName}</DialogTitle>
					<DialogDescription>
						Search for people on this server. They'll get an invite they can accept or decline.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					{selected.length > 0 && (
						<div className="flex flex-wrap gap-1.5 p-2 rounded-md border border-border bg-muted/30">
							{selected.map(u => (
								<span
									key={u.userId}
									className="inline-flex items-center gap-1.5 pl-1 pr-1.5 py-0.5 rounded-full bg-card border border-border text-xs"
								>
									<MatrixAvatar mxc={u.avatarUrl} seed={u.userId} className="h-4 w-4" />
									<span className="font-medium">{u.displayName ?? u.userId}</span>
									<button
										type="button"
										onClick={() => removeUser(u.userId)}
										className="text-muted-foreground hover:text-destructive"
										aria-label={`Remove ${u.userId}`}
									>
										<X className="h-3 w-3" />
									</button>
								</span>
							))}
						</div>
					)}

					<div className="space-y-1.5">
						<Label htmlFor="invite-query">Find a person</Label>
						<Input
							id="invite-query"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => {
								// Enter on a raw @user:server id adds it to the
								// selected list without requiring a search hit.
								if (e.key === "Enter" && query.trim().startsWith("@")) {
									e.preventDefault();
									addRawUserId();
								}
							}}
							placeholder="alice or @alice:localhost"
							autoFocus
							autoComplete="off"
						/>
					</div>

					<div className="border border-border rounded-md min-h-[120px] max-h-[220px] overflow-y-auto">
						{searching && results.length === 0 ? (
							<div className="text-xs text-muted-foreground p-3">Searching…</div>
						) : results.length === 0 ? (
							<div className="text-xs text-muted-foreground p-3 leading-snug">
								{query.trim()
									? "No matches yet — keep typing, or paste a full @user:server id and press Enter."
									: "Start typing to search the homeserver directory. You can pick multiple."}
							</div>
						) : (
							<ul className="divide-y divide-border">
								{results.map(r => (
									<li key={r.userId}>
										<button
											type="button"
											onClick={() => addUser(r)}
											className={cn(
												"w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors",
											)}
										>
											<MatrixAvatar
												mxc={r.avatarUrl}
												seed={r.userId}
												kind={r.isBot ? "bot" : "user"}
												className="h-6 w-6"
											/>
											<div className="min-w-0 flex-1">
												<div className="text-sm truncate flex items-center gap-1.5">
													<span className="truncate">{r.displayName ?? r.userId}</span>
													{r.isBot && <BotBadge />}
												</div>
												{r.displayName && (
													<div className="text-[10px] text-muted-foreground font-mono truncate">{r.userId}</div>
												)}
											</div>
										</button>
									</li>
								))}
							</ul>
						)}
					</div>

					{error && (
						<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
							{error}
						</div>
					)}
				</div>

				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						type="button"
						onClick={send}
						disabled={selected.length === 0 && !query.trim().startsWith("@")}
					>
						{selected.length === 0
							? `Invite to ${targetWord}`
							: `Invite ${selected.length} to ${targetWord}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// Multi-account switcher popover.
//
// Anchored to the user-avatar button at the top of the SpaceBar.
// Lists every account the user has signed into on this origin, with
// the active one marked, plus an "Add account" CTA at the bottom and
// a per-row sign-out affordance.  Clicking a non-active row triggers
// `onSwitch` which (in App.tsx) flips activeUserId — the cred-watching
// effect tears down the live transport, runs the rust-crypto IDB
// drain, and brings up a fresh transport for the picked account.
//
// "Open profile" stays the primary click on the active row so the
// most-common use of the avatar (open my profile) doesn't grow an
// extra step now that we're hosting a popover behind the same hit
// target — the popover itself opens via a separate caret.

import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { cn } from "@/lib/utils";
import { LogOut, Plus, Check, User as UserIcon } from "lucide-react";
import type { StoredAccount } from "@/lib/accounts";

export interface AccountSwitcherProps {
	accounts: StoredAccount[];
	activeUserId: string | null;
	// Called when the user clicks a non-active row.  Implementation
	// in App.tsx flips the activeUserId state and lets the
	// transport-lifecycle effect handle the actual switch.
	onSwitch(userId: string): void;
	// Called by the "Add account" CTA.  Renders the Login screen on
	// top of the existing app; on success the new account is appended
	// and made active.
	onAddAccount(): void;
	// Called by the per-row sign-out X.  When the row IS the active
	// account, App.tsx falls forward to the next account or to the
	// login screen.  When it's an inactive row, we just splice it out
	// without touching the live transport.
	onSignOutAccount(userId: string): void;
	// Called when the user clicks the active row's "Open profile"
	// affordance.  Closes the popover + shows the existing
	// ProfileSheet for the current user.
	onOpenProfile(): void;
	// Three-valued (matches SpaceBar): undefined = profile fetch
	// in flight, null = no avatar, string = mxc URL.  Only relevant
	// for the active account; inactive accounts use whatever was
	// cached at their last sign-in.
	currentUserAvatarMxc?: string | null;
}

export function AccountSwitcher({
	accounts,
	activeUserId,
	onSwitch,
	onAddAccount,
	onSignOutAccount,
	onOpenProfile,
	currentUserAvatarMxc,
}: AccountSwitcherProps) {
	const activeAccount = accounts.find(a => a.user_id === activeUserId) ?? null;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="rounded-full focus:outline-none focus:ring-2 focus:ring-primary"
					title={activeUserId ?? "Account"}
					aria-label="Account switcher"
				>
					{currentUserAvatarMxc === undefined ? (
						// Profile probe still in flight — render a neutral
						// muted disc instead of the DiceBear fallback that
						// MatrixAvatar would otherwise produce for a no-mxc
						// seed.  Same dimensions as the real avatar so the
						// SpaceBar layout doesn't shift on resolve.
						<span
							className="block h-10 w-10 rounded-full bg-muted"
							aria-hidden
						/>
					) : (
						<MatrixAvatar
							mxc={currentUserAvatarMxc ?? undefined}
							seed={activeUserId ?? "self"}
							kind="user"
							className="h-10 w-10"
						/>
					)}
				</button>
			</PopoverTrigger>
			<PopoverContent
				side="right"
				align="start"
				className="w-72 p-0 overflow-hidden"
			>
				{/* Active account header — clicking it opens the user's
				    profile (the same gesture that the bare avatar served
				    pre-multi-account, preserved here so habit isn't
				    broken). */}
				{activeAccount && (
					<button
						type="button"
						onClick={onOpenProfile}
						className="w-full flex items-center gap-3 px-3 py-3 hover:bg-accent transition-colors text-left border-b border-border"
					>
						<MatrixAvatar
							mxc={currentUserAvatarMxc ?? activeAccount.avatar_url ?? undefined}
							seed={activeAccount.user_id}
							kind="user"
							className="h-10 w-10 shrink-0"
						/>
						<div className="min-w-0 flex-1">
							<div className="text-sm font-medium truncate">
								{activeAccount.display_name ?? localpart(activeAccount.user_id)}
							</div>
							<div className="text-[11px] text-muted-foreground truncate">
								{activeAccount.user_id}
							</div>
						</div>
						<UserIcon className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
					</button>
				)}

				{/* Other accounts — shown only when there's at least one. */}
				{accounts.filter(a => a.user_id !== activeUserId).length > 0 && (
					<div className="border-b border-border">
						<div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
							Switch to
						</div>
						<ul className="divide-y divide-border">
							{accounts
								.filter(a => a.user_id !== activeUserId)
								.map(a => (
									<li key={a.user_id} className="relative group">
										<button
											type="button"
											onClick={() => onSwitch(a.user_id)}
											className="w-full flex items-center gap-3 px-3 py-2 pr-10 hover:bg-accent transition-colors text-left"
										>
											<MatrixAvatar
												mxc={a.avatar_url ?? undefined}
												seed={a.user_id}
												kind="user"
												className="h-8 w-8 shrink-0"
											/>
											<div className="min-w-0 flex-1">
												<div className="text-sm truncate">
													{a.display_name ?? localpart(a.user_id)}
												</div>
												<div className="text-[10px] text-muted-foreground truncate">
													{a.user_id}
												</div>
											</div>
										</button>
										<button
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												onSignOutAccount(a.user_id);
											}}
											className={cn(
												"absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded",
												"text-muted-foreground hover:text-destructive hover:bg-destructive/10",
												"opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity",
											)}
											title="Sign out of this account"
											aria-label="Sign out of this account"
										>
											<LogOut className="h-3.5 w-3.5" />
										</button>
									</li>
								))}
						</ul>
					</div>
				)}

				{/* Footer actions */}
				<div className="p-2 space-y-1">
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="w-full justify-start"
						onClick={onAddAccount}
					>
						<Plus className="h-3.5 w-3.5 mr-2" />
						Add account
					</Button>
					{activeAccount && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="w-full justify-start text-muted-foreground hover:text-destructive"
							onClick={() => onSignOutAccount(activeAccount.user_id)}
						>
							<LogOut className="h-3.5 w-3.5 mr-2" />
							Sign out of {localpart(activeAccount.user_id)}
						</Button>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

function localpart(mxid: string | undefined): string {
	if (!mxid) return "";
	if (!mxid.startsWith("@")) return mxid;
	const colon = mxid.indexOf(":");
	return colon > 1 ? mxid.slice(1, colon) : mxid.slice(1);
}

// Tiny check-icon helper kept inline so the popover stays self-
// contained; not used elsewhere in this component but exported in
// case the parent wants to reuse the visual.
export const _checkIcon = Check;

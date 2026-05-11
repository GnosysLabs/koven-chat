// Persistent banner that surfaces pending SPACE invites.  Renders as
// a thin horizontal pill at the top of the main content pane (right
// of the SpaceBar) whenever there's at least one pending space
// invite.  Click handler opens the PendingInvitesSheet with the
// full details + Accept / Decline controls.
//
// Why this exists separately from RoomList's Requests section:
// room invites live in the per-space room list, but space invites
// have nowhere to live, the SpaceBar is too narrow for inline
// Accept / Decline and putting them in `spaces` would re-create the
// NSFW-gate bypass where an invited space's name and avatar
// surface as if joined.  This pill is the only way an invite-state
// space is visible until the user explicitly accepts.
//
// NSFW handling: when ANY pending invite is flagged NSFW, the pill
// copy calls that out explicitly ("1 NSFW Space invite pending").
// The pill itself never shows space names or avatars, only the
// count + NSFW flag, so an attacker-named NSFW space can't surface
// content to a viewer who hasn't opted in.  The sheet behind the
// pill renders previews per-invite with its own gate.

import type { SpaceInvite } from "@koven/shared";
import { Mail } from "lucide-react";

export interface PendingInvitesPillProps {
	invites: SpaceInvite[];
	onOpen(): void;
}

export function PendingInvitesPill({ invites, onOpen }: PendingInvitesPillProps) {
	if (invites.length === 0) return null;

	const total = invites.length;
	const nsfwCount = invites.filter(i => i.isNsfw).length;
	const allNsfw = nsfwCount === total;
	const someNsfw = nsfwCount > 0 && !allNsfw;

	// Copy variants the user requested for the NSFW callout:
	//   pure SFW    : "1 Space invite pending"
	//   pure NSFW   : "1 NSFW Space invite pending"
	//   mixed       : "2 Space invites pending (1 NSFW)"
	const pluralised = total === 1 ? "Space invite" : "Space invites";
	let label: string;
	if (allNsfw) {
		label = `${total} NSFW ${pluralised} pending`;
	} else if (someNsfw) {
		label = `${total} ${pluralised} pending (${nsfwCount} NSFW)`;
	} else {
		label = `${total} ${pluralised} pending`;
	}

	return (
		<button
			type="button"
			onClick={onOpen}
			className="w-full px-4 py-2 text-xs flex items-center gap-2 border-b border-border bg-primary/10 hover:bg-primary/15 text-foreground transition-colors text-left"
			aria-label={`${label}, tap to see details`}
		>
			<Mail className="h-3.5 w-3.5 shrink-0 text-primary" />
			<span className="flex-1 truncate">
				<span className="font-medium">{label}</span>
				<span className="text-muted-foreground"> · Tap to see details</span>
			</span>
		</button>
	);
}

// Inline room-mention pill — Discord-style "#general" / space tag
// that renders inside message text where a Matrix id / alias /
// invite URL was pasted.  Click opens the share-intent flow (fast
// navigate if already a member; JoinConfirmSheet otherwise).
//
// Underlying element is a native `<a href>` so:
//   - Right-click → "Copy link" gives the original URL.
//   - Cmd/Ctrl-click → opens the link in the OS browser (Tauri's
//     navigation interceptor routes it through tauri-plugin-opener,
//     same as any other external link).  Acceptable fallback for
//     users who want to share the link onward.
//   - Selection + copy preserves the original URL in the clipboard.
//
// Left-click is intercepted: `preventDefault()` + dispatch through
// the ShareIntentContext.  When no context provider is mounted (an
// embedded preview, a search-result render), the click falls
// through to the anchor and the URL opens normally — graceful
// degradation rather than crash.
//
// Render strategy:
//   - If the target id is in the local rooms / spaces list (the
//     viewer is already a member), show the real name + a kind-
//     specific icon (# for room, Globe / Lock for space depending
//     on visibility).
//   - Otherwise, show the bare id (truncated if long) + a generic
//     icon.  No remote preview fetch — that happens on click via
//     previewTarget inside the JoinConfirmSheet flow.

import { useShareIntent } from "@/lib/shareIntentContext";
import type { ShareIntent } from "@/lib/inviteLink";
import { cn } from "@/lib/utils";
import { EyeOff, Globe, Hash, Lock } from "lucide-react";

export interface RoomMentionPillProps {
	/** The parsed intent the pill represents — could be invite-shaped
	 *  or message-permalink-shaped.  Click hands this verbatim to
	 *  the share-intent dispatcher. */
	intent: ShareIntent;
	/** Original substring from the message body — used as the
	 *  `<a href>` value (for right-click / copy / Cmd-click) and as
	 *  the fallback display label when we have no local data.  If
	 *  the original was a bare id (e.g. `!abc:foo`), it's used
	 *  verbatim; if it was a URL, the URL goes here. */
	original: string;
	/** Match the surrounding bubble's color so the pill reads on
	 *  both self and other bubbles.  Mirrors @-mention pill tone. */
	tone?: "self" | "other";
}

export function RoomMentionPill({ intent, original, tone = "other" }: RoomMentionPillProps) {
	const ctx = useShareIntent();
	const target = intent.kind === "invite" ? intent.target : intent.roomId;

	// Local resolution — pure read from the provided rooms/spaces
	// snapshot.  No network.
	const localRoom = ctx?.rooms.find(r => r.id === target);
	const localSpace = ctx?.spaces.find(s => s.id === target);

	const isSpace = !!localSpace;
	const isPrivateSpace = localSpace?.kind === "private";
	const isEncrypted = !!localRoom?.encrypted;
	const isDm = localRoom?.kind === "dm";

	// Display name — local data first, then a sensible fallback.
	// Aliases ("#general:server") render as "#general" (drop the
	// server portion); ids stay verbatim so the user knows they
	// referenced something the local instance can't resolve.
	const label = (() => {
		if (localSpace) return localSpace.name;
		if (localRoom) return localRoom.name;
		// Unknown target.  Strip the server suffix on aliases so
		// the pill reads cleaner; ids keep their full form because
		// the localpart of an id is opaque without a server context.
		if (target.startsWith("#")) {
			const colon = target.indexOf(":");
			return colon > 0 ? target.slice(0, colon) : target;
		}
		// For message permalinks, the room id is also opaque — show
		// "Message" as a hint, the underlying URL holds the real ids
		// for click resolution.
		if (intent.kind === "message") return "Message";
		// Bare id — truncate aggressively if very long so a malformed
		// or wantonly long id doesn't break out of the bubble.
		return target.length > 24 ? `${target.slice(0, 21)}…` : target;
	})();

	// Icon selection.  Encryption → Lock, private space → EyeOff,
	// public space → Globe, room → Hash.  DMs in the local list
	// fall back to # since DM links shouldn't normally appear
	// inline; if they do (someone pasted a DM permalink) we render
	// generically rather than leak the other party's name as the
	// pill's primary label.
	const Icon = (() => {
		if (isEncrypted) return Lock;
		if (isSpace) return isPrivateSpace ? EyeOff : Globe;
		return Hash;
	})();

	function onClick(e: React.MouseEvent<HTMLAnchorElement>) {
		// No share-intent provider — fall through to the anchor's
		// native behaviour.  Tells the rendering surface "I don't
		// have a handler, treat this as a normal link."
		if (!ctx) return;
		// Always intercept clicks when we have a handler — Cmd/Ctrl-
		// click "open in new tab" doesn't make sense for an in-app
		// room navigation (there are no tabs), and letting koven://
		// hrefs leak to the OS opener risks an extra Cocoa round
		// trip / second-instance refocus when we could just navigate
		// the current view.  The href is left intact for right-
		// click → Copy link, drag-out, and accessibility tooling.
		e.preventDefault();
		ctx.open(intent);
	}

	// The `<a href>` carries the original substring so Tauri's
	// navigation handler can route it (Cmd-click) and so
	// copy/right-click expose the actual link.  For bare ids that
	// aren't URLs, fall back to a koven:// shape — clicking outside
	// the SPA's intercept (e.g. dragging onto the address bar) at
	// least produces a working deep link instead of a non-URL.
	const href = original.startsWith("http") || original.startsWith("koven://")
		? original
		: `koven://${intent.kind === "invite" ? "invite" : "r"}/${encodeURIComponent(target)}${intent.kind === "message" ? "/" + encodeURIComponent((intent as { eventId: string }).eventId) : ""}`;

	// DMs shouldn't surface their "real name" (the other party) in
	// a pill — that's a low-grade leak of who you DM with into any
	// room where someone references the DM's permalink.  Render the
	// generic "Direct message" label instead.
	const safeLabel = isDm ? "Direct message" : label;

	return (
		<a
			href={href}
			onClick={onClick}
			data-room-mention={target}
			title={safeLabel}
			className={cn(
				"inline-flex items-baseline gap-0.5 px-1 -mx-0.5 rounded",
				"font-semibold cursor-pointer no-underline border-b-0",
				"max-w-[28ch] truncate align-baseline",
				tone === "self"
					? "bg-primary-foreground/15 text-primary-foreground hover:bg-primary-foreground/25 dark:bg-foreground/15 dark:text-foreground dark:hover:bg-foreground/25"
					: "bg-primary/15 text-primary hover:bg-primary/25",
				"transition-colors",
			)}
		>
			<Icon className="h-3 w-3 self-center shrink-0" aria-hidden />
			<span className="truncate">{safeLabel}</span>
		</a>
	);
}

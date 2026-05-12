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

import { useEffect, useMemo } from "react";
import { useShareIntent } from "@/lib/shareIntentContext";
import { useTransport } from "@/lib/transportContext";
import { fetchRoomPreview, useRoomPreview } from "@/lib/roomPreviewCache";
import type { ShareIntent } from "@/lib/inviteLink";
import type { EventId, RoomId } from "@koven/shared";
import { cn } from "@/lib/utils";
import { Hash, LayoutGrid, Lock, MessageSquare } from "lucide-react";

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
	const transport = useTransport();
	const target = intent.kind === "invite" ? intent.target : intent.roomId;

	// Message permalinks: look up the referenced event locally so the
	// pill can read "💬 Alice's message" instead of the generic
	// "Message" placeholder.  Lookup is O(1) via matrix-js-sdk's
	// internal hash, so this is safe to call on every render of every
	// pill.  Null when the room isn't joined / the event hasn't been
	// paginated in yet — caller falls back to "Message".
	const messagePreview = useMemo(() => {
		if (intent.kind !== "message") return null;
		if (!transport) return null;
		return transport.getMessagePreview(
			intent.roomId as RoomId,
			intent.eventId as EventId,
		);
	}, [transport, intent]);

	// Tier 1: viewer is already a member.  Pure read from the
	// snapshot threaded through context.  Cheapest; no fetch, no
	// re-render churn.
	const localRoom = ctx?.rooms.find(r => r.id === target);
	const localSpace = ctx?.spaces.find(s => s.id === target);

	// Tier 2: cached preview from a previous fetch (or a
	// JoinConfirmSheet preview we never invalidated).  Used when
	// the user isn't a member of the target.  useRoomPreview
	// subscribes to per-id cache changes so the pill auto-upgrades
	// from skeleton/id to name+avatar when the fetch resolves.
	const cachedPreview = useRoomPreview(localRoom || localSpace ? null : target);

	// Tier 3: kick off the fetch if we're in the not-a-member +
	// not-cached state.  fetchRoomPreview is no-op when already
	// cached / in-flight, so this is safe to call on every render
	// (the effect just shields us from running during SSR or when
	// transport hasn't been provided yet).
	useEffect(() => {
		if (!transport) return;
		if (localRoom || localSpace) return;        // local data wins
		if (cachedPreview !== undefined) return;    // cache already resolved (or null)
		void fetchRoomPreview(transport, target);
	}, [transport, target, localRoom, localSpace, cachedPreview]);

	const isSpace = !!localSpace || cachedPreview?.isSpace === true;
	const isEncrypted = !!localRoom?.encrypted;
	const isDm = localRoom?.kind === "dm";

	// Display name resolution.  Try in order: local Room/Space,
	// then cached preview, then a graceful fallback derived from
	// the target itself (strip server suffix on aliases so a long
	// federated alias doesn't dominate the pill).  Bare ids
	// without a resolved name keep their original form truncated
	// — the click flow will fetch and surface the real name in
	// the JoinConfirmSheet.
	const label = (() => {
		// Message permalinks render as "{senderDisplayName}'s message"
		// when we can resolve the sender, falling back to the generic
		// "Message" when the event isn't reachable from this client.
		// We strip a trailing "s" from "name's" → "name'" only in the
		// rare apostrophe-s collision (display names ending in s);
		// real display names like "James" still read fine as "James's
		// message" (English style varies on this; we pick the form
		// every chat client uses for "Alice's reply").
		if (intent.kind === "message") {
			if (messagePreview) return `${messagePreview.senderDisplayName}'s message`;
			return "Message";
		}
		if (localSpace) return localSpace.name;
		if (localRoom) return localRoom.name;
		if (cachedPreview && cachedPreview !== null && cachedPreview.name) return cachedPreview.name;
		if (target.startsWith("#")) {
			const colon = target.indexOf(":");
			return colon > 0 ? target.slice(0, colon) : target;
		}
		return target.length > 24 ? `${target.slice(0, 21)}…` : target;
	})();

	// Icon selection.  Encryption wins (Lock), then message-permalink
	// gets the speech-bubble (MessageSquare), then spaces (LayoutGrid
	// matching the marketing site's "Spaces & rooms" feature tile),
	// else rooms get Hash.  DMs render generically (Hash) so a DM
	// permalink doesn't leak the counterparty's identity through the
	// pill icon.  We don't surface a public-vs-private distinction
	// on the pill — Discord doesn't either, and the visibility is
	// implicit in whether the viewer can click through to join.
	const Icon = (() => {
		if (intent.kind === "message") return MessageSquare;
		if (isEncrypted) return Lock;
		if (isSpace) return LayoutGrid;
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
	// room where someone references the DM's permalink.  Applies to
	// both invite-shaped pills (room name == counterparty) AND
	// message-shaped pills (sender == counterparty), so the
	// suppression covers either: "{counterparty}'s message" pasted
	// into a group chat would advertise the DM relationship just as
	// directly as the room name would.
	const safeLabel = isDm
		? "Direct message"
		: label;

	return (
		<a
			href={href}
			onClick={onClick}
			data-room-mention={target}
			title={safeLabel}
			className={cn(
				"inline-flex items-baseline gap-1 px-1 -mx-0.5 rounded",
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

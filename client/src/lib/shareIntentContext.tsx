// Context that lets inline room-mention pills (and any other
// rendered share-link surface) dispatch a ShareIntent without
// having to pass `consumeShareIntent` through every component
// prop chain.
//
// Two values:
//
//   open(intent)
//     The handler — usually `consumeShareIntent` from App.tsx.
//     Pills call this with the parsed intent on click; the
//     handler runs the membership-check / preview / confirm-
//     sheet flow.
//
//   rooms / spaces
//     Snapshot of the viewer's joined rooms + spaces, plumbed in
//     so a pill can render the target's real name + avatar when
//     the viewer is already a member.  We deliberately do NOT
//     auto-fetch previews for unknown targets at render time —
//     pills referencing rooms the local SDK doesn't know about
//     render in a "bare-id" mode and resolve metadata only when
//     the user clicks (via previewTarget inside the share-intent
//     flow).  That avoids fan-out HTTP requests for messages
//     containing many ids.
//
// `useShareIntent()` returns null when no provider is mounted so
// renderers in odd places (preview cards, search results, etc.)
// can fall back to plain-text rendering instead of crashing.

import { createContext, useContext } from "react";
import type { Room, Space } from "@koven/shared";
import type { ShareIntent } from "@/lib/inviteLink";

export interface ShareIntentContextValue {
	open(intent: ShareIntent): void;
	rooms: Room[];
	spaces: Space[];
}

const ShareIntentContext = createContext<ShareIntentContextValue | null>(null);

export const ShareIntentProvider = ShareIntentContext.Provider;

export function useShareIntent(): ShareIntentContextValue | null {
	return useContext(ShareIntentContext);
}

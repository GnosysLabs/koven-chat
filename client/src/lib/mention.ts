// Shared mention-detection utility used by:
//   - App.tsx's onMessage notification gate (decides whether to ring
//     the OS / bell for an arriving message)
//   - ChatPane's MessageRow highlight (Discord-style accent on
//     messages that mention the viewer)
//
// Both surfaces want the same answer to the same question: "does this
// message ping the viewer?".  Keeping the logic in one place means
// they can't drift — if the rules for what counts as a mention
// change, both surfaces update together.

import type { Message } from "@koven/shared";

/** True when `message` mentions `viewerUserId` — either as a direct
 * @-mention in the body / formatted_body, OR as a reply target
 * (someone hit Reply on a message the viewer authored).  Both cases
 * are "the viewer is being addressed" and warrant identical
 * surfacing (notification + highlight).
 *
 * Mention detection mirrors the engine-side `extractMentionTargets`:
 * tries plaintext mxid first (the unambiguous case), then plaintext
 * `@localpart`.  m.mentions / formatted_body matrix.to detection
 * lives engine-side because that's where notifications are written;
 * the client-side check is a safety-net for events the engine missed
 * (encrypted rooms, etc.) and doesn't need to be exhaustive — false
 * negatives just mean "no highlight," not lost messages. */
export function messageMentionsUser(message: Message, viewerUserId: string): boolean {
	if (!viewerUserId) return false;
	// Reply-to-me counts as a mention.
	if (message.replyTo?.sender === viewerUserId) return true;
	const text = message.text ?? "";
	if (!text) return false;
	if (text.includes(viewerUserId)) return true;
	const localpart = viewerUserId.split(":")[0]; // includes leading @
	if (!localpart || localpart.length < 2) return false;
	const re = new RegExp(`(^|\\W)${escapeRegex(localpart)}(\\W|$)`);
	return re.test(text);
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

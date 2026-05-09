// Inline mention rendering — Discord-style "@displayname" pills for
// messages that mention room members.  Replaces matches in the
// plaintext body with a clickable pill that opens the user's
// profile sheet.  Falls through to linkify for the non-mention
// segments so URLs still get anchors.
//
// Limitations of v1:
//   - Plaintext body only.  Matrix's `formatted_body` (HTML, where
//     mentions are rich `<a href="https://matrix.to/#/@user:server">`
//     anchors) isn't parsed here.  For our messages — sent via the
//     SPA's @-mention picker which writes both body and formatted_
//     body — the plaintext form already contains `@localpart`, which
//     this resolves correctly.  Federated clients that emit ONLY
//     formatted_body (no plaintext mention) would render as plain
//     text; rare in practice.
//   - Markdown messages skip mention rendering — the markdown
//     pipeline (MarkdownContent) doesn't currently expose a hook
//     for inline transforms.  Acceptable trade-off: most chat-
//     style messages aren't markdown anyway.

import React from "react";
import type { ReactElement, ReactNode } from "react";
import { linkify } from "./linkify";
import { cn } from "./utils";

/** Plaintext mention regex.  Matches:
 *   @localpart                  (no server — resolved against room members)
 *   @localpart:server.tld       (full mxid, server is anything that looks
 *                                domain-y)
 * Localpart character class follows Matrix's localpart spec
 * (lowercase letters, digits, and `._=-/+`) but we keep it tight
 * — anything fancier is rare and the cost of a false negative is
 * "renders as plain text," not a bug.
 *
 * Anchored on a non-word boundary so we don't catch mid-word
 * sequences like "ssh@host" being treated as a mention.  The
 * leading `(?:^|\W)` group is consumed but emitted back via
 * match[0] subtraction in the caller. */
const MENTION_RE = /(^|\W)@([a-z0-9._=\-/+]+)(?::([a-zA-Z0-9.\-]+))?/gi;

interface RenderOpts {
	text: string;
	/** userId → display name lookup for resolving short `@localpart`
	 * mentions to a full MXID, and for picking the label shown in
	 * the rendered pill. */
	members: Map<string, string>;
	/** Click handler — opens the user's profile sheet upstream. */
	onMentionClick(userId: string): void;
	/** Tone for color matching the bubble (your sent vs received). */
	tone?: "self" | "other";
}

/** Build segment list: alternating plain strings, link anchors, and
 * MentionPill components.  Returns a single-element array of `text`
 * when there are no mentions or links. */
export function renderWithMentions(opts: RenderOpts): ReactNode[] {
	const { text, members, onMentionClick, tone = "other" } = opts;

	// Build a localpart → MXID index once for fast lookup.  Members
	// with the same localpart on different servers are vanishingly
	// rare on a single-instance koven.chat install; first-write wins.
	const localpartToMxid = new Map<string, string>();
	for (const mxid of members.keys()) {
		const m = mxid.match(/^@([^:]+):/);
		if (m) localpartToMxid.set(m[1]!.toLowerCase(), mxid);
	}

	const parts: ReactNode[] = [];
	let cursor = 0;
	let key = 0;
	const pushSegment = (segment: string) => {
		// Run linkify on each non-mention segment so URLs inside the
		// surrounding text still become anchors.  linkify returns
		// React nodes already; reuse them directly with fresh keys.
		const linked = linkify(segment);
		for (const piece of linked) {
			if (typeof piece === "string") {
				parts.push(<React.Fragment key={key++}>{piece}</React.Fragment>);
			} else {
				parts.push(React.cloneElement(piece as ReactElement, { key: key++ }));
			}
		}
	};

	MENTION_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = MENTION_RE.exec(text)) !== null) {
		const lead = m[1] ?? "";       // leading boundary char (or "")
		const localpart = m[2]!.toLowerCase();
		const server = m[3];
		const matchStart = m.index + lead.length;
		const matchEnd = MENTION_RE.lastIndex;

		// Resolve to a real MXID we know about.
		const mxid = server
			? `@${localpart}:${server}`
			: localpartToMxid.get(localpart);
		const displayName = mxid ? members.get(mxid) : undefined;

		if (!mxid || !displayName) {
			// Not a recognised user — leave as plain text and let
			// the regex engine continue past.  Don't reset cursor
			// so the surrounding text gets emitted in one go later.
			continue;
		}

		// Emit the lead boundary char (kept as plain text) and
		// everything from the prior cursor up to here.
		if (matchStart > cursor) {
			pushSegment(text.slice(cursor, matchStart));
		}
		// Emit the mention pill.
		parts.push(
			<MentionPill
				key={key++}
				userId={mxid}
				name={displayName}
				tone={tone}
				onClick={() => onMentionClick(mxid)}
			/>,
		);
		cursor = matchEnd;
	}

	// Trailing tail.
	if (cursor < text.length) {
		pushSegment(text.slice(cursor));
	} else if (parts.length === 0) {
		// No mentions found at all — fall through to plain linkify
		// so the original behaviour is preserved bit-for-bit.
		return linkify(text);
	}

	return parts;
}

function MentionPill({
	userId,
	name,
	tone,
	onClick,
}: {
	userId: string;
	name: string;
	tone: "self" | "other";
	onClick(): void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			data-mention-userid={userId}
			className={cn(
				"inline-flex items-baseline px-1 -mx-0.5 rounded",
				"font-semibold cursor-pointer",
				// Discord uses a tinted background that picks up the
				// theme accent.  Tone-aware so it reads on both the
				// self bubble (dark accent over primary bg) and the
				// other bubble (primary tint over muted bg).
				tone === "self"
					// On dark, the self bubble switches to a dim primary tint
					// with `text-foreground`, so a primary-foreground (dark)
					// pill no longer reads.  Match the bubble: pill text +
					// background derive from `--foreground` on dark.
					? "bg-primary-foreground/15 text-primary-foreground hover:bg-primary-foreground/25 dark:bg-foreground/15 dark:text-foreground dark:hover:bg-foreground/25"
					: "bg-primary/15 text-primary hover:bg-primary/25",
				"transition-colors",
			)}
		>
			{name}
		</button>
	);
}

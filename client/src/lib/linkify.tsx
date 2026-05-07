// Plain-text → React-with-links transform, plus a helper for finding
// the first URL in a chunk of text (used by the URL-preview card).
//
// Backed by linkify-it, the workhorse library used by markdown-it /
// remarkable / GitLab / Reddit / etc.  Catches https://, http://,
// www., bare-domain "example.com", and a bunch of edge cases (URLs
// inside parentheses, trailing punctuation that isn't part of the
// link, IP literals).  We disable email matching since "user@server"
// in chat is almost always a Matrix mxid, not a mailto target.

import LinkifyIt from "linkify-it";

const linkifier = new LinkifyIt().set({ fuzzyEmail: false });

/**
 * Split `text` into alternating plain strings and `<a>` elements.
 * The anchors inherit the surrounding text color so they read
 * against any bubble palette — the underline alone marks them as
 * links.  Returns a single-element array containing the raw text
 * when there are no links.
 */
export function linkify(text: string): React.ReactNode[] {
	const matches = linkifier.match(text);
	if (!matches || matches.length === 0) return [text];

	const parts: React.ReactNode[] = [];
	let cursor = 0;
	matches.forEach((m, i) => {
		if (m.index > cursor) {
			parts.push(text.slice(cursor, m.index));
		}
		parts.push(
			<a
				key={i}
				href={m.url}
				target="_blank"
				rel="noopener noreferrer"
				className="underline underline-offset-2 hover:no-underline break-all"
			>
				{m.text}
			</a>,
		);
		cursor = m.lastIndex;
	});
	if (cursor < text.length) parts.push(text.slice(cursor));
	return parts;
}

/**
 * First link in the body, normalised to a real URL.  linkify-it
 * adds the http(s):// prefix for bare-domain inputs ("example.com"
 * becomes "http://example.com") so the URL is always one we can
 * hand straight to Synapse's preview API or to fetch().
 */
export function firstLink(text: string): string | null {
	const matches = linkifier.match(text);
	return matches && matches.length > 0 ? matches[0]!.url : null;
}

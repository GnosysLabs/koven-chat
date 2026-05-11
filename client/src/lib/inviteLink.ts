// Public-facing share links for rooms, spaces, and individual messages.
//
// We deliberately do NOT use matrix.to (the universal Matrix landing
// page) for these.  matrix.to dumps the recipient on a chooser screen
// listing every Matrix client they could install, with Koven nowhere
// in sight.  That's hostile UX for a product where the link's whole
// purpose is "come into Koven and see this room."  Our links route
// straight to client.koven.chat, where the SPA either:
//
//   - joins the room and navigates if the user's signed in
//   - prompts a Koven sign-up otherwise (then joins on completion)
//
// The same SPA route handles desktop deep-links — the Tauri shell
// already whitelists koven.chat in its navigation handler, so a link
// clicked outside the app that hits the OS URL handler can hand off
// to a running Koven Desktop instance via single-instance focus.
//
// URL shapes:
//   https://client.koven.chat/invite/<roomOrSpaceId-or-alias>
//   https://client.koven.chat/r/<roomId>/<eventId>     (message permalink)
//
// Path-style rather than fragment so the path is visible in link
// previews + scrapers, and so server-side static hosting (Caddy's
// try_files) can route them all to index.html the same way it routes
// any other unmatched path.

const SHARE_HOST = "https://client.koven.chat";

// Hostnames the SPA accepts as legitimate share-link sources when
// parsing pasted/visited URLs.  Mirrors the production host above
// plus the dev / desktop hosts so a link works across every shipped
// surface.  Using a Set so adding a hostname later is a one-liner
// (e.g. preview deploys at koven-staging.chat).
const SHARE_HOSTS: ReadonlySet<string> = new Set([
	"client.koven.chat",
	"koven.chat",  // bare-domain redirect target
	"localhost",   // dev (Vite) + production desktop (tauri-plugin-localhost)
	"127.0.0.1",
	// tauri.localhost is the Tauri custom-protocol host on Windows
	// and (legacy) macOS bundles still on tauri:// — left in for
	// backwards compatibility with older desktop installs.
	"tauri.localhost",
]);

/** Universal share URL for a room, space, or alias.  The recipient
 * lands on /invite/<id> and the SPA dispatches based on whether
 * they're signed in. */
export function buildInviteUrl(roomOrSpaceIdOrAlias: string): string {
	return `${SHARE_HOST}/invite/${encodeURIComponent(roomOrSpaceIdOrAlias)}`;
}

/** Permalink to a single message inside a room.  Scrolls to the
 * referenced event after the room loads. */
export function buildMessageUrl(roomId: string, eventId: string): string {
	return `${SHARE_HOST}/r/${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}`;
}

/** Result of parsing a share URL pasted into the address bar (or
 * delivered via the Tauri OS-URL handler).  Null when the pathname
 * isn't one of our share routes. */
export type ShareIntent =
	| { kind: "invite"; target: string }
	| { kind: "message"; roomId: string; eventId: string };

/** Parse `window.location` (or any URL string) into a ShareIntent.
 * Used by the SPA boot sequence to detect "user landed via a share
 * link" and act on it after auth + sync ready.
 *
 * Tolerant: trailing slashes, fragment artefacts, missing schemes
 * all handled.  Returns null for normal app paths so the boot path
 * can no-op cleanly. */
export function parseShareIntent(input: string | URL | Location = window.location): ShareIntent | null {
	let pathname: string;
	let hostname: string | null;
	try {
		if (typeof input === "string") {
			// Allow callers to pass either a full URL or just a path.
			if (input.startsWith("koven://")) {
				// Custom-scheme deep links arriving from the Tauri
				// shell.  `koven://invite/abc` parses as host=invite,
				// pathname=/abc — reassemble into the same path shape
				// the SHARE_HOSTS branch produces so the downstream
				// splitter handles both transports identically.
				// Treat as trusted: only the OS hands us koven://
				// URLs (the scheme is registered to our bundle id);
				// no untrusted caller can synthesize one inside the
				// SPA without first traversing the OS handler.
				const u = new URL(input);
				pathname = `/${u.host}${u.pathname}`;
				hostname = null;
			} else if (input.startsWith("http") || input.startsWith("/")) {
				const u = new URL(input, SHARE_HOST);
				pathname = u.pathname;
				// Treat absolute /paths as same-origin (no hostname
				// guard); only validate when the input was a real
				// absolute URL with a host attached.
				hostname = input.startsWith("http") ? u.hostname : null;
			} else {
				pathname = input;
				hostname = null;
			}
		} else {
			pathname = input.pathname;
			// Location / URL both expose `hostname` directly.
			hostname = (input as { hostname?: string }).hostname ?? null;
		}
	} catch {
		return null;
	}

	// If we have a hostname and it isn't one of ours, this isn't a
	// share link we should act on (someone could paste an attacker-
	// constructed link with /invite/foo to trick the app into joining
	// arbitrary rooms).  Pathname-only inputs skip this check.
	if (hostname && !SHARE_HOSTS.has(hostname)) return null;

	// Strip leading + trailing slashes, then split.  Normalised here
	// so /invite/foo and /invite/foo/ both parse the same.
	const parts = pathname.replace(/^\/+|\/+$/g, "").split("/");
	if (parts.length === 0 || parts[0] === "") return null;

	if (parts[0] === "invite" && parts[1]) {
		return { kind: "invite", target: decodeURIComponent(parts[1]) };
	}
	if (parts[0] === "r" && parts[1] && parts[2]) {
		return {
			kind: "message",
			roomId: decodeURIComponent(parts[1]),
			eventId: decodeURIComponent(parts[2]),
		};
	}
	return null;
}

/** Matrix id / alias regex shapes used by `findInlineRoomMentions`
 * below.  Two patterns: `!id:server.tld` (room/space ids) and
 * `#alias:server.tld` (canonical aliases).
 *
 * Constraints:
 *   - Localpart accepts the Matrix-spec character class plus `+` /
 *     `/` / `_` / `=` / `.` / `-` (matches MENTION_RE in
 *     mentionRender.tsx for symmetry).
 *   - Server part requires AT LEAST one dot — `!abc:foo` without
 *     a TLD doesn't match.  This is the false-positive guard for
 *     things like exclamation-pointed sentences ("really!:O").
 *   - Word boundary on both sides via the `\b`-equivalent
 *     pre/post-class so mid-word matches don't fire.
 */
const MATRIX_ID_INLINE_RE =
	/(^|[^A-Za-z0-9_])([!#][A-Za-z0-9._=\-/+]+:[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** Hostnames matrix.to share URLs can use.  matrix.to is the
 * universal Matrix landing page; older Element invites + a lot of
 * federated clients still emit these.  Treated as equivalent to a
 * koven invite URL when the path segment is a Matrix id or alias. */
const MATRIX_TO_HOSTS: ReadonlySet<string> = new Set([
	"matrix.to",
	"www.matrix.to",
]);

/** Try to extract a ShareIntent from an arbitrary URL string —
 * differs from `parseShareIntent` (which is keyed on our own host)
 * by also recognising matrix.to and koven:// shapes pasted INTO
 * message bodies.  Used by `findInlineRoomMentions` to spot share
 * URLs the message-renderer should re-render as room pills.
 *
 * Returns null for URLs that aren't a Matrix-shaped invite. */
export function parseShareLinkUrl(href: string): ShareIntent | null {
	// koven://invite/... and koven://r/.../...
	if (href.startsWith("koven://")) {
		// parseShareIntent already handles this shape.  Reuse it
		// instead of duplicating the parsing.
		return parseShareIntent(href);
	}
	// HTTPS shapes.  Tolerate http:// for localhost dev environments
	// (the desktop bundle runs the SPA from http://localhost:51420).
	let u: URL;
	try {
		u = new URL(href);
	} catch {
		return null;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return null;

	// Path 1: Our own host's /invite/* + /r/*/* — defers to
	// parseShareIntent which already enforces the SHARE_HOSTS allow-
	// list and parses the path shape.
	if (SHARE_HOSTS.has(u.hostname)) {
		return parseShareIntent(href);
	}

	// Path 2: matrix.to.  Format is
	//   https://matrix.to/#/<id-or-alias>[/<eventId>]
	// Note the `#` — matrix.to uses fragment-based routing, so we
	// have to parse `u.hash` (which includes the leading `#`),
	// strip the `#`, and walk path segments.
	if (MATRIX_TO_HOSTS.has(u.hostname)) {
		const frag = (u.hash.startsWith("#") ? u.hash.slice(1) : u.hash).replace(/^\/+|\/+$/g, "");
		if (!frag) return null;
		const segs = frag.split("/").map(s => decodeURIComponent(s));
		// matrix.to URL-encodes the leading `!` / `#` as `%21` /
		// `%23`; decodeURIComponent restores them.
		const head = segs[0];
		if (!head || !(head.startsWith("!") || head.startsWith("#") || head.startsWith("@"))) return null;
		// We only handle room/space targets here — `@user`-shaped
		// matrix.to URLs are user profiles, rendered as mentions by
		// renderWithMentions, not as room pills.
		if (head.startsWith("@")) return null;
		const eventSeg = segs[1];
		if (eventSeg && eventSeg.startsWith("$")) {
			return { kind: "message", roomId: head, eventId: eventSeg };
		}
		return { kind: "invite", target: head };
	}

	return null;
}

/** Find every Matrix room/space mention inside a plaintext message
 * body — both bare `!id:server` / `#alias:server` forms AND URLs
 * pointing at our share routes / matrix.to.  Returns each match's
 * byte range + ShareIntent so the renderer can splice in pills
 * without re-running the regex.
 *
 * The output is sorted by start offset and is non-overlapping
 * (matches consume their range so subsequent matches start after).
 *
 * Privacy note: this function ONLY tokenises.  It does NOT fetch
 * preview metadata.  Auto-fetching arbitrary ids from message
 * bodies would fan out HTTP requests to potentially-hostile
 * federated servers; preview fetching happens lazily on click via
 * the existing previewTarget path, not eagerly at render time.
 */
export interface InlineRoomMention {
	start: number;
	end: number;
	intent: ShareIntent;
	/** The exact substring that matched — preserved so the rendered
	 * pill can fall back to this verbatim text if no preview is
	 * available, and so the underlying `<a href>` keeps the original
	 * URL for copy/right-click parity. */
	original: string;
}

export function findInlineRoomMentions(text: string): InlineRoomMention[] {
	const out: InlineRoomMention[] = [];

	// Pass 1: URLs.  Match common share-URL shapes with a single
	// regex so we don't have to call linkify-it twice.  The pattern
	// is intentionally loose on the host (alphanum + dots + dashes)
	// and trims trailing punctuation that's clearly sentence-end.
	const URL_RE = /\b(https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[^\s<>"]+|koven:\/\/[^\s<>"]+)/g;
	let m: RegExpExecArray | null;
	while ((m = URL_RE.exec(text)) !== null) {
		let raw = m[1]!;
		// Strip a single trailing closer if it looks like sentence
		// punctuation — `https://foo/bar.` shouldn't include the
		// period, `https://foo/bar)` shouldn't include the paren.
		// Conservative; keeps interior punctuation intact.
		const tail = /[.,;:)\]}>!?]$/.exec(raw);
		if (tail) raw = raw.slice(0, -1);
		const intent = parseShareLinkUrl(raw);
		if (!intent) continue;
		const start = m.index;
		out.push({ start, end: start + raw.length, intent, original: raw });
	}

	// Pass 2: bare ids / aliases.  Skip ranges already consumed by
	// pass 1 so a URL containing a matrix id (e.g. matrix.to URLs
	// the URL regex caught) doesn't double-match.
	const taken = new Set<number>();
	for (const m of out) {
		for (let i = m.start; i < m.end; i++) taken.add(i);
	}
	MATRIX_ID_INLINE_RE.lastIndex = 0;
	while ((m = MATRIX_ID_INLINE_RE.exec(text)) !== null) {
		const lead = m[1] ?? "";
		const id = m[2]!;
		const start = m.index + lead.length;
		const end = start + id.length;
		if (taken.has(start)) continue;
		out.push({
			start,
			end,
			intent: { kind: "invite", target: id },
			original: id,
		});
	}

	out.sort((a, b) => a.start - b.start);
	return out;
}

/** Replace the current URL with the app root, without a navigation.
 * Used after a share link is consumed so a refresh doesn't re-trigger
 * the join + auto-navigate (which would be confusing if the user has
 * since left the room).  history.replaceState is idempotent and
 * silent. */
export function clearShareUrl(): void {
	try {
		window.history.replaceState(null, "", "/");
	} catch {
		// No-op in environments without history (workers, SSR test).
	}
}

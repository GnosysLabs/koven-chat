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
			if (input.startsWith("http") || input.startsWith("/")) {
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

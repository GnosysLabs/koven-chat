// Deep-link bounce: when the web SPA loads a share route in a plain
// browser, try to hand the URL off to the desktop app via the
// registered `koven://` scheme.  Solves the "I clicked an invite in
// Brave and nothing happened" gap: Universal Links on macOS are
// Safari-only (and even there only auto-open when clicked from a
// different origin), so non-Safari browsers and same-origin Safari
// clicks need a JS-side bridge to reach the desktop bundle.
//
// Design:
//   - Skip inside the Tauri shell.  `__KOVEN_DESKTOP__` is set by the
//     init script; bouncing there would loop the OS handler back into
//     ourselves.
//   - Skip if the user has previously chosen "continue in browser" for
//     this session (sessionStorage flag, cleared on tab close).
//   - Only bounce on first navigation per route, so a refresh doesn't
//     re-pop the OS confirmation.
//   - Fire `location.href = "koven://..."` and let the OS decide.
//     Desktop installed: confirm-and-open.  No handler: no-op, SPA
//     continues loading normally.
//
// Run from `main.tsx` BEFORE React mounts so the bounce is the
// earliest meaningful side effect on the page.

const BOUNCED_KEY = "koven.deepLinkBounce.tried";
const DISMISSED_KEY = "koven.deepLinkBounce.dismissed";

function isDesktopShell(): boolean {
	return typeof window !== "undefined"
		&& Boolean((window as { __KOVEN_DESKTOP__?: unknown }).__KOVEN_DESKTOP__);
}

/** Translate a same-origin web path into a `koven://` URL.  Returns
 * null when the path isn't a share route.  Kept independent of
 * `parseShareIntent` so this module has no React / sdk imports and
 * can load in the tiniest possible bundle slice. */
function pathToKovenUrl(pathname: string): string | null {
	const parts = pathname.replace(/^\/+|\/+$/g, "").split("/");
	if (parts[0] === "invite" && parts[1]) {
		return `koven://invite/${parts[1]}`;
	}
	if (parts[0] === "r" && parts[1] && parts[2]) {
		return `koven://r/${parts[1]}/${parts[2]}`;
	}
	return null;
}

/** Attempt the bounce.  No-ops in the desktop shell or when the user
 * has already dismissed for this session.  Returns the koven:// URL
 * that was attempted (or null), so callers can render a "Try again"
 * affordance in the SPA. */
export function tryDeepLinkBounce(): string | null {
	if (typeof window === "undefined") return null;
	if (isDesktopShell()) return null;
	let url: string | null;
	try {
		url = pathToKovenUrl(window.location.pathname);
	} catch {
		return null;
	}
	if (!url) return null;

	try {
		if (sessionStorage.getItem(DISMISSED_KEY)) return url;
		if (sessionStorage.getItem(BOUNCED_KEY) === url) return url;
		sessionStorage.setItem(BOUNCED_KEY, url);
	} catch {
		// sessionStorage unavailable (private mode lockouts on some
		// older browsers): fall through and bounce unconditionally,
		// duplicate bounce on refresh is annoying but not broken.
	}

	// Fire the scheme.  Chrome/Brave: shows "Open Koven?" if the
	// handler is registered; nothing if not.  Safari: opens app if
	// registered, otherwise nothing.  Either way the SPA keeps
	// loading in the background.
	try {
		window.location.href = url;
	} catch {
		// Some browsers throw on unknown-scheme assignments inside
		// sandboxed iframes; ignore.
	}
	return url;
}

/** Called from the SPA when the user picks "continue in browser" so
 * subsequent navigations within the same tab don't re-pop the OS
 * confirmation dialog. */
export function dismissDeepLinkBounce(): void {
	try {
		sessionStorage.setItem(DISMISSED_KEY, "1");
	} catch {
		// no-op
	}
}

/** Whether this session has already dismissed the bounce. */
export function deepLinkBounceDismissed(): boolean {
	try {
		return Boolean(sessionStorage.getItem(DISMISSED_KEY));
	} catch {
		return false;
	}
}

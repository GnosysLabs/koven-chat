// Service URLs the client talks to.
//
// In dev, the Vite server proxies `/api`, `/static`, `/_matrix`, and
// `/_synapse` to the actual backend processes (engine on :9000,
// Synapse on :8008).  That keeps every request same-origin from the
// browser's perspective — which matters because:
//
//   - The dev server is HTTPS (so Web Crypto's crypto.subtle is
//     available on every origin, not just localhost).  An HTTPS page
//     can't fetch from an HTTP origin (mixed-content), so direct
//     calls to http://host:9000 / :8008 would fail.
//   - The client doesn't need to know what port the engine is on; it
//     just calls /api/instance.
//
// As a result:
//   - ENGINE_URL is the empty string by default — fetch calls like
//     `${ENGINE_URL}/api/instance` resolve to the relative path
//     `/api/instance`, which the Vite proxy forwards.
//   - HOMESERVER_URL defaults to the page origin (matrix-js-sdk wants
//     an absolute baseUrl); the proxy sends /_matrix/* to Synapse.
//
// Production builds can override either via VITE_ENGINE_URL /
// VITE_HOMESERVER_URL — typical setup is a reverse proxy that
// terminates TLS and routes by path, same shape as the dev proxy.
//
// Tauri desktop bundle: the SPA is served from `tauri://localhost`
// (macOS/Linux) or `https://tauri.localhost` (Windows) by Tauri's
// custom protocol handler.  Relative `/api/...` paths there hit
// Tauri's protocol 404 (which it serves as the SPA's index.html for
// SPA fallback routing), making fetch silently succeed with an HTML
// body — the calling code sees `r.ok === true`, parses {} from the
// HTML, and proceeds as if everything worked.  Two visible symptoms
// when this is misconfigured: instance config (login background,
// logo, tagline) loads as empty defaults, and the email-code login
// "succeeds" without ever calling the engine.  Detect the bundle at
// runtime and point both URLs at the canonical homeserver.

const KOVEN_BUNDLED_HOST = "https://client.koven.chat";

function pageOrigin(): string {
	if (typeof window === "undefined") return "";
	return window.location.origin;
}

/** True when the SPA is running inside a Tauri-bundled production
 * build (the `tauri build` output, served from Tauri's custom
 * protocol scheme).  False in `tauri dev` mode (where `devUrl` loads
 * `https://client.koven.chat` directly), false in browsers, false
 * during SSR.
 *
 * Detection: Tauri injects `window.__TAURI_INTERNALS__` (the IPC
 * bridge) into pages it serves from its own protocol — `tauri://`
 * on macOS / Linux, `https://tauri.localhost` on Windows.  It does
 * NOT inject it into pages loaded from a remote URL (the dev mode's
 * `devUrl: https://client.koven.chat` path), which is why we can use
 * its presence as a clean "are we the bundled SPA?" signal across
 * all three platforms without origin-string matching.  Pure
 * `window.location.origin` matching breaks on Windows in some
 * WebView2 configurations where the origin format isn't exactly
 * `https://tauri.localhost`. */
function isTauriBundle(): boolean {
	if (typeof window === "undefined") return false;
	return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

export const HOMESERVER_URL =
	(import.meta.env.VITE_HOMESERVER_URL as string | undefined)
	?? (isTauriBundle() ? KOVEN_BUNDLED_HOST : pageOrigin());

export const ENGINE_URL =
	(import.meta.env.VITE_ENGINE_URL as string | undefined)
	?? (isTauriBundle() ? KOVEN_BUNDLED_HOST : "");

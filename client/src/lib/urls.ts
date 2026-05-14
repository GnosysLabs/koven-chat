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
//
// Capacitor iOS shell: same class of bug, different mechanism.  We
// configure `iosScheme: "https"` in capacitor.config.json hoping the
// SPA serves from `https://client.koven.chat`, but iOS WKWebView
// reserves the `https` scheme and refuses to let Capacitor register
// a custom handler for it — see CAPInstanceDescriptor.normalize(),
// which silently resets the scheme to the default `capacitor` when
// `WKWebView.handlesURLScheme()` already claims it.  Net result: the
// SPA actually loads from `capacitor://client.koven.chat/index.html`
// and every relative `/api/...` fetch hits Capacitor's WKURLScheme-
// Handler, which only knows how to serve bundled assets and returns
// a 404 for unknown paths.  The fix is identical to Tauri's: detect
// the shell and route both URLs at the canonical `https://` host.
// Absolute `https://*` URLs go through normal WKWebView networking
// because the scheme handler is only registered for `capacitor`.

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
 * Detection signal: the Tauri shell's initialization_script runs
 * before any SPA code and sets `window.__KOVEN_DESKTOP__ = true` plus
 * `window.__KOVEN_PLATFORM__ = "macos" | "linux" | "windows"` —
 * compile-time tags from the Rust side that don't depend on origin
 * format, IPC injection, or UA sniffing.  The earlier protocol /
 * UA-based heuristics drifted between WebView versions; this is
 * deterministic.
 *
 * In `tauri dev` mode the same script runs for the same window, so
 * dev shows the same flags — that's intentional.  The dev-vs-prod
 * difference is only the URL the WebView loads, not the chrome. */
type KovenWindow = Window & {
	__KOVEN_DESKTOP__?: boolean;
	__KOVEN_PLATFORM__?: "macos" | "linux" | "windows" | "unknown";
};

export function isTauriBundle(): boolean {
	if (typeof window === "undefined") return false;
	return !!(window as KovenWindow).__KOVEN_DESKTOP__;
}

/** True when the SPA is running inside a Capacitor iOS WebView.
 * Mirrors `isTauriBundle()` so the URL resolution below can treat
 * both shells the same way: they each need an absolute remote URL
 * because their local origins (`capacitor://...` / `tauri://...`)
 * can't reach the engine through relative paths. */
function isCapacitorBundle(): boolean {
	if (typeof window === "undefined") return false;
	return (window as { Capacitor?: unknown }).Capacitor !== undefined;
}

const isNativeBundle = isTauriBundle() || isCapacitorBundle();

export const HOMESERVER_URL =
	(import.meta.env.VITE_HOMESERVER_URL as string | undefined)
	?? (isNativeBundle ? KOVEN_BUNDLED_HOST : pageOrigin());

export const ENGINE_URL =
	(import.meta.env.VITE_ENGINE_URL as string | undefined)
	?? (isNativeBundle ? KOVEN_BUNDLED_HOST : "");

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

function pageOrigin(): string {
	if (typeof window === "undefined") return "";
	return window.location.origin;
}

export const HOMESERVER_URL =
	(import.meta.env.VITE_HOMESERVER_URL as string | undefined) ?? pageOrigin();

export const ENGINE_URL =
	(import.meta.env.VITE_ENGINE_URL as string | undefined) ?? "";

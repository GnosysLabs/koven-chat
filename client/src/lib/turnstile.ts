// Cloudflare Turnstile loader + renderer.  Vanilla — no React
// wrapper dependency, just a script-tag inject + a minimal hook.
//
// Usage:
//   const ref = useRef<HTMLDivElement>(null);
//   const { token, reset } = useTurnstile(ref, siteKey);
//
// Behaviour:
//   - When `siteKey` is null/empty, the hook is a no-op (`token`
//     stays null, `reset` is a no-op).  Lets the caller render the
//     widget container unconditionally and gate downstream usage on
//     `token`.
//   - The Cloudflare script is loaded at most once per page lifetime
//     (the loader is idempotent — second + later callers hit the
//     in-flight promise or the resolved cache).
//   - `appearance: "managed"` lets Cloudflare decide invisible vs.
//     visible challenge based on the request's risk signals, which is
//     the recommended default.
//   - On widget verify, the token is captured into React state so
//     submit handlers can read it via the hook's return.
//   - On expire / error, the token is cleared so a stale value
//     doesn't get submitted.

import { useEffect, useRef, useState } from "react";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=__kovenTurnstileLoaded";

interface TurnstileApi {
	render(
		container: HTMLElement,
		opts: {
			sitekey: string;
			theme?: "auto" | "light" | "dark";
			appearance?: "always" | "execute" | "interaction-only";
			callback?(token: string): void;
			"error-callback"?(): void;
			"expired-callback"?(): void;
			"timeout-callback"?(): void;
		},
	): string;
	reset(widgetId: string): void;
	remove(widgetId: string): void;
}

let loaderPromise: Promise<TurnstileApi> | null = null;

/** Load Cloudflare's turnstile script once, returning the global
 * `turnstile` API once it's ready.  Subsequent callers share the
 * same promise. */
function loadTurnstile(): Promise<TurnstileApi> {
	if (loaderPromise) return loaderPromise;
	loaderPromise = new Promise<TurnstileApi>((resolve, reject) => {
		if (typeof window === "undefined" || typeof document === "undefined") {
			reject(new Error("no document"));
			return;
		}
		// Already loaded by an earlier call?  Resolve immediately.
		const existing = (window as { turnstile?: TurnstileApi }).turnstile;
		if (existing) {
			resolve(existing);
			return;
		}
		// Cloudflare's script calls `window.__kovenTurnstileLoaded`
		// when ready — give it a function to find.
		(window as { __kovenTurnstileLoaded?: () => void }).__kovenTurnstileLoaded = () => {
			const api = (window as { turnstile?: TurnstileApi }).turnstile;
			if (api) resolve(api);
			else reject(new Error("turnstile global not present after onload"));
		};
		const s = document.createElement("script");
		s.src = SCRIPT_URL;
		s.async = true;
		s.defer = true;
		s.onerror = () => reject(new Error("turnstile script failed to load"));
		document.head.appendChild(s);
	});
	return loaderPromise;
}

export interface UseTurnstileResult {
	/** The current valid token from the widget, or null when not yet
	 * solved / expired / errored.  Submit handlers should refuse to
	 * fire when this is null. */
	token: string | null;
	/** Force the widget to re-challenge.  Call after a server-side
	 * verification failure so the user can try again without a full
	 * page reload. */
	reset(): void;
	/** Latest error from the widget pipeline (load failure, callback
	 * failure, etc.).  Null on success / not-yet-loaded. */
	error: string | null;
}

/** Render Cloudflare Turnstile into `containerRef`.  No-op when
 * `siteKey` is falsy.  Returns the live token + a reset helper. */
export function useTurnstile(
	containerRef: React.RefObject<HTMLDivElement | null>,
	siteKey: string | null | undefined,
): UseTurnstileResult {
	const [token, setToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const widgetIdRef = useRef<string | null>(null);
	const apiRef = useRef<TurnstileApi | null>(null);

	useEffect(() => {
		if (!siteKey) return;
		if (!containerRef.current) return;
		let cancelled = false;
		setError(null);
		loadTurnstile()
			.then(api => {
				if (cancelled) return;
				if (!containerRef.current) return;
				apiRef.current = api;
				try {
					widgetIdRef.current = api.render(containerRef.current, {
						sitekey: siteKey,
						theme: "auto",
						// Default appearance: managed (Cloudflare picks
						// invisible vs visible challenge).  No prop
						// needed — managed is the default when omitted.
						callback: (t) => {
							if (!cancelled) setToken(t);
						},
						"error-callback": () => {
							if (!cancelled) {
								setToken(null);
								setError("Turnstile reported an error.");
							}
						},
						"expired-callback": () => {
							if (!cancelled) setToken(null);
						},
						"timeout-callback": () => {
							if (!cancelled) setToken(null);
						},
					});
				} catch (err) {
					if (!cancelled) setError(err instanceof Error ? err.message : String(err));
				}
			})
			.catch(err => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
			const id = widgetIdRef.current;
			const api = apiRef.current;
			if (id && api) {
				try { api.remove(id); } catch { /* widget already gone */ }
			}
			widgetIdRef.current = null;
			apiRef.current = null;
		};
	}, [containerRef, siteKey]);

	return {
		token,
		error,
		reset: () => {
			const id = widgetIdRef.current;
			const api = apiRef.current;
			if (id && api) {
				try { api.reset(id); setToken(null); } catch { /* widget gone */ }
			}
		},
	};
}

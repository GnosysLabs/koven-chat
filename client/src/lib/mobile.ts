// Mobile-viewport detection + helpers.
//
// HISTORY: this file used to read a `window.__KOVEN_MOBILE__` flag
// set by the Tauri mobile shell.  We pivoted away from a packaged
// mobile app to a PWA, so "are we on mobile?" is now a viewport
// question — not a shell-identity question.  Every mobile UI
// adjustment we built (bottom tab bar, drawer-less navigation,
// safe-area padding, larger touch targets) still applies; it just
// kicks in based on viewport size + pointer type rather than which
// app shell loaded the SPA.
//
// Detection rule:
//   - viewport ≤ 640 CSS px, OR
//   - coarse pointer (touch) AND viewport ≤ 1024
//
// Catches: phones in any orientation, tablets in portrait, narrow
// browser windows on desktop (devs testing the mobile layout).
// Excludes: wide desktop browsers and tablets in landscape.
//
// USAGE:
//   - `isMobileShell` — a live `let` export.  Read it inside a
//     React render and the latest value comes through; it updates
//     on viewport change via the side-effect at the bottom of
//     this file.
//   - `mobile(cls)` / `desktop(cls)` — Tailwind classname helpers
//     for `cn(...)` use sites.
//   - `.mobile-shell` class on `<html>` — preferred for plain CSS
//     rules that only need to differ on mobile.  Kept in sync
//     reactively here so resize / orientation changes flip the
//     class without each consumer subscribing.
//   - `platform` — coarse UA tag for the few places that need to
//     differentiate iOS Safari behaviour (e.g. safe-area quirks).

const MOBILE_MEDIA_QUERY =
	"(max-width: 640px), (pointer: coarse) and (max-width: 1024px)";

declare global {
	interface Window {
		__KOVEN_MOBILE__?: boolean;
		__KOVEN_PLATFORM__?: "ios" | "android" | "macos" | "linux" | "windows" | "unknown";
	}
}

function evaluate(): boolean {
	if (typeof window === "undefined") return false;
	return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

function detectPlatform():
	| "ios" | "android" | "macos" | "linux" | "windows" | "unknown" {
	if (typeof navigator === "undefined") return "unknown";
	const ua = navigator.userAgent;
	// iPad reports "Macintosh" on iPadOS 13+; cross-check touch.
	const isIpad =
		/Macintosh/.test(ua)
		&& typeof navigator.maxTouchPoints === "number"
		&& navigator.maxTouchPoints > 1;
	if (/iPhone|iPod/.test(ua) || isIpad || /iPad/.test(ua)) return "ios";
	if (/Android/.test(ua)) return "android";
	if (/Mac OS X/.test(ua)) return "macos";
	if (/Windows/.test(ua)) return "windows";
	if (/Linux/.test(ua)) return "linux";
	return "unknown";
}

/// Live binding — re-read at every component render to pick up
/// viewport changes.  ES module live bindings let `let` exports
/// update for importers without anyone re-importing.
// eslint-disable-next-line prefer-const
export let isMobileShell: boolean = evaluate();

/// Static-ish UA tag.  Captured at module load; doesn't change
/// during a session.
export const platform = detectPlatform();

/// Tailwind / classname helpers — emit `cls` only on mobile or
/// only on desktop.  Composable inside `cn(...)`.
export function mobile(cls: string): string {
	return isMobileShell ? cls : "";
}
export function desktop(cls: string): string {
	return isMobileShell ? "" : cls;
}

// ── Side effect: keep `<html class="mobile-shell">` and the
// `data-platform` attribute in sync with the live viewport state.
// Plain CSS rules under `.mobile-shell` (see `index.css`) drive
// the bulk of the mobile adjustments without any React state, so
// keeping this attribute current is the cheapest way to make the
// SPA reflow on resize / orientation flips.
function applyHtmlAttrs() {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	if (isMobileShell) root.classList.add("mobile-shell");
	else root.classList.remove("mobile-shell");
	root.setAttribute("data-platform", platform);
}

if (typeof window !== "undefined") {
	applyHtmlAttrs();
	const mq = window.matchMedia(MOBILE_MEDIA_QUERY);
	const onChange = () => {
		isMobileShell = mq.matches;
		applyHtmlAttrs();
	};
	// Modern API everywhere we target; addListener fallback covers
	// iOS Safari < 14, which we still occasionally see in the wild.
	if (typeof mq.addEventListener === "function") {
		mq.addEventListener("change", onChange);
	} else {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(mq as any).addListener(onChange);
	}
}

// Native-shell bootstrap.  Called once early in App.tsx mount when
// we detect we're running inside Capacitor (iOS / Android).  Has no
// effect in a regular browser or under Tauri.
//
// Why dynamic-import the Capacitor plugins instead of static-import:
// the koven-web client is the same bundle that gets shipped to the
// web, to Tauri desktop, and to Capacitor mobile.  Vite still needs
// these packages installed so it can analyze the imports, but dynamic
// imports keep the native plugin code out of hosts that never call it.

/** True when running inside a Capacitor WebView (iOS / Android shell). */
export function isCapacitor(): boolean {
	return typeof window !== "undefined"
		&& (window as { Capacitor?: unknown }).Capacitor !== undefined;
}

/** True when running inside any native shell — Capacitor (iOS / Android)
 * OR Tauri (desktop / mobile experimental) OR the legacy
 * `__KOVEN_DESKTOP__` init flag.  Use this for "we are not a regular
 * mobile browser" decisions like showing the brand wallpaper /
 * wordmark on login surfaces. */
export function isNativeShell(): boolean {
	if (typeof window === "undefined") return false;
	const w = window as {
		Capacitor?: unknown;
		isTauri?: boolean;
		__KOVEN_DESKTOP__?: boolean;
	};
	return w.Capacitor !== undefined
		|| w.isTauri === true
		|| w.__KOVEN_DESKTOP__ === true;
}

// ── Soft-keyboard tracking ────────────────────────────────────────
//
// iOS WKWebView never shrinks the layout viewport for the soft
// keyboard.  With Capacitor's `resize: "none"` the WebView keeps its
// full-screen frame, and `interactive-widget=resizes-content` (the
// viewport-meta opt-in) is an Android-Chromium feature WebKit ignores.
// So `100dvh` does NOT track the keyboard — the keyboard slides up
// OVER the page and nothing moves out of the way on its own.
//
// `--keyboard-inset` is the fix: a CSS custom property on <html>
// holding the live keyboard height in px (0 when down).  It is the
// single source of truth every keyboard-aware surface reads — the
// chat composer / push-view screens lift by it, the pre-auth login
// and encryption columns fold it into their bottom padding, mobile
// dialogs add it to their scroll padding.  `kb-open` is the matching
// boolean signal (keyboard up) that index.css uses to collapse
// `--composer-pb`'s home-indicator strip while the keyboard hides it.

/** Write the keyboard height to <html> as `--keyboard-inset` and keep
 * the `kb-open` class in sync. */
function publishKeyboardInset(px: number): void {
	const height = Math.max(0, Math.round(px));
	const root = document.documentElement;
	root.style.setProperty("--keyboard-inset", `${height}px`);
	root.classList.toggle("kb-open", height > 0);
}

let keyboardTrackingStarted = false;

/** Subscribe to the soft keyboard and publish its height.  Two signal
 * sources, picked by host:
 *
 *   - Capacitor (iOS / Android): @capacitor/keyboard's keyboardWillShow
 *     / keyboardWillHide.  `willShow` fires as the keyboard BEGINS its
 *     slide-in and carries the final height, so surfaces that
 *     transition `padding-bottom` track the slide instead of snapping.
 *   - Plain mobile browser (iOS Safari PWA, Chrome Android): the
 *     VisualViewport API.  The soft keyboard shrinks `visualViewport`
 *     even when the layout viewport (and `100dvh`) stays full size.
 *
 * Only one source runs per host.  Listeners live for the app's
 * lifetime — never torn down. */
async function setupKeyboardTracking(): Promise<void> {
	if (typeof window === "undefined") return;
	if (keyboardTrackingStarted) return;
	keyboardTrackingStarted = true;

	if (isCapacitor()) {
		try {
			const { Keyboard } = await import("@capacitor/keyboard");
			Keyboard.addListener("keyboardWillShow", (info) => {
				publishKeyboardInset(info.keyboardHeight);
			});
			Keyboard.addListener("keyboardWillHide", () => {
				publishKeyboardInset(0);
			});
			return;
		} catch {
			// Plugin missing (e.g. the web build running under
			// Capacitor's dev server) — fall through to VisualViewport.
		}
	}

	const vv = window.visualViewport;
	if (!vv) return;
	const sync = () => {
		// The keyboard occupies the gap between the layout viewport
		// (window.innerHeight) and the visual viewport.  `offsetTop`
		// accounts for the page being scrolled within the visual
		// viewport when a focused field pins the view upward.
		publishKeyboardInset(window.innerHeight - vv.height - vv.offsetTop);
	};
	vv.addEventListener("resize", sync);
	vv.addEventListener("scroll", sync);
	sync();
}

/** Apply native-shell tweaks that improve mobile UX.  Currently:
 *
 *   - Track the soft keyboard and publish `--keyboard-inset` /
 *     `kb-open` (runs on every mobile host — Capacitor uses the
 *     native plugin events, plain browsers use VisualViewport).
 *
 *   - Hide the keyboard input-accessory bar (the up/down/done strip
 *     iOS attaches above the keyboard for form-field navigation).
 *     It looks out of place in a chat composer and covers the top of
 *     the keyboard with vestigial buttons.  Capacitor only.
 *
 * Safe to call repeatedly; keyboard tracking guards against
 * double-registration and the Capacitor APIs are idempotent. */
export async function applyNativeShellTweaks(): Promise<void> {
	void setupKeyboardTracking();

	if (!isCapacitor()) return;
	try {
		const { Keyboard } = await import("@capacitor/keyboard");
		await Keyboard.setAccessoryBarVisible({ isVisible: false });
	} catch {
		// Plugin not installed (e.g. running web build via Capacitor's
		// dev-server in a browser) — silently no-op.
	}
}

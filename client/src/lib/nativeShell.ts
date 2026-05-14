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

/** Toggle `html.kb-open` while the soft keyboard is up.  Driven by
 * focus on text inputs — synchronous, fires the instant the keyboard
 * is about to come up.  Used as a defensive override for
 * `--composer-pb`: iOS's env(safe-area-inset-bottom) is supposed to
 * collapse to 0 automatically while the keyboard covers the home
 * indicator (we opt into this behavior via
 * `interactive-widget=resizes-content` in index.html), but if a given
 * WKWebView version doesn't honor that, the `:focus-within` / kb-open
 * rules in index.css still drop the inset to its 0.5rem floor.
 *
 * The composer's vertical OFFSET (moving above the keyboard) is
 * handled purely in CSS via `#root { height: 100dvh }` — no JS height
 * tracking, no per-device fallbacks, no event plumbing. */
function isTextInput(el: EventTarget | null): boolean {
	if (!(el instanceof HTMLElement)) return false;
	const tag = el.tagName;
	if (tag === "TEXTAREA") return true;
	if (tag === "INPUT") {
		const type = (el as HTMLInputElement).type;
		// Buttons / checkboxes / etc. don't summon the keyboard; only
		// text-flavored inputs.
		return type !== "button" && type !== "submit" && type !== "checkbox"
			&& type !== "radio" && type !== "file" && type !== "range"
			&& type !== "color";
	}
	return el.isContentEditable;
}

let blurResetTimer: number | null = null;

function setupKeyboardClassToggle() {
	if (typeof window === "undefined") return;
	document.addEventListener("focusin", (e) => {
		if (!isTextInput(e.target)) return;
		if (blurResetTimer !== null) {
			window.clearTimeout(blurResetTimer);
			blurResetTimer = null;
		}
		document.documentElement.classList.add("kb-open");
	});
	document.addEventListener("focusout", (e) => {
		if (!isTextInput(e.target)) return;
		// Delay the reset — if the user is tab-hopping between inputs,
		// focusout fires on the old input before focusin fires on the
		// new one.  The 80ms gap catches the swap and skips the
		// premature kb-open removal.
		if (blurResetTimer !== null) window.clearTimeout(blurResetTimer);
		blurResetTimer = window.setTimeout(() => {
			blurResetTimer = null;
			if (!isTextInput(document.activeElement)) {
				document.documentElement.classList.remove("kb-open");
			}
		}, 80);
	});
}

/** Apply native-shell tweaks that improve mobile UX.  Currently:
 *
 *   - Hide the keyboard input-accessory bar (the up/down/done strip
 *     that iOS attaches above the keyboard for form-field
 *     navigation).  It looks out of place in a chat composer and
 *     covers the top of the keyboard with vestigial buttons.
 *
 *   - Toggle `html.kb-open` while the soft keyboard is up.  iOS
 *     Capacitor's env(safe-area-inset-bottom) value is computed from
 *     the layout viewport and keeps reporting ~34pt of home-indicator
 *     inset even when the keyboard fully covers the indicator.  The
 *     chat composer reserves that strip as bottom padding (see
 *     `--composer-pb` in index.css) — without an override, the result
 *     is a 34pt black band between the textarea and the keyboard top.
 *     We mirror that signal into a class on <html> so CSS can drop
 *     `--composer-pb` to 0 while typing.
 *
 * Safe to call repeatedly; the Capacitor APIs are idempotent. */
export async function applyNativeShellTweaks(): Promise<void> {
	// kb-open class toggle runs on every platform — pure focus-driven,
	// no platform APIs needed.  Used by index.css rules that need a
	// keyboard-is-up signal for compositional overrides.
	setupKeyboardClassToggle();

	if (!isCapacitor()) return;
	try {
		const { Keyboard } = await import("@capacitor/keyboard");
		await Keyboard.setAccessoryBarVisible({ isVisible: false });
	} catch {
		// Plugin not installed (e.g. running web build via Capacitor's
		// dev-server in a browser) — silently no-op.
	}
}

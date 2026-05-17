// Native-shell bootstrap.  Called once early in App.tsx mount when
// we detect we're running inside Capacitor (iOS / Android).  Has no
// effect in a regular browser or under Tauri.
//
// Capacitor plugin calls go through the injected bridge global instead
// of package imports.  The production iOS bundle is loaded by WKWebView,
// where a leftover bare `@capacitor/*` import cannot be resolved at
// runtime.

import { ENGINE_URL } from "@/lib/urls";

/** True when running inside a Capacitor WebView (iOS / Android shell). */
export function isCapacitor(): boolean {
	return typeof window !== "undefined"
		&& (window as { Capacitor?: unknown }).Capacitor !== undefined;
}

/** True when running inside any native shell: Capacitor (iOS / Android)
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

interface KeyboardInfo {
	keyboardHeight: number;
}

interface KeyboardListenerHandle {
	remove(): Promise<void> | void;
}

interface NativeKeyboardPlugin {
	addListener(
		eventName: "keyboardWillShow",
		listenerFunc: (info: KeyboardInfo) => void,
	): Promise<KeyboardListenerHandle> | KeyboardListenerHandle;
	addListener(
		eventName: "keyboardWillHide",
		listenerFunc: () => void,
	): Promise<KeyboardListenerHandle> | KeyboardListenerHandle;
	setAccessoryBarVisible(options: { isVisible: boolean }): Promise<void>;
}

interface CapacitorBridge {
	Plugins?: {
		Keyboard?: NativeKeyboardPlugin;
		[name: string]: unknown;
	};
}

interface KeyboardWindowEvent extends Event {
	keyboardHeight?: number;
	detail?: {
		keyboardHeight?: number;
	};
}

function getKeyboardPlugin(): NativeKeyboardPlugin | null {
	if (typeof window === "undefined") return null;
	const bridge = (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
	return bridge?.Plugins?.Keyboard ?? null;
}

function readKeyboardHeight(event: Event): number | null {
	const keyboardEvent = event as KeyboardWindowEvent;
	const height = keyboardEvent.keyboardHeight ?? keyboardEvent.detail?.keyboardHeight;
	return typeof height === "number" && Number.isFinite(height) ? height : null;
}

// ── Soft-keyboard tracking ────────────────────────────────────────
//
// iOS WKWebView never shrinks the layout viewport for the soft
// keyboard.  With Capacitor's `resize: "none"` the WebView keeps its
// full-screen frame, and `interactive-widget=resizes-content` (the
// viewport-meta opt-in) is an Android-Chromium feature WebKit ignores.
// So `100dvh` does NOT track the keyboard.  The keyboard slides up
// OVER the page and nothing moves out of the way on its own.
//
// `--keyboard-inset` is the fix: a CSS custom property on <html>
// holding the live keyboard height in px (0 when down).  It is the
// single source of truth every keyboard-aware surface reads: the
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
 *   - Capacitor (iOS / Android): the native Keyboard plugin's window
 *     events publish the height.  The bridge listener also records the
 *     same signal when `window.Capacitor.Plugins.Keyboard` is present.
 *     `willShow` fires as the keyboard BEGINS its slide-in and carries
 *     the final height, so surfaces that transition `padding-bottom`
 *     track the slide instead of snapping.
 *   - Plain mobile browser (iOS Safari PWA, Chrome Android): the
 *     VisualViewport API.  The soft keyboard shrinks `visualViewport`
 *     even when the layout viewport (and `100dvh`) stays full size.
 *
 * The Capacitor and browser paths are mutually exclusive.  Listeners
 * live for the app's lifetime and are never torn down. */
async function setupKeyboardTracking(): Promise<void> {
	if (typeof window === "undefined") return;
	if (keyboardTrackingStarted) return;
	keyboardTrackingStarted = true;

	window.addEventListener("keyboardWillShow", (e) => {
		const h = readKeyboardHeight(e);
		if (h !== null) publishKeyboardInset(h);
	});
	window.addEventListener("keyboardWillHide", () => {
		publishKeyboardInset(0);
	});

	if (isCapacitor()) {
		const keyboard = getKeyboardPlugin();
		if (!keyboard) return;

		try {
			keyboard.addListener("keyboardWillShow", (info) => {
				publishKeyboardInset(info.keyboardHeight);
			});
			keyboard.addListener("keyboardWillHide", () => {
				publishKeyboardInset(0);
			});
			return;
		} catch {
			// If the bridge listener path fails, keep the raw window
			// event path alive.  That is the same native signal and it
			// carries the keyboard height on iOS.
			return;
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
 *     `kb-open` (runs on every mobile host.  Capacitor uses the
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
	const keyboard = getKeyboardPlugin();
	if (!keyboard) return;
	try {
		await keyboard.setAccessoryBarVisible({ isVisible: false });
	} catch {
		// Plugin not installed, silently no-op.
	}
}

// ── Push notification registration ──────────────────────────────────

interface PushNotificationsPlugin {
	requestPermissions(): Promise<{ receive: string }>;
	register(): Promise<void>;
	addListener(
		eventName: "registration",
		listenerFunc: (token: { value: string }) => void,
	): Promise<{ remove(): Promise<void> }> | { remove(): Promise<void> };
	addListener(
		eventName: "registrationError",
		listenerFunc: (error: { error: string }) => void,
	): Promise<{ remove(): Promise<void> }> | { remove(): Promise<void> };
}

function getPushPlugin(): PushNotificationsPlugin | null {
	if (typeof window === "undefined") return null;
	const bridge = (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
	return (bridge?.Plugins?.PushNotifications as PushNotificationsPlugin) ?? null;
}

let pushRegistered = false;

/** Request push notification permission, register with APNs, and send
 * the device token to the engine.  Call after login when an access
 * token is available.  No-op outside Capacitor or on repeated calls. */
export async function registerPushToken(accessToken: string): Promise<void> {
	if (!isCapacitor() || pushRegistered) return;
	const push = getPushPlugin();
	if (!push) return;

	try {
		const perm = await push.requestPermissions();
		if (perm.receive !== "granted") return;

		push.addListener("registration", (token) => {
			pushRegistered = true;
			fetch(`${ENGINE_URL}/api/push/register`, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ token: token.value, platform: "ios" }),
			}).catch(err => console.warn("[push] token registration failed:", err));
		});

		push.addListener("registrationError", (err) => {
			console.warn("[push] registration error:", err.error);
		});

		await push.register();
	} catch (err) {
		console.warn("[push] setup failed:", err);
	}
}

/** Unregister the current device's push token from the engine.
 * Call on sign-out. */
export async function unregisterPushToken(accessToken: string, token: string): Promise<void> {
	try {
		await fetch(`${ENGINE_URL}/api/push/unregister`, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ token }),
		});
	} catch {
		// Best-effort; if the server is unreachable the token will
		// just sit until the user signs in again.
	}
	pushRegistered = false;
}

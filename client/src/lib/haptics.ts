// Haptic feedback wrapper.  Talks directly to the Capacitor bridge
// global (`window.Capacitor.Plugins.Haptics`) instead of importing
// `@capacitor/haptics` through its ESM entrypoint.  Two reasons:
//
//   1. The ESM entrypoint registers a JS plugin proxy that, on
//      non-native platforms, silently falls back to `HapticsWeb`,
//      which calls `navigator.vibrate` — unavailable on iOS Safari
//      and the iOS WKWebView, where the fallback throws an "API
//      unavailable" error that the previous wrapper caught and
//      silently swallowed.  Hitting the bridge global directly means
//      "missing = no plugin" instead of "missing = wrong plugin."
//   2. The dynamic import added a microtask delay between the user
//      gesture (button press, swipe release) and the bridge call.
//      iOS doesn't actually gate haptics on user-gesture context the
//      way it gates audio, but a shorter chain is easier to reason
//      about when something fails.
//
// All decision points log at `console.warn` level so they're visible
// in Xcode's debug console (the bottom pane when you `cap run ios` or
// build to a device from Xcode).  WKWebView pipes JS console output
// into the iOS app's stderr, which Xcode surfaces directly — no
// Safari Web Inspector required.
//
// Diagnostic-flag-driven; flip HAPTICS_DEBUG to false once haptics
// are confirmed working on-device.

const HAPTICS_DEBUG = true;

type ImpactStyle = "light" | "medium" | "heavy";
type NotificationType = "success" | "warning" | "error";

interface BridgeHaptics {
	impact(opts: { style: string }): Promise<void>;
	notification(opts: { type: string }): Promise<void>;
	selectionStart(): Promise<void>;
	selectionChanged(): Promise<void>;
	selectionEnd(): Promise<void>;
	vibrate(opts: { duration?: number }): Promise<void>;
}

interface CapacitorBridge {
	Plugins?: {
		Haptics?: BridgeHaptics;
		[name: string]: unknown;
	};
	isNativePlatform?(): boolean;
	getPlatform?(): string;
}

function getBridge(): CapacitorBridge | null {
	if (typeof window === "undefined") return null;
	return (window as unknown as { Capacitor?: CapacitorBridge }).Capacitor ?? null;
}

function getHaptics(): BridgeHaptics | null {
	return getBridge()?.Plugins?.Haptics ?? null;
}

// Init diagnostic.  Deferred one tick so plugin registration (which
// runs synchronously after window.Capacitor is injected but before
// React mounts) has definitely landed.  Reads:
//   bridge: missing            → not running in Capacitor (regular
//                                 browser / Tauri desktop).  Expected
//                                 outside the iOS shell.
//   bridge: present, plugin:   → Capacitor is wired up but the
//   missing                      Haptics native pod isn't linked.
//                                 Run `cap sync ios` and rebuild.
//   bridge + plugin: present   → JS-to-native chain is healthy.  If
//                                 `impact ok` logs but you feel
//                                 nothing, the device has System
//                                 Haptics off (Settings → Sounds &
//                                 Haptics → System Haptics) or is in
//                                 Low Power Mode.  Both globally
//                                 suppress UIImpactFeedbackGenerator
//                                 with no error.
if (HAPTICS_DEBUG && typeof window !== "undefined") {
	setTimeout(() => {
		const bridge = getBridge();
		const haptics = getHaptics();
		console.warn("[haptics] init diagnostic", {
			bridge: bridge ? "present" : "missing",
			platform: bridge?.getPlatform?.() ?? "unknown",
			isNative: bridge?.isNativePlatform?.() ?? false,
			hapticsPlugin: haptics ? "present" : "missing",
			pluginNames: bridge?.Plugins ? Object.keys(bridge.Plugins) : [],
		});
	}, 0);
}

function styleKey(style: ImpactStyle): string {
	if (style === "light") return "LIGHT";
	if (style === "medium") return "MEDIUM";
	return "HEAVY";
}

function notifKey(type: NotificationType): string {
	if (type === "warning") return "WARNING";
	if (type === "error") return "ERROR";
	return "SUCCESS";
}

/** Tactile thud for committing to an action (button press, field
 * submission).  `medium` matches iOS's default for primary actions. */
export async function hapticImpact(style: ImpactStyle = "medium"): Promise<void> {
	const haptics = getHaptics();
	if (!haptics) {
		if (HAPTICS_DEBUG) console.warn("[haptics] impact: no bridge plugin", { style });
		return;
	}
	try {
		await haptics.impact({ style: styleKey(style) });
		if (HAPTICS_DEBUG) console.warn("[haptics] impact ok", style);
	} catch (err) {
		console.warn("[haptics] impact bridge call failed", { style, err });
	}
}

/** Outcome haptic for the result of an action (success after sign-in
 * completes, error after a failed verify, warning for recoverable
 * hiccups). */
export async function hapticNotification(type: NotificationType): Promise<void> {
	const haptics = getHaptics();
	if (!haptics) {
		if (HAPTICS_DEBUG) console.warn("[haptics] notification: no bridge plugin", { type });
		return;
	}
	try {
		await haptics.notification({ type: notifKey(type) });
		if (HAPTICS_DEBUG) console.warn("[haptics] notification ok", type);
	} catch (err) {
		console.warn("[haptics] notification bridge call failed", { type, err });
	}
}

/** Subtle click for UI state changes (selection moved, picker
 * advanced). */
export async function hapticSelection(): Promise<void> {
	const haptics = getHaptics();
	if (!haptics) {
		if (HAPTICS_DEBUG) console.warn("[haptics] selection: no bridge plugin");
		return;
	}
	try {
		await haptics.selectionChanged();
		if (HAPTICS_DEBUG) console.warn("[haptics] selection ok");
	} catch (err) {
		console.warn("[haptics] selection bridge call failed", err);
	}
}

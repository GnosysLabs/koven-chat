// Haptic feedback wrapper.  Mirrors `nativeShell.ts`: the same web
// bundle ships to web (where `@capacitor/haptics` doesn't resolve),
// Tauri desktop (where it also doesn't), and the iOS Capacitor
// WebView (where it does).  Dynamic-import + try/catch keeps the
// plugin out of every host that won't use it.
//
// Outside Capacitor every call is a silent async no-op.

import { isCapacitor } from "./nativeShell";

type ImpactStyle = "light" | "medium" | "heavy";
type NotificationType = "success" | "warning" | "error";

// Single resolved-promise cache.  First caller pays the dynamic
// import; everyone after rides the same module instance.  Storing
// the promise itself (not a flag + value) means parallel callers
// during the load window all await the one in-flight import.
let pluginPromise: Promise<HapticsModule | null> | null = null;

interface HapticsModule {
	Haptics: {
		impact(opts: { style: string }): Promise<void>;
		notification(opts: { type: string }): Promise<void>;
		selectionStart(): Promise<void>;
		selectionChanged(): Promise<void>;
		selectionEnd(): Promise<void>;
	};
	ImpactStyle: Record<"Light" | "Medium" | "Heavy", string>;
	NotificationType: Record<"Success" | "Warning" | "Error", string>;
}

async function loadPlugin(): Promise<HapticsModule | null> {
	if (!isCapacitor()) return null;
	try {
		// @ts-expect-error: optional native-only dependency, only
		// resolves inside the iOS Capacitor WebView at runtime.
		const mod = await import("@capacitor/haptics");
		return mod as HapticsModule;
	} catch {
		return null;
	}
}

function getPlugin(): Promise<HapticsModule | null> {
	if (!pluginPromise) pluginPromise = loadPlugin();
	return pluginPromise;
}

/** Tactile thud — for committing to an action (button press,
 * field submission).  `medium` is the iOS default for primary
 * actions. */
export async function hapticImpact(style: ImpactStyle = "medium"): Promise<void> {
	const p = await getPlugin();
	if (!p) return;
	const key = (style.charAt(0).toUpperCase() + style.slice(1)) as "Light" | "Medium" | "Heavy";
	try { await p.Haptics.impact({ style: p.ImpactStyle[key] }); } catch { /* no-op */ }
}

/** Outcome haptic — for the result of an action, not the action
 * itself.  `success` after sign-in completes, `error` after a
 * failed verify, `warning` for recoverable hiccups. */
export async function hapticNotification(type: NotificationType): Promise<void> {
	const p = await getPlugin();
	if (!p) return;
	const key = (type.charAt(0).toUpperCase() + type.slice(1)) as "Success" | "Warning" | "Error";
	try { await p.Haptics.notification({ type: p.NotificationType[key] }); } catch { /* no-op */ }
}

/** Subtle click — for UI state changes (selection moved, picker
 * advanced).  Not used today, but exported so future surfaces
 * don't reach for `hapticImpact("light")` and overdrive it. */
export async function hapticSelection(): Promise<void> {
	const p = await getPlugin();
	if (!p) return;
	try { await p.Haptics.selectionChanged(); } catch { /* no-op */ }
}

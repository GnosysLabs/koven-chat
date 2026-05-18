// Thin wrapper over the native barcode scanner used for QR device
// sign-in.  Backed by @capacitor-mlkit/barcode-scanning, which the
// native iOS shell registers on the Capacitor bridge as
// `Capacitor.Plugins.BarcodeScanner`.
//
// We reach the plugin through the bridge global rather than a bare
// `@capacitor-mlkit/*` import: the production iOS bundle is loaded by
// WKWebView, where an unresolved bare import would throw at runtime.
// Same pattern as the Keyboard / PushNotifications access in
// nativeShell.ts.

interface Barcode {
	rawValue?: string;
}

interface BarcodeScannerPlugin {
	requestPermissions(): Promise<{ camera: string }>;
	scan(): Promise<{ barcodes: Barcode[] }>;
}

function getBarcodeScannerPlugin(): BarcodeScannerPlugin | null {
	if (typeof window === "undefined") return null;
	const bridge = (window as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor;
	return (bridge?.Plugins?.BarcodeScanner as BarcodeScannerPlugin | undefined) ?? null;
}

export type ScanResult =
	| { ok: true; value: string }
	| { ok: false; reason: "unavailable" | "permission" | "cancelled" };

/** Open the native QR scanner and return the first scanned value.
 * Resolves with a tagged failure rather than throwing so the caller
 * can branch cleanly on permission vs. cancel vs. no-plugin. */
export async function scanQrCode(): Promise<ScanResult> {
	const plugin = getBarcodeScannerPlugin();
	if (!plugin) return { ok: false, reason: "unavailable" };
	try {
		const perm = await plugin.requestPermissions();
		// "limited" covers the iOS partial-access tier; either grants
		// enough for a one-shot scan.
		if (perm.camera !== "granted" && perm.camera !== "limited") {
			return { ok: false, reason: "permission" };
		}
		const { barcodes } = await plugin.scan();
		const value = barcodes[0]?.rawValue;
		if (!value) return { ok: false, reason: "cancelled" };
		return { ok: true, value };
	} catch {
		// The native UI throws on user-cancel; treat any throw as a
		// cancel; there is nothing actionable to surface.
		return { ok: false, reason: "cancelled" };
	}
}

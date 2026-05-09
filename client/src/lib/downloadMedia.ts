// Cross-WebView download helper for in-timeline media.
//
// Three distinct code paths depending on the host environment:
//
//   1. Tauri (desktop apps): IPC route.  Fetch the bytes in JS,
//      hand them to the `save_download` Rust command, which writes
//      to the OS Downloads folder via std::fs.  Bypasses the
//      WebView's download machinery entirely — the only path that
//      reliably works in all three Tauri WebView backends
//      (WKWebView, WebKitGTK, WebView2).  Earlier "tricks"
//      (data: URL anchor downloads, on_download Rust hook) all
//      failed in WKWebView because data:- and blob:-URL anchor
//      clicks navigate the WebView instead of triggering a
//      download event.
//
//   2. Browser with showSaveFilePicker (Chromium, recent Edge):
//      use the File System Access API for a proper save dialog.
//      Better UX than the silent anchor download because the
//      user picks the location.  Skipped automatically on
//      Firefox / Safari which don't expose the API.
//
//   3. Plain browser fallback: anchor with download attribute
//      pointed at the blob: URL.  Works in every browser; lands
//      in the user's default Downloads folder.

interface TauriInternals {
	__TAURI_INTERNALS__?: unknown;
}

function isTauri(): boolean {
	return typeof window !== "undefined"
		&& !!(window as unknown as TauriInternals).__TAURI_INTERNALS__;
}

export async function downloadMediaUrl(url: string, filename: string): Promise<void> {
	const safeName = filename || "download";
	try {
		// Tauri path — IPC the bytes to the Rust side, which writes
		// to ~/Downloads/.  This is the only path that works in
		// macOS WKWebView, where every other anchor-download
		// approach silently fails.  Path 1 in the module-level
		// comment.
		if (isTauri()) {
			const res = await fetch(url);
			const buf = await res.arrayBuffer();
			// Tauri 2's invoke serialises Uint8Array as raw bytes
			// (Vec<u8> on the Rust side) without going through JSON,
			// so this stays efficient even for multi-MB media.  Going
			// through Array.from(...) instead would JSON-encode every
			// byte and blow up memory by ~6x.
			const { invoke } = await import("@tauri-apps/api/core");
			const dest = await invoke<string>("save_download", {
				filename: safeName,
				bytes: new Uint8Array(buf),
			});
			console.info(`downloadMediaUrl: saved to ${dest}`);
			return;
		}

		// Browser path — prefer the File System Access API for a
		// real save dialog when available.  Path 2.
		const showSaveFilePicker = (window as unknown as {
			showSaveFilePicker?: (opts: {
				suggestedName?: string;
			}) => Promise<{ createWritable(): Promise<{
				write(b: Blob): Promise<void>;
				close(): Promise<void>;
			}>; }>;
		}).showSaveFilePicker;
		if (typeof showSaveFilePicker === "function") {
			try {
				const res = await fetch(url);
				const blob = await res.blob();
				const handle = await showSaveFilePicker({ suggestedName: safeName });
				const writable = await handle.createWritable();
				await writable.write(blob);
				await writable.close();
				return;
			} catch (err) {
				// User cancelled the dialog, or the API errored.
				// `AbortError` = cancel, treat as silent no-op.
				if ((err as { name?: string })?.name === "AbortError") return;
				console.warn("downloadMediaUrl: showSaveFilePicker failed, falling back to anchor", err);
				// fall through to anchor path
			}
		}

		// Anchor fallback — Path 3.  Browser-only path.
		const a = document.createElement("a");
		a.href = url;
		a.download = safeName;
		document.body.appendChild(a);
		a.click();
		a.remove();
	} catch (err) {
		console.error("downloadMediaUrl: failed to save", safeName, err);
	}
}

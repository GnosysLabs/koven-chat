// Cross-WebView download helper for in-timeline media.
//
// Why this exists: anchor-with-download attribute pointed at a `blob:`
// URL works in the major browsers but is silently dropped by Tauri's
// WebView backends (WKWebView on macOS, WebKitGTK on Linux, and to a
// lesser extent WebView2 on Windows).  Same root issue we hit on the
// recovery-key download, fixed the same way: read the bytes as a
// data: URL — which all three Tauri WebViews do follow as anchor
// download targets, and which the on_download Rust handler in
// apps/desktop/src-tauri/src/lib.rs intercepts and routes to the OS
// Downloads folder.
//
// Cost: ~33% memory inflation from base64 encoding.  Fine for chat
// media (almost always under 25 MB); the tiny risk surface is huge
// videos, but our Synapse `max_upload_size` is 50 MB anyway and the
// next step from there is a proper Tauri filesystem-plugin path,
// which we'll add when someone hits the limit.

export async function downloadMediaUrl(url: string, filename: string): Promise<void> {
	try {
		const res = await fetch(url);
		const blob = await res.blob();
		const dataUrl = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(blob);
		});
		const a = document.createElement("a");
		a.href = dataUrl;
		a.download = filename || "download";
		document.body.appendChild(a);
		a.click();
		a.remove();
	} catch (err) {
		console.error("downloadMediaUrl: failed to save", filename, err);
	}
}

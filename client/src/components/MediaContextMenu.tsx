// Right-click menu for media in the chat timeline (images, videos,
// audio, generic files).  Thin adapter over the generic ContextMenu
// primitive — adds the media-specific Download + Copy file actions.
//
// Replaces the browser's default context menu with one that actually
// works in Tauri WebViews — the native "Save image as" entry doesn't
// fire a download in WKWebView / WebView2 / WebKitGTK because their
// download paths don't intercept blob: URL anchor clicks.

import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { Download, Copy } from "lucide-react";
import { downloadMediaUrl } from "@/lib/downloadMedia";

export interface MediaContextMenuProps {
	x: number;
	y: number;
	url: string;
	filename: string;
	onClose(): void;
}

export function MediaContextMenu({ x, y, url, filename, onClose }: MediaContextMenuProps) {
	const items: ContextMenuItem[] = [
		{
			label: "Download",
			icon: <Download className="h-4 w-4" />,
			onClick: () => downloadMediaUrl(url, filename),
		},
		{
			label: "Copy file",
			icon: <Copy className="h-4 w-4" />,
			onClick: () => copyMediaToClipboard(url),
		},
	];
	return <ContextMenu x={x} y={y} items={items} onClose={onClose} />;
}

/**
 * Copy media bytes onto the system clipboard.  Uses the modern
 * Clipboard API which accepts a `ClipboardItem` for binary types.
 * Falls back gracefully when the API or the specific MIME isn't
 * supported (e.g. Firefox-on-Linux gates writes behind a pref) — the
 * user just sees a console warning rather than an error toast.
 */
async function copyMediaToClipboard(url: string): Promise<void> {
	try {
		const res = await fetch(url);
		const blob = await res.blob();
		if (!navigator.clipboard?.write) {
			console.warn("copyMediaToClipboard: clipboard API not available");
			return;
		}
		await navigator.clipboard.write([
			new ClipboardItem({ [blob.type]: blob }),
		]);
	} catch (err) {
		console.warn("copyMediaToClipboard: failed", err);
	}
}

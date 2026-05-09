// Right-click menu for media in the chat timeline (images, videos,
// audio, generic files).  Replaces the browser's default context menu
// with one that actually works in Tauri WebViews — the native "Save
// image as" entry doesn't fire a download in Tauri's WKWebView /
// WebView2 / WebKitGTK builds because their target attribute paths
// don't intercept blob: URL anchor clicks.
//
// We hand-roll the menu rather than pulling in another Radix primitive
// because the existing MemberContextMenu uses the same hand-rolled
// pattern (cursor-positioned portal + outside-mousedown dismissal),
// and consistency between the two right-click surfaces is worth more
// than the abstraction.

import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
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
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const onDown = (e: MouseEvent) => {
			if (!ref.current) return;
			if (ref.current.contains(e.target as Node)) return;
			onClose();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [onClose]);

	if (typeof document === "undefined") return null;

	// Cursor clamp so the menu never renders past the viewport edge.
	const menuW = 200;
	const menuH = 96;
	const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
	const vh = typeof window !== "undefined" ? window.innerHeight : 800;
	const left = Math.min(x, vw - menuW - 8);
	const top = Math.min(y, vh - menuH - 8);

	return createPortal(
		<div
			ref={ref}
			role="menu"
			style={{ position: "fixed", left, top, zIndex: 60 }}
			className={cn(
				"min-w-[12rem] rounded-md border border-border bg-popover text-popover-foreground shadow-md",
				"py-1 text-sm",
			)}
			onContextMenu={(e) => e.preventDefault()}
		>
			<MenuItem
				icon={<Download className="h-4 w-4" />}
				label="Download"
				onClick={async () => {
					await downloadMediaUrl(url, filename);
					onClose();
				}}
			/>
			<MenuItem
				icon={<Copy className="h-4 w-4" />}
				label="Copy file"
				onClick={async () => {
					await copyMediaToClipboard(url);
					onClose();
				}}
			/>
		</div>,
		document.body,
	);
}

function MenuItem({
	icon, label, onClick,
}: {
	icon: React.ReactNode;
	label: string;
	onClick(): void;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			onClick={onClick}
			className={cn(
				"w-full flex items-center gap-2 px-3 py-1.5 text-left",
				"hover:bg-accent focus:bg-accent focus:outline-none",
				"transition-colors",
			)}
		>
			<span className="text-muted-foreground shrink-0">{icon}</span>
			<span className="truncate">{label}</span>
		</button>
	);
}

/**
 * Copy media bytes onto the system clipboard so the user can paste
 * the image into another app.  Uses the modern Clipboard API which
 * accepts a `ClipboardItem` for binary types.  Falls back gracefully
 * when the API or the specific MIME type isn't supported (e.g. the
 * Clipboard API in Firefox-on-Linux still gates writes behind a
 * pref) — the user just sees a console warning rather than an
 * error toast, since this is a "nice to have" path; Download is the
 * load-bearing affordance.
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

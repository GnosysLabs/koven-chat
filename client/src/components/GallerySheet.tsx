// Room media gallery — grid view of every image/video shared in the
// active room.  Opens from the chat header's "Images" icon and reads
// from the parent's already-loaded message timeline.  No engine
// support needed: the timeline is the source of truth, and matrix-
// js-sdk has the bytes (or the auth-fetch paths to retrieve them)
// for whatever's been paginated in.
//
// Coverage:
//   - kind: "image" with a mediaMxc — includes GIFs (image/gif), JPGs,
//     PNGs, WebP, etc.
//   - kind: "video" with a mediaMxc
//   - audio + file are intentionally excluded; their presentation
//     doesn't fit a grid (audio is invisible in a thumb, files have
//     no visual preview).  Could be a separate "Files" tab later.
//
// Pagination:
//   - For v1 the gallery shows whatever's in `messages`.  The chat
//     timeline already offers infinite scroll; users who want older
//     media just scroll the chat first to load more, then reopen the
//     gallery.  Auto-paginating from the gallery would require a
//     dedicated request loop; deferred until anyone asks.

import { useMemo, useState, useEffect } from "react";
import { ChevronLeft, ChevronRight, Download, Images, Play, X } from "lucide-react";
import { downloadMediaUrl } from "@/lib/downloadMedia";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogPortal,
	DialogTitle,
} from "@/components/ui/dialog";
import { useMatrixAttachment, useMatrixVideoPoster } from "@/lib/useMatrixAttachment";
import type { Message } from "@koven/shared";
import { cn } from "@/lib/utils";

interface GallerySheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	messages: Message[];
	roomName: string;
}

export function GallerySheet({ open, onOpenChange, messages, roomName }: GallerySheetProps) {
	// Filter once per `messages` change.  Reverse-chronological — the
	// most recent media is the most likely target.  Stable id (event
	// id) drives React's reconciliation key so re-renders during
	// new-message arrivals don't unmount existing thumbnails.
	const items = useMemo(() => {
		return messages
			.filter(m =>
				(m.kind === "image" || m.kind === "video")
				&& !!m.mediaMxc
				&& !m.pending,
			)
			.slice()
			.reverse();
	}, [messages]);

	// Lightbox state: index into `items` of the currently-open media.
	// `null` = grid view (no lightbox).  Reset to null when the sheet
	// closes so reopening always lands on the grid.
	const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
	useEffect(() => {
		if (!open) setLightboxIdx(null);
	}, [open]);

	// Keyboard nav inside the lightbox: arrow keys scroll, Escape
	// closes back to the grid.  Skipped while the lightbox is closed
	// so the keys remain available to the underlying app.
	useEffect(() => {
		if (lightboxIdx === null) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "ArrowLeft") setLightboxIdx(i => (i === null ? null : Math.max(0, i - 1)));
			else if (e.key === "ArrowRight") setLightboxIdx(i => (i === null ? null : Math.min(items.length - 1, i + 1)));
			else if (e.key === "Escape") setLightboxIdx(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [lightboxIdx, items.length]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="sm:max-w-3xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden"
				// Lightbox is portalled to document.body so it can
				// escape the dialog's transformed containing block
				// (necessary for the fixed-position overlay to fill
				// the viewport instead of getting squished into the
				// dialog's footprint).  Side-effect: clicks on
				// lightbox chevrons / download / etc. look like
				// outside-clicks to Radix Dialog, which by default
				// closes on outside pointer-down — so the dialog
				// (and the lightbox under it) tore down on the
				// first chevron tap.  Block the close while the
				// lightbox is open.  Same for Escape: it should
				// close the LIGHTBOX first, dialog second.
				onPointerDownOutside={(e) => {
					if (lightboxIdx !== null) e.preventDefault();
				}}
				onEscapeKeyDown={(e) => {
					if (lightboxIdx !== null) {
						e.preventDefault();
						setLightboxIdx(null);
					}
				}}
			>
				<DialogHeader className="px-5 pt-5 pb-3 border-b border-border/60">
					<DialogTitle className="flex items-center gap-2 text-base">
						<Images className="h-4 w-4 text-muted-foreground" />
						Media in {roomName}
					</DialogTitle>
					<DialogDescription className="text-xs">
						{items.length === 0
							? "No images or videos have been shared yet."
							: `${items.length} ${items.length === 1 ? "item" : "items"} — most recent first.`}
					</DialogDescription>
				</DialogHeader>

				<div className="flex-1 overflow-y-auto p-3">
					{items.length === 0 ? (
						<div className="h-full min-h-[200px] flex flex-col items-center justify-center gap-2 text-muted-foreground">
							<Images className="h-8 w-8 opacity-40" />
							<p className="text-sm">Nothing to show.</p>
							<p className="text-[11px] leading-snug max-w-[260px] text-center">
								Scroll up in chat to load older history, then reopen this gallery.
							</p>
						</div>
					) : (
						<div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
							{items.map((m, i) => (
								<MediaThumb
									key={m.id}
									message={m}
									onClick={() => setLightboxIdx(i)}
								/>
							))}
						</div>
					)}
				</div>

				{lightboxIdx !== null && items[lightboxIdx] && (
					<MediaLightbox
						message={items[lightboxIdx]!}
						hasPrev={lightboxIdx > 0}
						hasNext={lightboxIdx < items.length - 1}
						onPrev={() => setLightboxIdx(i => i === null ? null : Math.max(0, i - 1))}
						onNext={() => setLightboxIdx(i => i === null ? null : Math.min(items.length - 1, i + 1))}
						onClose={() => setLightboxIdx(null)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function MediaThumb({ message, onClick }: { message: Message; onClick(): void }) {
	const isVideo = message.kind === "video";
	// For videos: prefer the sender-supplied poster from
	// info.thumbnail_url / info.thumbnail_file.  Newly uploaded videos
	// always have one (see videoThumbnail.ts + uploadAndSendAttachment);
	// older messages and external Matrix clients that don't include a
	// thumbnail fall back to the legacy `<video preload="metadata">`
	// pattern, which works in Chromium-based renderers but paints
	// black on WKWebView.  The fallback isn't great, but it matches
	// the prior behaviour exactly; the fix is purely additive.
	const poster = useMatrixVideoPoster(message);
	// We only need the main media URL when we DON'T have a poster
	// (else the <img> path is enough and we save the full-resolution
	// fetch + decode cost the gallery doesn't need).  Hooks have to
	// be called unconditionally; useMatrixAttachment treats an
	// undefined `mediaMxc` as a no-op and never starts the fetch.
	const skipMain = isVideo && !!poster;
	const url = useMatrixAttachment(skipMain
		? { mediaMxc: undefined, mediaMimeType: undefined, mediaEncrypted: undefined }
		: message,
	);
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"relative aspect-square overflow-hidden rounded-md bg-muted/60",
				"hover:ring-2 hover:ring-primary/60 transition-shadow",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
			)}
			aria-label={message.mediaName ?? (isVideo ? "Video" : "Image")}
		>
			{isVideo && poster ? (
				// Sender-provided poster: render as a flat <img>.  No
				// <video> element needed in the grid — playback only
				// happens in the lightbox below, so we save the
				// per-tile media-element cost on rooms with lots of
				// videos.
				<img
					src={poster}
					alt={message.mediaName ?? "video"}
					loading="lazy"
					className="w-full h-full object-cover block"
				/>
			) : url ? (
				isVideo ? (
					// Legacy fallback: no embedded poster, ask the
					// browser to paint the first frame.  Works in
					// Chromium; paints black in WKWebView (the
					// limitation that motivated the embedded-poster
					// fix in the first place).
					<video
						src={url}
						muted
						preload="metadata"
						className="w-full h-full object-cover block"
					/>
				) : (
					<img
						src={url}
						alt={message.mediaName ?? "image"}
						loading="lazy"
						className="w-full h-full object-cover block"
					/>
				)
			) : (
				<div className="w-full h-full bg-muted-foreground/10 animate-pulse" />
			)}
			{isVideo && (
				// Floating play badge on video thumbs so the user can
				// distinguish them from images at a glance.  Pointer-
				// events:none so the click still hits the button.
				<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
					<div className="bg-background/70 rounded-full p-1.5">
						<Play className="h-4 w-4 fill-foreground text-foreground" />
					</div>
				</div>
			)}
		</button>
	);
}

function MediaLightbox({
	message,
	hasPrev,
	hasNext,
	onPrev,
	onNext,
	onClose,
}: {
	message: Message;
	hasPrev: boolean;
	hasNext: boolean;
	onPrev(): void;
	onNext(): void;
	onClose(): void;
}) {
	const url = useMatrixAttachment(message);
	const poster = useMatrixVideoPoster(message);
	const isVideo = message.kind === "video";
	if (typeof document === "undefined") return null;
	// Portal to document.body so the fixed overlay actually fills the
	// viewport.  Without this the lightbox renders INSIDE the
	// containing DialogContent, which uses `translate-x-[-50%]
	// translate-y-[-50%]` for centering — that establishes a
	// containing block for `position: fixed`, so `inset-0` ends up
	// pinned to the dialog's 768×85vh footprint instead of the full
	// viewport.  Net effect was the image getting squeezed into the
	// dialog's aspect ratio rather than its own.
	//
	// Use Radix's `DialogPortal` (not a raw `createPortal`) so the
	// lightbox lives inside the same Dialog scope as DialogContent.
	// When `modal={true}` (the default), Radix marks every SIBLING
	// subtree of its portal with `inert` + `aria-hidden` via its
	// focus-scope library — which means a raw createPortal target
	// becomes uninteractive: clicks land but the browser swallows
	// them at the inert boundary.  That's the bug that made the
	// close / download / chevron buttons appear dead.  DialogPortal
	// renders to document.body too (same fixed-positioning benefit)
	// but Radix treats its descendants as part of the dialog so
	// inert isn't applied.
	return (
		<DialogPortal>
		{/* Stacked over the dialog content via a fixed overlay so the
		    underlying grid stays mounted (preserves scroll position +
		    thumbnail decode work).  Backdrop blocks pointer events to
		    the grid so clicks fall through to the close button only. */}
		<div
			className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85"
			onClick={onClose}
		>
			<button
				type="button"
				onClick={(e) => { e.stopPropagation(); onClose(); }}
				aria-label="Close"
				className="absolute top-4 right-4 p-2 rounded-full bg-background/20 hover:bg-background/40 text-white"
			>
				<X className="h-5 w-5" />
			</button>
			{url && (
				<button
					type="button"
					onClick={async (e) => {
						// Same blob:-URL-anchor problem as the chat-pane
						// download path: Tauri's WKWebView / WebKitGTK
						// silently drop anchor downloads pointed at a
						// blob: URL, so the previous <a download> here
						// did nothing in the desktop apps.  Route
						// through downloadMediaUrl, which fetches the
						// bytes and serves them as a data: URL the
						// Rust on_download handler intercepts and
						// writes to OS Downloads/.
						e.stopPropagation();
						await downloadMediaUrl(url, message.mediaName ?? "download");
					}}
					aria-label="Download"
					title="Download"
					className="absolute top-4 right-16 p-2 rounded-full bg-background/20 hover:bg-background/40 text-white"
				>
					<Download className="h-5 w-5" />
				</button>
			)}
			{hasPrev && (
				<button
					type="button"
					onClick={(e) => { e.stopPropagation(); onPrev(); }}
					aria-label="Previous"
					className="absolute left-4 p-3 rounded-full bg-background/20 hover:bg-background/40 text-white"
				>
					<ChevronLeft className="h-6 w-6" />
				</button>
			)}
			{hasNext && (
				<button
					type="button"
					onClick={(e) => { e.stopPropagation(); onNext(); }}
					aria-label="Next"
					className="absolute right-4 p-3 rounded-full bg-background/20 hover:bg-background/40 text-white"
				>
					<ChevronRight className="h-6 w-6" />
				</button>
			)}
			<div
				className="max-w-[92vw] max-h-[85vh] flex flex-col gap-2 items-center"
				onClick={(e) => e.stopPropagation()}
			>
				{url ? (
					isVideo ? (
						<video
							src={url}
							controls
							autoPlay
							// `poster` paints instantly from the
							// embedded thumbnail mxc while the actual
							// video bytes stream in.  Without it,
							// WKWebView shows a black square until the
							// first keyframe decodes (which can be
							// 1-2s on a 4K source).
							poster={poster}
							// Both axes capped — the natural aspect
							// ratio is preserved because <video> with
							// explicit max-w + max-h shrinks
							// proportionally rather than stretching.
							className="max-w-[92vw] max-h-[80vh] rounded-md"
						/>
					) : (
						<img
							src={url}
							alt={message.mediaName ?? "image"}
							// `object-contain` is belt-and-braces here
							// — max-w + max-h on an <img> already
							// preserves aspect ratio, but if either
							// the surrounding flex layout or a future
							// CSS change ever forced the element to a
							// fixed shape, contain stops it from
							// stretching.
							className="max-w-[92vw] max-h-[80vh] rounded-md object-contain"
						/>
					)
				) : (
					<div className="w-64 h-64 rounded-md bg-muted-foreground/10 animate-pulse" />
				)}
				<div className="text-[11px] text-white/70 flex items-center gap-2">
					<span className="truncate max-w-[60ch]">{message.senderDisplayName}</span>
					<span>·</span>
					<span>{new Date(message.timestamp).toLocaleString()}</span>
				</div>
			</div>
		</div>
		</DialogPortal>
	);
}

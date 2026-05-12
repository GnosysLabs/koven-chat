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
//
// Lightbox modal-stacking note:
//   The lightbox is its OWN top-level `<Dialog>`, rendered as a
//   sibling of the grid Dialog (not as a nested portal inside it).
//   The previous "nested DialogPortal inside the grid's
//   DialogContent" pattern was broken in a specific way that made
//   every lightbox control unclickable — and we kept re-fixing the
//   wrong layer.  Root cause: Radix Dialog in modal mode marks every
//   body-level container that isn't the active DialogContent's tree
//   with `inert` + `aria-hidden` via its focus-scope library.  A
//   nested portal renders to a SIBLING wrapper under document.body,
//   so the outer dialog's modal mechanism marks the nested wrapper
//   inert — and `inert` swallows pointer events at the browser
//   level (the click never reaches the button's handler).  Switching
//   to two sibling Dialogs lets Radix manage the modal stack
//   natively: the inner Dialog's tree is the active surface while
//   it's open, the grid Dialog gets the inert/aria-hidden treatment
//   in the meantime, and both restore correctly on close.

import { useMemo, useState, useEffect } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, Images, Play, X } from "lucide-react";
import { downloadMediaUrl } from "@/lib/downloadMedia";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
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
	// so the keys remain available to the underlying app.  We don't
	// rely on Radix's onEscapeKeyDown for arrow navigation; Radix
	// only forwards Escape, not arrow keys.
	useEffect(() => {
		if (lightboxIdx === null) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "ArrowLeft") setLightboxIdx(i => (i === null ? null : Math.max(0, i - 1)));
			else if (e.key === "ArrowRight") setLightboxIdx(i => (i === null ? null : Math.min(items.length - 1, i + 1)));
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [lightboxIdx, items.length]);

	const lightboxOpen = lightboxIdx !== null && !!items[lightboxIdx];

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent
					className="sm:max-w-3xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden"
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
				</DialogContent>
			</Dialog>

			{/* Lightbox — sibling Dialog, not nested.  See the file
			    header for why this matters.  Renders only when there's
			    a valid index AND the corresponding item exists; the
			    `open` flag flips both on / off based on that combined
			    check so stale indices (e.g. after the items array
			    shrinks while a lightbox was somehow stuck open) don't
			    leave it open against a missing item. */}
			<MediaLightboxDialog
				open={lightboxOpen}
				onClose={() => setLightboxIdx(null)}
				message={lightboxIdx !== null ? items[lightboxIdx] ?? null : null}
				hasPrev={lightboxIdx !== null && lightboxIdx > 0}
				hasNext={lightboxIdx !== null && lightboxIdx < items.length - 1}
				onPrev={() => setLightboxIdx(i => i === null ? null : Math.max(0, i - 1))}
				onNext={() => setLightboxIdx(i => i === null ? null : Math.min(items.length - 1, i + 1))}
			/>
		</>
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

/** Standalone lightbox dialog.  Sibling of the gallery Dialog, not
 * nested inside it — see the file-header note on why nesting broke
 * pointer events.  Uses Radix's raw primitives directly so we can
 * skip the wrapped DialogContent's default close-X and back-arrow
 * decorations: the lightbox has its own controls in their own
 * positions, and the wrapped chrome would render on top of them. */
function MediaLightboxDialog({
	open,
	onClose,
	message,
	hasPrev,
	hasNext,
	onPrev,
	onNext,
}: {
	open: boolean;
	onClose(): void;
	message: Message | null;
	hasPrev: boolean;
	hasNext: boolean;
	onPrev(): void;
	onNext(): void;
}) {
	if (typeof document === "undefined") return null;
	return (
		<DialogPrimitive.Root
			open={open}
			onOpenChange={(o) => { if (!o) onClose(); }}
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay
					className={cn(
						"fixed inset-0 z-[60] bg-black/85",
						"data-[state=open]:animate-in data-[state=closed]:animate-out",
						"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
					)}
				/>
				<DialogPrimitive.Content
					className={cn(
						"fixed inset-0 z-[60] outline-none flex items-center justify-center",
						"data-[state=open]:animate-in data-[state=closed]:animate-out",
						"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
					)}
					aria-describedby={undefined}
				>
					{/* Accessible title for screen readers; visually
					    hidden because the lightbox's visual context
					    is the media itself plus the caption row. */}
					<DialogPrimitive.Title className="sr-only">
						{message?.mediaName ?? (message?.kind === "video" ? "Video" : "Image")}
					</DialogPrimitive.Title>
					{message && (
						<MediaLightboxBody
							message={message}
							hasPrev={hasPrev}
							hasNext={hasNext}
							onPrev={onPrev}
							onNext={onNext}
							onClose={onClose}
						/>
					)}
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

function MediaLightboxBody({
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

	// Backdrop click closes; clicks on the media / controls
	// stopPropagation so they don't bubble to it.  We attach the
	// backdrop handler to a fixed-positioned overlay that fills the
	// DialogContent (which itself fills the viewport), and lay the
	// controls + media on top via absolute positioning.
	return (
		<>
			<div
				className="absolute inset-0"
				onClick={onClose}
				aria-hidden="true"
			/>
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
						// blob: URL.  Route through downloadMediaUrl,
						// which fetches the bytes and serves them as a
						// data: URL the Rust on_download handler
						// intercepts and writes to OS Downloads/.
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
					className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-background/20 hover:bg-background/40 text-white"
				>
					<ChevronLeft className="h-6 w-6" />
				</button>
			)}
			{hasNext && (
				<button
					type="button"
					onClick={(e) => { e.stopPropagation(); onNext(); }}
					aria-label="Next"
					className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-background/20 hover:bg-background/40 text-white"
				>
					<ChevronRight className="h-6 w-6" />
				</button>
			)}
			<div
				className="relative max-w-[92vw] max-h-[85vh] flex flex-col gap-2 items-center"
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
							// WKWebView shows a black square until
							// the first keyframe decodes (which can
							// be 1-2s on a 4K source).
							poster={poster}
							className="max-w-[92vw] max-h-[80vh] rounded-md"
						/>
					) : (
						<img
							src={url}
							alt={message.mediaName ?? "image"}
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
		</>
	);
}


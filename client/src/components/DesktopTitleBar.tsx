// Custom desktop title bar.  Three variants:
//
//   * macOS: three macOS-style traffic lights on the LEFT.  The
//     Rust side hides the OS-native traffic lights so we render
//     ours at pixel-perfect coordinates.  Drag is handled by
//     Tauri's `data-tauri-drag-region` on the strip — synchronous
//     enough on Cocoa that the JS-IPC round-trip doesn't race
//     against the mouse-up.
//   * Windows: Windows 11-style min / max / close on the RIGHT.
//     Rust strips the native title bar (`decorations(false)`) and
//     applies DWM corner rounding before first paint.  Drag is
//     handled entirely in Rust: a subclass on the WebView2 child
//     HWND intercepts WM_LBUTTONDOWN in the drag region and
//     synthesizes a WM_NCLBUTTONDOWN HTCAPTION on the parent
//     in-process (see apps/desktop/src-tauri/src/plugins/
//     windows_rounded_corners.rs::apply_drag_region).  We do NOT
//     wire `data-tauri-drag-region` here — letting it fire would
//     start a SECOND drag via JS-IPC after the native one already
//     began, and the two race on every click.
//   * Linux: same Win11-style chrome as Windows, but drag goes
//     through the JS-IPC path (data-tauri-drag-region +
//     startDragging fallback) because WebKitGTK has no HWND-
//     subclass equivalent.  Mutter/KWin are forgiving about the
//     few-ms latency, so the macOS approach works here too.  The
//     undecorated GTK window loses WM-provided resize edges on
//     Wayland — we paint our own via DesktopResizeEdges below.
//     No rounded corners (no DWM analog; transparency breaks
//     shadows on most WMs).

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type Platform = "macos" | "windows" | "linux" | "other";

function detectPlatform(): Platform {
	if (typeof window === "undefined") return "other";
	const tag = (window as { __KOVEN_PLATFORM__?: string }).__KOVEN_PLATFORM__;
	if (tag === "macos") return "macos";
	if (tag === "windows") return "windows";
	if (tag === "linux") return "linux";
	return "other";
}

// Tauri's resize-direction strings; we only ever pass these eight.
type ResizeDirection =
	| "North" | "South" | "East" | "West"
	| "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

type TauriWindow = {
	close(): Promise<void>;
	minimize(): Promise<void>;
	toggleMaximize(): Promise<void>;
	startDragging(): Promise<void>;
	startResizeDragging(direction: ResizeDirection): Promise<void>;
	isMaximized(): Promise<boolean>;
	onFocusChanged(
		cb: (e: { payload: boolean }) => void,
	): Promise<() => void>;
	onResized(
		cb: () => void,
	): Promise<() => void>;
};

// Module-level cache for the Tauri window object.  Hot path:
// mousedown on the drag strip calls startDragging() with ZERO
// awaits.  Without this cache, every drag attempt does
// `await import("@tauri-apps/api/window")` + a `.then()` chain
// before the IPC even fires — and on Windows the
// `WM_NCLBUTTONDOWN HTCAPTION` trick that starts the drag only
// works if the message arrives while the user is still holding
// the mouse button.  If React re-renders or the JS event loop is
// busy (Matrix sync, focus events), the few-ms delay is enough to
// miss the window and the drag silently no-ops — hence the
// "sometimes works, sometimes doesn't" intermittent we saw.
//
// preloadTauriWindow() is fire-and-forget at module load; the
// promise resolves into cachedWindow as soon as Tauri's API is
// available.  The browser build (no Tauri injected) just gets a
// rejected promise we ignore.
let cachedWindow: TauriWindow | null = null;
let cachedWindowPromise: Promise<TauriWindow | null> | null = null;
function preloadTauriWindow(): Promise<TauriWindow | null> {
	if (cachedWindowPromise) return cachedWindowPromise;
	cachedWindowPromise = import("@tauri-apps/api/window")
		.then((mod) => {
			cachedWindow = mod.getCurrentWindow() as unknown as TauriWindow;
			return cachedWindow;
		})
		.catch(() => null);
	return cachedWindowPromise;
}
// Kick off the preload immediately so by the time the user
// clicks the title bar (always at least one paint after mount),
// cachedWindow is already populated.
if (typeof window !== "undefined") {
	void preloadTauriWindow();
}

async function getCurrentWindow(): Promise<TauriWindow> {
	const w = cachedWindow ?? (await preloadTauriWindow());
	if (!w) throw new Error("Tauri window unavailable");
	return w;
}

export function DesktopTitleBar() {
	const platform = detectPlatform();
	if (platform === "other") return null;

	const [isFocused, setIsFocused] = useState(true);
	const [isMaximized, setIsMaximized] = useState(false);

	useEffect(() => {
		let unlistenFocus: (() => void) | undefined;
		let unlistenResize: (() => void) | undefined;
		let cancelled = false;
		void getCurrentWindow().then(async (w) => {
			if (cancelled) return;
			unlistenFocus = await w.onFocusChanged((e) => setIsFocused(e.payload));
			// Track maximized state so the Windows maximize icon
			// can flip between "maximize" and "restore" glyphs.
			// Harmless on macOS — we just don't use the bit.
			try {
				setIsMaximized(await w.isMaximized());
			} catch { /* no-op */ }
			unlistenResize = await w.onResized(() => {
				void w.isMaximized().then(setIsMaximized).catch(() => { /* no-op */ });
			});
		}).catch((err) => {
			console.error("DesktopTitleBar: getCurrentWindow on mount failed", err);
		});
		return () => {
			cancelled = true;
			unlistenFocus?.();
			unlistenResize?.();
		};
	}, []);

	function withWindow(label: string, action: (w: TauriWindow) => Promise<void>) {
		return () => {
			void getCurrentWindow()
				.then((w) => action(w))
				.catch((err) => console.error(`DesktopTitleBar: ${label} failed`, err));
		};
	}

	function handleDragMouseDown(e: React.MouseEvent<HTMLDivElement>) {
		if (e.button !== 0) return;
		const t = e.target as HTMLElement;
		if (t.closest("button")) return;
		// Fire startDragging synchronously off the cached window if
		// it's ready.  This is the path 99.9% of clicks take — the
		// async path only matters for clicks before the dynamic
		// import has resolved (effectively never on a real run).
		if (cachedWindow) {
			void cachedWindow.startDragging().catch((err) =>
				console.error("DesktopTitleBar: startDragging failed", err),
			);
			return;
		}
		void getCurrentWindow()
			.then((w) => w.startDragging())
			.catch((err) => console.error("DesktopTitleBar: startDragging failed", err));
	}

	if (platform === "macos") {
		return (
			<div
				data-tauri-drag-region
				onMouseDown={handleDragMouseDown}
				// macOS: keep both data-tauri-drag-region AND the
				// startDragging fallback — Cocoa is forgiving about
				// the JS-IPC latency, and either path reliably
				// initiates drag.
				className="absolute inset-x-0 top-0 h-10 z-50 flex items-center pl-5 gap-2 select-none"
			>
				<TrafficLight
					colorClass="bg-[#ff5f57]"
					ariaLabel="Close"
					isFocused={isFocused}
					onClick={withWindow("close", (w) => w.close())}
				/>
				<TrafficLight
					colorClass="bg-[#febc2e]"
					ariaLabel="Minimize"
					isFocused={isFocused}
					onClick={withWindow("minimize", (w) => w.minimize())}
				/>
				<TrafficLight
					colorClass="bg-[#28c840]"
					ariaLabel="Zoom"
					isFocused={isFocused}
					onClick={withWindow("toggleMaximize", (w) => w.toggleMaximize())}
				/>
			</div>
		);
	}

	// Win11-style chrome strip: three controls on the RIGHT (min /
	// max / close), full-height hover backgrounds, X turning red
	// on hover per Win11 convention.  Shared between the Windows
	// and Linux variants — the only difference is drag wiring,
	// which the caller owns via `dragProps`.
	const win11Controls = (
		<>
			<WindowsControl
				ariaLabel="Minimize"
				onClick={withWindow("minimize", (w) => w.minimize())}
			>
				<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
					<rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
				</svg>
			</WindowsControl>
			<WindowsControl
				ariaLabel={isMaximized ? "Restore" : "Maximize"}
				onClick={withWindow("toggleMaximize", (w) => w.toggleMaximize())}
			>
				{isMaximized ? (
					// "Restore" glyph: overlapping squares — the back square
					// is offset up-right, the front square sits in front.
					<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
						<rect x="2.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
						<rect x="0.5" y="2.5" width="7" height="7" fill="rgb(var(--color-card,17 17 17))" stroke="currentColor" strokeWidth="1" />
					</svg>
				) : (
					<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
						<rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
					</svg>
				)}
			</WindowsControl>
			<WindowsControl
				ariaLabel="Close"
				danger
				onClick={withWindow("close", (w) => w.close())}
			>
				<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
					<path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1" />
				</svg>
			</WindowsControl>
		</>
	);

	if (platform === "linux") {
		// Linux: same Win11 chrome as Windows, but drag goes
		// through the JS-IPC path (data-tauri-drag-region +
		// onMouseDown fallback) because WebKitGTK has no HWND
		// subclass to intercept WM_LBUTTONDOWN.  mutter/KWin tolerate
		// the few-ms IPC latency that broke Windows pre-subclass.
		// DesktopResizeEdges paints invisible 4px handles around
		// the window so an undecorated GTK window keeps its resize
		// affordance on Wayland (mutter doesn't grant edge-grab to
		// undecorated wl_surfaces).
		return (
			<>
				<div
					data-tauri-drag-region
					onMouseDown={handleDragMouseDown}
					className="absolute inset-x-0 top-0 h-10 z-50 flex items-center justify-end select-none"
				>
					{win11Controls}
				</div>
				<DesktopResizeEdges />
			</>
		);
	}

	// Windows variant: drag region (the empty space left of the
	// controls) is handled entirely by the WM_LBUTTONDOWN subclass
	// in Rust — no data-tauri-drag-region, no onMouseDown handler.
	// Both would only call startDragging via JS-IPC, which races
	// against the native drag the subclass already initiated, and
	// the two paths confuse each other on every other click.
	return (
		<div
			className="absolute inset-x-0 top-0 h-10 z-50 flex items-center justify-end select-none"
		>
			{win11Controls}
		</div>
	);
}

function TrafficLight({
	colorClass,
	ariaLabel,
	isFocused,
	onClick,
}: {
	colorClass: string;
	ariaLabel: string;
	isFocused: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={ariaLabel}
			className={cn(
				"h-3 w-3 rounded-full transition-colors",
				"shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.18)]",
				// Default arrow cursor — never pointer-hand.  Native
				// macOS traffic lights don't change the cursor when
				// hovered (you click them with the same default
				// pointer you'd use to drag the window); matching
				// that behaviour means the buttons feel like part
				// of the chrome rather than web-page elements.
				"cursor-default",
				isFocused ? colorClass : "bg-[#4d4d4d]",
			)}
		/>
	);
}

function WindowsControl({
	ariaLabel,
	onClick,
	children,
	danger,
}: {
	ariaLabel: string;
	onClick: () => void;
	children: React.ReactNode;
	/** Close button — red hover background, white glyph on hover.
	 *  Matches Win11's convention so users instinctively recognise
	 *  the rightmost button as Close. */
	danger?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={ariaLabel}
			className={cn(
				// 46×40 is the native Win11 caption button size; we
				// match exactly so muscle-memory aim works.
				"h-10 w-[46px] flex items-center justify-center",
				"text-foreground/80 transition-colors",
				"cursor-default",
				danger
					? "hover:bg-[#e81123] hover:text-white"
					: "hover:bg-foreground/10",
			)}
		>
			{children}
		</button>
	);
}

// Eight invisible 4px hit-zones (4 edges + 4 corners) layered over
// the window perimeter, calling `startResizeDragging(<direction>)`
// on mousedown.  Linux-only — Windows handles resize via the OS's
// non-client hit testing (decorations(false) keeps the resize-frame
// behaviour), macOS via Cocoa's window resize gestures.  On Linux
// the undecorated GtkWindow loses both: mutter/Wayland in particular
// only honours edge-resize for windows that carry CSD via libdecor
// or for windows the WM itself decorates, and we're neither.  Hand-
// rolling the resize ring is the same trick Electron's frameless
// windows use on Linux.
//
// Corner zones are stacked LAST so their 12×12 footprint wins the
// hit test over the edge strips that pass through underneath — diag
// resize from the corners stays exactly diag, never accidentally
// rolling to horizontal/vertical when the cursor's a few px off.
function DesktopResizeEdges() {
	function onEdgeDown(direction: ResizeDirection) {
		return (e: React.MouseEvent<HTMLDivElement>) => {
			if (e.button !== 0) return;
			e.preventDefault();
			const w = cachedWindow;
			if (w) {
				void w.startResizeDragging(direction).catch((err) =>
					console.error(`DesktopResizeEdges: ${direction} failed`, err),
				);
				return;
			}
			void getCurrentWindow()
				.then((win) => win.startResizeDragging(direction))
				.catch((err) =>
					console.error(`DesktopResizeEdges: ${direction} failed`, err),
				);
		};
	}

	// z-50 sits above the SPA content but below the title-bar
	// strip (also z-50 but rendered later in the tree, so it wins
	// ties).  Edges are 4px so they don't visually overlap the
	// content; corners are 12px so diag-resize has a sensible
	// target area without the edges fighting them for the hit.
	const edge = "absolute z-50 select-none";
	return (
		<>
			{/* Top edge — between the two top corners. */}
			<div
				className={cn(edge, "top-0 left-3 right-3 h-1 cursor-ns-resize")}
				onMouseDown={onEdgeDown("North")}
			/>
			{/* Bottom edge — between the two bottom corners. */}
			<div
				className={cn(edge, "bottom-0 left-3 right-3 h-1 cursor-ns-resize")}
				onMouseDown={onEdgeDown("South")}
			/>
			{/* Left edge — between the two left corners. */}
			<div
				className={cn(edge, "left-0 top-3 bottom-3 w-1 cursor-ew-resize")}
				onMouseDown={onEdgeDown("West")}
			/>
			{/* Right edge — between the two right corners. */}
			<div
				className={cn(edge, "right-0 top-3 bottom-3 w-1 cursor-ew-resize")}
				onMouseDown={onEdgeDown("East")}
			/>
			{/* Four corners.  12×12, stacked after edges so the
			    diag hit zone wins. */}
			<div
				className={cn(edge, "top-0 left-0 w-3 h-3 cursor-nwse-resize")}
				onMouseDown={onEdgeDown("NorthWest")}
			/>
			<div
				className={cn(edge, "top-0 right-0 w-3 h-3 cursor-nesw-resize")}
				onMouseDown={onEdgeDown("NorthEast")}
			/>
			<div
				className={cn(edge, "bottom-0 left-0 w-3 h-3 cursor-nesw-resize")}
				onMouseDown={onEdgeDown("SouthWest")}
			/>
			<div
				className={cn(edge, "bottom-0 right-0 w-3 h-3 cursor-nwse-resize")}
				onMouseDown={onEdgeDown("SouthEast")}
			/>
		</>
	);
}

// Custom desktop title bar.  Two variants:
//
//   * macOS: three macOS-style traffic lights on the LEFT.  The
//     Rust side hides the OS-native traffic lights so we render
//     ours at pixel-perfect coordinates.
//   * Windows: Windows 11-style min / max / close on the RIGHT.
//     Rust strips the native title bar (`decorations(false)`) and
//     applies DWM corner rounding before first paint.
//
// Linux falls through to the OS's native GTK/KDE chrome — distros
// vary too much for one custom title bar to look right everywhere.
//
// The strip carries `data-tauri-drag-region` (and an explicit
// `startDragging()` fallback for browsers where the drag-region
// attribute alone isn't enough) across the empty space between the
// controls so window drag works the way users expect.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type Platform = "macos" | "windows" | "other";

function detectPlatform(): Platform {
	if (typeof window === "undefined") return "other";
	const tag = (window as { __KOVEN_PLATFORM__?: string }).__KOVEN_PLATFORM__;
	if (tag === "macos") return "macos";
	if (tag === "windows") return "windows";
	return "other";
}

type TauriWindow = {
	close(): Promise<void>;
	minimize(): Promise<void>;
	toggleMaximize(): Promise<void>;
	startDragging(): Promise<void>;
	isMaximized(): Promise<boolean>;
	onFocusChanged(
		cb: (e: { payload: boolean }) => void,
	): Promise<() => void>;
	onResized(
		cb: () => void,
	): Promise<() => void>;
};

async function getCurrentWindow(): Promise<TauriWindow> {
	const mod = await import("@tauri-apps/api/window");
	return mod.getCurrentWindow() as unknown as TauriWindow;
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
		void getCurrentWindow()
			.then((w) => w.startDragging())
			.catch((err) => console.error("DesktopTitleBar: startDragging failed", err));
	}

	if (platform === "macos") {
		return (
			<div
				data-tauri-drag-region
				onMouseDown={handleDragMouseDown}
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

	// Windows variant: three controls on the RIGHT, full-height
	// hover backgrounds, X turning red on hover per Win11
	// convention.  The drag region is the entire bar minus the
	// buttons, same pattern as macOS.
	return (
		<div
			data-tauri-drag-region
			onMouseDown={handleDragMouseDown}
			className="absolute inset-x-0 top-0 h-10 z-50 flex items-center justify-end select-none"
		>
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

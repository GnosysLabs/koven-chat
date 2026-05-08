// Custom title bar for the Koven desktop shell.  Renders different
// chrome on macOS vs. Windows but shares the same architecture:
//
//   * `decorations(false)` on the Tauri side strips ALL native
//     window controls.  This component re-renders them inside the
//     SPA so we control the look pixel-by-pixel and they sit in
//     the right place relative to the rest of the chrome (the
//     centered Koven mark, the divider, the SpaceBar).
//   * `data-tauri-drag-region` on the empty strip + an explicit
//     `mousedown` handler call window.startDragging() — without
//     the explicit call, drags from the WKWebView surface get
//     swallowed before Tauri's drag handler sees them.
//   * Native chrome on Linux: this component returns null on
//     non-macOS, non-Windows desktops.  Linux WMs have well-loved
//     native chrome and the drag-region story is more work for
//     less benefit there.
//
// Visual layout:
//   * macOS — three colored circles (close / minimize / zoom) on
//     the LEFT, like every native Mac window.  No glyphs (Apple
//     hides them by default; we did the same for visual fidelity).
//   * Windows — three monochrome buttons (minimize / maximize /
//     close) on the RIGHT, with the standard gray-hover-on-min/max
//     and red-hover-on-close treatment that's been Microsoft's
//     convention since Win10.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const platform = ((): "macos" | "windows" | "other" => {
	if (typeof window === "undefined") return "other";
	const p = (window as { __KOVEN_PLATFORM__?: string }).__KOVEN_PLATFORM__;
	if (p === "macos" || p === "windows") return p;
	return "other";
})();

type TauriWindow = {
	close(): Promise<void>;
	minimize(): Promise<void>;
	toggleMaximize(): Promise<void>;
	startDragging(): Promise<void>;
	onFocusChanged(
		cb: (e: { payload: boolean }) => void,
	): Promise<() => void>;
};

async function getCurrentWindow(): Promise<TauriWindow> {
	const mod = await import("@tauri-apps/api/window");
	return mod.getCurrentWindow() as unknown as TauriWindow;
}

export function DesktopTitleBar() {
	if (platform === "other") return null;

	const [isFocused, setIsFocused] = useState(true);

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		let cancelled = false;
		void getCurrentWindow().then(async (w) => {
			if (cancelled) return;
			unlisten = await w.onFocusChanged((e) => setIsFocused(e.payload));
		}).catch((err) => {
			console.error("DesktopTitleBar: getCurrentWindow on mount failed", err);
		});
		return () => {
			cancelled = true;
			unlisten?.();
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
				<MacTrafficLight
					colorClass="bg-[#ff5f57]"
					ariaLabel="Close"
					isFocused={isFocused}
					onClick={withWindow("close", (w) => w.close())}
				/>
				<MacTrafficLight
					colorClass="bg-[#febc2e]"
					ariaLabel="Minimize"
					isFocused={isFocused}
					onClick={withWindow("minimize", (w) => w.minimize())}
				/>
				<MacTrafficLight
					colorClass="bg-[#28c840]"
					ariaLabel="Zoom"
					isFocused={isFocused}
					onClick={withWindow("toggleMaximize", (w) => w.toggleMaximize())}
				/>
			</div>
		);
	}

	// Windows — buttons on the right, drag region fills the rest.
	// Three buttons in min / max / close order, matching every
	// native Win11 window's chrome.  Each button is 46px wide
	// (Microsoft's spec) and 40px tall (matches our 10-row gutter),
	// flush to the top-right corner so the close button can be hit
	// in the corner via the Fitts's-law slam users expect.
	return (
		<div
			data-tauri-drag-region
			onMouseDown={handleDragMouseDown}
			className="absolute inset-x-0 top-0 h-10 z-50 flex items-center justify-end select-none"
		>
			<WinControlButton
				ariaLabel="Minimize"
				kind="min"
				onClick={withWindow("minimize", (w) => w.minimize())}
			/>
			<WinControlButton
				ariaLabel="Maximize"
				kind="max"
				onClick={withWindow("toggleMaximize", (w) => w.toggleMaximize())}
			/>
			<WinControlButton
				ariaLabel="Close"
				kind="close"
				onClick={withWindow("close", (w) => w.close())}
			/>
		</div>
	);
}

function MacTrafficLight({
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

// Windows control button — minimize, maximize, or close.  Sized
// 46x40 to match the Win11 spec (46px wide is the standard since
// Win10; 40px tall matches our gutter).  Hover treatment:
//   * minimize / maximize: subtle ~10% white wash
//   * close: red-560 background with white glyph (Microsoft's
//     standard close-button accent)
// Glyphs are inline SVGs so they scale correctly at any DPI and
// match the stroke-weight of native Windows controls.
function WinControlButton({
	ariaLabel,
	kind,
	onClick,
}: {
	ariaLabel: string;
	kind: "min" | "max" | "close";
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={ariaLabel}
			className={cn(
				"h-10 w-[46px] flex items-center justify-center transition-colors cursor-default",
				kind === "close"
					? "hover:bg-[#e81123] hover:text-white text-foreground"
					: "hover:bg-white/10 text-foreground",
			)}
		>
			{kind === "min" && (
				// Horizontal line, 10px wide, centered.
				<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
					<rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
				</svg>
			)}
			{kind === "max" && (
				// Hollow square, 10x10, 1px stroke.  Matches the
				// "maximize" state; we don't swap the glyph to the
				// "restore-down" cascading-squares variant when the
				// window is already maximized — it's a visual nicety
				// users rarely notice and the SPA can't cleanly
				// observe the maximized state without additional
				// wiring.
				<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
					<rect
						x="0.5"
						y="0.5"
						width="9"
						height="9"
						fill="none"
						stroke="currentColor"
						strokeWidth="1"
					/>
				</svg>
			)}
			{kind === "close" && (
				// X, 10x10, 1px stroke.  Corner-to-corner diagonals.
				<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
					<line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1" />
					<line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1" />
				</svg>
			)}
		</button>
	);
}

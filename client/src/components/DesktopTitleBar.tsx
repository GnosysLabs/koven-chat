// Custom macOS title bar.  Replaces the native chrome that
// `decorations(false)` removes in apps/desktop/src-tauri/src/lib.rs.
// Renders only on macOS desktop builds — browsers, Linux, and
// Windows fall through to a `null` and rely on their own chrome.
//
// Layout:
//
//    ┌────────────────────────────────────────────────────────────┐
//    │ ⬤ ⬤ ⬤   ────────────────── drag region ─────────────────── │  ← 32px
//    │ ─────────────────────────────────────────────────────────── │
//    │                                                             │
//    │                  (rest of the SPA below)                    │
//    │                                                             │
//
// The traffic lights mirror macOS's native pattern: 12px circles,
// red/yellow/green, 8px gap between centers, 9px from window-left.
// Hover state shows ✕ / − / ⤢ symbols in the middle of each circle,
// matching what the OS does on its own buttons.  Window-focus state
// dims the lights to gray when the window is in the background —
// same as native.
//
// The strip from the right edge of the third button all the way to
// the right edge of the window carries `data-tauri-drag-region`,
// which Tauri's WebView reads to make that area drag the window.
// Buttons themselves explicitly carry `data-tauri-drag-region="false"`
// because the parent has the attribute and click events on children
// would otherwise be eaten by the drag handler.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const isMacDesktop =
	typeof window !== "undefined" &&
	(window as { __KOVEN_PLATFORM__?: string }).__KOVEN_PLATFORM__ === "macos";

// Lazy import — `@tauri-apps/api/window` ships browser-safe code,
// but importing it eagerly pulls a chunk into the SPA bundle that
// the browser build doesn't need.  Loaded only when the title bar
// actually mounts.
type TauriWindow = {
	close(): Promise<void>;
	minimize(): Promise<void>;
	toggleMaximize(): Promise<void>;
	onFocusChanged(
		cb: (e: { payload: boolean }) => void,
	): Promise<() => void>;
};

async function getCurrentWindow(): Promise<TauriWindow> {
	const mod = await import("@tauri-apps/api/window");
	return mod.getCurrentWindow() as unknown as TauriWindow;
}

export function DesktopTitleBar() {
	if (!isMacDesktop) return null;

	const [isFocused, setIsFocused] = useState(true);
	const [groupHover, setGroupHover] = useState(false);

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		let cancelled = false;
		void getCurrentWindow().then(async (w) => {
			if (cancelled) return;
			unlisten = await w.onFocusChanged((e) => setIsFocused(e.payload));
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);

	function withWindow(action: (w: TauriWindow) => Promise<void>) {
		return () => {
			void getCurrentWindow().then((w) => action(w).catch(() => { /* swallow */ }));
		};
	}

	return (
		<div
			data-tauri-drag-region
			className="h-8 shrink-0 flex items-center pl-[9px] select-none"
			onMouseEnter={() => setGroupHover(true)}
			onMouseLeave={() => setGroupHover(false)}
		>
			<div className="flex items-center gap-2" data-tauri-drag-region="false">
				<TrafficLight
					colorClass="bg-[#ff5f57]"
					symbol={<CloseGlyph />}
					ariaLabel="Close"
					showSymbol={groupHover && isFocused}
					isFocused={isFocused}
					onClick={withWindow((w) => w.close())}
				/>
				<TrafficLight
					colorClass="bg-[#febc2e]"
					symbol={<MinimizeGlyph />}
					ariaLabel="Minimize"
					showSymbol={groupHover && isFocused}
					isFocused={isFocused}
					onClick={withWindow((w) => w.minimize())}
				/>
				<TrafficLight
					colorClass="bg-[#28c840]"
					symbol={<ZoomGlyph />}
					ariaLabel="Zoom"
					showSymbol={groupHover && isFocused}
					isFocused={isFocused}
					onClick={withWindow((w) => w.toggleMaximize())}
				/>
			</div>
		</div>
	);
}

function TrafficLight({
	colorClass,
	symbol,
	ariaLabel,
	showSymbol,
	isFocused,
	onClick,
}: {
	colorClass: string;
	symbol: React.ReactNode;
	ariaLabel: string;
	showSymbol: boolean;
	isFocused: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={ariaLabel}
			data-tauri-drag-region="false"
			className={cn(
				// 12×12 native size.  The button gets a thin inner
				// shadow / outer ring matching the depth macOS gives
				// its own buttons in dark mode.
				"h-3 w-3 rounded-full flex items-center justify-center transition-colors",
				"shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.18)]",
				isFocused ? colorClass : "bg-[#4d4d4d]",
				"hover:brightness-100",
			)}
		>
			<span className={cn(
				"flex items-center justify-center transition-opacity",
				showSymbol ? "opacity-100" : "opacity-0",
			)}>
				{symbol}
			</span>
		</button>
	);
}

// Glyphs are hand-tuned SVGs at 8×8 to match the OS button symbols.
// Lucide / hero icons render with too much stroke at this scale; the
// macOS chrome glyphs are very thin (≈1px stroke at 12px buttons),
// hand-rolling matches more cleanly.

function CloseGlyph() {
	return (
		<svg viewBox="0 0 8 8" width="6" height="6" aria-hidden>
			<path
				d="M1.5 1.5 L6.5 6.5 M6.5 1.5 L1.5 6.5"
				stroke="rgba(0,0,0,0.55)"
				strokeWidth="1.1"
				strokeLinecap="round"
			/>
		</svg>
	);
}

function MinimizeGlyph() {
	return (
		<svg viewBox="0 0 8 8" width="6" height="6" aria-hidden>
			<path
				d="M1.3 4 L6.7 4"
				stroke="rgba(0,0,0,0.55)"
				strokeWidth="1.1"
				strokeLinecap="round"
			/>
		</svg>
	);
}

function ZoomGlyph() {
	// macOS shows two opposing arrows for fullscreen, or a "+" for
	// zoom — Tauri's toggleMaximize is window-zoom semantics, so the
	// arrow form is more accurate.
	return (
		<svg viewBox="0 0 8 8" width="6" height="6" aria-hidden>
			<path
				d="M2.5 5.5 L2.5 2.5 L5.5 2.5 Z M5.5 2.5 L5.5 5.5 L2.5 5.5 Z"
				fill="rgba(0,0,0,0.55)"
			/>
		</svg>
	);
}

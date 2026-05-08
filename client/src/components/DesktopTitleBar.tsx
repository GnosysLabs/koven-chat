// Custom macOS title bar.  The cloudworxx plugin handles rounded
// window corners + the NSWindow style mask, but its
// `enable_modern_window_style` also re-enables the OS's native
// traffic-light buttons.  We invoke `hide_traffic_lights` to
// suppress those, then render our own three buttons here — sized
// and positioned exactly the way the rest of the SPA's chrome
// expects, no double-set-of-lights weirdness.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const isMacDesktop =
	typeof window !== "undefined" &&
	(window as { __KOVEN_PLATFORM__?: string }).__KOVEN_PLATFORM__ === "macos";

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
	if (!isMacDesktop) return null;

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

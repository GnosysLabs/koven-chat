// Shared HIG primitives for the mobile push-view stack.  Extracted
// so MobileProfileScreen / MobileSettingsScreen / MobileBlockedUsersScreen
// / MobileSessionsScreen / MobileDeleteAccountScreen all paint with
// the same nav-bar metrics and grouped-inset card geometry — drift
// here would read as inconsistency from one push to the next.
//
// Calibration:
//   - Nav bar: 44pt content row + safe-area-inset-top, translucent
//     blur material matching MobileTabBar.  Left/right slots 88pt
//     wide so titles stay centred regardless of label length.
//   - Group label: 13pt uppercase tracked muted, 24pt above the
//     card it labels.
//   - Group card: 14pt rounded corners, hairline border, theme-aware
//     card background.  16pt horizontal screen margin.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

export function NavBar({
	left,
	title,
	right,
}: {
	left?: ReactNode;
	title: string;
	right?: ReactNode;
}) {
	return (
		<div
			className={cn(
				"shrink-0 flex items-center px-2",
				"bg-card/70 backdrop-blur-2xl backdrop-saturate-150",
				"border-b border-foreground/10",
				"pt-[env(safe-area-inset-top)]",
			)}
			style={{ minHeight: "calc(44px + env(safe-area-inset-top))" }}
		>
			<div className="min-w-[88px] h-11 flex items-center justify-start">{left}</div>
			<div className="flex-1 flex items-center justify-center min-w-0 px-2">
				<h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground truncate">
					{title}
				</h1>
			</div>
			<div className="min-w-[88px] h-11 flex items-center justify-end">{right}</div>
		</div>
	);
}

export function NavBackButton({
	onClick,
	label = "Back",
}: {
	onClick(): void;
	label?: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label="Back"
			className="inline-flex items-center gap-0.5 pl-1 pr-2 h-11 text-primary active:opacity-60 transition-opacity"
		>
			<ChevronLeft className="h-[26px] w-[26px] -ml-1" strokeWidth={2.5} />
			<span className="text-[17px] truncate max-w-[80px]">{label}</span>
		</button>
	);
}

export function NavTextButton({
	label,
	onClick,
	disabled,
	bold,
	destructive,
}: {
	label: string;
	onClick(): void;
	disabled?: boolean;
	bold?: boolean;
	destructive?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"px-2 h-11 text-[17px] active:opacity-60 transition-opacity",
				"disabled:opacity-40 disabled:active:opacity-40",
				destructive ? "text-destructive" : "text-primary",
				bold && "font-semibold",
			)}
		>
			{label}
		</button>
	);
}

export function GroupLabel({ children }: { children: ReactNode }) {
	return (
		<div className="px-5 pt-6 pb-1.5 text-[13px] font-medium uppercase tracking-[0.06em] text-muted-foreground/80">
			{children}
		</div>
	);
}

export function GroupCard({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"mx-4 rounded-[14px] overflow-hidden",
				"bg-card/85 border border-foreground/10 shadow-sm",
				className,
			)}
		>
			{children}
		</div>
	);
}

export function GroupFooter({ children }: { children: ReactNode }) {
	// 13pt secondary text below a group card — used for explanatory
	// captions ("This will sign out other devices…").  Matches iOS
	// Settings' footer copy treatment.
	return (
		<div className="px-5 pt-2 pb-1 text-[13px] leading-snug text-muted-foreground/80">
			{children}
		</div>
	);
}

export function ErrorBanner({ message }: { message: string }) {
	return (
		<div className="mx-4 mt-3 px-3 py-2 rounded-[10px] border border-destructive/40 bg-destructive/10 text-[13px] text-destructive">
			{message}
		</div>
	);
}

/**
 * PushSlot — wraps a push-view child so it slides in from the right
 * on mount and slides out to the right on the next render where
 * `visible` flips false.  Defers unmount until the exit animation
 * finishes so the parent doesn't need to manage timers itself.
 *
 * Optionally accepts `onPop` to enable the iOS swipe-from-left-edge
 * back gesture: pointerdown within 20px of the left edge starts the
 * drag, the view follows the pointer in real time, and release past
 * a threshold (40% of width or fast horizontal velocity) commits
 * the pop by calling `onPop` (which should flip `visible` false).
 *
 * Usage:
 *   <PushSlot visible={meStack === "profile"} onPop={() => setMeStack("root")}>
 *     <MobileProfileScreen ... />
 *   </PushSlot>
 *
 * The wrapper paints a solid background so the layer below
 * (the screen this push slid in over) isn't visible through the
 * sliding child.  z-index sits one above the root content so
 * the push always covers it during the animation.
 */
const EXIT_DURATION_MS = 240;
const EDGE_ZONE_PX = 24;
const POP_DISTANCE_THRESHOLD = 0.4; // 40% of width
const POP_VELOCITY_THRESHOLD = 0.5; // px/ms

export function PushSlot({
	visible,
	onPop,
	children,
}: {
	visible: boolean;
	onPop?(): void;
	children: ReactNode;
}) {
	const [mounted, setMounted] = useState(visible);
	const [exiting, setExiting] = useState(false);
	const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const slotRef = useRef<HTMLDivElement | null>(null);
	// Latch the child while exiting so it stays visible during the
	// slide-out even after the parent has cleared the new-child
	// slot.  Important for the App.tsx wiring where the parent
	// passes `visible={meStack === "profile"}` and rerenders the
	// whole tree on stack changes.
	const latchedChild = useRef<ReactNode>(children);
	if (visible) latchedChild.current = children;

	// Drag state — `dragX` is the live offset in px; null means
	// "not dragging right now," so CSS animations stay in charge.
	// Storing the live x in a ref + driving the inline style with
	// requestAnimationFrame avoids re-rendering every pointermove,
	// which would tank the framerate on lower-end iPhones.
	const dragState = useRef<{
		pointerId: number;
		startX: number;
		startTime: number;
		lastX: number;
		lastTime: number;
		width: number;
	} | null>(null);
	const [dragX, setDragX] = useState<number | null>(null);

	useEffect(() => {
		if (visible) {
			if (exitTimer.current) {
				clearTimeout(exitTimer.current);
				exitTimer.current = null;
			}
			setExiting(false);
			setMounted(true);
			return;
		}
		if (!mounted) return;
		setExiting(true);
		exitTimer.current = setTimeout(() => {
			setMounted(false);
			setExiting(false);
			exitTimer.current = null;
		}, EXIT_DURATION_MS);
		return () => {
			if (exitTimer.current) {
				clearTimeout(exitTimer.current);
				exitTimer.current = null;
			}
		};
	}, [visible, mounted]);

	function handlePointerDown(e: React.PointerEvent) {
		if (!onPop || !visible || exiting) return;
		// Only the primary pointer; mouse left button only.  Ignore
		// touches that don't start near the left edge — anywhere
		// else and we let the underlying view handle the gesture
		// (scrolling, taps, etc.).
		if (e.pointerType === "mouse" && e.button !== 0) return;
		const slot = slotRef.current;
		if (!slot) return;
		const rect = slot.getBoundingClientRect();
		const relX = e.clientX - rect.left;
		if (relX > EDGE_ZONE_PX) return;
		const now = performance.now();
		dragState.current = {
			pointerId: e.pointerId,
			startX: e.clientX,
			startTime: now,
			lastX: e.clientX,
			lastTime: now,
			width: rect.width,
		};
		setDragX(0);
		try { slot.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
	}

	function handlePointerMove(e: React.PointerEvent) {
		const st = dragState.current;
		if (!st || e.pointerId !== st.pointerId) return;
		// Track only rightward drag — anything left of start is
		// clamped to 0 so the view can't slide off-screen-left.
		const dx = Math.max(0, e.clientX - st.startX);
		st.lastX = e.clientX;
		st.lastTime = performance.now();
		setDragX(dx);
	}

	function endDrag(e: React.PointerEvent, cancelled: boolean) {
		const st = dragState.current;
		if (!st || e.pointerId !== st.pointerId) return;
		dragState.current = null;
		try { slotRef.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
		if (cancelled) {
			setDragX(null);
			return;
		}
		const dx = Math.max(0, e.clientX - st.startX);
		const dt = Math.max(1, performance.now() - st.startTime);
		const velocity = dx / dt;
		const past = dx > st.width * POP_DISTANCE_THRESHOLD;
		const flick = velocity > POP_VELOCITY_THRESHOLD && dx > 24;
		if ((past || flick) && onPop) {
			// Commit the pop.  Drop dragX so the CSS exit animation
			// takes over from translateX(0); a small visual jump
			// from `dx → 0 → exit-anim` is acceptable and snappier
			// than carrying the drag offset through to the exit.
			setDragX(null);
			onPop();
		} else {
			// Snap back — null clears the inline style, returning
			// the slot to its CSS-anchored translateX(0).  A short
			// transition is applied via the snap-back class.
			setDragX(null);
		}
	}

	if (!mounted) return null;

	const dragging = dragX !== null && dragState.current !== null;
	const inlineTransform = dragX !== null && dragState.current !== null
		? { transform: `translateX(${dragX}px)` }
		: undefined;

	return (
		<div
			ref={slotRef}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={(e) => endDrag(e, false)}
			onPointerCancel={(e) => endDrag(e, true)}
			className={cn(
				"absolute inset-0 z-10",
				"bg-background",
				// CSS animation classes only when NOT actively
				// dragging — we drive the transform inline during
				// the drag, then let the CSS take over for the
				// snap-back transition or the post-pop exit.
				!dragging && (exiting ? "mobile-push-exit" : "mobile-push-enter"),
				dragX !== null && !dragging && "mobile-push-snap",
				"touch-pan-y",
			)}
			style={{
				backgroundImage: "var(--bg-gradient)",
				backgroundAttachment: "fixed",
				backgroundRepeat: "no-repeat",
				backgroundSize: "cover",
				...inlineTransform,
			}}
		>
			{latchedChild.current}
		</div>
	);
}

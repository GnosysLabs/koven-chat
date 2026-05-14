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
import { useDrag } from "@use-gesture/react";
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
const SNAP_DURATION_MS = 220;
const EDGE_ZONE_PX = 24;
const POP_DISTANCE_THRESHOLD = 0.4; // 40% of width
const POP_VELOCITY_THRESHOLD = 0.5; // px/ms
const EXIT_EASE = "cubic-bezier(0.4, 0, 0.7, 0.28)";
const SNAP_EASE = "cubic-bezier(0.32, 0.72, 0.18, 1)";

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

	// Two refs replace the dragX state from the previous hand-rolled
	// pointer-event version: `activeRef` tracks whether the current
	// gesture is one we accepted (started within the edge zone), and
	// `dragPoppedRef` tells the mount/exit useEffect below to skip
	// the CSS-keyframe exit animation when the gesture already drove
	// the slot off-screen imperatively.  Skipping is critical — the
	// CSS keyframe starts from translateX(0) and would visibly snap
	// the slot back before re-running the slide-out.
	const activeRef = useRef(false);
	const dragPoppedRef = useRef(false);

	useEffect(() => {
		if (visible) {
			if (exitTimer.current) {
				clearTimeout(exitTimer.current);
				exitTimer.current = null;
			}
			setExiting(false);
			setMounted(true);
			// Re-entering — drop any leftover inline transform from a
			// prior drag-snap-back so the CSS enter keyframe runs
			// cleanly from translateX(100%).
			const slot = slotRef.current;
			if (slot) {
				slot.style.transform = "";
				slot.style.transition = "";
			}
			return;
		}
		if (!mounted) return;
		if (dragPoppedRef.current) {
			// The drag committed the pop; the slot is already at
			// translateX(100%) via the imperative animation.  Just
			// unmount on the next tick — no CSS keyframe needed.
			dragPoppedRef.current = false;
			setMounted(false);
			return;
		}
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

	// useDrag from @use-gesture/react.  Replaces the hand-rolled
	// pointer-event handlers that drove a dragX setState on every
	// move — every move triggered a React re-render, which compounded
	// jank on lower-end iPhones.  Now the transform is mutated
	// directly on the DOM node during the drag, then a CSS transition
	// carries the final snap-back / pop animation.
	//
	// Edge-zone check happens on `first`: drags starting outside the
	// left 24px are cancelled so vertical scrolls / content taps
	// inside the view pass through untouched.  `axis: "x"` keeps
	// vertical pans from triggering this gesture even when they
	// start in the edge zone, so the user can scroll the push view
	// itself without accidentally swiping back.
	const dragBind = useDrag(({ first, last, active, movement: [mx], velocity: [vx], xy, cancel }) => {
		const slot = slotRef.current;
		if (!slot) return;
		if (first) {
			if (!onPop || !visible || exiting) {
				cancel();
				return;
			}
			const rect = slot.getBoundingClientRect();
			const relX = xy[0] - rect.left;
			if (relX > EDGE_ZONE_PX) {
				cancel();
				return;
			}
			activeRef.current = true;
		}
		if (!activeRef.current) return;

		if (active) {
			// Track only rightward drag.  Clamp at 0 so the view
			// can't slide off-screen-left.  No transition — the
			// transform follows the finger 1:1.
			const dx = Math.max(0, mx);
			slot.style.transition = "none";
			slot.style.transform = `translateX(${dx}px)`;
			return;
		}
		if (last) {
			activeRef.current = false;
			const dx = Math.max(0, mx);
			const width = slot.offsetWidth || window.innerWidth || 1;
			const past = dx > width * POP_DISTANCE_THRESHOLD;
			const flick = vx > POP_VELOCITY_THRESHOLD && dx > 24;

			if ((past || flick) && onPop) {
				// Commit the pop.  Continue the animation from the
				// current drag offset off the right edge — duration
				// scales with the remaining distance so a fast
				// flick completes quickly while a slow drag near
				// the threshold takes the full exit duration.
				dragPoppedRef.current = true;
				const remainingFraction = Math.max(0, (width - dx) / width);
				const duration = Math.max(
					120,
					Math.round(EXIT_DURATION_MS * remainingFraction),
				);
				slot.style.transition = `transform ${duration}ms ${EXIT_EASE}`;
				slot.style.transform = "translateX(100%)";
				window.setTimeout(() => onPop(), duration);
			} else {
				// Snap back to docked position.  After the snap
				// completes, clear the inline transform so future
				// state changes (re-pop via the back button, etc.)
				// fall through to the CSS keyframes.
				slot.style.transition = `transform ${SNAP_DURATION_MS}ms ${SNAP_EASE}`;
				slot.style.transform = "translateX(0)";
				window.setTimeout(() => {
					const s = slotRef.current;
					if (!s || activeRef.current) return;
					s.style.transition = "";
					s.style.transform = "";
				}, SNAP_DURATION_MS + 20);
			}
		}
	}, {
		pointer: { touch: true, mouse: true },
		axis: "x",
	});

	if (!mounted) return null;

	return (
		<div
			ref={slotRef}
			{...dragBind()}
			className={cn(
				"absolute inset-0 z-10",
				// `flex flex-col` so children that size themselves
				// via `flex-1` (ChatPane, SpaceHomeMobile) actually
				// fill the slot.  Without this they collapsed to
				// natural content height, leaving an "empty" PushSlot
				// below them — which on the chat use exposed the
				// parallaxed list underneath, and on the space
				// detail use broke scrolling because the
				// `flex-1 overflow-y-auto` container had no defined
				// height to scroll within.
				"flex flex-col",
				// NOTE: no `bg-background` here.  When PushSlot is
				// used as a direct child of `data-mobile-pane="main"`
				// (the chat overlay), index.css's
				// `.mobile-shell [data-mobile-pane] > * { background:
				// transparent !important }` rule strips the wrapper's
				// background, letting the parallaxed list pane peek
				// through.  The opaque layer is painted by the nested
				// `<div>` below instead — a grandchild of the pane,
				// so the !important rule doesn't reach it.
				// CSS keyframes drive enter + non-drag exit.  During
				// a drag, the inline transform overrides whatever
				// would be coming from the keyframe.  If the drag
				// commits a pop, dragPoppedRef suppresses the exit
				// keyframe entirely — the imperative animation
				// already drove the slot off-screen.
				!dragPoppedRef.current && (exiting ? "mobile-push-exit" : "mobile-push-enter"),
				"touch-pan-y",
			)}
		>
			{/* Opaque bg layer.  Nested one level deeper than the
			    slot wrapper so the pane-level transparent !important
			    rule (which only targets direct children of the pane)
			    can't reach it.  -z-10 puts it behind the latched
			    child while staying inside the slot's own stacking
			    context (the slot itself is z-10 in the pane). */}
			<div
				aria-hidden
				className="absolute inset-0 -z-10 bg-background pointer-events-none"
				style={{
					backgroundImage: "var(--bg-gradient)",
					backgroundAttachment: "fixed",
					backgroundRepeat: "no-repeat",
					backgroundSize: "cover",
				}}
			/>
			{latchedChild.current}
		</div>
	);
}

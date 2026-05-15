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
import { useSpring, animated } from "@react-spring/web";
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
 * `visible` flips false.  Defers unmount until the exit spring
 * lands so the parent doesn't need to manage timers itself.
 *
 * Optionally accepts `onPop` to enable the iOS swipe-from-left-edge
 * back gesture: pointerdown within 24px of the left edge starts the
 * drag, the view follows the pointer in real time, and release past
 * a threshold (40% of width or fast horizontal velocity) commits
 * the pop by calling `onPop` (which should flip `visible` false).
 *
 * Animation is driven by @react-spring/web — interruptions tween
 * smoothly from the current frame, so rapid back-and-forth taps
 * never produce the "backwards snap" the previous CSS-keyframe
 * version did.  Drag velocity carries into the release spring, so
 * a fast flick completes off-screen with momentum.
 *
 * The spring also writes a `--push-progress` CSS variable
 * (0 = docked at centre, 1 = off-screen right) onto the nearest
 * `[data-push-host]` ancestor.  Sibling underlayer elements use
 * that variable to parallax/dim in lockstep with the drag, instead
 * of the previous "frozen during the swipe, snap at the end"
 * behaviour.
 *
 * Usage:
 *   <PushSlot visible={meStack === "profile"} onPop={() => setMeStack("root")}>
 *     <MobileProfileScreen ... />
 *   </PushSlot>
 */
const EDGE_ZONE_PX = 24;
const POP_DISTANCE_THRESHOLD = 0.4; // 40% of width
const POP_VELOCITY_THRESHOLD = 0.5; // px/ms
// UIKit's push transition lands near 280ms with an ease-out curve.
// tension 320 / friction 32 gives a perceptually-equivalent spring
// that interrupts cleanly mid-flight (the main reason we're on a
// spring at all instead of a CSS transition).
const SPRING_CONFIG = { tension: 320, friction: 32, clamp: false };

function prefersReducedMotion(): boolean {
	if (typeof window === "undefined") return false;
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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
	const slotRef = useRef<HTMLDivElement | null>(null);
	const activeRef = useRef(false);
	// Latch the child for the exit slide so the parent can clear the
	// new-child slot the moment it pops the stack — the latched
	// ReactNode keeps rendering until the spring lands.
	const latchedChild = useRef<ReactNode>(children);
	if (visible) latchedChild.current = children;
	// Captured at the start of every drag-commit so the spring can
	// inherit the user's flick velocity (fast flick → fast exit;
	// slow drag past threshold → measured exit).  Cleared once the
	// exit effect consumes it so a subsequent tap-back doesn't get
	// a stale push.
	const releaseVelocityRef = useRef(0);
	// `visible` from the latest render, read inside spring `onRest`
	// callbacks where the closure-captured `visible` is stale.  Used
	// to guard against unmounting after a cancelled exit (visible
	// flipped back true while we were mid-slide-out).
	const visibleRef = useRef(visible);
	visibleRef.current = visible;

	const getWidth = () => {
		return slotRef.current?.offsetWidth || window.innerWidth || 1;
	};

	const [{ x }, api] = useSpring(() => ({
		x: visible ? 0 : getWidth(),
		config: SPRING_CONFIG,
	}));

	// Drive enter / exit from the `visible` prop.  Spring continues
	// from its current frame on every api.start — no `from`, no
	// snap.  Mid-flight interruptions (tap-back during enter, tap-
	// open during exit) reverse direction smoothly from wherever the
	// element happens to be.
	useEffect(() => {
		if (visible) {
			setMounted(true);
			api.start({
				x: 0,
				config: SPRING_CONFIG,
				immediate: prefersReducedMotion(),
			});
			return;
		}
		if (!mounted) return;
		const v = releaseVelocityRef.current;
		releaseVelocityRef.current = 0;
		api.start({
			x: getWidth(),
			config: { ...SPRING_CONFIG, velocity: v },
			immediate: prefersReducedMotion(),
			onRest: (result) => {
				// Only unmount if the exit actually completed AND
				// we're still meant to be hidden.  If `visible`
				// flipped back true mid-exit, a new spring is
				// already pulling x toward 0 and we must not yank
				// the DOM out from under it.
				if (result.finished && !visibleRef.current) {
					setMounted(false);
				}
			},
		});
	// `mounted` intentionally omitted: we set it inside this effect,
	// and re-running on its change would loop.  `api` is stable.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [visible]);

	// Write the live drag progress (0 = docked, 1 = off-screen) onto
	// the nearest [data-push-host] ancestor as a CSS custom property.
	// Sibling underlayers read it to parallax in lockstep with the
	// foreground, including during the swipe-back gesture.  Scoped
	// to the host (not document root) so multiple PushSlot stacks
	// in different overlays don't fight over the same variable.
	//
	// We use rAF polling rather than a SpringValue subscription
	// because react-spring's public API doesn't expose a per-frame
	// listener for an animated value off-DOM; piping the value into
	// an <animated.*> style only sets it on that one element, but
	// the underlayer is a sibling — it needs the var on a shared
	// ancestor.  The rAF tick runs at the same cadence as the
	// spring (and skips writes when the value hasn't changed), so
	// the cost is one comparison + at most one style write per
	// frame, only while a slot is mounted.
	useEffect(() => {
		if (!mounted) return;
		const slot = slotRef.current;
		if (!slot) return;
		const host =
			(slot.closest("[data-push-host]") as HTMLElement | null) ??
			(slot.closest("[data-mobile-view]") as HTMLElement | null) ??
			slot.parentElement ??
			document.documentElement;
		let raf = 0;
		let last = -1;
		const tick = () => {
			const w = getWidth();
			const v = x.get();
			const p = Math.min(1, Math.max(0, v / w));
			if (p !== last) {
				host.style.setProperty("--push-progress", String(p));
				last = p;
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(raf);
			// Reset to "no push" so the underlayer returns to
			// identity when this slot unmounts.
			host.style.setProperty("--push-progress", "1");
		};
	}, [x, mounted]);

	const dragBind = useDrag(({
		first, last, active, movement: [mx], velocity: [vx], xy, cancel,
	}) => {
		const slot = slotRef.current;
		if (!slot) return;
		if (first) {
			if (!onPop || !visible) {
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

		const dx = Math.max(0, mx);

		if (active) {
			// Finger 1:1.  immediate=true bypasses spring physics so
			// the slot tracks touch exactly; physics re-engages on
			// release below.
			api.start({ x: dx, immediate: true });
			return;
		}
		if (last) {
			activeRef.current = false;
			const width = getWidth();
			const past = dx > width * POP_DISTANCE_THRESHOLD;
			const flick = vx > POP_VELOCITY_THRESHOLD && dx > 24;

			if ((past || flick) && onPop) {
				// Stash velocity so the visible→false effect's exit
				// spring inherits the flick energy, then let the
				// parent flip visible — that triggers the unified
				// exit path (no duplicated api.start here).
				releaseVelocityRef.current = vx;
				onPop();
			} else {
				api.start({
					x: 0,
					config: SPRING_CONFIG,
					immediate: prefersReducedMotion(),
				});
			}
		}
	}, {
		pointer: { touch: true, mouse: true },
		axis: "x",
	});

	if (!mounted) return null;

	return (
		<animated.div
			ref={slotRef}
			{...dragBind()}
			// `x` is the react-spring push / drag transform.  `padding-
			// bottom` lifts the pushed screen's content above the soft
			// keyboard: `--keyboard-inset` (published by
			// lib/nativeShell.ts) shrinks this flex column's content
			// box, so ChatPane's composer (its last flex child), and
			// any other push view's bottom-anchored UI, rides up by
			// exactly the keyboard height.  Scoped to `padding-bottom`
			// so the transition never touches the spring-driven
			// transform; the 0.25s tracks the keyboard's slide.
			style={{
				x,
				paddingBottom: "var(--keyboard-inset, 0px)",
				transition: "padding-bottom 0.25s ease-out",
			}}
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
				"touch-pan-y",
				"will-change-transform",
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
		</animated.div>
	);
}

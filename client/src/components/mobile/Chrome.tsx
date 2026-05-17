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
import { hapticImpact } from "@/lib/haptics";
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
}: {
	onClick(): void;
}) {
	return (
		<button
			type="button"
			onClick={() => { void hapticImpact("light"); onClick(); }}
			aria-label="Back"
			className="h-10 w-10 -ml-1 rounded-full flex items-center justify-center text-primary active:opacity-60 transition-opacity"
		>
			<ChevronLeft className="h-[26px] w-[26px]" strokeWidth={2.5} />
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
 * PushSlot — wraps a push-view child so it fades and scales in on
 * mount (opacity 0→1, scale 0.97→1) and fades / scales back out on
 * the next render where `visible` flips false.  Defers unmount until
 * the fade-out has finished so the parent doesn't manage timers.
 *
 * The enter / exit tween is a plain CSS transition (the `.push-slot`
 * rule in index.css), NOT a JS animation library.  A CSS transition
 * is driven by the compositor, so it runs identically in every
 * WebKit and Blink build.  The previous react-spring version's
 * requestAnimationFrame frameloop did not advance inside the
 * production iOS WebView — every pushed view stayed frozen at its
 * initial (off-screen / faded-out) frame, so tapping a chat looked
 * like it did nothing at all.
 *
 * Optionally accepts `onPop` to enable the iOS swipe-from-left-edge
 * back gesture: pointerdown within 24px of the left edge starts the
 * drag, horizontal travel fades / shrinks the view in real time
 * (written straight onto the DOM node, no React re-render per move),
 * and release past a threshold (40% of width or a fast horizontal
 * flick) commits the pop by calling `onPop` (which should flip
 * `visible` false).
 *
 * Usage:
 *   <PushSlot visible={meStack === "profile"} onPop={() => setMeStack("root")}>
 *     <MobileProfileScreen ... />
 *   </PushSlot>
 */
const EDGE_ZONE_PX = 44;
const POP_DISTANCE_THRESHOLD = 0.3; // 30% of width
const POP_VELOCITY_THRESHOLD = 0.4; // px/ms
// Keep in sync with the `.push-slot` transition duration in index.css.
const PUSH_TRANSITION_MS = 280;

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
	// `mounted` gates the DOM node; `shown` is the CSS target state
	// (true = docked, false = faded out).  Toggling `shown` is what
	// triggers the `.push-slot` transition.
	const [mounted, setMounted] = useState(visible);
	const [shown, setShown] = useState(visible);
	const slotRef = useRef<HTMLDivElement | null>(null);
	const activeRef = useRef(false);
	// Latch the child for the exit fade so the parent can clear the
	// new-child slot the moment it pops the stack — the latched
	// ReactNode keeps rendering until the unmount timer fires.
	const latchedChild = useRef<ReactNode>(children);
	if (visible) latchedChild.current = children;
	// `visible` from the latest render, read inside the deferred rAF /
	// timeout callbacks where the closure-captured value is stale.
	const visibleRef = useRef(visible);
	visibleRef.current = visible;
	const exitTimerRef = useRef<number | null>(null);
	const enterRafRef = useRef<number | null>(null);

	const getWidth = () => slotRef.current?.offsetWidth || window.innerWidth || 1;

	// Drive enter / exit from the `visible` prop.
	useEffect(() => {
		// Cancel any scheduling still in flight from a previous flip so
		// rapid back-and-forth toggles can't fight each other.
		if (exitTimerRef.current !== null) {
			clearTimeout(exitTimerRef.current);
			exitTimerRef.current = null;
		}
		if (enterRafRef.current !== null) {
			cancelAnimationFrame(enterRafRef.current);
			enterRafRef.current = null;
		}

		if (visible) {
			setMounted(true);
			// Drop any inline overrides a drag (or an interrupted exit)
			// left behind so the `.push-slot` class fully owns the tween.
			const slot = slotRef.current;
			if (slot) {
				slot.style.opacity = "";
				slot.style.transform = "";
				slot.style.transition = "";
			}
			// Mount at the hidden frame, then flip `shown` true a frame
			// later so the browser has a "from" state to transition out
			// of.  Two rAFs: the node is committed and painted hidden by
			// the time the second one runs.
			enterRafRef.current = requestAnimationFrame(() => {
				enterRafRef.current = requestAnimationFrame(() => {
					enterRafRef.current = null;
					void slotRef.current?.offsetHeight; // flush layout
					if (visibleRef.current) setShown(true);
				});
			});
			return;
		}

		if (!mounted) return;
		// Exit: flip to the hidden frame, unmount once the fade-out has
		// had time to land.  A plain timer (not `transitionend`) stays
		// reliable even if the event is dropped or coalesced.
		setShown(false);
		const ms = prefersReducedMotion() ? 0 : PUSH_TRANSITION_MS;
		exitTimerRef.current = window.setTimeout(() => {
			exitTimerRef.current = null;
			if (!visibleRef.current) setMounted(false);
		}, ms + 60);
	// `mounted` intentionally omitted: we set it inside this effect.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [visible]);

	// Tidy up pending timers / frames if the slot unmounts mid-flight.
	useEffect(() => () => {
		if (exitTimerRef.current !== null) clearTimeout(exitTimerRef.current);
		if (enterRafRef.current !== null) cancelAnimationFrame(enterRafRef.current);
	}, []);

	const dragBind = useDrag(({
		first, movement: [mx], velocity: [vx], xy, cancel,
	}) => {
		if (first) {
			if (!onPop || !visible) {
				cancel();
				return;
			}
			const slot = slotRef.current;
			const rect = slot?.getBoundingClientRect();
			if (!rect || xy[0] - rect.left > EDGE_ZONE_PX) {
				cancel();
				return;
			}
			activeRef.current = true;
			return;
		}
		if (!activeRef.current) return;

		const dx = Math.max(0, mx);
		const width = getWidth();
		const past = dx > width * POP_DISTANCE_THRESHOLD;
		const flick = vx > POP_VELOCITY_THRESHOLD && dx > 24;
		if (past || flick) {
			activeRef.current = false;
			cancel();
			onPop!();
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
			// `padding-bottom` lifts the pushed screen's content above
			// the soft keyboard: `--keyboard-inset` (published by
			// lib/nativeShell.ts) shrinks this flex column's content
			// box, so ChatPane's composer (its last flex child) rides
			// up by exactly the keyboard height.  The `.push-slot`
			// class transitions it alongside the fade.
			style={{ paddingBottom: "var(--keyboard-inset, 0px)" }}
			className={cn(
				// `.push-slot` (index.css) owns opacity / transform /
				// transition; `--shown` is the docked target state.
				"push-slot",
				shown && "push-slot--shown",
				"absolute inset-0 z-10",
				// `flex flex-col` so children that size themselves via
				// `flex-1` (ChatPane, SpaceHomeMobile) fill the slot.
				"flex flex-col",
				// NOTE: no `bg-background` here.  When PushSlot is a
				// direct child of `data-mobile-pane="main"` (the chat
				// overlay), index.css's `[data-mobile-pane] > * {
				// background: transparent !important }` rule strips the
				// wrapper background.  The opaque layer is the nested
				// `<div>` below — a grandchild, out of that rule's reach.
				"touch-pan-y",
			)}
		>
			{/* Opaque bg layer.  Nested one level deeper than the slot
			    so the pane-level transparent !important rule (direct
			    children of the pane only) can't reach it.  -z-10 puts
			    it behind the latched child, inside the slot's own
			    stacking context. */}
			<div
				aria-hidden
				className="absolute inset-0 -z-10 bg-background pointer-events-none"
				style={{
					backgroundImage: "var(--bg-gradient)",
					backgroundRepeat: "no-repeat",
					backgroundSize: "cover",
				}}
			/>
			{latchedChild.current}
		</div>
	);
}

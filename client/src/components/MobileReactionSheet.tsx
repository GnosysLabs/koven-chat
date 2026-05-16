// Mobile bottom sheet for reacting to a message.  Opened from the
// long-press menu's "React…" item (see ChatPane → MessageContextMenu).
// Desktop uses a Radix Popover anchored to the SmilePlus button in
// MessageActions, but on phones a 360x450 anchored popover fills most
// of the viewport without respecting any sensible safe area — and the
// anchor point is meaningless under a finger.
//
// Shape: bottom-anchored full-width sheet with a drag handle, an
// emoji picker inside, dimmed scrim behind.  Dismissable by:
//   - tapping the scrim
//   - swiping the handle area down past a threshold OR fast enough
//   - picking an emoji (parent's onPick fires close)
//
// Implementation notes:
//   - Portalled to document.body so the sheet escapes the chat row's
//     contentVisibility / containment + any sticky / overflow stacking.
//   - Mount-then-animate-in via a useEffect + requestAnimationFrame
//     pair so the initial render lands with translateY(100%) and the
//     transition fires on the very next frame.
//   - Drag region is limited to the handle strip at the top.  Letting
//     the whole sheet drag would fight the emoji grid's internal
//     scroll (the picker has its own scrolling category list inside).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDrag } from "@use-gesture/react";
import { MobileEmojiGrid } from "@/components/MobileEmojiGrid";
import { cn } from "@/lib/utils";

export interface MobileReactionSheetProps {
	open: boolean;
	onClose(): void;
	onPick(emoji: string): void;
}

// 220ms feels deliberate without dragging.  Matches the swipe-to-reply
// snap-back transition in ChatPane so the two gestures read as the
// same family of motion.
const SHEET_TRANSITION_MS = 220;
// Drag-to-dismiss thresholds.  Either past 120px down OR a flick with
// vy > 0.5 commits the close.  120px is roughly a quarter of a typical
// phone viewport — far enough that the user clearly intended it.
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 0.5;

export function MobileReactionSheet({ open, onClose, onPick }: MobileReactionSheetProps) {
	// Two-stage lifecycle so we can play the close animation before
	// unmounting: `mounted` controls portal presence, `visible` drives
	// the translateY.  Open: setMounted(true) immediately, then flip
	// `visible` next frame.  Close: setVisible(false), then unmount
	// after the transition.
	const [mounted, setMounted] = useState(false);
	const [visible, setVisible] = useState(false);
	const sheetRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (open) {
			setMounted(true);
			// Defer to next frame so the initial render lands with
			// translateY(100%) before we flip to translateY(0).  Without
			// the rAF gap the transition has no `from` state to animate
			// from and the sheet just pops in.
			const id = requestAnimationFrame(() => setVisible(true));
			return () => cancelAnimationFrame(id);
		}
		// Closing: only react if we were previously mounted.  Avoids a
		// pointless setTimeout on the initial open=false mount.
		if (!mounted) return;
		setVisible(false);
		const t = window.setTimeout(() => setMounted(false), SHEET_TRANSITION_MS);
		return () => window.clearTimeout(t);
	// `mounted` intentionally omitted from deps: we only want to react
	// to changes in the `open` prop, not to our own internal cleanup
	// flipping `mounted` back to false (which would re-fire this effect
	// in a loop).  Read latest `mounted` via closure is fine here.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// Drag-to-dismiss.  Vertical only; clamp upward drag (can't pull
	// the sheet past its docked position).  Manipulate the transform
	// imperatively during the gesture for 60fps; commit a CSS
	// transition on release so the snap-back / commit-close animates.
	const dragBind = useDrag(({ active, movement: [, my], velocity: [, vy], last }) => {
		const el = sheetRef.current;
		if (!el) return;
		const dy = Math.max(0, my);
		if (active) {
			el.style.transform = `translateY(${dy}px)`;
			el.style.transition = "none";
			return;
		}
		if (last) {
			el.style.transition = `transform ${SHEET_TRANSITION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
			if (dy > DISMISS_DISTANCE || vy > DISMISS_VELOCITY) {
				// Commit the close.  Translate to the off-screen position
				// so the existing close-animation path (visible=false →
				// translateY(100%) via the inline style below) doesn't
				// fight us; the unmount timer in the effect will still
				// fire after onClose() flips `open` false.
				el.style.transform = "translateY(100%)";
				onClose();
			} else {
				// Snap back to docked.  Clear the inline transform so the
				// element returns to its className-driven layout.
				el.style.transform = "";
			}
		}
	}, { pointer: { touch: true }, axis: "y" });

	// Lock body scroll while the sheet is mounted.  Without this, a
	// drag that escapes the sheet's drag region (e.g. fingers landing
	// on the dimmed scrim then sliding up) scrolls the chat behind it,
	// which feels broken when the sheet is the active surface.
	useEffect(() => {
		if (!mounted) return;
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => { document.body.style.overflow = prev; };
	}, [mounted]);

	// Escape key (mostly for desktop testing — on mobile there's no
	// physical Escape, but the scrim tap covers that case).
	useEffect(() => {
		if (!mounted) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [mounted, onClose]);

	if (!mounted || typeof document === "undefined") return null;

	return createPortal(
		<div
			className="fixed inset-0 z-[80]"
			role="dialog"
			aria-modal="true"
			aria-label="Pick a reaction"
		>
			{/* Dimmed scrim.  Opacity transitions alongside the sheet's
			    translate so the two reads as a single coordinated open. */}
			<div
				className={cn(
					"absolute inset-0 bg-black/50 transition-opacity",
					visible ? "opacity-100" : "opacity-0",
				)}
				style={{ transitionDuration: `${SHEET_TRANSITION_MS}ms` }}
				onClick={onClose}
			/>
			{/* Sheet container.  rounded-t-xl for the docked top corners.
			    `bottom` tracks the soft keyboard via `--keyboard-inset`
			    (published on <html> by nativeShell.ts): iOS WKWebView
			    runs with Capacitor `resize: "none"`, so the keyboard
			    slides up OVER the page and nothing moves on its own.
			    Lifting `bottom` keeps the search field and grid above
			    the keyboard.  The bottom padding is the home-indicator
			    safe area, collapsed once the keyboard covers it. */}
			<div
				ref={sheetRef}
				className={cn(
					"absolute left-0 right-0 bg-popover text-popover-foreground",
					"rounded-t-xl shadow-2xl border-t border-border",
				)}
				style={{
					bottom: "var(--keyboard-inset, 0px)",
					paddingBottom: "max(0px, calc(env(safe-area-inset-bottom) - var(--keyboard-inset, 0px)))",
					transform: visible ? "translateY(0)" : "translateY(100%)",
					transition: `transform ${SHEET_TRANSITION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1), bottom ${SHEET_TRANSITION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
				}}
			>
				{/* Handle strip.  touch-none so the browser doesn't try to
				    pan/scroll the page when the user drags here — the
				    useDrag handler owns this region's gestures. */}
				<div
					{...dragBind()}
					className="flex justify-center pt-2.5 pb-2 touch-none cursor-grab active:cursor-grabbing"
				>
					<div className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
				</div>
				{/* Discord-style emoji grid.  Fills the sheet width edge to
				    edge (the grid handles its own internal padding). */}
				<div className="pb-3">
					<MobileEmojiGrid onPick={onPick} />
				</div>
			</div>
		</div>,
		document.body,
	);
}

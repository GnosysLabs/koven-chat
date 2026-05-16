// Generic mobile bottom sheet shell.  Extracted from MobileReactionSheet
// so the emoji reaction picker and the GIF / clip / sticker picker share
// one implementation instead of two drifting copies.
//
// Shape: bottom-anchored full-width sheet with a drag handle, a dimmed
// scrim behind, and the caller's content below the handle.  Dismissable
// by tapping the scrim, swiping the handle down past a threshold or fast
// enough, or by the caller flipping `open` (e.g. after a pick).
//
// Implementation notes:
//   - Portalled to document.body so the sheet escapes any chat-row
//     containment / sticky / overflow stacking.
//   - Mount-then-animate-in via a useEffect + requestAnimationFrame pair
//     so the initial render lands at translateY(100%) and the transition
//     fires on the very next frame.
//   - The drag region is ONLY the handle strip.  Letting the whole sheet
//     drag would fight the scrolling content callers put inside (emoji
//     category list, GIF grid).
//   - `bottom` tracks `--keyboard-inset` (published on <html> by
//     nativeShell.ts).  iOS WKWebView runs with Capacitor `resize:
//     "none"`, so the soft keyboard slides up OVER the page and nothing
//     moves on its own.  Lifting `bottom` keeps the sheet above the
//     keyboard; the home-indicator safe-area padding collapses once the
//     keyboard covers it.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDrag } from "@use-gesture/react";
import { cn } from "@/lib/utils";

// 220ms feels deliberate without dragging.  Matches the swipe-to-reply
// snap-back transition in ChatPane so the gestures read as one family.
const SHEET_TRANSITION_MS = 220;
// Drag-to-dismiss thresholds: past 120px down OR a flick with vy > 0.5.
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 0.5;

export interface MobileSheetProps {
	open: boolean;
	onClose(): void;
	/** Accessible label for the dialog role. */
	ariaLabel: string;
	children: React.ReactNode;
}

export function MobileSheet({ open, onClose, ariaLabel, children }: MobileSheetProps) {
	// Two-stage lifecycle so the close animation plays before unmount:
	// `mounted` controls portal presence, `visible` drives translateY.
	const [mounted, setMounted] = useState(false);
	const [visible, setVisible] = useState(false);
	const sheetRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (open) {
			setMounted(true);
			// Defer a frame so the initial render lands at
			// translateY(100%) before we flip to translateY(0); without
			// the gap the transition has no `from` state and the sheet
			// just pops in.
			const id = requestAnimationFrame(() => setVisible(true));
			return () => cancelAnimationFrame(id);
		}
		if (!mounted) return;
		setVisible(false);
		const t = window.setTimeout(() => setMounted(false), SHEET_TRANSITION_MS);
		return () => window.clearTimeout(t);
	// `mounted` intentionally omitted: we only react to `open`, not to
	// our own cleanup flipping `mounted` false (which would loop).
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// Drag-to-dismiss.  Vertical only; clamp upward drag.  Manipulate the
	// transform imperatively during the gesture for 60fps; commit a CSS
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
				el.style.transform = "translateY(100%)";
				onClose();
			} else {
				el.style.transform = "";
			}
		}
	}, { pointer: { touch: true }, axis: "y" });

	// Lock body scroll while mounted so a drag escaping the sheet's drag
	// region doesn't scroll the chat behind it.
	useEffect(() => {
		if (!mounted) return;
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => { document.body.style.overflow = prev; };
	}, [mounted]);

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
			aria-label={ariaLabel}
		>
			{/* Dimmed scrim.  Opacity transitions alongside the sheet's
			    translate so the two read as one coordinated open. */}
			<div
				className={cn(
					"absolute inset-0 bg-black/50 transition-opacity",
					visible ? "opacity-100" : "opacity-0",
				)}
				style={{ transitionDuration: `${SHEET_TRANSITION_MS}ms` }}
				onClick={onClose}
			/>
			{/* Sheet container.  `overflow-hidden` keeps full-bleed content
			    (tab strips) inside the rounded top corners.  See the file
			    header for the `bottom` / `--keyboard-inset` rationale. */}
			<div
				ref={sheetRef}
				className={cn(
					"absolute left-0 right-0 bg-popover text-popover-foreground",
					"rounded-t-xl shadow-2xl border-t border-border overflow-hidden",
				)}
				style={{
					bottom: "var(--keyboard-inset, 0px)",
					paddingBottom: "max(0px, calc(env(safe-area-inset-bottom) - var(--keyboard-inset, 0px)))",
					transform: visible ? "translateY(0)" : "translateY(100%)",
					transition: `transform ${SHEET_TRANSITION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1), bottom ${SHEET_TRANSITION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
				}}
			>
				{/* Handle strip.  touch-none so the browser doesn't pan the
				    page when the user drags here — useDrag owns it. */}
				<div
					{...dragBind()}
					className="flex justify-center pt-2.5 pb-2 touch-none cursor-grab active:cursor-grabbing"
				>
					<div className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
				</div>
				{children}
			</div>
		</div>,
		document.body,
	);
}

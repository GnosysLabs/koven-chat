// Generic right-click context-menu primitive used across the app.
// One implementation, every right-click surface — replaces the
// hand-rolled MemberContextMenu / MediaContextMenu copies that were
// drifting in subtle ways (z-index, dismiss behaviour, danger
// styling).
//
// Two pieces:
//   - useContextMenu() hook: tracks {x,y} state + returns an
//     onContextMenu handler the caller attaches to their hit area.
//     Plus a `menu` ReactNode the caller splices in alongside.
//   - <ContextMenu> component: portalled to document.body, cursor-
//     positioned, viewport-clamped, dismissed on outside-mousedown
//     / Escape / right-click-elsewhere.
//
// Items support: regular onClick, danger styling, dividers, checked
// indicator (for "Notifications: All / Mentions / Mute" type radio
// groups), submenu (one level deep — covers everything we need).
// Disabled items render in muted text, no hover highlight, no click.

import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { isMobileShell } from "@/lib/mobile";
import { Check, ChevronRight } from "lucide-react";

// Module-level singleton: only one context menu can be open at a time.
// When a new ContextMenu mounts, it closes the previous one directly
// (no events, no effect-timing races with React's batched rendering).
let activeMenuClose: (() => void) | null = null;

// Module-level one-shot click suppressor.  Installed by the dismiss
// handler BEFORE React can unmount the menu (and its listeners).
// Survives component unmount because it lives on `document`, not on
// any React-managed DOM node.  Exported so hand-rolled menus (e.g.
// MemberList) can reuse the same pattern.
export function suppressNextClick() {
	const handler = (e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		document.removeEventListener("click", handler, true);
	};
	document.addEventListener("click", handler, true);
}

// ───────────────────── Item shape ─────────────────────

export type ContextMenuItem =
	| {
		kind?: "item";
		label: string;
		icon?: React.ReactNode;
		// Optional checkmark to the right.  Used by radio-group
		// items (e.g. notification-level picker) where the current
		// value gets a check.
		checked?: boolean;
		// Render in destructive colours (red text + red hover).
		danger?: boolean;
		disabled?: boolean;
		onClick(): void | Promise<void>;
	}
	| {
		kind: "divider";
	}
	| {
		kind: "submenu";
		label: string;
		icon?: React.ReactNode;
		disabled?: boolean;
		items: ContextMenuItem[];
	};

// ───────────────────── Hook ─────────────────────

/**
 * Bind context-menu state to a clickable element.
 *
 * Returns:
 *   - onContextMenu: handler for the React onContextMenu prop.
 *     preventDefault + stopPropagation, captures cursor position.
 *   - menu: ReactNode to splice into the JSX tree.  Resolves to the
 *     portalled <ContextMenu> when open, or null when closed.
 *   - close: imperative dismiss — call this from menu onClick to
 *     close after running the action.
 *
 * `items` may be returned by a callback so the menu can compute the
 * item set lazily based on the latest viewer / target state.  When
 * `items` is empty, the menu is suppressed entirely (no flash of
 * empty popover).
 */
export function useContextMenu(itemsOrFactory: ContextMenuItem[] | (() => ContextMenuItem[])) {
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
	const onContextMenu = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setPos({ x: e.clientX, y: e.clientY });
	}, []);
	const close = useCallback(() => setPos(null), []);
	const items = typeof itemsOrFactory === "function" && pos
		? itemsOrFactory()
		: (Array.isArray(itemsOrFactory) ? itemsOrFactory : []);
	const menu = pos && items.length > 0 ? (
		<ContextMenu x={pos.x} y={pos.y} items={items} onClose={close} />
	) : null;
	return { onContextMenu, menu, close };
}

// ───────────────────── Component ─────────────────────

export interface ContextMenuProps {
	x: number;
	y: number;
	items: ContextMenuItem[];
	onClose(): void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
	const ref = useRef<HTMLDivElement | null>(null);
	const mountedAtRef = useRef(Date.now());
	// Stable ref for onClose so the listener effect never re-runs due
	// to the parent passing a new function identity (inline arrows).
	// Without this, the effect re-ran every render, resetting the
	// 300ms mount guard and making outside-click dismiss unreliable.
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Singleton registration: close any previously open menu before
	// this one paints.  useLayoutEffect runs synchronously after
	// render, before the browser paints, so no flash of two menus.
	// The stable `closer` wrapper lets us track ownership correctly
	// even when `onCloseRef.current` changes identity between renders.
	useLayoutEffect(() => {
		if (activeMenuClose) activeMenuClose();
		const closer = () => onCloseRef.current();
		activeMenuClose = closer;
		return () => {
			if (activeMenuClose === closer) activeMenuClose = null;
		};
	}, []);

	// Outside-mousedown / Escape dismissal.  mousedown (not click) so
	// a fresh right-click on another row closes us BEFORE that row's
	// onContextMenu handler fires.
	//
	// Critical exclusion: submenus are rendered via createPortal to
	// document.body so they're NOT a DOM descendant of the parent
	// menu's ref.  Without the `[data-submenu-portal]` ancestor
	// check, a mousedown on a submenu item is treated as outside-the-
	// menu and the entire context menu closes BEFORE the click event
	// can fire, so the submenu item's onClick handler never runs.
	useEffect(() => {
		mountedAtRef.current = Date.now();
		function isOutside(target: HTMLElement | null) {
			if (!ref.current || !target) return false;
			if (ref.current.contains(target)) return false;
			if (target.closest("[data-submenu-portal]")) return false;
			return true;
		}
		const onDown = (e: MouseEvent) => {
			if (Date.now() - mountedAtRef.current < 300) return;
			if (!isOutside(e.target as HTMLElement | null)) return;
			e.preventDefault();
			e.stopPropagation();
			suppressNextClick();
			onCloseRef.current();
		};
		const onTouch = (e: TouchEvent) => {
			if (Date.now() - mountedAtRef.current < 300) return;
			if (!isOutside(e.target as HTMLElement | null)) return;
			e.preventDefault();
			e.stopPropagation();
			onCloseRef.current();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onCloseRef.current();
		};
		const captureNonPassive = { capture: true, passive: false } as const;
		document.addEventListener("mousedown", onDown, true);
		document.addEventListener("touchstart", onTouch, captureNonPassive);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown, true);
			document.removeEventListener("touchstart", onTouch, captureNonPassive);
			document.removeEventListener("keydown", onKey);
		};
	}, []);

	if (typeof document === "undefined") return null;

	// Cursor clamp.  Estimate menu size to keep it inside the
	// viewport.  Mobile rows are 44pt tall + wider padding so the
	// estimates must scale up there — otherwise the menu can extend
	// off the right or bottom edge of the screen.  Pulled from the
	// MenuRow / SubmenuRow Tailwind classes above.
	const itemHeight = isMobileShell ? 44 : 32;
	const dividerHeight = isMobileShell ? 13 : 9;
	const verticalPadding = isMobileShell ? 12 : 8;
	const estHeight = items.reduce(
		(acc, it) => acc + (it.kind === "divider" ? dividerHeight : itemHeight),
		verticalPadding * 2,
	);
	const menuW = isMobileShell ? 280 : 220;
	const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
	const vh = typeof window !== "undefined" ? window.innerHeight : 800;
	// Math.max(8, ...) clamps the left edge to >=8px so the menu
	// also can't bleed off the LEFT side (e.g. when the user opens
	// it from a short bubble near the left edge).
	const left = Math.max(8, Math.min(x, vw - menuW - 8));
	const top = Math.max(8, Math.min(y, vh - estHeight - 8));

	return createPortal(
		<div
			ref={ref}
			role="menu"
			style={{ position: "fixed", left, top, zIndex: 70 }}
			className={cn(
				"min-w-[13.75rem] rounded-xl border border-border bg-popover text-popover-foreground shadow-md",
				"py-1 text-sm",
			)}
			onContextMenu={(e) => e.preventDefault()}
		>
			{items.map((item, idx) => (
				<MenuRow key={idx} item={item} onCloseRoot={onClose} />
			))}
		</div>,
		document.body,
	);
}

function MenuRow({ item, onCloseRoot }: { item: ContextMenuItem; onCloseRoot(): void }) {
	if (item.kind === "divider") {
		return <div className="my-1 border-t border-border/60" />;
	}
	if (item.kind === "submenu") {
		return <SubmenuRow item={item} onCloseRoot={onCloseRoot} />;
	}
	const disabled = !!item.disabled;
	return (
		<button
			type="button"
			role="menuitem"
			disabled={disabled}
			onClick={async () => {
				if (disabled) return;
				try {
					await item.onClick();
				} catch (err) {
					console.warn("ContextMenu item threw", err);
				}
				onCloseRoot();
			}}
			className={cn(
				"w-full flex items-center gap-2 text-left transition-colors",
				// 44pt min target on mobile (HIG); 32pt rows on
				// desktop where pointer precision is higher.
				isMobileShell ? "min-h-11 px-4 py-2.5 text-[15px]" : "px-3 py-1.5 text-sm",
				disabled
					? "text-muted-foreground/50 cursor-not-allowed"
					: item.danger
						? "text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-none"
						: "hover:bg-accent focus:bg-accent focus:outline-none",
			)}
		>
			<span className={cn(
				"shrink-0 flex items-center justify-center",
				isMobileShell ? "w-5 h-5" : "w-4 h-4",
				disabled ? "text-muted-foreground/40" : (item.danger ? "text-destructive" : "text-muted-foreground"),
			)}>
				{item.icon}
			</span>
			<span className="flex-1 truncate">{item.label}</span>
			{item.checked && (
				<Check className={cn("shrink-0 text-primary", isMobileShell ? "h-4 w-4" : "h-3.5 w-3.5")} />
			)}
		</button>
	);
}

function SubmenuRow({
	item, onCloseRoot,
}: {
	item: Extract<ContextMenuItem, { kind: "submenu" }>;
	onCloseRoot(): void;
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	const [open, setOpen] = useState(false);
	const [submenuPos, setSubmenuPos] = useState<{ left: number; top: number } | null>(null);
	// Intent-delay close timer.  Without this, the parent wrapper's
	// `onMouseLeave` fires the instant the cursor crosses out of its
	// rect — including when the user is moving INTO the submenu,
	// which is portaled to document.body and therefore not a DOM
	// descendant of the wrapper.  The submenu unmounts before the
	// click can land on an item, the user thinks "nothing happened",
	// and the bulk-notify action (and every other submenu action)
	// never fires.  Verified empirically by inspecting nginx logs:
	// zero /api/notify-prefs PUTs from the user's IP across 2000+
	// recent requests despite multiple right-click attempts.
	//
	// Fix: defer setOpen(false) by 120ms; re-enter on either the
	// wrapper OR the portaled submenu cancels it.  120ms is the
	// shortest delay that's invisible to a fast cursor and reliable
	// across trackpad/mouse input.
	const closeTimerRef = useRef<number | null>(null);
	const cancelClose = () => {
		if (closeTimerRef.current !== null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	};
	const scheduleClose = () => {
		cancelClose();
		closeTimerRef.current = window.setTimeout(() => {
			setOpen(false);
			closeTimerRef.current = null;
		}, 120);
	};
	useEffect(() => () => cancelClose(), []);

	const showSubmenu = () => {
		if (item.disabled) return;
		cancelClose();
		const rect = ref.current?.getBoundingClientRect();
		if (!rect) return;
		// Anchor to the right edge; flip to the left when there isn't
		// room.  Width estimate scales with the menu's row sizing
		// (mobile rows are 44pt + wider so the submenu is wider too).
		const submenuW = isMobileShell ? 280 : 220;
		const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
		const vh = typeof window !== "undefined" ? window.innerHeight : 800;
		const flipsLeft = rect.right + submenuW + 8 > vw;
		const rawLeft = flipsLeft ? rect.left - submenuW : rect.right;
		// Hard clamp to viewport on both axes so a submenu opened
		// near the screen edge can never render off-screen.
		const submenuH = item.items.length * (isMobileShell ? 44 : 32) + 16;
		const left = Math.max(8, Math.min(rawLeft, vw - submenuW - 8));
		const top = Math.max(8, Math.min(rect.top, vh - submenuH - 8));
		setSubmenuPos({ left, top });
		setOpen(true);
	};

	return (
		<div
			ref={ref}
			onMouseEnter={showSubmenu}
			onMouseLeave={scheduleClose}
			className="relative"
		>
			<button
				type="button"
				role="menuitem"
				disabled={item.disabled}
				// Click on the trigger ALSO opens the submenu — the
				// hover-only path was unreliable on trackpad gestures
				// and inaccessible to touch input.
				onClick={() => { if (!open) showSubmenu(); }}
				className={cn(
					"w-full flex items-center gap-2 text-left transition-colors",
					isMobileShell ? "min-h-11 px-4 py-2.5 text-[15px]" : "px-3 py-1.5 text-sm",
					item.disabled
						? "text-muted-foreground/50 cursor-not-allowed"
						: "hover:bg-accent focus:bg-accent focus:outline-none",
				)}
			>
				<span className={cn(
					"shrink-0 flex items-center justify-center",
					isMobileShell ? "w-5 h-5" : "w-4 h-4",
					item.disabled ? "text-muted-foreground/40" : "text-muted-foreground",
				)}>
					{item.icon}
				</span>
				<span className="flex-1 truncate">{item.label}</span>
				<ChevronRight className={cn("shrink-0 text-muted-foreground", isMobileShell ? "h-4 w-4" : "h-3.5 w-3.5")} />
			</button>
			{open && submenuPos && createPortal(
				<div
					role="menu"
					// `data-submenu-portal` so the parent ContextMenu's
					// outside-mousedown handler can detect clicks INTO
					// us as inside-the-menu and not slam itself shut
					// before our items' click handlers fire.  See the
					// onDown comment in ContextMenu above.
					data-submenu-portal="true"
					style={{ position: "fixed", left: submenuPos.left, top: submenuPos.top, zIndex: 71 }}
					className={cn(
						"min-w-[13.75rem] rounded-xl border border-border bg-popover text-popover-foreground shadow-md",
						"py-1 text-sm",
					)}
					onContextMenu={(e) => e.preventDefault()}
					onMouseEnter={cancelClose}
					onMouseLeave={scheduleClose}
				>
					{item.items.map((sub, idx) => (
						<MenuRow key={idx} item={sub} onCloseRoot={onCloseRoot} />
					))}
				</div>,
				document.body,
			)}
		</div>
	);
}

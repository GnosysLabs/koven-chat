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
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Check, ChevronRight } from "lucide-react";

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

	// Outside-mousedown / Escape dismissal.  mousedown (not click) so
	// a fresh right-click on another row closes us BEFORE that row's
	// onContextMenu handler fires — otherwise the second open would
	// race the first close and the menu would flicker shut.
	useEffect(() => {
		const onDown = (e: MouseEvent) => {
			if (!ref.current) return;
			if (ref.current.contains(e.target as Node)) return;
			onClose();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [onClose]);

	if (typeof document === "undefined") return null;

	// Cursor clamp.  Estimate menu size to keep it inside the
	// viewport.  Width is roughly fixed at 220px; height grows with
	// item count + dividers.  We over-estimate by 8px on each side
	// so the menu never bleeds past the viewport edge.
	const itemHeight = 32;
	const dividerHeight = 9;
	const verticalPadding = 8;
	const estHeight = items.reduce(
		(acc, it) => acc + (it.kind === "divider" ? dividerHeight : itemHeight),
		verticalPadding * 2,
	);
	const menuW = 220;
	const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
	const vh = typeof window !== "undefined" ? window.innerHeight : 800;
	const left = Math.min(x, vw - menuW - 8);
	const top = Math.min(y, vh - estHeight - 8);

	return createPortal(
		<div
			ref={ref}
			role="menu"
			style={{ position: "fixed", left, top, zIndex: 70 }}
			className={cn(
				"min-w-[13.75rem] rounded-md border border-border bg-popover text-popover-foreground shadow-md",
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
				"w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors",
				disabled
					? "text-muted-foreground/50 cursor-not-allowed"
					: item.danger
						? "text-destructive hover:bg-destructive/10 focus:bg-destructive/10 focus:outline-none"
						: "hover:bg-accent focus:bg-accent focus:outline-none",
			)}
		>
			<span className={cn(
				"shrink-0 w-4 h-4 flex items-center justify-center",
				disabled ? "text-muted-foreground/40" : (item.danger ? "text-destructive" : "text-muted-foreground"),
			)}>
				{item.icon}
			</span>
			<span className="flex-1 truncate">{item.label}</span>
			{item.checked && (
				<Check className="h-3.5 w-3.5 shrink-0 text-primary" />
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

	const showSubmenu = () => {
		if (item.disabled) return;
		const rect = ref.current?.getBoundingClientRect();
		if (!rect) return;
		// Anchor to the right edge; flip to the left when there isn't
		// room.  Uses a generous 220px width estimate matching the
		// parent menu.
		const submenuW = 220;
		const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
		const left = rect.right + submenuW + 8 > vw
			? rect.left - submenuW
			: rect.right;
		setSubmenuPos({ left, top: rect.top });
		setOpen(true);
	};

	return (
		<div
			ref={ref}
			onMouseEnter={showSubmenu}
			onMouseLeave={() => setOpen(false)}
			className="relative"
		>
			<button
				type="button"
				role="menuitem"
				disabled={item.disabled}
				className={cn(
					"w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors",
					item.disabled
						? "text-muted-foreground/50 cursor-not-allowed"
						: "hover:bg-accent focus:bg-accent focus:outline-none",
				)}
			>
				<span className={cn(
					"shrink-0 w-4 h-4 flex items-center justify-center",
					item.disabled ? "text-muted-foreground/40" : "text-muted-foreground",
				)}>
					{item.icon}
				</span>
				<span className="flex-1 truncate">{item.label}</span>
				<ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
			</button>
			{open && submenuPos && createPortal(
				<div
					role="menu"
					style={{ position: "fixed", left: submenuPos.left, top: submenuPos.top, zIndex: 71 }}
					className={cn(
						"min-w-[13.75rem] rounded-md border border-border bg-popover text-popover-foreground shadow-md",
						"py-1 text-sm",
					)}
					onContextMenu={(e) => e.preventDefault()}
					onMouseEnter={() => setOpen(true)}
					onMouseLeave={() => setOpen(false)}
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

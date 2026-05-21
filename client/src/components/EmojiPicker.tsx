// Full-library emoji picker for room / space icons.
//
// Wraps `emoji-mart` (the de-facto React picker) in a Radix Popover
// so the trigger is whatever the caller passes in.  emoji-mart ships
// with the full Unicode CLDR set, native search, categories, skin
// tones, and recently-used tracking.  Theme follows `data-theme.dark`
// on <html> so the picker adapts to Koven's theme variants.
//
// "Remove" is intentionally NOT inside the picker — putting it as
// a footer below emoji-mart (which already takes ~450px) routinely
// pushed the button below the viewport on shorter windows.  Callers
// render a separate Remove button alongside the trigger instead.

import { useEffect, useRef, useState } from "react";
import data from "@emoji-mart/data";
import { Picker } from "emoji-mart";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface EmojiPickerProps {
	value?: string;
	onChange(emoji: string): void;
	trigger: React.ReactNode;
	align?: "start" | "center" | "end";
}

interface EmojiSelection {
	native: string;
	shortcodes?: string;
	id?: string;
}

/** Live-theme hook used by both the popover-wrapped and inline
 * picker variants below.  Watches the documentElement's class /
 * data-theme attributes (Settings → Appearance flips these) so the
 * picker swaps palettes without a remount.
 *
 * Returns both:
 *   - The coarse emoji-mart theme prop ("light" | "dark") so the
 *     picker's internal default tokens are at least the right
 *     polarity.
 *   - A style object with the `--rgb-*` / `--color-*` override
 *     variables emoji-mart reads to recolour its chrome.  These
 *     point at Koven's theme tokens (`--background`, `--foreground`,
 *     `--primary`, `--muted`, `--border`) so the picker reads as
 *     part of Koven, not a generic light/dark Element-style box.
 *
 * `--rgb-*` MUST be a `R, G, B` triplet because emoji-mart wraps
 * them in `rgb()` and `rgba()` (`rgba(var(--em-rgb-color), .65)`).
 * Koven's tokens are HSL, so we let the browser do the conversion
 * via a hidden probe element: set the probe's color to
 * `hsl(<koven-token>)`, read the computed RGB back, parse the
 * three numbers.  Costs one DOM insert per token per theme flip;
 * cheap enough to do synchronously inside useMemo. */
function useEmojiTheme(): { theme: "light" | "dark"; styleVars: React.CSSProperties } {
	const [theme, setTheme] = useState<"light" | "dark">(() => detectDarkTheme() ? "dark" : "light");
	// Re-key when the theme flips OR when Koven's CSS vars change
	// shape underneath us (currently only via class/data-theme on
	// the root, which the observer already covers).
	const [styleVars, setStyleVars] = useState<React.CSSProperties>(() => computeEmojiStyleVars());
	useEffect(() => {
		const root = document.documentElement;
		const observer = new MutationObserver(() => {
			setTheme(detectDarkTheme() ? "dark" : "light");
			setStyleVars(computeEmojiStyleVars());
		});
		observer.observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
		return () => observer.disconnect();
	}, []);
	return { theme, styleVars };
}

/** Build the override-var style block for emoji-mart.  Reads the
 * current values of Koven's HSL tokens, converts them to RGB
 * triplets, and pairs the result with full-color border vars.
 * Returns an empty object server-side (no `document`) so SSR
 * builds don't blow up. */
function computeEmojiStyleVars(): React.CSSProperties {
	if (typeof document === "undefined") return {};
	const bgTriplet = hslVarToRgbTriplet("--background");
	const fgTriplet = hslVarToRgbTriplet("--foreground");
	const primaryTriplet = hslVarToRgbTriplet("--primary");
	const mutedTriplet = hslVarToRgbTriplet("--muted");
	// React's CSSProperties type rejects CSS custom properties by
	// default; cast through Record so we can set them without a
	// per-property `as any`.
	const vars: Record<string, string> = {};
	if (bgTriplet) vars["--rgb-background"] = bgTriplet;
	if (fgTriplet) vars["--rgb-color"] = fgTriplet;
	if (primaryTriplet) vars["--rgb-accent"] = primaryTriplet;
	// Search input gets the muted surface so it stands out from the
	// picker's background the same way Koven's inputs do.
	if (mutedTriplet) vars["--rgb-input"] = mutedTriplet;
	// Borders accept full CSS colors so we can hand emoji-mart the
	// HSL value directly; no triplet conversion needed.
	vars["--color-border"] = "hsl(var(--border))";
	vars["--color-border-over"] = "hsl(var(--border))";
	return vars as React.CSSProperties;
}

/** Convert one of Koven's HSL theme tokens to an "R, G, B" triplet
 * string suitable for emoji-mart's `--rgb-*` override vars.
 * Returns null when the token isn't defined (the picker falls
 * back to its built-in default in that case). */
function hslVarToRgbTriplet(cssVarName: string): string | null {
	const raw = getComputedStyle(document.documentElement)
		.getPropertyValue(cssVarName)
		.trim();
	if (!raw) return null;
	// Probe div: set its color to hsl(<token>), read the browser-
	// computed rgb(...) string back.  Cleaner than a hand-rolled
	// HSL→RGB because we get the exact same rounding the browser
	// would apply on real elements.
	const probe = document.createElement("div");
	probe.style.color = `hsl(${raw})`;
	probe.style.display = "none";
	document.body.appendChild(probe);
	const computed = getComputedStyle(probe).color;
	document.body.removeChild(probe);
	const m = /rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/.exec(computed);
	if (!m) return null;
	return `${Math.round(Number(m[1]))}, ${Math.round(Number(m[2]))}, ${Math.round(Number(m[3]))}`;
}

/** Inline emoji-mart picker without a popover wrapper.  Use this
 * when the caller is already rendering its own popover / dialog /
 * sheet and wants emoji-mart embedded inside.  See `EmojiPicker`
 * for the standalone popover-trigger variant.
 *
 * `onPick` fires with the native unicode glyph (no spritesheet
 * URL, just the codepoint sequence) so callers can drop it
 * straight into chat text, room icons, reaction events, etc. */
export function InlineEmojiPicker({
	value,
	onPick,
}: {
	value?: string;
	onPick(emoji: string): void;
}) {
	const { theme, styleVars } = useEmojiTheme();
	return (
		<div style={styleVars}>
			<EmojiMartWrapper
				theme={theme}
				value={value}
				onPick={(selection) => {
					if (selection?.native) {
						onPick(selection.native);
					}
				}}
			/>
		</div>
	);
}

export function EmojiPicker({ value, onChange, trigger, align = "start" }: EmojiPickerProps) {
	const [open, setOpen] = useState(false);
	const { theme, styleVars } = useEmojiTheme();

	function pick(selection: EmojiSelection) {
		if (selection?.native) {
			onChange(selection.native);
			setOpen(false);
		}
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent
				align={align}
				sideOffset={6}
				// emoji-mart renders its own chrome; drop the
				// PopoverContent's default padding/border so the picker
				// is the entire surface.  The Picker handles its own
				// height + internal scrolling.
				className="p-0 border-0 bg-transparent shadow-none w-auto"
				onCloseAutoFocus={e => e.preventDefault()}
				// Trap wheel + touch inside the picker so the surrounding
				// Dialog doesn't intercept.
				onWheel={e => e.stopPropagation()}
				onTouchMove={e => e.stopPropagation()}
				// Pad collisions so the picker doesn't sit flush against
				// the viewport edge when Radix flips it.
				collisionPadding={16}
			>
				<div style={styleVars}>
					<EmojiMartWrapper theme={theme} value={value} onPick={pick} />
				</div>
			</PopoverContent>
		</Popover>
	);
}

// emoji-mart mounts a single picker DOM tree; mounting + unmounting
// it on every popover open/close is slow.  We render the picker once
// and let Radix toggle visibility via the parent.  emoji-mart accepts
// loose props because its types ship as `any`; we tighten them here.
function EmojiMartWrapper({
	theme, value, onPick,
}: {
	theme: "light" | "dark";
	value?: string;
	onPick(selection: EmojiSelection): void;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const onPickRef = useRef(onPick);
	onPickRef.current = onPick;

	useEffect(() => {
		if (!containerRef.current) return;

		// Clean up any existing children first to avoid double instantiation
		containerRef.current.innerHTML = "";

		const picker = new (Picker as any)({
			data,
			theme,
			set: "native",
			// Hide the preview row at the bottom to save vertical space
			previewPosition: "none",
			skinTonePosition: "search",
			navPosition: "top",
			perLine: 9,
			maxFrequentRows: 2,
			emojiButtonRadius: "6px",
			autoFocus: true,
			dynamicWidth: false,
			onEmojiSelect: (selection: any) => {
				if (selection) {
					onPickRef.current(selection);
				}
			},
		});

		containerRef.current.appendChild(picker as unknown as Node);

		return () => {
			if (containerRef.current) {
				containerRef.current.innerHTML = "";
			}
		};
	}, [theme]);

	// Prevent click propagation outside the picker so parent popovers
	// or sheets do not interpret clicks inside the picker as outside clicks
	// and close prematurely or block interaction.
	const stopProp = (e: React.SyntheticEvent | Event) => {
		e.stopPropagation();
	};

	return (
		<div
			ref={containerRef}
			className="emoji-mart-host"
			onClick={stopProp}
			onMouseDown={stopProp}
			onPointerDown={stopProp}
			onTouchStart={stopProp}
		>
			{value && (
				<input type="hidden" data-current-emoji={value} />
			)}
		</div>
	);
}

function detectDarkTheme(): boolean {
	if (typeof document === "undefined") return false;
	return document.documentElement.classList.contains("dark");
}

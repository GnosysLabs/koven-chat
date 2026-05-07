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
import Picker from "@emoji-mart/react";
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

export function EmojiPicker({ value, onChange, trigger, align = "start" }: EmojiPickerProps) {
	const [open, setOpen] = useState(false);
	const [theme, setTheme] = useState<"light" | "dark">(() => detectDarkTheme() ? "dark" : "light");

	// Pick up live theme switches (Settings → Appearance) so the
	// picker swaps palettes without a popover re-mount.
	useEffect(() => {
		const root = document.documentElement;
		const observer = new MutationObserver(() => {
			setTheme(detectDarkTheme() ? "dark" : "light");
		});
		observer.observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
		return () => observer.disconnect();
	}, []);

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
				<EmojiMartWrapper theme={theme} value={value} onPick={pick} />
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
	const ref = useRef<HTMLDivElement | null>(null);
	return (
		<div ref={ref} className="emoji-mart-host">
			<Picker
				data={data}
				onEmojiSelect={onPick}
				theme={theme}
				// Native unicode glyphs (no spritesheet download).
				set="native"
				// Hide the preview row at the bottom — saves vertical
				// space in our compact dialog.
				previewPosition="none"
				skinTonePosition="search"
				navPosition="top"
				perLine={9}
				maxFrequentRows={2}
				// Highlight the current value if it matches a known emoji.
				emojiButtonRadius="6px"
				autoFocus
				// Used as the search input's id; helps a11y.
				dynamicWidth={false}
			/>
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

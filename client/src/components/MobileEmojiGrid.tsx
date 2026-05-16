// Discord-style emoji picker for the mobile reaction sheet.
//
// Replaces emoji-mart's cramped chrome (tiny category SVGs, a search
// field that autofocuses and yanks the keyboard up over half the
// picker) with a layout shaped like Discord's reaction sheet:
//
//   - A search field at the top that does NOT autofocus, so the
//     keyboard stays down until the user deliberately taps it.  This
//     is the single biggest fix: emoji-mart's `autoFocus` was opening
//     the keyboard on every reaction and covering the grid.
//   - A scrollable body of sectioned emoji with sticky headers,
//     8 large touch targets per row.
//   - A category jump bar pinned at the bottom; tapping a category
//     scrolls its section to the top, and scrolling highlights the
//     category currently in view.
//
// Frequently-used history is read from and written to the SAME
// localStorage store emoji-mart uses (`emoji-mart.frequently`, a
// `{ id: count }` map, plus `emoji-mart.last`).  Sharing the store
// means the desktop emoji-mart picker and this mobile grid stay in
// sync instead of keeping divergent histories.

import { useEffect, useMemo, useRef, useState } from "react";
import { Clock, Search, X } from "lucide-react";
import emojiData from "@emoji-mart/data";
import { hapticSelection } from "@/lib/haptics";
import { cn } from "@/lib/utils";

interface RawEmoji {
	id: string;
	name: string;
	keywords: string[];
	skins: { native: string }[];
}
interface RawCategory {
	id: string;
	emojis: string[];
}
interface EmojiData {
	categories: RawCategory[];
	emojis: Record<string, RawEmoji>;
}

const data = emojiData as unknown as EmojiData;

interface Emoji {
	id: string;
	native: string;
	name: string;
	search: string;
}

interface Section {
	id: string;
	label: string;
	icon: string;
	emojis: Emoji[];
}

// Display labels + jump-bar glyphs for the eight CLDR top-level
// categories.  Order matches `data.categories`.
const CATEGORY_META: Record<string, { label: string; icon: string }> = {
	people: { label: "Smileys & People", icon: "\u{1F600}" },
	nature: { label: "Animals & Nature", icon: "\u{1F43B}" },
	foods: { label: "Food & Drink", icon: "\u{1F354}" },
	activity: { label: "Activity", icon: "⚽" },
	places: { label: "Travel & Places", icon: "✈️" },
	objects: { label: "Objects", icon: "\u{1F4A1}" },
	symbols: { label: "Symbols", icon: "❤️" },
	flags: { label: "Flags", icon: "\u{1F3F3}️" },
};

const FREQUENT_KEY = "emoji-mart.frequently";
const LAST_KEY = "emoji-mart.last";
// 3 rows of 8 — same shape emoji-mart used (maxFrequentRows 2-3).
const FREQUENT_MAX = 24;

function readFrequentIds(): string[] {
	try {
		const raw = window.localStorage[FREQUENT_KEY];
		if (!raw) return [];
		const counts = JSON.parse(raw) as Record<string, number>;
		return Object.keys(counts)
			.sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0) || a.localeCompare(b))
			.slice(0, FREQUENT_MAX);
	} catch {
		return [];
	}
}

// Mirror emoji-mart's `add()`: bump the id's count and record it as
// `last` so both pickers agree on recency.
function recordFrequent(id: string) {
	try {
		const raw = window.localStorage[FREQUENT_KEY];
		const counts = raw ? (JSON.parse(raw) as Record<string, number>) : {};
		counts[id] = (counts[id] ?? 0) + 1;
		window.localStorage[FREQUENT_KEY] = JSON.stringify(counts);
		window.localStorage[LAST_KEY] = JSON.stringify(id);
	} catch {
		// localStorage unavailable (private mode / disabled) — history
		// is a nicety, not load-bearing.  Silently skip.
	}
}

function toEmoji(id: string): Emoji | null {
	const raw = data.emojis[id];
	const native = raw?.skins?.[0]?.native;
	if (!raw || !native) return null;
	return {
		id,
		native,
		name: raw.name,
		search: `${id} ${raw.name} ${raw.keywords.join(" ")}`.toLowerCase(),
	};
}

export interface MobileEmojiGridProps {
	onPick(emoji: string): void;
}

export function MobileEmojiGrid({ onPick }: MobileEmojiGridProps) {
	const [query, setQuery] = useState("");
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);

	// Build the category sections once.  `data` is a static import so
	// this never changes for the life of the component.
	const categorySections = useMemo<Section[]>(() => {
		return data.categories
			.map((cat) => {
				const meta = CATEGORY_META[cat.id];
				if (!meta) return null;
				const emojis = cat.emojis
					.map(toEmoji)
					.filter((e): e is Emoji => e !== null);
				return { id: cat.id, label: meta.label, icon: meta.icon, emojis };
			})
			.filter((s): s is Section => s !== null);
	}, []);

	// Frequently-used is read once on mount.  It only changes when the
	// user picks something — at which point the sheet closes — so a
	// snapshot is correct for the sheet's lifetime.
	const frequentSection = useMemo<Section | null>(() => {
		const emojis = readFrequentIds()
			.map(toEmoji)
			.filter((e): e is Emoji => e !== null);
		if (!emojis.length) return null;
		return { id: "frequent", label: "Frequently Used", icon: "", emojis };
	}, []);

	const sections = useMemo<Section[]>(
		() => (frequentSection ? [frequentSection, ...categorySections] : categorySections),
		[frequentSection, categorySections],
	);

	// Flat dataset for search.  De-duped by native glyph so the same
	// emoji surfaced under multiple ids doesn't show twice.
	const allEmojis = useMemo<Emoji[]>(() => {
		const seen = new Set<string>();
		const out: Emoji[] = [];
		for (const cat of categorySections) {
			for (const e of cat.emojis) {
				if (seen.has(e.native)) continue;
				seen.add(e.native);
				out.push(e);
			}
		}
		return out;
	}, [categorySections]);

	const trimmed = query.trim().toLowerCase();
	const results = useMemo<Emoji[]>(() => {
		if (!trimmed) return [];
		const terms = trimmed.split(/\s+/);
		return allEmojis.filter((e) => terms.every((t) => e.search.includes(t)));
	}, [trimmed, allEmojis]);

	// Jump-bar tabs: a clock for frequently-used, then one per
	// category.  `key` matches the section id used as the scroll
	// anchor's `data-cat` attribute.
	const tabs = useMemo(
		() =>
			sections.map((s) => ({
				key: s.id,
				icon: s.id === "frequent" ? null : s.icon,
				clock: s.id === "frequent",
				label: s.label,
			})),
		[sections],
	);

	const [activeTab, setActiveTab] = useState<string>(sections[0]?.id ?? "people");

	// Highlight the category currently scrolled into view.  Finds the
	// last section header whose top has crossed the scroll container's
	// top edge.
	function handleScroll() {
		const container = scrollRef.current;
		if (!container) return;
		const top = container.scrollTop;
		let current = sections[0]?.id ?? "";
		for (const s of sections) {
			const node = container.querySelector<HTMLElement>(`[data-cat="${s.id}"]`);
			if (node && node.offsetTop - 4 <= top) current = s.id;
		}
		setActiveTab((prev) => (prev === current ? prev : current));
	}

	function jumpTo(id: string) {
		const container = scrollRef.current;
		const node = container?.querySelector<HTMLElement>(`[data-cat="${id}"]`);
		if (!container || !node) return;
		container.scrollTo({ top: node.offsetTop, behavior: "auto" });
		setActiveTab(id);
		void hapticSelection();
	}

	function pick(e: Emoji) {
		recordFrequent(e.id);
		void hapticSelection();
		onPick(e.native);
	}

	// Reset scroll to the top whenever a search starts or clears so the
	// user never lands mid-list with stale scroll position.
	useEffect(() => {
		scrollRef.current?.scrollTo({ top: 0 });
	}, [trimmed]);

	const searching = trimmed.length > 0;

	return (
		<div className="flex w-full flex-col">
			{/* Search field.  No autoFocus — the keyboard stays down until
			    the user taps in, which is the whole point of the redesign. */}
			<div className="px-3 pb-2">
				<div className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2.5">
					<Search className="h-4 w-4 shrink-0 text-muted-foreground" />
					<input
						ref={inputRef}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Find the perfect reaction"
						inputMode="search"
						enterKeyHint="search"
						autoCapitalize="none"
						autoCorrect="off"
						spellCheck={false}
						className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
					/>
					{query && (
						<button
							type="button"
							aria-label="Clear search"
							onClick={() => {
								setQuery("");
								inputRef.current?.focus();
							}}
							className="shrink-0 text-muted-foreground"
						>
							<X className="h-4 w-4" />
						</button>
					)}
				</div>
			</div>

			{/* Scrollable emoji body.  Fixed height keeps the jump bar and
			    search anchored; `relative` makes child offsetTop values
			    measured against this container for `jumpTo`. */}
			<div
				ref={scrollRef}
				onScroll={searching ? undefined : handleScroll}
				className="relative h-[300px] overflow-y-auto overscroll-contain px-2"
			>
				{searching ? (
					results.length ? (
						<EmojiCells emojis={results} onPick={pick} />
					) : (
						<div className="flex h-full flex-col items-center justify-center gap-1 text-center">
							<span className="text-2xl">{"\u{1F50D}"}</span>
							<span className="text-sm text-muted-foreground">
								No emoji match "{query.trim()}"
							</span>
						</div>
					)
				) : (
					sections.map((section) => (
						<div key={section.id} data-cat={section.id}>
							<div className="sticky top-0 z-10 bg-popover px-1 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
								{section.label}
							</div>
							<EmojiCells emojis={section.emojis} onPick={pick} />
						</div>
					))
				)}
			</div>

			{/* Category jump bar.  Hidden while searching — there are no
			    sections to jump to in the flat result list. */}
			{!searching && (
				<div className="flex items-center justify-between gap-0.5 border-t border-border px-2 pt-1.5">
					{tabs.map((tab) => (
						<button
							key={tab.key}
							type="button"
							aria-label={tab.label}
							onClick={() => jumpTo(tab.key)}
							className={cn(
								"flex h-9 flex-1 items-center justify-center rounded-lg text-lg transition-colors",
								activeTab === tab.key
									? "bg-accent text-accent-foreground"
									: "text-muted-foreground active:bg-accent/50",
							)}
						>
							{tab.clock ? <Clock className="h-[18px] w-[18px]" /> : tab.icon}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

// One emoji grid: 8 large touch targets per row.  Pulled out so the
// search-results list and each category section render identically.
function EmojiCells({
	emojis,
	onPick,
}: {
	emojis: Emoji[];
	onPick(e: Emoji): void;
}) {
	return (
		<div className="grid grid-cols-8 gap-0.5">
			{emojis.map((e) => (
				<button
					key={e.id}
					type="button"
					aria-label={e.name}
					onClick={() => onPick(e)}
					className="flex aspect-square items-center justify-center rounded-lg text-[26px] leading-none active:bg-accent"
				>
					{e.native}
				</button>
			))}
		</div>
	);
}

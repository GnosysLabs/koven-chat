// Discord-style media picker — opens from the composer's media button.
// Three tabs: GIFs / Clips / Stickers, all powered by Klipy.
// Trending on first open of each tab, then live-search as the user
// types.  Clicking a result fetches the full-resolution media from
// Klipy's CDN and hands it to the parent as a File so the existing
// attachment pipeline can upload + send it.
//
// Network behaviour:
//   - One trending request per tab when first activated (cached for
//     the life of the popover; closing + reopening refetches).
//   - One search request 250 ms after the user stops typing, scoped
//     to the active tab.  Cancelled if a newer keystroke arrives.
//   - One CDN fetch when the user clicks a result.
//
// Visibility:
//   - Picker only renders when integrations.klipy.configured is true,
//     gated upstream in ChatPane.

import { useEffect, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
	fetchKlipyBlob,
	klipySearch,
	klipyTrending,
	type KlipyResult,
	type MediaKind,
} from "@/lib/klipy";

interface MediaPickerProps {
	accessToken: string;
	disabled?: boolean;
	/** Fired with a File ready for the existing attachment pipeline.
	 * Mime type on the File drives downstream behaviour:
	 * image/gif and image/webp render as inline images (m.image);
	 * video/mp4 renders with the inline video player (m.video). */
	onPick(file: File): void | Promise<void>;
	/** Trigger button — the composer renders its own icon button. */
	children: React.ReactNode;
}

const TABS: { kind: MediaKind; label: string }[] = [
	{ kind: "gif", label: "GIFs" },
	{ kind: "clip", label: "Clips" },
	{ kind: "sticker", label: "Stickers" },
];

export function MediaPicker({ accessToken, disabled, onPick, children }: MediaPickerProps) {
	const [open, setOpen] = useState(false);
	const [activeKind, setActiveKind] = useState<MediaKind>("gif");
	const [query, setQuery] = useState("");
	// Per-kind result cache: switching tabs shouldn't blow away what we
	// already fetched for the previous tab.  Re-opening the popover
	// resets the cache (effect below).
	const [resultsByKind, setResultsByKind] = useState<Record<MediaKind, KlipyResult[]>>({
		gif: [],
		clip: [],
		sticker: [],
	});
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pickingId, setPickingId] = useState<string | null>(null);
	// Token to discard responses from stale searches — every kind/query
	// change bumps it; on response we compare and drop if a newer
	// search has kicked off since.
	const requestIdRef = useRef(0);

	const results = resultsByKind[activeKind];

	// Reset everything when the popover opens.  Trending fetch for the
	// active tab fires from the debounced effect below.
	useEffect(() => {
		if (!open) return;
		setActiveKind("gif");
		setQuery("");
		setResultsByKind({ gif: [], clip: [], sticker: [] });
		setError(null);
	}, [open]);

	// Debounced fetch keyed on (activeKind, query, open).  Empty query
	// loads trending for the active kind; non-empty hits search.
	useEffect(() => {
		if (!open) return;
		const id = ++requestIdRef.current;
		const handle = setTimeout(() => {
			setLoading(true);
			setError(null);
			const fetcher = query.trim()
				? klipySearch(accessToken, activeKind, query.trim(), { limit: 24 })
				: klipyTrending(accessToken, activeKind, { limit: 24 });
			fetcher
				.then(rs => {
					if (requestIdRef.current !== id) return;
					setResultsByKind(prev => ({ ...prev, [activeKind]: rs }));
				})
				.catch(err => {
					if (requestIdRef.current !== id) return;
					setError(err instanceof Error ? err.message : String(err));
				})
				.finally(() => {
					if (requestIdRef.current !== id) return;
					setLoading(false);
				});
		}, 250);
		return () => clearTimeout(handle);
	}, [activeKind, query, open, accessToken]);

	async function pick(result: KlipyResult) {
		setPickingId(result.id);
		setError(null);
		try {
			const file = await fetchKlipyBlob(result);
			await onPick(file);
			setOpen(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPickingId(null);
		}
	}

	const placeholderForKind = (kind: MediaKind) =>
		kind === "gif" ? "Search GIFs"
		: kind === "clip" ? "Search clips"
		: "Search stickers";

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild disabled={disabled}>
				{children}
			</PopoverTrigger>
			<PopoverContent
				side="top"
				align="start"
				className="p-0 w-[360px] max-w-[calc(100vw-1rem)] overflow-hidden"
				onOpenAutoFocus={(e) => {
					// Keep focus on the search input — Radix's default
					// focus-first-tabbable lands on the first tile
					// otherwise, which is jarring.
					e.preventDefault();
				}}
			>
				{/* Tab strip.  Switching kinds resets the visible result
				    cell from the per-kind cache; the debounced fetch
				    effect repopulates it for the new kind. */}
				<div className="flex border-b border-border bg-muted/30">
					{TABS.map(tab => (
						<button
							key={tab.kind}
							type="button"
							onClick={() => setActiveKind(tab.kind)}
							className={cn(
								"flex-1 px-3 py-2 text-xs font-medium transition-colors",
								tab.kind === activeKind
									? "text-foreground bg-background border-b-2 border-primary -mb-px"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{tab.label}
						</button>
					))}
				</div>

				<div className="p-2 border-b border-border">
					<div className="relative">
						<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
						<Input
							autoFocus
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder={placeholderForKind(activeKind)}
							className="pl-8 h-9"
						/>
						{query && (
							<button
								type="button"
								onClick={() => setQuery("")}
								className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
								aria-label="Clear search"
							>
								<X className="h-3.5 w-3.5" />
							</button>
						)}
					</div>
				</div>

				<div className="h-[320px] overflow-y-auto p-1.5">
					{error ? (
						<div className="px-3 py-6 text-xs text-destructive text-center">
							{error}
						</div>
					) : loading && results.length === 0 ? (
						<div className="flex items-center justify-center h-full text-muted-foreground">
							<Loader2 className="h-5 w-5 animate-spin" />
						</div>
					) : results.length === 0 ? (
						<div className="px-3 py-6 text-xs text-muted-foreground text-center">
							No results
						</div>
					) : (
						<div className="grid grid-cols-2 gap-1.5">
							{results.map(r => (
								<button
									key={r.id}
									type="button"
									onClick={() => void pick(r)}
									disabled={pickingId !== null}
									className={cn(
										"relative rounded overflow-hidden bg-muted/40 transition-opacity",
										"hover:ring-2 hover:ring-primary/60",
										pickingId === r.id && "opacity-60",
										pickingId !== null && pickingId !== r.id && "opacity-40 pointer-events-none",
									)}
									title={r.title}
									style={
										// Use Klipy's inline blur as a background
										// while the real preview decodes; avoids
										// a flash of empty muted box on a
										// 24-tile grid that's all decoding
										// in parallel.
										r.preview_blur
											? { backgroundImage: `url(${r.preview_blur})`, backgroundSize: "cover" }
											: undefined
									}
								>
									<img
										src={r.preview_url}
										alt={r.title}
										loading="lazy"
										className="w-full h-auto block"
									/>
									{pickingId === r.id && (
										<div className="absolute inset-0 flex items-center justify-center bg-background/40">
											<Loader2 className="h-5 w-5 animate-spin" />
										</div>
									)}
								</button>
							))}
						</div>
					)}
				</div>

				{/* Required attribution per Klipy's terms.  Shown
				    verbatim wherever results are displayed. */}
				<div className="px-2 py-1.5 border-t border-border flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
					<a
						href="https://klipy.com"
						target="_blank"
						rel="noreferrer"
						className="hover:text-foreground transition-colors"
					>
						Powered by KLIPY
					</a>
					<span>{loading && results.length > 0 ? "Updating…" : ""}</span>
				</div>
			</PopoverContent>
		</Popover>
	);
}

// Discord-style Giphy picker — opens from the composer's GIF button.
// Trending on first open, then live-search as the admin types.  Clicking
// a result fetches the original-resolution GIF from Giphy's CDN and
// hands it to the parent as a File so the existing attachment pipeline
// can upload + send it.
//
// Network behaviour:
//   - One trending request when the popover first opens (cached for the
//     life of the popover; closing + reopening refetches).
//   - One search request 250 ms after the user stops typing, cancelled
//     if a newer keystroke arrives.
//   - One CDN fetch when the user clicks a result.
//
// Visibility:
//   - Picker only renders when integrations.giphy.configured is true,
//     gated upstream in ChatPane.

import { useEffect, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fetchGiphyBlob, giphySearch, giphyTrending, type GiphyResult } from "@/lib/giphy";

interface GifPickerProps {
	accessToken: string;
	disabled?: boolean;
	/** Fired with a File ready for the existing attachment pipeline. */
	onPick(file: File): void | Promise<void>;
	/** Trigger button — defaults to the "GIF" pill but callers can pass a
	 * custom trigger (the composer renders its own icon button). */
	children: React.ReactNode;
}

export function GifPicker({ accessToken, disabled, onPick, children }: GifPickerProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<GiphyResult[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pickingId, setPickingId] = useState<string | null>(null);
	// Token to discard responses from stale searches — every keystroke
	// bumps it; on response we compare and drop if a newer search has
	// kicked off since.
	const requestIdRef = useRef(0);

	// Trending on open; clear state on close.
	useEffect(() => {
		if (!open) return;
		const id = ++requestIdRef.current;
		setLoading(true);
		setError(null);
		setQuery("");
		giphyTrending(accessToken, { limit: 24 })
			.then(rs => {
				if (requestIdRef.current !== id) return;
				setResults(rs);
			})
			.catch(err => {
				if (requestIdRef.current !== id) return;
				setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (requestIdRef.current !== id) return;
				setLoading(false);
			});
	}, [open, accessToken]);

	// Debounced search.  Empty query reloads trending so the grid
	// always has content.
	useEffect(() => {
		if (!open) return;
		const id = ++requestIdRef.current;
		const handle = setTimeout(() => {
			setLoading(true);
			setError(null);
			const fetcher = query.trim()
				? giphySearch(accessToken, query.trim(), { limit: 24 })
				: giphyTrending(accessToken, { limit: 24 });
			fetcher
				.then(rs => {
					if (requestIdRef.current !== id) return;
					setResults(rs);
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
	}, [query, open, accessToken]);

	async function pick(result: GiphyResult) {
		setPickingId(result.id);
		setError(null);
		try {
			const file = await fetchGiphyBlob(result);
			await onPick(file);
			setOpen(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPickingId(null);
		}
	}

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
					// focus-first-tabbable lands on the first GIF button
					// otherwise, which is jarring.
					e.preventDefault();
				}}
			>
				<div className="p-2 border-b border-border">
					<div className="relative">
						<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
						<Input
							autoFocus
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search GIPHY"
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

				{/* Required GIPHY attribution mark — shown verbatim per
				    Giphy's brand guidelines (dark version on dark
				    themes, light version on light themes).  Production
				    API approval requires a visible "Powered by GIPHY"
				    mark wherever results are displayed. */}
				<div className="px-2 py-1.5 border-t border-border flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
					<a
						href="https://giphy.com"
						target="_blank"
						rel="noreferrer"
						aria-label="Powered by GIPHY"
						className="flex items-center"
					>
						<img
							src="/giphy/poweredby-on-dark.png"
							alt="Powered by GIPHY"
							className="h-4 w-auto hidden dark:block"
						/>
						<img
							src="/giphy/poweredby-on-light.png"
							alt="Powered by GIPHY"
							className="h-4 w-auto dark:hidden"
						/>
					</a>
					<span>{loading && results.length > 0 ? "Updating…" : ""}</span>
				</div>
			</PopoverContent>
		</Popover>
	);
}

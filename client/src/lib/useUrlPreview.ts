// React hook around the transport's previewUrl.  Caches per-URL via
// the matrix-js-sdk's own preview cache, but de-bounces React-side
// re-fetches on identity equality.  Returns the preview once Synapse
// resolves it, or null while loading / on failure.

import { useEffect, useState } from "react";
import { useTransport } from "@/lib/transportContext";
import type { UrlPreview } from "@/lib/matrix";

export function useUrlPreview(url: string | null): UrlPreview | null {
	const transport = useTransport();
	const [preview, setPreview] = useState<UrlPreview | null>(null);

	useEffect(() => {
		setPreview(null);
		if (!url || !transport) return;
		let cancelled = false;
		transport.previewUrl(url)
			.then(p => { if (!cancelled) setPreview(p); })
			.catch(() => { if (!cancelled) setPreview(null); });
		return () => { cancelled = true; };
	}, [url, transport]);

	return preview;
}

// First http(s) URL in a chunk of message text, or null if none.
// Mirrors the convention most chat clients use — only the first
// link gets a preview card, otherwise a wall of links would stack a
// wall of cards beneath the bubble.  Excludes trailing punctuation
// that's almost certainly not part of the URL ([)],.;:!?"'>]).
export function extractFirstUrl(text: string): string | null {
	const match = text.match(/https?:\/\/[^\s<>]+/);
	if (!match) return null;
	let url = match[0];
	// Trim trailing punctuation that's likely sentence-final, not URL.
	url = url.replace(/[),.;:!?"'>\]]+$/, "");
	// Balance unmatched closing parens (common in Wikipedia URLs).
	const opens = (url.match(/\(/g) ?? []).length;
	const closes = (url.match(/\)/g) ?? []).length;
	if (closes > opens) {
		url = url.replace(/\)+$/, "");
	}
	return url || null;
}

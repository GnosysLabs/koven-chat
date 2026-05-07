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


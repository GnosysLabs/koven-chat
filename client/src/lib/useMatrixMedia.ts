// React hook: convert an mxc:// URL into a renderable blob: URL by way
// of the transport's authenticated-media fetch + cache.  Returns
// `undefined` while the fetch is in flight or when no mxc was given,
// so callers can render a placeholder/auto-avatar in the meantime.
//
// On mount we synchronously peek the transport's resolved-media map
// before kicking off the async fetch — that way an mxc the transport
// has already loaded shows up on the very first render, no flash.

import { useEffect, useState } from "react";
import { useTransport } from "@/lib/transportContext";

export function useMatrixMedia(mxc: string | undefined): string | undefined {
	const transport = useTransport();
	const [url, setUrl] = useState<string | undefined>(() =>
		mxc && transport ? transport.peekMxcBlobUrl(mxc) : undefined,
	);

	useEffect(() => {
		if (!mxc || !transport) {
			setUrl(undefined);
			return;
		}
		// Re-seed from the sync cache when the mxc changes — covers
		// avatar swaps (e.g. user picks a new profile picture) where
		// the new value might already be resolved.
		const cached = transport.peekMxcBlobUrl(mxc);
		if (cached) {
			setUrl(cached);
			return;
		}
		setUrl(undefined);
		let cancelled = false;
		transport.getMxcBlobUrl(mxc)
			.then(blob => { if (!cancelled) setUrl(blob); })
			.catch(() => { if (!cancelled) setUrl(undefined); });
		return () => { cancelled = true; };
	}, [mxc, transport]);

	return url;
}

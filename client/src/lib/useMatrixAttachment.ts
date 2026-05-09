// React hook: turn a Message's media payload into a renderable
// blob: URL.  Wraps the transport's getAttachmentBlobUrl so we get
// authenticated fetch + (when needed) AES-CTR decryption with a
// shared cache.  The cache is keyed by mxc, so multiple components
// rendering the same attachment share one fetch + decrypt.
//
// Returns undefined while in flight or before the message has any
// media — callers can render a small spinner / placeholder during
// that window.

import { useEffect, useState } from "react";
import { useTransport } from "@/lib/transportContext";
import type { Message } from "@koven/shared";

export function useMatrixAttachment(message: Pick<Message, "mediaMxc" | "mediaMimeType" | "mediaEncrypted">): string | undefined {
	const transport = useTransport();
	const mxc = message.mediaMxc;
	const [url, setUrl] = useState<string | undefined>(() =>
		mxc && transport ? transport.peekMxcBlobUrl(mxc) : undefined,
	);

	useEffect(() => {
		if (!mxc || !transport) {
			setUrl(undefined);
			return;
		}
		const cached = transport.peekMxcBlobUrl(mxc);
		if (cached) {
			setUrl(cached);
			return;
		}
		setUrl(undefined);
		let cancelled = false;
		transport.getAttachmentBlobUrl({
			mxc,
			mimeType: message.mediaMimeType,
			encrypted: message.mediaEncrypted,
		})
			.then(blob => { if (!cancelled) setUrl(blob); })
			.catch(() => { if (!cancelled) setUrl(undefined); });
		return () => { cancelled = true; };
	}, [mxc, message.mediaMimeType, message.mediaEncrypted, transport]);

	return url;
}

/** Fetch the poster thumbnail mxc on a video message and return its
 * blob: URL (or undefined while loading / when the message has no
 * thumbnail).  Same fetch + decrypt + cache plumbing as
 * useMatrixAttachment, but reads the mediaThumb* fields instead of
 * the main media fields.
 *
 * For video messages without an embedded thumbnail (anything sent
 * before the upload pipeline started attaching one, or non-Koven
 * senders that skipped it), this returns undefined and the renderer
 * should fall back to the legacy `<video preload="metadata">`
 * approach. */
export function useMatrixVideoPoster(message: Pick<Message, "mediaThumbMxc" | "mediaThumbMimeType" | "mediaThumbEncrypted">): string | undefined {
	const transport = useTransport();
	const mxc = message.mediaThumbMxc;
	const [url, setUrl] = useState<string | undefined>(() =>
		mxc && transport ? transport.peekMxcBlobUrl(mxc) : undefined,
	);

	useEffect(() => {
		if (!mxc || !transport) {
			setUrl(undefined);
			return;
		}
		const cached = transport.peekMxcBlobUrl(mxc);
		if (cached) {
			setUrl(cached);
			return;
		}
		setUrl(undefined);
		let cancelled = false;
		transport.getAttachmentBlobUrl({
			mxc,
			mimeType: message.mediaThumbMimeType,
			encrypted: message.mediaThumbEncrypted,
		})
			.then(blob => { if (!cancelled) setUrl(blob); })
			.catch(() => { if (!cancelled) setUrl(undefined); });
		return () => { cancelled = true; };
	}, [mxc, message.mediaThumbMimeType, message.mediaThumbEncrypted, transport]);

	return url;
}

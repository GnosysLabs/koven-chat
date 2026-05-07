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

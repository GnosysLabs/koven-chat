// Typed client for the engine's Klipy proxy.  The engine holds the
// instance-wide API key and forwards search / trending requests to
// Klipy on behalf of the user; the SPA never sees the key.
//
// Klipy is a multi-format media service: the same endpoint shape
// works for GIFs, animated stickers (transparent webp), and short
// video clips (mp4).  The engine reshapes Klipy's nested response
// down to the flat fields the SPA actually renders.  See
// engine/src/server.ts → /api/klipy/* for the upstream shape.

import { ENGINE_URL } from "@/lib/urls";

export type MediaKind = "gif" | "sticker" | "clip";

export interface KlipyResult {
	id: string;
	/** Klipy's `type` field; mirrors the requested kind. */
	kind: MediaKind;
	title: string;
	/** Lower-resolution thumbnail used in the picker grid.  ~220px wide. */
	preview_url: string;
	/** Inline base64 blur placeholder Klipy returns alongside every result.
	 * Use as the background-image while the real preview decodes. */
	preview_blur: string | null;
	/** Full-resolution media URL used when the user picks one to send.
	 * For gifs: an animated .gif.  For stickers: a transparent .webp.
	 * For clips: an .mp4. */
	full_url: string;
	/** Alternate URLs at the same tier when Klipy returns them.  Lets
	 * the bubble renderer pick the format that fits its surface
	 * without re-querying. */
	full_mp4_url: string | null;
	full_webp_url: string | null;
	width: number;
	height: number;
	/** MIME type matching `full_url`: `image/gif`, `image/webp`, or
	 * `video/mp4`.  Drives the File.type on upload so Synapse + the
	 * timeline renderer pick the right msgtype (m.image vs m.video). */
	mime_type: string;
}

interface KlipyResponse {
	results: KlipyResult[];
}

interface KlipyError {
	errcode?: string;
	error?: string;
	/** Forwarded body from Klipy's response when the upstream call
	 * fails.  Surfaced in the picker's error toast so the admin can
	 * act without checking server logs. */
	detail?: string;
}

/** True when the engine reports Klipy is configured for this
 * instance.  Used by the SPA to hide the media picker on instances
 * without a key. */
export interface IntegrationsStatus {
	klipy: { configured: boolean };
	/** True only when BOTH the public site key and the secret key are
	 * set, neither half on its own is usable. */
	turnstile?: { configured: boolean };
}

export async function fetchIntegrationsStatus(accessToken: string): Promise<IntegrationsStatus> {
	const r = await fetch(`${ENGINE_URL}/api/instance/integrations`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) throw new Error(`integrations: ${r.status}`);
	const body = (await r.json()) as { integrations: IntegrationsStatus };
	return body.integrations;
}

/** Throws on 503 (`klipy_not_configured`) and on network failure.
 * The picker treats both as "Klipy is unavailable, hide the picker". */
export async function klipyTrending(
	accessToken: string,
	kind: MediaKind,
	opts: { limit?: number } = {},
): Promise<KlipyResult[]> {
	return klipyFetch(accessToken, "trending", kind, { limit: opts.limit });
}

export async function klipySearch(
	accessToken: string,
	kind: MediaKind,
	query: string,
	opts: { limit?: number } = {},
): Promise<KlipyResult[]> {
	return klipyFetch(accessToken, "search", kind, { q: query, limit: opts.limit });
}

async function klipyFetch(
	accessToken: string,
	endpoint: "trending" | "search",
	kind: MediaKind,
	params: { q?: string; limit?: number },
): Promise<KlipyResult[]> {
	const qs = new URLSearchParams();
	qs.set("kind", kind);
	if (params.q) qs.set("q", params.q);
	if (params.limit) qs.set("limit", String(params.limit));
	const url = `${ENGINE_URL}/api/klipy/${endpoint}?${qs}`;
	const r = await fetch(url, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) {
		const body = (await r.json().catch(() => ({}))) as KlipyError;
		const base = body.error ?? `klipy_${endpoint}_${r.status}`;
		throw new Error(body.detail ? `${base}: ${body.detail}` : base);
	}
	const body = (await r.json()) as KlipyResponse;
	return body.results;
}

/** Fetches the full-resolution media as a Blob, ready to feed into
 * the existing attachment-upload pipeline.  Goes direct to Klipy's
 * CDN (no engine hop), the URL is already public, and bouncing the
 * binary through the engine would just double the bandwidth.
 *
 * The MIME type on the File object drives downstream behavior:
 *   - image/gif    → m.image, renders as an animated GIF in the bubble
 *   - image/webp   → m.image, renders as a static or animated webp
 *   - video/mp4    → m.video, renders with the inline video player
 *
 * Stable filename so duplicate sends dedupe in Synapse's media store. */
export async function fetchKlipyBlob(result: KlipyResult): Promise<File> {
	const r = await fetch(result.full_url, { credentials: "omit" });
	if (!r.ok) throw new Error(`klipy_blob_${r.status}`);
	const blob = await r.blob();
	const ext = result.mime_type === "image/gif"
		? "gif"
		: result.mime_type === "image/webp"
			? "webp"
			: "mp4";
	const name = `klipy-${result.kind}-${result.id}.${ext}`;
	return new File([blob], name, { type: result.mime_type });
}

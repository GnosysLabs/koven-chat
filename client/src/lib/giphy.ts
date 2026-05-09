// Typed client for the engine's Giphy proxy.  The engine holds the
// instance-wide API key and forwards search / trending requests to
// Giphy on behalf of the user; the SPA never sees the key.
//
// Returns a normalised result shape — the engine reshapes Giphy's
// response so the SPA only sees the URLs + dimensions it actually
// renders.  See engine/src/server.ts → /api/giphy/* for the upstream
// shape.

import { ENGINE_URL } from "@/lib/urls";

export interface GiphyResult {
	id: string;
	title: string;
	/** Lower-resolution thumbnail used in the picker grid.  ~200px wide. */
	preview_url: string;
	/** Full-resolution GIF used when the user picks one to send. */
	original_url: string;
	width: number;
	height: number;
}

interface GiphyResponse {
	results: GiphyResult[];
}

interface GiphyError {
	errcode?: string;
	error?: string;
}

/** True when the engine reports Giphy is configured for this instance.
 * Used by the SPA to hide the GIF picker on instances without a key. */
export interface IntegrationsStatus {
	giphy: { configured: boolean };
}

export async function fetchIntegrationsStatus(accessToken: string): Promise<IntegrationsStatus> {
	const r = await fetch(`${ENGINE_URL}/api/instance/integrations`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) throw new Error(`integrations: ${r.status}`);
	const body = (await r.json()) as { integrations: IntegrationsStatus };
	return body.integrations;
}

/** Throws on 503 (`giphy_not_configured`) and on network failure.
 * The picker treats both as "Giphy is unavailable, hide the picker". */
export async function giphyTrending(accessToken: string, opts: { limit?: number } = {}): Promise<GiphyResult[]> {
	return giphyFetch(accessToken, "trending", { limit: opts.limit });
}

export async function giphySearch(
	accessToken: string,
	query: string,
	opts: { limit?: number } = {},
): Promise<GiphyResult[]> {
	return giphyFetch(accessToken, "search", { q: query, limit: opts.limit });
}

async function giphyFetch(
	accessToken: string,
	endpoint: "trending" | "search",
	params: { q?: string; limit?: number },
): Promise<GiphyResult[]> {
	const qs = new URLSearchParams();
	if (params.q) qs.set("q", params.q);
	if (params.limit) qs.set("limit", String(params.limit));
	const url = `${ENGINE_URL}/api/giphy/${endpoint}${qs.toString() ? `?${qs}` : ""}`;
	const r = await fetch(url, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) {
		const body = (await r.json().catch(() => ({}))) as GiphyError;
		throw new Error(body.error ?? `giphy_${endpoint}_${r.status}`);
	}
	const body = (await r.json()) as GiphyResponse;
	return body.results;
}

/** Fetches the full-resolution GIF as a Blob, ready to feed into the
 * existing attachment-upload pipeline.  Goes direct to Giphy's CDN
 * (no engine hop) — the URL is already public, and bouncing the
 * binary through the engine would just double the bandwidth.  Sets
 * `image/gif` mimetype because Giphy's CDN sometimes returns
 * `application/octet-stream` for redirect chains. */
export async function fetchGiphyBlob(result: GiphyResult): Promise<File> {
	const r = await fetch(result.original_url, { credentials: "omit" });
	if (!r.ok) throw new Error(`giphy_blob_${r.status}`);
	const blob = await r.blob();
	// Stable filename so duplicate sends dedupe in Synapse's media store.
	const name = `giphy-${result.id}.gif`;
	return new File([blob], name, { type: "image/gif" });
}

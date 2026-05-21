// Audius link detection and extraction.
//
// Used by the chat message renderer to:
//   1. Pull Audius track, playlist, and album links out of a message body so the bubble
//      does not print the raw URL alongside the embed player.
//   2. Hand the surviving text to the regular linkify / mention pipeline.
//   3. Render <AudiusEmbed> components for each detected URL.
//
// Matches patterns like:
//   - https://audius.co/FloorJansen_/into-the-unknown-459372
//   - https://audius.co/itsvincent_/playlist/sunrise-series-7588
//   - https://audius.co/neffex/album/some-album-12345
//

export interface AudiusMatch {
	url: string;
	artistHandle: string;
	trackSlug: string;
	type: "track" | "playlist" | "album";
	start: number;
	end: number;
}

const AUDIUS_URL_RE =
	/(?:^|[\s(])(?:https?:\/\/)?(?:www\.)?audius\.co\/([^/\s?#]+)\/(?:(playlist|album)\/)?([^/\s?#]+)\/?(?=$|[\s)?#])/gi;

export const MAX_INLINE_EMBEDS = 1;

export function findAudiusMatches(text: string): AudiusMatch[] {
	if (!text) return [];
	const out: AudiusMatch[] = [];
	const seenUrls = new Set<string>();
	AUDIUS_URL_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = AUDIUS_URL_RE.exec(text)) !== null) {
		const fullMatch = m[0];
		const handle = m[1]!;
		const typeRaw = m[2];
		const slug = m[3]!;

		const type: "track" | "playlist" | "album" =
			typeRaw === "playlist" ? "playlist" : typeRaw === "album" ? "album" : "track";

		// Skip resolving/matching API endpoints or static pages if shared.
		if (["feed", "trending", "explore", "search", "settings"].includes(handle.toLowerCase())) {
			continue;
		}

		// Re-anchor to where the URL actually starts (skip leading space or bracket).
		const urlStart = m.index + (fullMatch.startsWith("http") || fullMatch.startsWith("audius.co")
			? 0
			: 1);
		const urlText = text.slice(urlStart, m.index + fullMatch.length);

		if (seenUrls.has(urlText)) continue;
		if (out.length >= MAX_INLINE_EMBEDS) break;
		seenUrls.add(urlText);

		out.push({
			url: urlText,
			artistHandle: handle,
			trackSlug: slug,
			type,
			start: urlStart,
			end: urlStart + urlText.length,
		});
	}
	return out;
}

export function isAudiusUrl(url: string): boolean {
	return findAudiusMatches(url).length > 0;
}

export function stripAudiusUrls(text: string, matches: AudiusMatch[]): string {
	if (matches.length === 0) return text;
	let result = "";
	let cursor = 0;
	for (const m of matches) {
		result += text.slice(cursor, m.start);
		cursor = m.end;
	}
	result += text.slice(cursor);
	return result.replace(/[ \t]{2,}/g, " ").trim();
}

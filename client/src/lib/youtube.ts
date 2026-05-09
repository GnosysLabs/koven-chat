// YouTube link detection + extraction.
//
// Used by the chat message renderer to:
//   1. Pull every YouTube link out of a message body so the bubble
//      doesn't print the raw URL alongside the embed.
//   2. Hand the surviving text (everything that wasn't a YouTube
//      link) to the regular linkify / mention pipeline.
//   3. Render <YouTubeEmbed> components for each detected video.
//
// Handles the URL shapes YouTube actually emits in 2025:
//   - youtube.com/watch?v=ID         (plus &t=, &list=, etc.)
//   - youtube.com/watch?...&v=ID     (v= not first)
//   - youtu.be/ID                    (the short-link domain)
//   - youtube.com/shorts/ID
//   - youtube.com/live/ID
//   - youtube.com/embed/ID           (already an embed URL)
//   - m.youtube.com/...              (mobile mirror)
//   - music.youtube.com/...          (music product, same id space)
//   - www. prefixed and bare
//
// Doesn't try to follow shortlinks (so a bit.ly wrapping a YouTube
// URL won't expand) — keep it dumb and string-only.

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Pull every YouTube video id out of a body, in source order, with
 * the byte ranges of the URLs that produced them.  Used by the
 * renderer to strip the URLs from the inline text. */
export interface YouTubeMatch {
	videoId: string;
	/** Optional `?t=XXs` start time in seconds. */
	startSeconds?: number;
	/** Half-open range in the source string. */
	start: number;
	end: number;
}

const HOST_RE =
	/(?:^|[\s(])(?:https?:\/\/)?((?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be))(\/[^\s)]*)?/gi;

export function findYouTubeMatches(text: string): YouTubeMatch[] {
	if (!text) return [];
	const out: YouTubeMatch[] = [];
	HOST_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = HOST_RE.exec(text)) !== null) {
		// Re-anchor to where the URL actually starts (skip the
		// leading whitespace / `(` consumed by the lookahead).
		const fullMatch = m[0];
		const host = m[1]!;
		const path = m[2] ?? "";
		const urlStart = m.index + (fullMatch.startsWith(host) || fullMatch.startsWith("http")
			? 0
			: 1);
		const urlText = text.slice(urlStart, m.index + fullMatch.length);
		const id = extractIdFromUrl(host, path);
		if (!id) continue;
		const startSeconds = extractStartSeconds(path);
		out.push({
			videoId: id,
			startSeconds,
			start: urlStart,
			end: urlStart + urlText.length,
		});
	}
	return out;
}

function extractIdFromUrl(host: string, path: string): string | null {
	// youtu.be/<id>
	if (host.toLowerCase() === "youtu.be") {
		const id = path.replace(/^\//, "").split(/[/?#]/)[0];
		return id && ID_RE.test(id) ? id : null;
	}
	// /watch?v=<id>
	const watchMatch = /^\/watch(?:\?|$)/i.test(path);
	if (watchMatch) {
		const qs = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
		for (const pair of qs.split(/[&#]/)) {
			const eq = pair.indexOf("=");
			if (eq < 0) continue;
			const key = pair.slice(0, eq);
			if (key === "v") {
				const v = decodeURIComponent(pair.slice(eq + 1));
				return ID_RE.test(v) ? v : null;
			}
		}
		return null;
	}
	// /shorts/<id>, /live/<id>, /embed/<id>
	const segMatch = /^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]+)/i.exec(path);
	if (segMatch) {
		const id = segMatch[1]!;
		return ID_RE.test(id) ? id : null;
	}
	return null;
}

function extractStartSeconds(path: string): number | undefined {
	// `?t=30` or `?t=30s` or `?start=30` — accept both.
	const qs = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
	for (const pair of qs.split(/[&#]/)) {
		const eq = pair.indexOf("=");
		if (eq < 0) continue;
		const key = pair.slice(0, eq);
		if (key === "t" || key === "start") {
			const raw = pair.slice(eq + 1);
			// Strip optional trailing `s`; ignore `1m30s` style for now.
			const n = parseInt(raw.replace(/s$/i, ""), 10);
			if (Number.isFinite(n) && n > 0) return n;
		}
	}
	return undefined;
}

/** Privacy-respecting embed URL.  `youtube-nocookie.com` skips the
 * tracking cookies the regular embed sets until the user clicks
 * play, which matters in a chat client where embeds auto-load. */
export function buildEmbedUrl(videoId: string, startSeconds?: number): string {
	const base = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`;
	if (startSeconds && startSeconds > 0) {
		return `${base}?start=${startSeconds}`;
	}
	return base;
}

/** Replace YouTube URLs in the body with empty strings so the
 * surviving text can flow through the regular link / mention
 * renderers without the raw URL leaking through.  Trims any
 * resulting whitespace artefacts so a message that's JUST a
 * YouTube URL ends up empty (renderer hides the bubble in that
 * case). */
export function stripYouTubeUrls(text: string, matches: YouTubeMatch[]): string {
	if (matches.length === 0) return text;
	let result = "";
	let cursor = 0;
	for (const m of matches) {
		result += text.slice(cursor, m.start);
		cursor = m.end;
	}
	result += text.slice(cursor);
	// Collapse any double whitespace the removal produced (single
	// newlines are kept — they were probably intentional).
	return result.replace(/[ \t]{2,}/g, " ").trim();
}

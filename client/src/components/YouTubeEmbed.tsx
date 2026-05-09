// Inline YouTube player.  Drops into the chat message render path
// when a body contains a youtube.com / youtu.be URL — see
// `findYouTubeMatches` in lib/youtube.ts.  The player lives outside
// the message bubble (similar to image/video attachments) so it
// reads as a media block rather than text.
//
// Sized to ~max-w-md (matching image attachments) with a 16:9
// aspect ratio.  Uses the youtube-nocookie domain for privacy —
// no cookies set until the user actually clicks play.

import { buildEmbedUrl } from "@/lib/youtube";

interface YouTubeEmbedProps {
	videoId: string;
	startSeconds?: number;
}

export function YouTubeEmbed({ videoId, startSeconds }: YouTubeEmbedProps) {
	const src = buildEmbedUrl(videoId, startSeconds);
	return (
		<div className="max-w-md w-full">
			<div className="relative w-full overflow-hidden rounded-lg bg-black aspect-video">
				<iframe
					src={src}
					title="YouTube video"
					loading="lazy"
					// `accelerometer` + `gyroscope` are required for VR /
					// 360° videos; `picture-in-picture` lets the user pop
					// out of the bubble; `web-share` enables the in-iframe
					// share button.  No `autoplay` — chat is noisy enough
					// without 12 videos starting at once.
					allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
					allowFullScreen
					referrerPolicy="strict-origin-when-cross-origin"
					className="absolute inset-0 w-full h-full border-0 block"
				/>
			</div>
		</div>
	);
}

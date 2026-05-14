import { buildEmbedUrl } from "@/lib/youtube";
import { isMobileShell } from "@/lib/mobile";

interface YouTubeEmbedProps {
	videoId: string;
	startSeconds?: number;
}

export function YouTubeEmbed({ videoId, startSeconds }: YouTubeEmbedProps) {
	if (isMobileShell) {
		// Thumbnail + click-out path: avoids Capacitor iOS WKWebView
		// Error 153 / referrer issues with embedded iframes.
		const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
		const watchUrl = buildWatchUrl(videoId, startSeconds);
		return (
			<div className="w-[448px] max-w-full">
				<a
					href={watchUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="relative block w-full aspect-video overflow-hidden rounded-lg bg-black group"
				>
					<img
						src={thumbnailUrl}
						alt="YouTube video"
						loading="lazy"
						className="absolute inset-0 w-full h-full object-cover"
					/>
					<div className="absolute inset-0 flex items-center justify-center">
						<div className="w-[68px] h-[48px] bg-black/80 rounded-xl flex items-center justify-center group-hover:bg-[#ff0000] transition-colors">
							<svg viewBox="0 0 24 24" className="w-7 h-7 text-white fill-current ml-0.5">
								<path d="M8 5v14l11-7z" />
							</svg>
						</div>
					</div>
				</a>
			</div>
		);
	}

	// Desktop: inline iframe player. WKWebView restrictions don't
	// apply outside the Capacitor shell, so we can render the real
	// player and let users play in-place / fullscreen without leaving
	// the app.
	const src = buildEmbedUrl(videoId, startSeconds);
	return (
		<div className="w-[448px] max-w-full">
			<div className="relative w-full aspect-video overflow-hidden rounded-lg bg-black">
				<iframe
					src={src}
					title="YouTube video"
					loading="lazy"
					allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
					allowFullScreen
					className="absolute inset-0 w-full h-full border-0 block"
				/>
			</div>
		</div>
	);
}

function buildWatchUrl(videoId: string, startSeconds?: number): string {
	const base = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
	if (startSeconds && startSeconds > 0) return `${base}&t=${startSeconds}s`;
	return base;
}

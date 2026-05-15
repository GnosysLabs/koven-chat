// ProfileBanner — wide hero image at the top of profile views.  Given
// an mxc:// banner it auth-fetches the bytes into a blob: URL through
// the shared media hook (the same path MatrixAvatar uses); given a
// previewSrc (a local object URL) it shows that directly, for the
// live preview while editing.  Renders nothing when there is no
// banner, so a profile without one keeps its plain header.
//
// The image fades to transparent at its bottom edge via a CSS mask
// rather than a colored overlay — the fade stays theme-agnostic, and
// the avatar / name sitting below it blend cleanly into any
// background.  The container height is fixed by the caller, so the
// image filling in after its async fetch never shifts layout.

import { cn } from "@/lib/utils";
import { useMatrixMedia } from "@/lib/useMatrixMedia";

// Bottom fade: fully opaque for the top ~55%, then ramps to
// transparent.  WebKit (WKWebView on iOS) needs the -webkit- form.
const FADE_MASK = "linear-gradient(to bottom, #000 0%, #000 55%, transparent 100%)";

export interface ProfileBannerProps {
	// mxc:// URI of the stored banner, resolved through the
	// authenticated-media hook.  Ignored when previewSrc is set.
	mxc?: string | null;
	// Local object URL for an unsaved, just-picked banner file.
	// Takes priority over mxc so the edit form shows the new image
	// immediately, before it is uploaded.
	previewSrc?: string | null;
	// Height + corner radius are the caller's call — each surface
	// sizes the banner differently.
	className?: string;
}

export function ProfileBanner({ mxc, previewSrc, className }: ProfileBannerProps) {
	// Skip the media fetch entirely when a local preview is in play.
	const resolved = useMatrixMedia(previewSrc ? undefined : (mxc ?? undefined));
	const src = previewSrc ?? resolved;

	if (!previewSrc && !mxc) return null;

	return (
		<div
			className={cn("w-full overflow-hidden bg-muted", className)}
			style={{ maskImage: FADE_MASK, WebkitMaskImage: FADE_MASK }}
		>
			{src && <img src={src} alt="" className="h-full w-full object-cover" />}
		</div>
	);
}

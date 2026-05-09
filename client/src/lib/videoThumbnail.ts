// Pure-client video frame extraction.
//
// Takes a video Blob/File, paints frame 0 onto an OffscreenCanvas (or
// a hidden 2D canvas as fallback), encodes to JPEG, and returns the
// blob plus the video's natural dimensions and duration.  Used by:
//
//   1. The composer's pending-attachment chip — replaces the broken
//      `<video preload="metadata">` poster pattern (which renders
//      black in WKWebView on macOS/iOS) with a real <img src=>.
//
//   2. The upload pipeline (matrix.ts uploadAndSendAttachment) —
//      uploads the JPEG as a separate mxc and stamps it into the
//      m.video event's info.thumbnail_url / info.thumbnail_file so
//      every receiver (Koven gallery, Element, Cinny, federation
//      crawlers) gets a usable poster without having to decode the
//      video themselves.
//
// Why client-side and not server-side: the user already has the
// bytes locally before upload; doing it here means zero extra round-
// trips and the thumbnail lands in the same atomic "send" the user
// triggers.  Doing it on the server would need the engine to fetch
// the (potentially encrypted) ciphertext, decrypt with a key that
// only lives on the user's device, transcode, and re-upload.
// Architecturally pointless when we already have the source bytes.
//
// The seek-to-0.1s trick exists because frame 0 of many videos is a
// black or near-black fade-in.  0.1s lands inside the first real
// shot for the overwhelming majority of clips while still being
// fast enough that decoding doesn't lag the upload submit.

export interface VideoThumbnail {
	/** JPEG bytes of the captured frame, ready to upload or
	 * render as an <img src>. */
	blob: Blob;
	/** Object URL for the same blob.  Caller is responsible for
	 * URL.revokeObjectURL once the consumer is done.  Returned
	 * here for the common composer case where the caller
	 * immediately wants a renderable URL. */
	objectUrl: string;
	/** Source video's natural pixel dimensions.  Used to populate
	 * info.w / info.h on the m.video event so receivers know the
	 * intrinsic aspect ratio without having to decode metadata
	 * themselves. */
	width: number;
	height: number;
	/** Source video duration in milliseconds.  Matrix m.video events
	 * carry info.duration in ms; we capture it here so the upload
	 * pipeline doesn't have to re-load the video. */
	durationMs: number;
}

const SEEK_OFFSET_SECONDS = 0.1;
const JPEG_QUALITY = 0.85;
// Cap thumbnails so they're cheap to upload + cheap to fetch on
// the receiving side.  720p covers desktop gallery rendering at
// 1x and Retina (the gallery grid is ~200px square; bubbles are
// ~max-w-md ≈ 448px).  Anything above 720p is wasted bytes.
const MAX_THUMB_DIMENSION = 1280;

/** Extract a poster frame from a video blob.  Resolves null if the
 * decode fails (corrupt file, unsupported codec, browser refusing
 * to load the source) — caller should fall back to a generic file
 * placeholder rather than treating null as fatal. */
export async function extractVideoThumbnail(source: Blob): Promise<VideoThumbnail | null> {
	const sourceUrl = URL.createObjectURL(source);
	let video: HTMLVideoElement | null = null;
	try {
		video = document.createElement("video");
		video.muted = true;          // autoplay policies require muted
		video.playsInline = true;    // iOS WKWebView fullscreen-takeover guard
		video.preload = "auto";      // we NEED frame data, not just metadata
		video.crossOrigin = "anonymous";
		video.src = sourceUrl;

		// Wait for enough data to seek + paint a frame.  We hook
		// loadedmetadata first so we can grab dimensions even on
		// browsers that get cagey about painting before play().
		await waitForEvent(video, "loadedmetadata");

		const naturalWidth = video.videoWidth;
		const naturalHeight = video.videoHeight;
		const durationSeconds = isFinite(video.duration) ? video.duration : 0;
		if (!naturalWidth || !naturalHeight) {
			// Decoder couldn't determine dimensions: source is broken
			// or codec-unsupported.  Bail.
			return null;
		}

		// Seek to a frame past the typical fade-in.  Clamp to the
		// duration in case the clip is shorter than our default
		// offset (e.g. a 50ms motion sticker).
		const seekTo = durationSeconds > SEEK_OFFSET_SECONDS
			? SEEK_OFFSET_SECONDS
			: Math.max(0, durationSeconds - 0.01);
		const seekPromise = waitForEvent(video, "seeked");
		video.currentTime = seekTo;
		await seekPromise;

		// Some WKWebView builds resolve `seeked` before the new frame
		// is actually painted to the decoder's output buffer.  A
		// requestAnimationFrame double-tick is the cheapest reliable
		// way to wait for the next paint without busy-looping.
		await nextFrame();
		await nextFrame();

		// Downscale to MAX_THUMB_DIMENSION on the long edge.  Aspect
		// ratio preserved.  Skipping the scale for already-small
		// videos keeps the JPEG bit-perfect to the source.
		const scale = Math.min(
			1,
			MAX_THUMB_DIMENSION / Math.max(naturalWidth, naturalHeight),
		);
		const targetWidth = Math.round(naturalWidth * scale);
		const targetHeight = Math.round(naturalHeight * scale);

		const blob = await drawToJpegBlob(video, targetWidth, targetHeight);
		if (!blob) return null;

		const objectUrl = URL.createObjectURL(blob);
		return {
			blob,
			objectUrl,
			width: naturalWidth,
			height: naturalHeight,
			durationMs: Math.round(durationSeconds * 1000),
		};
	} catch (err) {
		console.warn("extractVideoThumbnail: failed", err);
		return null;
	} finally {
		// Always release the source URL — the caller never needs it
		// (we hand back the captured-frame URL instead, which points
		// at the JPEG, not the source video).
		URL.revokeObjectURL(sourceUrl);
		if (video) {
			// Detach src + nulling load() releases the decoded buffers
			// in WebKit.  Without this, repeated extractions during a
			// burst attach can pile up in the media element pool and
			// trip "too many open videos" warnings on iOS.
			try {
				video.removeAttribute("src");
				video.load();
			} catch {
				// Ignore — element going out of scope cleans up too.
			}
		}
	}
}

function waitForEvent(target: HTMLElement, event: string, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		let done = false;
		const cleanup = () => {
			target.removeEventListener(event, onEvent);
			target.removeEventListener("error", onError);
		};
		const onEvent = () => {
			if (done) return;
			done = true;
			cleanup();
			resolve();
		};
		const onError = () => {
			if (done) return;
			done = true;
			cleanup();
			reject(new Error(`media error before ${event}`));
		};
		target.addEventListener(event, onEvent, { once: true });
		target.addEventListener("error", onError, { once: true });
		// Safety net: a stuck decoder shouldn't block the composer
		// indefinitely.  5s is well above the realistic worst case
		// (4K HEVC on a slow Mac decoded the first frame in ~600ms
		// in testing); anything beyond that is a real failure.
		setTimeout(() => {
			if (done) return;
			done = true;
			cleanup();
			reject(new Error(`timeout waiting for ${event}`));
		}, timeoutMs);
	});
}

function nextFrame(): Promise<void> {
	return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

async function drawToJpegBlob(
	video: HTMLVideoElement,
	width: number,
	height: number,
): Promise<Blob | null> {
	// Prefer OffscreenCanvas where available (Workers + most modern
	// browsers since 2023).  Falls back to a detached HTMLCanvasElement
	// for WebKit builds without OffscreenCanvas support.  Both expose
	// drawImage(HTMLVideoElement, ...).
	if (typeof OffscreenCanvas !== "undefined") {
		try {
			const canvas = new OffscreenCanvas(width, height);
			const ctx = canvas.getContext("2d");
			if (!ctx) return null;
			ctx.drawImage(video, 0, 0, width, height);
			return await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
		} catch (err) {
			// Some WKWebView versions ship OffscreenCanvas but throw on
			// drawImage from a same-document HTMLVideoElement (the
			// element belongs to the main thread's document).  Fall
			// through to the regular canvas path.
			console.warn("extractVideoThumbnail: OffscreenCanvas path failed, retrying with HTMLCanvasElement", err);
		}
	}

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.drawImage(video, 0, 0, width, height);
	return await new Promise<Blob | null>(resolve => {
		canvas.toBlob(b => resolve(b), "image/jpeg", JPEG_QUALITY);
	});
}

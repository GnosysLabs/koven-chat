// Image-upload sanitiser.
//
// Two jobs, both privacy/compatibility plumbing the user shouldn't
// have to think about:
//
//   1. HEIC / HEIF → PNG conversion.  iOS cameras default to HEIC,
//      Chrome and Firefox can't decode it, so a HEIC upload silently
//      fails to render for ~70% of recipients.  We decode to PNG via
//      `heic-to` (lazy-loaded so non-iPhone users never pay the
//      ~150KB cost).  Quality is preserved — the conversion is
//      lossless re-container, not a JPEG transcode.
//
//   2. EXIF strip on static JPEG / PNG.  A cameraphone JPEG carries
//      GPS coordinates, camera serial, capture time, and ~30 other
//      fields by default; sending one to a public Matrix room
//      publishes that to anyone who joins later.  Re-encoding through
//      a canvas drops every container-level metadata block — the
//      output is just the rasterised pixels.
//
// Skipped: animated formats (GIF, video), audio, generic files.  GIF
// re-encode through canvas captures the first frame only and breaks
// animation; the privacy gain isn't worth the breakage there, and
// GIF rarely carries EXIF anyway.  Animated WebP would be the same
// problem — we leave WebP alone entirely so the rare animated case
// still works.
//
// All paths are best-effort: any failure (decode error, OOM on huge
// images, etc.) returns the original file rather than blocking the
// upload.  The UI never sees an error from this module — sanitiser
// failures degrade gracefully to "EXIF still embedded" instead of
// "your photo didn't send."

const HEIC_MIMES = new Set([
	"image/heic",
	"image/heif",
	"image/heic-sequence",
	"image/heif-sequence",
]);

/** Sanitise a single file before upload.
 *
 * Returns a NEW File object when conversion happened (with updated
 * name and MIME), or the original `file` when no work was needed.
 * Caller should treat the returned File as the canonical upload
 * payload and use its `.name`, `.type`, and `.size` for the Matrix
 * event's `info` block.
 */
export async function sanitizeImageForUpload(file: File): Promise<File> {
	try {
		// HEIC / HEIF — convert to PNG.  Lazy-loaded so the heic-to
		// bundle (~150KB gzip) only ships to users who actually upload
		// HEIC; everyone else's first paint stays the same size.
		if (isHeic(file)) {
			const { heicTo } = await import("heic-to");
			const out = await heicTo({
				blob: file,
				type: "image/png",
			});
			// heic-to returns a Blob.  Wrap in a File with a renamed
			// `.png` extension so receivers see the actual format in
			// the filename — a `*.heic` filename on a PNG payload
			// fools "open with" handlers and confuses users who try
			// to download the file.
			const newName = replaceExtension(file.name, ".png");
			return new File([out], newName, { type: "image/png" });
		}

		// JPEG — re-encode at quality 0.92 to strip EXIF.  0.92 is
		// effectively visually-lossless (Adobe Save-for-Web's "max"
		// preset) but still produces a meaningfully smaller file than
		// quality 1.0 because the very high frequencies most cameras
		// don't actually capture anyway get truncated.
		if (file.type === "image/jpeg" || file.type === "image/jpg") {
			const stripped = await reencodeViaCanvas(file, "image/jpeg", 0.92);
			return stripped ?? file;
		}

		// PNG — re-encode losslessly.  PNG has no quality knob; the
		// canvas writer outputs uncompressed-ish DEFLATE which can
		// occasionally be LARGER than a well-optimised input.  We
		// accept the size penalty for the privacy win because PNG
		// re-encode is the only way to drop tEXt/iTXt/eXIf chunks
		// portably.
		if (file.type === "image/png") {
			const stripped = await reencodeViaCanvas(file, "image/png");
			return stripped ?? file;
		}

		// Anything else (WebP, GIF, video, audio, generic file) —
		// passthrough.  See the module-level comment for the rationale.
		return file;
	} catch (err) {
		// Hard failure: log and pass the original through.  The user
		// gets their upload, just without the strip/convert.
		console.warn("imageSanitize: failed for", file.name, err);
		return file;
	}
}

/** Apply {@link sanitizeImageForUpload} to a list, preserving order.
 * Sequential rather than parallel so the heic-to bundle's first-load
 * cost only happens once, and so canvas memory pressure on huge
 * batches stays bounded. */
export async function sanitizeImagesForUpload(files: File[]): Promise<File[]> {
	const out: File[] = [];
	for (const f of files) {
		out.push(await sanitizeImageForUpload(f));
	}
	return out;
}

function isHeic(file: File): boolean {
	if (HEIC_MIMES.has(file.type)) return true;
	// Some browsers (older Safari, certain Android pickers) report
	// HEIC files with an empty MIME type.  Fall back to the filename
	// extension in that case.
	const lower = file.name.toLowerCase();
	return lower.endsWith(".heic") || lower.endsWith(".heif");
}

function replaceExtension(name: string, newExt: string): string {
	const dot = name.lastIndexOf(".");
	const base = dot > 0 ? name.slice(0, dot) : name;
	return `${base}${newExt}`;
}

/** Decode → encode via canvas.  Strips every container-level
 * metadata block (EXIF, IPTC, XMP, color-profile, etc.) by virtue
 * of writing a fresh container from raw pixel data.
 *
 * Returns null when the canvas can't decode the input (extremely
 * large images on memory-constrained devices, browsers without the
 * required image decoder, etc.) so the caller can fall through to
 * the original file rather than block the upload.
 */
async function reencodeViaCanvas(
	file: File,
	outputMime: "image/jpeg" | "image/png",
	quality?: number,
): Promise<File | null> {
	// Prefer createImageBitmap — it's faster than <img> decode and
	// doesn't require touching the DOM.  Where it isn't available
	// (very old browsers), we fall through to the Image-element path.
	let bitmap: ImageBitmap | null = null;
	try {
		bitmap = await createImageBitmap(file);
	} catch {
		// fall through to <img> path
	}

	let width = 0;
	let height = 0;
	let drawSource: CanvasImageSource;
	let cleanup: (() => void) | null = null;
	if (bitmap) {
		width = bitmap.width;
		height = bitmap.height;
		drawSource = bitmap;
		cleanup = () => bitmap?.close();
	} else {
		const url = URL.createObjectURL(file);
		const img = await new Promise<HTMLImageElement | null>((resolve) => {
			const i = new Image();
			i.onload = () => resolve(i);
			i.onerror = () => resolve(null);
			i.src = url;
		});
		if (!img) {
			URL.revokeObjectURL(url);
			return null;
		}
		width = img.naturalWidth;
		height = img.naturalHeight;
		drawSource = img;
		cleanup = () => URL.revokeObjectURL(url);
	}

	if (!width || !height) {
		cleanup?.();
		return null;
	}

	// Use OffscreenCanvas where supported so we don't have to attach
	// to the DOM.  Both paths converge on a Blob via the same
	// toBlob/convertToBlob API surface.
	let blob: Blob | null = null;
	try {
		if (typeof OffscreenCanvas !== "undefined") {
			const oc = new OffscreenCanvas(width, height);
			const ctx = oc.getContext("2d");
			if (!ctx) return null;
			ctx.drawImage(drawSource, 0, 0);
			blob = await oc.convertToBlob({
				type: outputMime,
				...(quality !== undefined ? { quality } : {}),
			});
		} else {
			const c = document.createElement("canvas");
			c.width = width;
			c.height = height;
			const ctx = c.getContext("2d");
			if (!ctx) return null;
			ctx.drawImage(drawSource, 0, 0);
			blob = await new Promise<Blob | null>((resolve) => {
				c.toBlob(resolve, outputMime, quality);
			});
		}
	} finally {
		cleanup?.();
	}

	if (!blob) return null;
	// Preserve the original filename's extension when output MIME
	// matches the input MIME; otherwise update it.  In practice both
	// JPEG paths and both PNG paths keep the same extension, so this
	// is a no-op for normal inputs but covers oddities like
	// `IMG_1234` (no extension).
	const ext = outputMime === "image/jpeg" ? ".jpg" : ".png";
	const lower = file.name.toLowerCase();
	const hasMatchingExt =
		(outputMime === "image/jpeg" && (lower.endsWith(".jpg") || lower.endsWith(".jpeg")))
		|| (outputMime === "image/png" && lower.endsWith(".png"));
	const finalName = hasMatchingExt ? file.name : replaceExtension(file.name, ext);
	return new File([blob], finalName, { type: outputMime });
}

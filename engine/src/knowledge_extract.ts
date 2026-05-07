// Pull plain-text content out of an uploaded knowledge file.
//
// Supported formats:
//   - Plain-text-ish (.txt .md .csv .log .json .yaml .yml .xml .html)
//     → read as UTF-8 directly.  Markdown stays as-is — the LLM
//     handles markdown syntax natively, no point stripping it.
//   - .docx (Word) → mammoth extracts a plain-text rendering.
//   - .rtf (Apple Notes / TextEdit / Word RTF export) → inline
//     stripper handles control words, hex escapes, and Unicode
//     escapes.  Good enough for prose; complex RTF (embedded
//     tables, images, hyperlinks) loses non-text content.
//
// .pdf is intentionally still missing — extraction is a minefield
// (multi-column layouts, scanned images, embedded fonts) and every
// JS lib has different failure modes plus megabytes of deps.  Punt
// until there's a clear use case.
//
// Returns the extracted text on success or { error } with a short
// reason on failure (caller surfaces this to the user).

import mammoth from "mammoth";

/** Extensions we treat as "already plain text" — read as UTF-8 with
 * no parsing.  Markdown is included because the LLM understands
 * markdown directly; stripping it would lose structural cues
 * (headings, lists) the model uses to navigate the doc. */
const PLAIN_TEXT_EXT = new Set([
	"txt",
	"md",
	"markdown",
	"csv",
	"tsv",
	"log",
	"json",
	"yaml",
	"yml",
	"xml",
	"html",
	"htm",
]);

export interface ExtractResult {
	text: string;
	/** Effective filename for the stored row.  Same as the input
	 * filename for now, but extractors that change format (e.g. a
	 * future .pdf → .txt path) might rewrite it. */
	filename: string;
}

export interface ExtractError {
	error: string;
	detail?: string;
}

/**
 * Extract plain text from a Bun/web `File`.  The extension is the
 * primary dispatch (MIME types from browsers are unreliable —
 * Chrome reports `.docx` as `application/octet-stream` half the
 * time).
 */
export async function extractKnowledgeText(file: File): Promise<ExtractResult | ExtractError> {
	const filename = (file.name || "").trim() || `upload-${Date.now()}.txt`;
	const ext = (filename.split(".").pop() || "").toLowerCase();

	if (PLAIN_TEXT_EXT.has(ext) || ext === "") {
		// Plain text — just decode the bytes.  We accept ext-less
		// files too because they're often clipboard-saved snippets
		// (e.g. drag-drop from Slack).
		try {
			const text = await file.text();
			return { text, filename };
		} catch (err) {
			return {
				error: "decode_failed",
				detail: err instanceof Error ? err.message : String(err),
			};
		}
	}

	if (ext === "docx") {
		try {
			const buf = await file.arrayBuffer();
			// Mammoth's `extractRawText` is the simplest path —
			// returns the document's text content with paragraph
			// breaks but no markup.  `convertToMarkdown` would
			// preserve more structure but its rendering of complex
			// docs (tables, footnotes) is uneven; raw text is more
			// predictable for LLM consumption.
			const result = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
			return { text: result.value, filename };
		} catch (err) {
			return {
				error: "docx_parse_failed",
				detail: err instanceof Error ? err.message : String(err),
			};
		}
	}

	if (ext === "rtf") {
		try {
			const raw = await file.text();
			return { text: stripRtf(raw), filename };
		} catch (err) {
			return {
				error: "rtf_parse_failed",
				detail: err instanceof Error ? err.message : String(err),
			};
		}
	}

	if (ext === "pdf") {
		return {
			error: "unsupported_format",
			detail: "PDF extraction isn't supported yet — convert to .txt, .md, .docx, or .rtf and re-upload.",
		};
	}

	return {
		error: "unsupported_format",
		detail: `Unsupported file type: .${ext}.  Upload .txt, .md, .docx, or .rtf.`,
	};
}

// ─── RTF stripper ───────────────────────────────────────────────────
//
// Tiny inline parser that pulls visible text out of an RTF document
// without an external dep.  Two-phase:
//
//   1. Walk the input tracking brace depth.  Drop entire group
//      contents when the group's leading control word names a known-
//      ignorable destination (font table, colour table, stylesheet,
//      info / metadata blocks, embedded pictures, etc.) or when the
//      group starts with `\*` (RTF's "skip me unless you understand
//      me" marker).  This removes the font / colour-table garbage
//      that would otherwise leak into the output.
//
//   2. On the remainder, decode structural control words to whitespace
//      (\par → newline, \tab → tab), decode \'XX hex escapes and
//      \uNNNN unicode escapes, then strip everything else.
//
// Doesn't handle: embedded images, raw binary objects, embedded
// fields with non-text content.  Good enough for prose and Apple
// Notes / TextEdit / TextMate exports; complex Word RTF that's been
// roundtripped a few times may lose some structure.

const RTF_SKIP_DESTINATIONS = new Set([
	"fonttbl",
	"colortbl",
	"expandedcolortbl",
	"stylesheet",
	"listtable",
	"listoverridetable",
	"rsidtbl",
	"info",
	"generator",
	"themedata",
	"datastore",
	"latentstyles",
	"pict",
	"shppict",
	"nonshppict",
	"object",
	"objdata",
	"header",
	"footer",
	"headerl",
	"headerr",
	"headerf",
	"footerl",
	"footerr",
	"footerf",
	"footnote",
	"endnote",
	"xmlnstbl",
	"mmathPr",
	"wgrffmtfilter",
	"sectd",
	"pgptbl",
]);

function stripRtf(rtf: string): string {
	// Phase 1: drop ignorable groups.  We can't do this with regex
	// alone because RTF groups nest; need brace tracking.
	const cleaned = dropIgnorableGroups(rtf);

	let s = cleaned;

	// Apple TextEdit / Notes encode soft line breaks as a backslash
	// at end of line (followed by a literal newline).  Standard RTF
	// uses \line / \par for the same job; convert Apple's variant
	// up front so the line structure survives the rest of the strip.
	s = s.replace(/\\\r?\n/g, "\n");

	// Decode structural control words BEFORE generic stripping so
	// the newline / tab characters survive.  Trailing optional
	// space is RTF's word-delimiter convention.
	s = s.replace(/\\par\b\s?/gi, "\n")
		.replace(/\\line\b\s?/gi, "\n")
		.replace(/\\tab\b\s?/gi, "\t");

	// Hex byte escapes (\'XX).  RTF documents declare a code page
	// in their header (Apple emits `\ansicpg1252`); we decode every
	// hex escape via Windows-1252, which covers virtually every
	// Apple Notes / TextEdit / Word RTF in the wild.  The decoder's
	// `fatal: false` mode swaps unmappable bytes for U+FFFD rather
	// than throwing — best-effort is fine here.
	const cp1252 = new TextDecoder("windows-1252", { fatal: false });
	s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex) => {
		const b = parseInt(hex, 16);
		return cp1252.decode(new Uint8Array([b]));
	});

	// Unicode escapes (\uNNNN with optional ANSI fallback char).  RTF
	// emits these as signed 16-bit ints; negative values wrap into
	// the surrogate range.
	s = s.replace(/\\u(-?\d+)\??/g, (_m, n) => {
		const code = parseInt(n, 10);
		const u = code < 0 ? code + 65536 : code;
		return String.fromCharCode(u);
	});

	// Escaped literals — convert before stripping generic backslash
	// sequences so `\\` doesn't get eaten as a "control word."
	s = s.replace(/\\([\\{}])/g, "$1");

	// Generic control words.  `\word` or `\word-123` plus optional
	// trailing space (the RTF spec says the space terminates the
	// word and is consumed by the parser).
	s = s.replace(/\\\*?[a-zA-Z]+-?\d*\s?/g, "");

	// Stragglers — bare `\` followed by anything we didn't already
	// match (unusual but legal).
	s = s.replace(/\\[^a-zA-Z]/g, "");

	// Strip remaining group braces.
	s = s.replace(/[{}]/g, "");

	// Tidy whitespace — RTF tends to produce strings of spaces from
	// the eaten control-word delimiters.
	s = s.replace(/[ \t]+/g, " ")
		.replace(/ ?\n ?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return s;
}

/** Walk the RTF source, drop entire groups whose leading control
 * word is in `RTF_SKIP_DESTINATIONS` or that start with `\*`.  Brace
 * tracking handles nested groups inside the skipped ones. */
function dropIgnorableGroups(rtf: string): string {
	let out = "";
	let depth = 0;
	let skipUntilDepth = -1; // depth we need to return to before re-emitting
	let i = 0;
	while (i < rtf.length) {
		const c = rtf[i]!;

		// Treat `\\`, `\{`, `\}` as literal escapes — don't let the
		// brace tracker miscount when they appear in body text.
		if (c === "\\" && i + 1 < rtf.length && /[\\{}]/.test(rtf[i + 1]!)) {
			if (skipUntilDepth < 0) out += rtf.slice(i, i + 2);
			i += 2;
			continue;
		}

		if (c === "{") {
			depth++;
			// Look at the group's prefix to decide whether to skip
			// the whole group.
			let j = i + 1;
			// {\* ...} — RTF "ignore unless you grok this" marker.
			let isStarred = false;
			if (rtf[j] === "\\" && rtf[j + 1] === "*") {
				isStarred = true;
				j += 2;
			}
			let cw: string | null = null;
			if (rtf[j] === "\\" && j + 1 < rtf.length && /[a-zA-Z]/.test(rtf[j + 1]!)) {
				let k = j + 1;
				while (k < rtf.length && /[a-zA-Z]/.test(rtf[k]!)) k++;
				cw = rtf.slice(j + 1, k);
			}
			const startSkip =
				skipUntilDepth < 0 &&
				(isStarred || (cw !== null && RTF_SKIP_DESTINATIONS.has(cw)));
			if (startSkip) {
				skipUntilDepth = depth - 1; // pop back when depth returns to this level
			} else if (skipUntilDepth < 0) {
				out += c;
			}
			i++;
			continue;
		}

		if (c === "}") {
			depth--;
			if (skipUntilDepth >= 0 && depth <= skipUntilDepth) {
				skipUntilDepth = -1;
				i++;
				continue;
			}
			if (skipUntilDepth < 0) out += c;
			i++;
			continue;
		}

		if (skipUntilDepth < 0) out += c;
		i++;
	}
	return out;
}

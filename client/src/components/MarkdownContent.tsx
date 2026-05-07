// Render a chat message's text body as markdown.
//
// Backed by react-markdown + remark-gfm so we get the CommonMark
// spec plus the GitHub-flavored extensions chat actually uses
// (autolinks for bare URLs, strikethrough, task lists, tables).
//
// Output is real React elements built from the AST — there is no
// `dangerouslySetInnerHTML` and no `rehype-raw`, so embedded HTML in
// a message body is rendered as literal text rather than executed.
// XSS via a markdown payload is therefore not possible here.
//
// All elements are styled to fit inside a chat bubble: headings are
// visibly larger than body text but small enough that a "# Heading"
// in chat doesn't dominate the timeline; code blocks scroll
// horizontally rather than blowing up the bubble; lists indent
// without bleeding past the bubble edge.  Links get the same
// underline treatment used by the linkify fallback.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export interface MarkdownContentProps {
	text: string;
	// Match the parent bubble's color pair (self vs other) so block
	// elements (code blocks, blockquotes) pick a contrasting bg that
	// reads against the bubble.
	tone: "self" | "other";
}

export function MarkdownContent({ text, tone }: MarkdownContentProps) {
	const codeBg = tone === "self"
		? "bg-primary-foreground/15"
		: "bg-foreground/10";
	const blockquoteBorder = tone === "self"
		? "border-primary-foreground/30"
		: "border-foreground/20";

	return (
		<div className="markdown-body">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				// `urlTransform` defaults to allowing http/https/mailto.
				// Anchor styling is handled in the components map below.
				components={{
					// Paragraphs lose their default top/bottom margin so
					// a single-paragraph message doesn't gain phantom
					// padding inside the bubble.  Adjacent paragraphs
					// pick up spacing via `:not(:first-child)`.
					p: ({ children }) => (
						<p className="[&:not(:first-child)]:mt-2">{children}</p>
					),
					// Headings — clear visual jump from body text (which
					// is 14px) so `# ##` actually reads as structure,
					// without a single h1 dominating the timeline.  Top
					// margin only when the heading has siblings above
					// it so the bubble doesn't gain phantom padding.
					h1: ({ children }) => (
						<h1 className="text-lg font-bold leading-tight [&:not(:first-child)]:mt-3 [&:not(:first-child)]:mb-1">
							{children}
						</h1>
					),
					h2: ({ children }) => (
						<h2 className="text-base font-bold leading-tight [&:not(:first-child)]:mt-3 [&:not(:first-child)]:mb-1">
							{children}
						</h2>
					),
					h3: ({ children }) => (
						<h3 className="text-[15px] font-semibold leading-tight [&:not(:first-child)]:mt-2.5 [&:not(:first-child)]:mb-0.5">
							{children}
						</h3>
					),
					h4: ({ children }) => (
						<h4 className="text-sm font-semibold leading-tight [&:not(:first-child)]:mt-2 [&:not(:first-child)]:mb-0.5">
							{children}
						</h4>
					),
					h5: ({ children }) => (
						<h5 className="text-sm font-medium uppercase tracking-wide [&:not(:first-child)]:mt-2 [&:not(:first-child)]:mb-0.5">
							{children}
						</h5>
					),
					h6: ({ children }) => (
						<h6 className="text-xs font-medium uppercase tracking-wide [&:not(:first-child)]:mt-2 [&:not(:first-child)]:mb-0.5">
							{children}
						</h6>
					),
					// Lists.  pl-5 leaves room for the marker; mt-1 +
					// space-y-0.5 keeps tight rhythm.  Nested lists pick
					// up additional padding via the marker style.
					ul: ({ children }) => (
						<ul className="list-disc pl-5 space-y-0.5 [&:not(:first-child)]:mt-1.5 marker:text-current/60">
							{children}
						</ul>
					),
					ol: ({ children }) => (
						<ol className="list-decimal pl-5 space-y-0.5 [&:not(:first-child)]:mt-1.5 marker:text-current/60">
							{children}
						</ol>
					),
					li: ({ children }) => <li>{children}</li>,
					// Inline emphasis.
					strong: ({ children }) => (
						<strong className="font-semibold">{children}</strong>
					),
					em: ({ children }) => <em className="italic">{children}</em>,
					del: ({ children }) => (
						<del className="opacity-60">{children}</del>
					),
					// Code — both inline (`backtick`) and fenced.  The
					// upstream `inline` boolean was deprecated; we
					// detect inline by checking whether the parent is a
					// <pre> via the absence of a className on the code
					// node (fenced code blocks come with `language-xxx`).
					code: ({ className, children, ...rest }) => {
						const isFenced = !!className && /language-/.test(className);
						if (isFenced) {
							// Fenced code is wrapped in <pre> by react-
							// markdown; styling lives on the pre below.
							return (
								<code className={cn("font-mono", className)} {...rest}>
									{children}
								</code>
							);
						}
						return (
							<code
								className={cn(
									"font-mono text-[0.85em] px-1 py-0.5 rounded",
									codeBg,
								)}
								{...rest}
							>
								{children}
							</code>
						);
					},
					pre: ({ children }) => (
						<pre className={cn(
							"mt-2 mb-1 px-3 py-2 rounded-md text-xs font-mono overflow-x-auto",
							codeBg,
						)}>
							{children}
						</pre>
					),
					// Blockquote — gentle left border, indented body.
					blockquote: ({ children }) => (
						<blockquote className={cn(
							"my-1.5 pl-3 border-l-2 italic opacity-90",
							blockquoteBorder,
						)}>
							{children}
						</blockquote>
					),
					// Anchors — match linkify's underline-on-default
					// styling so md links and bare URLs feel uniform.
					a: ({ href, children }) => (
						<a
							href={href}
							target="_blank"
							rel="noopener noreferrer"
							className="underline underline-offset-2 hover:no-underline break-all"
						>
							{children}
						</a>
					),
					// Horizontal rule — thin and subtle.
					hr: () => (
						<hr className="my-2 border-current/20" />
					),
					// Tables (GFM).  Force a horizontal scroll wrapper
					// so a wide table can't blow out the bubble width.
					table: ({ children }) => (
						<div className="my-2 -mx-1 overflow-x-auto">
							<table className="text-xs border-collapse">
								{children}
							</table>
						</div>
					),
					thead: ({ children }) => (
						<thead className="border-b border-current/20">{children}</thead>
					),
					th: ({ children }) => (
						<th className="px-2 py-1 text-left font-semibold">{children}</th>
					),
					td: ({ children }) => (
						<td className="px-2 py-1 align-top">{children}</td>
					),
					// Images in chat bubbles render as inline thumbnails;
					// not loading them here would lose alt text + the
					// bot occasionally embeds them.  Capped width keeps
					// them inside the bubble.
					img: ({ src, alt }) => (
						<img
							src={src}
							alt={alt ?? ""}
							className="max-w-full rounded my-1"
						/>
					),
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}

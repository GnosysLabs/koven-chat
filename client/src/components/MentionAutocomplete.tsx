// Compose-box `@` autocomplete.  Renders a small popover above the
// message input when the user is typing a mention prefix, showing
// matching room members + bots on this homeserver.
//
// Selection mechanics mirror Element / Slack:
//   - ↑ / ↓     navigate
//   - Enter     accept the highlighted suggestion
//   - Tab       accept the highlighted suggestion
//   - Escape    close without accepting
//   - mouse     click any row to accept
// Clicking outside the popover (parent's responsibility) also closes.
//
// Same-server convenience: when the picked mxid's server matches the
// viewer's server, the inserted text is `@localpart` (no `:server`
// suffix) — typing `:koven.chat` on every mention is grating.  The
// bot pipeline accepts both forms (see engine/bot_pipeline.ts).

import { useEffect, useMemo, useRef } from "react";
import type { Member, UserId } from "@koven/shared";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { BotBadge } from "@/components/BotBadge";
import { cn } from "@/lib/utils";

export interface AutocompleteCandidate {
	userId: UserId;
	displayName: string;
	avatarUrl?: string;
	isBot: boolean;
}

export interface MentionAutocompleteProps {
	query: string;       // text after the active "@", lowercase
	candidates: AutocompleteCandidate[]; // already-scored / filtered
	selectedIndex: number;
	onSelect(c: AutocompleteCandidate): void;
	onHover(index: number): void;
}

export function MentionAutocomplete({
	candidates,
	selectedIndex,
	onSelect,
	onHover,
}: MentionAutocompleteProps) {
	const containerRef = useRef<HTMLDivElement>(null);

	// Keep the highlighted row in view as the user navigates with the
	// keyboard.  `scrollIntoView` is enough — the popover is short and
	// scrolling here is rare (we cap matches at ~8).
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const row = container.querySelector<HTMLElement>(`[data-idx="${selectedIndex}"]`);
		if (row) row.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	if (candidates.length === 0) return null;

	return (
		<div
			ref={containerRef}
			className={cn(
				"absolute bottom-full left-0 right-0 mb-2",
				"bg-popover border border-border rounded-md shadow-lg",
				"max-h-64 overflow-y-auto z-30",
			)}
			role="listbox"
			aria-label="Mention suggestions"
		>
			{candidates.map((c, i) => (
				<button
					key={c.userId}
					type="button"
					data-idx={i}
					role="option"
					aria-selected={i === selectedIndex}
					onMouseDown={e => {
						// Use mousedown so the input keeps focus through
						// the click — onClick fires after blur, which
						// makes the input lose its caret context.
						e.preventDefault();
						onSelect(c);
					}}
					onMouseEnter={() => onHover(i)}
					className={cn(
						"w-full px-3 py-1.5 flex items-center gap-2 text-left text-sm",
						"hover:bg-accent",
						i === selectedIndex && "bg-accent",
					)}
				>
					<MatrixAvatar
						mxc={c.avatarUrl}
						seed={c.userId}
						kind={c.isBot ? "bot" : "user"}
						className="h-5 w-5 shrink-0"
					/>
					<span className="flex-1 min-w-0 truncate flex items-center gap-1.5">
						<span className="truncate">{c.displayName}</span>
						{c.isBot && <BotBadge />}
					</span>
					<span className="text-[10px] font-mono text-muted-foreground truncate max-w-[14ch]">
						{c.userId}
					</span>
				</button>
			))}
		</div>
	);
}

// ─── Token / candidate helpers ────────────────────────────────────

/** Find the active "@" mention token at the given cursor position.
 *
 *   "Hi @bo|"     → { start: 3, end: 6, query: "bo" }
 *   "Hi @bo|b"    → { start: 3, end: 5, query: "bo" }   (only up to caret)
 *   "Hi @bob "    → null   (whitespace ends the token)
 *   "@bot-runner" → { start: 0, end: 11, query: "bot-runner" }
 *
 * Returns null when the caret isn't sitting in an active `@`-prefixed
 * token.  We require the `@` to be at a word boundary (start of
 * string or preceded by whitespace) so that text like
 * "you@example.com" doesn't trigger autocomplete.
 */
export function activeMentionToken(text: string, cursor: number): { start: number; query: string } | null {
	if (cursor < 1) return null;
	// Walk backwards from the caret to the most recent "@" without
	// crossing whitespace.  The character before the "@" must be
	// whitespace or string start.
	let i = cursor - 1;
	while (i >= 0) {
		const ch = text[i]!;
		if (ch === "@") break;
		if (/\s/.test(ch)) return null;
		i--;
	}
	if (i < 0) return null;
	if (i > 0 && !/\s/.test(text[i - 1]!)) return null;
	const query = text.slice(i + 1, cursor);
	// Bound the matched character class — Matrix mxid localparts allow
	// `[a-z0-9._=/+-]`.  Anything outside that ends the token.
	if (!/^[a-zA-Z0-9._=/+\-:]*$/.test(query)) return null;
	return { start: i, query: query.toLowerCase() };
}

/** Score a candidate against a lowercased query.  Higher = better.
 * 0 means "doesn't match — drop it". */
export function scoreCandidate(c: AutocompleteCandidate, query: string): number {
	if (!query) return 1;
	const dn = c.displayName.toLowerCase();
	const localpart = c.userId.split(":")[0]!.slice(1).toLowerCase(); // strip "@" + server
	if (dn.startsWith(query) || localpart.startsWith(query)) return 100;
	if (dn.includes(query) || localpart.includes(query)) return 50;
	// Allow typing the full mxid prefix including ":" — useful for
	// federated users.
	if (c.userId.toLowerCase().includes(query)) return 25;
	return 0;
}

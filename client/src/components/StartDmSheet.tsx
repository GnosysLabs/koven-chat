// "Start a direct message" dialog — search by display name or user
// id, pick a result, and the transport creates (or returns the
// existing) DM room with that user.  Self is filtered out.

import { useEffect, useRef, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { cn } from "@/lib/utils";
import type { MatrixTransport } from "@/lib/matrix";
import type { UserId } from "@koven/shared";

interface DirectoryResult {
	userId: UserId;
	displayName?: string;
	avatarUrl?: string;
}

export interface StartDmSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	transport: MatrixTransport | null;
	onStarted(roomId: string): void;
}

export function StartDmSheet({ open, onOpenChange, transport, onStarted }: StartDmSheetProps) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<DirectoryResult[]>([]);
	const [picked, setPicked] = useState<DirectoryResult | null>(null);
	const [searching, setSearching] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const queryDebounceRef = useRef<number | null>(null);

	function reset() {
		setQuery("");
		setResults([]);
		setPicked(null);
		setError(null);
		setSearching(false);
		setPending(false);
	}

	// Debounced directory search.  Triggers ~250ms after the last
	// keystroke so we're not pummeling the homeserver on every letter.
	useEffect(() => {
		if (!open || !transport) return;
		if (queryDebounceRef.current) window.clearTimeout(queryDebounceRef.current);
		const trimmed = query.trim();
		if (!trimmed) {
			setResults([]);
			setSearching(false);
			return;
		}
		setSearching(true);
		queryDebounceRef.current = window.setTimeout(async () => {
			try {
				const matches = await transport.searchUsers(trimmed, 8);
				const me = transport.currentUserId;
				setResults(matches.filter(m => m.userId !== me));
			} catch (err) {
				console.warn("searchUsers failed", err);
				setResults([]);
			} finally {
				setSearching(false);
			}
		}, 250);
		return () => {
			if (queryDebounceRef.current) window.clearTimeout(queryDebounceRef.current);
		};
	}, [query, open, transport]);

	async function start() {
		if (!transport) return;
		// Use the picked result if there is one, otherwise treat the
		// raw query as a user id (lets you DM by typing @user:server
		// even if directory search misses them).
		const target = picked?.userId ?? (query.trim() as UserId);
		if (!target.startsWith("@") || !target.includes(":")) {
			setError("Enter a username (e.g. @alice:localhost) or pick a search result.");
			return;
		}
		setPending(true);
		setError(null);
		try {
			const roomId = await transport.startDm(target);
			onStarted(roomId);
			reset();
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Start a direct message</DialogTitle>
					<DialogDescription>
						Search for someone by name or paste their full Matrix id.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="dm-query">Find a person</Label>
						<Input
							id="dm-query"
							value={query}
							onChange={(e) => { setQuery(e.target.value); setPicked(null); }}
							placeholder="alice or @alice:localhost"
							autoFocus
							autoComplete="off"
						/>
					</div>

					<div className="border border-border rounded-md min-h-[140px] max-h-[240px] overflow-y-auto">
						{searching && results.length === 0 ? (
							<div className="text-xs text-muted-foreground p-3">Searching…</div>
						) : results.length === 0 ? (
							<div className="text-xs text-muted-foreground p-3 leading-snug">
								{query.trim()
									? "No matches yet — keep typing, or paste a full @user:server id and click Start."
									: "Start typing to search the homeserver directory."}
							</div>
						) : (
							<ul className="divide-y divide-border">
								{results.map(r => (
									<li key={r.userId}>
										<button
											type="button"
											onClick={() => setPicked(r)}
											className={cn(
												"w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent transition-colors",
												picked?.userId === r.userId && "bg-accent",
											)}
										>
											<MatrixAvatar mxc={r.avatarUrl} seed={r.userId} className="h-6 w-6" />
											<div className="min-w-0 flex-1">
												<div className="text-sm truncate">{r.displayName ?? r.userId}</div>
												{r.displayName && (
													<div className="text-[10px] text-muted-foreground font-mono truncate">{r.userId}</div>
												)}
											</div>
										</button>
									</li>
								))}
							</ul>
						)}
					</div>

					{error && (
						<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
							{error}
						</div>
					)}
				</div>

				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
						Cancel
					</Button>
					<Button
						type="button"
						onClick={start}
						disabled={pending || (!picked && !query.trim())}
					>
						{pending ? "Starting…" : "Start chat"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

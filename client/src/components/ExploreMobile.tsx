// ExploreMobile — iOS HIG version of the public-directory browser.
// Rendered on the Explore tab when `isMobileShell` is true.  Same
// data model as the desktop ExplorePane (PublicEntry rows fetched
// via transport.discoverDirectory + engine icon backfill) — just
// laid out per Apple's Human Interface Guidelines.
//
// HIG calibration:
//   - 34pt Large Title "Explore" at the top.
//   - iOS UISearchBar-style search field: 36pt tall, rounded, subtle
//     fill, leading magnifying glass.  No autofocus on tab landings
//     (iOS Mail / App Store don't pop the keyboard either).
//   - Result rows: 48pt rounded-square avatars (spaces look like
//     "apps"), 17pt name + 13pt meta line, iOS App Store-style "GET"
//     pill on the trailing edge — `bg-primary/15 text-primary`,
//     respects the user's theme tint.
//   - Inset-grouped result card with hairline dividers.
//   - Flag button: small icon button inline before the Join pill.
//   - Empty / loading / error states mirror the iOS list conventions.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Compass, Flag, Search } from "lucide-react";
import type { MatrixTransport } from "@/lib/matrix";
import type { FlagCategory, Room, RoomId, Space } from "@koven/shared";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { FlagDialog } from "@/components/FlagDialog";
import { hapticImpact, hapticNotification } from "@/lib/haptics";
import { fetchRoomIcons, flagRoom } from "@/lib/instance";
import { cn } from "@/lib/utils";

interface PublicEntry {
	roomId: RoomId;
	name: string;
	topic?: string;
	avatarUrl?: string;
	iconEmoji?: string;
	memberCount: number;
	isSpace: boolean;
	joinRule: string;
	roomCount?: number;
	nsfw?: boolean;
}

export interface ExploreMobileProps {
	transport: MatrixTransport | null;
	rooms: Room[];
	spaces: Space[];
	onJoined(roomId: RoomId, isSpace: boolean): void;
	accessToken: string | null;
	showNsfw: boolean;
}

export function ExploreMobile({
	transport, rooms, spaces, onJoined, accessToken, showNsfw,
}: ExploreMobileProps) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<PublicEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [joining, setJoining] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [flagDialog, setFlagDialog] = useState<PublicEntry | null>(null);
	const searchDebounceRef = useRef<number | null>(null);

	// Same fetch flow as the desktop ExplorePane.  See that file for
	// the full rationale on the two-step directory + icons backfill.
	useEffect(() => {
		if (!transport) return;
		if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current);
		searchDebounceRef.current = window.setTimeout(async () => {
			setLoading(true);
			setError(null);
			try {
				const { spaces: dirSpaces, soloRooms } = await transport.discoverDirectory({
					search: query.trim() || undefined,
					limit: 50,
				});
				const merged: PublicEntry[] = [
					...dirSpaces.map(s => ({ ...s, isSpace: true })),
					...soloRooms.map(r => ({ ...r, isSpace: false })),
				];
				const ids = merged.map(e => e.roomId);
				const meta = await fetchRoomIcons(ids).catch(
					() => ({ icons: {} as Record<string, string>, nsfw: new Set<string>() }),
				);
				const enriched = merged.map(e => ({
					...e,
					iconEmoji: meta.icons[e.roomId] ?? e.iconEmoji,
					nsfw: meta.nsfw.has(e.roomId),
				}));
				setResults(enriched);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading(false);
			}
		}, query ? 250 : 0);
		return () => {
			if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current);
		};
	}, [query, transport]);

	const joinedIds = useMemo(() => {
		const set = new Set<string>();
		for (const r of rooms) set.add(r.id);
		for (const s of spaces) set.add(s.id);
		return set;
	}, [rooms, spaces]);

	// Two-stage filter so the empty-state copy can distinguish
	// "nothing public on this server yet" from "you've joined every
	// available space."
	const publicSpaces = useMemo(() => {
		let live = results;
		if (!showNsfw) live = live.filter(r => !r.nsfw);
		// Discord-style: Explore only surfaces SPACES.  Rooms live
		// inside their parent space.
		return live.filter(r => r.isSpace);
	}, [results, showNsfw]);

	const visible = useMemo(
		// Hide spaces the user has already joined — a discovery
		// surface that keeps showing joined rows is just confusing.
		// Stage two (after NSFW + isSpace) so the empty-state copy
		// can still tell the user when they've cleared the directory.
		() => publicSpaces.filter(r => !joinedIds.has(r.roomId)),
		[publicSpaces, joinedIds],
	);

	async function handleJoin(entry: PublicEntry) {
		if (!transport) return;
		setJoining(entry.roomId);
		setError(null);
		void hapticImpact("medium");
		try {
			if (entry.isSpace) {
				const r = await transport.joinSpaceWithChildren(entry.roomId);
				void hapticNotification("success");
				onJoined(r.spaceId, true);
			} else {
				const id = await transport.joinRoomById(entry.roomId);
				void hapticNotification("success");
				onJoined(id, false);
			}
		} catch (err) {
			void hapticNotification("error");
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setJoining(null);
		}
	}

	return (
		<div className="flex-1 min-h-0 overflow-y-auto">
			<div
				className="px-4 pt-3"
				// `--keyboard-inset` extends the scroll runway so the
				// last results can clear the soft keyboard when the
				// search field is focused (0 when the keyboard is down).
				style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 80px + var(--keyboard-inset, 0px))" }}
			>
				<h1 className="text-[34px] font-bold tracking-[-0.022em] leading-[1.1] text-foreground py-3">
					Explore
				</h1>

				{/* iOS UISearchBar.  Flex container with icon + input
				    as siblings — keeps icon centered with the input's
				    text baseline without any positioning math.  36pt
				    tall, subtle fill, leading magnifying glass.  No
				    autofocus — tab landings on iOS don't pop the
				    keyboard. */}
				<div className="pb-4">
					<div
						className={cn(
							"flex items-center h-10 rounded-[10px]",
							"bg-foreground/[0.08] focus-within:bg-foreground/[0.12]",
							"transition-colors duration-150",
						)}
					>
						<Search
							className="ml-3 size-[18px] text-muted-foreground/70 shrink-0 pointer-events-none"
							strokeWidth={2.25}
						/>
						<input
							type="search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search spaces"
							enterKeyHint="search"
							className={cn(
								"flex-1 min-w-0 h-full pl-2 pr-3 bg-transparent",
								"text-[15px] text-foreground placeholder:text-muted-foreground/70",
								"outline-none border-0 ring-0 focus:outline-none focus:ring-0",
								"appearance-none",
							)}
						/>
					</div>
				</div>

				{error && (
					<div className="mb-3 flex items-start gap-2 px-3.5 py-3 rounded-2xl text-[14px] leading-snug bg-red-500/[0.14] text-red-200 border border-red-500/30">
						{error}
					</div>
				)}

				{loading && results.length === 0 ? (
					<LoadingState />
				) : visible.length === 0 ? (
					<EmptyState
						query={query}
						everythingJoined={publicSpaces.length > 0 && !query}
					/>
				) : (
					<div className="rounded-2xl bg-card/60 backdrop-blur-xl border border-foreground/10 overflow-hidden">
						{visible.map((entry, idx) => (
							<EntryRow
								key={entry.roomId}
								entry={entry}
								joined={joinedIds.has(entry.roomId)}
								joining={joining === entry.roomId}
								onJoin={() => handleJoin(entry)}
								onFlag={accessToken ? () => setFlagDialog(entry) : undefined}
								showDivider={idx > 0}
							/>
						))}
					</div>
				)}
			</div>

			<FlagDialog
				open={!!flagDialog}
				onOpenChange={(o) => { if (!o) setFlagDialog(null); }}
				target="room"
				onSubmit={async (category: FlagCategory, rationale?: string) => {
					if (!flagDialog || !accessToken) return;
					const r = await flagRoom(accessToken, flagDialog.roomId, category, rationale);
					if (!r.ok) throw new Error(r.error ?? "Report submission failed");
					setFlagDialog(null);
				}}
			/>
		</div>
	);
}

function EntryRow({
	entry, joined, joining, onJoin, onFlag, showDivider,
}: {
	entry: PublicEntry;
	joined: boolean;
	joining: boolean;
	onJoin(): void;
	onFlag?(): void;
	showDivider: boolean;
}) {
	const memberLabel = `${entry.memberCount} ${entry.memberCount === 1 ? "member" : "members"}`;
	const roomLabel = entry.roomCount !== undefined
		? `${entry.roomCount} ${entry.roomCount === 1 ? "room" : "rooms"}`
		: null;
	const meta = [memberLabel, roomLabel].filter(Boolean).join(" · ");
	return (
		<>
			{showDivider && <div className="h-px bg-foreground/[0.08]" aria-hidden />}
			<div className="px-4 py-3.5">
				{/* Top section: avatar (top-aligned, doesn't grow
				    with topic wrap) + stacked title block. */}
				<div className="flex items-start gap-3">
					<MatrixAvatar
						mxc={entry.avatarUrl}
						emoji={entry.iconEmoji}
						seed={entry.roomId}
						kind={entry.isSpace ? "space" : "room"}
						className="h-14 w-14 rounded-2xl shrink-0"
					/>
					<div className="flex-1 min-w-0 text-left">
						<div className="text-[17px] font-semibold text-foreground leading-tight truncate">
							{entry.name}
						</div>
						<div className="text-[13px] text-muted-foreground leading-snug mt-0.5 truncate">
							{meta}
						</div>
						{entry.topic && (
							<div className="text-[14px] text-foreground/80 leading-snug mt-1.5 line-clamp-3">
								{entry.topic}
							</div>
						)}
					</div>
				</div>

				{/* Action row.  Pills on the leading side, Join +
				    flag on the trailing.  Always rendered so rows
				    have a consistent footer even with no pills. */}
				<div className="flex items-center justify-between gap-2 mt-3">
					<div className="flex items-center gap-1.5 min-w-0 flex-wrap">
						{entry.nsfw && (
							<MetaPill tone="destructive">NSFW</MetaPill>
						)}
					</div>
					<div className="flex items-center gap-1 shrink-0">
						{onFlag && !joined && (
							<button
								type="button"
								onClick={() => { void hapticImpact("light"); onFlag(); }}
								aria-label="Flag this space"
								className="size-8 rounded-full flex items-center justify-center text-muted-foreground/70 active:bg-foreground/[0.08] transition-colors"
							>
								<Flag className="size-[15px]" strokeWidth={2.25} />
							</button>
						)}
						{joined ? (
							<span className="inline-flex items-center gap-1 px-3 h-7 rounded-full bg-foreground/[0.08] text-[13px] font-semibold text-muted-foreground">
								<Check className="size-[14px]" strokeWidth={2.75} /> Joined
							</span>
						) : (
							// iOS App Store "GET" pill — subtle primary-
							// tinted fill with primary text.  Respects
							// the user's theme.
							<button
								type="button"
								onClick={onJoin}
								disabled={joining}
								className={cn(
									"px-4 h-7 rounded-full",
									"bg-primary/15 text-primary text-[13px] font-semibold tracking-tight",
									"active:opacity-70 transition-opacity",
									"disabled:opacity-50",
								)}
							>
								{joining ? "Joining…" : "Join"}
							</button>
						)}
					</div>
				</div>
			</div>
		</>
	);
}

function MetaPill({
	tone, children,
}: {
	tone: "destructive" | "neutral";
	children: React.ReactNode;
}) {
	return (
		<span className={cn(
			"shrink-0 inline-flex items-center gap-1 px-2 h-[22px] rounded-md",
			"text-[11px] uppercase tracking-wide font-bold",
			tone === "destructive"
				? "text-red-300 bg-red-500/[0.14] border border-red-500/30"
				: "text-muted-foreground bg-foreground/[0.08] border border-foreground/[0.12]",
		)}>
			{children}
		</span>
	);
}

function LoadingState() {
	return (
		<div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
			<span
				aria-hidden
				className="block size-6 rounded-full border-[2.5px] border-foreground/20 border-t-foreground/70 animate-spin"
			/>
			<p className="text-[15px] text-muted-foreground">Loading directory…</p>
		</div>
	);
}

function EmptyState({ query, everythingJoined }: { query: string; everythingJoined: boolean }) {
	const heading = query
		? "No matches"
		: everythingJoined
			? "You're all caught up"
			: "Nothing public yet";
	const body = query
		? "Try a different search term, or check back later as new spaces appear."
		: everythingJoined
			? "You've joined every public space on this server.  New ones will show up here as they appear."
			: "When the operator publishes a space to this server, it'll show up here.";
	return (
		<div className="flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
			<div className="size-16 rounded-2xl bg-foreground/[0.06] flex items-center justify-center">
				<Compass className="size-7 text-muted-foreground" strokeWidth={1.8} />
			</div>
			<div className="text-[17px] font-medium text-foreground">{heading}</div>
			<p className="text-[15px] text-muted-foreground max-w-[280px] leading-snug">{body}</p>
		</div>
	);
}

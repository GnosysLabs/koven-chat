// ExploreMobile — iOS HIG version of the public-directory browser.
// Rendered on the Explore tab when `isMobileShell` is true.  Two
// tabs: Spaces and People, via an iOS-style segmented control.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Compass, Flag, MessageCircle, Search } from "lucide-react";
import type { MatrixTransport } from "@/lib/matrix";
import type { FlagCategory, Room, RoomId, Space, UserId } from "@koven/shared";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { FounderBadge } from "@/components/FounderBadge";
import { FlagDialog } from "@/components/FlagDialog";
import { hapticImpact, hapticNotification } from "@/lib/haptics";
import { fetchRoomIcons, fetchUserDirectory, flagRoom } from "@/lib/instance";
import type { DirectoryUser } from "@/lib/instance";
import { useResolvedUser } from "@/lib/useResolvedUser";
import { formatMxid, serverOf } from "@/lib/mxid";
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
	creatorId?: string;
}

type ExploreTab = "spaces" | "people";

export interface ExploreMobileProps {
	transport: MatrixTransport | null;
	rooms: Room[];
	spaces: Space[];
	onJoined(roomId: RoomId, isSpace: boolean): void;
	accessToken: string | null;
	showNsfw: boolean;
	onStartDm?(userId: UserId): void;
}

export function ExploreMobile({
	transport, rooms, spaces, onJoined, accessToken, showNsfw, onStartDm,
}: ExploreMobileProps) {
	const [tab, setTab] = useState<ExploreTab>("spaces");
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<PublicEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [joining, setJoining] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [flagDialog, setFlagDialog] = useState<PublicEntry | null>(null);
	const searchDebounceRef = useRef<number | null>(null);

	const [people, setPeople] = useState<DirectoryUser[]>([]);
	const [peopleLoading, setPeopleLoading] = useState(false);
	const peopleDebounceRef = useRef<number | null>(null);

	const currentUserId = transport?.currentUserId ?? null;
	const serverName = serverOf(currentUserId) ?? undefined;

	useEffect(() => {
		if (tab !== "spaces" || !transport) return;
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
					() => ({ icons: {} as Record<string, string>, nsfw: new Set<string>(), creators: {} as Record<string, string> }),
				);
				const enriched = merged.map(e => ({
					...e,
					iconEmoji: meta.icons[e.roomId] ?? e.iconEmoji,
					nsfw: meta.nsfw.has(e.roomId),
					creatorId: meta.creators[e.roomId],
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
	}, [query, transport, tab]);

	useEffect(() => {
		if (tab !== "people") return;
		if (peopleDebounceRef.current) window.clearTimeout(peopleDebounceRef.current);
		peopleDebounceRef.current = window.setTimeout(async () => {
			setPeopleLoading(true);
			setError(null);
			try {
				const r = await fetchUserDirectory({ q: query.trim() || undefined, limit: 50 });
				setPeople(r.users);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setPeopleLoading(false);
			}
		}, query ? 250 : 0);
		return () => {
			if (peopleDebounceRef.current) window.clearTimeout(peopleDebounceRef.current);
		};
	}, [query, tab]);

	const joinedIds = useMemo(() => {
		const set = new Set<string>();
		for (const r of rooms) set.add(r.id);
		for (const s of spaces) set.add(s.id);
		return set;
	}, [rooms, spaces]);

	const publicSpaces = useMemo(() => {
		let live = results;
		if (!showNsfw) live = live.filter(r => !r.nsfw);
		return live.filter(r => r.isSpace);
	}, [results, showNsfw]);

	const visible = useMemo(
		() => publicSpaces.filter(r => !joinedIds.has(r.roomId)),
		[publicSpaces, joinedIds],
	);

	const visiblePeople = useMemo(
		() => people.filter(u => u.user_id !== currentUserId),
		[people, currentUserId],
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
				style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 80px + var(--keyboard-inset, 0px))" }}
			>
				<h1 className="text-[34px] font-bold tracking-[-0.022em] leading-[1.1] text-foreground py-3">
					Explore
				</h1>

				{/* iOS-style segmented control */}
				<div className="pb-3">
					<div className="relative flex h-8 rounded-[8px] bg-foreground/[0.08] p-[2px]">
						<button
							type="button"
							onClick={() => { void hapticImpact("light"); setTab("spaces"); }}
							className={cn(
								"flex-1 rounded-[7px] text-[13px] font-semibold transition-all duration-200 z-10",
								tab === "spaces"
									? "bg-card text-foreground shadow-sm"
									: "text-muted-foreground",
							)}
						>
							Spaces
						</button>
						<button
							type="button"
							onClick={() => { void hapticImpact("light"); setTab("people"); }}
							className={cn(
								"flex-1 rounded-[7px] text-[13px] font-semibold transition-all duration-200 z-10",
								tab === "people"
									? "bg-card text-foreground shadow-sm"
									: "text-muted-foreground",
							)}
						>
							People
						</button>
					</div>
				</div>

				{/* Search bar */}
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
							placeholder={tab === "spaces" ? "Search spaces" : "Search people"}
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

				{tab === "spaces" ? (
					loading && results.length === 0 ? (
						<LoadingState />
					) : visible.length === 0 ? (
						<EmptyState
							query={query}
							everythingJoined={publicSpaces.length > 0 && !query}
							kind="spaces"
						/>
					) : (
						<div className="rounded-2xl bg-card/60 backdrop-blur-xl border border-foreground/10 overflow-hidden">
							{visible.map((entry, idx) => (
								<SpaceRow
									key={entry.roomId}
									entry={entry}
									transport={transport}
									joined={joinedIds.has(entry.roomId)}
									joining={joining === entry.roomId}
									onJoin={() => handleJoin(entry)}
									onFlag={accessToken ? () => setFlagDialog(entry) : undefined}
									showDivider={idx > 0}
								/>
							))}
						</div>
					)
				) : (
					peopleLoading && people.length === 0 ? (
						<LoadingState />
					) : visiblePeople.length === 0 ? (
						<EmptyState query={query} everythingJoined={false} kind="people" />
					) : (
						<div className="rounded-2xl bg-card/60 backdrop-blur-xl border border-foreground/10 overflow-hidden">
							{visiblePeople.map((user, idx) => (
								<PersonRow
									key={user.user_id}
									user={user}
									transport={transport}
									serverName={serverName}
									onMessage={onStartDm ? () => onStartDm(user.user_id as UserId) : undefined}
									showDivider={idx > 0}
								/>
							))}
						</div>
					)
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

function SpaceRow({
	entry, transport, joined, joining, onJoin, onFlag, showDivider,
}: {
	entry: PublicEntry;
	transport: MatrixTransport | null;
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
	const creator = useResolvedUser(transport, entry.creatorId);
	return (
		<>
			{showDivider && <div className="h-px bg-foreground/[0.08]" aria-hidden />}
			<div className="px-4 py-3.5">
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

				<div className="flex items-center gap-2 mt-3">
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
						{entry.nsfw && (
							<MetaPill tone="destructive">NSFW</MetaPill>
						)}
					</div>

					<div className="flex-1 flex items-center justify-center gap-1.5 min-w-0">
						{creator && (
							<>
								<MatrixAvatar
									mxc={creator.avatarMxc}
									seed={entry.creatorId!}
									kind="user"
									className="h-5 w-5 rounded-full shrink-0"
								/>
								<span className="text-[13px] text-muted-foreground truncate">
									{creator.displayName}
								</span>
							</>
						)}
					</div>

					<div className="shrink-0">
						{joined ? (
							<span className="inline-flex items-center gap-1 px-3 h-7 rounded-full bg-foreground/[0.08] text-[13px] font-semibold text-muted-foreground">
								<Check className="size-[14px]" strokeWidth={2.75} /> Joined
							</span>
						) : (
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
								{joining ? "Joining..." : "Join"}
							</button>
						)}
					</div>
				</div>
			</div>
		</>
	);
}


function PersonRow({
	user, transport, serverName, onMessage, showDivider,
}: {
	user: DirectoryUser;
	transport: MatrixTransport | null;
	serverName?: string;
	onMessage?(): void;
	showDivider: boolean;
}) {
	const resolved = useResolvedUser(transport, user.user_id);
	const displayName = resolved?.displayName ?? user.user_id.slice(1, user.user_id.indexOf(":"));
	const handle = formatMxid(user.user_id, serverName);

	return (
		<>
			{showDivider && <div className="h-px bg-foreground/[0.08]" aria-hidden />}
			<div className="px-4 py-3.5">
				<div className="flex items-center gap-3">
					<MatrixAvatar
						mxc={resolved?.avatarMxc}
						seed={user.user_id}
						kind="user"
						className="h-12 w-12 rounded-full shrink-0"
					/>
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-1.5">
							<span className="text-[17px] font-semibold text-foreground truncate">{displayName}</span>
							{user.founder_number != null && (
								<FounderBadge number={user.founder_number} />
							)}
						</div>
						<div className="text-[13px] text-muted-foreground leading-snug mt-0.5 truncate">
							{handle}
						</div>
						{user.bio && (
							<div className="text-[14px] text-foreground/80 leading-snug mt-1 line-clamp-2">
								{user.bio}
							</div>
						)}
					</div>
					{onMessage && (
						<button
							type="button"
							onClick={() => { void hapticImpact("light"); onMessage(); }}
							className={cn(
								"shrink-0 px-4 h-7 rounded-full",
								"bg-primary/15 text-primary text-[13px] font-semibold tracking-tight",
								"active:opacity-70 transition-opacity",
							)}
						>
							Message
						</button>
					)}
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

function EmptyState({ query, everythingJoined, kind }: { query: string; everythingJoined: boolean; kind: "spaces" | "people" }) {
	const heading = query
		? "No matches"
		: everythingJoined
			? "You're all caught up"
			: kind === "spaces"
				? "Nothing public yet"
				: "No discoverable users yet";
	const body = query
		? "Try a different search term, or check back later."
		: everythingJoined
			? "You've joined every public space on this server. New ones will show up here as they appear."
			: kind === "spaces"
				? "When the operator publishes a space to this server, it'll show up here."
				: "When users join this server, they'll appear here.";
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

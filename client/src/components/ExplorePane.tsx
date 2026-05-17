// Explore — homeserver public-directory browser.  Renders in the chat
// pane when the Explore tile is active in the SpaceBar.  Two tabs:
// Spaces (public directory) and People (user directory).

import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { FounderBadge } from "@/components/FounderBadge";
import { FlagDialog } from "@/components/FlagDialog";
import { cn } from "@/lib/utils";
import { Check, Compass, Flag, Hash, MessageCircle, Search, Users } from "lucide-react";
import type { MatrixTransport } from "@/lib/matrix";
import type { FlagCategory, Room, RoomId, Space, UserId } from "@koven/shared";
import { fetchRoomIcons, fetchUserDirectory, flagRoom } from "@/lib/instance";
import type { DirectoryUser } from "@/lib/instance";
import { useResolvedUser } from "@/lib/useResolvedUser";
import { formatMxid, serverOf } from "@/lib/mxid";

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

export interface ExplorePaneProps {
	transport: MatrixTransport | null;
	rooms: Room[];
	spaces: Space[];
	onJoined(roomId: RoomId, isSpace: boolean): void;
	accessToken: string | null;
	showNsfw: boolean;
	onStartDm?(userId: UserId): void;
}

export function ExplorePane({
	transport, rooms, spaces, onJoined,
	accessToken,
	showNsfw,
	onStartDm,
}: ExplorePaneProps) {
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
	const [peopleTotal, setPeopleTotal] = useState(0);
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
				setPeopleTotal(r.total);
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

	const visible = useMemo(() => {
		let liveResults = results;
		if (!showNsfw) {
			liveResults = liveResults.filter(r => !r.nsfw);
		}
		return liveResults.filter(r => r.isSpace);
	}, [results, showNsfw]);

	const visiblePeople = useMemo(
		() => people.filter(u => u.user_id !== currentUserId),
		[people, currentUserId],
	);

	async function handleJoin(entry: PublicEntry) {
		if (!transport) return;
		setJoining(entry.roomId);
		setError(null);
		try {
			if (entry.isSpace) {
				const r = await transport.joinSpaceWithChildren(entry.roomId);
				onJoined(r.spaceId, true);
			} else {
				const id = await transport.joinRoomById(entry.roomId);
				onJoined(id, false);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setJoining(null);
		}
	}

	return (
		<div className="flex-1 overflow-y-auto">
			<div className="max-w-3xl mx-auto px-6 py-8 w-full space-y-5">
				<header className="flex flex-col items-center text-center">
					<div className="h-16 w-16 rounded-2xl bg-primary/15 flex items-center justify-center mb-3">
						<Compass className="h-8 w-8 text-primary" />
					</div>
					<h1 className="text-2xl font-semibold">Explore</h1>
					<p className="text-sm text-muted-foreground mt-1 max-w-md">
						{tab === "spaces"
							? "Browse public spaces anyone can join on this server."
							: "Discover people on this server."}
					</p>
				</header>

				<div className="flex items-center justify-center gap-1 p-1 rounded-lg bg-muted/50 w-fit mx-auto">
					<button
						type="button"
						onClick={() => setTab("spaces")}
						className={cn(
							"px-4 py-1.5 rounded-md text-sm font-medium transition-colors",
							tab === "spaces"
								? "bg-primary text-primary-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						Spaces
					</button>
					<button
						type="button"
						onClick={() => setTab("people")}
						className={cn(
							"px-4 py-1.5 rounded-md text-sm font-medium transition-colors",
							tab === "people"
								? "bg-primary text-primary-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						People
					</button>
				</div>

				<div className="relative">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
					<Input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={tab === "spaces" ? "Search by name or topic" : "Search by username or bio"}
						autoFocus
						className="pl-9"
					/>
				</div>

				{error && (
					<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
						{error}
					</div>
				)}

				{tab === "spaces" ? (
					loading && results.length === 0 ? (
						<div className="text-sm text-muted-foreground text-center py-10">Loading directory…</div>
					) : visible.length === 0 ? (
						<div className="text-sm text-muted-foreground text-center py-10">
							{query ? "No matches for that search." : "Nothing public yet on this server."}
						</div>
					) : (
						<div className="rounded-lg border border-border divide-y divide-border bg-card">
							{visible.map(entry => (
								<SpaceRow
									key={entry.roomId}
									entry={entry}
									transport={transport}
									joined={joinedIds.has(entry.roomId)}
									joining={joining === entry.roomId}
									onJoin={() => handleJoin(entry)}
									onFlag={accessToken ? () => setFlagDialog(entry) : undefined}
								/>
							))}
						</div>
					)
				) : (
					peopleLoading && people.length === 0 ? (
						<div className="text-sm text-muted-foreground text-center py-10">Loading directory…</div>
					) : visiblePeople.length === 0 ? (
						<div className="text-sm text-muted-foreground text-center py-10">
							{query ? "No matches for that search." : "No discoverable users yet."}
						</div>
					) : (
						<div className="rounded-lg border border-border divide-y divide-border bg-card">
							{visiblePeople.map(user => (
								<PersonRow
									key={user.user_id}
									user={user}
									transport={transport}
									serverName={serverName}
									onMessage={onStartDm ? () => onStartDm(user.user_id as UserId) : undefined}
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
	entry, transport, joined, joining, onJoin, onFlag,
}: {
	entry: PublicEntry;
	transport: MatrixTransport | null;
	joined: boolean;
	joining: boolean;
	onJoin(): void;
	onFlag?(): void;
}) {
	const creator = useResolvedUser(transport, entry.creatorId);
	return (
		<div className="flex items-start gap-3 px-3 py-3">
			<MatrixAvatar
				mxc={entry.avatarUrl}
				emoji={entry.iconEmoji}
				seed={entry.roomId}
				kind={entry.isSpace ? "space" : "room"}
				className={cn("shrink-0", entry.isSpace ? "h-10 w-10 rounded-lg" : "h-10 w-10 rounded-md")}
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="font-medium text-sm truncate">{entry.name}</span>
					<span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
						{entry.isSpace ? "Space" : "Room"}
					</span>
					{entry.nsfw && (
						<span className="text-[10px] uppercase tracking-wide text-destructive bg-destructive/10 border border-destructive/30 px-1.5 py-0.5 rounded">
							NSFW
						</span>
					)}
					{creator && (
						<span className="inline-flex items-center gap-1 ml-auto text-xs text-muted-foreground">
							<MatrixAvatar
								mxc={creator.avatarMxc}
								seed={entry.creatorId!}
								kind="user"
								className="h-4 w-4 rounded-full"
							/>
							<span className="truncate max-w-[120px]">{creator.displayName}</span>
						</span>
					)}
				</div>
				<div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
					<Users className="h-3 w-3" />
					<span>{entry.memberCount} {entry.memberCount === 1 ? "member" : "members"}</span>
					{entry.isSpace && entry.roomCount !== undefined && (
						<>
							<span>·</span>
							<Hash className="h-3 w-3" />
							<span>{entry.roomCount} {entry.roomCount === 1 ? "room" : "rooms"}</span>
						</>
					)}
				</div>
				{entry.topic && (
					<div className="text-xs text-muted-foreground/80 mt-0.5 truncate">
						{entry.topic}
					</div>
				)}
			</div>
			<div className="shrink-0 flex items-center gap-1.5">
				{onFlag && (
					<button
						type="button"
						onClick={onFlag}
						className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
						title="Flag this room"
						aria-label="Flag this room"
					>
						<Flag className="h-3.5 w-3.5" />
					</button>
				)}
				{joined ? (
					<span className="inline-flex items-center gap-1 text-xs text-emerald-500/90">
						<Check className="h-3.5 w-3.5" /> Joined
					</span>
				) : (
					<Button type="button" size="sm" onClick={onJoin} disabled={joining}>
						{joining ? "Joining…" : "Join"}
					</Button>
				)}
			</div>
		</div>
	);
}


function PersonRow({
	user, transport, serverName, onMessage,
}: {
	user: DirectoryUser;
	transport: MatrixTransport | null;
	serverName?: string;
	onMessage?(): void;
}) {
	const resolved = useResolvedUser(transport, user.user_id);
	const displayName = resolved?.displayName ?? user.user_id.slice(1, user.user_id.indexOf(":"));
	const handle = formatMxid(user.user_id, serverName);

	return (
		<div className="flex items-center gap-3 px-3 py-3">
			<MatrixAvatar
				mxc={resolved?.avatarMxc}
				seed={user.user_id}
				kind="user"
				className="h-10 w-10 rounded-full shrink-0"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="font-medium text-sm truncate">{displayName}</span>
					{user.founder_number != null && (
						<FounderBadge number={user.founder_number} />
					)}
				</div>
				<div className="text-xs text-muted-foreground truncate">
					{handle}
					{user.bio && <> · {user.bio}</>}
				</div>
			</div>
			{onMessage && (
				<Button type="button" size="sm" variant="ghost" onClick={onMessage} className="shrink-0">
					<MessageCircle className="h-3.5 w-3.5 mr-1.5" />
					Message
				</Button>
			)}
		</div>
	);
}

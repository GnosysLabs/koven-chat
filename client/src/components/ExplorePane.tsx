// Explore — homeserver public-directory browser.  Renders in the chat
// pane when the Explore tile is active in the SpaceBar.  Lets the
// user search, filter Spaces vs Rooms, and one-click join.  Already-
// joined entries are tagged so we don't trigger a duplicate join (the
// SDK no-ops anyway, but the UX is cleaner).

import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { FlagDialog } from "@/components/FlagDialog";
import { cn } from "@/lib/utils";
import { Check, Compass, Flag, Hash, Search, Users } from "lucide-react";
import type { MatrixTransport } from "@/lib/matrix";
import type { FlagCategory, Room, RoomId, Space } from "@koven/shared";
import { fetchRoomIcons, flagRoom } from "@/lib/instance";

interface PublicEntry {
	roomId: RoomId;
	name: string;
	topic?: string;
	avatarUrl?: string;
	// Founder-picked emoji icon.  Synapse's public-rooms directory
	// doesn't surface custom state events, so we backfill this from
	// the engine's /api/rooms/icons batch endpoint after the directory
	// query lands.  Undefined means either no emoji is set or we
	// haven't fetched yet — MatrixAvatar treats it the same way.
	iconEmoji?: string;
	memberCount: number;
	isSpace: boolean;
	joinRule: string;
	// Only set for spaces — number of leaf rooms inside the space.
	// undefined for non-spaces.
	roomCount?: number;
	// Founder marked this room/space as adult-content via
	// `chat.koven.nsfw`.  Same batched backfill as iconEmoji.
	nsfw?: boolean;
}

export interface ExplorePaneProps {
	transport: MatrixTransport | null;
	rooms: Room[];      // joined rooms — used to mark "Joined" rows
	spaces: Space[];    // joined spaces — same
	onJoined(roomId: RoomId, isSpace: boolean): void;
	// Engine-issued bearer for the current user, used by the flag-room
	// HTTP endpoint.  When null the per-tile flag affordance is hidden
	// (a logged-out user can browse Explore but can't flag).
	accessToken: string | null;
	// Whether the viewer has opted into seeing NSFW-flagged rooms +
	// spaces.  When false (the default), Explore filters them out
	// entirely.  When true, they appear with a small badge so the
	// flag is visible at a glance.
	showNsfw: boolean;
}

export function ExplorePane({
	transport, rooms, spaces, onJoined,
	accessToken,
	showNsfw,
}: ExplorePaneProps) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<PublicEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [joining, setJoining] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [flagDialog, setFlagDialog] = useState<PublicEntry | null>(null);
	const searchDebounceRef = useRef<number | null>(null);

	// Initial load + debounced research as the query changes.  Public
	// directory queries are cheap on Synapse but we still don't want
	// to flood it on every keystroke.  We use discoverDirectory rather
	// than the raw discoverPublicRooms so child rooms of any space
	// are folded into their parent and don't appear as standalone
	// entries — those rooms surface through the space, not separately.
	useEffect(() => {
		if (!transport) return;
		if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current);
		searchDebounceRef.current = window.setTimeout(async () => {
			setLoading(true);
			setError(null);
			try {
				// Directory query first — icon fetch needs the room id
				// list to know what to look up.  Two-step rather than
				// truly parallel because the engine endpoint takes a
				// list and we don't have the list until publicRooms
				// returns.  In practice the directory call dominates;
				// the icons call is a single batched state-event read
				// per room (sub-100ms typical) tacked onto the end.
				//
				// We await both before setResults so the entries paint
				// once, with the right icon already attached.  The
				// earlier fire-and-forget version flashed DiceBear
				// avatars and then snapped to emojis a moment later,
				// which read as jank.  A failed icons fetch falls
				// through to the empty map — emoji-iconed rooms then
				// briefly show DiceBear, but only on engine outage.
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

	const visible = useMemo(() => {
		// NSFW gate.  When the viewer hasn't opted in, drop every
		// NSFW-flagged entry from the directory entirely.  When they
		// have opted in, all entries flow through; the badge on each
		// tile communicates which ones carry the flag.
		let liveResults = results;
		if (!showNsfw) {
			liveResults = liveResults.filter(r => !r.nsfw);
		}
		// Discord-style: Explore only surfaces SPACES (servers).  Rooms
		// live inside their parent space and inherit its visibility, so
		// listing them as separate Explore entries duplicates the space
		// and confuses discovery.
		return liveResults.filter(r => r.isSpace);
	}, [results, showNsfw]);

	async function handleJoin(entry: PublicEntry) {
		if (!transport) return;
		setJoining(entry.roomId);
		setError(null);
		try {
			if (entry.isSpace) {
				// Discord-style: joining a space also joins every
				// public child room so the user lands on a populated
				// space rather than an empty one.
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
						Browse public spaces anyone can join on this server.
					</p>
				</header>

				<div className="relative">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
					<Input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search by name or topic"
						autoFocus
						className="pl-9"
					/>
				</div>

				{error && (
					<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
						{error}
					</div>
				)}

				{loading && results.length === 0 ? (
					<div className="text-sm text-muted-foreground text-center py-10">Loading directory…</div>
				) : visible.length === 0 ? (
					<div className="text-sm text-muted-foreground text-center py-10">
						{query ? "No matches for that search." : "Nothing public yet on this server."}
					</div>
				) : (
					<div className="rounded-lg border border-border divide-y divide-border bg-card">
						{visible.map(entry => (
							<EntryRow
								key={entry.roomId}
								entry={entry}
								joined={joinedIds.has(entry.roomId)}
								joining={joining === entry.roomId}
								onJoin={() => handleJoin(entry)}
								onFlag={accessToken ? () => setFlagDialog(entry) : undefined}
							/>
						))}
					</div>
				)}
			</div>

			{/* Report-this-room dialog.  Shared FlagDialog component with
			    target="room" so users see room-specific copy. */}
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
	entry, joined, joining, onJoin, onFlag,
}: {
	entry: PublicEntry;
	joined: boolean;
	joining: boolean;
	onJoin(): void;
	// When set, renders a small flag affordance on the tile (logged-in
	// users only — flagging is gated on a Matrix token in the engine).
	onFlag?(): void;
}) {
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
					{entry.topic && (
						<>
							<span>·</span>
							<span className="truncate">{entry.topic}</span>
						</>
					)}
				</div>
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

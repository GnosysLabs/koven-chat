// Picker that adds a room the user CREATED to a space.
//
// Lists every room the viewer is the founder/creator of, minus:
//   * DMs (servers don't list 1-on-1 conversations as channels)
//   * the space itself (can't file a space under its own children)
//   * other spaces (no sub-space affordance from this surface)
//   * rooms that are ALREADY children of any joined space (would
//     either be a no-op state event for THIS space, or steal the
//     room from a sibling server — neither what the user wants)
//
// We restrict to rooms the viewer created because:
//   1. m.space.parent on the room requires PL ≥ 50 to write —
//      anything else fails silently and you get a half-linked
//      room (child on the space, no parent on the room).
//   2. Adding someone else's room to your server without their say-so
//      is weird socially.  Even though Matrix allows the space-side
//      to claim a room as a child, the room's actual founder didn't
//      ask to be filed under your community.
//
// Single-select for now — pick a room, click Add, done.

import { useMemo, useState } from "react";
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
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { Search, Hash } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Room, RoomId, Space } from "@koven/shared";

export interface AddExistingRoomDialogProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	// The space we're adding a room to.  Used to filter out the
	// space itself + already-child rooms from the candidate list.
	space: Space | null;
	// All rooms the user is in.  We filter client-side rather than
	// asking the engine because the user only ever picks from rooms
	// they can already see; no privacy implications.
	rooms: Room[];
	// Other joined spaces — used to filter out their children too,
	// because we already prefer to keep a room in one server only
	// (cross-server children are valid Matrix but make navigation
	// confusing).  Optional — passing nothing just disables the
	// cross-space dedupe.
	otherSpaces?: Space[];
	// Viewer's mxid — used to filter the candidate list to rooms
	// they actually founded.  See file-level comment for rationale.
	currentUserId: string | null;
	onAdd(roomId: RoomId): Promise<void>;
}

export function AddExistingRoomDialog({
	open, onOpenChange, space, rooms, otherSpaces, currentUserId, onAdd,
}: AddExistingRoomDialogProps) {
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<RoomId | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Reset transient state every time the dialog re-opens so a
	// previous error doesn't linger.
	const reset = () => {
		setQuery("");
		setSelected(null);
		setPending(false);
		setError(null);
	};

	function handleOpenChange(o: boolean) {
		if (!pending) onOpenChange(o);
		if (!o) reset();
	}

	const childIdSet = useMemo(() => {
		const s = new Set<string>(space?.childRoomIds ?? []);
		// Anything already filed under another joined space — see the
		// otherSpaces docstring above.
		for (const sp of otherSpaces ?? []) {
			if (sp.id === space?.id) continue;
			for (const id of sp.childRoomIds) s.add(id);
		}
		return s;
	}, [space, otherSpaces]);

	const candidates = useMemo<Room[]>(() => {
		const q = query.trim().toLowerCase();
		const out: Room[] = [];
		for (const r of rooms) {
			if (r.kind === "dm") continue;
			if (r.id === space?.id) continue;
			if (childIdSet.has(r.id)) continue;
			// Founder-only.  Adding someone else's room to your space
			// is socially weird and the m.space.parent state event on
			// the room would fail to write anyway (PL gated).
			if (!currentUserId || r.creatorId !== currentUserId) continue;
			if (q) {
				const hay = `${r.name} ${r.topic ?? ""}`.toLowerCase();
				if (!hay.includes(q)) continue;
			}
			out.push(r);
		}
		// Sort alpha for stable ordering — search filtering already
		// narrows; alphabetical inside is more predictable than
		// last-active for "find a specific known room."
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}, [rooms, space, childIdSet, currentUserId, query]);

	async function commit() {
		if (!selected) return;
		setPending(true);
		setError(null);
		try {
			await onAdd(selected);
			handleOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPending(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Add an existing room</DialogTitle>
					<DialogDescription>
						Pick a room you&rsquo;re already in to file under {space?.name ?? "this space"}. Members of the space will be invited automatically.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<div className="relative">
						<Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
						<Input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search your rooms"
							className="pl-8"
							autoFocus
						/>
					</div>

					<div className="max-h-72 overflow-y-auto rounded-md border border-border bg-muted/20">
						{candidates.length === 0 ? (
							<div className="text-xs text-muted-foreground italic p-4 text-center">
								{rooms.length === 0
									? "You haven't created any rooms yet."
									: query.trim()
										? "No matching rooms."
										: "No eligible rooms — only rooms you created and that aren't already in a space can be added."}
							</div>
						) : (
							<ul>
								{candidates.map(r => {
									const isActive = r.id === selected;
									return (
										<li key={r.id}>
											<button
												type="button"
												onClick={() => setSelected(r.id)}
												className={cn(
													"w-full text-left flex items-center gap-2.5 px-3 py-2 transition-colors",
													isActive
														? "bg-primary/15 hover:bg-primary/15"
														: "hover:bg-accent",
												)}
											>
												<MatrixAvatar
													mxc={r.avatarUrl}
													emoji={r.iconEmoji}
													seed={r.id}
													kind="room"
													className="h-7 w-7 rounded-md"
												/>
												<div className="flex-1 min-w-0">
													<div className="text-sm font-medium truncate flex items-center gap-1.5">
														<Hash className="h-3 w-3 text-muted-foreground shrink-0" />
														{r.name}
													</div>
													{r.topic && (
														<div className="text-xs text-muted-foreground truncate">{r.topic}</div>
													)}
												</div>
											</button>
										</li>
									);
								})}
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
					<Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={pending}>
						Cancel
					</Button>
					<Button type="button" onClick={commit} disabled={!selected || pending}>
						{pending ? "Adding…" : "Add to space"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

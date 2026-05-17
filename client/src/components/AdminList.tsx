// Left sidebar for the admin page. Lists the user's moderated spaces
// (PL >= 50) plus an "Instance" item for server admins. Selection
// drives what the AdminPane shows in the content area. Same visual
// pattern as BotList: w-60, header row, scrollable list with
// pill-on-left active indicator.

import { useEffect, useMemo } from "react";
import { Globe, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import type { Room, Space, SpaceId } from "@koven/shared";

export type AdminSelection =
	| { kind: "instance" }
	| { kind: "space"; spaceId: SpaceId }
	| null;

export interface AdminListProps {
	spaces: Space[];
	rooms: Room[];
	isAdmin: boolean;
	selected: AdminSelection;
	onSelect(selection: AdminSelection): void;
}

export function AdminList({
	spaces, rooms, isAdmin, selected, onSelect,
}: AdminListProps) {
	const moderatedSpaces = useMemo(() => {
		return spaces.filter(space => {
			if ((space.myPowerLevel ?? 0) >= 50) return true;
			return rooms.some(
				r => r.parentSpaceIds.includes(space.id) && (r.myPowerLevel ?? 0) >= 50,
			);
		});
	}, [spaces, rooms]);

	useEffect(() => {
		if (selected) return;
		if (isAdmin) {
			onSelect({ kind: "instance" });
		} else {
			const first = moderatedSpaces[0];
			if (first) onSelect({ kind: "space", spaceId: first.id as SpaceId });
		}
	}, [selected, isAdmin, moderatedSpaces, onSelect]);

	const instanceActive = selected?.kind === "instance";

	return (
		<aside className="w-60 shrink-0 bg-card border-r border-border flex flex-col">
			<div className="h-12 px-4 flex items-center justify-between border-b border-border">
				<span className="text-sm font-semibold">Admin</span>
				<Shield className="h-4 w-4 text-muted-foreground" />
			</div>

			<div className="flex-1 overflow-y-auto p-2 space-y-0.5">
				{isAdmin && (
					<button
						type="button"
						onClick={() => onSelect({ kind: "instance" })}
						className={cn(
							"relative w-full flex items-center gap-3 px-3 py-2 rounded-md text-left transition-colors",
							"hover:bg-accent",
							instanceActive && "bg-accent",
						)}
					>
						<span
							className={cn(
								"absolute left-0 top-1/2 -translate-y-1/2 w-1 rounded-r-full bg-primary transition-all",
								instanceActive ? "h-6 opacity-100" : "h-0 opacity-0",
							)}
							aria-hidden
						/>
						<div className="h-8 w-8 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
							<Globe className="h-4 w-4 text-primary" />
						</div>
						<span className="text-sm font-medium truncate">Instance</span>
					</button>
				)}

				{moderatedSpaces.length > 0 && isAdmin && (
					<div className="h-px bg-border mx-2 my-1" />
				)}

				{moderatedSpaces.map(space => {
					const active = selected?.kind === "space" && selected.spaceId === space.id;
					return (
						<button
							key={space.id}
							type="button"
							onClick={() => onSelect({ kind: "space", spaceId: space.id as SpaceId })}
							className={cn(
								"relative w-full flex items-center gap-3 px-3 py-2 rounded-md text-left transition-colors",
								"hover:bg-accent",
								active && "bg-accent",
							)}
						>
							<span
								className={cn(
									"absolute left-0 top-1/2 -translate-y-1/2 w-1 rounded-r-full bg-primary transition-all",
									active ? "h-6 opacity-100" : "h-0 opacity-0",
								)}
								aria-hidden
							/>
							<MatrixAvatar
								mxc={space.avatarUrl}
								seed={space.id}
								className="h-8 w-8 shrink-0 rounded-lg"
							/>
							<span className="text-sm font-medium truncate">{space.name}</span>
						</button>
					);
				})}

				{!isAdmin && moderatedSpaces.length === 0 && (
					<div className="px-2 py-4 text-xs text-muted-foreground leading-relaxed">
						No spaces to moderate. You need PL 50+ in a space to see reports here.
					</div>
				)}
			</div>
		</aside>
	);
}

// Member list — the right sidebar of a room.  Two-section split by
// presence: "Online" (active or recently active) above, "Offline"
// below.  No power-level grouping — Koven doesn't have a moderator
// tier (community moderation lives in the engine), so PL distinctions
// other than "creator" don't carry meaning in the UI.  Bots always
// render as online; the engine keeps them connected and they don't
// emit Matrix presence in a way the SDK reflects reliably.

import { cn } from "@/lib/utils";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { RepBadge } from "@/components/RepBadge";
import { BotBadge } from "@/components/BotBadge";
import type { Member } from "@koven/shared";

export interface MemberListProps {
	members: Member[];
	currentUserId: string | null;
	onSelectMember(userId: string): void;
	// mxids in this Set render with a BOT pill next to the name AND
	// override their presence to "online" (bots are always live as
	// long as the engine is up).  Optional.
	botMxids?: Set<string>;
}

/** Effective presence for a member.  Bots always read as online;
 * everyone else uses the SDK-reported value (or "offline" if we
 * haven't observed presence for them yet). */
function effectivePresence(m: Member, isBot: boolean): "online" | "unavailable" | "offline" {
	if (isBot) return "online";
	return m.presence ?? "offline";
}

/** Online section catches both "online" (active right now) and
 * "unavailable" (logged in but idle).  Both feel like "they're
 * around"; offline is the only meaningfully different bucket. */
function isInOnlineSection(p: ReturnType<typeof effectivePresence>): boolean {
	return p === "online" || p === "unavailable";
}

export function MemberList({ members, currentUserId, onSelectMember, botMxids }: MemberListProps) {
	const decorated = members.map(m => {
		const isBot = !!botMxids?.has(m.userId);
		return { m, isBot, presence: effectivePresence(m, isBot) };
	});

	// Sort: bots first within each section (the engine keeps them
	// online, they're often the most relevant participant), then
	// alphabetical by display name.  Power level is intentionally
	// not part of the sort — see the file header.
	const sortRows = (a: typeof decorated[number], b: typeof decorated[number]) => {
		if (a.isBot !== b.isBot) return a.isBot ? -1 : 1;
		return a.m.displayName.localeCompare(b.m.displayName);
	};

	const online = decorated.filter(d => isInOnlineSection(d.presence)).sort(sortRows);
	const offline = decorated.filter(d => !isInOnlineSection(d.presence)).sort(sortRows);

	return (
		<aside className="w-56 border-l border-border bg-card flex flex-col">
			<div className="px-4 h-12 flex items-center border-b border-border">
				<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
					Members &middot; {members.length}
				</span>
			</div>
			<div className="flex-1 overflow-y-auto py-2">
				{members.length === 0 ? (
					<div className="text-xs text-muted-foreground px-4 py-3">No members.</div>
				) : (
					<>
						{online.length > 0 && (
							<Section label="Online" count={online.length}>
								{online.map(d => (
									<MemberRow
										key={d.m.userId}
										member={d.m}
										isSelf={d.m.userId === currentUserId}
										isBot={d.isBot}
										presence={d.presence}
										onClick={() => onSelectMember(d.m.userId)}
									/>
								))}
							</Section>
						)}
						{offline.length > 0 && (
							<Section label="Offline" count={offline.length} muted>
								{offline.map(d => (
									<MemberRow
										key={d.m.userId}
										member={d.m}
										isSelf={d.m.userId === currentUserId}
										isBot={d.isBot}
										presence={d.presence}
										onClick={() => onSelectMember(d.m.userId)}
									/>
								))}
							</Section>
						)}
					</>
				)}
			</div>
		</aside>
	);
}

function Section({
	label, count, muted, children,
}: {
	label: string;
	count: number;
	muted?: boolean;
	children: React.ReactNode;
}) {
	return (
		<section className="mb-3">
			<h3 className="px-4 mb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
				{label} &middot; {count}
			</h3>
			<ul className={muted ? "opacity-70" : undefined}>{children}</ul>
		</section>
	);
}

function MemberRow({
	member, isSelf, isBot, presence, onClick,
}: {
	member: Member;
	isSelf: boolean;
	isBot: boolean;
	presence: "online" | "unavailable" | "offline";
	onClick(): void;
}) {
	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				className={cn(
					"w-full px-4 py-1 flex items-center gap-2 text-sm text-left hover:bg-accent transition-colors",
					isSelf && "font-medium",
					presence === "offline" && "text-muted-foreground",
				)}
				title={member.userId}
			>
				<Avatar member={member} isBot={isBot} presence={presence} />
				<span className="flex-1 truncate flex items-center gap-1.5">
					<span className="truncate">{member.displayName}</span>
					{isBot && <BotBadge />}
				</span>
				{!isBot && <RepBadge userId={member.userId} />}
			</button>
		</li>
	);
}

function Avatar({
	member, isBot, presence,
}: {
	member: Member;
	isBot: boolean;
	presence: "online" | "unavailable" | "offline";
}) {
	// Status dot overlays the bottom-right of the avatar.  Color
	// codes:
	//   - online      = solid green (active right now)
	//   - unavailable = amber (logged in but idle / recently
	//                   active — the matrix-spec equivalent of
	//                   "away")
	//   - offline     = empty / grey ring (don't draw a dot at all,
	//                   keeps the avatar gutter quiet for the
	//                   majority case in most rooms)
	const dotClass =
		presence === "online" ? "bg-green-500"
		: presence === "unavailable" ? "bg-amber-500"
		: null;
	return (
		<span className="relative shrink-0">
			<MatrixAvatar
				mxc={member.avatarUrl}
				seed={member.userId}
				kind={isBot ? "bot" : "user"}
				className={cn(
					"h-6 w-6",
					presence === "offline" && !isBot && "grayscale opacity-70",
				)}
			/>
			{dotClass && (
				<span
					className={cn(
						"absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-card",
						dotClass,
					)}
					aria-hidden
				/>
			)}
		</span>
	);
}

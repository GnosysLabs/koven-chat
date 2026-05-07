// Member list — the right sidebar of a room.  Shows joined members
// grouped by power level: founder → admin → mod → member.  Reputation
// badges are placeholder for now (engine not wired); positioned for
// when governance state plugs in.

import { cn } from "@/lib/utils";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { RepBadge } from "@/components/RepBadge";
import { BotBadge } from "@/components/BotBadge";
import type { Member } from "@koven/shared";
import { Crown, Shield, Star } from "lucide-react";

export interface MemberListProps {
	members: Member[];
	currentUserId: string | null;
	onSelectMember(userId: string): void;
	// mxids in this Set render with a BOT pill next to the name.
	// Optional — defaults to no badges.
	botMxids?: Set<string>;
}

interface MemberGroup {
	label: string;
	members: Member[];
}

function groupMembers(members: Member[]): MemberGroup[] {
	const founder: Member[] = [];
	const admins: Member[] = [];
	const mods: Member[] = [];
	const regular: Member[] = [];
	for (const m of members) {
		if (m.powerLevel >= 100) founder.push(m);
		else if (m.powerLevel >= 75) admins.push(m);
		else if (m.powerLevel >= 50) mods.push(m);
		else regular.push(m);
	}
	return [
		{ label: "Founder",        members: founder },
		{ label: "Administrators", members: admins },
		{ label: "Moderators",     members: mods },
		{ label: "Members",        members: regular },
	].filter(g => g.members.length > 0);
}

export function MemberList({ members, currentUserId, onSelectMember, botMxids }: MemberListProps) {
	const groups = groupMembers(members);
	const total = members.length;

	return (
		<aside className="w-56 border-l border-border bg-card flex flex-col">
			<div className="px-4 h-12 flex items-center border-b border-border">
				<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
					Members &middot; {total}
				</span>
			</div>
			<div className="flex-1 overflow-y-auto py-2">
				{groups.length === 0 ? (
					<div className="text-xs text-muted-foreground px-4 py-3">No members.</div>
				) : (
					groups.map(group => (
						<section key={group.label} className="mb-3">
							<h3 className="px-4 mb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
								{group.label} &middot; {group.members.length}
							</h3>
							<ul>
								{group.members.map(m => (
									<MemberRow
										key={m.userId}
										member={m}
										isSelf={m.userId === currentUserId}
										isBot={!!botMxids?.has(m.userId)}
										onClick={() => onSelectMember(m.userId)}
									/>
								))}
							</ul>
						</section>
					))
				)}
			</div>
		</aside>
	);
}

function MemberRow({ member, isSelf, isBot, onClick }: { member: Member; isSelf: boolean; isBot: boolean; onClick(): void }) {
	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				className={cn(
					"w-full px-4 py-1 flex items-center gap-2 text-sm text-left hover:bg-accent transition-colors",
					isSelf && "font-medium"
				)}
				title={member.userId}
			>
				<Avatar member={member} isBot={isBot} />
				<span className="flex-1 truncate flex items-center gap-1.5">
					<span className="truncate">{member.displayName}</span>
					{isBot && <BotBadge />}
				</span>
				<RoleIcon powerLevel={member.powerLevel} />
				{!isBot && <RepBadge userId={member.userId} />}
			</button>
		</li>
	);
}

function Avatar({ member, isBot }: { member: Member; isBot: boolean }) {
	return (
		<MatrixAvatar
			mxc={member.avatarUrl}
			seed={member.userId}
			kind={isBot ? "bot" : "user"}
			className="h-6 w-6"
		/>
	);
}

function RoleIcon({ powerLevel }: { powerLevel: number }) {
	if (powerLevel >= 100) return <Crown className="h-3 w-3 text-amber-500" aria-label="Founder" />;
	if (powerLevel >= 75) return <Shield className="h-3 w-3 text-blue-500" aria-label="Admin" />;
	if (powerLevel >= 50) return <Star className="h-3 w-3 text-emerald-500" aria-label="Moderator" />;
	return null;
}

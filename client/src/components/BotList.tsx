// Left sidebar list of the user's bots.  Same shape as RoomList:
// a header with a "+" button to start a create flow, then a
// scrollable list where each row selects a bot and reveals its
// configuration in the main pane.
//
// We mirror the RoomList look (no extra trim, no usage counters in
// the list — that's detail-pane territory) so the two sidebars feel
// like siblings.  Click selects; the active row gets the same
// pill-on-the-left treatment used elsewhere in the app.

import { useState } from "react";
import { Copy, MessageSquare, Pencil, Plus, Power, PowerOff, Trash2, User as UserIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { BotBadge } from "@/components/BotBadge";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import type { BotSummary } from "@/lib/bots";

export interface BotListProps {
	// `null` = roster fetch hasn't returned yet; component renders
	// the chrome but no list / no empty-state.  `[]` = loaded, user
	// has no bots → "No bots yet" hint shown.
	bots: BotSummary[] | null;
	loading: boolean;
	error: string | null;
	// Currently-selected bot id, or "new" when the create form is
	// open, or null when the user is on the empty/picker state.
	selectedBotId: number | "new" | null;
	atLimit: boolean;
	onSelectBot(id: number): void;
	onNewBot(): void;
	// Right-click action handlers.  Optional — bots in test fixtures
	// without a transport just see Edit (which routes through
	// onSelectBot) and Copy mxid.
	onSendDmToBot?(mxid: string): void;
	onViewBotProfile?(mxid: string): void;
	onToggleBotEnabled?(id: number, enabled: boolean): void;
	onDeleteBot?(id: number): void;
}

export function BotList({
	bots,
	loading,
	error,
	selectedBotId,
	atLimit,
	onSelectBot,
	onNewBot,
	onSendDmToBot,
	onViewBotProfile,
	onToggleBotEnabled,
	onDeleteBot,
}: BotListProps) {
	return (
		<aside className="w-60 shrink-0 bg-card border-r border-border flex flex-col">
			<div className="h-12 px-3 flex items-center justify-between border-b border-border">
				<span className="text-sm font-semibold">Bots</span>
				<button
					type="button"
					onClick={onNewBot}
					disabled={atLimit}
					title={atLimit ? "Per-user bot limit reached" : "Create a new bot"}
					aria-label="Create a new bot"
					className={cn(
						"h-7 w-7 rounded-md flex items-center justify-center transition-colors",
						"text-muted-foreground hover:text-foreground hover:bg-accent",
						"disabled:opacity-40 disabled:cursor-not-allowed",
						selectedBotId === "new" && "bg-accent text-foreground",
					)}
				>
					<Plus className="h-4 w-4" />
				</button>
			</div>

			<div className="flex-1 overflow-y-auto py-1">
				{bots === null || loading ? (
					// Pre-load: render an empty body rather than a
					// "Loading…" string OR the "No bots yet" CTA.
					// Either text would flash for the brief window
					// before the engine returns the roster, then snap
					// to the real list.
					null
				) : error ? (
					<div className="px-3 py-3 text-xs text-destructive">{error}</div>
				) : bots.length === 0 ? (
					<div className="px-3 py-3 text-xs text-muted-foreground leading-relaxed">
						No bots yet. Click <span className="font-medium text-foreground">+</span> to create one with your own LLM API key.
					</div>
				) : (
					<ul>
						{bots.map(b => (
							<BotRow
								key={b.id}
								bot={b}
								active={selectedBotId === b.id}
								onClick={() => onSelectBot(b.id)}
								onSendDm={onSendDmToBot ? () => onSendDmToBot(b.mxid) : undefined}
								onViewProfile={onViewBotProfile ? () => onViewBotProfile(b.mxid) : undefined}
								onToggleEnabled={onToggleBotEnabled ? () => onToggleBotEnabled(b.id, !b.enabled) : undefined}
								onDelete={onDeleteBot ? () => onDeleteBot(b.id) : undefined}
							/>
						))}
					</ul>
				)}
			</div>

			{atLimit && (
				<div className="px-3 py-2 border-t border-border text-[11px] text-muted-foreground">
					Per-user bot limit reached. Delete a bot to add another.
				</div>
			)}
		</aside>
	);
}

function BotRow({
	bot,
	active,
	onClick,
	onSendDm,
	onViewProfile,
	onToggleEnabled,
	onDelete,
}: {
	bot: BotSummary;
	active: boolean;
	onClick(): void;
	onSendDm?(): void;
	onViewProfile?(): void;
	onToggleEnabled?(): void;
	onDelete?(): void;
}) {
	const [ctxMenuPos, setCtxMenuPos] = useState<{ x: number; y: number } | null>(null);
	return (
		<li className="relative">
			<button
				type="button"
				onClick={onClick}
				onContextMenu={(e) => {
					e.preventDefault();
					e.stopPropagation();
					setCtxMenuPos({ x: e.clientX, y: e.clientY });
				}}
				title={bot.mxid}
				className={cn(
					"w-full px-3 py-2 flex items-center gap-2.5 text-left text-sm relative",
					"hover:bg-accent transition-colors",
					active && "bg-primary/10",
				)}
			>
				{/* Selection rail — pill on the very left edge when active. */}
				<span
					className={cn(
						"absolute left-0 top-1/2 -translate-y-1/2 w-1 rounded-r-full bg-primary transition-all",
						active ? "h-6 opacity-100" : "h-0 opacity-0",
					)}
					aria-hidden
				/>
				<MatrixAvatar
					mxc={bot.avatar_mxc ?? undefined}
					seed={bot.mxid}
					kind="bot"
					className="h-8 w-8 shrink-0"
				/>
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-1.5 min-w-0">
						<span className={cn("truncate", active ? "font-medium" : "")}>
							{bot.display_name}
						</span>
						<BotBadge />
					</div>
					<div className="text-[11px] text-muted-foreground truncate">
						{bot.mxid.replace(/:.*$/, "")}
					</div>
				</div>
				{!bot.enabled && (
					<span className="text-[9px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1 py-px shrink-0">
						Off
					</span>
				)}
			</button>
			{ctxMenuPos && (
				<ContextMenu
					x={ctxMenuPos.x}
					y={ctxMenuPos.y}
					items={[
						{
							label: "Edit bot…",
							icon: <Pencil className="h-4 w-4" />,
							onClick,
						},
						...(onSendDm ? [{
							label: "Send DM to bot",
							icon: <MessageSquare className="h-4 w-4" />,
							onClick: onSendDm,
						} satisfies ContextMenuItem] : []),
						...(onViewProfile ? [{
							label: "View bot profile",
							icon: <UserIcon className="h-4 w-4" />,
							onClick: onViewProfile,
						} satisfies ContextMenuItem] : []),
						...(onToggleEnabled ? [{
							label: bot.enabled ? "Disable bot" : "Enable bot",
							icon: bot.enabled ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />,
							onClick: onToggleEnabled,
						} satisfies ContextMenuItem] : []),
						{ kind: "divider" } satisfies ContextMenuItem,
						{
							label: "Copy bot mxid",
							icon: <Copy className="h-4 w-4" />,
							onClick: () => { void navigator.clipboard.writeText(bot.mxid); },
						},
						...(onDelete ? [
							{ kind: "divider" } satisfies ContextMenuItem,
							{
								label: "Delete bot",
								icon: <Trash2 className="h-4 w-4" />,
								danger: true,
								onClick: onDelete,
							} satisfies ContextMenuItem,
						] : []),
					]}
					onClose={() => setCtxMenuPos(null)}
				/>
			)}
		</li>
	);
}

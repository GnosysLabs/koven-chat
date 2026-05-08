// Bot management — main right pane.  Counterpart to BotList in the
// sidebar: clicking a bot in the list reveals its configuration here.
//
// Three render states drive what shows up:
//   1. selectedBotId === "new"  → BotEditForm in create mode
//   2. selectedBotId === number → BotEditForm in edit mode
//   3. selectedBotId === null   → empty state.  When the user has no
//                                 bots yet we surface a friendly call-
//                                 to-action; when they have bots but
//                                 haven't picked one we just nudge
//                                 them to do so.
//
// Bot CRUD state (the list itself, loading/error, refresh) lives one
// level up in App.tsx so BotList and BotsPane stay in sync without
// either owning the canonical data.

import { Bot, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BotEditForm } from "@/components/BotEditForm";
import type { BotSummary } from "@/lib/bots";

export interface BotsPaneProps {
	accessToken: string | null;
	currentUserId: string | null;
	// `null` = roster fetch hasn't returned yet (caller's initial
	// state).  Pane renders nothing in the picker until the real
	// list lands — without this gate, the "No bots yet" CTA flashes
	// for the user that DOES have bots, on every Bots-view entry.
	bots: BotSummary[] | null;
	selectedBotId: number | "new" | null;
	atLimit: boolean;
	onNewBot(): void;
	onSelectionCleared(): void;
	// After a successful create or edit; caller refreshes the list
	// and updates the selection (e.g. select the just-created bot).
	onSaved(saved: BotSummary): void | Promise<void>;
	onDelete(bot: BotSummary): void | Promise<void>;
}

export function BotsPane({
	accessToken,
	currentUserId,
	bots,
	selectedBotId,
	atLimit,
	onNewBot,
	onSelectionCleared,
	onSaved,
	onDelete,
}: BotsPaneProps) {
	if (!accessToken || !currentUserId) {
		return (
			<div className="flex-1 min-w-0 flex items-center justify-center text-sm text-muted-foreground">
				Sign in to manage bots.
			</div>
		);
	}

	if (selectedBotId === "new") {
		return (
			<BotEditForm
				mode="create"
				accessToken={accessToken}
				onSaved={onSaved}
				onCancel={onSelectionCleared}
			/>
		);
	}

	if (typeof selectedBotId === "number") {
		const bot = (bots ?? []).find(b => b.id === selectedBotId);
		if (!bot) {
			// Selection points at a bot we no longer have (e.g. the
			// list refresh removed it after a delete).  Show the
			// picker state — the caller will reset the selection on
			// the next interaction.
			return <PickerState bots={bots} onNewBot={onNewBot} atLimit={atLimit} />;
		}
		return (
			<BotEditForm
				mode="edit"
				bot={bot}
				accessToken={accessToken}
				onSaved={onSaved}
				onCancel={onSelectionCleared}
				onDelete={onDelete}
			/>
		);
	}

	return <PickerState bots={bots} onNewBot={onNewBot} atLimit={atLimit} />;
}

function PickerState({
	bots,
	onNewBot,
	atLimit,
}: {
	bots: BotSummary[] | null;
	onNewBot(): void;
	atLimit: boolean;
}) {
	// Roster fetch in flight — render an empty pane (no "No bots
	// yet" splash) so the first paint after navigating into Bots
	// matches the final state.
	if (bots === null) {
		return <div className="flex-1 min-w-0" />;
	}
	if (bots.length === 0) {
		return (
			<div className="flex-1 min-w-0 flex flex-col items-center justify-center text-center px-6 gap-4">
				<div className="rounded-full bg-primary/10 p-4 text-primary">
					<Bot className="h-8 w-8" />
				</div>
				<div className="max-w-md space-y-1">
					<h3 className="font-medium">No bots yet</h3>
					<p className="text-sm text-muted-foreground">
						Create a bot with your own LLM API key (OpenRouter or any
						OpenAI-compatible endpoint), invite it to a room, and
						mention it by name to get a reply.
					</p>
				</div>
				<Button type="button" onClick={onNewBot} disabled={atLimit} className="gap-1.5">
					<Plus className="h-4 w-4" />
					Create your first bot
				</Button>
			</div>
		);
	}

	return (
		<div className="flex-1 min-w-0 flex flex-col items-center justify-center text-center px-6 gap-3 text-muted-foreground">
			<Bot className="h-8 w-8 opacity-50" />
			<p className="text-sm max-w-md">
				Pick a bot from the list to view or edit its configuration, or
				click <span className="font-medium text-foreground">+</span> to create a new one.
			</p>
		</div>
	);
}

// Public mod log — append-only ledger of every moderation action.
// Stubbed; the active per-room implementation lives in ModLogSheet.tsx
// which reads from /api/rooms/:id/mod-log.
//
// This component only renders the wire-level `chat.koven.flag.v1`
// stream (which is what's still emitted into room timelines).  Admin
// actions (kick / ban / redact) flow through standard Matrix events;
// the per-room sheet surfaces them via the engine-tracked audit log.

import type { GovernanceEvent } from "@koven/shared";

export interface ModLogProps {
	events: GovernanceEvent[];
	loading?: boolean;
}

export function ModLog({ events, loading }: ModLogProps) {
	if (loading) {
		return (
			<div className="flex items-center justify-center h-full text-sm text-muted-foreground">
				Loading mod log…
			</div>
		);
	}
	if (events.length === 0) {
		return (
			<div className="flex items-center justify-center h-full p-8 text-sm text-muted-foreground text-center">
				No moderation events yet.<br />
				Reports and admin actions land here.
			</div>
		);
	}
	return (
		<ol className="font-mono text-xs leading-relaxed p-4 space-y-1">
			{events.map((event, idx) => (
				<li key={idx} className="text-muted-foreground">
					<ModLogRow event={event} />
				</li>
			))}
		</ol>
	);
}

function ModLogRow({ event }: { event: GovernanceEvent }) {
	const ts = new Date(event.timestamp).toISOString();
	if (event.type === "chat.koven.flag.v1") {
		const targetRef = event.target_kind === "room"
			? event.target_room_id
			: event.target_event_id;
		const targetLabel = event.target_kind === "room" ? "room" : null;
		return (
			<>
				<span>{ts}</span>
				{" "}
				<span className="text-yellow-500">REPORT</span>
				{" "}
				<span className="text-foreground">{event.flagger}</span>
				{" "}
				<span>reported{targetLabel ? ` ${targetLabel}` : ""}</span>
				{" "}
				<code>{targetRef.slice(0, 12)}…</code>
				{" "}
				<span>as</span>
				{" "}
				<span className="text-yellow-500">{event.category}</span>
				{event.rationale && (
					<>
						{" — "}
						<span className="italic">"{event.rationale}"</span>
					</>
				)}
			</>
		);
	}
	// Unknown / legacy variants drop silently.  The engine no longer
	// emits collapse/appeal/censure/floor events, but the shared types
	// still carry them for wire-format back-compat — we tolerate them
	// here so the stub stays robust.
	return null;
}

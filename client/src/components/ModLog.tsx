// Public mod log — the append-only ledger of every flag, vote, and
// action across the server.  This is the single biggest accountability
// lever Koven has, and it's almost free to implement: render the
// stream of governance events in chronological order, never offer
// edit/delete affordances anywhere in the codebase.
//
// Stubbed for now.  See ../../../docs/GOVERNANCE.md for the rules
// this component will eventually render.

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
				When the community flags or collapses anything, every action lands here — permanently.
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
	switch (event.type) {
		case "chat.koven.flag.v1": {
			// Discriminated union: room flags carry target_room_id,
			// message flags target_event_id.  Both narrow into a
			// printable target ref for this stub.
			const targetRef = event.target_kind === "room"
				? event.target_room_id
				: event.target_event_id;
			const targetLabel = event.target_kind === "room" ? "room" : null;
			return (
				<>
					<span>{ts}</span>
					{" "}
					<span className="text-yellow-500">FLAG</span>
					{" "}
					<span className="text-foreground">{event.flagger}</span>
					{" "}
					<span>flagged{targetLabel ? ` ${targetLabel}` : ""}</span>
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
		case "chat.koven.collapse.v1": {
			const targetRef = event.target_kind === "room"
				? event.target_room_id
				: event.target_event_id;
			const targetLabel = event.target_kind === "room" ? "ROOM " : "";
			return (
				<>
					<span>{ts}</span>
					{" "}
					<span className="text-orange-500">{targetLabel}COLLAPSE</span>
					{" "}
					<code>{targetRef.slice(0, 12)}…</code>
					{" "}
					<span>by</span>
					{" "}
					<span className="text-foreground">{event.flaggers.length} flaggers</span>
					{" "}
					(<span>weight {event.weighted_score.toFixed(1)} / {event.threshold_weight.toFixed(1)}</span>)
				</>
			);
		}
		case "chat.koven.appeal.v1":
			return (
				<>
					<span>{ts}</span>
					{" "}
					<span className="text-blue-500">APPEAL</span>
					{" "}
					<span className="text-foreground">{event.appellant}</span>
					{" "}
					<span>appealed</span>
					{" "}
					<code>{event.target_event_id.slice(0, 12)}…</code>
					{" — "}
					<span className="italic">"{event.rationale}"</span>
				</>
			);
		case "chat.koven.censure.v1":
			return (
				<>
					<span>{ts}</span>
					{" "}
					<span className="text-red-500">CENSURE</span>
					{" "}
					<span className="text-foreground">{event.target_user}</span>
					{" "}
					<span>+{event.points} pts</span>
					{" "}
					(<span>expires {new Date(event.expires_at).toISOString().slice(0, 10)}</span>)
				</>
			);
		case "chat.koven.floor.v1":
			return (
				<>
					<span>{ts}</span>
					{" "}
					<span className="text-red-700 font-semibold">FLOOR</span>
					{" "}
					<code>{event.target_event_id.slice(0, 12)}…</code>
					{" "}
					<span>auto-removed: <span className="text-red-700">{event.classifier}</span></span>
					{" "}
					(confidence {(event.confidence * 100).toFixed(0)}%)
				</>
			);
	}
}

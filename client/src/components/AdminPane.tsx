// Content pane for the admin page. Shows a tab strip (Reports / Bans)
// and renders the appropriate content based on the sidebar selection
// (a specific space or the whole instance). Report row rendering and
// floor toolkit actions are moved here from AdminReportsSheet.

import { useEffect, useMemo, useState } from "react";
import {
	AlertTriangle, Ban, Check, ExternalLink, Flag,
	Shield, ShieldAlert, Trash2, UserX, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { BannedUsersSection } from "@/components/BannedUsersSection";
import type { AdminSelection } from "@/components/AdminList";
import {
	adminBanUser,
	adminDeactivateUser,
	adminDeleteRoom,
	adminDeleteSpace,
	dismissReport,
	markReportActioned,
	type AdminReport,
} from "@/lib/instance";
import type { MatrixTransport } from "@/lib/matrix";
import type { Member, Room, Space, SpaceId, UserId } from "@koven/shared";

type AdminTab = "reports" | "bans";

export interface AdminPaneProps {
	accessToken: string;
	selection: AdminSelection;
	reports: AdminReport[];
	onReportsChange(reports: AdminReport[]): void;
	rooms: Room[];
	spaces: Space[];
	isAdmin: boolean;
	transport: MatrixTransport | null;
	onOpenTarget?(roomId: string, eventId?: string): void;
	onCountChanged?(openCount: number): void;
}

export function AdminPane({
	accessToken, selection, reports, onReportsChange,
	rooms, spaces, isAdmin, transport, onOpenTarget, onCountChanged,
}: AdminPaneProps) {
	const [activeTab, setActiveTab] = useState<AdminTab>("reports");

	useEffect(() => {
		setActiveTab("reports");
	}, [selection?.kind, selection?.kind === "space" ? (selection as any).spaceId : null]);

	if (!selection) {
		return (
			<div className="flex-1 min-w-0 flex items-center justify-center bg-background">
				<div className="text-center space-y-2">
					<div className="h-16 w-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto">
						<ShieldAlert className="h-8 w-8 text-muted-foreground" />
					</div>
					<p className="text-sm text-muted-foreground">Select a space or instance to manage</p>
				</div>
			</div>
		);
	}

	const selectionLabel = selection.kind === "instance"
		? "Instance"
		: spaces.find(s => s.id === (selection as any).spaceId)?.name ?? "Space";

	return (
		<div className="flex-1 min-w-0 flex flex-col bg-background">
			{/* Header */}
			<div className="h-12 px-6 flex items-center border-b border-border">
				<h2 className="text-sm font-semibold truncate">{selectionLabel}</h2>
			</div>

			{/* Tab strip */}
			<div className="px-6 border-b border-border bg-card/30">
				<div className="flex items-center gap-1 -mb-px">
					{(["reports", "bans"] as const).map(tab => (
						<button
							key={tab}
							type="button"
							onClick={() => setActiveTab(tab)}
							className={cn(
								"relative px-3 py-2.5 text-sm whitespace-nowrap transition-colors border-b-2",
								activeTab === tab
									? "text-foreground border-primary font-medium"
									: "text-muted-foreground border-transparent hover:text-foreground hover:border-border",
							)}
						>
							{tab === "reports" ? "Reports" : "Bans"}
						</button>
					))}
				</div>
			</div>

			{/* Tab content */}
			<div className="flex-1 overflow-y-auto">
				{activeTab === "reports" ? (
					<ReportsTab
						accessToken={accessToken}
						selection={selection}
						reports={reports}
						onReportsChange={onReportsChange}
						rooms={rooms}
						spaces={spaces}
						onOpenTarget={onOpenTarget}
						onCountChanged={onCountChanged}
					/>
				) : (
					<BansTab
						accessToken={accessToken}
						selection={selection}
						transport={transport}
						isAdmin={isAdmin}
					/>
				)}
			</div>
		</div>
	);
}

// ─── Reports tab ─────────────────────────────────────────────────

function ReportsTab({
	accessToken, selection, reports, onReportsChange,
	rooms, spaces, onOpenTarget, onCountChanged,
}: {
	accessToken: string;
	selection: NonNullable<AdminSelection>;
	reports: AdminReport[];
	onReportsChange(reports: AdminReport[]): void;
	rooms: Room[];
	spaces: Space[];
	onOpenTarget?(roomId: string, eventId?: string): void;
	onCountChanged?(openCount: number): void;
}) {
	const [busyId, setBusyId] = useState<string | null>(null);
	const [showOpenOnly, setShowOpenOnly] = useState(true);

	const filtered = useMemo(() => {
		if (selection.kind === "instance") return reports;
		const spaceId = selection.spaceId;
		return reports.filter(r => {
			const reportedRoomId = r.target_kind === "room"
				? (r.target_room_id ?? r.room_id)
				: r.room_id;
			if (reportedRoomId === spaceId) return true;
			const room = rooms.find(rr => rr.id === reportedRoomId);
			return room?.parentSpaceIds.includes(spaceId as SpaceId) ?? false;
		});
	}, [reports, rooms, selection]);

	async function applyStatus(eventId: string, kind: "dismiss" | "action") {
		if (busyId) return;
		setBusyId(eventId);
		try {
			if (kind === "dismiss") await dismissReport(accessToken, eventId);
			else await markReportActioned(accessToken, eventId);
			const next = reports.map(r =>
				r.event_id === eventId
					? { ...r, status: kind === "dismiss" ? ("dismissed" as const) : ("actioned" as const) }
					: r,
			);
			onReportsChange(next);
			const remaining = next.filter(r => r.status === "open").length;
			onCountChanged?.(remaining);
		} catch (err) {
			console.warn("admin reports: applyStatus failed", err);
		} finally {
			setBusyId(null);
		}
	}

	async function applyDestructive(
		eventId: string,
		kind: "delete_room" | "delete_space" | "deactivate_user" | "ban_user",
		target: string,
	) {
		if (busyId) return;
		setBusyId(eventId);
		try {
			const body = { related_flag: eventId };
			if (kind === "delete_room") await adminDeleteRoom(accessToken, target, body);
			else if (kind === "delete_space") await adminDeleteSpace(accessToken, target, body);
			else if (kind === "ban_user") await adminBanUser(accessToken, target, body);
			else await adminDeactivateUser(accessToken, target, body);
			await markReportActioned(accessToken, eventId).catch(() => {});
			const next = reports.map(r =>
				r.event_id === eventId
					? { ...r, status: "actioned" as const }
					: r,
			);
			onReportsChange(next);
			const remaining = next.filter(r => r.status === "open").length;
			onCountChanged?.(remaining);
		} catch (err) {
			window.alert(`Action failed: ${err instanceof Error ? err.message : String(err)}`);
			console.warn("admin reports: applyDestructive failed", err);
		} finally {
			setBusyId(null);
		}
	}

	const visible = filtered.filter(r => !showOpenOnly || r.status === "open");
	const openCount = filtered.filter(r => r.status === "open").length;

	return (
		<div className="px-6 py-4">
			<div className="flex items-center justify-between text-xs text-muted-foreground py-1 mb-3">
				<span>
					{openCount} open
					{filtered.length > openCount && (
						<> · {filtered.length - openCount} closed</>
					)}
				</span>
				<label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
					<input
						type="checkbox"
						checked={showOpenOnly}
						onChange={(e) => setShowOpenOnly(e.target.checked)}
						className="h-3 w-3"
					/>
					Open only
				</label>
			</div>

			{visible.length === 0 ? (
				<div className="text-sm text-muted-foreground italic py-6 text-center border border-dashed border-border rounded">
					{showOpenOnly
						? "No open reports. Nice."
						: "No reports recorded yet."}
				</div>
			) : (
				<ol className="space-y-2">
					{visible.map(r => (
						<ReportRow
							key={r.event_id}
							r={r}
							busy={busyId === r.event_id}
							rooms={rooms}
							spaces={spaces}
							onDismiss={() => applyStatus(r.event_id, "dismiss")}
							onAction={() => applyStatus(r.event_id, "action")}
							onDeleteRoom={(roomId) => applyDestructive(r.event_id, "delete_room", roomId)}
							onDeleteSpace={(spaceId) => applyDestructive(r.event_id, "delete_space", spaceId)}
							onBanUser={(userId) => applyDestructive(r.event_id, "ban_user", userId)}
							onDeactivateUser={(userId) => applyDestructive(r.event_id, "deactivate_user", userId)}
							onOpenTarget={onOpenTarget}
						/>
					))}
				</ol>
			)}
		</div>
	);
}

// ─── Bans tab ────────────────────────────────────────────────────

function BansTab({
	accessToken, selection, transport, isAdmin,
}: {
	accessToken: string;
	selection: NonNullable<AdminSelection>;
	transport: MatrixTransport | null;
	isAdmin: boolean;
}) {
	if (selection.kind === "instance") {
		return (
			<div className="px-6 py-4">
				<BannedUsersSection accessToken={accessToken} transport={transport} />
			</div>
		);
	}

	return (
		<SpaceBansView
			spaceId={selection.spaceId}
			transport={transport}
		/>
	);
}

function SpaceBansView({
	spaceId, transport,
}: {
	spaceId: SpaceId;
	transport: MatrixTransport | null;
}) {
	const [banned, setBanned] = useState<Member[]>([]);
	const [pendingMxid, setPendingMxid] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!transport) return;
		setBanned(transport.getSpaceBannedMembers(spaceId));
	}, [spaceId, transport]);

	async function handleUnban(userId: string) {
		if (pendingMxid || !transport) return;
		if (typeof window !== "undefined" && !window.confirm(
			`Unban ${userId} from this space? They will be able to rejoin.`,
		)) return;
		setPendingMxid(userId);
		setError(null);
		try {
			await transport.unbanFromSpace(spaceId, userId as UserId);
			setBanned(prev => prev.filter(m => m.userId !== userId));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPendingMxid(null);
		}
	}

	return (
		<div className="px-6 py-4 space-y-3">
			<div>
				<p className="text-sm font-medium">Space bans</p>
				<p className="text-xs text-muted-foreground mt-0.5">
					Users banned from this space and all its rooms.
				</p>
			</div>

			{error && (
				<p className="text-xs text-destructive">{error}</p>
			)}

			{banned.length === 0 ? (
				<p className="text-xs text-muted-foreground italic py-2">No banned users in this space.</p>
			) : (
				<ul className="space-y-2">
					{banned.map(member => {
						const busy = pendingMxid === member.userId;
						return (
							<li
								key={member.userId}
								className="flex items-center gap-3 p-2 rounded border border-border bg-card/50"
							>
								<MatrixAvatar
									mxc={member.avatarUrl}
									seed={member.userId}
									className="h-8 w-8 shrink-0"
								/>
								<div className="flex-1 min-w-0">
									<div className="text-sm font-medium truncate">
										{member.displayName}
									</div>
									<div className="text-[11px] text-muted-foreground truncate">
										{member.userId}
									</div>
								</div>
								<button
									type="button"
									disabled={busy}
									onClick={() => handleUnban(member.userId)}
									className="shrink-0 px-2 py-1 rounded border border-border bg-card hover:bg-accent text-xs disabled:opacity-50"
								>
									{busy ? "Unbanning..." : "Unban"}
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

// ─── Report row (moved from AdminReportsSheet) ──────────────────

function ReportRow({
	r, busy, rooms, spaces, onDismiss, onAction, onOpenTarget,
	onDeleteRoom, onDeleteSpace, onBanUser, onDeactivateUser,
}: {
	r: AdminReport;
	busy: boolean;
	rooms: Room[];
	spaces: Space[];
	onDismiss(): void;
	onAction(): void;
	onOpenTarget?(roomId: string, eventId?: string): void;
	onDeleteRoom(roomId: string): void | Promise<void>;
	onDeleteSpace(spaceId: string): void | Promise<void>;
	onBanUser(userId: string): void | Promise<void>;
	onDeactivateUser(userId: string): void | Promise<void>;
}) {
	const time = new Date(r.created_at).toLocaleString();
	const isClosed = r.status !== "open";
	const reportedRoomId = r.target_kind === "room"
		? (r.target_room_id ?? r.room_id)
		: r.room_id;
	const room = rooms.find(rr => rr.id === reportedRoomId);
	const viewerPl = room?.myPowerLevel ?? 0;
	const isSpaceModPath = viewerPl >= 50;
	let spaceLabel: string | undefined;
	if (isSpaceModPath && room) {
		const parentId = room.parentSpaceIds[0];
		if (parentId) {
			spaceLabel = spaces.find(s => s.id === parentId)?.name;
		} else {
			spaceLabel = spaces.find(s => s.id === room.id)?.name;
		}
	}
	return (
		<li className={cn(
			"px-3 py-2 rounded border border-border bg-card/50",
			isClosed && "opacity-60",
		)}>
			<div className="flex items-start gap-3">
				<Flag className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
				<div className="flex-1 min-w-0 text-xs leading-snug">
					<div className="flex items-center gap-2 flex-wrap">
						<span className="font-medium">{labelForCategory(r.category)}</span>
						<span className="text-muted-foreground">
							{r.target_kind === "room" ? "room report" : "message report"}
						</span>
						{isSpaceModPath ? (
							<span
								title="You see this report because you have PL >= 50 in the reported room"
								className="inline-flex items-center gap-1 uppercase tracking-wide text-[9px] font-medium px-1.5 py-px rounded bg-amber-500/15 text-amber-500"
							>
								<Shield className="h-2.5 w-2.5" />
								{spaceLabel ?? "your space"}
							</span>
						) : (
							<span
								title="You see this report because you're a server admin and it's a floor-violation report"
								className="inline-flex items-center gap-1 uppercase tracking-wide text-[9px] font-medium px-1.5 py-px rounded bg-destructive/15 text-destructive"
							>
								<AlertTriangle className="h-2.5 w-2.5" />
								Floor · instance
							</span>
						)}
						{r.status !== "open" && (
							<span className={cn(
								"uppercase tracking-wide text-[9px] font-medium px-1 py-px rounded",
								r.status === "actioned"
									? "bg-emerald-500/20 text-emerald-500"
									: "bg-muted text-muted-foreground",
							)}>
								{r.status}
							</span>
						)}
					</div>
					<div className="mt-1 text-muted-foreground">
						<span>Reporter: </span>
						<span className="font-medium text-foreground">{r.flagger}</span>
					</div>
					{r.rationale && (
						<div className="mt-1 italic text-muted-foreground">"{r.rationale}"</div>
					)}
					<div className="mt-1 text-muted-foreground font-mono text-[10px] break-all">
						{r.target_kind === "room"
							? <>Room: {r.target_room_id ?? r.room_id}</>
							: <>Room: {r.room_id} · Event: {r.target_event_id ?? "?"}</>}
					</div>
					<div className="text-[10px] text-muted-foreground/70 mt-1 tabular-nums">{time}</div>

					<div className="mt-2 flex items-center gap-2 flex-wrap">
						{onOpenTarget && (
							<button
								type="button"
								onClick={() => {
									const eventId = r.target_kind === "message" ? r.target_event_id ?? undefined : undefined;
									const roomId = r.target_kind === "room"
										? (r.target_room_id ?? r.room_id)
										: r.room_id;
									onOpenTarget(roomId, eventId);
								}}
								className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-card hover:bg-accent text-[11px]"
							>
								<ExternalLink className="h-3 w-3" />
								Open in room
							</button>
						)}
						{!isClosed && (
							<>
								<button
									type="button"
									disabled={busy}
									onClick={onAction}
									className="inline-flex items-center gap-1 px-2 py-1 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 text-[11px] disabled:opacity-50"
								>
									<Check className="h-3 w-3" />
									{busy ? "Marking..." : "Mark resolved"}
								</button>
								<button
									type="button"
									disabled={busy}
									onClick={onDismiss}
									className="inline-flex items-center gap-1 px-2 py-1 rounded border border-border bg-card hover:bg-accent text-[11px] disabled:opacity-50"
								>
									<X className="h-3 w-3" />
									{busy ? "Dismissing..." : "Dismiss"}
								</button>
							</>
						)}
					</div>
					{!isClosed && r.target_kind === "room" && (
						<FloorToolkitRow
							r={r}
							rooms={rooms}
							spaces={spaces}
							busy={busy}
							onDeleteRoom={onDeleteRoom}
							onDeleteSpace={onDeleteSpace}
							onBanUser={onBanUser}
							onDeactivateUser={onDeactivateUser}
						/>
					)}
				</div>
			</div>
		</li>
	);
}

function FloorToolkitRow({
	r, rooms, spaces, busy,
	onDeleteRoom, onDeleteSpace, onBanUser, onDeactivateUser,
}: {
	r: AdminReport;
	rooms: Room[];
	spaces: Space[];
	busy: boolean;
	onDeleteRoom(roomId: string): void | Promise<void>;
	onDeleteSpace(spaceId: string): void | Promise<void>;
	onBanUser(userId: string): void | Promise<void>;
	onDeactivateUser(userId: string): void | Promise<void>;
}) {
	const reportedRoomId = r.target_room_id ?? r.room_id;
	const reportedSpace = spaces.find(s => s.id === reportedRoomId);
	const isSpace = !!reportedSpace;
	const reportedRoom = rooms.find(rr => rr.id === reportedRoomId);
	const creatorId = reportedRoom?.creatorId ?? reportedSpace?.creatorId ?? null;
	return (
		<div className="mt-2 pt-2 border-t border-destructive/20 flex items-center gap-2 flex-wrap">
			<span className="text-[10px] uppercase tracking-wide text-destructive/80 font-medium">
				Floor toolkit
			</span>
			<button
				type="button"
				disabled={busy}
				onClick={async () => {
					if (typeof window === "undefined") return;
					const label = isSpace ? "this space (without its child rooms)" : "this room";
					if (!window.confirm(
						`Permanently delete ${label}?\n\n`
						+ `Every member will be kicked.  Message history will be purged.  `
						+ `This can't be undone.`,
					)) return;
					await onDeleteRoom(reportedRoomId);
				}}
				className="inline-flex items-center gap-1 px-2 py-1 rounded border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 text-[11px] disabled:opacity-50"
			>
				<Trash2 className="h-3 w-3" />
				Delete room
			</button>
			{isSpace && (
				<button
					type="button"
					disabled={busy}
					onClick={async () => {
						if (typeof window === "undefined") return;
						if (!window.confirm(
							`Permanently delete this ENTIRE SPACE, including every child room inside it?\n\n`
							+ `Every member of every room will be kicked.  Every message history will be purged.  `
							+ `This can't be undone.`,
						)) return;
						await onDeleteSpace(reportedRoomId);
					}}
					className="inline-flex items-center gap-1 px-2 py-1 rounded border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 text-[11px] disabled:opacity-50"
				>
					<Trash2 className="h-3 w-3" />
					Delete whole space
				</button>
			)}
			{creatorId && (
				<button
					type="button"
					disabled={busy}
					onClick={async () => {
						if (typeof window === "undefined") return;
						if (!window.confirm(
							`Ban the creator of this ${isSpace ? "space" : "room"} from the platform?\n\n`
							+ `User: ${creatorId}\n\n`
							+ `They will be immediately logged out and unable to sign in until unbanned.\n`
							+ `This is reversible.`,
						)) return;
						await onBanUser(creatorId);
					}}
					className="inline-flex items-center gap-1 px-2 py-1 rounded border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 text-[11px] disabled:opacity-50"
				>
					<Ban className="h-3 w-3" />
					Ban from platform
				</button>
			)}
			{creatorId && (
				<button
					type="button"
					disabled={busy}
					onClick={async () => {
						if (typeof window === "undefined") return;
						const typed = window.prompt(
							`Permanently deactivate the creator of this ${isSpace ? "space" : "room"}?\n\n`
							+ `User: ${creatorId}\n\n`
							+ `Their account will be erased platform-wide:\n`
							+ `  - They cannot log in again, ever.\n`
							+ `  - Their profile is wiped.\n`
							+ `  - Their messages are pseudonymised.\n`
							+ `  - Their mxid is blocked from re-registration.\n\n`
							+ `Type the user's mxid exactly to confirm:`,
						);
						if (typed !== creatorId) return;
						await onDeactivateUser(creatorId);
					}}
					className="inline-flex items-center gap-1 px-2 py-1 rounded border border-destructive/60 bg-destructive/20 text-destructive hover:bg-destructive/30 text-[11px] disabled:opacity-50 font-medium"
				>
					<UserX className="h-3 w-3" />
					Deactivate creator
				</button>
			)}
		</div>
	);
}

function labelForCategory(c: string): string {
	switch (c) {
		case "off_topic":       return "Off-topic";
		case "spam":            return "Spam";
		case "harassment":      return "Harassment";
		case "misinformation":  return "Misinformation";
		case "floor_violation": return "Serious violation";
		default:                return c;
	}
}

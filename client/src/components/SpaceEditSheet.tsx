// Edit-space dialog — opened from the Settings button on the space
// landing page.  Pre-populates from the current space's state events;
// only sends fields that actually changed so we don't churn state for
// no reason.

import { useEffect, useRef, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { cn } from "@/lib/utils";
import { EmojiPicker } from "@/components/EmojiPicker";
import { Camera, DoorOpen, EyeOff, Globe, Smile, Trash2 } from "lucide-react";
import type { Space } from "@koven/shared";

export interface SpaceEditSheetProps {
	space: Space | null;            // null keeps the dialog closed
	currentUserId: string | null;
	onClose(): void;
	onSave(opts: {
		spaceId: string;
		name?: string;
		topic?: string;
		avatarFile?: File;
		clearAvatar?: boolean;
		iconEmoji?: string;
		visibility?: "public" | "private";
	}): Promise<void>;
	// See RoomEditSheet for the Leave-vs-Delete creator rule.
	onLeave?(spaceId: string): Promise<void>;
	// Delete the space + every child room in `childIds`.  The dialog
	// resolves names via `lookupChildName` and shows them in the
	// confirmation UI before firing this; caller's responsible for
	// closing the dialog + navigating away on resolve.
	onDelete?(spaceId: string, childIds: string[]): Promise<void>;
	// Resolves a child room id to the human-readable name we render
	// in the confirmation list.  Falls back to the room id when the
	// user isn't a member of the child (so we can't read its name
	// locally) — at that point all the dialog can show is the id.
	lookupChildName?(roomId: string): string;
}

export function SpaceEditSheet({ space, currentUserId, onClose, onSave, onLeave, onDelete, lookupChildName }: SpaceEditSheetProps) {
	const [name, setName] = useState("");
	const [topic, setTopic] = useState("");
	const [visibility, setVisibility] = useState<"public" | "private">("public");
	const [avatarFile, setAvatarFile] = useState<File | undefined>(undefined);
	const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined);
	const [clearAvatar, setClearAvatar] = useState(false);
	// Emoji icon — empty string means "no emoji set" (we send "" on
	// clear and a non-empty trimmed glyph on set).
	const [iconEmoji, setIconEmoji] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [confirmingLeave, setConfirmingLeave] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const isCreator = !!space && !!currentUserId && space.creatorId === currentUserId;
	const showLeave = !isCreator && !!onLeave;
	const showDelete = isCreator && !!onDelete;

	const open = !!space;

	// Re-seed form whenever a different space is opened for edit, and
	// reset the local-only avatar state so the dialog is clean.
	useEffect(() => {
		if (!space) return;
		setName(space.name ?? "");
		setTopic(space.topic ?? "");
		setVisibility(space.kind === "public" ? "public" : "private");
		setAvatarFile(undefined);
		setAvatarPreview(undefined);
		setClearAvatar(false);
		setIconEmoji(space.iconEmoji ?? "");
		setError(null);
		setPending(false);
		setConfirmingLeave(false);
		setConfirmingDelete(false);
	}, [space]);

	async function doLeave() {
		if (!space || !onLeave) return;
		setPending(true);
		setError(null);
		try {
			await onLeave(space.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPending(false);
		}
	}

	async function doDelete() {
		if (!space || !onDelete) return;
		setPending(true);
		setError(null);
		try {
			await onDelete(space.id, space.childRoomIds);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPending(false);
		}
	}

	// Clean up object URLs when the preview changes or the dialog
	// unmounts so we don't leak.
	useEffect(() => {
		return () => {
			if (avatarPreview) URL.revokeObjectURL(avatarPreview);
		};
	}, [avatarPreview]);

	function pickAvatar(file: File | undefined) {
		if (avatarPreview) URL.revokeObjectURL(avatarPreview);
		setAvatarFile(file);
		setClearAvatar(false);
		if (file) setAvatarPreview(URL.createObjectURL(file));
		else setAvatarPreview(undefined);
	}

	function removeAvatar() {
		if (avatarPreview) URL.revokeObjectURL(avatarPreview);
		setAvatarFile(undefined);
		setAvatarPreview(undefined);
		setClearAvatar(true);
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (!space) return;
		const trimmedName = name.trim();
		if (!trimmedName) return;

		// Only include fields that actually changed — keeps the diff
		// minimal on the wire and avoids re-broadcasting identical
		// state events that other clients would treat as a fresh edit.
		const opts: Parameters<typeof onSave>[0] = { spaceId: space.id };
		if (trimmedName !== (space.name ?? "")) opts.name = trimmedName;
		if (topic.trim() !== (space.topic ?? "")) opts.topic = topic.trim();
		const currentVisibility = space.kind === "public" ? "public" : "private";
		if (visibility !== currentVisibility) opts.visibility = visibility;
		if (avatarFile) opts.avatarFile = avatarFile;
		else if (clearAvatar) opts.clearAvatar = true;
		const trimmedEmoji = iconEmoji.trim();
		if (trimmedEmoji !== (space.iconEmoji ?? "")) opts.iconEmoji = trimmedEmoji;

		// If nothing changed, just close.
		const hasChanges =
			opts.name !== undefined ||
			opts.topic !== undefined ||
			opts.visibility !== undefined ||
			opts.avatarFile !== undefined ||
			opts.clearAvatar ||
			opts.iconEmoji !== undefined;
		if (!hasChanges) {
			onClose();
			return;
		}

		setPending(true);
		setError(null);
		try {
			await onSave(opts);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPending(false);
		}
	}

	const hasRealAvatar = !!(avatarPreview || (!clearAvatar && space?.avatarUrl));

	// Delete-confirmation view replaces the settings form when the
	// creator clicks Delete.  Lists the child rooms by name so the
	// user knows exactly what they're nuking.  We can only show
	// names for rooms the user is a joined member of (the
	// matrix-js-sdk store doesn't carry full state for foreign
	// rooms); rooms we can't resolve fall back to their id, which
	// is rare in practice — the creator usually authored the
	// children and is in all of them.
	if (confirmingDelete && space) {
		const childCount = space.childRoomIds.length;
		return (
			<Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							Delete {space.name || "this space"}?
						</DialogTitle>
						<DialogDescription>
							{childCount === 0
								? "This space has no rooms inside it. Deleting will kick everyone out and shut the space down."
								: `Deleting will kick everyone out of the space and shut down its ${childCount} ${childCount === 1 ? "room" : "rooms"}. Past messages stay attributed but no one will be able to post or read them again.`
							}
						</DialogDescription>
					</DialogHeader>

					{childCount > 0 && (
						<div className="space-y-2">
							<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
								Rooms that will be deleted
							</div>
							<ul className="rounded-md border border-border divide-y divide-border bg-card/30 max-h-48 overflow-y-auto">
								{space.childRoomIds.map(id => (
									<li key={id} className="px-3 py-1.5 text-sm">
										{lookupChildName ? lookupChildName(id) : id}
									</li>
								))}
							</ul>
						</div>
					)}

					<p className="text-xs text-muted-foreground">
						This can't be undone.
					</p>

					{error && (
						<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
							{error}
						</div>
					)}

					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => { setConfirmingDelete(false); setError(null); }}
							disabled={pending}
						>
							Cancel
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={doDelete}
							disabled={pending}
							className="gap-1.5"
						>
							<Trash2 className="h-4 w-4" />
							{pending
								? "Deleting…"
								: childCount === 0
									? "Delete space"
									: `Delete space + ${childCount} ${childCount === 1 ? "room" : "rooms"}`}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Space settings</DialogTitle>
					<DialogDescription>
						Visible to anyone who can see {space?.name ?? "this space"}.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={submit} className="space-y-4">
					<div className="flex items-center gap-3">
						<button
							type="button"
							onClick={() => fileInputRef.current?.click()}
							className={cn(
								"h-14 w-14 rounded-lg border border-border flex items-center justify-center overflow-hidden",
								"hover:border-primary/60 transition-colors shrink-0",
								avatarPreview ? "" : "bg-muted",
							)}
							aria-label="Upload avatar"
							title="Upload avatar"
						>
							{iconEmoji.trim() && space ? (
								// Emoji takes priority in the preview too —
								// matches what the room list will show.
								<MatrixAvatar
									emoji={iconEmoji.trim()}
									seed={space.id}
									kind="space"
									className="h-14 w-14 rounded-lg"
								/>
							) : avatarPreview ? (
								<img src={avatarPreview} alt="" className="h-full w-full object-cover" />
							) : !clearAvatar && space ? (
								<MatrixAvatar
									mxc={space.avatarUrl}
									seed={space.id}
									kind="space"
									className="h-14 w-14 rounded-lg"
								/>
							) : (
								<Camera className="h-5 w-5 text-muted-foreground" />
							)}
						</button>
						<div className="flex flex-col items-start gap-1.5">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => fileInputRef.current?.click()}
							>
								<Camera className="h-3.5 w-3.5 mr-1.5" />
								{hasRealAvatar ? "Change avatar" : "Upload avatar"}
							</Button>
							<div className="flex items-center gap-1.5">
								<EmojiPicker
									value={iconEmoji}
									onChange={setIconEmoji}
									trigger={
										<Button type="button" variant="outline" size="sm">
											<Smile className="h-3.5 w-3.5 mr-1.5" />
											{iconEmoji ? "Change emoji" : "Set an emoji"}
										</Button>
									}
								/>
								{iconEmoji && (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => setIconEmoji("")}
										className="text-muted-foreground hover:text-destructive h-7"
										title="Remove emoji"
									>
										<Trash2 className="h-3 w-3" />
									</Button>
								)}
							</div>
							{hasRealAvatar && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={removeAvatar}
									className="text-muted-foreground hover:text-destructive h-7"
								>
									<Trash2 className="h-3 w-3 mr-1" /> Remove
								</Button>
							)}
						</div>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							className="hidden"
							onChange={(e) => {
								const file = e.target.files?.[0];
								if (file) pickAvatar(file);
								e.target.value = "";
							}}
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="space-edit-name">Name</Label>
						<Input
							id="space-edit-name"
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
							maxLength={20}
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="space-edit-topic">Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
						<Input
							id="space-edit-topic"
							type="text"
							value={topic}
							onChange={(e) => setTopic(e.target.value)}
							placeholder="What this space is about"
							maxLength={200}
						/>
					</div>

					<div className="space-y-2">
						<Label>Visibility</Label>
						<div className="grid grid-cols-2 gap-2">
							<VisibilityCard
								selected={visibility === "public"}
								onClick={() => setVisibility("public")}
								icon={<Globe className="h-4 w-4" />}
								title="Public"
								description="Anyone on the homeserver can find and join."
							/>
							<VisibilityCard
								selected={visibility === "private"}
								onClick={() => setVisibility("private")}
								icon={<EyeOff className="h-4 w-4" />}
								title="Private"
								description="Invite-only. Won't appear in directories."
							/>
						</div>
					</div>

					{error && (
						<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
							{error}
						</div>
					)}

					<DialogFooter className="sm:justify-between">
						<div className="flex items-center gap-2 flex-wrap">
							{showLeave && !confirmingLeave && !confirmingDelete && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setConfirmingLeave(true)}
									disabled={pending}
									className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1.5"
								>
									<DoorOpen className="h-3.5 w-3.5" />
									Leave
								</Button>
							)}
							{showDelete && !confirmingLeave && !confirmingDelete && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setConfirmingDelete(true)}
									disabled={pending}
									className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1.5"
								>
									<Trash2 className="h-3.5 w-3.5" />
									Delete
								</Button>
							)}
							{confirmingLeave && (
								<>
									<span className="text-xs text-muted-foreground">Leave this space?</span>
									<Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingLeave(false)} disabled={pending}>
										Cancel
									</Button>
									<Button type="button" variant="destructive" size="sm" onClick={doLeave} disabled={pending}>
										{pending ? "Leaving…" : "Confirm leave"}
									</Button>
								</>
							)}
							{/* Delete uses a full-body confirmation view (see
							    the early-return above) so we can list every
							    child room about to be destroyed.  No inline
							    confirm here. */}
						</div>
						<div className="flex items-center gap-2">
							<Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
								Cancel
							</Button>
							<Button type="submit" disabled={!name.trim() || pending}>
								{pending ? "Saving…" : "Save"}
							</Button>
						</div>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function VisibilityCard({
	selected, onClick, icon, title, description,
}: {
	selected: boolean;
	onClick(): void;
	icon: React.ReactNode;
	title: string;
	description: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"text-left rounded-md border p-3 transition-colors",
				selected ? "border-primary bg-primary/5" : "border-border hover:bg-accent",
			)}
		>
			<div className="flex items-center gap-2 mb-1">
				{icon}
				<span className="font-medium text-sm">{title}</span>
			</div>
			<div className="text-xs text-muted-foreground leading-snug">{description}</div>
		</button>
	);
}

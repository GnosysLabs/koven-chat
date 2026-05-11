// Edit-room dialog — opened from the Settings (gear) button in the
// ChatPane header.  Pre-populates from the current room's state events;
// only sends fields that actually changed so we don't churn state for
// no reason.  Mirrors SpaceEditSheet — kept separate because rooms have
// extra knobs in the pipeline (encryption, history visibility) that
// don't apply to spaces.

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
import { Switch } from "@/components/ui/switch";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { cn } from "@/lib/utils";
import { EmojiPicker } from "@/components/EmojiPicker";
import { Camera, DoorOpen, Smile, Trash2, Video } from "lucide-react";
import type { Room } from "@koven/shared";

export interface RoomEditSheetProps {
	room: Room | null;              // null keeps the dialog closed
	currentUserId: string | null;   // viewer's mxid; drives creator check
	onClose(): void;
	onSave(opts: {
		roomId: string;
		name?: string;
		topic?: string;
		avatarFile?: File;
		clearAvatar?: boolean;
		iconEmoji?: string;
		liveEnabled?: boolean;
	}): Promise<void>;
	// Membership exit handlers.  The dialog shows EXACTLY ONE of
	// these based on whether the viewer is the room's creator:
	//
	//   - Non-creators see Leave only.  The room continues without
	//     them; other members keep their power levels.
	//   - The creator sees Delete only.  Leaving without picking a
	//     successor would orphan the room with no founder, so we
	//     don't offer that gesture — the creator must wind the room
	//     down (kicks everyone, leaves + forgets self) instead.
	//
	// Both are still optional because the parent might omit them in
	// contexts where membership changes don't apply.
	onLeave?(roomId: string): Promise<void>;
	onDelete?(roomId: string): Promise<void>;
}

export function RoomEditSheet({ room, currentUserId, onClose, onSave, onLeave, onDelete }: RoomEditSheetProps) {
	const [name, setName] = useState("");
	const [topic, setTopic] = useState("");
	const [avatarFile, setAvatarFile] = useState<File | undefined>(undefined);
	const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined);
	const [clearAvatar, setClearAvatar] = useState(false);
	const [iconEmoji, setIconEmoji] = useState("");
	const [liveEnabled, setLiveEnabled] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	// Two-step inline confirms for destructive actions.  Click "Leave"
	// once → button morphs into "Confirm leave" + a Cancel; click
	// again to fire.  Modal-on-modal would be clunky, the inline
	// reveal keeps everything in this dialog.
	const [confirmingLeave, setConfirmingLeave] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	// Creator → Delete only (Leave would orphan the room).  Everyone
	// else → Leave only.  No middle ground; if the creator wants to
	// step away while keeping the room alive, they need to promote a
	// successor first (separate flow we'll add when there's demand).
	const isCreator = !!room && !!currentUserId && room.creatorId === currentUserId;
	const showLeave = !isCreator && !!onLeave;
	const showDelete = isCreator && !!onDelete;

	// DMs aren't editable as rooms; the parent gates this, but if a
	// DM somehow lands here we treat it as closed.
	const open = !!room && room.kind !== "dm";

	// Re-seed form whenever a different room is opened for edit, and
	// reset the local-only avatar state so the dialog is clean.
	useEffect(() => {
		if (!room) return;
		setName(room.name ?? "");
		setTopic(room.topic ?? "");
		setAvatarFile(undefined);
		setAvatarPreview(undefined);
		setClearAvatar(false);
		setIconEmoji(room.iconEmoji ?? "");
		// liveEnabled defaults to true when the state event is missing,
		// so an undefined here also means "on".
		setLiveEnabled(room.liveEnabled !== false);
		setError(null);
		setPending(false);
		setConfirmingLeave(false);
		setConfirmingDelete(false);
	}, [room]);

	async function doLeave() {
		if (!room || !onLeave) return;
		setPending(true);
		setError(null);
		try {
			await onLeave(room.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPending(false);
		}
	}

	async function doDelete() {
		if (!room || !onDelete) return;
		setPending(true);
		setError(null);
		try {
			await onDelete(room.id);
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
		if (!room) return;
		const trimmedName = name.trim();
		if (!trimmedName) return;

		// Only include fields that actually changed — keeps the diff
		// minimal on the wire and avoids re-broadcasting identical
		// state events that other clients would treat as a fresh edit.
		const opts: Parameters<typeof onSave>[0] = { roomId: room.id };
		if (trimmedName !== (room.name ?? "")) opts.name = trimmedName;
		if (topic.trim() !== (room.topic ?? "")) opts.topic = topic.trim();
		if (avatarFile) opts.avatarFile = avatarFile;
		else if (clearAvatar) opts.clearAvatar = true;
		const trimmedEmoji = iconEmoji.trim();
		if (trimmedEmoji !== (room.iconEmoji ?? "")) opts.iconEmoji = trimmedEmoji;
		const currentLiveEnabled = room.liveEnabled !== false;
		if (liveEnabled !== currentLiveEnabled) opts.liveEnabled = liveEnabled;

		// If nothing changed, just close.
		const hasChanges =
			opts.name !== undefined ||
			opts.topic !== undefined ||
			opts.avatarFile !== undefined ||
			opts.clearAvatar ||
			opts.iconEmoji !== undefined ||
			opts.liveEnabled !== undefined;
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

	const hasRealAvatar = !!(avatarPreview || (!clearAvatar && room?.avatarUrl));

	// Delete-confirmation view — full-body replacement so the user
	// sees exactly what they're firing.  Rooms have no children to
	// list so the copy is shorter than the space-delete equivalent.
	if (confirmingDelete && room) {
		return (
			<Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							Delete {room.name || "this room"}?
						</DialogTitle>
						<DialogDescription>
							Everyone will be kicked out and the room will shut down. Past messages stay attributed but no one will be able to post or read them again. This can't be undone.
						</DialogDescription>
					</DialogHeader>

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
							{pending ? "Deleting…" : "Delete room"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		);
	}

	// Leave-confirmation view — same shape as Delete, scoped to "I'm
	// out" gestures (the room continues without us).
	if (confirmingLeave && room) {
		return (
			<Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							Leave {room.name || "this room"}?
						</DialogTitle>
						<DialogDescription>
							You'll stop receiving messages from this room and it'll disappear from your room list. Other members are unaffected — the room continues without you.
						</DialogDescription>
					</DialogHeader>

					{error && (
						<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
							{error}
						</div>
					)}

					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => { setConfirmingLeave(false); setError(null); }}
							disabled={pending}
						>
							Cancel
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={doLeave}
							disabled={pending}
							className="gap-1.5"
						>
							<DoorOpen className="h-4 w-4" />
							{pending ? "Leaving…" : "Leave room"}
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
					<DialogTitle>Room settings</DialogTitle>
					<DialogDescription>
						Visible to everyone in {room?.name ?? "this room"}.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={submit} className="space-y-4">
					<div className="flex items-center gap-3">
						<button
							type="button"
							onClick={() => fileInputRef.current?.click()}
							className={cn(
								"h-14 w-14 rounded-md border border-border flex items-center justify-center overflow-hidden",
								"hover:border-primary/60 transition-colors shrink-0",
								avatarPreview ? "" : "bg-muted",
							)}
							aria-label="Upload avatar"
							title="Upload avatar"
						>
							{iconEmoji.trim() && room ? (
								// Emoji takes priority in the preview.
								<MatrixAvatar
									emoji={iconEmoji.trim()}
									seed={room.id}
									kind="room"
									className="h-14 w-14 rounded-md"
								/>
							) : avatarPreview ? (
								<img src={avatarPreview} alt="" className="h-full w-full object-cover" />
							) : !clearAvatar && room ? (
								<MatrixAvatar
									mxc={room.avatarUrl}
									seed={room.id}
									kind="room"
									className="h-14 w-14 rounded-md"
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
						<Label htmlFor="room-edit-name">Name</Label>
						<Input
							id="room-edit-name"
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
							maxLength={50}
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="room-edit-topic">Topic <span className="text-muted-foreground font-normal">(optional)</span></Label>
						<Input
							id="room-edit-topic"
							type="text"
							value={topic}
							onChange={(e) => setTopic(e.target.value)}
							placeholder="What this room is about"
							maxLength={300}
						/>
					</div>

					{/* Live channel toggle — every room gets a per-room
					    voice/video channel by default.  Admins can flip
					    this off for rooms where voice would be noise
					    (#announcements, #report-a-bug, etc.).  Unlike
					    NSFW this IS reversible — the state event just
					    flips back.  Gated to the creator to match the
					    NSFW pattern; we could open it up to anyone with
					    state PL later if there's demand. */}
					{isCreator && (
						<div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
							<div className="space-y-0.5 flex-1 min-w-0">
								<Label htmlFor="room-edit-live" className="cursor-pointer flex items-center gap-1.5">
									<Video className="h-3.5 w-3.5" />
									Enable Live channel
								</Label>
								<p className="text-xs text-muted-foreground leading-relaxed">
									Adds a voice / video / screen-share bar at the top of the room. Turn off for rooms where dropping in a call doesn&rsquo;t make sense.
								</p>
							</div>
							<Switch
								id="room-edit-live"
								checked={liveEnabled}
								onCheckedChange={setLiveEnabled}
							/>
						</div>
					)}

					{error && (
						<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
							{error}
						</div>
					)}

					<DialogFooter className="sm:justify-between">
						{/* Destructive actions on the left, separated from
						    the Save / Cancel pair.  Two-step inline
						    confirms — first click morphs the button
						    into a Confirm + Cancel pair. */}
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
							{/* Leave + Delete fire full-body confirmation
							    views (see early-returns above) instead
							    of inline confirms — clearer copy, more
							    room for "what happens next." */}
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


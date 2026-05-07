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
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { cn } from "@/lib/utils";
import { EmojiPicker } from "@/components/EmojiPicker";
import { Camera, EyeOff, Globe, Smile, Trash2 } from "lucide-react";
import type { Room } from "@koven/shared";

export interface RoomEditSheetProps {
	room: Room | null;              // null keeps the dialog closed
	onClose(): void;
	onSave(opts: {
		roomId: string;
		name?: string;
		topic?: string;
		avatarFile?: File;
		clearAvatar?: boolean;
		iconEmoji?: string;
		visibility?: "public" | "private";
	}): Promise<void>;
}

export function RoomEditSheet({ room, onClose, onSave }: RoomEditSheetProps) {
	const [name, setName] = useState("");
	const [topic, setTopic] = useState("");
	const [visibility, setVisibility] = useState<"public" | "private">("public");
	const [avatarFile, setAvatarFile] = useState<File | undefined>(undefined);
	const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined);
	const [clearAvatar, setClearAvatar] = useState(false);
	const [iconEmoji, setIconEmoji] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// DMs aren't editable as rooms; the parent gates this, but if a
	// DM somehow lands here we treat it as closed.
	const open = !!room && room.kind !== "dm";

	// Re-seed form whenever a different room is opened for edit, and
	// reset the local-only avatar state so the dialog is clean.
	useEffect(() => {
		if (!room) return;
		setName(room.name ?? "");
		setTopic(room.topic ?? "");
		setVisibility(room.kind === "public" ? "public" : "private");
		setAvatarFile(undefined);
		setAvatarPreview(undefined);
		setClearAvatar(false);
		setIconEmoji(room.iconEmoji ?? "");
		setError(null);
		setPending(false);
	}, [room]);

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
		const currentVisibility = room.kind === "public" ? "public" : "private";
		if (visibility !== currentVisibility) opts.visibility = visibility;
		if (avatarFile) opts.avatarFile = avatarFile;
		else if (clearAvatar) opts.clearAvatar = true;
		const trimmedEmoji = iconEmoji.trim();
		if (trimmedEmoji !== (room.iconEmoji ?? "")) opts.iconEmoji = trimmedEmoji;

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

	const hasRealAvatar = !!(avatarPreview || (!clearAvatar && room?.avatarUrl));

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

					<div className="space-y-2">
						<Label>Visibility</Label>
						<div className="grid grid-cols-2 gap-2">
							<VisibilityCard
								selected={visibility === "public"}
								onClick={() => {
									// Encrypted rooms can't go public — Matrix
									// doesn't support disabling encryption
									// once enabled, and a public-but-
									// encrypted room is unmoderatable.  Block
									// the toggle and surface the reason.
									if (room?.encrypted) return;
									setVisibility("public");
								}}
								disabled={!!room?.encrypted}
								icon={<Globe className="h-4 w-4" />}
								title="Public"
								description={
									room?.encrypted
										? "Encrypted rooms can't be public."
										: "Anyone on the homeserver can find and join."
								}
							/>
							<VisibilityCard
								selected={visibility === "private"}
								onClick={() => setVisibility("private")}
								icon={<EyeOff className="h-4 w-4" />}
								title="Private"
								description="Invite-only. Won't appear in the directory."
							/>
						</div>
					</div>

					{error && (
						<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
							{error}
						</div>
					)}

					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
							Cancel
						</Button>
						<Button type="submit" disabled={!name.trim() || pending}>
							{pending ? "Saving…" : "Save"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function VisibilityCard({
	selected, onClick, icon, title, description, disabled,
}: {
	selected: boolean;
	onClick(): void;
	icon: React.ReactNode;
	title: string;
	description: string;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"text-left rounded-md border p-3 transition-colors",
				selected ? "border-primary bg-primary/5" : "border-border hover:bg-accent",
				disabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
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

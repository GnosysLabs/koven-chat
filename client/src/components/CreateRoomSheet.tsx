// Create-room dialog — name + topic + avatar + emoji + Live toggle.
//
// Layout mirrors RoomEditSheet so the create + edit flows feel like
// the same form in two states (one with empty fields, one with the
// current room's state preloaded).  Narrow `sm:max-w-md` dialog,
// 14×14 avatar tile on the left, action column on the right with
// Upload / Set Emoji / Remove buttons, name + topic inputs below.
//
// Discord-style invariant: the new room ALWAYS lives inside the
// currently active space, and silently inherits the space's
// privacy + NSFW + encryption posture.  No room-level visibility
// toggle, no room-level NSFW toggle, no room-level encryption
// toggle — the inheritance is implicit.  Public space → public
// not-encrypted rooms; private space → restricted-join in-space
// rooms; private space with the e2ee_required policy → every room
// is encrypted; NSFW space → NSFW rooms.
//
// The encryption decision is made once at space creation and
// applied to every child room.  Per-room opt-in was removed
// because mixing encrypted and unencrypted rooms inside the same
// space created an inconsistent moderation surface (some rooms
// flag-able, some not) that was hard to communicate to users.
// The whole-space decision is simpler to reason about and matches
// the "this space is or isn't moderated" mental model.

import { useRef, useState } from "react";
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
import { EmojiPicker } from "@/components/EmojiPicker";
import { cn } from "@/lib/utils";
import { Camera, Smile, Trash2, Video } from "lucide-react";

export interface CreateRoomSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	onCreate(opts: {
		name: string;
		topic: string;
		// Mirrors CreateSpaceSheet — when set, the file gets uploaded
		// + written as m.room.avatar after createRoom returns.
		avatarFile?: File;
		// Optional emoji icon — stamped as chat.koven.room_icon at
		// create time.  Empty string means "no emoji."
		iconEmoji: string;
		// Whether the new room exposes the Live (voice / video /
		// screen-share) bar.  Defaults to true; only passed as
		// false when the creator explicitly turns it off, so the
		// state event is only stamped on rooms that differ from
		// the global default.
		liveEnabled: boolean;
	}): Promise<void>;
	// Parent space context — used for the dialog's "in <space>"
	// description.  Encryption + visibility are inherited by
	// matrix.ts's createRoom from the parent space's state at
	// create time; the dialog itself no longer exposes either.
	parentSpaceName: string;
}

export function CreateRoomSheet({
	open, onOpenChange, onCreate, parentSpaceName,
}: CreateRoomSheetProps) {
	const [name, setName] = useState("");
	const [topic, setTopic] = useState("");
	const [iconEmoji, setIconEmoji] = useState("");
	// Live channel defaults to on — matches the default in
	// RoomEditSheet + readKovenLiveEnabled (missing state event
	// is treated as enabled).  Creator can turn it off here for
	// rooms where a call surface doesn't make sense.
	const [liveEnabled, setLiveEnabled] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [avatarFile, setAvatarFile] = useState<File | undefined>(undefined);
	const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined);

	function reset() {
		setName("");
		setTopic("");
		setIconEmoji("");
		setLiveEnabled(true);
		setAvatarFile(undefined);
		setAvatarPreview(undefined);
		setError(null);
		setPending(false);
	}

	function pickAvatar(file: File | undefined) {
		setAvatarFile(file);
		if (file) {
			const reader = new FileReader();
			reader.onload = () => setAvatarPreview(reader.result as string);
			reader.readAsDataURL(file);
		} else {
			setAvatarPreview(undefined);
		}
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return;
		setPending(true);
		setError(null);
		try {
			await onCreate({
				name: trimmed,
				topic: topic.trim(),
				avatarFile,
				iconEmoji: iconEmoji.trim(),
				liveEnabled,
			});
			reset();
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPending(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Create a room in {parentSpaceName}</DialogTitle>
					<DialogDescription>
						Rooms are channels inside this space. They inherit the space&rsquo;s privacy posture &mdash; no per-room toggles to drift out of sync.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={submit} className="space-y-4">
					{/* Avatar tile + action column — mirrors RoomEditSheet's
					    layout so the create + edit dialogs feel like one
					    form in two states.  Emoji takes priority over
					    uploaded image in the preview, same as the
					    rendered avatar everywhere else in the SPA. */}
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
							{iconEmoji.trim() ? (
								// Emoji preview: render at the same size as
								// MatrixAvatar's emoji variant elsewhere.
								<span className="text-2xl leading-none">{iconEmoji.trim()}</span>
							) : avatarPreview ? (
								<img src={avatarPreview} alt="" className="h-full w-full object-cover" />
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
								{avatarPreview ? "Change avatar" : "Upload avatar"}
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
							{avatarPreview && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => pickAvatar(undefined)}
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
						<Label htmlFor="room-name">Name</Label>
						<Input
							id="room-name"
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="general"
							autoFocus
							required
							maxLength={50}
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="room-topic">Topic <span className="text-muted-foreground font-normal">(optional)</span></Label>
						<Input
							id="room-topic"
							type="text"
							value={topic}
							onChange={(e) => setTopic(e.target.value)}
							placeholder="What this room is about"
							maxLength={300}
						/>
					</div>

					{/* Live channel — voice / video / screen-share bar
					    at the top of the room.  Defaults on; turn off
					    for rooms where dropping in a call doesn't make
					    sense.  Reversible from RoomEditSheet later. */}
					<div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
						<div className="space-y-0.5 flex-1 min-w-0">
							<Label htmlFor="room-live" className="cursor-pointer flex items-center gap-1.5">
								<Video className="h-3.5 w-3.5" />
								Enable Live channel
							</Label>
							<p className="text-xs text-muted-foreground leading-relaxed">
								Adds a voice / video / screen-share bar at the top of the room. Turn off for rooms where dropping in a call doesn&rsquo;t make sense &mdash; you can flip this back on later.
							</p>
						</div>
						<Switch
							id="room-live"
							checked={liveEnabled}
							onCheckedChange={setLiveEnabled}
						/>
					</div>

					{error && (
						<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
							{error}
						</div>
					)}

					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
							Cancel
						</Button>
						<Button type="submit" disabled={!name.trim() || pending}>
							{pending ? "Creating…" : "Create room"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

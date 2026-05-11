// Create-room dialog — name + topic + avatar.
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
import { cn } from "@/lib/utils";
import { Camera, Trash2 } from "lucide-react";

export interface CreateRoomSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	onCreate(opts: {
		name: string;
		topic: string;
		// Mirrors CreateSpaceSheet — when set, the file gets uploaded
		// + written as m.room.avatar after createRoom returns.
		avatarFile?: File;
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
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Avatar pick state — same pattern as CreateSpaceSheet.
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [avatarFile, setAvatarFile] = useState<File | undefined>(undefined);
	const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined);

	function reset() {
		setName("");
		setTopic("");
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
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Create a room in {parentSpaceName}</DialogTitle>
					<DialogDescription>
						Rooms are channels inside this space. They inherit the space&rsquo;s privacy and NSFW posture &mdash; no per-room toggles to drift out of sync.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={submit} className="space-y-4">
					{/* Avatar + name on the same row — mirrors
					    CreateSpaceSheet for visual consistency. */}
					<div className="flex items-start gap-4">
						<button
							type="button"
							onClick={() => fileInputRef.current?.click()}
							className={cn(
								"h-20 w-20 rounded-lg border border-border flex items-center justify-center overflow-hidden shrink-0",
								"hover:border-primary/60 transition-colors",
								avatarPreview ? "" : "bg-muted text-muted-foreground",
							)}
							aria-label="Upload avatar"
							title="Upload avatar"
						>
							{avatarPreview ? (
								<img src={avatarPreview} alt="" className="h-full w-full object-cover" />
							) : (
								<Camera className="h-6 w-6" />
							)}
						</button>
						<div className="flex-1 space-y-3 min-w-0">
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
									maxLength={20}
								/>
							</div>
							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => fileInputRef.current?.click()}
								>
									<Camera className="h-3.5 w-3.5 mr-1.5" />
									{avatarPreview ? "Change avatar" : "Upload avatar"}
								</Button>
								{avatarPreview && (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => pickAvatar(undefined)}
										className="text-muted-foreground hover:text-destructive"
									>
										<Trash2 className="h-3.5 w-3.5 mr-1" /> Remove
									</Button>
								)}
							</div>
							<input
								ref={fileInputRef}
								type="file"
								accept="image/*"
								className="hidden"
								onChange={(e) => pickAvatar(e.target.files?.[0])}
							/>
						</div>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="room-topic">Topic <span className="text-muted-foreground font-normal">(optional)</span></Label>
						<Input
							id="room-topic"
							type="text"
							value={topic}
							onChange={(e) => setTopic(e.target.value)}
							placeholder="What this room is about"
							maxLength={200}
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

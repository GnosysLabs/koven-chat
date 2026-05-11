// Create-room dialog — name + topic + avatar + encryption.
//
// Discord-style invariant: the new room ALWAYS lives inside the
// currently active space, and silently inherits the space's
// privacy + NSFW posture.  No room-level visibility toggle, no
// room-level NSFW toggle, no read-only "inherits from" panel —
// the inheritance is implicit.  Public space → public rooms;
// private space → restricted-join in-space rooms; NSFW space →
// NSFW rooms.  The dialog only needs `parentSpaceKind` to gate
// the encryption switch.
//
// Encryption stays a per-room choice because it's a technical
// axis (megolm sessions, key backup, blind moderation) rather
// than governance.  We force it off when the parent space is
// public (encrypted public rooms can't be moderated by the engine,
// which is Koven's whole consensus story).

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
import { cn } from "@/lib/utils";
import { Camera, Trash2 } from "lucide-react";

export interface CreateRoomSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	onCreate(opts: {
		name: string;
		topic: string;
		encrypted: boolean;
		// Mirrors CreateSpaceSheet — when set, the file gets uploaded
		// + written as m.room.avatar after createRoom returns.
		avatarFile?: File;
	}): Promise<void>;
	// Parent space context — the room inherits these.  Drives the
	// "Inherits from <space>" copy + the encryption gate (encryption
	// only allowed when the parent is private).  Required because
	// the dialog can no longer be opened without an active space.
	parentSpaceName: string;
	parentSpaceKind: "public" | "private";
	// True when the parent space was created with the "all child
	// rooms must be E2EE" policy.  Forces the encryption switch
	// ON and read-only — the user can't opt out of the space's
	// policy on a per-room basis.  matrix.ts's createRoom also
	// enforces this server-side; the UI gate is just for clarity.
	parentSpaceE2eeRequired?: boolean;
}

export function CreateRoomSheet({
	open, onOpenChange, onCreate,
	parentSpaceName, parentSpaceKind, parentSpaceE2eeRequired,
}: CreateRoomSheetProps) {
	const [name, setName] = useState("");
	const [topic, setTopic] = useState("");
	const [encrypted, setEncrypted] = useState(false);
	// Encryption is only sensible inside a private space.  Public
	// spaces can't host encrypted rooms because the engine needs to
	// see content to run consensus moderation.
	const canEncrypt = parentSpaceKind === "private";
	// When the parent space's policy requires E2EE, the switch is
	// forced on regardless of the local state.  The local `encrypted`
	// state is kept so the rendered switch shows the right "checked"
	// position; we just override the effective value.
	const effectiveEncrypted = parentSpaceE2eeRequired
		? true
		: (canEncrypt && encrypted);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Avatar pick state — same pattern as CreateSpaceSheet.
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [avatarFile, setAvatarFile] = useState<File | undefined>(undefined);
	const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined);

	function reset() {
		setName("");
		setTopic("");
		setEncrypted(false);
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
				encrypted: effectiveEncrypted,
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

					<div className={cn(
						"flex items-start justify-between gap-3 rounded-md border border-border p-3",
						!canEncrypt && "opacity-60",
					)}>
						<div className="space-y-0.5 flex-1 min-w-0">
							<Label htmlFor="room-encrypted" className="cursor-pointer">End-to-end encryption</Label>
							<p className="text-xs text-muted-foreground leading-relaxed">
								{parentSpaceE2eeRequired ? (
									<>
										<strong className="text-foreground">Required by this space.</strong> {parentSpaceName} was created with end-to-end encryption locked on, so every room in it must be encrypted.
									</>
								) : canEncrypt ? (
									<>
										Encrypted rooms are unreadable by the server. <strong className="text-foreground">Koven moderation cannot apply</strong> &mdash; flags, collapse, and the mod log go silent. Use only when you trust everyone in the space.
									</>
								) : (
									<>
										Encryption is only available inside a private space. {parentSpaceName} is public, so rooms must stay readable for consensus moderation to work.
									</>
								)}
							</p>
						</div>
						<Switch
							id="room-encrypted"
							checked={effectiveEncrypted}
							onCheckedChange={setEncrypted}
							disabled={!canEncrypt || parentSpaceE2eeRequired === true}
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

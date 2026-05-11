// Create-space dialog — name + topic + avatar + emoji + visibility
// + encryption + NSFW.
//
// Layout mirrors CreateRoomSheet (which itself mirrors
// RoomEditSheet / SpaceEditSheet): narrow `sm:max-w-md` dialog,
// 14×14 avatar tile on the left with action column on the right
// (Upload / Set Emoji / Remove), name + topic inputs, then the
// space-specific knobs (visibility, encryption, NSFW) below.
// The create + edit flows now read as the same form in two states.

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
import { Camera, EyeOff, Globe, Lock, Smile, Trash2 } from "lucide-react";

export interface CreateSpaceSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	onCreate(opts: {
		name: string;
		topic: string;
		visibility: "public" | "private";
		avatarFile?: File;
		// Optional emoji icon — stamped as chat.koven.room_icon on
		// the space's m.space-typed room after create.
		iconEmoji: string;
		nsfw: boolean;
		e2eeRequired: boolean;
	}): Promise<void>;
	/** Same gate as the room create form — only shows the NSFW toggle
	 * when the viewer's account has "Show NSFW rooms" enabled. */
	showNsfw: boolean;
}

export function CreateSpaceSheet({ open, onOpenChange, onCreate, showNsfw }: CreateSpaceSheetProps) {
	const [name, setName] = useState("");
	const [topic, setTopic] = useState("");
	const [iconEmoji, setIconEmoji] = useState("");
	const [visibility, setVisibility] = useState<"public" | "private">("public");
	const [nsfw, setNsfw] = useState(false);
	const [e2eeRequired, setE2eeRequired] = useState(false);
	const [avatarFile, setAvatarFile] = useState<File | undefined>(undefined);
	const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	// E2EE only makes sense inside a private space — encrypted public
	// spaces are forbidden by governance because the engine can't run
	// consensus moderation on what it can't read.  When the user flips
	// visibility back to public, we silently clear the encryption
	// switch so the two settings can't drift out of sync.
	const canEncrypt = visibility === "private";
	const effectiveE2eeRequired = canEncrypt && e2eeRequired;

	function reset() {
		setName("");
		setTopic("");
		setIconEmoji("");
		setVisibility("public");
		setNsfw(false);
		setE2eeRequired(false);
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
				visibility,
				avatarFile,
				iconEmoji: iconEmoji.trim(),
				nsfw,
				e2eeRequired: effectiveE2eeRequired,
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
					<DialogTitle>Create a space</DialogTitle>
					<DialogDescription>
						Spaces are containers for related rooms &mdash; a community, a team, a project. You&rsquo;ll be the founder; you can add rooms after.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={submit} className="space-y-4">
					{/* Avatar tile + action column — mirrors CreateRoomSheet
					    so the two create flows feel like one form. */}
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
						<Label htmlFor="space-name">Name</Label>
						<Input
							id="space-name"
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="My space"
							autoFocus
							required
							maxLength={50}
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="space-topic">Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
						<Input
							id="space-topic"
							type="text"
							value={topic}
							onChange={(e) => setTopic(e.target.value)}
							placeholder="What this space is about"
							maxLength={300}
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

					{/* End-to-end encryption — only valid for private
					    spaces.  When on, every child room created under
					    this space is forced to be encrypted + private,
					    permanently.  Matrix can't disable encryption on
					    a room once it's on, so this flag is a one-way
					    switch.  Surfaced disabled (with explanatory copy)
					    when visibility is public so the user understands
					    why they can't combine the two. */}
					<div className={cn(
						"flex items-start justify-between gap-3 rounded-md border border-border p-3",
						!canEncrypt && "opacity-60",
					)}>
						<div className="space-y-0.5 flex-1 min-w-0">
							<Label htmlFor="space-e2ee" className="cursor-pointer flex items-center gap-1.5">
								<Lock className="h-3.5 w-3.5 text-muted-foreground" />
								End-to-end encryption
							</Label>
							<p className="text-xs text-muted-foreground leading-relaxed">
								{canEncrypt ? (
									<>
										Forces every room in this space to be encrypted &amp; private. <strong className="text-foreground">Koven moderation can&rsquo;t apply</strong> &mdash; flags, collapse, and the mod log go silent in every child room. <strong className="text-foreground">This can&rsquo;t be reversed.</strong>
									</>
								) : (
									<>
										Encryption is only available on private spaces. Public rooms must stay readable for consensus moderation to work.
									</>
								)}
							</p>
						</div>
						<Switch
							id="space-e2ee"
							checked={effectiveE2eeRequired}
							onCheckedChange={setE2eeRequired}
							disabled={!canEncrypt}
						/>
					</div>

					{showNsfw && (
						<div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
							<div className="space-y-0.5 flex-1 min-w-0">
								<Label htmlFor="space-nsfw" className="cursor-pointer">Mark as NSFW</Label>
								<p className="text-xs text-muted-foreground leading-relaxed">
									Hides the space from Explore for users who haven&rsquo;t opted into NSFW content. <strong className="text-foreground">This can&rsquo;t be reversed</strong> &mdash; once marked, the space stays marked.
								</p>
							</div>
							<Switch
								id="space-nsfw"
								checked={nsfw}
								onCheckedChange={setNsfw}
							/>
						</div>
					)}

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
							{pending ? "Creating…" : "Create space"}
						</Button>
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

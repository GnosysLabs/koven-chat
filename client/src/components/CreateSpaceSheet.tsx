// Create-space dialog — name + topic + visibility + avatar + NSFW.
//
// Same modal pattern as CreateRoomSheet so the two creation flows
// feel like siblings.  Replaces the popover-anchored SpaceCreateMenu
// — the popover put the form in a tight 320px column and split it
// across two stages (visibility pick → details), which made the
// flow feel more involved than it actually was.  A single modal
// matches the room flow and gives the avatar + visibility cards
// room to breathe side-by-side.

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
import { Camera, EyeOff, Globe, Trash2 } from "lucide-react";

export interface CreateSpaceSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	onCreate(opts: {
		name: string;
		topic: string;
		visibility: "public" | "private";
		avatarFile?: File;
		nsfw: boolean;
	}): Promise<void>;
	/** Same gate as the room create form — only shows the NSFW toggle
	 * when the viewer's account has "Show NSFW rooms" enabled. */
	showNsfw: boolean;
}

export function CreateSpaceSheet({ open, onOpenChange, onCreate, showNsfw }: CreateSpaceSheetProps) {
	const [name, setName] = useState("");
	const [topic, setTopic] = useState("");
	const [visibility, setVisibility] = useState<"public" | "private">("public");
	const [nsfw, setNsfw] = useState(false);
	const [avatarFile, setAvatarFile] = useState<File | undefined>(undefined);
	const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	function reset() {
		setName("");
		setTopic("");
		setVisibility("public");
		setNsfw(false);
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
				nsfw,
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
			{/* Wider sm:max-w-2xl so the visibility cards + avatar
			    block can sit comfortably without feeling cramped.
			    Matches CreateRoomSheet's footprint exactly. */}
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Create a space</DialogTitle>
					<DialogDescription>
						Spaces are containers for related rooms — a community, a team, a project. You&rsquo;ll be the founder; you can add rooms after.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={submit} className="space-y-4">
					{/* Avatar + name on the same row.  Avatar is a square
					    swatch on the left, name + topic stack on the
					    right, mirroring the SpaceBar tile layout the
					    user will see after creation. */}
					<div className="flex items-start gap-4">
						<button
							type="button"
							onClick={() => fileInputRef.current?.click()}
							className={cn(
								"h-20 w-20 rounded-lg border border-border flex items-center justify-center overflow-hidden shrink-0",
								"hover:border-primary/60 transition-colors",
								avatarPreview ? "" : "bg-muted text-muted-foreground"
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
								<Label htmlFor="space-name">Name</Label>
								<Input
									id="space-name"
									type="text"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="My space"
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
						<Label htmlFor="space-topic">Description <span className="text-muted-foreground font-normal">(optional)</span></Label>
						<Input
							id="space-topic"
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

					{showNsfw && (
						<div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
							<div className="space-y-0.5 flex-1 min-w-0">
								<Label htmlFor="space-nsfw" className="cursor-pointer">Mark as NSFW</Label>
								<p className="text-xs text-muted-foreground leading-relaxed">
									Hides the space from Explore for users who haven&rsquo;t opted into NSFW content. <strong className="text-foreground">This can&rsquo;t be reversed</strong> — once marked, the space stays marked.
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
				selected ? "border-primary bg-primary/5" : "border-border hover:bg-accent"
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

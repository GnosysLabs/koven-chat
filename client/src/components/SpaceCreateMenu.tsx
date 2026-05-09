// Two-step space-creation popover, mirroring Element's pattern:
//   1. Pick visibility (Public / Private) — big pill buttons with descriptions.
//   2. Fill in name + description + avatar — back chevron returns to step 1.
//
// Anchored next to the SpaceBar's "+" tile rather than rendered as a
// modal — keeps the action close to its trigger and feels lighter than
// our previous full-dialog approach.

import { useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ChevronLeft, EyeOff, Globe, Trash2, Camera } from "lucide-react";
import { Switch } from "@/components/ui/switch";

export interface SpaceCreateMenuProps {
	// The thing the popover anchors to — typically the "+" tile in the SpaceBar.
	trigger: React.ReactNode;
	onCreate(opts: {
		name: string;
		topic: string;
		visibility: "public" | "private";
		avatarFile?: File;
		nsfw: boolean;
	}): Promise<void>;
	// Optional gate fired BEFORE the popover opens.  Resolve true
	// to proceed; resolve false to swallow the open click (the
	// parent is responsible for showing whatever the denial UI is
	// — e.g. the publish-quota dialog when a new user has hit
	// their daily cap).  Without this, a rate-limited user would
	// have to fill in the whole space form before getting denied
	// at submit.
	onBeforeOpen?(): Promise<boolean>;
	/** Drives visibility of the NSFW toggle.  Hidden when the viewer
	 * has the "Show NSFW rooms" preference off — same protection as
	 * room creation, so users can't accidentally mark a space NSFW
	 * without realizing what that means. */
	showNsfw?: boolean;
}

type Stage =
	| { kind: "visibility" }
	| { kind: "details"; visibility: "public" | "private" };

export function SpaceCreateMenu({ trigger, onCreate, onBeforeOpen, showNsfw }: SpaceCreateMenuProps) {
	const [open, setOpen] = useState(false);
	const [stage, setStage] = useState<Stage>({ kind: "visibility" });
	const [name, setName] = useState("");
	const [topic, setTopic] = useState("");
	const [avatarFile, setAvatarFile] = useState<File | undefined>(undefined);
	const [avatarPreview, setAvatarPreview] = useState<string | undefined>(undefined);
	const [nsfw, setNsfw] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	function reset() {
		setStage({ kind: "visibility" });
		setName("");
		setTopic("");
		setAvatarFile(undefined);
		setAvatarPreview(undefined);
		setNsfw(false);
		setError(null);
		setPending(false);
	}

	function handleOpenChange(o: boolean) {
		// Closing path is unconditional — Radix can fire close on
		// click-outside, escape, etc., and we always want to
		// honour that.
		if (!o) {
			setOpen(false);
			reset();
			return;
		}
		// Opening path: gate behind onBeforeOpen if provided.  If it
		// resolves false (e.g. user is rate-limited), swallow the
		// open click — the parent will surface its own denial UI.
		if (!onBeforeOpen) {
			setOpen(true);
			return;
		}
		void onBeforeOpen().then((ok) => {
			if (ok) setOpen(true);
		});
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
		if (stage.kind !== "details") return;
		const trimmed = name.trim();
		if (!trimmed) return;
		setPending(true);
		setError(null);
		try {
			await onCreate({
				name: trimmed,
				topic: topic.trim(),
				visibility: stage.visibility,
				avatarFile,
				nsfw,
			});
			handleOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPending(false);
		}
	}

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent
				side="right"
				align="start"
				sideOffset={12}
				className="w-80 p-4"
				// Avoid auto-close when the user clicks into the file picker
				// or types in the form fields.
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				{stage.kind === "visibility" ? (
					<VisibilityStage
						onPick={(visibility) => setStage({ kind: "details", visibility })}
					/>
				) : (
					<DetailsStage
						visibility={stage.visibility}
						name={name}
						setName={setName}
						topic={topic}
						setTopic={setTopic}
						avatarPreview={avatarPreview}
						onAvatarPick={pickAvatar}
						onAvatarClear={() => pickAvatar(undefined)}
						fileInputRef={fileInputRef}
						onBack={() => setStage({ kind: "visibility" })}
						onSubmit={submit}
						pending={pending}
						error={error}
						showNsfw={!!showNsfw}
						nsfw={nsfw}
						setNsfw={setNsfw}
					/>
				)}
			</PopoverContent>
		</Popover>
	);
}

function VisibilityStage({ onPick }: { onPick(v: "public" | "private"): void }) {
	return (
		<div className="space-y-3">
			<div>
				<h3 className="text-sm font-semibold">Create a space</h3>
				<p className="text-xs text-muted-foreground leading-snug mt-1">
					Spaces are containers for related rooms. Pick how this one shows up.
				</p>
			</div>
			<VisibilityPill
				icon={<Globe className="h-4 w-4" />}
				title="Public"
				description="Anyone on the homeserver can find and join."
				onClick={() => onPick("public")}
			/>
			<VisibilityPill
				icon={<EyeOff className="h-4 w-4" />}
				title="Private"
				description="Invite-only. Won't appear in directories."
				onClick={() => onPick("private")}
			/>
		</div>
	);
}

function VisibilityPill({
	icon, title, description, onClick,
}: {
	icon: React.ReactNode;
	title: string;
	description: string;
	onClick(): void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="w-full text-left rounded-md border border-border p-3 hover:bg-accent transition-colors"
		>
			<div className="flex items-center gap-2 mb-0.5">
				{icon}
				<span className="font-medium text-sm">{title}</span>
			</div>
			<div className="text-xs text-muted-foreground leading-snug">{description}</div>
		</button>
	);
}

function DetailsStage({
	visibility, name, setName, topic, setTopic,
	avatarPreview, onAvatarPick, onAvatarClear, fileInputRef,
	onBack, onSubmit, pending, error,
	showNsfw, nsfw, setNsfw,
}: {
	visibility: "public" | "private";
	name: string;
	setName(v: string): void;
	topic: string;
	setTopic(v: string): void;
	avatarPreview: string | undefined;
	onAvatarPick(f: File | undefined): void;
	onAvatarClear(): void;
	fileInputRef: React.RefObject<HTMLInputElement>;
	onBack(): void;
	onSubmit(e: React.FormEvent): void;
	pending: boolean;
	error: string | null;
	showNsfw: boolean;
	nsfw: boolean;
	setNsfw(v: boolean): void;
}) {
	const heading = visibility === "public" ? "Public space" : "Private space";
	return (
		<form onSubmit={onSubmit} className="space-y-3">
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={onBack}
					className="p-1 -ml-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
					aria-label="Back"
					title="Back"
				>
					<ChevronLeft className="h-4 w-4" />
				</button>
				<h3 className="text-sm font-semibold">{heading}</h3>
			</div>

			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={() => fileInputRef.current?.click()}
					className={cn(
						"h-14 w-14 rounded-lg border border-border flex items-center justify-center overflow-hidden",
						"hover:border-primary/60 transition-colors shrink-0",
						avatarPreview ? "" : "bg-muted text-muted-foreground"
					)}
					aria-label="Upload avatar"
					title="Upload avatar"
				>
					{avatarPreview ? (
						<img src={avatarPreview} alt="" className="h-full w-full object-cover" />
					) : (
						<Camera className="h-5 w-5" />
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
					{avatarPreview && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={onAvatarClear}
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
					onChange={(e) => onAvatarPick(e.target.files?.[0])}
				/>
			</div>

			<div className="space-y-1.5">
				<Label htmlFor="space-name" className="text-xs">Name</Label>
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

			<div className="space-y-1.5">
				<Label htmlFor="space-topic" className="text-xs">
					Description <span className="text-muted-foreground font-normal">(optional)</span>
				</Label>
				<Input
					id="space-topic"
					type="text"
					value={topic}
					onChange={(e) => setTopic(e.target.value)}
					placeholder="What this space is about"
					maxLength={200}
				/>
			</div>

			{/* Permanent NSFW flag.  Always visible on the create-
			    space form — operators creating a space need to be
			    able to mark it appropriately at creation time
			    regardless of their own discovery preferences. */}
			<div className="flex items-start justify-between gap-3 rounded-md border border-border bg-card/40 px-3 py-2">
				<div className="flex-1 min-w-0">
					<Label htmlFor="space-nsfw" className="text-xs cursor-pointer">Mark as NSFW</Label>
					<p className="text-[10px] text-muted-foreground leading-snug mt-0.5">
						Hides the space from Explore for users who haven&rsquo;t opted into NSFW content. <strong className="text-foreground">This can&rsquo;t be reversed.</strong>
					</p>
				</div>
				<Switch
					id="space-nsfw"
					checked={nsfw}
					onCheckedChange={setNsfw}
					className="mt-0.5"
				/>
			</div>

			{error && (
				<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-2 py-1.5">
					{error}
				</div>
			)}

			<Button type="submit" disabled={!name.trim() || pending} className="w-full">
				{pending ? "Creating…" : "Create"}
			</Button>
		</form>
	);
}

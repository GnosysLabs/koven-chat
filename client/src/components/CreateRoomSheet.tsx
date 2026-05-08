// Create-room dialog — name + topic + privacy + encryption toggle.
//
// The encryption choice is governance-relevant: encrypted rooms can't
// be moderated by Koven's engine because the engine can't read their
// content.  We surface that explicitly so the user makes a deliberate
// choice rather than a default click-through.

import { useState } from "react";
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
import { EyeOff, Globe } from "lucide-react";

export interface CreateRoomSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	onCreate(opts: {
		name: string;
		topic: string;
		visibility: "public" | "private";
		encrypted: boolean;
		nsfw: boolean;
	}): Promise<void>;
	// True iff the viewer has the "Show NSFW rooms" preference on.
	// Gates visibility of the NSFW toggle: you can only create an
	// adult-content room if you've opted into seeing them yourself.
	// Stops "I marked the room NSFW without realizing what that
	// means" — explicit opt-in upstream.
	showNsfw: boolean;
}

export function CreateRoomSheet({ open, onOpenChange, onCreate, showNsfw }: CreateRoomSheetProps) {
	const [name, setName] = useState("");
	const [topic, setTopic] = useState("");
	const [visibility, setVisibility] = useState<"public" | "private">("public");
	const [encrypted, setEncrypted] = useState(false);
	const [nsfw, setNsfw] = useState(false);
	// Public + encrypted is a contradiction in Koven: the room is open
	// to anyone but the engine + admins can't see content, so consensus
	// moderation can't run.  When the user flips to public, we force
	// encryption off; the toggle below is also disabled in that mode.
	const canEncrypt = visibility === "private";
	const effectiveEncrypted = canEncrypt && encrypted;
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function reset() {
		setName("");
		setTopic("");
		setVisibility("public");
		setEncrypted(false);
		setNsfw(false);
		setError(null);
		setPending(false);
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) return;
		setPending(true);
		setError(null);
		try {
			await onCreate({ name: trimmed, topic: topic.trim(), visibility, encrypted: effectiveEncrypted, nsfw });
			reset();
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPending(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
			{/* Wider than the default sm:max-w-md so the encryption +
			    NSFW toggle blocks (each a paragraph of explanatory copy)
			    can sit side-by-side without forcing the dialog to
			    scroll.  Falls back to default mobile sizing under sm. */}
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Create a room</DialogTitle>
					<DialogDescription>
						Rooms are where conversation happens. You&rsquo;ll be the founder; channel governance settings are tunable later.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={submit} className="space-y-4">
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

					{/* Toggle row: encryption is always present, NSFW is
					    conditional.  Lay out side-by-side when both are
					    visible so the dialog doesn't grow tall enough
					    to need scrolling — falls back to single-column
					    when NSFW is hidden. */}
					<div className={cn("grid gap-3", showNsfw ? "grid-cols-2" : "grid-cols-1")}>
						<div className={cn(
							"flex items-start justify-between gap-3 rounded-md border border-border p-3",
							!canEncrypt && "opacity-60",
						)}>
							<div className="space-y-0.5 flex-1 min-w-0">
								<Label htmlFor="room-encrypted" className="cursor-pointer">End-to-end encryption</Label>
								<p className="text-xs text-muted-foreground leading-relaxed">
									{canEncrypt ? (
										<>
											Encrypted rooms are unreadable by the server. <strong className="text-foreground">Koven moderation cannot apply</strong> &mdash; flags, collapse, and the mod log go silent. Use only for trusted private spaces.
										</>
									) : (
										<>
											Encryption is only available on private rooms. Public rooms must stay readable so consensus moderation can work.
										</>
									)}
								</p>
							</div>
							<Switch
								id="room-encrypted"
								checked={effectiveEncrypted}
								onCheckedChange={setEncrypted}
								disabled={!canEncrypt}
							/>
						</div>

						{showNsfw && (
							<div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
								<div className="space-y-0.5 flex-1 min-w-0">
									<Label htmlFor="room-nsfw" className="cursor-pointer">Mark as NSFW</Label>
									<p className="text-xs text-muted-foreground leading-relaxed">
										Hides the room from Explore for users who haven&rsquo;t opted into NSFW content. <strong className="text-foreground">This can&rsquo;t be reversed</strong> — once marked, the room stays marked.
									</p>
								</div>
								<Switch
									id="room-nsfw"
									checked={nsfw}
									onCheckedChange={setNsfw}
								/>
							</div>
						)}
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

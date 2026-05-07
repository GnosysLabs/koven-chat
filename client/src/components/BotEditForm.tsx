// Inline bot create / edit form.  Renders in the BotsPane right-pane
// detail view (not a modal), so the experience matches editing a
// space or room in the rest of the app: the list lives in the left
// sidebar, the configuration takes the main pane.
//
// Validation is deliberately permissive: the engine does the
// authoritative check (lowercase a-z 0-9 -, length 1-21, uniqueness)
// and we only fence off obvious mistakes here so the user gets
// immediate feedback before the round-trip.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { BotBadge } from "@/components/BotBadge";
import { Camera, ChevronDown, Eye, EyeOff, FileText, Trash2, Upload, X } from "lucide-react";
import {
	createBot,
	patchBot,
	PROVIDER_DEFAULTS,
	removeBotAvatar,
	uploadBotAvatar,
	listBotKnowledge,
	uploadBotKnowledge,
	deleteBotKnowledge,
	type BotKnowledgeFile,
	type BotProvider,
	type BotSummary,
} from "@/lib/bots";
import { cn } from "@/lib/utils";

export interface BotEditFormProps {
	mode: "create" | "edit";
	// Required in edit mode.
	bot?: BotSummary | null;
	accessToken: string | null;
	// Called after a successful create / edit with the saved bot's
	// summary (so the caller can update its list + selection).
	onSaved(saved: BotSummary): void | Promise<void>;
	// Cancel button click — caller decides whether to clear the
	// selection, navigate elsewhere, etc.
	onCancel(): void;
	// Delete action — only shown in edit mode.  The form itself
	// handles the confirmation dialog before invoking this.
	onDelete?(bot: BotSummary): void | Promise<void>;
}

interface FormState {
	name: string;          // create-only
	displayName: string;
	provider: BotProvider;
	apiBase: string;
	apiKey: string;
	apiKeyMasked: boolean; // edit-only — shows ••• until user clicks Replace
	model: string;
	systemPrompt: string;
	contextWindow: number;
	triggers: string[];
}

function freshFormState(): FormState {
	return {
		name: "",
		displayName: "",
		provider: "openrouter",
		apiBase: PROVIDER_DEFAULTS.openrouter.api_base,
		apiKey: "",
		apiKeyMasked: false,
		model: PROVIDER_DEFAULTS.openrouter.model,
		systemPrompt: "",
		contextWindow: 20,
		triggers: [],
	};
}

function formStateFromBot(bot: BotSummary): FormState {
	return {
		name: bot.mxid.replace(/^@bot-/, "").replace(/:.*$/, ""),
		displayName: bot.display_name,
		provider: bot.provider,
		apiBase: bot.api_base,
		apiKey: "",                // empty by default; sent only if revealed/edited
		apiKeyMasked: bot.has_api_key,
		model: bot.model,
		systemPrompt: bot.system_prompt,
		contextWindow: bot.context_window,
		triggers: bot.triggers ?? [],
	};
}

const NAME_PATTERN = /^[a-z0-9-]{1,21}$/;

export function BotEditForm({
	mode,
	bot,
	accessToken,
	onSaved,
	onCancel,
	onDelete,
}: BotEditFormProps) {
	const [form, setForm] = useState<FormState>(() =>
		mode === "edit" && bot ? formStateFromBot(bot) : freshFormState(),
	);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showKey, setShowKey] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	// Auto-grow handle for the system prompt textarea — see useEffect
	// below.  Resetting height to "auto" first lets the browser
	// re-measure the natural content height before we pin it.
	const systemPromptRef = useRef<HTMLTextAreaElement | null>(null);
	// Avatar picker state.  Three states:
	//   - pendingAvatarFile + pendingAvatarPreview set → user picked a
	//     new image; preview the local object URL until save uploads it.
	//   - clearAvatarOnSave === true → user clicked the small X to
	//     remove the existing avatar; render the DiceBear fallback and
	//     fire DELETE on save.
	//   - both null/false → render whatever the bot already has.
	const avatarFileInputRef = useRef<HTMLInputElement | null>(null);
	const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
	const [pendingAvatarPreview, setPendingAvatarPreview] = useState<string | null>(null);
	const [clearAvatarOnSave, setClearAvatarOnSave] = useState(false);

	// Knowledge files.  Two states share this section:
	//   - Edit mode: existing files come from the engine (`knowledge`)
	//     and uploads / deletes happen immediately against /api/bots/
	//     :id/knowledge.
	//   - Create mode: there's no bot id yet, so picks queue locally
	//     in `pendingKnowledge` and upload after createBot succeeds
	//     (handleSubmit walks the queue at the end).
	const knowledgeFileInputRef = useRef<HTMLInputElement | null>(null);
	const [knowledge, setKnowledge] = useState<BotKnowledgeFile[]>([]);
	const [pendingKnowledge, setPendingKnowledge] = useState<File[]>([]);
	const [knowledgeBusy, setKnowledgeBusy] = useState(false);
	const [knowledgeError, setKnowledgeError] = useState<string | null>(null);

	// Reset whenever the target bot or mode changes — switching from
	// edit-bot-A to edit-bot-B (or to "create") shouldn't keep stale
	// form values around.
	useEffect(() => {
		setError(null);
		setShowKey(false);
		setSubmitting(false);
		setConfirmingDelete(false);
		setPendingAvatarFile(null);
		setPendingAvatarPreview(prev => {
			// Revoke the previous object URL so we don't leak browser
			// memory on form re-renders or bot-switches.
			if (prev) URL.revokeObjectURL(prev);
			return null;
		});
		setClearAvatarOnSave(false);
		setKnowledge([]);
		setPendingKnowledge([]);
		setKnowledgeError(null);
		if (mode === "edit" && bot) {
			setForm(formStateFromBot(bot));
		} else {
			setForm(freshFormState());
		}
	}, [mode, bot?.id]);

	// Fetch the bot's existing knowledge files when entering edit
	// mode (or when the selected bot changes).  Create mode skips —
	// no bot id to query yet; pendingKnowledge holds whatever the
	// user picks until handleSubmit can upload it post-create.
	useEffect(() => {
		if (!accessToken || mode !== "edit" || !bot?.id) return;
		let cancelled = false;
		listBotKnowledge(accessToken, bot.id)
			.then(r => { if (!cancelled) setKnowledge(r.files); })
			.catch(err => {
				if (!cancelled) setKnowledgeError(err instanceof Error ? err.message : String(err));
			});
		return () => { cancelled = true; };
	}, [accessToken, mode, bot?.id]);

	// Object-URL cleanup on unmount — covers the case where the form
	// closes with a pending pick that was never submitted.
	useEffect(() => {
		return () => {
			if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview);
		};
	}, [pendingAvatarPreview]);

	// Keep the system-prompt textarea sized to its content.  Recompute
	// on every value change so the height tracks both user typing and
	// the bot-load reset above (longer prompts grow the box, deletions
	// shrink it).  Setting height to "auto" first lets the browser
	// measure natural content height; scrollHeight then becomes the
	// new pinned height.
	useEffect(() => {
		const el = systemPromptRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [form.systemPrompt]);

	const update = <K extends keyof FormState>(k: K, v: FormState[K]) => {
		setForm(prev => ({ ...prev, [k]: v }));
	};

	const onProviderChange = (p: BotProvider) => {
		// `apiBase` is provider-bound: OpenRouter has exactly one
		// canonical URL and the field is locked in the form when
		// that provider is picked, so switching providers must
		// always reset apiBase to the new default.  Going to
		// openai_compatible reveals an empty (now-editable) URL
		// field; going to openrouter snaps it to the canonical
		// OpenRouter URL.
		//
		// The model name is preserved across provider changes in
		// edit mode (existing bots may have a custom model name
		// the owner wants to keep) but reset to the provider's
		// default in create mode where there's no prior choice
		// worth preserving.
		setForm(prev => {
			const d = PROVIDER_DEFAULTS[p];
			return {
				...prev,
				provider: p,
				apiBase: d.api_base,
				model: mode === "create" ? d.model : prev.model,
			};
		});
	};

	const nameError = useMemo(() => {
		if (mode !== "create") return null;
		if (!form.name) return null;
		if (!NAME_PATTERN.test(form.name)) {
			return "Lowercase a-z, 0-9, and -; up to 21 chars.";
		}
		return null;
	}, [form.name, mode]);

	const canSubmit =
		!submitting &&
		form.displayName.trim().length > 0 &&
		form.provider &&
		form.apiBase.trim().length > 0 &&
		form.model.trim().length > 0 &&
		(mode === "edit" || (form.name.length > 0 && !nameError && form.apiKey.length > 0));

	async function handleSubmit() {
		if (!accessToken) return;
		setSubmitting(true);
		setError(null);
		try {
			let saved: BotSummary;
			if (mode === "create") {
				saved = await createBot(accessToken, {
					name: form.name.trim().toLowerCase(),
					display_name: form.displayName.trim(),
					provider: form.provider,
					api_base: form.apiBase.trim(),
					api_key: form.apiKey,
					model: form.model.trim(),
					system_prompt: form.systemPrompt,
					context_window: form.contextWindow,
					triggers: form.triggers,
				});
			} else if (bot) {
				const patch: Record<string, unknown> = {
					display_name: form.displayName.trim(),
					provider: form.provider,
					api_base: form.apiBase.trim(),
					model: form.model.trim(),
					system_prompt: form.systemPrompt,
					context_window: form.contextWindow,
					triggers: form.triggers,
				};
				// Only send api_key if the user replaced it (mask was
				// off and a non-empty value entered).
				if (!form.apiKeyMasked && form.apiKey.length > 0) {
					patch.api_key = form.apiKey;
				}
				saved = await patchBot(accessToken, bot.id, patch);
			} else {
				return;
			}

			// Avatar follow-up.  Two cases beyond "no change":
			//   - pendingAvatarFile set → upload it.  The endpoint
			//     overwrites the bot's profile avatar on Synapse and
			//     returns the updated summary so we re-render with the
			//     mxc immediately (no /sync round-trip).
			//   - clearAvatarOnSave set → DELETE /api/bots/:id/avatar
			//     to wipe both the Synapse profile and our row.
			// Failures here don't undo the metadata save — log + show
			// the error so the user knows the avatar didn't apply.
			if (pendingAvatarFile) {
				try {
					saved = await uploadBotAvatar(accessToken, saved.id, pendingAvatarFile);
				} catch (err) {
					setError(`Saved, but avatar upload failed: ${err instanceof Error ? err.message : String(err)}`);
					await onSaved(saved);
					return;
				}
			} else if (clearAvatarOnSave && saved.avatar_mxc) {
				try {
					saved = await removeBotAvatar(accessToken, saved.id);
				} catch (err) {
					setError(`Saved, but avatar clear failed: ${err instanceof Error ? err.message : String(err)}`);
					await onSaved(saved);
					return;
				}
			}

			// Knowledge follow-up: in create mode any pending picks
			// queue here.  Walk them sequentially — parallel uploads
			// would all check the 50 MB total against the same pre-
			// upload number and let the bot exceed the cap.  Same
			// fail-soft pattern as the avatar branch above; the bot
			// is created either way.
			if (pendingKnowledge.length > 0) {
				try {
					for (const f of pendingKnowledge) {
						await uploadBotKnowledge(accessToken, saved.id, f);
					}
					setPendingKnowledge([]);
				} catch (err) {
					setError(`Saved, but knowledge upload failed: ${err instanceof Error ? err.message : String(err)}`);
					await onSaved(saved);
					return;
				}
			}

			await onSaved(saved);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}

	// Knowledge handlers.  Edit mode uploads/deletes hit the engine
	// immediately so the user gets instant feedback (no "wait until
	// you click Save"); create mode queues until the bot exists.
	async function pickKnowledgeFiles(files: FileList) {
		const arr = Array.from(files);
		if (arr.length === 0) return;
		setKnowledgeError(null);
		if (mode === "create") {
			setPendingKnowledge(prev => [...prev, ...arr]);
			return;
		}
		if (!accessToken || !bot) return;
		setKnowledgeBusy(true);
		try {
			for (const f of arr) {
				const meta = await uploadBotKnowledge(accessToken, bot.id, f);
				setKnowledge(prev => [...prev, meta]);
			}
		} catch (err) {
			setKnowledgeError(err instanceof Error ? err.message : String(err));
		} finally {
			setKnowledgeBusy(false);
		}
	}

	async function removeKnowledgeFile(fileId: number) {
		if (!accessToken || !bot) return;
		setKnowledgeError(null);
		setKnowledgeBusy(true);
		try {
			await deleteBotKnowledge(accessToken, bot.id, fileId);
			setKnowledge(prev => prev.filter(k => k.id !== fileId));
		} catch (err) {
			setKnowledgeError(err instanceof Error ? err.message : String(err));
		} finally {
			setKnowledgeBusy(false);
		}
	}

	function removePendingKnowledge(idx: number) {
		setPendingKnowledge(prev => prev.filter((_, i) => i !== idx));
	}

	function pickAvatar(file: File) {
		// Replace the existing pending pick (revoke its blob URL so
		// we don't leak), wire up the new one.  No upload yet — that
		// fires from handleSubmit.
		setPendingAvatarPreview(prev => {
			if (prev) URL.revokeObjectURL(prev);
			return URL.createObjectURL(file);
		});
		setPendingAvatarFile(file);
		setClearAvatarOnSave(false);
	}

	function clearAvatar() {
		setPendingAvatarFile(null);
		setPendingAvatarPreview(prev => {
			if (prev) URL.revokeObjectURL(prev);
			return null;
		});
		// Only flag the server-side clear if the bot already has an
		// avatar.  A fresh create with no pick + a click on the X is
		// a no-op.
		if (mode === "edit" && bot?.avatar_mxc) {
			setClearAvatarOnSave(true);
		}
	}

	// Live preview values — what the bot will look like in the chat
	// surface.  Falls back to the create-mode placeholder so the
	// preview is something useful even before the user types.
	const previewSeed = mode === "edit" && bot
		? bot.mxid
		: `@bot-${form.name || "new"}:local`;
	const previewName = form.displayName.trim() || (mode === "create" ? form.name || "New bot" : bot?.display_name ?? "");

	// Effective avatar source: pending preview wins; cleared flag
	// forces the DiceBear fallback; otherwise show whatever the bot
	// already has.
	const effectiveAvatarMxc = pendingAvatarPreview
		? undefined
		: clearAvatarOnSave
			? undefined
			: (mode === "edit" ? bot?.avatar_mxc ?? undefined : undefined);
	const showRemove = !!pendingAvatarPreview || (mode === "edit" && !!bot?.avatar_mxc && !clearAvatarOnSave);

	return (
		<div className="flex-1 min-w-0 flex flex-col bg-background overflow-hidden">
			{/* Header — bot identity preview at the top of the pane.
			    The avatar is clickable: opens a file picker that swaps
			    in a local preview; the actual upload happens on Save
			    (handleSubmit). */}
			<div className="px-6 pt-6 pb-4 border-b border-border flex items-center gap-4">
				<div className="relative shrink-0">
					<button
						type="button"
						onClick={() => avatarFileInputRef.current?.click()}
						className="group relative h-12 w-12 rounded-full overflow-hidden focus:outline-none focus:ring-2 focus:ring-primary"
						aria-label="Change bot avatar"
					>
						{pendingAvatarPreview ? (
							<img
								src={pendingAvatarPreview}
								alt=""
								className="h-12 w-12 rounded-full object-cover bg-muted"
							/>
						) : (
							<MatrixAvatar
								mxc={effectiveAvatarMxc}
								seed={previewSeed}
								kind="bot"
								className="h-12 w-12"
							/>
						)}
						{/* Hover overlay — surfaces the affordance only
						    when the user moves over the avatar so the
						    bot's image reads cleanly otherwise. */}
						<span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white">
							<Camera className="h-4 w-4" />
						</span>
					</button>
					{showRemove && (
						<button
							type="button"
							onClick={clearAvatar}
							title="Remove avatar"
							aria-label="Remove avatar"
							className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-card border border-border text-muted-foreground hover:text-destructive hover:border-destructive transition-colors flex items-center justify-center"
						>
							<X className="h-3 w-3" />
						</button>
					)}
					<input
						ref={avatarFileInputRef}
						type="file"
						accept="image/png,image/jpeg,image/webp,image/gif"
						className="hidden"
						onChange={e => {
							const file = e.target.files?.[0];
							if (file) pickAvatar(file);
							// Reset so the same file can be re-picked
							// after a clear + re-attach in one flow.
							e.target.value = "";
						}}
					/>
				</div>
				<div className="min-w-0 flex-1">
					<div className="text-base font-semibold truncate flex items-center gap-1.5">
						<span className="truncate">{previewName || "—"}</span>
						<BotBadge />
					</div>
					<div className="text-xs text-muted-foreground truncate">
						{mode === "edit" && bot
							? bot.mxid
							: form.name
								? `@bot-${form.name}`
								: "Pick a name your bot will be mentioned by"}
					</div>
					{mode === "edit" && bot && bot.total_calls > 0 && (
						<div className="text-xs text-muted-foreground mt-0.5">
							{bot.total_calls.toLocaleString()} calls ·{" "}
							{(bot.total_prompt_tokens + bot.total_completion_tokens).toLocaleString()} tokens
						</div>
					)}
				</div>
			</div>

			{/* Body — scrollable form, organised into three sections
			    (Identity, Connection, Behavior) each prefaced with a
			    short header.  Field widths are deliberate: short
			    fields like Provider and Context window are sized to
			    their content; URLs and prompts get full width within a
			    768px reading column.  Avoids the dead-grid-cell look
			    of a rigid column layout. */}
			<div className="flex-1 overflow-y-auto px-6 py-6">
				<div className="space-y-8 max-w-3xl">
					{/* ─── Identity ─────────────────────────────────── */}
					<section className="space-y-4">
						<SectionHeader
							title="Identity"
							subtitle="What this bot looks like to people in the room."
						/>
						<div className="flex flex-wrap gap-4">
							{mode === "create" && (
								<div className="space-y-1.5 w-56">
									<Label htmlFor="bot-name">Name</Label>
									<div className="flex items-center gap-2">
										<span className="text-sm text-muted-foreground">@bot-</span>
										<Input
											id="bot-name"
											value={form.name}
											onChange={e => update("name", e.target.value)}
											placeholder="gptcoder"
											autoComplete="off"
											autoCorrect="off"
											autoCapitalize="off"
										/>
									</div>
									<p className={cn(
										"text-xs",
										nameError ? "text-destructive" : "text-muted-foreground",
									)}>
										{nameError ?? "Becomes the bot's username on this server."}
									</p>
								</div>
							)}
							<div className="space-y-1.5 w-72">
								<Label htmlFor="bot-display">Display name</Label>
								<Input
									id="bot-display"
									value={form.displayName}
									onChange={e => update("displayName", e.target.value)}
									placeholder="GPT Coder"
								/>
							</div>
						</div>
					</section>

					<Divider />

					{/* ─── Connection ───────────────────────────────── */}
					<section className="space-y-4">
						<SectionHeader
							title="Connection"
							subtitle="Where to send chat completion requests, and which model to ask."
						/>

						{/* Provider + Model on one row — provider is a
						    fixed-list dropdown so it gets a tight width;
						    model identifiers can be long, so it grows. */}
						<div className="flex flex-wrap gap-4">
							<div className="space-y-1.5 w-56">
								<Label htmlFor="bot-provider">Provider</Label>
								<div className="relative">
									<select
										id="bot-provider"
										value={form.provider}
										onChange={e => onProviderChange(e.target.value as BotProvider)}
										className="h-9 w-full appearance-none rounded-md border border-foreground/15 bg-background pl-3 pr-9 text-sm shadow-sm transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring"
									>
										<option value="openrouter">OpenRouter</option>
										<option value="openai_compatible">OpenAI-compatible</option>
									</select>
									<ChevronDown
										className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none"
										aria-hidden
									/>
								</div>
							</div>
							<div className="space-y-1.5 flex-1 min-w-[16rem]">
								<Label htmlFor="bot-model">Model</Label>
								<Input
									id="bot-model"
									value={form.model}
									onChange={e => update("model", e.target.value)}
									placeholder="~google/gemini-flash-latest"
								/>
							</div>
						</div>

						{/* OpenRouter has exactly one valid base URL —
						    locking the field stops the user from typing
						    something the engine can't reach.  Switching
						    to "openai_compatible" via Provider clears
						    the field (see onProviderChange). */}
						<div className="space-y-1.5">
							<Label htmlFor="bot-api-base">API base URL</Label>
							<Input
								id="bot-api-base"
								value={form.apiBase}
								onChange={e => update("apiBase", e.target.value)}
								placeholder={form.provider === "openrouter" ? "" : "https://api.example.com/v1"}
								disabled={form.provider === "openrouter"}
							/>
							{form.provider === "openrouter" && (
								<p className="text-xs text-muted-foreground">
									Locked to OpenRouter's endpoint. Switch the Provider to "OpenAI-compatible" to use a custom URL.
								</p>
							)}
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="bot-api-key">API key</Label>
							{form.apiKeyMasked ? (
								<div className="flex items-center gap-2">
									<div className="flex-1 h-9 px-3 rounded-md border border-foreground/15 bg-muted text-sm flex items-center text-muted-foreground tracking-widest">
										••••••••
									</div>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => {
											setForm(prev => ({ ...prev, apiKeyMasked: false, apiKey: "" }));
											setShowKey(true);
										}}
									>
										Replace
									</Button>
								</div>
							) : (
								<div className="relative">
									<Input
										id="bot-api-key"
										type={showKey ? "text" : "password"}
										value={form.apiKey}
										onChange={e => update("apiKey", e.target.value)}
										placeholder={mode === "create" ? "sk-or-..." : "New key — leave blank to cancel replace"}
										autoComplete="off"
										className="pr-9"
									/>
									<button
										type="button"
										aria-label={showKey ? "Hide API key" : "Show API key"}
										onClick={() => setShowKey(s => !s)}
										className="absolute inset-y-0 right-0 px-2 flex items-center text-muted-foreground hover:text-foreground"
									>
										{showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
									</button>
								</div>
							)}
							<p className="text-xs text-muted-foreground">
								Stored encrypted (AES-256-GCM) on the server. The plaintext never returns to your client.
							</p>
						</div>
					</section>

					<Divider />

					{/* ─── Behavior ─────────────────────────────────── */}
					<section className="space-y-4">
						<SectionHeader
							title="Behavior"
							subtitle="How the bot responds when someone @mentions it."
						/>

						<div className="space-y-1.5 w-32">
							<Label htmlFor="bot-context">Context window</Label>
							<Input
								id="bot-context"
								type="number"
								min={1}
								max={100}
								value={form.contextWindow}
								onChange={e => update("contextWindow", Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
							/>
						</div>
						<p className="text-xs text-muted-foreground -mt-2">
							Number of recent messages from the room to include in each prompt. Higher = more context for the model, more tokens billed per reply.
						</p>

						<div className="space-y-1.5">
							<Label>Trigger phrases <span className="text-muted-foreground font-normal">(optional)</span></Label>
							<TriggerInput
								triggers={form.triggers}
								onChange={next => update("triggers", next)}
							/>
							<p className="text-xs text-muted-foreground">
								Phrases that wake the bot up the same way an @mention does. Type a phrase and press <kbd className="px-1 py-0.5 rounded border border-border bg-muted text-[10px] font-mono">Enter</kbd> or <kbd className="px-1 py-0.5 rounded border border-border bg-muted text-[10px] font-mono">,</kbd> to add it. Matched word-by-word, case-insensitive — "vessel" matches "Vessel" but not "vessels."
							</p>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="bot-system-prompt">System prompt <span className="text-muted-foreground font-normal">(optional)</span></Label>
							<textarea
								ref={systemPromptRef}
								id="bot-system-prompt"
								value={form.systemPrompt}
								onChange={e => update("systemPrompt", e.target.value)}
								rows={3}
								placeholder="Leave blank for vanilla model behaviour."
								// resize-none kills the native drag handle
								// in the bottom-right corner; overflow-
								// hidden prevents the scrollbar from
								// flickering during the auto-grow recalc.
								// The effect above pins height to
								// scrollHeight on every value change.
								className="w-full rounded-md border border-foreground/15 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none overflow-hidden"
							/>
						</div>
					</section>

					<Divider />

					{/* ─── Knowledge ────────────────────────────────── */}
					<section className="space-y-4">
						<SectionHeader
							title="Knowledge"
							subtitle="Reference material the bot can quote from. Each file's full text is included in every prompt — keep them concise, since longer files mean more tokens billed per reply."
						/>

						<KnowledgeList
							knowledge={knowledge}
							pendingKnowledge={pendingKnowledge}
							busy={knowledgeBusy}
							onRemoveExisting={removeKnowledgeFile}
							onRemovePending={removePendingKnowledge}
						/>

						<div>
							<input
								ref={knowledgeFileInputRef}
								type="file"
								accept=".txt,.md,.markdown,.csv,.tsv,.log,.json,.yaml,.yml,.xml,.html,.htm,.docx,.rtf"
								multiple
								className="hidden"
								onChange={e => {
									if (e.target.files) pickKnowledgeFiles(e.target.files);
									e.target.value = "";
								}}
							/>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => knowledgeFileInputRef.current?.click()}
								disabled={knowledgeBusy}
								className="gap-1.5"
							>
								<Upload className="h-4 w-4" />
								{knowledgeBusy ? "Uploading…" : "Upload files"}
							</Button>
							<p className="text-xs text-muted-foreground mt-1.5">
								Plain text (.txt, .md), Word (.docx), or Apple/RTF (.rtf). Up to 10&nbsp;MB per file, 50&nbsp;MB total per bot.
							</p>
						</div>

						{knowledgeError && (
							<div className="text-sm text-destructive border border-destructive/40 bg-destructive/5 rounded-md px-3 py-2">
								{knowledgeError}
							</div>
						)}
					</section>

					{error && (
						<div className="text-sm text-destructive border border-destructive/40 bg-destructive/5 rounded-md px-3 py-2">
							{error}
						</div>
					)}
				</div>
			</div>

			{/* Sticky footer with primary actions and (in edit mode)
			    the destructive delete affordance.  The two-step delete
			    happens inline rather than as a modal so the user stays
			    in the same view. */}
			<div className="px-6 py-3 border-t border-border bg-card/50 flex items-center gap-2">
				{mode === "edit" && bot && onDelete && (
					!confirmingDelete ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setConfirmingDelete(true)}
							className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1.5"
						>
							<Trash2 className="h-4 w-4" />
							Delete
						</Button>
					) : (
						<div className="flex items-center gap-2 mr-auto">
							<span className="text-xs text-muted-foreground">Delete this bot?</span>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => setConfirmingDelete(false)}
							>
								Cancel
							</Button>
							<Button
								type="button"
								variant="destructive"
								size="sm"
								onClick={() => {
									setConfirmingDelete(false);
									void onDelete(bot);
								}}
							>
								Confirm delete
							</Button>
						</div>
					)
				)}
				<div className="flex-1" />
				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					type="button"
					size="sm"
					onClick={handleSubmit}
					disabled={!canSubmit}
				>
					{submitting ? "Saving…" : mode === "create" ? "Create bot" : "Save changes"}
				</Button>
			</div>
		</div>
	);
}

// Small section heading + supporting line.  Kept inline in the same
// file because no other surface needs it; if more settings sheets
// adopt this pattern we'll lift it into a shared primitive.
function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
	return (
		<div className="space-y-0.5">
			<h3 className="text-sm font-semibold leading-none">{title}</h3>
			<p className="text-xs text-muted-foreground">{subtitle}</p>
		</div>
	);
}

// Hairline divider between sections.  A 1px border doesn't read
// against the dark background; bg-border with explicit height
// renders crisply on every theme.
function Divider() {
	return <div className="h-px bg-border" aria-hidden />;
}

// Render the bot's existing knowledge files plus any pending picks
// queued for upload.  Empty-state copy nudges the user to upload
// something useful instead of just showing a void.
function KnowledgeList({
	knowledge,
	pendingKnowledge,
	busy,
	onRemoveExisting,
	onRemovePending,
}: {
	knowledge: BotKnowledgeFile[];
	pendingKnowledge: File[];
	busy: boolean;
	onRemoveExisting(id: number): void;
	onRemovePending(idx: number): void;
}) {
	if (knowledge.length === 0 && pendingKnowledge.length === 0) {
		return (
			<div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
				No knowledge files yet.
			</div>
		);
	}
	return (
		<ul className="rounded-md border border-border divide-y divide-border bg-card/30">
			{knowledge.map(k => (
				<li key={`existing-${k.id}`} className="px-3 py-2 flex items-center gap-3">
					<FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
					<div className="flex-1 min-w-0">
						<div className="text-sm truncate">{k.filename}</div>
						<div className="text-[11px] text-muted-foreground">{formatBytes(k.bytes)}</div>
					</div>
					<button
						type="button"
						onClick={() => onRemoveExisting(k.id)}
						disabled={busy}
						title="Remove file"
						aria-label="Remove file"
						className="text-muted-foreground hover:text-destructive disabled:opacity-40"
					>
						<X className="h-4 w-4" />
					</button>
				</li>
			))}
			{pendingKnowledge.map((f, i) => (
				<li key={`pending-${i}`} className="px-3 py-2 flex items-center gap-3 bg-primary/5">
					<FileText className="h-4 w-4 shrink-0 text-primary" />
					<div className="flex-1 min-w-0">
						<div className="text-sm truncate">{f.name}</div>
						<div className="text-[11px] text-muted-foreground">
							{formatBytes(f.size)} · queued — uploads after save
						</div>
					</div>
					<button
						type="button"
						onClick={() => onRemovePending(i)}
						title="Remove from queue"
						aria-label="Remove from queue"
						className="text-muted-foreground hover:text-destructive"
					>
						<X className="h-4 w-4" />
					</button>
				</li>
			))}
		</ul>
	);
}

// Chip-style multi-value input.  Existing entries render as pills
// with an X to remove; a single trailing input takes new entries.
// Enter or `,` commits the typed value as a chip; Backspace on an
// empty field removes the last chip.  Trims, dedupes case-
// insensitively, caps to 50 (matches the server-side sanitiser),
// matches per-phrase length cap of 100.
function TriggerInput({
	triggers,
	onChange,
}: {
	triggers: string[];
	onChange(next: string[]): void;
}) {
	const [draft, setDraft] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);

	function commit(raw: string) {
		const trimmed = raw.trim().slice(0, 100);
		if (!trimmed) return;
		const lower = trimmed.toLowerCase();
		if (triggers.some(t => t.toLowerCase() === lower)) return;
		if (triggers.length >= 50) return;
		onChange([...triggers, trimmed]);
		setDraft("");
	}

	function remove(idx: number) {
		onChange(triggers.filter((_, i) => i !== idx));
	}

	return (
		<div
			className="flex flex-wrap items-center gap-1.5 min-h-9 rounded-md border border-foreground/15 bg-background px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring focus-within:border-ring"
			onClick={() => inputRef.current?.focus()}
		>
			{triggers.map((t, i) => (
				<span
					key={`${t}-${i}`}
					className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded bg-primary/15 text-primary text-xs"
				>
					<span>{t}</span>
					<button
						type="button"
						onClick={e => { e.stopPropagation(); remove(i); }}
						aria-label={`Remove ${t}`}
						className="hover:text-destructive"
					>
						<X className="h-3 w-3" />
					</button>
				</span>
			))}
			<input
				ref={inputRef}
				type="text"
				value={draft}
				onChange={e => {
					const v = e.target.value;
					// Treat a typed comma as a chip-commit too — matches
					// the spec the user asked for ("tag separated").
					if (v.endsWith(",")) {
						commit(v.slice(0, -1));
					} else {
						setDraft(v);
					}
				}}
				onKeyDown={e => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit(draft);
					} else if (e.key === "Backspace" && draft === "" && triggers.length > 0) {
						e.preventDefault();
						remove(triggers.length - 1);
					}
				}}
				onBlur={() => commit(draft)}
				placeholder={triggers.length === 0 ? "i need help, vessel, on-call" : ""}
				className="flex-1 min-w-[8ch] bg-transparent outline-none text-sm py-0.5"
			/>
		</div>
	);
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

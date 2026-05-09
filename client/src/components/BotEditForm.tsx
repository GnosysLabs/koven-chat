// Inline bot create / edit form.  Renders in the BotsPane right-pane
// detail view (not a modal), so the experience matches editing a
// space or room in the rest of the app: the list lives in the left
// sidebar, the configuration takes the main pane.
//
// Tabbed wizard: each section (Identity, Connection, Behavior,
// Knowledge, Tools) is one step.  Users can either walk it
// linearly with the Next button or jump to any tab from the strip.
// Save / Create is always available in the footer when the form is
// valid — the tabs are organisation, not a gate.
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
import {
	Camera,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Eye,
	EyeOff,
	FileText,
	Plug,
	Search,
	Trash2,
	Upload,
	X,
} from "lucide-react";
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
import {
	listBotMcpServers as fetchBotMcpServers,
	attachBotMcpServer,
	detachBotMcpServer,
	searchSmitheryCatalog,
	getSmitheryServerDetail,
	SmitheryKeyMissingError,
	type BotMcpAttachment,
	type SmitheryServerSummary,
	type SmitheryServerDetail,
} from "@/lib/bot-mcp";
import { McpConfigDialog } from "@/components/McpConfigDialog";
import { claimBellOffset, releaseBellOffset } from "@/state/bell-offset";
import { cn } from "@/lib/utils";

export interface BotEditFormProps {
	mode: "create" | "edit";
	// Required in edit mode.
	bot?: BotSummary | null;
	accessToken: string | null;
	// Homeserver portion of the eventual bot mxid (e.g. "100.76.239.128").
	// Used to make the create-mode avatar preview seed match what the
	// server will actually compute, so the avatar doesn't visibly
	// change between preview and post-create.
	homeserverName: string;
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
	bio: string;
	provider: BotProvider;
	apiBase: string;
	apiKey: string;
	apiKeyMasked: boolean; // edit-only — shows ••• until user clicks Replace
	model: string;
	systemPrompt: string;
	contextWindow: number;
}

function freshFormState(): FormState {
	return {
		name: "",
		displayName: "",
		bio: "",
		provider: "openrouter",
		apiBase: PROVIDER_DEFAULTS.openrouter.api_base,
		apiKey: "",
		apiKeyMasked: false,
		model: PROVIDER_DEFAULTS.openrouter.model,
		systemPrompt: "",
		contextWindow: 20,
	};
}

function formStateFromBot(bot: BotSummary): FormState {
	return {
		name: bot.mxid.replace(/^@bot-/, "").replace(/:.*$/, ""),
		displayName: bot.display_name,
		bio: bot.bio ?? "",
		provider: bot.provider,
		apiBase: bot.api_base,
		apiKey: "",                // empty by default; sent only if revealed/edited
		apiKeyMasked: bot.has_api_key,
		model: bot.model,
		systemPrompt: bot.system_prompt,
		contextWindow: bot.context_window,
	};
}

const NAME_PATTERN = /^[a-z0-9-]{1,21}$/;

/** Catalog pick queued during create mode.  Carries the summary so
 * the Tools tab can render the queued row with display name +
 * description, plus the per-server config the user supplied via
 * McpConfigDialog (empty object for servers that didn't need any). */
interface PendingMcpAttachment {
	server: SmitheryServerSummary;
	config: Record<string, unknown>;
}

/** Tabs are ordered by the typical create flow.  "tools" is gated
 * behind edit mode in create flows (the bot needs to exist before we
 * can attach a server to it) — see the `availableTabs` memo below. */
type TabKey = "identity" | "connection" | "behavior" | "knowledge" | "tools";

interface TabDef {
	key: TabKey;
	label: string;
}

const ALL_TABS: TabDef[] = [
	{ key: "identity",   label: "Identity"   },
	{ key: "connection", label: "Connection" },
	{ key: "behavior",   label: "Behavior"   },
	{ key: "knowledge",  label: "Knowledge"  },
	{ key: "tools",      label: "Tools"      },
];

export function BotEditForm({
	mode,
	bot,
	accessToken,
	homeserverName,
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
	const [activeTab, setActiveTab] = useState<TabKey>("identity");
	// True between a successful save and the next time the user
	// edits anything — drives the primary button to read "Saved"
	// (greyed, disabled) so it's obvious the click took effect
	// instead of just flashing back to "Save changes".  Cleared by
	// the update() helper on any field change.
	const [justSaved, setJustSaved] = useState(false);
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

	// MCP server picks queued during create.  In edit mode the Tools
	// tab attaches/detaches against the engine immediately; in
	// create mode there's no bot id yet, so picks queue here and
	// flush after createBot succeeds (same pattern as knowledge).
	// We store the catalog summary (not just the qualified name) so
	// the Tools tab can render the queued items with their display
	// name + description without re-fetching.  `config` carries the
	// per-server config the user entered through the McpConfigDialog
	// — empty for servers that don't need any.
	const [pendingMcpAttachments, setPendingMcpAttachments] = useState<PendingMcpAttachment[]>([]);

	// Push the floating notification bell up by the footer height
	// while this form is mounted — without this, the FAB sits on top
	// of the Cancel / Save buttons in the bottom-right corner.
	useEffect(() => {
		const id = `bot-edit-form-${mode}-${bot?.id ?? "new"}`;
		// Footer is ~56px tall (px-6 py-3 + button row).  Add a
		// 12px gap so the bell visibly clears the footer's top edge.
		claimBellOffset(id, 56 + 12);
		return () => releaseBellOffset(id);
	}, [mode, bot?.id]);

	// Reset whenever the target bot or mode changes — switching from
	// edit-bot-A to edit-bot-B (or to "create") shouldn't keep stale
	// form values around.
	useEffect(() => {
		setError(null);
		setShowKey(false);
		setSubmitting(false);
		setConfirmingDelete(false);
		setActiveTab("identity");
		setJustSaved(false);
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
		setPendingMcpAttachments([]);
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
	// new pinned height.  Also runs on tab change so switching to
	// Behavior re-measures (the textarea was display:none until now).
	useEffect(() => {
		const el = systemPromptRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [form.systemPrompt, activeTab]);

	const update = <K extends keyof FormState>(k: K, v: FormState[K]) => {
		setForm(prev => ({ ...prev, [k]: v }));
		// Any field edit invalidates the "just saved" state so the
		// primary button switches back to "Save changes".
		if (justSaved) setJustSaved(false);
	};

	// Mark the form dirty whenever a non-text mutator fires (provider
	// switch, avatar pick / clear).  Text-input edits go through
	// update() above which handles the same flag itself.
	const markDirty = () => { if (justSaved) setJustSaved(false); };

	const onProviderChange = (p: BotProvider) => {
		markDirty();
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

	// Tools tab is available in both modes.  In create mode picks
	// queue locally in `pendingMcpAttachments` and flush after
	// createBot succeeds (handleSubmit walks the queue, same as
	// knowledge); in edit mode the tab talks to the engine API
	// directly.
	const availableTabs = ALL_TABS;

	const tabIndex = availableTabs.findIndex(t => t.key === activeTab);
	const safeTabIndex = tabIndex < 0 ? 0 : tabIndex;
	const currentTabKey = availableTabs[safeTabIndex]?.key ?? "identity";
	const isFirstTab = safeTabIndex === 0;
	const isLastTab = safeTabIndex === availableTabs.length - 1;

	function goToTab(k: TabKey) {
		setActiveTab(k);
	}

	function goNext() {
		const next = availableTabs[safeTabIndex + 1];
		if (next) setActiveTab(next.key);
	}

	function goBack() {
		const prev = availableTabs[safeTabIndex - 1];
		if (prev) setActiveTab(prev.key);
	}

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
					bio: form.bio.trim(),
				});
			} else if (bot) {
				const patch: Record<string, unknown> = {
					display_name: form.displayName.trim(),
					provider: form.provider,
					api_base: form.apiBase.trim(),
					model: form.model.trim(),
					system_prompt: form.systemPrompt,
					context_window: form.contextWindow,
					bio: form.bio.trim(),
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

			// MCP follow-up: same idea as knowledge.  Each pending
			// pick from the catalog gets attached against the freshly
			// created bot.  Sequential because each attach is a small
			// DB write and the engine treats duplicate attaches as
			// upsert — concurrent retries would race the unique
			// constraint and confuse error reporting.
			if (pendingMcpAttachments.length > 0) {
				try {
					for (const p of pendingMcpAttachments) {
						await attachBotMcpServer(accessToken, saved.id, p.server.qualifiedName, p.config);
					}
					setPendingMcpAttachments([]);
				} catch (err) {
					setError(`Saved, but tool attach failed: ${err instanceof Error ? err.message : String(err)}`);
					await onSaved(saved);
					return;
				}
			}

			await onSaved(saved);
			// Flip into the "Saved" affordance after a clean save —
			// the button stays greyed and disabled until the user
			// edits something, which markDirty() / update() reset.
			// Edit mode only: in create mode the form is unmounting
			// (selection flips to the new bot), so the indicator
			// would be invisible anyway.
			if (mode === "edit") setJustSaved(true);
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
		markDirty();
		setPendingAvatarPreview(prev => {
			if (prev) URL.revokeObjectURL(prev);
			return URL.createObjectURL(file);
		});
		setPendingAvatarFile(file);
		setClearAvatarOnSave(false);
	}

	function clearAvatar() {
		markDirty();
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
	// Compose the preview seed against the user's actual homeserver
	// so the DiceBear hash matches what MatrixAvatar will render
	// post-create.  Empty name → "new" placeholder so the avatar is
	// stable across keystrokes until the user picks something.
	const previewSeed = mode === "edit" && bot
		? bot.mxid
		: `@bot-${form.name || "new"}:${homeserverName}`;
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

			{/* Tab strip.  Sticky under the header so it stays visible
			    while the body scrolls.  Each tab is a button that flips
			    activeTab; the body below renders only the active tab's
			    section.  Visual treatment: underline indicator on the
			    active tab, hover lifts the muted-foreground tabs to
			    foreground.  We don't gate clicks on validation — users
			    can jump freely; canSubmit decides whether Save fires.  */}
			<div className="px-6 border-b border-border bg-card/30 sticky top-0 z-10">
				<div className="flex items-center gap-1 overflow-x-auto -mb-px">
					{availableTabs.map(t => {
						const isActive = t.key === currentTabKey;
						return (
							<button
								key={t.key}
								type="button"
								onClick={() => goToTab(t.key)}
								className={cn(
									"relative px-3 py-2.5 text-sm whitespace-nowrap transition-colors",
									"border-b-2",
									isActive
										? "text-foreground border-primary font-medium"
										: "text-muted-foreground border-transparent hover:text-foreground hover:border-border",
								)}
							>
								{t.label}
							</button>
						);
					})}
				</div>
			</div>

			{/* Body — renders the active tab's content.  `key` on the
			    inner div would reset scroll on every tab change; we
			    leave it untyped so each tab's scroll position is
			    independent (the outer container handles overflow). */}
			<div className="flex-1 overflow-y-auto px-6 py-6">
				<div className="max-w-3xl">
					{currentTabKey === "identity"   && renderIdentityTab()}
					{currentTabKey === "connection" && renderConnectionTab()}
					{currentTabKey === "behavior"   && renderBehaviorTab()}
					{currentTabKey === "knowledge"  && renderKnowledgeTab()}
					{currentTabKey === "tools"      && (
						<ToolsTab
							bot={bot ?? null}
							accessToken={accessToken}
							pendingAttachments={pendingMcpAttachments}
							onPendingChange={setPendingMcpAttachments}
						/>
					)}

					{error && (
						<div className="mt-6 text-sm text-destructive border border-destructive/40 bg-destructive/5 rounded-md px-3 py-2">
							{error}
						</div>
					)}
				</div>
			</div>

			{/* Sticky footer with primary actions and (in edit mode)
			    the destructive delete affordance.  The two-step delete
			    happens inline rather than as a modal so the user stays
			    in the same view.  Back/Next live alongside Save so
			    sequential walkers and free-jumpers both have the
			    controls they need without burying anything in a menu. */}
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

				{!isFirstTab && (
					<Button type="button" variant="ghost" size="sm" onClick={goBack} className="gap-1">
						<ChevronLeft className="h-4 w-4" />
						Back
					</Button>
				)}
				{!isLastTab && (
					<Button type="button" variant="outline" size="sm" onClick={goNext} className="gap-1">
						Next
						<ChevronRight className="h-4 w-4" />
					</Button>
				)}

				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					type="button"
					size="sm"
					onClick={handleSubmit}
					// Disabled while submitting OR after a clean save
					// until the user edits again — the button labels
					// reflect each state in turn ("Saving…" → "Saved"
					// → "Save changes" the moment a field changes).
					disabled={!canSubmit || justSaved}
					// `variant=secondary` for the saved state so the
					// button visibly recedes (greyed out instead of
					// the primary accent), reinforcing the "no work
					// queued" read.  Active button keeps the default
					// primary variant.
					variant={justSaved ? "secondary" : "default"}
				>
					{submitting
						? "Saving…"
						: justSaved
							? "Saved"
							: mode === "create"
								? "Create bot"
								: "Save changes"}
				</Button>
			</div>
		</div>
	);

	// ─── Tab body renderers ────────────────────────────────────────
	// Inlined as nested functions so they close over the form state
	// without a prop-drilling layer.  The Tools tab is a real
	// sub-component because it owns its own catalog/search state and
	// would otherwise force the whole form to re-render on every
	// keystroke in the search box.

	function renderIdentityTab() {
		return (
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

				{/* Public bio — same field humans see on their
				    profile sheet.  Caps at 300 chars to match
				    the human ceiling enforced server-side. */}
				<div className="space-y-1.5 max-w-2xl">
					<Label htmlFor="bot-bio">
						Bio <span className="text-muted-foreground font-normal">(optional)</span>
					</Label>
					<textarea
						id="bot-bio"
						value={form.bio}
						onChange={e => update("bio", e.target.value)}
						placeholder="A short description of what this bot does."
						maxLength={300}
						rows={2}
						className={cn(
							"flex w-full rounded-md border border-foreground/15 bg-transparent px-3 py-1.5 text-sm shadow-sm transition-colors",
							"hover:border-foreground/25",
							"placeholder:text-muted-foreground",
							"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring",
							"resize-none leading-normal",
						)}
					/>
					<p className="text-[10px] text-muted-foreground">
						Shown on the bot's profile sheet alongside its display name and avatar. {form.bio.length}/300.
					</p>
				</div>
			</section>
		);
	}

	function renderConnectionTab() {
		return (
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
							placeholder="google/gemini-3.1-flash-lite"
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
		);
	}

	function renderBehaviorTab() {
		return (
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
		);
	}

	function renderKnowledgeTab() {
		return (
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
		);
	}
}

// Small section heading + supporting line.  Kept inline in the same
// file because no other surface needs it; if more settings sheets
// adopt this pattern we'll lift it into a shared primitive.
function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
	return (
		<div className="space-y-0.5 mb-4">
			<h3 className="text-sm font-semibold leading-none">{title}</h3>
			<p className="text-xs text-muted-foreground">{subtitle}</p>
		</div>
	);
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

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ─── Tools (MCP) tab ───────────────────────────────────────────────
//
// Two sections:
//   - Attached servers: GET /api/bots/:id/mcp + per-row detach
//   - Catalog browse: search field hits /api/smithery/search,
//     click a result to attach.  Shows a "configure your Smithery
//     key first" nudge when the engine reports the key is missing.
//
// Servers with required config (the registry's JSONSchema marks
// fields as `required`) are surfaced with a hint — for now the
// attach flow uses an empty config object.  A first-class config
// form generator is future work.

function ToolsTab({
	bot,
	accessToken,
	pendingAttachments,
	onPendingChange,
}: {
	bot: BotSummary | null;
	accessToken: string | null;
	/** Catalog picks queued during create mode.  Ignored in edit
	 * mode (where we mutate the engine directly).  The parent flushes
	 * this queue after createBot succeeds. */
	pendingAttachments: PendingMcpAttachment[];
	onPendingChange(next: PendingMcpAttachment[]): void;
}) {
	const isCreateMode = bot === null;

	const [attached, setAttached] = useState<BotMcpAttachment[]>([]);
	const [loading, setLoading] = useState(!isCreateMode);
	const [listError, setListError] = useState<string | null>(null);

	const [query, setQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SmitheryServerSummary[]>([]);
	const [searching, setSearching] = useState(false);
	const [searchError, setSearchError] = useState<string | null>(null);
	const [keyMissing, setKeyMissing] = useState(false);

	const [busyQualifiedName, setBusyQualifiedName] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	// Config-dialog state.  When the user clicks Attach on a server
	// whose schema declares required fields, we open this dialog
	// with the server's detail and complete the attach only after
	// the user fills it out.  Servers with no required config skip
	// the dialog and attach directly.
	const [configTarget, setConfigTarget] = useState<{
		summary: SmitheryServerSummary;
		detail: SmitheryServerDetail;
	} | null>(null);

	// Initial fetch of the bot's existing attachments.  Re-runs when
	// the bot id changes (parent flips between bots).  Skipped
	// entirely in create mode — there's no bot id yet, the source of
	// truth is the parent's pendingAttachments queue.
	useEffect(() => {
		if (!accessToken || !bot) {
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setListError(null);
		fetchBotMcpServers(accessToken, bot.id)
			.then(rows => { if (!cancelled) setAttached(rows); })
			.catch(err => { if (!cancelled) setListError(err instanceof Error ? err.message : String(err)); })
			.finally(() => { if (!cancelled) setLoading(false); });
		return () => { cancelled = true; };
	}, [accessToken, bot?.id]);

	// Debounced catalog search.  Empty query returns top servers; the
	// 250ms wait is enough to avoid hammering the proxy on every
	// keystroke without making the UI feel sluggish.
	useEffect(() => {
		if (!accessToken) return;
		let cancelled = false;
		setSearchError(null);
		setKeyMissing(false);
		const handle = window.setTimeout(async () => {
			setSearching(true);
			try {
				const r = await searchSmitheryCatalog(accessToken, query);
				if (!cancelled) setSearchResults(r.servers);
			} catch (err) {
				if (cancelled) return;
				if (err instanceof SmitheryKeyMissingError) {
					setKeyMissing(true);
					setSearchResults([]);
				} else {
					setSearchError(err instanceof Error ? err.message : String(err));
				}
			} finally {
				if (!cancelled) setSearching(false);
			}
		}, 250);
		return () => { cancelled = true; window.clearTimeout(handle); };
	}, [accessToken, query]);

	async function attach(server: SmitheryServerSummary) {
		if (!accessToken) return;
		setActionError(null);
		setBusyQualifiedName(server.qualifiedName);

		// Fetch the server detail before deciding what to do.  When
		// the schema declares required fields we route through the
		// config dialog; when it doesn't, we attach immediately with
		// an empty config object.  Detail-fetch failure is non-fatal
		// — fall through to direct-attach so the user isn't blocked
		// on a transient registry hiccup.
		let detail: SmitheryServerDetail | null = null;
		try { detail = await getSmitheryServerDetail(accessToken, server.qualifiedName); } catch { /* fall through */ }
		setBusyQualifiedName(null);

		if (detail && hasRequiredConfig(detail.configSchema)) {
			// Open the dialog and stop here — completion fires
			// from finishAttach() once the user submits the form.
			setConfigTarget({ summary: server, detail });
			return;
		}

		await finishAttach(server, {});
	}

	/** Complete the attach, with whatever config the dialog (or empty
	 * defaulting) produced.  Two routing branches:
	 *   - Create mode: enqueue with config; the parent flushes after
	 *     createBot succeeds.
	 *   - Edit mode: POST /api/bots/:id/mcp now with the config and
	 *     update local list state on success.
	 * Throws on edit-mode network failure so the dialog can surface
	 * the error inline rather than closing optimistically. */
	async function finishAttach(server: SmitheryServerSummary, config: Record<string, unknown>) {
		if (!accessToken) return;
		if (isCreateMode) {
			const filtered = pendingAttachments.filter(p => p.server.qualifiedName !== server.qualifiedName);
			onPendingChange([...filtered, { server, config }]);
			return;
		}
		if (!bot) return;
		setBusyQualifiedName(server.qualifiedName);
		try {
			const row = await attachBotMcpServer(accessToken, bot.id, server.qualifiedName, config);
			setAttached(prev => {
				// Engine treats duplicate attach as upsert — match
				// that semantics client-side so the list doesn't
				// duplicate after a re-attach.
				const filtered = prev.filter(p => p.smithery_qualified_name !== row.smithery_qualified_name);
				return [...filtered, row];
			});
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
			throw err;
		} finally {
			setBusyQualifiedName(null);
		}
	}

	async function detach(row: BotMcpAttachment) {
		if (!accessToken || !bot) return;
		setActionError(null);
		setBusyQualifiedName(row.smithery_qualified_name);
		try {
			await detachBotMcpServer(accessToken, bot.id, row.id);
			setAttached(prev => prev.filter(p => p.id !== row.id));
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyQualifiedName(null);
		}
	}

	function detachPending(qualifiedName: string) {
		setActionError(null);
		onPendingChange(pendingAttachments.filter(p => p.server.qualifiedName !== qualifiedName));
	}

	// Names already attached (or queued).  Drives the "Attached" /
	// disabled state on catalog results so the user can't queue the
	// same server twice.
	const attachedQualifiedNames = new Set(
		isCreateMode
			? pendingAttachments.map(a => a.server.qualifiedName)
			: attached.map(a => a.smithery_qualified_name),
	);

	return (
		<section className="space-y-6">
			<SectionHeader
				title="Tools"
				subtitle="Smithery-hosted MCP servers this bot can call.  Tools listed by each server become available to the model on every reply."
			/>

			{/* Attached list — in create mode this renders the queued
			    catalog picks (flushed by the parent after Create bot);
			    in edit mode it's the live engine list. */}
			<div className="space-y-2">
				<div className="text-xs font-medium uppercase text-muted-foreground tracking-wide">
					{isCreateMode ? "Queued" : "Attached"}
				</div>
				{!isCreateMode && loading ? (
					<div className="text-sm text-muted-foreground">Loading…</div>
				) : listError ? (
					<div className="text-sm text-destructive border border-destructive/40 bg-destructive/5 rounded-md px-3 py-2">
						{listError}
					</div>
				) : isCreateMode ? (
					pendingAttachments.length === 0 ? (
						<div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
							No tools queued. Search the catalog below — picks will attach when you create the bot.
						</div>
					) : (
						<ul className="rounded-md border border-border divide-y divide-border bg-primary/5">
							{pendingAttachments.map(row => {
								const hasConfig = Object.keys(row.config).length > 0;
								return (
									<li key={row.server.qualifiedName} className="px-3 py-2.5 flex items-center gap-3">
										<Plug className="h-4 w-4 shrink-0 text-primary" />
										<div className="flex-1 min-w-0">
											<div className="text-sm font-medium truncate">{row.server.displayName}</div>
											<div className="text-[11px] text-muted-foreground truncate">
												{row.server.qualifiedName} · queued{hasConfig ? " · configured" : ""} — attaches after create
											</div>
										</div>
										<button
											type="button"
											onClick={() => detachPending(row.server.qualifiedName)}
											title="Remove from queue"
											aria-label="Remove from queue"
											className="text-muted-foreground hover:text-destructive"
										>
											<X className="h-4 w-4" />
										</button>
									</li>
								);
							})}
						</ul>
					)
				) : attached.length === 0 ? (
					<div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
						No tools attached. Search the catalog below to add one.
					</div>
				) : (
					<ul className="rounded-md border border-border divide-y divide-border bg-card/30">
						{attached.map(row => (
							<li key={row.id} className="px-3 py-2.5 flex items-center gap-3">
								<Plug className="h-4 w-4 shrink-0 text-muted-foreground" />
								<div className="flex-1 min-w-0">
									<div className="text-sm font-medium truncate">{row.smithery_qualified_name}</div>
									{Object.keys(row.config).length > 0 && (
										<div className="text-[11px] text-muted-foreground">configured</div>
									)}
								</div>
								<button
									type="button"
									onClick={() => detach(row)}
									disabled={busyQualifiedName === row.smithery_qualified_name}
									title="Remove tool"
									aria-label="Remove tool"
									className="text-muted-foreground hover:text-destructive disabled:opacity-40"
								>
									<X className="h-4 w-4" />
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			{/* Catalog search */}
			<div className="space-y-2">
				<div className="text-xs font-medium uppercase text-muted-foreground tracking-wide">Browse Smithery catalog</div>

				{keyMissing ? (
					<div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-3 text-sm">
						<p className="font-medium">Connect your Smithery account first</p>
						<p className="text-muted-foreground mt-0.5">
							Add your Smithery API key in Account → Integrations to browse and attach tools.
						</p>
					</div>
				) : (
					<>
						<div className="relative max-w-md">
							<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
							<Input
								value={query}
								onChange={e => setQuery(e.target.value)}
								placeholder="Search for a tool/capability"
								className="pl-9"
								autoComplete="off"
							/>
						</div>

						{searchError && (
							<div className="text-sm text-destructive border border-destructive/40 bg-destructive/5 rounded-md px-3 py-2">
								{searchError}
							</div>
						)}

						{searching && searchResults.length === 0 ? (
							<div className="text-sm text-muted-foreground">Searching…</div>
						) : searchResults.length === 0 ? (
							<div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
								No matches.
							</div>
						) : (
							<ul className="rounded-md border border-border divide-y divide-border">
								{searchResults.map(s => {
									const isAttached = attachedQualifiedNames.has(s.qualifiedName);
									const isBusy = busyQualifiedName === s.qualifiedName;
									return (
										<li key={s.qualifiedName} className="px-3 py-2.5 flex items-start gap-3">
											<div className="flex-1 min-w-0">
												<div className="flex items-center gap-2">
													<span className="text-sm font-medium truncate">{s.displayName}</span>
													{s.isDeployed === false && (
														<span className="text-[10px] px-1.5 py-0.5 rounded-full border border-border text-muted-foreground">
															not deployed
														</span>
													)}
												</div>
												<div className="text-[11px] text-muted-foreground truncate">{s.qualifiedName}</div>
												{s.description && (
													<p className="text-xs text-muted-foreground mt-1 line-clamp-2">{s.description}</p>
												)}
											</div>
											<Button
												type="button"
												size="sm"
												variant={isAttached ? "ghost" : "outline"}
												disabled={isAttached || isBusy || s.isDeployed === false}
												onClick={() => attach(s)}
											>
												{isAttached
													? (isCreateMode ? "Queued" : "Attached")
													: isBusy ? "Attaching…"
													: (isCreateMode ? "Queue" : "Attach")}
											</Button>
										</li>
									);
								})}
							</ul>
						)}
					</>
				)}

				{actionError && (
					<div className="text-sm text-destructive border border-destructive/40 bg-destructive/5 rounded-md px-3 py-2">
						{actionError}
					</div>
				)}
			</div>

			{configTarget && (
				<McpConfigDialog
					open={!!configTarget}
					onOpenChange={(o) => { if (!o) setConfigTarget(null); }}
					displayName={configTarget.summary.displayName}
					qualifiedName={configTarget.summary.qualifiedName}
					homepage={configTarget.summary.homepage}
					configSchema={configTarget.detail.configSchema}
					onSubmit={async (config) => {
						await finishAttach(configTarget.summary, config);
					}}
				/>
			)}
		</section>
	);
}

/** True if the registry's config schema declares any required
 * fields.  We use this only as a UX warning — empty config is
 * always sent on attach; runtime failures surface in the bot logs. */
function hasRequiredConfig(schema: Record<string, unknown> | undefined): boolean {
	if (!schema) return false;
	const required = (schema as { required?: unknown }).required;
	return Array.isArray(required) && required.length > 0;
}

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

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MatrixAvatar } from "@/components/MatrixAvatar";
import { BotBadge } from "@/components/BotBadge";
import {
	AlertCircle,
	Camera,
	ChevronDown,
	ChevronRight,
	Copy,
	Eye,
	EyeOff,
	FileText,
	Pencil,
	Plug,
	Plus,
	Search,
	Trash2,
	Upload,
	Webhook,
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
	importBotMcpServers,
	patchBotMcpServer,
	detachBotMcpServer,
	type BotMcpAttachment,
} from "@/lib/bot-mcp";
import {
	listBotWebhooks,
	createBotWebhook,
	deleteBotWebhook,
	listBotWebhookDeliveries,
	webhookUrlFor,
	type WebhookSummary,
	type WebhookCreated,
	type WebhookDelivery,
} from "@/lib/webhooks-api";
import {
	listBotOutboundWebhooks,
	createBotOutboundWebhook,
	updateBotOutboundWebhook,
	deleteBotOutboundWebhook,
	type OutboundWebhook,
	type OutboundParam,
	type OutboundHeader,
} from "@/lib/outbound-webhooks-api";
import { useTransport } from "@/lib/transportContext";
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
	// Spending guardrails.  Stored as strings in form state so the
	// inputs can show empty (= unlimited) cleanly without displaying
	// a literal 0; coerced to numbers at submit time.
	maxTokensPerReply: string;
	dailyTokenLimit: string;
	dailyCallLimit: string;
	// Privacy gate.  When false, non-owners can't DM this bot.
	// Default true so the bot is open to anyone in the absence of
	// explicit opt-out — matches the platform's existing behaviour
	// for already-deployed bots after the column migration.
	acceptDms: boolean;
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
		maxTokensPerReply: "",
		dailyTokenLimit: "",
		dailyCallLimit: "",
		acceptDms: true,
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
		// Engine returns 0 for "unlimited"; show that as empty in the
		// inputs so the user sees blank rather than a literal 0.
		maxTokensPerReply: bot.max_tokens_per_reply > 0 ? String(bot.max_tokens_per_reply) : "",
		dailyTokenLimit: bot.daily_token_limit > 0 ? String(bot.daily_token_limit) : "",
		dailyCallLimit: bot.daily_call_limit > 0 ? String(bot.daily_call_limit) : "",
		acceptDms: bot.accept_dms,
	};
}

/** Coerce a limit input value (string from the form) into the wire
 * number — 0 means unlimited.  Empty / non-numeric falls through to
 * 0 so the user can clear a limit by emptying the field. */
function parseLimit(s: string): number {
	const n = Number(s);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.floor(n);
}

/** Options for the Limits-tab dropdowns.  Stored value is a string
 * (matches FormState which keeps everything as strings); empty
 * string = "unlimited" sentinel (maps to 0 on the wire via
 * parseLimit).  Labels use compact suffixes (1K / 1M) so the
 * column stays narrow.  Update freely — the engine clamps to its
 * own ceilings (1M for max-per-reply, 1B for daily-tokens, 1M for
 * daily-calls), so adding bigger values here is safe. */
interface LimitOption {
	value: string;
	label: string;
}

// Per-reply token cap.  Labels are the raw token counts — vague
// "sentence / paragraph" descriptors mislead because real reply
// length depends on the model's verbosity, formatting, and the
// system-prompt length hint we attach in the engine.  Token count
// is the only number that's stable across models.  Engine appends a
// natural-language length cue to the system prompt based on this
// number (see lengthHint() in engine/src/bot_pipeline.ts), so the
// model self-limits at sentence/paragraph boundaries above the cap.
const MAX_REPLY_OPTIONS: LimitOption[] = [
	{ value: "",     label: "Unlimited" },
	{ value: "40",   label: "40 tokens" },
	{ value: "100",  label: "100 tokens" },
	{ value: "200",  label: "200 tokens" },
	{ value: "400",  label: "400 tokens" },
	{ value: "800",  label: "800 tokens" },
	{ value: "1500", label: "1500 tokens" },
];

const DAILY_TOKEN_OPTIONS: LimitOption[] = [
	{ value: "",          label: "Unlimited" },
	{ value: "100000",    label: "100K" },
	{ value: "500000",    label: "500K" },
	{ value: "1000000",   label: "1M" },
	{ value: "3000000",   label: "3M" },
	{ value: "5000000",   label: "5M" },
	{ value: "10000000",  label: "10M" },
	{ value: "25000000",  label: "25M" },
	{ value: "50000000",  label: "50M" },
	{ value: "100000000", label: "100M" },
];

const DAILY_CALL_OPTIONS: LimitOption[] = [
	{ value: "",     label: "Unlimited" },
	{ value: "10",   label: "10" },
	{ value: "25",   label: "25" },
	{ value: "50",   label: "50" },
	{ value: "100",  label: "100" },
	{ value: "250",  label: "250" },
	{ value: "500",  label: "500" },
	{ value: "1000", label: "1,000" },
	{ value: "5000", label: "5,000" },
];

/** Styled `<select>` for the Limits tab, matching the Provider /
 * Bearer dropdowns elsewhere in the form (appearance-none plus a
 * stacked ChevronDown to keep the chevron off the border).  When
 * the bot's saved value isn't in the option list (e.g. an admin
 * tweaked the column directly, or the option list shrank in a
 * later release), we surface the raw value as a "Custom: N" entry
 * so the user can see + keep their existing setting rather than
 * having it silently snap to the closest preset. */
function LimitSelect({
	id, value, onChange, options,
}: {
	id: string;
	value: string;
	onChange(v: string): void;
	options: LimitOption[];
}) {
	const knownValues = new Set(options.map(o => o.value));
	const showCustom = value !== "" && !knownValues.has(value);
	return (
		<div className="relative">
			<select
				id={id}
				value={value}
				onChange={e => onChange(e.target.value)}
				className="h-9 w-full appearance-none rounded-md border border-foreground/15 bg-background pl-3 pr-9 text-sm shadow-sm transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring"
			>
				{options.map(o => (
					<option key={o.value} value={o.value}>{o.label}</option>
				))}
				{showCustom && (
					<option value={value}>Custom: {Number(value).toLocaleString()}</option>
				)}
			</select>
			<ChevronDown
				className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none"
				aria-hidden
			/>
		</div>
	);
}

const NAME_PATTERN = /^[a-z0-9-]{1,21}$/;

/** MCP attachment queued during create mode.  Same shape as the
 * AttachMcpRequest the engine accepts after bot creation; the
 * parent's handleSubmit flushes the queue against /api/bots/:id/mcp
 * once the new bot id exists. */
/** A queued MCP attachment from create mode.  Two flavours
 * matching the live-attach paths:
 *   kind='http'  → label + URL + headers, flushed via
 *                  attachBotMcpServer once the bot exists.
 *   kind='paste' → raw JSON the user pasted, flushed via
 *                  importBotMcpServers (which parses + version-pins).
 *                  Always treated as a single queue entry even if
 *                  the JSON contains multiple servers — the import
 *                  endpoint expands them server-side.
 *
 * The discriminated union keeps the create-mode tools tab honest:
 * users can attach hosted URLs AND paste stdio configs in the same
 * create flow, and both flush after the first save. */
type PendingMcpAttachment =
	| {
		kind?: "http"; // optional for backwards compat; default 'http'
		label: string;
		url: string;
		headers: Record<string, string>;
	}
	| {
		kind: "paste";
		/** Display label derived from the JSON for the queued list.
		 * Best-effort: counts the servers in the paste, e.g. "Paste
		 * config (3 servers)". */
		label: string;
		/** Raw JSON the user pasted.  Forwarded as-is to
		 * importBotMcpServers on flush. */
		pasteJson: string;
	};

/** A webhook the user added during create mode, queued in
 * BotEditForm and flushed against /api/bots/:id/webhooks once the
 * bot exists.  Same fields as the create body; matches PendingMcp's
 * pattern so a single handleSubmit can walk both queues. */
interface PendingWebhook {
	label: string;
	targetRoomId: string;
	/** Server generates a random HMAC secret on save.  Mutually
	 * exclusive with `providedSecret`. */
	generateSecret: boolean;
	/** User-supplied secret (Twilio Auth Token, etc.).  Sent verbatim
	 * to the engine on save and stored as the webhook's HMAC secret
	 * for signature verification. */
	providedSecret?: string;
}

/** Tabs are ordered by the typical create flow.  "tools" is gated
 * behind edit mode in create flows (the bot needs to exist before we
 * can attach a server to it) — see the `availableTabs` memo below. */
type TabKey = "identity" | "connection" | "behavior" | "knowledge" | "tools" | "webhooks" | "limits";

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
	{ key: "webhooks",   label: "Webhooks"   },
	{ key: "limits",     label: "Limits"     },
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
	// Webhooks queued during create mode.  Same idea as
	// pendingMcpAttachments: in create mode the bot doesn't have
	// an id yet so we can't POST against /api/bots/:id/webhooks;
	// queue locally + flush after createBot succeeds.  The flush
	// returns each webhook's URL + (optional) secret which we
	// stash in `justCreatedWebhooksBatch` below to surface in a
	// one-time banner the user must acknowledge before onSaved
	// closes the form.
	const [pendingWebhooks, setPendingWebhooks] = useState<PendingWebhook[]>([]);
	// One-time post-save credentials banner.  Set to the array of
	// freshly-created webhooks (with plaintext secrets) only when a
	// create-mode flush produces them; cleared by the "Done" button
	// which then triggers onSaved.  Edit-mode webhook creation has
	// its own per-call banner inside WebhooksTab and doesn't touch
	// this state.
	const [justCreatedWebhooksBatch, setJustCreatedWebhooksBatch] = useState<WebhookCreated[] | null>(null);
	const [pendingPostSave, setPendingPostSave] = useState<BotSummary | null>(null);

	// Snapshot of the form at load time — used by the dirty check
	// that gates the Save button in edit mode so it isn't clickable
	// when the user hasn't actually changed anything.  Reset in the
	// same useEffect that resets the form (mode / bot id change).
	// In create mode the snapshot is the empty starting state, so
	// editing any field marks the form dirty straight away.
	const initialFormRef = useRef<FormState>(freshFormState());

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
			const snap = formStateFromBot(bot);
			setForm(snap);
			initialFormRef.current = snap;
		} else {
			const snap = freshFormState();
			setForm(snap);
			initialFormRef.current = snap;
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

	// Dirty check — has anything actually changed vs the loaded
	// snapshot?  Used in edit mode to grey out Save when there's
	// nothing to save.  Compares each form field individually
	// (cheaper than JSON.stringify on every render) and folds in
	// the side-channel "pending" pieces that don't live in form
	// state (avatar pick / clear, queued knowledge / MCP / webhook
	// items in create mode).  In create mode the snapshot is the
	// empty starting state so any non-default field counts as dirty
	// — matches the existing "Create bot requires displayName +
	// name + apiKey" gate, which already covers the validity side.
	const formChanged = useMemo(() => {
		const a = form;
		const b = initialFormRef.current;
		return (
			a.name !== b.name
			|| a.displayName !== b.displayName
			|| a.bio !== b.bio
			|| a.provider !== b.provider
			|| a.apiBase !== b.apiBase
			|| a.apiKey !== b.apiKey
			|| a.apiKeyMasked !== b.apiKeyMasked
			|| a.model !== b.model
			|| a.systemPrompt !== b.systemPrompt
			|| a.contextWindow !== b.contextWindow
			|| a.maxTokensPerReply !== b.maxTokensPerReply
			|| a.dailyTokenLimit !== b.dailyTokenLimit
			|| a.dailyCallLimit !== b.dailyCallLimit
			|| a.acceptDms !== b.acceptDms
		);
	}, [form]);
	const sideChannelDirty =
		!!pendingAvatarFile
		|| clearAvatarOnSave
		|| pendingKnowledge.length > 0
		|| pendingMcpAttachments.length > 0
		|| pendingWebhooks.length > 0;
	const isDirty = formChanged || sideChannelDirty;

	// Tools tab is available in both modes.  In create mode picks
	// queue locally in `pendingMcpAttachments` and flush after
	// createBot succeeds (handleSubmit walks the queue, same as
	// knowledge); in edit mode the tab talks to the engine API
	// directly.
	const availableTabs = ALL_TABS;

	const tabIndex = availableTabs.findIndex(t => t.key === activeTab);
	const safeTabIndex = tabIndex < 0 ? 0 : tabIndex;
	const currentTabKey = availableTabs[safeTabIndex]?.key ?? "identity";

	function goToTab(k: TabKey) {
		setActiveTab(k);
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
					max_tokens_per_reply: parseLimit(form.maxTokensPerReply),
					daily_token_limit: parseLimit(form.dailyTokenLimit),
					daily_call_limit: parseLimit(form.dailyCallLimit),
				});
				// Newly-created bots inherit the engine default (open
				// to DMs from anyone).  If the form's flipped to
				// closed before submit, write that through as a
				// follow-up patch — keeps the create payload narrow
				// and avoids a server-side schema change just for
				// the rare opt-out-at-create flow.
				if (!form.acceptDms) {
					try {
						saved = await patchBot(accessToken, saved.id, { accept_dms: false });
					} catch (err) {
						console.warn("BotEditForm: failed to apply accept_dms=false on create", err);
					}
				}
			} else if (bot) {
				const patch: Record<string, unknown> = {
					display_name: form.displayName.trim(),
					provider: form.provider,
					api_base: form.apiBase.trim(),
					model: form.model.trim(),
					system_prompt: form.systemPrompt,
					context_window: form.contextWindow,
					bio: form.bio.trim(),
					max_tokens_per_reply: parseLimit(form.maxTokensPerReply),
					daily_token_limit: parseLimit(form.dailyTokenLimit),
					daily_call_limit: parseLimit(form.dailyCallLimit),
					accept_dms: form.acceptDms,
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
						if (p.kind === "paste") {
							// Pasted JSON config — bulk-import,
							// engine parses + version-pins each
							// server inside.  Warnings / skipped
							// rows are dropped here in the create
							// flow; user can re-paste in edit mode
							// to see them surfaced.
							await importBotMcpServers(accessToken, saved.id, p.pasteJson);
						} else {
							await attachBotMcpServer(accessToken, saved.id, {
								label: p.label,
								url: p.url,
								headers: p.headers,
							});
						}
					}
					setPendingMcpAttachments([]);
				} catch (err) {
					setError(`Saved, but tool attach failed: ${err instanceof Error ? err.message : String(err)}`);
					await onSaved(saved);
					return;
				}
			}

			// Webhook follow-up: same shape as MCP and knowledge —
			// queued during create mode in `pendingWebhooks`, flushed
			// here against /api/bots/:id/webhooks.  The POST returns
			// each webhook's plaintext secret (when generated); we
			// stash the batch in `justCreatedWebhooksBatch` and gate
			// onSaved behind the user dismissing a one-time
			// credentials banner so they have a chance to copy them.
			// Without that gate the secrets would be lost forever
			// the moment the form closes — the engine intentionally
			// doesn't store secrets in a recoverable form.
			if (pendingWebhooks.length > 0) {
				const created: WebhookCreated[] = [];
				try {
					for (const w of pendingWebhooks) {
						const c = await createBotWebhook({
							accessToken,
							botId: saved.id,
							targetRoomId: w.targetRoomId,
							label: w.label,
							generateSecret: w.generateSecret,
							secret: w.providedSecret,
						});
						created.push(c);
					}
					setPendingWebhooks([]);
				} catch (err) {
					setError(`Saved, but webhook create failed: ${err instanceof Error ? err.message : String(err)}`);
					await onSaved(saved);
					return;
				}
				if (created.length > 0) {
					// Defer onSaved until the user dismisses the
					// secrets banner — see the JSX render block
					// keyed off justCreatedWebhooksBatch below.
					setJustCreatedWebhooksBatch(created);
					setPendingPostSave(saved);
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
			if (mode === "edit") {
				setJustSaved(true);
				// Re-baseline the dirty snapshot to the just-saved
				// state.  Without this, even after a successful save
				// the dirty check would report "still dirty" because
				// the snapshot still points at the pre-edit version
				// of the form, and the Save button would re-enable
				// the moment the user touches anything (which would
				// be confusing — they just saved).  formStateFromBot
				// reads the SAME row we just persisted via patchBot,
				// so this is the correct new baseline.
				initialFormRef.current = formStateFromBot(saved);
			}
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

	// One-time secrets banner.  Renders ABOVE the rest of the form
	// (and disables the form interaction visually) when a create-mode
	// flush produced webhooks with secrets — the user must
	// acknowledge it so they have a chance to copy the URLs +
	// signing secrets before the form closes (engine doesn't store
	// secrets recoverably).  Done button drops the banner + fires
	// onSaved.
	if (justCreatedWebhooksBatch && pendingPostSave) {
		const n = justCreatedWebhooksBatch.length;
		// Adapt the headline copy to the actual situation.  When the
		// user pasted their own secret(s) the engine returns
		// `secret: null` for those rows, so the "copy this now or roll
		// it" instruction would be a lie — they already have it.  Only
		// urge "copy now" when there's at least one server-generated
		// secret the user genuinely won't see again.
		const hasGeneratedSecret = justCreatedWebhooksBatch.some(w => !!w.secret);
		const allHaveGenerated = justCreatedWebhooksBatch.every(w => !!w.secret);
		const subline = hasGeneratedSecret
			? (allHaveGenerated
				? `Copy the signing secret${n === 1 ? "" : "s"} now — ${n === 1 ? "it" : "they"} won’t be shown again. The webhook URL${n === 1 ? "" : "s"} ${n === 1 ? "stays" : "stay"} visible in the Webhooks tab.`
				: `Copy the generated signing secrets now — they won’t be shown again. Webhook URLs stay visible in the Webhooks tab.`)
			: `Copy the URL${n === 1 ? "" : "s"} into your source service. ${n === 1 ? "It" : "They"} also stay visible in the Webhooks tab.`;
		const buttonLabel = hasGeneratedSecret
			? `I’ve copied ${n === 1 && allHaveGenerated ? "it" : "them"}`
			: "Done";
		return (
			<div className="flex-1 min-w-0 flex flex-col bg-background overflow-auto">
				<div className="flex-1 flex items-start justify-center px-6 py-10">
					<div className="w-full max-w-2xl">
						{/* Hero header — brand-tinted icon disc + headline.
						    The disc echoes the BotBadge / FounderBadge
						    visual language so the moment feels native to
						    Koven, not a generic "alert" surface. */}
						<div className="flex flex-col items-center text-center mb-8">
							<div className="relative mb-4">
								<div className="absolute inset-0 rounded-full bg-primary/30 blur-xl" />
								<div className="relative h-14 w-14 rounded-full bg-primary/15 ring-1 ring-primary/40 flex items-center justify-center text-primary">
									<Webhook className="h-7 w-7" strokeWidth={2} />
								</div>
							</div>
							<h2 className="text-xl font-semibold tracking-tight">
								{n === 1 ? "Webhook ready" : `${n} webhooks ready`}
							</h2>
							<p className="text-sm text-muted-foreground mt-2 max-w-md leading-relaxed">
								{subline}
							</p>
						</div>

						{/* Per-webhook card.  Subtle border + label chip
						    at the top so multiple webhooks visually
						    separate without feeling like nested boxes. */}
						<div className="space-y-3">
							{justCreatedWebhooksBatch.map(w => (
								<div
									key={w.id}
									className="rounded-lg border border-border/70 bg-card/60 backdrop-blur-sm overflow-hidden"
								>
									<div className="px-4 py-2.5 border-b border-border/50 bg-muted/30 flex items-center gap-2">
										<Webhook className="h-3.5 w-3.5 text-primary/80 shrink-0" />
										<span className="text-sm font-medium truncate">
											{w.label || <span className="text-muted-foreground italic">unlabeled</span>}
										</span>
									</div>
									<div className="p-4 space-y-3">
										<CopyableField label="Webhook URL" value={webhookUrlFor(w.token)} />
										{w.secret && (
											<CopyableField label="Signing secret" value={w.secret} secret />
										)}
									</div>
								</div>
							))}
						</div>

						<div className="flex justify-end mt-6">
							<Button
								type="button"
								size="lg"
								onClick={async () => {
									const saved = pendingPostSave;
									setJustCreatedWebhooksBatch(null);
									setPendingPostSave(null);
									if (saved) await onSaved(saved);
								}}
							>
								{buttonLabel}
							</Button>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="flex-1 min-w-0 flex flex-col bg-background overflow-hidden">
			{/* Header — bot identity preview at the top of the pane.
			    The avatar is clickable: opens a file picker that swaps
			    in a local preview; the actual upload happens on Save
			    (handleSubmit).  WKWebView (Tauri) needs the file-
			    picker UIDelegate from src-tauri/src/plugins/
			    mac_webrtc_permission.rs to be installed, otherwise
			    file inputs silently no-op. */}
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
						accept="image/*"
						className="hidden"
						onChange={e => {
							const file = e.target.files?.[0];
							if (file) pickAvatar(file);
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
					{currentTabKey === "webhooks"   && (
						<WebhooksTab
							bot={bot ?? null}
							accessToken={accessToken}
							pendingWebhooks={pendingWebhooks}
							onPendingChange={setPendingWebhooks}
						/>
					)}
					{currentTabKey === "limits"     && renderLimitsTab()}

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

				<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					type="button"
					size="sm"
					onClick={handleSubmit}
					// Disabled when:
					//   - submitting (avoids double-click)
					//   - just saved (user hasn't touched anything since)
					//   - in edit mode AND the form is clean (no actual
					//     changes to send — without this gate the button
					//     was always clickable on bot edit, which read
					//     as "what does this even do" UX)
					// Create mode keeps the existing presence-based gate
					// (canSubmit) — there's no "saved snapshot" to be
					// dirty against, the form starts blank by definition.
					disabled={
						!canSubmit
						|| justSaved
						|| (mode === "edit" && !isDirty)
					}
					// `variant=secondary` for the saved / clean state so
					// the button visibly recedes (greyed out instead of
					// the primary accent), reinforcing the "no work
					// queued" read.  Active button keeps the default
					// primary variant.
					variant={(justSaved || (mode === "edit" && !isDirty)) ? "secondary" : "default"}
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

				{/* Privacy gate.  Default-on (open to anyone) so
				    existing bots and freshly-created bots both
				    behave the same way unless the owner explicitly
				    flips it.  Group-room invites are always owner-
				    only — no UI for that since it's not a setting,
				    it's a hard rule enforced engine-side. */}
				<div className="space-y-2 max-w-2xl pt-2 border-t border-border">
					<div className="flex items-start gap-3">
						<button
							type="button"
							role="switch"
							aria-checked={form.acceptDms}
							onClick={() => update("acceptDms", !form.acceptDms)}
							className={cn(
								"shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
								form.acceptDms ? "bg-primary" : "bg-muted",
							)}
						>
							<span
								className={cn(
									"inline-block h-4 w-4 transform rounded-full bg-background transition-transform",
									form.acceptDms ? "translate-x-[18px]" : "translate-x-0.5",
								)}
							/>
						</button>
						<div className="space-y-1">
							<Label className="cursor-pointer" onClick={() => update("acceptDms", !form.acceptDms)}>
								Accept DMs from other users
							</Label>
							<p className="text-[11px] text-muted-foreground leading-snug">
								When off, only you can DM this bot. {form.acceptDms
									? "Anyone on the instance can start a DM with it."
									: "DM invites from other users are silently declined."} Group-room invites are always owner-only regardless of this setting.
							</p>
						</div>
					</div>
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

				{/* API base URL: only relevant when the provider is
				    "openai_compatible".  OpenRouter has exactly one
				    valid base URL (kept in form state via
				    onProviderChange but never edited or displayed),
				    so showing a disabled field with a "locked"
				    explainer is just noise.  Hidden entirely. */}
				{form.provider === "openai_compatible" && (
					<div className="space-y-1.5">
						<Label htmlFor="bot-api-base">API base URL</Label>
						<Input
							id="bot-api-base"
							value={form.apiBase}
							onChange={e => update("apiBase", e.target.value)}
							placeholder="https://api.example.com/v1"
						/>
					</div>
				)}

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

	function renderLimitsTab() {
		// Show today's UTC usage (edit mode only) so the owner can
		// gauge headroom relative to their daily caps without leaving
		// the form.  Lifetime totals come from BotSummary; daily
		// rolling counters aren't on the summary, so we derive a
		// rough sense from "since last_used_at" hints below the
		// inputs.  A future enhancement could add a /api/bots/:id/usage
		// endpoint for true today-only numbers.
		const lifetimeTokens = mode === "edit" && bot
			? bot.total_prompt_tokens + bot.total_completion_tokens
			: 0;
		const lifetimeCalls = mode === "edit" && bot ? bot.total_calls : 0;
		return (
			<section className="space-y-4">
				<SectionHeader
					title="Limits"
					subtitle="Spending guardrails. Leave any field blank for unlimited. The bot stops responding once a daily cap is reached and resumes at 00:00 UTC."
				/>

				<div className="space-y-1.5 max-w-xs">
					<Label htmlFor="bot-max-tokens">
						Max tokens per reply <span className="text-muted-foreground font-normal">(optional)</span>
					</Label>
					<LimitSelect
						id="bot-max-tokens"
						value={form.maxTokensPerReply}
						onChange={v => update("maxTokensPerReply", v)}
						options={MAX_REPLY_OPTIONS}
					/>
					<p className="text-xs text-muted-foreground">
						Caps the output length of a single LLM call. Useful when the model gets chatty — passes through to OpenAI's <code className="font-mono text-[11px]">max_tokens</code>.
					</p>
				</div>

				<div className="space-y-1.5 max-w-xs">
					<Label htmlFor="bot-daily-tokens">
						Daily token limit <span className="text-muted-foreground font-normal">(optional)</span>
					</Label>
					<LimitSelect
						id="bot-daily-tokens"
						value={form.dailyTokenLimit}
						onChange={v => update("dailyTokenLimit", v)}
						options={DAILY_TOKEN_OPTIONS}
					/>
					<p className="text-xs text-muted-foreground">
						Total prompt + completion tokens across all replies in a UTC day. The bot will quietly refuse new mentions once exceeded.
					</p>
				</div>

				<div className="space-y-1.5 max-w-xs">
					<Label htmlFor="bot-daily-calls">
						Daily call limit <span className="text-muted-foreground font-normal">(optional)</span>
					</Label>
					<LimitSelect
						id="bot-daily-calls"
						value={form.dailyCallLimit}
						onChange={v => update("dailyCallLimit", v)}
						options={DAILY_CALL_OPTIONS}
					/>
					<p className="text-xs text-muted-foreground">
						Number of times the bot can be triggered in a UTC day, regardless of token count. Useful when the model is cheap-per-call but a single conversation could fan out to many tool-use iterations.
					</p>
				</div>

				{mode === "edit" && bot && (
					<div className="rounded-md border border-border bg-card/30 px-3 py-2.5 max-w-md">
						<div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-1">
							Lifetime usage
						</div>
						<div className="text-xs text-muted-foreground">
							{lifetimeCalls.toLocaleString()} call{lifetimeCalls === 1 ? "" : "s"} · {lifetimeTokens.toLocaleString()} tokens
						</div>
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
//   - Attached servers: list of URL-based MCP attachments with edit
//     and detach affordances.
//   - Add server form: URL + label + optional Authorization header
//     (with show/hide) + advanced raw-headers textarea.  No catalog
//     browse, no OAuth dance, no Smithery proxy — protocol-pure.
//
// SECURITY NOTE: any caller who can mention the bot can invoke its
// tools, which means anyone in any room with the bot can act with
// whatever permissions the URL + headers grant.  Surface that
// explicitly under the form so the owner makes an informed choice
// (especially for static-token-auth servers like the user's own
// API key for some service — leaking that to "anyone in the room"
// is a real risk worth flagging).

function ToolsTab({
	bot,
	accessToken,
	pendingAttachments,
	onPendingChange,
}: {
	bot: BotSummary | null;
	accessToken: string | null;
	/** Picks queued during create mode.  Ignored in edit mode (where
	 * we mutate the engine directly).  The parent flushes this
	 * queue after createBot succeeds. */
	pendingAttachments: PendingMcpAttachment[];
	onPendingChange(next: PendingMcpAttachment[]): void;
}) {
	const isCreateMode = bot === null;

	const [attached, setAttached] = useState<BotMcpAttachment[]>([]);
	const [loading, setLoading] = useState(!isCreateMode);
	const [listError, setListError] = useState<string | null>(null);

	// Form state for adding a new server.  Kept inline (vs. a
	// dialog) because it's a small enough form to live alongside
	// the attached list — and the user told us not to overcomplicate.
	const [formLabel, setFormLabel] = useState("");
	const [formUrl, setFormUrl] = useState("");
	const [formAuthToken, setFormAuthToken] = useState("");
	const [formAuthScheme, setFormAuthScheme] = useState<"bearer" | "raw">("bearer");
	const [formExtraHeaders, setFormExtraHeaders] = useState("");
	const [showToken, setShowToken] = useState(false);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [editingId, setEditingId] = useState<number | null>(null);

	// Form mode toggle.  "url" = the existing single-server form for
	// hosted Streamable-HTTP endpoints.  "paste" = a JSON textarea
	// where users dump the canonical Claude Desktop / Cursor / Cline
	// `mcpServers` config block (one or more servers at once,
	// stdio or http).  paste mode goes through the bulk-import
	// engine endpoint which parses the config tolerantly.
	const [addMode, setAddMode] = useState<"url" | "paste">("url");
	const [pasteJson, setPasteJson] = useState("");
	const [pasteWarnings, setPasteWarnings] = useState<string[]>([]);

	// Initial fetch of the bot's attached servers (edit mode only).
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

	function resetForm() {
		setFormLabel("");
		setFormUrl("");
		setFormAuthToken("");
		setFormAuthScheme("bearer");
		setFormExtraHeaders("");
		setShowAdvanced(false);
		setActionError(null);
		setEditingId(null);
	}

	function startEdit(row: BotMcpAttachment) {
		setEditingId(row.id);
		setFormLabel(row.label);
		setFormUrl(row.url);
		// Try to recover an "Authorization: Bearer …" entry into
		// the dedicated auth field; everything else lands in the
		// advanced raw-headers textarea.
		const restHeaders: Record<string, string> = { ...row.headers };
		const auth = restHeaders["Authorization"] ?? restHeaders["authorization"];
		if (auth && /^Bearer\s+/i.test(auth)) {
			setFormAuthScheme("bearer");
			setFormAuthToken(auth.replace(/^Bearer\s+/i, ""));
			delete restHeaders["Authorization"];
			delete restHeaders["authorization"];
		} else {
			setFormAuthScheme("bearer");
			setFormAuthToken("");
		}
		const extras = Object.entries(restHeaders);
		setFormExtraHeaders(
			extras.length === 0
				? ""
				: JSON.stringify(Object.fromEntries(extras), null, 2),
		);
		setShowAdvanced(extras.length > 0);
		setActionError(null);
	}

	/** Build the final headers map from the form fields.  The auth
	 * field is the common case (Bearer token); advanced JSON is
	 * merged on top so power users can set arbitrary headers
	 * (X-Api-Key, custom tenant ids, etc.). */
	function buildHeaders(): Record<string, string> | { error: string } {
		const headers: Record<string, string> = {};
		const tok = formAuthToken.trim();
		if (tok.length > 0) {
			headers["Authorization"] = formAuthScheme === "bearer" ? `Bearer ${tok}` : tok;
		}
		const raw = formExtraHeaders.trim();
		if (raw.length > 0) {
			let parsed: unknown;
			try { parsed = JSON.parse(raw); } catch (err) {
				return { error: `Advanced headers: invalid JSON (${err instanceof Error ? err.message : String(err)})` };
			}
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { error: "Advanced headers must be a JSON object." };
			}
			for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof v !== "string") {
					return { error: `Advanced headers: ${k} must be a string.` };
				}
				headers[k] = v;
			}
		}
		return headers;
	}

	async function submit() {
		setActionError(null);
		const url = formUrl.trim();
		if (!url) { setActionError("URL is required."); return; }
		try { new URL(url); } catch { setActionError("URL doesn't parse."); return; }
		const label = formLabel.trim() || hostnameFromUrl(url);
		const headersOrError = buildHeaders();
		if ("error" in headersOrError) { setActionError(headersOrError.error); return; }
		const headers = headersOrError;

		setSubmitting(true);
		try {
			if (isCreateMode) {
				// Queue locally; parent flushes after createBot succeeds.
				// Filter dedupes on URL — only HTTP-kind entries have a
				// URL, paste-kind entries are kept regardless.
				const filtered = pendingAttachments.filter(p => {
					if (p.kind === "paste") return true;
					return p.url !== url || editingId === null;
				});
				if (editingId !== null) {
					// In create mode, "edit" replaces the queued entry
					// at that synthetic id — we use index-as-id since
					// there's no real DB row yet.
					onPendingChange(
						pendingAttachments.map((p, i) =>
							i === editingId ? { kind: "http", label, url, headers } : p,
						),
					);
				} else {
					onPendingChange([...filtered, { kind: "http", label, url, headers }]);
				}
			} else if (bot && accessToken) {
				if (editingId !== null) {
					const updated = await patchBotMcpServer(accessToken, bot.id, editingId, { label, url, headers });
					setAttached(prev => prev.map(r => r.id === editingId ? updated : r));
				} else {
					const row = await attachBotMcpServer(accessToken, bot.id, { label, url, headers });
					setAttached(prev => [...prev, row]);
				}
			}
			resetForm();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}

	async function detach(row: BotMcpAttachment) {
		if (!accessToken || !bot) return;
		setActionError(null);
		try {
			await detachBotMcpServer(accessToken, bot.id, row.id);
			setAttached(prev => prev.filter(p => p.id !== row.id));
			if (editingId === row.id) resetForm();
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		}
	}

	function detachPending(idx: number) {
		onPendingChange(pendingAttachments.filter((_, i) => i !== idx));
		if (editingId === idx) resetForm();
	}

	/** Bulk-import the pasted JSON config.
	 *
	 * Edit mode: posts to the bulk-import engine endpoint
	 * immediately, surfaces per-server warnings inline.
	 *
	 * Create mode: queues the raw JSON onto pendingMcpAttachments
	 * (kind="paste").  The form's main submit flushes the queue via
	 * importBotMcpServers once the new bot id exists.  Single-entry
	 * queue per paste — even if the JSON contained multiple servers
	 * the queued list shows it as one row, matching how the import
	 * endpoint treats it (atomic per paste). */
	async function submitPaste() {
		setActionError(null);
		setPasteWarnings([]);
		const trimmed = pasteJson.trim();
		if (!trimmed) {
			setActionError("paste a config first");
			return;
		}
		// Validate the JSON parses + has at least one server-shaped
		// entry BEFORE we queue it — otherwise the user would only
		// find out at create-time, by which point the form's gone
		// and they can't recover the paste.  Cheap parse-side check;
		// the engine still re-validates at flush.
		let serverCount = 0;
		try {
			const parsed = JSON.parse(trimmed);
			serverCount = countServersInPaste(parsed);
			if (serverCount === 0) {
				setActionError("no MCP servers found in the paste — expected an `mcpServers` block, a bare server map, or a single server object");
				return;
			}
		} catch (err) {
			setActionError(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		if (isCreateMode) {
			// Queue for post-create flush.
			const labelGuess = serverCount === 1
				? "Paste config (1 server)"
				: `Paste config (${serverCount} servers)`;
			onPendingChange([
				...pendingAttachments,
				{ kind: "paste", label: labelGuess, pasteJson: trimmed },
			]);
			setPasteJson("");
			return;
		}

		if (!accessToken || !bot) return;
		setSubmitting(true);
		try {
			const result = await importBotMcpServers(accessToken, bot.id, trimmed);
			setAttached(prev => [...prev, ...result.servers]);
			setPasteWarnings([
				...result.warnings,
				...result.skipped.map(s => `Skipped: ${s}`),
			]);
			if (result.servers.length > 0) {
				setPasteJson("");
			}
			if (result.servers.length === 0) {
				setActionError(
					result.skipped.length > 0
						? "every server in the paste was skipped — see warnings below"
						: "no servers found in the paste",
				);
			}
		} catch (err) {
			setActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}

	const editing = editingId !== null;

	// Suppress the entire tab body until the attached-list fetch
	// resolves.  Without this gate the empty-state banner ("No tools
	// attached.  Use the form below to add one.") flashes briefly
	// after the form, even when there ARE attached servers about to
	// land — the loading state lives inside the list block but the
	// surrounding form renders unconditionally.  Same intent as the
	// rule on the notifications bell: don't show any UI against
	// half-loaded data.  Create mode skips this gate (no fetch
	// happens; the queue is local).
	if (!isCreateMode && loading) {
		return (
			<section className="space-y-6">
				<SectionHeader
					title="Tools"
					subtitle="Attach MCP servers your bot can call. Paste any Streamable-HTTP MCP endpoint and (optional) auth."
				/>
				<div className="text-sm text-muted-foreground">Loading…</div>
			</section>
		);
	}

	return (
		<section className="space-y-6">
			<SectionHeader
				title="Tools"
				subtitle="Attach MCP servers your bot can call. Paste any Streamable-HTTP MCP endpoint and (optional) auth."
			/>

			{/* Attached / Queued list */}
			<div className="space-y-2">
				<div className="text-xs font-medium uppercase text-muted-foreground tracking-wide">
					{isCreateMode ? "Queued" : "Attached"}
				</div>
				{listError ? (
					<div className="text-sm text-destructive border border-destructive/40 bg-destructive/5 rounded-md px-3 py-2">
						{listError}
					</div>
				) : isCreateMode ? (
					pendingAttachments.length === 0 ? (
						<EmptyServersState createMode />
					) : (
						<ul className="rounded-md border border-border divide-y divide-border bg-primary/5">
							{pendingAttachments.map((p, idx) => {
								// Paste-config queue entry: render with the
								// stdio-style badge + a generic subtitle.
								// No Edit affordance — re-pasting is the
								// edit gesture (remove + paste again).
								if (p.kind === "paste") {
									return (
										<AttachmentRow
											key={`pending-${idx}`}
											label={p.label}
											url="JSON config"
											hasAuth={false}
											kind="stdio"
											suffix=" · queued — imports after create"
											onRemove={() => detachPending(idx)}
										/>
									);
								}
								return (
									<AttachmentRow
										key={`pending-${idx}`}
										label={p.label || hostnameFromUrl(p.url)}
										url={p.url}
										hasAuth={!!p.headers["Authorization"]}
										suffix=" · queued — attaches after create"
										onEdit={() => {
											setEditingId(idx);
											setFormLabel(p.label);
											setFormUrl(p.url);
											const auth = p.headers["Authorization"];
											if (auth && /^Bearer\s+/i.test(auth)) {
												setFormAuthScheme("bearer");
												setFormAuthToken(auth.replace(/^Bearer\s+/i, ""));
											} else {
												setFormAuthToken("");
											}
											const others = Object.fromEntries(
												Object.entries(p.headers).filter(([k]) => k !== "Authorization"),
											);
											setFormExtraHeaders(
												Object.keys(others).length > 0 ? JSON.stringify(others, null, 2) : "",
											);
											setShowAdvanced(Object.keys(others).length > 0);
										}}
										onRemove={() => detachPending(idx)}
									/>
								);
							})}
						</ul>
					)
				) : attached.length === 0 ? (
					<EmptyServersState createMode={false} />
				) : (
					<ul className="rounded-md border border-border divide-y divide-border bg-card/30">
						{attached.map(row => {
							// For stdio attachments, the URL field is empty
							// — show the command + args as the subtitle so
							// the row is identifiable.  Hide the Edit
							// button: stdio attachments are atomic,
							// re-paste to change them.
							const isStdio = row.kind === "stdio";
							const subtitle = isStdio
								? `${row.command ?? ""} ${row.args.join(" ")}`.trim()
								: row.url;
							const labelText = row.label
								|| (isStdio ? (row.command ?? "stdio server") : hostnameFromUrl(row.url));
							return (
								<AttachmentRow
									key={row.id}
									label={labelText}
									url={subtitle}
									hasAuth={isStdio
										? Object.keys(row.env).length > 0
										: !!row.headers["Authorization"]}
									kind={row.kind}
									onEdit={isStdio ? undefined : () => startEdit(row)}
									onRemove={() => detach(row)}
								/>
							);
						})}
					</ul>
				)}
			</div>

			{/* Add / Edit form */}
			<div className="space-y-3 rounded-md border border-border bg-card/20 px-4 py-4">
				<div className="flex items-center justify-between">
					<div className="text-xs font-medium uppercase text-muted-foreground tracking-wide">
						{editing ? "Edit server" : "Add server"}
					</div>
					{!editing && (
						/* Mode toggle — hidden only in edit mode (you
						   can't re-paste an existing row).  Available
						   in both create + edit otherwise: in create
						   mode pasted configs are queued and bulk-
						   imported after the first save. */
						<div className="inline-flex rounded-md border border-border overflow-hidden text-[11px]">
							<button
								type="button"
								onClick={() => { setAddMode("url"); setActionError(null); setPasteWarnings([]); }}
								className={cn(
									"px-2.5 py-1 transition-colors",
									addMode === "url" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								Hosted URL
							</button>
							<button
								type="button"
								onClick={() => { setAddMode("paste"); setActionError(null); }}
								className={cn(
									"px-2.5 py-1 transition-colors border-l border-border",
									addMode === "paste" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								Paste config
							</button>
						</div>
					)}
				</div>

				{addMode === "paste" && !editing ? (
					/* JSON-paste mode: tolerant import.  Shows warnings
					   from the engine after submit so the user knows
					   what was attached, what was skipped, and any
					   per-server caveats (couldn't pin npm version,
					   unknown fields ignored, etc.). */
					<>
						<div className="space-y-1.5">
							<Label htmlFor="mcp-paste">Server config JSON</Label>
							<textarea
								id="mcp-paste"
								value={pasteJson}
								onChange={e => setPasteJson(e.target.value)}
								placeholder={`{
  "mcpServers": {
    "perplexity-ask": {
      "command": "npx",
      "args": ["-y", "@chatmcp/server-perplexity-ask"],
      "env": { "PERPLEXITY_API_KEY": "..." }
    }
  }
}`}
								rows={12}
								className="w-full font-mono text-xs rounded-md border border-foreground/15 bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
							/>
							<p className="text-[11px] text-muted-foreground leading-snug">
								Paste an <code className="font-mono">mcpServers</code> block from any MCP client config (Claude Desktop, Cursor, Cline, Windsurf). Multiple servers in one paste are all attached. Both <code className="font-mono">command</code>-based stdio servers and <code className="font-mono">url</code>-based HTTP servers are supported.
							</p>
						</div>
						<div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400 leading-snug space-y-1.5">
							<div>
								<strong className="font-semibold">Stdio MCP servers run on the engine host.</strong> The package you attach gets a sandboxed filesystem (no view of engine secrets), only the env vars you specify, and per-spawn memory + CPU limits.
							</div>
							<div>
								<strong className="font-semibold">Anyone who can mention your bot can invoke its tools.</strong> The credentials you paste here authorize those calls — costs (API billing, rate limits) and side effects (writes via the API) accrue to whoever owns the keys. Use a dedicated bot account or scoped key, not your personal one.
							</div>
						</div>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								onClick={submitPaste}
								disabled={submitting || !pasteJson.trim()}
							>
								{submitting ? "Importing…" : "Import"}
							</Button>
							{pasteJson && (
								<Button
									type="button"
									variant="ghost"
									onClick={() => { setPasteJson(""); setPasteWarnings([]); setActionError(null); }}
									disabled={submitting}
								>
									Clear
								</Button>
							)}
						</div>
						{pasteWarnings.length > 0 && (
							<div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400 space-y-1">
								<div className="font-semibold">Notes:</div>
								<ul className="list-disc list-inside space-y-0.5">
									{pasteWarnings.map((w, i) => (
										<li key={i}>{w}</li>
									))}
								</ul>
							</div>
						)}
						{actionError && (
							<div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
								{actionError}
							</div>
						)}
					</>
				) : (
				<>
				<div className="space-y-1.5">
					<Label htmlFor="mcp-url">MCP server URL</Label>
					<Input
						id="mcp-url"
						value={formUrl}
						onChange={e => setFormUrl(e.target.value)}
						placeholder="https://example.com/mcp"
						autoComplete="off"
					/>
					<p className="text-[11px] text-muted-foreground">
						Streamable-HTTP MCP endpoint. Many MCP servers publish their endpoint URL in their docs.
					</p>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="mcp-label">
						Label <span className="text-muted-foreground font-normal">(optional)</span>
					</Label>
					<Input
						id="mcp-label"
						value={formLabel}
						onChange={e => setFormLabel(e.target.value)}
						placeholder="Defaults to the URL's hostname"
						autoComplete="off"
					/>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="mcp-auth">
						Auth token <span className="text-muted-foreground font-normal">(optional)</span>
					</Label>
					<div className="flex items-center gap-2">
						{/* Hide the native select chevron with
						    appearance-none and stack our own
						    ChevronDown icon — the OS-rendered arrow
						    sits flush against the border, which
						    looks crowded next to the input field
						    that follows.  Same pattern the Provider
						    dropdown above uses. */}
						<div className="relative shrink-0">
							<select
								value={formAuthScheme}
								onChange={e => setFormAuthScheme(e.target.value as "bearer" | "raw")}
								className="h-9 appearance-none rounded-md border border-foreground/15 bg-background pl-3 pr-8 text-sm"
							>
								<option value="bearer">Bearer</option>
								<option value="raw">Raw</option>
							</select>
							<ChevronDown
								className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none"
								aria-hidden
							/>
						</div>
						<div className="relative flex-1">
							<Input
								id="mcp-auth"
								type={showToken ? "text" : "password"}
								value={formAuthToken}
								onChange={e => setFormAuthToken(e.target.value)}
								placeholder={formAuthScheme === "bearer" ? "your-token" : "Custom Authorization header value"}
								autoComplete="off"
								className="pr-9 font-mono"
							/>
							<button
								type="button"
								onClick={() => setShowToken(s => !s)}
								className="absolute inset-y-0 right-0 px-2 flex items-center text-muted-foreground hover:text-foreground"
								aria-label={showToken ? "Hide token" : "Show token"}
							>
								{showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
							</button>
						</div>
					</div>
					<p className="text-[11px] text-muted-foreground">
						Sent as <code className="font-mono text-[10px]">Authorization: {formAuthScheme === "bearer" ? "Bearer …" : "…"}</code> with every request.
					</p>
				</div>

				{showAdvanced ? (
					<div className="space-y-1.5">
						<div className="flex items-center justify-between">
							<Label htmlFor="mcp-extra">Extra headers (JSON)</Label>
							<button
								type="button"
								onClick={() => { setShowAdvanced(false); setFormExtraHeaders(""); }}
								className="text-[10px] text-muted-foreground hover:text-foreground"
							>
								hide
							</button>
						</div>
						<textarea
							id="mcp-extra"
							value={formExtraHeaders}
							onChange={e => setFormExtraHeaders(e.target.value)}
							placeholder='{"X-Api-Key": "…"}'
							rows={3}
							className="w-full font-mono text-xs rounded-md border border-foreground/15 bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
						/>
						<p className="text-[10px] text-muted-foreground">
							Object of header name → value. Merged with the Authorization header above.
						</p>
					</div>
				) : (
					<button
						type="button"
						onClick={() => setShowAdvanced(true)}
						className="text-xs text-muted-foreground hover:text-foreground underline"
					>
						Add custom headers…
					</button>
				)}

				{actionError && (
					<div className="text-sm text-destructive border border-destructive/40 bg-destructive/5 rounded-md px-3 py-2">
						{actionError}
					</div>
				)}

				<div className="flex items-center gap-2 pt-1">
					<Button type="button" size="sm" onClick={submit} disabled={submitting || !formUrl.trim()}>
						{submitting ? "Saving…" : editing ? "Save changes" : "Attach server"}
					</Button>
					{editing && (
						<Button type="button" size="sm" variant="ghost" onClick={resetForm} disabled={submitting}>
							Cancel edit
						</Button>
					)}
				</div>

				<p className="text-[11px] text-muted-foreground leading-snug border-t border-border/50 pt-3">
					⚠️ Anyone who can mention the bot — i.e. anyone in any room the bot's joined to — can invoke its tools. The token you paste here grants that audience whatever access it authorises. Don't attach personal-account tokens to bots in shared rooms.
				</p>
				</>
				)}
			</div>
		</section>
	);
}

function AttachmentRow({
	label, url, hasAuth, suffix, kind = "http", onEdit, onRemove,
}: {
	label: string;
	url: string;
	hasAuth: boolean;
	suffix?: string;
	/** Drives the badge + edit-button visibility.  stdio attachments
	 * aren't editable in-place (they're a single command + env block,
	 * usually pasted from a Claude Desktop config — re-pasting is the
	 * edit flow). */
	kind?: "http" | "stdio";
	onEdit?(): void;
	onRemove(): void;
}) {
	return (
		<li className="px-3 py-2.5 flex items-center gap-3">
			<Plug className="h-4 w-4 shrink-0 text-muted-foreground" />
			<div className="flex-1 min-w-0">
				<div className="text-sm font-medium truncate flex items-center gap-1.5">
					<span className="truncate">{label}</span>
					<span className={cn(
						"shrink-0 text-[9px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded border",
						kind === "stdio"
							? "bg-amber-500/10 text-amber-600 border-amber-500/30"
							: "bg-primary/10 text-primary border-primary/20",
					)}>
						{kind === "stdio" ? "stdio" : "http"}
					</span>
				</div>
				<div className="text-[11px] text-muted-foreground truncate">
					{url}{hasAuth ? " · authed" : ""}{suffix ?? ""}
				</div>
			</div>
			{onEdit && (
				<button
					type="button"
					onClick={onEdit}
					className="text-xs text-muted-foreground hover:text-foreground"
				>
					Edit
				</button>
			)}
			<button
				type="button"
				onClick={onRemove}
				title="Remove"
				aria-label="Remove"
				className="text-muted-foreground hover:text-destructive"
			>
				<X className="h-4 w-4" />
			</button>
		</li>
	);
}

function EmptyServersState({ createMode }: { createMode: boolean }) {
	return (
		<div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
			{createMode
				? "No tools queued. Add a server below — picks attach when you create the bot."
				: "No tools attached. Use the form below to add one."}
		</div>
	);
}

/** Best-effort hostname extraction for the "Defaults to" label
 * placeholder.  Returns the URL string itself when parsing fails so
 * the form still degrades gracefully. */
function hostnameFromUrl(url: string): string {
	try { return new URL(url).hostname; } catch { return url; }
}

/** Count the number of server-shaped entries in a parsed MCP config
 * paste.  Used by the create-mode queue to label the queued entry
 * "Paste config (N servers)" — same accept-anything heuristic as the
 * engine-side parser, just count-only.  Returns 0 when nothing
 * recognisable. */
function countServersInPaste(obj: unknown): number {
	if (!obj || typeof obj !== "object") return 0;
	const o = obj as Record<string, unknown>;
	const map =
		(o.mcpServers && typeof o.mcpServers === "object" && o.mcpServers as Record<string, unknown>)
		|| (o.servers && typeof o.servers === "object" && o.servers as Record<string, unknown>)
		|| (o.mcp && typeof o.mcp === "object" && (o.mcp as Record<string, unknown>).servers as Record<string, unknown> | undefined)
		|| null;
	if (map) return Object.keys(map).length;
	// Bare server (single object with command or url).
	if (typeof o.command === "string" || typeof o.url === "string") return 1;
	// Bare map of servers (every value looks like a server).
	const entries = Object.entries(o);
	if (entries.length > 0 && entries.every(([, v]) =>
		v && typeof v === "object" && (
			typeof (v as Record<string, unknown>).command === "string"
			|| typeof (v as Record<string, unknown>).url === "string"
		)
	)) {
		return entries.length;
	}
	return 0;
}

// ─── Webhooks tab ────────────────────────────────────────────────────
//
// Two sub-tabs within the same tab pane:
//
//   - Inbound  — external services POST to a Koven URL, the bot
//                processes the payload via its system prompt and
//                posts the result into a room.
//   - Outbound — the bot's LLM gets HTTP-request tools it can call
//                ("fetch_news" → GET https://api.example.com/news?q={q}),
//                fires them when it decides to, and uses the
//                response in its reply.
//
// WebhooksTab is the thin wrapper that picks which sub-tab is
// visible.  The actual logic lives in InboundWebhooksSubTab and
// OutboundWebhooksSubTab below — keeps each focused, since the
// forms are quite different (room target + signing for inbound;
// URL template + params + headers for outbound).

function WebhooksTab(props: {
	bot: BotSummary | null;
	accessToken: string | null;
	pendingWebhooks: PendingWebhook[];
	onPendingChange(next: PendingWebhook[]): void;
}) {
	type Sub = "inbound" | "outbound";
	const [sub, setSub] = useState<Sub>("inbound");

	const subs: { key: Sub; label: string; hint: string }[] = [
		{ key: "inbound",  label: "Inbound",  hint: "Services post to a URL the bot relays" },
		{ key: "outbound", label: "Outbound", hint: "Tools the bot can call when it decides to" },
	];

	return (
		<div className="space-y-5 max-w-3xl">
			<div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5">
				{subs.map(s => (
					<button
						key={s.key}
						type="button"
						onClick={() => setSub(s.key)}
						title={s.hint}
						className={cn(
							"px-3 py-1.5 text-sm rounded transition-colors",
							sub === s.key
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{s.label}
					</button>
				))}
			</div>
			{sub === "inbound" ? (
				<InboundWebhooksSubTab {...props} />
			) : (
				<OutboundWebhooksSubTab bot={props.bot} accessToken={props.accessToken} />
			)}
		</div>
	);
}

function InboundWebhooksSubTab({
	bot,
	accessToken,
	pendingWebhooks,
	onPendingChange,
}: {
	bot: BotSummary | null;
	accessToken: string | null;
	pendingWebhooks: PendingWebhook[];
	onPendingChange(next: PendingWebhook[]): void;
}) {
	const transport = useTransport();
	const isCreateMode = bot === null;

	const [hooks, setHooks] = useState<WebhookSummary[]>([]);
	const [loading, setLoading] = useState(!isCreateMode);
	const [listError, setListError] = useState<string | null>(null);

	// Add-form state (single inline row, like ToolsTab).
	const [formLabel, setFormLabel] = useState("");
	const [formRoomId, setFormRoomId] = useState("");
	// Three-mode secret picker:
	//   "none"     — no signing.  Open webhook (anyone with URL posts).
	//   "generate" — server generates an HMAC secret for us.  Use for
	//                sources that accept a Koven-issued secret
	//                (GitHub, Stripe, generic n8n / cron / etc.).
	//   "provided" — user pastes a secret the source dictates.  Use
	//                for Twilio (Auth Token), Slack (Signing Secret),
	//                Stripe (when reusing an existing webhook secret),
	//                etc. — anywhere you can't pick the key.
	type SecretMode = "none" | "generate" | "provided";
	const [formSecretMode, setFormSecretMode] = useState<SecretMode>("generate");
	const [formProvidedSecret, setFormProvidedSecret] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);

	// Just-created webhook — edit-mode only.  Exposes the secret
	// EXACTLY ONCE in a banner above the list, so the user can
	// copy it before it disappears.  Create-mode uses the parent's
	// post-save banner via `justCreatedWebhooksBatch` instead.
	const [justCreated, setJustCreated] = useState<WebhookCreated | null>(null);

	// Rooms the bot has joined — populated from the bot owner's
	// view of joined rooms via the transport.  We can only target a
	// room the bot is actually in (sendEvent fails otherwise), so
	// the room dropdown filters to the bot's joined rooms.  For
	// v1 we approximate "bot's joined rooms" as "the owner's
	// joined rooms" — the bot sync state isn't exposed to the
	// client, but in practice bots are added to rooms from the
	// owner's invite UI, so the overlap is close enough.
	const ownerRooms = useMemo(() => {
		if (!transport) return [];
		return transport.getRooms()
			.filter(r => r.kind !== "dm")
			.map(r => ({ id: r.id, name: r.name || r.id }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [transport]);

	useEffect(() => {
		if (isCreateMode || !accessToken || !bot) return;
		let cancelled = false;
		setLoading(true);
		listBotWebhooks(accessToken, bot.id)
			.then(rows => { if (!cancelled) { setHooks(rows); setListError(null); } })
			.catch(err => { if (!cancelled) setListError(err instanceof Error ? err.message : String(err)); })
			.finally(() => { if (!cancelled) setLoading(false); });
		return () => { cancelled = true; };
	}, [isCreateMode, accessToken, bot]);

	async function refresh() {
		if (!accessToken || !bot) return;
		try {
			const rows = await listBotWebhooks(accessToken, bot.id);
			setHooks(rows);
			setListError(null);
		} catch (err) {
			setListError(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleCreate(e: React.FormEvent) {
		e.preventDefault();
		setFormError(null);
		const label = formLabel.trim();
		const targetRoomId = formRoomId.trim();
		if (!targetRoomId.startsWith("!")) {
			setFormError("Pick a target room");
			return;
		}
		// Resolve the secret mode into the API shape.  "provided"
		// requires a non-empty paste; surface that as a form error
		// instead of silently degrading to "none".
		const trimmedProvided = formProvidedSecret.trim();
		if (formSecretMode === "provided" && trimmedProvided.length === 0) {
			setFormError("Paste the source's signing secret, or pick a different mode");
			return;
		}
		const generateSecret = formSecretMode === "generate";
		const providedSecret = formSecretMode === "provided" ? trimmedProvided : undefined;

		// Create mode: queue locally, parent flushes after createBot.
		// No POST happens here; the URL + secret are surfaced by the
		// parent's post-save banner once the bot has an id.
		if (isCreateMode) {
			onPendingChange([...pendingWebhooks, {
				label,
				targetRoomId,
				generateSecret,
				providedSecret,
			}]);
			setFormLabel("");
			setFormRoomId("");
			setFormSecretMode("generate");
			setFormProvidedSecret("");
			return;
		}
		// Edit mode: POST against /api/bots/:id/webhooks immediately.
		if (!accessToken || !bot) return;
		setSubmitting(true);
		try {
			const created = await createBotWebhook({
				accessToken,
				botId: bot.id,
				targetRoomId,
				label,
				generateSecret,
				secret: providedSecret,
			});
			setJustCreated(created);
			setFormLabel("");
			setFormRoomId("");
			setFormSecretMode("generate");
			setFormProvidedSecret("");
			await refresh();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}

	async function handleDelete(wid: number) {
		if (!accessToken || !bot) return;
		if (!window.confirm("Delete this webhook?  External services posting to its URL will start getting 404s.")) return;
		try {
			await deleteBotWebhook({ accessToken, botId: bot.id, webhookId: wid });
			await refresh();
		} catch (err) {
			window.alert(`Couldn't delete: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	function handleRemovePending(idx: number) {
		onPendingChange(pendingWebhooks.filter((_, i) => i !== idx));
	}

	// Suppress entire body until the webhooks fetch resolves —
	// matches the rule we apply elsewhere (notification bell, tools
	// tab): no UI rendered against half-loaded data.  Without this
	// gate the "No webhooks yet." empty state would flash before
	// the actual list lands.  Create mode skips since there's no
	// fetch to wait on.
	if (!isCreateMode && loading) {
		return (
			<div className="space-y-4 max-w-3xl">
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Webhook className="h-4 w-4" />
					<span>External services post to a Koven URL, this bot relays the payload into a room.</span>
				</div>
				<div className="text-sm text-muted-foreground">Loading…</div>
			</div>
		);
	}

	return (
		<div className="space-y-6 max-w-3xl">
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Webhook className="h-4 w-4" />
				<span>External services post to a Koven URL; this bot processes the payload through its system prompt and posts the response into a room.</span>
			</div>

			{isCreateMode && (
				<div className="text-xs text-muted-foreground border border-border/60 rounded-md p-3 bg-muted/30">
					Webhooks queued here will be created when you save the bot.  URLs and signing secrets are shown once at that point — copy them then.
				</div>
			)}

			{justCreated && (
				<div className="rounded-md border border-primary/40 bg-primary/5 p-4 space-y-3 text-sm">
					<div className="font-medium flex items-center gap-2">
						<AlertCircle className="h-4 w-4" />
						{justCreated.secret
							? "Save the secret now — it's shown once"
							: "Webhook ready"}
					</div>
					<div className="space-y-3">
						<CopyableField label="Webhook URL" value={webhookUrlFor(justCreated.token)} />
						{justCreated.secret && (
							<CopyableField label="Signing secret" value={justCreated.secret} secret />
						)}
					</div>
					<div className="text-xs text-muted-foreground">
						{justCreated.secret
							? "Paste the URL into your source service, then paste the signing secret into the source's webhook config (GitHub: Secret; Stripe: Signing secret) so Koven can verify inbound requests."
							: "Paste the URL into your source service.  Koven verifies inbound signatures with the secret you provided."}
					</div>
					<button
						type="button"
						onClick={() => setJustCreated(null)}
						className="text-xs text-muted-foreground hover:text-foreground underline"
					>
						Dismiss
					</button>
				</div>
			)}

			<form onSubmit={handleCreate} className="rounded-md border border-border p-4 space-y-3">
				<div className="text-sm font-medium">Add a webhook</div>
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<div className="space-y-1">
						<Label htmlFor="webhook-label">Label</Label>
						<Input
							id="webhook-label"
							value={formLabel}
							onChange={e => setFormLabel(e.target.value)}
							placeholder="e.g. GitHub - frontend"
							maxLength={80}
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor="webhook-room">Target room</Label>
						<select
							id="webhook-room"
							value={formRoomId}
							onChange={e => setFormRoomId(e.target.value)}
							className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							<option value="">Pick a room…</option>
							{ownerRooms.map(r => (
								<option key={r.id} value={r.id}>{r.name}</option>
							))}
						</select>
					</div>
				</div>
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<Label htmlFor="webhook-secret-mode" className="text-xs text-muted-foreground">
							Signing
						</Label>
						<select
							id="webhook-secret-mode"
							value={formSecretMode}
							onChange={e => setFormSecretMode(e.target.value as SecretMode)}
							className="h-8 px-2 rounded border border-input bg-background text-xs"
						>
							<option value="generate">Generate one for me</option>
							<option value="provided">I have a secret to paste</option>
							<option value="none">No signing (open webhook)</option>
						</select>
					</div>
					{formSecretMode === "generate" && (
						<p className="text-[11px] text-muted-foreground leading-relaxed">
							Koven generates a random HMAC secret. You&rsquo;ll see it once on save — paste it into the source service&rsquo;s webhook config (GitHub: <em>Secret</em>; Stripe: <em>Signing secret</em>). Inbound requests are verified with HMAC-SHA256.
						</p>
					)}
					{formSecretMode === "provided" && (
						<>
							<input
								type="text"
								value={formProvidedSecret}
								onChange={e => setFormProvidedSecret(e.target.value)}
								placeholder="paste signing secret"
								spellCheck={false}
								autoComplete="off"
								className="w-full h-8 px-2 rounded border border-input bg-background text-xs font-mono"
							/>
							<p className="text-[11px] text-muted-foreground leading-relaxed">
								Use this when the source dictates the key — Twilio (paste your <em>Auth Token</em> from the Twilio Console), Slack (<em>Signing Secret</em>), or any pre-existing webhook secret you want to reuse. Koven verifies signatures with the scheme that matches the detected source (Twilio: HMAC-SHA1 over URL+sorted form params; GitHub-style: HMAC-SHA256 over raw body).
							</p>
						</>
					)}
					{formSecretMode === "none" && (
						<p className="text-[11px] text-muted-foreground leading-relaxed">
							Anyone who learns the URL can post. Fine for internal cron jobs and quick tests; not recommended for public services.
						</p>
					)}
				</div>
				{formError && <div className="text-xs text-destructive">{formError}</div>}
				<Button type="submit" size="sm" disabled={submitting}>
					<Plus className="h-3.5 w-3.5 mr-1.5" />
					{isCreateMode
						? "Queue webhook"
						: submitting ? "Creating…" : "Create webhook"}
				</Button>
			</form>

			{!isCreateMode && loading && <div className="text-sm text-muted-foreground">Loading…</div>}
			{!isCreateMode && listError && <div className="text-sm text-destructive">{listError}</div>}

			{isCreateMode && pendingWebhooks.length === 0 && (
				<div className="text-sm text-muted-foreground italic">No webhooks queued.</div>
			)}
			{!isCreateMode && !loading && hooks.length === 0 && !justCreated && (
				<div className="text-sm text-muted-foreground italic">No webhooks yet.</div>
			)}

			{/* Create-mode pending list — no URL yet, gets one on save. */}
			{isCreateMode && (
				<div className="space-y-3">
					{pendingWebhooks.map((p, idx) => (
						<div key={idx} className="rounded-md border border-border bg-card/40 p-3 flex items-start gap-3">
							<Webhook className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
							<div className="flex-1 min-w-0 space-y-1">
								<div className="flex items-baseline gap-2 flex-wrap">
									<span className="text-sm font-medium truncate">{p.label || "(unlabeled)"}</span>
									<span className="text-[11px] text-muted-foreground truncate">
										→ {ownerRooms.find(r => r.id === p.targetRoomId)?.name ?? p.targetRoomId}
									</span>
									{(p.generateSecret || p.providedSecret) && (
										<span className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-primary/15 text-primary font-semibold">
											{p.providedSecret ? "Signed (yours)" : "Signed"}
										</span>
									)}
								</div>
								<div className="text-[11px] text-muted-foreground italic">
									URL will be generated when you save the bot
								</div>
							</div>
							<button
								type="button"
								onClick={() => handleRemovePending(idx)}
								className="text-muted-foreground hover:text-destructive p-1 rounded hover:bg-destructive/10"
								title="Remove from queue"
							>
								<Trash2 className="h-3.5 w-3.5" />
							</button>
						</div>
					))}
				</div>
			)}

			{/* Edit-mode live list — full webhook rows with URLs + deliveries. */}
			{!isCreateMode && (
				<div className="space-y-3">
					{hooks.map(h => (
						<WebhookRow
							key={h.id}
							hook={h}
							accessToken={accessToken!}
							botId={bot!.id}
							onDelete={() => handleDelete(h.id)}
							roomName={ownerRooms.find(r => r.id === h.target_room_id)?.name ?? h.target_room_id}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// ─── Outbound webhooks sub-tab ──────────────────────────────────────
//
// Each row registers as an OpenAI tool definition the bot's LLM can
// call.  The user supplies: tool name (LLM sees it), description
// (LLM uses it to decide when to call), URL template with optional
// {placeholder} tokens, params (the LLM args, mapped to URL or body),
// and optional static headers (auth tokens).  Engine fires the HTTP
// request when the model invokes the tool and hands the response
// back to the LLM as a tool result.
//
// Edit-mode only — outbound webhooks need a bot id to attach to.
// In create mode we show a "save the bot first" placeholder rather
// than building a queued-pending flow (the inbound queue exists
// because users want to define inbound URLs before the bot has
// landed; outbound URLs are an after-the-fact add).

/** Reusable form for creating + editing outbound webhooks.  Used by
 * OutboundWebhooksSubTab in two places: a single inline create form
 * at the top of the list, and a per-row edit form that appears in
 * place of the read-only summary when the user clicks Edit.  Both
 * modes share the same field layout + validation; the only
 * difference is initial values, the Submit label, and whether the
 * Cancel button shows. */
interface OutboundFormSnapshot {
	name: string;
	description: string;
	method: "GET" | "POST";
	url: string;
	params: OutboundParam[];
	headers: OutboundHeader[];
}

function OutboundWebhookForm({
	mode,
	initial,
	submitting,
	onSubmit,
	onCancel,
}: {
	mode: "create" | "edit";
	/** Initial values.  In create mode usually all empty; in edit
	 * mode the snapshot of the row being edited. */
	initial: OutboundFormSnapshot;
	submitting: boolean;
	onSubmit(snapshot: OutboundFormSnapshot): Promise<void> | void;
	onCancel?(): void;
}) {
	const [name, setName] = useState(initial.name);
	const [description, setDescription] = useState(initial.description);
	const [method, setMethod] = useState<"GET" | "POST">(initial.method);
	const [url, setUrl] = useState(initial.url);
	const [params, setParams] = useState<OutboundParam[]>(initial.params);
	const [headers, setHeaders] = useState<OutboundHeader[]>(initial.headers);
	const [formError, setFormError] = useState<string | null>(null);

	// Stable ids for `htmlFor` so multiple instances on the same
	// page (create form + per-row edit forms) don't collide.
	const idPrefix = useId();

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setFormError(null);
		const trimmedName = name.trim();
		const trimmedUrl = url.trim();
		if (trimmedName.length === 0) { setFormError("Tool name required"); return; }
		if (!/^[a-zA-Z0-9_-]+$/.test(trimmedName)) {
			setFormError("Tool name may only contain letters, digits, underscore, hyphen");
			return;
		}
		if (trimmedUrl.length === 0) { setFormError("URL required"); return; }
		try {
			await onSubmit({
				name: trimmedName,
				description: description.trim(),
				method,
				url: trimmedUrl,
				params: params.filter(p => p.name.trim().length > 0),
				headers: headers.filter(h => h.name.trim().length > 0),
			});
		} catch (err) {
			setFormError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<form onSubmit={handleSubmit} className="rounded-md border border-border p-4 space-y-3">
			<div className="text-sm font-medium">{mode === "create" ? "Add a tool" : `Edit ${initial.name || "tool"}`}</div>
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
				<div className="space-y-1">
					<Label htmlFor={`${idPrefix}-name`}>Name</Label>
					<Input
						id={`${idPrefix}-name`}
						value={name}
						onChange={e => setName(e.target.value)}
						placeholder="e.g. fetch_news"
						maxLength={64}
						spellCheck={false}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor={`${idPrefix}-method`}>Method</Label>
					<select
						id={`${idPrefix}-method`}
						value={method}
						onChange={e => {
							const m = e.target.value as "GET" | "POST";
							setMethod(m);
							// GET requests can't carry a body — auto-
							// convert any body-scope params to url-
							// scope so the user doesn't end up with
							// silently-dropped fields after switching
							// from POST → GET.
							if (m === "GET") {
								setParams(arr => arr.map(p => p.in === "body" ? { ...p, in: "url" } : p));
							}
						}}
						className="h-9 w-full px-2 rounded border border-input bg-background text-sm"
					>
						<option value="GET">GET</option>
						<option value="POST">POST</option>
					</select>
				</div>
			</div>
			<div className="space-y-1">
				<Label htmlFor={`${idPrefix}-description`}>Description (what the LLM uses to decide when to call)</Label>
				<Input
					id={`${idPrefix}-description`}
					value={description}
					onChange={e => setDescription(e.target.value)}
					placeholder="e.g. Fetches today's top news headlines on a topic"
					maxLength={500}
				/>
			</div>
			<div className="space-y-1">
				<Label htmlFor={`${idPrefix}-url`}>URL</Label>
				<Input
					id={`${idPrefix}-url`}
					value={url}
					onChange={e => setUrl(e.target.value)}
					placeholder="https://api.example.com/news"
					spellCheck={false}
				/>
				<p className="text-[11px] text-muted-foreground">
					URL-scope params append automatically as <code>?name=value</code>. Use <code>{`{name}`}</code> in the URL only when you need to slot a value into a specific spot (e.g. <code>/users/{`{id}`}/posts</code>).
				</p>
			</div>

			{/* Params editor */}
			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label>Parameters <span className="text-muted-foreground font-normal text-xs">(arguments the LLM fills in)</span></Label>
					<button
						type="button"
						onClick={() => setParams(p => [...p, { name: "", description: "", required: false, in: "url" }])}
						className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
					>
						<Plus className="h-3 w-3" /> Add
					</button>
				</div>
				{params.length === 0 && (
					<div className="text-xs text-muted-foreground italic">No parameters yet — add one if your URL has placeholders or your POST needs body fields.</div>
				)}
				{params.map((p, i) => (
					<div key={i} className="grid grid-cols-12 gap-2 items-start">
						<input
							className="col-span-3 h-8 px-2 rounded border border-input bg-background text-xs font-mono"
							placeholder="name"
							value={p.name}
							onChange={e => setParams(arr => arr.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))}
						/>
						<input
							className={cn(
								"h-8 px-2 rounded border border-input bg-background text-xs",
								method === "GET" ? "col-span-8" : "col-span-6",
							)}
							placeholder="description (helps the LLM know what to put here)"
							value={p.description}
							onChange={e => setParams(arr => arr.map((x, idx) => idx === i ? { ...x, description: e.target.value } : x))}
						/>
						{method === "POST" && (
							<select
								className="col-span-2 h-8 px-1 rounded border border-input bg-background text-xs"
								value={p.in}
								onChange={e => setParams(arr => arr.map((x, idx) => idx === i ? { ...x, in: e.target.value as "url" | "body" } : x))}
								title="url = path/query substitution; body = JSON body field"
							>
								<option value="url">URL</option>
								<option value="body">Body</option>
							</select>
						)}
						<button
							type="button"
							onClick={() => setParams(arr => arr.filter((_, idx) => idx !== i))}
							className="col-span-1 h-8 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 inline-flex items-center justify-center"
							title="Remove"
						>
							<Trash2 className="h-3.5 w-3.5" />
						</button>
					</div>
				))}
			</div>

			{/* Headers editor */}
			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label>Headers <span className="text-muted-foreground font-normal text-xs">(auth tokens etc.)</span></Label>
					<button
						type="button"
						onClick={() => setHeaders(h => [...h, { name: "", value: "" }])}
						className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
					>
						<Plus className="h-3 w-3" /> Add
					</button>
				</div>
				{headers.length === 0 && (
					<div className="text-xs text-muted-foreground italic">No headers yet — add one for auth tokens (e.g. <code>Authorization: Bearer …</code>).</div>
				)}
				{headers.map((h, i) => (
					<div key={i} className="grid grid-cols-12 gap-2 items-start">
						<input
							className="col-span-4 h-8 px-2 rounded border border-input bg-background text-xs font-mono"
							placeholder="header name"
							value={h.name}
							onChange={e => setHeaders(arr => arr.map((x, idx) => idx === i ? { ...x, name: e.target.value } : x))}
						/>
						<input
							className="col-span-7 h-8 px-2 rounded border border-input bg-background text-xs font-mono"
							placeholder="value"
							value={h.value}
							type="password"
							onChange={e => setHeaders(arr => arr.map((x, idx) => idx === i ? { ...x, value: e.target.value } : x))}
						/>
						<button
							type="button"
							onClick={() => setHeaders(arr => arr.filter((_, idx) => idx !== i))}
							className="col-span-1 h-8 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 inline-flex items-center justify-center"
							title="Remove"
						>
							<Trash2 className="h-3.5 w-3.5" />
						</button>
					</div>
				))}
				{mode === "edit" && headers.length > 0 && (
					<p className="text-[11px] text-muted-foreground italic">
						Header values are masked but stored as-is. Re-type a value to update it; leave alone to keep the existing value.
					</p>
				)}
			</div>

			{formError && <div className="text-xs text-destructive">{formError}</div>}
			<div className="flex items-center gap-2">
				<Button type="submit" size="sm" disabled={submitting}>
					{mode === "create" ? <Plus className="h-3.5 w-3.5 mr-1.5" /> : null}
					{submitting
						? (mode === "create" ? "Creating…" : "Saving…")
						: (mode === "create" ? "Create tool" : "Save changes")}
				</Button>
				{onCancel && (
					<Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
						Cancel
					</Button>
				)}
			</div>
		</form>
	);
}

const EMPTY_OUTBOUND_FORM: OutboundFormSnapshot = {
	name: "",
	description: "",
	method: "GET",
	url: "",
	params: [],
	headers: [],
};

function OutboundWebhooksSubTab({
	bot,
	accessToken,
}: {
	bot: BotSummary | null;
	accessToken: string | null;
}) {
	const isCreateMode = bot === null;

	const [hooks, setHooks] = useState<OutboundWebhook[]>([]);
	const [loading, setLoading] = useState(!isCreateMode);
	const [listError, setListError] = useState<string | null>(null);

	// Per-row edit-mode tracking.  Only one row can be editing at a
	// time; clicking Edit on another row swaps focus.  null = no
	// row is being edited (the create form is the only form visible
	// at the top).
	const [editingId, setEditingId] = useState<number | null>(null);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		if (isCreateMode || !accessToken || !bot) return;
		let cancelled = false;
		setLoading(true);
		listBotOutboundWebhooks(accessToken, bot.id)
			.then(rows => { if (!cancelled) { setHooks(rows); setListError(null); } })
			.catch(err => { if (!cancelled) setListError(err instanceof Error ? err.message : String(err)); })
			.finally(() => { if (!cancelled) setLoading(false); });
		return () => { cancelled = true; };
	}, [isCreateMode, accessToken, bot]);

	async function refresh() {
		if (!accessToken || !bot) return;
		try {
			const rows = await listBotOutboundWebhooks(accessToken, bot.id);
			setHooks(rows);
			setListError(null);
		} catch (err) {
			setListError(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleCreate(snap: OutboundFormSnapshot) {
		if (!accessToken || !bot) return;
		setSubmitting(true);
		try {
			await createBotOutboundWebhook({
				accessToken,
				botId: bot.id,
				...snap,
			});
			await refresh();
		} finally {
			setSubmitting(false);
		}
	}

	async function handleUpdate(webhookId: number, snap: OutboundFormSnapshot) {
		if (!accessToken || !bot) return;
		setSubmitting(true);
		try {
			await updateBotOutboundWebhook({
				accessToken,
				botId: bot.id,
				webhookId,
				patch: snap,
			});
			setEditingId(null);
			await refresh();
		} finally {
			setSubmitting(false);
		}
	}

	async function handleDelete(wid: number) {
		if (!accessToken || !bot) return;
		if (!window.confirm("Delete this outbound tool?  The bot will lose access to it immediately.")) return;
		try {
			await deleteBotOutboundWebhook({ accessToken, botId: bot.id, webhookId: wid });
			if (editingId === wid) setEditingId(null);
			await refresh();
		} catch (err) {
			window.alert(`Couldn't delete: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	if (isCreateMode) {
		return (
			<div className="text-sm text-muted-foreground border border-border/60 rounded-md p-4 bg-muted/30">
				Save the bot first, then add outbound HTTP tools — they need an existing bot to attach to.
			</div>
		);
	}

	if (loading) {
		return <div className="text-sm text-muted-foreground">Loading…</div>;
	}

	return (
		<div className="space-y-5">
			<div className="flex items-start gap-2 text-sm text-muted-foreground">
				<Webhook className="h-4 w-4 mt-0.5 shrink-0 -scale-x-100" />
				<span>Define HTTP requests the bot can fire when its LLM decides to. The model picks the tool by <em>name</em> + <em>description</em>, fills in <em>params</em>, and uses the response in its reply. Use for news / weather / status APIs, n8n endpoints, internal services — anything that returns a useful body in one HTTP call.</span>
			</div>

			{listError && <div className="text-sm text-destructive">{listError}</div>}

			{/* Create form — always visible at the top. */}
			<OutboundWebhookForm
				mode="create"
				initial={EMPTY_OUTBOUND_FORM}
				submitting={submitting && editingId === null}
				onSubmit={handleCreate}
			/>

			{hooks.length === 0 && (
				<div className="text-sm text-muted-foreground italic">No outbound tools yet.</div>
			)}

			<div className="space-y-3">
				{hooks.map(h => {
					const isEditing = editingId === h.id;
					if (isEditing) {
						return (
							<OutboundWebhookForm
								key={h.id}
								mode="edit"
								initial={{
									name: h.name,
									description: h.description,
									method: h.method,
									url: h.url,
									params: h.params,
									headers: h.headers,
								}}
								submitting={submitting && editingId === h.id}
								onSubmit={snap => handleUpdate(h.id, snap)}
								onCancel={() => setEditingId(null)}
							/>
						);
					}
					return (
						<div key={h.id} className="rounded-md border border-border bg-card/60 p-3">
							<div className="flex items-start justify-between gap-2">
								<div className="flex-1 min-w-0">
									<div className="flex items-baseline gap-2 flex-wrap">
										<span className="text-sm font-medium font-mono">{h.name}</span>
										<span className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-primary/15 text-primary font-semibold">{h.method}</span>
										<span className="text-[11px] text-muted-foreground truncate">{h.url}</span>
									</div>
									{h.description && (
										<div className="text-xs text-muted-foreground mt-1">{h.description}</div>
									)}
									{h.params.length > 0 && (
										<div className="text-[11px] text-muted-foreground mt-2 flex flex-wrap gap-x-3 gap-y-1">
											{h.params.map(p => (
												<span key={p.name} className="font-mono">
													{p.name}
													<span className="text-muted-foreground/70">:{p.in}</span>
												</span>
											))}
										</div>
									)}
									{h.last_error && (
										<div className="text-[11px] text-destructive mt-1 truncate" title={h.last_error}>
											Last error: {h.last_error}
										</div>
									)}
									{h.last_called && !h.last_error && (
										<div className="text-[11px] text-muted-foreground mt-1">
											Last called: {new Date(h.last_called).toLocaleString()}
										</div>
									)}
								</div>
								<div className="flex items-center gap-1 shrink-0">
									<button
										type="button"
										onClick={() => setEditingId(h.id)}
										className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-accent"
										title="Edit"
									>
										<Pencil className="h-4 w-4" />
									</button>
									<button
										type="button"
										onClick={() => handleDelete(h.id)}
										className="text-muted-foreground hover:text-destructive p-1 rounded hover:bg-destructive/10"
										title="Delete"
									>
										<Trash2 className="h-4 w-4" />
									</button>
								</div>
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function CopyableField({
	label,
	value,
	secret = false,
}: {
	label: string;
	value: string;
	/** Renders the value as obscured dots until the user clicks to
	 * reveal.  Used for signing secrets so a bystander glance doesn't
	 * leak them.  Copy still works while obscured. */
	secret?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	const [revealed, setRevealed] = useState(!secret);

	const onCopy = async () => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			setTimeout(() => setCopied(false), 1800);
		} catch {
			// User can still triple-click + ⌘C from the rendered text.
		}
	};

	const display = revealed ? value : "•".repeat(Math.min(40, value.length));

	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between gap-2">
				<span className="text-[10.5px] uppercase tracking-[0.08em] font-medium text-muted-foreground">
					{label}
				</span>
				{secret && (
					<button
						type="button"
						onClick={() => setRevealed(r => !r)}
						className="text-[10.5px] uppercase tracking-[0.08em] font-medium text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors"
					>
						{revealed ? (
							<>
								<EyeOff className="h-3 w-3" /> Hide
							</>
						) : (
							<>
								<Eye className="h-3 w-3" /> Reveal
							</>
						)}
					</button>
				)}
			</div>
			<div className="group flex items-stretch rounded-md border border-border/80 bg-background/40 overflow-hidden focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30 transition-colors">
				<div
					className="flex-1 min-w-0 px-3 py-2 font-mono text-xs select-all overflow-x-auto whitespace-nowrap text-foreground/90 [scrollbar-width:thin]"
					onClick={(e) => {
						// One-click select makes ⌘C work without a triple
						// click — chrome strips the trailing newline that
						// triple-click on a div otherwise picks up.
						const range = document.createRange();
						range.selectNodeContents(e.currentTarget);
						const sel = window.getSelection();
						sel?.removeAllRanges();
						sel?.addRange(range);
					}}
					title={value}
				>
					{display}
				</div>
				<button
					type="button"
					onClick={onCopy}
					className={cn(
						"shrink-0 px-3 inline-flex items-center gap-1.5 text-xs font-medium border-l border-border/80 transition-colors",
						copied
							? "bg-primary/15 text-primary"
							: "text-muted-foreground hover:bg-accent hover:text-foreground",
					)}
					title="Copy to clipboard"
				>
					<Copy className="h-3.5 w-3.5" />
					{copied ? "Copied" : "Copy"}
				</button>
			</div>
		</div>
	);
}

function WebhookRow({
	hook,
	accessToken,
	botId,
	onDelete,
	roomName,
}: {
	hook: WebhookSummary;
	accessToken: string;
	botId: number;
	onDelete(): void;
	roomName: string;
}) {
	const url = webhookUrlFor(hook.token);
	const [showDeliveries, setShowDeliveries] = useState(false);
	const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
	const [delivLoading, setDelivLoading] = useState(false);

	useEffect(() => {
		if (!showDeliveries || deliveries !== null) return;
		setDelivLoading(true);
		listBotWebhookDeliveries({ accessToken, botId, webhookId: hook.id })
			.then(setDeliveries)
			.catch(() => setDeliveries([]))
			.finally(() => setDelivLoading(false));
	}, [showDeliveries, deliveries, accessToken, botId, hook.id]);

	return (
		<div className="rounded-md border border-border bg-card/40">
			<div className="p-3 flex items-start gap-3">
				<Webhook className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
				<div className="flex-1 min-w-0 space-y-1">
					<div className="flex items-baseline gap-2 flex-wrap">
						<span className="text-sm font-medium truncate">{hook.label || "(unlabeled)"}</span>
						<span className="text-[11px] text-muted-foreground truncate">→ {roomName}</span>
						{hook.has_secret && (
							<span className="text-[10px] uppercase tracking-wider px-1.5 py-px rounded bg-primary/15 text-primary font-semibold">HMAC</span>
						)}
					</div>
					<CopyableField label="URL" value={url} />
					{hook.last_error && (
						<div className="text-[11px] text-destructive truncate" title={hook.last_error}>
							Last error: {hook.last_error}
						</div>
					)}
					{hook.last_delivery && !hook.last_error && (
						<div className="text-[11px] text-muted-foreground">
							Last delivered: {new Date(hook.last_delivery).toLocaleString()}
						</div>
					)}
					<button
						type="button"
						onClick={() => setShowDeliveries(s => !s)}
						className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
					>
						{showDeliveries ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
						Recent deliveries
					</button>
				</div>
				<button
					type="button"
					onClick={onDelete}
					className="text-muted-foreground hover:text-destructive p-1 rounded hover:bg-destructive/10"
					title="Delete webhook"
				>
					<Trash2 className="h-3.5 w-3.5" />
				</button>
			</div>
			{showDeliveries && (
				<div className="border-t border-border bg-background/50 p-3 max-h-72 overflow-y-auto">
					{delivLoading && <div className="text-xs text-muted-foreground">Loading…</div>}
					{!delivLoading && deliveries && deliveries.length === 0 && (
						<div className="text-xs text-muted-foreground italic">No deliveries recorded yet.</div>
					)}
					<div className="space-y-2">
						{deliveries?.map(d => (
							<div key={d.id} className="text-[11px] font-mono space-y-1">
								<div className={cn("flex items-center gap-2", d.error ? "text-destructive" : "text-muted-foreground")}>
									<span>{new Date(d.received_at).toLocaleString()}</span>
									{d.error ? <span>· {d.error}</span> : <span>· delivered</span>}
								</div>
								<details className="ml-2">
									<summary className="cursor-pointer text-muted-foreground/80">payload</summary>
									<pre className="mt-1 p-2 rounded bg-muted/40 overflow-x-auto whitespace-pre-wrap break-words max-h-48">{d.payload_json}</pre>
								</details>
								{d.posted_text && (
									<details className="ml-2">
										<summary className="cursor-pointer text-muted-foreground/80">posted</summary>
										<pre className="mt-1 p-2 rounded bg-muted/40 overflow-x-auto whitespace-pre-wrap break-words">{d.posted_text}</pre>
									</details>
								)}
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

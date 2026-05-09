// Modal that collects per-server MCP configuration from a JSONSchema
// and returns the assembled config object.  Some Smithery servers
// declare required fields (Reddit needs an OAuth token, GitHub needs
// a PAT, …) — without a value for those, the bot's attempt to open
// the MCP session fails server-side and the tools never load.  The
// previous "attach with empty config" path silently produced bots
// that didn't know about half their tools; this dialog is the UX
// gap that closes off that failure mode.
//
// Schema support is intentionally pragmatic, not exhaustive:
//   - top-level `properties` map of named fields
//   - leaf types: string / number / integer / boolean
//   - string with `enum` → <select>
//   - string fields whose name suggests a credential (token / secret
//     / key / password / api_key, etc.) → password input
//   - `required: string[]` flags fields with an asterisk
//   - per-field `description` renders as helper text
//
// Anything more complex (oneOf, nested object, array) falls through
// to a raw-JSON textarea so power users can still configure the
// server without us having to model every schema shape.

import { useEffect, useMemo, useState } from "react";
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
import { Eye, EyeOff } from "lucide-react";

export interface McpConfigDialogProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	/** Server display name for the dialog title (e.g. "Reddit"). */
	displayName: string;
	/** Smithery qualified name shown subtly under the title. */
	qualifiedName: string;
	/** Optional homepage / docs link surfaced as helper copy when the
	 * server has required fields the user might need docs for. */
	homepage?: string;
	/** JSONSchema describing the per-server config.  Empty for
	 * servers that don't need any per-call config — those usually
	 * authorize via Smithery OAuth (Reddit, Notion, etc.) and
	 * trigger the OAuth callout below instead of a form. */
	configSchema: Record<string, unknown> | undefined;
	/** True when Smithery hosts the server (vs. local-stdio).
	 * Combined with empty configSchema, that's the heuristic for
	 * "this server probably needs OAuth setup on smithery.ai". */
	remote?: boolean;
	/** smithery.ai page for the server.  When provided, the dialog
	 * surfaces a "Configure on Smithery" link the user can follow
	 * to authorize OAuth integrations.  Required for the OAuth
	 * callout when configSchema is empty. */
	smitheryUrl?: string;
	/** Submit handler — fired with the assembled config object once
	 * the user clicks "Attach".  The dialog stays open (with a
	 * busy state) until this resolves so any backend error can
	 * surface inline. */
	onSubmit(config: Record<string, unknown>): Promise<void>;
}

interface FieldSpec {
	key: string;
	title: string;
	description: string;
	required: boolean;
	kind: "text" | "password" | "number" | "boolean" | "enum";
	enumValues: string[];
}

const SECRET_HINTS = /token|secret|key|password|credential|pat\b|auth/i;

/** Walk the schema's `properties` and produce a flat list of fields
 * we know how to render.  Fields whose type is anything we don't
 * support (object, array, oneOf, …) are skipped — caller falls back
 * to the raw-JSON pane in that case. */
function fieldsFromSchema(schema: Record<string, unknown> | undefined): {
	fields: FieldSpec[];
	hasUnsupported: boolean;
} {
	if (!schema || typeof schema !== "object") return { fields: [], hasUnsupported: false };
	const props = (schema as { properties?: unknown }).properties;
	if (!props || typeof props !== "object") return { fields: [], hasUnsupported: false };
	const required = Array.isArray((schema as { required?: unknown }).required)
		? ((schema as { required: unknown[] }).required.filter((x): x is string => typeof x === "string"))
		: [];

	const out: FieldSpec[] = [];
	let hasUnsupported = false;

	for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object") continue;
		const def = raw as Record<string, unknown>;
		const type = typeof def.type === "string" ? def.type : null;
		const description = typeof def.description === "string" ? def.description : "";
		const title = typeof def.title === "string" && def.title.trim().length > 0
			? def.title
			: prettifyKey(key);
		const isRequired = required.includes(key);

		if (type === "string") {
			const enumVals = Array.isArray(def.enum)
				? (def.enum as unknown[]).filter((x): x is string => typeof x === "string")
				: [];
			if (enumVals.length > 0) {
				out.push({ key, title, description, required: isRequired, kind: "enum", enumValues: enumVals });
			} else {
				const isSecret = def.format === "password"
					|| SECRET_HINTS.test(key)
					|| (typeof description === "string" && SECRET_HINTS.test(description.slice(0, 80)));
				out.push({ key, title, description, required: isRequired, kind: isSecret ? "password" : "text", enumValues: [] });
			}
		} else if (type === "number" || type === "integer") {
			out.push({ key, title, description, required: isRequired, kind: "number", enumValues: [] });
		} else if (type === "boolean") {
			out.push({ key, title, description, required: isRequired, kind: "boolean", enumValues: [] });
		} else {
			// Nested object / array / unknown shape — flag for the
			// raw-JSON fallback so power users can still set it.
			hasUnsupported = true;
		}
	}

	return { fields: out, hasUnsupported };
}

/** "githubPersonalAccessToken" → "Github personal access token". */
function prettifyKey(s: string): string {
	const spaced = s
		.replace(/[_-]+/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2");
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function McpConfigDialog({
	open,
	onOpenChange,
	displayName,
	qualifiedName,
	homepage,
	configSchema,
	remote,
	smitheryUrl,
	onSubmit,
}: McpConfigDialogProps) {
	const { fields, hasUnsupported } = useMemo(() => fieldsFromSchema(configSchema), [configSchema]);

	// Form state.  Kept as Record<string, unknown> rather than typed
	// per-field because the values flow straight into the per-server
	// config blob — opaque JSON from our perspective.
	const [values, setValues] = useState<Record<string, unknown>>({});
	const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
	const [rawJson, setRawJson] = useState("");
	const [showRaw, setShowRaw] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);

	// Reset whenever the dialog opens for a new server.
	useEffect(() => {
		if (!open) return;
		setValues({});
		setRevealedSecrets(new Set());
		setRawJson("");
		setShowRaw(hasUnsupported);
		setError(null);
		setSubmitting(false);
	}, [open, qualifiedName, hasUnsupported]);

	function setField(key: string, value: unknown) {
		setValues(prev => ({ ...prev, [key]: value }));
	}

	function toggleReveal(key: string) {
		setRevealedSecrets(prev => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key); else next.add(key);
			return next;
		});
	}

	async function submit() {
		setError(null);
		// Build the final config: form values for known fields, plus
		// raw JSON merged on top (so the user can override / set
		// extra fields that the simple form didn't surface).
		let merged: Record<string, unknown> = { ...values };
		// Drop empty-string entries so we don't send "" for fields
		// the user left blank — the server's own defaulting handles
		// that better than a literal empty string.
		for (const [k, v] of Object.entries(merged)) {
			if (v === "" || v === undefined) delete merged[k];
		}
		if (showRaw && rawJson.trim().length > 0) {
			try {
				const parsed = JSON.parse(rawJson);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					setError("Raw JSON must be an object.");
					return;
				}
				merged = { ...merged, ...(parsed as Record<string, unknown>) };
			} catch (err) {
				setError(`Raw JSON didn't parse: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
		}

		// Required-field check before we submit.
		const missing = fields
			.filter(f => f.required && (merged[f.key] === undefined || merged[f.key] === ""))
			.map(f => f.title);
		if (missing.length > 0) {
			setError(`Missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
			return;
		}

		setSubmitting(true);
		try {
			await onSubmit(merged);
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col p-0 gap-0">
				<DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
					<DialogTitle className="text-base">Configure {displayName}</DialogTitle>
					<DialogDescription className="text-xs font-mono truncate">{qualifiedName}</DialogDescription>
				</DialogHeader>
				<div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
					{fields.length === 0 && !hasUnsupported ? (
						// No fields to render.  Two sub-cases:
						//   - Remote (Smithery-hosted) server with no
						//     declared config schema: very likely
						//     OAuth-protected (Reddit, Notion, GitHub
						//     via Composio, …).  The MCP-spec OAuth
						//     handshake (Dynamic Client Registration +
						//     authorize-redirect + token exchange) has
						//     to happen in the BOT's MCP client at
						//     connect time — and Koven hasn't
						//     implemented that yet.  Tokens minted in
						//     Smithery's own playground don't carry
						//     over to our connection, so claiming
						//     "configure on Smithery" was misleading.
						//     Be honest: tell the user it likely won't
						//     work and link to Smithery for further
						//     reading rather than as a "fix this here"
						//     CTA.
						//   - Local / no-auth server: nothing to do.
						remote ? (
							<div className="space-y-3">
								<div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-3 text-sm space-y-2">
									<p className="font-medium">{displayName} may not work yet</p>
									<p className="text-muted-foreground">
										Servers like this one usually require OAuth authentication that runs in the MCP client at connect time. Koven's bot runtime doesn't yet support that flow — if the bot can't list this server's tools after attaching, that's why.
									</p>
									{smitheryUrl && (
										<a
											href={smitheryUrl}
											target="_blank"
											rel="noreferrer"
											className="inline-block text-primary underline hover:no-underline"
										>
											View on Smithery →
										</a>
									)}
								</div>
								<p className="text-xs text-muted-foreground">
									You can still attach the server — the bot will silently skip tools it can't authenticate against. Removing it later is a one-click action in the Tools list.
								</p>
							</div>
						) : (
							<p className="text-sm text-muted-foreground">
								This server doesn't need any configuration. Click Attach to add it.
							</p>
						)
					) : (
						<>
							{fields.length > 0 && (
								<div className="space-y-3">
									{fields.map(f => (
										<FieldRow
											key={f.key}
											field={f}
											value={values[f.key]}
											revealed={revealedSecrets.has(f.key)}
											onChange={v => setField(f.key, v)}
											onToggleReveal={() => toggleReveal(f.key)}
										/>
									))}
								</div>
							)}
							{(hasUnsupported || showRaw) && (
								<div className="space-y-1.5">
									<div className="flex items-center justify-between">
										<Label htmlFor="mcp-raw">Advanced (raw JSON)</Label>
										{!hasUnsupported && (
											<button
												type="button"
												onClick={() => setShowRaw(false)}
												className="text-[10px] text-muted-foreground hover:text-foreground"
											>
												hide
											</button>
										)}
									</div>
									<textarea
										id="mcp-raw"
										value={rawJson}
										onChange={e => setRawJson(e.target.value)}
										placeholder='{"extraField": "value"}'
										rows={4}
										className="w-full font-mono text-xs rounded-md border border-foreground/15 bg-background px-3 py-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
									/>
									<p className="text-[10px] text-muted-foreground">
										{hasUnsupported
											? "This server's schema has fields we couldn't render as a form. Provide the full config as JSON; it'll be merged on top of the fields above."
											: "Optional extra fields, merged on top of the form values."}
									</p>
								</div>
							)}
							{!hasUnsupported && !showRaw && (
								<button
									type="button"
									onClick={() => setShowRaw(true)}
									className="text-xs text-muted-foreground hover:text-foreground underline"
								>
									Add advanced JSON…
								</button>
							)}
						</>
					)}

					{homepage && (
						<p className="text-xs text-muted-foreground">
							Need help finding these values?{" "}
							<a
								href={homepage}
								target="_blank"
								rel="noreferrer"
								className="underline hover:text-foreground"
							>
								Open the server's docs
							</a>
							.
						</p>
					)}

					{error && (
						<div className="text-xs text-destructive border border-destructive/40 bg-destructive/5 rounded px-3 py-2">
							{error}
						</div>
					)}
				</div>
				<DialogFooter className="px-5 py-3 border-t border-border">
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
						Cancel
					</Button>
					<Button type="button" onClick={submit} disabled={submitting}>
						{submitting ? "Attaching…" : "Attach with config"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function FieldRow({
	field, value, revealed, onChange, onToggleReveal,
}: {
	field: FieldSpec;
	value: unknown;
	revealed: boolean;
	onChange(v: unknown): void;
	onToggleReveal(): void;
}) {
	const id = `mcp-cfg-${field.key}`;
	return (
		<div className="space-y-1">
			<Label htmlFor={id} className="text-xs">
				{field.title}
				{field.required && <span className="text-destructive ml-0.5" aria-hidden>*</span>}
			</Label>
			{field.kind === "boolean" ? (
				<label className="flex items-center gap-2 text-sm">
					<input
						id={id}
						type="checkbox"
						checked={value === true}
						onChange={e => onChange(e.target.checked)}
						className="h-4 w-4"
					/>
					<span className="text-xs text-muted-foreground">{field.description || "Enable"}</span>
				</label>
			) : field.kind === "enum" ? (
				<select
					id={id}
					value={typeof value === "string" ? value : ""}
					onChange={e => onChange(e.target.value)}
					className="h-9 w-full rounded-md border border-foreground/15 bg-background px-3 text-sm"
				>
					<option value="">Select…</option>
					{field.enumValues.map(v => (
						<option key={v} value={v}>{v}</option>
					))}
				</select>
			) : field.kind === "number" ? (
				<Input
					id={id}
					type="number"
					value={typeof value === "number" ? String(value) : (typeof value === "string" ? value : "")}
					onChange={e => {
						const v = e.target.value;
						if (v === "") { onChange(""); return; }
						const n = Number(v);
						onChange(Number.isFinite(n) ? n : v);
					}}
				/>
			) : field.kind === "password" ? (
				<div className="relative">
					<Input
						id={id}
						type={revealed ? "text" : "password"}
						value={typeof value === "string" ? value : ""}
						onChange={e => onChange(e.target.value)}
						autoComplete="off"
						className="pr-9 font-mono"
					/>
					<button
						type="button"
						onClick={onToggleReveal}
						aria-label={revealed ? "Hide value" : "Show value"}
						className="absolute inset-y-0 right-0 px-2 flex items-center text-muted-foreground hover:text-foreground"
					>
						{revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
					</button>
				</div>
			) : (
				<Input
					id={id}
					type="text"
					value={typeof value === "string" ? value : ""}
					onChange={e => onChange(e.target.value)}
					autoComplete="off"
				/>
			)}
			{field.description && field.kind !== "boolean" && (
				<p className={cn("text-[11px] text-muted-foreground leading-snug")}>
					{field.description}
				</p>
			)}
		</div>
	);
}

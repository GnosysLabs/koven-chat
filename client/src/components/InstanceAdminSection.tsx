// Admin-only branding controls for the instance (server name, login
// background, tagline).  The parent gates whether this is rendered at
// all based on the user's admin status — this component just assumes
// the caller is allowed and focuses on the form.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	fetchInstanceConfig,
	resolveAssetUrl,
	updateInstanceConfig,
	uploadLoginBackground,
	uploadLogo,
	type InstanceConfig,
} from "@/lib/instance";
import { Camera, Check, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MatrixTransport } from "@/lib/matrix";
import { fetchIntegrationsStatus, type IntegrationsStatus } from "@/lib/klipy";

export interface InstanceAdminSectionProps {
	accessToken: string;
	transport: MatrixTransport | null;
	onConfigChange?: (config: InstanceConfig) => void;
}

interface PublicSpaceOption {
	roomId: string;
	name: string;
	memberCount: number;
}

export function InstanceAdminSection({ accessToken, transport, onConfigChange }: InstanceAdminSectionProps) {
	const [loading, setLoading] = useState(true);
	const [config, setConfig] = useState<InstanceConfig>({});
	const [name, setName] = useState("");
	const [tagline, setTagline] = useState("");
	const [defaultSpaceId, setDefaultSpaceId] = useState<string>("");
	const [allowCommentEditWhenReply, setAllowCommentEditWhenReply] = useState<string>("false");
	const [allowEditForMinutes, setAllowEditForMinutes] = useState<string>("default");
	const [publicSpaces, setPublicSpaces] = useState<PublicSpaceOption[]>([]);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const logoInputRef = useRef<HTMLInputElement | null>(null);

	// Integrations: Klipy etc.  The API key itself is never returned
	// from the engine (write-only); we only learn whether one is set
	// via /api/instance/integrations.  `klipyKeyDraft` holds the
	// admin's pending input until they hit Save.
	const [integrations, setIntegrations] = useState<IntegrationsStatus | null>(null);
	const [klipyKeyDraft, setKlipyKeyDraft] = useState("");
	// Turnstile uses two keys: site (public, embedded in login HTML)
	// and secret (private, used for siteverify).  Both required for
	// the integration to function — engine reports `configured` true
	// only when both are set.
	const [turnstileSiteDraft, setTurnstileSiteDraft] = useState("");
	const [turnstileSecretDraft, setTurnstileSecretDraft] = useState("");

	useEffect(() => {
		let cancelled = false;
		// Config + public-space directory in parallel — directory feeds
		// the default-space dropdown, both are independent of each
		// other so we don't gate one on the other.
		Promise.all([
			fetchInstanceConfig().catch(() => ({} as InstanceConfig)),
			transport
				? transport.discoverPublicRooms({ limit: 100 }).catch(() => [])
				: Promise.resolve([]),
			fetchIntegrationsStatus(accessToken).catch(
				() => ({ klipy: { configured: false } } as IntegrationsStatus),
			),
		]).then(([cfg, dirEntries, integ]) => {
			if (cancelled) return;
			setConfig(cfg);
			setName(cfg.name ?? "");
			setTagline(cfg.login_tagline ?? "");
			setDefaultSpaceId(cfg.default_space_id ?? "");
			setAllowCommentEditWhenReply(cfg.allow_comment_edit_when_reply ?? "false");
			setAllowEditForMinutes(cfg.allow_edit_for_minutes ?? "default");
			// Public config exposes the Turnstile site key: it's
			// embedded in the login HTML so it's not a secret. Pre-
			// fill the input so admins can see what's set without
			// re-pasting from Cloudflare.
			setTurnstileSiteDraft((cfg as { turnstile_site_key?: string }).turnstile_site_key ?? "");
			setPublicSpaces(
				dirEntries
					.filter(e => e.isSpace)
					.map(e => ({ roomId: e.roomId, name: e.name, memberCount: e.memberCount })),
			);
			setIntegrations(integ);
			setLoading(false);
		});
		return () => { cancelled = true; };
	}, [accessToken, transport]);

	if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

	async function save() {
		setPending(true);
		setError(null);
		setInfo(null);
		try {
			const patch: Record<string, string | null> = {
				name: name.trim() || null,
				login_tagline: tagline.trim() || null,
				default_space_id: defaultSpaceId || null,
				allow_comment_edit_when_reply: allowCommentEditWhenReply,
				allow_edit_for_minutes: allowEditForMinutes,
			};
			// Only write the Klipy key when the admin has typed
			// something, never overwrite an existing key with empty
			// (Clear is the explicit way to remove it).
			if (klipyKeyDraft.trim()) patch.klipy_api_key = klipyKeyDraft.trim();
			// Turnstile site key is editable in-place (it's public),
			// so write it whenever it differs from the saved value.
			// Empty input clears the saved key (passes null).
			const currentSite = (config as { turnstile_site_key?: string }).turnstile_site_key ?? "";
			const trimmedSite = turnstileSiteDraft.trim();
			if (trimmedSite !== currentSite) {
				patch.turnstile_site_key = trimmedSite || null;
			}
			// Secret key is write-only.  Same rule as Klipy: only
			// write on non-empty draft.
			if (turnstileSecretDraft.trim()) {
				patch.turnstile_secret_key = turnstileSecretDraft.trim();
			}
			const next = await updateInstanceConfig(accessToken, patch);
			setConfig(next);
			onConfigChange?.(next);
			const wroteIntegration = !!(
				klipyKeyDraft.trim() || turnstileSecretDraft.trim() || trimmedSite !== currentSite
			);
			if (wroteIntegration) {
				// Re-fetch integrations to flip the badge to "configured"
				// and clear write-only drafts back to placeholder.
				const integ = await fetchIntegrationsStatus(accessToken);
				setIntegrations(integ);
				setKlipyKeyDraft("");
				setTurnstileSecretDraft("");
				// Site key is left in-place, pre-fills from the freshly
				// loaded config below.
				setTurnstileSiteDraft(
					(next as { turnstile_site_key?: string }).turnstile_site_key ?? "",
				);
			}
			setInfo("Saved.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	async function uploadBg(file: File) {
		setPending(true);
		setError(null);
		setInfo(null);
		try {
			const next = await uploadLoginBackground(accessToken, file);
			setConfig(next);
			onConfigChange?.(next);
			setInfo("Background updated.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	async function removeBg() {
		setPending(true);
		setError(null);
		setInfo(null);
		try {
			const next = await updateInstanceConfig(accessToken, { login_background_url: null });
			setConfig(next);
			onConfigChange?.(next);
			setInfo("Background removed.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	async function doUploadLogo(file: File) {
		setPending(true);
		setError(null);
		setInfo(null);
		try {
			const next = await uploadLogo(accessToken, file);
			setConfig(next);
			onConfigChange?.(next);
			setInfo("Logo updated.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	async function clearKlipyKey() {
		setPending(true);
		setError(null);
		setInfo(null);
		try {
			const nextConfig = await updateInstanceConfig(accessToken, { klipy_api_key: null });
			setConfig(nextConfig);
			onConfigChange?.(nextConfig);
			const next = await fetchIntegrationsStatus(accessToken);
			setIntegrations(next);
			setKlipyKeyDraft("");
			setInfo("Klipy disabled.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	async function clearTurnstile() {
		setPending(true);
		setError(null);
		setInfo(null);
		try {
			// Clearing wipes BOTH keys, leaving one half configured
			// produces a half-broken state where the engine refuses
			// requests but the login HTML doesn't render the widget,
			// so users hit captcha_required errors with nothing to
			// solve. Atomic clear keeps the state coherent.
			const next = await updateInstanceConfig(accessToken, {
				turnstile_site_key: null,
				turnstile_secret_key: null,
			});
			setConfig(next);
			onConfigChange?.(next);
			const integ = await fetchIntegrationsStatus(accessToken);
			setIntegrations(integ);
			setTurnstileSiteDraft("");
			setTurnstileSecretDraft("");
			setInfo("Turnstile disabled.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	async function removeLogo() {
		setPending(true);
		setError(null);
		setInfo(null);
		try {
			const next = await updateInstanceConfig(accessToken, { logo_url: null });
			setConfig(next);
			onConfigChange?.(next);
			setInfo("Logo removed.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	const bgUrl = resolveAssetUrl(config.login_background_url);
	const logoUrl = resolveAssetUrl(config.logo_url);
	const currentTurnstileSite = (config as { turnstile_site_key?: string }).turnstile_site_key ?? "";
	const dirty =
		name.trim() !== (config.name ?? "") ||
		tagline.trim() !== (config.login_tagline ?? "") ||
		defaultSpaceId !== (config.default_space_id ?? "") ||
		allowCommentEditWhenReply !== (config.allow_comment_edit_when_reply ?? "false") ||
		allowEditForMinutes !== (config.allow_edit_for_minutes ?? "default") ||
		klipyKeyDraft.trim() !== "" ||
		turnstileSiteDraft.trim() !== currentTurnstileSite ||
		turnstileSecretDraft.trim() !== "";

	return (
		<section>
			<p className="text-xs text-muted-foreground mb-4 leading-snug">
				Branding shown to everyone signing in to this server.
			</p>

			<div className="space-y-4">
				<div className="space-y-1.5">
					<Label htmlFor="instance-name">Server name</Label>
					<Input
						id="instance-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Koven"
						maxLength={80}
					/>
					<p className="text-[10px] text-muted-foreground">
						Hidden when a logo is uploaded.
					</p>
				</div>

				<div className="space-y-1.5">
					<Label>Logo <span className="text-muted-foreground font-normal">(optional)</span></Label>
					<div className="flex items-start gap-3">
						<div
							className={cn(
								"h-14 min-w-[112px] rounded-md border border-border shrink-0 flex items-center justify-center px-2",
								logoUrl ? "bg-muted/40" : "bg-muted text-muted-foreground italic text-[10px]",
							)}
						>
							{logoUrl ? (
								<img src={logoUrl} alt="logo" className="max-h-10 max-w-full object-contain" />
							) : (
								<span>No logo</span>
							)}
						</div>
						<div className="flex flex-col gap-1.5">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => logoInputRef.current?.click()}
								disabled={pending}
							>
								<Camera className="h-3.5 w-3.5 mr-1.5" />
								{logoUrl ? "Replace" : "Upload"}
							</Button>
							{logoUrl && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="text-muted-foreground hover:text-destructive"
									onClick={removeLogo}
									disabled={pending}
								>
									<Trash2 className="h-3.5 w-3.5 mr-1.5" />
									Remove
								</Button>
							)}
							<p className="text-[10px] text-muted-foreground italic max-w-[180px] leading-snug">
								Replaces the server name on the login screen. PNG / SVG with a transparent background looks best.
							</p>
						</div>
						<input
							ref={logoInputRef}
							type="file"
							accept="image/*"
							className="hidden"
							onChange={(e) => {
								const file = e.target.files?.[0];
								if (file) doUploadLogo(file);
								e.target.value = "";
							}}
						/>
					</div>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="instance-tagline">Login tagline <span className="text-muted-foreground font-normal">(optional)</span></Label>
					<Input
						id="instance-tagline"
						value={tagline}
						onChange={(e) => setTagline(e.target.value)}
						placeholder="A line shown under the server name"
						maxLength={120}
					/>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="instance-default-space">
						Default space <span className="text-muted-foreground font-normal">(optional)</span>
					</Label>
					<select
						id="instance-default-space"
						value={defaultSpaceId}
						onChange={(e) => setDefaultSpaceId(e.target.value)}
						className="flex h-9 w-full rounded-md border border-foreground/15 bg-transparent px-3 py-1 text-sm shadow-sm transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring"
					>
						<option value="">— None —</option>
						{publicSpaces.map(s => (
							<option key={s.roomId} value={s.roomId}>
								{s.name} · {s.memberCount} {s.memberCount === 1 ? "member" : "members"}
							</option>
						))}
					</select>
					<p className="text-[10px] text-muted-foreground leading-snug">
						New users are auto-joined to this space (and its public rooms) on signup. Only public spaces are listed.
					</p>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="instance-allow-comment-edit-when-reply">Allow comment edit when reply</Label>
					<select
						id="instance-allow-comment-edit-when-reply"
						value={allowCommentEditWhenReply}
						onChange={(e) => setAllowCommentEditWhenReply(e.target.value)}
						className="flex h-9 w-full rounded-md border border-foreground/15 bg-transparent px-3 py-1 text-sm shadow-sm transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring"
					>
						<option value="false">No</option>
						<option value="true">Yes</option>
					</select>
					<p className="text-[10px] text-muted-foreground leading-snug">
						Controls whether users are allowed to edit a comment after it has replies.
					</p>
				</div>

				<div className="space-y-1.5">
					<Label htmlFor="instance-allow-edit-for-minutes">Allow edit for</Label>
					<select
						id="instance-allow-edit-for-minutes"
						value={allowEditForMinutes}
						onChange={(e) => setAllowEditForMinutes(e.target.value)}
						className="flex h-9 w-full rounded-md border border-foreground/15 bg-transparent px-3 py-1 text-sm shadow-sm transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring"
					>
						<option value="default">Default (10 minutes)</option>
						<option value="5">5 minutes</option>
						<option value="15">15 minutes</option>
						<option value="30">30 minutes</option>
						<option value="60">1 hour</option>
						<option value="infinite">Infinite</option>
					</select>
					<p className="text-[10px] text-muted-foreground leading-snug">
						The time window after posting during which a user is allowed to edit their comment.
					</p>
				</div>

				<div className="space-y-1.5">
					<Label>Login background</Label>
					<div className="flex items-start gap-3">
						<div
							className="h-20 w-32 rounded-md border border-border bg-muted shrink-0 bg-cover bg-center"
							style={bgUrl ? { backgroundImage: `url('${bgUrl}')` } : undefined}
						/>
						<div className="flex flex-col gap-1.5">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => fileInputRef.current?.click()}
								disabled={pending}
							>
								<Camera className="h-3.5 w-3.5 mr-1.5" />
								{bgUrl ? "Replace" : "Upload"}
							</Button>
							{bgUrl && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="text-muted-foreground hover:text-destructive"
									onClick={removeBg}
									disabled={pending}
								>
									<Trash2 className="h-3.5 w-3.5 mr-1.5" />
									Remove
								</Button>
							)}
							<p className="text-[10px] text-muted-foreground italic max-w-[180px] leading-snug">
								PNG / JPG / WebP / GIF / SVG, up to 5 MB.
							</p>
						</div>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							className="hidden"
							onChange={(e) => {
								const file = e.target.files?.[0];
								if (file) uploadBg(file);
								e.target.value = "";
							}}
						/>
					</div>
				</div>

				{/* ── Integrations ───────────────────────────────────
				    Third-party services keyed at the instance level.
				    The API key is write-only — once saved, the engine
				    never returns it.  The "Configured" badge is the
				    only feedback that a key is set, which is enough
				    for an admin re-visiting the form to know they
				    don't need to paste it again. */}
				<div className="pt-4 border-t border-border space-y-3">
					<div>
						<h3 className="text-sm font-semibold">Integrations</h3>
						<p className="text-[10px] text-muted-foreground leading-snug">
							Optional third-party services. Keys are stored on this server only and never sent back to clients.
						</p>
					</div>

					<div className="space-y-1.5">
						<div className="flex items-center justify-between">
							<Label htmlFor="klipy-api-key">Klipy API key</Label>
							{integrations?.klipy.configured ? (
								<span className="inline-flex items-center gap-1 text-[10px] text-emerald-500/90">
									<Check className="h-3 w-3" />
									Configured
								</span>
							) : (
								<span className="text-[10px] text-muted-foreground">Not configured</span>
							)}
						</div>
						<div className="flex gap-2">
							<Input
								id="klipy-api-key"
								type="password"
								autoComplete="off"
								value={klipyKeyDraft}
								onChange={(e) => setKlipyKeyDraft(e.target.value)}
								placeholder={integrations?.klipy.configured ? "•••••••• (paste a new key to replace)" : "Paste your Klipy API key"}
								disabled={pending}
							/>
							{integrations?.klipy.configured && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={clearKlipyKey}
									disabled={pending}
									className="text-muted-foreground hover:text-destructive"
								>
									Clear
								</Button>
							)}
						</div>
						<p className="text-[10px] text-muted-foreground leading-snug">
							Sign up at <a href="https://klipy.com/developers" target="_blank" rel="noreferrer" className="underline">klipy.com/developers</a> and request a key.  When set, members get a media picker (GIFs, clips, and stickers) in the message composer.
						</p>
					</div>

					{/* Cloudflare Turnstile — bot detection on email
					    sign-in.  Two fields because Turnstile's API is
					    split: a public site key (embedded in the
					    login HTML) and a private secret key (used
					    server-side for siteverify).  Both required to
					    enforce. */}
					<div className="space-y-1.5 pt-2">
						<div className="flex items-center justify-between">
							<Label htmlFor="turnstile-site-key">Cloudflare Turnstile</Label>
							{integrations?.turnstile?.configured ? (
								<span className="inline-flex items-center gap-1 text-[10px] text-emerald-500/90">
									<Check className="h-3 w-3" />
									Configured
								</span>
							) : (
								<span className="text-[10px] text-muted-foreground">Not configured</span>
							)}
						</div>
						<Input
							id="turnstile-site-key"
							type="text"
							autoComplete="off"
							value={turnstileSiteDraft}
							onChange={(e) => setTurnstileSiteDraft(e.target.value)}
							placeholder="Site key (public, e.g. 0x4AAA…)"
							disabled={pending}
						/>
						<div className="flex gap-2">
							<Input
								id="turnstile-secret-key"
								type="password"
								autoComplete="off"
								value={turnstileSecretDraft}
								onChange={(e) => setTurnstileSecretDraft(e.target.value)}
								placeholder={integrations?.turnstile?.configured ? "•••••••• (paste a new secret to replace)" : "Secret key (private)"}
								disabled={pending}
							/>
							{integrations?.turnstile?.configured && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={clearTurnstile}
									disabled={pending}
									className="text-muted-foreground hover:text-destructive"
								>
									Clear
								</Button>
							)}
						</div>
						<p className="text-[10px] text-muted-foreground leading-snug">
							Get both keys from <a href="https://dash.cloudflare.com/?to=/:account/turnstile" target="_blank" rel="noreferrer" className="underline">Cloudflare → Turnstile</a>. When both are set, the email sign-in step requires passing a managed-challenge before a code is sent — blocks bots from burning the email quota.
						</p>
					</div>
				</div>

				{error && (
					<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
						{error}
					</div>
				)}
				{info && !error && (
					<div className="text-xs text-emerald-500/90 border border-emerald-500/30 bg-emerald-500/5 rounded px-3 py-2">
						{info}
					</div>
				)}

				<div className="flex justify-end">
					<Button type="button" onClick={save} disabled={pending || !dirty}>
						{pending ? "Saving…" : "Save"}
					</Button>
				</div>
			</div>
		</section>
	);
}

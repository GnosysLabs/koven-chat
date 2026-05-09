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
import { fetchIntegrationsStatus, type IntegrationsStatus } from "@/lib/giphy";

export interface InstanceAdminSectionProps {
	accessToken: string;
	transport: MatrixTransport | null;
}

interface PublicSpaceOption {
	roomId: string;
	name: string;
	memberCount: number;
}

export function InstanceAdminSection({ accessToken, transport }: InstanceAdminSectionProps) {
	const [loading, setLoading] = useState(true);
	const [config, setConfig] = useState<InstanceConfig>({});
	const [name, setName] = useState("");
	const [tagline, setTagline] = useState("");
	const [defaultSpaceId, setDefaultSpaceId] = useState<string>("");
	const [publicSpaces, setPublicSpaces] = useState<PublicSpaceOption[]>([]);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const logoInputRef = useRef<HTMLInputElement | null>(null);

	// Integrations — Giphy etc.  The API key itself is never returned
	// from the engine (write-only); we only learn whether one is set
	// via /api/instance/integrations.  `giphyKeyDraft` holds the
	// admin's pending input until they hit Save.
	const [integrations, setIntegrations] = useState<IntegrationsStatus | null>(null);
	const [giphyKeyDraft, setGiphyKeyDraft] = useState("");

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
				() => ({ giphy: { configured: false } } as IntegrationsStatus),
			),
		]).then(([cfg, dirEntries, integ]) => {
			if (cancelled) return;
			setConfig(cfg);
			setName(cfg.name ?? "");
			setTagline(cfg.login_tagline ?? "");
			setDefaultSpaceId(cfg.default_space_id ?? "");
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
			const next = await updateInstanceConfig(accessToken, {
				name: name.trim() || null,
				login_tagline: tagline.trim() || null,
				default_space_id: defaultSpaceId || null,
			});
			setConfig(next);
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
			setInfo("Logo updated.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	async function saveGiphyKey() {
		if (!giphyKeyDraft.trim()) return;
		setPending(true);
		setError(null);
		setInfo(null);
		try {
			await updateInstanceConfig(accessToken, { giphy_api_key: giphyKeyDraft.trim() });
			// Re-fetch integrations to flip the badge to "configured"
			// without exposing the value we just wrote.
			const next = await fetchIntegrationsStatus(accessToken);
			setIntegrations(next);
			setGiphyKeyDraft("");
			setInfo("Giphy API key saved.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	async function clearGiphyKey() {
		setPending(true);
		setError(null);
		setInfo(null);
		try {
			await updateInstanceConfig(accessToken, { giphy_api_key: null });
			const next = await fetchIntegrationsStatus(accessToken);
			setIntegrations(next);
			setGiphyKeyDraft("");
			setInfo("Giphy disabled.");
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
			setInfo("Logo removed.");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	const bgUrl = resolveAssetUrl(config.login_background_url);
	const logoUrl = resolveAssetUrl(config.logo_url);
	const dirty =
		name.trim() !== (config.name ?? "") ||
		tagline.trim() !== (config.login_tagline ?? "") ||
		defaultSpaceId !== (config.default_space_id ?? "");

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
							<Label htmlFor="giphy-api-key">Giphy API key</Label>
							{integrations?.giphy.configured ? (
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
								id="giphy-api-key"
								type="password"
								autoComplete="off"
								value={giphyKeyDraft}
								onChange={(e) => setGiphyKeyDraft(e.target.value)}
								placeholder={integrations?.giphy.configured ? "•••••••• (paste a new key to replace)" : "Paste your Giphy API key"}
								disabled={pending}
							/>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={saveGiphyKey}
								disabled={pending || !giphyKeyDraft.trim()}
							>
								Save
							</Button>
							{integrations?.giphy.configured && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={clearGiphyKey}
									disabled={pending}
									className="text-muted-foreground hover:text-destructive"
								>
									Clear
								</Button>
							)}
						</div>
						<p className="text-[10px] text-muted-foreground leading-snug">
							Get a key at <a href="https://developers.giphy.com/dashboard/" target="_blank" rel="noreferrer" className="underline">developers.giphy.com</a> — pick the <strong>API</strong> option (not SDK). When set, members get a GIF picker in the message composer.
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

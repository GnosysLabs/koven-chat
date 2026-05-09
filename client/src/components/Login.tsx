// Login / sign-up screen.  Single email-code flow: user enters their
// email, the engine sends a 6-digit code via Resend, user enters the
// code, engine returns a Matrix access token (creating the account on
// first contact for that email).  No passwords ever surface to the
// user.
//
// The UIA password we get back in the verify response gets handed to
// the parent so it can be stashed in the transport for the immediate
// follow-on UIA challenge (encryption setup at signup).  Subsequent
// UIA challenges call /api/auth/uia-password to rotate fresh.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { isMobileShell } from "@/lib/mobile";
import type { MatrixCredentials } from "@/lib/matrix";
import { fetchInstanceConfig, resolveAssetUrl, type InstanceConfig } from "@/lib/instance";
import {
	requestEmailCode,
	verifyEmailCode,
	type RequestCodeError,
	type VerifyCodeError,
} from "@/lib/auth";
import { HOMESERVER_URL } from "@/lib/urls";
import { useTurnstile } from "@/lib/turnstile";

export interface LoginProps {
	onLoggedIn(creds: MatrixCredentials, uiaPassword: string): void;
	// "Add account" mode flips the heading to make it clear the user
	// is signing INTO an additional account rather than the only one,
	// and surfaces a "Back" button so they can cancel without
	// trapping themselves on the login screen with another account
	// already signed in.  Default false → original single-account
	// flow.
	addingAccount?: boolean;
	onCancelAddAccount?(): void;
}

type Step = "email" | "code";

export function Login({ onLoggedIn, addingAccount, onCancelAddAccount }: LoginProps) {
	const [step, setStep] = useState<Step>("email");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [username, setUsername] = useState("");
	const [isNewAccount, setIsNewAccount] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	const [instance, setInstance] = useState<InstanceConfig>({});

	// Mobile login: drop the brand image entirely and paint the
	// whole canvas `#0a0a0c` — the same colour iOS forces the
	// home-indicator safe-area zone to use in PWA standalone mode
	// (manifest `theme_color`).  Solid-colour login means there's
	// no visible boundary between the page and the system strip
	// at the bottom: it all reads as one continuous dark canvas.
	// Trade-off: lose the brand wallpaper on mobile login, but
	// gain a clean edge-to-edge presentation that no iOS WebKit
	// regression can break.
	//
	// Cleared on unmount so the rest of the SPA gets its normal
	// theme-driven background back.
	useEffect(() => {
		if (!isMobileShell) return;
		const html = document.documentElement;
		const prevStyle = html.getAttribute("style") ?? "";
		html.style.backgroundColor = "#0a0a0c";
		html.style.backgroundImage = "none";
		const body = document.body;
		const prevBg = body.style.backgroundColor;
		body.style.backgroundColor = "#0a0a0c";
		return () => {
			html.setAttribute("style", prevStyle);
			body.style.backgroundColor = prevBg;
		};
	}, []);

	useEffect(() => {
		// Best-effort. If the engine is offline, we render the
		// hard-coded defaults rather than blocking the form.
		fetchInstanceConfig()
			.then(setInstance)
			.catch(() => setInstance({}));
	}, []);

	const brandName = instance.name?.trim() || "Koven";
	const tagline = instance.login_tagline?.trim();
	// Brand background image on desktop only.  Mobile uses a flat
	// `#0a0a0c` canvas (matching iOS's PWA safe-area fill) so the
	// home-indicator system strip blends seamlessly — see the
	// useEffect above for the rationale.
	const bgUrl = isMobileShell
		? null
		: resolveAssetUrl(instance.login_background_url);
	const logoUrl = resolveAssetUrl(instance.logo_url);

	function reset() {
		setStep("email");
		setCode("");
		setUsername("");
		setError(null);
		setInfo(null);
		setIsNewAccount(false);
	}

	async function submitEmail(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = email.trim().toLowerCase();
		if (!trimmed) return;
		setError(null);
		setInfo(null);
		setPending(true);
		const r = await requestEmailCode(trimmed, {
			turnstileToken: turnstile.token,
		});
		setPending(false);
		if (!r.ok) {
			// On captcha failure, reset the widget so the user can
			// try again without reloading.  Other errors leave the
			// widget alone — its token may still be valid for a
			// retry.
			if (r.error === "captcha_failed" || r.error === "captcha_required") {
				turnstile.reset();
			}
			setError(requestErrorMessage(r.error));
			return;
		}
		setIsNewAccount(r.isNewAccount);
		setInfo(r.isNewAccount
			? "Check your inbox for a 6-digit code. Pick a username below to finish creating your account."
			: "Check your inbox for a 6-digit code.");
		setStep("code");
	}

	async function submitCode(e: React.FormEvent) {
		e.preventDefault();
		const trimmedCode = code.trim();
		const trimmedUser = username.trim().toLowerCase();
		if (!trimmedCode) return;
		if (isNewAccount) {
			if (!trimmedUser) {
				setError("Pick a username to finish creating your account.");
				return;
			}
			if (!isValidLocalpart(trimmedUser)) {
				setError("Username can only contain lowercase letters, numbers, and hyphens.");
				return;
			}
		}
		setError(null);
		setPending(true);
		const r = await verifyEmailCode({
			email: email.trim().toLowerCase(),
			code: trimmedCode,
			username: isNewAccount ? trimmedUser : undefined,
			homeserver: HOMESERVER_URL,
		});
		setPending(false);
		if (!r.ok) {
			if (r.error === "needs_username") {
				// Engine learned this is a new email after we asked.
				// Reveal the username field and let the user retry.
				setIsNewAccount(true);
				setError("This email is new here. Pick a username to finish creating your account.");
				return;
			}
			setError(verifyErrorMessage(r.error, r.detail));
			return;
		}
		onLoggedIn(r.creds, r.uiaPassword);
	}

	// Cloudflare Turnstile (instance-configurable bot detection).
	// Only relevant on the email step — verify-code is gated by the
	// 6-digit code so it's already self-protected.  When the instance
	// admin hasn't set a site key, the hook is a no-op and the
	// `turnstileToken` stays null; we then still let the email
	// submission through (engine also skips siteverify in that case).
	//
	// Skipped on the desktop shell — Cloudflare can't validate the
	// WebView's `tauri://` / `tauri.localhost` origin so the widget
	// just errors out.  The engine sees an X-Koven-Client header
	// from the desktop fetch and bypasses captcha enforcement on
	// that path; the existing email rate-limit still applies.
	const isDesktop = typeof window !== "undefined"
		&& (window as { __KOVEN_DESKTOP__?: boolean }).__KOVEN_DESKTOP__ === true;
	const turnstileRef = useRef<HTMLDivElement | null>(null);
	const turnstileSiteKey = isDesktop
		? null
		: (instance as { turnstile_site_key?: string }).turnstile_site_key ?? null;
	const turnstileEnabled = !!turnstileSiteKey;
	const turnstile = useTurnstile(turnstileRef, step === "email" ? turnstileSiteKey : null);

	const continueDisabled = pending || (step === "email"
		? !email.trim() || (turnstileEnabled && !turnstile.token)
		: !code.trim() || (isNewAccount && !username.trim()));

	return (
		<div
			className={cn(
				"h-full flex items-center justify-center bg-background bg-cover bg-center relative",
				// Outer breathing room — generous on desktop, snug on
				// phone-sized viewports.  `pt`/`pb` use safe-area-inset
				// so the form clears the iOS notch + home-indicator
				// when the WebView paints under them (viewport-fit=cover).
				"px-4 sm:p-8",
				"pt-[max(env(safe-area-inset-top),1rem)]",
				"pb-[max(env(safe-area-inset-bottom),1rem)]",
				// Force the midnight palette regardless of the user's
				// chosen theme — the brand bg image is tuned for a
				// dark canvas, and the login is the brand handshake
				// every user should see the same way.  Once they're
				// signed in, their theme preference takes over.
				"force-midnight",
			)}
			style={bgUrl ? { backgroundImage: `url(${cssUrl(bgUrl)})` } : undefined}
		>
			{bgUrl && (
				// Two-layer scrim: opaque dark wash + subtle vignette
				// gradient.  Brand image stays visible but text contrast
				// stays readable.
				<>
					<div className="absolute inset-0 bg-black/55" aria-hidden />
					<div
						className="absolute inset-0"
						style={{
							background:
								"radial-gradient(ellipse at center, rgba(0,0,0,0) 0%, rgba(0,0,0,0.35) 75%, rgba(0,0,0,0.6) 100%)",
						}}
						aria-hidden
					/>
				</>
			)}
			<div className="relative w-full max-w-sm space-y-4">
				{addingAccount && onCancelAddAccount && (
					<div className="-mt-2">
						<button
							type="button"
							onClick={onCancelAddAccount}
							className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
						>
							← Back to your other account
						</button>
					</div>
				)}
				<div className="text-center space-y-1 flex flex-col items-center">
					{logoUrl ? (
						<img
							src={logoUrl}
							alt={brandName}
							className="max-h-16 max-w-full object-contain"
						/>
					) : (
						<h1 className="text-2xl font-semibold tracking-tight">{brandName}</h1>
					)}
					{addingAccount && (
						<p className="text-xs text-muted-foreground italic">
							Sign in to add another account
						</p>
					)}
					{tagline ? (
						<p className={cn(
							"text-xs italic",
							// On mobile the brand image is the user's
							// whole canvas so muted-foreground reads
							// faded against it; force white for the
							// tagline.  Desktop keeps muted-foreground
							// because the SPA renders inside a window
							// with framing chrome that gives it consistent
							// contrast.
							isMobileShell ? "text-white" : "text-muted-foreground",
						)}>{tagline}</p>
					) : null}
				</div>

				<div className={cn(
					"rounded-lg overflow-hidden",
					// Desktop keeps the original light-glass effect
					// (`bg-card/30`) because the window-framed crop of
					// the brand image is consistent enough for text to
					// read.  On the mobile shell the same image gets a
					// tighter portrait crop so colorful strips bleed
					// through and contrast jumps from line to line —
					// `bg-card/70` gives a consistent dark floor without
					// losing the blur.
					bgUrl
						? cn(
							"backdrop-blur-xl border border-white/10 shadow-2xl",
							isMobileShell ? "bg-card/70" : "bg-card/30",
						)
						: "bg-card border border-border",
				)}>
					{step === "email" ? (
						<form onSubmit={submitEmail} className="p-5 space-y-3">
							<div className="space-y-1">
								<div className="text-sm font-medium">Sign In/Create Account</div>
								<p className="text-xs text-muted-foreground leading-snug">
									We'll email you a 6-digit code.
								</p>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="login-email">Email</Label>
								<Input
									id="login-email"
									type="email"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									required
									autoComplete="email"
									placeholder="you@example.com"
									autoFocus
								/>
							</div>

							{turnstileEnabled && (
								// Cloudflare's widget renders here once the
								// script loads.  Stays mounted while step ===
								// "email"; the hook unmounts it on step
								// transition so it doesn't keep ticking in
								// the background.
								<div ref={turnstileRef} className="flex justify-center min-h-[65px]" />
							)}

							{error && (
								<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
									{error}
								</div>
							)}

							<Button type="submit" disabled={continueDisabled} className="w-full">
								{pending ? "Sending code…" : "Send code"}
							</Button>
						</form>
					) : (
						<form onSubmit={submitCode} className="p-5 space-y-3">
							<div className="space-y-1">
								<div className="text-sm font-medium">
									{isNewAccount ? "Create your account" : "Enter your sign-in code"}
								</div>
								<p className="text-xs text-muted-foreground leading-snug">
									Code sent to <span className="font-medium text-foreground">{email}</span>.
									{" "}
									<button
										type="button"
										onClick={reset}
										className="underline hover:text-foreground"
									>
										Use a different email
									</button>
								</p>
							</div>

							<div className="space-y-1.5">
								<Label htmlFor="login-code">6-digit code</Label>
								<Input
									id="login-code"
									type="text"
									inputMode="numeric"
									pattern="[0-9]*"
									value={code}
									onChange={(e) => setCode(e.target.value.replace(/\D+/g, "").slice(0, 6))}
									required
									autoComplete="one-time-code"
									placeholder="123456"
									autoFocus
									maxLength={6}
									className="font-mono tracking-[0.4em] text-center"
								/>
							</div>

							{isNewAccount && (
								<div className="space-y-1.5">
									<Label htmlFor="login-username">Pick a username</Label>
									<Input
										id="login-username"
										type="text"
										value={username}
										onChange={(e) => setUsername(
											// Strip anything outside the allowed set on input so the
											// field can't even hold an invalid character.  Same rule
											// as isValidLocalpart, applied as you type.
											e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 21),
										)}
										required
										autoComplete="off"
										placeholder="pick-a-username"
										maxLength={21}
									/>
									<p className="text-[10px] text-muted-foreground leading-snug">
										Lowercase letters, numbers, and hyphens only, up to 21 characters. This becomes part of your address: <span className="font-mono">@username:{deriveServerName()}</span>
									</p>
								</div>
							)}

							{info && !error && (
								<div className="text-xs text-muted-foreground border border-border bg-muted/40 rounded px-3 py-2 leading-snug">
									{info}
								</div>
							)}
							{error && (
								<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
									{error}
								</div>
							)}

							<Button type="submit" disabled={continueDisabled} className="w-full">
								{pending
									? (isNewAccount ? "Creating account…" : "Signing in…")
									: (isNewAccount ? "Create account" : "Sign in")}
							</Button>
						</form>
					)}
				</div>
			</div>

			{/* Koven attribution footer — desktop only.  Mobile drops
			    it entirely: iOS 26.x ignores manifest `theme_color`
			    + meta tag for the home-indicator safe-area zone,
			    so any coloured footer here would just leave a
			    black system strip below it that reads worse than
			    no footer at all.  When Apple fixes the regression
			    we can put the footer back. */}
			{!isMobileShell && (
				<p className={cn(
					"absolute bottom-4 left-0 right-0 text-center text-[11px] tracking-wide",
					bgUrl ? "text-white/70" : "text-muted-foreground",
				)}>
					Chat powered by{" "}
					<a
						href="https://koven.chat"
						target="_blank"
						rel="noopener noreferrer"
						className="font-medium hover:underline underline-offset-2"
					>
						Koven
					</a>
				</p>
			)}
		</div>
	);
}

function cssUrl(u: string): string {
	return `'${u.replace(/'/g, "\\'")}'`;
}

// Tighter than Matrix's full localpart spec — see engine/src/server.ts
// for rationale.  Lowercase letters, digits, and hyphens only, max 21.
function isValidLocalpart(s: string): boolean {
	return s.length >= 1 && s.length <= 21 && /^[a-z0-9-]+$/.test(s);
}

// Best-effort homeserver-name extract for the username preview.  We
// don't want to depend on the engine for this; it's just a UI hint.
// Strips protocol + port, picks the host portion.
function deriveServerName(): string {
	try {
		const u = new URL(HOMESERVER_URL);
		return u.hostname || "koven";
	} catch {
		return "koven";
	}
}

function requestErrorMessage(err: RequestCodeError): string {
	switch (err) {
		case "invalid_email":     return "That doesn't look like a valid email address.";
		case "rate_limited":      return "Too many codes requested. Wait an hour and try again.";
		case "email_disabled":    return "Email sign-in isn't configured on this instance. Ask the operator to set RESEND_API_KEY.";
		case "send_failed":       return "Couldn't deliver the email. Try again, or use a different address.";
		case "captcha_required":  return "Bot-detection challenge didn't load. Refresh and try again.";
		case "captcha_failed":    return "Bot-detection challenge failed. Try again — the widget should reset automatically.";
		case "network":           return "Can't reach the server. Check your connection and try again.";
		default:                  return "Something went wrong sending your code.";
	}
}

function verifyErrorMessage(err: VerifyCodeError, detail?: string): string {
	switch (err) {
		case "invalid_request":     return "Couldn't read your submission. Try again.";
		case "no_active_code":      return "Code expired or never issued. Request a fresh one.";
		case "wrong_code":          return "That code doesn't match. Check your email and try again.";
		case "too_many_attempts":   return "Too many wrong attempts on that code. Request a fresh one.";
		case "invalid_username":    return "Username can only contain lowercase letters, numbers, and hyphens.";
		case "username_unavailable":return "That username is taken. Pick another.";
		case "password_rotate_failed":
			// Engine retried once already.  When `detail` is set the
			// failure was Synapse-specific (admin token revoked,
			// account state inconsistency, etc.) — surface it so
			// the user has something to escalate with rather than
			// a generic "try again" they've already tried.
			return detail
				? `Sign-in blocked at the homeserver: ${detail}`
				: "Server hiccup minting your session. Try again in a moment.";
		case "synapse_error":
			// Detail is the engine's verbatim Synapse error (status
			// code + errcode + body).  Long, but truthful — far better
			// than a generic "try again" when the actual blocker is
			// "admin token revoked" or "Synapse 502 from upstream."
			return detail
				? `Sign-in blocked at the homeserver: ${detail}`
				: "Server error completing sign-in.";
		case "network":             return "Can't reach the server. Check your connection and try again.";
		default:                    return detail ?? "Sign-in failed.";
	}
}

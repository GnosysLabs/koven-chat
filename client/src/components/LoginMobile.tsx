// Native iOS login screen.  Rendered by Login.tsx when
// `isMobileShell` is true.  Same auth flow as the desktop path
// (email → 6-digit code → optional username on first sign-in),
// laid out per Apple's Human Interface Guidelines:
//
//   - 34pt Large Title heading; 17pt secondary body underneath.
//   - 52pt-tall form fields with iOS-style rounded fill (no border,
//     subtle white-on-dark wash) — meets the 44pt touch-target floor
//     with comfortable headroom.
//   - 52pt capsule primary button tinted iOS system blue (#0A84FF).
//     Sits at the bottom of the column so it lands within thumb
//     reach on every iPhone size.
//   - Generous 24/32pt vertical rhythm; safe-area insets respected
//     on top + bottom so the form clears the Dynamic Island and home
//     indicator.
//   - Notification haptic on sign-in success / verify failure —
//     iOS users have learned to expect tactile confirmation for
//     outcome-level events.
//
// The brand wallpaper (login-bg-mobile.png) and wordmark stay so the
// surface still reads as Koven, but the scrim is darker than the
// desktop path: Large Title typography needs a higher-contrast floor
// to stay readable across the photo's bright + dark patches.
//
// Auth-flow code is duplicated from Login.tsx rather than extracted
// to a shared hook.  Reason: a hook refactor would touch the desktop
// path, and the directive for this change was explicit that desktop
// behaviour stays byte-for-byte identical.  The duplicated block is
// small and the auth API has been stable for a while; if it churns
// we can DRY it up then.

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { isNativeShell } from "@/lib/nativeShell";
import { hapticImpact, hapticNotification } from "@/lib/haptics";
import { fetchInstanceConfig, resolveAssetUrl, type InstanceConfig } from "@/lib/instance";
import {
	requestEmailCode,
	verifyEmailCode,
	type RequestCodeError,
	type VerifyCodeError,
} from "@/lib/auth";
import { HOMESERVER_URL } from "@/lib/urls";
import { useTurnstile } from "@/lib/turnstile";
import type { MatrixCredentials } from "@/lib/matrix";

export interface LoginMobileProps {
	onLoggedIn(creds: MatrixCredentials, uiaPassword: string): void;
	addingAccount?: boolean;
	onCancelAddAccount?(): void;
}

type Step = "email" | "code";

// iOS system blue, dark-mode variant.  Hardcoded rather than mapped
// through the theme tokens because:
//   1. The login is locked to `force-midnight` and shouldn't pick
//      up any user theme,
//   2. The HIG explicitly calls for the system-blue accent on
//      neutral surfaces — Koven's brand doesn't yet define an
//      accent of its own.
const IOS_BLUE = "#0A84FF";
const IOS_BLUE_PRESSED = "#0974DC";

export function LoginMobile({ onLoggedIn, addingAccount, onCancelAddAccount }: LoginMobileProps) {
	const [step, setStep] = useState<Step>("email");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [username, setUsername] = useState("");
	const [isNewAccount, setIsNewAccount] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [info, setInfo] = useState<string | null>(null);
	const [instance, setInstance] = useState<InstanceConfig>({});

	// Paint the document root the same flat near-black as the iOS
	// safe-area zones.  Without this the WebView shows its own
	// background during the keyboard slide-in animation, which
	// flashes against the dark login canvas.  Cleared on unmount so
	// the rest of the SPA gets its normal theme background back.
	useEffect(() => {
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
		fetchInstanceConfig().then(setInstance).catch(() => setInstance({}));
	}, []);

	const brandName = instance.name?.trim() || "Koven";
	const tagline = instance.login_tagline?.trim();
	// Prefer the locally-bundled wordmark in native shells so the
	// splash → login transition doesn't flash a missing image while
	// the server logo loads.
	const inNativeShell = isNativeShell();
	const logoUrl = inNativeShell
		? "/koven-wordmark.png"
		: resolveAssetUrl(instance.logo_url);

	function reset() {
		void hapticImpact("light");
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
		void hapticImpact("medium");
		const r = await requestEmailCode(trimmed, { turnstileToken: turnstile.token });
		setPending(false);
		if (!r.ok) {
			if (r.error === "captcha_failed" || r.error === "captcha_required") {
				turnstile.reset();
			}
			void hapticNotification("error");
			setError(requestErrorMessage(r.error));
			return;
		}
		setIsNewAccount(r.isNewAccount);
		setInfo(r.isNewAccount
			? "Check your inbox for a 6-digit code, then pick a username to finish creating your account."
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
		void hapticImpact("medium");
		const r = await verifyEmailCode({
			email: email.trim().toLowerCase(),
			code: trimmedCode,
			username: isNewAccount ? trimmedUser : undefined,
			homeserver: HOMESERVER_URL,
		});
		setPending(false);
		if (!r.ok) {
			if (r.error === "needs_username") {
				setIsNewAccount(true);
				setError("This email is new here. Pick a username to finish creating your account.");
				void hapticNotification("warning");
				return;
			}
			void hapticNotification("error");
			setError(verifyErrorMessage(r.error, r.detail));
			return;
		}
		void hapticNotification("success");
		onLoggedIn(r.creds, r.uiaPassword);
	}

	// Turnstile — same bypass rules as desktop Login.tsx, expanded to
	// include native mobile shells.  Cloudflare can't validate the
	// Capacitor WebView's `capacitor://` origin any more than it can
	// validate Tauri's, so the widget would just error out.  The
	// engine reads an X-Koven-Client header set by every native
	// shell's fetch path and skips captcha enforcement; the email
	// rate-limit still applies.  Dev builds (`import.meta.env.DEV`)
	// bypass too because the live engine's site key is bound to
	// client.koven.chat and won't render on http://localhost.
	const isDev = import.meta.env.DEV;
	const turnstileRef = useRef<HTMLDivElement | null>(null);
	const turnstileSiteKey = (inNativeShell || isDev)
		? null
		: (instance as { turnstile_site_key?: string }).turnstile_site_key ?? null;
	const turnstileEnabled = !!turnstileSiteKey;
	const turnstile = useTurnstile(turnstileRef, step === "email" ? turnstileSiteKey : null);

	const continueDisabled = pending || (step === "email"
		? !email.trim() || (turnstileEnabled && !turnstile.token)
		: !code.trim() || (isNewAccount && !username.trim()));

	const heading = step === "email"
		? (addingAccount ? "Add an account" : "Welcome")
		: (isNewAccount ? "Create your account" : "Check your email");

	const subheading = step === "email"
		? (addingAccount
			? "Sign in to add another Koven account on this device."
			: "Sign in or create an account with your email. We'll send you a 6-digit code.")
		: isNewAccount
			? "Enter the code we sent and pick a username."
			: "Enter the 6-digit code we just sent you.";

	return (
		// `position: fixed; inset: 0` anchors the surface against the
		// layout viewport — which on iOS Capacitor + `viewport-fit=cover`
		// includes the status-bar and home-indicator zones.  A plain
		// `h-full` would stop at the SPA root's bounds, which the
		// `@media (display-mode: standalone)` block in index.css only
		// extends edge-to-edge in PWA mode (Capacitor's WKWebView
		// doesn't always match that media query).  Fixed positioning
		// reaches all four screen edges in every shell.
		<div className="force-midnight fixed inset-0 bg-background overflow-hidden">
			{/* Brand wallpaper.  Native shells ship the asset in the
			    bundle so there's no network flash; browsers on mobile
			    fall back to the flat canvas (no bgUrl). */}
			{inNativeShell && (
				<div
					className="absolute inset-0 bg-cover bg-center"
					style={{ backgroundImage: "url(/login-bg-mobile.png)" }}
					aria-hidden
				/>
			)}
			{/* Scrim — deeper than desktop.  iOS Large Title (34pt) and
			    17pt body need a high-contrast floor across the photo's
			    bright + dark patches; the desktop's 35% wash is too
			    thin for typography this size. */}
			{inNativeShell && (
				<>
					<div className="absolute inset-0 bg-black/65" aria-hidden />
					<div
						className="absolute inset-0"
						style={{
							background:
								"linear-gradient(to bottom, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 70%, rgba(0,0,0,0.55) 100%)",
						}}
						aria-hidden
					/>
				</>
			)}

			{/* Scrollable content column.  Single column, top-aligned,
			    primary action lives at the natural bottom of the form
			    so it sits in thumb reach on every iPhone size. */}
			<div className="relative h-full overflow-y-auto">
				<div
					className="flex flex-col min-h-full px-6"
					style={{
						paddingTop: "max(env(safe-area-inset-top), 0.5rem)",
						paddingBottom: "max(env(safe-area-inset-bottom), 1rem)",
					}}
				>
					{/* Nav slot — back chevron only when adding a second
					    account so users can bail out of the flow. */}
					<div className="h-10 flex items-center">
						{addingAccount && onCancelAddAccount && (
							<button
								type="button"
								onClick={() => { void hapticImpact("light"); onCancelAddAccount(); }}
								className="-ml-2 flex items-center gap-0.5 px-2 py-2 text-[15px] text-white/85 active:text-white/60"
							>
								<ArrowLeft className="size-[18px]" strokeWidth={2.25} />
								<span className="ml-0.5">Back</span>
							</button>
						)}
					</div>

					{/* Wordmark — compact mark up top, leaves the visual
					    weight for the Large Title.  iOS apps put the
					    brand in the nav-bar area, not centered hero-style. */}
					<div className="pt-2 pb-1 flex items-center justify-center">
						{logoUrl ? (
							<img
								src={logoUrl}
								alt={brandName}
								className="h-10 max-w-[55%] object-contain opacity-95"
							/>
						) : (
							<span className="text-[17px] font-semibold tracking-tight text-white">{brandName}</span>
						)}
					</div>

					{/* Title block.  34pt Bold matches `.largeTitle` in
					    UIKit/SwiftUI.  Tracking tightened slightly per
					    SF Pro at large sizes. */}
					<div className="pt-12 space-y-2">
						<h1 className="text-[34px] font-bold tracking-[-0.022em] leading-[1.1] text-white">
							{heading}
						</h1>
						<p className="text-[17px] leading-[1.35] text-white/70">
							{step === "code" ? (
								<>
									{subheading}{" "}
									<span className="text-white">{email}</span>
								</>
							) : subheading}
						</p>
						{tagline && step === "email" && !addingAccount && (
							<p className="pt-1 text-[15px] italic text-white/55">{tagline}</p>
						)}
					</div>

					{/* Form column.  flex-1 spacer + bottom-anchored
					    button means the primary action stays near the
					    keyboard / safe-area edge regardless of how many
					    fields are showing. */}
					<form
						onSubmit={step === "email" ? submitEmail : submitCode}
						className="pt-8 pb-2 flex-1 flex flex-col"
					>
						{step === "email" ? (
							<IosField
								type="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								required
								autoComplete="email"
								placeholder="you@example.com"
								autoFocus
								inputMode="email"
								autoCapitalize="none"
								autoCorrect="off"
								spellCheck={false}
								enterKeyHint="send"
								aria-label="Email"
							/>
						) : (
							<div className="space-y-3">
								<IosField
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
									enterKeyHint={isNewAccount ? "next" : "go"}
									aria-label="6-digit verification code"
									// Monospaced + wide tracking so a 6-digit code
									// reads as discrete characters even without
									// per-digit cells.  Bigger than the default
									// 17pt for the same reason — emphasizes the
									// code as the focal input.
									className="font-mono tracking-[0.45em] text-center text-[22px]"
								/>
								{isNewAccount && (
									<div className="space-y-1.5">
										<label className="block text-[13px] uppercase tracking-wider text-white/55 font-medium px-1">
											Username
										</label>
										<IosField
											type="text"
											value={username}
											onChange={(e) => setUsername(
												e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 21),
											)}
											required
											autoComplete="off"
											placeholder="pick-a-username"
											maxLength={21}
											autoCapitalize="none"
											autoCorrect="off"
											spellCheck={false}
											enterKeyHint="go"
											aria-label="Username"
										/>
										<p className="px-1 text-[12px] leading-snug text-white/55">
											Lowercase letters, numbers, and hyphens. This becomes part of your address:{" "}
											<span className="font-mono text-white/75">@{username || "username"}:{deriveServerName()}</span>
										</p>
									</div>
								)}
								<button
									type="button"
									onClick={reset}
									className="block text-[15px] text-[#5AC8FA] active:opacity-60 py-1.5 px-0.5"
								>
									Use a different email
								</button>
							</div>
						)}

						{turnstileEnabled && step === "email" && (
							<div ref={turnstileRef} className="mt-4 flex justify-center min-h-[65px]" />
						)}

						{/* Status banner.  Errors get red wash + icon;
						    info gets a quieter neutral wash.  Rounded-2xl
						    matches iOS alert / card radii. */}
						{(error || (info && !error)) && (
							<div className={cn(
								"mt-4 flex items-start gap-2 px-3.5 py-3 rounded-2xl text-[14px] leading-snug",
								error
									? "bg-red-500/[0.14] text-red-200 border border-red-500/30"
									: "bg-white/[0.08] text-white/85 border border-white/10",
							)}>
								{error && <AlertCircle className="size-[16px] shrink-0 mt-px text-red-300" strokeWidth={2.25} />}
								<span>{error ?? info}</span>
							</div>
						)}

						{/* Spacer pushes button toward bottom on tall
						    viewports; collapses to zero on short ones
						    (keyboard up) so the button stays directly
						    below the field. */}
						<div className="flex-1 min-h-[24px]" />

						<IosPrimaryButton type="submit" disabled={continueDisabled} loading={pending}>
							{step === "email"
								? (pending ? "Sending code…" : "Continue")
								: pending
									? (isNewAccount ? "Creating account…" : "Signing in…")
									: (isNewAccount ? "Create Account" : "Sign In")}
						</IosPrimaryButton>
					</form>
				</div>
			</div>
		</div>
	);
}

// ── Native-feel form field ────────────────────────────────────────
//
// 52pt height, 17pt text, rounded-2xl filled wash (no border).  This
// is the standard iOS "single-line text field on a dark surface"
// look — Apple ID, App Store, Wallet all use a variation of it.
//
// We deliberately don't wire `:focus` ring colours: iOS form fields
// don't show a focus ring (the keyboard appearing is the focus
// affordance).  We do bump the wash brightness slightly so a
// focused field still reads as "active" for sighted users without
// the keyboard up (e.g. on hardware-keyboard iPads).

type IosFieldProps = React.InputHTMLAttributes<HTMLInputElement>;

function IosField({ className, ...rest }: IosFieldProps) {
	return (
		<input
			{...rest}
			className={cn(
				"w-full h-[52px] px-4 rounded-2xl",
				"bg-white/[0.08] focus:bg-white/[0.12]",
				"text-white text-[17px] leading-none",
				"placeholder:text-white/40",
				"outline-none border-0 ring-0 focus:outline-none focus:ring-0",
				// Subtle inset shadow gives the field a recessed
				// feel against the wallpaper — matches iOS's depth
				// language without a hard border line.
				"shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]",
				"transition-colors duration-150",
				"appearance-none",
				className,
			)}
		/>
	);
}

// ── Primary action button ─────────────────────────────────────────
//
// 52pt capsule.  iOS system blue with active-state darken on press
// (no hover state — mobile is touch-first, hover is a desktop
// affordance that doesn't apply).  Loading shows the same label
// with a subtle inline spinner so the button width doesn't jump.

interface IosPrimaryButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	loading?: boolean;
}

function IosPrimaryButton({ children, loading, disabled, className, style, ...rest }: IosPrimaryButtonProps) {
	return (
		<button
			{...rest}
			disabled={disabled}
			className={cn(
				"w-full h-[52px] rounded-2xl",
				"text-white text-[17px] font-semibold tracking-tight",
				"flex items-center justify-center gap-2",
				"transition-[background-color,opacity,transform] duration-150",
				"active:scale-[0.985]",
				disabled ? "opacity-40" : "opacity-100",
				className,
			)}
			style={{
				backgroundColor: disabled ? IOS_BLUE_PRESSED : IOS_BLUE,
				...style,
			}}
		>
			{loading && (
				<span
					aria-hidden
					className="inline-block size-[16px] rounded-full border-2 border-white/30 border-t-white animate-spin"
				/>
			)}
			<span>{children}</span>
		</button>
	);
}

// Same validators as the desktop path — kept local to avoid pulling
// in a new shared module just to share one regex.
function isValidLocalpart(s: string): boolean {
	return s.length >= 1 && s.length <= 21 && /^[a-z0-9-]+$/.test(s);
}

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
		case "email_disabled":    return "Email sign-in isn't configured on this instance.";
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
			return detail
				? `Sign-in blocked at the homeserver: ${detail}`
				: "Server hiccup minting your session. Try again in a moment.";
		case "synapse_error":
			return detail
				? `Sign-in blocked at the homeserver: ${detail}`
				: "Server error completing sign-in.";
		case "network":             return "Can't reach the server. Check your connection and try again.";
		default:                    return detail ?? "Sign-in failed.";
	}
}

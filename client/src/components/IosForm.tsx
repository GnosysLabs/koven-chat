// Shared iOS-HIG form controls used by the mobile pre-auth screens
// (LoginMobile, EncryptionUnlockMobile, EncryptionSetupMobile, etc.).
// These are mobile-only by intent — desktop surfaces stick with the
// shadcn `Button` / `Input` so they don't get tugged into iOS shapes
// that look out of place inside a window-framed app.
//
// HIG calibration in this file:
//   - 52pt height for fields and primary buttons (44pt min target + comfort)
//   - 17pt body text, 13pt section headers
//   - rounded-2xl ≈ iOS continuous-corner radius
//   - iOS system blue for primary action, system red for destructive
//   - No focus rings: iOS form fields don't draw them (the keyboard
//     itself is the focus affordance).  We bump the field-fill brightness
//     instead so the field still reads as "active" sans-keyboard.

import { useEffect } from "react";
import { cn } from "@/lib/utils";

// Hardcoded iOS palette.  Pre-auth surfaces force `force-midnight`
// regardless of the user's theme, so theme tokens don't apply here —
// hardcoding keeps the colors honest to the iOS reference rather than
// the brand palette.
const IOS_BLUE = "#0A84FF";
const IOS_BLUE_PRESSED = "#0974DC";
const IOS_RED = "#FF453A";
const IOS_TEAL = "#5AC8FA";

// ── Native-feel form field ────────────────────────────────────────
//
// 52pt height, 17pt text, rounded-2xl filled wash on dark.  No border;
// a subtle inset shadow gives the field a recessed feel against the
// brand wallpaper.  Mirrors what Apple ID / App Store / Wallet use
// for single-line dark-background text input.

type IosFieldProps = React.InputHTMLAttributes<HTMLInputElement>;

export function IosField({ className, ...rest }: IosFieldProps) {
	return (
		<input
			{...rest}
			className={cn(
				"w-full h-[52px] px-4 rounded-2xl",
				"bg-white/[0.08] focus:bg-white/[0.12]",
				"text-white text-[17px] leading-none",
				"placeholder:text-white/40",
				"outline-none border-0 ring-0 focus:outline-none focus:ring-0",
				"shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]",
				"transition-colors duration-150",
				"appearance-none",
				className,
			)}
		/>
	);
}

// ── Field section label ───────────────────────────────────────────
//
// 13pt uppercase tracking-wide, secondary text colour.  Use sparingly
// — the iOS pattern is to skip section labels when a placeholder
// makes the field's purpose obvious, and only label when grouping
// multiple fields or clarifying ambiguous ones.

export function IosFieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
	return (
		<label
			htmlFor={htmlFor}
			className="block text-[13px] uppercase tracking-wider text-white/55 font-medium px-1"
		>
			{children}
		</label>
	);
}

// ── Primary action button ─────────────────────────────────────────
//
// 52pt capsule, iOS system blue, 17pt semibold label.  Loading shows
// an inline spinner without resizing the button (label stays so the
// click target doesn't shift mid-flight).

interface IosPrimaryButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	loading?: boolean;
}

export function IosPrimaryButton({
	children,
	loading,
	disabled,
	className,
	style,
	...rest
}: IosPrimaryButtonProps) {
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

// ── Secondary outlined button ─────────────────────────────────────
//
// Same height as primary but transparent fill with a subtle border.
// Used for paired alternatives (Copy / Download) or step-back actions
// that aren't destructive.

export function IosSecondaryButton({
	children,
	className,
	...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			{...rest}
			className={cn(
				"w-full h-[52px] rounded-2xl",
				"text-white text-[17px] font-medium",
				"flex items-center justify-center gap-2",
				"bg-white/[0.10] hover:bg-white/[0.14] active:bg-white/[0.18]",
				"transition-colors duration-150",
				"active:scale-[0.985]",
				className,
			)}
		>
			{children}
		</button>
	);
}

// ── Inline text button ────────────────────────────────────────────
//
// For tertiary navigation ("Use a different email", "Sign out
// instead").  No background, system tint colour, no fixed height —
// renders as inline text the user reads as a link.  `tone="destructive"`
// flips it to system red for sign-out / abandon flows.

export function IosTextButton({
	children,
	tone = "default",
	className,
	...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "destructive" }) {
	return (
		<button
			type="button"
			{...rest}
			className={cn(
				"text-[15px] py-2 px-1 active:opacity-60 transition-opacity",
				className,
			)}
			style={{ color: tone === "destructive" ? IOS_RED : IOS_TEAL }}
		>
			{children}
		</button>
	);
}

// ── Status banner ─────────────────────────────────────────────────
//
// iOS-styled error / info container.  Red tint with leading icon for
// errors; neutral tint for info.  Rounded-2xl matches alert / card
// radii throughout the system.

export function IosStatusBanner({
	tone,
	icon,
	children,
}: {
	tone: "error" | "info";
	icon?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex items-start gap-2 px-3.5 py-3 rounded-2xl text-[14px] leading-snug",
				tone === "error"
					? "bg-red-500/[0.14] text-red-200 border border-red-500/30"
					: "bg-white/[0.08] text-white/85 border border-white/10",
			)}
		>
			{icon && <span className="shrink-0 mt-px">{icon}</span>}
			<span>{children}</span>
		</div>
	);
}

// ── Native-feel surface wrapper ───────────────────────────────────
//
// The full-screen brand canvas every mobile pre-auth screen sits on:
// brand wallpaper (native shells only), darker-than-desktop scrim for
// Large Title legibility, vertical gradient corners.  Inner content
// gets safe-area padding via the wrapper's flex column.  Children
// render inside the relative-positioned content layer so they sit
// above the scrim without each one needing to redeclare it.

export function IosBrandSurface({
	showWallpaper,
	children,
}: {
	showWallpaper: boolean;
	children: React.ReactNode;
}) {
	// Paint the document root the same flat near-black as the iOS
	// safe-area zones for the lifetime of this surface.  Without it
	// the WebView shows its own background during the keyboard slide-
	// in animation, flashing against the dark canvas.  Cleared on
	// unmount so the rest of the SPA gets its normal theme bg back.
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

	return (
		// `position: fixed; inset: 0` anchors against the layout
		// viewport so the surface reaches into the status-bar and
		// home-indicator safe-area zones.  Without this, an `h-full`
		// would stop at the SPA root's bounds.
		<div className="force-midnight fixed inset-0 bg-background overflow-hidden">
			{showWallpaper && (
				<>
					<div
						className="absolute inset-0 bg-cover bg-center"
						style={{ backgroundImage: "url(/login-bg-mobile.png)" }}
						aria-hidden
					/>
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
			<div className="relative h-full overflow-y-auto">
				{children}
			</div>
		</div>
	);
}

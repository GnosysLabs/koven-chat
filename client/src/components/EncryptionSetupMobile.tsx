// iOS HIG version of the one-time encryption-setup flow.  Shown
// immediately after a fresh sign-up on the iOS shell, blocking the
// app until the user finishes setup or signs out.
//
// Same brand canvas as LoginMobile / ConnectingMobile / Unlock so the
// post-sign-up sequence reads as one continuous Koven flow.
//
// Two steps:
//   1. Passphrase — pick + confirm a passphrase that protects the
//      user's direct messages.  Engine doesn't see this; PBKDF2 in
//      the WebView derives the SSSS key.
//   2. Recovery key — display the 48-char base58 fallback once, with
//      Copy / Download actions and an explicit "I've saved it"
//      checkbox.  The checkbox gate exists because losing both the
//      passphrase and this key irrecoverably loses the user's
//      encrypted history.
//
// Non-dismissible by design — same reasoning as EncryptionUnlock.

import { useState } from "react";
import { AlertCircle, Check, Copy, Download, Lock, Shield } from "lucide-react";
import { isNativeShell } from "@/lib/nativeShell";
import { hapticImpact, hapticNotification, hapticSelection } from "@/lib/haptics";
import {
	IosBrandSurface,
	IosField,
	IosFieldLabel,
	IosPrimaryButton,
	IosSecondaryButton,
	IosStatusBanner,
	IosTextButton,
} from "@/components/IosForm";

export interface EncryptionSetupMobileProps {
	onSetup(passphrase: string): Promise<string>;
	onComplete(): void;
	onSignOut(): void;
}

type Step = "passphrase" | "recovery";

export function EncryptionSetupMobile({ onSetup, onComplete, onSignOut }: EncryptionSetupMobileProps) {
	const inNativeShell = isNativeShell();
	const [step, setStep] = useState<Step>("passphrase");
	const [passphrase, setPassphrase] = useState("");
	const [confirm, setConfirm] = useState("");
	const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedAck, setSavedAck] = useState(false);
	const [copyHint, setCopyHint] = useState<"copied" | "saved" | null>(null);

	async function submitPassphrase(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (passphrase.length < 8) {
			setError("Encryption passphrase must be at least 8 characters.");
			void hapticNotification("warning");
			return;
		}
		if (passphrase !== confirm) {
			setError("Encryption passphrases don't match.");
			void hapticNotification("warning");
			return;
		}
		setPending(true);
		void hapticImpact("medium");
		try {
			const key = await onSetup(passphrase);
			setRecoveryKey(key);
			setStep("recovery");
			void hapticNotification("success");
		} catch (err) {
			void hapticNotification("error");
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	function copyRecoveryKey() {
		if (!recoveryKey) return;
		navigator.clipboard.writeText(recoveryKey).then(() => {
			void hapticImpact("light");
			setCopyHint("copied");
			setTimeout(() => setCopyHint((h) => (h === "copied" ? null : h)), 2500);
		}).catch(() => {/* clipboard denied */});
	}

	function downloadRecoveryKey() {
		if (!recoveryKey) return;
		// `data:` URL rather than `blob:` because WKWebView (macOS
		// Tauri AND iOS Capacitor) silently drops anchor downloads
		// pointed at blob: URLs — the click registers, nothing lands.
		// data: URLs work in every WebView backend.  Recovery keys
		// are ~50 chars so the data-URL size limit is irrelevant.
		const text = recoveryKey + "\n";
		const dataUrl = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
		const a = document.createElement("a");
		a.href = dataUrl;
		a.download = "koven-recovery-key.txt";
		document.body.appendChild(a);
		a.click();
		a.remove();
		void hapticImpact("light");
		setCopyHint("saved");
		setTimeout(() => setCopyHint((h) => (h === "saved" ? null : h)), 2500);
	}

	function toggleAck() {
		setSavedAck((v) => {
			void hapticSelection();
			return !v;
		});
	}

	return (
		<IosBrandSurface showWallpaper={inNativeShell}>
			<div
				className="flex flex-col min-h-full px-6"
				style={{
					paddingTop: "max(env(safe-area-inset-top), 0.5rem)",
					// Fold the live keyboard height into the bottom
					// padding so the primary button (anchored at the
					// column's bottom) stays above the keyboard.
					// `--keyboard-inset` is 0 when the keyboard is
					// down, so this reduces to the safe-area inset.
					paddingBottom: "max(env(safe-area-inset-bottom), 1rem, calc(var(--keyboard-inset, 0px) + 0.5rem))",
					transition: "padding-bottom 0.25s ease-out",
				}}
			>
				<div className="h-10" />

				<div className="pt-2 pb-1 flex items-center justify-center">
					{inNativeShell ? (
						<img
							src="/koven-wordmark.png"
							alt="Koven"
							className="h-10 max-w-[55%] object-contain opacity-95"
						/>
					) : (
						<span className="text-[17px] font-semibold tracking-tight text-white">Koven</span>
					)}
				</div>

				{step === "passphrase" ? (
					<PassphraseStep
						passphrase={passphrase}
						setPassphrase={setPassphrase}
						confirm={confirm}
						setConfirm={setConfirm}
						pending={pending}
						error={error}
						onSubmit={submitPassphrase}
						onSignOut={onSignOut}
					/>
				) : (
					<RecoveryStep
						recoveryKey={recoveryKey ?? ""}
						savedAck={savedAck}
						onToggleAck={toggleAck}
						onCopy={copyRecoveryKey}
						onDownload={downloadRecoveryKey}
						onComplete={onComplete}
						copyHint={copyHint}
					/>
				)}
			</div>
		</IosBrandSurface>
	);
}

// ── Step 1: passphrase + confirm ──────────────────────────────────

interface PassphraseStepProps {
	passphrase: string;
	setPassphrase: (s: string) => void;
	confirm: string;
	setConfirm: (s: string) => void;
	pending: boolean;
	error: string | null;
	onSubmit: (e: React.FormEvent) => void;
	onSignOut: () => void;
}

function PassphraseStep({
	passphrase,
	setPassphrase,
	confirm,
	setConfirm,
	pending,
	error,
	onSubmit,
	onSignOut,
}: PassphraseStepProps) {
	return (
		<>
			<div className="pt-12 space-y-2">
				<div className="flex items-center gap-2 pb-1">
					<Lock className="size-[20px] text-white/75" strokeWidth={2.25} />
					<span className="text-[13px] uppercase tracking-wider text-white/55 font-medium">
						End-to-end encryption
					</span>
				</div>
				<h1 className="text-[34px] font-bold tracking-[-0.022em] leading-[1.1] text-white">
					Protect your messages
				</h1>
				<p className="text-[17px] leading-[1.35] text-white/70">
					Pick a passphrase that locks your direct messages. Only you ever see it —
					not Koven, not the server.
				</p>
			</div>

			<form onSubmit={onSubmit} className="pt-8 pb-2 flex-1 flex flex-col">
				<div className="space-y-4">
					<div className="space-y-1.5">
						<IosFieldLabel htmlFor="enc-passphrase">Passphrase</IosFieldLabel>
						<IosField
							id="enc-passphrase"
							type="password"
							value={passphrase}
							onChange={(e) => setPassphrase(e.target.value)}
							placeholder="At least 8 characters"
							autoComplete="new-password"
							autoFocus
							enterKeyHint="next"
							aria-label="Encryption passphrase"
						/>
					</div>
					<div className="space-y-1.5">
						<IosFieldLabel htmlFor="enc-confirm">Confirm passphrase</IosFieldLabel>
						<IosField
							id="enc-confirm"
							type="password"
							value={confirm}
							onChange={(e) => setConfirm(e.target.value)}
							autoComplete="new-password"
							enterKeyHint="go"
							aria-label="Confirm encryption passphrase"
						/>
					</div>
					<p className="px-1 text-[13px] leading-snug text-white/55">
						If you forget it, you'll need the recovery key we generate next. Without
						either, your encrypted message history is gone.
					</p>
				</div>

				{error && (
					<div className="mt-4">
						<IosStatusBanner
							tone="error"
							icon={<AlertCircle className="size-[16px] text-red-300" strokeWidth={2.25} />}
						>
							{error}
						</IosStatusBanner>
					</div>
				)}

				<div className="flex-1 min-h-[24px]" />

				<IosPrimaryButton
					type="submit"
					disabled={pending || !passphrase || !confirm}
					loading={pending}
				>
					{pending ? "Setting up…" : "Continue"}
				</IosPrimaryButton>

				<div className="pt-3 flex justify-center">
					<IosTextButton tone="destructive" onClick={onSignOut}>
						Sign out instead
					</IosTextButton>
				</div>
			</form>
		</>
	);
}

// ── Step 2: recovery key display + acknowledgment ─────────────────

interface RecoveryStepProps {
	recoveryKey: string;
	savedAck: boolean;
	onToggleAck: () => void;
	onCopy: () => void;
	onDownload: () => void;
	onComplete: () => void;
	copyHint: "copied" | "saved" | null;
}

function RecoveryStep({
	recoveryKey,
	savedAck,
	onToggleAck,
	onCopy,
	onDownload,
	onComplete,
	copyHint,
}: RecoveryStepProps) {
	return (
		<>
			<div className="pt-12 space-y-2">
				<div className="flex items-center gap-2 pb-1">
					<Shield className="size-[20px] text-white/75" strokeWidth={2.25} />
					<span className="text-[13px] uppercase tracking-wider text-white/55 font-medium">
						Recovery key
					</span>
				</div>
				<h1 className="text-[34px] font-bold tracking-[-0.022em] leading-[1.1] text-white">
					Save this key
				</h1>
				<p className="text-[17px] leading-[1.35] text-white/70">
					Your recovery key gets you back in if you ever forget your passphrase or
					sign in on a new device.
				</p>
			</div>

			<div className="pt-8 pb-2 flex-1 flex flex-col">
				{/* Recovery key chip.  Larger monospace + select-all so a
				    long-press on iOS pops the system Copy menu.  Tinted
				    container reads as a "credential" — visually distinct
				    from regular text. */}
				<div className="rounded-2xl bg-white/[0.08] border border-white/10 p-4">
					<p className="font-mono text-[16px] leading-[1.5] tracking-[0.04em] text-white break-all select-all">
						{recoveryKey}
					</p>
				</div>

				<div className="pt-3 grid grid-cols-2 gap-3">
					<IosSecondaryButton type="button" onClick={onCopy}>
						{copyHint === "copied" ? (
							<><Check className="size-[16px]" /> Copied</>
						) : (
							<><Copy className="size-[16px]" /> Copy</>
						)}
					</IosSecondaryButton>
					<IosSecondaryButton type="button" onClick={onDownload}>
						{copyHint === "saved" ? (
							<><Check className="size-[16px]" /> Saved</>
						) : (
							<><Download className="size-[16px]" /> Save file</>
						)}
					</IosSecondaryButton>
				</div>

				<p className="pt-4 px-1 text-[13px] leading-snug text-white/55">
					Store it somewhere safe — a password manager works. We can't show this
					key to you again.
				</p>

				{/* iOS-style checkbox row.  Tap the whole row, not just
				    the box — bigger target, matches Settings cell behaviour. */}
				<button
					type="button"
					onClick={onToggleAck}
					className="mt-5 flex items-start gap-3 rounded-2xl bg-white/[0.06] border border-white/10 px-4 py-3.5 text-left active:bg-white/[0.10]"
					role="checkbox"
					aria-checked={savedAck}
				>
					<span
						className={`shrink-0 mt-px size-6 rounded-md flex items-center justify-center transition-colors duration-150 ${
							savedAck
								? "bg-[#0A84FF] border border-[#0A84FF]"
								: "bg-transparent border border-white/30"
						}`}
					>
						{savedAck && <Check className="size-[14px] text-white" strokeWidth={3} />}
					</span>
					<span className="text-[14px] leading-snug text-white/85">
						I've saved my recovery key.  I understand that losing both the passphrase
						and this key means losing access to my encrypted messages.
					</span>
				</button>

				<div className="flex-1 min-h-[24px]" />

				<IosPrimaryButton type="button" disabled={!savedAck} onClick={onComplete}>
					Continue to Koven
				</IosPrimaryButton>
			</div>
		</>
	);
}

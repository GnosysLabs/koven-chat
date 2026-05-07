// One-time encryption-setup flow.  Shown immediately after first
// login on an account that has no SSSS yet, blocking the rest of the
// app until the user either completes setup or signs out.
//
// Three logical steps:
//   1. User picks an encryption passphrase (separate from anything
//      account-related — see CLAUDE.md / SSSS rationale).
//   2. We bootstrap cross-signing + SSSS + key backup, capturing the
//      generated recovery key.  UIA on cross-signing key upload is
//      satisfied with an engine-issued ephemeral password the
//      transport already has cached (no field shown to the user).
//   3. We display the recovery key once with copy/download, and
//      require the user to confirm they've saved it before letting
//      them into the app.
//
// The dialog is non-dismissible during in-flight bootstrap and after
// the recovery key is shown — losing the recovery key without saving
// it would mean losing the only fallback if the passphrase is later
// forgotten.

import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Copy, Download, Lock } from "lucide-react";

export interface EncryptionSetupSheetProps {
	open: boolean;
	// Called with the passphrase the user picked.  Caller handles the
	// UIA password (engine-issued, cached on the transport) so the
	// sheet doesn't have to expose any account-credential field.
	// Resolves with the generated recovery key (a 48-char base58
	// string).  Throws on failure; the dialog surfaces the error and
	// lets the user retry.
	onSetup(passphrase: string): Promise<string>;
	// Called once the user confirms they've saved the recovery key.
	onComplete(): void;
	// Escape hatch: if the user can't proceed (transport hiccup, etc.)
	// they can sign out.
	onSignOut(): void;
}

type Step = "passphrase" | "recovery";

export function EncryptionSetupSheet({ open, onSetup, onComplete, onSignOut }: EncryptionSetupSheetProps) {
	const [step, setStep] = useState<Step>("passphrase");
	const [passphrase, setPassphrase] = useState("");
	const [confirm, setConfirm] = useState("");
	const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedAck, setSavedAck] = useState(false);

	async function submitPassphrase(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (passphrase.length < 8) {
			setError("Encryption passphrase must be at least 8 characters.");
			return;
		}
		if (passphrase !== confirm) {
			setError("Encryption passphrases don't match.");
			return;
		}
		setPending(true);
		try {
			const key = await onSetup(passphrase);
			setRecoveryKey(key);
			setStep("recovery");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	function copyRecoveryKey() {
		if (!recoveryKey) return;
		navigator.clipboard.writeText(recoveryKey).catch(() => {/* clipboard denied */});
	}

	function downloadRecoveryKey() {
		if (!recoveryKey) return;
		const blob = new Blob([recoveryKey + "\n"], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "koven-recovery-key.txt";
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	return (
		// onOpenChange={() => {}} — non-dismissible.  The user must finish
		// setup or explicitly sign out; closing the dialog mid-flow would
		// strand them with a half-bootstrapped account.
		<Dialog open={open} onOpenChange={() => {}}>
			<DialogContent className="sm:max-w-md" onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Lock className="h-4 w-4 text-primary" />
						Set up encrypted messages
					</DialogTitle>
					<DialogDescription>
						Pick a passphrase that protects your direct messages. Only you ever see it — not Koven, not the server.
					</DialogDescription>
				</DialogHeader>

				{step === "passphrase" && (
					<form onSubmit={submitPassphrase} className="space-y-4">
						<div className="space-y-1.5">
							<Label htmlFor="enc-passphrase">Encryption passphrase</Label>
							<Input
								id="enc-passphrase"
								type="password"
								value={passphrase}
								onChange={(e) => setPassphrase(e.target.value)}
								placeholder="At least 8 characters"
								autoComplete="new-password"
								autoFocus
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="enc-confirm">Confirm encryption passphrase</Label>
							<Input
								id="enc-confirm"
								type="password"
								value={confirm}
								onChange={(e) => setConfirm(e.target.value)}
								autoComplete="new-password"
							/>
						</div>
						<p className="text-[11px] text-muted-foreground leading-snug">
							This passphrase only protects your encrypted messages. If you forget it, you'll need the recovery key we generate next — without either, your encrypted message history is gone.
						</p>
						{error && (
							<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-3 py-2">
								{error}
							</div>
						)}
						<div className="flex items-center justify-between gap-2">
							<button
								type="button"
								onClick={onSignOut}
								className="text-xs text-muted-foreground hover:text-foreground underline"
							>
								Sign out instead
							</button>
							<Button type="submit" disabled={pending || !passphrase || !confirm}>
								{pending ? "Setting up…" : "Continue"}
							</Button>
						</div>
					</form>
				)}

				{step === "recovery" && recoveryKey && (
					<div className="space-y-4">
						<div className="space-y-1.5">
							<Label>Recovery key</Label>
							<div className="font-mono text-sm bg-muted border border-border rounded p-3 break-all select-all">
								{recoveryKey}
							</div>
						</div>
						<div className="flex gap-2">
							<Button type="button" variant="outline" size="sm" onClick={copyRecoveryKey} className="flex-1">
								<Copy className="h-3.5 w-3.5 mr-1.5" />
								Copy
							</Button>
							<Button type="button" variant="outline" size="sm" onClick={downloadRecoveryKey} className="flex-1">
								<Download className="h-3.5 w-3.5 mr-1.5" />
								Download
							</Button>
						</div>
						<p className="text-[11px] text-muted-foreground leading-snug">
							Save this somewhere safe — a password manager works. If you ever forget your passphrase or sign in on a new device, the recovery key gets you back in.
						</p>
						<label className="flex items-start gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={savedAck}
								onChange={(e) => setSavedAck(e.target.checked)}
								className="mt-0.5"
							/>
							<span className="text-xs leading-snug">
								I've saved the recovery key. I understand losing both the passphrase and this key means losing access to my encrypted messages.
							</span>
						</label>
						<div className="flex justify-end">
							<Button type="button" disabled={!savedAck} onClick={onComplete}>
								Continue to Koven
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

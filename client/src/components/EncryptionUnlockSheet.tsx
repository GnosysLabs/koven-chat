// Encryption-unlock dialog.  Shown after login when the account
// already has SSSS configured but this device hasn't unlocked it yet
// (fresh login on a new browser, after a clear-storage, etc.).
//
// The single input accepts either:
//   - the user's encryption passphrase (PBKDF2-derived per the SSSS
//     key info's salt + iterations), OR
//   - their recovery key (48-char base58, base-64 with extra error
//     correction baked in)
//
// Both decode to the same private key; the transport's
// unlockEncryption decides which form was given by trying recovery
// key decode first and falling through to passphrase derivation.

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
import { Lock } from "lucide-react";

export interface EncryptionUnlockSheetProps {
	open: boolean;
	// Returns true on a successful unlock, false on bad input.  Throws
	// on infrastructure errors (no SSSS configured, network failure).
	onUnlock(input: string): Promise<boolean>;
	onUnlocked(): void;
	onSignOut(): void;
}

export function EncryptionUnlockSheet({ open, onUnlock, onUnlocked, onSignOut }: EncryptionUnlockSheetProps) {
	const [input, setInput] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setPending(true);
		try {
			const ok = await onUnlock(input.trim());
			if (ok) {
				onUnlocked();
			} else {
				setError("That passphrase or recovery key didn't work. Check for typos.");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={() => {}}>
			{/* `[&>button]:hidden` suppresses shadcn's auto-rendered
			    close buttons.  Same rationale as EncryptionSetupSheet:
			    the dialog is non-dismissible by design, leaving a
			    visible-but-inert X reads as a broken button.  The
			    "Sign out instead" link below is the proper escape.
			    `force-midnight` keeps this pre-auth surface visually
			    consistent with the login screen no matter what theme
			    the user has stashed in localStorage; the same recipe
			    runs on desktop AND mobile so we don't fork the UI. */}
			<DialogContent
				className="sm:max-w-md [&>button]:hidden force-midnight"
				onInteractOutside={(e) => e.preventDefault()}
				onEscapeKeyDown={(e) => e.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Lock className="h-4 w-4 text-primary" />
						Unlock encrypted messages
					</DialogTitle>
					<DialogDescription>
						Enter your encryption passphrase to access your direct messages on this device.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={submit} className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="enc-unlock">Passphrase or recovery key</Label>
						<Input
							id="enc-unlock"
							type="password"
							value={input}
							onChange={(e) => setInput(e.target.value)}
							autoComplete="current-password"
							autoFocus
						/>
					</div>
					<p className="text-[11px] text-muted-foreground leading-snug">
						Forgotten your passphrase? Paste your recovery key here instead.
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
						<Button type="submit" disabled={pending || !input.trim()}>
							{pending ? "Unlocking…" : "Unlock"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

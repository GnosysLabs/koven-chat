// iOS HIG version of the encryption-unlock surface.  Same brand
// canvas as LoginMobile / ConnectingMobile so the post-login flow
// reads as one continuous Koven experience rather than handing off
// to a system Dialog.
//
// Field accepts either the user's passphrase or their recovery key —
// the transport tries recovery-key decode first then falls back to
// PBKDF2.  Single field is the iOS pattern (Apple ID handles
// equivalent dual-input the same way: one field, accept either form,
// disambiguate server-side).
//
// Non-dismissible by design.  No close button; the only escape is
// "Sign out instead" rendered as a destructive-tinted text button at
// the bottom of the column.

import { useState } from "react";
import { AlertCircle, Lock } from "lucide-react";
import { isNativeShell } from "@/lib/nativeShell";
import { hapticImpact, hapticNotification } from "@/lib/haptics";
import {
	IosBrandSurface,
	IosField,
	IosFieldLabel,
	IosPrimaryButton,
	IosStatusBanner,
	IosTextButton,
} from "@/components/IosForm";

export interface EncryptionUnlockMobileProps {
	onUnlock(input: string): Promise<boolean>;
	onUnlocked(): void;
	onSignOut(): void;
}

export function EncryptionUnlockMobile({ onUnlock, onUnlocked, onSignOut }: EncryptionUnlockMobileProps) {
	const [input, setInput] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inNativeShell = isNativeShell();

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setPending(true);
		void hapticImpact("medium");
		try {
			const ok = await onUnlock(input.trim());
			if (ok) {
				void hapticNotification("success");
				onUnlocked();
			} else {
				void hapticNotification("error");
				setError("That passphrase or recovery key didn't work. Check for typos.");
			}
		} catch (err) {
			void hapticNotification("error");
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPending(false);
		}
	}

	return (
		<IosBrandSurface showWallpaper={inNativeShell}>
			<div
				className="flex flex-col min-h-full px-6"
				style={{
					paddingTop: "max(env(safe-area-inset-top), 0.5rem)",
					paddingBottom: "max(env(safe-area-inset-bottom), 1rem)",
				}}
			>
				{/* Empty nav slot so vertical layout matches LoginMobile
				    + ConnectingMobile — keeps transitions calm. */}
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

				<div className="pt-12 space-y-2">
					<div className="flex items-center gap-2 pb-1">
						<Lock className="size-[20px] text-white/75" strokeWidth={2.25} />
						<span className="text-[13px] uppercase tracking-wider text-white/55 font-medium">
							End-to-end encrypted
						</span>
					</div>
					<h1 className="text-[34px] font-bold tracking-[-0.022em] leading-[1.1] text-white">
						Unlock your messages
					</h1>
					<p className="text-[17px] leading-[1.35] text-white/70">
						Enter your encryption passphrase to read your direct messages on this device.
					</p>
				</div>

				<form onSubmit={submit} className="pt-8 pb-2 flex-1 flex flex-col">
					<div className="space-y-1.5">
						<IosFieldLabel htmlFor="enc-unlock">Passphrase or recovery key</IosFieldLabel>
						<IosField
							id="enc-unlock"
							type="password"
							value={input}
							onChange={(e) => setInput(e.target.value)}
							autoComplete="current-password"
							autoFocus
							enterKeyHint="go"
							aria-label="Encryption passphrase or recovery key"
						/>
						<p className="px-1 pt-1 text-[13px] leading-snug text-white/55">
							Forgotten your passphrase? Paste your recovery key here instead.
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

					<IosPrimaryButton type="submit" disabled={pending || !input.trim()} loading={pending}>
						{pending ? "Unlocking…" : "Unlock"}
					</IosPrimaryButton>

					<div className="pt-3 flex justify-center">
						<IosTextButton tone="destructive" onClick={onSignOut}>
							Sign out instead
						</IosTextButton>
					</div>
				</form>
			</div>
		</IosBrandSurface>
	);
}

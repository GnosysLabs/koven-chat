// MobileLinkDeviceScreen: HIG sub-screen for QR device sign-in.
//
// The user scans a QR code shown on a desktop / web Koven login
// screen.  This screen confirms the action, resolves the encryption
// recovery key, and approves the desktop session via the engine.  The
// recovery key is encrypted to the desktop's public key before it
// leaves the phone (see client/src/lib/qrLink.ts); the engine only
// relays ciphertext.
//
// Resolving the recovery key has two paths: if the SSSS key is already
// unlocked in memory this session we use it silently; otherwise the
// user is asked for their encryption passphrase or recovery key, which
// doubles as a confirmation that the person scanning controls the
// account's encryption identity.

import { useState } from "react";
import { QrCode, MonitorSmartphone, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { hapticImpact, hapticNotification } from "@/lib/haptics";
import { scanQrCode } from "@/lib/barcodeScanner";
import { parseQrPayload, approveQrLink } from "@/lib/qrLink";
import type { QrLinkPayload } from "@koven/shared";
import type { MatrixTransport } from "@/lib/matrix";
import {
	NavBar,
	NavBackButton,
	GroupLabel,
	GroupCard,
	GroupFooter,
	ErrorBanner,
} from "@/components/mobile/Chrome";

export interface MobileLinkDeviceScreenProps {
	transport: MatrixTransport | null;
	accessToken: string | null;
	onBack(): void;
}

type Phase = "intro" | "confirm" | "needsKey" | "approving" | "done" | "error";

export function MobileLinkDeviceScreen({
	transport,
	accessToken,
	onBack,
}: MobileLinkDeviceScreenProps) {
	const [phase, setPhase] = useState<Phase>("intro");
	const [payload, setPayload] = useState<QrLinkPayload | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [keyInput, setKeyInput] = useState("");
	const [keyError, setKeyError] = useState<string | null>(null);

	function fail(message: string) {
		void hapticNotification("error");
		setError(message);
		setPhase("error");
	}

	async function startScan() {
		void hapticImpact("light");
		setError(null);
		const result = await scanQrCode();
		if (!result.ok) {
			if (result.reason === "unavailable") {
				fail("Scanning isn't available on this device.");
			} else if (result.reason === "permission") {
				fail("Camera access is needed to scan the code. Enable it in Settings.");
			}
			// "cancelled": the user backed out; stay on the intro.
			return;
		}
		const parsed = parseQrPayload(result.value);
		if (!parsed) {
			fail("That QR code isn't a Koven sign-in code.");
			return;
		}
		setPayload(parsed);
		setPhase("confirm");
	}

	// Resolve the recovery key and approve, optionally with a
	// user-supplied passphrase / recovery key.
	async function approve(suppliedKey?: string) {
		if (!transport || !accessToken || !payload) {
			fail("Sign-in session is no longer available.");
			return;
		}
		setPhase("approving");
		setKeyError(null);

		const resolved = await transport.resolveLinkingRecoveryKey(suppliedKey);
		if (!resolved.ok) {
			if (resolved.reason === "need_input") {
				setPhase("needsKey");
				return;
			}
			if (resolved.reason === "bad_input") {
				setKeyError("That passphrase or recovery key didn't match. Try again.");
				setPhase("needsKey");
				return;
			}
			fail("This account doesn't have encryption set up yet.");
			return;
		}

		const res = await approveQrLink(payload, resolved.recoveryKey, accessToken);
		if (res.ok) {
			void hapticNotification("success");
			setPhase("done");
			return;
		}
		if (res.error === "expired") {
			fail("That sign-in code expired. Generate a new one on the other device.");
		} else if (res.error === "already_approved") {
			fail("That sign-in code was already used.");
		} else if (res.error === "network") {
			fail("Couldn't reach the server. Check your connection and try again.");
		} else {
			fail("Something went wrong approving the sign-in.");
		}
	}

	return (
		<div className="flex flex-col h-full">
			<NavBar
				left={<NavBackButton onClick={onBack} />}
				title="Link a Device"
			/>
			<div className="flex-1 overflow-y-auto pb-10">
				{error && <ErrorBanner message={error} />}

				{phase === "intro" && (
					<>
						<div className="flex flex-col items-center text-center px-8 pt-10 pb-6">
							<div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
								<QrCode className="h-8 w-8 text-primary" strokeWidth={2} />
							</div>
							<h2 className="text-[17px] font-semibold">Sign in on another device</h2>
							<p className="text-[13px] text-muted-foreground leading-snug mt-1.5">
								Open Koven on a computer, choose{" "}
								<span className="font-medium text-foreground">Sign in with a QR code</span>,
								then scan the code it shows.
							</p>
						</div>
						<div className="px-4">
							<Button className="w-full" onClick={startScan}>
								Scan QR code
							</Button>
						</div>
					</>
				)}

				{phase === "confirm" && (
					<>
						<div className="flex flex-col items-center text-center px-8 pt-10 pb-6">
							<div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
								<MonitorSmartphone className="h-8 w-8 text-primary" strokeWidth={2} />
							</div>
							<h2 className="text-[17px] font-semibold">Sign in on the other device?</h2>
							<p className="text-[13px] text-muted-foreground leading-snug mt-1.5">
								This signs that device into your account and unlocks
								encrypted chats there. Only continue if it's a device
								you own.
							</p>
						</div>
						<div className="px-4 space-y-2">
							<Button className="w-full" onClick={() => approve()}>
								Sign in that device
							</Button>
							<Button variant="ghost" className="w-full" onClick={onBack}>
								Cancel
							</Button>
						</div>
					</>
				)}

				{phase === "needsKey" && (
					<>
						<GroupLabel>Confirm it's you</GroupLabel>
						<GroupCard>
							<div className="px-4 py-3 space-y-2">
								<p className="text-[13px] text-muted-foreground leading-snug">
									Enter your encryption passphrase or recovery key to
									unlock encrypted chats on the other device.
								</p>
								<Input
									type="password"
									autoFocus
									value={keyInput}
									onChange={(e) => setKeyInput(e.target.value)}
									placeholder="Passphrase or recovery key"
								/>
							</div>
						</GroupCard>
						{keyError && <GroupFooter>{keyError}</GroupFooter>}
						<div className="px-4 pt-3">
							<Button
								className="w-full"
								disabled={!keyInput.trim()}
								onClick={() => approve(keyInput.trim())}
							>
								Confirm and sign in
							</Button>
						</div>
					</>
				)}

				{phase === "approving" && (
					<div className="flex flex-col items-center text-center px-8 pt-16">
						<p className="text-[15px] text-muted-foreground">Signing in the other device…</p>
					</div>
				)}

				{phase === "done" && (
					<div className="flex flex-col items-center text-center px-8 pt-12">
						<div className="h-16 w-16 rounded-2xl bg-green-500/15 flex items-center justify-center mb-4">
							<Check className="h-8 w-8 text-green-500" strokeWidth={2.4} />
						</div>
						<h2 className="text-[17px] font-semibold">Device signed in</h2>
						<p className="text-[13px] text-muted-foreground leading-snug mt-1.5">
							The other device is now signed into your account.
						</p>
						<div className="px-4 pt-6 w-full">
							<Button className="w-full" onClick={onBack}>
								Done
							</Button>
						</div>
					</div>
				)}

				{phase === "error" && (
					<div className="px-4 pt-4">
						<Button className="w-full" onClick={() => { setPhase("intro"); setError(null); }}>
							Try again
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}

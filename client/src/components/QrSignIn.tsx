// QR-code sign-in panel for the desktop / web login screen.
//
// Renders a QR code the user scans inside the already-signed-in Koven
// mobile app.  Once the phone approves, the engine relays a freshly
// minted Matrix session (plus the encryption recovery key, end-to-end
// encrypted) and this panel signs the desktop in with zero typing.
//
// See client/src/lib/qrLink.ts for the crypto + transport, and
// engine/src/server.ts (/api/auth/qr/*) for the relay.

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { HOMESERVER_URL } from "@/lib/urls";
import {
	initiateQrLink,
	pollQrLink,
	claimRecoveryKey,
	type QrLinkSession,
} from "@/lib/qrLink";
import type { MatrixCredentials } from "@/lib/matrix";

interface QrSignInProps {
	onLoggedIn(creds: MatrixCredentials, uiaPassword: string, recoveryKey?: string): void;
	onBack(): void;
}

type Phase = "loading" | "waiting" | "expired" | "error";

// How often the desktop polls the engine for approval.
const POLL_INTERVAL_MS = 2000;

export function QrSignIn({ onLoggedIn, onBack }: QrSignInProps) {
	const [phase, setPhase] = useState<Phase>("loading");
	const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
	// Bumped to throw away an expired / failed session and start fresh.
	const [generation, setGeneration] = useState(0);

	// onLoggedIn is recreated on every parent render; keep it in a ref
	// so the polling effect doesn't restart (and re-mint a QR) each time.
	const onLoggedInRef = useRef(onLoggedIn);
	useEffect(() => {
		onLoggedInRef.current = onLoggedIn;
	});

	useEffect(() => {
		let cancelled = false;
		let pollTimer: ReturnType<typeof setInterval> | null = null;
		let expiryTimer: ReturnType<typeof setTimeout> | null = null;
		const stopTimers = () => {
			if (pollTimer) clearInterval(pollTimer);
			if (expiryTimer) clearTimeout(expiryTimer);
		};

		setPhase("loading");
		setQrDataUrl(null);

		(async () => {
			let session: QrLinkSession;
			try {
				session = await initiateQrLink();
			} catch {
				if (!cancelled) setPhase("error");
				return;
			}
			if (cancelled) return;

			let dataUrl: string;
			try {
				dataUrl = await QRCode.toDataURL(session.qrPayload, {
					margin: 1,
					width: 240,
				});
			} catch {
				if (!cancelled) setPhase("error");
				return;
			}
			if (cancelled) return;
			setQrDataUrl(dataUrl);
			setPhase("waiting");

			expiryTimer = setTimeout(() => {
				if (cancelled) return;
				stopTimers();
				setPhase("expired");
			}, Math.max(0, session.expiresAt - Date.now()));

			pollTimer = setInterval(async () => {
				if (cancelled) return;
				let res;
				try {
					res = await pollQrLink(session.qrId, session.claimSecret);
				} catch {
					// Transient network blip; keep polling.
					return;
				}
				if (cancelled) return;
				if (res.status === "pending") return;

				stopTimers();
				if (res.status === "expired") {
					setPhase("expired");
					return;
				}
				// Approved: decrypt the relayed recovery key and sign in.
				try {
					const recoveryKey = await claimRecoveryKey(res, session.privateKey);
					const creds: MatrixCredentials = {
						homeserver: HOMESERVER_URL,
						user_id: res.user_id,
						access_token: res.access_token,
						device_id: res.device_id,
					};
					onLoggedInRef.current(creds, "", recoveryKey);
				} catch {
					if (!cancelled) setPhase("error");
				}
			}, POLL_INTERVAL_MS);
		})();

		return () => {
			cancelled = true;
			stopTimers();
		};
	}, [generation]);

	return (
		<div className="p-5 space-y-4">
			<div className="space-y-1">
				<div className="text-sm font-medium">Sign in with your phone</div>
				<p className="text-xs text-muted-foreground leading-snug">
					Open Koven on your phone, go to Settings, and tap{" "}
					<span className="font-medium text-foreground">Link a device</span>{" "}
					to scan this code.
				</p>
			</div>

			<div className="flex items-center justify-center">
				<div className="rounded-lg bg-white p-3 w-[264px] h-[264px] flex items-center justify-center">
					{phase === "waiting" && qrDataUrl ? (
						<img
							src={qrDataUrl}
							alt="Sign-in QR code"
							width={240}
							height={240}
						/>
					) : phase === "expired" ? (
						<span className="text-xs text-neutral-500 text-center px-4">
							This code expired.
						</span>
					) : phase === "error" ? (
						<span className="text-xs text-neutral-500 text-center px-4">
							Couldn't generate a code.
						</span>
					) : (
						<span className="text-xs text-neutral-500">Generating…</span>
					)}
				</div>
			</div>

			{phase === "waiting" && (
				<p className="text-xs text-muted-foreground text-center">
					Waiting for you to scan and approve…
				</p>
			)}

			{(phase === "expired" || phase === "error") && (
				<Button
					type="button"
					className="w-full"
					onClick={() => setGeneration((g) => g + 1)}
				>
					Generate a new code
				</Button>
			)}

			<button
				type="button"
				onClick={onBack}
				className="w-full text-xs text-muted-foreground hover:text-foreground"
			>
				← Sign in with email instead
			</button>
		</div>
	);
}

// Email-code auth surface against the engine.  Typed wrappers around
// the three /api/auth/* endpoints.  All errors come back as a tagged
// string so callers can branch on the cause without parsing free-form
// text.

import { ENGINE_URL } from "@/lib/urls";
import { isCapacitor } from "@/lib/nativeShell";
import type { MatrixCredentials } from "@/lib/matrix";
import type { UserId } from "@koven/shared";

// ─── Request code ───────────────────────────────────────────────────

export type RequestCodeResult =
	| { ok: true; isNewAccount: boolean }
	| { ok: false; error: RequestCodeError };

export type RequestCodeError =
	| "invalid_email"
	| "rate_limited"
	| "email_disabled"
	| "send_failed"
	| "captcha_required"
	| "captcha_failed"
	| "network";

export async function requestEmailCode(
	email: string,
	opts: { turnstileToken?: string | null } = {},
): Promise<RequestCodeResult> {
	// Native-shell captcha bypass.  Cloudflare can't validate the
	// WebView origin in either Tauri (`tauri://localhost`) or
	// Capacitor iOS (`capacitor://localhost`), so the Turnstile
	// widget can't render in those shells.  Both ship as signed
	// binaries (GitHub releases for desktop, App Store for iOS) so
	// the threat model that justifies Turnstile — email-spam bots
	// hitting the public web — doesn't apply.  The engine matches
	// `X-Koven-Client: desktop|ios` and skips the captcha gate
	// (server.ts ~ line 934).  Email rate-limits + send-failure
	// paths still apply on both code paths.
	//
	// Same bypass for local Vite dev — Turnstile site key is bound
	// to client.koven.chat so the widget refuses to render on
	// http://localhost.  `import.meta.env.DEV` is true only in dev
	// builds, stripped to false in `vite build`, so this can't ship
	// to real users.
	const isDesktop = typeof window !== "undefined"
		&& (window as { __KOVEN_DESKTOP__?: boolean }).__KOVEN_DESKTOP__ === true;
	const isDev = import.meta.env.DEV;
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (isDesktop || isDev) headers["X-Koven-Client"] = "desktop";
	else if (isCapacitor()) headers["X-Koven-Client"] = "ios";
	let r: Response;
	try {
		r = await fetch(`${ENGINE_URL}/api/auth/request-code`, {
			method: "POST",
			headers,
			// Always include the turnstile_token field when set so the
			// engine can pass it through to Cloudflare's siteverify.
			// Engine ignores it when the integration isn't configured
			// or the desktop bypass header is set, so leaving the
			// field unconditionally is safe.
			body: JSON.stringify(
				opts.turnstileToken
					? { email, turnstile_token: opts.turnstileToken }
					: { email },
			),
		});
	} catch {
		return { ok: false, error: "network" };
	}
	if (r.ok) {
		const body = (await r.json().catch(() => ({}))) as { is_new_account?: boolean };
		return { ok: true, isNewAccount: !!body.is_new_account };
	}
	const body = (await r.json().catch(() => ({}))) as { error?: string };
	return { ok: false, error: (body.error as RequestCodeError) ?? "send_failed" };
}

// ─── Verify code ────────────────────────────────────────────────────

export interface VerifyCodeSuccess {
	ok: true;
	creds: MatrixCredentials;
	uiaPassword: string;
}

export type VerifyCodeError =
	| "invalid_request"
	| "no_active_code"
	| "wrong_code"
	| "too_many_attempts"
	| "needs_username"
	| "invalid_username"
	| "username_unavailable"
	| "password_rotate_failed"
	| "synapse_error"
	| "network";

export type VerifyCodeResult =
	| VerifyCodeSuccess
	| { ok: false; error: VerifyCodeError; detail?: string };

export async function verifyEmailCode(opts: {
	email: string;
	code: string;
	username?: string;
	homeserver: string;
}): Promise<VerifyCodeResult> {
	let r: Response;
	try {
		r = await fetch(`${ENGINE_URL}/api/auth/verify-code`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: opts.email,
				code: opts.code,
				username: opts.username,
			}),
		});
	} catch {
		return { ok: false, error: "network" };
	}
	const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
	if (!r.ok) {
		const err = (body.error as VerifyCodeError) ?? "synapse_error";
		const detail = typeof body.detail === "string" ? body.detail : undefined;
		return { ok: false, error: err, detail };
	}
	const userId = body.user_id as string | undefined;
	const accessToken = body.access_token as string | undefined;
	const deviceId = body.device_id as string | undefined;
	const uiaPassword = body.uia_password as string | undefined;
	if (!userId || !accessToken || !deviceId || !uiaPassword) {
		return { ok: false, error: "synapse_error" };
	}
	return {
		ok: true,
		creds: {
			homeserver: opts.homeserver,
			user_id: userId as UserId,
			access_token: accessToken,
			device_id: deviceId,
		},
		uiaPassword,
	};
}

// ─── Fetch fresh UIA password ───────────────────────────────────────

/**
 * Rotate the Synapse password for the current user (engine does this
 * via admin API) and return the new value.  The client should call
 * this immediately before any UIA-protected operation (encryption
 * setup, account deactivation) and forget the value the moment the
 * UIA stage completes.  Never persist to disk.
 */
export async function fetchUiaPassword(accessToken: string): Promise<string> {
	const r = await fetch(`${ENGINE_URL}/api/auth/uia-password`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) {
		const body = (await r.json().catch(() => ({}))) as { error?: string };
		throw new Error(`UIA password fetch failed: ${body.error ?? r.status}`);
	}
	const body = (await r.json()) as { password?: string };
	if (!body.password) throw new Error("engine returned no password");
	return body.password;
}

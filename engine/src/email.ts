// Outbound email for the email-code login flow.  Two transports
// supported, picked by environment:
//
//   1. Resend HTTP API  (RESEND_API_KEY set): takes precedence
//   2. Generic SMTP     (SMTP_HOST + SMTP_PORT + SMTP_USER + SMTP_PASSWORD)
//
// The fallback order means an operator can swap providers by changing
// env vars without touching code.  Resend is the lighter integration
// (one fetch, no persistent connection); SMTP is the universal one
// that talks to anything else.
//
// Failure modes the caller cares about:
//   - no transport configured → { error: "not_configured" }
//   - HTTP/SMTP error         → { error: "send_failed", detail }
// On success returns { ok: true }.

import nodemailer, { type Transporter } from "nodemailer";
import { config } from "./config";

export interface SendResult {
	ok?: true;
	error?: "not_configured" | "send_failed";
	detail?: string;
}

interface ResendErrorBody {
	message?: string;
	name?: string;
}

type Transport = "resend" | "smtp" | null;

function pickTransport(): Transport {
	if (config.resendApiKey) return "resend";
	if (config.smtpHost && config.smtpUser && config.smtpPassword) return "smtp";
	return null;
}

export function emailTransportConfigured(): boolean {
	return pickTransport() !== null;
}

// Lazily-built nodemailer transporter, reused across sends so we don't
// reopen the SMTP connection per email.  Reset to null if config
// changes (we don't reload at runtime today, but the guard is cheap).
let smtpTransporter: Transporter | null = null;
function getSmtpTransporter(): Transporter {
	if (smtpTransporter) return smtpTransporter;
	smtpTransporter = nodemailer.createTransport({
		host: config.smtpHost,
		port: config.smtpPort,
		secure: config.smtpSecure,         // true = implicit TLS (465); false = STARTTLS (587)
		auth: {
			user: config.smtpUser,
			pass: config.smtpPassword,
		},
	});
	return smtpTransporter;
}

export async function sendLoginCodeEmail(
	to: string,
	code: string,
	context: { brandName: string; ttlMinutes: number },
): Promise<SendResult> {
	const transport = pickTransport();
	if (transport === null) return { error: "not_configured" };

	const subject = `${context.brandName} sign-in code: ${code}`;
	const html = renderHtml(code, context);
	const text = renderText(code, context);

	if (transport === "resend") {
		return sendViaResend({ to, subject, html, text });
	}
	return sendViaSmtp({ to, subject, html, text });
}

async function sendViaResend(msg: {
	to: string; subject: string; html: string; text: string;
}): Promise<SendResult> {
	const r = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.resendApiKey}`,
		},
		body: JSON.stringify({
			from: config.emailFrom,
			to: msg.to,
			subject: msg.subject,
			html: msg.html,
			text: msg.text,
		}),
	});
	if (!r.ok) {
		const body = (await r.json().catch(() => ({}))) as ResendErrorBody;
		const detail = body.message ?? `HTTP ${r.status}`;
		console.warn(`engine: Resend send failed: ${detail}`);
		return { error: "send_failed", detail };
	}
	return { ok: true };
}

async function sendViaSmtp(msg: {
	to: string; subject: string; html: string; text: string;
}): Promise<SendResult> {
	try {
		await getSmtpTransporter().sendMail({
			from: config.emailFrom,
			to: msg.to,
			subject: msg.subject,
			html: msg.html,
			text: msg.text,
		});
		return { ok: true };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		console.warn(`engine: SMTP send failed: ${detail}`);
		// Reset the transporter so a transient connection failure
		// (DNS hiccup, server bounce) gets a fresh socket on the next
		// attempt rather than dying on a broken pool.
		smtpTransporter = null;
		return { error: "send_failed", detail };
	}
}

function renderText(code: string, ctx: { brandName: string; ttlMinutes: number }): string {
	return [
		`${ctx.brandName} sign-in`,
		``,
		`Your one-time code is: ${code}`,
		``,
		`It expires in ${ctx.ttlMinutes} minutes.  If you didn't ask for this code,`,
		`you can ignore this email; nothing happens until the code is used.`,
	].join("\n");
}

// Inline-styled HTML: most webmail clients strip <style> blocks and
// some don't even render <head>.  Keep it boring and self-contained.
function renderHtml(code: string, ctx: { brandName: string; ttlMinutes: number }): string {
	return `<!doctype html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#0c0c10; color:#e5e5ea; margin:0; padding:32px;">
	<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:480px; margin:0 auto;">
		<tr>
			<td style="padding:24px 0; text-align:center; font-size:18px; font-weight:600; letter-spacing:0.2px;">
				${escapeHtml(ctx.brandName)}
			</td>
		</tr>
		<tr>
			<td style="background:#16161c; border:1px solid #232329; border-radius:10px; padding:28px 24px; text-align:center;">
				<div style="font-size:13px; color:#a1a1aa; margin-bottom:16px;">Your sign-in code</div>
				<div style="font-family: 'SF Mono', Menlo, Consolas, monospace; font-size:32px; letter-spacing:6px; font-weight:600; color:#fafafa;">
					${escapeHtml(code)}
				</div>
				<div style="font-size:12px; color:#71717a; margin-top:16px;">
					Expires in ${ctx.ttlMinutes} minutes.
				</div>
			</td>
		</tr>
		<tr>
			<td style="padding:20px 8px; font-size:12px; line-height:1.55; color:#71717a;">
				If you didn't ask for this code, you can ignore this email. Nothing happens until the code is used.
			</td>
		</tr>
	</table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

// Push delivery for APNs (iOS).
//
// Called by notification-fanout.ts after writing a bell row.  Looks up
// push tokens for the recipient and fires a background notification to
// each registered device.  Uses the HTTP/2 APNs provider API with a
// signed JWT (ES256, from the .p8 key file).
//
// Uses node:http2 directly because Bun's fetch produces
// "Malformed_HTTP_Response" against Apple's HTTP/2-only APNs endpoint.
//
// The JWT is cached and rotated every 50 minutes (Apple allows up to
// 60 minutes).  Token refresh is lazy: if a send gets a 403
// ExpiredProviderToken, we regenerate and retry once.

import http2 from "node:http2";
import { SignJWT, importPKCS8 } from "jose";
import { config } from "./config";
import { listPushTokensForUsers } from "./db";

const APNS_ORIGIN = config.apnsProduction
	? "https://api.push.apple.com"
	: "https://api.sandbox.push.apple.com";

const BUNDLE_ID = "chat.koven.ios";

let cachedJwt: string | null = null;
let jwtIssuedAt = 0;
const JWT_LIFETIME_MS = 50 * 60 * 1000;

// Persistent HTTP/2 session to APNs.  Apple recommends keeping the
// connection open and multiplexing requests over it.
let h2Session: http2.ClientHttp2Session | null = null;

function getH2Session(): http2.ClientHttp2Session {
	if (h2Session && !h2Session.closed && !h2Session.destroyed) return h2Session;
	h2Session = http2.connect(APNS_ORIGIN);
	h2Session.on("error", () => { h2Session = null; });
	h2Session.on("close", () => { h2Session = null; });
	return h2Session;
}

async function getApnsJwt(): Promise<string> {
	const now = Date.now();
	if (cachedJwt && (now - jwtIssuedAt) < JWT_LIFETIME_MS) return cachedJwt;

	if (!config.apnsKeyPath || !config.apnsKeyId || !config.apnsTeamId) {
		throw new Error("APNs not configured (missing APNS_KEY_PATH, APNS_KEY_ID, or APNS_TEAM_ID)");
	}

	const keyFile = await Bun.file(config.apnsKeyPath).text();
	const privateKey = await importPKCS8(keyFile, "ES256");

	const iat = Math.floor(now / 1000);
	cachedJwt = await new SignJWT({})
		.setProtectedHeader({ alg: "ES256", kid: config.apnsKeyId })
		.setIssuer(config.apnsTeamId)
		.setIssuedAt(iat)
		.sign(privateKey);

	jwtIssuedAt = now;
	return cachedJwt;
}

function invalidateJwt(): void {
	cachedJwt = null;
	jwtIssuedAt = 0;
}

interface PushPayload {
	title: string;
	body: string;
	roomId: string;
	eventId: string;
}

function h2Post(session: http2.ClientHttp2Session, path: string, headers: Record<string, string>, body: Buffer): Promise<{ status: number; data: string }> {
	return new Promise((resolve, reject) => {
		const req = session.request({
			":method": "POST",
			":path": path,
			...headers,
		});
		req.setEncoding("utf8");
		let data = "";
		let status = 0;
		req.on("response", (h) => { status = h[":status"] as number; });
		req.on("data", (chunk) => { data += chunk; });
		req.on("end", () => resolve({ status, data }));
		req.on("error", reject);
		req.end(body);
	});
}

async function sendToApns(token: string, payload: PushPayload): Promise<void> {
	const jwt = await getApnsJwt();
	const session = getH2Session();

	const apnsPayload = Buffer.from(JSON.stringify({
		aps: {
			alert: {
				title: payload.title,
				body: payload.body,
			},
			sound: "default",
			"thread-id": payload.roomId,
			"mutable-content": 1,
		},
		roomId: payload.roomId,
		eventId: payload.eventId,
	}));

	const headers: Record<string, string> = {
		"authorization": `bearer ${jwt}`,
		"apns-topic": BUNDLE_ID,
		"apns-push-type": "alert",
		"apns-priority": "10",
		"content-type": "application/json",
	};

	const res = await h2Post(session, `/3/device/${token}`, headers, apnsPayload);

	if (res.status === 200) return;

	if (res.status === 410 || res.status === 400) {
		console.warn(`[push] APNs rejected token (${res.status}): ${res.data} — token=${token.slice(0, 16)}... topic=${BUNDLE_ID}`);
		return;
	}

	if (res.status === 403) {
		const body = JSON.parse(res.data || "{}") as { reason?: string };
		if (body.reason === "ExpiredProviderToken") {
			invalidateJwt();
			const retryJwt = await getApnsJwt();
			headers["authorization"] = `bearer ${retryJwt}`;
			const retry = await h2Post(session, `/3/device/${token}`, headers, apnsPayload);
			if (retry.status === 200) return;
			console.warn(`[push] APNs retry failed (${retry.status}) for ${token.slice(0, 8)}...`);
			return;
		}
		console.warn(`[push] APNs 403: ${body.reason}`);
		return;
	}

	console.warn(`[push] APNs unexpected status ${res.status} for ${token.slice(0, 8)}...`);
}

function buildTitle(kind: string, senderLocalpart: string): string {
	switch (kind) {
		case "dm": return senderLocalpart;
		case "mention": return `${senderLocalpart} mentioned you`;
		case "reply": return `${senderLocalpart} replied to you`;
		case "invite": return `${senderLocalpart} invited you`;
		case "message": return senderLocalpart;
		default: return senderLocalpart;
	}
}

function buildBody(kind: string, snippet: string | null): string {
	if (snippet) return snippet;
	switch (kind) {
		case "dm": return "Sent you a message";
		case "mention": return "Mentioned you in a message";
		case "reply": return "Replied to your message";
		case "invite": return "Invited you to a conversation";
		case "message": return "Sent a message";
		default: return "Sent a message";
	}
}

export function pushEnabled(): boolean {
	return !!(config.apnsKeyPath && config.apnsKeyId && config.apnsTeamId);
}

export async function sendPushNotifications(
	recipientIds: string[],
	opts: {
		kind: string;
		sender: string;
		snippet: string | null;
		roomId: string;
		eventId: string;
	},
): Promise<void> {
	if (!pushEnabled()) return;

	const tokens = listPushTokensForUsers(recipientIds);
	if (tokens.length === 0) return;

	const senderLocalpart = opts.sender.startsWith("@")
		? opts.sender.slice(1).split(":")[0] ?? opts.sender
		: opts.sender;

	const title = buildTitle(opts.kind, senderLocalpart);
	const body = buildBody(opts.kind, opts.snippet);

	const promises: Promise<void>[] = [];
	for (const t of tokens) {
		if (t.platform === "ios") {
			promises.push(
				sendToApns(t.token, {
					title,
					body,
					roomId: opts.roomId,
					eventId: opts.eventId,
				}).catch(err => {
					console.warn(`[push] APNs send failed for ${t.user_id}:`, err);
				}),
			);
		}
	}

	if (promises.length > 0) {
		await Promise.allSettled(promises);
	}
}

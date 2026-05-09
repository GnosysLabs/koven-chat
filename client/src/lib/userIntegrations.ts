// Engine HTTP client for per-user integration credentials.  Mirrors
// the typed-wrapper pattern of lib/instance.ts and lib/notifications-
// api.ts — every call carries the user's Matrix access token, the
// engine identifies the caller via whoami, the value of the secret
// itself never round-trips back to the client.

import { ENGINE_URL } from "@/lib/urls";

export interface UserIntegrationsStatus {
	smithery: { configured: boolean };
}

interface UserIntegrationsResponse {
	integrations: UserIntegrationsStatus;
}

/** Fetch presence-only status for every per-user integration.
 * Caller can render "Configured" / "Not configured" badges without
 * ever holding the credential. */
export async function fetchUserIntegrationsStatus(
	accessToken: string,
): Promise<UserIntegrationsStatus> {
	const r = await fetch(`${ENGINE_URL}/api/me/integrations`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) throw new Error(`integrations: ${r.status}`);
	const body = (await r.json()) as UserIntegrationsResponse;
	return body.integrations;
}

/** Store / replace the user's Smithery API key.  Engine seals the
 * value with sealSecret before persisting; subsequent reads return
 * presence only.  Empty/whitespace api_key returns 400. */
export async function setSmitheryApiKey(
	accessToken: string,
	apiKey: string,
): Promise<void> {
	const r = await fetch(`${ENGINE_URL}/api/me/integrations/smithery`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ api_key: apiKey }),
	});
	if (!r.ok) {
		const body = (await r.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `setSmitheryApiKey: ${r.status}`);
	}
}

/** Drop the user's stored Smithery key.  Idempotent — clearing a
 * key that was never set is a no-op success. */
export async function clearSmitheryApiKey(accessToken: string): Promise<void> {
	const r = await fetch(`${ENGINE_URL}/api/me/integrations/smithery`, {
		method: "DELETE",
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!r.ok) {
		throw new Error(`clearSmitheryApiKey: ${r.status}`);
	}
}

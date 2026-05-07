// User-bio client.  Bios live on the engine, not in Matrix, because
// the Matrix profile API has fixed fields and account_data is private
// to the owner — neither lets us surface bios to other people.  Reads
// are public; writes require the owner's Matrix access token.

import { ENGINE_URL } from "@/lib/urls";

export interface UserBioResponse {
	user_id: string;
	bio: string;
}

export async function fetchUserBio(userId: string): Promise<string> {
	const r = await fetch(`${ENGINE_URL}/api/profile/${encodeURIComponent(userId)}`, {
		credentials: "omit",
	});
	if (!r.ok) return "";
	const body = (await r.json()) as UserBioResponse;
	return body.bio ?? "";
}

export async function updateMyBio(accessToken: string, bio: string): Promise<string> {
	const r = await fetch(`${ENGINE_URL}/api/profile/me`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ bio }),
	});
	if (!r.ok) {
		const body = await r.json().catch(() => ({})) as { error?: string };
		throw new Error(body.error ?? `engine PUT /api/profile/me → ${r.status}`);
	}
	const body = (await r.json()) as UserBioResponse;
	return body.bio ?? "";
}

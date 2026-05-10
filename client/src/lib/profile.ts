// User-bio + founder-status client.  Bios live on the engine, not in
// Matrix, because the Matrix profile API has fixed fields and
// account_data is private to the owner — neither lets us surface
// bios to other people.  Founder number rides on the same response
// to save a second round-trip when opening a profile.  Reads are
// public; writes require the owner's Matrix access token.

import { ENGINE_URL } from "@/lib/urls";

export interface UserBioResponse {
	user_id: string;
	bio: string;
}

export interface UserProfileResponse {
	user_id: string;
	bio: string;
	// Numerical Founder slot (1..666) for users who claimed one;
	// null otherwise.  Drives the holographic Founder badge on the
	// profile sheet.
	founder_number: number | null;
}

export async function fetchUserBio(userId: string): Promise<string> {
	const r = await fetch(`${ENGINE_URL}/api/profile/${encodeURIComponent(userId)}`, {
		credentials: "omit",
	});
	if (!r.ok) return "";
	const body = (await r.json()) as UserBioResponse;
	return body.bio ?? "";
}

/** Fetch the full profile (bio + founder number) for a user.
 * Use this in the profile sheet where both pieces of data are
 * visible at the same time.  Returns nulls for missing fields
 * rather than throwing so the sheet always renders. */
export async function fetchUserProfile(userId: string): Promise<UserProfileResponse> {
	const r = await fetch(`${ENGINE_URL}/api/profile/${encodeURIComponent(userId)}`, {
		credentials: "omit",
	});
	if (!r.ok) {
		return { user_id: userId, bio: "", founder_number: null };
	}
	const body = (await r.json()) as UserProfileResponse;
	return {
		user_id: body.user_id ?? userId,
		bio: body.bio ?? "",
		founder_number: typeof body.founder_number === "number" ? body.founder_number : null,
	};
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

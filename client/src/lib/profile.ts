// User-bio + founder-status + social-links client.  All live on the
// engine because the Matrix profile API has fixed fields and
// account_data is private to the owner.  Reads are public; writes
// require the owner's Matrix access token.

import { ENGINE_URL } from "@/lib/urls";

export interface SocialLink {
	platform: string;
	url: string;
}

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
	social_links: SocialLink[];
	// mxc:// URI of the user's profile banner image, or null when
	// unset.  The bytes live in the Matrix media repo; the engine
	// only stores this pointer.
	banner_mxc: string | null;
	// Whether this user appears in the public People directory.
	// Default true.  Absent from older engine responses, so treat
	// missing as true.
	discoverable?: boolean;
}

export async function fetchUserBio(userId: string): Promise<string> {
	const r = await fetch(`${ENGINE_URL}/api/profile/${encodeURIComponent(userId)}`, {
		credentials: "omit",
	});
	if (!r.ok) return "";
	const body = (await r.json()) as UserBioResponse;
	return body.bio ?? "";
}

/** Fetch the full profile (bio + founder number + social links) for a user. */
export async function fetchUserProfile(userId: string): Promise<UserProfileResponse> {
	const r = await fetch(`${ENGINE_URL}/api/profile/${encodeURIComponent(userId)}`, {
		credentials: "omit",
	});
	if (!r.ok) {
		return { user_id: userId, bio: "", founder_number: null, social_links: [], banner_mxc: null };
	}
	const body = (await r.json()) as UserProfileResponse;
	return {
		user_id: body.user_id ?? userId,
		bio: body.bio ?? "",
		founder_number: typeof body.founder_number === "number" ? body.founder_number : null,
		social_links: Array.isArray(body.social_links) ? body.social_links : [],
		banner_mxc: typeof body.banner_mxc === "string" ? body.banner_mxc : null,
	};
}

/** Update the current user's bio, social links, banner and/or discoverability in one request. */
export async function updateMyProfileData(
	accessToken: string,
	data: { bio?: string; social_links?: SocialLink[]; banner_mxc?: string | null; discoverable?: boolean },
): Promise<void> {
	const r = await fetch(`${ENGINE_URL}/api/profile/me`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify(data),
	});
	if (!r.ok) {
		const body = await r.json().catch(() => ({})) as { error?: string };
		throw new Error(body.error ?? `engine PUT /api/profile/me → ${r.status}`);
	}
}

/** @deprecated Use updateMyProfileData instead. */
export async function updateMyBio(accessToken: string, bio: string): Promise<string> {
	await updateMyProfileData(accessToken, { bio });
	return bio;
}

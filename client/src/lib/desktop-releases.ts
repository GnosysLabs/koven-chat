// GitHub Releases lookup for the koven-desktop builds.  The download
// UI on the login screen needs the current `desktop-v*` release's
// asset URLs without us hardcoding the version (every release
// would otherwise need a parallel SPA edit).  This module hits
// `releases/latest` once per page-load, parses the chunk by file
// extension, and returns a typed map.
//
// Cached at module scope so re-mounting the Login screen (or
// re-rendering after a state change) doesn't refetch.  Failure modes
// — rate limit, network hiccup, no published release yet — return
// `null`; the consumer's responsibility to fall back to a generic
// "Downloads page" link.
//
// We're not authenticating against the GitHub API; the unauth limit
// is 60 calls per IP per hour, which is plenty for the login surface.

import { useEffect, useState } from "react";

export interface DesktopReleases {
	version: string;
	releaseUrl: string;
	macos?: string;          // .app.tar.gz
	windows?: string;        // -setup.exe (NSIS)
	linuxAppImage?: string;
}

const REPO = "GnosysLabs/koven-chat";
const TAG_PREFIX = "desktop-v";

let cached: DesktopReleases | null | undefined = undefined;
let inFlight: Promise<DesktopReleases | null> | null = null;

async function fetchOnce(): Promise<DesktopReleases | null> {
	const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
		headers: { Accept: "application/vnd.github+json" },
	}).catch(() => null);
	if (!r || !r.ok) return null;
	const body = (await r.json().catch(() => null)) as {
		tag_name?: string;
		html_url?: string;
		assets?: Array<{ name?: string; browser_download_url?: string }>;
	} | null;
	if (!body || typeof body.tag_name !== "string") return null;

	// Defend against a non-desktop "latest" release on the same repo
	// (we don't tag anything else under this prefix, but treat this
	// as a soft assertion against future drift).
	if (!body.tag_name.startsWith(TAG_PREFIX)) return null;

	const version = body.tag_name.slice(TAG_PREFIX.length);
	const out: DesktopReleases = {
		version,
		releaseUrl: body.html_url ?? `https://github.com/${REPO}/releases/tag/${body.tag_name}`,
	};
	for (const asset of body.assets ?? []) {
		const name = asset.name ?? "";
		const url = asset.browser_download_url ?? "";
		if (!name || !url) continue;
		// Pick by suffix.  tauri-action also writes `.sig` files
		// alongside each artifact; those are minisign signatures the
		// in-app updater consumes and aren't user-downloads, so
		// ignore them here.
		if (name.endsWith(".app.tar.gz")) out.macos = url;
		else if (name.endsWith("-setup.exe")) out.windows = url;
		else if (name.endsWith(".AppImage")) out.linuxAppImage = url;
	}
	return out;
}

/**
 * React hook that returns the cached desktop-release info, kicking
 * off the fetch on first mount.  Re-renders once when the fetch
 * completes.  Returns `undefined` while the request is in flight,
 * `null` on failure / no release yet, or the parsed map on success.
 *
 * Components consuming this should branch on all three states
 * — render nothing on `undefined` (in-flight) so the buttons don't
 * pop in mid-paint; show a fallback link to the GitHub Releases
 * page when `null`.
 */
export function useDesktopReleases(): DesktopReleases | null | undefined {
	const [state, setState] = useState<DesktopReleases | null | undefined>(cached);

	useEffect(() => {
		if (cached !== undefined) {
			setState(cached);
			return;
		}
		if (!inFlight) {
			inFlight = fetchOnce().then(r => {
				cached = r;
				inFlight = null;
				return r;
			});
		}
		let cancelled = false;
		inFlight.then(r => {
			if (!cancelled) setState(r);
		});
		return () => { cancelled = true; };
	}, []);

	return state;
}

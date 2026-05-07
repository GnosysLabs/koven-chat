// MatrixAvatar — render an avatar for a user, room, or anything with
// an mxc:// URL.  Auth-fetches the underlying bytes into a blob: URL
// (modern Synapse requires authenticated media; <img> can't send the
// Authorization header, so we fetch ourselves) and falls back to the
// auto-generated DiceBear avatar based on the seed when no mxc is
// set or the fetch fails.
//
// Only show the DiceBear fallback when there's no mxc to begin with.
// While an mxc is in flight we render a transparent placeholder so we
// don't flash the wrong identity ("user has the cute robot" → "no wait,
// it's their face") right before the real avatar arrives.

import { cn } from "@/lib/utils";
import { autoAvatarUrl, type AvatarKind } from "@/lib/avatar";
import { useMatrixMedia } from "@/lib/useMatrixMedia";

export interface MatrixAvatarProps {
	mxc?: string;
	// Optional emoji glyph that takes priority over both the mxc image
	// AND the DiceBear fallback.  Used by rooms/spaces whose owner has
	// picked an emoji icon via Settings.  Renders as a centered glyph
	// over a muted-colored tile keyed off `seed` so two emoji-iconed
	// rooms don't blend into one another visually.
	emoji?: string;
	seed: string;             // e.g. user id or room id — drives the auto-avatar
	kind?: AvatarKind;        // selects DiceBear style for fallback (default: user)
	className?: string;       // size + extra styling
}

export function MatrixAvatar({ mxc, emoji, seed, kind = "user", className }: MatrixAvatarProps) {
	const blobUrl = useMatrixMedia(mxc);

	// Emoji wins.  A picked emoji is the room's chosen identity — even
	// if an old mxc avatar is still on the room state event, the emoji
	// supersedes it visually.  Background uses the active theme's
	// accent color so emoji-iconed rooms inherit the user's palette
	// (Plum users see a soft purple tile, Forest users see a green
	// one, etc.) rather than a fixed hardcoded hue.
	//
	// Rendered as inline SVG: <text> auto-scales with the viewBox, so
	// the emoji always fills the tile at the same proportion no matter
	// what size the consumer's className applies (h-7, h-20, doesn't
	// matter — viewBox 0..100 + fontSize 56 always gives the same look).
	if (emoji) {
		return (
			<svg
				viewBox="0 0 100 100"
				className={cn(
					"rounded-full shrink-0 select-none bg-accent",
					className,
				)}
				aria-hidden
			>
				<text
					x="50"
					y="50"
					textAnchor="middle"
					dominantBaseline="central"
					fontSize="56"
				>
					{emoji}
				</text>
			</svg>
		);
	}

	// Three render states:
	//   1. mxc set + blob ready → real avatar
	//   2. mxc set + blob loading → muted placeholder (no fallback flash)
	//   3. no mxc → DiceBear fallback (this user has no real avatar)
	if (mxc) {
		if (blobUrl) {
			return (
				<img
					src={blobUrl}
					alt=""
					className={cn("rounded-full bg-muted shrink-0 object-cover", className)}
				/>
			);
		}
		return (
			<div
				className={cn("rounded-full bg-muted shrink-0", className)}
				aria-hidden
			/>
		);
	}

	return (
		<img
			src={autoAvatarUrl(seed, kind)}
			alt=""
			className={cn("rounded-full bg-muted shrink-0 object-cover", className)}
		/>
	);
}


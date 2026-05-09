// Default avatar fallback — when a user/room/space hasn't uploaded
// one we render a DiceBear SVG seeded from a stable identifier (user
// id, room id, space id), so the same entity always gets the same
// generated avatar.  No API key, no rate limit at our scale, SVG so
// it stays crisp at any size.
//
// Style choices are deliberate per kind:
//   - users:  fun-emoji      (cute single-glyph faces).  fun-emoji has
//                             a limited base-face set, so two seeds
//                             often pick the same face — to keep the
//                             style but reduce visual collisions, we
//                             pass an expanded `backgroundColor`
//                             palette so even matching faces sit on
//                             distinct hues.
//   - rooms:  shapes         (abstract geometric — clearly inanimate)
//   - spaces: glass          (translucent gradient blobs — heavier
//                             visual weight that reads as "container
//                             of rooms")
//   - bots:   bottts-neutral (cute robots — visibly non-human, stays
//                             on-brand with the BOT badge so a glance
//                             at the avatar already tells you it's
//                             an automated account)

export type AvatarKind = "user" | "room" | "space" | "bot";

const STYLE_BY_KIND: Record<AvatarKind, string> = {
	user: "fun-emoji",
	room: "shapes",
	space: "glass",
	bot: "bottts-neutral",
};

// Expanded background palette for fun-emoji — DiceBear deterministically
// picks one entry based on the seed, so widening the list spreads
// collisions across more hues.  Default DiceBear palette is just four
// pale pastels; this version is 14 hand-picked hex codes covering
// the rainbow at saturation/lightness that pairs well with fun-emoji's
// yellow-glyph faces.  No octothorpes — DiceBear expects bare hex.
const FUN_EMOJI_BG_PALETTE = [
	"ffd5dc", // pink
	"f4b4c4", // rose
	"f7c5a2", // peach
	"f9e2af", // soft yellow
	"d6f5c5", // mint
	"a8e6cf", // teal
	"b6e3f4", // sky
	"a3c4f3", // periwinkle
	"c0aede", // lavender
	"d4a5e8", // orchid
	"f5b6e0", // bubblegum
	"d1d4f9", // ice
	"e2d4b7", // sand
	"ffb3ba", // coral
];

// Allowlists for fun-emoji's facial features.  By default DiceBear
// picks from the full set, which includes sad / crying / pissed
// expressions — those landing on a real person's avatar reads as
// the app calling them sad, which is a bummer.  Restrict to the
// expressive-but-positive subset so every generated face feels
// neutral-to-friendly.  The remaining variation across mouth ×
// eye combos is enough to keep avatars distinct.
const FUN_EMOJI_MOUTHS = [
	"cute",
	"kissHeart",
	"lilSmile",
	"plain",
	"shock",          // surprised, not sad
	"smileLol",
	"smileTeeth",
	"tongueOut",
	"wideSmile",
];
const FUN_EMOJI_EYES = [
	"closed",
	"closed2",
	"cute",
	"glasses",
	"love",
	"plain",
	"shades",
	"sleepClose",
	"stars",
	"wink",
	"wink2",
];

export function autoAvatarUrl(seed: string, kind: AvatarKind = "user"): string {
	const style = STYLE_BY_KIND[kind];
	const params = new URLSearchParams();
	params.set("seed", seed);
	if (kind === "user") {
		params.set("backgroundColor", FUN_EMOJI_BG_PALETTE.join(","));
		params.set("mouth", FUN_EMOJI_MOUTHS.join(","));
		params.set("eyes", FUN_EMOJI_EYES.join(","));
	}
	return `https://api.dicebear.com/9.x/${style}/svg?${params.toString()}`;
}

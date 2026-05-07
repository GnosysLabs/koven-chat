// Default avatar fallback — when a user/room/space hasn't uploaded
// one we render a DiceBear SVG seeded from a stable identifier (user
// id, room id, space id), so the same entity always gets the same
// generated avatar.  No API key, no rate limit at our scale, SVG so
// it stays crisp at any size.
//
// Style choices are deliberate per kind:
//   - users:  fun-emoji  (faces, friendly, distinct)
//   - rooms:  shapes     (abstract geometric — clearly inanimate)
//   - spaces: glass      (translucent gradient blobs — heavier visual
//                         weight that reads as "container of rooms")

export type AvatarKind = "user" | "room" | "space";

const STYLE_BY_KIND: Record<AvatarKind, string> = {
	user: "fun-emoji",
	room: "shapes",
	space: "glass",
};

export function autoAvatarUrl(seed: string, kind: AvatarKind = "user"): string {
	const style = STYLE_BY_KIND[kind];
	return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(seed)}`;
}

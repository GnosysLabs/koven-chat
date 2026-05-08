// Global UI settings, persisted to localStorage.  Read with
// `loadSettings()` at startup; write with `saveSettings(next)` whenever
// the user toggles something.

export type Theme =
	| "midnight"   // neutral dark (shadcn zinc default)
	| "plum"       // dark purple/indigo
	| "forest"     // dark pine green
	| "mahogany"   // dark warm wood + amber accent (was "ember" pre-rename)
	| "ember"      // dark red, glowing-coal accent
	| "aurora"     // dark teal/cyan
	| "cosmos"     // dark magenta/violet/indigo nebula
	| "sunset"     // dark pink/orange/purple
	| "neon"       // dark cyberpunk cyan + magenta
	| "daylight"   // neutral light
	| "sand"       // light warm cream
	| "mint"       // light cool sage
	| "blush"      // light warm rose pink (replaced "peach" in v3)
	| "lilac"      // light violet/rose
	| "seaglass";  // light aqua/mint

// Theme metadata used by the picker UI.  `mode` decides whether we
// add the `dark` class on <html>.  `swatch` is a CSS background value
// — typically a gradient — drawn into the picker circle so the theme's
// vibe is visible at a glance.
export interface ThemeDescriptor {
	id: Theme;
	label: string;
	mode: "dark" | "light";
	swatch: string;
}

export const THEMES: ThemeDescriptor[] = [
	{
		id: "midnight",
		label: "Midnight",
		mode: "dark",
		swatch: "linear-gradient(135deg, hsl(240 10% 22%) 0%, hsl(240 10% 12%) 50%, hsl(240 10% 4%) 100%)",
	},
	{
		id: "plum",
		label: "Plum",
		mode: "dark",
		swatch: "linear-gradient(135deg, hsl(310 80% 65%) 0%, hsl(280 70% 45%) 35%, hsl(270 50% 18%) 75%, hsl(270 30% 6%) 100%)",
	},
	{
		id: "forest",
		label: "Forest",
		mode: "dark",
		swatch: "linear-gradient(135deg, hsl(80 70% 55%) 0%, hsl(145 65% 45%) 35%, hsl(155 45% 18%) 75%, hsl(150 25% 6%) 100%)",
	},
	{
		id: "mahogany",
		label: "Mahogany",
		mode: "dark",
		// Wood-grain gradient: warm tan → mid sienna → dark walnut → near-black.
		// Reads as polished wood, matching the chrome's actual feel
		// (back when this entry was called "Ember" the swatch leaned
		// fire-y but the applied palette never did).
		swatch: "linear-gradient(135deg, hsl(30 55% 58%) 0%, hsl(20 60% 38%) 35%, hsl(15 65% 20%) 75%, hsl(16 30% 6%) 100%)",
	},
	{
		id: "ember",
		label: "Ember",
		mode: "dark",
		// Glowing-coal gradient: orange-red highlight → vivid red →
		// deep crimson → charcoal.  Matches the new actually-red Ember
		// palette in index.css.
		swatch: "linear-gradient(135deg, hsl(20 95% 62%) 0%, hsl(5 90% 55%) 35%, hsl(355 75% 32%) 75%, hsl(0 35% 6%) 100%)",
	},
	{
		id: "aurora",
		label: "Aurora",
		mode: "dark",
		swatch: "linear-gradient(135deg, hsl(155 80% 65%) 0%, hsl(185 80% 55%) 35%, hsl(220 70% 30%) 75%, hsl(200 40% 6%) 100%)",
	},
	{
		id: "cosmos",
		label: "Cosmos",
		mode: "dark",
		swatch: "linear-gradient(135deg, hsl(330 90% 70%) 0%, hsl(300 80% 55%) 25%, hsl(260 70% 40%) 55%, hsl(220 60% 22%) 80%, hsl(250 40% 6%) 100%)",
	},
	{
		id: "sunset",
		label: "Sunset",
		mode: "dark",
		swatch: "linear-gradient(135deg, hsl(340 95% 75%) 0%, hsl(15 95% 65%) 30%, hsl(330 70% 45%) 60%, hsl(280 50% 22%) 85%, hsl(285 30% 6%) 100%)",
	},
	{
		id: "neon",
		label: "Neon",
		mode: "dark",
		swatch: "linear-gradient(135deg, hsl(320 100% 70%) 0%, hsl(280 90% 55%) 30%, hsl(180 100% 50%) 70%, hsl(240 60% 10%) 100%)",
	},
	{
		id: "daylight",
		label: "Daylight",
		mode: "light",
		swatch: "linear-gradient(135deg, hsl(0 0% 100%) 0%, hsl(240 8% 92%) 50%, hsl(240 8% 80%) 100%)",
	},
	{
		id: "sand",
		label: "Sand",
		mode: "light",
		swatch: "linear-gradient(135deg, hsl(50 90% 96%) 0%, hsl(35 85% 85%) 40%, hsl(25 80% 65%) 80%, hsl(15 70% 55%) 100%)",
	},
	{
		id: "mint",
		label: "Mint",
		mode: "light",
		swatch: "linear-gradient(135deg, hsl(170 60% 95%) 0%, hsl(155 60% 75%) 40%, hsl(150 60% 50%) 80%, hsl(160 65% 35%) 100%)",
	},
	{
		id: "blush",
		label: "Blush",
		mode: "light",
		// Pale rose → warm pink → deep rose.  Stays in the 340° hue
		// family so it reads as pink, not the cream-orange the old
		// Peach swatch implied.
		swatch: "linear-gradient(135deg, hsl(340 80% 95%) 0%, hsl(340 75% 80%) 40%, hsl(340 70% 60%) 75%, hsl(340 65% 45%) 100%)",
	},
	{
		id: "lilac",
		label: "Lilac",
		mode: "light",
		swatch: "linear-gradient(135deg, hsl(40 85% 95%) 0%, hsl(330 70% 85%) 35%, hsl(285 65% 70%) 70%, hsl(265 60% 55%) 100%)",
	},
	{
		id: "seaglass",
		label: "Seaglass",
		mode: "light",
		swatch: "linear-gradient(135deg, hsl(50 60% 96%) 0%, hsl(150 55% 85%) 35%, hsl(180 60% 65%) 70%, hsl(200 70% 45%) 100%)",
	},
];

const THEME_IDS = new Set(THEMES.map(t => t.id));

export interface Settings {
	theme: Theme;
	// Show NSFW-flagged rooms and spaces in Explore (search + browse).
	// Default false — adult-content rooms stay invisible from
	// discovery until the user opts in.  Has no effect on rooms the
	// user is already joined to: once you're in, you're in.  Stored
	// in localStorage rather than m.account_data because it's a
	// per-device discovery preference, not a profile property.
	showNsfw?: boolean;
	// Bump every time we change theme ids so loadSettings can migrate
	// existing localStorage forward.  Don't read this elsewhere.
	_v?: number;
}

// Bumped when we rename or repurpose theme ids.  See migrations in
// loadSettings.  Currently:
//   1: "ember" was the warm-wood theme.
//   2: "ember" repurposed for a red palette; old wood theme moved to
//      a new "mahogany" id.  Existing v<2 entries with theme "ember"
//      get remapped to "mahogany" so the user's chrome doesn't change
//      out from under them.
//   3: "peach" replaced with "blush" (the old peach was nearly
//      identical to sand; blush is a true pink in the 340° hue range).
//      Existing v<3 entries with theme "peach" get remapped to "blush".
const SETTINGS_VERSION = 3;

export const DEFAULT_SETTINGS: Settings = {
	theme: "midnight",
	showNsfw: false,
	_v: SETTINGS_VERSION,
};

const KEY = "koven:settings";

export function loadSettings(): Settings {
	try {
		const raw = window.localStorage.getItem(KEY);
		if (!raw) {
			const prefersLight = typeof window.matchMedia === "function"
				&& window.matchMedia("(prefers-color-scheme: light)").matches;
			return { ...DEFAULT_SETTINGS, theme: prefersLight ? "daylight" : "midnight" };
		}
		const parsed = JSON.parse(raw) as Partial<Settings>;
		// Forward-migrations.  Apply oldest first.
		const v = typeof parsed._v === "number" ? parsed._v : 1;
		if (v < 2 && parsed.theme === "ember") {
			// "ember" used to mean warm-wood; renamed to "mahogany".
			parsed.theme = "mahogany" as Theme;
		}
		if (v < 3 && (parsed.theme as string) === "peach") {
			// "peach" was a near-duplicate of "sand"; replaced with
			// "blush" (a true pink).  Old peach users get blush.
			parsed.theme = "blush" as Theme;
		}
		parsed._v = SETTINGS_VERSION;
		// Migrate older "light"/"dark" values to the new named themes.
		const t = parsed.theme as string | undefined;
		if (t === "light") parsed.theme = "daylight";
		else if (t === "dark") parsed.theme = "midnight";
		else if (t && !THEME_IDS.has(t as Theme)) parsed.theme = "midnight";
		return { ...DEFAULT_SETTINGS, ...parsed };
	} catch {
		return DEFAULT_SETTINGS;
	}
}

export function saveSettings(s: Settings): void {
	try { window.localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/**
 * Apply theme to <html> by setting the `data-theme` attribute and
 * toggling the `dark` class.  The shadcn token overrides we ship in
 * index.css key off both — `data-theme="<id>"` selects the palette,
 * `dark` selects the light/dark base.
 */
export function applyTheme(theme: Theme): void {
	const root = document.documentElement;
	const desc = THEMES.find(t => t.id === theme) ?? THEMES[0]!;
	root.setAttribute("data-theme", desc.id);
	if (desc.mode === "dark") root.classList.add("dark");
	else root.classList.remove("dark");
}

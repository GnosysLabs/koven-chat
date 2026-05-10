// Full-screen sheet that mounts Cloudflare's RealtimeKit UI Kit
// for the actual in-call experience.  Voice channels in Koven open
// this when the user clicks Join Voice; the sheet covers the chat
// pane while the call is live.
//
// We use the prebuilt <RtkMeeting /> component from the UI Kit
// rather than building our own grid + controls — Cloudflare's
// component handles every WebRTC / device / browser quirk we'd
// otherwise reinvent badly.  We pass a Koven-themed palette derived
// from the user's current CSS theme variables (HSL → hex) into the
// UIConfig.designTokens so buttons / inputs / dropdowns match the
// rest of the app, and overlay our pulsing favicon at the top of
// the dialog so the SetupScreen breath looks like Koven, not
// Cloudflare.
//
// Lifecycle:
//   1. Sheet opens with `authToken` prop (minted by engine on Join)
//   2. useRealtimeKitClient connects to Cloudflare's signaling
//      using the JWT
//   3. When connected, <RtkMeeting> renders the SetupScreen → on
//      user-Join → the full call UI
//   4. User clicks Leave → SDK fires roomLeft → we close the sheet
//
// One token, one connection.  The auth tokens are single-use per
// the RealtimeKit docs, so each open of this sheet should be
// preceded by a fresh /api/calls/:roomId/join call (handled in
// RoomVoiceBar.tsx where the click originates).

import { useEffect, useMemo, useState } from "react";
import {
	RealtimeKitProvider,
	useRealtimeKitClient,
} from "@cloudflare/realtimekit-react";
import { RtkMeeting } from "@cloudflare/realtimekit-react-ui";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
} from "@/components/ui/dialog";

export interface VoiceCallSheetProps {
	open: boolean;
	authToken: string | null;
	roomName: string;
	onClose(): void;
}

// ─── Theme bridge ─────────────────────────────────────────────────
//
// Our app stores theme colors as raw HSL components in CSS custom
// properties (`--primary: 240 5.9% 10%`, no hsl() wrapper, see
// `client/src/index.css`).  The RealtimeKit design-token system
// wants hex codes.  We resolve the variables at runtime and convert.
//
// We re-resolve whenever the dialog opens (themes can change) but
// not on every render, since reading CSS vars + converting is
// cheap-ish but not free.

function hslVarToHex(varName: string, fallback: string): string {
	if (typeof window === "undefined") return fallback;
	const raw = getComputedStyle(document.documentElement)
		.getPropertyValue(varName)
		.trim();
	if (!raw) return fallback;
	// Parse "H S% L%" or "H,S%,L%" — both shapes appear in the wild.
	const parts = raw.replace(/,/g, " ").split(/\s+/).filter(Boolean);
	if (parts.length < 3) return fallback;
	const h = parseFloat(parts[0]!);
	const s = parseFloat(parts[1]!) / 100;
	const l = parseFloat(parts[2]!) / 100;
	if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return fallback;
	// Standard HSL → RGB.  Pulled from MDN reference; unrolled for
	// no-deps + minimal overhead.
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => {
		const v = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
		return Math.round(v * 255);
	};
	const toHex = (n: number) => n.toString(16).padStart(2, "0");
	return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/** Build a RealtimeKit UIConfig.designTokens.colors object from the
 *  user's current CSS theme.  The brand ramp (300-700) is the
 *  primary button color, the background ramp (600-1000) is the
 *  surface/dropdown chrome, text is foreground.  We give the brand
 *  ramp a 5-stop spread by lightening / darkening primary because
 *  Koven only stores one primary value, while RealtimeKit wants a
 *  scale.
 */
function buildRtkColors() {
	const primary = hslVarToHex("--primary", "#a855f7");
	const primaryFg = hslVarToHex("--primary-foreground", "#ffffff");
	const background = hslVarToHex("--background", "#0a0a0f");
	const card = hslVarToHex("--card", "#0f0f17");
	const accent = hslVarToHex("--accent", "#1a1a23");
	const muted = hslVarToHex("--muted", "#1a1a23");
	const fg = hslVarToHex("--foreground", "#fafafa");
	const destructive = hslVarToHex("--destructive", "#ef4444");

	return {
		brand: {
			300: shadeHex(primary, 0.4),
			400: shadeHex(primary, 0.2),
			500: primary,
			600: shadeHex(primary, -0.2),
			700: shadeHex(primary, -0.4),
		},
		background: {
			1000: background,
			900: card,
			800: muted,
			700: accent,
			600: shadeHex(accent, 0.2),
		},
		text: fg,
		"text-on-brand": primaryFg,
		"video-bg": background,
		danger: destructive,
		success: "#22c55e",
		warning: "#eab308",
	} as const;
}

/** Lighten / darken a hex color by a factor in [-1, 1].
 *  +0.2 → 20% lighter, -0.2 → 20% darker.  Used to synthesize the
 *  brand ramp from a single primary color.  Channel-wise mix toward
 *  white (lighten) or black (darken). */
function shadeHex(hex: string, amount: number): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!m) return hex;
	const n = parseInt(m[1]!, 16);
	const r = (n >> 16) & 0xff;
	const g = (n >> 8) & 0xff;
	const b = n & 0xff;
	const mix = (c: number) => {
		const target = amount > 0 ? 255 : 0;
		const v = Math.round(c + (target - c) * Math.abs(amount));
		return Math.max(0, Math.min(255, v));
	};
	const toHex = (v: number) => v.toString(16).padStart(2, "0");
	return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

// ─── i18n override ────────────────────────────────────────────────
//
// The default SetupScreen reads `setup_screen.join_in_as` to print
// "Joining as" above the (auto-filled) name input.  We don't want
// that label — the participant's display name is already baked
// into the JWT and shown elsewhere — so blank it out.  The rest of
// the strings get a light Koven-ification (capitalization tweaks).

const RTK_STRINGS: Record<string, string> = {
	"setup_screen.join_in_as": "",
	"setup_screen.your_name": "Your name",
	"join": "Join Live",
};

export function VoiceCallSheet({ open, authToken, roomName, onClose }: VoiceCallSheetProps) {
	// useRealtimeKitClient returns [client, init].  Init is async
	// and the SDK opens a websocket to Cloudflare's signaling
	// service, exchanges SDP, and resolves the client object.
	const [meeting, initMeeting] = useRealtimeKitClient();

	// Re-derive the theme tokens whenever the dialog opens.  Cheap,
	// and accommodates theme switches between calls.
	const [themeTick, setThemeTick] = useState(0);
	useEffect(() => {
		if (open) setThemeTick(t => t + 1);
	}, [open]);

	const rtkConfig = useMemo(() => ({
		designTokens: {
			theme: "darkest" as const,
			borderRadius: "rounded" as const,
			spacingBase: 4,
			fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
			colors: buildRtkColors(),
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}), [themeTick]);

	// i18n function — returns the override if present, falls back to
	// the key (RealtimeKit accepts a function shape for `t`).  The
	// types want the full union of i18n keys, so we cast to `any`
	// at the call site.  Empty string for `setup_screen.join_in_as`
	// removes the "Joining as" label entirely.
	const rtkT = useMemo(() => {
		return (key: string) => RTK_STRINGS[key] ?? key;
	}, []);

	// Wire up the Cloudflare client whenever we have a fresh token.
	// Re-init if the token changes (which happens when the user
	// re-joins after a leave — we mint a new token each time).
	useEffect(() => {
		if (!open || !authToken) return;
		void initMeeting({
			authToken,
			defaults: {
				audio: false,   // start with mic muted - user explicitly enables
				video: false,   // ditto camera
			},
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, authToken]);

	// The SDK fires a "roomLeft" event when the participant exits
	// (leave button, kicked, network teardown, etc.).  We close the
	// sheet on that signal so the chat pane comes back into view.
	useEffect(() => {
		if (!meeting) return;
		const onLeft = () => onClose();
		meeting.self.on("roomLeft", onLeft);
		return () => {
			try {
				meeting.self.off("roomLeft", onLeft);
			} catch {
				// idempotent — SDK has already torn down
			}
		};
	}, [meeting, onClose]);

	return (
		<Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
			<DialogContent className="max-w-[1200px] w-[95vw] h-[85vh] p-0 overflow-hidden flex flex-col bg-background">
				<DialogHeader className="sr-only">
					<DialogTitle>Voice channel — {roomName}</DialogTitle>
					<DialogDescription>
						Live voice and video call for {roomName}.  Use the
						control bar at the bottom to mute, share screen,
						or leave.
					</DialogDescription>
				</DialogHeader>
				<div className="flex-1 min-h-0 flex flex-col">
					{meeting ? (
						<RealtimeKitProvider value={meeting}>
							{/* Pulsing brand mark + room name pinned to
							    the top of the dialog while in the
							    SetupScreen breath, so the participant
							    sees "this is Koven, we're connecting you
							    to <room>" above the camera preview +
							    device pickers.  Once joined the in-call
							    UI fills the whole sheet beneath. */}
							<div className="flex flex-col items-center gap-2 pt-6 pb-2 shrink-0">
								<img
									src="/favicon.png"
									alt=""
									aria-hidden
									className="h-12 w-12 animate-pulse"
									style={{ animationDuration: "1.6s" }}
								/>
								<div className="text-sm font-medium text-foreground">
									{roomName}
								</div>
							</div>
							<div className="flex-1 min-h-0">
								{/* The Web-Component-backed RtkMeeting is the
								    full prebuilt call UI — participant grid,
								    control bar, chat panel, polls, the works.
								    style fills the dialog so it doesn't sit on
								    top of a margin.  The `config` prop is the
								    bridge between our CSS theme and Cloudflare's
								    design-token system. */}
								<RtkMeeting
									meeting={meeting}
									mode="fill"
									// eslint-disable-next-line @typescript-eslint/no-explicit-any
									config={rtkConfig as any}
									// eslint-disable-next-line @typescript-eslint/no-explicit-any
									t={rtkT as any}
									style={{ width: "100%", height: "100%" }}
								/>
							</div>
						</RealtimeKitProvider>
					) : (
						/* Connecting state — favicon, room name, and
						   status line stack centered in the dialog so
						   nothing floats alone.  As soon as the SDK
						   resolves we swap to the layout above. */
						<div className="flex-1 flex flex-col items-center justify-center gap-3">
							<img
								src="/favicon.png"
								alt=""
								aria-hidden
								className="h-14 w-14 animate-pulse"
								style={{ animationDuration: "1.6s" }}
							/>
							<div className="text-sm font-medium text-foreground">
								{roomName}
							</div>
							<div className="text-sm text-muted-foreground">
								Connecting to Live…
							</div>
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

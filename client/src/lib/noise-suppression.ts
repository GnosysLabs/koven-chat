// DeepFilterNet noise-suppression manager for calls.
//
// RealtimeKit's built-in audio cleanup is just the browser's WebRTC
// noise suppressor, which is weak: traffic, background voices and
// objects clanking all leak through.  This module runs DeepFilterNet3
// (an open-source ML denoiser) as a RealtimeKit *audio middleware* so
// the mic signal is cleaned BEFORE the track is published to peers.
//
// RealtimeKit's middleware contract is
// `(audioContext) => Promise<AudioWorkletNode>` and it owns the
// source -> node -> destination wiring internally; we only construct
// and hand back the worklet node.
//
// The DeepFilterNet WASM + model are vendored under the SPA's
// `public/deepfilternet/` so there is no runtime dependency on a
// third-party CDN, and they resolve same-origin on web, desktop, and
// the Capacitor shell alike.
//
// Lifecycle: a single shared core per page, kept warm for the whole
// session.  `preload()` fetches and compiles the assets once (call it
// on the PreJoin screen so the multi-MB model is ready before the
// user joins); `attach()` registers the middleware on a meeting;
// `setEnabled()` flips the worklet between active and bypass without
// tearing the track down.  The core deliberately outlives any single
// call — the assets are page-stable, and RealtimeKit hands a fresh
// AudioContext per meeting, so `createAudioWorkletNode` just builds a
// new node on top of the already-compiled WASM each time.

import { DeepFilterNet3Core } from "deepfilternet3-noise-filter";

// The two assets ship under public/deepfilternet/v2/... — the package's
// AssetLoader appends `v2/pkg/df_bg.wasm` and
// `v2/models/DeepFilterNet3_onnx.tar.gz` to this base.
const ASSET_BASE = "/deepfilternet";

const PREF_KEY = "koven.noiseSuppression";

// Minimal structural type for the bits of the RealtimeKit meeting we
// touch.  Avoids a brittle import of the SDK's client type, which is
// re-exported through several layers.
type AudioMiddleware = (ctx: AudioContext) => Promise<AudioWorkletNode | ScriptProcessorNode>;
interface ResponseStatus {
	success: boolean;
	message: string;
}
interface RTKMeetingLike {
	self: {
		addAudioMiddleware(mw: AudioMiddleware): Promise<ResponseStatus>;
	};
}

/** Read the persisted on/off preference.  Defaults to on. */
export function getNoiseSuppressionPref(): boolean {
	try {
		return localStorage.getItem(PREF_KEY) !== "false";
	} catch {
		return true;
	}
}

function writePref(enabled: boolean): void {
	try {
		localStorage.setItem(PREF_KEY, enabled ? "true" : "false");
	} catch {
		// Private-mode / storage-disabled — preference just won't persist.
	}
}

let core: DeepFilterNet3Core | null = null;
let initPromise: Promise<DeepFilterNet3Core> | null = null;
// Mirrors the user preference; applied to the worklet as soon as one
// exists (the worklet may be created after the toggle is flipped).
let enabled = getNoiseSuppressionPref();

/**
 * Fetch + compile the DeepFilterNet WASM and model.  Idempotent and
 * safe to call repeatedly; the work happens once.  Call this early
 * (PreJoin) so the model is warm before the call connects.
 */
export function preload(): Promise<DeepFilterNet3Core> {
	if (initPromise) return initPromise;
	initPromise = (async () => {
		const c = new DeepFilterNet3Core({
			assetConfig: { cdnUrl: ASSET_BASE },
		});
		await c.initialize();
		core = c;
		return c;
	})();
	initPromise.catch(() => {
		// Let a later attach()/preload() retry from scratch instead of
		// caching the rejection forever.
		initPromise = null;
	});
	return initPromise;
}

/**
 * Register the DeepFilterNet worklet as an audio middleware on the
 * given meeting.  RealtimeKit invokes the middleware with its own
 * AudioContext when the mic track is (re)published, so this works
 * whether called before or after joining — including across a
 * mid-call device switch, since the SDK re-applies stored middlewares
 * when it re-acquires the mic track.
 *
 * IMPORTANT — WebKit limitation: RealtimeKit blocks audio middlewares
 * on WebKit engines (Safari, iOS WKWebView, macOS/Linux Tauri
 * WebView) unless Cloudflare has enabled the `allow_safari_media_
 * middlewares` account feature flag.  When blocked, `addAudioMiddleware`
 * RESOLVES with `{ success: false }` rather than throwing, so we
 * inspect the result and log it.  The call still works on those
 * platforms, just without the extra suppression layer.
 */
export async function attach(meeting: RTKMeetingLike): Promise<void> {
	const result = await meeting.self.addAudioMiddleware(async (audioContext) => {
		const c = await preload();
		const node = await c.createAudioWorkletNode(audioContext as AudioContext);
		// The worklet starts active; mirror the current preference so a
		// user who joined with suppression off doesn't get a brief blast
		// of processed audio.
		c.setNoiseSuppressionEnabled(enabled);
		return node;
	});
	if (!result.success) {
		console.warn(
			`noise-suppression: middleware not applied — ${result.message}`,
		);
	}
}

/**
 * Turn suppression on or off.  Keeps the middleware registered and
 * the worklet in the graph; just toggles bypass, so there is no track
 * republish / glitch.  Persists the choice.
 */
export function setEnabled(next: boolean): void {
	enabled = next;
	writePref(next);
	core?.setNoiseSuppressionEnabled(next);
}

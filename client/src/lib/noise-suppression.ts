// Noise-suppression manager for calls.  Two engines, one toggle.
//
// The right tool differs by browser engine, so the strategy is split:
//
//   - Chromium / Gecko: the browser's own WebRTC noise suppressor is
//     a dated DSP filter that lets keyboards, traffic and other voices
//     through.  We run RNNoise (a small, fast ML denoiser) as a
//     RealtimeKit *audio middleware* so the mic signal is cleaned
//     BEFORE the track is published to peers.  RNNoise is light enough
//     to never starve the audio render thread, so unlike the previous
//     DeepFilterNet integration it does not crackle or drift the A/V
//     sync.
//
//   - WebKit (Safari, iOS WKWebView, Tauri's macOS/Linux WebView):
//     RealtimeKit refuses to apply audio middlewares on WebKit.  But
//     on Apple platforms `noiseSuppression: true` routes to the OS
//     Voice Processing unit, a strong modern denoiser in its own
//     right, so on WebKit we lean on that native suppression instead.
//
// The engine is chosen from the user agent, but the decision is not
// load-bearing: when we DO register the middleware we inspect
// RealtimeKit's response, and a refusal falls the meeting back to
// native NS.  So a wrong UA guess self-corrects.
//
// Native NS and RNNoise must never both run: stacking two suppressors
// pumps and adds artifacts (this is why Discord drops WebRTC NS when
// Krisp is on).  In middleware mode native NS is therefore dropped
// from the mic the moment RNNoise is live; in native mode it simply
// mirrors the preference.
//
// The single `koven.noiseSuppression` preference drives both paths;
// `setEnabled()` routes to whichever engine the meeting landed on.

import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

const PREF_KEY = "koven.noiseSuppression";

// Minimal structural types for the bits of the RealtimeKit meeting we
// touch.  Avoids a brittle import of the SDK's client type, which is
// re-exported through several layers.
type AudioMiddleware = (ctx: AudioContext) => Promise<AudioWorkletNode | ScriptProcessorNode>;
interface ResponseStatus {
	success: boolean;
	message: string;
}
interface RTKSelfLike {
	addAudioMiddleware(mw: AudioMiddleware): Promise<ResponseStatus>;
	removeAllAudioMiddlewares(): Promise<ResponseStatus> | void;
	rawAudioTrack?: MediaStreamTrack;
	audioTrack?: MediaStreamTrack;
	on(event: string, cb: () => void): void;
	off(event: string, cb: () => void): void;
}
interface RTKMeetingLike {
	self: RTKSelfLike;
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

// True on WebKit engines (Safari, iOS WKWebView, Tauri's macOS/Linux
// WebView), where RealtimeKit refuses audio middlewares.  Chromium and
// Gecko both carry a "Chrome/", "Chromium/" or "Firefox/" token and
// are middleware-capable; third-party iOS browsers (Chrome/Firefox on
// iOS) are still WebKit underneath and carry CriOS/FxiOS instead.
function isWebKitEngine(): boolean {
	if (typeof navigator === "undefined") return false;
	const ua = navigator.userAgent;
	if (/\b(CriOS|FxiOS|EdgiOS)\b/.test(ua)) return true;
	if (/iPhone|iPad|iPod/.test(ua)) return true;
	if (/Chrome\/|Chromium\/|Firefox\//.test(ua)) return false;
	return /AppleWebKit\//.test(ua);
}

// Mirrors the user preference.  Applied to whichever engine is live as
// soon as a meeting is attached.
let enabled = getNoiseSuppressionPref();
// "middleware" once RNNoise is the chosen engine, "native" on WebKit
// (or after a middleware refusal).  null until attach() runs.
let mode: "middleware" | "native" | null = null;
let attachedMeeting: RTKMeetingLike | null = null;

let rnnoiseBinary: ArrayBuffer | null = null;
let rnnoiseBinaryPromise: Promise<ArrayBuffer> | null = null;

/**
 * Fetch the RNNoise WASM binary.  Idempotent and safe to call
 * repeatedly; the fetch happens once.  Call this early (meeting init)
 * so the binary is warm before the user joins.  Harmless on WebKit —
 * the binary just goes unused there.
 */
export function preload(): Promise<ArrayBuffer> {
	if (rnnoiseBinaryPromise) return rnnoiseBinaryPromise;
	rnnoiseBinaryPromise = loadRnnoise({
		url: rnnoiseWasmUrl,
		simdUrl: rnnoiseSimdWasmUrl,
	}).then((bin) => {
		rnnoiseBinary = bin;
		return bin;
	});
	rnnoiseBinaryPromise.catch(() => {
		// Let a later preload() retry from scratch instead of caching
		// the rejection forever.
		rnnoiseBinaryPromise = null;
	});
	return rnnoiseBinaryPromise;
}

/**
 * Apply (or clear) the browser's native noise suppression on the live
 * mic capture.  Targets `rawAudioTrack` — the actual getUserMedia
 * track — since in middleware mode `audioTrack` is the post-RNNoise
 * MediaStreamDestination output, which `applyConstraints` cannot
 * touch.  A no-op when the track already has the desired state, so it
 * is cheap to call on every `audioUpdate`.
 */
function applyNativeNs(meeting: RTKMeetingLike, on: boolean): void {
	const track = meeting.self.rawAudioTrack ?? meeting.self.audioTrack;
	if (!track) return;
	let current: boolean | undefined;
	try {
		current = track.getSettings().noiseSuppression;
	} catch {
		current = undefined;
	}
	if (current === on) return;
	track.applyConstraints({ noiseSuppression: on }).catch((err) => {
		console.warn("noise-suppression: applyConstraints failed", err);
	});
}

/** Build the RealtimeKit audio middleware that splices RNNoise into
 *  the mic path.  RealtimeKit invokes this with its own AudioContext
 *  each time the mic track is (re)published. */
function buildMiddleware(meeting: RTKMeetingLike): AudioMiddleware {
	return async (audioContext) => {
		// RNNoise is a 48 kHz model.  audio-context-rate.ts pins every
		// AudioContext to 48 kHz so this always holds; surface it
		// loudly rather than ship degraded audio if it ever does not.
		if (audioContext.sampleRate !== 48000) {
			console.warn(
				`noise-suppression: AudioContext is ${audioContext.sampleRate} Hz, expected 48000 — output may be degraded`,
			);
		}
		const binary = await preload();
		try {
			await audioContext.audioWorklet.addModule(rnnoiseWorkletUrl);
		} catch {
			// The processor only needs registering once per
			// AudioContext; a second publish on the same context
			// throws "already registered", which is fine.
		}
		const node = new RnnoiseWorkletNode(audioContext, {
			maxChannels: 2,
			wasmBinary: binary,
		});
		// RNNoise is now the suppressor.  Drop the browser's native NS
		// so the two do not stack.  Done HERE, after the node exists,
		// so a failed worklet load never leaves the mic with no
		// suppression at all.
		applyNativeNs(meeting, false);
		return node;
	};
}

/** Register the RNNoise middleware, falling back to native NS if
 *  RealtimeKit refuses it (the UA guess was wrong, or Cloudflare
 *  changed the WebKit policy). */
async function registerMiddleware(meeting: RTKMeetingLike): Promise<void> {
	const result = await meeting.self.addAudioMiddleware(buildMiddleware(meeting));
	if (!result.success) {
		console.warn(
			`noise-suppression: middleware refused — ${result.message}; falling back to native NS`,
		);
		mode = "native";
		applyNativeNs(meeting, enabled);
	}
}

/** Re-assert the correct native-NS state after the SDK re-acquires
 *  the mic (device switch, enable/disable).  A device switch re-reads
 *  the init-time mediaConfiguration, which may no longer match the
 *  live toggle, so without this a switch could silently re-enable
 *  native NS underneath RNNoise (double suppression) or lose it. */
function syncTrack(meeting: RTKMeetingLike): void {
	if (mode === "native") {
		applyNativeNs(meeting, enabled);
	} else {
		// Middleware mode: native NS must always be off — RNNoise owns
		// suppression when enabled, and "off" means a raw mic.
		applyNativeNs(meeting, false);
	}
}

/**
 * Bind the noise-suppression engine to a meeting.  Picks the engine
 * from the user agent, registers the RNNoise middleware on
 * middleware-capable engines, and keeps native NS synced across
 * mid-call device switches.  Safe to call before or after joining.
 */
export async function attach(meeting: RTKMeetingLike): Promise<void> {
	attachedMeeting = meeting;
	mode = isWebKitEngine() ? "native" : "middleware";

	const onAudio = () => syncTrack(meeting);
	try {
		meeting.self.on("audioUpdate", onAudio);
	} catch {
		// SDK shape changed — non-fatal, device switches just won't
		// re-sync native NS.
	}

	if (mode === "native") {
		// WebKit: native NS is the suppressor; mirror the preference.
		applyNativeNs(meeting, enabled);
		return;
	}

	// Middleware-capable engine.  The mic is acquired with native NS
	// on (mediaConfiguration in call-context.tsx), which covers the
	// brief window before RNNoise is live.
	if (enabled) {
		await registerMiddleware(meeting);
	} else {
		// Suppression off: no middleware, and native NS must come off
		// too so "off" really means a raw mic.
		applyNativeNs(meeting, false);
	}
}

/**
 * Turn suppression on or off.  Routes to whichever engine the meeting
 * landed on, and persists the choice.
 *
 * On WebKit this is an instant `applyConstraints` on the live track.
 * On middleware engines RNNoise has no in-node bypass, so the toggle
 * adds or removes the middleware — that republishes the mic track, a
 * brief blip which is acceptable for an explicit, user-initiated
 * toggle (Discord's Krisp toggle behaves the same way).
 */
export function setEnabled(next: boolean): void {
	enabled = next;
	writePref(next);
	const meeting = attachedMeeting;
	if (!meeting) return;

	if (mode === "native") {
		applyNativeNs(meeting, next);
		return;
	}

	if (next) {
		void registerMiddleware(meeting);
	} else {
		try {
			void meeting.self.removeAllAudioMiddlewares();
		} catch (err) {
			console.warn("noise-suppression: removeAllAudioMiddlewares failed", err);
		}
		// Guarantee "off" means no suppression at all, even if RNNoise
		// never got a chance to drop native NS itself.
		applyNativeNs(meeting, false);
	}
}

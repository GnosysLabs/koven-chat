// Force every AudioContext to 48 kHz.  Side-effecting module: import
// it once, as early as possible, before any audio code runs.
//
// RealtimeKit creates the audio-middleware AudioContext with a bare
// `new AudioContext()` (verified in the SDK source), so it adopts the
// hardware sample rate.  On a Bluetooth headset the microphone
// switches to the Hands-Free Profile and the hardware rate collapses
// to 16 kHz, dragging the whole Web Audio graph down with it.
//
// That breaks DeepFilterNet (see noise-suppression.ts): it is a
// 48 kHz speech model, and fed a 16 kHz context it processes the
// wrong spectral content and its frame timing drifts, producing
// mangled, stuttering audio.
//
// Pinning the context to 48 kHz makes the browser's own high-quality
// resampler upsample the mic into the graph.  The signal is still
// narrowband at the source (Bluetooth HFP cannot be undone), but the
// RATE is now stable, so DeepFilterNet and the Opus encoder both
// behave.  48 kHz is the correct rate for every AudioContext in the
// app, so this is a deliberate global policy, not a workaround for
// one surface.  A caller that explicitly passes its own `sampleRate`
// still wins (the spread below puts caller options last).
//
// OfflineAudioContext is intentionally NOT patched: it takes a
// required, caller-chosen sample rate by design.

const TARGET_RATE = 48000;

type AudioContextCtor = typeof AudioContext;

function rateLocked(Original: AudioContextCtor): AudioContextCtor {
	class RateLockedAudioContext extends Original {
		constructor(options?: AudioContextOptions) {
			super({ sampleRate: TARGET_RATE, ...options });
		}
	}
	return RateLockedAudioContext;
}

const w = globalThis as typeof globalThis & {
	AudioContext?: AudioContextCtor;
	webkitAudioContext?: AudioContextCtor;
	__kovenAudioRateLocked?: boolean;
};

// Guard against double-patching (Vite HMR can re-run this module).
if (!w.__kovenAudioRateLocked) {
	if (typeof w.AudioContext === "function") {
		w.AudioContext = rateLocked(w.AudioContext);
	}
	if (typeof w.webkitAudioContext === "function") {
		w.webkitAudioContext = rateLocked(w.webkitAudioContext);
	}
	w.__kovenAudioRateLocked = true;
}

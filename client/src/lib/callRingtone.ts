// Audible ringtones for incoming + outbound calls.
//
// Generated via Web Audio API (no mp3 assets to bundle / load).
// Two tones, both loop until stopped:
//
//   - Inbound ring  → louder, 2-tone alternating burst on a 4-second
//                     cadence (0.4s tone, 0.2s silence, 0.4s tone,
//                     ~3s gap), classic phone-ring rhythm.
//   - Outbound dial → quieter, single sustained tone with a gentle
//                     pulse, lower volume so the caller isn't
//                     deafened while waiting for the other side.
//
// Both functions return a stop() callback the caller invokes when
// the call state moves out of ringing (accepted, declined, cancelled,
// timed out).  Calling stop() more than once is a no-op.  The
// AudioContext is created lazily on the first ring so we don't fight
// browsers' "no audio without user gesture" policy until there's a
// real reason — incoming-call rendering counts as a user-context
// trigger, but we still wrap the resume() in a try/catch in case the
// browser refused.

let sharedCtx: AudioContext | null = null;

function ctx(): AudioContext | null {
	if (sharedCtx) return sharedCtx;
	try {
		const Ctor = (window as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
			?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!Ctor) return null;
		sharedCtx = new Ctor();
		return sharedCtx;
	} catch {
		return null;
	}
}

interface ToneSpec {
	freqHz: number;
	durationSec: number;
	gain: number;          // 0..1 (higher = louder)
	startAt: number;       // seconds from cycle start
}

interface RingHandle {
	stop(): void;
}

/** Inbound ring: two-tone burst, ~4s cadence.  Mimics iOS's classic
 * dual-tone pattern.  Loops until stop(). */
export function startInboundRing(): RingHandle {
	return playPattern(
		[
			{ freqHz: 440, durationSec: 0.4, gain: 0.18, startAt: 0.0 },
			{ freqHz: 480, durationSec: 0.4, gain: 0.18, startAt: 0.6 },
		],
		4.0, // cycle length — 0.6 + 0.4 = 1.0s of sound, then 3s silence
	);
}

/** Outbound dial: one sustained low tone every 3s.  Quieter than the
 * inbound ring so the caller isn't startled while waiting. */
export function startOutboundDial(): RingHandle {
	return playPattern(
		[
			{ freqHz: 350, durationSec: 0.7, gain: 0.06, startAt: 0.0 },
		],
		3.0,
	);
}

function playPattern(tones: ToneSpec[], cycleSec: number): RingHandle {
	const audio = ctx();
	if (!audio) {
		// Audio API unavailable — return a no-op handle so callers
		// don't have to guard.  No sound, but the rest of the call
		// flow still works.
		return { stop: () => { /* no-op */ } };
	}
	// Some browsers suspend the context until a user gesture.  An
	// incoming-call render is implicitly user-initiated (Synapse
	// pushed it via /sync after the user explicitly logged in), but
	// we resume() defensively anyway.
	void audio.resume().catch(() => { /* fine, may stay suspended */ });

	let stopped = false;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	const activeNodes: { osc: OscillatorNode; gain: GainNode }[] = [];

	const playOneCycle = () => {
		if (stopped) return;
		const cycleStart = audio.currentTime;
		for (const tone of tones) {
			const osc = audio.createOscillator();
			const gain = audio.createGain();
			osc.type = "sine";
			osc.frequency.value = tone.freqHz;
			// Quick attack / release envelope so the tone doesn't
			// click on/off — sounds gentler and avoids the
			// "speaker pop" some headphones produce on hard edges.
			gain.gain.setValueAtTime(0, cycleStart + tone.startAt);
			gain.gain.linearRampToValueAtTime(
				tone.gain,
				cycleStart + tone.startAt + 0.02,
			);
			gain.gain.linearRampToValueAtTime(
				tone.gain,
				cycleStart + tone.startAt + tone.durationSec - 0.02,
			);
			gain.gain.linearRampToValueAtTime(
				0,
				cycleStart + tone.startAt + tone.durationSec,
			);
			osc.connect(gain);
			gain.connect(audio.destination);
			osc.start(cycleStart + tone.startAt);
			osc.stop(cycleStart + tone.startAt + tone.durationSec + 0.05);
			activeNodes.push({ osc, gain });
		}
		// Schedule the next cycle.  setTimeout drift is fine here —
		// a few ms of jitter on a ring rhythm is imperceptible.
		timeoutId = setTimeout(playOneCycle, cycleSec * 1000);
	};

	playOneCycle();

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = null;
			}
			// Tear down any oscillators that haven't reached their
			// scheduled stop yet.  Just calling stop(0) would clip
			// audibly; ramp the gain to 0 first to avoid a click.
			const now = audio.currentTime;
			for (const { osc, gain } of activeNodes) {
				try {
					gain.gain.cancelScheduledValues(now);
					gain.gain.setValueAtTime(gain.gain.value, now);
					gain.gain.linearRampToValueAtTime(0, now + 0.05);
					osc.stop(now + 0.06);
				} catch {
					// Already stopped — ignore.
				}
			}
		},
	};
}

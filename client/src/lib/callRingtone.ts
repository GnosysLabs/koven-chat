// Call ringtone controller.
//
// Plays /ring.mp3 (looped) for both sides of a DM call: the recipient
// while the incoming-call modal is up, and the caller while waiting for
// an answer.
//
// Why a primed singleton instead of a fresh <audio> per ring:
// browsers policy-block media playback that isn't started from inside a
// user-gesture handler.  An incoming ring renders from a Matrix /sync
// push, which is NOT a gesture, so a fresh `new Audio().play()` there
// gets rejected (always on iOS WKWebView, on the Tauri desktop
// WKWebView, and conditionally in Chrome).  The fix: keep ONE audio
// element for the whole session and "unlock" it once on the first real
// user gesture (a silent play+pause).  Once an element has played
// inside a gesture, the browser lets us drive it programmatically from
// then on, on every platform.

const RING_SRC = "/ring.mp3";

let el: HTMLAudioElement | null = null;

function element(): HTMLAudioElement | null {
	if (el) return el;
	if (typeof Audio === "undefined") return null;
	el = new Audio(RING_SRC);
	el.loop = true;
	el.preload = "auto";
	return el;
}

let primed = false;

/** Wire a one-time "unlock" of the ring element to the first user
 *  gesture in the session.  Safe to call more than once — only the
 *  first call arms the listeners.  Call at app startup. */
export function primeRingtone(): void {
	if (primed) return;
	primed = true;
	const a = element();
	if (!a) return;

	const events = ["pointerdown", "keydown", "touchstart"] as const;
	const unlock = () => {
		for (const ev of events) window.removeEventListener(ev, unlock, true);
		// Silent play+pause inside the gesture so the element is
		// "blessed" for later programmatic playback.  Muted so the
		// user hears nothing during the unlock.
		a.muted = true;
		a.play().then(() => {
			a.pause();
			a.currentTime = 0;
			a.muted = false;
		}).catch(err => {
			a.muted = false;
			console.warn("ringtone: unlock play() rejected", err);
		});
	};
	for (const ev of events) {
		window.addEventListener(ev, unlock, { capture: true, once: true });
	}
}

/** Start the looping ringtone.  Idempotent — calling while already
 *  ringing just keeps it going. */
export function startRing(): void {
	const a = element();
	if (!a) return;
	a.muted = false;
	a.volume = 0.6;
	if (!a.paused) return;
	a.currentTime = 0;
	a.play().catch(err => {
		// Loud, not swallowed — a real failure should be visible.
		console.error("ringtone: startRing play() rejected", err);
	});
}

/** Stop the ringtone and rewind.  Idempotent. */
export function stopRing(): void {
	if (!el) return;
	el.pause();
	try { el.currentTime = 0; } catch { /* not seekable yet, fine */ }
}

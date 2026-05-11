// Hidden audio sinks for every joined remote participant.  Lives at
// the App level so audio survives navigation — the previous design
// had the audio elements inside ParticipantTile, which unmounted
// when the user left the call's room and silenced the call.  That
// breaks the Discord-style "stay in voice while clicking around"
// promise.
//
// One <audio> per remote participant, srcObject bound to their
// audioTrack.  Re-derives the participant array on
// participantJoined / participantLeft / audioUpdate events.  Self
// is excluded — we don't want to hear our own mic looped back.
//
// This component renders nothing visible.  It just keeps the audio
// pipeline alive across React unmounts of the visible call UI.

import { useEffect, useRef, useState } from "react";
import { useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";
import type { RTKParticipant } from "@cloudflare/realtimekit-react";

export function CallAudioSink() {
	const { meeting } = useRealtimeKitMeeting();
	// Re-derive on every joined/left tick rather than maintaining a
	// parallel state copy — the SDK's map is the source of truth.
	const [tick, setTick] = useState(0);

	useEffect(() => {
		const bump = () => setTick(t => t + 1);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const joined = meeting.participants.joined as any;
		joined.on("participantJoined", bump);
		joined.on("participantLeft", bump);
		// audioUpdate at the participants level isn't a documented
		// event but the wildcard catches any per-participant change
		// we'd care about (audio enable/disable, track swap).  Cheap
		// to re-derive; the audio elements use srcObject which is
		// idempotent for the same MediaStreamTrack.
		return () => {
			try {
				joined.off("participantJoined", bump);
				joined.off("participantLeft", bump);
			} catch {
				// SDK already torn down.
			}
		};
	}, [meeting]);

	// Snapshot the joined map.  RTKParticipantMap exposes toArray()
	// per the SDK; fall back to Map.values() if the type ever
	// changes shape.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const m = meeting.participants.joined as any;
	const participants: RTKParticipant[] =
		typeof m.toArray === "function"
			? (m.toArray() as RTKParticipant[])
			: (Array.from(m.values()) as RTKParticipant[]);

	void tick; // dependency for re-render only
	return (
		<div aria-hidden className="sr-only">
			{participants.map(p => (
				<RemoteAudio key={p.id} participant={p} />
			))}
			{/* Separate audio sinks for any remote with active screen
			    share that includes audio (e.g. sharing a YouTube tab
			    with sound).  RealtimeKit splits screen audio from
			    mic audio into screenShareTracks.audio so we route
			    them through their own <audio> elements. */}
			{participants.map(p => (
				<RemoteScreenAudio key={`screen-${p.id}`} participant={p} />
			))}
		</div>
	);
}

/** Single hidden audio element bound to one participant's audio
 *  track.  Subscribes to the participant's audioUpdate events so
 *  mute/unmute toggles + mic-device swaps re-bind the track in
 *  real time — without this, a remote who joined muted and then
 *  unmuted would stay silent until the parent map mutated. */
function RemoteAudio({ participant }: { participant: RTKParticipant }) {
	const ref = useRef<HTMLAudioElement | null>(null);
	// Local tick to force re-runs of the bind effect when the
	// participant fires audioUpdate.  React doesn't observe field
	// mutations on the participant object directly, so we listen
	// to the SDK's event and bump.
	const [tick, setTick] = useState(0);

	useEffect(() => {
		const onAudio = () => setTick(t => t + 1);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(participant as any).on("audioUpdate", onAudio);
		return () => {
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(participant as any).off("audioUpdate", onAudio);
			} catch {
				// SDK already torn down.
			}
		};
	}, [participant]);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		if (participant.audioEnabled && participant.audioTrack) {
			el.srcObject = new MediaStream([participant.audioTrack]);
			void el.play().catch(() => { /* autoplay blocked, fine */ });
		} else {
			el.srcObject = null;
		}
		// `tick` is the dependency that forces re-evaluation when
		// the participant emits audioUpdate.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [participant, tick]);

	return <audio ref={ref} autoPlay />;
}

/** Separate audio sink for the OPTIONAL audio track that comes
 *  alongside a screen share (Chromium only; Safari + Firefox
 *  generally don't capture tab audio).  We track it independently
 *  of the mic audio so a participant can mute their mic without
 *  silencing the YouTube clip they're sharing.  No-op when the
 *  participant isn't sharing or didn't include audio in the
 *  share. */
function RemoteScreenAudio({ participant }: { participant: RTKParticipant }) {
	const ref = useRef<HTMLAudioElement | null>(null);
	const [tick, setTick] = useState(0);

	useEffect(() => {
		const onScreen = () => setTick(t => t + 1);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(participant as any).on("screenShareUpdate", onScreen);
		return () => {
			try {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(participant as any).off("screenShareUpdate", onScreen);
			} catch { /* SDK torn down */ }
		};
	}, [participant]);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const audioTrack = (participant as any).screenShareTracks?.audio as MediaStreamTrack | undefined;
		if (participant.screenShareEnabled && audioTrack) {
			el.srcObject = new MediaStream([audioTrack]);
			void el.play().catch(() => { /* autoplay blocked, fine */ });
		} else {
			el.srcObject = null;
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [participant, tick]);

	return <audio ref={ref} autoPlay />;
}

// Shared media-device state for the call surface.  Owns the
// enumerated device lists (mic / camera / speaker), the current
// selection per kind, and the switch action.  Used by both the
// pre-join screen and the in-call device menu so the device-picker
// logic lives in exactly one place.
//
// `meeting.self.setDevice()` is the SDK's switch primitive — it
// works identically before joining and mid-call (mid-call it
// republishes the track to peers), so the same hook covers both
// surfaces.
//
// The `ready` gate exists for the pre-join screen: browsers hide
// device LABELS until media permission has been granted at least
// once, so the pre-join screen fires a getUserMedia probe first and
// only flips `ready` true once that resolves.  In-call the
// permission is already granted, so callers pass `ready = true`.

import { useCallback, useEffect, useState } from "react";
import { useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";

type Meeting = ReturnType<typeof useRealtimeKitMeeting>["meeting"];

export interface CallDevices {
	audioDevices: MediaDeviceInfo[];
	videoDevices: MediaDeviceInfo[];
	speakerDevices: MediaDeviceInfo[];
	currentAudioId: string;
	currentVideoId: string;
	currentSpeakerId: string;
	pickDevice(kind: "audio" | "video" | "speaker", deviceId: string): Promise<void>;
}

export function useCallDevices(meeting: Meeting, ready: boolean): CallDevices {
	const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
	const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);
	const [speakerDevices, setSpeakerDevices] = useState<MediaDeviceInfo[]>([]);
	const [currentAudioId, setCurrentAudioId] = useState<string>("");
	const [currentVideoId, setCurrentVideoId] = useState<string>("");
	const [currentSpeakerId, setCurrentSpeakerId] = useState<string>("");

	// Initial enumeration + current-selection hydration.  Deferred
	// until `ready` so the pre-join screen can wait out its
	// permission probe (otherwise the lists come back unlabeled).
	useEffect(() => {
		if (!ready) return;
		let cancelled = false;
		(async () => {
			try {
				const [a, v, s, current] = await Promise.all([
					meeting.self.getAudioDevices(),
					meeting.self.getVideoDevices(),
					meeting.self.getSpeakerDevices(),
					meeting.self.getCurrentDevices(),
				]);
				if (cancelled) return;
				setAudioDevices(a);
				setVideoDevices(v);
				setSpeakerDevices(s);
				setCurrentAudioId(current.audio?.deviceId ?? "");
				setCurrentVideoId(current.video?.deviceId ?? "");
				setCurrentSpeakerId(current.speaker?.deviceId ?? "");
			} catch (err) {
				console.warn("useCallDevices: device hydration failed", err);
			}
		})();
		return () => { cancelled = true; };
	}, [meeting, ready]);

	// Refresh the lists when a device is plugged or unplugged.
	useEffect(() => {
		const onDeviceList = async () => {
			try {
				const [a, v, s] = await Promise.all([
					meeting.self.getAudioDevices(),
					meeting.self.getVideoDevices(),
					meeting.self.getSpeakerDevices(),
				]);
				setAudioDevices(a);
				setVideoDevices(v);
				setSpeakerDevices(s);
			} catch (err) {
				console.warn("useCallDevices: device-list refresh failed", err);
			}
		};
		meeting.self.on("deviceListUpdate", onDeviceList);
		return () => {
			try {
				meeting.self.off("deviceListUpdate", onDeviceList);
			} catch {
				// SDK already torn down.
			}
		};
	}, [meeting]);

	const pickDevice = useCallback(async (kind: "audio" | "video" | "speaker", deviceId: string) => {
		const list =
			kind === "audio" ? audioDevices
			: kind === "video" ? videoDevices
			: speakerDevices;
		const device = list.find(d => d.deviceId === deviceId);
		if (!device) return;
		await meeting.self.setDevice(device);
		if (kind === "audio") setCurrentAudioId(deviceId);
		else if (kind === "video") setCurrentVideoId(deviceId);
		else setCurrentSpeakerId(deviceId);
	}, [meeting, audioDevices, videoDevices, speakerDevices]);

	return {
		audioDevices,
		videoDevices,
		speakerDevices,
		currentAudioId,
		currentVideoId,
		currentSpeakerId,
		pickDevice,
	};
}

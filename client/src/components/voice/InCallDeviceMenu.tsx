// In-call device switcher.  A control-bar button that opens a
// popover with the three device pickers (mic, camera, speaker) so
// the user can change input/output devices without leaving the
// call.  `meeting.self.setDevice()` republishes the track to peers,
// so switches take effect live.
//
// Permission is already granted by the time the user is in a call,
// so the device hook runs with `ready = true` — no probe needed.

import { useState } from "react";
import { useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";
import { Mic, Settings, Video, Volume2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DeviceRow } from "@/components/voice/DeviceRow";
import { useCallDevices } from "@/components/voice/useCallDevices";

export function InCallDeviceMenu() {
	const { meeting } = useRealtimeKitMeeting();
	const devices = useCallDevices(meeting, true);
	const [error, setError] = useState<string | null>(null);

	async function pick(kind: "audio" | "video" | "speaker", deviceId: string) {
		setError(null);
		try {
			await devices.pickDevice(kind, deviceId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<Popover>
			<PopoverTrigger
				aria-label="Devices"
				title="Devices"
				className="h-11 w-11 rounded-full flex items-center justify-center bg-muted hover:bg-accent text-foreground transition-colors"
			>
				<Settings className="h-5 w-5" />
			</PopoverTrigger>
			<PopoverContent side="top" align="center" className="w-72 flex flex-col gap-2">
				<div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
					Devices
				</div>
				<DeviceRow
					icon={<Mic className="h-3.5 w-3.5" />}
					devices={devices.audioDevices}
					currentId={devices.currentAudioId}
					placeholder="Default microphone"
					onChange={(id) => pick("audio", id)}
				/>
				<DeviceRow
					icon={<Video className="h-3.5 w-3.5" />}
					devices={devices.videoDevices}
					currentId={devices.currentVideoId}
					placeholder="Default camera"
					onChange={(id) => pick("video", id)}
				/>
				<DeviceRow
					icon={<Volume2 className="h-3.5 w-3.5" />}
					devices={devices.speakerDevices}
					currentId={devices.currentSpeakerId}
					placeholder="Default speaker"
					onChange={(id) => pick("speaker", id)}
				/>
				{error && (
					<div className="text-xs text-destructive border border-destructive/40 bg-destructive/10 rounded px-2 py-1.5">
						{error}
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}

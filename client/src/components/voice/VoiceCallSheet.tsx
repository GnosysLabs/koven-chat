// Full-screen sheet that mounts Cloudflare's RealtimeKit UI Kit
// for the actual in-call experience.  Voice channels in Koven open
// this when the user clicks Join Voice; the sheet covers the chat
// pane while the call is live.
//
// We use the prebuilt <RtkMeeting /> component from the UI Kit
// rather than building our own grid + controls — Cloudflare's
// component handles every WebRTC / device / browser quirk we'd
// otherwise reinvent badly.
//
// Lifecycle:
//   1. Sheet opens with `authToken` prop (minted by engine on Join)
//   2. useRealtimeKitClient connects to Cloudflare's signaling
//      using the JWT
//   3. When connected, <RtkMeeting> renders the full call UI
//   4. User clicks Leave → SDK fires roomLeft → we close the sheet
//
// One token, one connection.  The auth tokens are single-use per
// the RealtimeKit docs, so each open of this sheet should be
// preceded by a fresh /api/calls/:roomId/join call (handled in
// RoomVoiceBar.tsx where the click originates).

import { useEffect } from "react";
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

export function VoiceCallSheet({ open, authToken, roomName, onClose }: VoiceCallSheetProps) {
	// useRealtimeKitClient returns [client, init].  Init is async
	// and the SDK opens a websocket to Cloudflare's signaling
	// service, exchanges SDP, and resolves the client object.
	const [meeting, initMeeting] = useRealtimeKitClient();

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
				<div className="flex-1 min-h-0">
					{meeting ? (
						<RealtimeKitProvider value={meeting}>
							{/* The Web-Component-backed RtkMeeting is the
							    full prebuilt call UI — participant grid,
							    control bar, chat panel, polls, the works.
							    style fills the dialog so it doesn't sit on
							    top of a margin. */}
							<RtkMeeting
								meeting={meeting}
								mode="fill"
								style={{ width: "100%", height: "100%" }}
							/>
						</RealtimeKitProvider>
					) : (
						<div className="flex-1 flex flex-col items-center justify-center gap-4 h-full">
							{/* Pulsing brand mark while the SDK exchanges
							    SDP + opens the WS to Cloudflare's
							    signaling server. */}
							<img
								src="/favicon.png"
								alt=""
								aria-hidden
								className="h-16 w-16 animate-pulse"
								style={{ animationDuration: "1.4s" }}
							/>
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

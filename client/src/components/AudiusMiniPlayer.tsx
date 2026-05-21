import { useAudiusPlayer } from "@/lib/audiusPlayerContext";
import { useIsMobile } from "@/lib/useIsMobile";
import { Play, Pause, SkipForward, SkipBack, X, Music, AlertTriangle } from "lucide-react";

interface AudiusMiniPlayerProps {
	activeRoomId: string | null;
	onNavigateToRoom: (roomId: string) => void;
}

export function AudiusMiniPlayer({ activeRoomId, onNavigateToRoom }: AudiusMiniPlayerProps) {
	const {
		activeTrackUrl,
		playingRoomId,
		tracks,
		playlistName,
		curatorName,
		coverArtUrl,
		isPlaylist,
		currentTrackIndex,
		isPlaying,
		progress,
		currentTime,
		duration,
		playbackError,
		togglePlay,
		next,
		prev,
		stop,
	} = useAudiusPlayer();

	const isMobile = useIsMobile();

	// Return null if no track is loaded to avoid taking up screen space.
	if (!activeTrackUrl) return null;

	// Hide the player if the user is in the room where the music is shared.
	if (activeRoomId === playingRoomId) return null;

	// Hide on mobile when a chat room is open to optimize vertical viewport space.
	if (isMobile && activeRoomId) return null;

	const currentTrack = tracks[currentTrackIndex];
	const titleText = isPlaylist && currentTrack ? currentTrack.title : playlistName;
	const artistText = curatorName || "Unknown Artist";
	const hasNext = isPlaylist && currentTrackIndex + 1 < tracks.length;

	const handleCardClick = (e: React.MouseEvent) => {
		// Prevent navigating to the room if the user clicked player controls or action buttons.
		const target = e.target as HTMLElement;
		if (target.closest("button") || target.closest("a")) return;

		if (playingRoomId) {
			onNavigateToRoom(playingRoomId);
		}
	};

	return (
		<div
			onClick={handleCardClick}
			className="audius-miniplayer group relative grid grid-cols-3 items-center gap-4 px-4 py-2 bg-card border-b border-border/80 text-foreground select-none shrink-0 cursor-pointer h-12"
		>
			{/* Bottom Progress Bar Indicator */}
			<div className="absolute bottom-0 left-0 right-0 h-[2px] bg-border/40">
				<div
					className="h-full bg-primary transition-all duration-100"
					style={{ width: `${progress}%` }}
				/>
			</div>

			{/* Left Part: Cover Art + Text */}
			<div className="flex items-center gap-2.5 min-w-0">
				<div className="w-8 h-8 rounded overflow-hidden bg-zinc-900 border border-zinc-850 flex-shrink-0 flex items-center justify-center shadow-inner">
					{coverArtUrl ? (
						<img src={coverArtUrl} alt={titleText} className="w-full h-full object-cover" />
					) : (
						<Music className="w-4 h-4 text-zinc-650" />
					)}
				</div>

				<div className="min-w-0 flex flex-col justify-center">
					{playbackError ? (
						<div className="text-[10px] text-destructive truncate font-medium flex items-center gap-1">
							<AlertTriangle className="w-3 h-3 flex-shrink-0" />
							<span>Unavailable</span>
						</div>
					) : (
						<h5 className="font-semibold text-xs truncate text-foreground group-hover:text-primary transition-colors">
							{titleText}
						</h5>
					)}
					<p className="text-[10px] text-muted-foreground truncate">
						{artistText}
					</p>
				</div>
			</div>

			{/* Center Part: Controls */}
			<div className="flex items-center justify-center gap-2">
				<div className="w-8 flex justify-end">
					{isPlaylist && (
						<button
							type="button"
							onClick={prev}
							className="p-1 rounded-full hover:bg-muted active:scale-95 transition-all text-muted-foreground hover:text-foreground"
							title="Previous Track"
						>
							<SkipBack className="w-4 h-4 fill-current" />
						</button>
					)}
				</div>

				<button
					type="button"
					onClick={togglePlay}
					className="w-7 h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow hover:scale-105 active:scale-95 transition-all"
					title={isPlaying ? "Pause" : "Play"}
				>
					{isPlaying ? (
						<Pause className="w-3.5 h-3.5 fill-current" />
					) : (
						<Play className="w-3.5 h-3.5 fill-current ml-0.5" />
					)}
				</button>

				<div className="w-8 flex justify-start">
					{hasNext && (
						<button
							type="button"
							onClick={next}
							className="p-1 rounded-full hover:bg-muted active:scale-95 transition-all text-muted-foreground hover:text-foreground"
							title="Next Track"
						>
							<SkipForward className="w-4 h-4 fill-current" />
						</button>
					)}
				</div>
			</div>

			{/* Right Part: Timeline + Close Button */}
			<div className="flex items-center justify-end gap-3">
				<span className="text-[10px] font-mono text-muted-foreground hidden sm:inline">
					{formatTime(currentTime)} / {formatTime(duration)}
				</span>

				<button
					type="button"
					onClick={stop}
					className="p-1.5 rounded-full hover:bg-muted active:scale-95 transition-all text-muted-foreground hover:text-destructive"
					title="Close Player"
				>
					<X className="w-4 h-4" />
				</button>
			</div>
		</div>
	);
}

function formatTime(seconds: number): string {
	if (isNaN(seconds) || seconds === Infinity) return "0:00";
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60).toString().padStart(2, "0");
	return `${m}:${s}`;
}

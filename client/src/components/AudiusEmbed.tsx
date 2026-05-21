// Audius player embed component.
//
// Fetches track, playlist, or album metadata from the Audius API.
// Renders a custom player with cover art, track/curator details, play/pause,
// previous/next controls, a seekable progress bar, and an interactive tracklist.
//
// We query the public Discovery API directly instead of bundling the official
// Audius SDK. This design keeps the client bundle size small.

import { useEffect, useRef, useState } from "react";
import { Play, Pause, SkipForward, SkipBack, ListMusic, ChevronDown, ChevronUp, Music, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface AudiusEmbedProps {
	trackUrl: string;
}

interface TrackMetadata {
	id: string;
	title: string;
	user?: { name: string; handle: string };
	artwork?: { "150x150"?: string; "480x480"?: string };
	duration: number;
}

export function AudiusEmbed({ trackUrl }: AudiusEmbedProps) {
	const [tracks, setTracks] = useState<TrackMetadata[]>([]);
	const [playlistName, setPlaylistName] = useState("");
	const [curatorName, setCuratorName] = useState("");
	const [coverArtUrl, setCoverArtUrl] = useState<string | undefined>(undefined);
	const [isPlaylist, setIsPlaylist] = useState(false);
	const [isAlbum, setIsAlbum] = useState(false);

	const [currentTrackIndex, setCurrentTrackIndex] = useState(0);
	const [isPlaying, setIsPlaying] = useState(false);
	const [progress, setProgress] = useState(0);
	const [currentTime, setCurrentTime] = useState(0);
	const [loading, setLoading] = useState(true);
	const [resolveError, setResolveError] = useState(false);
	const [playbackError, setPlaybackError] = useState<string | null>(null);
	const [showAllTracks, setShowAllTracks] = useState(false);

	const audioRef = useRef<HTMLAudioElement | null>(null);
	const progressBarRef = useRef<HTMLDivElement | null>(null);

	// Fetch metadata from Audius Resolve API.
	useEffect(() => {
		let active = true;
		setTracks([]);
		setPlaylistName("");
		setCuratorName("");
		setCoverArtUrl(undefined);
		setIsPlaylist(false);
		setIsAlbum(false);
		setCurrentTrackIndex(0);
		setIsPlaying(false);
		setProgress(0);
		setCurrentTime(0);
		setLoading(true);
		setResolveError(false);
		setPlaybackError(null);

		const resolveUrl = `https://api.audius.co/v1/resolve?url=${encodeURIComponent(trackUrl)}&app_name=koven`;

		fetch(resolveUrl)
			.then((res) => {
				if (!res.ok) throw new Error("Failed to resolve URL");
				return res.json();
			})
			.then((res) => {
				if (!active) return;
				if (res?.data) {
					if (Array.isArray(res.data)) {
						const playlistObj = res.data[0];
						setIsPlaylist(true);
						setIsAlbum(!!playlistObj.is_album);
						setPlaylistName(playlistObj.playlist_name);
						setCuratorName(playlistObj.user?.name || "Unknown Creator");
						setCoverArtUrl(playlistObj.artwork?.["150x150"]);
						// Filter out tracks that are deleted or unavailable to prevent playback failures.
						const rawTracks = playlistObj.tracks || [];
						const filteredTracks = rawTracks.filter(
							(t: any) => t.is_delete !== true && t.is_available !== false
						);
						setTracks(filteredTracks);
					} else {
						const trackObj = res.data;
						setIsPlaylist(false);
						setIsAlbum(false);
						setPlaylistName(trackObj.title);
						setCuratorName(trackObj.user?.name || "Unknown Artist");
						setCoverArtUrl(trackObj.artwork?.["150x150"]);
						// Filter out single track if it is deleted or unavailable.
						const isDeleted = trackObj.is_delete === true || trackObj.is_available === false;
						setTracks(isDeleted ? [] : [trackObj]);
					}
					setLoading(false);
				} else {
					throw new Error("No data returned");
				}
			})
			.catch(() => {
				if (active) {
					setResolveError(true);
					setLoading(false);
				}
			});

		return () => {
			active = false;
			if (audioRef.current) {
				audioRef.current.pause();
				audioRef.current.src = "";
				try {
					audioRef.current.load();
				} catch (e) {
					// Ignore potential errors during abort load.
				}
				audioRef.current = null;
			}
		};
	}, [trackUrl]);

	// Play track at index.
	const playTrack = (index: number, shouldStartPlaying = true) => {
		const targetTrack = tracks[index];
		if (!targetTrack) return;

		// Clean up existing audio instance.
		if (audioRef.current) {
			audioRef.current.pause();
			audioRef.current.src = "";
			try {
				audioRef.current.load();
			} catch (e) {
				// Ignore load abort errors.
			}
			audioRef.current = null;
		}

		setCurrentTrackIndex(index);
		setProgress(0);
		setCurrentTime(0);
		setPlaybackError(null);

		if (shouldStartPlaying) {
			const streamUrl = `https://api.audius.co/v1/tracks/${targetTrack.id}/stream?app_name=koven`;
			const audio = new Audio(streamUrl);
			audioRef.current = audio;
			const fallbackDuration = targetTrack.duration;

			audio.addEventListener("timeupdate", () => {
				if (audioRef.current) {
					const cur = audioRef.current.currentTime;
					const dur = audioRef.current.duration || fallbackDuration || 0;
					setCurrentTime(cur);
					setProgress(dur > 0 ? (cur / dur) * 100 : 0);
				}
			});

			audio.addEventListener("ended", () => {
				// Auto-advance.
				const nextIndex = index + 1;
				if (nextIndex < tracks.length) {
					playTrack(nextIndex, true);
				} else {
					setIsPlaying(false);
					setProgress(0);
					setCurrentTime(0);
				}
			});

			audio.addEventListener("error", () => {
				// Show error status instead of crashing the entire component.
				setPlaybackError("Playback failed: track unavailable");
				setIsPlaying(false);
			});

			audio.play()
				.then(() => {
					setPlaybackError(null);
					setIsPlaying(true);
				})
				.catch((err) => {
					console.error("Audio playback failed:", err);
					setPlaybackError("Playback failed: track unavailable");
					setIsPlaying(false);
				});
		} else {
			setIsPlaying(false);
		}
	};

	// Play / Pause toggler.
	const togglePlay = () => {
		if (isPlaying) {
			if (audioRef.current) {
				audioRef.current.pause();
			}
			setIsPlaying(false);
		} else {
			if (audioRef.current) {
				audioRef.current.play().then(() => {
					setPlaybackError(null);
					setIsPlaying(true);
				}).catch(() => {
					setPlaybackError("Playback failed: track unavailable");
				});
			} else {
				playTrack(currentTrackIndex, true);
			}
		}
	};

	// Next / Prev track handlers.
	const handleNext = () => {
		if (currentTrackIndex + 1 < tracks.length) {
			playTrack(currentTrackIndex + 1, isPlaying);
		}
	};

	const handlePrev = () => {
		if (audioRef.current && audioRef.current.currentTime > 3) {
			audioRef.current.currentTime = 0;
			setCurrentTime(0);
			setProgress(0);
		} else if (currentTrackIndex - 1 >= 0) {
			playTrack(currentTrackIndex - 1, isPlaying);
		} else if (audioRef.current) {
			audioRef.current.currentTime = 0;
			setCurrentTime(0);
			setProgress(0);
		}
	};

	// Click to seek handler.
	const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
		if (!audioRef.current) return;
		const activeTrack = tracks[currentTrackIndex];
		if (!activeTrack) return;

		const dur = audioRef.current.duration || activeTrack.duration || 0;
		if (dur <= 0) return;

		const rect = e.currentTarget.getBoundingClientRect();
		const clickX = e.clientX - rect.left;
		const width = rect.width;
		const pct = Math.max(0, Math.min(1, clickX / width));

		try {
			audioRef.current.currentTime = pct * dur;
			setProgress(pct * 100);
			setCurrentTime(pct * dur);
		} catch (err) {
			console.warn("Failed to seek audio:", err);
		}
	};

	// Time format helper.
	const formatTime = (secs: number) => {
		if (isNaN(secs) || !isFinite(secs)) return "0:00";
		const m = Math.floor(secs / 60);
		const s = Math.floor(secs % 60);
		return `${m}:${s < 10 ? "0" : ""}${s}`;
	};

	if (loading) {
		return (
			<div className="h-20 w-[420px] max-w-full bg-zinc-900/40 animate-pulse rounded-xl border border-zinc-800/80" />
		);
	}

	if (resolveError || tracks.length === 0) {
		return (
			<div className="w-[420px] max-w-full rounded-xl border border-red-900/30 bg-red-950/20 backdrop-blur-md p-3.5 flex items-center gap-3 text-red-400">
				<AlertTriangle className="w-5 h-5 flex-shrink-0" />
				<span className="text-xs">Failed to load Audius player.</span>
			</div>
		);
	}

	const visibleTracks = showAllTracks ? tracks : tracks.slice(0, 5);

	return (
		<div className="w-[420px] max-w-full rounded-xl border border-zinc-800/60 bg-zinc-950/40 backdrop-blur-md p-3.5 flex flex-col gap-3 text-zinc-100 select-none shadow-xl">
			{/* Cover Artwork & Metadata Header */}
			<div className="flex gap-3 items-center min-w-0">
				<div className="w-16 h-16 rounded-lg overflow-hidden bg-zinc-900 border border-zinc-850 flex-shrink-0 flex items-center justify-center shadow-inner">
					{coverArtUrl ? (
						<img src={coverArtUrl} alt={playlistName} className="w-full h-full object-cover" />
					) : (
						<Music className="w-7 h-7 text-zinc-650" />
					)}
				</div>
				<div className="flex-1 min-w-0 flex flex-col justify-center">
					<div className="flex items-center gap-2 mb-0.5">
						{isPlaylist && (
							<span className={cn(
								"text-[9px] px-1.5 py-0.5 rounded border font-bold uppercase tracking-wider flex-shrink-0",
								isAlbum 
									? "bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/20"
									: "bg-violet-500/10 text-violet-400 border-violet-500/20"
							)}>
								{isAlbum ? "Album" : "Playlist"}
							</span>
						)}
						<h4 className="font-semibold text-sm truncate text-zinc-100 flex-1">{playlistName}</h4>
					</div>
					<p className="text-xs text-zinc-400 truncate">
						{isPlaylist ? `Curated by ${curatorName}` : curatorName}
					</p>
					{!isPlaylist && (
						<span className="text-[10px] text-zinc-500 mt-0.5 font-medium">Single Track</span>
					)}
				</div>
			</div>

			{/* Controls and Progress Bar */}
			<div className="flex items-center gap-3">
				<div className="flex items-center gap-1.5 flex-shrink-0">
					<button
						onClick={handlePrev}
						disabled={tracks.length <= 1}
						className="p-1.5 rounded-full hover:bg-zinc-800/60 active:scale-95 transition-all text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:pointer-events-none"
						title="Previous Track"
					>
						<SkipBack className="w-4 h-4 fill-current" />
					</button>
					
					<button
						onClick={togglePlay}
						className="w-9 h-9 rounded-full bg-gradient-to-tr from-violet-600 to-fuchsia-600 text-white flex items-center justify-center shadow-lg hover:shadow-fuchsia-500/20 hover:scale-105 active:scale-95 transition-all duration-200"
						title={isPlaying ? "Pause" : "Play"}
					>
						{isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
					</button>

					<button
						onClick={handleNext}
						disabled={tracks.length <= 1}
						className="p-1.5 rounded-full hover:bg-zinc-800/60 active:scale-95 transition-all text-zinc-400 hover:text-zinc-200 disabled:opacity-30 disabled:pointer-events-none"
						title="Next Track"
					>
						<SkipForward className="w-4 h-4 fill-current" />
					</button>
				</div>

				{/* Progress Slider */}
				<div className="flex-1 flex flex-col gap-1 min-w-0">
					{playbackError ? (
						<div className="text-[10px] text-red-400 truncate font-medium mb-0.5 flex items-center gap-1">
							<AlertTriangle className="w-3 h-3 flex-shrink-0 text-red-400" />
							<span>{playbackError}</span>
						</div>
					) : (
						isPlaylist && tracks[currentTrackIndex] && (
							<div className="text-[10px] text-zinc-300 truncate font-medium mb-0.5">
								Playing: {tracks[currentTrackIndex].title}
							</div>
						)
					)}
					<div
						ref={progressBarRef}
						onClick={handleSeek}
						className="h-1.5 bg-zinc-800/80 hover:bg-zinc-700/80 rounded-full overflow-hidden cursor-pointer relative transition-colors duration-150"
					>
						<div
							className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500 rounded-full"
							style={{ width: `${progress}%` }}
						/>
					</div>
					<div className="flex justify-between text-[10px] text-zinc-500">
						<span>{formatTime(currentTime)}</span>
						<span>{formatTime(tracks[currentTrackIndex]?.duration || 0)}</span>
					</div>
				</div>
			</div>

			{/* Playlist Tracklist Section */}
			{isPlaylist && (
				<>
					<div className="border-t border-zinc-800/40 my-1" />
					
					<div className="flex flex-col gap-1">
						<div className="flex items-center justify-between text-xs text-zinc-400 px-1 mb-1 font-medium">
							<div className="flex items-center gap-1.5">
								<ListMusic className="w-3.5 h-3.5" />
								<span>Tracks ({tracks.length})</span>
							</div>
						</div>

						<div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-0.5 scrollbar-thin">
							{visibleTracks.map((t, i) => {
								const isActive = i === currentTrackIndex;
								return (
									<div
										key={`${t.id}-${i}`}
										onClick={() => playTrack(i, true)}
										className={cn(
											"hover:bg-zinc-800/40 cursor-pointer rounded-md p-1.5 flex justify-between items-center text-xs transition-colors duration-150",
											isActive 
												? "bg-violet-950/20 text-violet-400 font-semibold border-l-2 border-violet-500 pl-2" 
												: "text-zinc-300 pl-2.5"
										)}
									>
										<div className="flex items-center gap-2 min-w-0">
											<span className="text-[10px] text-zinc-500 w-4 text-right flex-shrink-0">
												{isActive && isPlaying ? (
													<span className="flex gap-0.5 justify-center items-end h-2 w-2.5">
														<span className="w-[1.5px] bg-violet-400 animate-bounce h-2" style={{ animationDelay: "0.1s" }} />
														<span className="w-[1.5px] bg-violet-400 animate-bounce h-1.5" style={{ animationDelay: "0.3s" }} />
														<span className="w-[1.5px] bg-violet-400 animate-bounce h-2" style={{ animationDelay: "0.5s" }} />
													</span>
												) : (
													`${i + 1}.`
												)}
											</span>
											<span className="truncate">{t.title}</span>
										</div>
										<span className="text-[10px] text-zinc-500 flex-shrink-0 pl-2">
											{formatTime(t.duration)}
										</span>
									</div>
								);
							})}
						</div>

						{tracks.length > 5 && (
							<button
								onClick={() => setShowAllTracks(!showAllTracks)}
								className="w-full text-center text-[10px] text-zinc-400 hover:text-zinc-200 mt-1 py-1 flex items-center justify-center gap-1 hover:bg-zinc-800/20 rounded transition-colors duration-150"
							>
								{showAllTracks ? (
									<>
										<span>Show Less</span>
										<ChevronUp className="w-3 h-3" />
									</>
								) : (
									<>
										<span>Show More ({tracks.length - 5} more)</span>
										<ChevronDown className="w-3 h-3" />
									</>
								)}
							</button>
						)}
					</div>
				</>
			)}
		</div>
	);
}

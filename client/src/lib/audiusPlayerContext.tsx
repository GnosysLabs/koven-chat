import React, { createContext, useContext, useEffect, useRef, useState } from "react";

export interface TrackMetadata {
	id: string;
	title: string;
	user?: { name: string; handle: string };
	artwork?: { "150x150"?: string; "480x480"?: string };
	duration: number;
}

export interface AudiusPlayerContextValue {
	activeTrackUrl: string | null;
	playingRoomId: string | null;
	tracks: TrackMetadata[];
	playlistName: string;
	curatorName: string;
	coverArtUrl: string | undefined;
	isPlaylist: boolean;
	isAlbum: boolean;
	currentTrackIndex: number;
	isPlaying: boolean;
	progress: number;
	currentTime: number;
	duration: number;
	playbackError: string | null;
	play: (params: {
		trackUrl: string;
		roomId: string;
		tracks: TrackMetadata[];
		playlistName: string;
		curatorName: string;
		coverArtUrl: string | undefined;
		isPlaylist: boolean;
		isAlbum: boolean;
		initialTrackIndex: number;
	}) => void;
	togglePlay: () => void;
	next: () => void;
	prev: () => void;
	seek: (pct: number) => void;
	playTrack: (index: number, shouldStartPlaying?: boolean) => void;
	stop: () => void;
}

const AudiusPlayerContext = createContext<AudiusPlayerContextValue | null>(null);

export function AudiusPlayerProvider({ children }: { children: React.ReactNode }) {
	const [activeTrackUrl, setActiveTrackUrl] = useState<string | null>(null);
	const [playingRoomId, setPlayingRoomId] = useState<string | null>(null);
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
	const [duration, setDuration] = useState(0);
	const [playbackError, setPlaybackError] = useState<string | null>(null);

	const audioRef = useRef<HTMLAudioElement | null>(null);

	const tracksRef = useRef<TrackMetadata[]>([]);
	const currentTrackIndexRef = useRef<number>(0);
	const isPlayingRef = useRef<boolean>(false);

	useEffect(() => {
		tracksRef.current = tracks;
	}, [tracks]);

	useEffect(() => {
		currentTrackIndexRef.current = currentTrackIndex;
	}, [currentTrackIndex]);

	useEffect(() => {
		isPlayingRef.current = isPlaying;
	}, [isPlaying]);

	const cleanUpAudio = () => {
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
	};

	const startAudio = (trackList: TrackMetadata[], index: number, shouldPlay: boolean) => {
		cleanUpAudio();

		const targetTrack = trackList[index];
		if (!targetTrack) return;

		setCurrentTrackIndex(index);
		setProgress(0);
		setCurrentTime(0);
		setDuration(targetTrack.duration);
		setPlaybackError(null);

		if (!shouldPlay) {
			setIsPlaying(false);
			return;
		}

		const streamUrl = `https://api.audius.co/v1/tracks/${targetTrack.id}/stream?app_name=koven`;
		const audio = new Audio(streamUrl);
		audioRef.current = audio;
		const fallbackDuration = targetTrack.duration;

		audio.addEventListener("timeupdate", () => {
			if (audioRef.current === audio) {
				const cur = audio.currentTime;
				const dur = audio.duration || fallbackDuration || 0;
				setCurrentTime(cur);
				setProgress(dur > 0 ? (cur / dur) * 100 : 0);
			}
		});

		audio.addEventListener("durationchange", () => {
			if (audioRef.current === audio && audio.duration) {
				setDuration(audio.duration);
			}
		});

		audio.addEventListener("ended", () => {
			if (audioRef.current === audio) {
				const nextIndex = currentTrackIndexRef.current + 1;
				if (nextIndex < tracksRef.current.length) {
					startAudio(tracksRef.current, nextIndex, true);
				} else {
					setIsPlaying(false);
					setProgress(0);
					setCurrentTime(0);
				}
			}
		});

		audio.addEventListener("error", () => {
			if (audioRef.current === audio) {
				setPlaybackError("Playback failed: track unavailable");
				setIsPlaying(false);
			}
		});

		audio.play()
			.then(() => {
				if (audioRef.current === audio) {
					setPlaybackError(null);
					setIsPlaying(true);
				}
			})
			.catch((err) => {
				console.error("Global audio playback failed:", err);
				if (audioRef.current === audio) {
					setPlaybackError("Playback failed: track unavailable");
					setIsPlaying(false);
				}
			});
	};

	const play = (params: {
		trackUrl: string;
		roomId: string;
		tracks: TrackMetadata[];
		playlistName: string;
		curatorName: string;
		coverArtUrl: string | undefined;
		isPlaylist: boolean;
		isAlbum: boolean;
		initialTrackIndex: number;
	}) => {
		setActiveTrackUrl(params.trackUrl);
		setPlayingRoomId(params.roomId);
		setTracks(params.tracks);
		setPlaylistName(params.playlistName);
		setCuratorName(params.curatorName);
		setCoverArtUrl(params.coverArtUrl);
		setIsPlaylist(params.isPlaylist);
		setIsAlbum(params.isAlbum);

		startAudio(params.tracks, params.initialTrackIndex, true);
	};

	const togglePlay = () => {
		const audio = audioRef.current;
		if (isPlayingRef.current) {
			if (audio) {
				audio.pause();
			}
			setIsPlaying(false);
		} else {
			if (audio) {
				audio.play()
					.then(() => {
						setPlaybackError(null);
						setIsPlaying(true);
					})
					.catch(() => {
						setPlaybackError("Playback failed: track unavailable");
					});
			} else {
				if (tracksRef.current.length > 0) {
					startAudio(tracksRef.current, currentTrackIndexRef.current, true);
				}
			}
		}
	};

	const next = () => {
		const nextIndex = currentTrackIndexRef.current + 1;
		if (nextIndex < tracksRef.current.length) {
			startAudio(tracksRef.current, nextIndex, isPlayingRef.current);
		}
	};

	const prev = () => {
		const audio = audioRef.current;
		if (audio && audio.currentTime > 3) {
			audio.currentTime = 0;
			setCurrentTime(0);
			setProgress(0);
		} else {
			const prevIndex = currentTrackIndexRef.current - 1;
			if (prevIndex >= 0) {
				startAudio(tracksRef.current, prevIndex, isPlayingRef.current);
			} else if (audio) {
				audio.currentTime = 0;
				setCurrentTime(0);
				setProgress(0);
			}
		}
	};

	const seek = (pct: number) => {
		const audio = audioRef.current;
		if (!audio) return;
		const activeTrack = tracksRef.current[currentTrackIndexRef.current];
		if (!activeTrack) return;
		const dur = audio.duration || activeTrack.duration || 0;
		if (dur <= 0) return;
		try {
			audio.currentTime = pct * dur;
			setProgress(pct * 100);
			setCurrentTime(pct * dur);
		} catch (err) {
			console.warn("Failed to seek audio:", err);
		}
	};

	const playTrack = (index: number, shouldStartPlaying = true) => {
		if (index >= 0 && index < tracksRef.current.length) {
			startAudio(tracksRef.current, index, shouldStartPlaying);
		}
	};

	const stop = () => {
		cleanUpAudio();
		setActiveTrackUrl(null);
		setPlayingRoomId(null);
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
		setDuration(0);
		setPlaybackError(null);
	};

	useEffect(() => {
		return () => {
			cleanUpAudio();
		};
	}, []);

	return (
		<AudiusPlayerContext.Provider
			value={{
				activeTrackUrl,
				playingRoomId,
				tracks,
				playlistName,
				curatorName,
				coverArtUrl,
				isPlaylist,
				isAlbum,
				currentTrackIndex,
				isPlaying,
				progress,
				currentTime,
				duration,
				playbackError,
				play,
				togglePlay,
				next,
				prev,
				seek,
				playTrack,
				stop,
			}}
		>
			{children}
		</AudiusPlayerContext.Provider>
	);
}

export function useAudiusPlayer() {
	const context = useContext(AudiusPlayerContext);
	if (!context) {
		throw new Error("useAudiusPlayer must be used within an AudiusPlayerProvider");
	}
	return context;
}

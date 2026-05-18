// Hyperbeam shared-browser embed for the in-call spotlight.
//
// Video: the SDK's shadow-DOM rendering works in Chrome but fails
// silently in WKWebView (Tauri desktop on macOS).  We use
// `videoTrackCb` to capture the raw MediaStreamTrack and render it
// in our own <video> element that works everywhere.
//
// Input: since we handle video externally, the SDK's shadow-DOM
// input surface doesn't reliably capture events.  We listen for
// mouse, keyboard, and wheel events on our interactive overlay and
// forward them to the VM via `hb.sendEvent()` with normalized 0-1
// coordinates.  This is Hyperbeam's supported API for custom
// rendering setups.
//
// Resize: a ResizeObserver + hb.resize() keeps the cloud VM's
// viewport matched to the container so there are no letterbox bars.

import { useCallback, useEffect, useRef, useState } from "react";
import Hyperbeam, { type HyperbeamEmbed } from "@hyperbeam/web";
import { cn } from "@/lib/utils";

export interface SharedBrowserTileProps {
	embedUrl: string;
	className?: string;
}

export function SharedBrowserTile({ embedUrl, className }: SharedBrowserTileProps) {
	const wrapperRef = useRef<HTMLDivElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const videoRef = useRef<HTMLVideoElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);
	const hbRef = useRef<HyperbeamEmbed | null>(null);
	const [state, setState] = useState<"connecting" | "ready" | "error">("connecting");
	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	// Initialize the Hyperbeam SDK.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let destroyed = false;

		Hyperbeam(container, embedUrl, {
			videoTrackCb: (track) => {
				const video = videoRef.current;
				if (!video || destroyed) return;
				const stream = new MediaStream([track]);
				video.srcObject = stream;
				video.play().catch(() => {});
			},
			onConnectionStateChange: (e) => {
				if (destroyed) return;
				if (e.state === "playing") setState("ready");
				if (e.state === "failed") {
					setState("error");
					setErrorMsg("Connection to shared browser lost");
				}
			},
			onDisconnect: () => {
				if (destroyed) return;
				setState("error");
				setErrorMsg("Shared browser session ended");
			},
		})
			.then((hb) => {
				if (destroyed) {
					hb.destroy();
					return;
				}
				hbRef.current = hb;
				setState("ready");
				const { width, height } = container.getBoundingClientRect();
				if (width > 0 && height > 0) {
					hb.resize(Math.round(width), Math.round(height)).catch(() => {});
				}
			})
			.catch((err) => {
				if (destroyed) return;
				setState("error");
				setErrorMsg(err instanceof Error ? err.message : "Failed to connect");
			});

		return () => {
			destroyed = true;
			if (videoRef.current) videoRef.current.srcObject = null;
			hbRef.current?.destroy();
			hbRef.current = null;
		};
	}, [embedUrl]);

	// Resize the VM viewport to match the container.
	useEffect(() => {
		const wrapper = wrapperRef.current;
		if (!wrapper) return;

		let timer: ReturnType<typeof setTimeout> | null = null;
		const ro = new ResizeObserver((entries) => {
			const hb = hbRef.current;
			if (!hb) return;
			const entry = entries[0];
			if (!entry) return;
			const { width, height } = entry.contentRect;
			if (width <= 0 || height <= 0) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				hb.resize(Math.round(width), Math.round(height)).catch(() => {});
			}, 150);
		});
		ro.observe(wrapper);
		return () => {
			ro.disconnect();
			if (timer) clearTimeout(timer);
		};
	}, []);

	// Forward mouse events to the VM as normalized 0-1 coordinates.
	const sendMouse = useCallback((e: React.MouseEvent, type: "mousedown" | "mousemove" | "mouseup") => {
		const hb = hbRef.current;
		const overlay = overlayRef.current;
		if (!hb || !overlay) return;
		const rect = overlay.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		hb.sendEvent({
			type,
			x: (e.clientX - rect.left) / rect.width,
			y: (e.clientY - rect.top) / rect.height,
			button: e.button,
		});
	}, []);

	// Forward wheel events.
	useEffect(() => {
		const overlay = overlayRef.current;
		if (!overlay) return;
		const handler = (e: WheelEvent) => {
			const hb = hbRef.current;
			if (!hb) return;
			e.preventDefault();
			hb.sendEvent({ type: "wheel", deltaY: e.deltaY });
		};
		overlay.addEventListener("wheel", handler, { passive: false });
		return () => overlay.removeEventListener("wheel", handler);
	}, []);

	// Forward keyboard events when the overlay is focused.
	useEffect(() => {
		const overlay = overlayRef.current;
		if (!overlay) return;
		const onKey = (e: KeyboardEvent) => {
			const hb = hbRef.current;
			if (!hb) return;
			e.preventDefault();
			hb.sendEvent({
				type: e.type as "keydown" | "keyup",
				key: e.key,
				ctrlKey: e.ctrlKey,
				metaKey: e.metaKey,
			});
		};
		overlay.addEventListener("keydown", onKey);
		overlay.addEventListener("keyup", onKey);
		return () => {
			overlay.removeEventListener("keydown", onKey);
			overlay.removeEventListener("keyup", onKey);
		};
	}, []);

	return (
		<div
			ref={wrapperRef}
			className={cn(
				"relative w-full h-full rounded-xl overflow-hidden bg-muted",
				className,
			)}
		>
			{/* Hidden SDK container: Hyperbeam attaches its shadow DOM
			    here for signaling + WebRTC.  We don't rely on it for
			    rendering or input, but the SDK needs a mounted DOM
			    node to initialize against. */}
			<div ref={containerRef} className="absolute w-0 h-0 overflow-hidden" />

			{/* Video layer: renders the raw WebRTC track captured via
			    videoTrackCb.  Works in both Chrome and WKWebView. */}
			<video
				ref={videoRef}
				autoPlay
				playsInline
				muted
				className="absolute inset-0 w-full h-full object-cover"
			/>

			{/* Interactive overlay: captures mouse, keyboard, and wheel
			    events and forwards them to the VM via hb.sendEvent()
			    with normalized coordinates.  tabIndex makes it
			    focusable so keyboard events reach it. */}
			{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
			<div
				ref={overlayRef}
				tabIndex={0}
				className="absolute inset-0 w-full h-full z-10 outline-none cursor-default"
				onMouseDown={(e) => sendMouse(e, "mousedown")}
				onMouseMove={(e) => sendMouse(e, "mousemove")}
				onMouseUp={(e) => sendMouse(e, "mouseup")}
				onContextMenu={(e) => e.preventDefault()}
			/>

			{state === "connecting" && (
				<div className="absolute inset-0 flex items-center justify-center bg-muted z-20">
					<p className="text-sm text-muted-foreground animate-pulse">
						Connecting to shared browser...
					</p>
				</div>
			)}

			{state === "error" && (
				<div className="absolute inset-0 flex items-center justify-center bg-muted z-20">
					<p className="text-sm text-destructive">
						{errorMsg ?? "Something went wrong"}
					</p>
				</div>
			)}
		</div>
	);
}

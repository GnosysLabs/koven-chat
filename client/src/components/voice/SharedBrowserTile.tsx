// Hyperbeam shared-browser embed for the in-call spotlight.
//
// Mounts the @hyperbeam/web SDK into a div and streams the cloud
// browser.  Multi-cursor input is handled natively by the SDK.
// Cleans up on unmount so the WebRTC session doesn't leak.
//
// Uses a ResizeObserver + hb.resize() so the cloud VM's viewport
// always matches the container's pixel dimensions.  This eliminates
// letterbox bars: the VM renders at exactly the size we show it.

import { useEffect, useRef, useState } from "react";
import Hyperbeam, { type HyperbeamEmbed } from "@hyperbeam/web";
import { cn } from "@/lib/utils";

export interface SharedBrowserTileProps {
	embedUrl: string;
	className?: string;
}

export function SharedBrowserTile({ embedUrl, className }: SharedBrowserTileProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const hbRef = useRef<HyperbeamEmbed | null>(null);
	const [state, setState] = useState<"connecting" | "ready" | "error">("connecting");
	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let destroyed = false;

		Hyperbeam(container, embedUrl, {
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
				// Initial resize to match the container right away.
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
			hbRef.current?.destroy();
			hbRef.current = null;
		};
	}, [embedUrl]);

	// Keep the cloud VM's viewport in sync with the container so
	// there are never letterbox bars.  The observer fires on mount
	// and whenever the container resizes (window resize, layout
	// shift, etc.).  Debounced slightly so rapid resize drags don't
	// spam the Hyperbeam control channel.
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

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
		ro.observe(container);
		return () => {
			ro.disconnect();
			if (timer) clearTimeout(timer);
		};
	}, []);

	return (
		<div
			className={cn(
				"relative w-full h-full rounded-xl overflow-hidden bg-muted",
				className,
			)}
		>
			<div ref={containerRef} className="w-full h-full" />

			{state === "connecting" && (
				<div className="absolute inset-0 flex items-center justify-center bg-muted">
					<p className="text-sm text-muted-foreground animate-pulse">
						Connecting to shared browser...
					</p>
				</div>
			)}

			{state === "error" && (
				<div className="absolute inset-0 flex items-center justify-center bg-muted">
					<p className="text-sm text-destructive">
						{errorMsg ?? "Something went wrong"}
					</p>
				</div>
			)}
		</div>
	);
}

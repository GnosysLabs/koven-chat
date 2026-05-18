// Hyperbeam shared-browser embed for the in-call spotlight.
//
// Mounts the @hyperbeam/web SDK into a div and streams the cloud
// browser.  Multi-cursor input is handled natively by the SDK.
// Cleans up on unmount so the WebRTC session doesn't leak.

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

	return (
		<div
			className={cn(
				"relative w-full h-full rounded-lg overflow-hidden bg-black",
				className,
			)}
		>
			<div ref={containerRef} className="w-full h-full" />

			{state === "connecting" && (
				<div className="absolute inset-0 flex items-center justify-center bg-black/60">
					<p className="text-sm text-muted-foreground animate-pulse">
						Connecting to shared browser...
					</p>
				</div>
			)}

			{state === "error" && (
				<div className="absolute inset-0 flex items-center justify-center bg-black/60">
					<p className="text-sm text-destructive">
						{errorMsg ?? "Something went wrong"}
					</p>
				</div>
			)}
		</div>
	);
}

// Connecting screen — shown between successful sign-in and the
// encryption-state probe resolving (rust-crypto WASM load + initial
// Matrix sync + SSSS read).  Same brand canvas as LoginMobile so the
// transition from login → connecting → encryption setup / unlock
// reads as one continuous flow rather than three different UIs.
//
// Pre-iOS-HIG version was a single line of muted text centered on a
// flat bg.  This adds: brand wallpaper, wordmark, 17pt status copy,
// an iOS-style ring spinner positioned where the form sits on the
// surrounding screens (so layout-shift between screens is minimal).
//
// Mobile-only by design.  Desktop keeps the small inline status div
// because it has nav-bar / sync-banner chrome around it that this
// screen would conflict with.

import { isNativeShell } from "@/lib/nativeShell";
import { IosBrandSurface } from "@/components/IosForm";

export function ConnectingMobile({ label = "Connecting…" }: { label?: string }) {
	const inNativeShell = isNativeShell();
	return (
		<IosBrandSurface showWallpaper={inNativeShell}>
			<div
				className="flex flex-col min-h-full px-6"
				style={{
					paddingTop: "max(env(safe-area-inset-top), 0.5rem)",
					paddingBottom: "max(env(safe-area-inset-bottom), 1rem)",
				}}
			>
				{/* Nav slot held empty so the wordmark sits at the same
				    vertical position as on Login / Encryption screens —
				    eliminates visible jump on transition. */}
				<div className="h-10" />

				<div className="pt-2 pb-1 flex items-center justify-center">
					{inNativeShell ? (
						<img
							src="/koven-wordmark.png"
							alt="Koven"
							className="h-10 max-w-[55%] object-contain opacity-95"
						/>
					) : (
						<span className="text-[17px] font-semibold tracking-tight text-white">Koven</span>
					)}
				</div>

				{/* Spinner + label centered in the remaining space.
				    24pt ring matches iOS's medium activity-indicator
				    proportions; 17pt label is the iOS body size. */}
				<div className="flex-1 flex flex-col items-center justify-center gap-5 pb-20">
					<span
						aria-hidden
						className="block size-7 rounded-full border-[2.5px] border-white/20 border-t-white animate-spin"
					/>
					<p className="text-[17px] text-white/75 tracking-tight" role="status" aria-live="polite">
						{label}
					</p>
				</div>
			</div>
		</IosBrandSurface>
	);
}

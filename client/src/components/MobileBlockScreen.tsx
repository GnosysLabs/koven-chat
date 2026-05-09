// Full-screen mobile block.  Shown when the viewport / pointer
// detection in `lib/mobile.ts` reports a mobile context AND the SPA
// isn't running inside the Tauri desktop shell.
//
// Why block: the mobile UX is in active development and isn't ready
// for users yet.  Better to be honest about it than ship a sub-par
// experience that taints first impressions.  Once the mobile layout
// matures, drop the gate in App.tsx — none of the mobile UI code
// underneath is removed, just bypassed.

import { Monitor } from "lucide-react";

export function MobileBlockScreen() {
	return (
		<div
			className="fixed inset-0 z-[100] flex flex-col items-center justify-center px-6 text-center bg-background"
			style={{
				backgroundImage: "var(--bg-gradient)",
				backgroundAttachment: "fixed",
				backgroundRepeat: "no-repeat",
				backgroundSize: "cover",
				paddingTop: "calc(env(safe-area-inset-top) + 1rem)",
				paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)",
			}}
		>
			<div className="max-w-sm space-y-8 flex flex-col items-center">
				{/* Brand wordmark — single image with the prism mark and
				    "KOVEN" lettering.  Sized so the wordmark dominates
				    the screen without crowding the message below. */}
				<img
					src="/koven-wordmark.png"
					alt="Koven"
					className="w-full max-w-[280px] h-auto"
				/>

				<div className="flex flex-col items-center gap-3">
					<div className="rounded-full bg-primary/10 p-3 text-primary">
						<Monitor className="h-6 w-6" />
					</div>
					<h1 className="text-xl font-semibold">
						Built for desktop
					</h1>
					<p className="text-sm text-muted-foreground leading-relaxed">
						Koven on phones isn&rsquo;t ready yet. Open this page on a desktop computer, or install the desktop app.
					</p>
				</div>
			</div>
		</div>
	);
}

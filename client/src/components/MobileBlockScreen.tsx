// Full-screen mobile block.  Shown when the viewport / pointer
// detection in `lib/mobile.ts` reports a mobile context AND the SPA
// isn't running inside the Tauri desktop shell.
//
// Why block: the mobile UX is in active development and isn't ready
// for users yet — better to be honest about it and direct people to
// the desktop app than ship a sub-par experience that taints first
// impressions.  Once the mobile layout matures, we drop this.
//
// Exempts:
//   - Tauri desktop shell (`__KOVEN_DESKTOP__`) — even if the user
//     has the desktop window resized small, they're using the
//     desktop app and shouldn't be locked out.
//
// What it shows:
//   - Brand mark (logo or "Koven" text)
//   - Plain-spoken explanation
//   - GitHub release link for the desktop installer
//   - Note that client.koven.chat works in any desktop browser

import { ExternalLink, Monitor } from "lucide-react";
import { resolveAssetUrl, type InstanceConfig } from "@/lib/instance";

interface MobileBlockScreenProps {
	instance?: InstanceConfig;
}

export function MobileBlockScreen({ instance }: MobileBlockScreenProps) {
	const brandName = instance?.name?.trim() || "Koven";
	const logoUrl = resolveAssetUrl(instance?.logo_url);
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
			<div className="max-w-sm space-y-6">
				<div className="flex flex-col items-center gap-3">
					{logoUrl ? (
						<img
							src={logoUrl}
							alt={brandName}
							className="h-14 max-w-[200px] object-contain"
						/>
					) : (
						<div className="text-2xl font-semibold tracking-tight">{brandName}</div>
					)}
				</div>

				<div className="flex flex-col items-center gap-3">
					<div className="rounded-full bg-primary/10 p-3 text-primary">
						<Monitor className="h-6 w-6" />
					</div>
					<h1 className="text-xl font-semibold">
						Built for desktop
					</h1>
					<p className="text-sm text-muted-foreground leading-relaxed">
						{brandName} on phones isn&rsquo;t ready yet. Install the desktop app, or open this page on a computer.
					</p>
				</div>

				<div className="space-y-3">
					<a
						href="https://github.com/GnosysLabs/koven-chat/releases/latest"
						target="_blank"
						rel="noreferrer"
						className="flex items-center justify-center gap-2 w-full rounded-md bg-primary text-primary-foreground py-3 text-sm font-medium hover:bg-primary/90 transition-colors"
					>
						<Monitor className="h-4 w-4" />
						Download the desktop app
					</a>
					<div className="text-[11px] text-muted-foreground leading-relaxed">
						Or open <span className="font-mono text-foreground">client.koven.chat</span> on any desktop browser.
					</div>
				</div>

				<div className="text-[10px] text-muted-foreground/60 pt-4 border-t border-border/40">
					Mobile support is in development.{" "}
					<a
						href="https://github.com/GnosysLabs/koven-chat"
						target="_blank"
						rel="noreferrer"
						className="underline inline-flex items-center gap-1"
					>
						Track progress
						<ExternalLink className="h-3 w-3" />
					</a>
				</div>
			</div>
		</div>
	);
}

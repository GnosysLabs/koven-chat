// Download CTAs for the native Koven Desktop builds.  Rendered on
// the login screen below the auth form for logged-out web visitors.
//
// Three buttons mirroring the irisirc.chat pattern:
//   - **Mac**:     direct download link to the .app.tar.gz updater
//                  archive (Tauri's Sparkle-style zip distribution).
//   - **Windows**: opens a modal with the .exe download + the
//                  "Windows protected your PC" SmartScreen workaround
//                  steps the user has to walk through on first launch
//                  (we're not Authenticode-signed yet).
//   - **Linux**:   opens a modal with the .AppImage download + the
//                  chmod+x / "Allow executing as program" steps.
//                  The .deb is offered as a secondary affordance for
//                  Debian/Ubuntu users — recommended path on those
//                  distros because dock-icon integration is more
//                  reliable than AppImage on GNOME.
//
// Hidden when running inside the Tauri bundle itself — there's no
// point offering "Download the app" to a user who's already running
// the app.

import { useState } from "react";
import { Apple, Download, Monitor, Terminal } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isTauriBundle } from "@/lib/urls";
import { useDesktopReleases, type DesktopReleases } from "@/lib/desktop-releases";

const RELEASES_PAGE = "https://github.com/GnosysLabs/koven-chat/releases/latest";

export function DesktopDownloads() {
	const releases = useDesktopReleases();
	const [openModal, setOpenModal] = useState<"windows" | "linux" | null>(null);

	// Don't surface "Download the app" to a user already running the
	// desktop app.  Tauri's auto-updater handles new versions there
	// without the user touching a download button.
	if (isTauriBundle()) return null;

	// Pre-load: render nothing.  The CTA appearing mid-paint after
	// the login form has settled is the kind of jank we just spent
	// a session removing — wait for the GH API call to land or fail.
	if (releases === undefined) return null;

	// API failure / no published release yet: fall back to a single
	// link to the GitHub Releases page.  The user can pick the right
	// asset from there manually.  Better than hiding the affordance
	// entirely, since "where do I get the desktop app" is a real
	// question the page should answer.
	if (releases === null) {
		return (
			<div className="text-center mt-2">
				<a
					href={RELEASES_PAGE}
					target="_blank"
					rel="noopener noreferrer"
					className="text-xs underline underline-offset-2 opacity-80 hover:opacity-100 transition-opacity"
				>
					Get the desktop app
				</a>
			</div>
		);
	}

	return (
		<>
			<div className="space-y-2 mt-2">
				<p className="text-[11px] text-center uppercase tracking-wider opacity-70">
					Or get the native app
				</p>
				<div className="grid grid-cols-3 gap-2">
					<DlButton
						icon={<Apple className="h-3.5 w-3.5" />}
						label="Mac"
						href={releases.macos}
						fallbackHref={RELEASES_PAGE}
					/>
					<DlButton
						icon={<Monitor className="h-3.5 w-3.5" />}
						label="Windows"
						onClick={releases.windows ? () => setOpenModal("windows") : undefined}
						fallbackHref={RELEASES_PAGE}
					/>
					<DlButton
						icon={<Terminal className="h-3.5 w-3.5" />}
						label="Linux"
						onClick={releases.linuxAppImage ? () => setOpenModal("linux") : undefined}
						fallbackHref={RELEASES_PAGE}
					/>
				</div>
			</div>

			<WindowsModal
				open={openModal === "windows"}
				onOpenChange={(open) => setOpenModal(open ? "windows" : null)}
				releases={releases}
			/>
			<LinuxModal
				open={openModal === "linux"}
				onOpenChange={(open) => setOpenModal(open ? "linux" : null)}
				releases={releases}
			/>
		</>
	);
}

function DlButton({
	icon, label, href, onClick, fallbackHref,
}: {
	icon: React.ReactNode;
	label: string;
	// One of href / onClick — direct download for Mac, click-to-open-
	// modal for Windows + Linux.
	href?: string;
	onClick?: () => void;
	// Used when neither `href` nor `onClick` is provided (asset
	// missing from the latest release for some reason — better to
	// link to the Releases page than render a dead button).
	fallbackHref: string;
}) {
	const className =
		"flex items-center justify-center gap-1.5 px-2 py-2 rounded-md text-xs font-medium " +
		"bg-card/50 border border-border hover:bg-accent transition-colors";
	if (onClick) {
		return (
			<button type="button" onClick={onClick} className={className}>
				{icon}
				{label}
			</button>
		);
	}
	return (
		<a
			href={href ?? fallbackHref}
			target={href ? undefined : "_blank"}
			rel={href ? undefined : "noopener noreferrer"}
			className={className}
		>
			{icon}
			{label}
		</a>
	);
}

function WindowsModal({
	open, onOpenChange, releases,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	releases: DesktopReleases;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Download Koven for Windows</DialogTitle>
					<DialogDescription>
						Native NSIS installer — works on Windows 10 and 11.
					</DialogDescription>
				</DialogHeader>

				{releases.windows && (
					<a
						href={releases.windows}
						className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-border hover:bg-accent transition-colors"
					>
						<div className="text-left">
							<div className="text-sm font-semibold">Intel / AMD (x86_64)</div>
							<div className="text-xs text-muted-foreground mt-0.5">All modern Windows PCs</div>
						</div>
						<span className="text-xs text-primary inline-flex items-center gap-1">
							<Download className="h-3.5 w-3.5" />
							Download
						</span>
					</a>
				)}

				<div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-xs leading-relaxed">
					<div className="font-semibold mb-1.5">First launch</div>
					<ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
						<li>
							Windows shows a <em>"Windows protected your PC"</em> screen
							because Koven isn't code-signed yet. Click <strong>More info</strong>.
						</li>
						<li>
							Click <strong>Run anyway</strong>. You'll only see this once —
							Windows remembers the choice.
						</li>
					</ol>
				</div>

				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function LinuxModal({
	open, onOpenChange, releases,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	releases: DesktopReleases;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Download Koven for Linux</DialogTitle>
					<DialogDescription>
						Native AppImage — runs on any modern x86_64 distro.
					</DialogDescription>
				</DialogHeader>

				{releases.linuxAppImage && (
					<a
						href={releases.linuxAppImage}
						className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-border hover:bg-accent transition-colors"
					>
						<div className="text-left min-w-0">
							<div className="text-sm font-semibold">Intel / AMD (x86_64)</div>
							<div className="text-xs text-muted-foreground mt-0.5">
								Most desktops &amp; laptops, NUCs, cloud VMs
							</div>
						</div>
						<span className="text-xs text-primary inline-flex items-center gap-1 shrink-0">
							<Download className="h-3.5 w-3.5" />
							Download
						</span>
					</a>
				)}

				<div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-xs leading-relaxed">
					<div className="font-semibold mb-1.5">How to run</div>
					<ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
						<li>
							Right-click the downloaded file → <strong>Properties</strong> →{" "}
							<strong>Permissions</strong> → tick{" "}
							<strong>"Allow executing as program"</strong>.
						</li>
						<li>Double-click the file to launch Koven.</li>
					</ol>
				</div>

				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

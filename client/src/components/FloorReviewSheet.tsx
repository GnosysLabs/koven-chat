// Admin floor-violation review queue, surfaced via the shield icon
// above Settings in the SpaceBar.  Used to live as a Settings tab;
// promoted to a top-level dialog because (a) it's an admin's most
// actionable surface and (b) the shield gets a red dot when there
// are pending cases, which works better directly in the rail than
// buried two clicks deep in Settings.
//
// Thin wrapper around <FloorReviewSection>: the Dialog chrome is
// here, the actual case list + actions live in the section
// component (also reused if we ever want to embed this surface
// elsewhere).

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ShieldAlert } from "lucide-react";
import { FloorReviewSection } from "@/components/FloorReviewSection";
import type { MatrixTransport } from "@/lib/matrix";

export interface FloorReviewSheetProps {
	open: boolean;
	onOpenChange(open: boolean): void;
	accessToken: string;
	transport: MatrixTransport | null;
	// Fired after every confirm/reverse so the parent's badge counter
	// stays in sync without having to re-poll on a fixed cadence.
	onQueueChanged?(): void;
}

export function FloorReviewSheet({
	open, onOpenChange, accessToken, transport, onQueueChanged,
}: FloorReviewSheetProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<ShieldAlert className="h-4 w-4 text-destructive" />
						Pending review
					</DialogTitle>
					<DialogDescription>
						Floor-violation suspensions and auto-suspended repeat false flaggers awaiting your decision.
					</DialogDescription>
				</DialogHeader>
				<FloorReviewSection
					accessToken={accessToken}
					transport={transport}
					onQueueChanged={onQueueChanged}
				/>
			</DialogContent>
		</Dialog>
	);
}

// Noise-suppression toggle row, shared between the pre-join screen
// and the in-call device menu.  Sits alongside the device pickers in
// the Devices popover rather than getting its own control-bar button,
// so the call control bar stays uncluttered.  Reads / writes the
// preference through the call context (persisted across calls).

import { Sparkles } from "lucide-react";
import { useCall } from "@/lib/call-context";
import { Switch } from "@/components/ui/switch";

export function NoiseSuppressionToggle() {
	const { noiseSuppressionEnabled, setNoiseSuppressionEnabled } = useCall();
	return (
		<label className="flex items-center gap-2.5 h-9 px-3 rounded-md border border-border bg-background/50 cursor-pointer hover:bg-accent/50 transition-colors">
			<Sparkles className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
			<span className="flex-1 text-xs text-foreground">Noise suppression</span>
			<Switch
				checked={noiseSuppressionEnabled}
				onCheckedChange={setNoiseSuppressionEnabled}
			/>
		</label>
	);
}

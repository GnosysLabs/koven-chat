// Compact device-picker dropdown row, shared between the pre-join
// screen and the in-call device menu.  Icon prefix tells the user
// which device kind it controls (mic, cam, speaker) without a wordy
// text label, leaving the row short enough to stack three of them
// in a tight column.  Native <select> for free keyboard nav,
// screen-reader semantics, and long-list scrolling — no extra dep.
//
// When the SDK reports zero devices for the kind (e.g. permissions
// not yet granted), the placeholder shows so the control still
// reads as legible-but-empty rather than broken.

import { cn } from "@/lib/utils";

export interface DeviceRowProps {
	icon: React.ReactNode;
	devices: MediaDeviceInfo[];
	currentId: string;
	placeholder: string;
	onChange(deviceId: string): void;
}

export function DeviceRow({ icon, devices, currentId, placeholder, onChange }: DeviceRowProps) {
	return (
		<div className="relative flex items-center">
			<div className="absolute left-3 text-muted-foreground pointer-events-none">
				{icon}
			</div>
			<select
				value={currentId}
				onChange={(e) => onChange(e.target.value)}
				disabled={devices.length === 0}
				className={cn(
					"w-full h-9 pl-9 pr-3 rounded-md border border-border bg-background/50",
					"text-foreground text-xs focus:outline-none focus:ring-2 focus:ring-primary/40",
					"disabled:opacity-50 disabled:cursor-not-allowed",
					"appearance-none cursor-pointer hover:bg-accent/50 transition-colors",
				)}
			>
				{devices.length === 0 ? (
					<option value="">{placeholder}</option>
				) : (
					devices.map(d => (
						<option key={d.deviceId} value={d.deviceId}>
							{d.label || placeholder}
						</option>
					))
				)}
			</select>
			{/* Custom chevron — the default OS one breaks the visual
			    consistency of the row and on macOS shows a different
			    indicator than on Windows/Linux.  appearance-none on
			    the select hides the native chevron; we draw our own. */}
			<svg
				className="absolute right-3 h-3 w-3 text-muted-foreground pointer-events-none"
				fill="none"
				viewBox="0 0 24 24"
				stroke="currentColor"
			>
				<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
			</svg>
		</div>
	);
}

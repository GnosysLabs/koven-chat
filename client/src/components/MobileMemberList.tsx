// Full-screen mobile wrapper around the desktop MemberList.
// Rendered inside a PushSlot so it slides in from the right
// with swipe-from-left-edge back, matching Profile / Settings.

import { MobileTopBar } from "@/components/MobileTopBar";
import { MemberList, type MemberListProps } from "@/components/MemberList";

interface MobileMemberListProps extends MemberListProps {
	onBack(): void;
}

export function MobileMemberList({ onBack, ...memberProps }: MobileMemberListProps) {
	const count = memberProps.members?.length;
	return (
		<div className="flex flex-col h-full bg-background" style={{ backgroundImage: "var(--bg-gradient)", backgroundAttachment: "fixed", backgroundRepeat: "no-repeat", backgroundSize: "cover" }}>
			<MobileTopBar title={count != null ? `Members · ${count}` : "Members"} onBack={onBack} />
			<div className="flex-1 min-h-0 overflow-y-auto">
				<MemberList {...memberProps} className="flex flex-col flex-1" hideHeader />
			</div>
		</div>
	);
}

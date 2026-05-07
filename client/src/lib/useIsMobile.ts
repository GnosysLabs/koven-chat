import { useEffect, useState } from "react";

// True when the viewport is narrower than Tailwind's `sm` breakpoint
// (640px).  Subscribes to matchMedia so it updates on resize / device
// rotation without needing a re-render trigger from the rest of the app.
//
// Use SPARINGLY — for layout decisions, prefer Tailwind's `sm:` variants
// (CSS-driven, no React work).  This hook exists for cases where you
// need to render *different React subtrees* on mobile vs. desktop —
// e.g. when a third-party component (Radix Popper) anchors to whichever
// trigger element is in the DOM and you can't have both at once.
export function useIsMobile(): boolean {
	const [isMobile, setIsMobile] = useState(() => {
		if (typeof window === "undefined") return false;
		return window.matchMedia("(max-width: 639.98px)").matches;
	});
	useEffect(() => {
		const mql = window.matchMedia("(max-width: 639.98px)");
		const update = () => setIsMobile(mql.matches);
		mql.addEventListener("change", update);
		return () => mql.removeEventListener("change", update);
	}, []);
	return isMobile;
}

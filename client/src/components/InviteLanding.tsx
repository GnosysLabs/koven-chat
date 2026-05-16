// Data-fetching wrapper for the invite link landing experience.
//
// When an unauthenticated user arrives via /invite/<target>, this
// component fetches public room metadata from the engine and passes
// it to <Login> as inviteContext.  Login then renders the "You've
// been invited" hero card in place of its usual brand section.
//
// After auth completes, the URL still has /invite/<target> so
// App.tsx's normal share-intent consumption joins the room.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ENGINE_URL } from "@/lib/urls";
import { Login, type LoginProps, type InviteContext } from "@/components/Login";

export interface InviteLandingProps {
	target: string;
	onLoggedIn: LoginProps["onLoggedIn"];
}

export function InviteLanding({ target, onLoggedIn }: InviteLandingProps) {
	const [inviteContext, setInviteContext] = useState<InviteContext | null>(null);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;

		fetch(`${ENGINE_URL}/api/invite-preview/${encodeURIComponent(target)}`)
			.then(r => {
				if (!r.ok) throw new Error("not_found");
				return r.json();
			})
			.then((data: {
				room_id: string;
				name: string | null;
				topic: string | null;
				avatar_url: string | null;
				member_count: number;
				is_space: boolean;
			}) => {
				if (cancelled) return;
				setInviteContext({
					target,
					name: data.name,
					topic: data.topic,
					avatarUrl: data.avatar_url,
					memberCount: data.member_count,
					isSpace: data.is_space,
				});
				setLoaded(true);
			})
			.catch(() => {
				if (cancelled) return;
				// Fallback: show login with minimal invite context
				setInviteContext({
					target,
					name: null,
					topic: null,
					avatarUrl: null,
					memberCount: 0,
					isSpace: false,
				});
				setLoaded(true);
			});

		return () => { cancelled = true; };
	}, [target]);

	// Gate on the preview fetch: rendering Login before it resolves
	// would paint the normal brand section and then visibly swap it
	// for the invite hero a frame later.  Hold a neutral splash until
	// the data is ready so the invite Login lands fully formed.
	if (!loaded) {
		return (
			<div className="fixed inset-0 flex items-center justify-center bg-background">
				<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	return (
		<Login
			onLoggedIn={onLoggedIn}
			inviteContext={inviteContext ?? undefined}
		/>
	);
}

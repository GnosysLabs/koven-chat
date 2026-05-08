// Top-level wiring.  Loads stored Matrix credentials (if any), shows
// the login screen when absent, otherwise spins up a MatrixTransport
// and renders the Sidebar + ChatPane.  Governance overlays go on top
// of this in subsequent passes.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
	MatrixTransport,
	loadStoredCredentials,
	saveCredentials,
	type MatrixCredentials,
	type SyncState,
} from "@/lib/matrix";
import { Login } from "@/components/Login";
import { SpaceBar } from "@/components/SpaceBar";
import { RoomList } from "@/components/RoomList";
import { ChatPane } from "@/components/ChatPane";
import { SpaceLanding } from "@/components/SpaceLanding";
import { ExplorePane } from "@/components/ExplorePane";
import { BotsPane } from "@/components/BotsPane";
import { BotList } from "@/components/BotList";
import { listMyBots, deleteBot as apiDeleteBot, type BotSummary } from "@/lib/bots";
import { MemberList } from "@/components/MemberList";
import { DmProfilePanel } from "@/components/DmProfilePanel";
import { CreateRoomSheet } from "@/components/CreateRoomSheet";
import { StartDmSheet } from "@/components/StartDmSheet";
import { SpaceEditSheet } from "@/components/SpaceEditSheet";
import { RoomEditSheet } from "@/components/RoomEditSheet";
import { InviteSheet } from "@/components/InviteSheet";
import { ProfileSheet } from "@/components/ProfileSheet";
import { AppSettingsSheet } from "@/components/AppSettingsSheet";
import { EncryptionSetupSheet } from "@/components/EncryptionSetupSheet";
import { EncryptionUnlockSheet } from "@/components/EncryptionUnlockSheet";
import { IncomingCallSheet } from "@/components/IncomingCallSheet";
import { ActiveCallView } from "@/components/ActiveCallView";
import { SuspendedBanner } from "@/components/SuspendedBanner";
import { ModLogSheet } from "@/components/ModLogSheet";
import { FloorReviewSheet } from "@/components/FloorReviewSheet";
import { botKickBan, deleteOwnMessage, fetchAdminStatus, fetchFloorQueue, fetchMyStatus, flagRoom, type SuspensionSummary } from "@/lib/instance";
import { useCollapsedRooms } from "@/lib/collapsedRooms";
import { fetchAllBotMxids } from "@/lib/bots-cache";
import { fetchUiaPassword } from "@/lib/auth";
import { TransportContext } from "@/lib/transportContext";
import { applyTheme, loadSettings, saveSettings, type Settings } from "@/state/settings";
import type { UserId } from "@koven/shared";
import { initialState, reduce } from "@/state/store";
import type { RoomId, SpaceId } from "@koven/shared";

/**
 * Resolve a call's peer identity from the DM's room data.  Used to
 * paint the right name/avatar in the call overlays immediately,
 * without waiting for MatrixCall.getOpponentMember() to populate
 * (which only happens after the answer arrives).  Returns undefined
 * for non-DM rooms or unknown room ids — caller falls back to SDK
 * getters.
 */
function peerForCall(roomId: string | undefined, rooms: import("@koven/shared").Room[]) {
	if (!roomId) return undefined;
	const room = rooms.find(r => r.id === roomId);
	if (!room || room.kind !== "dm" || !room.dmUserId) return undefined;
	return {
		userId: room.dmUserId,
		displayName: room.name,
		avatarMxc: room.avatarUrl,
	};
}

export default function App() {
	const [creds, setCreds] = useState<MatrixCredentials | null>(loadStoredCredentials);
	const [state, dispatch] = useReducer(reduce, initialState);
	// Engine-driven collapsed-room set: drives the room-name display
	// override + the Explore directory filter for the offensive-room-
	// name pipeline.  Polled every 5 min + on focus; we also call
	// `refresh()` immediately after a flag submission.
	const { ids: collapsedRoomIds, refresh: refreshCollapsedRooms } = useCollapsedRooms();
	const [transport, setTransport] = useState<MatrixTransport | null>(null);
	const [bootError, setBootError] = useState<string | null>(null);
	const [createRoomOpen, setCreateRoomOpen] = useState(false);
	const [startDmOpen, setStartDmOpen] = useState(false);
	const [editingSpaceId, setEditingSpaceId] = useState<SpaceId | null>(null);
	const [editingRoomId, setEditingRoomId] = useState<RoomId | null>(null);
	// Target of the active invite dialog: a room or space id.  Null
	// keeps the dialog closed.
	const [invitingRoomId, setInvitingRoomId] = useState<RoomId | null>(null);
	const [viewedUserId, setViewedUserId] = useState<UserId | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settings, setSettings] = useState<Settings>(loadSettings);
	// Three-valued: undefined = profile not yet probed (suppress the
	// SpaceBar avatar tile so we don't flash DiceBear); null = probed,
	// no avatar set; string = real mxc.  The probe runs on every auth
	// change in the effect below — until it lands the SpaceBar tile
	// renders a neutral placeholder rather than the auto-avatar.
	const [myAvatarMxc, setMyAvatarMxc] = useState<string | null | undefined>(undefined);
	// Public set of bot mxids — drives the BOT badge wherever a user
	// is rendered.  Refreshed periodically so newly-created bots show
	// up without a page reload.  Default empty Set so first-render
	// branches just don't render any badges.
	const [botMxids, setBotMxids] = useState<Set<UserId>>(() => new Set());

	// ─── Bot management state (the user's own roster) ────────────────
	// Lifted to App so BotList (sidebar) and BotsPane (detail pane)
	// stay in sync.  Refreshed on activeSpace=="bots" entry and after
	// every save / delete.  selectedBotId drives the right-pane view:
	// number = edit, "new" = create form, null = picker / empty state.
	// Initialised to `null` rather than `[]` so consumers can tell
	// "fetch hasn't returned yet" from "fetched, user has no bots."
	// BotList / BotsPane render nothing while null and only flip to
	// the empty-state UI once we've confirmed the roster is genuinely
	// empty — without this, the first paint flashes "No bots yet" +
	// CTA before snapping to the populated list.
	const [myBots, setMyBots] = useState<BotSummary[] | null>(null);
	const [myBotsLoading, setMyBotsLoading] = useState(false);
	const [myBotsError, setMyBotsError] = useState<string | null>(null);
	const [selectedBotId, setSelectedBotId] = useState<number | "new" | null>(null);
	const refreshMyBots = useCallback(async () => {
		if (!creds?.access_token) return;
		setMyBotsLoading(true);
		setMyBotsError(null);
		try {
			const list = await listMyBots(creds.access_token);
			setMyBots(list);
		} catch (err) {
			setMyBotsError(err instanceof Error ? err.message : String(err));
		} finally {
			setMyBotsLoading(false);
		}
	}, [creds?.access_token]);
	// Encryption gate.  Null = not yet probed.  "needs-setup" means the
	// account has no SSSS yet (first-time signup or an old account
	// pre-dating E2EE), "needs-unlock" means SSSS exists but this
	// device hasn't fetched the cross-signing keys, "ready" means we
	// can render the app.  The setup sheet collects the account
	// password directly from the user (Synapse needs it for UIA on
	// cross-signing key upload), so we don't have to thread it through
	// from the login form — that means setup also works after a page
	// refresh, not just immediately after a fresh sign-in.
	const [encState, setEncState] = useState<"needs-setup" | "needs-unlock" | "ready" | null>(null);
	// Suspension state, polled from the engine.  Null until the first
	// poll completes; a populated value means the engine considers
	// this account paused (status = "pending" or "confirmed") and the
	// UI gates compose / DM / room creation.
	const [suspension, setSuspension] = useState<SuspensionSummary | null>(null);
	// Per-room mod log dialog target.  Null = closed.
	const [modLogRoomId, setModLogRoomId] = useState<RoomId | null>(null);
	// Ignored-user list (Matrix-native block).  Mirrors transport state
	// for cheap render-time filtering of timeline messages and for
	// driving the Settings → Account "Blocked users" section.  Stored
	// as a Set for O(1) lookups; updated whenever account_data fires
	// `m.ignored_user_list`.
	const [ignoredUsers, setIgnoredUsers] = useState<Set<UserId>>(new Set());
	// Admin status + pending-review queue length.  Drives the shield
	// icon (admin-only) above Settings in the SpaceBar plus its red
	// attention dot.  Polled on the same 60s cadence as other "rare
	// event" surfaces; bumped immediately after the admin acts on a
	// case via the FloorReviewSheet's onQueueChanged callback.
	const [isAdmin, setIsAdmin] = useState(false);
	const [pendingReviewCount, setPendingReviewCount] = useState(0);
	const [reviewSheetOpen, setReviewSheetOpen] = useState(false);
	// 1:1 call state.  At most one of these is non-null:
	//   - incomingCall: a remote ringing us; renders the accept/decline sheet
	//   - activeCall: we're in a call (just-placed outbound, or accepted inbound)
	// Once a call ends (Hangup/Error/Replaced), the handler clears the
	// matching slot.  MatrixCall objects are stored as-is so call-state
	// listeners can attach to them; we keep them out of useReducer so
	// React doesn't try to memoize them.
	const [incomingCall, setIncomingCall] = useState<import("matrix-js-sdk/lib/webrtc/call").MatrixCall | null>(null);
	const [activeCall, setActiveCall] = useState<import("matrix-js-sdk/lib/webrtc/call").MatrixCall | null>(null);
	// Mirror the call state into refs so the transport's onIncomingCall
	// closure (captured once per transport boot) reads current values
	// when deciding whether to auto-reject an overlapping invite.
	const incomingCallRef = useRef<import("matrix-js-sdk/lib/webrtc/call").MatrixCall | null>(null);
	const activeCallRef = useRef<import("matrix-js-sdk/lib/webrtc/call").MatrixCall | null>(null);
	// Holds the UIA password handed back by the engine on login so the
	// transport can pick it up the moment it's constructed.  See
	// handleLogin for the rationale.
	const pendingUiaPasswordRef = useRef<string | null>(null);
	useEffect(() => { incomingCallRef.current = incomingCall; }, [incomingCall]);
	useEffect(() => { activeCallRef.current = activeCall; }, [activeCall]);

	// Apply theme on mount and whenever it changes.  Persist on every
	// settings update.
	useEffect(() => {
		applyTheme(settings.theme);
		saveSettings(settings);
	}, [settings]);

	// Public bot roster — drives the BOT badge.  Pulled from the
	// engine's unauthenticated `/api/bots/all-mxids`.  Refreshed every
	// 5 minutes so creating or deleting a bot eventually surfaces
	// without a page reload; the BotsPane management view triggers an
	// immediate re-fetch via the same hook on save.
	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			const set = await fetchAllBotMxids();
			if (!cancelled) setBotMxids(set);
		};
		refresh();
		const id = window.setInterval(refresh, 5 * 60 * 1000);
		return () => {
			cancelled = true;
			window.clearInterval(id);
		};
	}, []);

	// Refresh the user's own bot roster every time they navigate into
	// the Bots view — keeps usage counters current without a manual
	// reload.  Also resets the selection when navigating away so the
	// next entry starts on the picker.
	useEffect(() => {
		if (state.activeSpace?.kind === "bots") {
			void refreshMyBots();
		} else {
			setSelectedBotId(null);
		}
	}, [state.activeSpace?.kind, refreshMyBots]);

	// Eager-load the user's own bot roster once the access token is
	// available, regardless of which view they're on.  The Bots-view
	// effect above only fires when the user navigates *into* Bots, but
	// `myOwnedBotMxids` (derived from `myBots`) gates the trash button
	// on bot messages everywhere in the app — without this fetch, a
	// user who's never opened Bots in this session sees no delete
	// affordance on their own bot's chat output.  Fires once per
	// access-token change (which is what `refreshMyBots`'s identity
	// is keyed on).
	useEffect(() => {
		void refreshMyBots();
	}, [refreshMyBots]);

	// Admin status + pending-review-queue length poll.  Cheap two-call
	// fan-out on the same cadence as the suspension poll: first probe
	// /api/instance/me to confirm we're an admin, and only then pull
	// /api/admin/floor-queue (which would 403 for non-admins anyway).
	// Listening on `creds` so the timer resets across sign-in / sign-out.
	useEffect(() => {
		if (!creds) {
			setIsAdmin(false);
			setPendingReviewCount(0);
			return;
		}
		let cancelled = false;
		const poll = async () => {
			try {
				const status = await fetchAdminStatus(creds.access_token);
				if (cancelled) return;
				setIsAdmin(status.is_admin);
				if (!status.is_admin) {
					setPendingReviewCount(0);
					return;
				}
				const queue = await fetchFloorQueue(creds.access_token);
				if (!cancelled) setPendingReviewCount(queue.length);
			} catch {
				// Transient network error; keep last-known values rather
				// than thrash the badge.
			}
		};
		poll();
		const id = window.setInterval(poll, 60_000);
		return () => {
			cancelled = true;
			window.clearInterval(id);
		};
	}, [creds]);

	// Manual refresh hook — fired by the FloorReviewSheet after every
	// confirm/reverse so the badge updates without waiting for the
	// next poll tick.  Idempotent.
	async function refreshPendingReviewCount() {
		if (!creds || !isAdmin) return;
		try {
			const queue = await fetchFloorQueue(creds.access_token);
			setPendingReviewCount(queue.length);
		} catch {
			/* ignore — next poll will catch it */
		}
	}

	// Suspension state poll.  Hits /api/me/status on boot and every
	// 60s thereafter so a freshly-applied suspension takes effect
	// without a refresh.  Lighter than a websocket — the cadence
	// matches "actually-pretty-rare event" timing.
	useEffect(() => {
		if (!creds) {
			setSuspension(null);
			return;
		}
		let cancelled = false;
		const poll = async () => {
			try {
				const status = await fetchMyStatus(creds.access_token);
				if (!cancelled) setSuspension(status?.suspension ?? null);
			} catch {
				// Transient network error — leave the previous state
				// in place rather than thrash the UI on a flake.
			}
		};
		poll();
		const id = window.setInterval(poll, 60_000);
		return () => {
			cancelled = true;
			window.clearInterval(id);
		};
	}, [creds]);

	// Bootstrap (and re-bootstrap) the transport whenever creds change.
	useEffect(() => {
		if (!creds) return;
		const t = new MatrixTransport({
			onSyncState: (s: SyncState) => dispatch({ type: "sync_state", state: s }),
			onRoomsUpdated: rooms => dispatch({ type: "rooms_updated", rooms }),
			onSpacesUpdated: spaces => dispatch({ type: "spaces_updated", spaces }),
			onMessage: (message, { live }) => {
				dispatch({ type: "message_arrived", message, live });
				// Live message in the room the user is currently
				// viewing → send a read receipt right away so the
				// unread dot doesn't light up the moment they
				// navigate elsewhere.  The on-entry markAsRead only
				// fires when activeRoomId changes; without this,
				// every live message that arrives while you're
				// already in the room is recorded as unread by
				// Synapse.  Skipped when the tab is backgrounded so
				// notifications you didn't actually see don't get
				// swallowed.
				if (
					live &&
					activeRoomIdRef.current === message.roomId &&
					(typeof document === "undefined" || document.visibilityState === "visible")
				) {
					t.markAsRead(message.roomId).catch(() => {});
				}
			},
			onReaction: (reaction) => dispatch({
				type: "reaction_arrived",
				reaction,
				myUserId: creds.user_id as UserId,
			}),
			onReactionRedacted: (_roomId, reactionEventId) => dispatch({
				type: "reaction_redacted",
				reactionEventId,
			}),
			onFlag: (flag) => dispatch({
				type: "flag_arrived",
				flag,
				myUserId: creds.user_id as UserId,
			}),
			onFlagRedacted: (_roomId, flagEventId) => dispatch({
				type: "flag_redacted",
				flagEventId,
			}),
			onCollapse: (collapse) => dispatch({
				type: "collapse_arrived",
				collapse,
			}),
			onMembersUpdated: roomId => {
				const members = t.getRoomMembers(roomId);
				dispatch({ type: "members_loaded", roomId, members });
			},
			onIncomingCall: (call) => {
				// If we're already in a call, auto-reject overlapping
				// invites.  Single-call semantics for v1; "call waiting"
				// is a future-feature concern.  Read from refs because
				// this closure was captured at transport-boot time and
				// the state values it sees would otherwise be stale.
				if (activeCallRef.current || incomingCallRef.current) {
					call.reject();
					return;
				}
				setIncomingCall(call);
			},
		});
		// Hand the freshly-issued UIA password (from email-code login)
		// to the transport before any UIA-protected op can fire.
		// Cleared after read so a sign-out / re-login cycle picks up
		// only the new value.
		if (pendingUiaPasswordRef.current) {
			t.setUiaPassword(pendingUiaPasswordRef.current);
			pendingUiaPasswordRef.current = null;
		}
		setTransport(t);
		setBootError(null);
		setEncState(null);
		// Capture this transport instance so the .then/.catch below can
		// confirm they belong to the still-current run.  React's
		// <StrictMode> double-invokes this effect in dev: the first
		// transport gets stop()'d during cleanup, but its in-flight
		// start() promise still resolves and would otherwise race the
		// second transport's state writes.
		let cancelled = false;
		// Top-level timer that brackets the whole "Connecting…" → first
		// real UI window, so the user can correlate wall-clock wait
		// against the per-phase timers inside transport.
		console.time("app.boot: transport.start → encState");
		t.start(creds).then(async () => {
			if (cancelled) return;
			// Pull my avatar mxc once so the SpaceBar tile resolves to my
			// real avatar instead of the DiceBear fallback.  Map an
			// undefined `avatarUrl` to `null` so SpaceBar can tell
			// "probe completed, no avatar" from the still-pending
			// `undefined` initial state — the SpaceBar tile renders a
			// muted placeholder until this fires.
			t.getMyProfile()
				.then(p => { if (!cancelled) setMyAvatarMxc(p.avatarUrl ?? null); })
				.catch(() => { if (!cancelled) setMyAvatarMxc(null); });
			// Encryption probe — gates app rendering.  See encState above.
			try {
				console.time("app.boot: encryptionStatus");
				const status = await t.encryptionStatus();
				console.timeEnd("app.boot: encryptionStatus");
				if (!cancelled) setEncState(status);
			} catch (err) {
				if (cancelled) return;
				console.warn("encryptionStatus probe failed", err);
				setEncState("needs-unlock");
			} finally {
				console.timeEnd("app.boot: transport.start → encState");
			}
			// Kick off /sync AFTER the encryption probe + setEncState.
			// Doing it here (not inside start()) gives React a clean
			// commit window to paint the setup sheet / unlock sheet /
			// main UI before the SDK starts hammering the JS thread
			// with first-sync event processing.  Two requestAnimationFrame
			// hops yield to the browser's compositor twice — first to
			// run the React commit, second to actually paint — so by
			// the time beginSync runs the user is already looking at
			// the right screen and the heavy sync work happens
			// invisibly in the background.
			if (cancelled) return;
			requestAnimationFrame(() => {
				if (cancelled) return;
				requestAnimationFrame(() => {
					if (cancelled) return;
					t.beginSync();
				});
			});
		}).catch(e => {
			if (cancelled) return;
			console.timeEnd("app.boot: transport.start → encState");
			setBootError(e instanceof Error ? e.message : String(e));
		});
		// Subscribe to ignore-list changes so block/unblock takes effect
		// across the app without a refresh.  Initial pull happens once
		// here too; the listener only fires on subsequent updates.
		const unsubscribe = t.onIgnoredUsersChanged(() => {
			if (cancelled) return;
			setIgnoredUsers(new Set(t.getIgnoredUsers()));
		});
		// Pull the initial list slightly after sync settles.  We can
		// read it earlier, but account_data sometimes arrives a beat
		// after PREPARED, and re-reading on the first
		// onIgnoredUsersChanged catches us up regardless.
		setIgnoredUsers(new Set(t.getIgnoredUsers()));
		return () => {
			cancelled = true;
			unsubscribe();
			t.stop();
			setTransport(null);
			setIgnoredUsers(new Set());
		};
	}, [creds]);

	// Live mirror of the active room id, readable from inside long-
	// lived callbacks (the transport's onMessage handler in particular)
	// without the closure going stale.  Used to send read receipts
	// for messages that arrive while the user is already in the room
	// — see the transport setup useEffect below.
	const activeRoomIdRef = useRef<RoomId | null>(null);
	useEffect(() => {
		activeRoomIdRef.current = state.activeRoomId;
	}, [state.activeRoomId]);

	// Tab refocus → catch up on read receipts for the active room.
	// While the tab is hidden we suppress receipts for incoming
	// messages (the user didn't actually see them), but the moment
	// the tab becomes visible again we mark the latest event read so
	// any messages that arrived while hidden don't linger as unread
	// once the user moves on.
	useEffect(() => {
		if (typeof document === "undefined") return;
		const onVisible = () => {
			if (document.visibilityState !== "visible") return;
			const id = activeRoomIdRef.current;
			if (id && transport) {
				transport.markAsRead(id).catch(() => {});
			}
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [transport]);

	// When the active room changes, load its existing timeline + members
	// + reactions from the matrix-js-sdk's in-memory state.
	useEffect(() => {
		if (!state.activeRoomId || !transport || !creds) return;
		// Mark the room read on entry so the unread dot clears.  Fire
		// and forget — the receipt round-trips to Synapse but we don't
		// gate the room render on it.
		transport.markAsRead(state.activeRoomId).catch(() => {});
		dispatch({
			type: "messages_loaded",
			roomId: state.activeRoomId,
			messages: transport.getRoomMessages(state.activeRoomId),
		});
		dispatch({
			type: "members_loaded",
			roomId: state.activeRoomId,
			members: transport.getRoomMembers(state.activeRoomId),
		});
		dispatch({
			type: "reactions_loaded",
			reactions: transport.getRoomReactions(state.activeRoomId),
			myUserId: creds.user_id as UserId,
		});
		dispatch({
			type: "flags_loaded",
			flags: transport.getRoomFlags(state.activeRoomId),
			myUserId: creds.user_id as UserId,
		});
		dispatch({
			type: "collapses_loaded",
			collapses: transport.getRoomCollapses(state.activeRoomId),
		});
	}, [state.activeRoomId, transport, creds]);

	function handleLogin(newCreds: MatrixCredentials, uiaPassword: string) {
		saveCredentials(newCreds);
		// Stash the engine-issued UIA password in a ref so we can hand
		// it to the transport once it's instantiated by the cred-driven
		// effect below.  Memory-only by design: never written to
		// localStorage, never sent back to the engine, never persisted.
		// On every page refresh the UIA password is gone — any UIA op
		// that fires later this session calls fetchUiaPassword() to
		// rotate fresh.
		pendingUiaPasswordRef.current = uiaPassword;
		setCreds(newCreds);
	}

	function handleSignOut() {
		saveCredentials(null);
		setCreds(null);
		setEncState(null);
		dispatch({ type: "set_active_room", roomId: null });
		// Wipe matrix-js-sdk's IndexedDB state — both the rust-crypto
		// stores AND the regular sync store — so the NEXT login (which
		// might be as a different user) doesn't trip the "rust-crypto
		// store mismatch" recovery path on the way in.  That path
		// catches the mismatch error, wipes, and retries init from
		// scratch, which on slow devices takes 30-90s and strands the
		// user on the "Connecting…" screen.  Doing the wipe at
		// sign-out time means we pay the cost during "signing out…"
		// (a UX moment where users already expect to wait) instead of
		// at the next login.
		//
		// Fire-and-forget: the wipe is async (IndexedDB) but signing
		// out is otherwise instantaneous — we don't want to make the
		// user stare at the login screen waiting for IndexedDB to
		// drain.  Errors are tolerated by the recovery path on the
		// next login.
		void import("@/lib/matrix").then(({ wipeAllMatrixIndexedDB }) => {
			void wipeAllMatrixIndexedDB();
		});
	}

	const activeRoom = useMemo(
		() => state.rooms.find(r => r.id === state.activeRoomId) ?? null,
		[state.rooms, state.activeRoomId],
	);
	// Set form of the viewer's owned-bot mxids, recomputed only when
	// the bot roster changes.  ChatPane consults this to decide whether
	// to show the trash icon on a bot's message: if the sender is in
	// here, the viewer owns that bot and is allowed to redact its
	// content.  The engine re-checks server-side so a tampered SPA
	// can't actually exceed its rights.
	const myOwnedBotMxids = useMemo(
		// While myBots is null (fetch in flight) we treat the owned
		// set as empty — the trash icon stays hidden until the real
		// roster arrives, at which point owned-bot rows pick it up
		// on the next paint.
		() => new Set((myBots ?? []).map(b => b.mxid as UserId)),
		[myBots],
	);
	const allMessages = state.activeRoomId
		? state.messagesByRoom.get(state.activeRoomId) ?? []
		: [];
	// Drop messages from ignored users at render time.  Messages stay in
	// the reducer state so unblocking re-shows them without a re-sync.
	const messages = useMemo(
		() => ignoredUsers.size === 0
			? allMessages
			: allMessages.filter(m => !ignoredUsers.has(m.sender as UserId)),
		[allMessages, ignoredUsers],
	);

	// What the chat pane shows when no room is active depends on the
	// SpaceBar selection.  Real spaces show the existing landing; the
	// two virtual selections (DMs, Rooms) get a synthesized space-like
	// object so SpaceLanding can render them with the same shell.
	const activeSpaceObj = useMemo(() => {
		if (!state.activeSpace) return null;
		if (state.activeSpace.kind === "explore") return null;
		if (state.activeSpace.kind === "bots") return null;
		if (state.activeSpace.kind === "dms") {
			return {
				id: "__dms__",
				name: "Direct messages",
				topic: "Your one-on-one conversations.",
				avatarUrl: undefined,
				kind: "private" as const,
				childRoomIds: [],
				pinnedRoomIds: [],
			};
		}
		if (state.activeSpace.kind === "rooms") {
			return {
				id: "__rooms__",
				name: "Rooms",
				topic: "Joined rooms not assigned to any space.",
				avatarUrl: undefined,
				kind: "public" as const,
				childRoomIds: [],
				pinnedRoomIds: [],
			};
		}
		const id = state.activeSpace.id;
		return state.spaces.find(s => s.id === id) ?? null;
	}, [state.activeSpace, state.spaces]);
	const roomsInActiveSpace = useMemo(() => {
		if (!state.activeSpace) return [];
		if (state.activeSpace.kind === "explore") return [];
		if (state.activeSpace.kind === "bots") return [];
		if (state.activeSpace.kind === "dms") return state.rooms.filter(r => r.kind === "dm");
		if (state.activeSpace.kind === "rooms") {
			return state.rooms.filter(r => r.kind !== "dm" && r.parentSpaceIds.length === 0);
		}
		const id = state.activeSpace.id;
		return state.rooms.filter(r => r.parentSpaceIds.includes(id));
	}, [state.activeSpace, state.rooms]);
	const landingVariant: "real" | "dms" | "rooms" =
		state.activeSpace?.kind === "dms" ? "dms"
		: state.activeSpace?.kind === "rooms" ? "rooms"
		: "real";
	const showSpaceLanding = !!activeSpaceObj && !activeRoom;

	// Build a userId → avatar-mxc lookup for the active room so each
	// message can render its sender's avatar without the row component
	// having to know about Matrix internals.
	const memberAvatars = useMemo(() => {
		const m = new Map<string, string | undefined>();
		const list = state.activeRoomId ? state.membersByRoom.get(state.activeRoomId) : undefined;
		for (const member of list ?? []) {
			m.set(member.userId, member.avatarUrl);
		}
		return m;
	}, [state.activeRoomId, state.membersByRoom]);

	if (!creds) {
		return <Login onLoggedIn={handleLogin} />;
	}

	// If transport boot failed (most commonly: rust-crypto WASM
	// failing to initialize), render a hard error instead of letting
	// the user into a half-broken app.  Without this gate a crypto
	// init failure silently produces an app that can't send DMs and
	// won't surface the encryption setup sheet.
	if (bootError) {
		return (
			<div className="h-full flex items-center justify-center p-8 bg-background">
				<div className="max-w-md text-center space-y-4">
					<div className="text-sm font-semibold">Couldn't start the client</div>
					<div className="text-xs text-muted-foreground leading-relaxed border border-destructive/40 bg-destructive/10 rounded px-3 py-2 text-left">
						{bootError}
					</div>
					<button
						type="button"
						className="text-xs text-muted-foreground hover:text-foreground underline"
						onClick={handleSignOut}
					>
						Sign out and try again
					</button>
				</div>
			</div>
		);
	}

	// Block the app while the encryption probe is in flight.  encState
	// is null until t.start() resolves and we read the SSSS state — if
	// we let the rest of the app render here, a slow start would flash
	// an unprotected UI (no setup sheet, no unlock sheet) for a beat.
	if (!transport || encState === null) {
		return (
			<div className="h-full flex items-center justify-center p-8 bg-background text-xs text-muted-foreground">
				Connecting…
			</div>
		);
	}

	// Encryption gate — block the app behind setup or unlock until the
	// device has cross-signing keys cached locally.  We render the
	// chrome (sync banner, etc.) but the dialog is non-dismissible so
	// the user must finish or sign out.
	if (transport && encState === "needs-setup") {
		return (
			<EncryptionSetupSheet
				open
				onSetup={async (passphrase) => {
					// Use the engine-issued UIA password the transport
					// already has cached (handed to it right after login).
					// If somehow missing — page refresh on a half-set-up
					// account — fetch a fresh one which rotates the
					// Synapse password to a new value.
					if (!transport.getUiaPassword()) {
						const fresh = await fetchUiaPassword(creds.access_token);
						transport.setUiaPassword(fresh);
					}
					const { recoveryKey } = await transport.setupEncryption(passphrase);
					// Setup succeeded; we don't need this password again
					// in the immediate flow — clear it and let any later
					// UIA op fetch fresh.
					transport.setUiaPassword(null);
					return recoveryKey;
				}}
				onComplete={() => setEncState("ready")}
				onSignOut={handleSignOut}
			/>
		);
	}
	if (transport && encState === "needs-unlock") {
		return (
			<EncryptionUnlockSheet
				open
				onUnlock={async (input) => transport.unlockEncryption(input)}
				onUnlocked={() => setEncState("ready")}
				onSignOut={handleSignOut}
			/>
		);
	}

	// macOS desktop builds need a 40px chrome gutter at the top of
	// the authed app: it (a) clears the OS-reserved title-bar drag
	// zone so chat-header buttons stay clickable, (b) carries the
	// hairline divider between chrome and content, and (c) hosts
	// the centered Koven mark.  Login + early-return screens skip
	// the gutter so their backgrounds extend edge-to-edge.
	const isMacDesktop = typeof window !== "undefined"
		&& (window as { __KOVEN_PLATFORM__?: string }).__KOVEN_PLATFORM__ === "macos";

	return (
		<TransportContext.Provider value={transport}>
		<div className="h-full flex flex-col">
			{/* DesktopTitleBar (traffic lights) is rendered absolute-
			    positioned at the top of main.tsx so it floats over
			    every screen.  The 40px chrome gutter below — with
			    the centered Koven mark + a hairline divider —
			    appears ONLY in the authed app: the login screen
			    deliberately leaves the top empty so its background
			    image extends edge-to-edge under the floating
			    traffic lights. */}
			{isMacDesktop && (
				<div className="h-10 shrink-0 border-b border-border flex items-center justify-center relative">
					<img
						src="/favicon.png"
						alt=""
						aria-hidden
						className="h-6 w-6 pointer-events-none select-none"
					/>
				</div>
			)}
			{suspension && <SuspendedBanner suspension={suspension} />}
			{state.syncState !== "ready" && state.syncState !== "syncing" && (
				<div className="text-xs px-3 py-1 bg-muted text-muted-foreground border-b border-border">
					{bootError ? `Connection error: ${bootError}` : `Sync: ${state.syncState}`}
				</div>
			)}
			<div className="flex-1 flex min-h-0">
				<SpaceBar
					currentUserId={creds.user_id}
					currentUserAvatarMxc={myAvatarMxc}
					spaces={state.spaces}
					rooms={state.rooms}
					activeSpace={state.activeSpace}
					onSelectExplore={() => dispatch({ type: "set_active_space", space: { kind: "explore" } })}
					onSelectDms={() => dispatch({ type: "set_active_space", space: { kind: "dms" } })}
					onSelectBots={() => dispatch({ type: "set_active_space", space: { kind: "bots" } })}
					onSelectRooms={() => dispatch({ type: "set_active_space", space: { kind: "rooms" } })}
					onSelectSpace={(id: SpaceId) => dispatch({ type: "set_active_space", space: { kind: "space", id } })}
					onCreateSpace={async (opts) => {
						if (!transport) throw new Error("Not connected");
						const spaceId = await transport.createSpace(opts);
						dispatch({ type: "set_active_space", space: { kind: "space", id: spaceId } });
					}}
					onOpenProfile={() => setViewedUserId(creds.user_id as UserId)}
					onOpenSettings={() => setSettingsOpen(true)}
					onSignOut={handleSignOut}
					onOpenReview={isAdmin ? () => setReviewSheetOpen(true) : undefined}
					pendingReviewCount={pendingReviewCount}
				/>
				{state.activeSpace?.kind === "bots" ? (
					<BotList
						bots={myBots}
						loading={myBotsLoading}
						error={myBotsError}
						selectedBotId={selectedBotId}
						atLimit={(myBots ?? []).length >= 30}
						onSelectBot={id => setSelectedBotId(id)}
						onNewBot={() => setSelectedBotId("new")}
					/>
				) : null}
				{state.activeSpace?.kind !== "explore" && state.activeSpace?.kind !== "bots" && (
				<RoomList
					rooms={state.rooms}
					spaces={state.spaces}
					activeSpace={state.activeSpace}
					activeRoomId={state.activeRoomId}
					collapsedRoomIds={collapsedRoomIds}
					// True once initial sync has reached the "syncing"
					// or "ready" state — at that point matrix-js-sdk
					// has populated `state.rooms` with whatever the
					// user has, and an empty list is genuinely empty.
					// While "preparing" we leave the empty hint
					// suppressed so the sidebar paints clean during
					// boot.
					roomsLoaded={state.syncState === "syncing" || state.syncState === "ready"}
					onSelectRoom={(roomId: RoomId) => dispatch({ type: "set_active_room", roomId })}
					onCreateRoom={() => {
						// "+" in the list header is context-aware: DMs
						// opens the start-a-DM dialog, every other view
						// opens the create-room dialog.
						if (state.activeSpace?.kind === "dms") setStartDmOpen(true);
						else setCreateRoomOpen(true);
					}}
					onAcceptInvite={async (roomId) => {
						if (!transport) return;
						try {
							await transport.acceptInvite(roomId);
							dispatch({ type: "set_active_room", roomId });
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
						}
					}}
					onDeclineInvite={async (roomId) => {
						if (!transport) return;
						try {
							await transport.declineInvite(roomId);
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
						}
					}}
					onPinRoom={async (spaceId, roomId) => {
						if (!transport) return;
						try {
							await transport.pinRoomInSpace(spaceId, roomId);
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
						}
					}}
					onUnpinRoom={async (spaceId, roomId) => {
						if (!transport) return;
						try {
							await transport.unpinRoomInSpace(spaceId, roomId);
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
						}
					}}
				/>
				)}
				{state.activeSpace?.kind === "explore" ? (
					<ExplorePane
						transport={transport}
						rooms={state.rooms}
						spaces={state.spaces}
						accessToken={creds?.access_token ?? null}
						collapsedRoomIds={collapsedRoomIds}
						onCollapseRefresh={refreshCollapsedRooms}
						onJoined={(roomId, isSpace) => {
							// Joining a room → switch to Rooms view + open
							// it.  Joining a space → switch to that space.
							if (isSpace) {
								dispatch({ type: "set_active_space", space: { kind: "space", id: roomId } });
							} else {
								dispatch({ type: "set_active_room", roomId });
							}
						}}
					/>
				) : state.activeSpace?.kind === "bots" ? (
					<BotsPane
						accessToken={creds?.access_token ?? null}
						currentUserId={creds?.user_id ?? null}
						bots={myBots}
						selectedBotId={selectedBotId}
						atLimit={(myBots ?? []).length >= 30}
						onNewBot={() => setSelectedBotId("new")}
						onSelectionCleared={() => setSelectedBotId(null)}
						onSaved={async (saved) => {
							// Re-pull the canonical roster (server-side
							// changes — token totals, mxid, etc.) and
							// switch the selection to the just-saved bot.
							await refreshMyBots();
							// Refresh the public bot mxid set so the BOT
							// badge in chat picks up new bots immediately.
							void fetchAllBotMxids().then(setBotMxids);
							setSelectedBotId(saved.id);
						}}
						onDelete={async (bot) => {
							if (!creds?.access_token) return;
							try {
								await apiDeleteBot(creds.access_token, bot.id);
							} catch (e) {
								dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
								return;
							}
							setSelectedBotId(null);
							await refreshMyBots();
							void fetchAllBotMxids().then(setBotMxids);
						}}
					/>
				) : showSpaceLanding && activeSpaceObj ? (
					<SpaceLanding
						space={activeSpaceObj}
						rooms={roomsInActiveSpace}
						variant={landingVariant}
						onAddRoom={() => setCreateRoomOpen(true)}
						onInvite={() => {
							if (state.activeSpace?.kind === "space") setInvitingRoomId(state.activeSpace.id as unknown as RoomId);
						}}
						onOpenSettings={() => {
							if (state.activeSpace?.kind === "space") setEditingSpaceId(state.activeSpace.id);
						}}
						onStartDm={() => setStartDmOpen(true)}
						onSelectRoom={(roomId: RoomId) => dispatch({ type: "set_active_room", roomId })}
					/>
				) : (
				<ChatPane
					room={activeRoom}
					messages={messages}
					memberAvatars={memberAvatars}
					reactionsByMessage={state.reactionsByMessage}
					flagsByMessage={state.flagsByMessage}
					collapsesByMessage={state.collapsesByMessage}
					botMxids={botMxids}
					myOwnedBotMxids={myOwnedBotMxids}
					onDeleteMessage={async (eventId) => {
						if (!creds?.access_token || !state.activeRoomId) return;
						try {
							await deleteOwnMessage(
								creds.access_token,
								state.activeRoomId,
								eventId,
							);
							// Synapse emits the redaction back through sync,
							// matrix-js-sdk applies it, and the row re-renders
							// as a redacted stub on the next reducer pass —
							// no manual state update needed here.  Errors
							// (target gone, not authorized, network) bubble
							// up to the global error dispatcher.
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
						}
					}}
					members={state.activeRoomId ? state.membersByRoom.get(state.activeRoomId) ?? [] : []}
					// True once the active room's initial timeline has
					// landed.  Suppresses ChatPane's "No messages yet."
					// banner during the brief window between switching
					// into a room and the first timeline batch
					// arriving — without this, every room enter
					// flashes the banner.
					messagesLoaded={!!state.activeRoomId && state.loadedTimelines.has(state.activeRoomId)}
					viewerServer={creds.user_id ? creds.user_id.split(":")[1] ?? null : null}
					onSendMessage={(text, replyTo) => {
						if (!state.activeRoomId || !transport) return;
						const send = replyTo
							? transport.replyTo(state.activeRoomId, replyTo, text)
							: transport.sendText(state.activeRoomId, text);
						send.catch(e => dispatch({ type: "error", message: e.message }));
					}}
					onSendAttachment={async (file) => {
						if (!state.activeRoomId || !transport) return;
						try {
							await transport.uploadAndSendAttachment(state.activeRoomId, file);
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
							throw e;
						}
					}}
					onReact={(eventId, emoji) => {
						if (!state.activeRoomId || !transport) return;
						transport.react(state.activeRoomId, eventId, emoji)
							.catch(e => dispatch({ type: "error", message: e.message }));
					}}
					onUnreact={(reaction) => {
						if (!state.activeRoomId || !transport || !reaction.myReactionId) return;
						transport.unreact(state.activeRoomId, reaction.myReactionId)
							.catch(e => dispatch({ type: "error", message: e.message }));
					}}
					onFlag={async (eventId, category, rationale) => {
						if (!state.activeRoomId || !transport) return;
						try {
							await transport.flag(state.activeRoomId, eventId, category, rationale);
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
							throw e;
						}
					}}
					onUnflag={async (flagEventId) => {
						if (!state.activeRoomId || !transport) return;
						try {
							await transport.unflag(state.activeRoomId, flagEventId);
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
							throw e;
						}
					}}
					onFlagRoom={async (roomId, category, rationale) => {
						if (!creds?.access_token) return;
						const r = await flagRoom(creds.access_token, roomId, category, rationale);
						if (!r.ok) throw new Error(r.error ?? "Flag submission failed");
						// Re-poll the collapsed-rooms list — a floor flag
						// may have just collapsed the room, in which case
						// the SPA should pick that up immediately rather
						// than wait for the next 5-min interval.
						await refreshCollapsedRooms();
					}}
					collapsedRoomIds={collapsedRoomIds}
					onAcceptInvite={async (roomId) => {
						if (!transport) return;
						try {
							await transport.acceptInvite(roomId as RoomId);
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
						}
					}}
					onDeclineInvite={async (roomId) => {
						if (!transport) return;
						try {
							await transport.declineInvite(roomId as RoomId);
							dispatch({ type: "set_active_room", roomId: null });
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
						}
					}}
					onInvite={(roomId) => setInvitingRoomId(roomId as RoomId)}
					onEditRoom={(roomId) => setEditingRoomId(roomId as RoomId)}
					onPlaceCall={async (roomId, video) => {
						if (!transport) return;
						try {
							const call = await transport.placeCall(roomId as RoomId, video);
							if (call) setActiveCall(call);
						} catch (err) {
							// Most placeCall failures are media-access related;
							// translate DOMException names into something the
							// user can actually act on instead of dumping
							// "NotAllowedError" into the banner.
							const e = err as { name?: string; message?: string };
							const friendly =
								e.name === "NotAllowedError"  ? "Microphone or camera access was denied. Allow access in your browser and try again." :
								e.name === "NotFoundError"    ? "No microphone or camera found on this device." :
								e.name === "NotReadableError" ? "Another app or tab is using your microphone or camera. Close it and try again." :
								(e.message ?? "Couldn't start the call.");
							dispatch({ type: "error", message: friendly });
						}
					}}
					callInProgress={!!activeCall || !!incomingCall}
					isSuspended={!!suspension}
					onOpenModLog={(roomId) => setModLogRoomId(roomId as RoomId)}
				/>
				)}
				{activeRoom && (
					activeRoom.kind === "dm" && activeRoom.dmUserId ? (
						<DmProfilePanel
							otherUserId={activeRoom.dmUserId as UserId}
							transport={transport}
							ignoredUsers={ignoredUsers}
							isBot={botMxids.has(activeRoom.dmUserId as UserId)}
							onOpenProfile={(userId) => setViewedUserId(userId)}
							onDeleteDm={async () => {
								if (!transport || !state.activeRoomId) return;
								try {
									await transport.deleteDm(state.activeRoomId);
									dispatch({ type: "set_active_room", roomId: null });
								} catch (e) {
									dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
								}
							}}
						/>
					) : (
						<MemberList
							// null while the room's first member fetch
							// is in flight; MemberList suppresses its
							// chrome and the empty-state hint while
							// null so we don't flash "Members · 0" /
							// "No members." before the list arrives.
							members={
								state.activeRoomId && state.loadedMembers.has(state.activeRoomId)
									? state.membersByRoom.get(state.activeRoomId) ?? []
									: null
							}
							currentUserId={creds.user_id}
							onSelectMember={(userId) => setViewedUserId(userId as UserId)}
							botMxids={botMxids}
						/>
					)
				)}
			</div>
			<CreateRoomSheet
				open={createRoomOpen}
				onOpenChange={setCreateRoomOpen}
				onCreate={async (opts) => {
					if (!transport) throw new Error("Not connected");
					// If a space is currently selected, the new room joins
					// it automatically — saves an extra step that almost
					// always immediately follows room creation.
					const parentSpaceId = state.activeSpace?.kind === "space"
						? state.activeSpace.id
						: undefined;
					const roomId = await transport.createRoom({ ...opts, parentSpaceId });
					dispatch({ type: "set_active_room", roomId });
				}}
			/>
			<StartDmSheet
				open={startDmOpen}
				onOpenChange={setStartDmOpen}
				transport={transport}
				onStarted={(roomId) => {
					dispatch({ type: "set_active_space", space: { kind: "dms" } });
					dispatch({ type: "set_active_room", roomId: roomId as RoomId });
				}}
			/>
			<SpaceEditSheet
				space={editingSpaceId ? state.spaces.find(s => s.id === editingSpaceId) ?? null : null}
				currentUserId={creds.user_id}
				onClose={() => setEditingSpaceId(null)}
				onSave={async (opts) => {
					if (!transport) throw new Error("Not connected");
					await transport.updateSpace({
						spaceId: opts.spaceId as SpaceId,
						name: opts.name,
						topic: opts.topic,
						avatarFile: opts.avatarFile,
						clearAvatar: opts.clearAvatar,
						iconEmoji: opts.iconEmoji,
						visibility: opts.visibility,
					});
				}}
				onLeave={async (spaceId) => {
					if (!transport) throw new Error("Not connected");
					// Cascade-leave: drops the user from every child
					// room reachable through this space (skipping
					// sub-spaces and rooms protected by another joined
					// space — see leaveSpaceWithChildren for the full
					// rules).  Symmetric with joinSpaceWithChildren so
					// the Discord-style "join the server, get all
					// channels" gesture has a "leave the server, lose
					// all channels" counterpart.
					await transport.leaveSpaceWithChildren(spaceId as SpaceId);
					// Close the sheet + bounce out of the now-gone
					// space.  Rooms tile is the safest landing place
					// since it always exists and never depends on a
					// specific space membership.
					setEditingSpaceId(null);
					dispatch({ type: "set_active_space", space: { kind: "rooms" } });
				}}
				onDelete={async (spaceId, childIds) => {
					if (!transport) throw new Error("Not connected");
					await transport.deleteSpace(spaceId as RoomId, childIds as RoomId[]);
					setEditingSpaceId(null);
					dispatch({ type: "set_active_space", space: { kind: "rooms" } });
					dispatch({ type: "set_active_room", roomId: null });
				}}
				lookupChildName={(roomId) => {
					// Resolve via the SPA's room cache.  Falls back to
					// the bare room id only if the user isn't a joined
					// member of the child (rare for creator-deleted
					// spaces, common only when somebody else added a
					// foreign room into the space).
					return state.rooms.find(r => r.id === roomId)?.name ?? roomId;
				}}
			/>
			<RoomEditSheet
				room={editingRoomId ? state.rooms.find(r => r.id === editingRoomId) ?? null : null}
				currentUserId={creds.user_id}
				onClose={() => setEditingRoomId(null)}
				onSave={async (opts) => {
					if (!transport) throw new Error("Not connected");
					await transport.updateRoom({
						roomId: opts.roomId as RoomId,
						name: opts.name,
						topic: opts.topic,
						avatarFile: opts.avatarFile,
						clearAvatar: opts.clearAvatar,
						iconEmoji: opts.iconEmoji,
						visibility: opts.visibility,
					});
				}}
				onLeave={async (roomId) => {
					if (!transport) throw new Error("Not connected");
					await transport.leaveRoom(roomId as RoomId);
					setEditingRoomId(null);
					// Drop the active room — RoomList will pick a new
					// one (or render the empty state) on next render.
					dispatch({ type: "set_active_room", roomId: null });
				}}
				onDelete={async (roomId) => {
					if (!transport) throw new Error("Not connected");
					await transport.deleteRoom(roomId as RoomId);
					setEditingRoomId(null);
					dispatch({ type: "set_active_room", roomId: null });
				}}
			/>
			<InviteSheet
				open={!!invitingRoomId}
				onOpenChange={(o) => { if (!o) setInvitingRoomId(null); }}
				transport={transport}
				roomId={invitingRoomId}
				roomName={
					invitingRoomId
						? state.spaces.find(s => s.id === invitingRoomId)?.name
							?? state.rooms.find(r => r.id === invitingRoomId)?.name
							?? "this room"
						: ""
				}
				isSpace={!!invitingRoomId && state.spaces.some(s => s.id === invitingRoomId)}
			/>
			<ProfileSheet
				viewedUserId={viewedUserId}
				onClose={() => setViewedUserId(null)}
				transport={transport}
				accessToken={creds.access_token}
				ignoredUsers={ignoredUsers}
				isBot={!!viewedUserId && botMxids.has(viewedUserId)}
				// Bot kick/ban is a founder-only carve-out from the
				// consensus model.  We expose the affordance in the
				// profile sheet only when the viewer is the founder
				// of the currently-active room (`creatorId` from the
				// m.room.create event).  Anywhere else (DMs, federated
				// rooms, viewing in a room you didn't create) the
				// affordance stays hidden — including for instance
				// admins; admin-delete is a separate capability.
				canKickBanBots={!!(activeRoom?.creatorId && creds.user_id && activeRoom.creatorId === creds.user_id)}
				// Suppress kick/ban affordance when the bot in question
				// is one the viewer owns.  Founder-of-room === bot-
				// owner is allowed (the affordance just hides);
				// they can manage the bot from Settings → Bots.
				isMyBot={!!viewedUserId && myOwnedBotMxids.has(viewedUserId)}
				onBotMembership={async (action, botMxid) => {
					if (!creds?.access_token || !state.activeRoomId) return;
					try {
						await botKickBan(
							creds.access_token,
							state.activeRoomId,
							botMxid,
							action,
						);
						// Synapse emits the membership transition back
						// through sync; the member list and chat header
						// pick it up on the next reducer pass.  No
						// manual state poke required.
					} catch (e) {
						// Re-throw so the sheet can show the error
						// inline; App.tsx still receives it via the
						// global error path if the user dismisses
						// without retrying.
						dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
						throw e;
					}
				}}
				onSelfProfileSaved={(avatarMxc) => {
					// undefined = avatar wasn't touched (e.g. only the
					// display name changed); leave the cached mxc alone
					// so we don't blow away a known-good URL.
					if (avatarMxc === undefined) return;
					setMyAvatarMxc(avatarMxc ?? undefined);
				}}
				onStartDm={async (userId) => {
					// Close the profile sheet first so the navigation
					// to the new DM doesn't render under it; startDm
					// is idempotent (returns the existing room id if
					// a DM already exists) so the close + fire pattern
					// is safe.
					setViewedUserId(null);
					if (!transport) return;
					try {
						const roomId = await transport.startDm(userId);
						dispatch({ type: "set_active_space", space: { kind: "dms" } });
						dispatch({ type: "set_active_room", roomId });
					} catch (e) {
						dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
					}
				}}
			/>
			<AppSettingsSheet
				open={settingsOpen}
				onOpenChange={setSettingsOpen}
				settings={settings}
				onSettingsChange={setSettings}
				accessToken={creds.access_token}
				transport={transport}
				ignoredUsers={ignoredUsers}
				onSignedOut={handleSignOut}
			/>
			{/* Call overlays — top-level so they survive room navigation.
			    Peer info is resolved from the DM's known partner data so
			    the right name/avatar paint immediately, even before the
			    MatrixCall has populated getOpponentMember() (which only
			    happens after the answer comes back). */}
			{incomingCall && (
				<IncomingCallSheet
					call={incomingCall}
					peer={peerForCall(incomingCall.roomId, state.rooms)}
					onAccept={(call) => {
						setIncomingCall(null);
						setActiveCall(call);
					}}
					onDismiss={() => setIncomingCall(null)}
				/>
			)}
			{activeCall && (
				<ActiveCallView
					call={activeCall}
					peer={peerForCall(activeCall.roomId, state.rooms)}
					onEnded={() => setActiveCall(null)}
				/>
			)}
			{modLogRoomId && (
				<ModLogSheet
					open
					onOpenChange={(o) => { if (!o) setModLogRoomId(null); }}
					roomId={modLogRoomId}
				/>
			)}
			{isAdmin && (
				<FloorReviewSheet
					open={reviewSheetOpen}
					onOpenChange={setReviewSheetOpen}
					accessToken={creds.access_token}
					transport={transport}
					onQueueChanged={refreshPendingReviewCount}
				/>
			)}
		</div>
		</TransportContext.Provider>
	);
}

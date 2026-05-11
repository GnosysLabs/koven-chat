// Top-level wiring.  Loads stored Matrix credentials (if any), shows
// the login screen when absent, otherwise spins up a MatrixTransport
// and renders the Sidebar + ChatPane.  Governance overlays go on top
// of this in subsequent passes.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
	MatrixTransport,
	type MatrixCredentials,
	type SyncState,
} from "@/lib/matrix";
import {
	loadAccounts,
	saveAccounts,
	loadActiveUserId,
	saveActiveUserId,
	upsertAccount,
	removeAccount,
	pickNextActive,
	type StoredAccount,
} from "@/lib/accounts";
import { Login } from "@/components/Login";
import { SpaceBar } from "@/components/SpaceBar";
import { RoomList } from "@/components/RoomList";
import { MobileTopBar } from "@/components/MobileTopBar";
import { MobileTabBar, type MobileTab } from "@/components/MobileTabBar";
import { MobileSpacesList } from "@/components/MobileSpacesList";
import { MobileMeScreen } from "@/components/MobileMeScreen";
import { isMobileShell } from "@/lib/mobile";
import { parseShareIntent, clearShareUrl, type ShareIntent } from "@/lib/inviteLink";
import { ChatPane } from "@/components/ChatPane";
import { SpaceLanding } from "@/components/SpaceLanding";
import { ExplorePane } from "@/components/ExplorePane";
import { BotsPane } from "@/components/BotsPane";
import { BotList } from "@/components/BotList";
import { listMyBots, deleteBot as apiDeleteBot, type BotSummary } from "@/lib/bots";
import { MemberList } from "@/components/MemberList";
import { DmProfilePanel } from "@/components/DmProfilePanel";
import { CreateRoomSheet } from "@/components/CreateRoomSheet";
import { CreateSpaceSheet } from "@/components/CreateSpaceSheet";
import { MobileBlockScreen } from "@/components/MobileBlockScreen";
import { StartDmSheet } from "@/components/StartDmSheet";
import { SpaceEditSheet } from "@/components/SpaceEditSheet";
import { RoomEditSheet } from "@/components/RoomEditSheet";
import { InviteSheet } from "@/components/InviteSheet";
import { ProfileSheet } from "@/components/ProfileSheet";
import { AppSettingsSheet } from "@/components/AppSettingsSheet";
import { EncryptionSetupSheet } from "@/components/EncryptionSetupSheet";
import { EncryptionUnlockSheet } from "@/components/EncryptionUnlockSheet";
import { SuspendedBanner } from "@/components/SuspendedBanner";
import { ModLogSheet } from "@/components/ModLogSheet";
import { FloorReviewSheet } from "@/components/FloorReviewSheet";
import { botKickBan, deleteOwnMessage, fetchAdminStatus, fetchFloorQueue, fetchMyStatus, flagRoom, type SuspensionSummary } from "@/lib/instance";
import { fetchIntegrationsStatus } from "@/lib/giphy";
import { ENGINE_URL } from "@/lib/urls";
import { setAppBadge } from "@/lib/appBadge";
import { NsfwAcceptDialog } from "@/components/NsfwAcceptDialog";
import { AddExistingRoomDialog } from "@/components/AddExistingRoomDialog";
import { useCollapsedRooms } from "@/lib/collapsedRooms";
import { fetchAllBotMxids } from "@/lib/bots-cache";
import { startFoundersRosterRefresh } from "@/lib/founders-cache";
import { fetchUiaPassword } from "@/lib/auth";
import { TransportContext } from "@/lib/transportContext";
import { applyTheme, loadSettings, saveSettings, type Settings } from "@/state/settings";
import type { Room, UserId } from "@koven/shared";
import { ensureNotificationPermission, notify } from "@/lib/notifications";
import { initialState, reduce } from "@/state/store";
import type { RoomId, SpaceId } from "@koven/shared";
import { NotificationBell } from "@/components/NotificationBell";
import { useNotifications } from "@/state/use-notifications";
import { markRoomRead as apiMarkRoomRead } from "@/lib/notifications-api";
import { CallAudioSinkGate } from "@/components/voice/CallAudioSinkGate";
import { CallPipPanel } from "@/components/voice/CallPipPanel";
import { IncomingRingListener } from "@/components/voice/IncomingRingListener";
import { CallToastListener } from "@/components/voice/CallToastListener";
import { useCall } from "@/lib/call-context";

// Escape a string for safe interpolation into a RegExp.  Used to
// build the @localpart mention matcher in the notification path —
// localparts can contain `.` and `_`, both regex meta-characters.
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default function App() {
	// Multi-account model.
	//
	// `accounts` holds every account the user has logged into on this
	// origin; `activeUserId` is a pointer to the one currently driving
	// the live MatrixTransport.  Switching is "set the pointer, let
	// the cred-watching effect tear the old transport down and bring
	// the new one up."  Sign-out-of-current splices the active row out
	// and falls forward to the next account when one exists, else null
	// (which routes to the Login screen).  Adding an account leaves
	// every existing entry untouched and just appends.
	//
	// `creds` is derived from those two — the rest of the app keeps
	// reading `creds` exactly the way it did in the single-account era,
	// which kept this refactor surgical.
	const [accounts, setAccounts] = useState<StoredAccount[]>(loadAccounts);
	const [activeUserId, setActiveUserIdState] = useState<string | null>(loadActiveUserId);
	// Whenever no `activeUserId` is set but accounts exist, default to
	// the first one — covers fresh-load with the legacy single-cred
	// migration where the active key wasn't yet written.
	useEffect(() => {
		if (!activeUserId && accounts.length > 0) {
			const fallback = accounts[0]!.user_id;
			setActiveUserIdState(fallback);
			saveActiveUserId(fallback);
		}
	}, [accounts, activeUserId]);
	const creds: MatrixCredentials | null = useMemo(() => {
		if (!activeUserId) return null;
		const a = accounts.find(x => x.user_id === activeUserId);
		return a ? {
			homeserver: a.homeserver,
			user_id: a.user_id,
			access_token: a.access_token,
			device_id: a.device_id,
		} : null;
	}, [accounts, activeUserId]);
	const [state, dispatch] = useReducer(reduce, initialState);
	// Engine-driven collapsed-room set: drives the room-name display
	// override + the Explore directory filter for the offensive-room-
	// name pipeline.  Polled every 5 min + on focus; we also call
	// `refresh()` immediately after a flag submission.
	const { ids: collapsedRoomIds, refresh: refreshCollapsedRooms } = useCollapsedRooms();
	// In-app notification bell.  Polls /api/notifications/unread-count
	// every ~30s; full list is fetched on bell open.  Hook is a no-op
	// until creds resolve, so it's safe to mount unconditionally.
	// `activeRoomId` lets the hook auto-clear unread for the room
	// the user is actively viewing (with tab focused) — symmetric
	// with the OS-notification gate, so neither surface lights up
	// for messages the user is watching land in real time.
	const notifications = useNotifications(
		creds?.access_token ?? null,
		state.activeRoomId,
	);
	// Stable handle on `notifications.refresh` so the transport's
	// onMessage callback can pull a fresh unread count the instant a
	// notification-worthy event lands, without re-binding the entire
	// MatrixHandlers object every render.  Otherwise the bell's red
	// dot only appeared on the next 30-second poll tick — the engine
	// had already written the row, but the SPA hadn't asked yet.
	const notificationsRefreshRef = useRef(notifications.refresh);
	useEffect(() => {
		notificationsRefreshRef.current = notifications.refresh;
	}, [notifications.refresh]);

	// Mirror the bell's unread count onto the OS app icon — Tauri
	// dock badge on macOS, Web App Badging API for installed PWAs.
	// Cleared when the user signs out so a stale number doesn't
	// linger on the icon after the next launch.
	useEffect(() => {
		void setAppBadge(creds ? notifications.unreadCount : 0);
	}, [creds, notifications.unreadCount]);

	// Click handler shared by both bell instances (mobile topbar
	// icon + desktop FAB).  Two responsibilities:
	//
	//   1. Switch the activeSpace to the right container so
	//      whatever opens lands under the correct tab.  Without
	//      this, clicking a DM notification from the "Rooms" tab
	//      shows the DM rendered inside the rooms list — broken UX.
	//        - room.kind === "dm"           → activeSpace = {dms}
	//        - room.parentSpaceIds.length>0 → activeSpace = parent
	//        - orphan room                  → leave activeSpace alone
	//
	//   2. Open the room IFF it's a normal joined room.  For
	//      invite-state rooms (room.isInvite), we deliberately
	//      DON'T set active_room — opening would dump the user
	//      into a not-yet-joined room with the awkward join/
	//      decline overlay.  Instead we just navigate to the
	//      right tab/space so the user sees the invite listed in
	//      "Requests" at the top of the room list, where they can
	//      accept or decline cleanly.
	//
	// On mobile, also closes the Me overlay — the notification
	// click is a stronger nav signal than "stay on Me."
	const openRoomFromNotification = useCallback(
		(roomId: string) => {
			const room = roomsRef.current.find(r => r.id === roomId);
			if (room) {
				if (room.kind === "dm") {
					dispatch({ type: "set_active_space", space: { kind: "dms" } });
				} else if (room.parentSpaceIds.length > 0) {
					dispatch({
						type: "set_active_space",
						space: { kind: "space", id: room.parentSpaceIds[0] as SpaceId },
					});
				} else {
					// Orphan non-DM room — lives in the "Rooms" bucket.
					// Without this branch, clicking a notification while
					// on Explore (or any other virtual space) would
					// silently leave the active space alone, the
					// timeline would never render, and the user would
					// just stare at Explore wondering where their room
					// went.
					dispatch({ type: "set_active_space", space: { kind: "spaces_overview" } });
				}
			}
			setMobileMeOpen(false);

			// Invite state — just land in the right tab, don't
			// auto-open the room.
			if (room?.isInvite) return;

			dispatch({ type: "set_active_room", roomId: roomId as RoomId });
		},
		[],
	);
	const [transport, setTransport] = useState<MatrixTransport | null>(null);
	// Live-call gate.  True only when the user is actively LOOKING
	// at the call (not just in the call's room while reading
	// chat) — Discord-style: voice and chat are separate views.
	// When true, the chat pane swaps in the call surface AND the
	// right sidebar (member list / DM profile) hides so the call
	// grid + thumbnail strip get the full width.  Same condition
	// as ChatPane's isInActiveCallRoom so they stay in lockstep.
	const call = useCall();
	const isViewingActiveCallRoom =
		!!call.activeCall &&
		call.activeCall.roomId === state.activeRoomId &&
		call.inCallView &&
		(call.phase === "connecting" || call.phase === "prejoin" || call.phase === "joined");
	// Wrap room navigation so any sidebar room-click also drops the
	// "in call view" flag.  Discord rule: clicking a channel name
	// always shows the channel's chat, never the call view —
	// regardless of whether you're in voice in that channel or
	// elsewhere.  To re-enter the call view the user clicks the
	// PIP, the "Return to call" bar, or any other explicit
	// affordance that calls call.setInCallView(true).
	const navigateToRoom = useCallback((roomId: RoomId) => {
		call.setInCallView(false);
		dispatch({ type: "set_active_room", roomId });
	}, [call]);
	const [bootError, setBootError] = useState<string | null>(null);
	const [createRoomOpen, setCreateRoomOpen] = useState(false);
	const [createSpaceOpen, setCreateSpaceOpen] = useState(false);
	// SpaceLanding's "Add existing room" affordance opens a picker
	// dialog scoped to the space whose id is held here.  Cleared on
	// dialog close.  Distinct from the createRoom path because we're
	// linking an already-existing room, not creating a new one.
	const [addExistingRoomTo, setAddExistingRoomTo] = useState<SpaceId | null>(null);
	const [startDmOpen, setStartDmOpen] = useState(false);
	// NSFW invite-confirmation gate.  Two-mode dialog: "invite"
	// (pre-accept, the room/space itself is flagged NSFW) and
	// "space-children" (post-accept, joinSpaceWithChildren skipped
	// some NSFW child rooms because the viewer hasn't opted in).
	// Confirming flips `chat.koven.nsfw_preference` to true and runs
	// the deferred accept (or, for space-children mode, lets the live
	// auto-join listener pick the children up on the next sync).
	const [nsfwGate, setNsfwGate] = useState<{
		mode: "invite" | "space-children";
		roomId: RoomId;
		subjectName: string;
		isSpace: boolean;
		skippedNsfwCount?: number;
		// Deferred accept handler — only set in "invite" mode.  Runs
		// after the user confirms (and after we flip the NSFW pref);
		// in "space-children" mode the join already happened, so this
		// is undefined and confirmation just flips the pref.
		onConfirm?: () => Promise<void>;
	} | null>(null);
	// Mobile-only "Me" tab — when true, the bottom-tab "Me" view
	// covers the panels with the profile + settings list.  Kept
	// as a separate flag (rather than another `ActiveSpace` kind)
	// because it isn't really a chat surface; pressing any other
	// tab clears it without disturbing the underlying activeSpace.
	const [mobileMeOpen, setMobileMeOpen] = useState(false);
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
	// Instance-wide third-party integrations.  Polled once on sign-in
	// (admin re-saves invalidate it via a refresh — see InstanceAdmin
	// section).  Drives the GIF picker visibility in the composer.
	const [giphyEnabled, setGiphyEnabled] = useState(false);
	// (Old MatrixCall-based 1:1 call state removed — DM calls now
	// use the same RealtimeKit-backed flow as group rooms via
	// CallProvider.  The ringing UI is IncomingRingListener +
	// IncomingRingSheet, the in-call UI is InCallPane, and the
	// "you got declined" toast is CallToastListener.)
	// Holds the UIA password handed back by the engine on login so the
	// transport can pick it up the moment it's constructed.  See
	// handleLogin for the rationale.
	const pendingUiaPasswordRef = useRef<string | null>(null);

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

	// Founders roster — same shape as the bot roster, but keyed by
	// numerical signup slot.  Cached locally; consumers (chat author
	// header, member list, profile sheet) read synchronously via
	// getCachedFounderNumber.  See lib/founders-cache.ts.
	useEffect(() => startFoundersRosterRefresh(), []);

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

	// Mobile gatekeeper: the Bots pane is desktop-only (dense
	// management UI: mxid copy, token rotation, config sheets).
	// If a stored session from a prior desktop run lands here on
	// mobile — or any future code path tries to enter it —
	// quietly bounce back to DMs so the user isn't stuck in a
	// sub-par view with no entry point in the drawer.
	useEffect(() => {
		if (isMobileShell && state.activeSpace?.kind === "bots") {
			dispatch({ type: "set_active_space", space: { kind: "dms" } });
		}
	}, [state.activeSpace?.kind]);

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

	// Integrations status — polled once at sign-in; admin saves
	// re-invalidate from inside InstanceAdminSection (which re-fetches
	// itself).  Out-of-band changes (admin on another session)
	// pick up on next sign-in, which is good enough for v1.
	useEffect(() => {
		if (!creds) {
			setGiphyEnabled(false);
			return;
		}
		let cancelled = false;
		fetchIntegrationsStatus(creds.access_token)
			.then(integ => {
				if (!cancelled) setGiphyEnabled(integ.giphy.configured);
			})
			.catch(() => {
				/* engine may be older than the integrations endpoint;
				   leave giphy disabled.  Not worth surfacing. */
			});
		return () => { cancelled = true; };
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

	// Listen for `open-room` messages posted by the service worker
	// when the user taps a notification.  The SW can't navigate the
	// SPA on its own — it focuses an existing tab + posts the room
	// id, and we dispatch the active-room change here.  Without this
	// listener, tapped notifications focus the tab but leave the user
	// on whatever screen they had open before.
	useEffect(() => {
		if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
		const onMessage = (e: MessageEvent) => {
			const data = e.data as { type?: string; roomId?: string } | undefined;
			if (data?.type !== "open-room" || typeof data.roomId !== "string") return;
			dispatch({ type: "set_active_room", roomId: data.roomId as RoomId });
		};
		navigator.serviceWorker.addEventListener("message", onMessage);
		return () => navigator.serviceWorker.removeEventListener("message", onMessage);
	}, []);

	// Tracks the previous transport's teardown promise across creds
	// changes.  Account-switch path was racing the new start() against
	// the old transport's still-open IndexedDB connections — wipe was
	// blocked, timed out after 5s, and initRustCrypto then ran against
	// stale data.  Symptom was "stuck on Connecting…" on the second
	// account.  We now await this promise (when set) before the new
	// transport calls start(), so the old crypto IDB is fully released
	// first.  useRef survives the StrictMode dev double-effect; the
	// promise stays resolvable across both invocations.
	const previousTeardownRef = useRef<Promise<void> | null>(null);

	// Bootstrap (and re-bootstrap) the transport whenever creds change.
	useEffect(() => {
		if (!creds) return;
		const t = new MatrixTransport({
			onSyncState: (s: SyncState) => dispatch({ type: "sync_state", state: s }),
			onRoomsUpdated: rooms => dispatch({ type: "rooms_updated", rooms }),
			onSpacesUpdated: spaces => dispatch({ type: "spaces_updated", spaces }),
			onMessage: (message, { live }) => {
				dispatch({ type: "message_arrived", message, live });
				// Mark-as-read for messages arriving in the room
				// the user is actively viewing with the tab
				// focused.  Deliberately NOT gated on `live`:
				// matrix-js-sdk's Decrypted listener (which is the
				// path encrypted messages arrive through — that's
				// every bot DM, every E2EE room) hardcodes
				// `live: false` because the original Timeline
				// event was processed earlier as the encrypted
				// placeholder.  Gating markAsRead on `live` meant
				// the receipt + counter-zero NEVER fired for
				// encrypted messages, leaving the SDK's counter
				// at 1 and the sidebar dot lit while the user
				// stared at the message they just received.
				// Receipts are idempotent — extra ones during the
				// rare initial-sync replay window are cheap and
				// the SDK dedupes consecutive identical receipts.
				if (
					activeRoomIdRef.current === message.roomId &&
					(typeof document === "undefined" || document.visibilityState === "visible")
				) {
					t.markAsRead(message.roomId).catch(() => {});
					// Engine-side: stamp the room_active timestamp
					// so the notification fanout sees this user as
					// actively in the room and skips writing bell
					// rows for events arriving in the next ~60s
					// (RECENTLY_ACTIVE_MS in db.ts).  Without this
					// stamp the bell would log "Newsly sent you 3
					// DMs" for messages the user watched arrive.
					const tok = creds?.access_token;
					if (tok) {
						apiMarkRoomRead({ accessToken: tok, roomId: message.roomId }).catch(() => {});
					}
				}

				// Notification gate.  Live, not-from-me, and ANY of:
				//   * the room is a DM, OR
				//   * the message text mentions the viewer (full mxid
				//     or local @localpart), OR
				//   * the message is a reply whose target sender is the
				//     viewer (someone hit "Reply" on one of your
				//     messages — same intent signal as a mention).
				// AND not the room they're currently looking at while
				// the tab is focused — popping a notification for a
				// message that's already on their screen is noise.
				if (!live || message.isSelf) return;
				// Skip catch-up replays.  matrix-js-sdk delivers events
				// that arrived since the user's last sync token as
				// `liveEvent: true` during the initial sync after
				// login.  From the SDK's perspective these are "live"
				// (just received), but from the user's they're old —
				// firing OS notifications for them replays days of
				// missed messages on every cold boot.  Drop anything
				// older than 30 seconds; real-time messages are well
				// inside that window.
				const RECENT_MS = 30_000;
				if (Date.now() - message.timestamp > RECENT_MS) return;
				const myMxid = creds.user_id;
				const localpart = myMxid.split(":")[0] ?? ""; // includes leading @
				const text = message.text ?? "";
				// Match either the full mxid or the @localpart shorthand
				// the @-mention picker inserts on same-server mentions.
				// Simple substring matches are fine — false positives
				// (someone typed "@alice" when they meant a different
				// alice) are rare and the cost of an extra notification
				// is small.
				const mentionsMe = text.includes(myMxid) ||
					(localpart.length > 1 && new RegExp(`(^|\\W)${escapeRegex(localpart)}(\\W|$)`).test(text));
				const repliesToMe = message.replyTo?.sender === myMxid;
				const room = roomsRef.current.find(r => r.id === message.roomId);
				const isDm = room?.kind === "dm";
				// Per-room notification level override.  When the user
				// has set this room to "all messages" via the right-
				// click menu, every regular message here triggers an
				// OS notification — same gate the engine fanout uses
				// to write the kind=message bell entry.  When set to
				// "muted", suppress everything including DM/mention.
				const notifyLevel = notifyPrefsCacheRef.current?.(message.roomId) ?? "mentions";
				if (notifyLevel === "muted") return;
				const followAll = notifyLevel === "all";
				if (!isDm && !mentionsMe && !repliesToMe && !followAll) return;

				// Skip if the message is in the room the user has open
				// as their active room — full stop, regardless of tab
				// visibility / focus state.
				//
				// Earlier this also gated on document.visibilityState
				// being "visible" (and originally hasFocus()), but
				// both flags have edge cases that fire false negatives
				// — leaving the user with "I'm staring at this DM and
				// got a notification for a message I just watched
				// arrive."  The simpler rule is: if you've explicitly
				// opened a room, anything that lands in it is by
				// definition not noise-worthy; the unread dot is the
				// signal if you wandered off.  Any room you didn't
				// open is treated as "behind your back" and gets an
				// OS notification through the rest of the gate below.
				if (activeRoomIdRef.current === message.roomId) return;

				const senderName = message.senderDisplayName || message.sender;
				const title = isDm
					? senderName
					: `${senderName} in ${room?.name ?? "a room"}`;
				const body = text || (message.kind !== "text" ? `(${message.kind})` : "");
				void notify({
					title,
					body,
					tag: message.roomId, // collapse-stack per-room
					// Per-event dedupe persists in localStorage so a
					// matrix-js-sdk replay on the next launch (initial
					// sync delivers events as `liveEvent: true` even
					// after the user has already seen them) doesn't
					// re-fire the OS notification.
					dedupeKey: message.id,
					roomId: message.roomId,
					onClick: () => {
						dispatch({ type: "set_active_room", roomId: message.roomId });
					},
				});
				// Bell red dot used to lag the 30s poll cadence behind
				// the actual event.  Refresh now AND again after a
				// short delay: Synapse sends the event to our /sync
				// in parallel with sending it to the engine's
				// /transactions appservice stream, and the engine's
				// notification fanout (which writes the row the bell
				// reads) finishes some milliseconds AFTER our /sync
				// delivers the event.  An immediate refresh races
				// the fanout and can return the pre-write count;
				// the 1.2s follow-up catches the row reliably.
				void notificationsRefreshRef.current?.();
				window.setTimeout(() => {
					void notificationsRefreshRef.current?.();
				}, 1_200);
			},
			onReaction: (reaction) => dispatch({
				type: "reaction_arrived",
				reaction,
				myUserId: creds.user_id as UserId,
			}),
			onMessageRedacted: (roomId, eventId) => dispatch({
				type: "message_redacted",
				roomId,
				eventId,
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
			onPollResponse: (ev) => dispatch({
				type: "poll_response_arrived",
				response: ev,
				myUserId: creds.user_id as UserId,
			}),
			onPollEnd: (ev) => dispatch({
				type: "poll_end_arrived",
				end: ev,
			}),
			onMembersUpdated: roomId => {
				const members = t.getRoomMembers(roomId);
				dispatch({ type: "members_loaded", roomId, members });
			},
			onReceiptsUpdated: (roomId) => {
				// Bump a per-room version counter so the active
				// ChatPane re-renders its message list (and the
				// per-message SeenIndicator components re-query
				// transport.getMessageSeenBy).  Cheap — we don't
				// store receipt data in our state, just a counter.
				dispatch({ type: "receipts_updated", roomId });
			},
			onIncomingCall: (call) => {
				// MatrixCall flow has been retired in favor of the
				// RealtimeKit-backed system.  Reject any incoming
				// MatrixCall invite (e.g. from a federated client
				// still using the old flow) so we don't half-answer
				// a call we have no UI for.
				try { call.reject(); } catch { /* already-rejected */ }
			},
			onSessionLoggedOut: () => {
				// Server-side session invalidation (token revoked,
				// device deleted, admin logout, soft-logout).  Drop
				// this account from local state + storage and pivot
				// to the next stored account if any, otherwise the
				// login screen.  We DELIBERATELY don't call
				// `t.logout()` — the homeserver already considers
				// this token dead, and a /logout against a dead token
				// returns 401 in its own loop.  Same reasoning as a
				// normal handleSignOut otherwise: clear creds, blank
				// the encryption gate, drop active room.
				const leaving = creds.user_id;
				setAccounts(prev => {
					const next = removeAccount(prev, leaving);
					saveAccounts(next);
					return next;
				});
				setActiveUserIdState(prevActive => {
					if (prevActive !== leaving) return prevActive;
					// The next active account is computed off the
					// PRE-removal list so pickNextActive can see the
					// account being removed and skip it.
					const nextActive = pickNextActive(accounts, leaving);
					saveActiveUserId(nextActive);
					return nextActive;
				});
				setEncState(null);
				dispatch({ type: "set_active_room", roomId: null });
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
		// Probe (and request once if not already decided) the OS-
		// notification permission.  Idempotent on subsequent calls;
		// on browsers this surfaces the permission prompt the first
		// time the user signs in.  On Tauri it round-trips the
		// plugin's isPermissionGranted / requestPermission flow.
		// Fire-and-forget — failures fall through to "no
		// notifications", which is the right graceful degrade.
		void ensureNotificationPermission();
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
		// Wait for the previous transport's teardown to finish BEFORE
		// firing start().  start() calls wipeRustCryptoIndexedDB
		// internally on user-switch detection, and the wipe blocks
		// indefinitely if the previous transport's OlmMachine still
		// holds the IDB open.  Without this await, the wipe times out
		// after 5s, "proceeds anyway" against stale data, and the
		// user gets stuck on "Connecting…" forever.
		const startWithTeardownAwait = async () => {
			if (previousTeardownRef.current) {
				try {
					await previousTeardownRef.current;
				} catch (err) {
					console.warn("app.boot: previous teardown rejected", err);
				}
				previousTeardownRef.current = null;
			}
			if (cancelled) return;
			await t.start(creds);
		};
		startWithTeardownAwait().then(async () => {
			if (cancelled) return;
			// Hydrate the per-room notification preferences cache so
			// the sidebar mute indicators + right-click level pickers
			// have data without per-row round-trips.  Fire-and-forget;
			// the cache hydration emits to its listeners, so any UI
			// depending on it re-renders when the data lands.
			void import("@/lib/notifyPrefs").then(({ hydrateNotifyPrefs }) => {
				if (cancelled || !creds.access_token) return;
				void hydrateNotifyPrefs(creds.access_token);
			});
			// Pull my avatar mxc once so the SpaceBar tile resolves to my
			// real avatar instead of the DiceBear fallback.  Map an
			// undefined `avatarUrl` to `null` so SpaceBar can tell
			// "probe completed, no avatar" from the still-pending
			// `undefined` initial state — the SpaceBar tile renders a
			// muted placeholder until this fires.
			t.getMyProfile()
				.then(p => {
					if (cancelled) return;
					setMyAvatarMxc(p.avatarUrl ?? null);
					// Cache display name + avatar onto the active stored
					// account so the AccountSwitcher popover can render
					// inactive rows without a network round-trip on cold
					// boot.  Only write when a value actually changed
					// (cheap deep equality on the two cached fields)
					// so we don't churn localStorage on every sync echo.
					setAccounts(prev => {
						const idx = prev.findIndex(a => a.user_id === p.userId);
						if (idx < 0) return prev;
						const existing = prev[idx]!;
						if (
							existing.display_name === p.displayName
							&& existing.avatar_url === (p.avatarUrl ?? undefined)
						) {
							return prev;
						}
						const updated: StoredAccount = {
							...existing,
							display_name: p.displayName,
							avatar_url: p.avatarUrl ?? undefined,
						};
						const copy = prev.slice();
						copy[idx] = updated;
						saveAccounts(copy);
						return copy;
					});
				})
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

		// Cross-device NSFW preference sync.  account_data is the
		// source of truth; localStorage is just a per-device cache so
		// the toggle has correct state on first paint before sync
		// catches up.  Listener fires on every change (this client +
		// other devices) and mirrors the value into Settings.
		const unsubscribeNsfw = t.onNsfwPreferenceChanged((show) => {
			if (cancelled) return;
			setSettings(prev => prev.showNsfw === show ? prev : { ...prev, showNsfw: show });
		});
		// Initial reconcile — once /sync has populated account_data,
		// pull the server-side value and override local state.  Wrap
		// in a microtask so we don't fight the start() promise chain.
		queueMicrotask(() => {
			if (cancelled) return;
			const serverShow = t.getNsfwPreference();
			setSettings(prev => prev.showNsfw === serverShow ? prev : { ...prev, showNsfw: serverShow });
		});

		return () => {
			cancelled = true;
			unsubscribe();
			unsubscribeNsfw();
			// useEffect cleanups can't be async, so we record the stop
			// promise on a ref the NEXT effect awaits before its own
			// start().  Without this handoff, the new transport hits
			// the wipeRustCryptoIndexedDB step while THIS transport's
			// OlmMachine still has the IDB open — wipe gets blocked,
			// times out after 5s, then initRustCrypto reads stale
			// data and the user gets stuck on "Connecting…" forever.
			//
			// The promise is intentionally allowed to settle even
			// after `cancelled` flips — start() short-circuits on
			// cancelled, but we still want stop() to fully complete
			// so its IDB connections close.
			previousTeardownRef.current = t.stop();
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
		const previousRoomId = activeRoomIdRef.current;
		activeRoomIdRef.current = state.activeRoomId;
		// Engine-side bell clear for the room being LEFT.  Closes
		// the gap on the bell side; sidebar-dot side is handled
		// by markAsRead's setUnreadNotificationCount path which
		// updates synchronously without needing any presentation-
		// layer masking.
		if (previousRoomId && previousRoomId !== state.activeRoomId) {
			const tok = creds?.access_token;
			if (tok) {
				apiMarkRoomRead({ accessToken: tok, roomId: previousRoomId }).catch(() => {});
			}
		}
	}, [state.activeRoomId, creds?.access_token]);

	// Keep a stable reference to the current rooms list so the
	// transport's onMessage handler (captured at boot time) can
	// look up room metadata — specifically: is this a DM, what's
	// the room name — without going stale across re-renders.  Same
	// pattern as activeRoomIdRef.
	const roomsRef = useRef<Room[]>([]);
	useEffect(() => {
		roomsRef.current = state.rooms;
	}, [state.rooms]);

	// Reader for the per-room notification level cache.  Lazy-loaded
	// via dynamic import the first time a notification fires (avoids
	// pulling notifyPrefs into the App.tsx initial bundle); cached on
	// the ref so the lookup stays synchronous on the hot path.  Returns
	// the user's chosen level for a room, or "mentions" by default.
	const notifyPrefsCacheRef = useRef<((roomId: string) => "all" | "mentions" | "muted") | null>(null);
	useEffect(() => {
		void import("@/lib/notifyPrefs").then(({ getRoomNotifyLevel }) => {
			notifyPrefsCacheRef.current = getRoomNotifyLevel;
		});
	}, []);

	// One-shot DM backfill — the engine doesn't have access to a
	// user's m.direct account_data over the appservice, so it can't
	// see which rooms are "real" DMs vs. 2-person private rooms on
	// its own.  The SPA already has m.direct (matrix-js-sdk uses it
	// to project room.kind = "dm").  Once per session, after the
	// first non-empty room list lands, forward those ids to
	// /api/rooms/mark-dms so the engine's notification fan-out can
	// distinguish the two.  Forward-going invites that carry
	// is_direct=true mark themselves through handleMember in the
	// appservice transaction stream — this is just the bridge for
	// rooms that pre-date that path.  Idempotent server-side.
	const dmBackfillDoneRef = useRef(false);
	useEffect(() => {
		if (!creds?.access_token) return;
		if (dmBackfillDoneRef.current) return;
		const dmIds = state.rooms.filter(r => r.kind === "dm").map(r => r.id);
		if (dmIds.length === 0) return;
		dmBackfillDoneRef.current = true;
		fetch(`${ENGINE_URL}/api/rooms/mark-dms`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${creds.access_token}`,
			},
			body: JSON.stringify({ room_ids: dmIds }),
		}).catch(() => {
			// Reset the flag on failure so the next room-list update
			// retries; transient network blips shouldn't permanently
			// poison the bridge.
			dmBackfillDoneRef.current = false;
		});
	}, [creds, state.rooms]);

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

	// Share-link handler.  Boot path consumes one of:
	//   /invite/<roomOrSpaceIdOrAlias>  → join (if not already in)
	//                                      then navigate
	//   /r/<roomId>/<eventId>           → navigate to the room (event-
	//                                      level scrolling is a future
	//                                      enhancement; for now landing
	//                                      in the room is the win)
	// Runs once per session: a ref guards against re-firing on every
	// sync transition, and clearShareUrl() rewrites the address bar
	// so a refresh doesn't repeat the auto-navigate (which would be
	// confusing if the user has since left the room or routed away).
	const shareIntentConsumedRef = useRef(false);
	// Consume a parsed share intent: join the room (idempotent for
	// already-joined ones), pick the right active space so the room
	// shows in the sidebar, then activate it.  Extracted so both
	// the on-mount cold path (URL the SPA loaded with) and the
	// running-app warm path (Tauri `deep-link` event) feed the same
	// pipeline.
	const consumeShareIntent = useCallback(async (intent: ShareIntent) => {
		if (!transport) return;
		try {
			let roomId: string;
			if (intent.kind === "invite") {
				// joinRoomById is idempotent — already-joined rooms
				// resolve immediately to their roomId.  Aliases get
				// resolved server-side as part of the join.
				roomId = await transport.joinRoomById(intent.target);
			} else {
				roomId = intent.roomId;
			}
			// Pick the right "active space" so the room actually
			// shows up in the rendered list.  Reuses the same
			// resolution logic as openRoomFromNotification.
			const room = roomsRef.current.find(r => r.id === roomId);
			if (room) {
				if (room.kind === "dm") {
					dispatch({ type: "set_active_space", space: { kind: "dms" } });
				} else if (room.parentSpaceIds.length > 0) {
					dispatch({
						type: "set_active_space",
						space: { kind: "space", id: room.parentSpaceIds[0] as SpaceId },
					});
				} else {
					dispatch({ type: "set_active_space", space: { kind: "spaces_overview" } });
				}
			}
			dispatch({ type: "set_active_room", roomId: roomId as RoomId });
		} catch (err) {
			console.warn("share-intent: failed to consume", intent, err);
		} finally {
			clearShareUrl();
		}
	}, [transport]);

	useEffect(() => {
		if (shareIntentConsumedRef.current) return;
		if (!transport || !creds) return;
		// Wait for sync to be at least syncing — joinRoom needs a
		// live client and dispatching set_active_room on a room that
		// hasn't synced yet leaves the timeline empty until the
		// next room-list refresh.
		if (state.syncState !== "ready" && state.syncState !== "syncing") return;
		const intent = parseShareIntent();
		if (!intent) {
			shareIntentConsumedRef.current = true;
			return;
		}
		shareIntentConsumedRef.current = true;
		void consumeShareIntent(intent);
	}, [transport, creds, state.syncState, consumeShareIntent]);

	// Tauri deep-link warm path.  When the OS hands us a `koven://...`
	// URL while the app is already running (Mail click, Messages
	// click, terminal `open koven://invite/foo`, etc.) the Rust
	// shell re-emits it on the `deep-link` window event.  Subscribe
	// once per session — the listener stays alive for the lifetime
	// of the app.  Cold-launch deep-links also flow through this
	// path: tauri-plugin-deep-link replays queued URLs to listeners
	// the moment one binds, so the SPA picks up an URL that arrived
	// before React mounted.
	//
	// Dynamic import + window.__TAURI__ guard keeps this code path
	// dead in the web build (the @tauri-apps/api/event module would
	// throw on subscribe in a plain browser).
	useEffect(() => {
		if (!transport || !creds) return;
		if (typeof window === "undefined" || !("__TAURI__" in window)) return;
		let unsubscribe: (() => void) | null = null;
		let cancelled = false;
		void (async () => {
			try {
				const { listen } = await import("@tauri-apps/api/event");
				const unlisten = await listen<string>("deep-link", evt => {
					const url = evt.payload;
					if (typeof url !== "string" || !url) return;
					const intent = parseShareIntent(url);
					if (!intent) return;
					void consumeShareIntent(intent);
				});
				if (cancelled) { unlisten(); return; }
				unsubscribe = unlisten;
			} catch (err) {
				console.warn("deep-link listener failed to bind", err);
			}
		})();
		return () => {
			cancelled = true;
			if (unsubscribe) unsubscribe();
		};
	}, [transport, creds, consumeShareIntent]);

	// Session-view persistence intentionally removed.  Every login
	// + page reload now lands on DMs (the initialState default) so
	// the post-login experience is deterministic; restoring the
	// last-viewed space-channel was disorienting and occasionally
	// tripped on stale ids.  See the matching "no restore" block
	// below.

	// Restore the persisted view once the room list is available.  Fires
	// only once per session (guarded by a ref), only when there's no
	// share-intent in flight (intent navigation wins over restore), and
	// only validates the saved room/space against the user's CURRENT
	// joined set so a stored room id for a room they've since left
	// doesn't navigate them into a missing room.
	const viewRestoredRef = useRef(false);
	useEffect(() => {
		if (viewRestoredRef.current) return;
		if (!creds?.user_id) return;
		if (state.syncState !== "ready" && state.syncState !== "syncing") return;
		// Skip restore when the URL carried a share intent — that
		// intent's navigation should win.  parseShareIntent is cheap
		// (string parse on window.location).
		if (parseShareIntent()) {
			viewRestoredRef.current = true;
			return;
		}
		// Discord-style: every login + page reload lands on DMs (the
		// initialState default).  We deliberately do NOT restore the
		// user's last activeSpace / activeRoomId — restoring into a
		// space-channel after login was disorienting (you'd land in
		// #general before knowing whether anyone was around) and
		// occasionally tripped on stale room ids.  The user can
		// navigate back to whatever they care about; saving them a
		// click isn't worth the brittleness.
		viewRestoredRef.current = true;
	}, [creds?.user_id, state.syncState, state.rooms, state.spaces]);

	// When the active room changes, load its existing timeline + members
	// + reactions from the matrix-js-sdk's in-memory state.
	useEffect(() => {
		if (!state.activeRoomId || !transport || !creds) return;
		// Mark the room read on entry so the unread dot clears.  Fire
		// and forget — the receipt round-trips to Synapse but we don't
		// gate the room render on it.
		transport.markAsRead(state.activeRoomId).catch(() => {});
		// ALSO ping the engine so its room_active timestamp is
		// stamped immediately.  Without this, the engine's
		// notification fanout has no way to know the user is in
		// the room until the next /api/notifications poll fires
		// (30s window) — any message that arrives in the meantime
		// gets a notification row with read_at=null and the bell
		// rings while the user is staring at the message.
		apiMarkRoomRead({ accessToken: creds.access_token, roomId: state.activeRoomId }).catch(() => {});
		// Hydrate the timeline from whatever matrix-js-sdk has cached
		// for this room.  For rooms the user already had open during
		// the initial /sync this is the full last-200-events window;
		// for rooms they JUST joined (cascade-join from accepting a
		// space invite, freshly added child room, gappy sync) the
		// live timeline can be empty even though the server has
		// history.  Two-phase load handles both:
		//   1. Dispatch synchronously with whatever's cached.  When
		//      it's non-empty, the UI shows messages immediately
		//      (zero flicker, the common case).  When it's empty,
		//      the reducer adds the room to loadedTimelines and the
		//      "No messages yet." banner would fire — UNLESS we
		//      catch it on the second phase below.
		//   2. If the cached read returned 0 messages AND this is
		//      our first time entering the room (no entry in
		//      loadedTimelines yet), eagerly call loadMoreHistory
		//      to backfill from the server.  When it returns
		//      events, re-dispatch — the bug it fixes is rooms with
		//      real history flashing "No messages yet." until the
		//      user refreshed (which forced /sync to backfill).
		const roomIdAtMount = state.activeRoomId;
		const initialMessages = transport.getRoomMessages(roomIdAtMount);
		dispatch({
			type: "messages_loaded",
			roomId: roomIdAtMount,
			messages: initialMessages,
		});
		if (initialMessages.length === 0 && !state.loadedTimelines.has(roomIdAtMount)) {
			void (async () => {
				try {
					const grew = await transport.loadMoreHistory(roomIdAtMount, 50);
					if (!grew) return;
					// Re-emit so the reducer overwrites the empty array.
					// Only fire if the user is still in this room — they
					// may have switched away during the round-trip; an
					// out-of-room re-dispatch would briefly leak an
					// older room's messages into the wrong slot.
					dispatch({
						type: "messages_loaded",
						roomId: roomIdAtMount,
						messages: transport.getRoomMessages(roomIdAtMount),
					});
				} catch (err) {
					console.warn("room-enter backfill failed", err);
				}
			})();
		}
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
		// Insert (or refresh) the account in the array.  Existing rows
		// for the same user_id are replaced — covers the "log in again
		// to refresh the access token / device_id for an account I've
		// already added" case — without duplicating the slot.
		const next = upsertAccount(accounts, newCreds as StoredAccount);
		setAccounts(next);
		saveAccounts(next);
		// Make the just-logged-in account active.  The cred-watching
		// effect below tears down the previous transport (if any) and
		// brings up a fresh one for this user.
		setActiveUserIdState(newCreds.user_id);
		saveActiveUserId(newCreds.user_id);
		// Stash the engine-issued UIA password in a ref so we can hand
		// it to the transport once it's instantiated by the cred-driven
		// effect below.  Memory-only by design: never written to
		// localStorage, never sent back to the engine, never persisted.
		// On every page refresh the UIA password is gone — any UIA op
		// that fires later this session calls fetchUiaPassword() to
		// rotate fresh.
		pendingUiaPasswordRef.current = uiaPassword;
		// Surface the login screen as DONE — required when we're in
		// "add account" mode where the LoginScreen was rendered on top
		// of the existing transport.
		setAddAccountMode(false);
	}

	/** Switch the live transport to a different already-stored account.
	 * No-op when the requested user is already active.  Drops back to
	 * the login screen if asked to switch to an account that isn't in
	 * the array (shouldn't happen in normal flows, but defensive). */
	function switchAccount(userId: string) {
		if (userId === activeUserId) return;
		const account = accounts.find(a => a.user_id === userId);
		if (!account) {
			console.warn(`switchAccount: ${userId} not in accounts`);
			return;
		}
		// Reset the navigation state to a safe landing BEFORE the
		// transport swap.  Without this, the previous account's
		// activeSpace + activeRoomId carry over to the new account —
		// which usually points at a space the new account isn't a
		// member of, so the RoomList paints "No rooms in this space
		// yet" while the chat pane shows "Pick a room from the
		// sidebar" — a confusing limbo.  Drop the active room and
		// default to the DMs view: every account has DMs (even if
		// empty), it's a familiar starting point, and the user can
		// navigate to spaces / rooms from there.
		dispatch({ type: "set_active_room", roomId: null });
		dispatch({ type: "set_active_space", space: { kind: "dms" } });
		setActiveUserIdState(userId);
		saveActiveUserId(userId);
		// The effect below sees the derived `creds` change and runs
		// teardown → start.  No further work here — letting the
		// effect own the lifecycle keeps a single source of truth for
		// transport state.
	}

	// Add-account mode flag: when true, render the Login screen even
	// though the user is already authenticated as someone else.  Login
	// success flips this back to false (handled in handleLogin).
	const [addAccountMode, setAddAccountMode] = useState(false);

	// Pre-flight rate-limit check before opening CreateRoomSheet.  If
	// the user's over their daily cap, surface the explanatory dialog
	// with the per-tier ladder instead of opening the create form for
	// nothing.  Called from every "Create room" entry point — keeps
	// the gate logic in one place so adding a new entry point
	// elsewhere doesn't accidentally bypass it.  Soft-fails to "open
	// the form" on quota fetch errors — better to let the user
	// proceed and hit a real engine error at submit than block them
	// on a transient health blip.
	const openCreateRoomGated = useCallback(async () => {
		// Discord-style invariant: rooms can only be created inside a
		// space.  Every entry point already routes through here, so
		// gating once covers the lot — if no space is active, refuse
		// rather than open a sheet that would throw on submit.  The
		// "+" button on the (now-removed) Rooms tile no longer
		// exists, so this path should be unreachable from the UI;
		// treat it as a belt-and-suspenders no-op.
		if (state.activeSpace?.kind !== "space") {
			console.warn("openCreateRoomGated: no active space; refusing to open CreateRoomSheet");
			return;
		}
		// No publish-quota check — Discord doesn't limit channel
		// creation, and under the invariant every room is contained
		// inside the space's privacy boundary, so there's no risk of
		// flooding Explore.  Suspended-account blocks still happen
		// server-side via the engine's can-publish-room hook.
		setCreateRoomOpen(true);
	}, [state.activeSpace]);

	// Centralised invite-accept with NSFW gate.  Three paths:
	//   1. Room/space is flagged NSFW + user hasn't opted in →
	//      surface NsfwAcceptDialog ("invite" mode), defer the join
	//      until the user confirms.  Confirming flips the pref and
	//      runs the join.
	//   2. Subject isn't NSFW or user already opted in → run
	//      acceptInvite immediately.  If it was a space invite and
	//      joinSpaceWithChildren skipped any NSFW children, surface
	//      the dialog in "space-children" mode so the user can
	//      decide to enable + auto-join the rest.
	//   3. Anything else → just join.
	//
	// All RoomList / ChatPane invite buttons funnel through here so
	// the gate is unbypassable from the UI.
	const acceptInviteWithGate = useCallback(async (roomId: RoomId): Promise<RoomId | null> => {
		if (!transport) return null;
		const info = transport.getInviteInfo(roomId);
		const room = state.rooms.find(r => r.id === roomId);
		const subjectName = room?.name ?? "this room";
		const nsfwPref = !!settings.showNsfw;
		// Path 1: pre-accept gate.
		if (info?.isNsfw && !nsfwPref) {
			setNsfwGate({
				mode: "invite",
				roomId,
				subjectName,
				isSpace: !!info.isSpace,
				onConfirm: async () => {
					try {
						await transport.setNsfwPreference(true);
						const result = await transport.acceptInvite(roomId);
						dispatch({ type: "set_active_room", roomId });
						// If the invite was for a space whose children
						// include MORE NSFW rooms, joinSpaceWithChildren
						// would have skipped them — but since we just
						// flipped the pref, they should auto-join via the
						// live m.space.child listener as state propagates.
						// No follow-up dialog needed here.
						void result;
					} catch (e) {
						dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
					}
				},
			});
			return null;
		}
		// Path 2: normal accept, but watch for skipped NSFW children
		// when it was a space invite.
		try {
			const result = await transport.acceptInvite(roomId);
			if (result.isSpace && result.skippedNsfwChildren > 0 && !nsfwPref) {
				setNsfwGate({
					mode: "space-children",
					roomId,
					subjectName,
					isSpace: true,
					skippedNsfwCount: result.skippedNsfwChildren,
				});
			}
			return roomId;
		} catch (e) {
			dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
			return null;
		}
	}, [transport, state.rooms, settings.showNsfw]);

	/** Sign out of the currently-active account.
	 *
	 * Three-step:
	 *   1. Fire-and-forget the Synapse-side logout (drop the device
	 *      so the next sign-in doesn't accumulate a stale device row;
	 *      see the long comment below for why that matters for E2EE).
	 *   2. Splice the active row out of the local accounts array.
	 *   3. Fall forward to the next account when one exists, else
	 *      drop activeUserId to null which routes back to the login
	 *      screen.
	 *
	 * The cred-watching effect below sees `creds` change and tears
	 * the live transport down — including the IDB drain in
	 * transport.stop() — before bringing up the next account's
	 * transport.  Whichever account we land on, the user gets a
	 * clean sync from there.
	 */
	/** Sign out of any single account by user_id.
	 *
	 * When `userId` is the current active account, this delegates to
	 * the full handleSignOut path (which falls forward to the next
	 * account or to the login screen).
	 *
	 * When `userId` is an inactive stored account, we splice it out
	 * of the array WITHOUT touching the live transport — the user
	 * stays signed in as whoever they were.  We do still attempt a
	 * server-side logout for the dropped account using its stored
	 * access token, fire-and-forget, so the device row on Synapse
	 * gets cleaned up.
	 */
	function handleSignOutOfAccount(userId: string) {
		if (userId === activeUserId) {
			handleSignOut();
			return;
		}
		const dropped = accounts.find(a => a.user_id === userId);
		if (!dropped) return;
		// Best-effort server-side logout for the stored token.  Direct
		// fetch (bypassing matrix-js-sdk) so we don't have to spin up a
		// second client just to call /logout — this account isn't live.
		void (async () => {
			try {
				await fetch(`${dropped.homeserver}/_matrix/client/v3/logout`, {
					method: "POST",
					headers: { Authorization: `Bearer ${dropped.access_token}` },
				});
			} catch (err) {
				console.warn(`signOutOfAccount: server-side logout for ${userId} failed`, err);
			}
		})();
		const nextAccounts = removeAccount(accounts, userId);
		setAccounts(nextAccounts);
		saveAccounts(nextAccounts);
	}

	function handleSignOut() {
		// Server-side logout for the leaving account.  Invalidates the
		// access token AND deactivates the device on Synapse — without
		// it, every sign-out + sign-in cycle creates a new Matrix
		// device while leaving the old one alive, so a single user
		// accumulates 8+ active devices over a few sessions.
		// Encrypted messages get re-encrypted to every active device
		// the sender's client can see — when one of those devices is
		// a stale ghost without local megolm session keys, decryption
		// fails server-side ("key backup is not working") because the
		// message was encrypted to a key the live device never had.
		// Fire-and-forget; the rest of the teardown runs synchronously
		// so the UI flips immediately.
		const t = transport;
		if (t) {
			void t.logout().catch(err => {
				console.warn("handleSignOut: server-side logout failed", err);
			});
		}
		const leaving = activeUserId;
		const nextAccounts = leaving ? removeAccount(accounts, leaving) : accounts;
		const nextActive = leaving ? pickNextActive(accounts, leaving) : null;
		setAccounts(nextAccounts);
		saveAccounts(nextAccounts);
		setActiveUserIdState(nextActive);
		saveActiveUserId(nextActive);
		setEncState(null);
		dispatch({ type: "set_active_room", roomId: null });
		// IDB wipe is now handled inside transport.stop() (which the
		// cred-watching effect awaits before starting the next
		// transport), so we don't need a separate fire-and-forget
		// wipe here.  When `nextActive` is null the transport tears
		// down to nothing and the wipe still happens — start() of
		// the next user (whenever it arrives) sees clean state.
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
		// Mobile-only "Spaces" tab landing — no synthetic Space
		// object; the MobileSpacesList renders its own UI.
		if (state.activeSpace.kind === "spaces_overview") return null;
		if (state.activeSpace.kind === "dms") {
			return {
				id: "__dms__",
				name: "Direct messages",
				topic: "Your one-on-one conversations.",
				avatarUrl: undefined,
				kind: "private" as const,
				childRoomIds: [],
				pinnedRoomIds: [],
				nsfw: false,
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
		if (state.activeSpace.kind === "spaces_overview") return [];
		const id = state.activeSpace.id;
		return state.rooms.filter(r => r.parentSpaceIds.includes(id));
	}, [state.activeSpace, state.rooms]);
	const landingVariant: "real" | "dms" =
		state.activeSpace?.kind === "dms" ? "dms"
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

	// Hard mobile block.  When the viewport / pointer detection in
	// lib/mobile.ts reports a mobile context AND we're not running
	// inside the Tauri desktop shell (which can be resized small but
	// IS still the desktop app), render a takeover that points users
	// to the desktop installer.  Mobile UX is in development; better
	// to be honest than ship a half-broken first impression.
	const isTauriDesktop = typeof window !== "undefined"
		&& (window as { __KOVEN_DESKTOP__?: boolean }).__KOVEN_DESKTOP__ === true;
	if (isMobileShell && !isTauriDesktop) {
		return <MobileBlockScreen />;
	}

	if (!creds) {
		return <Login onLoggedIn={handleLogin} />;
	}
	// Add-account mode: an existing user clicked "Add account" in the
	// switcher.  We render the same Login form on top of the live app
	// without tearing down the existing transport — handleLogin
	// appends + flips the active id, which triggers the cred-watching
	// effect to swap transports cleanly.  An "← cancel" button lets
	// the user back out without a new login.
	if (addAccountMode) {
		return (
			<Login
				onLoggedIn={handleLogin}
				addingAccount
				onCancelAddAccount={() => setAddAccountMode(false)}
			/>
		);
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
			{/* Hidden audio sinks for every joined remote participant.
			    Lives at the App level so audio survives navigation
			    (the participant tiles unmount when you leave the
			    call's room; this keeps the WebRTC pipeline alive).
			    The gate component reads the call context internally
			    so App doesn't have to plumb call state down. */}
			<CallAudioSinkGate />
			{/* Draggable picture-in-picture panel.  Floats in the
			    corner of the viewport when the user has navigated
			    away from the call's room, showing whichever
			    participant is spotlit (or self).  Click to jump
			    back; drag to reposition; mute / leave from a hover
			    overlay.  Self-hides when there's no joined call or
			    the user is currently viewing the call room. */}
			<CallPipPanel
				currentRoomId={state.activeRoomId}
				onJumpToCallRoom={(roomId) => dispatch({ type: "set_active_room", roomId })}
			/>
			{/* Listens for incoming DM call rings across every joined
			    DM the user is in.  Surfaces an Accept / Decline
			    sheet centered in the viewport.  Auto-dismisses on
			    cancel or after 30s. */}
			<IncomingRingListener
				transport={transport}
				rooms={state.rooms}
				currentUserId={creds?.user_id as UserId | null}
				accessToken={creds?.access_token ?? null}
				// Navigate to the DM room WITHOUT going through
				// navigateToRoom (which flips inCallView=false).
				// We just answered a call — keep inCallView=true
				// so the chat pane renders the pre-join / call
				// surface, not the chat view.
				onAcceptedNavigate={(roomId) => {
					dispatch({ type: "set_active_room", roomId });
				}}
			/>
			{/* Listens for the recipient's chat.koven.call.decline
			    when WE'RE the caller and shows a toast.  Also tears
			    down the empty 1:1 meeting on decline so the caller
			    doesn't hang around alone. */}
			<CallToastListener transport={transport} />
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
			{/* Mobile-only top bar.  Single-column shell can't show
			    list + chat side-by-side, so we provide explicit
			    back navigation:
			      - in a room    → back to the space's room list
			      - in a space   → back to DMs (the mobile "home")
			      - at DMs       → no back, this is the root
			    Desktop relies on the multi-pane layout where "back"
			    is implicit (click another room or close the panel).
			    The bar itself is just brand chrome — per-view title
			    + actions live in each panel's own header below. */}
			{isMobileShell && (
				<MobileTopBar
					onBack={
						state.activeRoomId
							? () => dispatch({ type: "set_active_room", roomId: null })
							: undefined
					}
					rightSlot={
						<NotificationBell
							notifications={notifications}
							onOpenRoom={openRoomFromNotification}
							resolveDisplayName={(userId) => {
								// Best-effort: scan rooms for a member
								// row matching the MXID and pick its
								// display name.  Cheap (member arrays are
								// small) and avoids hitting the transport
								// for a /profile call we'd then have to
								// cache.  Falls through to localpart in
								// the bell when nothing matches.
								if (!transport) return null;
								for (const r of state.rooms) {
									const members = transport.getRoomMembers(r.id) ?? [];
									const m = members.find(mb => mb.userId === userId);
									if (m?.displayName) return m.displayName;
								}
								return null;
							}}
							resolveRoomName={(roomId) =>
								state.rooms.find(r => r.id === roomId)?.name ?? null
							}
							accessToken={creds.access_token}
						/>
					}
				/>
			)}
			<div
				className="flex-1 flex min-h-0"
				data-mobile-view={state.activeRoomId ? "chat" : "rooms"}
			>
				<div className="contents" data-mobile-pane="sidebar">
				<SpaceBar
					currentUserId={creds.user_id}
					currentUserAvatarMxc={myAvatarMxc}
					spaces={state.spaces}
					rooms={state.rooms}
					activeSpace={state.activeSpace}
					onSelectExplore={() => dispatch({ type: "set_active_space", space: { kind: "explore" } })}
					onSelectDms={() => dispatch({ type: "set_active_space", space: { kind: "dms" } })}
					onSelectBots={() => dispatch({ type: "set_active_space", space: { kind: "bots" } })}
					onSelectSpace={(id: SpaceId) => dispatch({ type: "set_active_space", space: { kind: "space", id } })}
					onOpenCreateSpace={() => {
						// No publish-quota check — Discord doesn't limit
						// server / channel creation, and rate-limit tiers
						// just confused users who'd hit "1/day" silently.
						// Suspended-account blocks still happen server-
						// side via the engine's can-publish-room hook.
						setCreateSpaceOpen(true);
					}}
					onOpenProfile={() => setViewedUserId(creds.user_id as UserId)}
					onOpenSettings={() => setSettingsOpen(true)}
					accounts={accounts}
					onSwitchAccount={switchAccount}
					onAddAccount={() => setAddAccountMode(true)}
					onSignOutAccount={handleSignOutOfAccount}
					onOpenReview={isAdmin ? () => setReviewSheetOpen(true) : undefined}
					pendingReviewCount={pendingReviewCount}
					transport={transport}
					accessToken={creds.access_token}
					onEditSpace={(id) => setEditingSpaceId(id)}
					onAddRoomToSpace={(id) => {
						dispatch({ type: "set_active_space", space: { kind: "space", id } });
						void openCreateRoomGated();
					}}
					onAddExistingRoomToSpace={(id) => setAddExistingRoomTo(id)}
					onLeaveSpace={(id) => {
						transport?.leaveRoom(id).catch(err => {
							dispatch({ type: "error", message: err instanceof Error ? err.message : String(err) });
						});
					}}
					onDeleteSpace={(id) => {
						// "Delete" semantics: same as leave for now —
						// proper space tombstoning is a Synapse-admin
						// path that requires extra plumbing.  Founder-
						// only via the right-click gate.
						transport?.leaveRoom(id).catch(err => {
							dispatch({ type: "error", message: err instanceof Error ? err.message : String(err) });
						});
					}}
				/>
				</div>
				{state.activeSpace?.kind === "bots" ? (
					<div className="contents" data-mobile-pane="list">
					<BotList
						bots={myBots}
						loading={myBotsLoading}
						error={myBotsError}
						selectedBotId={selectedBotId}
						atLimit={(myBots ?? []).length >= 30}
						onSelectBot={id => setSelectedBotId(id)}
						onNewBot={() => setSelectedBotId("new")}
						onSendDmToBot={async (mxid) => {
							if (!transport) return;
							try {
								const roomId = await transport.startDm(mxid as UserId);
								dispatch({ type: "set_active_space", space: { kind: "dms" } });
								dispatch({ type: "set_active_room", roomId });
							} catch (e) {
								dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
							}
						}}
						onViewBotProfile={(mxid) => setViewedUserId(mxid as UserId)}
					/>
					</div>
				) : null}
				{state.activeSpace?.kind === "spaces_overview" ? (
					<div className="contents" data-mobile-pane="list">
						<MobileSpacesList
							spaces={state.spaces}
							rooms={state.rooms}
							onSelectSpace={(id) =>
								dispatch({ type: "set_active_space", space: { kind: "space", id: id as SpaceId } })
							}
							onSelectExplore={() =>
								dispatch({ type: "set_active_space", space: { kind: "explore" } })
							}
						/>
					</div>
				) : null}
				{/* Explore on mobile.  The main pane is hidden in
				    mobile-view="rooms" (no active room) so we render
				    ExplorePane into the list pane instead — same
				    pattern Bots / Spaces Overview use above. */}
				{isMobileShell && state.activeSpace?.kind === "explore" ? (
					<div className="contents" data-mobile-pane="list">
						<ExplorePane
							transport={transport}
							rooms={state.rooms}
							spaces={state.spaces}
							accessToken={creds?.access_token ?? null}
							collapsedRoomIds={collapsedRoomIds}
							onCollapseRefresh={refreshCollapsedRooms}
							showNsfw={!!settings.showNsfw}
							onJoined={(roomId, isSpace) => {
								if (isSpace) {
									dispatch({ type: "set_active_space", space: { kind: "space", id: roomId } });
								} else {
									dispatch({ type: "set_active_room", roomId });
								}
							}}
						/>
					</div>
				) : null}
				{state.activeSpace?.kind !== "explore"
					&& state.activeSpace?.kind !== "bots"
					&& state.activeSpace?.kind !== "spaces_overview" && (
				<div className="contents" data-mobile-pane="list">
				<RoomList
					rooms={state.rooms}
					spaces={state.spaces}
					activeSpace={state.activeSpace}
					// When the call view is on top, unhighlight the
					// underlying room in the sidebar so it reads as
					// "no chat selected" — the affordance to the user
					// that clicking the room name takes them to chat
					// (not back into the call).  The PIP / call
					// surface remain the way back into the call view.
					activeRoomId={isViewingActiveCallRoom ? null : state.activeRoomId}
					currentUserId={creds.user_id}
					transport={transport}
					accessToken={creds.access_token}
					onEditRoom={(roomId) => setEditingRoomId(roomId)}
					onOpenProfile={(userId) => setViewedUserId(userId)}
					collapsedRoomIds={collapsedRoomIds}
					botMxids={botMxids}
					// True once initial sync has reached the "syncing"
					// or "ready" state — at that point matrix-js-sdk
					// has populated `state.rooms` with whatever the
					// user has, and an empty list is genuinely empty.
					// While "preparing" we leave the empty hint
					// suppressed so the sidebar paints clean during
					// boot.
					roomsLoaded={state.syncState === "syncing" || state.syncState === "ready"}
					onSelectRoom={navigateToRoom}
					onCreateRoom={async () => {
						// "+" in the list header is context-aware: DMs
						// opens the start-a-DM dialog, every other view
						// opens the create-room dialog (gated by the
						// publish-quota precheck — see openCreateRoom).
						if (state.activeSpace?.kind === "dms") {
							setStartDmOpen(true);
							return;
						}
						await openCreateRoomGated();
					}}
					onAcceptInvite={async (roomId) => {
						const accepted = await acceptInviteWithGate(roomId);
						if (accepted) dispatch({ type: "set_active_room", roomId: accepted });
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
				</div>
				)}
				<div className="contents" data-mobile-pane="main">
				{state.activeSpace?.kind === "explore" ? (
					<ExplorePane
						transport={transport}
						rooms={state.rooms}
						spaces={state.spaces}
						accessToken={creds?.access_token ?? null}
						collapsedRoomIds={collapsedRoomIds}
						onCollapseRefresh={refreshCollapsedRooms}
						showNsfw={!!settings.showNsfw}
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
						onAddRoom={() => { void openCreateRoomGated(); }}
						onAddExistingRoom={
							landingVariant === "real"
								? () => setAddExistingRoomTo(activeSpaceObj.id as SpaceId)
								: undefined
						}
						onInvite={() => {
							if (state.activeSpace?.kind === "space") setInvitingRoomId(state.activeSpace.id as unknown as RoomId);
						}}
						onOpenSettings={() => {
							if (state.activeSpace?.kind === "space") setEditingSpaceId(state.activeSpace.id);
						}}
						onStartDm={() => setStartDmOpen(true)}
						onSelectRoom={navigateToRoom}
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
						if (!creds?.access_token || !state.activeRoomId) {
							throw new Error("Not connected");
						}
						// Let errors bubble up to MessageActions's DeleteAction
						// dialog — it shows them inline next to the buttons
						// so the user can see exactly why the redaction
						// failed (403 "not your bot", 404 "event gone",
						// 502 redaction-side failure, network drop).
						// Synapse emits the successful redaction back
						// through sync, matrix-js-sdk applies it, and the
						// row re-renders as a redacted stub on the next
						// reducer pass — no manual state update needed.
						await deleteOwnMessage(
							creds.access_token,
							state.activeRoomId,
							eventId,
						);
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
					receiptsVersion={state.activeRoomId ? state.receiptsVersionByRoom.get(state.activeRoomId) ?? 0 : 0}
					viewerUserId={creds.user_id}
					onLoadMoreHistory={async (roomId) => {
						if (!transport) return false;
						const got = await transport.loadMoreHistory(roomId, 50);
						if (got) {
							// Re-emit the (now-longer) message list so the
							// timeline picks up the prepended events.  Same
							// path as the initial messages_loaded; idempotent
							// because the reducer overwrites the room's
							// messages array wholesale.
							dispatch({
								type: "messages_loaded",
								roomId,
								messages: transport.getRoomMessages(roomId),
							});
						}
						return got;
					}}
					onSendMessage={(text, replyTo) => {
						if (!state.activeRoomId || !transport) return;
						const send = replyTo
							? transport.replyTo(state.activeRoomId, replyTo, text)
							: transport.sendText(state.activeRoomId, text);
						send.catch(e => dispatch({ type: "error", message: e.message }));
					}}
					onSendAttachment={async (file, _replyTo, caption) => {
						if (!state.activeRoomId || !transport) return;
						try {
							// caption is the text the user typed alongside
							// the attachment in the composer.  When set,
							// uploadAndSendAttachment writes it MSC2530-
							// style (body=caption, filename=file.name) so
							// the renderer can show it underneath the
							// media bubble on every connected client.
							await transport.uploadAndSendAttachment(
								state.activeRoomId,
								file,
								caption ?? undefined,
							);
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
						await acceptInviteWithGate(roomId as RoomId);
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
					// onPlaceCall + callInProgress props retired
					// alongside the MatrixCall flow — DM calls now
					// go through RoomVoiceBar's Join button + the
					// CallProvider system, same as group rooms.
					isSuspended={!!suspension}
					onOpenModLog={(roomId) => setModLogRoomId(roomId as RoomId)}
					onOpenProfile={(userId) => setViewedUserId(userId as UserId)}
					// Right-click message context menu: Send DM and
					// Block.  startDm covers "open existing or create
					// fresh DM" semantics; ignoreUser writes the
					// m.ignored_user_list account_data.
					onSendDm={async (userId) => {
						if (!transport) return;
						try {
							const roomId = await transport.startDm(userId);
							dispatch({ type: "set_active_space", space: { kind: "dms" } });
							dispatch({ type: "set_active_room", roomId });
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
						}
					}}
					onBlockSender={async (userId) => {
						if (!transport) return;
						try {
							await transport.ignoreUser(userId);
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
						}
					}}
					accessToken={creds.access_token}
					giphyEnabled={giphyEnabled}
					pollsByMessage={state.pollsByMessage}
					onCreatePoll={async (opts) => {
						if (!transport || !state.activeRoomId) return;
						try {
							// `opts` already carries `endsAt` when the user
							// picked a finite duration in the dialog; sendPoll
							// reads it directly into the start event.
							await transport.sendPoll(state.activeRoomId, opts);
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
							throw e;
						}
					}}
					onVoteOnPoll={async (pollId, answerIds) => {
						if (!transport || !state.activeRoomId) return;
						try {
							await transport.voteOnPoll(state.activeRoomId, pollId, answerIds);
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
						}
					}}
					onEndPoll={async (pollId) => {
						if (!transport || !state.activeRoomId) return;
						try {
							await transport.endPoll(state.activeRoomId, pollId);
						} catch (e) {
							dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
						}
					}}
				/>
				)}
				</div>
				<div className="contents" data-mobile-pane="aux">
				{activeRoom && !isViewingActiveCallRoom && (
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
							// Hide the appservice's @engine bot from the
							// member list.  It joins every room with
							// activity so it can write moderation events
							// (collapses, censures), but it's a platform
							// identity not a participant — surfacing it
							// next to humans is confusing and clutters
							// the count.  The mxid pattern is
							// `@engine:<homeserver>` (per the appservice
							// yaml's sender_localpart) so we derive it
							// from the user's own mxid suffix.
							hiddenUserIds={(() => {
								const me = creds.user_id;
								const colon = me.indexOf(":");
								if (colon <= 0) return undefined;
								return new Set([`@engine${me.slice(colon)}`]);
							})()}
							// Right-click member menu.  Surfaces View
							// profile / Send DM / Copy user ID for
							// everyone, plus founder-only Kick / Ban
							// for bot rows.
							canKickBanBots={!!(activeRoom?.creatorId && creds.user_id && activeRoom.creatorId === creds.user_id)}
							onBotKickBan={async (action, botMxid) => {
								if (!creds?.access_token || !state.activeRoomId) return;
								try {
									await botKickBan(
										creds.access_token,
										state.activeRoomId,
										botMxid as UserId,
										action,
									);
								} catch (e) {
									dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
									throw e;
								}
							}}
							onStartDm={async (userId) => {
								if (!transport) return;
								try {
									const roomId = await transport.startDm(userId as UserId);
									dispatch({ type: "set_active_space", space: { kind: "dms" } });
									dispatch({ type: "set_active_room", roomId });
								} catch (e) {
									dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
								}
							}}
							// Banner avatar above the members list — only
							// when the room has a real uploaded image and
							// no emoji icon override (emojis already win
							// in MatrixAvatar's fallback chain and show
							// in the chat header, no need to repeat).
							roomAvatarUrl={
								activeRoom && !activeRoom.iconEmoji && activeRoom.avatarUrl
									? activeRoom.avatarUrl
									: undefined
							}
							roomId={activeRoom?.id}
							roomName={activeRoom?.name}
						/>
					)
				)}
				</div>
			</div>
			{/* Mobile bottom tab bar + Me overlay.  The Me screen
			    is rendered as an absolute-positioned overlay above
			    the panels (rather than a sheet) so the bottom tab
			    bar stays visible while it's open — same pattern
			    iMessage / Telegram use for their "Me" / Settings
			    tab.  Z-index just above the FAB so it covers the
			    chat composer too. */}
			{isMobileShell && mobileMeOpen && (
				// The Me overlay sits above the underlying pane (z-30),
				// so it MUST paint a solid bg or the chat list bleeds
				// through behind the rows.  Repaint the body's gradient
				// on top of bg-background so this overlay has the same
				// coloured aura every other mobile screen has.
				<div className="fixed inset-x-0 z-30 flex flex-col bg-background"
				     style={{
				         top: "calc(env(safe-area-inset-top) + 48px)",
				         bottom: "calc(env(safe-area-inset-bottom) + 56px)",
				         backgroundImage: "var(--bg-gradient)",
				         backgroundAttachment: "fixed",
				         backgroundRepeat: "no-repeat",
				         backgroundSize: "cover",
				     }}
				>
					<MobileMeScreen
						userId={creds.user_id}
						avatarMxc={myAvatarMxc}
						onOpenProfile={() => setViewedUserId(creds.user_id as UserId)}
						onOpenSettings={() => setSettingsOpen(true)}
						onSignOut={handleSignOut}
					/>
				</div>
			)}
			{/* Hide the tab bar in a chat — chats are "push" views
			    that take over the screen until the user pops back
			    via the top-bar arrow.  iMessage / Telegram / Slack
			    all do this; persistent tabs over a chat read as
			    cluttered. */}
			{isMobileShell && !state.activeRoomId && (
				<MobileTabBar
					active={
						mobileMeOpen
							? "me"
							: state.activeSpace?.kind === "explore"
								? "explore"
								: state.activeSpace?.kind === "space"
									|| state.activeSpace?.kind === "spaces_overview"
									? "spaces"
									: "chats"
					}
					onChange={(tab: MobileTab) => {
						// Switching tabs always clears the Me overlay
						// + drops any open chat so the user sees the
						// tab's landing screen on first tap.
						setMobileMeOpen(tab === "me");
						if (tab === "me") return;
						dispatch({ type: "set_active_room", roomId: null });
						if (tab === "chats") {
							dispatch({ type: "set_active_space", space: { kind: "dms" } });
						} else if (tab === "spaces") {
							// Stay in the current space if we already
							// have one selected — only drop into the
							// overview when the tab is "fresh".
							if (state.activeSpace?.kind !== "space") {
								dispatch({ type: "set_active_space", space: { kind: "spaces_overview" } });
							}
						} else if (tab === "explore") {
							dispatch({ type: "set_active_space", space: { kind: "explore" } });
						}
					}}
					unreadByTab={{
						chats: state.rooms.filter(
							r => r.kind === "dm" && !r.isInvite && r.unreadCount > 0,
						).length,
						spaces: state.rooms.filter(
							r => r.parentSpaceIds.length > 0
								&& !r.isInvite
								&& r.unreadCount > 0,
						).length,
					}}
				/>
			)}
			{/* Desktop notification bell — fixed-position FAB in
			    the bottom-right corner.  Only renders outside the
			    mobile shell (mobile already has its own bell in
			    the MobileTopBar's right slot, plus a FAB would
			    visually compete with the floating tab pill).
			    Same NotificationBell component, different visual
			    treatment via the `variant` prop. */}
			{!isMobileShell && (
				<NotificationBell
					variant="fab"
					notifications={notifications}
					onOpenRoom={openRoomFromNotification}
					resolveDisplayName={(userId) => {
						if (!transport) return null;
						for (const r of state.rooms) {
							const members = transport.getRoomMembers(r.id) ?? [];
							const m = members.find(mb => mb.userId === userId);
							if (m?.displayName) return m.displayName;
						}
						return null;
					}}
					resolveRoomName={(roomId) =>
						state.rooms.find(r => r.id === roomId)?.name ?? null
					}
					accessToken={creds.access_token}
				/>
			)}
			<CreateRoomSheet
				open={createRoomOpen}
				onOpenChange={setCreateRoomOpen}
				parentSpaceName={(() => {
					const a = state.activeSpace;
					if (!a || a.kind !== "space") return "this space";
					return state.spaces.find(s => s.id === a.id)?.name ?? "this space";
				})()}
				parentSpaceKind={(() => {
					const a = state.activeSpace;
					if (!a || a.kind !== "space") return "private";
					return state.spaces.find(s => s.id === a.id)?.kind ?? "private";
				})()}
				parentSpaceE2eeRequired={(() => {
					const a = state.activeSpace;
					if (!a || a.kind !== "space") return false;
					return state.spaces.find(s => s.id === a.id)?.e2eeRequired === true;
				})()}
				onCreate={async (opts) => {
					if (!transport) throw new Error("Not connected");
					// Discord-style invariant: room MUST belong to a
					// space.  openCreateRoomGated refuses to open the
					// sheet without a space context, so this is the
					// belt-and-suspenders gate at submit time.
					if (state.activeSpace?.kind !== "space") {
						throw new Error("Pick a space first — rooms live inside spaces.");
					}
					const parentSpaceId = state.activeSpace.id;
					const roomId = await transport.createRoom({ ...opts, parentSpaceId });
					dispatch({ type: "set_active_room", roomId });
				}}
			/>
			<CreateSpaceSheet
				open={createSpaceOpen}
				onOpenChange={setCreateSpaceOpen}
				showNsfw={!!settings.showNsfw}
				onCreate={async (opts) => {
					if (!transport) throw new Error("Not connected");
					const spaceId = await transport.createSpace(opts);
					dispatch({ type: "set_active_space", space: { kind: "space", id: spaceId } });
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
				showNsfw={!!settings.showNsfw}
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
						nsfw: opts.nsfw,
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
					dispatch({ type: "set_active_space", space: { kind: "spaces_overview" } });
				}}
				onDelete={async (spaceId, childIds) => {
					if (!transport) throw new Error("Not connected");
					await transport.deleteSpace(spaceId as RoomId, childIds as RoomId[]);
					setEditingSpaceId(null);
					dispatch({ type: "set_active_space", space: { kind: "spaces_overview" } });
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
						liveEnabled: opts.liveEnabled,
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
				onViewProfile={(userId) => {
					// Pivot the sheet from the bot to its creator.
					// Single-state-update: setViewedUserId triggers the
					// sheet's own re-fetch effect.  No close/reopen
					// flicker because the dialog stays mounted; only the
					// body re-paints.
					setViewedUserId(userId);
				}}
			/>
			<AppSettingsSheet
				open={settingsOpen}
				onOpenChange={setSettingsOpen}
				settings={settings}
				onSettingsChange={(next) => {
					// Apply locally first for instant UI feedback;
					// account_data round-trip happens in the
					// background.  When the server echoes the change
					// back through /sync, our subscriber re-applies
					// it (idempotent — same value, no-op).
					setSettings(next);
					// Cross-device sync: only the showNsfw field is
					// account_data-backed today.  Theme stays
					// per-device (localStorage); flipping the theme
					// on a phone shouldn't change your laptop's look.
					if (transport && next.showNsfw !== settings.showNsfw) {
						transport.setNsfwPreference(!!next.showNsfw).catch(err => {
							console.warn("App: setNsfwPreference failed", err);
						});
					}
				}}
				accessToken={creds.access_token}
				transport={transport}
				currentUserId={creds.user_id}
				ignoredUsers={ignoredUsers}
				onSignedOut={handleSignOut}
			/>
			<NsfwAcceptDialog
				open={!!nsfwGate}
				onOpenChange={(o) => { if (!o) setNsfwGate(null); }}
				mode={nsfwGate?.mode ?? "invite"}
				subjectName={nsfwGate?.subjectName ?? ""}
				isSpace={nsfwGate?.isSpace}
				skippedNsfwCount={nsfwGate?.skippedNsfwCount}
				onConfirm={async () => {
					if (!nsfwGate) return;
					if (nsfwGate.mode === "invite" && nsfwGate.onConfirm) {
						// "invite" mode: the join was deferred — flip
						// the pref + run the deferred join.  The
						// onConfirm closure captured by the gate already
						// sequences setNsfwPreference + acceptInvite +
						// dispatch in the right order.
						await nsfwGate.onConfirm();
					} else {
						// "space-children" mode: already joined the
						// parent space.  Flip the pref and re-run
						// joinSpaceWithChildren — it's idempotent for
						// already-joined children, and the second pass
						// (with the pref now on) picks up the NSFW
						// children that the first pass skipped.
						if (transport) {
							try {
								await transport.setNsfwPreference(true);
								await transport.joinSpaceWithChildren(nsfwGate.roomId);
							} catch (e) {
								dispatch({ type: "error", message: e instanceof Error ? e.message : String(e) });
							}
						}
					}
				}}
			/>
			<AddExistingRoomDialog
				open={!!addExistingRoomTo}
				onOpenChange={(o) => { if (!o) setAddExistingRoomTo(null); }}
				space={
					addExistingRoomTo
						? state.spaces.find(s => s.id === addExistingRoomTo) ?? null
						: null
				}
				rooms={state.rooms}
				otherSpaces={state.spaces}
				currentUserId={creds.user_id}
				onAdd={async (roomId) => {
					if (!transport || !addExistingRoomTo) return;
					// Pass through the room's NSFW flag so the parent's
					// m.space.child content carries it — that's the bit
					// joinSpaceWithChildren / the live cascade listener
					// reads to decide whether to auto-join the child for
					// users who haven't opted into NSFW.
					const room = state.rooms.find(r => r.id === roomId);
					await transport.linkRoomToSpace(addExistingRoomTo, roomId, { nsfw: !!room?.nsfw });
				}}
			/>
			{/* Old MatrixCall-based IncomingCallSheet + ActiveCallView
			    removed.  Replaced by IncomingRingListener (mounted
			    above) + the inline call view inside ChatPane + the
			    floating PIP — all driven by the RealtimeKit-backed
			    CallProvider system. */}
			{modLogRoomId && (
				<ModLogSheet
					open
					onOpenChange={(o) => { if (!o) setModLogRoomId(null); }}
					roomId={modLogRoomId}
					transport={transport}
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

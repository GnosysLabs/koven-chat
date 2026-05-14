// Koven desktop shell.
//
// Loads the bundled SPA (`client/dist/`) into a system WebView, talks
// to the live homeserver at `client.koven.chat` for all Matrix +
// engine API calls, and routes every external link out to the user's
// real browser.  The shell is intentionally thin — anything that can
// live in the web client lives in the web client; this binary adds
// only what *requires* native context (window chrome, OS link
// dispatch, native notifications, single-instance focus, signed
// auto-update).

use tauri::{Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri::webview::DownloadEvent;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};

// Per-OS native chrome plugins.
//
// `mac_rounded_corners` (cloudworxx/tauri-plugin-mac-rounded-corners,
// copied into ./plugins/ by the npm postinstall hook): rounds the
// NSWindow's contentView layer + hides the OS traffic lights so the
// SPA can render its own at pixel-perfect coordinates.
//
// `windows_rounded_corners`: one DWM call to opt the chromeless
// Windows main window into Win11's rounded-corner treatment.  No-op
// on Win10.
mod plugins;
#[cfg(target_os = "linux")]
use plugins::linux_desktop_integration;
#[cfg(target_os = "macos")]
use plugins::mac_rounded_corners;
#[cfg(target_os = "windows")]
use plugins::windows_rounded_corners;

/// Close the floating splash window + reveal the (already styled)
/// main window.  Invoked from the SPA's main.tsx after the
/// rounded-corner setup has run AND React has finished its first
/// render — by that point the main window is fully chromed and
/// painting the real UI, so swapping the splash for it is a single
/// invisible transition rather than the white-flash → square-dark
/// → rounded-dark sequence we saw with an in-window splash.
/// Save the given `bytes` to a user-picked location.
///
/// Pops the OS native save-as dialog, defaulting the filename to
/// `filename` and the directory to ~/Downloads/.  If the user picks
/// a path, write the bytes and return the absolute destination as a
/// string.  If the user cancels, return Ok(None) so the JS side can
/// distinguish cancellation from real errors.
///
/// Why this exists despite the on_download WebView hook:
///   - WKWebView (macOS) and WebKitGTK (Linux) silently drop anchor
///     downloads pointed at `blob:` URLs — the on_download hook never
///     fires.
///   - data: URL anchor downloads in WKWebView usually navigate the
///     WebView to the data URL instead of triggering a download
///     event, so on_download doesn't fire there either.
///   - WebView2 (Windows) is more permissive but inconsistent across
///     versions.
///
/// The IPC route bypasses the WebView download machinery entirely:
/// the SPA fetches the bytes (which it already has via blob: URL),
/// hands them to Rust, and Rust writes the file with std::fs.  No
/// WebView interpretation, no platform-specific download policy.
///
/// Filename is sanitised against path-traversal attempts (no `..`,
/// no separators) before being used as the dialog's default name —
/// if the user accepts the default, the resulting path stays inside
/// the directory they picked.
#[tauri::command]
async fn save_download(
	app: tauri::AppHandle,
	filename: String,
	bytes: Vec<u8>,
) -> Result<Option<String>, String> {
	use tauri_plugin_dialog::DialogExt;

	// Strip any path components — caller-supplied filename only,
	// never a path.  Also drop empty/dot filenames as a belt-and-
	// braces measure.
	let safe = std::path::Path::new(&filename)
		.file_name()
		.map(|n| n.to_string_lossy().into_owned())
		.unwrap_or_default();
	let safe = if safe.is_empty() || safe == "." || safe == ".." {
		"download".to_string()
	} else {
		safe
	};

	// Default the dialog's starting directory to ~/Downloads/ — best
	// guess at where the user wants downloads to land.  Falls through
	// to the OS default (last-used location, typically) when the
	// PathResolver can't find a Downloads dir.
	let mut builder = app.dialog().file().set_file_name(&safe);
	if let Ok(dl_dir) = app.path().download_dir() {
		builder = builder.set_directory(dl_dir);
	}

	// Native save-as dialog.  The Rust closure-based API is non-
	// blocking; we wrap it in a oneshot channel so the async tauri
	// command can await the user's choice.
	let (tx, rx) = std::sync::mpsc::channel::<Option<std::path::PathBuf>>();
	builder.save_file(move |path| {
		let _ = tx.send(path.and_then(|p| p.into_path().ok()));
	});
	let chosen = rx
		.recv()
		.map_err(|e| format!("dialog channel: {e}"))?;

	let dest = match chosen {
		Some(p) => p,
		None => return Ok(None), // user cancelled
	};

	std::fs::write(&dest, &bytes).map_err(|e| format!("write: {e}"))?;
	log::info!("save_download: wrote {} bytes to {}", bytes.len(), dest.display());
	Ok(Some(dest.to_string_lossy().into_owned()))
}

#[tauri::command]
fn reveal_app(app: tauri::AppHandle) -> Result<(), String> {
	if let Some(splash) = app.get_webview_window("splash") {
		let _ = splash.close();
	}
	if let Some(main) = app.get_webview_window("main") {
		let _ = main.show();
		let _ = main.set_focus();
	}
	Ok(())
}

/// Wipe the WebView's local-data + cache directories, then exit the
/// app.  Surfaced via the SPA's "Couldn't start the client" error
/// screen as a last-resort recovery when IDB itself has gotten into
/// a state the normal sign-out path can't recover from (most
/// commonly: a stuck WebKitGTK storage-process lock from a prior
/// crashed instance — symptom is "DomException UnknownError (0):
/// Unable to establish IDB database file").
///
/// What we wipe:
///   - `app_local_data_dir()`  — WebKitGTK / WKWebView storage on
///     Linux + macOS, WebView2 user-data folder on Windows.  Holds
///     IndexedDB, LocalStorage, cookies, service-worker registrations.
///   - `app_cache_dir()`       — WebView disk cache.  Not strictly
///     needed for the IDB-stuck case but cheap to clear and rules
///     out cache-driven mismatches as a side cause.
///
/// What we DON'T wipe:
///   - `app_config_dir()` — Tauri's own per-app settings (window
///     state, etc.).  Untouched so the user's chrome/decoration
///     prefs survive.
///   - `~/.config/koven-release/` — release credentials, outside
///     this app's dirs anyway.
///
/// Best-effort: `remove_dir_all` is called per-target and errors
/// are collected, not propagated.  A single locked file (e.g. on
/// Windows with WebView2 holding an open SQLite handle to a file
/// inside the dir) won't abort the whole wipe — the rest of the
/// directory still goes, and even a partial wipe is enough to
/// unstick the IDB corruption pattern that motivates this path.
///
/// After the wipe we exit with status 0 on a brief background-
/// thread delay.  Reason for the delay: the IPC reply to the SPA
/// is in flight when we call this and a synchronous `app.exit(0)`
/// races against that flush — the SPA would see a disconnect
/// instead of a clean success.  200 ms is plenty for the response
/// to hit the WebView before we shut down.
///
/// We don't try to relaunch from inside the wipe — Tauri 2's
/// restart API behaves differently across platforms (and isn't a
/// reliable round-trip through WebView teardown on Linux).  The
/// SPA shows a "Koven has been reset — relaunch the app to sign
/// back in" message and the user double-clicks the AppImage / app
/// icon themselves.
#[tauri::command]
fn wipe_local_cache_and_exit(app: tauri::AppHandle) -> Result<(), String> {
	let local_data = app
		.path()
		.app_local_data_dir()
		.map_err(|e| format!("app_local_data_dir: {e}"))?;
	let cache = app
		.path()
		.app_cache_dir()
		.map_err(|e| format!("app_cache_dir: {e}"))?;

	let mut wiped: Vec<String> = Vec::new();
	let mut failed: Vec<String> = Vec::new();

	for dir in [&local_data, &cache] {
		if !dir.exists() {
			continue;
		}
		match std::fs::remove_dir_all(dir) {
			Ok(_) => wiped.push(dir.display().to_string()),
			Err(e) => failed.push(format!("{}: {}", dir.display(), e)),
		}
	}

	log::info!(
		"wipe_local_cache_and_exit: wiped={:?} failed={:?} — exiting",
		wiped,
		failed,
	);

	// Detach the exit on a worker so the IPC reply to the SPA
	// flushes before the process terminates.  See doc comment.
	let handle = app.clone();
	std::thread::spawn(move || {
		std::thread::sleep(std::time::Duration::from_millis(200));
		handle.exit(0);
	});

	Ok(())
}

/// JS injected into every page before the SPA scripts run.  Catches
/// `<a target="_blank">` clicks and `window.open()` calls and routes
/// the URL through the WebView's top-level navigation, where the Rust
/// `on_navigation` handler picks it up and dispatches external links
/// to the OS browser via the opener plugin.
///
/// Why a JS interceptor on top of Rust's `on_navigation`?  WKWebView
/// (macOS) and WebKitGTK (Linux) treat target=_blank / window.open as
/// pop-up requests, not top-level navigations — without a native
/// new-window handler the click is silently dropped and `on_navigation`
/// never fires.  This script rewrites those into top-level navigations
/// so they reach the navigation hook.
///
/// Why not call `window.__TAURI_INTERNALS__.invoke('plugin:opener|...')`
/// directly?  In dev mode and any time we navigate to client.koven.chat,
/// the SPA runs from a remote origin — Tauri 2 doesn't inject the IPC
/// bridge into remote URLs by default (security feature), so the
/// internals object is undefined and `invoke` throws.  Going through
/// `window.location.href` instead keeps everything driven from the
/// trusted Rust side.
///
/// The internal-host list mirrors `is_internal` in Rust; they need to
/// stay in sync if either set of origins changes.
const LINK_INTERCEPTOR_JS: &str = r#"
(function () {
	'use strict';
	function isInternal(rawUrl) {
		try {
			const u = new URL(rawUrl, window.location.href);
			if (u.protocol === 'tauri:') return true;
			if (u.protocol === 'http:' || u.protocol === 'https:') {
				return u.hostname === 'client.koven.chat'
					|| u.hostname === 'tauri.localhost'
					// localhost / 127.0.0.1: the SPA itself when
					// served by tauri-plugin-localhost (production)
					// or by Vite (dev).  Mirrors the same hostname
					// in the Rust `is_internal`.
					|| u.hostname === 'localhost'
					|| u.hostname === '127.0.0.1'
					|| u.hostname === 'challenges.cloudflare.com'
					|| u.hostname === 'www.youtube-nocookie.com'
					|| u.hostname === 'youtube-nocookie.com'
					|| u.hostname === 'www.youtube.com'
					|| u.hostname === 'youtube.com'
					|| u.hostname === 'm.youtube.com';
			}
			return false;
		} catch (_) {
			// Non-URL-parseable href (mailto:, tel:, javascript:, etc.) —
			// fall through and let the navigation hook handle it.
			return false;
		}
	}
	function dispatch(url) {
		// Top-level navigation triggers the Rust on_navigation hook.
		// External URLs get cancelled there and handed to the OS
		// browser; internal URLs proceed normally.
		window.location.href = url;
	}
	document.addEventListener('click', function (e) {
		if (e.defaultPrevented) return;
		if (e.button !== 0) return;
		// Honor modifier-clicks (cmd/ctrl-click) — let the page handle
		// them however it wants; we only intercept plain left-clicks.
		if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		let a = e.target;
		while (a && a !== document && a.tagName !== 'A') {
			a = a.parentNode;
		}
		if (!a || a.tagName !== 'A') return;
		const href = a.getAttribute('href');
		if (!href) return;
		// Same-page anchors (#section) and javascript: voids are
		// strictly in-page; never route them out.
		if (href.startsWith('#') || href.startsWith('javascript:')) return;
		const blank = a.target === '_blank';
		const external = !isInternal(a.href);
		// We only need to step in when the WebView would otherwise
		// drop the click silently — that's any _blank link, plus any
		// link the SPA explicitly marks for external opening.
		if (!blank && !external) return;
		e.preventDefault();
		dispatch(a.href);
	}, true);
	const origOpen = window.open;
	window.open = function (url, target, features) {
		if (typeof url === 'string') {
			dispatch(url);
			return null;
		}
		return origOpen ? origOpen.call(window, url, target, features) : null;
	};
})();
"#;

/// Treat a navigation request as "internal" (stays inside the
/// WebView) iff it lands on one of these origins.  Everything else is
/// dispatched to the user's default browser via the opener plugin.
///
/// - `tauri://localhost`        → bundled SPA on macOS / Linux (WKWebView,
///                                WebKitGTK).  Custom protocol scheme.
/// - `https://tauri.localhost`  → bundled SPA on Windows (WebView2
///                                serves the same assets via the
///                                `https` protocol — no custom-scheme
///                                support).
/// - `https://client.koven.chat` → the live homeserver itself; matters
///                                in dev mode (`devUrl`) and as a
///                                fallback if the SPA hard-navigates.
/// - `https://challenges.cloudflare.com` → Cloudflare Turnstile iframe.
///                                The bot-detection widget on the login
///                                page loads its challenge UI from this
///                                origin; without the allowlist entry,
///                                the iframe load (and any interactive
///                                challenge click inside it) gets
///                                routed out to the OS browser, which
///                                breaks login entirely.
/// - `https://www.youtube-nocookie.com` and `https://www.youtube.com`
///                                → YouTube iframe player.  The chat
///                                renderer embeds youtube-nocookie's
///                                /embed URL when a body contains a
///                                YouTube link; the player itself
///                                pulls related JS / thumbnail assets
///                                from www.youtube.com once the user
///                                hits play.  Without both whitelisted
///                                the iframe never loads (or the play
///                                click opens the video in the system
///                                browser instead of inline).
///
/// Cross-origin XHR / fetch isn't gated by this list; only top-level
/// navigation requests pass through `on_navigation` below.
fn is_internal(url: &Url) -> bool {
	match url.scheme() {
		"tauri" => true,
		"http" | "https" => match url.host_str() {
			Some("client.koven.chat") | Some("tauri.localhost") => true,
			Some("challenges.cloudflare.com") => true,
			Some("www.youtube-nocookie.com") | Some("youtube-nocookie.com") => true,
			Some("www.youtube.com") | Some("youtube.com") | Some("m.youtube.com") => true,
			// localhost / 127.0.0.1 cover both dev (Vite on :1421)
			// AND production (tauri-plugin-localhost on a portpicker-
			// assigned port).  The production move from tauri:// to
			// http://localhost was driven by third-party embed
			// compatibility (see the plugin registration in run());
			// once we're serving from localhost in prod, the
			// navigation handler has to treat localhost as
			// first-party so the SPA doesn't get bounced out to the
			// OS browser on every internal click.
			Some("localhost") | Some("127.0.0.1") => true,
			_ => false,
		},
		_ => false,
	}
}

/// Compile-time platform tag exposed to the SPA via `__KOVEN_PLATFORM__`.
/// Lets the SPA gate platform-specific UI (e.g. the macOS draggable
/// strip that compensates for `TitleBarStyle::Overlay`) without
/// trying to feature-detect or sniff user agents from inside the
/// WebView, both of which have proven unreliable.
#[cfg(target_os = "macos")]
const KOVEN_PLATFORM: &str = "macos";
#[cfg(target_os = "linux")]
const KOVEN_PLATFORM: &str = "linux";
#[cfg(target_os = "windows")]
const KOVEN_PLATFORM: &str = "windows";
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
const KOVEN_PLATFORM: &str = "unknown";

/// Build the init script that runs before the SPA scripts on every
/// page.  Prepends a small prelude that exposes `__KOVEN_DESKTOP__`
/// (always true here), `__KOVEN_PLATFORM__` (compile-time OS tag),
/// and `__KOVEN_WINDOW_KIND__` (per-window: "main" for the app
/// shell, "call" for the popped-out call window).  The SPA reads
/// `__KOVEN_WINDOW_KIND__` at boot to mount the right top-level
/// component (full app shell vs. call-only surface).  Done at
/// runtime so the platform + kind strings can be interpolated;
/// LINK_INTERCEPTOR_JS stays a const &str.
fn build_init_script_for(kind: &str) -> String {
	format!(
		"window.__KOVEN_DESKTOP__=true;window.__KOVEN_PLATFORM__='{}';window.__KOVEN_WINDOW_KIND__='{}';\n{}",
		KOVEN_PLATFORM, kind, LINK_INTERCEPTOR_JS,
	)
}

/// Per-call handoff slot used when popping a call out of the main
/// window into its own freely-resizable window.  Main window:
/// invokes `spawn_call_window` with a freshly-minted auth token →
/// Rust stashes the params here → spawns the call window → call
/// window calls `drain_pending_call` on boot and joins with the
/// stashed params.
///
/// Why pass via state and not URL params: auth tokens in URLs leak
/// into the WebView's history, devtools network tab, and any logs
/// that record top-level navigations.  A `Mutex<Option<…>>` is a
/// near-zero-cost handoff that keeps the URL clean (the call
/// window's URL is just the same SPA root the main window loaded;
/// the SPA decides what to render based on `__KOVEN_WINDOW_KIND__`).
#[derive(Default)]
struct CallHandoff(std::sync::Mutex<Option<PendingCall>>);

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingCall {
	room_id: String,
	room_name: String,
	auth_token: String,
	access_token: String,
	is_dm: bool,
	/// Mic state at the moment of pop-out.  Threaded through so the
	/// new SDK session starts with the same mic state the user had
	/// just configured; otherwise they'd land in the new window with
	/// the mic off and have to re-toggle.
	default_audio: bool,
	/// Camera state at the moment of pop-out.  Same reasoning as
	/// `default_audio`.
	default_video: bool,
}

/// The pinned local port the bundled SPA is served from.  Stored in
/// managed state so `spawn_call_window` (which runs much later than
/// `run`, after the SPA hands us params) can build the same URL the
/// main window was launched with.  Threading the port through every
/// closure that might one day need it is uglier than a single
/// managed value.
struct LocalPort(u16);

/// Open the freely-resizable call window with the params handed to
/// us by the main window's pop-out flow.  Reuses a single window
/// labeled "call": if one already exists (shouldn't happen in the
/// normal flow, since the main window has no active call once a
/// pop-out succeeds), close it first so a fresh one can take over.
///
/// Native chrome on this window is intentional: traffic lights /
/// title bar / standard min-max-close, native fullscreen via the
/// macOS green button or Win/Linux maximize.  Matches FaceTime's
/// model and saves us from re-implementing the rounded-corner
/// Cocoa dance for a second window.
#[tauri::command]
async fn spawn_call_window(
	app: tauri::AppHandle,
	handoff: tauri::State<'_, CallHandoff>,
	port: tauri::State<'_, LocalPort>,
	params: PendingCall,
) -> Result<(), String> {
	// Stash params first so the new window can drain them on boot.
	// Mutex-poisoning recovery: if a prior holder panicked, recover
	// the inner value and overwrite rather than propagating the
	// poison (which would hang the pop-out flow forever).
	let title = format!("Koven · {}", params.room_name);
	match handoff.0.lock() {
		Ok(mut g) => *g = Some(params),
		Err(poisoned) => {
			let mut g = poisoned.into_inner();
			*g = Some(params);
		}
	}

	// Defensive close if another call window is somehow still up.
	// In the normal flow the main window has no active call when
	// the user pops out (we leave the meeting first), so there's no
	// route to a second pop-out without a fresh call+join in
	// between.  Closing here keeps a manual reload + edge cases
	// from leaving two call windows fighting over the same handoff.
	if let Some(existing) = app.get_webview_window("call") {
		let _ = existing.close();
	}

	let url_str = if cfg!(debug_assertions) {
		"http://localhost:1421/".to_string()
	} else {
		format!("http://localhost:{}/index.html", port.0)
	};
	let parsed: Url = url_str.parse().map_err(|e: url::ParseError| e.to_string())?;

	let mut builder = WebviewWindowBuilder::new(&app, "call", WebviewUrl::External(parsed))
		.title(title)
		.inner_size(720.0, 540.0)
		.min_inner_size(320.0, 240.0)
		.resizable(true)
		.center()
		.decorations(true)
		.devtools(true)
		.initialization_script(build_init_script_for("call"));

	// Same UA spoof as the main window: RealtimeKit's device-support
	// check refuses to initialise without a Safari-flavoured UA on
	// macOS, and pinning a known-good UA on Windows + Linux keeps
	// behaviour reproducible across WebView updates.  See the long
	// comment on the main window's user_agent call for background.
	#[cfg(target_os = "macos")]
	{
		builder = builder.user_agent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
		);
	}
	#[cfg(target_os = "windows")]
	{
		builder = builder.user_agent(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"
		);
	}
	#[cfg(target_os = "linux")]
	{
		builder = builder.user_agent(
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
		);
	}

	let win = builder.build().map_err(|e| e.to_string())?;

	// macOS WKWebView needs the UIDelegate gate flipped on each
	// window separately: the main window's install doesn't carry
	// over.  Without this, getUserMedia in the call window would
	// silently reject with NotAllowedError even though the
	// entitlements + Info.plist permissions are in place.
	//
	// We intentionally do NOT apply NSWindowCollectionBehaviorFullScreenNone
	// here (which the main window uses to keep its rounded-corner
	// chrome stable).  Native fullscreen on the call window is a
	// primary feature; leaving the collection-behavior default in
	// place lets the macOS green button do the right thing.
	#[cfg(target_os = "macos")]
	{
		use cocoa::base::id;
		if let Ok(ptr) = win.ns_window() {
			plugins::mac_webrtc_permission::install(ptr as id);
		}
	}

	Ok(())
}

/// The call window calls this once on boot to claim the params the
/// main window stashed via `spawn_call_window`.  Returning `None`
/// means the window was opened without a pending call (e.g.
/// reloaded after the call ended), in which case the SPA shows an
/// error state instead of attempting to start an empty call.
#[tauri::command]
fn drain_pending_call(handoff: tauri::State<'_, CallHandoff>) -> Option<PendingCall> {
	handoff.0.lock().ok().and_then(|mut g| g.take())
}

pub fn run() {
	// Pin a free local port up front so the `is_internal` check + the
	// webview URL agree on the same number.  Production only —
	// development still loads from Vite at http://localhost:1421.
	//
	// We pick a port once at process start (rather than letting the
	// localhost plugin pick on its own) so the value is reachable from
	// both the navigation handler and the webview URL builder without
	// having to thread it through closures.
	//
	// CRITICAL: the port must be STABLE across launches.  WKWebView
	// (and every other browser) keys localStorage / IndexedDB by
	// ORIGIN — `http://localhost:51420` and `http://localhost:51421`
	// are different origins, so a port that changes per launch wipes
	// the user's auth (and matrix-js-sdk's crypto store) every time
	// the app reopens — most visible after an updater-triggered
	// relaunch ("why does it make me sign in every update?").
	//
	// Strategy: try a deterministic high port first (51420 is well
	// above the typical user-app range, unlikely to collide).  If
	// it's already taken (other Koven install running on the same
	// machine, port shadow from a recent crash, etc.), fall back to
	// portpicker — that launch will lose its localStorage but at
	// least the app starts.  In practice the deterministic port
	// works for the lifetime of the user's install.
	const STABLE_LOCAL_PORT: u16 = 51420;
	let local_port: u16 = if portpicker::is_free(STABLE_LOCAL_PORT) {
		STABLE_LOCAL_PORT
	} else {
		eprintln!("koven-desktop: stable port {STABLE_LOCAL_PORT} busy, falling back to random — this launch will lose localStorage");
		portpicker::pick_unused_port().expect("no free local port available")
	};

	tauri::Builder::default()
		// Managed state used by the pop-out call window flow.  Both
		// values are read by `spawn_call_window` / `drain_pending_call`
		// commands; declaring them up here means the values exist
		// before the first SPA boot.  CallHandoff::default() is an
		// empty Mutex<Option<…>>.
		.manage(CallHandoff::default())
		.manage(LocalPort(local_port))
		// Keep one window per machine — second `koven-desktop` launch
		// (or a `koven://` deep-link click) focuses the existing one
		// instead of spawning a duplicate.  Required before any other
		// plugin so the focus message is dispatched first.
		.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
			if let Some(window) = app.get_webview_window("main") {
				let _ = window.unminimize();
				let _ = window.set_focus();
			}
			// Linux + Windows cold-warm path: when the OS launches a
			// second instance with a `koven://...` URL in argv (a
			// deep-link click while we're already running), the
			// single-instance plugin diverts that launch into THIS
			// callback so we can forward the URL to the existing
			// window.  macOS doesn't take this path — Cocoa calls
			// our `on_open_url` handler in setup() instead — but it
			// runs the same emit so the SPA side has exactly one
			// event to subscribe to.  Scan argv for any token that
			// looks like a `koven://` URL and emit each one.  Most
			// clicks will be a single URL; a multi-URL launch is
			// theoretically possible (rare, harmless if it happens).
			for arg in argv.iter() {
				if arg.starts_with("koven://") {
					if let Err(err) = app.emit("deep-link", arg.clone()) {
						log::warn!("deep-link emit failed for {arg}: {err}");
					}
				}
			}
		}))
		// Custom-scheme deep links.  Registers `koven://` with the OS
		// (via CFBundleURLTypes on macOS, a registry key on Windows,
		// AppData XML on Linux).  When the OS opens us with a URL,
		// either at cold start or while running, the handler below
		// fires and re-emits the URL on the `deep-link` window event
		// so the SPA can consume it through its existing share-intent
		// pipeline.  Plugin must register before setup() so its
		// internal subscriber is alive when the first URL arrives —
		// macOS Cocoa can fire `application:openURLs:` during launch
		// before our setup callback runs.
		.plugin(tauri_plugin_deep_link::init())
		// Embedded HTTP server serving the bundled SPA from
		// http://localhost:<local_port>/.  See the comment on
		// tauri-plugin-localhost in Cargo.toml for the full rationale
		// — TL;DR custom-protocol parents (tauri://) break YouTube /
		// Twitter / Spotify embeds, http://localhost is a real
		// "potentially trustworthy" origin and embeds just work.
		//
		// Dev mode skips this entirely and keeps loading from Vite at
		// http://localhost:1421 — same scheme, same secure-context
		// treatment, no compatibility delta between dev and prod.
		.plugin(tauri_plugin_localhost::Builder::new(local_port).build())
		// OS-default URL / path handler.  Used by the navigation
		// guard below to dispatch external links.
		.plugin(tauri_plugin_opener::init())
		// Native toast notifications (Notification Center on macOS,
		// Action Center on Windows, libnotify on Linux).
		.plugin(tauri_plugin_notification::init())
		// Signed auto-update from GitHub Releases via the manifest
		// URL declared in tauri.conf.json.
		.plugin(tauri_plugin_updater::Builder::new().build())
		// Native save-as dialog used by the save_download command so
		// the user picks where each downloaded attachment lands
		// instead of seeing it disappear silently into ~/Downloads/.
		.plugin(tauri_plugin_dialog::init())
		// Rounded-corner plugin commands.  macOS-only — guarded so
		// the invoke_handler isn't compiled into Linux / Windows
		// builds that don't need it.  The SPA invokes
		// `enable_modern_window_style` once on mount (see
		// DesktopTitleBar.tsx) to apply the layer mask.
		.invoke_handler({
			#[cfg(target_os = "macos")]
			{
				tauri::generate_handler![
					mac_rounded_corners::enable_rounded_corners,
					mac_rounded_corners::enable_modern_window_style,
					mac_rounded_corners::reposition_traffic_lights,
					mac_rounded_corners::hide_traffic_lights,
					reveal_app,
					save_download,
					wipe_local_cache_and_exit,
					spawn_call_window,
					drain_pending_call,
				]
			}
			#[cfg(not(target_os = "macos"))]
			{
				tauri::generate_handler![
					reveal_app,
					save_download,
					wipe_local_cache_and_exit,
					spawn_call_window,
					drain_pending_call,
				]
			}
		})
		.setup(move |app| {
			// Linux: write a `.desktop` entry + icons into
			// ~/.local/share/ when running from an AppImage so
			// GNOME / KDE see Koven as a real application (proper
			// name, proper icon, pinnable to taskbar).  No-op on
			// .deb / .rpm installs and during `cargo tauri dev`.
			// See plugins/linux_desktop_integration.rs for the full
			// rationale.
			#[cfg(target_os = "linux")]
			linux_desktop_integration::integrate();

			// macOS application menu.  Tauri 2 doesn't auto-build one,
			// and without an explicit menu the system falls back to a
			// stub that names every item after the binary
			// (`koven-desktop`) — hence "About koven-desktop" instead
			// of "About Koven".  Build the standard set (App / Edit /
			// View / Window) explicitly so menu labels, the About
			// dialog, and Cmd-shortcuts behave the way users expect.
			//
			// Linux / Windows ignore this — they don't have a global
			// menu bar (Linux desktops vary; Windows menus live inside
			// the window via Tauri's built-in chrome).
			#[cfg(target_os = "macos")]
			{
				let about = AboutMetadataBuilder::new()
					.name(Some("Koven"))
					.version(Some(env!("CARGO_PKG_VERSION").to_string()))
					.copyright(Some("Copyright © 2026 Gnosys Labs".to_string()))
					.website(Some("https://koven.chat".to_string()))
					.website_label(Some("koven.chat".to_string()))
					// The .icns bundled by Tauri's icon pipeline lives
					// inside the .app's Resources folder — macOS pulls
					// it for the About dialog automatically via
					// CFBundleIconFile.  No need to load bytes here.
					.build();

				let app_menu = SubmenuBuilder::new(app, "Koven")
					.about(Some(about))
					.separator()
					.services()
					.separator()
					.hide()
					.hide_others()
					.show_all()
					.separator()
					.quit()
					.build()?;

				let edit_menu = SubmenuBuilder::new(app, "Edit")
					.undo()
					.redo()
					.separator()
					.cut()
					.copy()
					.paste()
					.select_all()
					.build()?;

				// View menu intentionally omitted.  The only standard
				// item it would carry is "Enter Full Screen", which
				// we've disabled via NSWindowCollectionBehaviorFullScreenNone
				// — showing a non-functional menu item would be worse
				// than no menu at all.

				let window_menu = SubmenuBuilder::new(app, "Window")
					.minimize()
					.maximize()
					.separator()
					.close_window()
					.build()?;

				let menu = MenuBuilder::new(app)
					.items(&[&app_menu, &edit_menu, &window_menu])
					.build()?;
				app.set_menu(menu)?;
			}

			// Splash window — tiny transparent floater that shows the
			// favicon over the desktop wallpaper while the main
			// window builds + the SPA runs its rounded-corner setup.
			// macOS only because Linux / Windows builds don't have
			// the same square-white-flash problem (their native
			// chrome is what users expect during launch).  Splash is
			// closed by the JS-invoked `reveal_app` command once
			// the main UI is ready, OR by a 3-second fallback timer
			// if the reveal call never lands.
			#[cfg(target_os = "macos")]
			{
				let splash_url = if cfg!(debug_assertions) {
					// Dev: Vite serves splash.html.  Port matches
					// `devUrl` in tauri.conf.json AND the `--port`
					// flag in client/package.json's dev:tauri script.
					// Bumped from 1420 to 1421 so dev:lan (LAN-
					// accessible Vite on 1420) and dev:tauri can run
					// concurrently — without this, the user can have
					// either the web view OR the desktop view live,
					// not both.
					WebviewUrl::External("http://localhost:1421/splash.html".parse().unwrap())
				} else {
					WebviewUrl::External(
						format!("http://localhost:{local_port}/splash.html").parse().unwrap(),
					)
				};
				let splash = WebviewWindowBuilder::new(app, "splash", splash_url)
					.title("")
					.decorations(false)
					.transparent(true)
					.always_on_top(true)
					.resizable(false)
					.skip_taskbar(true)
					.inner_size(200.0, 200.0)
					.center()
					.build()?;

				// Kill the NSWindow's auto-drawn shadow rectangle —
				// macOS gives every undecorated transparent window a
				// soft drop shadow, which renders as a faint dark
				// circle/oval around our floating favicon.
				// setHasShadow:NO removes it so the favicon really
				// does float against the bare desktop.
				use cocoa::base::id;
				use objc::{msg_send, sel, sel_impl};
				if let Ok(ptr) = splash.ns_window() {
					unsafe {
						let ns_window: id = ptr as id;
						let _: () = msg_send![ns_window, setHasShadow: false];
					}
				}

				// Fallback: 5 seconds after launch, force-reveal even
				// if `reveal_app` never fires.  Without this, any
				// silent failure in the SPA's chrome-setup chain
				// leaves the main window hidden forever and the user
				// just stares at the splash.  5s (was 3s) gives the
				// SPA enough headroom to finish its full first paint
				// — IndexedDBStore.startup, initRustCrypto, the
				// rounded-corner Cocoa setup, and React's first
				// commit can comfortably exceed 3s on a cold cache.
				// Plain std::thread is fine — Tauri's WebviewWindow
				// handles are Send + Sync so we can poke them from
				// any thread.
				let app_handle = app.handle().clone();
				std::thread::spawn(move || {
					std::thread::sleep(std::time::Duration::from_secs(5));
					if let Some(s) = app_handle.get_webview_window("splash") {
						let _ = s.close();
					}
					if let Some(m) = app_handle.get_webview_window("main") {
						let _ = m.show();
						let _ = m.set_focus();
					}
				});
			}

			// Build the main window in code rather than declaring it
			// statically in tauri.conf.json so we can attach the
			// navigation handler before the WebView's first load —
			// declaratively-built windows don't expose `on_navigation`
			// until after they're already on screen, which races
			// against the first paint.
			let url = if cfg!(debug_assertions) {
				// Dev: load the local Vite dev server.  This matches
				// `devUrl` in tauri.conf.json (Tauri's CLI starts
				// Vite via `beforeDevCommand`), so SPA edits hot-
				// reload into the running window.  Backend traffic
				// (engine + Matrix) goes to client.koven.chat via
				// the VITE_ENGINE_URL / VITE_HOMESERVER_URL env vars
				// the dev:tauri script sets — no local engine /
				// Synapse needed.
				WebviewUrl::External("http://localhost:1421".parse().unwrap())
			} else {
				// Production: bundled `client/dist/` is served by
				// tauri-plugin-localhost on http://localhost:<local_port>/.
				// We deliberately do NOT use WebviewUrl::App here —
				// that would resolve to tauri://localhost/index.html
				// (the custom-protocol scheme), which third-party
				// embeds reject.  See the plugin registration above.
				WebviewUrl::External(
					format!("http://localhost:{local_port}/index.html").parse().unwrap(),
				)
			};

			// Capture the AppHandle for the navigation closure so it
			// can dispatch URLs to the OS opener.  `app.handle()`
			// returns a cheap clone-friendly handle that's `Send +
			// Sync`, which the `on_navigation` closure requires.
			let opener_app = app.handle().clone();

			let mut builder = WebviewWindowBuilder::new(app, "main", url)
				.title("Koven")
				.inner_size(1280.0, 800.0)
				.min_inner_size(720.0, 480.0)
				.resizable(true)
				.center()
				// Build hidden so we can set the icon BEFORE the window
				// registers with the WM (see the long comment by the
				// set_icon call below).  We call `win.show()` after
				// set_icon — net effect: the window pops up exactly
				// once, with the right icon already on it, no flicker.
				// macOS / Windows are fine either way; this matters
				// specifically for GNOME, which snapshots the dock /
				// Activities icon at the moment the window registers
				// with mutter and never re-reads it.
				.visible(false);

			// macOS + Windows: kill ALL native chrome and render our
			// own title bar in the SPA.  Tauri's stock options
			// (Visible / Transparent / Overlay) all have problems
			// for our case:
			//
			//   * Visible — chunky opaque bar with "Koven" text
			//     centered.  Doesn't blend with the dark gradient,
			//     reads like an early-2010s desktop app.
			//   * Transparent + hiddenTitle — bar exists but is
			//     invisible.  Past attempts had drag-region issues
			//     where clicks on the SPA's leftmost column ate the
			//     drag handle.
			//   * Overlay (macOS only) — no allocated chrome,
			//     traffic lights overlay the SpaceBar.  Same drag
			//     problem.
			//
			// `decorations(false)` removes everything: no traffic
			// lights / title-bar buttons, no title bar, no chrome.
			// The SPA fills the entire window edge-to-edge.  We
			// then render a custom `<DesktopTitleBar />` inside the
			// SPA (see client/src/components/DesktopTitleBar.tsx)
			// that:
			//
			//   * Draws platform-appropriate window controls —
			//     macOS-style traffic lights on the LEFT, Windows-
			//     style min/max/close on the RIGHT — wired to
			//     window.close() / minimize() / toggleMaximize()
			//     via the Tauri JS API.
			//   * Carries `data-tauri-drag-region` across the strip
			//     between the controls and the rest of the chrome
			//     so window drag still works the way users expect.
			//
			// Trade-offs on Windows with `decorations(false)`: Aero
			// Snap (drop-to-edge to dock) and Win11 Snap Layouts
			// (hover the maximize button → snap popover) are lost
			// until we restore them with manual WM_NCCALCSIZE /
			// WM_NCHITTEST handling.  Acceptable starting point —
			// the corner-rounding is the load-bearing visual.
			//
			// Linux trade-offs with `decorations(false)`: the SPA
			// renders the same Win11-style chrome the Windows build
			// uses (see DesktopTitleBar.tsx's "linux" branch).  Drag
			// is handled in JS via `data-tauri-drag-region` —
			// WebKitGTK doesn't expose an HWND-subclass equivalent,
			// and the JS-IPC latency that races with mousedown on
			// Windows is forgiving on GTK.  Resize-from-edge is the
			// real loss: GNOME/mutter doesn't grant edge-resize to
			// undecorated Wayland windows, so the SPA also paints a
			// ring of invisible 4px handles around the viewport that
			// call `startResizeDragging` (see DesktopResizeEdges in
			// DesktopTitleBar.tsx).  No rounded corners on Linux —
			// no DWM equivalent, and `transparent(true)` is the
			// usual Linux corner-mask trick but it disables window
			// shadows and confuses every WM differently.
			#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
			{
				// Strip native chrome (no traffic lights / no system
				// title-bar buttons).  Window stays OPAQUE on macOS
				// + Windows — we'll round its corners via Cocoa
				// layer mask (macOS) or DWMWA_WINDOW_CORNER_PREFERENCE
				// (Win11).  `transparent(true)` is documented as
				// actively breaking layer corner-masking on macOS
				// (Tauri issue #14165), so don't go there.
				builder = builder.decorations(false);
			}

			// Override the WebView user-agent so feature-detection
			// libraries that gate on UA strings (Cloudflare RealtimeKit
			// SDK is the immediate offender — it throws
			// "[ERR0001] {Client} Failed to initialize. device not
			// supported" because Tauri's stock WKWebView UA omits the
			// "Version/X Safari/..." tokens that the SDK keys off of)
			// see a recognizably-Safari UA.  WKWebView IS Safari's
			// engine, so any feature the SDK needs from "real Safari"
			// is present here too — it's a string-mismatch problem,
			// not a capability problem.  We pick a recent Safari UA
			// that the SDK is known to accept; bump this every couple
			// of years so it doesn't get flagged as "outdated browser"
			// by other libraries.  iris-rs uses the same trick.
			#[cfg(target_os = "macos")]
			{
				builder = builder.user_agent(
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
				);
			}
			#[cfg(target_os = "windows")]
			{
				// Edge / WebView2 already includes "Chrome/..." so the
				// SDK's UA check passes there; we still pin a value so
				// the behavior is reproducible across WebView2 updates.
				builder = builder.user_agent(
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"
				);
			}
			#[cfg(target_os = "linux")]
			{
				// WebKitGTK ships with "Safari/" already, but the older
				// "Version/" token is missing on some distros — pin a
				// known-good string so RealtimeKit doesn't reject.
				builder = builder.user_agent(
					"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
				);
			}

			// Enable DevTools in production builds.  Tauri release
			// builds disable inspector by default, which leaves users
			// (and us) with NO way to see console errors when the SPA
			// misbehaves — every "silent failure" report becomes a
			// guessing game.  Trade: anyone can right-click → Inspect
			// and poke at the app, but a desktop app that loads a
			// known SPA from localhost has no secrets to protect that
			// inspection would expose — the same code is served from
			// client.koven.chat where DevTools is always available
			// anyway.  Win-win on debuggability.
			builder = builder.devtools(true);

			let builder_final = builder
				// Inject a click + window.open interceptor that routes
				// external URLs through the opener plugin.  Required
				// because WKWebView (macOS) and WebKitGTK (Linux)
				// silently drop `<a target="_blank">` clicks and
				// `window.open()` calls when there's no native
				// new-window handler — `on_navigation` below only fires
				// for top-level navigations, not pop-up requests.  This
				// runs before any page script so it catches links from
				// the very first paint.
				.initialization_script(build_init_script_for("main"))
				.on_navigation(move |url| {
					if is_internal(url) {
						return true;
					}
					// External top-level navigation: hand off to the
					// OS browser, cancel the in-WebView navigation.
					// This branch handles direct address-bar style
					// navigations and same-window `<a href>` clicks
					// (no `_blank`); pop-up style links are handled
					// by the JS interceptor above.
					log::info!("opening external link in OS browser: {}", url);
					if let Err(err) = opener_app
						.opener()
						.open_url(url.as_str(), None::<&str>)
					{
						log::warn!("opener failed for {url}: {err}");
					}
					false
				})
				// Allow `<a download>` clicks to actually save files.
				// Tauri's three WebView backends (WKWebView on macOS,
				// WebView2 on Windows, WebKitGTK on Linux) all default
				// to BLOCKING download events when no on_download
				// handler is registered — the click registers, the
				// event fires, but no file lands.  The recovery-key
				// "Download" button on encryption setup is the
				// user-visible casualty: signing up + clicking
				// Download appears to do nothing, leaving the user
				// with no way to save the only key that gets them
				// back into encrypted history.
				//
				// Default destination: the OS's Downloads folder +
				// the suggested filename from the anchor's `download`
				// attribute (Tauri pre-populates `destination` with
				// it).  When `download` was empty (or the WebView
				// didn't carry the filename through, which WKWebView
				// occasionally drops), fall back to a timestamped
				// generic name so the file at least lands somewhere
				// findable rather than being silently dropped.
				.on_download(|webview, mut event| {
					if let DownloadEvent::Requested { url, destination } = &mut event {
						// Resolve the OS Downloads folder via Tauri's
						// PathResolver — works cross-platform without
						// needing the dirs/dirs-next crate as a
						// dependency.  Falls back to "." (CWD) on the
						// extremely unlikely failure path so we never
						// drop the file silently.
						let dl_dir = webview
							.path()
							.download_dir()
							.unwrap_or_else(|_| std::path::PathBuf::from("."));
						let mut filename = destination
							.file_name()
							.map(|n| n.to_string_lossy().into_owned())
							.unwrap_or_default();
						if filename.is_empty() {
							let ts = std::time::SystemTime::now()
								.duration_since(std::time::UNIX_EPOCH)
								.map(|d| d.as_secs())
								.unwrap_or(0);
							filename = format!("koven-download-{ts}.txt");
						}
						**destination = dl_dir.join(&filename);
						log::info!("download: {} -> {}", url, destination.display());
					}
					true
				});

			let win = builder_final.build()?;

			// Disable fullscreen.  Fullscreen on macOS uses a
			// separate compositor space that breaks our rounded-
			// corner / NSFullSizeContentView setup — the window
			// flips to full-size square chrome and the SPA layout
			// behaves badly during the transition.  Setting
			// NSWindowCollectionBehaviorFullScreenNone (1 << 9)
			// blocks all four entry points: green-button hover
			// menu, ⌃⌘F shortcut, View menu's "Enter Full Screen"
			// item, and double-click-titlebar-to-fullscreen.
			// Window zoom (toggleMaximize) still works — that's a
			// separate operation that just resizes the window.
			#[cfg(target_os = "macos")]
			{
				use cocoa::base::id;
				use objc::{msg_send, sel, sel_impl};
				const FULL_SCREEN_NONE: u64 = 1 << 9;
				if let Ok(ptr) = win.ns_window() {
					unsafe {
						let ns_window: id = ptr as id;
						let _: () = msg_send![ns_window, setCollectionBehavior: FULL_SCREEN_NONE];
					}
					// Install the WKWebView UIDelegate that auto-grants
					// getUserMedia.  Without this, the page sees
					// NotAllowedError on every camera/mic request even
					// with the Info.plist + Entitlements in place.
					// See plugins/mac_webrtc_permission for the full
					// 3-gate explanation.
					if let Ok(ptr) = win.ns_window() {
						plugins::mac_webrtc_permission::install(ptr as id);
					}
				}
			}

			// macOS rounded window corners are applied via the
			// cloudworxx plugin's `enable_modern_window_style`
			// command, invoked from the SPA after the window mounts
			// (see client/src/components/DesktopTitleBar.tsx).  The
			// plugin handles the NSWindow.styleMask + layer-mask +
			// traffic-light dance correctly — direct Cocoa from
			// Rust didn't survive the WKWebView's own opaque layer.

			// Embed the icon at compile time and apply it to the window
			// at runtime.  Lifted from iris-linux's main.rs (a known-
			// working AppImage / WinExe reference) — without this:
			//
			//   * Linux AppImage launches show a generic settings-cog
			//     in the GNOME / KDE dock + taskbar, because the WM
			//     can't find a matching .desktop entry when the
			//     AppImage hasn't been integrated system-wide.  The
			//     icon list in tauri.conf.json governs installed-app
			//     bundle icons but doesn't reach the running window's
			//     surface; the WM falls back to its default cog.
			//   * Windows installs occasionally show the previous
			//     version's icon in the taskbar / window title bar
			//     because Windows caches icons keyed on the .exe path
			//     and the cache doesn't always invalidate when a fresh
			//     installer overwrites the binary in place.  set_icon
			//     rewrites the running window's icon from PNG bytes the
			//     cache never saw, side-stepping the staleness.
			//
			// macOS draws its window-chrome icon from the bundle's
			// .icns automatically (and doesn't render window icons in
			// the title bar at all), so this is a no-op there — but
			// it's cheap and keeps the codepath uniform across OSes.
			//
			// **Order matters on Linux.**  The window is built with
			// `visible: false`; we set the icon, THEN call show().
			// GNOME's mutter snapshots the icon when the window first
			// appears in the dock and never re-reads — calling
			// set_icon AFTER show() leaves the cog in place even
			// though the window's GTK icon is now correct.  Doing
			// it pre-show means the icon is already on the window
			// before mutter looks at it.  Windows / macOS don't care
			// about ordering; the early-show + late-icon path works
			// there regardless.
			//
			// `image-png` is enabled in Cargo.toml so the runtime PNG
			// decoder is available; without that feature
			// `Image::from_bytes` errors out and we'd silently fall
			// back to the WM default.
			let icon_bytes = include_bytes!("../icons/256x256.png");
			if let Ok(image) = tauri::image::Image::from_bytes(icon_bytes) {
				if let Err(err) = win.set_icon(image) {
					log::warn!("set_icon failed: {err}");
				}
			} else {
				log::warn!("set_icon: PNG decode failed (image-png feature missing?)");
			}

			// On macOS the main window stays hidden until the SPA
			// invokes `reveal_app` — the splash window is what the
			// user sees during boot, and the corner-radius / hide-
			// traffic-lights dance has to happen on the main HWND
			// after Cocoa has finished laying it out.
			//
			// On Windows we apply DWM corner rounding BEFORE the
			// first show() so the window's first frame paints with
			// the rounded shape — otherwise the user briefly sees a
			// sharp-cornered square before DWM masks it.  Win10
			// silently no-ops (the API ignores unknown attrs), so
			// the call is safe to make unconditionally.
			//
			// On Linux there's no splash and no native rounding to
			// apply — just show.
			#[cfg(target_os = "windows")]
			{
				windows_rounded_corners::apply_rounded_corners(&win);
				// Subclass the HWND so WM_NCHITTEST returns
				// HTCAPTION for the top 40px (minus the right ~138px
				// where the Min/Max/Close buttons live).  Lets
				// Windows handle drag natively — no JS round-trip,
				// no async race on mousedown, and the standard
				// caption gestures (double-click to maximize, Aero
				// Snap, right-click system menu) all come back.
				windows_rounded_corners::apply_drag_region(&win);
			}
			#[cfg(not(target_os = "macos"))]
			{
				if let Err(err) = win.show() {
					log::warn!("window.show failed: {err}");
				}
			}

			// Linux + Windows COLD-START deep-link handler.  The
			// tauri-plugin-deep-link plugin parses argv at boot and
			// fires `on_open_url` for any URL that matches a
			// configured scheme.  Required because the plugin
			// explicitly does NOT hook macOS Cocoa events — for
			// macOS see the `run` callback below.
			let deep_link_app = app.handle().clone();
			app.deep_link().on_open_url(move |event| {
				for url in event.urls() {
					let url_str = url.to_string();
					if let Err(err) = deep_link_app.emit("deep-link", url_str.clone()) {
						log::warn!("deep-link emit failed for {url_str}: {err}");
					}
				}
			});

			// Kick off an update check after the window is up.
			// Best-effort — failures (no network, no new release,
			// signature mismatch) are logged and ignored; we don't
			// want a flaky updater to block the SPA from loading.
			let updater_app = app.handle().clone();
			tauri::async_runtime::spawn(async move {
				if let Err(err) = check_for_updates(updater_app).await {
					log::warn!("updater: skipped ({err})");
				}
			});

			Ok(())
		})
		// macOS deep-link + Universal Link handler.  Cocoa delivers
		// custom-scheme URLs (koven://...) through
		// `application:openURLs:`, and Universal Links
		// (https://client.koven.chat/invite/...) through
		// `application:continueUserActivity:restorationHandler:`.
		// Tauri's `tao` backend hooks BOTH AppDelegate methods and
		// routes them through the same `RunEvent::Opened { urls }`
		// event — which is only accessible if we go through
		// `build()?.run(callback)` instead of the `run()` shorthand
		// that hides the event loop.
		//
		// The tauri-plugin-deep-link plugin we use for Linux/Windows
		// explicitly does not hook macOS Cocoa events, so without
		// this `RunEvent::Opened` interception every koven:// click
		// AND every Universal Link click on macOS would be silently
		// dropped.  All three OSes funnel into the same `deep-link`
		// emit so the SPA only has one event to listen for.
		//
		// Cold-launch caveat: Cocoa may deliver the URL before the
		// SPA listener binds.  The SPA's deep-link useEffect is
		// gated on `transport` + `creds`, which means it can't fire
		// until after sign-in.  A cold-launch URL that arrives
		// pre-auth gets dropped today; the user lands on the SPA
		// without the room they wanted opened.  Fix is a Mutex-backed
		// pending-URL queue + a tauri command the SPA calls on bind
		// to drain it — punted for now since most real-world clicks
		// happen while the app is already running and signed in.
		.build(tauri::generate_context!())
		.expect("error while building koven-desktop")
		.run(|_app_handle, _event| {
			// `RunEvent::Opened` only exists on macOS — Tauri's
			// enum gates the variant behind a cfg, so on Linux /
			// Windows the match would be a "variant not found"
			// compile error.  Wrap the body in a macos cfg.
			// Linux + Windows funnel deep links through the
			// single-instance plugin's argv callback (above), so
			// this branch isn't needed there anyway.
			#[cfg(target_os = "macos")]
			if let tauri::RunEvent::Opened { urls } = _event {
				for url in urls {
					let url_str = url.to_string();
					log::info!("RunEvent::Opened — {url_str}");
					if let Err(err) = _app_handle.emit("deep-link", url_str.clone()) {
						log::warn!("deep-link emit failed for {url_str}: {err}");
					}
				}
			}
		});
}

/// Async update check: fetch the manifest, prompt-and-install if a
/// newer signed build is available, restart on apply.  Errors
/// propagate up so the caller can log them; we don't surface them in
/// the UI for v1.
async fn check_for_updates(app: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
	let updater = app.updater()?;
	if let Some(update) = updater.check().await? {
		log::info!(
			"update available: {} → {}",
			env!("CARGO_PKG_VERSION"),
			update.version,
		);
		update
			.download_and_install(
				|chunk, total| log::debug!("updater: {} / {:?}", chunk, total),
				|| log::info!("updater: download finished, installing"),
			)
			.await?;
		log::info!("updater: applied, restarting");
		app.restart();
	} else {
		log::info!("updater: already on latest");
	}
	Ok(())
}

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

use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

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
				return u.hostname === 'client.koven.chat' || u.hostname === 'tauri.localhost';
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
///
/// Cross-origin XHR / fetch isn't gated by this list; only top-level
/// navigation requests pass through `on_navigation` below.
fn is_internal(url: &Url) -> bool {
	match url.scheme() {
		"tauri" => true,
		"http" | "https" => matches!(
			url.host_str(),
			Some("client.koven.chat") | Some("tauri.localhost"),
		),
		_ => false,
	}
}

pub fn run() {
	tauri::Builder::default()
		// Keep one window per machine — second `koven-desktop` launch
		// (or a `koven://` deep-link click) focuses the existing one
		// instead of spawning a duplicate.  Required before any other
		// plugin so the focus message is dispatched first.
		.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
			if let Some(window) = app.get_webview_window("main") {
				let _ = window.unminimize();
				let _ = window.set_focus();
			}
		}))
		// OS-default URL / path handler.  Used by the navigation
		// guard below to dispatch external links.
		.plugin(tauri_plugin_opener::init())
		// Native toast notifications (Notification Center on macOS,
		// Action Center on Windows, libnotify on Linux).
		.plugin(tauri_plugin_notification::init())
		// Signed auto-update from GitHub Releases via the manifest
		// URL declared in tauri.conf.json.
		.plugin(tauri_plugin_updater::Builder::new().build())
		.setup(|app| {
			// Build the main window in code rather than declaring it
			// statically in tauri.conf.json so we can attach the
			// navigation handler before the WebView's first load —
			// declaratively-built windows don't expose `on_navigation`
			// until after they're already on screen, which races
			// against the first paint.
			let url = if cfg!(debug_assertions) {
				// Dev: load the live SPA so shell features can be
				// iterated without spinning up Synapse + the engine
				// locally.  Replace this with `WebviewUrl::External`
				// pointing at a local Vite dev server if you're
				// hot-reloading client/ alongside the shell.
				WebviewUrl::External("https://client.koven.chat".parse().unwrap())
			} else {
				// Production: bundled `client/dist/` — Tauri serves
				// it from `tauri://localhost/` on macOS / Linux and
				// `https://tauri.localhost/` on Windows.
				WebviewUrl::App("index.html".into())
			};

			// Capture the AppHandle for the navigation closure so it
			// can dispatch URLs to the OS opener.  `app.handle()`
			// returns a cheap clone-friendly handle that's `Send +
			// Sync`, which the `on_navigation` closure requires.
			let opener_app = app.handle().clone();

			let _win = WebviewWindowBuilder::new(app, "main", url)
				.title("Koven")
				.inner_size(1280.0, 800.0)
				.min_inner_size(720.0, 480.0)
				.resizable(true)
				.center()
				// Inject a click + window.open interceptor that routes
				// external URLs through the opener plugin.  Required
				// because WKWebView (macOS) and WebKitGTK (Linux)
				// silently drop `<a target="_blank">` clicks and
				// `window.open()` calls when there's no native
				// new-window handler — `on_navigation` below only fires
				// for top-level navigations, not pop-up requests.  This
				// runs before any page script so it catches links from
				// the very first paint.
				.initialization_script(LINK_INTERCEPTOR_JS)
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
				.build()?;

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
		.run(tauri::generate_context!())
		.expect("error while running koven-desktop");
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

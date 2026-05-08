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

#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, SubmenuBuilder};

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
/// (always true here) and `__KOVEN_PLATFORM__` (compile-time OS tag),
/// which the SPA reads to branch on platform-specific UI.  Done at
/// runtime so the platform string can be interpolated; LINK_INTERCEPTOR_JS
/// stays a const &str.
fn build_init_script() -> String {
	format!(
		"window.__KOVEN_DESKTOP__=true;window.__KOVEN_PLATFORM__='{}';\n{}",
		KOVEN_PLATFORM, LINK_INTERCEPTOR_JS,
	)
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

				let view_menu = SubmenuBuilder::new(app, "View")
					.fullscreen()
					.build()?;

				let window_menu = SubmenuBuilder::new(app, "Window")
					.minimize()
					.maximize()
					.separator()
					.close_window()
					.build()?;

				let menu = MenuBuilder::new(app)
					.items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
					.build()?;
				app.set_menu(menu)?;
			}

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

			let builder = WebviewWindowBuilder::new(app, "main", url)
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
				.visible(false)
				// Inject a click + window.open interceptor that routes
				// external URLs through the opener plugin.  Required
				// because WKWebView (macOS) and WebKitGTK (Linux)
				// silently drop `<a target="_blank">` clicks and
				// `window.open()` calls when there's no native
				// new-window handler — `on_navigation` below only fires
				// for top-level navigations, not pop-up requests.  This
				// runs before any page script so it catches links from
				// the very first paint.
				.initialization_script(build_init_script())
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
				});

			// macOS: no title-bar customization.  The default
			// `Visible` style draws a standard native title bar with
			// "Koven" text and traffic lights, the WebView starts
			// below it, dragging works natively, and the SpaceBar's
			// avatar isn't overlapped by the traffic lights because
			// the OS reserves space for the title bar itself.

			let win = builder.build()?;

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

			// Now the window has the right icon attached — surface it.
			// Failure here is non-fatal: log and proceed (a hidden
			// window the user can't see is recoverable via the
			// single-instance focus path; a panic isn't).
			if let Err(err) = win.show() {
				log::warn!("window.show failed: {err}");
			}

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

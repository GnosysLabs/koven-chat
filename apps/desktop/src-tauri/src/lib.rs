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

/// Treat a navigation request as "internal" (stays inside the
/// WebView) iff it lands on one of these origins.  Everything else is
/// dispatched to the user's default browser via the opener plugin.
///
/// - `tauri://localhost`        → bundled SPA on macOS / Linux
/// - `https://tauri.localhost`  → bundled SPA on Windows (WebView2
///                                serves the same assets via the
///                                `https` protocol).
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
				// it from `tauri://localhost/` (or `tauri.localhost`
				// on Windows).
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
				.on_navigation(move |url| {
					if is_internal(url) {
						return true;
					}
					// External: hand off to the OS browser, cancel
					// the in-WebView navigation.  This also fires
					// for `<a target="_blank">` and `window.open()`
					// because WebView treats both as a top-level
					// navigation request from this hook's POV.
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

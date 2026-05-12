// Linux AppImage desktop integration.
//
// An AppImage is a single self-mounting executable — running it does
// NOT install a `.desktop` entry on the user's machine the way a .deb
// or .rpm does.  Without that entry, the WM has nothing to associate
// the running window with: GNOME / KDE / etc. show a generic icon in
// the dock + Activities, the title bar falls back to the binary name
// (`koven-desktop`) instead of "Koven", and there is no way to pin
// the app to the taskbar because pinning needs a `.desktop` file to
// pin TO.  `WebviewWindow::set_icon` only patches the running window's
// own GTK icon — it can't manufacture an application-menu entry.
//
// On every launch (idempotent) write `koven-desktop.desktop` to
// `~/.local/share/applications/` and copy our PNG icons to
// `~/.local/share/icons/hicolor/<size>/apps/koven-desktop.png`.  Once
// those files are in place GNOME / KDE pick the entry up on the next
// menu refresh (we kick `update-desktop-database` + `gtk-update-icon-cache`
// best-effort to make it instant) and the running window matches via
// `StartupWMClass=koven-desktop` — that string matches GTK's default
// WM_CLASS (the binary name, set from `g_get_prgname()` at GTK init).
//
// Only runs when `$APPIMAGE` is set, which AppImageKit exports for
// every AppImage launch.  .deb / .rpm installs already ship their own
// system-level `.desktop` file via the bundler — running this on top
// would just duplicate it user-locally (XDG would prefer the user
// copy, which is harmless but pointless), so we skip.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

// Icon basename used in the .desktop file's `Icon=` line AND the
// installed icon file's name.  Matches the binary name so it lines
// up with what the .deb bundler installs — easier to reason about
// when both formats coexist on one machine.
const ICON_NAME: &str = "koven-desktop";

// `.desktop` file basename.  Mirrors the .deb's install path so a
// user with both formats sees one entry, not two — and our user-local
// copy correctly overrides any stale system copy after an AppImage
// auto-update.
const DESKTOP_FILE_NAME: &str = "koven-desktop.desktop";

// Each tuple: (hicolor size dir, embedded PNG bytes).  We embed at
// compile time so the integration step has no runtime file deps —
// the icons aren't reachable on disk anyway once we're running from
// an AppImage mount (paths inside `/tmp/.mount_XXXX/...` vanish as
// soon as the AppImage exits).
const ICONS: &[(&str, &[u8])] = &[
	("32x32",   include_bytes!("../../icons/32x32.png")),
	("64x64",   include_bytes!("../../icons/64x64.png")),
	("128x128", include_bytes!("../../icons/128x128.png")),
	("256x256", include_bytes!("../../icons/256x256.png")),
	("512x512", include_bytes!("../../icons/512x512.png")),
];

/// Top-level entry: run from `setup()` on Linux.  No-op on every
/// non-AppImage launch (dev `cargo tauri dev`, .deb install, ...).
pub fn integrate() {
	let appimage_path = match env::var("APPIMAGE") {
		Ok(p) if !p.is_empty() => PathBuf::from(p),
		_ => {
			log::debug!("desktop integration: not running as AppImage, skipping");
			return;
		}
	};

	let data_home = xdg_data_home();
	if let Err(err) = write_desktop_entry(&data_home, &appimage_path) {
		log::warn!("desktop integration: write .desktop failed: {err}");
		return;
	}
	if let Err(err) = install_icons(&data_home) {
		log::warn!("desktop integration: install icons failed: {err}");
		// Don't return — the .desktop entry alone is still useful even
		// if icons fall back to the generic placeholder.
	}
	refresh_caches(&data_home);
	log::info!(
		"desktop integration: installed {} pointing at {}",
		DESKTOP_FILE_NAME,
		appimage_path.display(),
	);
}

/// Resolve `$XDG_DATA_HOME`, falling back to `$HOME/.local/share` per
/// the XDG Base Directory spec.  Returns an absolute path that may
/// not exist yet — callers should `create_dir_all` on subpaths.
fn xdg_data_home() -> PathBuf {
	if let Ok(p) = env::var("XDG_DATA_HOME") {
		if !p.is_empty() {
			return PathBuf::from(p);
		}
	}
	let home = env::var("HOME").unwrap_or_else(|_| "/tmp".into());
	PathBuf::from(home).join(".local/share")
}

fn write_desktop_entry(data_home: &PathBuf, appimage_path: &PathBuf) -> std::io::Result<()> {
	let dir = data_home.join("applications");
	fs::create_dir_all(&dir)?;
	let path = dir.join(DESKTOP_FILE_NAME);

	// `Exec=` must be the absolute AppImage path so a click from the
	// menu re-launches the same binary the user opened.  After an
	// auto-update the path may change (the updater swaps the file in
	// place but the integrity-checking AppImage runtime occasionally
	// remounts under a new `/tmp/.mount_*` prefix) — re-writing on
	// every launch keeps the entry current.
	//
	// `%U` lets the entry accept URL args from the OS deep-link
	// handler so `koven://...` clicks from other apps land here.
	//
	// `StartupWMClass=koven-desktop` matches GTK's default WM_CLASS
	// (g_get_prgname() returns the binary basename), so the WM can
	// associate the running window with this entry — without that
	// match, GNOME shows a SECOND, unpinnable entry for the live
	// window alongside the menu entry, which is the symptom users
	// see.  If we ever set an explicit GTK app_id via tao's
	// WindowBuilderExtUnix::with_app_id, update this string to match.
	let exec = appimage_path.to_string_lossy();
	let contents = format!(
		"[Desktop Entry]\n\
		 Type=Application\n\
		 Name=Koven\n\
		 Comment=Consensus-governed chat\n\
		 Exec=\"{exec}\" %U\n\
		 Icon={ICON_NAME}\n\
		 Terminal=false\n\
		 Categories=Network;InstantMessaging;\n\
		 StartupNotify=true\n\
		 StartupWMClass=koven-desktop\n\
		 MimeType=x-scheme-handler/koven;\n",
	);
	fs::write(&path, contents)?;
	// chmod 0644 — `.desktop` entries must be world-readable but not
	// executable; some WMs reject entries with the +x bit set.
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o644));
	}
	Ok(())
}

fn install_icons(data_home: &PathBuf) -> std::io::Result<()> {
	let base = data_home.join("icons/hicolor");
	for (size, bytes) in ICONS {
		let dir = base.join(size).join("apps");
		fs::create_dir_all(&dir)?;
		fs::write(dir.join(format!("{ICON_NAME}.png")), bytes)?;
	}
	Ok(())
}

/// Best-effort cache refresh so the new entry shows up in the menu
/// immediately rather than after the next login.  Both commands are
/// no-ops if the cache is already current and silently absent on
/// distros that don't ship the tooling — failures are logged at debug
/// because they're cosmetic, not load-bearing.
fn refresh_caches(data_home: &PathBuf) {
	let apps = data_home.join("applications");
	let icons = data_home.join("icons/hicolor");
	let _ = Command::new("update-desktop-database")
		.arg(&apps)
		.status()
		.map_err(|e| log::debug!("update-desktop-database not available: {e}"));
	let _ = Command::new("gtk-update-icon-cache")
		.arg("-q")
		.arg("-t")
		.arg("-f")
		.arg(&icons)
		.status()
		.map_err(|e| log::debug!("gtk-update-icon-cache not available: {e}"));
}

// Prevents an extra terminal window from spawning behind the Tauri
// app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
	koven_desktop_lib::run();
}

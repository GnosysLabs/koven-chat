// Last-resort recovery from a broken client state.
//
// Surfaced via the "Wipe local cache and restart" button on App's
// bootError screen.  Distinct from the normal sign-out path because
// the normal path itself depends on IndexedDB being usable — when
// WebKit can't open the IDB database file at all (the "DomException
// UnknownError (0): Unable to establish IDB database file" symptom
// most commonly seen on Linux + WebKitGTK after a stuck storage-
// process lock from a prior crash), sign-out's `transport.stop()`
// can't actually drop the bad state because every IDB call hangs or
// errors.  This module bypasses IDB entirely on the desktop branch
// and goes through Rust to nuke the WebView data dir on disk.

interface TauriInternals {
	__TAURI_INTERNALS__?: unknown;
}

function isTauri(): boolean {
	return typeof window !== "undefined"
		&& !!(window as unknown as TauriInternals).__TAURI_INTERNALS__;
}

/**
 * Wipe every piece of client-side state we have access to and then
 * either exit (desktop) or reload (web).  The user has to sign back
 * in afterwards — there's nothing left to remember them by, which
 * is the entire point.
 *
 * Returns void; on success the page is either gone (desktop exit)
 * or replaced (web reload).  Any return from this function is the
 * unhappy path — desktop IPC failure or web reload race — and the
 * caller surfaces the error string back to the user.
 *
 * **Desktop branch.**  Invokes the Rust `wipe_local_cache_and_exit`
 * command, which deletes `app_local_data_dir()` and `app_cache_dir()`
 * via `std::fs::remove_dir_all` (best-effort per-entry, no aborts
 * on individual lock failures), then exits the process on a 200 ms
 * background thread so the IPC reply has time to flush back here
 * first.  The user has to relaunch the AppImage / .app / .exe
 * manually — Tauri 2's restart API behaves too differently across
 * platforms to lean on, and a clean exit-and-reopen sidesteps any
 * in-flight WebView teardown that could re-create the bad state.
 *
 * **Web branch.**  Best-effort wipe inside the page itself:
 *   1. `indexedDB.databases()` enumeration (when supported — falls
 *      through to a hardcoded list of matrix-js-sdk DB names for
 *      older Firefox), then `deleteDatabase` for each.
 *   2. `localStorage.clear()` + `sessionStorage.clear()`.
 *   3. Unregister every service worker registration (the SPA doesn't
 *      ship one today, but this is forward-defence — if a future
 *      release introduces SWs, an old one cached on a user's machine
 *      shouldn't survive the wipe).
 *   4. `location.reload()` once the wipes have settled.
 *
 * The web branch can't reliably wipe cookies (HttpOnly cookies set
 * by Synapse are inaccessible from JS).  Acceptable — the cookie
 * just carries the bearer token, which is invalidated server-side
 * when the user signs in again on the fresh page.
 */
export async function wipeLocalCacheAndRestart(): Promise<void> {
	if (isTauri()) {
		// Desktop: delegate to Rust.  On success this function never
		// returns — the Rust side exits the process on a brief delay.
		//
		// Fallback for old shells.  Desktop installs predating the
		// 0.21.1 build don't have the `wipe_local_cache_and_exit`
		// command registered, so the invoke rejects with an "unknown
		// command" error.  We can't tell the user "update the app
		// first" — they're stuck on the bootError screen, the whole
		// reason they hit this button is that the app won't even
		// start.  Catch the missing-command case and fall through to
		// the web-style in-page wipe (IDB + localStorage + reload).
		// The disk-level wipe is more thorough (cookies, service
		// worker cache, on-disk SQLite WAL files), but the in-page
		// path is still enough to recover most cases on an old
		// shell; on a freshly-installed shell with the command
		// present we always take the disk path.
		try {
			const { invoke } = await import("@tauri-apps/api/core");
			await invoke<void>("wipe_local_cache_and_exit");
			return;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			// Tauri 2 surfaces unknown commands as a string containing
			// "command ... not found" — pattern-match loosely so we
			// catch dialect differences across plugin versions.
			const looksLikeMissingCommand = /not found|unknown command|wipe_local_cache_and_exit/i.test(msg);
			if (!looksLikeMissingCommand) {
				// Real Rust-side failure — propagate so the UI shows
				// it instead of silently dropping into an in-page
				// wipe that pretends it worked.
				throw e;
			}
			// Fall through to the web path.
			console.warn(
				"wipeLocalCacheAndRestart: Rust command unavailable on this desktop shell, "
				+ "falling back to in-page wipe — disk-level WebView data dir will NOT be cleared. "
				+ "Update the desktop app to a newer build for the full wipe path.",
			);
		}
	}

	// Web (or desktop fallback when the Rust command isn't there):
	// best-effort, in-page wipe.

	// Step 1 — IndexedDB.  Skip cleanly if the runtime doesn't expose
	// the API (older browser, or a Tauri sandbox that disabled it).
	if (typeof indexedDB !== "undefined") {
		let names: string[] = [];
		try {
			const dbs = await (indexedDB as unknown as { databases?(): Promise<{ name?: string }[]> })
				.databases?.() ?? [];
			names = dbs
				.map(d => d.name)
				.filter((n): n is string => typeof n === "string" && n.length > 0);
		} catch {
			// fall through to the hardcoded list
		}
		if (names.length === 0) {
			// matrix-js-sdk's known store names.  Aligned with
			// wipeAllMatrixIndexedDB() in matrix.ts — keep in sync if
			// either changes.
			names = [
				"matrix-js-sdk::matrix-sdk-crypto",
				"matrix-js-sdk::matrix-sdk-crypto-meta",
				"matrix-js-sdk:crypto",
				"matrix-js-sdk:riot-web-sync",
				"matrix-js-sdk:default",
			];
		}
		await Promise.all(names.map(name => new Promise<void>(resolve => {
			try {
				const req = indexedDB.deleteDatabase(name);
				req.onsuccess = () => resolve();
				req.onerror = () => resolve(); // best-effort
				req.onblocked = () => resolve(); // best-effort
				// Defensive 5s ceiling so a stuck delete doesn't
				// strand the wipe — the reload at the end will give
				// us a clean process either way.
				setTimeout(() => resolve(), 5_000);
			} catch {
				resolve();
			}
		})));
	}

	// Step 2 — localStorage + sessionStorage.  Synchronous, fast,
	// can't fail in any way that matters here.
	try { localStorage.clear(); } catch { /* ignore */ }
	try { sessionStorage.clear(); } catch { /* ignore */ }

	// Step 3 — service workers.  Forward-defence; we don't register
	// one today, but if a future release ships one and we ever roll
	// it back, an orphaned SW on a user's machine would otherwise
	// survive this wipe.
	if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
		try {
			const regs = await navigator.serviceWorker.getRegistrations();
			await Promise.all(regs.map(r => r.unregister().catch(() => false)));
		} catch {
			// ignore
		}
	}

	// Step 4 — reload.  Use a small delay so the unregister/delete
	// callbacks have a tick to settle in the event loop.
	setTimeout(() => {
		try { location.reload(); } catch { /* ignore */ }
	}, 50);
}

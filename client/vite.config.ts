import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import path from "node:path";

// HTTPS on the dev server is needed for LAN / Tailscale access —
// Web Crypto's `crypto.subtle` (used by matrix-js-sdk for PBKDF2
// recovery keys during encryption setup) is gated to "secure
// contexts."  http://localhost IS a secure context, but
// http://<lan-ip> or http://<tailscale-ip> are NOT.
//
// For the Tauri dev workflow (`bun run desktop:dev`), the WebView
// loads from localhost only — and macOS's WKWebView refuses self-
// signed certs from basicSsl (no warning page, no "proceed anyway"
// option, just a 500 / blank window).  Plain HTTP on localhost
// avoids the cert handshake entirely while still being a secure
// context, so crypto.subtle keeps working.
//
// `KOVEN_DEV_HTTP=1` flips us to HTTP.  The `dev:tauri` script in
// client/package.json sets this; the plain `dev` script doesn't,
// so browser-on-LAN testing still gets HTTPS.
const useHttp = process.env.KOVEN_DEV_HTTP === "1";

export default defineConfig({
	plugins: [
		react(),
		...(useHttp ? [] : [basicSsl()]),
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	// matrix-sdk-crypto-wasm ships a .wasm binary it loads at runtime
	// via import.meta.url.  Vite's dep pre-bundler rewrites the import
	// paths and the wasm fails to resolve, so initRustCrypto() throws
	// the moment it runs.  Excluding the package from pre-bundling
	// lets Vite serve the .wasm directly alongside the .mjs entry.
	optimizeDeps: {
		exclude: ["@matrix-org/matrix-sdk-crypto-wasm", "@capacitor/keyboard", "@capacitor/haptics"],
	},
	build: {
		rollupOptions: {
			// `@capacitor/*` plugins are only present in the Capacitor
			// iOS / Android bundles (loaded from
			// `koven-ios/node_modules`).  Web + Tauri desktop never
			// resolve them; the dynamic `import()`s in `nativeShell.ts`
			// + `haptics.ts` are wrapped in try/catch so the runtime
			// failures are silent.  Marking them external prevents
			// Rollup from aborting the build because it can't find the
			// module.
			external: ["@capacitor/keyboard", "@capacitor/haptics"],
		},
	},
	server: {
		// 1420 is Tauri's convention.  Pre-empts most random-Vite-on-
		// 5173 collisions and keeps the URL stable across machines so
		// `tauri.conf.json`'s devUrl is reliably valid.  Tauri's
		// CLI documentation defaults to this port for the same reason.
		port: 1420,
		// Fail loudly if the port's taken — the previous "auto-switch
		// to next free port" behaviour caused a silent bug where Vite
		// landed on 5174 but Tauri's devUrl still pointed at 5173,
		// producing a 500 / blank window with no error.  Better to
		// crash the dev command and surface "kill whatever has 1420"
		// than to half-start.
		strictPort: true,
		// Bind to all interfaces so the dev server is reachable from
		// other devices on the LAN / Tailnet (e.g. testing the mobile
		// layout from a phone via Tailscale).
		host: true,
		// Same-origin proxy.  The frontend is HTTPS but the engine
		// (port 9000) and Synapse (port 8008) speak plain HTTP — a
		// browser on an HTTPS page won't fetch HTTP resources from a
		// different port (mixed-content blocking).  Routing every
		// backend request through Vite's HTTPS origin sidesteps that
		// entirely: the client makes relative-URL requests, Vite
		// terminates TLS, then connects to the local HTTP services.
		proxy: {
			"/api":      { target: "http://localhost:9000", changeOrigin: true },
			"/static":   { target: "http://localhost:9000", changeOrigin: true },
			"/_matrix":  { target: "http://localhost:8008", changeOrigin: true, ws: true },
			"/_synapse": { target: "http://localhost:8008", changeOrigin: true },
		},
	},
});

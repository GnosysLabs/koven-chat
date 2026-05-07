import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import path from "node:path";

export default defineConfig({
	plugins: [
		react(),
		// HTTPS on the dev server.  Web Crypto API's `crypto.subtle`
		// — used by matrix-js-sdk for PBKDF2-derived recovery keys
		// during encryption setup — is gated to "secure contexts".
		// http://localhost is a secure context, but http://<lan-ip>
		// or http://<tailscale-ip> are NOT, and the browser disables
		// crypto.subtle on those origins.  That manifests as
		// "Password-based backup is not available on this platform"
		// the moment a user signs up over the network.  HTTPS makes
		// every origin a secure context.
		//
		// basicSsl auto-generates a self-signed cert.  Users see a
		// "your connection isn't private" warning once per browser
		// per origin and accept; afterwards encryption setup works
		// from any device on the network.  For a smoother dev story
		// (no warnings) install mkcert and swap to a CA-signed cert.
		basicSsl(),
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
		exclude: ["@matrix-org/matrix-sdk-crypto-wasm"],
	},
	server: {
		port: 5173,
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

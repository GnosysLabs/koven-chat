// Surgical Node-globals shim, applied before React mounts.  Only
// `Buffer` is genuinely needed — matrix-js-sdk uses it in places that
// don't tolerate undefined.  We deliberately do NOT use
// vite-plugin-node-polyfills: its broader Node-module shims (crypto,
// stream, util) interfere with WASM ↔ JS string marshaling in
// matrix-sdk-crypto-wasm, manifesting as "Unexpected end of JSON
// input" inside receiveSyncChanges and breaking the encrypted sync
// loop.
import { Buffer } from "buffer";
const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (typeof g.Buffer === "undefined") {
	g.Buffer = Buffer;
}

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);

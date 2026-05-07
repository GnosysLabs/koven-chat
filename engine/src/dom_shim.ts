// Minimal browser-API shim so matrix-js-sdk runs server-side in Bun.
// Imported for side-effects from any module that ends up loading the
// SDK (bot_runtime.ts).  Idempotent.
//
// We need:
//   - IndexedDB (used by rust-crypto-wasm + the SDK's sync store).
//     Provided by `fake-indexeddb`.  In-memory for now; persistence
//     comes via a SQLite-backed adapter we'll layer in chunk 2b.
//   - localStorage (used by some SDK paths as a hint cache).
//     Tiny in-memory Map shim is sufficient.
//   - WebSocket / fetch / WebCrypto are already native in Bun.

import { indexedDB, IDBKeyRange } from "fake-indexeddb";

const g = globalThis as unknown as {
	indexedDB?: unknown;
	IDBKeyRange?: unknown;
	localStorage?: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void; clear: () => void; key: (i: number) => string | null; readonly length: number };
};

if (!g.indexedDB) g.indexedDB = indexedDB;
if (!g.IDBKeyRange) g.IDBKeyRange = IDBKeyRange;

if (!g.localStorage) {
	const store = new Map<string, string>();
	g.localStorage = {
		getItem: (k) => store.has(k) ? store.get(k)! : null,
		setItem: (k, v) => { store.set(k, String(v)); },
		removeItem: (k) => { store.delete(k); },
		clear: () => { store.clear(); },
		key: (i) => Array.from(store.keys())[i] ?? null,
		get length() { return store.size; },
	};
}

// Snapshot / restore for fake-indexeddb databases.
//
// The matrix-js-sdk rust-crypto layer keeps device identity, megolm
// sessions, OTKs, etc. in IndexedDB.  In Bun we polyfill that with
// fake-indexeddb (see dom_shim.ts) which is in-memory: every restart
// would otherwise hand the bot a fresh device key, conflicting with
// the device row Synapse already has on file.
//
// To get restart-safe crypto without pulling in a native IDB-on-disk
// dependency, we snapshot the bot's databases to a JSON file on disk
// after meaningful state changes and hydrate them back into the
// shared global IDB factory on startup.  The snapshot walks the
// public IDB API only (cursor + getAll), so it's stable against
// fake-indexeddb internal changes.
//
// Each bot gets its own store prefix (`koven-bot-<id>`), so multiple
// bots can share a single global IDB factory without their crypto
// state colliding — see `init_rust_crypto.ts` for the prefix wiring.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface IndexSnapshot {
	name: string;
	keyPath: string | string[] | null;
	unique: boolean;
	multiEntry: boolean;
}

interface StoreSnapshot {
	keyPath: string | string[] | null;
	autoIncrement: boolean;
	indexes: IndexSnapshot[];
	records: Array<{ key: unknown; value: unknown }>;
}

export interface DbSnapshot {
	name: string;
	version: number;
	stores: Record<string, StoreSnapshot>;
}

/** Walk every database whose name begins with `${prefix}::` (the
 * convention rust-crypto-wasm uses) and return a deep snapshot. */
export async function snapshotByPrefix(idb: IDBFactory, prefix: string): Promise<DbSnapshot[]> {
	const all = await idb.databases();
	const out: DbSnapshot[] = [];
	for (const info of all) {
		if (!info.name) continue;
		if (info.name !== prefix && !info.name.startsWith(`${prefix}::`) && !info.name.startsWith(`${prefix}:`)) continue;
		const db = await openExisting(idb, info.name);
		try {
			const storeNames = Array.from(db.objectStoreNames);
			const stores: Record<string, StoreSnapshot> = {};
			if (storeNames.length > 0) {
				const tx = db.transaction(storeNames, "readonly");
				const txDone = waitForTx(tx);
				for (const sn of storeNames) {
					const os = tx.objectStore(sn);
					const indexes: IndexSnapshot[] = [];
					for (const iname of Array.from(os.indexNames)) {
						const idx = os.index(iname);
						indexes.push({
							name: iname,
							keyPath: idx.keyPath as unknown as string | string[],
							unique: idx.unique,
							multiEntry: idx.multiEntry,
						});
					}
					const records = await readAllRecords(os);
					stores[sn] = {
						keyPath: os.keyPath as unknown as string | string[] | null,
						autoIncrement: os.autoIncrement,
						indexes,
						records,
					};
				}
				await txDone;
			}
			out.push({
				name: info.name,
				version: db.version,
				stores,
			});
		} finally {
			db.close();
		}
	}
	return out;
}

/** Replay snapshots into an empty IDB factory.  Skips databases
 * that already exist with the same or higher version (idempotent on
 * partial restores). */
export async function restoreSnapshots(idb: IDBFactory, snapshots: DbSnapshot[]): Promise<void> {
	for (const snap of snapshots) {
		await restoreOne(idb, snap);
	}
}

async function restoreOne(idb: IDBFactory, snap: DbSnapshot): Promise<void> {
	// Open at the snapshot's version with onupgradeneeded creating
	// the schema, then write records in a separate transaction.
	const db: IDBDatabase = await new Promise((resolve, reject) => {
		const req = idb.open(snap.name, snap.version);
		req.onupgradeneeded = () => {
			const created = req.result;
			for (const [sn, sd] of Object.entries(snap.stores)) {
				const opts: IDBObjectStoreParameters = {};
				if (sd.keyPath !== null) opts.keyPath = sd.keyPath;
				if (sd.autoIncrement) opts.autoIncrement = true;
				const os = created.createObjectStore(sn, opts);
				for (const idx of sd.indexes) {
					os.createIndex(idx.name, idx.keyPath as string | string[], {
						unique: idx.unique,
						multiEntry: idx.multiEntry,
					});
				}
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
		req.onblocked = () => reject(new Error(`open blocked: ${snap.name}`));
	});

	try {
		const storeNames = Object.keys(snap.stores);
		if (storeNames.length === 0) return;
		const tx = db.transaction(storeNames, "readwrite");
		const txDone = waitForTx(tx);
		for (const sn of storeNames) {
			const sd = snap.stores[sn]!;
			if (sd.records.length === 0) continue;
			const os = tx.objectStore(sn);
			for (const rec of sd.records) {
				if (sd.keyPath !== null) {
					// In-line keys: the value carries its own key.
					os.put(rec.value);
				} else {
					os.put(rec.value, rec.key as IDBValidKey);
				}
			}
		}
		await txDone;
	} finally {
		db.close();
	}
}

function openExisting(idb: IDBFactory, name: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		// No version arg → opens current version, never upgrades.
		const req = idb.open(name);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function waitForTx(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
	});
}

function readAllRecords(os: IDBObjectStore): Promise<Array<{ key: unknown; value: unknown }>> {
	return new Promise((resolve, reject) => {
		const out: Array<{ key: unknown; value: unknown }> = [];
		const req = os.openCursor();
		req.onsuccess = () => {
			const cursor = req.result;
			if (cursor) {
				out.push({ key: cursor.key, value: cursor.value });
				cursor.continue();
			} else {
				resolve(out);
			}
		};
		req.onerror = () => reject(req.error);
	});
}

// ─── On-disk JSON file ─────────────────────────────────────────────

/** Snapshot the prefix's databases and write to disk atomically.
 * Skips entirely if the snapshot is empty (no databases yet). */
export async function persistSnapshot(idb: IDBFactory, prefix: string, path: string): Promise<void> {
	const snaps = await snapshotByPrefix(idb, prefix);
	if (snaps.length === 0) return;
	const tmp = `${path}.tmp`;
	await mkdir(dirname(path), { recursive: true });
	const json = jsonStringify(snaps);
	await writeFile(tmp, json, "utf8");
	await rename(tmp, path);
}

/** Read the JSON snapshot file and replay into the IDB factory.
 * No-op if the file doesn't exist (fresh bot). */
export async function loadSnapshot(idb: IDBFactory, path: string): Promise<boolean> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw err;
	}
	const snaps = jsonParse(raw) as DbSnapshot[];
	await restoreSnapshots(idb, snaps);
	return true;
}

// ─── (de)serialisation ─────────────────────────────────────────────
// IndexedDB records contain Uint8Array (rust-crypto stores ciphertext
// as bytes) and Date and other structuredClone-able types that JSON
// doesn't natively round-trip.  We tag those with a `__t` discriminator
// and decode on the way back in.

function jsonStringify(value: unknown): string {
	return JSON.stringify(value, (_k, v) => {
		if (v instanceof Uint8Array) return { __t: "u8", d: bytesToBase64(v) };
		if (v instanceof ArrayBuffer) return { __t: "ab", d: bytesToBase64(new Uint8Array(v)) };
		if (v instanceof Date) return { __t: "date", d: v.toISOString() };
		return v;
	});
}

function jsonParse(text: string): unknown {
	return JSON.parse(text, (_k, v) => {
		if (v && typeof v === "object" && "__t" in v) {
			const tag = (v as { __t: string }).__t;
			const data = (v as { d: string }).d;
			if (tag === "u8") return base64ToBytes(data);
			if (tag === "ab") return base64ToBytes(data).buffer;
			if (tag === "date") return new Date(data);
		}
		return v;
	});
}

function bytesToBase64(b: Uint8Array): string {
	// Bun's btoa supports arbitrary binary strings; build one cheaply.
	let s = "";
	for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
	return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
	const bin = atob(s);
	const b = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
	return b;
}

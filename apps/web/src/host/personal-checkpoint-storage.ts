import { utf8ByteLength } from "@opensteer/core";
import {
  checkpointFence,
  noCheckpointFences,
  raiseCheckpointFence,
  type CheckpointFences,
  type CheckpointStorage,
} from "@opensteer/client/host";

const values = "checkpoints";
const index = "index";
const fenceStore = "fences";
const fenceKey = "fences";
type Entry = { readonly savedAt: number; readonly bytes: number };
type Stores = { values: IDBObjectStore; index: IDBObjectStore; fences: IDBObjectStore };

/**
 * Saved personal checkpoints in IndexedDB, one record per scope. Each write puts the value and its
 * index row in one transaction, so it lands whole or not at all; windows sharing the origin share
 * the database and never rewrite each other's scopes. The same transaction reads the fences, so a
 * write from a window that missed another window's clear never lands after it.
 */
export function indexedDbCheckpointStorage(name: string): CheckpointStorage {
  let opened: Promise<IDBDatabase> | null = null;
  const database = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      // Named before it can exist, so a later format can find it without enumeration.
      registerCheckpointDatabase(name);
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(values);
        request.result.createObjectStore(index);
        request.result.createObjectStore(fenceStore);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Saved state is busy."));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opened = null;
        };
        resolve(db);
      };
    }).catch((error: unknown) => {
      opened = null;
      throw error;
    }));
  const run = async <T>(
    mode: IDBTransactionMode,
    work: (stores: Stores) => () => T,
  ): Promise<T> => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction([values, index, fenceStore], mode);
      const result = work({
        values: transaction.objectStore(values),
        index: transaction.objectStore(index),
        fences: transaction.objectStore(fenceStore),
      });
      transaction.oncomplete = () => resolve(result());
      transaction.onerror = transaction.onabort = () =>
        reject(transaction.error ?? new Error("Saved state failed."));
    });
  };
  /** Runs `then` with the fences this transaction read. */
  const withFences = (stores: Stores, then: (fences: CheckpointFences) => void) => {
    const request = stores.fences.get(fenceKey);
    request.onsuccess = () =>
      then((request.result as CheckpointFences | undefined) ?? noCheckpointFences);
  };
  return {
    list: () =>
      run("readonly", (stores) => {
        const keys = stores.index.getAllKeys();
        const entries = stores.index.getAll();
        return () =>
          keys.result.flatMap((key, position) => {
            const entry = entries.result[position] as Entry | undefined;
            return typeof key === "string" && entry
              ? [{ key, savedAt: entry.savedAt, bytes: entry.bytes }]
              : [];
          });
      }),
    read: (key) =>
      run("readonly", (stores) => {
        const request = stores.values.get(key);
        return () => (typeof request.result === "string" ? request.result : null);
      }),
    fences: () =>
      run("readonly", (stores) => {
        const request = stores.fences.get(fenceKey);
        return () => (request.result as CheckpointFences | undefined) ?? noCheckpointFences;
      }),
    write: (key, value, guard) =>
      run("readwrite", (stores) => {
        let written = false;
        withFences(stores, (fences) => {
          if (checkpointFence(fences, guard) !== guard.fence) return;
          written = true;
          stores.values.put(value, key);
          stores.index.put(
            { savedAt: Date.now(), bytes: utf8ByteLength(value) } satisfies Entry,
            key,
          );
        });
        return () => written;
      }),
    remove: (keys) =>
      run("readwrite", (stores) => {
        for (const key of keys) {
          stores.values.delete(key);
          stores.index.delete(key);
        }
        return () => undefined;
      }),
    clear: (matches, scope) =>
      run("readwrite", (stores) => {
        const listed = stores.index.getAllKeys();
        listed.onsuccess = () => {
          for (const key of listed.result)
            if (typeof key !== "string" || matches(key)) {
              stores.values.delete(key);
              stores.index.delete(key);
            }
        };
        withFences(stores, (fences) =>
          stores.fences.put(raiseCheckpointFence(fences, scope), fenceKey),
        );
        return () => undefined;
      }),
  };
}

export const checkpointDatabasePrefix = "opensteer-personal-stream-v";

/** The saved-state database for one Host origin, in this format. */
export function checkpointDatabaseName(format: number, origin: string) {
  return `${checkpointDatabasePrefix}${format}:${origin}`;
}

/** Where this origin lists the saved-state databases it has opened. */
const registryKey = "opensteer.personal-stream.databases";

function readRegistry(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(registryKey) ?? "[]");
    return Array.isArray(value) ? value.filter((name) => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function writeRegistry(names: readonly string[]) {
  try {
    window.localStorage.setItem(registryKey, JSON.stringify([...new Set(names)]));
  } catch {
    // Without storage the database still opens; only cleanup falls back to the other sources.
  }
}

function registerCheckpointDatabase(name: string) {
  const held = readRegistry();
  if (!held.includes(name)) writeRegistry([...held, name]);
}

function formatOf(name: string) {
  return name.startsWith(checkpointDatabasePrefix)
    ? Number.parseInt(name.slice(checkpointDatabasePrefix.length), 10)
    : Number.NaN;
}

/**
 * Deletes every saved-state database of another format; none is migrated. They are found three
 * ways, so no one of them failing keeps one: the names this origin registered before opening
 * them, the names an earlier format would have used for `origin`, and the browser's own listing
 * where it has one.
 */
export async function dropOtherCheckpointFormats(format: number, origin: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const listed =
    typeof indexedDB.databases === "function"
      ? await indexedDB.databases().then(
          (databases) => databases.flatMap(({ name }) => (name ? [name] : [])),
          () => [],
        )
      : [];
  const earlier = Array.from({ length: Math.max(0, format - 65) }, (_, index) =>
    checkpointDatabaseName(65 + index, origin),
  );
  const doomed = [...new Set([...readRegistry(), ...listed, ...earlier])].filter((name) => {
    const version = formatOf(name);
    return Number.isFinite(version) && version !== format;
  });
  await Promise.all(
    doomed.map(
      (name) =>
        new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => {
            writeRegistry(readRegistry().filter((held) => held !== name));
            resolve();
          };
          request.onerror = request.onblocked = () => resolve();
        }),
    ),
  );
}

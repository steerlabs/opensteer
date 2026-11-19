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

/** Deletes every saved-state database of another format, for every origin; none is migrated. */
export async function dropOtherCheckpointFormats(format: number): Promise<void> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return;
  const held = await indexedDB.databases().catch(() => []);
  for (const { name } of held) {
    const version = name?.startsWith(checkpointDatabasePrefix)
      ? Number.parseInt(name.slice(checkpointDatabasePrefix.length), 10)
      : Number.NaN;
    if (name && Number.isFinite(version) && version !== format) indexedDB.deleteDatabase(name);
  }
}

import { utf8ByteLength } from "@opensteer/core";
import type { CheckpointStorage } from "@opensteer/client/host";

const values = "checkpoints";
const index = "index";
type Entry = { readonly savedAt: number; readonly bytes: number };

/**
 * Saved personal checkpoints in IndexedDB, one record per scope. Each write puts the value and its
 * index row in one transaction, so it lands whole or not at all; windows sharing the origin share
 * the database and never rewrite each other's scopes.
 */
export function indexedDbCheckpointStorage(name: string): CheckpointStorage {
  let opened: Promise<IDBDatabase> | null = null;
  const database = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(values);
        request.result.createObjectStore(index);
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
    work: (stores: { values: IDBObjectStore; index: IDBObjectStore }) => () => T,
  ): Promise<T> => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction([values, index], mode);
      const result = work({
        values: transaction.objectStore(values),
        index: transaction.objectStore(index),
      });
      transaction.oncomplete = () => resolve(result());
      transaction.onerror = transaction.onabort = () =>
        reject(transaction.error ?? new Error("Saved state failed."));
    });
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
    write: (key, value) =>
      run("readwrite", (stores) => {
        stores.values.put(value, key);
        stores.index.put(
          { savedAt: Date.now(), bytes: utf8ByteLength(value) } satisfies Entry,
          key,
        );
        return () => undefined;
      }),
    remove: (keys) =>
      run("readwrite", (stores) => {
        for (const key of keys) {
          stores.values.delete(key);
          stores.index.delete(key);
        }
        return () => undefined;
      }),
  };
}

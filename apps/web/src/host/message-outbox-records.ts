import type { MessageRecordStorage } from "@opensteer/client/host";

let opened: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  if (opened) return opened;
  opened = new Promise((resolve, reject) => {
    const request = indexedDB.open("opensteer-message-outbox", 1);
    let failed = false;
    request.onupgradeneeded = () => request.result.createObjectStore("scopes");
    request.onerror = () => {
      failed = true;
      opened = null;
      reject(request.error);
    };
    request.onblocked = () => {
      failed = true;
      opened = null;
      reject(new Error("Message storage is busy."));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        opened = null;
      };
      resolve(db);
    };
  });
  return opened;
}
export function browserMessageRecords(): MessageRecordStorage {
  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel("opensteer-message-outbox");
  const mutate = async (
    key: string,
    change: (raw: string | null) => string | null,
  ): Promise<void> => {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("scopes", "readwrite", { durability: "strict" });
      const store = transaction.objectStore("scopes");
      let failure: unknown;
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          const raw: unknown = request.result;
          if (raw !== undefined && typeof raw !== "string")
            throw new Error("Message storage is invalid.");
          const value = change(raw ?? null);
          if (value === null) store.delete(key);
          else store.put(value, key);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () =>
        reject(failure ?? transaction.error ?? new Error("Message storage failed."));
    });
    channel?.postMessage(key);
  };
  return {
    async read(key) {
      const db = await database();
      return new Promise((resolve, reject) => {
        const request = db.transaction("scopes", "readonly").objectStore("scopes").get(key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const value: unknown = request.result;
          if (value === undefined) resolve(null);
          else if (typeof value === "string") resolve(value);
          else reject(new Error("Message storage is invalid."));
        };
      });
    },
    mutate,
    write: (key, value) => mutate(key, () => value),
    remove: (key) => mutate(key, () => null),
    ...(globalThis.navigator?.locks
      ? {
          exclusive: <T>(key: string, work: () => Promise<T>) =>
            navigator.locks.request(`opensteer:${key}`, work),
        }
      : {}),
    subscribe(listener) {
      const changed = () => listener();
      const legacyChanged = (event: StorageEvent) => {
        if (event.key?.startsWith("opensteer:pending-send:")) listener();
      };
      channel?.addEventListener("message", changed);
      window.addEventListener("storage", legacyChanged);
      return () => {
        channel?.removeEventListener("message", changed);
        channel?.close();
        window.removeEventListener("storage", legacyChanged);
      };
    },
  };
}

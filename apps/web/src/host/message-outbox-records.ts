import { ClientOperationError } from "@opensteer/client/connections";
import { KeyedMutationQueue } from "@opensteer/shared/mutationQueue";
import type { ConsumedDraftRevision, MessageRecordStorage } from "@opensteer/client/host";

export const browserDraftHandoffKey = (key: string): string => `draft-handoff:${key}`;

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
  opened = opened.catch((error: unknown) => {
    opened = null;
    throw error;
  });
  return opened;
}
export async function mutateBrowserMessageRecord(
  key: string,
  change: (raw: string | null) => string | null,
  consumedDraft?: ConsumedDraftRevision,
): Promise<boolean> {
  const db = await database();
  let committed = false;
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
        if (value === (raw ?? null)) return;
        committed = true;
        if (value === null) store.delete(key);
        else store.put(value, key);
        if (consumedDraft)
          store.put(consumedDraft.revision, browserDraftHandoffKey(consumedDraft.key));
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () =>
      reject(failure ?? transaction.error ?? new Error("Message storage failed."));
  });
  return committed;
}
export async function browserTaskStartKeys(): Promise<string[]> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("scopes", "readonly")
      .objectStore("scopes")
      .getAllKeys(IDBKeyRange.bound("task-start:", "task-start;"));
    request.onerror = () => reject(request.error);
    request.onsuccess = () =>
      resolve(request.result.filter((key): key is string => typeof key === "string"));
  });
}
const localLocks = new KeyedMutationQueue();
const changeSignal = "opensteer:message-outbox:changed";

export function browserMessageRecords({ notify = true } = {}): MessageRecordStorage {
  const locks = globalThis.navigator?.locks;
  const channel =
    !notify || typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel("opensteer-message-outbox");
  const mutate: NonNullable<MessageRecordStorage["mutate"]> = async (
    key,
    change,
    consumedDraft,
  ) => {
    const committed = await mutateBrowserMessageRecord(key, change, consumedDraft);
    if (!committed || !notify) return;
    if (channel) {
      try {
        channel.postMessage(key);
        return;
      } catch {}
    }
    try {
      globalThis.localStorage?.setItem(changeSignal, globalThis.crypto.randomUUID());
    } catch {}
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
    exclusive: (key, work) => locks?.request(`opensteer:${key}`, work) ?? localLocks.run(key, work),
    subscribe(listener) {
      const changed = () => listener();
      const legacyChanged = (event: StorageEvent) => {
        if (event.key === changeSignal || event.key?.startsWith("opensteer:pending-send:"))
          listener();
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

/** No outbox could be opened in this browser, so nothing is kept or sent. */
export function storageUnavailable(): ClientOperationError {
  return new ClientOperationError("Message storage is unavailable.", "blocked", {
    kind: "local",
    provenance: "local",
    reason: "storage-unavailable",
    retryable: false,
  });
}

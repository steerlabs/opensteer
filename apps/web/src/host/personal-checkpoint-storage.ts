import { utf8ByteLength } from "@opensteer/core";
import {
  checkpointFence,
  checkpointKeyDeployment,
  noCheckpointFences,
  raiseCheckpointFence,
  type CheckpointFences,
  type CheckpointStorage,
  type HostSnapshot,
} from "@opensteer/client/host";

const values = "checkpoints";
const index = "index";
const fenceStore = "fences";
const fenceKey = "fences";
type Entry = { readonly savedAt: number; readonly bytes: number; readonly session: string };
type Stores = { values: IDBObjectStore; index: IDBObjectStore; fences: IDBObjectStore };

/**
 * The session this origin's client holds now for a Deployment, or null when it holds none. On the
 * web the session cookie is out of the page's reach, so this is the Host-confirmed session the
 * client recorded (`checkpointSessionMarker`), cleared when the session ends and treated as ended
 * once it may have expired.
 */
export type CurrentCheckpointSession = (deploymentId: string) => string | null;

export interface IndexedDbCheckpointStorage extends CheckpointStorage {
  /** Deletes, now, every entry not saved under its Deployment's current session. */
  sweep(): Promise<void>;
}

/**
 * Saved personal checkpoints in IndexedDB, one record per scope.
 *
 * The invariant: an entry is read, and kept, only for a Deployment this origin holds a current
 * session for, and only under that same session. Each entry records the session it was saved
 * under, in the same transaction as its value and the fence check, so a write from a window that
 * missed another window's clear never lands after it. Every start and every clear deletes the
 * entries of any other session, so a sign-out whose own clear failed leaves nothing readable for
 * the next person and nothing kept past the next start.
 */
export function indexedDbCheckpointStorage(
  name: string,
  currentSession: CurrentCheckpointSession,
  /** Whether this origin holds any current session; without one nothing saved may outlive start. */
  holdsSession: () => boolean = () => true,
): IndexedDbCheckpointStorage {
  let opened: Promise<IDBDatabase> | null = null;
  let started = false;
  const database = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      // Named before it can exist, so a later format can find it without enumeration.
      registerCheckpointDatabase(name);
      // Started with no current session: the database goes before anything can open it. The open
      // below is queued behind the deletion, and other windows close on its version change.
      if (!started && !holdsSession()) indexedDB.deleteDatabase(name);
      started = true;
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
  const sessionOf = (key: string) => {
    const deploymentId = checkpointKeyDeployment(key);
    return deploymentId ? currentSession(deploymentId) : null;
  };
  /** Whether a stored entry belongs to its Deployment's current session. */
  const current = (key: IDBValidKey, entry: unknown) =>
    typeof key === "string" &&
    !!entry &&
    typeof entry === "object" &&
    Reflect.get(entry, "session") === sessionOf(key) &&
    sessionOf(key) !== null;
  /** Deletes, inside this transaction, every entry `doomed` names or that is not current. */
  const sweepIn = (stores: Stores, doomed: (key: string) => boolean) => {
    const keys = stores.index.getAllKeys();
    const entries = stores.index.getAll();
    entries.onsuccess = () =>
      keys.result.forEach((key, position) => {
        if (typeof key === "string" && !doomed(key) && current(key, entries.result[position]))
          return;
        stores.values.delete(key);
        stores.index.delete(key);
      });
  };
  const sweep = () =>
    run("readwrite", (stores) => {
      sweepIn(stores, () => false);
      return () => undefined;
    });
  // The first use deletes whatever another session left behind.
  let swept: Promise<void> | undefined;
  const ready = () =>
    (swept ??= sweep().catch(() => {
      swept = undefined;
    }));
  return {
    sweep,
    list: async () => {
      await ready();
      return run("readonly", (stores) => {
        const keys = stores.index.getAllKeys();
        const entries = stores.index.getAll();
        return () =>
          keys.result.flatMap((key, position) => {
            const entry = entries.result[position] as Entry | undefined;
            return typeof key === "string" && entry && current(key, entry)
              ? [{ key, savedAt: entry.savedAt, bytes: entry.bytes }]
              : [];
          });
      });
    },
    read: async (key) => {
      await ready();
      return run("readonly", (stores) => {
        const value = stores.values.get(key);
        const entry = stores.index.get(key);
        return () =>
          typeof value.result === "string" && current(key, entry.result) ? value.result : null;
      });
    },
    fences: () =>
      run("readonly", (stores) => {
        const request = stores.fences.get(fenceKey);
        return () => (request.result as CheckpointFences | undefined) ?? noCheckpointFences;
      }),
    write: async (key, value, guard) => {
      await ready();
      const session = sessionOf(key);
      // A writer from a session that has since ended (another window's late flush) is refused.
      if (session === null || (guard.session !== undefined && guard.session !== session))
        return false;
      return run("readwrite", (stores) => {
        let written = false;
        withFences(stores, (fences) => {
          if (checkpointFence(fences, guard) !== guard.fence) return;
          // The session is asked again as the write commits: one that ended since it was asked
          // above, even where that sign-out's own clear failed, takes no write.
          if (sessionOf(key) !== session) return;
          written = true;
          stores.values.put(value, key);
          stores.index.put(
            { savedAt: Date.now(), bytes: utf8ByteLength(value), session } satisfies Entry,
            key,
          );
        });
        return () => written;
      });
    },
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
        sweepIn(stores, matches);
        withFences(stores, (fences) =>
          stores.fences.put(raiseCheckpointFence(fences, scope), fenceKey),
        );
        return () => undefined;
      }),
  };
}

const sessionMarkerPrefix = "opensteer.personal-stream.session:";

/**
 * How long a session the Host confirmed may still be current without another confirmation. The
 * session cookie is HttpOnly and the Host's session read carries no expiry, so this is the Host's
 * idle session lifetime (`idleSessionSeconds`, 7 days): a session not used for that long has
 * expired, and every use of it from here is a confirmation that renews the marker. It is never
 * longer than the session's absolute lifetime (30 days).
 */
export const checkpointSessionMaxAgeMs = 7 * 24 * 60 * 60 * 1_000;

/**
 * Records the session this origin's client holds for a Host origin, as and when the Host confirmed
 * it, or clears it when the session ends. Kept apart from IndexedDB, so a sign-out whose IndexedDB
 * clear fails still ends what the saved state may be read under. A marker older than
 * `checkpointSessionMaxAgeMs`, or one dated after now (the clock went back, so its age is
 * unknown), is no session.
 */
export function checkpointSessionMarker(origin: string, now: () => number = Date.now) {
  const key = `${sessionMarkerPrefix}${origin}`;
  const read = (): { deploymentId: string; sessionId: string } | null => {
    try {
      const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
      if (!value || typeof value !== "object") return null;
      const deploymentId = Reflect.get(value, "deploymentId");
      const sessionId = Reflect.get(value, "sessionId");
      const confirmedAt = Reflect.get(value, "confirmedAt");
      const age = typeof confirmedAt === "number" ? now() - confirmedAt : Number.NaN;
      return typeof deploymentId === "string" &&
        typeof sessionId === "string" &&
        age >= 0 &&
        age < checkpointSessionMaxAgeMs
        ? { deploymentId, sessionId }
        : null;
    } catch {
      return null;
    }
  };
  return {
    current: (deploymentId: string): string | null => {
      const held = read();
      return held?.deploymentId === deploymentId ? held.sessionId : null;
    },
    /** Whether any session is current here at all. */
    holds: () => read() !== null,
    held: (deploymentId: string, sessionId: string) => {
      try {
        window.localStorage.setItem(
          key,
          JSON.stringify({ deploymentId, sessionId, confirmedAt: now() }),
        );
      } catch {
        // Without the marker nothing is saved or read: writes need a current session.
      }
    },
    ended: () => {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // A storage that refuses removal is one nothing can be read from either.
      }
    },
  };
}

/** How often a session confirmed again renews its marker; well inside the maximum age. */
const markerRenewalMs = 60 * 60 * 1_000;

/**
 * Keeps the marker to what the client learns of its session. A Host-confirmed connection records
 * or renews it. Every way the client learns the session ended reaches `authentication-required`:
 * a 401 on any request, the socket's session-ended closes (4401, 4403, "Session ended"), sign-out,
 * revocation and a dispatch refused for a changed login all go through the client's one
 * `#expireSession`. Then the marker goes and the saved state is swept at once, whether or not the
 * stream's own clear lands.
 */
export function keepCheckpointSession(
  client: {
    getSnapshot(): Pick<HostSnapshot, "session" | "connection" | "deploymentId" | "sessionId">;
    subscribe(listener: () => void): () => void;
  },
  marker: Pick<ReturnType<typeof checkpointSessionMarker>, "held" | "ended">,
  storage: Pick<IndexedDbCheckpointStorage, "sweep"> | undefined,
  now: () => number = Date.now,
): () => void {
  let confirmed: { identity: string; at: number } | null = null;
  let ended = false;
  return client.subscribe(() => {
    const snapshot = client.getSnapshot();
    if (snapshot.session === "authentication-required") {
      confirmed = null;
      if (ended) return;
      ended = true;
      marker.ended();
      void storage?.sweep().catch(() => undefined);
      return;
    }
    if (
      snapshot.session !== "authenticated" ||
      snapshot.connection !== "connected" ||
      !snapshot.deploymentId ||
      !snapshot.sessionId
    )
      return;
    ended = false;
    const identity = JSON.stringify([snapshot.deploymentId, snapshot.sessionId]);
    const at = now();
    if (confirmed?.identity === identity && at - confirmed.at < markerRenewalMs) return;
    confirmed = { identity, at };
    marker.held(snapshot.deploymentId, snapshot.sessionId);
  });
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

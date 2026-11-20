import { utf8ByteLength } from "@opensteer/core";
import type {
  PersonalResumeCursor,
  PersonalShellSnapshotSchema,
} from "@opensteer/protocol/personal-sync";
import type { TranscriptState } from "./thread-transcript-store.js";

export const personalCacheFormat = 68;

export interface PersonalCacheScope {
  readonly deploymentId: string;
  readonly viewerId: string;
  readonly epoch: string;
  readonly scopeKey: PersonalResumeCursor["scopeKey"];
  readonly format: typeof personalCacheFormat;
}

export type PersonalStreamCheckpoint = {
  readonly scope: PersonalCacheScope;
  readonly cursor: PersonalResumeCursor;
} & (
  | {
      readonly kind: "shell";
      /** Keeps its `session`: a cold start resumes the socket with it before any read. */
      readonly state: import("zod").infer<typeof PersonalShellSnapshotSchema>;
    }
  | { readonly kind: "detail"; readonly state: NonNullable<TranscriptState["snapshot"]> }
);
export type PersonalShellCheckpoint = Extract<PersonalStreamCheckpoint, { kind: "shell" }>;

type Identity = Pick<PersonalCacheScope, "deploymentId" | "viewerId" | "epoch">;

type Viewer = Pick<PersonalCacheScope, "deploymentId" | "viewerId">;

export interface PersonalStreamCache {
  /**
   * The fence a writer for this viewer takes once its identity is confirmed. A clear of the viewer,
   * its Deployment or everything raises the fence, so every write taken under an older one, from
   * any process sharing the storage, is refused and every record saved under one is never loaded.
   */
  fence(viewer: Viewer): Promise<number>;
  /** The newest saved shell, for this Deployment when named. */
  latestShell(deploymentId?: string): Promise<PersonalShellCheckpoint | null>;
  load(scope: PersonalCacheScope): Promise<PersonalStreamCheckpoint | null>;
  /** `session` is the Host session the writer saved under; storage refuses it once that ended. */
  commit(
    checkpoint: PersonalStreamCheckpoint,
    isCurrent: () => boolean,
    fence: number,
    session?: string,
  ): Promise<void>;
  remove(scope: PersonalCacheScope): Promise<void>;
  removeThread(identity: Identity, threadId: string): Promise<void>;
  removeViewer(identity: Viewer): Promise<void>;
  removeDeployment(deploymentId: string): Promise<void>;
  clear(): Promise<void>;
}

/** Raised by each clear; a viewer's fence is the sum of the three that cover it. */
export interface CheckpointFences {
  readonly all: number;
  readonly deployments: Readonly<Record<string, number>>;
  /** Keyed by `checkpointViewerKey`. */
  readonly viewers: Readonly<Record<string, number>>;
}
export const noCheckpointFences: CheckpointFences = { all: 0, deployments: {}, viewers: {} };

export function checkpointViewerKey(viewer: Viewer) {
  return JSON.stringify([viewer.deploymentId, viewer.viewerId]);
}

export function checkpointFence(fences: CheckpointFences, viewer: Viewer) {
  return (
    fences.all +
    (fences.deployments[viewer.deploymentId] ?? 0) +
    (fences.viewers[checkpointViewerKey(viewer)] ?? 0)
  );
}

/** The fences once a clear of `scope` (a viewer, a Deployment, or everything when empty) lands. */
export function raiseCheckpointFence(
  fences: CheckpointFences,
  scope: Partial<Viewer>,
): CheckpointFences {
  if (scope.deploymentId !== undefined && scope.viewerId !== undefined) {
    const key = checkpointViewerKey({ deploymentId: scope.deploymentId, viewerId: scope.viewerId });
    return { ...fences, viewers: { ...fences.viewers, [key]: (fences.viewers[key] ?? 0) + 1 } };
  }
  if (scope.deploymentId !== undefined)
    return {
      ...fences,
      deployments: {
        ...fences.deployments,
        [scope.deploymentId]: (fences.deployments[scope.deploymentId] ?? 0) + 1,
      },
    };
  return { ...fences, all: fences.all + 1 };
}

/**
 * One value per key. A write replaces its key whole or not at all, so a failed or interrupted
 * write leaves the previous value readable; other keys are untouched. `write` and `clear` each
 * check or raise the fences in the same transaction as their keys, so another process sharing the
 * storage cannot land a write between a clear and its fence.
 */
export interface CheckpointStorage {
  list(): Promise<
    readonly { readonly key: string; readonly savedAt: number; readonly bytes: number }[]
  >;
  read(key: string): Promise<string | null>;
  fences(): Promise<CheckpointFences>;
  /** Writes only while `checkpointFence(fences, guard)` is still `guard.fence`; says whether. */
  write(
    key: string,
    value: string,
    guard: Viewer & { readonly fence: number; readonly session?: string | undefined },
  ): Promise<boolean>;
  remove(keys: readonly string[]): Promise<void>;
  /** Removes every key `matches` accepts and raises the fence for `scope`, together. */
  clear(matches: (key: string) => boolean, scope: Partial<Viewer>): Promise<void>;
}

export const personalCheckpointMaxBytes = 512 * 1024;
const maxEntries = 16;
const maxTotalBytes = 4 * 1024 * 1024;

type Key = {
  readonly key: string;
  readonly format: unknown;
  readonly deploymentId: string;
  readonly viewerId: string;
  readonly epoch: string;
  readonly scopeKey: string;
  readonly threadId: string | null;
};

function storageKey(scope: PersonalCacheScope, threadId: string | null) {
  return JSON.stringify([
    scope.format,
    scope.deploymentId,
    scope.viewerId,
    scope.epoch,
    scope.scopeKey,
    threadId,
  ]);
}

/**
 * The Deployment a stored key belongs to, so storage can hold each record to that Deployment's
 * current session without knowing the rest of the key.
 */
export function checkpointKeyDeployment(key: string): string | null {
  return parseKey(key)?.deploymentId ?? null;
}

function parseKey(key: string): Key | null {
  try {
    const value: unknown = JSON.parse(key);
    if (!Array.isArray(value) || value.length !== 6) return null;
    const [format, deploymentId, viewerId, epoch, scopeKey, threadId] = value as unknown[];
    if (
      typeof deploymentId !== "string" ||
      typeof viewerId !== "string" ||
      typeof epoch !== "string" ||
      typeof scopeKey !== "string" ||
      (threadId !== null && typeof threadId !== "string")
    )
      return null;
    return { key, format, deploymentId, viewerId, epoch, scopeKey, threadId };
  } catch {
    return null;
  }
}

/** A detail key names its root thread so a revoked task removes its node scopes too. */
function threadOf(scopeKey: string, checkpoint?: PersonalStreamCheckpoint) {
  if (scopeKey.startsWith("thread:")) return scopeKey.slice("thread:".length);
  return checkpoint?.kind === "detail" ? checkpoint.state.thread.id : null;
}

type Stored = PersonalStreamCheckpoint & { readonly fence: number };

function parse(serialized: string | null): Stored | null {
  if (!serialized) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    return value && typeof value === "object" && typeof Reflect.get(value, "fence") === "number"
      ? (value as Stored)
      : null;
  } catch {
    return null;
  }
}

/** Saved scope checkpoints, one storage key per scope. Callers validate what `load` returns. */
export function createPersonalStreamCache(storage: CheckpointStorage): PersonalStreamCache {
  let tail = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const done = tail.then(work);
    tail = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  };
  const keys = async () => {
    const listed = await storage.list();
    const parsed = listed.map((entry) => ({ ...entry, parsed: parseKey(entry.key) }));
    // Another format is never migrated: it is removed the first time it is seen.
    const stale = parsed.filter(({ parsed }) => parsed?.format !== personalCacheFormat);
    if (stale.length) await storage.remove(stale.map(({ key }) => key));
    return parsed.flatMap(({ parsed, savedAt, bytes }) =>
      parsed && parsed.format === personalCacheFormat ? [{ ...parsed, savedAt, bytes }] : [],
    );
  };
  const removeWhere = (match: (key: Key) => boolean) =>
    serial(async () => {
      const doomed = (await keys()).filter(match).map(({ key }) => key);
      if (doomed.length) await storage.remove(doomed);
    });
  const clearWhere = (match: (key: Key) => boolean, scope: Partial<Viewer>) =>
    serial(() =>
      storage.clear((key) => {
        const parsed = parseKey(key);
        // Another format's key is never this viewer's to keep.
        return !parsed || parsed.format !== personalCacheFormat || match(parsed);
      }, scope),
    );
  /** A record saved before its viewer's last clear is never handed out. */
  const current = async (held: Stored | null) => {
    if (!held?.scope) return null;
    const fence = checkpointFence(await storage.fences(), held.scope);
    if (held.fence < fence) return null;
    const { fence: _fence, ...checkpoint } = held;
    return checkpoint as PersonalStreamCheckpoint;
  };
  const evict = async () => {
    const held = (await keys()).sort((a, b) => b.savedAt - a.savedAt);
    let total = 0;
    const doomed = held.filter((entry, index) => {
      total += entry.bytes;
      return index >= maxEntries || total > maxTotalBytes;
    });
    if (doomed.length) await storage.remove(doomed.map(({ key }) => key));
  };
  return {
    fence: (viewer) => serial(async () => checkpointFence(await storage.fences(), viewer)),
    latestShell: (deploymentId) =>
      serial(async () => {
        const newest = (await keys())
          .filter(
            (entry) =>
              entry.scopeKey === "shell" && (!deploymentId || entry.deploymentId === deploymentId),
          )
          .sort((a, b) => b.savedAt - a.savedAt)[0];
        const held = newest ? await current(parse(await storage.read(newest.key))) : null;
        return held?.kind === "shell" ? held : null;
      }),
    load: (scope) =>
      serial(async () => {
        const threadId = scope.scopeKey.startsWith("thread:")
          ? scope.scopeKey.slice("thread:".length)
          : undefined;
        if (threadId !== undefined || scope.scopeKey === "shell")
          return current(parse(await storage.read(storageKey(scope, threadId ?? null))));
        const entry = (await keys()).find(
          (key) =>
            key.deploymentId === scope.deploymentId &&
            key.viewerId === scope.viewerId &&
            key.epoch === scope.epoch &&
            key.scopeKey === scope.scopeKey,
        );
        return entry ? current(parse(await storage.read(entry.key))) : null;
      }),
    commit: (checkpoint, isCurrent, fence, session) =>
      serial(async () => {
        if (!isCurrent()) return;
        const serialized = JSON.stringify({ ...checkpoint, fence });
        if (utf8ByteLength(serialized) > personalCheckpointMaxBytes) return;
        const written = await storage.write(
          storageKey(checkpoint.scope, threadOf(checkpoint.scope.scopeKey, checkpoint)),
          serialized,
          {
            deploymentId: checkpoint.scope.deploymentId,
            viewerId: checkpoint.scope.viewerId,
            fence,
            session,
          },
        );
        if (written) await evict();
      }),
    remove: (scope) =>
      removeWhere(
        (key) =>
          key.deploymentId === scope.deploymentId &&
          key.viewerId === scope.viewerId &&
          key.epoch === scope.epoch &&
          key.scopeKey === scope.scopeKey,
      ),
    removeThread: (identity, threadId) =>
      removeWhere(
        (key) =>
          key.deploymentId === identity.deploymentId &&
          key.viewerId === identity.viewerId &&
          key.epoch === identity.epoch &&
          key.threadId === threadId,
      ),
    removeViewer: (identity) =>
      clearWhere(
        (key) => key.deploymentId === identity.deploymentId && key.viewerId === identity.viewerId,
        { deploymentId: identity.deploymentId, viewerId: identity.viewerId },
      ),
    removeDeployment: (deploymentId) =>
      clearWhere((key) => key.deploymentId === deploymentId, { deploymentId }),
    clear: () => clearWhere(() => true, {}),
  };
}

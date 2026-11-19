import { utf8ByteLength } from "@opensteer/core";
import type {
  PersonalResumeCursor,
  PersonalShellSnapshotSchema,
} from "@opensteer/protocol/personal-sync";
import type { PersonalResourceKind, PersonalResourceView } from "@opensteer/protocol/resources";
import type { TranscriptState } from "./thread-transcript-store.js";

export const personalCacheFormat = 65;

export interface PersonalCacheScope {
  readonly deploymentId: string;
  readonly viewerId: string;
  readonly epoch: string;
  readonly scopeKey: PersonalResumeCursor["scopeKey"];
  readonly format: typeof personalCacheFormat;
}

export interface InstalledResource {
  readonly revision: string;
  readonly view: PersonalResourceView;
}

export type PersonalStreamCheckpoint = {
  readonly scope: PersonalCacheScope;
  readonly cursor: PersonalResumeCursor;
} & (
  | {
      readonly kind: "shell";
      /** Keeps its `session`: a cold start resumes the socket with it before any read. */
      readonly state: import("zod").infer<typeof PersonalShellSnapshotSchema>;
      readonly resources: Partial<Record<PersonalResourceKind, InstalledResource>>;
    }
  | { readonly kind: "detail"; readonly state: NonNullable<TranscriptState["snapshot"]> }
);
export type PersonalShellCheckpoint = Extract<PersonalStreamCheckpoint, { kind: "shell" }>;

type Identity = Pick<PersonalCacheScope, "deploymentId" | "viewerId" | "epoch">;

export interface PersonalStreamCache {
  /** The newest saved shell, for this Deployment when named. */
  latestShell(deploymentId?: string): Promise<PersonalShellCheckpoint | null>;
  load(scope: PersonalCacheScope): Promise<PersonalStreamCheckpoint | null>;
  commit(checkpoint: PersonalStreamCheckpoint, isCurrent: () => boolean): Promise<void>;
  remove(scope: PersonalCacheScope): Promise<void>;
  removeThread(identity: Identity, threadId: string): Promise<void>;
  removeViewer(identity: Pick<PersonalCacheScope, "deploymentId" | "viewerId">): Promise<void>;
  removeDeployment(deploymentId: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * One value per key. A write replaces its key whole or not at all, so a failed or interrupted
 * write leaves the previous value readable; other keys are untouched.
 */
export interface CheckpointStorage {
  list(): Promise<
    readonly { readonly key: string; readonly savedAt: number; readonly bytes: number }[]
  >;
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
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

function parse(serialized: string | null): PersonalStreamCheckpoint | null {
  if (!serialized) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    return value && typeof value === "object" ? (value as PersonalStreamCheckpoint) : null;
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
    latestShell: (deploymentId) =>
      serial(async () => {
        const newest = (await keys())
          .filter(
            (entry) =>
              entry.scopeKey === "shell" && (!deploymentId || entry.deploymentId === deploymentId),
          )
          .sort((a, b) => b.savedAt - a.savedAt)[0];
        const held = newest ? parse(await storage.read(newest.key)) : null;
        return held?.kind === "shell" ? held : null;
      }),
    load: (scope) =>
      serial(async () => {
        const threadId = scope.scopeKey.startsWith("thread:")
          ? scope.scopeKey.slice("thread:".length)
          : undefined;
        if (threadId !== undefined || scope.scopeKey === "shell")
          return parse(await storage.read(storageKey(scope, threadId ?? null)));
        const entry = (await keys()).find(
          (key) =>
            key.deploymentId === scope.deploymentId &&
            key.viewerId === scope.viewerId &&
            key.epoch === scope.epoch &&
            key.scopeKey === scope.scopeKey,
        );
        return entry ? parse(await storage.read(entry.key)) : null;
      }),
    commit: (checkpoint, isCurrent) =>
      serial(async () => {
        if (!isCurrent()) return;
        const serialized = JSON.stringify(checkpoint);
        if (utf8ByteLength(serialized) > personalCheckpointMaxBytes) return;
        await storage.write(
          storageKey(checkpoint.scope, threadOf(checkpoint.scope.scopeKey, checkpoint)),
          serialized,
        );
        await evict();
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
      removeWhere(
        (key) => key.deploymentId === identity.deploymentId && key.viewerId === identity.viewerId,
      ),
    removeDeployment: (deploymentId) => removeWhere((key) => key.deploymentId === deploymentId),
    clear: () => removeWhere(() => true),
  };
}

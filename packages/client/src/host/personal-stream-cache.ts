import { utf8ByteLength } from "@opensteer/core";
import type { PersonalResumeCursor, ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import type { TranscriptState } from "./thread-transcript-store.js";

export const personalCacheFormat = 64;

export interface PersonalCacheScope {
  readonly deploymentId: string;
  readonly viewerId: string;
  readonly epoch: string;
  readonly scopeKey: PersonalResumeCursor["scopeKey"];
  readonly format: typeof personalCacheFormat;
}

type Shell = Extract<
  Extract<ScopedHostMessage, { type: "host.snapshot" }>["snapshot"],
  { tasks: unknown }
>;

export type PersonalStreamCheckpoint = {
  readonly scope: PersonalCacheScope;
  readonly cursor: PersonalResumeCursor;
} & (
  | { readonly kind: "shell"; readonly state: Shell }
  | { readonly kind: "detail"; readonly state: NonNullable<TranscriptState["snapshot"]> }
);

export interface PersonalStreamCache {
  hasCheckpoints?(deploymentId?: string): Promise<boolean>;
  removeDeployment?(deploymentId: string): Promise<void>;
  removeThread?(
    identity: Pick<PersonalCacheScope, "deploymentId" | "viewerId" | "epoch">,
    threadId: string,
  ): Promise<void>;
  clear?(): Promise<void>;
  removeViewer?(identity: Pick<PersonalCacheScope, "deploymentId" | "viewerId">): Promise<void>;
  load(scope: PersonalCacheScope): Promise<PersonalStreamCheckpoint | null>;
  commit(checkpoint: PersonalStreamCheckpoint, isCurrent: () => boolean): Promise<void>;
  remove(scope: PersonalCacheScope): Promise<void>;
}

type CheckpointStorage = {
  exists(): Promise<boolean>;
  read(): Promise<string | null>;
  write(serialized: string, isCurrent: () => boolean): Promise<void>;
  remove(): Promise<void>;
};

export function createPersonalStreamCache(storage: CheckpointStorage): PersonalStreamCache {
  const limit = 512 * 1024;
  const key = (scope: PersonalCacheScope) =>
    JSON.stringify([scope.format, scope.deploymentId, scope.viewerId, scope.epoch, scope.scopeKey]);
  let tail = Promise.resolve();
  let held: Promise<Map<string, PersonalStreamCheckpoint>> | undefined;
  const load = () =>
    (held ??= storage
      .read()
      .then((serialized) => {
        if (!serialized || utf8ByteLength(serialized) > limit) return new Map();
        const input: unknown = JSON.parse(serialized);
        if (!Array.isArray(input) || input.length > 6) return new Map();
        const entries = input.filter(
          (entry): entry is [string, PersonalStreamCheckpoint] =>
            Array.isArray(entry) &&
            typeof entry[0] === "string" &&
            entry[1] &&
            typeof entry[1] === "object",
        );
        return new Map(entries);
      })
      .catch(() => new Map()));
  const update = (work: () => Promise<void>) => {
    const done = tail.then(work);
    tail = done.catch(() => undefined);
    return done;
  };
  const replace = async (
    entries: Map<string, PersonalStreamCheckpoint>,
    isCurrent = () => true,
    serialized = JSON.stringify([...entries]),
  ) => {
    if (!isCurrent()) return;
    if (entries.size) await storage.write(serialized, isCurrent);
    else await storage.remove();
    if (isCurrent()) held = Promise.resolve(entries);
  };
  const removeWhere = (match: (checkpoint: PersonalStreamCheckpoint) => boolean) =>
    update(async () => {
      const entries = new Map(await load());
      let changed = false;
      for (const [id, entry] of entries) {
        if (!match(entry)) continue;
        entries.delete(id);
        changed = true;
      }
      if (changed) await replace(entries);
    });
  return {
    hasCheckpoints: async (deploymentId) => {
      if (!(await storage.exists())) return false;
      await tail;
      return [...(await load()).values()].some(
        (entry) =>
          entry?.scope?.format === personalCacheFormat &&
          (!deploymentId || entry.scope.deploymentId === deploymentId),
      );
    },
    clear: () => update(() => replace(new Map())),
    load: async (scope) => {
      await tail;
      return (await load()).get(key(scope)) ?? null;
    },
    commit: (checkpoint, isCurrent) =>
      update(async () => {
        const entries = new Map(await load());
        if (!isCurrent()) return;
        const id = key(checkpoint.scope);
        entries.delete(id);
        entries.set(id, checkpoint);
        let serialized = JSON.stringify([...entries]);
        for (const oldest of entries.keys()) {
          if (entries.size <= 6 && utf8ByteLength(serialized) <= limit) break;
          entries.delete(oldest);
          serialized = JSON.stringify([...entries]);
        }
        await replace(entries, isCurrent, serialized);
      }),
    remove: (scope) =>
      update(async () => {
        const entries = new Map(await load());
        if (entries.delete(key(scope))) await replace(entries);
      }),
    removeViewer: (identity) =>
      removeWhere(
        (entry) =>
          entry?.scope?.deploymentId === identity.deploymentId &&
          entry.scope.viewerId === identity.viewerId,
      ),
    removeDeployment: (deploymentId) =>
      removeWhere((entry) => entry?.scope?.deploymentId === deploymentId),
    removeThread: (identity, threadId) =>
      removeWhere(
        (entry) =>
          entry?.kind === "detail" &&
          entry.scope?.deploymentId === identity.deploymentId &&
          entry.scope.viewerId === identity.viewerId &&
          entry.scope.epoch === identity.epoch &&
          entry.state?.thread?.id === threadId,
      ),
  };
}

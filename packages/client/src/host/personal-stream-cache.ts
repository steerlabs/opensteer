import type { PersonalResumeCursor, ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import type { PersonalResourceKind, PersonalResourceView } from "@opensteer/protocol/resources";
import type { TranscriptState } from "./thread-transcript-store.js";

export const personalCacheFormat = 62;

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
      readonly state: Shell;
      readonly resources: Partial<Record<PersonalResourceKind, InstalledResource>>;
    }
  | { readonly kind: "detail"; readonly state: NonNullable<TranscriptState["snapshot"]> }
);

export interface PersonalStreamCache {
  hasCheckpoints?(): Promise<boolean>;
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
        if (!serialized || serialized.length > limit) return new Map();
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
  ) => {
    if (!isCurrent()) return;
    if (entries.size) await storage.write(JSON.stringify([...entries]), isCurrent);
    else await storage.remove();
    if (isCurrent()) held = Promise.resolve(entries);
  };
  return {
    hasCheckpoints: () => storage.exists(),
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
        for (const oldest of entries.keys()) {
          if (entries.size <= 6 && bytes(entries) <= limit) break;
          entries.delete(oldest);
        }
        await replace(entries, isCurrent);
      }),
    remove: (scope) =>
      update(async () => {
        const entries = new Map(await load());
        if (entries.delete(key(scope))) await replace(entries);
      }),
    removeViewer: (identity) =>
      update(async () => {
        const entries = new Map(await load());
        for (const [id, entry] of entries)
          if (
            entry?.scope?.deploymentId === identity.deploymentId &&
            entry.scope.viewerId === identity.viewerId
          )
            entries.delete(id);
        await replace(entries);
      }),
  };
}

function bytes(entries: ReadonlyMap<string, PersonalStreamCheckpoint>) {
  return new TextEncoder().encode(JSON.stringify([...entries])).length;
}

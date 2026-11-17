import type { PersonalResumeCursor, ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import type { PersonalResourceKind, PersonalResourceView } from "@opensteer/protocol/resources";

type Snapshot = Extract<ScopedHostMessage, { type: "host.snapshot" }>["snapshot"];
const format = 62;

export interface ScopedPersonalCheckpoint {
  readonly format: typeof format;
  readonly cursor: PersonalResumeCursor;
  readonly snapshot: Snapshot;
  readonly resources?: Partial<
    Record<
      PersonalResourceKind,
      {
        readonly revision: string;
        readonly view: PersonalResourceView;
      }
    >
  >;
}

type Identity = Omit<PersonalResumeCursor, "afterSequence">;

function checkpointKey(identity: Identity) {
  return JSON.stringify([
    format,
    identity.deploymentId,
    identity.viewerId,
    identity.epoch,
    identity.scopeKey,
  ]);
}

export interface ScopedPersonalCachePort {
  load(key: string): Promise<ScopedPersonalCheckpoint | null>;
  commit(
    key: string,
    checkpoint: ScopedPersonalCheckpoint,
    isCurrent: () => boolean,
  ): Promise<void>;
  remove(key: string): Promise<void>;
}

export class ScopedPersonalCache {
  readonly #port: ScopedPersonalCachePort;
  #tail: Promise<void> = Promise.resolve();
  readonly #active = new Map<string, symbol>();

  constructor(port: ScopedPersonalCachePort) {
    this.#port = port;
  }

  open(identity: Identity) {
    const key = checkpointKey(identity);
    const generation = Symbol();
    this.#active.set(key, generation);
    const isCurrent = () => this.#active.get(key) === generation;
    return {
      load: async () => {
        await this.#tail;
        const checkpoint = isCurrent() && (await this.#port.load(key));
        return checkpoint &&
          isCurrent() &&
          checkpoint.format === format &&
          checkpointKey(checkpoint.cursor) === key
          ? checkpoint
          : null;
      },
      save: (
        cursor: PersonalResumeCursor,
        snapshot: Snapshot,
        resources?: ScopedPersonalCheckpoint["resources"],
      ) => {
        if (checkpointKey(cursor) !== key) throw new Error("Personal checkpoint changed identity");
        return this.#enqueue(async () => {
          if (isCurrent())
            await this.#port.commit(
              key,
              {
                format,
                cursor,
                snapshot,
                ...(resources ? { resources } : {}),
              },
              isCurrent,
            );
        });
      },
      close: () => {
        if (isCurrent()) this.#active.delete(key);
      },
    };
  }

  remove(identity: Identity) {
    const key = checkpointKey(identity);
    this.#active.delete(key);
    return this.#enqueue(() => this.#port.remove(key));
  }

  #enqueue(work: () => Promise<void>) {
    const done = this.#tail.then(work);
    this.#tail = done.catch(() => undefined);
    return done;
  }
}

import { sha256 } from "@noble/hashes/sha2.js";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import type { PrivateFilesystem } from "../connections/private-filesystem.js";
import { ClientOperationError } from "../connections/operation-error.js";
import type { HostApiClient } from "@opensteer/protocol";

export type TeamAccountIdentity = { readonly issuer: string; readonly subject: string } | null;

const fileWrites = new WeakMap<PrivateFilesystem, MutationQueue>();

/** Account identity owns team work; token rotation and entry attempts have separate lifetimes. */
export class TeamRuntimeOwner {
  readonly id = globalThis.crypto.randomUUID();
  readonly #controller = new AbortController();
  readonly #resources = new Set<() => void>();
  readonly signal = this.#controller.signal;
  readonly partition: string;
  readonly identity: TeamAccountIdentity;
  constructor(identity: TeamAccountIdentity) {
    this.identity = identity;
    this.partition = encodeBase64Url(
      sha256(
        new TextEncoder().encode(JSON.stringify(identity && [identity.issuer, identity.subject])),
      ),
    );
  }
  matches(identity: TeamAccountIdentity): boolean {
    return (
      this.identity?.issuer === identity?.issuer && this.identity?.subject === identity?.subject
    );
  }
  readonly assertCurrent = (): void => {
    if (this.signal.aborted) throw this.signal.reason;
  };
  own(dispose: () => void): () => void {
    this.assertCurrent();
    this.#resources.add(dispose);
    return () => this.#resources.delete(dispose);
  }
  cache<Key, Value>(): Map<Key, Value> {
    const cache = new Map<Key, Value>();
    this.own(() => cache.clear());
    return cache;
  }
  async run<Value>(work: () => Promise<Value>): Promise<Value> {
    this.assertCurrent();
    const value = await work();
    this.assertCurrent();
    return value;
  }
  files(
    files: PrivateFilesystem,
  ): Pick<PrivateFilesystem, "readFile" | "writeFileAtomic" | "ensureDirectory" | "removeFile"> {
    let writes = fileWrites.get(files);
    if (!writes) fileWrites.set(files, (writes = new MutationQueue()));
    const queue = writes;
    return {
      readFile: (path, maximum) => this.run(() => files.readFile(path, maximum, this.signal)),
      ensureDirectory: (path) => this.run(() => files.ensureDirectory(path, this.signal)),
      removeFile: (path) => queue.run(() => files.removeFile(path)),
      writeFileAtomic: (path, content) =>
        queue.run(async () => {
          this.assertCurrent();
          await files.writeFileAtomic(path, content, this.signal);
          if (this.signal.aborted) {
            await files.removeFile(path);
            this.assertCurrent();
          }
        }),
    };
  }
  rpc(client: HostApiClient): HostApiClient {
    return new Proxy(client, {
      get: (target, key) => {
        const method: unknown = Reflect.get(target, key);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => this.run(() => Reflect.apply(method, target, args));
      },
    });
  }
  retire(): void {
    if (this.signal.aborted) return;
    this.#controller.abort(new ClientOperationError("The Account identity changed.", "transient"));
    for (const dispose of this.#resources) {
      try {
        dispose();
      } catch {
        /* Every resource must retire even when a platform cleanup fails. */
      }
    }
    this.#resources.clear();
  }
}

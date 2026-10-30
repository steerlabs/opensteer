import type { PrivateFilesystem } from "@opensteer/client/connections";
import type { SavedHostView, SavedViewScope, SavedViewStore } from "@opensteer/client/host";
import { DeploymentIdSchema } from "@opensteer/core";

type Deletion = { promise: Promise<void>; failed: boolean };

/** One deletion owner shared by credentials and presentation, independent of selection visits. */
export class SavedViewCache implements SavedViewStore {
  readonly #store: SavedViewStore | undefined;
  readonly #files: PrivateFilesystem;
  readonly #directory: string;
  readonly #blocked = new Set<string>();
  readonly #deletions = new Map<string, Deletion>();
  readonly #listeners = new Set<() => void>();

  constructor(options: {
    readonly store?: SavedViewStore;
    readonly files: PrivateFilesystem;
    readonly directory: string;
  }) {
    this.#store = options.store;
    this.#files = options.files;
    this.#directory = options.directory;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  isBlocked = (id: string): boolean => this.#blocked.has(id);
  isPending = (id: string): boolean => this.#deletions.has(id);
  getFailure = (): string | null =>
    [...this.#deletions.values()].some(({ failed }) => failed)
      ? "Saved view cleanup could not be completed. Cleanup will retry on foreground."
      : null;

  /** Fresh authenticated models may capture again after cleanup, never reload old disk data. */
  confirm(id: string): void {
    if (!this.isPending(id)) this.#blocked.delete(id);
  }
  async load(scope: SavedViewScope, isCurrent: () => boolean): Promise<SavedHostView | null> {
    const id = scope.hostIdentity.deploymentId;
    if (!isCurrent() || !(await this.#allowDisk(id)) || this.isBlocked(id)) return null;
    return this.#store?.load(scope, () => isCurrent() && !this.isBlocked(id)) ?? null;
  }
  async write(view: SavedHostView, isCurrent: () => boolean): Promise<void> {
    const id = view.hostIdentity.deploymentId;
    if (!isCurrent() || !(await this.#allowDisk(id)) || this.isBlocked(id)) return;
    await this.#store?.write(view, () => isCurrent() && !this.isBlocked(id));
  }
  invalidate(id: string): Promise<void> {
    this.#blocked.add(id);
    const previous = this.#deletions.get(id);
    if (previous && !previous.failed) return previous.promise;
    const deletion: Deletion = { promise: Promise.resolve(), failed: false };
    this.#deletions.set(id, deletion);
    deletion.promise = this.#delete(id).then(
      () => {
        if (this.#deletions.get(id) === deletion) this.#deletions.delete(id);
        this.#notify();
      },
      () => {
        deletion.failed = true;
        this.#notify();
      },
    );
    this.#notify();
    return deletion.promise;
  }
  async retryInvalidation(): Promise<void> {
    await Promise.all([...this.#deletions.keys()].map((id) => this.invalidate(id)));
  }
  #path(id: string): string {
    return `${this.#directory}/${DeploymentIdSchema.parse(id)}.deny`;
  }
  async #allowDisk(id: string): Promise<boolean> {
    try {
      if (!(await this.#files.fileExists(this.#path(id)))) return true;
    } catch {
      // Unreadable denial state cannot authorize optional cached content either.
    }
    await this.invalidate(id);
    return false;
  }
  async #delete(id: string): Promise<void> {
    const path = this.#path(id);
    // Exclusive creation is synchronous in the native adapter. Even an empty or
    // interrupted marker denies reads; do not journal its first creation.
    try {
      try {
        await this.#files.writeFileExclusive(path, "");
      } catch (error) {
        // A previous (or interrupted) exclusive creation already denies reads.
        if (!(await this.#files.fileExists(path))) throw error;
      }
    } finally {
      // Marker failure must never prevent the independent key-erasure attempt.
      await this.#store?.invalidate(id);
    }
    // Only successful key deletion permits clearing the independent denial marker.
    await this.#files.removeFile(path);
  }
  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

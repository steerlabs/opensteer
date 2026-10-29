import type { WorkspaceId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";

const activityWriteIntervalMs = 5 * 60 * 1_000;

export class WorkspaceActivityService {
  readonly #lastWrites = new Map<WorkspaceId, number>();
  readonly #now: () => number;
  readonly #onError: (error: unknown, workspaceId: WorkspaceId) => void;
  readonly #store: Pick<OpensteerStore, "noteWorkspaceActivity">;

  constructor(options: {
    readonly now?: () => number;
    readonly onError?: (error: unknown, workspaceId: WorkspaceId) => void;
    readonly store: Pick<OpensteerStore, "noteWorkspaceActivity">;
  }) {
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => undefined);
    this.#store = options.store;
  }

  note(workspaceId: WorkspaceId): void {
    const now = this.#now();
    const lastWrite = this.#lastWrites.get(workspaceId);
    if (lastWrite !== undefined && now - lastWrite < activityWriteIntervalMs) return;
    // Claimed before the write so a burst dedupes down to one statement, and
    // released again on failure so the next demand retries immediately instead
    // of leaving the Workspace looking idle for a whole interval.
    this.#lastWrites.set(workspaceId, now);
    void this.#store.noteWorkspaceActivity(workspaceId, new Date(now)).catch((error: unknown) => {
      if (this.#lastWrites.get(workspaceId) === now) this.#lastWrites.delete(workspaceId);
      try {
        this.#onError(error, workspaceId);
      } catch {
        // Activity accounting must never fail the demand path or create an unhandled rejection.
      }
    });
  }
}

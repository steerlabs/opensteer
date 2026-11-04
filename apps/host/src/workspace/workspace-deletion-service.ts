import type { AdministrationCommandIdentity } from "@opensteer/database";
import type { AgentEvent, UserId, Workspace, WorkspaceId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { type WorkspaceBackingLifecycleDriver, workspaceUsesBacking } from "@opensteer/workspace";

const purgePageSize = 100;
const millisecondsPerDay = 24 * 60 * 60 * 1_000;

type WorkspaceDeletionStore = Pick<
  OpensteerStore,
  | "listWorkspacesDuePurge"
  | "markWorkspaceDeleted"
  | "recoverWorkspaceDeletion"
  | "requestWorkspaceDeletion"
>;

interface WorkspaceDeletionDrivers {
  readonly local?: Pick<WorkspaceBackingLifecycleDriver<"local-directory">, "destroy">;
}

export class WorkspaceDeletionService {
  readonly #drivers: WorkspaceDeletionDrivers;
  readonly #now: () => Date;
  readonly #onError: (error: unknown, workspaceId: WorkspaceId) => void;
  readonly #onWorkspaceEvent: (event: AgentEvent) => void;
  readonly #retentionMilliseconds: number;
  readonly #store: WorkspaceDeletionStore;
  readonly #terminateRuns: (workspaceId: WorkspaceId) => Promise<void>;

  constructor(options: {
    readonly drivers: WorkspaceDeletionDrivers;
    readonly now?: () => Date;
    readonly onError: (error: unknown, workspaceId: WorkspaceId) => void;
    readonly onWorkspaceEvent: (event: AgentEvent) => void;
    readonly retentionDays: number;
    readonly store: WorkspaceDeletionStore;
    readonly terminateRuns: (workspaceId: WorkspaceId) => Promise<void>;
  }) {
    if (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 0) {
      throw new TypeError("Workspace deletion retention days must be a nonnegative integer");
    }

    if (!options.drivers.local)
      throw new TypeError("Workspace deletion requires a local storage driver");
    this.#drivers = options.drivers;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError;
    this.#onWorkspaceEvent = options.onWorkspaceEvent;
    this.#retentionMilliseconds = options.retentionDays * millisecondsPerDay;
    this.#store = options.store;
    this.#terminateRuns = options.terminateRuns;
  }

  async requestDeletion(
    workspaceId: WorkspaceId,
    requestedBy: UserId,
    administration?: AdministrationCommandIdentity | undefined,
  ): Promise<Workspace> {
    const now = this.#now();
    const mutation = await this.#store.requestWorkspaceDeletion({
      administration,
      purgeAfter: new Date(now.getTime() + this.#retentionMilliseconds),
      requestedBy,
      workspaceId,
    });
    for (const event of mutation.requestEvents) this.#onWorkspaceEvent(event);
    const workspace = mutation.workspace;
    const teardown = [this.#terminateRuns(workspaceId)];
    for (const result of await Promise.allSettled(teardown)) {
      if (result.status === "rejected") this.#onError(result.reason, workspaceId);
    }
    return workspace;
  }

  recover(
    workspaceId: WorkspaceId,
    requestedBy: UserId,
    administration?: AdministrationCommandIdentity | undefined,
  ): Promise<Workspace> {
    return this.#store.recoverWorkspaceDeletion({ requestedBy, workspaceId, administration });
  }

  async purgeDue(now: Date): Promise<void> {
    let after: WorkspaceId | undefined;
    for (;;) {
      const page = await this.#store.listWorkspacesDuePurge({
        ...(after ? { after } : {}),
        limit: purgePageSize,
        now,
      });
      for (const workspace of page) {
        try {
          await this.#destroy(workspace);
          await this.#store.markWorkspaceDeleted({ workspaceId: workspace.id });
        } catch (error) {
          this.#onError(error, workspace.id);
        }
      }
      const last = page.at(-1);
      if (!last || page.length < purgePageSize) return;
      after = last.id;
    }
  }

  /**
   * A destroy that cannot reach its storage authority throws, which leaves the
   * Workspace in `deleting` for the next purge pass. Nothing is ever marked
   * deleted on the strength of an unanswered request.
   */
  #destroy(workspace: Workspace): Promise<void> {
    if (workspaceUsesBacking(workspace, "local-directory")) {
      const local = this.#drivers.local;
      if (!local) throw new Error("This Deployment cannot destroy local Workspace directories");
      return local.destroy({ workspace });
    }
    throw new Error("Workspace backing does not match the configured deletion driver");
  }
}

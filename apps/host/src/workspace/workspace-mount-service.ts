import { createId, type EnvironmentId, type UserId, type WorkspaceId } from "@opensteer/core";
import type {
  OpensteerStore,
  PendingWorkspaceMountRevocation,
  WorkspaceMountInventoryEntry,
  WorkspaceMountRecord,
} from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import { CorrelationIdSchema, type RunnerCommand } from "@opensteer/protocol";
import type { PortableFsControlPlane } from "@opensteer/workspace-portablefs";

const claimLimit = 32;
const claimLeaseMs = 60_000;
const detachDeadlineMs = 15_000;
const maximumRetryMs = 15 * 60_000;
const baseRetryMs = 5_000;

type WorkspaceMountStore = Pick<
  OpensteerStore,
  | "claimPendingMountEnrollmentRevocations"
  | "closeEnvironment"
  | "completeMountEnrollmentRevocation"
  | "failMountEnrollmentRevocation"
  | "listReplacedWorkspaceMounts"
  | "listWorkspaceMounts"
  | "listWorkspaceMountsAuthorizedBy"
  | "reconcileRunnerInventory"
  | "recordWorkspaceMount"
  | "requestWorkspaceMountRevocationByEnrollmentId"
  | "requestWorkspaceMountRevocations"
>;

/** Machine-scoped Workspace mount lifecycle and Manager revocation reconciler. */
export class WorkspaceMountService {
  readonly #controlPlane: PortableFsControlPlane;
  readonly #runners: Pick<RunnerRegistry, "dispatch">;
  readonly #store: WorkspaceMountStore;
  #active: Promise<void> | undefined;

  constructor(options: {
    readonly controlPlane: PortableFsControlPlane;
    readonly runners: Pick<RunnerRegistry, "dispatch">;
    readonly store: WorkspaceMountStore;
  }) {
    this.#controlPlane = options.controlPlane;
    this.#runners = options.runners;
    this.#store = options.store;
  }

  recordIssued(
    input: Parameters<WorkspaceMountStore["recordWorkspaceMount"]>[0],
  ): Promise<WorkspaceMountRecord> {
    return this.#store.recordWorkspaceMount(input);
  }

  async revokeIssued(input: {
    readonly enrollmentId: string;
    readonly reason: string;
    readonly volumeId: string;
  }): Promise<void> {
    const tracked = await this.#store.requestWorkspaceMountRevocationByEnrollmentId(
      input.enrollmentId,
      input.reason,
    );
    if (tracked) {
      await this.reconcile();
      return;
    }
    await this.#controlPlane.revokeMountEnrollment(
      input.volumeId,
      input.enrollmentId,
      input.reason,
    );
  }

  async revokeForMembership(workspaceId: WorkspaceId, userId: UserId): Promise<void> {
    await this.#revoke(
      await this.#store.listWorkspaceMountsAuthorizedBy({ authorizedBy: userId, workspaceId }),
      "workspace-membership-revoked",
    );
  }

  async revokeWorkspace(workspaceId: WorkspaceId): Promise<void> {
    await this.#revoke(
      await this.#store.listWorkspaceMounts(workspaceId),
      "opensteer-workspace-deletion",
    );
  }

  async revokeReplacedBacking(workspaceId: WorkspaceId, currentGeneration: number): Promise<void> {
    await this.#revoke(
      await this.#store.listReplacedWorkspaceMounts({ currentGeneration, workspaceId }),
      "workspace-backing-replaced",
    );
  }

  async evictIdle(workspaceId: WorkspaceId): Promise<void> {
    await this.#revoke(
      await this.#store.listWorkspaceMounts(workspaceId),
      "workspace-idle-archive",
    );
  }

  closeEnvironment(environmentId: EnvironmentId, reason: string): Promise<number> {
    return this.#store.closeEnvironment(environmentId, reason);
  }

  async reconcileRunnerInventory(
    environmentId: EnvironmentId,
    mounts: readonly WorkspaceMountInventoryEntry[],
  ): Promise<void> {
    const unknown = await this.#store.reconcileRunnerInventory({ environmentId, mounts });
    await Promise.all(unknown.map((mount) => this.#detach(environmentId, mount)));
  }

  reconcile(): Promise<void> {
    const prior = this.#active;
    const operation = (prior ? prior.catch(() => undefined) : Promise.resolve()).then(() =>
      this.#reconcile(),
    );
    this.#active = operation;
    void operation.then(
      () => {
        if (this.#active === operation) this.#active = undefined;
      },
      () => {
        if (this.#active === operation) this.#active = undefined;
      },
    );
    return operation;
  }

  async close(): Promise<void> {
    await this.#active?.catch(() => undefined);
  }

  async #revoke(rows: readonly WorkspaceMountRecord[], reason: string): Promise<void> {
    if (rows.length === 0) return;
    const unique = new Map<string, WorkspaceMountRecord>();
    for (const row of rows) {
      unique.set(`${row.environmentId}\0${row.workspaceId}\0${row.volumeId}`, row);
    }
    await Promise.all(
      [...unique.values()].map((row) =>
        this.#detach(row.environmentId, {
          enrollmentId: row.enrollmentId,
          volumeId: row.volumeId,
          workspaceId: row.workspaceId,
        }),
      ),
    );
    await this.#store.requestWorkspaceMountRevocations({
      reason,
      workspaceMountIds: rows.map((row) => row.id),
    });
    await this.reconcile();
  }

  async #detach(environmentId: EnvironmentId, mount: WorkspaceMountInventoryEntry): Promise<void> {
    const commandId = createId("command");
    const command: RunnerCommand = {
      commandId,
      correlationId: CorrelationIdSchema.parse(commandId),
      environmentId,
      type: "workspace.detach",
      volumeId: mount.volumeId,
      workspaceId: mount.workspaceId,
    };
    await this.#runners
      .dispatch(command, AbortSignal.timeout(detachDeadlineMs))
      .catch(() => undefined);
  }

  async #reconcile(): Promise<void> {
    const now = new Date();
    const records = await this.#store.claimPendingMountEnrollmentRevocations({
      leaseUntil: new Date(now.getTime() + claimLeaseMs),
      limit: claimLimit,
      now,
    });
    const failures: unknown[] = [];
    await mapWithConcurrency(records, 4, async (record) => {
      try {
        await this.#revokeEnrollment(record);
      } catch (error) {
        failures.push(error);
      }
    });
    if (failures.length > 0) {
      throw new AggregateError(failures, "PortableFS mount enrollment revocation failed");
    }
  }

  async #revokeEnrollment(record: PendingWorkspaceMountRevocation): Promise<void> {
    try {
      const result = await this.#controlPlane.revokeMountEnrollment(
        record.volumeId,
        record.enrollmentId,
        record.terminationReason,
      );
      await this.#store.completeMountEnrollmentRevocation(record.enrollmentId, result.outcome);
    } catch (error) {
      await this.#store.failMountEnrollmentRevocation({
        enrollmentId: record.enrollmentId,
        errorCode: "portablefs-manager-revocation-failed",
        nextAttemptAt: new Date(Date.now() + retryDelay(record.revocationAttempt)),
      });
      throw new Error("PortableFS Manager did not accept mount enrollment revocation", {
        cause: error,
      });
    }
  }
}

function retryDelay(attempt: number): number {
  return Math.min(baseRetryMs * 2 ** Math.min(Math.max(0, attempt - 1), 12), maximumRetryMs);
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (index < values.length) {
        const current = values[index];
        index += 1;
        if (current !== undefined) await operation(current);
      }
    }),
  );
}

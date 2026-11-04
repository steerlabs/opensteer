import {
  automaticModelWants,
  OpensteerError,
  TimeZoneSchema,
  type AgentEvent,
  type Thread,
  type TriggerOccurrenceId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  createMemoryPass,
  missingMemoryPassMains,
  setMemoryPassWaiting,
  withDatabaseOperationSignal,
  type MemoryPassExecution,
  type OpensteerStore,
} from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import { MANAGED_MEMORY_WAKE_SKIPPED, type TriggerSystemRole } from "@opensteer/triggers";
import type { WorkspaceFilesService } from "../workspace/files/workspace-files-service.js";
import { resolveAutomaticModels, workspaceExecution } from "./automatic-models.js";
import { memoryPassProgram } from "./memory-pass-program.js";
import { triggerProgramCompatibilityReason } from "../triggers/trigger-program-compatibility.js";

export const memoryPassWaitingReason =
  "Waiting for an AI account it can use on Main's computer. Connect one there, or turn one on for automatic work in AI settings; it resumes by itself.";

interface MemoryPassServiceOptions {
  readonly store: OpensteerStore;
  readonly runners: Pick<RunnerRegistry, "isAvailable" | "canRunHarness" | "harnessAccessModes">;
  readonly files: Pick<WorkspaceFilesService, "preview">;
  readonly onEvent: (event: AgentEvent) => void;
  readonly onChanged: (workspaceId: WorkspaceId) => void;
  readonly onError: (workspaceId: WorkspaceId, error: unknown) => void;
  readonly batchSize?: number;
}

/** Uses the Workspace reconciliation clock; each candidate advances even when deferred. */
export class MemoryPassService {
  #after: WorkspaceId | undefined;
  readonly #options: MemoryPassServiceOptions;
  constructor(options: MemoryPassServiceOptions) {
    this.#options = options;
  }

  async reconcileMissing(): Promise<void> {
    const { store, batchSize = 20 } = this.#options;
    const candidates = await missingMemoryPassMains(store.database, this.#after, batchSize);
    for (const { id } of candidates) {
      this.#after = id;
      try {
        const expiresAt = Date.now() + 15_000;
        await withDatabaseOperationSignal(AbortSignal.timeout(15_000), expiresAt, () =>
          this.ensureForMain(id),
        );
      } catch (error) {
        if (
          error instanceof OpensteerError &&
          ["conflict", "forbidden", "not_found", "unavailable"].includes(error.code)
        )
          continue;
        this.#options.onError(id, error);
      }
    }
    if (candidates.length < batchSize) this.#after = undefined;
  }

  async ensureForMain(workspaceId: WorkspaceId): Promise<void> {
    const { store, files } = this.#options;
    const present = await store.database
      .selectFrom("triggers")
      .select("systemRole")
      .where("workspaceId", "=", workspaceId)
      .where("systemRole", "is not", null)
      .execute();
    const missing = (["memory-light", "memory-nightly"] as const).filter(
      (role) => !present.some(({ systemRole }) => systemRole === role),
    );
    if (!missing.length) return;
    const workspace = await store.getWorkspace(workspaceId);
    if (
      !workspace ||
      workspace.kind !== "main" ||
      workspace.status !== "ready" ||
      !workspace.homeThreadId
    )
      return;
    const zone = TimeZoneSchema.safeParse(
      await store.notificationState.timeZoneFor(workspace.createdBy),
    );
    if (!zone.success) return;
    const chat = await store.getThreadForOwner(workspace.homeThreadId, workspace.createdBy);
    if (!chat?.inheritsMain) return;
    // The worker is each pass's Trigger anchor, on Chat's computer.
    if (await triggerProgramCompatibilityReason(store, chat.environmentId, 3)) return;
    const admission = await store.admitWorkspaceFiles(workspace.id, workspace.createdBy);
    if (!admission) return;
    let off = false;
    try {
      const file = await files.preview(
        admission,
        Buffer.from("AGENTS.md").toString("base64url"),
        AbortSignal.timeout(10_000),
      );
      if (file.metadata.truncated) return;
      off = /^Memory: off at the person's request/mu.test(Buffer.from(file.bytes).toString("utf8"));
    } catch (error) {
      if (!(error instanceof OpensteerError) || error.code !== "not_found") return;
    }
    for (const systemRole of missing) {
      const created = await createMemoryPass(store.database, {
        workspaceId,
        ownerId: workspace.createdBy,
        chat,
        systemRole,
        program: memoryPassProgram(systemRole),
        source: memoryPassSource(systemRole, zone.data),
        pauseReason: off ? "Memory is off at your request." : null,
      });
      if (created) {
        if (created.event) this.#options.onEvent(created.event);
        this.#options.onChanged(workspaceId);
      }
    }
  }

  /**
   * The model a managed pass's own wake runs on, resolved afresh for each
   * pass; undefined for every other Trigger. Without a usable model the pass
   * waits: the wake is skipped and the next one resolves again, so the
   * schedule recovers by itself and a pause stays the person's.
   */
  async admissionSelection(
    occurrenceId: TriggerOccurrenceId,
    worker: Thread,
  ): Promise<MemoryPassExecution | undefined> {
    const { store } = this.#options;
    const trigger = await store.database
      .selectFrom("triggerOccurrences")
      .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
      .select([
        "triggers.id",
        "triggers.anchorThreadId",
        "triggers.createdBy",
        "triggers.systemRole",
        "triggers.workspaceId",
      ])
      .where("triggerOccurrences.id", "=", occurrenceId)
      .executeTakeFirst();
    if (!trigger?.systemRole || trigger.anchorThreadId !== worker.id) return undefined;
    const chosen = await this.#resolve(
      trigger.createdBy,
      worker,
      trigger.systemRole === "memory-light" ? "light" : "deep",
    );
    if (
      await setMemoryPassWaiting(
        store.database,
        trigger.id,
        chosen ? null : memoryPassWaitingReason,
      )
    )
      this.#options.onChanged(trigger.workspaceId);
    if (!chosen)
      throw new OpensteerError({ code: "conflict", message: MANAGED_MEMORY_WAKE_SKIPPED });
    return {
      harnessInstanceId: chosen.harnessInstanceId,
      modelSelection: chosen.storedModelSelection,
    };
  }

  /**
   * Main's owner, with their current authority over Main and its files, on
   * Main's computer in the worker's access mode. The light pass waits rather
   * than run on Chat's model; the nightly pass ends with it.
   */
  async #resolve(ownerId: UserId, worker: Thread, role: "light" | "deep") {
    const { store, runners } = this.#options;
    const main = await store.getWorkspaceForOwner(worker.workspaceId, ownerId);
    if (
      main?.kind !== "main" ||
      main.backing.kind !== "local-directory" ||
      main.backing.ownerEnvironmentId !== worker.environmentId ||
      !main.homeThreadId ||
      !(await store.admitWorkspaceFiles(main.id, ownerId))
    )
      return undefined;
    const chat = role === "deep" ? await store.getThreadForOwner(main.homeThreadId, ownerId) : null;
    const { candidates } = await resolveAutomaticModels(
      { store, runners },
      {
        userId: ownerId,
        wants: (config) => automaticModelWants(config, role),
        original: chat ?? undefined,
        canRun: workspaceExecution(runners, {
          environmentId: worker.environmentId,
          accessMode: worker.accessMode,
        }),
      },
    );
    return candidates[0];
  }
}

function memoryPassSource(role: TriggerSystemRole, timezone: string) {
  return {
    kind: "schedule",
    schedule: {
      kind: "cron",
      expression: role === "memory-light" ? "*/30 8-22 * * *" : "0 3 * * *",
      timezone,
    },
  } as const;
}

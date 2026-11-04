import {
  OpensteerError,
  TimeZoneSchema,
  type AgentEvent,
  type BackgroundModelRole,
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
import { backgroundAccounts } from "./background-model-settings.js";
import { resolveBackgroundCandidates } from "./background-models.js";
import { memoryPassProgram } from "./memory-pass-program.js";
import { triggerProgramCompatibilityReason } from "../triggers/trigger-program-compatibility.js";

export const memoryPassWaitingReason =
  "Waiting for a model it can use. Allow a provider for background work, or choose a model, in AI settings; it resumes by itself.";

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
    const [chosen] = await this.#candidates(
      trigger.systemRole === "memory-light" ? "light" : "deep",
      worker,
      trigger.createdBy,
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
    return { harnessInstanceId: chosen.harnessInstanceId, modelSelection: chosen.modelSelection };
  }

  async #candidates(role: BackgroundModelRole, worker: Thread, ownerId: UserId) {
    const { store, runners } = this.#options;
    const main = await store.getWorkspace(worker.workspaceId);
    // Main's files are reachable only on the computer that holds them, which
    // is also where the worker anchors its Trigger.
    if (
      main?.backing.kind !== "local-directory" ||
      main.backing.ownerEnvironmentId !== worker.environmentId ||
      !main.homeThreadId
    )
      return [];
    const [preferences, chat, { harnesses, accounts }] = await Promise.all([
      store.getBackgroundModelPreferences(ownerId),
      store.getThreadForOwner(main.homeThreadId, ownerId),
      backgroundAccounts(
        store,
        [worker.environmentId],
        (environmentId) => runners.isAvailable(environmentId),
        (harness) =>
          runners.canRunHarness(harness.environmentId, harness.driverKind) &&
          runners
            .harnessAccessModes(harness.environmentId, harness.driverKind)
            ?.includes(worker.accessMode) === true,
      ),
    ]);
    const chatHarness =
      role === "deep" && chat
        ? harnesses.find((harness) => harness.id === chat.harnessInstanceId)
        : undefined;
    // Main's memory already reaches Chat's provider, so like a task's own
    // provider it needs no consent; every other provider does.
    return resolveBackgroundCandidates(role, {
      accounts,
      preferences,
      now: Date.now(),
      ...(chat ? { ownProviderId: chat.modelSelection.providerId } : {}),
      ...(chat && chatHarness
        ? {
            taskModelFallback: {
              environmentId: chat.environmentId,
              harnessInstanceId: chat.harnessInstanceId,
              harnessRevision: chatHarness.runtimeRevision,
              modelSelection: chat.modelSelection,
              reason: "task-model" as const,
            },
          }
        : {}),
    });
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

import {
  automaticModelWants,
  ExecutionPreferencesSchema,
  ModelSelectionSchema,
  OpensteerError,
  TimeZoneSchema,
  type AgentEvent,
  type TaskFolder,
  type Thread,
  type TriggerOccurrenceId,
  type UserId,
} from "@opensteer/core";
import {
  createMemoryPass,
  personalSettings,
  recordMemoryPassWake,
  withDatabaseOperationSignal,
  type MemoryPassExecution,
  type OpensteerStore,
} from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import { MANAGED_MEMORY_WAKE_SKIPPED, type TriggerSystemRole } from "@opensteer/triggers";
import { resolveAutomaticModels, personalExecution } from "./automatic-models.js";
import { memoryPassProgram } from "./memory-pass-program.js";
import { triggerProgramCompatibilityReason } from "../triggers/trigger-program-compatibility.js";

export const memoryPassWaitingReason =
  "Waiting for an AI account on the hosting computer. Connect one there, or turn one on for automatic work in AI settings; it resumes by itself.";
interface MemoryPassServiceOptions {
  readonly store: OpensteerStore;
  readonly runners: Pick<RunnerRegistry, "isAvailable" | "canRunHarness" | "harnessAccessModes">;
  readonly readAgentInstructions: (
    folder: TaskFolder,
    signal: AbortSignal,
  ) => Promise<string | null>;
  readonly onEvent: (event: AgentEvent) => void;
  readonly onChanged: () => void;
  readonly onError: (error: unknown) => void;
}

export class MemoryPassService {
  readonly options: MemoryPassServiceOptions;
  constructor(options: MemoryPassServiceOptions) {
    this.options = options;
  }

  async reconcileMissing(): Promise<void> {
    const expiresAt = Date.now() + 15_000;
    try {
      await withDatabaseOperationSignal(AbortSignal.timeout(15_000), expiresAt, () =>
        this.ensureForPersonal(),
      );
    } catch (error) {
      if (
        error instanceof OpensteerError &&
        ["conflict", "forbidden", "not_found", "unavailable"].includes(error.code)
      )
        return;
      this.options.onError(error);
    }
  }

  async ensureForPersonal(): Promise<void> {
    const { store } = this.options;
    const initialized = await store.database
      .selectFrom("personalSettings")
      .select("ownerId")
      .executeTakeFirst();
    if (!initialized) return;
    const settings = await personalSettings(store.database);
    const zone = TimeZoneSchema.safeParse(
      await store.notificationState.timeZoneFor(settings.ownerId),
    );
    if (!zone.success) return;
    const present = await store.database
      .selectFrom("triggers")
      .select("systemRole")
      .where("systemRole", "is not", null)
      .execute();
    const missing = (["memory-light", "memory-nightly"] as const).filter(
      (role) => !present.some((row) => row.systemRole === role),
    );
    if (!missing.length) return;
    const environment = await store.database
      .selectFrom("executionEnvironments")
      .select("id")
      .where("runnerId", "=", settings.agentHome.computerId)
      .executeTakeFirst();
    if (!environment || (await triggerProgramCompatibilityReason(store, environment.id, 3))) return;
    let instructions: string | null;
    try {
      instructions = await this.options.readAgentInstructions(
        settings.agentHome,
        AbortSignal.timeout(10_000),
      );
    } catch (error) {
      this.options.onError(error);
      return;
    }
    const off =
      instructions !== null && /^Memory: off at the person's request/mu.test(instructions);
    const remembered = await this.remembered(settings.ownerId);
    const prior = await store.database
      .selectFrom("threads")
      .select(["harnessInstanceId", "modelSelection"])
      .where("environmentId", "=", environment.id)
      .where("createdBy", "=", settings.ownerId)
      .where("purpose", "=", "task")
      .orderBy("updatedAt", "desc")
      .executeTakeFirst();
    const seed =
      remembered ??
      (prior
        ? {
            harnessInstanceId: prior.harnessInstanceId,
            modelSelection: ModelSelectionSchema.parse(prior.modelSelection),
          }
        : undefined);
    if (!seed) return;

    for (const systemRole of missing) {
      const created = await createMemoryPass(store.database, {
        ownerId: settings.ownerId,
        execution: {
          environmentId: environment.id,
          harnessInstanceId: seed.harnessInstanceId,
          modelSelection: seed.modelSelection,
        },
        systemRole,
        program: memoryPassProgram(systemRole),
        source: memoryPassSource(systemRole, zone.data),
        pauseReason: off ? "Memory is off at your request." : null,
      });
      if (created) {
        if (created.event) this.options.onEvent(created.event);
        this.options.onChanged();
      }
    }
  }

  async admissionSelection(
    occurrenceId: TriggerOccurrenceId,
    worker: Thread,
  ): Promise<MemoryPassExecution | undefined> {
    const { store, runners } = this.options;
    const trigger = await store.database
      .selectFrom("triggerOccurrences")
      .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
      .select([
        "triggers.id",
        "triggers.anchorThreadId",
        "triggers.createdBy",
        "triggers.systemRole",
      ])
      .where("triggerOccurrences.id", "=", occurrenceId)
      .executeTakeFirst();
    if (!trigger?.systemRole || trigger.anchorThreadId !== worker.id) return undefined;
    const settings = await personalSettings(store.database);
    if (
      settings.ownerId !== trigger.createdBy ||
      worker.folder.computerId !== settings.agentHome.computerId ||
      worker.folder.path !== settings.agentHome.path
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Memory jobs use the personal agent home.",
      });
    const { candidates } = await resolveAutomaticModels(
      { store, runners },
      {
        userId: settings.ownerId,
        wants: (config) =>
          automaticModelWants(config, trigger.systemRole === "memory-light" ? "light" : "deep"),
        original:
          trigger.systemRole === "memory-nightly"
            ? await this.remembered(settings.ownerId)
            : undefined,
        canRun: personalExecution(runners, {
          environmentId: worker.environmentId,
          accessMode: worker.accessMode,
        }),
      },
    );
    const chosen = candidates[0];
    const { accepted, changed } = await recordMemoryPassWake(store.database, {
      occurrenceId,
      triggerId: trigger.id,
      workerId: worker.id,
      waitingReason: chosen ? null : memoryPassWaitingReason,
    });
    if (changed) this.options.onChanged();
    if (accepted) return undefined;
    if (!chosen)
      throw new OpensteerError({ code: "conflict", message: MANAGED_MEMORY_WAKE_SKIPPED });
    return {
      harnessInstanceId: chosen.harnessInstanceId,
      harnessRevision: chosen.harnessRevision,
      modelSelection: chosen.storedModelSelection,
    };
  }

  private async remembered(ownerId: UserId) {
    const row = await this.options.store.database
      .selectFrom("personalSettings")
      .select("executionPreferences")
      .where("ownerId", "=", ownerId)
      .executeTakeFirstOrThrow();
    return ExecutionPreferencesSchema.parse(row.executionPreferences).history[0];
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

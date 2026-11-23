import {
  backgroundModelWants,
  ExecutionPreferencesSchema,
  ModelSelectionSchema,
  OpensteerError,
  TimeZoneSchema,
  type Thread,
  type TriggerOccurrenceId,
  type UserId,
} from "@opensteer/core";
import {
  TriggerStore,
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
import { isDeepStrictEqual } from "node:util";
import type { Clock } from "@opensteer/shared/clock";
import { DeadlineDrain, retryWithBackoff } from "../runtime/deadline-drain.js";
import { memoryPassProgram } from "./memory-pass-program.js";
import { memoryPassScript } from "./memory-pass-script.js";

export const memoryPassWaitingReason =
  "Waiting for an AI account on the hosting computer. Connect one there, or turn one on for automatic work in AI settings; it resumes by itself.";
interface MemoryPassServiceOptions {
  readonly store: OpensteerStore;
  readonly runners: Pick<RunnerRegistry, "isAvailable" | "canRunHarness" | "harnessAccessModes">;
  readonly readAgentInstructions: (signal: AbortSignal) => Promise<string | null>;
  readonly onChanged: () => void;
  readonly onError: (error: unknown) => void;
  readonly clock?: Clock;
}

/** How a provisioning pass ended: both exist, prerequisites are missing, or it failed and owes a retry. */
type ProvisioningOutcome = "settled" | "waiting" | "retry";

export class MemoryPassService {
  readonly options: MemoryPassServiceOptions;
  #settled = false;
  readonly #drain: DeadlineDrain;
  constructor(options: MemoryPassServiceOptions) {
    this.options = options;
    // Prerequisites that are missing arrive with a Runner registration or a
    // finished Run, which wake this; a failed pass owes a retry and backs off.
    this.#drain = new DeadlineDrain({
      ...(options.clock ? { clock: options.clock } : {}),
      drain: async () =>
        this.#settled || (await this.reconcileMissing()) !== "retry" ? null : retryWithBackoff,
      onError: options.onError,
    });
  }

  /** Runs a provisioning pass now, and again on backoff while one fails. */
  wake(): void {
    this.#drain.wake();
  }

  /** Resolves once no pass is running. */
  async idle(): Promise<void> {
    await this.#drain.settled();
  }

  async close(): Promise<void> {
    await this.#drain.close();
  }

  /**
   * Both memory passes exist. Until then their prerequisites (settings, the
   * hosting computer, a first task's model) arrive with Runner registration
   * and finished Runs, which ask again; afterwards nothing does.
   */
  get settled(): boolean {
    return this.#settled;
  }

  async reconcileMissing(): Promise<ProvisioningOutcome> {
    const expiresAt = Date.now() + 15_000;
    try {
      return await withDatabaseOperationSignal(AbortSignal.timeout(15_000), expiresAt, () =>
        this.ensureForPersonal(),
      );
    } catch (error) {
      if (
        error instanceof OpensteerError &&
        ["conflict", "forbidden", "not_found", "unavailable"].includes(error.code)
      )
        return "waiting";
      this.options.onError(error);
      return "retry";
    }
  }

  async ensureForPersonal(): Promise<ProvisioningOutcome> {
    const { store } = this.options;
    const initialized = await store.database
      .selectFrom("personalSettings")
      .select("ownerId")
      .executeTakeFirst();
    if (!initialized) return "waiting";
    const settings = await personalSettings(store.database);
    const systemPrograms = await store.database
      .selectFrom("triggers")
      .innerJoin("triggerRevisions", "triggerRevisions.id", "triggers.currentRevisionId")
      .leftJoin(
        "triggerRevisionScripts",
        "triggerRevisionScripts.revisionId",
        "triggers.currentRevisionId",
      )
      .select([
        "triggers.id",
        "triggers.currentRevisionId",
        "triggers.systemRole",
        "triggerRevisions.program",
        "triggerRevisionScripts.script as currentScript",
      ])
      .where("triggers.systemRole", "is not", null)
      .execute();
    for (const current of systemPrograms) {
      if (!current.systemRole) continue;
      const program = memoryPassProgram(current.systemRole);
      const script = memoryPassScript(current.systemRole);
      if (
        !isDeepStrictEqual(current.program, program) ||
        !isDeepStrictEqual(current.currentScript, script)
      ) {
        await new TriggerStore(store.database).regenerateSystemProgram({
          triggerId: current.id,
          ownerId: settings.ownerId,
          expectedRevisionId: current.currentRevisionId,
          program,
          script,
        });
        this.options.onChanged();
      }
    }
    // Memory passes run on this computer, so they keep its clock.
    const zone = TimeZoneSchema.safeParse(Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (!zone.success) return "waiting";
    const present = await store.database
      .selectFrom("triggers")
      .select("systemRole")
      .where("systemRole", "is not", null)
      .execute();
    const missing = (["memory-light", "memory-nightly"] as const).filter(
      (role) => !present.some((row) => row.systemRole === role),
    );
    if (!missing.length) {
      this.#settled = true;
      return "settled";
    }
    const environment = await store.database
      .selectFrom("executionEnvironments")
      .innerJoin("runners", "runners.id", "executionEnvironments.runnerId")
      .select(["executionEnvironments.id", "runners.capabilities"])
      .where("executionEnvironments.runnerId", "=", settings.agentHome.computerId)
      .executeTakeFirst();
    if (
      !environment ||
      !Array.isArray(environment.capabilities) ||
      !environment.capabilities.includes("automation-script-v1")
    )
      return "waiting";
    let instructions: string | null;
    try {
      instructions = await this.options.readAgentInstructions(AbortSignal.timeout(10_000));
    } catch (error) {
      this.options.onError(error);
      return "retry";
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
    if (!seed) return "waiting";

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
        script: memoryPassScript(systemRole),
        source: memoryPassSource(systemRole, zone.data),
        pauseReason: off ? "Memory is off at your request." : null,
      });
      if (created) {
        this.options.onChanged();
      }
    }
    this.#settled = true;
    return "settled";
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
    if (settings.ownerId !== trigger.createdBy)
      throw new OpensteerError({
        code: "forbidden",
        message: "Memory jobs belong to the personal owner.",
      });
    const { candidates } = await resolveAutomaticModels(
      { store, runners },
      {
        userId: settings.ownerId,
        wants: (settings) =>
          backgroundModelWants(settings, trigger.systemRole === "memory-light" ? "light" : "deep"),
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

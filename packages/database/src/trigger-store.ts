import { personalSettings, requirePersonalOwner } from "./personal-settings-store.js";
import {
  commitPersonalMutation,
  wakeExecutionCommands,
  wakePausedTriggerInterrupts,
  wakeTriggerSchedules,
} from "./personal-mutation.js";
import { TransactionScopeChanged } from "./connection.js";
import { jsonValue, lockCommandIdempotency } from "./store-primitives.js";
import { triggerOccurrenceStateColumns } from "./trigger-occurrence-state.js";
import { createHash } from "node:crypto";
import {
  minThreadAccessMode,
  threadAccessModeAtMost,
  type ThreadAccessMode,
  CommandIdSchema,
  IsoDateTimeSchema,
  ModelSelectionSchema,
  OpensteerError,
  createId,
  type CommandId,
  type EnvironmentId,
  type RunnerId,
  type Run,
  type ThreadId,
  type TriggerId,
  type TriggerOccurrenceId,
  type TriggerRevisionId,
  type TriggerWatchActivationId,
  type UserId,
} from "@opensteer/core";
import {
  AutomationScriptSchema,
  MANAGED_MEMORY_REFUSAL,
  type TriggerSystemRole,
  MAX_PENDING_TRIGGER_OCCURRENCES,
  RETAINED_OUTPUT_OCCURRENCES,
  TRIGGER_PROGRAM_UPDATE_REASON,
  WATCH_CRASH_NOTICE_THRESHOLD,
  WATCH_HEALTHY_WINDOW_MS,
  TriggerOccurrenceSchema,
  TriggerProgramEventSchema,
  TriggerRevisionSchema,
  TriggerSchema,
  TriggerSourceSchema,
  TriggerSummarySchema,
  TriggerWatchActivationSchema,
  firstTriggerFireAt,
  nextTriggerFireAfter,
  triggerOccurrenceErrorMessage,
  triggerAccess,
  validateTriggerSchedule,
  type AutomationPausedBy,
  type AutomationScript,
  type Trigger,
  type TriggerExecutionOutput,
  type TriggerOccurrence,
  type TriggerProgramEvent,
  type TriggerRevision,
  type TriggerSource,
  type TriggerSummary,
  type TriggerWatchActivation,
  type AuthorityThread,
  type TriggerAccess,
} from "@opensteer/triggers";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import {
  lineagePersonalContext,
  liveDelegatingConnection,
  meetsConnectionFloor,
  sendEligible,
  type AgentConnectionAuthority,
} from "./resource-access.js";
import { admitLineageExecution, lineageExecutionStanding } from "./execution-authority.js";
import { PrincipalIdSchema } from "@opensteer/channel-core";
import type {
  DatabaseSchema,
  TriggerOccurrenceTable,
  TriggerWatchActivationTable,
} from "./schema.js";
import { admitThreadExecution } from "./execution-authority.js";
import { isFinalScheduledOccurrence, recordAutomationFailure } from "./automation-failure-store.js";
import { runFromRow } from "./thread-row-mappers.js";
import { createThreadInTransaction, readTask } from "./thread-store.js";
import { personTaskReader, readerSees, type TaskReader } from "./task-reader.js";
import { connectionState } from "./connection-liveness.js";
import { assertDelegationDepth } from "./thread-lineage.js";
import type { Thread } from "@opensteer/core";
type TriggerRow = Selectable<DatabaseSchema["triggers"]>;
type TriggerRevisionRow = Selectable<DatabaseSchema["triggerRevisions"]>;
type TriggerOccurrenceRow = Selectable<TriggerOccurrenceTable>;
type TriggerWatchActivationRow = Selectable<TriggerWatchActivationTable>;
const executableProgram = sql<boolean>`trigger_revisions.script is not null`;
const triggerAuthorityLossPauseReason =
  "Paused because its conversation could not run when it was due.";
interface CreateTriggerInput {
  readonly actorThreadId: ThreadId | null;
  readonly actorAccessMode?: ThreadAccessMode;
  /** The external agent connection the actor works for, checked under this mutation's fence. */
  readonly actorConnectionId?: string;
  readonly anchorThreadId: ThreadId;
  readonly createdBy: UserId;
  readonly idempotencyKey: string;
  readonly name: string;
  /**
   * Runs it in a new task linked under the anchor by parent link alone: no
   * Assignment, off the task list, shown in the anchor's family.
   */
  readonly ownTask?: true;
  readonly script: AutomationScript;
  readonly source: TriggerSource;
  readonly webhookRouteKey?: string;
}
export interface TriggerDetail {
  readonly anchorThread: Thread | null;
  readonly activation: TriggerWatchActivation | null;
  readonly anchorThreadTitle: string;
  readonly createdByThreadTitle: string | null;
  readonly downstreamRuns: readonly {
    readonly occurrenceId: TriggerOccurrenceId;
    readonly run: Run;
    readonly threadTitle: string;
  }[];
  readonly downstreamRunsTruncated: boolean;
  readonly occurrences: readonly TriggerOccurrence[];
  readonly revision: TriggerRevision;
  readonly trigger: Trigger;
}
export interface RunningFiringRef {
  readonly commandId: CommandId;
  readonly environmentId: EnvironmentId;
  readonly executionGeneration: number;
  readonly occurrenceId: TriggerOccurrenceId;
  readonly runnerBootId: string;
  readonly runnerId: RunnerId;
}
export interface TriggerDispatchContext {
  readonly anchorThread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  };
  readonly encryptedSecrets: Buffer | null;
  readonly occurrence: TriggerOccurrence;
  readonly revision: TriggerRevision;
  readonly script: AutomationScript | null;
  readonly trigger: Trigger;
  readonly webhookBody?: Buffer | null;
  readonly agentHome: import("@opensteer/core").ComputerFolder;
}

export interface WatchActivationContext {
  readonly activation: TriggerWatchActivation;
  readonly connectionId?: string;
  readonly agentHome: import("@opensteer/core").ComputerFolder;
}
export interface ActiveWatchBindingInput {
  readonly activationId: TriggerWatchActivationId;
  readonly anchorThreadId: ThreadId;
  readonly createdBy: UserId;
  readonly environmentId: EnvironmentId;
  readonly executionGeneration: number;
  readonly revisionId: TriggerRevisionId;
  readonly triggerId: TriggerId;
}
export interface ActiveTriggerExecutionBindingInput {
  readonly environmentId: EnvironmentId;
  readonly executionGeneration: number;
  readonly occurrenceId: TriggerOccurrenceId;
  readonly requestedBy: UserId;
  readonly runnerBootId: string;
  readonly runnerId: RunnerId;
  readonly threadId: ThreadId;
}

interface TriggerBindingAuthorityRow {
  readonly admittedAccessMode: ThreadAccessMode | null;
  readonly admittedGrantRevision: number | null;
  readonly anchorThreadId: ThreadId;
  readonly createdBy: UserId;
  readonly originConnectionId: string | null;
  readonly threadDoneAt: Date | null;
  readonly threadRemovedAt: Date | null;
  readonly threadStatus: string;
  readonly triggerStatus: string;
}

/**
 * The ONE firing authority rule (Z6 / Rule 1), called by tool token auth, on-demand proxy
 * token renewal (`activeFiringCapabilityScope`), and Runner firing attach (`attachRunnerFirings`):
 * the automation must be active, its anchor task must not be done/archived/removed, its hosting
 * environment must be available, and any originating connected agent must still be live, hold
 * Tasks, and satisfy the admitted grant/mode floor.
 */
async function triggerBindingAuthorityHolds(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  row: TriggerBindingAuthorityRow,
): Promise<boolean> {
  if (
    row.triggerStatus !== "active" ||
    row.threadStatus === "archived" ||
    row.threadDoneAt !== null ||
    row.threadRemovedAt !== null
  ) {
    return false;
  }
  if (!(await admitThreadExecution(database, row.anchorThreadId, row.createdBy))) {
    return false;
  }
  if (!row.originConnectionId) return true;
  try {
    const connection = await liveDelegatingConnection(
      database,
      row.createdBy,
      row.originConnectionId,
    );
    return meetsConnectionFloor(connection, row.admittedGrantRevision, row.admittedAccessMode);
  } catch (error) {
    if (
      error instanceof OpensteerError &&
      (error.code === "forbidden" || error.code === "not_found")
    ) {
      return false;
    }
    throw error;
  }
}

/** Validates every fact carried by a Trigger execution capability. */
export async function assertActiveTriggerExecutionBinding(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  input: ActiveTriggerExecutionBindingInput,
): Promise<void> {
  const row = await database
    .selectFrom("triggerOccurrences")
    .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
    .innerJoin("threads", "threads.id", "triggers.anchorThreadId")
    .select([
      "triggers.anchorThreadId",
      "triggers.createdBy",
      "triggers.originConnectionId",
      "triggers.status as triggerStatus",
      "threads.doneAt as threadDoneAt",
      "threads.removedAt as threadRemovedAt",
      "threads.status as threadStatus",
      "triggerOccurrences.admittedGrantRevision",
      "triggerOccurrences.admittedAccessMode",
    ])
    .where("triggerOccurrences.id", "=", input.occurrenceId)
    .where("triggerOccurrences.environmentId", "=", input.environmentId)
    .where("triggerOccurrences.executionGeneration", "=", input.executionGeneration)
    .where("triggerOccurrences.runnerId", "=", input.runnerId)
    .where("triggerOccurrences.runnerBootId", "=", input.runnerBootId)
    .where("triggerOccurrences.status", "=", "running")
    .where("triggers.anchorThreadId", "=", input.threadId)
    .where("triggers.createdBy", "=", input.requestedBy)
    .executeTakeFirst();
  if (!row || !(await triggerBindingAuthorityHolds(database, row))) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Automation execution is no longer active",
    });
  }
}

/** Validates every fact carried by a continuously running watch capability. */
export async function assertActiveWatchBinding(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  input: ActiveWatchBindingInput,
): Promise<void> {
  const row = await database
    .selectFrom("triggerWatchActivations")
    .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
    .innerJoin("threads", "threads.id", "triggerWatchActivations.anchorThreadId")
    .innerJoin("triggerRevisions", "triggerRevisions.id", "triggerWatchActivations.revisionId")
    .select([
      "triggerWatchActivations.anchorThreadId",
      "triggerWatchActivations.createdBy",
      "triggerWatchActivations.environmentId",
      "triggerWatchActivations.admittedGrantRevision",
      "triggerWatchActivations.admittedAccessMode",
      "triggers.originConnectionId",
      "threads.doneAt as threadDoneAt",
      "threads.removedAt as threadRemovedAt",
      "threads.status as threadStatus",
    ])
    .where("triggerWatchActivations.id", "=", input.activationId)
    .where("triggerWatchActivations.triggerId", "=", input.triggerId)
    .where("triggerWatchActivations.revisionId", "=", input.revisionId)
    .where("triggerWatchActivations.executionGeneration", "=", String(input.executionGeneration))
    .where("triggerWatchActivations.desired", "=", "active")
    .where("triggers.currentRevisionId", "=", input.revisionId)
    .where("triggers.status", "=", "active")
    .where("triggers.kind", "=", "watch")
    .where(executableProgram)
    .executeTakeFirst();
  const admission =
    row &&
    row.threadStatus !== "archived" &&
    row.threadDoneAt === null &&
    row.threadRemovedAt === null
      ? await admitLineageExecution(database, {
          threadId: row.anchorThreadId,
          userId: row.createdBy,
          agentConnectionId: row.originConnectionId,
        })
      : null;
  if (
    !row ||
    row.anchorThreadId !== input.anchorThreadId ||
    row.createdBy !== input.createdBy ||
    row.environmentId !== input.environmentId ||
    !admission ||
    admission.environmentId !== input.environmentId ||
    (row.originConnectionId !== null &&
      !meetsConnectionFloor(
        await liveDelegatingConnection(database, row.createdBy, row.originConnectionId),
        row.admittedGrantRevision,
        row.admittedAccessMode,
      ))
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Watch activation is no longer active",
    });
  }
}
class TriggerOccurrenceSetChanged extends TransactionScopeChanged {}
export async function createTriggerInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: CreateTriggerInput,
  managed?: {
    readonly systemRole: TriggerSystemRole;
    readonly paused: boolean;
    readonly pauseReason: string | null;
  },
) {
  const source = TriggerSourceSchema.parse(input.source);
  const script = AutomationScriptSchema.parse(input.script);
  validateSource(source);
  // The caller's intent, so a replay of an own-task create matches its receipt.
  const requestFingerprint = fingerprint({
    anchorThreadId: input.anchorThreadId,
    name: input.name,
    script,
    source,
    ...(input.ownTask ? { ownTask: true } : {}),
  });
  await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["trigger-create", input.createdBy, input.idempotencyKey])}, 0))`.execute(
    transaction,
  );
  const admitted = await admitTriggerActor(transaction, input.createdBy, input);
  input = admitted.input;
  const assertAnchorScope = async (anchorThreadId: ThreadId) => {
    if (!admitted.connection) return;
    const anchor = await transaction
      .selectFrom("threads")
      .select("originConnectionId")
      .where("id", "=", anchorThreadId)
      .executeTakeFirstOrThrow();
    if (!sendEligible(admitted.connection, anchor.originConnectionId))
      throw new OpensteerError({ code: "forbidden", message: "Task is unavailable" });
  };
  const existing = await transaction
    .selectFrom("triggers")
    .selectAll()
    .where("createdBy", "=", input.createdBy)
    .where("idempotencyKey", "=", input.idempotencyKey)
    .executeTakeFirst();
  if (existing) {
    await lockWatchAnchorPlacementForTrigger(transaction, existing.id);
    const trigger = await lockTriggerForMutation(
      transaction,
      {
        actorThreadId: input.actorThreadId,
        ...(input.actorAccessMode ? { actorAccessMode: input.actorAccessMode } : {}),
        ownerId: input.createdBy,
        triggerId: existing.id,
      },
      "define",
    );
    await assertAnchorScope(trigger.anchorThreadId);
    if (trigger.requestFingerprint !== requestFingerprint) throw idempotencyConflict();
    await requireTriggerExecutionAuthority(transaction, trigger);
    const revision = await transaction
      .selectFrom("triggerRevisions")
      .selectAll()
      .where("id", "=", trigger.currentRevisionId)
      .executeTakeFirstOrThrow();
    const parsed = revisionFromRow(revision);
    return {
      revision: parsed,
      trigger: triggerFromRow(trigger, parsed.script === null),
      wasDuplicate: true,
    };
  }
  const ownTask = input.ownTask ? await createOwnTask(transaction, input, source) : null;
  const anchorThreadId = ownTask?.thread.id ?? input.anchorThreadId;
  if (source.kind === "watch") {
    const anchor = await transaction
      .selectFrom("threads")
      .where("id", "=", anchorThreadId)
      .executeTakeFirst();
    if (!anchor) throw notFound();
    await lockWatchAnchorPlacement(transaction, anchorThreadId);
  }
  const authority = await lockTriggerAuthorityThreads(
    transaction,
    input.actorThreadId,
    anchorThreadId,
    input.actorAccessMode,
  );
  assertTriggerAccess(authority, "define");
  const anchor = await requireAnchorThread(
    transaction,
    anchorThreadId,
    input.createdBy,
    managed !== undefined,
  );
  if (!ownTask) await assertAnchorScope(anchorThreadId);
  const triggerId = createId("trigger");
  const revisionId = createId("triggerRevision");
  const now = new Date();
  const nextFireAt =
    !managed?.paused && source.kind === "schedule" ? firstTriggerFireAt(source.schedule) : null;
  // An automation works for whoever defined it: the authenticated actor's connection, if any.
  // One the person makes on a task without their personal context (from a chat anyone may
  // speak in) works in that task's lineage, so what its program starts never gains it.
  const originConnectionId =
    input.actorConnectionId ??
    (anchor.originConnectionId !== null &&
    !(await lineagePersonalContext(transaction, anchor.originConnectionId))
      ? anchor.originConnectionId
      : null);
  await transaction
    .insertInto("triggers")
    .values({
      ...(originConnectionId ? { originConnectionId } : {}),
      systemRole: managed?.systemRole ?? null,
      anchorThreadId: anchor.id,
      createdAt: now,
      createdBy: input.createdBy,
      createdByThreadId: input.actorThreadId,
      currentRevisionId: revisionId,
      id: triggerId,
      idempotencyKey: input.idempotencyKey,
      kind: source.kind,
      name: input.name,
      nextFireAt,
      pauseReason: managed?.pauseReason ?? null,
      requestFingerprint,
      status: managed?.paused ? "paused" : "active",
      updatedAt: now,
      webhookRouteKey: source.kind === "webhook" ? required(input.webhookRouteKey) : null,
    })
    .execute();
  if (nextFireAt) await wakeTriggerSchedules(transaction);
  await transaction
    .insertInto("triggerRevisions")
    .values({
      createdAt: now,
      createdBy: input.createdBy,
      createdByThreadId: input.actorThreadId,
      id: revisionId,
      ordinal: 1,
      script: jsonValue(script),
      source: jsonValue(source),
      triggerId,
    })
    .execute();
  if (source.kind === "watch") {
    await createWatchActivation(transaction, {
      anchorThreadId: anchor.id,
      createdBy: input.createdBy,
      environmentId: anchor.environmentId,
      revisionId,
      triggerId,
    });
  }
  const [trigger, revision] = await Promise.all([
    transaction
      .selectFrom("triggers")
      .selectAll()
      .where("id", "=", triggerId)
      .executeTakeFirstOrThrow(),
    transaction
      .selectFrom("triggerRevisions")
      .selectAll()
      .where("id", "=", revisionId)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    revision: revisionFromRow(revision),
    trigger: triggerFromRow(trigger),
    wasDuplicate: false,
  };
}

/**
 * The task an automation runs in when it gets its own: a child of the anchor
 * by parent link, with the anchor's computer, engine, model and access.
 * Nothing is handed out, so nothing returns to the anchor.
 * Locks follow ./lock-order.ts: the creation identity and environment before
 * the new Thread's placement rows, and the anchor and caller after them.
 */
async function createOwnTask(
  transaction: Transaction<DatabaseSchema>,
  input: CreateTriggerInput,
  source: TriggerSource,
) {
  const parent = await transaction
    .selectFrom("threads")
    .select(["accessMode", "environmentId", "harnessInstanceId", "modelSelection"])
    .where("id", "=", input.anchorThreadId)
    .executeTakeFirst();
  if (!parent) throw notFound("Task not found");
  // Refuse before creating anything; the locked checks below decide.
  await assertOwnTaskParent(transaction, input, false);
  await assertDelegationDepth(transaction, input.anchorThreadId);
  const idempotencyKey = `trigger-own-task:${fingerprint([input.createdBy, input.idempotencyKey])}`;
  await lockCommandIdempotency(transaction, input.createdBy, idempotencyKey);
  if (source.kind === "watch") await lockWatchAnchorPlacement(transaction, input.anchorThreadId);
  const created = await createThreadInTransaction(transaction, {
    accessMode: parent.accessMode,
    createdBy: input.createdBy,
    environmentId: parent.environmentId,
    harnessInstanceId: parent.harnessInstanceId,
    idempotencyKey,
    modelSelection: ModelSelectionSchema.parse(parent.modelSelection),
    parentThreadId: input.anchorThreadId,
    title: input.name,
  });
  await assertOwnTaskParent(transaction, input, true);
  return created;
}
async function assertOwnTaskParent(
  transaction: Transaction<DatabaseSchema>,
  input: CreateTriggerInput,
  locked: boolean,
): Promise<void> {
  const authority = locked
    ? await lockTriggerAuthorityThreads(
        transaction,
        input.actorThreadId,
        input.anchorThreadId,
        input.actorAccessMode,
      )
    : await readTriggerAuthorityThreads(
        transaction,
        input.actorThreadId,
        input.anchorThreadId,
        input.actorAccessMode,
      );
  assertTriggerAccess(authority, "define");
  if (locked && authority === null)
    await transaction
      .selectFrom("threads")
      .select("id")
      .where("id", "=", input.anchorThreadId)
      .forShare()
      .execute();
  await requireAnchorThread(transaction, input.anchorThreadId, input.createdBy);
}
export class TriggerStore {
  readonly #database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }
  async create(input: CreateTriggerInput) {
    return commitPersonalMutation(this.#database, (transaction) =>
      createTriggerInTransaction(transaction, input),
    );
  }
  async regenerateSystemProgram(input: {
    triggerId: TriggerId;
    ownerId: UserId;
    expectedRevisionId: TriggerRevisionId;
    script: AutomationScript;
  }) {
    return this.#update({ ...input, actorThreadId: null }, true);
  }
  async update(input: {
    readonly actorThreadId: ThreadId | null;
    readonly actorAccessMode?: ThreadAccessMode;
    /** The external agent connection the actor works for, checked under this mutation's fence. */
    readonly actorConnectionId?: string;
    readonly expectedRevisionId: TriggerRevisionId;
    readonly name?: string;
    readonly ownerId: UserId;
    readonly script?: AutomationScript;
    readonly source?: TriggerSource;
    readonly triggerId: TriggerId;
  }): Promise<{
    readonly revision: TriggerRevision;
    readonly trigger: Trigger;
  }> {
    return this.#update(input, false);
  }
  async #update(
    input: Parameters<TriggerStore["update"]>[0],
    systemProgram = false,
  ): Promise<{
    readonly revision: TriggerRevision;
    readonly trigger: Trigger;
  }> {
    if (input.name === undefined && input.script === undefined && input.source === undefined) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Automation update requires at least one of name, script, or source",
      });
    }
    return commitPersonalMutation(this.#database, async (transaction) => {
      input = (await admitTriggerActor(transaction, input.ownerId, input)).input;
      await lockWatchAnchorPlacementForTrigger(transaction, input.triggerId);
      const trigger = await lockTriggerForMutation(transaction, input, "define");
      // Another lineage's script, or the person's, would run with authority this actor lacks.
      if (
        input.actorConnectionId &&
        (input.script !== undefined || input.source !== undefined) &&
        trigger.originConnectionId !== input.actorConnectionId
      )
        throw new OpensteerError({
          code: "forbidden",
          message:
            "A connected agent cannot replace the program of an automation it did not create.",
        });
      if (!systemProgram) await requireTriggerExecutionAuthority(transaction, trigger);
      if (systemProgram && !trigger.systemRole)
        throw conflict("Only system automations can regenerate programs");
      if (
        trigger.systemRole &&
        !systemProgram &&
        (input.name !== undefined ||
          input.script !== undefined ||
          (input.source !== undefined &&
            (input.source.kind !== "schedule" ||
              input.source.schedule.kind !== "cron" ||
              input.source.schedule.payload !== undefined)))
      ) {
        throw conflict(MANAGED_MEMORY_REFUSAL);
      }
      if (trigger.status === "archived" && !systemProgram)
        throw conflict("Archived automations cannot be changed");
      if (trigger.currentRevisionId !== input.expectedRevisionId) {
        throw conflict("Automation revision changed; read it again before updating");
      }
      const current = await transaction
        .selectFrom("triggerRevisions")
        .selectAll()
        .select(executableProgram.as("executable"))
        .where("id", "=", trigger.currentRevisionId)
        .executeTakeFirstOrThrow();
      const source = TriggerSourceSchema.parse(input.source ?? current.source);
      if (source.kind !== trigger.kind) {
        throw new OpensteerError({
          code: "bad_request",
          message: "An automation cannot change between schedule, webhook, and watch sources",
        });
      }
      validateSource(source);
      const nextScript =
        input.script !== undefined
          ? AutomationScriptSchema.parse(input.script)
          : current.script !== null
            ? AutomationScriptSchema.parse(current.script)
            : null;
      if (!nextScript) {
        throw conflict(TRIGGER_PROGRAM_UPDATE_REASON);
      }
      const revisionId = createId("triggerRevision");
      const now = new Date();
      await transaction
        .insertInto("triggerRevisions")
        .values({
          createdAt: now,
          createdBy: input.ownerId,
          createdByThreadId: input.actorThreadId,
          id: revisionId,
          ordinal: current.ordinal + 1,
          script: jsonValue(nextScript),
          source: jsonValue(source),
          triggerId: trigger.id,
        })
        .execute();
      // A new source re-arms the clock the way a resume does: an elapsed
      // one-shot stays elapsed. A repair also skips missed ticks, keeping
      // a future next run (including a manual reschedule).
      const rearmed =
        input.source !== undefined ||
        (!current.executable && trigger.nextFireAt !== null && trigger.nextFireAt <= now)
          ? {
              nextFireAt:
                trigger.status === "active" && source.kind === "schedule"
                  ? resumedScheduleFireAt(source.schedule, now)
                  : null,
            }
          : {};
      const updated = await transaction
        .updateTable("triggers")
        .set({
          ...(input.script !== undefined && trigger.pauseReason === TRIGGER_PROGRAM_UPDATE_REASON
            ? { pauseReason: null }
            : {}),
          currentRevisionId: revisionId,
          ...(input.name === undefined
            ? {}
            : {
                name: input.name,
              }),
          ...rearmed,
          updatedAt: now,
        })
        .where("id", "=", trigger.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      // A new script can make a waiting schedule runnable at its existing time,
      // so any update that leaves one armed re-arms the scheduler.
      if (updated.kind === "schedule" && updated.status === "active" && updated.nextFireAt)
        await wakeTriggerSchedules(transaction);
      if (trigger.kind === "watch") {
        await stopActiveWatchActivation(transaction, trigger.id, now);
        if (updated.status === "active") {
          const anchor = await transaction
            .selectFrom("threads")
            .select("environmentId")
            .where("id", "=", trigger.anchorThreadId)
            .executeTakeFirstOrThrow();
          await createWatchActivation(transaction, {
            anchorThreadId: trigger.anchorThreadId,
            createdBy: trigger.createdBy,
            environmentId: anchor.environmentId,
            revisionId,
            triggerId: trigger.id,
          });
        }
      }
      const revision = await transaction
        .selectFrom("triggerRevisions")
        .selectAll()
        .where("id", "=", revisionId)
        .executeTakeFirstOrThrow();
      return {
        revision: revisionFromRow(revision),
        trigger: triggerFromRow(updated),
      };
    });
  }
  async setStatus(input: {
    readonly actorThreadId: ThreadId | null;
    readonly actorAccessMode?: ThreadAccessMode;
    /** The external agent connection the actor works for, checked under this mutation's fence. */
    readonly actorConnectionId?: string;
    readonly ownerId: UserId;
    readonly status: "active" | "paused" | "archived";
    readonly triggerId: TriggerId;
  }): Promise<Trigger> {
    return (await this.setStatusWithEffects(input)).trigger;
  }
  async setStatusWithEffects(input: {
    readonly actorThreadId: ThreadId | null;
    readonly actorAccessMode?: ThreadAccessMode;
    /** The external agent connection the actor works for, checked under this mutation's fence. */
    readonly actorConnectionId?: string;
    readonly ownerId: UserId;
    readonly status: "active" | "paused" | "archived";
    readonly triggerId: TriggerId;
  }): Promise<{
    readonly canceledOccurrenceIds: readonly TriggerOccurrenceId[];
    readonly runningFirings: readonly RunningFiringRef[];
    readonly trigger: Trigger;
  }> {
    return commitPersonalMutation(
      this.#database,
      async (transaction) => {
        input = (await admitTriggerActor(transaction, input.ownerId, input)).input;
        const ending = input.status === "paused" || input.status === "archived";
        const observedActive = ending
          ? await transaction
              .selectFrom("triggerOccurrences")
              .select(["id"])
              .where("triggerId", "=", input.triggerId)
              .where("status", "in", ["pending", "running"])
              .orderBy("id", "asc")
              .forNoKeyUpdate()
              .execute()
          : [];
        const heldOccurrences = new Set(observedActive.map(({ id }) => id));
        await lockWatchAnchorPlacementForTrigger(transaction, input.triggerId);
        const trigger = await lockTriggerForMutation(
          transaction,
          input,
          input.status === "archived" ? "define" : "control",
        );
        await requireTriggerExecutionAuthority(transaction, trigger);
        if (trigger.systemRole && input.status === "archived")
          throw conflict(MANAGED_MEMORY_REFUSAL);
        if (trigger.status === "archived") {
          if (input.status === "archived") {
            return {
              canceledOccurrenceIds: [],
              runningFirings: [],
              trigger: triggerFromRow(trigger),
            };
          }
          throw conflict("Archived automations cannot be reactivated");
        }
        const revision =
          input.status === "archived"
            ? null
            : await transaction
                .selectFrom("triggerRevisions")
                .select(["source", executableProgram.as("executable")])
                .where("id", "=", trigger.currentRevisionId)
                .executeTakeFirstOrThrow();
        const needsUpdate = revision !== null && !revision.executable;
        if (input.status === "active" && needsUpdate) throw conflict(TRIGGER_PROGRAM_UPDATE_REASON);
        // Repeating the current status is a no-op: a paused Trigger keeps
        // its reason and an active one keeps its failure count.
        if (trigger.status === input.status) {
          return {
            canceledOccurrenceIds: [],
            runningFirings: [],
            trigger: triggerFromRow(trigger, needsUpdate),
          };
        }
        const now = new Date();
        let activeOccurrences: {
          readonly commandId: CommandId;
          readonly connectionId: string | null;
          readonly contactLostAt: Date | null;
          readonly environmentId: EnvironmentId;
          readonly executionGeneration: number;
          readonly id: TriggerOccurrenceId;
          readonly runnerBootId: string | null;
          readonly runnerId: RunnerId | null;
          readonly status: TriggerOccurrenceRow["status"];
        }[] = [];
        if (ending) {
          activeOccurrences = await transaction
            .selectFrom("triggerOccurrences")
            .select([
              "commandId",
              "connectionId",
              "contactLostAt",
              "environmentId",
              "executionGeneration",
              "id",
              "runnerBootId",
              "runnerId",
              "status",
            ])
            .where("triggerId", "=", trigger.id)
            .where("status", "in", ["pending", "running"])
            .orderBy("id", "asc")
            .execute();
          if (activeOccurrences.some(({ id }) => !heldOccurrences.has(id))) {
            throw new TriggerOccurrenceSetChanged(
              "Active occurrences changed before Trigger fencing",
            );
          }
        }
        let updatedRow: TriggerRow;
        if (input.status === "paused") {
          updatedRow = await pauseTriggerInTransaction(transaction, trigger, {
            pausedBy: input.actorConnectionId
              ? "connection"
              : input.actorThreadId
                ? "agent"
                : "person",
            pausedByConnectionId: input.actorConnectionId ?? null,
            pausedByThreadId: input.actorThreadId,
          });
        } else {
          let nextFireAt = trigger.nextFireAt;
          if (trigger.kind === "schedule") {
            if (!revision) {
              nextFireAt = null;
            } else {
              const source = TriggerSourceSchema.parse(revision.source);
              if (source.kind !== "schedule")
                throw new Error("Schedule Trigger revision is invalid");
              nextFireAt = resumedScheduleFireAt(source.schedule, now);
            }
          }
          updatedRow = await transaction
            .updateTable("triggers")
            .set({
              ...(input.status === "active"
                ? {
                    failingSince: null,
                    failureNotifiedAt: null,
                    overrunNotifiedAt: null,
                    watchCrashNotifiedAt: null,
                  }
                : {}),
              nextFireAt,
              pauseReason: null,
              pausedAt: null,
              pausedBy: null,
              pausedByConnectionId: null,
              pausedByThreadId: null,
              status: input.status,
              updatedAt: now,
            })
            .where("id", "=", trigger.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          if (nextFireAt) await wakeTriggerSchedules(transaction);
          if (trigger.kind === "watch") {
            await stopActiveWatchActivation(transaction, trigger.id, updatedRow.updatedAt);
            if (input.status === "active") {
              const anchor = await transaction
                .selectFrom("threads")
                .select("environmentId")
                .where("id", "=", trigger.anchorThreadId)
                .executeTakeFirstOrThrow();
              await createWatchActivation(transaction, {
                anchorThreadId: trigger.anchorThreadId,
                createdBy: trigger.createdBy,
                environmentId: anchor.environmentId,
                revisionId: trigger.currentRevisionId,
                triggerId: trigger.id,
              });
            }
          }
        }
        const canceledOccurrenceIds: TriggerOccurrenceId[] = [];
        const runningFirings: RunningFiringRef[] = [];
        if (ending && activeOccurrences.length > 0) {
          const pending = activeOccurrences.filter((row) => row.status === "pending");
          const lostPersonalRunning = activeOccurrences.filter(
            (row) =>
              row.status === "running" && row.connectionId === null && row.contactLostAt !== null,
          );
          const commandIdsToLock = [
            ...new Set([
              ...pending.map(({ commandId }) => commandId),
              ...lostPersonalRunning.map(({ commandId }) => commandId),
            ]),
          ].sort();
          if (commandIdsToLock.length > 0) {
            await transaction
              .selectFrom("commands")
              .select("id")
              .where("id", "in", commandIdsToLock)
              .orderBy("id", "asc")
              .forNoKeyUpdate()
              .execute();
          }
          if (pending.length > 0) {
            const cancellation = {
              code: input.status === "archived" ? "canceled_by_archive" : "canceled_by_pause",
              message:
                input.status === "archived"
                  ? "Automation occurrence was canceled when the automation was archived"
                  : "Automation occurrence was canceled when the automation was paused",
            };
            for (const row of pending) {
              const command = await transaction
                .updateTable("commands")
                .set({
                  lastError: jsonValue(cancellation),
                  status: "failed",
                  updatedAt: now,
                })
                .where("id", "=", row.commandId)
                .where("status", "=", "pending")
                .executeTakeFirst();
              if (command.numUpdatedRows !== 1n) continue;
              await transaction
                .updateTable("triggerOccurrences")
                .set({
                  completedAt: now,
                  error: jsonValue(cancellation),
                  ...triggerOccurrenceStateColumns("canceled"),
                  updatedAt: now,
                })
                .where("id", "=", row.id)
                .where("status", "=", "pending")
                .execute();
              canceledOccurrenceIds.push(row.id);
            }
          }
          if (lostPersonalRunning.length > 0) {
            // AA12: A person's own firing whose computer already lost contact settles to
            // 'unknown' when ended/paused so a dead computer cannot deadlock later firings.
            const unknownPayload = jsonValue({
              code: "outcome_unknown",
              message: "Outcome unknown: ended after contact with its computer was lost.",
            });
            for (const row of lostPersonalRunning) {
              await transaction
                .updateTable("commands")
                .set({
                  lastError: unknownPayload,
                  status: "unknown",
                  updatedAt: now,
                })
                .where("id", "=", row.commandId)
                .where("status", "=", "dispatched")
                .execute();
              await transaction
                .updateTable("triggerOccurrences")
                .set({
                  completedAt: now,
                  error: unknownPayload,
                  ...triggerOccurrenceStateColumns("unknown"),
                  updatedAt: now,
                })
                .where("id", "=", row.id)
                .where("status", "=", "running")
                .execute();
            }
          }
          if (canceledOccurrenceIds.length > 0 || lostPersonalRunning.length > 0) {
            await wakeExecutionCommands(transaction);
          }
          for (const row of activeOccurrences) {
            if (row.status === "running" && row.runnerId && row.runnerBootId) {
              runningFirings.push({
                commandId: row.commandId,
                environmentId: row.environmentId,
                executionGeneration: row.executionGeneration,
                occurrenceId: row.id,
                runnerBootId: row.runnerBootId,
                runnerId: row.runnerId,
              });
            }
          }
        }
        return {
          canceledOccurrenceIds,
          runningFirings,
          trigger: triggerFromRow(updatedRow, needsUpdate),
        };
      },
      (error) => error instanceof TriggerOccurrenceSetChanged,
    );
  }
  async setNextFire(input: {
    readonly actorThreadId: ThreadId | null;
    readonly actorAccessMode?: ThreadAccessMode;
    /** The external agent connection the actor works for, checked under this mutation's fence. */
    readonly actorConnectionId?: string;
    readonly nextFireAt: string;
    readonly ownerId: UserId;
    readonly triggerId: TriggerId;
  }): Promise<Trigger> {
    const parsed = IsoDateTimeSchema.safeParse(input.nextFireAt);
    if (!parsed.success) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Next fire time must be an ISO-8601 instant",
      });
    }
    const nextFireAt = new Date(parsed.data);
    return commitPersonalMutation(this.#database, async (transaction) => {
      input = (await admitTriggerActor(transaction, input.ownerId, input)).input;
      const trigger = await lockTriggerForMutation(transaction, input, "control");
      await requireTriggerExecutionAuthority(transaction, trigger);
      if (nextFireAt.getTime() <= Date.now()) {
        throw new OpensteerError({
          code: "bad_request",
          message: "Next fire time must be in the future",
        });
      }
      if (trigger.status !== "active" || trigger.kind !== "schedule") {
        throw conflict("Only active cron schedule automations can reschedule their next run");
      }
      const revision = await transaction
        .selectFrom("triggerRevisions")
        .select(["source", executableProgram.as("executable")])
        .where("id", "=", trigger.currentRevisionId)
        .executeTakeFirstOrThrow();
      if (!revision.executable) throw conflict(TRIGGER_PROGRAM_UPDATE_REASON);
      const source = TriggerSourceSchema.parse(revision.source);
      if (source.kind !== "schedule" || source.schedule.kind !== "cron") {
        throw conflict("Only active cron schedule automations can reschedule their next run");
      }
      const updated = await transaction
        .updateTable("triggers")
        .set({
          nextFireAt,
          updatedAt: new Date(),
        })
        .where("id", "=", trigger.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await wakeTriggerSchedules(transaction);
      return triggerFromRow(updated);
    });
  }
  /** The command runs an automation whose chat is paused: its work is held until it is back. */
  async commandChatWaiting(commandId: CommandId): Promise<boolean> {
    const trigger = await this.#database
      .selectFrom("triggerOccurrences")
      .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
      .select(["triggers.originConnectionId"])
      .where("triggerOccurrences.commandId", "=", commandId)
      .executeTakeFirst();
    return trigger ? triggerChatWaiting(this.#database, trigger) : false;
  }
  async listForOwner(input: {
    readonly anchorThreadId?: ThreadId;
    readonly limit?: number;
    readonly ownerId: UserId;
    readonly systemRole?: TriggerSystemRole;
    /** Only the automations in one connected agent's lineage. */
    readonly originConnectionId?: string;
    /** Who reads: a memory worker's own task tree sees only automations with personal context. */
    readonly reader: TaskReader;
  }): Promise<readonly TriggerSummary[]> {
    await requirePersonalOwner(this.#database, input.ownerId);
    let query = this.#database
      .selectFrom("triggers")
      .innerJoin("threads", "threads.id", "triggers.anchorThreadId")
      .selectAll("triggers")
      .select("threads.title as anchorThreadTitle")
      .where("triggers.createdBy", "=", input.ownerId)
      .$if(input.reader.kind === "work", (q) => q.where(automationReaderSees(input.reader)))
      .$if(input.originConnectionId !== undefined, (q) =>
        q.where("triggers.originConnectionId", "=", input.originConnectionId!),
      );
    if (input.systemRole) query = query.where("triggers.systemRole", "=", input.systemRole);
    const familyOf = input.anchorThreadId;
    // A conversation's family: its own automations, and those of tasks linked
    // under it without an Assignment, which only this list leads to. Those stay
    // once ended, so their task is never stranded.
    query = familyOf
      ? query.where((eb) =>
          eb.or([
            eb.and([
              eb("triggers.anchorThreadId", "=", familyOf),
              eb("triggers.status", "!=", "archived"),
            ]),
            eb.and([
              eb("threads.parentThreadId", "=", familyOf),
              eb.not(
                eb.exists(
                  eb
                    .selectFrom("delegations")
                    .select("delegations.id")
                    .whereRef("delegations.childThreadId", "=", "threads.id"),
                ),
              ),
            ]),
          ]),
        )
      : query.where("triggers.status", "!=", "archived");
    const rows = await query
      .orderBy(sql<boolean>`triggers.status = 'archived'`, "asc")
      .orderBy(sql<boolean>`triggers.system_role is not null`, "desc")
      .orderBy("triggers.updatedAt", "desc")
      .orderBy("triggers.id", "desc")
      .limit(Math.min(Math.max(input.limit ?? 50, 1), 100))
      .execute();
    if (rows.length === 0) return [];
    const triggerIds = rows.map(({ id }) => id);
    const [revisions, occurrences, activations] = await Promise.all([
      this.#database
        .selectFrom("triggerRevisions")
        .select(["id", "source", executableProgram.as("executable")])
        .where(
          "id",
          "in",
          rows.map(({ currentRevisionId }) => currentRevisionId),
        )
        .execute(),
      this.#database
        .selectFrom("triggerOccurrences")
        .leftJoin("commands", "commands.id", "triggerOccurrences.commandId")
        .select([
          "triggerOccurrences.completedAt",
          "triggerOccurrences.contactLostAt",
          "triggerOccurrences.createdAt",
          "triggerOccurrences.error",
          "triggerOccurrences.event",
          "triggerOccurrences.exitCode",
          "triggerOccurrences.id",
          "triggerOccurrences.status",
          "triggerOccurrences.triggerId",
          "commands.frameSentAt",
        ])
        .distinctOn("triggerOccurrences.triggerId")
        .where("triggerOccurrences.triggerId", "in", triggerIds)
        .orderBy("triggerOccurrences.triggerId")
        .orderBy("triggerOccurrences.createdAt", "desc")
        .orderBy("triggerOccurrences.id", "desc")
        .execute(),
      this.#database
        .selectFrom("triggerWatchActivations")
        .select(["lastError", "observed", "triggerId"])
        .distinctOn("triggerId")
        .where("triggerId", "in", triggerIds)
        .orderBy("triggerId")
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .execute(),
    ]);
    const currentRevisions = new Map(revisions.map((revision) => [revision.id, revision]));
    const latest = new Map(occurrences.map((occurrence) => [occurrence.triggerId, occurrence]));
    const watches = new Map(activations.map((activation) => [activation.triggerId, activation]));
    return rows.map((row) => {
      const occurrence = latest.get(row.id);
      const watch = row.kind === "watch" ? watches.get(row.id) : undefined;
      const { anchorThreadTitle, ...trigger } = row;
      const revision = currentRevisions.get(row.currentRevisionId);
      return TriggerSummarySchema.parse({
        ...triggerFromRow(trigger, !revision?.executable),
        anchorThreadTitle,
        latestOccurrence: occurrence
          ? {
              completedAt: occurrence.completedAt?.toISOString() ?? null,
              contactLostAt: occurrence.contactLostAt?.toISOString() ?? null,
              createdAt: occurrence.createdAt.toISOString(),
              error: triggerOccurrenceErrorMessage(occurrence.error),
              exitCode: occurrence.exitCode,
              id: occurrence.id,
              sent: occurrence.frameSentAt !== null,
              source: TriggerProgramEventSchema.parse(occurrence.event).source.kind,
              status: occurrence.status,
            }
          : null,
        source: withoutSchedulePayload(TriggerSourceSchema.parse(revision?.source)),
        watch: watch
          ? {
              lastError: watch.lastError,
              observed: watch.observed,
            }
          : null,
      });
    });
  }
  async watchEnvironmentForTrigger(triggerId: TriggerId): Promise<EnvironmentId | null> {
    const row = await this.#database
      .selectFrom("triggerWatchActivations")
      .select("environmentId")
      .where("triggerId", "=", triggerId)
      .orderBy("createdAt", "desc")
      .executeTakeFirst();
    return row?.environmentId ?? null;
  }
  async watchEnvironments(): Promise<readonly EnvironmentId[]> {
    const rows = await this.#database
      .selectFrom("triggerWatchActivations")
      .select("environmentId")
      .distinct()
      .execute();
    return rows.map(({ environmentId }) => environmentId);
  }
  async reconcileWatchesForRunner(input: {
    readonly environmentId: EnvironmentId;
    readonly unavailableReason?: string;
    readonly leaseExpiresAt: Date;
    readonly runnerBootId: string;
    readonly runnerConnectionGeneration: number;
    readonly runnerId: RunnerId;
  }): Promise<{
    readonly activations: readonly WatchActivationContext[];
    readonly reconcileGeneration: number;
    readonly unavailable?: true;
  }> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const rows = await transaction
        .selectFrom("triggerWatchActivations")
        .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
        .innerJoin("triggerRevisions", "triggerRevisions.id", "triggerWatchActivations.revisionId")
        .selectAll("triggerWatchActivations")
        .select(executableProgram.as("executable"))
        .where("triggerWatchActivations.environmentId", "=", input.environmentId)
        .where("triggerWatchActivations.desired", "=", "active")
        .where("triggers.kind", "=", "watch")
        .orderBy("triggerWatchActivations.id", "asc")
        .forNoKeyUpdate("triggerWatchActivations")
        .execute();
      const activations: WatchActivationContext[] = [];
      let unavailable = false;
      for (const row of rows) {
        const trigger = await transaction
          .selectFrom("triggers")
          .selectAll()
          .where("id", "=", row.triggerId)
          .executeTakeFirstOrThrow();
        const admission = await admitLineageExecution(transaction, {
          threadId: row.anchorThreadId,
          userId: row.createdBy,
          agentConnectionId: trigger.originConnectionId,
        });
        if (
          trigger.status !== "active" ||
          trigger.currentRevisionId !== row.revisionId ||
          !row.executable ||
          !admission ||
          admission.environmentId !== row.environmentId
        ) {
          await transaction
            .updateTable("triggerWatchActivations")
            .set({
              desired: "stopped",
              leaseExpiresAt: null,
              observed: sql`case when runner_id is null then 'stopped' else observed end`,
              updatedAt: new Date(),
            })
            .where("id", "=", row.id)
            .execute();
          continue;
        }
        if (input.unavailableReason !== undefined) {
          await transaction
            .updateTable("triggerWatchActivations")
            .set({
              healthySince: null,
              lastError: input.unavailableReason.slice(0, 20_000),
              lastExitCode: null,
              leaseExpiresAt: null,
              observed: "backoff",
              updatedAt: new Date(),
            })
            .where("id", "=", row.id)
            .execute();
          unavailable = true;
          continue;
        }
        const witness = await automationHandoffWitness(transaction, trigger);
        const sameExecution =
          row.runnerBootId === input.runnerBootId &&
          !row.terminalEvidenceAt &&
          row.observed !== "stopped" &&
          row.observed !== "expired";
        const nextExecutionGeneration = sameExecution
          ? Number(row.executionGeneration)
          : Number(row.executionGeneration) + 1;
        if (!Number.isSafeInteger(nextExecutionGeneration)) {
          throw new OpensteerError({
            code: "internal",
            message: "Watch execution generation overflow",
          });
        }
        const binding = {
          ...(sameExecution ? {} : { ...witness, terminalEvidenceAt: null, contactLostAt: null }),
          executionGeneration: nextExecutionGeneration,
          leaseExpiresAt: input.leaseExpiresAt,
          ...(sameExecution
            ? {}
            : { healthySince: null, observed: "starting" as const, restartCount: 0 }),
          runnerBootId: input.runnerBootId,
          runnerConnectionGeneration: input.runnerConnectionGeneration,
          runnerId: input.runnerId,
          updatedAt: new Date(),
        };
        const preserve = row.connectionId !== null && !sameExecution;
        if (preserve) {
          if (
            row.runnerId !== input.runnerId ||
            Number(row.runnerConnectionGeneration) > input.runnerConnectionGeneration
          )
            continue;
          const now = new Date();
          await transaction
            .updateTable("triggerWatchActivations")
            .set({
              desired: "stopped",
              observed: "stopped",
              leaseExpiresAt: null,
              updatedAt: now,
              terminalEvidenceAt: row.terminalEvidenceAt ?? now,
              contactLostAt: row.terminalEvidenceAt ? row.contactLostAt : now,
            })
            .where("id", "=", row.id)
            .execute();
        }
        const { executable: _executable, ...prior } = row;
        const updated = preserve
          ? await transaction
              .insertInto("triggerWatchActivations")
              .values({
                ...prior,
                ...binding,
                id: createId("triggerWatchActivation"),
                createdAt: new Date(),
                lastError: null,
                lastExitCode: null,
                stderrTail: "",
                stdoutTail: "",
              })
              .returningAll()
              .executeTakeFirstOrThrow()
          : await transaction
              .updateTable("triggerWatchActivations")
              .set(binding)
              .where("id", "=", row.id)
              .returningAll()
              .executeTakeFirstOrThrow();
        activations.push({
          activation: watchActivationFromRow(updated),
          ...(updated.connectionId ? { connectionId: updated.connectionId } : {}),
          agentHome: (await personalSettings(transaction)).agentHome,
        });
      }
      const generation = await sql<{
        generation: string;
      }>`
        select nextval('public.trigger_watch_reconcile_generation')::text as generation
      `.execute(transaction);
      const reconcileGeneration = Number(generation.rows[0]?.generation);
      if (!Number.isSafeInteger(reconcileGeneration) || reconcileGeneration < 1) {
        throw new OpensteerError({
          code: "internal",
          message: "Invalid watch reconcile generation",
        });
      }
      return {
        activations,
        reconcileGeneration,
        ...(unavailable ? { unavailable: true } : {}),
      };
    });
  }
  async stopConnectionWatch(id: TriggerWatchActivationId, generation: number): Promise<void> {
    await this.#database
      .updateTable("triggerWatchActivations")
      .set({
        desired: "stopped",
        leaseExpiresAt: null,
        observed: sql`case when runner_id is null then 'stopped' else observed end`,
        updatedAt: new Date(),
      })
      .where("id", "=", id)
      .where("executionGeneration", "=", String(generation))
      .where("desired", "=", "active")
      .execute();
  }
  async assertActiveWatchBinding(input: ActiveWatchBindingInput): Promise<void> {
    await assertActiveWatchBinding(this.#database, input);
  }
  async watchScript(input: ActiveWatchBindingInput): Promise<{
    readonly encryptedSecrets: Buffer | null;
    readonly script: AutomationScript;
    readonly triggerId: TriggerId;
  }> {
    await this.assertActiveWatchBinding(input);
    const [revisionRow, triggerRow] = await Promise.all([
      this.#database
        .selectFrom("triggerRevisions")
        .select("script")
        .where("id", "=", input.revisionId)
        .where("triggerId", "=", input.triggerId)
        .executeTakeFirst(),
      this.#database
        .selectFrom("triggers")
        .select("encryptedSecrets")
        .where("id", "=", input.triggerId)
        .executeTakeFirstOrThrow(),
    ]);
    if (!revisionRow?.script) throw conflict(TRIGGER_PROGRAM_UPDATE_REASON);
    return {
      encryptedSecrets: triggerRow.encryptedSecrets ?? null,
      script: AutomationScriptSchema.parse(revisionRow.script),
      triggerId: input.triggerId,
    };
  }
  async getEncryptedSecrets(ownerId: UserId, triggerId: TriggerId): Promise<Buffer | null> {
    await requirePersonalOwner(this.#database, ownerId);
    const row = await this.#database
      .selectFrom("triggers")
      .select("encryptedSecrets")
      .where("id", "=", triggerId)
      .where("createdBy", "=", ownerId)
      .executeTakeFirst();
    if (!row) throw notFound("Automation not found");
    return row.encryptedSecrets ?? null;
  }
  async updateEncryptedSecrets<Result>(input: {
    readonly actorAccessMode?: ThreadAccessMode;
    readonly actorConnectionId?: string;
    readonly actorThreadId: ThreadId | null;
    readonly ownerId: UserId;
    readonly transform: (current: Buffer | null) => Promise<{
      readonly result: Result;
      readonly sealed: { readonly envelope: Buffer; readonly keyVersion: number } | null;
    }>;
    readonly triggerId: TriggerId;
  }): Promise<{ readonly result: Result; readonly trigger: Trigger }> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const admitted = await admitTriggerActor(transaction, input.ownerId, input);
      const trigger = await lockTriggerForMutation(transaction, admitted.input, "define");
      if (
        admitted.connection?.grant.scope === "selected" &&
        trigger.originConnectionId !== admitted.input.actorConnectionId
      ) {
        throw notFound();
      }
      if (
        admitted.input.actorConnectionId &&
        trigger.originConnectionId !== admitted.input.actorConnectionId
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message:
            "A connected agent cannot change the secrets of an automation it did not create.",
        });
      }
      if (trigger.systemRole) throw conflict(MANAGED_MEMORY_REFUSAL);
      if (trigger.status === "archived") throw conflict("Archived automations cannot be changed");
      const { result, sealed } = await input.transform(trigger.encryptedSecrets ?? null);
      const updated = await transaction
        .updateTable("triggers")
        .set({
          encryptedSecrets: sealed?.envelope ?? null,
          secretsKeyVersion: sealed?.keyVersion ?? null,
          updatedAt: new Date(),
        })
        .where("id", "=", trigger.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { result, trigger: triggerFromRow(updated) };
    });
  }
  async applyWatchStatus(input: {
    readonly verifiedContainment?: boolean;
    readonly activationId: TriggerWatchActivationId;
    readonly executionGeneration: number;
    readonly healthySince: Date | null;
    readonly lastError: string | null;
    readonly lastExitCode: number | null;
    readonly observed: TriggerWatchActivation["observed"];
    readonly restartCount: number;
    readonly runnerBootId: string;
    readonly runnerConnectionGeneration: number;
    readonly runnerId: RunnerId;
    readonly stderrTail: string;
    readonly stdoutTail: string;
  }): Promise<{
    readonly activation: TriggerWatchActivation;
  }> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const identity = await transaction
        .selectFrom("triggerWatchActivations")
        .select("triggerId")
        .where("id", "=", input.activationId)
        .executeTakeFirst();
      if (!identity) throw notFound("Watch activation not found");
      const trigger = await transaction
        .selectFrom("triggers")
        .selectAll()
        .where("id", "=", identity.triggerId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const activation = await transaction
        .selectFrom("triggerWatchActivations")
        .selectAll()
        .where("id", "=", input.activationId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!activation) throw notFound("Watch activation not found");
      const terminal = input.observed === "stopped" || input.observed === "expired";
      const admittedConnectionGeneration = Number(activation.runnerConnectionGeneration);
      if (
        activation.runnerId !== input.runnerId ||
        activation.runnerBootId !== input.runnerBootId ||
        (admittedConnectionGeneration !== input.runnerConnectionGeneration &&
          !(terminal && input.runnerConnectionGeneration > admittedConnectionGeneration)) ||
        Number(activation.executionGeneration) !== input.executionGeneration
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Watch status binding is stale",
        });
      }
      if (input.restartCount < activation.restartCount) {
        throw conflict("Watch status is older than the stored restart count");
      }
      const now = new Date();
      const failureDelta =
        activation.desired === "active" ? input.restartCount - activation.restartCount : 0;
      let consecutiveFailures = activation.consecutiveFailures + failureDelta;
      const recovered =
        activation.desired === "active" &&
        input.observed === "running" &&
        input.healthySince !== null &&
        now.getTime() - input.healthySince.getTime() >= WATCH_HEALTHY_WINDOW_MS;
      if (recovered) {
        consecutiveFailures = 0;
        if (trigger.failingSince !== null || trigger.watchCrashNotifiedAt !== null) {
          await transaction
            .updateTable("triggers")
            .set({
              failingSince: null,
              watchCrashNotifiedAt: null,
              updatedAt: now,
            })
            .where("id", "=", trigger.id)
            .execute();
        }
      }
      // Y10 / T8: Never auto-pause a crash-looping watch; emit one 'watch-crash-loop' notice
      // while the supervisor continues retrying with exponential backoff.
      const containmentHalted =
        activation.desired === "active" &&
        trigger.status === "active" &&
        input.observed === "backoff" &&
        Boolean(input.lastError?.includes("containment"));
      const crashLooping =
        (activation.desired === "active" &&
          trigger.status === "active" &&
          consecutiveFailures >= WATCH_CRASH_NOTICE_THRESHOLD) ||
        containmentHalted;
      if (crashLooping) {
        await transaction
          .updateTable("triggers")
          .set({
            failingSince: trigger.failingSince ?? now,
            watchCrashNotifiedAt: trigger.watchCrashNotifiedAt ?? now,
            updatedAt: now,
          })
          .where("id", "=", trigger.id)
          .execute();
        if (!trigger.watchCrashNotifiedAt) {
          const exitPrefix = input.lastExitCode !== null ? `exit ${input.lastExitCode}: ` : "";
          const rawDetail =
            input.lastError ??
            (input.stderrTail.trim() ? input.stderrTail.slice(-2_000) : "Watch exited repeatedly.");
          await recordAutomationFailure(transaction, {
            activationId: activation.id,
            detail: `${exitPrefix}${rawDetail}`,
            reason: "watch-crash-loop",
            triggerId: trigger.id,
          });
        }
      }
      const updated = await transaction
        .updateTable("triggerWatchActivations")
        .set({
          consecutiveFailures,
          desired: activation.desired,
          healthySince: input.healthySince,
          lastError: input.lastError,
          lastExitCode: input.lastExitCode,
          observed: input.observed,
          ...(terminal && activation.connectionId
            ? {
                terminalEvidenceAt: activation.terminalEvidenceAt ?? now,
                contactLostAt: activation.terminalEvidenceAt
                  ? activation.contactLostAt
                  : input.verifiedContainment
                    ? null
                    : now,
              }
            : {}),
          restartCount: input.restartCount,
          stderrTail: input.stderrTail,
          stdoutTail: input.stdoutTail,
          updatedAt: now,
        })
        .where("id", "=", activation.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        activation: watchActivationFromRow(updated),
      };
    });
  }
  async getForOwner(
    triggerId: TriggerId,
    ownerId: UserId,
    occurrenceLimit: number,
    /** Who reads: one a memory worker's own task tree may not read is null, as a missing one. */
    reader: TaskReader,
  ): Promise<TriggerDetail | null> {
    await requirePersonalOwner(this.#database, ownerId);
    let query = this.#database
      .selectFrom("triggers")
      .innerJoin("threads", "threads.id", "triggers.anchorThreadId")
      .selectAll("triggers")
      // The author is named only when the reader could reach that Thread itself, by the one rule.
      .leftJoin("threads as authorThread", (join) =>
        join
          .onRef("authorThread.id", "=", "triggers.createdByThreadId")
          .on(readerSees(reader, sql.ref("authorThread.origin_connection_id"))),
      )
      .select(["threads.title as anchorThreadTitle", "authorThread.title as createdByThreadTitle"])
      .where("triggers.id", "=", triggerId)
      .where("triggers.createdBy", "=", ownerId)
      .$if(reader.kind === "work", (q) => q.where(automationReaderSees(reader)));
    const row = await query.executeTakeFirst();
    if (!row) return null;
    const { anchorThreadTitle, createdByThreadTitle, ...trigger } = row;
    const [revision, occurrences, activation] = await Promise.all([
      this.#database
        .selectFrom("triggerRevisions")
        .selectAll()
        .where("id", "=", trigger.currentRevisionId)
        .executeTakeFirstOrThrow(),
      this.#database
        .selectFrom("triggerOccurrences")
        .leftJoin("commands", "commands.id", "triggerOccurrences.commandId")
        .selectAll("triggerOccurrences")
        .select("commands.frameSentAt")
        .where("triggerOccurrences.triggerId", "=", trigger.id)
        .orderBy("triggerOccurrences.createdAt", "desc")
        .orderBy("triggerOccurrences.id", "desc")
        .limit(Math.min(Math.max(occurrenceLimit, 1), 100))
        .execute(),
      this.#database
        .selectFrom("triggerWatchActivations")
        .selectAll()
        .where("triggerId", "=", trigger.id)
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .executeTakeFirst(),
    ]);
    const causalRunRows =
      occurrences.length === 0
        ? []
        : await this.#database
            .selectFrom("runs")
            .innerJoin("threads", "threads.id", "runs.threadId")
            .innerJoin(
              "triggerOccurrences",
              "triggerOccurrences.causalChainId",
              "runs.causalChainId",
            )
            .$if(reader.kind === "work", (q) =>
              q.where(readerSees(reader, sql.ref("threads.origin_connection_id"))),
            )
            .selectAll("runs")
            .select(["threads.title as threadTitle", "triggerOccurrences.id as occurrenceId"])
            .distinct()
            .where(
              "triggerOccurrences.id",
              "in",
              occurrences.map(({ id }) => id),
            )
            .orderBy("runs.createdAt", "desc")
            .orderBy("runs.id", "desc")
            .orderBy("triggerOccurrences.id", "desc")
            .limit(101)
            .execute();
    const steeredRunRows =
      occurrences.length === 0
        ? []
        : await this.#database
            .selectFrom("runs")
            .innerJoin("threads", "threads.id", "runs.threadId")
            .innerJoin("threadInputs", "threadInputs.runId", "runs.id")
            .where("threadInputs.policy", "=", "steer")
            .innerJoin(
              "triggerOccurrences",
              "triggerOccurrences.causalChainId",
              "threadInputs.causalChainId",
            )
            .$if(reader.kind === "work", (q) =>
              q.where(readerSees(reader, sql.ref("threads.origin_connection_id"))),
            )
            .selectAll("runs")
            .select(["threads.title as threadTitle", "triggerOccurrences.id as occurrenceId"])
            .distinct()
            .where(
              "triggerOccurrences.id",
              "in",
              occurrences.map(({ id }) => id),
            )
            .orderBy("runs.createdAt", "desc")
            .orderBy("runs.id", "desc")
            .orderBy("triggerOccurrences.id", "desc")
            .limit(101)
            .execute();
    const downstreamRunRows = [
      ...new Map(
        [...causalRunRows, ...steeredRunRows]
          .sort(
            (left, right) =>
              right.createdAt.getTime() - left.createdAt.getTime() ||
              right.id.localeCompare(left.id) ||
              right.occurrenceId.localeCompare(left.occurrenceId),
          )
          .map((row) => [`${row.occurrenceId}:${row.id}`, row] as const),
      ).values(),
    ];
    const parsed = revisionFromRow(revision);
    return {
      activation: activation ? watchActivationFromRow(activation) : null,
      anchorThread: await readTask(this.#database, reader, trigger.anchorThreadId, ownerId),
      anchorThreadTitle,
      createdByThreadTitle,
      downstreamRuns: downstreamRunRows.slice(0, 100).map((row) => ({
        occurrenceId: row.occurrenceId,
        run: runFromRow(row),
        threadTitle: row.threadTitle,
      })),
      downstreamRunsTruncated: downstreamRunRows.length > 100,
      occurrences: occurrences.map(occurrenceFromRow),
      revision: parsed,
      trigger: triggerFromRow(trigger, parsed.script === null),
    };
  }
  enqueueWebhook(input: {
    readonly headers: Readonly<Record<string, string>>;
    readonly method: string;
    readonly path?: string;
    readonly payload?: unknown;
    readonly query?: Readonly<Record<string, string | readonly string[]>>;
    readonly rawBody?: Buffer | null;
    readonly routeKey: string;
  }): Promise<{
    readonly occurrence: TriggerOccurrence;
    readonly wasDuplicate: boolean;
  }> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const trigger = await transaction
        .selectFrom("triggers")
        .selectAll()
        .where("webhookRouteKey", "=", input.routeKey)
        .where("kind", "=", "webhook")
        .forNoKeyUpdate()
        .executeTakeFirst();
      // Unknown, paused, archived, rotated, waiting-chat, or lost-authority keys return identical 404 (T7 / AA14.3).
      if (!trigger || trigger.status !== "active") throw notFound("Webhook not found");
      try {
        await requireTriggerExecutionAuthority(transaction, trigger);
      } catch (error) {
        if (
          error instanceof TriggerChatWaiting ||
          (error instanceof OpensteerError &&
            (error.code === "forbidden" || error.code === "conflict" || error.code === "not_found"))
        ) {
          throw notFound("Webhook not found");
        }
        throw error;
      }
      // Y11: Every webhook request queues in FIFO order (up to 100 pending, then 429).
      const sourceKey = `webhook:${globalThis.crypto.randomUUID()}`;
      const rawBody = input.rawBody && input.rawBody.byteLength > 0 ? input.rawBody : null;
      const query: Record<string, string | string[]> | undefined = input.query
        ? Object.fromEntries(
            Object.entries(input.query).map(([k, v]) => [k, typeof v === "string" ? v : [...v]]),
          )
        : undefined;
      return enqueueOccurrence(
        transaction,
        trigger,
        sourceKey,
        {
          payload: input.payload ?? null,
          source: {
            ...(rawBody ? { bodyBytes: rawBody.byteLength } : { bodyBytes: 0 }),
            headers: {
              ...input.headers,
            },
            kind: "webhook",
            method: input.method,
            ...(input.path ? { path: input.path } : {}),
            ...(query ? { query } : {}),
          },
        },
        rawBody,
      );
    });
  }
  async rotateWebhookKey(input: {
    readonly actorAccessMode?: ThreadAccessMode;
    readonly actorConnectionId?: string;
    readonly actorThreadId: ThreadId | null;
    readonly ownerId: UserId;
    readonly triggerId: TriggerId;
    readonly webhookRouteKey: string;
  }): Promise<Trigger> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const admitted = await admitTriggerActor(transaction, input.ownerId, input);
      const trigger = await lockTriggerForMutation(transaction, admitted.input, "define");
      if (
        admitted.connection?.grant.scope === "selected" &&
        trigger.originConnectionId !== admitted.input.actorConnectionId
      ) {
        throw notFound();
      }
      if (
        admitted.input.actorConnectionId &&
        trigger.originConnectionId !== admitted.input.actorConnectionId
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message:
            "A connected agent cannot rotate the webhook address of an automation it did not create.",
        });
      }
      if (trigger.kind !== "webhook") {
        throw new OpensteerError({
          code: "bad_request",
          message: "Only webhook automations have a webhook address",
        });
      }
      if (trigger.status === "archived") {
        throw conflict("Archived automation cannot rotate its webhook address");
      }
      const updated = await transaction
        .updateTable("triggers")
        .set({
          updatedAt: new Date(),
          webhookRouteKey: input.webhookRouteKey,
        })
        .where("id", "=", trigger.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return triggerFromRow(updated);
    });
  }
  enqueueManual(input: {
    readonly actorThreadId: ThreadId | null;
    readonly actorAccessMode?: ThreadAccessMode;
    /** The external agent connection the actor works for, checked under this mutation's fence. */
    readonly actorConnectionId?: string;
    readonly ownerId: UserId;
    readonly idempotencyKey?: string;
    readonly payload?: unknown;
    readonly triggerId: TriggerId;
  }): Promise<TriggerOccurrence> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      input = (await admitTriggerActor(transaction, input.ownerId, input)).input;
      const trigger = await lockTriggerForMutation(transaction, input, "define");
      if (trigger.status === "archived") throw conflict("Archived automation cannot run");
      if (trigger.kind === "watch") {
        throw conflict("Watch automations run continuously and cannot create occurrences");
      }
      await requireTriggerExecutionAuthority(transaction, trigger);
      // T13: Manual run_now works on memory passes as well as user automations.
      const sourceKey =
        input.idempotencyKey === undefined
          ? `manual:${globalThis.crypto.randomUUID()}`
          : `manual-command:${JSON.stringify([input.ownerId, input.actorThreadId, input.idempotencyKey])}`;
      if (input.idempotencyKey !== undefined) {
        const existing = await transaction
          .selectFrom("triggerOccurrences")
          .leftJoin("commands", "commands.id", "triggerOccurrences.commandId")
          .selectAll("triggerOccurrences")
          .select("commands.frameSentAt")
          .where("triggerOccurrences.triggerId", "=", trigger.id)
          .where("triggerOccurrences.sourceKey", "=", sourceKey)
          .executeTakeFirst();
        if (existing) return occurrenceFromRow(existing);
      }
      // Y11: Manual run_now is refused while a firing is already pending or running.
      const activeOccurrence = await transaction
        .selectFrom("triggerOccurrences")
        .select("id")
        .where("triggerId", "=", trigger.id)
        .where("status", "in", ["pending", "running"])
        .executeTakeFirst();
      if (activeOccurrence) {
        throw conflict("This automation already has a firing in progress.");
      }
      const enqueued = await enqueueOccurrence(transaction, trigger, sourceKey, {
        payload: input.payload ?? null,
        source: {
          kind: "manual",
        },
      });
      return enqueued.occurrence;
    });
  }

  /**
   * Cancels queued work that has not reached a Runner. An Occurrence whose
   * Command was claimed while this ran keeps running: the conditional Command
   * update is the single arbiter, so exactly one of cancel and dispatch wins
   * and the loser reports the Occurrence as untouched.
   */
  async cancelPendingOccurrences(
    ownerId: UserId,
    input: {
      readonly actorThreadId: ThreadId | null;
      readonly actorAccessMode?: ThreadAccessMode;
      /** The external agent connection the actor works for, checked under this mutation's fence. */
      readonly actorConnectionId?: string;
      readonly occurrenceId?: TriggerOccurrenceId;
      readonly triggerId: TriggerId;
    },
  ): Promise<{
    readonly canceledOccurrenceIds: readonly TriggerOccurrenceId[];
  }> {
    return commitPersonalMutation(
      this.#database,
      async (transaction) => {
        input = (await admitTriggerActor(transaction, ownerId, input)).input;
        const observedCancelable = await transaction
          .selectFrom("triggerOccurrences")
          .select("id")
          .where("triggerId", "=", input.triggerId)
          .where((eb) =>
            input.occurrenceId !== undefined
              ? eb.and([
                  eb("id", "=", input.occurrenceId),
                  eb.or([
                    eb("status", "=", "pending"),
                    eb.and([
                      eb("status", "=", "running"),
                      eb("connectionId", "is", null),
                      eb("contactLostAt", "is not", null),
                    ]),
                  ]),
                ])
              : eb("status", "=", "pending"),
          )
          .orderBy("id", "asc")
          .forNoKeyUpdate()
          .execute();
        const heldOccurrences = new Set(observedCancelable.map(({ id }) => id));
        const trigger = await lockTriggerForMutation(
          transaction,
          {
            ...input,
            ownerId,
          },
          "control",
        );
        if (input.occurrenceId) {
          const target = await transaction
            .selectFrom("triggerOccurrences")
            .select("id")
            .where("id", "=", input.occurrenceId)
            .where("triggerId", "=", trigger.id)
            .executeTakeFirst();
          if (!target) throw notFound("Automation occurrence not found");
        }
        const cancelable = await transaction
          .selectFrom("triggerOccurrences")
          .select(["commandId", "connectionId", "contactLostAt", "id", "status"])
          .where("triggerId", "=", trigger.id)
          .where((eb) =>
            input.occurrenceId !== undefined
              ? eb.and([
                  eb("id", "=", input.occurrenceId),
                  eb.or([
                    eb("status", "=", "pending"),
                    eb.and([
                      eb("status", "=", "running"),
                      eb("connectionId", "is", null),
                      eb("contactLostAt", "is not", null),
                    ]),
                  ]),
                ])
              : eb("status", "=", "pending"),
          )
          .orderBy("id", "asc")
          .execute();
        if (cancelable.some(({ id }) => !heldOccurrences.has(id))) {
          throw new TriggerOccurrenceSetChanged(
            "Pending occurrences changed before Trigger fencing",
          );
        }
        const now = new Date();
        const cancellation = {
          code: "canceled_by_owner",
          message: "Automation occurrence was canceled before it reached its computer",
        };
        const lostUnknown = {
          code: "outcome_unknown",
          message: "Outcome unknown: ended after contact with its computer was lost.",
        };
        const canceledOccurrenceIds: TriggerOccurrenceId[] = [];
        if (cancelable.length) {
          await transaction
            .selectFrom("commands")
            .select("id")
            .where(
              "id",
              "in",
              cancelable.map(({ commandId }) => commandId),
            )
            .orderBy("id", "asc")
            .forNoKeyUpdate()
            .execute();
        }
        for (const row of cancelable) {
          if (row.status === "running" && row.connectionId === null && row.contactLostAt !== null) {
            await transaction
              .updateTable("commands")
              .set({
                lastError: jsonValue(lostUnknown),
                status: "unknown",
                updatedAt: now,
              })
              .where("id", "=", row.commandId)
              .where("status", "=", "dispatched")
              .execute();
            await transaction
              .updateTable("triggerOccurrences")
              .set({
                completedAt: now,
                error: jsonValue(lostUnknown),
                ...triggerOccurrenceStateColumns("unknown"),
                updatedAt: now,
              })
              .where("id", "=", row.id)
              .where("status", "=", "running")
              .execute();
            canceledOccurrenceIds.push(row.id);
            continue;
          }
          const command = await transaction
            .updateTable("commands")
            .set({
              lastError: jsonValue(cancellation),
              status: "failed",
              updatedAt: now,
            })
            .where("id", "=", row.commandId)
            .where("status", "=", "pending")
            .executeTakeFirst();
          if (command.numUpdatedRows !== 1n) continue;
          await transaction
            .updateTable("triggerOccurrences")
            .set({
              completedAt: now,
              error: jsonValue(cancellation),
              ...triggerOccurrenceStateColumns("canceled"),
              updatedAt: now,
            })
            .where("id", "=", row.id)
            .where("status", "=", "pending")
            .execute();
          canceledOccurrenceIds.push(row.id);
        }
        if (canceledOccurrenceIds.length > 0) {
          await wakeExecutionCommands(transaction);
        }
        return {
          canceledOccurrenceIds,
        };
      },
      (error) => error instanceof TriggerOccurrenceSetChanged,
    );
  }

  /** When the earliest active, runnable schedule is due; null when none is armed. */
  async nextScheduleAt(): Promise<Date | null> {
    const row = await this.#database
      .selectFrom("triggers")
      .innerJoin("triggerRevisions", "triggerRevisions.id", "triggers.currentRevisionId")
      .select((eb) => eb.fn.min("triggers.nextFireAt").as("next"))
      .where("triggers.kind", "=", "schedule")
      .where("triggers.status", "=", "active")
      .where(executableProgram)
      // As the claim: a paused chat's schedule is not due, so the loop neither spins nor backs off.
      .where((eb) => eb.not(triggerChatHeld(this.#database)))
      .executeTakeFirst();
    return row?.next ? new Date(row.next) : null;
  }

  /**
   * Fires every due schedule. Each due Trigger changes whether or not it gets
   * an Occurrence — it is paused, or its next instant moves on — so the
   * The caller refreshes the Deployment's Trigger list after commit.
   */
  async claimDueSchedules(
    now = new Date(),
    limit = 64,
    /**
     * Tests only: `afterDueRead` runs after the due schedules are read and before their
     * authority is; `afterAuthority` after the authority is read; `beforeEnqueue` just before
     * the occurrence is recorded.
     */
    seam?: {
      readonly afterDueRead?: () => Promise<void>;
      readonly afterAuthority?: () => Promise<void>;
      readonly beforeEnqueue?: () => Promise<void>;
    },
  ): Promise<{
    readonly occurrences: readonly TriggerOccurrence[];
    readonly changed: boolean;
    /** Schedules this claim could not process; each was rolled back alone. */
    readonly failures: readonly unknown[];
    /** Running firings on schedules paused during this pass (e.g., authority loss, AA10). */
    readonly runningFirings: readonly RunningFiringRef[];
  }> {
    const dueSchedules = (database: Kysely<DatabaseSchema>) =>
      database
        .selectFrom("triggers")
        .innerJoin("triggerRevisions", "triggerRevisions.id", "triggers.currentRevisionId")
        .where("triggers.kind", "=", "schedule")
        .where("triggers.status", "=", "active")
        .where("triggers.nextFireAt", "<=", now)
        .where(executableProgram)
        // A paused chat's schedule does not fire: no occurrence, no move, no pause, no error.
        .where((eb) => eb.not(triggerChatHeld(database)));
    const candidate = await dueSchedules(this.#database)
      .select("triggers.id")
      .limit(1)
      .executeTakeFirst();
    if (!candidate) return { occurrences: [], changed: false, failures: [], runningFirings: [] };
    return commitPersonalMutation(this.#database, async (transaction) => {
      const due = await dueSchedules(transaction)
        .selectAll("triggers")
        .orderBy("triggers.nextFireAt", "asc")
        .orderBy("triggers.id", "asc")
        .limit(Math.min(Math.max(limit, 1), 256))
        .forNoKeyUpdate("triggers")
        .skipLocked()
        .execute();
      const occurrences: TriggerOccurrence[] = [];
      const failures: unknown[] = [];
      const runningFirings: RunningFiringRef[] = [];
      let claimed = 0;
      // Each schedule is claimed under its own savepoint: one that cannot be
      // claimed rolls back alone and is reported, instead of failing the whole
      // batch and starving every schedule behind it on every pass.
      const claim = async (
        trigger: (typeof due)[number],
      ): Promise<
        | { readonly occurrence?: TriggerOccurrence; readonly runningFirings?: RunningFiringRef[] }
        | typeof held
      > => {
        if (!trigger.nextFireAt) return {};
        let occurrence: TriggerOccurrence | undefined;
        await seam?.afterDueRead?.();
        // Held or lost, read as one fact in one statement: a chat that started waiting since the
        // due read is held (nothing created, nothing moved); only an end pauses the automation.
        const standing = await triggerLaunchStanding(transaction, trigger);
        await seam?.afterAuthority?.();
        if (standing.kind === "waiting") return held;
        if (standing.kind === "lost") {
          // Authority can be unavailable transiently — an offline Runner. Pausing keeps the Trigger recoverable by
          // its owner; archiving would be a permanent answer to a temporary
          // condition.
          await pauseTriggerInTransaction(transaction, trigger, {
            pauseReason: triggerAuthorityLossPauseReason,
            pausedBy: "system",
          });
          const running = await transaction
            .selectFrom("triggerOccurrences")
            .select([
              "commandId",
              "environmentId",
              "executionGeneration",
              "id",
              "runnerBootId",
              "runnerId",
            ])
            .where("triggerId", "=", trigger.id)
            .where("status", "=", "running")
            .where("runnerId", "is not", null)
            .where("runnerBootId", "is not", null)
            .orderBy("id", "asc")
            .execute();
          return {
            runningFirings: running.map((row) => ({
              commandId: row.commandId,
              environmentId: row.environmentId,
              executionGeneration: row.executionGeneration,
              occurrenceId: row.id,
              runnerBootId: row.runnerBootId!,
              runnerId: row.runnerId!,
            })),
          };
        }
        const revision = await transaction
          .selectFrom("triggerRevisions")
          .selectAll()
          .where("id", "=", trigger.currentRevisionId)
          .executeTakeFirstOrThrow();
        const source = TriggerSourceSchema.parse(revision.source);
        if (source.kind !== "schedule") throw new Error("Schedule Trigger revision is invalid");
        const scheduledFor = trigger.nextFireAt;
        // T10 / AA8: One firing at a time. When a schedule comes due while a firing is running,
        // enqueue ONE waiting pending firing (if none is waiting yet) and emit a one-time overrun
        // notice; further due times collapse into that single waiting firing.
        const runningOccurrence = await transaction
          .selectFrom("triggerOccurrences")
          .select("id")
          .where("triggerId", "=", trigger.id)
          .where("status", "=", "running")
          .executeTakeFirst();
        const notifyOverrun = runningOccurrence !== undefined && trigger.overrunNotifiedAt === null;
        if (!(await pendingScheduleOccurrenceExists(transaction, trigger.id))) {
          await seam?.beforeEnqueue?.();
          const enqueued = await enqueueOccurrence(
            transaction,
            trigger,
            `schedule:${revision.id}:${scheduledFor.toISOString()}`,
            {
              payload: source.schedule.payload ?? null,
              source: {
                kind: "schedule",
                scheduledFor: scheduledFor.toISOString(),
              },
            },
          );
          occurrence = enqueued.occurrence;
        }
        const next = nextTriggerFireAfter(
          source.schedule,
          new Date(Math.max(now.getTime(), scheduledFor.getTime())),
        );
        const updatedAt = new Date();
        await transaction
          .updateTable("triggers")
          .set({
            nextFireAt: next,
            ...(notifyOverrun ? { overrunNotifiedAt: updatedAt } : {}),
            updatedAt,
          })
          .where("id", "=", trigger.id)
          .execute();
        if (notifyOverrun) {
          await recordAutomationFailure(transaction, {
            detail: `Scheduled run for ${scheduledFor.toISOString()} came due while a previous firing was still running; one waiting firing is queued.`,
            reason: "overran-schedule",
            triggerId: trigger.id,
          });
        }
        return occurrence ? { occurrence } : {};
      };
      for (const trigger of due) {
        await sql`savepoint claim_schedule`.execute(transaction);
        try {
          const outcome = await claim(trigger);
          if (outcome === held) {
            // Held changes nothing: the savepoint holds nothing to keep.
            await sql`rollback to savepoint claim_schedule`.execute(transaction);
            continue;
          }
          await sql`release savepoint claim_schedule`.execute(transaction);
          if (outcome.occurrence) occurrences.push(outcome.occurrence);
          if (outcome.runningFirings?.length) runningFirings.push(...outcome.runningFirings);
          claimed += 1;
        } catch (error) {
          await sql`rollback to savepoint claim_schedule`.execute(transaction);
          // Its chat started waiting before the occurrence was recorded: held, not a failure.
          if (error instanceof TriggerChatWaiting) continue;
          failures.push(error);
        }
      }
      return {
        occurrences,
        changed: claimed > 0,
        failures,
        runningFirings,
      };
    });
  }
  async listPausedRunningFirings(): Promise<readonly RunningFiringRef[]> {
    const rows = await this.#database
      .selectFrom("triggerOccurrences")
      .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
      .select([
        "triggerOccurrences.commandId",
        "triggerOccurrences.environmentId",
        "triggerOccurrences.executionGeneration",
        "triggerOccurrences.id",
        "triggerOccurrences.runnerBootId",
        "triggerOccurrences.runnerId",
      ])
      .where("triggerOccurrences.status", "=", "running")
      .where("triggers.status", "<>", "active")
      .where("triggerOccurrences.runnerId", "is not", null)
      .where("triggerOccurrences.runnerBootId", "is not", null)
      .orderBy("triggerOccurrences.id", "asc")
      .execute();
    return rows.map((row) => ({
      commandId: row.commandId,
      environmentId: row.environmentId,
      executionGeneration: row.executionGeneration,
      occurrenceId: row.id,
      runnerBootId: row.runnerBootId!,
      runnerId: row.runnerId!,
    }));
  }
  async isFiringStillRunning(firing: RunningFiringRef): Promise<boolean> {
    const row = await this.#database
      .selectFrom("triggerOccurrences")
      .select("id")
      .where("id", "=", firing.occurrenceId)
      .where("status", "=", "running")
      .where("runnerId", "=", firing.runnerId)
      .where("runnerBootId", "=", firing.runnerBootId)
      .where("executionGeneration", "=", firing.executionGeneration)
      .executeTakeFirst();
    return row !== undefined;
  }
  async loadDispatchContext(commandId: CommandId): Promise<TriggerDispatchContext> {
    const occurrence = await this.#database
      .selectFrom("triggerOccurrences")
      .selectAll()
      .where("commandId", "=", commandId)
      .executeTakeFirst();
    if (!occurrence)
      throw new OpensteerError({
        code: "not_found",
        message: "Trigger command not found",
      });
    const trigger = await this.#database
      .selectFrom("triggers")
      .selectAll()
      .where("id", "=", occurrence.triggerId)
      .executeTakeFirstOrThrow();
    await requireTriggerLaunchAuthority(this.#database, trigger);
    const [revision, anchorThread] = await Promise.all([
      this.#database
        .selectFrom("triggerRevisions")
        .selectAll()
        .where("id", "=", occurrence.revisionId)
        .executeTakeFirstOrThrow(),
      this.#database
        .selectFrom("threads")
        .select(["environmentId", "id"])
        .where("id", "=", trigger.anchorThreadId)
        .executeTakeFirstOrThrow(),
    ]);
    return {
      anchorThread,
      encryptedSecrets: trigger.encryptedSecrets ?? null,
      occurrence: occurrenceFromRow(occurrence),
      revision: revisionFromRow(revision),
      script: revision.script ? AutomationScriptSchema.parse(revision.script) : null,
      trigger: triggerFromRow(trigger),
      webhookBody: occurrence.webhookBody ?? null,
      agentHome: (await personalSettings(this.#database)).agentHome,
    };
  }
  async startExecution(input: {
    readonly commandId: CommandId;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<{
    readonly context: TriggerDispatchContext;
    readonly executionGeneration: number;
    readonly connectionId: string | null;
  }> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const occurrence = await transaction
        .selectFrom("triggerOccurrences")
        .innerJoin("commands", "commands.id", "triggerOccurrences.commandId")
        .selectAll("triggerOccurrences")
        .select("commands.status as commandStatus")
        .where("triggerOccurrences.commandId", "=", input.commandId)
        .forNoKeyUpdate("triggerOccurrences")
        .executeTakeFirst();
      if (!occurrence || occurrence.commandStatus !== "dispatched") {
        throw conflict("Trigger command is not dispatchable");
      }
      const trigger = await transaction
        .selectFrom("triggers")
        .selectAll()
        .where("id", "=", occurrence.triggerId)
        .executeTakeFirstOrThrow();
      await requireTriggerLaunchAuthority(transaction, trigger);
      let executionGeneration = occurrence.executionGeneration;
      if (occurrence.status === "pending") {
        const witness = await automationHandoffWitness(transaction, trigger);
        executionGeneration += 1;
        await transaction
          .updateTable("triggerOccurrences")
          .set({
            ...witness,
            terminalEvidenceAt: null,
            contactLostAt: null,
            executionGeneration,
            ...triggerOccurrenceStateColumns("running"),
            runnerBootId: input.runnerBootId,
            runnerId: input.runnerId,
            startedAt: new Date(),
            updatedAt: new Date(),
          })
          .where("id", "=", occurrence.id)
          .execute();
      } else if (
        occurrence.status !== "running" ||
        occurrence.runnerId !== input.runnerId ||
        occurrence.runnerBootId !== input.runnerBootId
      ) {
        throw conflict("Trigger occurrence already belongs to another execution");
      }
      return {
        context: await loadDispatchContext(transaction, occurrence.id),
        executionGeneration,
        connectionId: trigger.originConnectionId,
      };
    });
  }
  async recordOccurrenceNotAdmitted(id: TriggerOccurrenceId, generation: number): Promise<void> {
    await commitPersonalMutation(this.#database, async (transaction) => {
      const updated = await transaction
        .updateTable("triggerOccurrences")
        .set({ terminalEvidenceAt: new Date(), contactLostAt: null })
        .where("id", "=", id)
        .where("executionGeneration", "=", generation)
        .where("runnerId", "is not", null)
        .where("connectionId", "is not", null)
        .where("terminalEvidenceAt", "is", null)
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) {
        await transaction
          .deleteFrom("triggerOccurrenceAttempts")
          .where("occurrenceId", "=", id)
          .where("executionGeneration", "=", generation)
          .where("terminalEvidenceAt", "is", null)
          .execute();
      }
    });
  }
  async assertActiveExecutionBinding(input: ActiveTriggerExecutionBindingInput): Promise<void> {
    await assertActiveTriggerExecutionBinding(this.#database, input);
  }
  async activeFiringCapabilityScope(input: {
    readonly executionGeneration: number;
    readonly occurrenceId: TriggerOccurrenceId;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<ActiveTriggerExecutionBindingInput | null> {
    const row = await this.#database
      .selectFrom("triggerOccurrences")
      .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
      .innerJoin("threads", "threads.id", "triggers.anchorThreadId")
      .select(["threads.environmentId", "triggers.anchorThreadId", "triggers.createdBy"])
      .where("triggerOccurrences.id", "=", input.occurrenceId)
      .where("triggerOccurrences.executionGeneration", "=", input.executionGeneration)
      .where("triggerOccurrences.runnerId", "=", input.runnerId)
      .where("triggerOccurrences.runnerBootId", "=", input.runnerBootId)
      .where("triggerOccurrences.status", "=", "running")
      .executeTakeFirst();
    if (!row) return null;
    const scope: ActiveTriggerExecutionBindingInput = {
      environmentId: row.environmentId,
      executionGeneration: input.executionGeneration,
      occurrenceId: input.occurrenceId,
      requestedBy: row.createdBy,
      runnerBootId: input.runnerBootId,
      runnerId: input.runnerId,
      threadId: row.anchorThreadId,
    };
    try {
      await assertActiveTriggerExecutionBinding(this.#database, scope);
    } catch (error) {
      if (
        error instanceof OpensteerError &&
        (error.code === "forbidden" || error.code === "not_found")
      ) {
        return null;
      }
      throw error;
    }
    return scope;
  }
  async activeWatchCapabilityScope(input: {
    readonly activationId: TriggerWatchActivationId;
    readonly executionGeneration: number;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<ActiveWatchBindingInput | null> {
    const row = await this.#database
      .selectFrom("triggerWatchActivations")
      .select(["id", "triggerId", "revisionId", "environmentId", "anchorThreadId", "createdBy"])
      .where("id", "=", input.activationId)
      .where("executionGeneration", "=", String(input.executionGeneration))
      .where("runnerId", "=", input.runnerId)
      .where("runnerBootId", "=", input.runnerBootId)
      .where("desired", "=", "active")
      .executeTakeFirst();
    if (!row) return null;
    const scope: ActiveWatchBindingInput = {
      activationId: row.id,
      anchorThreadId: row.anchorThreadId,
      createdBy: row.createdBy,
      environmentId: row.environmentId,
      executionGeneration: input.executionGeneration,
      revisionId: row.revisionId,
      triggerId: row.triggerId,
    };
    try {
      await assertActiveWatchBinding(this.#database, scope);
    } catch (error) {
      if (
        error instanceof OpensteerError &&
        (error.code === "forbidden" || error.code === "not_found")
      ) {
        return null;
      }
      throw error;
    }
    return scope;
  }
  async acceptExecution(input: {
    readonly commandId: CommandId;
    readonly executionGeneration: number;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<void> {
    await commitPersonalMutation(this.#database, async (transaction) => {
      const occurrence = await transaction
        .selectFrom("triggerOccurrences")
        .select("id")
        .where("commandId", "=", input.commandId)
        .where("executionGeneration", "=", input.executionGeneration)
        .where("runnerBootId", "=", input.runnerBootId)
        .where("runnerId", "=", input.runnerId)
        .where("status", "=", "running")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!occurrence) return;
      await transaction
        .updateTable("commands")
        .set({ lastError: null, status: "succeeded", updatedAt: new Date() })
        .where("id", "=", input.commandId)
        .where("type", "=", "trigger.execute")
        .where("status", "in", ["dispatched", "unknown"])
        .execute();
    });
  }
  async completeExecution(input: {
    readonly verifiedContainment?: boolean;
    readonly executionGeneration: number;
    readonly output: TriggerExecutionOutput;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<TriggerOccurrence | null> {
    const completed = await commitPersonalMutation(this.#database, async (transaction) => {
      const occurrence = await transaction
        .selectFrom("triggerOccurrences")
        .selectAll()
        .where("id", "=", input.output.occurrenceId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!occurrence) throw notFound("Automation occurrence not found");
      const now = new Date();
      if (
        occurrence.executionGeneration !== input.executionGeneration ||
        occurrence.runnerId !== input.runnerId ||
        occurrence.runnerBootId !== input.runnerBootId
      ) {
        const retired = await transaction
          .updateTable("triggerOccurrenceAttempts")
          .set({
            terminalEvidenceAt: sql`coalesce(terminal_evidence_at, ${now})`,
            contactLostAt: sql`case when terminal_evidence_at is not null then contact_lost_at
              else ${input.verifiedContainment ? null : now}::timestamptz end`,
          })
          .where("occurrenceId", "=", occurrence.id)
          .where("executionGeneration", "=", input.executionGeneration)
          .where("runnerId", "=", input.runnerId)
          .where("runnerBootId", "=", input.runnerBootId)
          .executeTakeFirst();
        if (retired.numUpdatedRows === 1n) return null;
        throw new OpensteerError({
          code: "forbidden",
          message: "Trigger result binding is stale",
        });
      }
      const settledAsUnknown = occurrence.status === "unknown";
      if (occurrence.status !== "running" && !settledAsUnknown && !occurrence.connectionId)
        return occurrenceFromRow(occurrence);
      if (occurrence.terminalEvidenceAt && occurrence.status !== "running" && !settledAsUnknown)
        return occurrenceFromRow(occurrence);
      const trigger = await transaction
        .selectFrom("triggers")
        .selectAll()
        .where("id", "=", occurrence.triggerId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const updated = await transaction
        .updateTable("triggerOccurrences")
        .set({
          completedAt: new Date(input.output.completedAt),
          ...(occurrence.connectionId && (!occurrence.terminalEvidenceAt || settledAsUnknown)
            ? {
                terminalEvidenceAt: now,
                contactLostAt: input.verifiedContainment ? null : now,
              }
            : {}),
          error: input.output.error
            ? jsonValue({
                message: input.output.error,
              })
            : null,
          exitCode: input.output.exitCode,
          ...triggerOccurrenceStateColumns(input.output.status),
          result: input.output.result === null ? null : jsonValue(input.output.result),
          stderr: input.output.stderr,
          stdout: input.output.stdout,
          updatedAt: now,
        })
        .where("id", "=", occurrence.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      let failureNotice:
        | {
            readonly detail: string;
            readonly reason:
              | "final-occurrence-failed"
              | "started-failing"
              | "started-unknown"
              | "outcome-unknown";
          }
        | undefined;
      if (input.output.status === "succeeded") {
        const recovered =
          occurrence.revisionId === trigger.currentRevisionId &&
          (trigger.failingSince !== null ||
            trigger.failureNotifiedAt !== null ||
            trigger.overrunNotifiedAt !== null);
        const finished = await oneTimeTriggerFinished(transaction, trigger, now);
        if (recovered || finished) {
          await transaction
            .updateTable("triggers")
            .set({
              ...(recovered
                ? {
                    failingSince: null,
                    failureNotifiedAt: null,
                    overrunNotifiedAt: null,
                  }
                : {}),
              ...(finished
                ? {
                    pauseReason: null,
                    status: "archived" as const,
                  }
                : {}),
              updatedAt: now,
            })
            .where("id", "=", trigger.id)
            .execute();
        }
      } else if (
        input.output.status === "failed" &&
        occurrence.revisionId === trigger.currentRevisionId
      ) {
        // T9: Never auto-pause after failures. Keep the automation active, stamp failingSince,
        // and emit a single 'started-failing' notice (or 'final-occurrence-failed' for one-shots).
        const final = await isFinalOccurrence(transaction, occurrence);
        const notifyStartedFailing =
          !final && trigger.status === "active" && trigger.failureNotifiedAt === null;
        await transaction
          .updateTable("triggers")
          .set({
            failingSince: trigger.failingSince ?? now,
            ...(notifyStartedFailing ? { failureNotifiedAt: now } : {}),
            updatedAt: now,
          })
          .where("id", "=", trigger.id)
          .execute();
        if (final || notifyStartedFailing) {
          const stderr = input.output.stderr.trim();
          const base = input.output.error?.trim() ?? "";
          const rawDetail =
            base && stderr && !base.includes(stderr)
              ? `${base}\n${stderr}`
              : base || stderr || "The script failed without an error message.";
          const detail =
            input.output.exitCode !== null && !/\bexit(?:ed)?(?:\s+with)?\s+code\s+\d+/iu.test(rawDetail)
              ? `Exit code ${input.output.exitCode}: ${rawDetail}`
              : rawDetail;
          failureNotice = {
            detail,
            reason: final ? "final-occurrence-failed" : "started-failing",
          };
        }
      } else if (input.output.status === "unknown") {
        // AB2: unknown never runs again, never words as failed, and never clears failingSince.
        // Emit the one-time notice if the automation was previously succeeding (failureNotifiedAt is null).
        const final = await isFinalOccurrence(transaction, occurrence);
        const notifyStartedUnknown =
          !final &&
          occurrence.revisionId === trigger.currentRevisionId &&
          trigger.status === "active" &&
          trigger.failureNotifiedAt === null;
        if (notifyStartedUnknown) {
          await transaction
            .updateTable("triggers")
            .set({
              failureNotifiedAt: now,
              updatedAt: now,
            })
            .where("id", "=", trigger.id)
            .execute();
        }
        if (final || notifyStartedUnknown) {
          const stderr = input.output.stderr.trim();
          const base =
            input.output.error?.trim() ||
            (input.output.exitCode !== null
              ? `Automation script exited with code ${input.output.exitCode}: outcome unknown (an effect may have happened)`
              : "Automation script exit status could not be determined.");
          const detail =
            base && stderr && !base.includes(stderr) ? `${base}\n${stderr}` : base;
          failureNotice = {
            detail,
            reason: final ? "outcome-unknown" : "started-unknown",
          };
        }
      }
      await transaction
        .updateTable("commands")
        .set({
          lastError:
            input.output.status === "unknown"
              ? jsonValue({
                  code: "outcome_unknown",
                  message:
                    input.output.error?.trim() ||
                    "Automation script exit status could not be determined.",
                })
              : null,
          status: input.output.status === "unknown" ? "unknown" : "succeeded",
          updatedAt: now,
        })
        .where("id", "=", occurrence.commandId)
        .where("status", "in", ["dispatched", "unknown"])
        .execute();
      if (failureNotice) {
        const replaced = settledAsUnknown
          ? await transaction
              .updateTable("automationFailureNotices")
              .set({
                detail: [...(failureNotice.detail.trim() || "No error was reported.")]
                  .slice(0, 2_000)
                  .join(""),
                reason: failureNotice.reason,
              })
              .where("occurrenceId", "=", occurrence.id)
              .where("reason", "=", "outcome-unknown")
              .where("settledAt", "is", null)
              .executeTakeFirst()
          : undefined;
        if (!replaced || replaced.numUpdatedRows === 0n) {
          await recordAutomationFailure(transaction, {
            detail: failureNotice.detail,
            occurrenceId: occurrence.id,
            reason: failureNotice.reason,
            triggerId: trigger.id,
          });
        }
      } else if (settledAsUnknown) {
        await transaction
          .updateTable("automationFailureNotices")
          .set({ lastError: null, settledAt: now })
          .where("occurrenceId", "=", occurrence.id)
          .where("reason", "=", "outcome-unknown")
          .where("settledAt", "is", null)
          .execute();
      }
      // Wake the dispatcher so any FIFO-queued webhook firing waiting behind this one starts now.
      await wakeExecutionCommands(transaction);
      return occurrenceFromRow(updated);
    });
    if (completed) {
      await pruneCompletedOccurrenceOutputs(this.#database, completed.triggerId);
    }
    return completed;
  }

  /**
   * Reconciles a reconnecting Runner's firing inventory (T12, Fault A, Fault B).
   * - Announced active/settled firings whose binding and trigger are still live attach.
   * - Announced firings whose trigger or lineage stopped are revoked so the Runner kills them.
   * - Every running occurrence on this Runner (personal OR connection lineage) NOT announced and
   *   NOT currently being dispatched settles to `outcome = 'unknown'` (never re-run, never left
   *   stuck `running`). A late proven result for the exact `(runnerId, runnerBootId, generation)`
   *   can still settle `unknown` to its real exit code in `completeExecution`.
   */
  async attachRunnerFirings(input: {
    readonly dispatchingOccurrenceIds: readonly TriggerOccurrenceId[];
    readonly firings: readonly {
      readonly environmentId: EnvironmentId;
      readonly executionGeneration: number;
      readonly occurrenceId: TriggerOccurrenceId;
      readonly terminal: boolean;
    }[];
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<{
    readonly pausedRunningFirings: readonly RunningFiringRef[];
    readonly results: readonly (
      | { readonly occurrenceId: TriggerOccurrenceId; readonly status: "attached" }
      | {
          readonly occurrenceId: TriggerOccurrenceId;
          readonly reason: string;
          readonly status: "revoked";
        }
    )[];
    readonly settledUnknownCount: number;
  }> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      const pausedRunningFirings: RunningFiringRef[] = [];
      const results: (
        | { readonly occurrenceId: TriggerOccurrenceId; readonly status: "attached" }
        | {
            readonly occurrenceId: TriggerOccurrenceId;
            readonly reason: string;
            readonly status: "revoked";
          }
      )[] = [];
      const heldIds = new Set<TriggerOccurrenceId>();
      const attachedRunningIds: TriggerOccurrenceId[] = [];
      const restoredUnknownIds: TriggerOccurrenceId[] = [];
      const restoredCommandIds: CommandId[] = [];
      const dispatchingIds = new Set<TriggerOccurrenceId>(input.dispatchingOccurrenceIds);

      const announcedIds = [...new Set(input.firings.map((firing) => firing.occurrenceId))];
      // Single-pass ascending-id lock across both announced firings and every running firing
      // bound to this Runner so mixed personal/connection attaches never lock out of key order (Z7).
      const candidateRows = await transaction
        .selectFrom("triggerOccurrences")
        .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
        .innerJoin("threads", "threads.id", "triggers.anchorThreadId")
        .select([
          "triggerOccurrences.admittedAccessMode",
          "triggerOccurrences.admittedGrantRevision",
          "triggerOccurrences.commandId",
          "triggerOccurrences.connectionId",
          "triggerOccurrences.contactLostAt",
          "triggerOccurrences.environmentId",
          "triggerOccurrences.event",
          "triggerOccurrences.executionGeneration",
          "triggerOccurrences.id",
          "triggerOccurrences.revisionId",
          "triggerOccurrences.runnerBootId",
          "triggerOccurrences.runnerId",
          "triggerOccurrences.status",
          "triggerOccurrences.terminalEvidenceAt",
          "triggerOccurrences.triggerId",
          "triggers.anchorThreadId",
          "triggers.createdBy",
          "triggers.originConnectionId",
          "triggers.status as triggerStatus",
          "threads.doneAt as threadDoneAt",
          "threads.removedAt as threadRemovedAt",
          "threads.status as threadStatus",
        ])
        .where((eb) => {
          const runningOnRunner = eb.and([
            eb("triggerOccurrences.status", "=", "running"),
            eb("triggerOccurrences.runnerId", "=", input.runnerId),
          ]);
          return announcedIds.length > 0
            ? eb.or([eb("triggerOccurrences.id", "in", announcedIds), runningOnRunner])
            : runningOnRunner;
        })
        .orderBy("triggerOccurrences.id", "asc")
        .forNoKeyUpdate("triggerOccurrences")
        .execute();
      const rowsById = new Map(candidateRows.map((row) => [row.id, row]));

      const sortedFirings = [...input.firings].toSorted((a, b) =>
        a.occurrenceId.localeCompare(b.occurrenceId),
      );
      for (const firing of sortedFirings) {
        heldIds.add(firing.occurrenceId);
        const row = rowsById.get(firing.occurrenceId);
        if (
          !row ||
          row.environmentId !== firing.environmentId ||
          row.runnerId !== input.runnerId ||
          row.runnerBootId !== input.runnerBootId ||
          row.executionGeneration !== firing.executionGeneration
        ) {
          results.push({
            occurrenceId: firing.occurrenceId,
            reason: "The Host does not hold this firing",
            status: "revoked",
          });
          continue;
        }
        if (row.status !== "running" && row.status !== "unknown") {
          results.push({
            occurrenceId: firing.occurrenceId,
            reason: "This firing has already ended",
            status: "revoked",
          });
          continue;
        }
        if (!firing.terminal) {
          if (row.triggerStatus !== "active") {
            if (row.runnerId && row.runnerBootId) {
              pausedRunningFirings.push({
                commandId: row.commandId,
                environmentId: row.environmentId,
                executionGeneration: row.executionGeneration,
                occurrenceId: row.id,
                runnerBootId: row.runnerBootId,
                runnerId: row.runnerId,
              });
            }
            results.push({
              occurrenceId: firing.occurrenceId,
              reason:
                row.triggerStatus === "archived"
                  ? "The automation was archived"
                  : "The automation was paused",
              status: "revoked",
            });
            continue;
          }
          if (!(await triggerBindingAuthorityHolds(transaction, row))) {
            results.push({
              occurrenceId: firing.occurrenceId,
              reason: "Automation execution authority is no longer active",
              status: "revoked",
            });
            continue;
          }
        }
        if (!firing.terminal && row.status === "unknown") {
          restoredUnknownIds.push(row.id);
          restoredCommandIds.push(row.commandId);
        } else if (
          row.status === "running" &&
          row.contactLostAt !== null &&
          row.terminalEvidenceAt === null
        ) {
          attachedRunningIds.push(row.id);
        }
        results.push({ occurrenceId: firing.occurrenceId, status: "attached" });
      }

      const unannouncedRows = candidateRows.filter(
        (row) =>
          row.status === "running" &&
          row.runnerId === input.runnerId &&
          !heldIds.has(row.id) &&
          !(dispatchingIds.has(row.id) && row.runnerBootId === input.runnerBootId),
      );

      const now = new Date();
      const allCommandIds = [
        ...new Set([...restoredCommandIds, ...unannouncedRows.map((row) => row.commandId)]),
      ];
      const commandRows =
        allCommandIds.length > 0
          ? await transaction
              .selectFrom("commands")
              .select(["frameSentAt", "id"])
              .where("id", "in", allCommandIds)
              .orderBy("id", "asc")
              .forNoKeyUpdate()
              .execute()
          : [];
      const frameSentByCommandId = new Map(commandRows.map((row) => [row.id, row.frameSentAt]));
      const unsentRows = unannouncedRows.filter(
        (row) => frameSentByCommandId.get(row.commandId) === null,
      );
      const unknownRows = unannouncedRows.filter(
        (row) => frameSentByCommandId.get(row.commandId) !== null,
      );

      if (attachedRunningIds.length > 0) {
        await transaction
          .updateTable("triggerOccurrences")
          .set({ contactLostAt: null, updatedAt: now })
          .where("id", "in", attachedRunningIds)
          .where("status", "=", "running")
          .where("terminalEvidenceAt", "is", null)
          .execute();
      }
      if (restoredUnknownIds.length > 0) {
        await transaction
          .updateTable("triggerOccurrences")
          .set({
            completedAt: null,
            contactLostAt: null,
            error: null,
            terminalEvidenceAt: null,
            ...triggerOccurrenceStateColumns("running"),
            updatedAt: now,
          })
          .where("id", "in", restoredUnknownIds)
          .where("status", "=", "unknown")
          .execute();
      }
      if (unsentRows.length > 0) {
        await transaction
          .updateTable("triggerOccurrences")
          .set({
            admittedAccessMode: null,
            admittedGrantRevision: null,
            contactLostAt: null,
            runnerBootId: null,
            runnerId: null,
            startedAt: null,
            terminalEvidenceAt: null,
            ...triggerOccurrenceStateColumns("pending"),
            updatedAt: now,
          })
          .where(
            "id",
            "in",
            unsentRows.map((row) => row.id),
          )
          .where("status", "=", "running")
          .execute();
      }
      const unknownMessage = "Outcome unknown: the computer reconnected without this firing.";
      const unknownErrorPayload = jsonValue({
        code: "outcome_unknown",
        message: unknownMessage,
      });
      if (unknownRows.length > 0) {
        await transaction
          .updateTable("triggerOccurrences")
          .set({
            completedAt: now,
            contactLostAt: sql`case when connection_id is not null then coalesce(contact_lost_at, ${now}) else contact_lost_at end`,
            error: unknownErrorPayload,
            ...triggerOccurrenceStateColumns("unknown"),
            terminalEvidenceAt: sql`case when connection_id is not null then coalesce(terminal_evidence_at, ${now}) else terminal_evidence_at end`,
            updatedAt: now,
          })
          .where(
            "id",
            "in",
            unknownRows.map((row) => row.id),
          )
          .where("status", "=", "running")
          .execute();
      }

      if (restoredCommandIds.length > 0) {
        await transaction
          .updateTable("commands")
          .set({ lastError: null, status: "succeeded", updatedAt: now })
          .where("id", "in", restoredCommandIds)
          .where("status", "=", "unknown")
          .execute();
      }
      if (unsentRows.length > 0) {
        await transaction
          .updateTable("commands")
          .set({
            dispatcherId: null,
            frameSentAt: null,
            lastError: null,
            status: "pending",
            updatedAt: now,
          })
          .where(
            "id",
            "in",
            unsentRows.map((row) => row.commandId),
          )
          .where("status", "=", "dispatched")
          .execute();
      }
      if (unknownRows.length > 0) {
        await transaction
          .updateTable("commands")
          .set({
            lastError: unknownErrorPayload,
            status: "unknown",
            updatedAt: now,
          })
          .where(
            "id",
            "in",
            unknownRows.map((row) => row.commandId),
          )
          .where("status", "=", "dispatched")
          .execute();
      }

      if (restoredUnknownIds.length > 0) {
        await transaction
          .updateTable("automationFailureNotices")
          .set({ lastError: null, settledAt: now })
          .where("occurrenceId", "in", restoredUnknownIds)
          .where("reason", "=", "outcome-unknown")
          .where("settledAt", "is", null)
          .execute();
      }
      for (const row of unknownRows) {
        if (!(await isFinalOccurrence(transaction, row))) continue;
        await recordAutomationFailure(transaction, {
          detail: unknownMessage,
          occurrenceId: row.id,
          reason: "outcome-unknown",
          triggerId: row.triggerId,
        });
      }
      if (unknownRows.length > 0 || unsentRows.length > 0) {
        await wakeExecutionCommands(transaction);
      }

      return { pausedRunningFirings, results, settledUnknownCount: unknownRows.length };
    });
  }

  /** Settles active firings on a revoked Runner to unknown (it can never reconnect). */
  async markActiveUnknownForRevokedRunner(input: {
    readonly runnerBootId?: string;
    readonly runnerId: RunnerId;
  }): Promise<number> {
    return commitPersonalMutation(this.#database, async (transaction) =>
      this.#markActiveUnknownInTransaction(transaction, {
        message: "Outcome unknown: the computer was removed before this firing finished.",
        ...(input.runnerBootId ? { runnerBootId: input.runnerBootId } : {}),
        runnerId: input.runnerId,
      }),
    );
  }

  async #markActiveUnknownInTransaction(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly message: string;
      readonly runnerBootId?: string;
      readonly runnerId: RunnerId;
    },
  ): Promise<number> {
    let query = transaction
      .selectFrom("triggerOccurrences")
      .select(["commandId", "connectionId", "event", "id", "revisionId", "triggerId"])
      .where("status", "=", "running")
      .where("runnerId", "=", input.runnerId);
    if (input.runnerBootId) query = query.where("runnerBootId", "=", input.runnerBootId);
    const rows = await query.orderBy("id", "asc").forNoKeyUpdate().execute();
    if (rows.length === 0) return 0;

    const now = new Date();
    const commandIds = rows.map((row) => row.commandId);
    const commandRows = await transaction
      .selectFrom("commands")
      .select(["frameSentAt", "id"])
      .where("id", "in", commandIds)
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
    const frameSentByCommandId = new Map(commandRows.map((row) => [row.id, row.frameSentAt]));
    // AA3(b) / Z5: a firing that never left the Home on a removed computer is canceled, never unknown.
    const unsentRows = rows.filter((row) => frameSentByCommandId.get(row.commandId) === null);
    const unknownRows = rows.filter((row) => frameSentByCommandId.get(row.commandId) !== null);

    if (unsentRows.length > 0) {
      const unsentIds = unsentRows.map((row) => row.id);
      const unsentCommandIds = unsentRows.map((row) => row.commandId);
      const cancelError = jsonValue({
        code: "canceled_by_computer_removed",
        message: "Automation occurrence was canceled because its computer was removed.",
      });
      await transaction
        .updateTable("triggerOccurrences")
        .set({
          completedAt: now,
          error: cancelError,
          ...triggerOccurrenceStateColumns("canceled"),
          terminalEvidenceAt: sql`case when connection_id is not null then coalesce(terminal_evidence_at, ${now}) else terminal_evidence_at end`,
          updatedAt: now,
        })
        .where("id", "in", unsentIds)
        .where("status", "=", "running")
        .execute();
      await transaction
        .updateTable("commands")
        .set({
          lastError: cancelError,
          status: "failed",
          updatedAt: now,
        })
        .where("id", "in", unsentCommandIds)
        .where("status", "in", ["pending", "dispatched"])
        .execute();
      await wakeExecutionCommands(transaction);
    }

    if (unknownRows.length === 0) return 0;

    const unknownIds = unknownRows.map((row) => row.id);
    const unknownCommandIds = unknownRows.map((row) => row.commandId);
    const errorPayload = jsonValue({
      code: "outcome_unknown",
      message: input.message,
    });

    await transaction
      .updateTable("triggerOccurrences")
      .set({
        completedAt: now,
        contactLostAt: sql`case when connection_id is not null then coalesce(contact_lost_at, ${now}) else contact_lost_at end`,
        error: errorPayload,
        ...triggerOccurrenceStateColumns("unknown"),
        terminalEvidenceAt: sql`case when connection_id is not null then coalesce(terminal_evidence_at, ${now}) else terminal_evidence_at end`,
        updatedAt: now,
      })
      .where("id", "in", unknownIds)
      .where("status", "=", "running")
      .execute();

    await transaction
      .updateTable("commands")
      .set({
        lastError: errorPayload,
        status: "unknown",
        updatedAt: now,
      })
      .where("id", "in", unknownCommandIds)
      .where("status", "=", "dispatched")
      .execute();
    await wakeExecutionCommands(transaction);

    for (const row of unknownRows) {
      if (!(await isFinalOccurrence(transaction, row))) continue;
      await recordAutomationFailure(transaction, {
        detail: input.message,
        occurrenceId: row.id,
        reason: "outcome-unknown",
        triggerId: row.triggerId,
      });
    }
    return unknownRows.length;
  }
}

/**
 * T10: Keep full stdout/stderr/result/webhook_body for the most recent 100 completed firings
 * per automation and clear older ones without deleting rows. Runs in its own lock-ordered
 * transaction (`trigger_occurrences` by `id asc`) so it never collides with completion locks.
 */
async function pruneCompletedOccurrenceOutputs(
  database: Kysely<DatabaseSchema>,
  triggerId: TriggerId,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    const stale = await transaction
      .selectFrom("triggerOccurrences")
      .select("id")
      .where("triggerId", "=", triggerId)
      .where("status", "in", ["succeeded", "failed", "canceled"])
      .where("outputPrunedAt", "is", null)
      .where(
        "id",
        "not in",
        transaction
          .selectFrom("triggerOccurrences")
          .select("id")
          .where("triggerId", "=", triggerId)
          .where("status", "in", ["succeeded", "failed", "canceled"])
          .orderBy("createdAt", "desc")
          .orderBy("id", "desc")
          .limit(RETAINED_OUTPUT_OCCURRENCES),
      )
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .skipLocked()
      .execute();
    if (stale.length === 0) return;
    const now = new Date();
    await transaction
      .updateTable("triggerOccurrences")
      .set({
        outputPrunedAt: now,
        result: null,
        stderr: "",
        stdout: "",
        webhookBody: null,
      })
      .where(
        "id",
        "in",
        stale.map(({ id }) => id),
      )
      .execute();
  });
}

/** Whether a failed Occurrence was the only run its one-shot Trigger will make. */
async function isFinalOccurrence(
  transaction: Transaction<DatabaseSchema>,
  occurrence: {
    readonly event: unknown;
    readonly revisionId: TriggerRevisionId;
  },
): Promise<boolean> {
  const revision = await transaction
    .selectFrom("triggerRevisions")
    .select("source")
    .where("id", "=", occurrence.revisionId)
    .executeTakeFirst();
  return (
    revision !== undefined &&
    isFinalScheduledOccurrence({
      event: occurrence.event,
      revisionSource: revision.source,
    })
  );
}

/**
 * Whether a one-time Trigger has nothing left to do, so that a successful run
 * finishes it and a reminder that went off leaves its owner's list. An active
 * one with no fire scheduled has had its moment — the scheduler claimed it, or
 * it passed before the Trigger was resumed; a paused one has nothing left once
 * its moment has passed.
 */
async function oneTimeTriggerFinished(
  transaction: Transaction<DatabaseSchema>,
  trigger: TriggerRow,
  now: Date,
): Promise<boolean> {
  if (trigger.kind !== "schedule" || trigger.status === "archived" || trigger.nextFireAt) {
    return false;
  }
  const revision = await transaction
    .selectFrom("triggerRevisions")
    .select("source")
    .where("id", "=", trigger.currentRevisionId)
    .executeTakeFirstOrThrow();
  const source = TriggerSourceSchema.parse(revision.source);
  return (
    source.kind === "schedule" &&
    source.schedule.kind === "at" &&
    (trigger.status === "active" || Date.parse(source.schedule.at) <= now.getTime())
  );
}
async function enqueueOccurrence(
  transaction: Transaction<DatabaseSchema>,
  trigger: TriggerRow,
  sourceKey: string,
  input: Pick<TriggerProgramEvent, "payload" | "source">,
  webhookBody: Buffer | null = null,
): Promise<{
  readonly occurrence: TriggerOccurrence;
  readonly wasDuplicate: boolean;
}> {
  await requireTriggerLaunchAuthority(transaction, trigger);
  const revision = await transaction
    .selectFrom("triggerRevisions")
    .select(["id", executableProgram.as("executable")])
    .where("id", "=", trigger.currentRevisionId)
    .executeTakeFirstOrThrow();
  if (!revision.executable) throw conflict(TRIGGER_PROGRAM_UPDATE_REASON);
  const existing = await transaction
    .selectFrom("triggerOccurrences")
    .leftJoin("commands", "commands.id", "triggerOccurrences.commandId")
    .selectAll("triggerOccurrences")
    .select("commands.frameSentAt")
    .where("triggerOccurrences.triggerId", "=", trigger.id)
    .where("triggerOccurrences.sourceKey", "=", sourceKey)
    .executeTakeFirst();
  if (existing)
    return {
      occurrence: occurrenceFromRow(existing),
      wasDuplicate: true,
    };
  // Every caller holds the Trigger row lock, so this count cannot race another
  // ingress. An offline Runner must not accumulate an unbounded durable queue:
  // over the cap the sender's own retry policy is the overflow buffer.
  const pending = await countPendingOccurrences(transaction, trigger.id);
  if (pending >= MAX_PENDING_TRIGGER_OCCURRENCES) {
    throw new OpensteerError({
      code: "resource_exhausted",
      details: {
        pendingLimit: MAX_PENDING_TRIGGER_OCCURRENCES,
        triggerId: trigger.id,
      },
      message: `Automation already has ${MAX_PENDING_TRIGGER_OCCURRENCES} pending occurrences, its durable limit`,
    });
  }
  const admission = await requireTriggerLaunchAuthority(transaction, trigger);
  const occurrenceId = createId("triggerOccurrence");
  const commandId = createId("command");
  const now = new Date();
  const event = TriggerProgramEventSchema.parse({
    id: occurrenceId,
    payload: input.payload,
    receivedAt: now.toISOString(),
    source: input.source,
    trigger: {
      anchorThreadId: trigger.anchorThreadId,
      id: trigger.id,
      revisionId: revision.id,
    },
  });
  const principalId = await principalIdForUser(transaction, trigger.createdBy);
  await transaction
    .insertInto("commands")
    .values({
      actorPrincipalId: principalId,
      authoritySource: jsonValue({
        kind: "trigger",
        triggerId: trigger.id,
      }),
      dispatcherId: null,
      environmentId: admission.environmentId,
      id: commandId,
      idempotencyKey: `trigger-occurrence:${occurrenceId}`,
      lastError: null,
      payload: jsonValue({
        occurrenceId,
        type: "trigger.execute",
      }),
      requestedBy: trigger.createdBy,
      runId: null,
      status: "pending",
      threadId: trigger.anchorThreadId,
      type: "trigger.execute",
    })
    .execute();
  await wakeExecutionCommands(transaction);
  const row = await transaction
    .insertInto("triggerOccurrences")
    .values({
      commandId,
      completedAt: null,
      createdAt: now,
      environmentId: admission.environmentId,
      error: null,
      event: jsonValue(event),
      executionGeneration: 0,
      exitCode: null,
      id: occurrenceId,
      result: null,
      revisionId: revision.id,
      runnerBootId: null,
      runnerId: null,
      sourceKey,
      startedAt: null,
      ...triggerOccurrenceStateColumns("pending"),
      stderr: "",
      stdout: "",
      triggerId: trigger.id,
      updatedAt: now,
      ...(webhookBody ? { webhookBody } : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return {
    occurrence: occurrenceFromRow({ ...row, frameSentAt: null }),
    wasDuplicate: false,
  };
}
async function pendingScheduleOccurrenceExists(
  transaction: Transaction<DatabaseSchema>,
  triggerId: TriggerId,
): Promise<boolean> {
  const row = await transaction
    .selectFrom("triggerOccurrences")
    .select("id")
    .where("triggerId", "=", triggerId)
    .where("status", "=", "pending")
    .where(sql<boolean>`event -> 'source' ->> 'kind' = 'schedule'`)
    .executeTakeFirst();
  return row !== undefined;
}
async function countPendingOccurrences(
  transaction: Transaction<DatabaseSchema>,
  triggerId: TriggerId,
): Promise<number> {
  const row = await transaction
    .selectFrom("triggerOccurrences")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("triggerId", "=", triggerId)
    .where("status", "=", "pending")
    .executeTakeFirstOrThrow();
  const parsed = Number(row.count);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new OpensteerError({
      code: "internal",
      message: "Invalid pending Occurrence count",
    });
  }
  return parsed;
}
async function loadDispatchContext(
  transaction: Transaction<DatabaseSchema>,
  occurrenceId: TriggerOccurrenceId,
): Promise<TriggerDispatchContext> {
  const occurrence = await transaction
    .selectFrom("triggerOccurrences")
    .selectAll()
    .where("id", "=", occurrenceId)
    .executeTakeFirstOrThrow();
  const trigger = await transaction
    .selectFrom("triggers")
    .selectAll()
    .where("id", "=", occurrence.triggerId)
    .executeTakeFirstOrThrow();
  await requireTriggerLaunchAuthority(transaction, trigger);
  const [revision, anchorThread] = await Promise.all([
    transaction
      .selectFrom("triggerRevisions")
      .selectAll()
      .where("id", "=", occurrence.revisionId)
      .executeTakeFirstOrThrow(),
    transaction
      .selectFrom("threads")
      .select(["environmentId", "id"])
      .where("id", "=", trigger.anchorThreadId)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    anchorThread,
    encryptedSecrets: trigger.encryptedSecrets ?? null,
    occurrence: occurrenceFromRow(occurrence),
    revision: revisionFromRow(revision),
    script: revision.script ? AutomationScriptSchema.parse(revision.script) : null,
    trigger: triggerFromRow(trigger),
    webhookBody: occurrence.webhookBody ?? null,
    agentHome: (await personalSettings(transaction)).agentHome,
  };
}
async function requireAnchorThread(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
  userId: UserId,
  backgroundJob = false,
): Promise<{
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly originConnectionId: string | null;
}> {
  const anchor = await transaction
    .selectFrom("threads")
    .select(["purpose", "doneAt", "status", "originConnectionId"])
    .where("id", "=", threadId)
    .executeTakeFirst();
  if (
    !anchor ||
    (anchor.purpose !== "task" && !(backgroundJob && anchor.purpose === "background-job")) ||
    anchor.doneAt ||
    anchor.status === "archived"
  )
    throw new OpensteerError({
      code: "bad_request",
      message: "Choose an open task for the automation.",
    });
  const admission = await admitThreadExecution(transaction, threadId, userId);
  if (!admission)
    throw new OpensteerError({
      code: "forbidden",
      message: "Task is unavailable",
    });
  return {
    environmentId: admission.environmentId,
    id: threadId,
    originConnectionId: anchor.originConnectionId,
  };
}
type LockedTriggerAuthority = {
  readonly actor: AuthorityThread;
  readonly anchor: AuthorityThread;
} | null;
function lockTriggerAuthorityThreads(
  transaction: Transaction<DatabaseSchema>,
  actorThreadId: ThreadId | null,
  anchorThreadId: ThreadId,
  ceiling?: ThreadAccessMode,
): Promise<LockedTriggerAuthority> {
  return readTriggerAuthorityThreads(transaction, actorThreadId, anchorThreadId, ceiling, true);
}
async function readTriggerAuthorityThreads(
  transaction: Transaction<DatabaseSchema>,
  actorThreadId: ThreadId | null,
  anchorThreadId: ThreadId,
  ceiling?: ThreadAccessMode,
  lock = false,
): Promise<LockedTriggerAuthority> {
  if (actorThreadId === null && ceiling === undefined) return null;
  const query = transaction
    .selectFrom("threads")
    .select(["id", "accessMode"])
    .where("id", "in", actorThreadId ? [actorThreadId, anchorThreadId] : [anchorThreadId])
    .orderBy("id");
  const rows = await (lock ? query.forShare() : query).execute();
  const actor = rows.find((row) => row.id === actorThreadId);
  const anchor = rows.find((row) => row.id === anchorThreadId);
  if (!anchor || (actorThreadId !== null && !actor)) throw notFound();
  if (actor && ceiling && !threadAccessModeAtMost(ceiling, actor.accessMode))
    throw new OpensteerError({
      code: "forbidden",
      message: "The calling task's access was reduced.",
    });
  return { actor: { accessMode: ceiling ?? actor!.accessMode }, anchor };
}
async function lockTriggerForMutation(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorThreadId: ThreadId | null;
    readonly actorAccessMode?: ThreadAccessMode;
    /** The external agent connection the actor works for, checked under this mutation's fence. */
    readonly actorConnectionId?: string;
    readonly ownerId: UserId;
    readonly triggerId: TriggerId;
  },
  requiredAccess: "control" | "define",
): Promise<TriggerRow> {
  // Work acting from a task reads its automations as it reads them anywhere: one it may not
  // read (a memory worker's own task tree, an automation without personal context) is missing.
  const reader: TaskReader =
    input.actorThreadId === null
      ? personTaskReader
      : { kind: "work", threadId: input.actorThreadId };
  const observed = await transaction
    .selectFrom("triggers")
    .innerJoin("threads", "threads.id", "triggers.anchorThreadId")
    .select("triggers.anchorThreadId")
    .where("triggers.id", "=", input.triggerId)
    .where("triggers.createdBy", "=", input.ownerId)
    .$if(reader.kind === "work", (q) => q.where(automationReaderSees(reader)))
    .executeTakeFirst();
  if (!observed) throw notFound();
  const authority = await lockTriggerAuthorityThreads(
    transaction,
    input.actorThreadId,
    observed.anchorThreadId,
    input.actorAccessMode,
  );
  const trigger = await transaction
    .selectFrom("triggers")
    .selectAll()
    .where("id", "=", input.triggerId)
    .where("createdBy", "=", input.ownerId)
    .where("anchorThreadId", "=", observed.anchorThreadId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!trigger) throw notFound();
  assertTriggerAccess(authority, requiredAccess);
  return trigger;
}
function assertTriggerAccess(
  authority: LockedTriggerAuthority,
  requiredAccess: "control" | "define",
): void {
  if (authority === null) return;
  const access = triggerAccess(authority.actor, authority.anchor);
  if (access === "none") throw notFound();
  if (access === "define" || (access === "control" && requiredAccess === "control")) return;
  const messages: Record<Exclude<TriggerAccess, "none" | "define">, string> = {
    see: "This task can read this Trigger. Controlling it requires an access mode at least as high as its anchor; changing its program requires full access.",
    control:
      "This task can pause, resume, cancel pending runs or reschedule this Trigger. Changing its program requires full access.",
  };
  throw new OpensteerError({
    code: "forbidden",
    message: messages[access],
  });
}

/** The Deployment fence keeps anchor placement stable while capacity is reserved. */
async function lockWatchAnchorPlacementForTrigger(
  transaction: Transaction<DatabaseSchema>,
  triggerId: TriggerId,
): Promise<void> {
  const observed = await transaction
    .selectFrom("triggers")
    .select(["anchorThreadId"])
    .where("id", "=", triggerId)
    .where("kind", "=", "watch")
    .executeTakeFirst();
  if (!observed) return;
  await lockWatchAnchorPlacement(transaction, observed.anchorThreadId);
}
async function lockWatchAnchorPlacement(
  transaction: Transaction<DatabaseSchema>,
  anchorThreadId: ThreadId,
): Promise<void> {
  const anchor = await transaction
    .selectFrom("threads")
    .select("environmentId")
    .where("id", "=", anchorThreadId)
    .executeTakeFirstOrThrow();
  await transaction
    .selectFrom("executionEnvironments")
    .select("id")
    .where("id", "=", anchor.environmentId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
}
async function createWatchActivation(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly anchorThreadId: ThreadId;
    readonly createdBy: UserId;
    readonly environmentId: EnvironmentId;
    readonly revisionId: TriggerRevisionId;
    readonly triggerId: TriggerId;
  },
): Promise<TriggerWatchActivation> {
  await transaction
    .selectFrom("executionEnvironments")
    .select("id")
    .where("id", "=", input.environmentId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  const now = new Date();
  const row = await transaction
    .insertInto("triggerWatchActivations")
    .values({
      anchorThreadId: input.anchorThreadId,
      consecutiveFailures: 0,
      createdAt: now,
      createdBy: input.createdBy,
      desired: "active",
      environmentId: input.environmentId,
      executionGeneration: 0,
      healthySince: null,
      id: createId("triggerWatchActivation"),
      lastError: null,
      lastExitCode: null,
      leaseExpiresAt: null,
      observed: "starting",
      restartCount: 0,
      revisionId: input.revisionId,
      runnerBootId: null,
      runnerConnectionGeneration: null,
      runnerId: null,
      stderrTail: "",
      stdoutTail: "",
      triggerId: input.triggerId,
      updatedAt: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return watchActivationFromRow(row);
}
async function stopActiveWatchActivation(
  transaction: Transaction<DatabaseSchema>,
  triggerId: TriggerId,
  now: Date,
): Promise<void> {
  await transaction
    .updateTable("triggerWatchActivations")
    .set({
      desired: "stopped",
      leaseExpiresAt: null,
      observed: sql`case when runner_id is null then 'stopped' else observed end`,
      updatedAt: now,
    })
    .where("triggerId", "=", triggerId)
    .where("desired", "=", "active")
    .execute();
}
async function automationHandoffWitness(
  transaction: Transaction<DatabaseSchema>,
  trigger: Pick<TriggerRow, "anchorThreadId" | "createdBy" | "originConnectionId">,
) {
  if (!trigger.originConnectionId) return {};
  const connection = await liveDelegatingConnection(
    transaction,
    trigger.createdBy,
    trigger.originConnectionId,
  );
  const thread = await transaction
    .selectFrom("threads")
    .select("accessMode")
    .where("id", "=", trigger.anchorThreadId)
    .executeTakeFirstOrThrow();
  return {
    connectionId: connection.agentConnectionId,
    admittedGrantRevision: connection.grantRevision,
    admittedAccessMode: threadAccessModeAtMost(thread.accessMode, connection.accessMode)
      ? thread.accessMode
      : connection.accessMode,
  };
}
/**
 * A new occurrence, dispatch or program call: its anchor's environment and, for an automation a
 * connection made, that connection still live and still granted Tasks.
 */
/**
 * The automation belongs to a chat (by its own lineage, `triggers.origin_connection_id`, as
 * authority and Disconnect read it) that is paused, asked of the one state function. Its schedule
 * does not fire and its work is held until the chat is back.
 */
export async function triggerChatWaiting(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  trigger: Pick<TriggerRow, "originConnectionId">,
): Promise<boolean> {
  if (trigger.originConnectionId === null) return false;
  const { rows } = await sql<{ waiting: boolean }>`
    select ${connectionState(database)} = 'waiting' as waiting
    from agent_connections
    where agent_connections.bridge_account_id is not null
      and agent_connections.id = ${trigger.originConnectionId}`.execute(database);
  return rows[0]?.waiting === true;
}

/** The same, as SQL over the unaliased `triggers` row, for the schedule's claim and deadline. */
function triggerChatHeld(database: object) {
  return sql<boolean>`exists (
    select 1 from agent_connections
    where agent_connections.id = triggers.origin_connection_id
      and agent_connections.bridge_account_id is not null
      and ${connectionState(database)} = 'waiting')`;
}
/** A claim's answer for a schedule whose chat is waiting: nothing created, nothing moved. */
const held = Symbol("held");

/**
 * The launch refusal for an automation whose chat is waiting. Callers read it as the refusal it
 * always was (`forbidden`, the same words); a schedule's claim reads it as held.
 */
class TriggerChatWaiting extends OpensteerError {
  constructor() {
    super({ code: "forbidden", message: "Automation execution authority is no longer active" });
  }
}

/** Admitted, held (its chat is waiting) or lost, as one fact (`lineageExecutionStanding`). */
function triggerLaunchStanding(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  trigger: Pick<TriggerRow, "anchorThreadId" | "createdBy" | "originConnectionId">,
) {
  return lineageExecutionStanding(database, {
    threadId: trigger.anchorThreadId,
    userId: trigger.createdBy,
    agentConnectionId: trigger.originConnectionId,
  });
}
async function requireTriggerLaunchAuthority(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  trigger: Pick<TriggerRow, "anchorThreadId" | "createdBy" | "originConnectionId">,
) {
  const standing = await triggerLaunchStanding(database, trigger);
  if (standing.kind === "waiting") throw new TriggerChatWaiting();
  if (standing.kind === "lost")
    throw new OpensteerError({
      code: "forbidden",
      message: "Automation execution authority is no longer active",
    });
  return { environmentId: standing.environmentId };
}
async function requireTriggerExecutionAuthority(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  trigger: Pick<TriggerRow, "anchorThreadId" | "createdBy">,
) {
  const admission = await admitThreadExecution(database, trigger.anchorThreadId, trigger.createdBy);
  if (!admission) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Automation execution authority is no longer active",
    });
  }
  return admission;
}
async function principalIdForUser(transaction: Transaction<DatabaseSchema>, userId: UserId) {
  const principal = await transaction
    .selectFrom("principals")
    .select("id")
    .where("kind", "=", "user")
    .where("userId", "=", userId)
    .executeTakeFirst();
  if (!principal)
    throw new OpensteerError({
      code: "internal",
      message: "User principal is missing",
    });
  return PrincipalIdSchema.parse(principal.id);
}
function validateSource(source: TriggerSource): void {
  if (source.kind === "schedule") validateTriggerSchedule(source.schedule);
}
function resumedScheduleFireAt(
  schedule: Extract<
    TriggerSource,
    {
      kind: "schedule";
    }
  >["schedule"],
  now: Date,
): Date | null {
  if (schedule.kind === "at") {
    const at = new Date(schedule.at);
    return at.getTime() > now.getTime() ? at : null;
  }
  return firstTriggerFireAt(schedule, now);
}

/** A source as a list shows it: when it runs, without the payload it carries. */
function withoutSchedulePayload(source: TriggerSource): TriggerSource {
  if (source.kind !== "schedule") return source;
  const { payload: _payload, ...schedule } = source.schedule;
  return {
    kind: "schedule",
    schedule,
  };
}
function triggerFromRow(row: TriggerRow, needsProgramUpdate = false): Trigger {
  // Version gates execution while the stored status preserves the owner's intent.
  const blocked = needsProgramUpdate && row.status !== "archived";
  return TriggerSchema.parse({
    systemRole: row.systemRole,
    anchorThreadId: row.anchorThreadId,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    createdByThreadId: row.createdByThreadId,
    currentRevisionId: row.currentRevisionId,
    id: row.id,
    kind: row.kind,
    name: row.name,
    nextFireAt: blocked ? null : (row.nextFireAt?.toISOString() ?? null),
    pauseReason: blocked ? TRIGGER_PROGRAM_UPDATE_REASON : row.pauseReason,
    waitingReason: blocked ? null : row.waitingReason,
    status: blocked ? "paused" : row.status,
    updatedAt: row.updatedAt.toISOString(),
    webhookRouteKey: row.webhookRouteKey,
  });
}
function revisionFromRow(row: TriggerRevisionRow): TriggerRevision {
  const script = row.script !== null ? AutomationScriptSchema.parse(row.script) : null;
  const legacySource = script === null ? (row.legacySource ?? undefined) : undefined;
  return TriggerRevisionSchema.parse({
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    createdByThreadId: row.createdByThreadId,
    id: row.id,
    ...(legacySource !== undefined ? { legacySource } : {}),
    ordinal: row.ordinal,
    script,
    source: row.source,
    triggerId: row.triggerId,
  });
}
function occurrenceFromRow(
  row: TriggerOccurrenceRow & { readonly frameSentAt?: Date | null },
): TriggerOccurrence {
  return TriggerOccurrenceSchema.parse({
    commandId: CommandIdSchema.parse(row.commandId),
    completedAt: row.completedAt?.toISOString() ?? null,
    contactLostAt: row.contactLostAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    environmentId: row.environmentId,
    error: row.error,
    event: row.event,
    exitCode: row.exitCode,
    id: row.id,
    result: row.result,
    revisionId: row.revisionId,
    ...(row.frameSentAt !== undefined ? { sent: row.frameSentAt !== null } : {}),
    startedAt: row.startedAt?.toISOString() ?? null,
    status: row.status,
    stderr: row.stderr,
    stdout: row.stdout,
    triggerId: row.triggerId,
  });
}
function watchActivationFromRow(row: TriggerWatchActivationRow): TriggerWatchActivation {
  const {
    connectionId: _connectionId,
    admittedGrantRevision: _admittedGrantRevision,
    admittedAccessMode: _admittedAccessMode,
    terminalEvidenceAt: _terminalEvidenceAt,
    contactLostAt: _contactLostAt,
    ...activation
  } = row;
  return TriggerWatchActivationSchema.parse({
    ...activation,
    createdAt: row.createdAt.toISOString(),
    executionGeneration: Number(row.executionGeneration),
    healthySince: row.healthySince?.toISOString() ?? null,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    runnerConnectionGeneration:
      row.runnerConnectionGeneration === null ? null : Number(row.runnerConnectionGeneration),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
function required(value: string | undefined): string {
  if (!value) throw new TypeError("Webhook identity is required");
  return value;
}
function notFound(message = "Trigger not found"): OpensteerError {
  return new OpensteerError({
    code: "not_found",
    message,
  });
}
function conflict(message: string): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    message,
  });
}
function idempotencyConflict(): OpensteerError {
  return conflict("Idempotency key was already used with different automation input");
}

/** The Trigger and watch activation rows are reserved before Request settlement. */
/**
 * Disconnect pauses an automation whose connection lost authority. Its own authority is already
 * gone, so this needs none: it only stops the automation from running again.
 */
export function pauseLineageTrigger(
  database: Kysely<DatabaseSchema>,
  triggerId: TriggerId,
): Promise<void> {
  return commitPersonalMutation(database, async (transaction) => {
    await lockWatchAnchorPlacementForTrigger(transaction, triggerId);
    const trigger = await transaction
      .selectFrom("triggers")
      .selectAll()
      .where("id", "=", triggerId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (trigger?.status !== "active") return;
    await pauseTriggerInTransaction(transaction, trigger, {
      pauseReason: "Paused because the connected agent that made it was disconnected.",
      pausedBy: "system",
    });
  });
}
export async function pauseTriggerInTransaction(
  transaction: Transaction<DatabaseSchema>,
  trigger: TriggerRow,
  options?: {
    readonly pauseReason?: string | null;
    readonly pausedBy?: AutomationPausedBy | null;
    readonly pausedByConnectionId?: string | null;
    readonly pausedByThreadId?: ThreadId | null;
  },
): Promise<TriggerRow> {
  if (trigger.status !== "active") return trigger;
  const now = new Date();
  const updated = await transaction
    .updateTable("triggers")
    .set({
      status: "paused",
      pauseReason: options?.pauseReason ?? null,
      pausedAt: now,
      pausedBy: options?.pausedBy ?? null,
      pausedByConnectionId: options?.pausedByConnectionId ?? null,
      pausedByThreadId: options?.pausedByThreadId ?? null,
      nextFireAt: trigger.kind === "schedule" ? null : trigger.nextFireAt,
      updatedAt: now,
    })
    .where("id", "=", trigger.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  if (trigger.kind === "watch") await stopActiveWatchActivation(transaction, trigger.id, now);
  await wakePausedTriggerInterrupts(transaction);
  return updated;
}

/** A lineaged actor's connection, locked ahead of every trigger row and checked live. */
/**
 * The actor as it stands inside this mutation's fence. Its connection is held and must still
 * delegate; the mode the caller was admitted with is capped by the connection's mode now, so a
 * lowering committed after the MCP check still applies.
 */
async function admitTriggerActor<
  Input extends {
    readonly actorConnectionId?: string | undefined;
    readonly actorAccessMode?: ThreadAccessMode | undefined;
  },
>(
  transaction: Transaction<DatabaseSchema>,
  ownerId: UserId,
  input: Input,
): Promise<{ readonly input: Input; readonly connection: AgentConnectionAuthority | null }> {
  if (!input.actorConnectionId) return { input, connection: null };
  await transaction
    .selectFrom("agentConnections")
    .select("id")
    .where("id", "=", input.actorConnectionId)
    .forShare()
    .executeTakeFirst();
  const connection = await liveDelegatingConnection(transaction, ownerId, input.actorConnectionId);
  const actorAccessMode = input.actorAccessMode
    ? minThreadAccessMode(input.actorAccessMode, connection.accessMode)
    : connection.accessMode;
  return { input: { ...input, actorAccessMode }, connection };
}

/** An automation as a reader may see it: by its anchor task's lineage and its own. */
function automationReaderSees(reader: TaskReader) {
  return readerSees(
    reader,
    sql.ref("threads.origin_connection_id"),
    sql.ref("triggers.origin_connection_id"),
  );
}

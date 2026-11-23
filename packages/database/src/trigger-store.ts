import { personalSettings, requirePersonalOwner } from "./personal-settings-store.js";
import {
  commitPersonalMutation,
  wakeExecutionCommands,
  wakeTriggerSchedules,
} from "./personal-mutation.js";
import { TransactionScopeChanged } from "./connection.js";
import { jsonValue, lockCommandIdempotency } from "./store-primitives.js";
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
  MANAGED_MEMORY_REFUSAL,
  type TriggerSystemRole,
  MAX_PENDING_TRIGGER_OCCURRENCES,
  MAX_ACTIVE_WATCHES_PER_ENVIRONMENT,
  TRIGGER_AUTO_PAUSE_FAILURE_THRESHOLD,
  TRIGGER_AUTO_PAUSE_REASON,
  TRIGGER_PROGRAM_UPDATE_REASON,
  WATCH_AUTO_PAUSE_FAILURE_THRESHOLD,
  WATCH_AUTO_PAUSE_REASON,
  WATCH_HEALTHY_WINDOW_MS,
  TriggerOccurrenceSchema,
  TriggerProgramEventSchema,
  TriggerProgramSchema,
  TriggerRevisionSchema,
  TriggerSchema,
  TriggerSourceSchema,
  TriggerSummarySchema,
  TriggerWatchActivationSchema,
  firstTriggerFireAt,
  isExecutableTriggerProgram,
  nextTriggerFireAfter,
  triggerOccurrenceErrorMessage,
  triggerAccess,
  validateTriggerSchedule,
  type Trigger,
  type TriggerExecutionOutput,
  type TriggerOccurrence,
  type TriggerProgram,
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
  connectionIsWaiting,
  lineagePersonalContext,
  liveDelegatingConnection,
  meetsConnectionFloor,
  sendEligible,
  type AgentConnectionAuthority,
} from "./resource-access.js";
import { lineageExecutionStanding } from "./execution-authority.js";
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
const maxPostgresInteger = 2_147_483_647;
const currentProgramVersion = TriggerProgramSchema.shape.toolContractVersion.value;
const executableProgram = sql<boolean>`trigger_revisions.program->'toolContractVersion' = to_jsonb(${currentProgramVersion}::integer)`;
const noAutomationPauseReason =
  "Paused because a chat that anyone in the conversation can message can't have an automation.";
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
  readonly program: TriggerProgram;
  readonly source: TriggerSource;
  readonly webhookRouteKey?: string;
  readonly webhookSecretHash?: string;
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
export interface TriggerDispatchContext {
  readonly anchorThread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  };
  readonly occurrence: TriggerOccurrence;
  readonly revision: TriggerRevision;
  readonly trigger: Trigger;
  readonly agentHome: import("@opensteer/core").ComputerFolder;
}

export interface WatchActivationContext {
  readonly activation: TriggerWatchActivation;
  readonly connectionId?: string;
  readonly toolContractVersion: typeof currentProgramVersion;
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

/** Validates every fact carried by a Trigger execution capability. */
export async function assertActiveTriggerExecutionBinding(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  input: ActiveTriggerExecutionBindingInput,
): Promise<void> {
  const row = await database
    .selectFrom("triggerOccurrences")
    .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
    .select([
      "triggers.anchorThreadId",
      "triggers.createdBy",
      "triggers.originConnectionId",
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
  const ended = () =>
    new OpensteerError({ code: "forbidden", message: "Automation execution is no longer active" });
  if (!row) throw ended();
  // Its chat's standing, read once: one that waits holds the automation (`triggerChatIsWaiting`),
  // anything else that is not live ends it.
  const connection = row.originConnectionId
    ? await liveDelegatingConnection(database, row.createdBy, row.originConnectionId).catch(
        (error: unknown) => {
          throw connectionIsWaiting(error) ? new TriggerChatWaiting() : ended();
        },
      )
    : null;
  if (
    !(await admitThreadExecution(database, row.anchorThreadId, row.createdBy)) ||
    (connection &&
      !meetsConnectionFloor(connection, row.admittedGrantRevision, row.admittedAccessMode))
  )
    throw ended();
}

/** Validates every fact carried by a continuously running watch capability. */
export async function assertActiveWatchBinding(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  input: ActiveWatchBindingInput,
): Promise<void> {
  const row = await database
    .selectFrom("triggerWatchActivations")
    .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
    .innerJoin("triggerRevisions", "triggerRevisions.id", "triggerWatchActivations.revisionId")
    .select([
      "triggerWatchActivations.anchorThreadId",
      "triggerWatchActivations.createdBy",
      "triggerWatchActivations.environmentId",
      "triggerWatchActivations.admittedGrantRevision",
      "triggerWatchActivations.admittedAccessMode",
      "triggers.originConnectionId",
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
  const ended = () =>
    new OpensteerError({ code: "forbidden", message: "Watch activation is no longer active" });
  if (
    !row ||
    row.anchorThreadId !== input.anchorThreadId ||
    row.createdBy !== input.createdBy ||
    row.environmentId !== input.environmentId
  )
    throw ended();
  // Its lineage's standing, read once, as the execution binding reads it.
  const connection = row.originConnectionId
    ? await liveDelegatingConnection(database, row.createdBy, row.originConnectionId).catch(() => {
        throw ended();
      })
    : null;
  const admission = await admitThreadExecution(database, row.anchorThreadId, row.createdBy);
  if (
    !admission ||
    admission.environmentId !== input.environmentId ||
    (connection &&
      !meetsConnectionFloor(connection, row.admittedGrantRevision, row.admittedAccessMode))
  )
    throw ended();
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
  const program = TriggerProgramSchema.parse(input.program);
  validateSource(source);
  // The caller's intent, so a replay of an own-task create matches its receipt.
  const requestFingerprint = fingerprint({
    anchorThreadId: input.anchorThreadId,
    name: input.name,
    program,
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
    await lockWatchCapacityForTrigger(transaction, existing.id);
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
      trigger: triggerFromRow(trigger, !isExecutableTriggerProgram(parsed.program)),
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
    await lockWatchCapacity(transaction, anchorThreadId);
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
  // A program runs as the person, in their Agent home, outside any engine's sandbox: a lineage
  // without personal context (a chat anyone in the conversation can message) never defines one.
  if (
    !managed &&
    ((input.actorConnectionId !== undefined &&
      !(await lineagePersonalContext(transaction, input.actorConnectionId))) ||
      (anchor.originConnectionId !== null &&
        !(await lineagePersonalContext(transaction, anchor.originConnectionId))))
  )
    throw noProgramWithoutPersonalContext();
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
      consecutiveFailures: 0,
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
      webhookSecretHash: source.kind === "webhook" ? required(input.webhookSecretHash) : null,
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
      program: jsonValue(program),
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
  if (source.kind === "watch") await lockWatchCapacity(transaction, input.anchorThreadId);
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
    program: TriggerProgram;
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
    readonly program?: TriggerProgram;
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
    if (input.name === undefined && input.program === undefined && input.source === undefined) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Automation update requires at least one of name, program, or source",
      });
    }
    return commitPersonalMutation(this.#database, async (transaction) => {
      input = (await admitTriggerActor(transaction, input.ownerId, input)).input;
      await lockWatchCapacityForTrigger(transaction, input.triggerId);
      const trigger = await lockTriggerForMutation(transaction, input, "define");
      // Another lineage's program, or the person's, would run with authority this actor lacks.
      if (
        input.actorConnectionId &&
        (input.program !== undefined || input.source !== undefined) &&
        trigger.originConnectionId !== input.actorConnectionId
      )
        throw new OpensteerError({
          code: "forbidden",
          message:
            "A connected agent cannot replace the program of an automation it did not create.",
        });
      // Its program would run in the person's Agent home: nothing of it is set, or made to run
      // again, from such a lineage.
      if (
        trigger.originConnectionId !== null &&
        !(await lineagePersonalContext(transaction, trigger.originConnectionId))
      )
        throw noProgramWithoutPersonalContext();
      if (!systemProgram) await requireTriggerExecutionAuthority(transaction, trigger);
      if (systemProgram && !trigger.systemRole)
        throw conflict("Only system automations can regenerate programs");
      if (
        trigger.systemRole &&
        !systemProgram &&
        (input.name !== undefined ||
          input.program !== undefined ||
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
      const program = TriggerProgramSchema.parse(input.program ?? current.program);
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
          program: jsonValue(program),
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
          ...(input.program === undefined && input.source === undefined
            ? {}
            : {
                consecutiveFailures: 0,
              }),
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
      // A new program can make a waiting schedule runnable at its existing time,
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
    return commitPersonalMutation(this.#database, async (transaction) => {
      input = (await admitTriggerActor(transaction, input.ownerId, input)).input;
      await lockWatchCapacityForTrigger(transaction, input.triggerId);
      const trigger = await lockTriggerForMutation(
        transaction,
        input,
        input.status === "archived" ? "define" : "control",
      );
      await requireTriggerExecutionAuthority(transaction, trigger);
      // Resumed, it would launch in the person's Agent home: refused now, in the launch's words.
      if (
        input.status === "active" &&
        trigger.originConnectionId !== null &&
        !(await lineagePersonalContext(transaction, trigger.originConnectionId))
      )
        throw noProgramWithoutPersonalContext();
      if (trigger.systemRole && input.status === "archived") throw conflict(MANAGED_MEMORY_REFUSAL);
      if (trigger.status === "archived") {
        if (input.status === "archived") return triggerFromRow(trigger);
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
      // Repeating the current status is a no-op: an auto-paused Trigger keeps
      // its reason and an active one keeps its failure count.
      if (trigger.status === input.status) return triggerFromRow(trigger, needsUpdate);
      if (input.status === "paused") {
        return triggerFromRow(await pauseTriggerInTransaction(transaction, trigger), needsUpdate);
      }
      let nextFireAt = trigger.nextFireAt;
      if (trigger.kind === "schedule") {
        if (!revision) {
          nextFireAt = null;
        } else {
          const source = TriggerSourceSchema.parse(revision.source);
          if (source.kind !== "schedule") throw new Error("Schedule Trigger revision is invalid");
          nextFireAt = resumedScheduleFireAt(source.schedule, new Date());
        }
      }
      const updated = await transaction
        .updateTable("triggers")
        .set({
          ...(input.status === "active"
            ? {
                consecutiveFailures: 0,
              }
            : {}),
          nextFireAt,
          pauseReason: null,
          status: input.status,
          updatedAt: new Date(),
        })
        .where("id", "=", trigger.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (nextFireAt) await wakeTriggerSchedules(transaction);
      if (trigger.kind === "watch") {
        await stopActiveWatchActivation(transaction, trigger.id, updated.updatedAt);
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
      return triggerFromRow(updated);
    });
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
      if (
        trigger.originConnectionId !== null &&
        !(await lineagePersonalContext(transaction, trigger.originConnectionId))
      )
        throw noProgramWithoutPersonalContext();
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
        .select(["completedAt", "createdAt", "error", "event", "id", "status", "triggerId"])
        .distinctOn("triggerId")
        .where("triggerId", "in", triggerIds)
        .orderBy("triggerId")
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
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
              createdAt: occurrence.createdAt.toISOString(),
              error: triggerOccurrenceErrorMessage(occurrence.error),
              id: occurrence.id,
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
        const admission = await triggerLaunchStanding(transaction, trigger);
        if (
          trigger.status !== "active" ||
          trigger.currentRevisionId !== row.revisionId ||
          !row.executable ||
          admission.kind !== "admitted" ||
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
          toolContractVersion: currentProgramVersion,
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
  async watchProgram(input: ActiveWatchBindingInput): Promise<TriggerProgram> {
    await this.assertActiveWatchBinding(input);
    const revision = await this.#database
      .selectFrom("triggerRevisions")
      .select("program")
      .where("id", "=", input.revisionId)
      .where("triggerId", "=", input.triggerId)
      .executeTakeFirstOrThrow();
    return TriggerProgramSchema.parse(revision.program);
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
    readonly autoPaused: boolean;
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
      if (
        activation.desired === "active" &&
        input.observed === "running" &&
        input.healthySince &&
        now.getTime() - input.healthySince.getTime() >= WATCH_HEALTHY_WINDOW_MS
      ) {
        consecutiveFailures = 0;
      }
      const autoPaused =
        activation.desired === "active" &&
        trigger.status === "active" &&
        consecutiveFailures >= WATCH_AUTO_PAUSE_FAILURE_THRESHOLD;
      if (autoPaused) {
        await transaction
          .updateTable("triggers")
          .set({
            consecutiveFailures,
            pauseReason: WATCH_AUTO_PAUSE_REASON,
            status: "paused",
            updatedAt: now,
          })
          .where("id", "=", trigger.id)
          .execute();
      }
      if (autoPaused) {
        await recordAutomationFailure(transaction, {
          activationId: activation.id,
          detail: input.lastError ?? input.stderrTail.slice(-2_000),
          reason: "paused",
          triggerId: trigger.id,
        });
      }
      const updated = await transaction
        .updateTable("triggerWatchActivations")
        .set({
          consecutiveFailures,
          desired: autoPaused ? "stopped" : activation.desired,
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
        autoPaused,
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
        .selectAll()
        .where("triggerId", "=", trigger.id)
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
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
      trigger: triggerFromRow(trigger, !isExecutableTriggerProgram(parsed.program)),
    };
  }
  async webhookRoute(routeKey: string): Promise<{
    readonly secretHash: string;
    readonly trigger: Trigger;
  } | null> {
    const row = await this.#database
      .selectFrom("triggers")
      .selectAll()
      .where("webhookRouteKey", "=", routeKey)
      .executeTakeFirst();
    if (!row?.webhookSecretHash) return null;
    return {
      secretHash: row.webhookSecretHash,
      trigger: triggerFromRow(row),
    };
  }
  enqueueWebhook(input: {
    readonly deliveryId?: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly method: string;
    readonly payload: unknown;
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
      if (!trigger) throw notFound();
      if (trigger.status !== "active") throw conflict("Webhook automation is not active");
      await requireTriggerExecutionAuthority(transaction, trigger);
      const sourceKey = input.deliveryId
        ? `webhook:${input.deliveryId}`
        : `webhook:${globalThis.crypto.randomUUID()}`;
      return enqueueOccurrence(transaction, trigger, sourceKey, {
        payload: input.payload,
        source: {
          ...(input.deliveryId
            ? {
                deliveryId: input.deliveryId,
              }
            : {}),
          headers: {
            ...input.headers,
          },
          kind: "webhook",
          method: input.method,
        },
      });
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
      if (trigger.systemRole) throw conflict(MANAGED_MEMORY_REFUSAL);
      const enqueued = await enqueueOccurrence(
        transaction,
        trigger,
        input.idempotencyKey === undefined
          ? `manual:${globalThis.crypto.randomUUID()}`
          : `manual-command:${JSON.stringify([input.ownerId, input.actorThreadId, input.idempotencyKey])}`,
        {
          payload: input.payload ?? null,
          source: {
            kind: "manual",
          },
        },
      );
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
        const observedPending = await transaction
          .selectFrom("triggerOccurrences")
          .select("id")
          .where("triggerId", "=", input.triggerId)
          .where("status", "=", "pending")
          .$if(input.occurrenceId !== undefined, (query) =>
            query.where("id", "=", input.occurrenceId!),
          )
          .orderBy("id", "asc")
          .forNoKeyUpdate()
          .execute();
        const heldOccurrences = new Set(observedPending.map(({ id }) => id));
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
        let query = transaction
          .selectFrom("triggerOccurrences")
          .select(["commandId", "id"])
          .where("triggerId", "=", trigger.id)
          .where("status", "=", "pending");
        if (input.occurrenceId) query = query.where("id", "=", input.occurrenceId);
        const pending = await query.orderBy("id", "asc").execute();
        if (pending.some(({ id }) => !heldOccurrences.has(id))) {
          throw new TriggerOccurrenceSetChanged(
            "Pending occurrences changed before Trigger fencing",
          );
        }
        const now = new Date();
        const cancellation = {
          code: "canceled_by_owner",
          message: "Automation occurrence was canceled before it reached its computer",
        };
        const canceledOccurrenceIds: TriggerOccurrenceId[] = [];
        if (pending.length) {
          await transaction
            .selectFrom("commands")
            .select("id")
            .where(
              "id",
              "in",
              pending.map(({ commandId }) => commandId),
            )
            .orderBy("id", "asc")
            .forNoKeyUpdate()
            .execute();
        }
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
              status: "canceled",
              updatedAt: now,
            })
            .where("id", "=", row.id)
            .where("status", "=", "pending")
            .execute();
          canceledOccurrenceIds.push(row.id);
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
    if (!candidate) return { occurrences: [], changed: false, failures: [] };
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
      let claimed = 0;
      // Each schedule is claimed under its own savepoint: one that cannot be
      // claimed rolls back alone and is reported, instead of failing the whole
      // batch and starving every schedule behind it on every pass.
      const claim = async (
        trigger: (typeof due)[number],
      ): Promise<TriggerOccurrence | typeof held | undefined> => {
        if (!trigger.nextFireAt) return undefined;
        let occurrence: TriggerOccurrence | undefined;
        await seam?.afterDueRead?.();
        // Held or lost, read as one fact in one statement: a chat that started waiting since the
        // due read is held (nothing created, nothing moved); only an end pauses the automation.
        const standing = await triggerLaunchStanding(transaction, trigger);
        await seam?.afterAuthority?.();
        if (standing.kind === "waiting") return held;
        if (standing.kind === "refused") {
          await transaction
            .updateTable("triggers")
            .set({
              nextFireAt: null,
              pauseReason: noAutomationPauseReason,
              status: "paused",
              updatedAt: new Date(),
            })
            .where("id", "=", trigger.id)
            .execute();
          return undefined;
        }
        if (standing.kind === "lost") {
          // Authority can be unavailable transiently — an offline Runner. Pausing keeps the Trigger recoverable by
          // its owner; archiving would be a permanent answer to a temporary
          // condition.
          await transaction
            .updateTable("triggers")
            .set({
              nextFireAt: null,
              pauseReason: triggerAuthorityLossPauseReason,
              status: "paused",
              updatedAt: new Date(),
            })
            .where("id", "=", trigger.id)
            .execute();
          return undefined;
        }
        const revision = await transaction
          .selectFrom("triggerRevisions")
          .selectAll()
          .where("id", "=", trigger.currentRevisionId)
          .executeTakeFirstOrThrow();
        const source = TriggerSourceSchema.parse(revision.source);
        if (source.kind !== "schedule") throw new Error("Schedule Trigger revision is invalid");
        const scheduledFor = trigger.nextFireAt;
        // Cron ticks are fungible: a tick still waiting for a Runner already
        // says everything a newer tick would. Collapsing them keeps a backlog
        // from forming while the clock keeps advancing. Running Occurrences do
        // not suppress a tick — overlap up to Runner capacity is intended.
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
        await transaction
          .updateTable("triggers")
          .set({
            nextFireAt: next,
            updatedAt: new Date(),
          })
          .where("id", "=", trigger.id)
          .execute();
        return occurrence;
      };
      for (const trigger of due) {
        await sql`savepoint claim_schedule`.execute(transaction);
        try {
          const occurrence = await claim(trigger);
          if (occurrence === held) {
            // Held changes nothing: the savepoint holds nothing to keep.
            await sql`rollback to savepoint claim_schedule`.execute(transaction);
            continue;
          }
          await sql`release savepoint claim_schedule`.execute(transaction);
          if (occurrence) occurrences.push(occurrence);
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
      };
    });
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
      occurrence: occurrenceFromRow(occurrence),
      revision: revisionFromRow(revision),
      trigger: triggerFromRow(trigger),
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
            runnerBootId: input.runnerBootId,
            runnerId: input.runnerId,
            startedAt: new Date(),
            status: "running",
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
    return commitPersonalMutation(this.#database, async (transaction) => {
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
      if (occurrence.status !== "running" && !occurrence.connectionId)
        return occurrenceFromRow(occurrence);
      if (occurrence.terminalEvidenceAt && occurrence.status !== "running")
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
          ...(occurrence.connectionId && !occurrence.terminalEvidenceAt
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
          result: input.output.result === null ? null : jsonValue(input.output.result),
          status: input.output.status,
          stderr: input.output.stderr,
          stdout: input.output.stdout,
          updatedAt: now,
        })
        .where("id", "=", occurrence.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (input.output.status === "succeeded") {
        const recovered =
          occurrence.revisionId === trigger.currentRevisionId && trigger.consecutiveFailures !== 0;
        const finished = await oneTimeTriggerFinished(transaction, trigger, now);
        if (recovered || finished) {
          await transaction
            .updateTable("triggers")
            .set({
              ...(recovered
                ? {
                    consecutiveFailures: 0,
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
        const consecutiveFailures = Math.min(trigger.consecutiveFailures + 1, maxPostgresInteger);
        const autoPause =
          trigger.status === "active" &&
          consecutiveFailures >= TRIGGER_AUTO_PAUSE_FAILURE_THRESHOLD;
        await transaction
          .updateTable("triggers")
          .set({
            consecutiveFailures,
            ...(autoPause
              ? {
                  nextFireAt: null,
                  pauseReason: TRIGGER_AUTO_PAUSE_REASON,
                  status: "paused" as const,
                }
              : {}),
            updatedAt: now,
          })
          .where("id", "=", trigger.id)
          .execute();
        const final = await isFinalOccurrence(transaction, occurrence);
        if (final || autoPause) {
          await recordAutomationFailure(transaction, {
            detail: input.output.error ?? "The program failed without an error message.",
            occurrenceId: occurrence.id,
            reason: final ? "final-occurrence-failed" : "paused",
            triggerId: trigger.id,
          });
        }
      }
      await transaction
        .updateTable("commands")
        .set({
          lastError: null,
          status: "succeeded",
          updatedAt: now,
        })
        .where("id", "=", occurrence.commandId)
        .where("status", "=", "dispatched")
        .execute();
      return occurrenceFromRow(updated);
    });
  }
  failActiveAfterHostRestart(): Promise<number> {
    return this.#failActive({
      code: "host_restarted",
      message: "Host restarted before the automation program finished",
    });
  }
  failActiveForRunnerDisconnect(input: {
    readonly activeOccurrenceIds: readonly TriggerOccurrenceId[];
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<number> {
    if (input.activeOccurrenceIds.length === 0) return Promise.resolve(0);
    return this.#failActive({
      activeOccurrenceIds: input.activeOccurrenceIds,
      code: "runner_disconnected",
      message: "The computer disconnected before the automation program finished",
      runnerBootId: input.runnerBootId,
      runnerId: input.runnerId,
    });
  }

  /** Permanently disables a revoked member's Triggers and fences all live work. */

  async #failActive(input: {
    readonly activeOccurrenceIds?: readonly TriggerOccurrenceId[];
    readonly code: string;
    readonly message: string;
    readonly runnerBootId?: string;
    readonly runnerId?: RunnerId;
  }): Promise<number> {
    return commitPersonalMutation(this.#database, async (transaction) => {
      let query = transaction
        .selectFrom("triggerOccurrences")
        .select(["commandId", "event", "id", "revisionId", "triggerId"])
        .where("status", "=", "running")
        .where("connectionId", "is", null);
      if (input.activeOccurrenceIds) {
        query = query.where("id", "in", input.activeOccurrenceIds);
      }
      if (input.runnerId) query = query.where("runnerId", "=", input.runnerId);
      if (input.runnerBootId) query = query.where("runnerBootId", "=", input.runnerBootId);
      const rows = await query.orderBy("id", "asc").forNoKeyUpdate().execute();
      if (rows.length === 0) return 0;
      const now = new Date();
      const ids = rows.map((row) => row.id);
      const commandIds = rows.map((row) => row.commandId);
      await transaction
        .updateTable("triggerOccurrences")
        .set({
          completedAt: now,
          error: jsonValue({
            code: input.code,
            message: input.message,
          }),
          status: "failed",
          updatedAt: now,
        })
        .where("id", "in", ids)
        .where("status", "=", "running")
        .execute();
      await transaction
        .selectFrom("commands")
        .select("id")
        .where("id", "in", commandIds)
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute();
      await transaction
        .updateTable("commands")
        .set({
          lastError: jsonValue({
            code: input.code,
            message: input.message,
          }),
          status: "failed",
          updatedAt: now,
        })
        .where("id", "in", commandIds)
        .where("status", "=", "dispatched")
        .execute();
      // A recurring Trigger runs again; a one-shot one that lost its only run
      // to a restart or a disconnect never will, so its Thread hears of it.
      for (const row of rows) {
        if (!(await isFinalOccurrence(transaction, row))) continue;
        await recordAutomationFailure(transaction, {
          detail: input.message,
          occurrenceId: row.id,
          reason: "final-occurrence-interrupted",
          triggerId: row.triggerId,
        });
      }
      return rows.length;
    });
  }
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
    .selectAll()
    .where("triggerId", "=", trigger.id)
    .where("sourceKey", "=", sourceKey)
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
      status: "pending",
      stderr: "",
      stdout: "",
      triggerId: trigger.id,
      updatedAt: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return {
    occurrence: occurrenceFromRow(row),
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
    occurrence: occurrenceFromRow(occurrence),
    revision: revisionFromRow(revision),
    trigger: triggerFromRow(trigger),
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
async function lockWatchCapacityForTrigger(
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
  await lockWatchCapacity(transaction, observed.anchorThreadId);
}
async function lockWatchCapacity(
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
  const active = await transaction
    .selectFrom("triggerWatchActivations")
    .innerJoin("triggerRevisions", "triggerRevisions.id", "triggerWatchActivations.revisionId")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("environmentId", "=", input.environmentId)
    .where("desired", "=", "active")
    .where(executableProgram)
    .executeTakeFirstOrThrow();
  if (Number(active.count) >= MAX_ACTIVE_WATCHES_PER_ENVIRONMENT) {
    throw new OpensteerError({
      code: "resource_exhausted",
      details: {
        environmentId: input.environmentId,
        limit: MAX_ACTIVE_WATCHES_PER_ENVIRONMENT,
      },
      message: `This computer already has ${MAX_ACTIVE_WATCHES_PER_ENVIRONMENT} active watches, its concurrent limit`,
    });
  }
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
 * authority and Disconnect read it) that is paused, as SQL over the unaliased `triggers` row, for
 * the schedule's claim and deadline. Its schedule does not fire until the chat is back.
 */
function triggerChatHeld(database: object) {
  return sql<boolean>`exists (
    select 1 from agent_connections
    where agent_connections.id = triggers.origin_connection_id
      and agent_connections.bridge_account_id is not null
      and ${connectionState(database)} = 'waiting')`;
}
/** The refusal of a program for a lineage without personal context. */
function noProgramWithoutPersonalContext(): OpensteerError {
  return new OpensteerError({
    code: "forbidden",
    message: "A chat that anyone in the conversation can message can't have an automation.",
  });
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

/**
 * Whether a launch refusal is the one a waiting chat causes, from the same read that refused it:
 * its work is held, never failed. A lineage without personal context is refused as itself, paused
 * or not.
 */
export function triggerChatIsWaiting(error: unknown): boolean {
  return error instanceof TriggerChatWaiting;
}

/**
 * Whether an automation may launch now: the one check every firing passes (a schedule's claim,
 * run now, a webhook, a resume or a change that queues an occurrence, its dispatch to a Runner,
 * and a watch's activation). A lineage without personal context (a chat anyone in the
 * conversation can message) never launches one: its program would run as the person, in their
 * Agent home. Its connection's senders never change, so this reads apart from the standing.
 */
async function triggerLaunchStanding(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  trigger: Pick<TriggerRow, "anchorThreadId" | "createdBy" | "originConnectionId">,
): Promise<
  | Awaited<ReturnType<typeof lineageExecutionStanding>>
  | { readonly kind: "refused"; readonly reason: string }
> {
  if (!(await lineagePersonalContext(database, trigger.originConnectionId)))
    return { kind: "refused", reason: noProgramWithoutPersonalContext().message };
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
  if (standing.kind === "refused") throw noProgramWithoutPersonalContext();
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
    consecutiveFailures: row.consecutiveFailures,
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
  return TriggerRevisionSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
  });
}
function occurrenceFromRow(row: TriggerOccurrenceRow): TriggerOccurrence {
  return TriggerOccurrenceSchema.parse({
    commandId: CommandIdSchema.parse(row.commandId),
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    environmentId: row.environmentId,
    error: row.error,
    event: row.event,
    exitCode: row.exitCode,
    id: row.id,
    result: row.result,
    revisionId: row.revisionId,
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
    await lockWatchCapacityForTrigger(transaction, triggerId);
    const trigger = await transaction
      .selectFrom("triggers")
      .selectAll()
      .where("id", "=", triggerId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (trigger?.status !== "active") return;
    await pauseTriggerInTransaction(transaction, trigger);
    await transaction
      .updateTable("triggers")
      .set({ pauseReason: "Paused because the connected agent that made it was disconnected." })
      .where("id", "=", triggerId)
      .execute();
  });
}
export async function pauseTriggerInTransaction(
  transaction: Transaction<DatabaseSchema>,
  trigger: TriggerRow,
): Promise<TriggerRow> {
  if (trigger.status !== "active") return trigger;
  const now = new Date();
  const updated = await transaction
    .updateTable("triggers")
    .set({
      status: "paused",
      pauseReason: null,
      nextFireAt: trigger.kind === "schedule" ? null : trigger.nextFireAt,
      updatedAt: now,
    })
    .where("id", "=", trigger.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  if (trigger.kind === "watch") await stopActiveWatchActivation(transaction, trigger.id, now);
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

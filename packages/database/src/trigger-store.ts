import { personalExecutionLocation, requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { TransactionScopeChanged } from "./connection.js";
import { jsonValue } from "./store-primitives.js";
import { createHash } from "node:crypto";
import {
  threadAccessModeAtMost,
  type ThreadAccessMode,
  CommandIdSchema,
  IsoDateTimeSchema,
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
import { PrincipalIdSchema } from "@opensteer/channel-core";
import type {
  DatabaseSchema,
  TriggerOccurrenceTable,
  TriggerWatchActivationTable,
} from "./schema.js";
import { admitThreadExecution } from "./execution-authority.js";
import { isFinalScheduledOccurrence, recordAutomationFailure } from "./automation-failure-store.js";
import { runFromRow } from "./thread-row-mappers.js";
import { getThreadForOwner } from "./thread-store.js";
import type { Thread } from "@opensteer/core";
type TriggerRow = Selectable<DatabaseSchema["triggers"]>;
type TriggerRevisionRow = Selectable<DatabaseSchema["triggerRevisions"]>;
type TriggerOccurrenceRow = Selectable<TriggerOccurrenceTable>;
type TriggerWatchActivationRow = Selectable<TriggerWatchActivationTable>;
const maxPostgresInteger = 2_147_483_647;
const triggerAuthorityLossPauseReason =
  "Paused because its conversation could not run when it was due.";
interface CreateTriggerInput {
  readonly actorThreadId: ThreadId | null;
  readonly actorAccessMode?: ThreadAccessMode;
  readonly anchorThreadId: ThreadId;
  readonly createdBy: UserId;
  readonly idempotencyKey: string;
  readonly name: string;
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
  readonly location: import("@opensteer/protocol").PersonalExecutionLocation;
}

export interface WatchActivationContext {
  readonly activation: TriggerWatchActivation;
  readonly toolContractVersion: 1 | 2 | 3;
  readonly location: import("@opensteer/protocol").PersonalExecutionLocation;
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
    .select(["triggers.anchorThreadId", "triggers.createdBy"])
    .where("triggerOccurrences.id", "=", input.occurrenceId)
    .where("triggerOccurrences.environmentId", "=", input.environmentId)
    .where("triggerOccurrences.executionGeneration", "=", input.executionGeneration)
    .where("triggerOccurrences.runnerId", "=", input.runnerId)
    .where("triggerOccurrences.runnerBootId", "=", input.runnerBootId)
    .where("triggerOccurrences.status", "=", "running")
    .where("triggers.anchorThreadId", "=", input.threadId)
    .where("triggers.createdBy", "=", input.requestedBy)
    .executeTakeFirst();
  if (!row || !(await triggerExecutionAuthorityAvailable(database, row))) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Trigger execution is no longer active",
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
    .select([
      "triggerWatchActivations.anchorThreadId",
      "triggerWatchActivations.createdBy",
      "triggerWatchActivations.environmentId",
    ])
    .where("triggerWatchActivations.id", "=", input.activationId)
    .where("triggerWatchActivations.triggerId", "=", input.triggerId)
    .where("triggerWatchActivations.revisionId", "=", input.revisionId)
    .where("triggerWatchActivations.executionGeneration", "=", String(input.executionGeneration))
    .where("triggerWatchActivations.desired", "=", "active")
    .where("triggers.currentRevisionId", "=", input.revisionId)
    .where("triggers.status", "=", "active")
    .where("triggers.kind", "=", "watch")
    .executeTakeFirst();
  const admission = row
    ? await admitThreadExecution(database, row.anchorThreadId, row.createdBy)
    : null;
  if (
    !row ||
    row.anchorThreadId !== input.anchorThreadId ||
    row.createdBy !== input.createdBy ||
    row.environmentId !== input.environmentId ||
    !admission ||
    admission.environmentId !== input.environmentId
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
  const program = TriggerProgramSchema.parse(input.program);
  validateSource(source);
  const requestFingerprint = fingerprint({
    anchorThreadId: input.anchorThreadId,
    name: input.name,
    program,
    source,
  });
  await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["trigger-create", input.createdBy, input.idempotencyKey])}, 0))`.execute(
    transaction,
  );
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
    if (trigger.requestFingerprint !== requestFingerprint) throw idempotencyConflict();
    await requireTriggerExecutionAuthority(transaction, trigger);
    const revision = await transaction
      .selectFrom("triggerRevisions")
      .selectAll()
      .where("id", "=", trigger.currentRevisionId)
      .executeTakeFirstOrThrow();
    return {
      revision: revisionFromRow(revision),
      trigger: triggerFromRow(trigger),
      wasDuplicate: true,
    };
  }
  if (source.kind === "watch") {
    const anchor = await transaction
      .selectFrom("threads")
      .where("id", "=", input.anchorThreadId)
      .executeTakeFirst();
    if (!anchor) throw notFound();
    await lockWatchCapacity(transaction, input.anchorThreadId);
  }
  const authority = await lockTriggerAuthorityThreads(
    transaction,
    input.actorThreadId,
    input.anchorThreadId,
    input.actorAccessMode,
  );
  assertTriggerAccess(authority, "define");
  const anchor = await requireAnchorThread(
    transaction,
    input.anchorThreadId,
    input.createdBy,
    managed !== undefined,
  );
  const triggerId = createId("trigger");
  const revisionId = createId("triggerRevision");
  const now = new Date();
  const nextFireAt =
    !managed?.paused && source.kind === "schedule" ? firstTriggerFireAt(source.schedule) : null;
  await transaction
    .insertInto("triggers")
    .values({
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
export class TriggerStore {
  readonly #database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.#database = database;
  }
  async create(input: CreateTriggerInput) {
    return withPersonalTransaction(this.#database, (transaction) =>
      createTriggerInTransaction(transaction, input),
    );
  }
  async update(input: {
    readonly actorThreadId: ThreadId | null;
    readonly actorAccessMode?: ThreadAccessMode;
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
    if (input.name === undefined && input.program === undefined && input.source === undefined) {
      throw new OpensteerError({
        code: "bad_request",
        message: "Trigger update requires at least one of name, program, or source",
      });
    }
    return withPersonalTransaction(this.#database, async (transaction) => {
      await lockWatchCapacityForTrigger(transaction, input.triggerId);
      const trigger = await lockTriggerForMutation(transaction, input, "define");
      await requireTriggerExecutionAuthority(transaction, trigger);
      if (
        trigger.systemRole &&
        (input.name !== undefined ||
          input.program !== undefined ||
          (input.source !== undefined &&
            (input.source.kind !== "schedule" ||
              input.source.schedule.kind !== "cron" ||
              input.source.schedule.payload !== undefined)))
      ) {
        throw conflict(MANAGED_MEMORY_REFUSAL);
      }
      if (trigger.status === "archived") throw conflict("Archived Triggers cannot be changed");
      if (trigger.currentRevisionId !== input.expectedRevisionId) {
        throw conflict("Trigger revision changed; read it again before updating");
      }
      const current = await transaction
        .selectFrom("triggerRevisions")
        .selectAll()
        .where("id", "=", trigger.currentRevisionId)
        .executeTakeFirstOrThrow();
      const source = TriggerSourceSchema.parse(input.source ?? current.source);
      if (source.kind !== trigger.kind) {
        throw new OpensteerError({
          code: "bad_request",
          message: "A Trigger cannot change between schedule, webhook, and watch ingress",
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
      // Only a new source re-arms the clock, and it re-arms it the way a resume
      // does: an elapsed one-shot stays elapsed. Editing a program or a name
      // must never resurrect an instant that has already passed.
      const rearmed =
        input.source === undefined
          ? {}
          : {
              nextFireAt:
                trigger.status === "active" && source.kind === "schedule"
                  ? resumedScheduleFireAt(source.schedule, now)
                  : null,
            };
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
    readonly ownerId: UserId;
    readonly status: "active" | "paused" | "archived";
    readonly triggerId: TriggerId;
  }): Promise<Trigger> {
    return withPersonalTransaction(this.#database, async (transaction) => {
      await lockWatchCapacityForTrigger(transaction, input.triggerId);
      const trigger = await lockTriggerForMutation(
        transaction,
        input,
        input.status === "archived" ? "define" : "control",
      );
      await requireTriggerExecutionAuthority(transaction, trigger);
      if (trigger.systemRole && input.status === "archived") throw conflict(MANAGED_MEMORY_REFUSAL);
      // Repeating the current status is a no-op: an auto-paused Trigger keeps
      // its reason and an active one keeps its failure count.
      if (trigger.status === input.status) return triggerFromRow(trigger);
      if (trigger.status === "archived") {
        throw conflict("Archived Triggers cannot be reactivated");
      }
      if (input.status === "paused") {
        return triggerFromRow(await pauseTriggerInTransaction(transaction, trigger));
      }
      let nextFireAt = trigger.nextFireAt;
      if (trigger.kind === "schedule") {
        if (input.status !== "active") {
          nextFireAt = null;
        } else if (trigger.status !== "active") {
          const revision = await transaction
            .selectFrom("triggerRevisions")
            .select("source")
            .where("id", "=", trigger.currentRevisionId)
            .executeTakeFirstOrThrow();
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
    return withPersonalTransaction(this.#database, async (transaction) => {
      const trigger = await lockTriggerForMutation(transaction, input, "control");
      await requireTriggerExecutionAuthority(transaction, trigger);
      if (nextFireAt.getTime() <= Date.now()) {
        throw new OpensteerError({
          code: "bad_request",
          message: "Next fire time must be in the future",
        });
      }
      if (trigger.status !== "active" || trigger.kind !== "schedule") {
        throw conflict("Only active cron schedule Triggers can reschedule their next run");
      }
      const revision = await transaction
        .selectFrom("triggerRevisions")
        .select("source")
        .where("id", "=", trigger.currentRevisionId)
        .executeTakeFirstOrThrow();
      const source = TriggerSourceSchema.parse(revision.source);
      if (source.kind !== "schedule" || source.schedule.kind !== "cron") {
        throw conflict("Only active cron schedule Triggers can reschedule their next run");
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
      return triggerFromRow(updated);
    });
  }
  async listForOwner(input: {
    readonly anchorThreadId?: ThreadId;
    readonly limit?: number;
    readonly ownerId: UserId;
    readonly systemRole?: TriggerSystemRole;
  }): Promise<readonly TriggerSummary[]> {
    await requirePersonalOwner(this.#database, input.ownerId);
    let query = this.#database
      .selectFrom("triggers")
      .innerJoin("threads", "threads.id", "triggers.anchorThreadId")
      .selectAll("triggers")
      .select("threads.title as anchorThreadTitle")
      .where("triggers.createdBy", "=", input.ownerId)
      .where("triggers.status", "!=", "archived");
    if (input.systemRole) query = query.where("triggers.systemRole", "=", input.systemRole);
    if (input.anchorThreadId)
      query = query.where("triggers.anchorThreadId", "=", input.anchorThreadId);
    const rows = await query
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
        .select(["id", "source"])
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
    const sources = new Map(revisions.map((revision) => [revision.id, revision.source]));
    const latest = new Map(occurrences.map((occurrence) => [occurrence.triggerId, occurrence]));
    const watches = new Map(activations.map((activation) => [activation.triggerId, activation]));
    return rows.map((row) => {
      const occurrence = latest.get(row.id);
      const watch = row.kind === "watch" ? watches.get(row.id) : undefined;
      const { anchorThreadTitle, ...trigger } = row;
      return TriggerSummarySchema.parse({
        ...triggerFromRow(trigger),
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
        source: withoutSchedulePayload(
          TriggerSourceSchema.parse(sources.get(row.currentRevisionId)),
        ),
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
    readonly leaseExpiresAt: Date;
    readonly runnerBootId: string;
    readonly runnerConnectionGeneration: number;
    readonly runnerId: RunnerId;
  }): Promise<{
    readonly activations: readonly WatchActivationContext[];
    readonly reconcileGeneration: number;
  }> {
    return withPersonalTransaction(this.#database, async (transaction) => {
      const rows = await transaction
        .selectFrom("triggerWatchActivations")
        .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
        .selectAll("triggerWatchActivations")
        .where("triggerWatchActivations.environmentId", "=", input.environmentId)
        .where("triggerWatchActivations.desired", "=", "active")
        .where("triggers.kind", "=", "watch")
        .orderBy("triggerWatchActivations.id", "asc")
        .forNoKeyUpdate("triggerWatchActivations")
        .execute();
      const activations: WatchActivationContext[] = [];
      for (const row of rows) {
        const trigger = await transaction
          .selectFrom("triggers")
          .selectAll()
          .where("id", "=", row.triggerId)
          .executeTakeFirstOrThrow();
        const admission = await admitThreadExecution(
          transaction,
          row.anchorThreadId,
          row.createdBy,
        );
        if (
          trigger.status !== "active" ||
          trigger.currentRevisionId !== row.revisionId ||
          !admission ||
          admission.environmentId !== row.environmentId
        ) {
          await transaction
            .updateTable("triggerWatchActivations")
            .set({
              desired: "stopped",
              leaseExpiresAt: null,
              observed: "stopped",
              updatedAt: new Date(),
            })
            .where("id", "=", row.id)
            .execute();
          continue;
        }
        const nextExecutionGeneration =
          row.runnerBootId === input.runnerBootId
            ? Number(row.executionGeneration)
            : Number(row.executionGeneration) + 1;
        if (!Number.isSafeInteger(nextExecutionGeneration)) {
          throw new OpensteerError({
            code: "internal",
            message: "Watch execution generation overflow",
          });
        }
        const updated = await transaction
          .updateTable("triggerWatchActivations")
          .set({
            executionGeneration: nextExecutionGeneration,
            leaseExpiresAt: input.leaseExpiresAt,
            ...(row.runnerBootId === input.runnerBootId
              ? {}
              : {
                  healthySince: null,
                  observed: "starting" as const,
                  restartCount: 0,
                }),
            runnerBootId: input.runnerBootId,
            runnerConnectionGeneration: input.runnerConnectionGeneration,
            runnerId: input.runnerId,
            updatedAt: new Date(),
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        const revision = await transaction
          .selectFrom("triggerRevisions")
          .select("program")
          .where("id", "=", row.revisionId)
          .executeTakeFirstOrThrow();
        activations.push({
          activation: watchActivationFromRow(updated),
          toolContractVersion: TriggerProgramSchema.parse(revision.program).toolContractVersion,
          location: await personalExecutionLocation(transaction, row.anchorThreadId),
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
      };
    });
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
    return withPersonalTransaction(this.#database, async (transaction) => {
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
      if (
        activation.runnerId !== input.runnerId ||
        activation.runnerBootId !== input.runnerBootId ||
        Number(activation.runnerConnectionGeneration) !== input.runnerConnectionGeneration ||
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
          observed: autoPaused || activation.desired === "stopped" ? "stopped" : input.observed,
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
  async recordWatchUnavailable(input: {
    readonly activationId: TriggerWatchActivationId;
    readonly executionGeneration: number;
    readonly reason: string;
    readonly runnerBootId: string;
    readonly runnerConnectionGeneration: number;
    readonly runnerId: RunnerId;
  }): Promise<TriggerWatchActivation> {
    const updated = await this.#database
      .updateTable("triggerWatchActivations")
      .set({
        healthySince: null,
        lastError: input.reason.slice(0, 20_000),
        lastExitCode: null,
        leaseExpiresAt: null,
        observed: "backoff",
        updatedAt: new Date(),
      })
      .where("id", "=", input.activationId)
      .where("desired", "=", "active")
      .where("executionGeneration", "=", String(input.executionGeneration))
      .where("runnerId", "=", input.runnerId)
      .where("runnerBootId", "=", input.runnerBootId)
      .where("runnerConnectionGeneration", "=", String(input.runnerConnectionGeneration))
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Watch unavailability binding is stale",
      });
    }
    return watchActivationFromRow(updated);
  }
  async getForOwner(
    triggerId: TriggerId,
    ownerId: UserId,
    occurrenceLimit: number,
  ): Promise<TriggerDetail | null> {
    await requirePersonalOwner(this.#database, ownerId);
    let query = this.#database
      .selectFrom("triggers")
      .innerJoin("threads", "threads.id", "triggers.anchorThreadId")
      .selectAll("triggers")
      // The author is named only when the reader could reach that Thread itself.
      .leftJoin("threads as authorThread", (join) =>
        join.onRef("authorThread.id", "=", "triggers.createdByThreadId"),
      )
      .select(["threads.title as anchorThreadTitle", "authorThread.title as createdByThreadTitle"])
      .where("triggers.id", "=", triggerId)
      .where("triggers.createdBy", "=", ownerId);
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
    return {
      activation: activation ? watchActivationFromRow(activation) : null,
      anchorThread: await getThreadForOwner(this.#database, trigger.anchorThreadId, ownerId),
      anchorThreadTitle,
      createdByThreadTitle,
      downstreamRuns: downstreamRunRows.slice(0, 100).map((row) => ({
        occurrenceId: row.occurrenceId,
        run: runFromRow(row),
        threadTitle: row.threadTitle,
      })),
      downstreamRunsTruncated: downstreamRunRows.length > 100,
      occurrences: occurrences.map(occurrenceFromRow),
      revision: revisionFromRow(revision),
      trigger: triggerFromRow(trigger),
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
    return withPersonalTransaction(this.#database, async (transaction) => {
      const trigger = await transaction
        .selectFrom("triggers")
        .selectAll()
        .where("webhookRouteKey", "=", input.routeKey)
        .where("kind", "=", "webhook")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!trigger) throw notFound();
      if (trigger.status !== "active") throw conflict("Webhook Trigger is not active");
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
    readonly ownerId: UserId;
    readonly idempotencyKey?: string;
    readonly payload?: unknown;
    readonly triggerId: TriggerId;
  }): Promise<TriggerOccurrence> {
    return withPersonalTransaction(this.#database, async (transaction) => {
      const trigger = await lockTriggerForMutation(transaction, input, "define");
      if (trigger.status === "archived") throw conflict("Archived Trigger cannot run");
      if (trigger.kind === "watch") {
        throw conflict("Watch Triggers run continuously and cannot create occurrences");
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
      readonly occurrenceId?: TriggerOccurrenceId;
      readonly triggerId: TriggerId;
    },
  ): Promise<{
    readonly canceledOccurrenceIds: readonly TriggerOccurrenceId[];
  }> {
    return withPersonalTransaction(
      this.#database,
      async (transaction) => {
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
          if (!target) throw notFound("Trigger occurrence not found");
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
          message: "Trigger occurrence was canceled before it reached a Runner",
        };
        const canceledOccurrenceIds: TriggerOccurrenceId[] = [];
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
      undefined,
      (error) => error instanceof TriggerOccurrenceSetChanged,
    );
  }

  /**
   * Fires every due schedule. Each due Trigger changes whether or not it gets
   * an Occurrence — it is paused, or its next instant moves on — so the
   * The caller refreshes the Deployment's Trigger list after commit.
   */
  async claimDueSchedules(
    now = new Date(),
    limit = 64,
  ): Promise<{
    readonly occurrences: readonly TriggerOccurrence[];
    readonly changed: boolean;
  }> {
    const candidate = await this.#database
      .selectFrom("triggers")
      .select("id")
      .where("kind", "=", "schedule")
      .where("status", "=", "active")
      .where("nextFireAt", "<=", now)
      .limit(1)
      .executeTakeFirst();
    if (!candidate) return { occurrences: [], changed: false };
    return withPersonalTransaction(this.#database, async (transaction) => {
      const due = await transaction
        .selectFrom("triggers")
        .selectAll()
        .where("kind", "=", "schedule")
        .where("status", "=", "active")
        .where("nextFireAt", "<=", now)
        .orderBy("nextFireAt", "asc")
        .orderBy("id", "asc")
        .limit(Math.min(Math.max(limit, 1), 256))
        .forNoKeyUpdate()
        .skipLocked()
        .execute();
      const occurrences: TriggerOccurrence[] = [];
      for (const trigger of due) {
        if (!trigger.nextFireAt) continue;
        if (!(await triggerExecutionAuthorityAvailable(transaction, trigger))) {
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
          continue;
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
          occurrences.push(enqueued.occurrence);
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
      }
      return {
        occurrences,
        changed: due.length > 0,
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
    await requireTriggerExecutionAuthority(this.#database, trigger);
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
      location: await personalExecutionLocation(this.#database, trigger.anchorThreadId),
    };
  }
  async startExecution(input: {
    readonly commandId: CommandId;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<{
    readonly context: TriggerDispatchContext;
    readonly executionGeneration: number;
  }> {
    return withPersonalTransaction(this.#database, async (transaction) => {
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
      await requireTriggerExecutionAuthority(transaction, trigger);
      let executionGeneration = occurrence.executionGeneration;
      if (occurrence.status === "pending") {
        executionGeneration += 1;
        await transaction
          .updateTable("triggerOccurrences")
          .set({
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
      };
    });
  }
  async assertActiveExecutionBinding(input: ActiveTriggerExecutionBindingInput): Promise<void> {
    await assertActiveTriggerExecutionBinding(this.#database, input);
  }
  async completeExecution(input: {
    readonly executionGeneration: number;
    readonly output: TriggerExecutionOutput;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  }): Promise<TriggerOccurrence> {
    return withPersonalTransaction(this.#database, async (transaction) => {
      const occurrence = await transaction
        .selectFrom("triggerOccurrences")
        .selectAll()
        .where("id", "=", input.output.occurrenceId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!occurrence) throw notFound("Trigger occurrence not found");
      const trigger = await transaction
        .selectFrom("triggers")
        .selectAll()
        .where("id", "=", occurrence.triggerId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      if (occurrence.status !== "running") return occurrenceFromRow(occurrence);
      await requireTriggerExecutionAuthority(transaction, trigger);
      if (
        occurrence.executionGeneration !== input.executionGeneration ||
        occurrence.runnerId !== input.runnerId ||
        occurrence.runnerBootId !== input.runnerBootId
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Trigger result binding is stale",
        });
      }
      const now = new Date();
      const updated = await transaction
        .updateTable("triggerOccurrences")
        .set({
          completedAt: new Date(input.output.completedAt),
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
      message: "Host restarted before the Trigger program finished",
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
      message: "Runner disconnected before the Trigger program finished",
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
    return withPersonalTransaction(this.#database, async (transaction) => {
      let query = transaction
        .selectFrom("triggerOccurrences")
        .select(["commandId", "event", "id", "revisionId", "triggerId"])
        .where("status", "=", "running");
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
  await requireTriggerExecutionAuthority(transaction, trigger);
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
      message: `Trigger already has ${MAX_PENDING_TRIGGER_OCCURRENCES} pending Occurrences, its durable limit`,
    });
  }
  const admission = await requireTriggerExecutionAuthority(transaction, trigger);
  const revision = await transaction
    .selectFrom("triggerRevisions")
    .select("id")
    .where("id", "=", trigger.currentRevisionId)
    .executeTakeFirstOrThrow();
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
  await requireTriggerExecutionAuthority(transaction, trigger);
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
    location: await personalExecutionLocation(transaction, trigger.anchorThreadId),
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
}> {
  const anchor = await transaction
    .selectFrom("threads")
    .select(["purpose", "doneAt", "status"])
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
      message: "Choose an open task as the Trigger anchor.",
    });
  const admission = await admitThreadExecution(transaction, threadId, userId);
  if (!admission)
    throw new OpensteerError({
      code: "forbidden",
      message: "Anchor Thread is unavailable",
    });
  return {
    environmentId: admission.environmentId,
    id: threadId,
  };
}
type LockedTriggerAuthority = {
  readonly actor: AuthorityThread;
  readonly anchor: AuthorityThread;
} | null;
async function lockTriggerAuthorityThreads(
  transaction: Transaction<DatabaseSchema>,
  actorThreadId: ThreadId | null,
  anchorThreadId: ThreadId,
  ceiling?: ThreadAccessMode,
): Promise<LockedTriggerAuthority> {
  if (actorThreadId === null && ceiling === undefined) return null;
  const rows = await transaction
    .selectFrom("threads")
    .select(["id", "accessMode"])
    .where("id", "in", actorThreadId ? [actorThreadId, anchorThreadId] : [anchorThreadId])
    .orderBy("id")
    .forShare()
    .execute();
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
    readonly ownerId: UserId;
    readonly triggerId: TriggerId;
  },
  requiredAccess: "control" | "define",
): Promise<TriggerRow> {
  const observed = await transaction
    .selectFrom("triggers")
    .select("anchorThreadId")
    .where("id", "=", input.triggerId)
    .where("createdBy", "=", input.ownerId)
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
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("environmentId", "=", input.environmentId)
    .where("desired", "=", "active")
    .executeTakeFirstOrThrow();
  if (Number(active.count) >= MAX_ACTIVE_WATCHES_PER_ENVIRONMENT) {
    throw new OpensteerError({
      code: "resource_exhausted",
      details: {
        environmentId: input.environmentId,
        limit: MAX_ACTIVE_WATCHES_PER_ENVIRONMENT,
      },
      message: `Execution environment already has ${MAX_ACTIVE_WATCHES_PER_ENVIRONMENT} active watches, its concurrent limit`,
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
      observed: "stopped",
      updatedAt: now,
    })
    .where("triggerId", "=", triggerId)
    .where("desired", "=", "active")
    .execute();
}
async function triggerExecutionAuthorityAvailable(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  trigger: Pick<TriggerRow, "anchorThreadId" | "createdBy">,
): Promise<boolean> {
  const admission = await admitThreadExecution(database, trigger.anchorThreadId, trigger.createdBy);
  return admission !== null;
}
async function requireTriggerExecutionAuthority(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  trigger: Pick<TriggerRow, "anchorThreadId" | "createdBy">,
) {
  const admission = await admitThreadExecution(database, trigger.anchorThreadId, trigger.createdBy);
  if (!admission) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Trigger execution authority is no longer active",
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
function triggerFromRow(row: TriggerRow): Trigger {
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
    nextFireAt: row.nextFireAt?.toISOString() ?? null,
    pauseReason: row.pauseReason,
    waitingReason: row.waitingReason,
    status: row.status,
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
  return TriggerWatchActivationSchema.parse({
    ...row,
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
  return conflict("Idempotency key was already used with different Trigger input");
}

/** The Trigger and watch activation rows are reserved before Request settlement. */
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

import {
  createId,
  ModelSelectionSchema,
  OpensteerError,
  type AgentEvent,
  type HarnessInstanceId,
  type ModelSelection,
  type Thread,
  type ThreadId,
  type TriggerId,
  type TriggerOccurrenceId,
  type WorkspaceId,
  type UserId,
} from "@opensteer/core";
import {
  MANAGED_MEMORY_WAKE_SKIPPED,
  type TriggerProgram,
  type TriggerSource,
  type TriggerSystemRole,
} from "@opensteer/triggers";
import { sql, type Kysely, type Transaction } from "kysely";
import { withDatabaseTransaction } from "./connection.js";
import type { DatabaseSchema, ThreadRow } from "./schema.js";
import { jsonValue, lockCommandIdempotency } from "./store-primitives.js";
import { threadFromRow } from "./thread-row-mappers.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import { prepareThreadInsertion } from "./thread-insertion.js";
import { createThreadInTransaction } from "./thread-store.js";
import { createTriggerInTransaction } from "./trigger-store.js";

/** The role row is the receipt, including paused schedules and Done workers. */
export function missingMemoryPassMains(
  database: Kysely<DatabaseSchema>,
  after?: WorkspaceId,
  limit = 20,
) {
  let query = database
    .selectFrom("workspaces")
    .innerJoin("users", "users.id", "workspaces.createdBy")
    .innerJoin("workspaceMemberships as owner", (join) =>
      join
        .onRef("owner.workspaceId", "=", "workspaces.id")
        .onRef("owner.userId", "=", "workspaces.createdBy")
        .on("owner.state", "=", "active")
        .on("owner.role", "=", "owner"),
    )
    .select("workspaces.id")
    .where("workspaces.kind", "=", "main")
    .where("workspaces.status", "=", "ready")
    .where("workspaces.homeThreadId", "is not", null)
    .where("users.disabledAt", "is", null)
    .where("users.timeZone", "is not", null)
    .where(({ or, not, exists, selectFrom }) =>
      or(
        (["memory-light", "memory-nightly"] as const).map((role) =>
          not(
            exists(
              selectFrom("triggers")
                .select("id")
                .whereRef("workspaceId", "=", "workspaces.id")
                .where("systemRole", "=", role),
            ),
          ),
        ),
      ),
    );
  if (after) query = query.where("workspaces.id", ">", after);
  return query.orderBy("workspaces.id").limit(limit).execute();
}

export async function createMemoryPass(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly workspaceId: WorkspaceId;
    readonly ownerId: UserId;
    readonly chat: Thread;
    readonly systemRole: TriggerSystemRole;
    readonly program: TriggerProgram;
    readonly source: TriggerSource;
    readonly pauseReason: string | null;
  },
) {
  const key = `memory:${input.workspaceId}:${input.systemRole}`;
  return withDatabaseTransaction(database, async (transaction) => {
    // Creation reservations precede every materialized parent in lock-order.ts.
    await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["trigger-create", input.ownerId, key])}, 0))`.execute(
      transaction,
    );
    await lockCommandIdempotency(transaction, input.ownerId, key);
    const workspace = await transaction
      .selectFrom("workspaces")
      .selectAll()
      .where("id", "=", input.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const existing = await transaction
      .selectFrom("triggers")
      .select("id")
      .where("workspaceId", "=", workspace.id)
      .where("systemRole", "=", input.systemRole)
      .executeTakeFirst();
    if (existing) return null;
    const owner = await transaction
      .selectFrom("workspaceMemberships")
      .select(["role", "state"])
      .where("workspaceId", "=", workspace.id)
      .where("userId", "=", input.ownerId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const user = await transaction
      .selectFrom("users")
      .select("disabledAt")
      .where("id", "=", input.ownerId)
      .executeTakeFirst();
    if (
      workspace.kind !== "main" ||
      workspace.createdBy !== input.ownerId ||
      workspace.status !== "ready" ||
      workspace.homeThreadId !== input.chat.id ||
      owner?.state !== "active" ||
      owner.role !== "owner" ||
      !user ||
      user.disabledAt
    )
      throw snapshotChanged();
    const insertThread = await prepareThreadInsertion(transaction, {
      createdBy: input.ownerId,
      environmentId: input.chat.environmentId,
      harnessInstanceId: input.chat.harnessInstanceId,
    });
    const chat = await transaction
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", input.chat.id)
      .forShare()
      .executeTakeFirstOrThrow();
    if (
      chat.workspaceId !== workspace.id ||
      chat.role !== "conversation" ||
      !chat.inheritsMain ||
      chat.lineageRootThreadId !== input.chat.lineageRootThreadId ||
      chat.environmentId !== input.chat.environmentId ||
      chat.harnessInstanceId !== input.chat.harnessInstanceId
    )
      throw snapshotChanged();
    // Chat's engine is only where the worker starts: every pass picks its own
    // model when admitted (startMemoryPassInTransaction).
    const created = await createThreadInTransaction(
      transaction,
      {
        createdBy: input.ownerId,
        environmentId: chat.environmentId,
        harnessInstanceId: chat.harnessInstanceId,
        accessMode: chat.accessMode,
        idempotencyKey: key,
        modelSelection: chat.modelSelection,
        parentThreadId: chat.id,
        role: "work",
        title: input.systemRole === "memory-light" ? "Memory light pass" : "Memory nightly pass",
        workspaceId: workspace.id,
      },
      { insertThread, unlisted: true },
    );
    const trigger = await createTriggerInTransaction(
      transaction,
      {
        actorThreadId: null,
        anchorThreadId: created.thread.id,
        createdBy: input.ownerId,
        idempotencyKey: key,
        name: created.thread.title,
        program: input.program,
        source: input.source,
      },
      {
        systemRole: input.systemRole,
        paused: input.pauseReason !== null,
        pauseReason: input.pauseReason,
      },
    );
    return { ...trigger, event: created.event };
  });
}

export interface MemoryPassExecution {
  readonly harnessInstanceId: HarnessInstanceId;
  readonly harnessRevision: number;
  readonly modelSelection: ModelSelection;
}

/**
 * Puts an admitted pass on the model the Host resolved for it, in a fresh
 * native session. Passes are stateless over Main's memory files, so nothing
 * carries from one pass to the next; the Run then freezes this choice for the
 * pass and its recovery. The caller holds the worker's Thread lock.
 */
export async function startMemoryPassInTransaction(
  transaction: Transaction<DatabaseSchema>,
  worker: ThreadRow,
  execution: MemoryPassExecution,
): Promise<{ readonly worker: ThreadRow; readonly event: AgentEvent }> {
  // The input's preconditions already hold this row: harness_instances precede threads.
  const harness = await transaction
    .selectFrom("harnessInstances")
    .select(["enabled", "environmentId", "removedAt", "runtimeRevision"])
    .where("id", "=", execution.harnessInstanceId)
    .executeTakeFirst();
  if (
    !harness?.enabled ||
    harness.removedAt ||
    harness.environmentId !== worker.environmentId ||
    harness.runtimeRevision !== execution.harnessRevision
  )
    throw new OpensteerError({ code: "conflict", message: MANAGED_MEMORY_WAKE_SKIPPED });
  await transaction
    .updateTable("triggers")
    .set({ waitingReason: null, updatedAt: new Date() })
    .where("anchorThreadId", "=", worker.id)
    .where("systemRole", "is not", null)
    .where("waitingReason", "is not", null)
    .execute();
  await transaction
    .updateTable("providerSessions")
    .set({ active: false, updatedAt: new Date() })
    .where("threadId", "=", worker.id)
    .where("active", "=", true)
    .execute();
  const providerSessionId = createId("providerSession");
  await transaction
    .insertInto("providerSessions")
    .values({
      active: true,
      bindingGeneration: 0,
      continuationIdentity: null,
      harnessInstanceId: execution.harnessInstanceId,
      id: providerSessionId,
      leaseExpiresAt: null,
      leaseTokenHash: null,
      providerSessionReference: null,
      runnerBootId: null,
      runnerId: null,
      status: "starting",
      stateLayout: "session",
      threadId: worker.id,
    })
    .executeTakeFirstOrThrow();
  const updated = await transaction
    .updateTable("threads")
    .set({
      harnessInstanceId: execution.harnessInstanceId,
      modelSelection: jsonValue(ModelSelectionSchema.parse(execution.modelSelection)),
      updatedAt: new Date(),
    })
    .where("id", "=", worker.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  const event = await appendHostWorkspaceEvent(transaction, {
    data: {
      thread: threadFromRow({
        ...updated,
        continuationIdentity: null,
        pendingRequests: updated.pendingRequestCount,
        providerSessionId,
      }),
    },
    environmentId: updated.environmentId,
    runId: null,
    threadId: updated.id,
    type: "thread.execution-updated",
    workspaceId: updated.workspaceId,
  });
  return { worker: updated, event };
}

/**
 * Waiting is not a pause: the schedule keeps waking and each wake resolves again.
 * Admission holds this occurrence's row until its receipt commits, so a pass that
 * was accepted, or is being accepted, always wins over a retry's waiting decision.
 */
export async function recordMemoryPassWake(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly occurrenceId: TriggerOccurrenceId;
    readonly triggerId: TriggerId;
    readonly workerId: ThreadId;
    readonly waitingReason: string | null;
  },
): Promise<{ readonly accepted: boolean; readonly changed: boolean }> {
  return withDatabaseTransaction(database, async (transaction) => {
    await transaction
      .selectFrom("triggerOccurrences")
      .select("id")
      .where("id", "=", input.occurrenceId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const receipt = await transaction
      .selectFrom("threadInputs")
      .select("messageId")
      .where("threadId", "=", input.workerId)
      .where(sql<string>`authority_source->>'occurrenceId'`, "=", input.occurrenceId)
      .executeTakeFirst();
    if (receipt) return { accepted: true, changed: false };
    const result = await transaction
      .updateTable("triggers")
      .set({ waitingReason: input.waitingReason, updatedAt: new Date() })
      .where("id", "=", input.triggerId)
      .where("systemRole", "is not", null)
      .where(sql<boolean>`waiting_reason is distinct from ${input.waitingReason}`)
      .executeTakeFirst();
    return { accepted: false, changed: result.numUpdatedRows > 0n };
  });
}

function snapshotChanged() {
  return new OpensteerError({
    code: "conflict",
    message: "Memory pass prerequisites changed",
    retryable: true,
  });
}

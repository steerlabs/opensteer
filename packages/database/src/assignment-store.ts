import { isOfflineSettlement, personalTransactionDatabase } from "./personal-transaction.js";
import { commitPersonalMutation, wakeExecutionCommands } from "./personal-mutation.js";
import { publishThreadCard } from "./message-visibility.js";
import { transcriptPreview } from "./transcript-store.js";
import { refreshInputQueue } from "./waiting-inputs.js";
import { assignmentWasCancelled } from "./execution-authority.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { connectionRequests } from "./request-agent-response.js";
import type { ThreadCallerAuthority } from "./thread-caller.js";

import { revokeRunGrants, type RevokedRunGrant } from "./run-grants.js";
import {
  AssignmentSummarySchema,
  ModelSelectionSchema,
  OpensteerError,
  assignmentResultMaxBytes,
  createId,
  nonTerminalRunStatuses,
  utf8Prefix,
  type AssignmentId,
  type AssignmentSummary,
  type RunId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { CommandRow, DatabaseSchema, DelegationTable } from "./schema.js";
import {
  idempotencyConflict,
  jsonValue,
  lockCommandIdempotency,
  lockThreadRow,
  principalIdForUser,
  type ChannelLinks,
} from "./store-primitives.js";
import { isDeepStrictEqual } from "node:util";
import { cancelPending } from "./request-store.js";
import { finalizeRunTransaction } from "./run-finalization.js";
import { lockRunProjectionRows, lockThreadProviderSession } from "./run-projection-locks.js";
import { runReply } from "./run-reply.js";
const assignmentResultPreviewMaxBytes = 8 * 1_024;
const truncatedReplyNote = "\n\n[Reply truncated. The full reply is in the task.]";
interface AssignmentSummaryOptions {
  readonly connectionAuthority?: Extract<ThreadCallerAuthority, { kind: "connection" }>;
  readonly ownerVerified?: boolean;
  readonly scope?: "everything" | "selected";
}

function buildAssignmentSummary(
  row: Selectable<DelegationTable>,
  worker: {
    readonly environmentId: string;
    readonly id: ThreadId;
    readonly title: string;
    readonly icon: string | null;
    readonly color: string | null;
    readonly status: string;
    readonly pendingRequestCount: number;
  },
  currentRun: {
    readonly id: RunId;
    readonly status: string;
    readonly modelSelection: unknown;
  },
  parentRun: { readonly modelSelection: unknown } | null,
): AssignmentSummary {
  const workerModel = ModelSelectionSchema.parse(currentRun.modelSelection);
  const assigningModel =
    parentRun === null ? null : ModelSelectionSchema.parse(parentRun.modelSelection);
  return AssignmentSummarySchema.parse({
    createdAt: row.createdAt.toISOString(),
    currentRunId: currentRun.id,
    currentRunStatus: currentRun.status,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    id: row.id,
    initialRunId: row.childRunId,
    modelLabel:
      assigningModel !== null &&
      workerModel.providerId === assigningModel.providerId &&
      workerModel.modelId === assigningModel.modelId
        ? null
        : workerModel.modelId,
    objectivePreview: row.objective,
    origin: row.origin,
    parentThreadId: row.parentThreadId,
    resultPreview:
      row.resultText === null ? null : utf8Prefix(row.resultText, assignmentResultPreviewMaxBytes),
    returnStatus: row.resultStatus,
    revision: Number(row.revision),
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    workerThread: {
      environmentId: worker.environmentId,
      id: worker.id,
      pendingRequests: worker.pendingRequestCount,
      status: worker.status,
      title: worker.title,
      icon: worker.icon,
      color: worker.color,
    },
  });
}

export async function assignmentSummariesInTransaction(
  transaction: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  rows: readonly Selectable<DelegationTable>[],
  options?: AssignmentSummaryOptions,
): Promise<AssignmentSummary[]> {
  if (rows.length === 0) return [];
  const childThreadIds = [...new Set(rows.map((row) => row.childThreadId))];
  const assignmentIds = [...new Set(rows.map((row) => row.id))];
  const parentRunIds = [
    ...new Set(rows.map((row) => row.parentRunId).filter((id): id is RunId => id !== null)),
  ];
  const visibleRequests = options?.connectionAuthority
    ? await connectionRequests(
        transaction as Transaction<DatabaseSchema>,
        options.connectionAuthority,
        {
          ownerVerified: options.ownerVerified ?? true,
          ...(options.scope ? { scope: options.scope } : {}),
        },
      )
    : undefined;
  const [workers, currentRuns, parentRuns] = await Promise.all([
    transaction
      .selectFrom("threads")
      .select([
        "environmentId",
        "id",
        "title",
        "icon",
        "color",
        "status",
        ...(visibleRequests
          ? [
              sql<number>`(
                select count(*)::int from (${visibleRequests}) as visible_requests
                where visible_requests.originating_thread_id = threads.id
                  and visible_requests.status = 'pending'
              )`.as("pendingRequestCount"),
            ]
          : (["pendingRequestCount"] as const)),
      ])
      .where("id", "in", childThreadIds)
      .execute(),
    transaction
      .selectFrom("runs")
      .distinctOn("assignmentId")
      .select(["assignmentId", "id", "status", "modelSelection"])
      .where("assignmentId", "in", assignmentIds)
      .orderBy("assignmentId")
      .orderBy("runOrdinal", "desc")
      .execute(),
    parentRunIds.length === 0
      ? Promise.resolve([])
      : transaction
          .selectFrom("runs")
          .select(["id", "modelSelection"])
          .where("id", "in", parentRunIds)
          .execute(),
  ]);
  const workersById = new Map(workers.map((worker) => [worker.id, worker]));
  const currentRunsByAssignment = new Map(
    currentRuns
      .filter(
        (run): run is typeof run & { assignmentId: AssignmentId } => run.assignmentId !== null,
      )
      .map((run) => [run.assignmentId, run]),
  );
  const parentRunsById = new Map(parentRuns.map((run) => [run.id, run]));
  return rows.map((row) => {
    const worker = workersById.get(row.childThreadId);
    if (!worker) throw new Error(`Worker thread not found for assignment ${row.id}`);
    const currentRun = currentRunsByAssignment.get(row.id);
    if (!currentRun) throw new Error(`Current run not found for assignment ${row.id}`);
    const parentRun =
      row.parentRunId === null ? null : (parentRunsById.get(row.parentRunId) ?? null);
    if (row.parentRunId !== null && !parentRun)
      throw new Error(`Parent run not found for assignment ${row.id}`);
    return buildAssignmentSummary(row, worker, currentRun, parentRun);
  });
}

export async function assignmentSummaryInTransaction(
  transaction: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  row: Selectable<DelegationTable>,
  options?: AssignmentSummaryOptions,
): Promise<AssignmentSummary> {
  const [summary] = await assignmentSummariesInTransaction(transaction, [row], options);
  return summary!;
}

type AssignmentReturnWake = (assignmentId: AssignmentId) => void | Promise<void>;
const assignmentReturnWakes = new WeakMap<Kysely<DatabaseSchema>, AssignmentReturnWake>();

export function installAssignmentReturnWake(
  database: Kysely<DatabaseSchema>,
  wake: AssignmentReturnWake,
) {
  assignmentReturnWakes.set(database, wake);
  return () => {
    if (assignmentReturnWakes.get(database) === wake) assignmentReturnWakes.delete(database);
  };
}

/**
 * Wakes the return owner when this commit lands, for a finished Assignment
 * whose result is still pending: the moment something that held it lets go.
 */
export function wakeAssignmentReturnOnCommit(
  tx: Transaction<DatabaseSchema>,
  mutation: { reaction(callback: () => void | Promise<void>): void },
  row: Pick<Selectable<DelegationTable>, "id" | "status" | "resultStatus">,
): void {
  if (row.status === "open" || row.resultStatus !== "pending") return;
  const database = personalTransactionDatabase(tx);
  const wake = database && assignmentReturnWakes.get(database);
  if (wake) mutation.reaction(() => wake(row.id));
}

export async function publishAssignmentSummaries(
  tx: Transaction<DatabaseSchema>,
  row: Selectable<DelegationTable>,
  wakeReturn = false,
): Promise<void> {
  if (isOfflineSettlement(tx)) return;
  await commitPersonalMutation(tx, async (tx, mutation) => {
    const assignment = await assignmentSummaryInTransaction(tx, row);
    const bounded = {
      ...assignment,
      objectivePreview: utf8Prefix(assignment.objectivePreview, 320),
      resultPreview:
        assignment.resultPreview === null ? null : utf8Prefix(assignment.resultPreview, 320),
      workerThread: {
        ...assignment.workerThread,
        title: utf8Prefix(assignment.workerThread.title, 192),
      },
    };
    const view = transcriptPreview({
      title: assignment.workerThread.title,
      status: assignment.status,
      preview: assignment.resultPreview ?? assignment.objectivePreview,
      assignment: bounded,
    });
    await publishThreadCard(tx, mutation, {
      id: `assignment:${row.id}`,
      threadId: row.childThreadId,
      runId: null,
      kind: "assignment",
      delegationId: row.id,
      createdAt: row.createdAt,
      view,
    });
    if (row.parentThreadId) {
      if (row.status !== "open" && row.resultStatus === "delivered") {
        await publishThreadCard(tx, mutation, {
          id: `delegation:${row.id}`,
          threadId: row.parentThreadId,
          runId: row.parentRunId,
          kind: "delegation",
          delegationId: row.id,
          createdAt: row.finishedAt ?? row.updatedAt,
          view,
        });
      }
      mutation.change(
        {
          scopeKey: `thread:${row.parentThreadId}`,
          entityKind: "assignment",
          entityId: row.id,
          operation: "upsert",
        },
        () => bounded,
      );
    }
    if (wakeReturn && row.status !== "open" && row.resultStatus === "pending") {
      const database = personalTransactionDatabase(tx);
      const wake = database && assignmentReturnWakes.get(database);
      if (wake) mutation.reaction(() => wake(row.id));
    }
  });
}

export async function lockThreadNameDestinations(
  tx: Transaction<DatabaseSchema>,
  threadId: ThreadId,
): Promise<ThreadId | null> {
  const worker = await tx
    .selectFrom("threads")
    .select("id")
    .where("id", "=", threadId)
    .where("removedAt", "is", null)
    .executeTakeFirst();
  return worker?.id ?? null;
}

async function touchAssignment(tx: Transaction<DatabaseSchema>, assignmentId: AssignmentId) {
  const row = await tx
    .updateTable("delegations")
    .set((eb) => ({ revision: eb("revision", "+", 1), updatedAt: new Date() }))
    .where("id", "=", assignmentId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await publishAssignmentSummaries(tx, row);
}

export async function refreshAssignmentWorkerSummaries(
  tx: Transaction<DatabaseSchema>,
  threadId: ThreadId,
): Promise<void> {
  const assignments = await tx
    .selectFrom("delegations")
    .select("id")
    .where("childThreadId", "=", threadId)
    .where("status", "=", "open")
    .orderBy("id")
    .limit(128)
    .forNoKeyUpdate()
    .execute();
  for (const { id } of assignments) await touchAssignment(tx, id);
}

/** A Run's progress changes what its Assignment's card shows. */
export async function assignmentActivityEventsForRun(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<void> {
  const run = await transaction
    .selectFrom("runs")
    .select("assignmentId")
    .where("id", "=", runId)
    .executeTakeFirst();
  if (run?.assignmentId) await touchAssignment(transaction, run.assignmentId);
}

/**
 * A Run may open a Request only while the work it serves is open. The share
 * lock orders this against cancellation, which takes an exclusive row lock
 * before it cancels the tree's pending Requests.
 */
export async function runAssignmentAcceptsRequests(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<boolean> {
  const assignment = await transaction
    .selectFrom("runs")
    .innerJoin("delegations", "delegations.id", "runs.assignmentId")
    .select(["delegations.id", "delegations.status"])
    .where("runs.id", "=", runId)
    .forShare("delegations")
    .executeTakeFirst();
  return (
    !assignment ||
    (assignment.status === "open" && !(await assignmentWasCancelled(transaction, assignment.id)))
  );
}
export const assignmentClosedToRequestsMessage =
  "This task is no longer open, so it cannot ask for anything new";

/**
 * Work that will start another Run of this Assignment, or whose outcome must
 * reach it first. Reports never start work, and a cancelled child's return is
 * a report, so neither holds the Assignment open.
 */
export async function threadOrAssignmentHasPendingWork(
  transaction: Transaction<DatabaseSchema>,
  scope:
    | {
        readonly assignmentId: AssignmentId;
      }
    | {
        readonly threadId: ThreadId;
      },
): Promise<boolean> {
  const [request, input, child, run] = await Promise.all([
    transaction
      .selectFrom("requests")
      .leftJoin("runs", "runs.id", "requests.originatingRunId")
      .leftJoin("requestContinuations", "requestContinuations.requestId", "requests.id")
      .select("requests.id")
      .where(
        "assignmentId" in scope ? "runs.assignmentId" : "requests.originatingThreadId",
        "=",
        "assignmentId" in scope ? scope.assignmentId : scope.threadId,
      )
      .where((expression) =>
        expression.or([
          expression("requests.status", "=", "pending"),
          // Resolved, but the continuation that resumes the work is not queued yet.
          expression("requestContinuations.status", "=", "waiting"),
        ]),
      )
      .limit(1)
      .executeTakeFirst(),
    transaction
      .selectFrom("threadInputs")
      .select("messageId")
      .where(
        "assignmentId" in scope ? "assignmentId" : "threadId",
        "=",
        "assignmentId" in scope ? scope.assignmentId : scope.threadId,
      )
      .where("state", "in", ["pending", "claimed"])
      .where("policy", "<>", "report")
      .limit(1)
      .executeTakeFirst(),
    transaction
      .selectFrom("delegations")
      .select("id")
      .where(
        "assignmentId" in scope ? "parentAssignmentId" : "parentThreadId",
        "=",
        "assignmentId" in scope ? scope.assignmentId : scope.threadId,
      )
      .where((expression) =>
        expression.or([
          expression("status", "=", "open"),
          expression.and([
            expression("status", "in", ["completed", "failed"]),
            expression("resultStatus", "=", "pending"),
          ]),
        ]),
      )
      .limit(1)
      .executeTakeFirst(),
    transaction
      .selectFrom("runs")
      .select("id")
      .where(
        "assignmentId" in scope ? "assignmentId" : "threadId",
        "=",
        "assignmentId" in scope ? scope.assignmentId : scope.threadId,
      )
      .where("status", "in", nonTerminalRunStatuses)
      .limit(1)
      .executeTakeFirst(),
  ]);
  const served =
    "threadId" in scope
      ? await transaction
          .selectFrom("delegations")
          .select("id")
          .where("childThreadId", "=", scope.threadId)
          .where("status", "=", "open")
          .limit(1)
          .executeTakeFirst()
      : undefined;
  return (
    served !== undefined ||
    request !== undefined ||
    input !== undefined ||
    child !== undefined ||
    run !== undefined
  );
}
function boundedResult(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= assignmentResultMaxBytes) return text;
  const budget = assignmentResultMaxBytes - Buffer.byteLength(truncatedReplyNote, "utf8");
  return `${utf8Prefix(text, budget)}${truncatedReplyNote}`;
}

/** The text of the last message the Run wrote: its reply when it completed. */
async function finalReplyOfRun(
  transaction: Transaction<DatabaseSchema>,
  run: {
    readonly id: RunId;
    readonly threadId: ThreadId;
  },
): Promise<string | null> {
  const message = await runReply(transaction, run);
  if (!message) return null;
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  // Null means no substantive reply; an empty string preserves a non-text reply.
  return text;
}

/**
 * Called by Run finalization after the Run became terminal. A completed or
 * failed Run with nothing left to wait for finishes its open Assignment with
 * its own final reply; otherwise the Assignment stays open and the Run's end
 * only changes its summary.
 */
export async function settleAssignmentAfterRun(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly assignmentId: AssignmentId;
    readonly failureSummary: string | null;
    readonly finishedAt: Date;
    readonly run: {
      readonly id: RunId;
      readonly threadId: ThreadId;
    };
    readonly status: "completed" | "failed" | "interrupted";
  },
): Promise<void> {
  const row = await transaction
    .selectFrom("delegations")
    .select("status")
    .where("id", "=", input.assignmentId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  const outcome = input.status;
  if (
    outcome === "interrupted" ||
    row.status !== "open" ||
    (await threadOrAssignmentHasPendingWork(transaction, {
      assignmentId: input.assignmentId,
    }))
  ) {
    return touchAssignment(transaction, input.assignmentId);
  }
  const reply = await finalReplyOfRun(transaction, input.run);
  const resultText =
    outcome === "completed"
      ? boundedResult(reply === null ? "" : reply || "The task ended without a written reply.")
      : boundedResult(
          `${input.failureSummary ? `The task stopped because of an error: ${input.failureSummary}` : "The task stopped because of an error."}${reply ? `\n\nLast reply before the error:\n${reply}` : ""}`,
        );
  const finished = await transaction
    .updateTable("delegations")
    .set((expression) => ({
      finishedAt: input.finishedAt,
      resultRunId: input.run.id,
      resultText,
      revision: expression("revision", "+", 1),
      status: outcome,
      updatedAt: input.finishedAt,
    }))
    .where("id", "=", input.assignmentId)
    .where("status", "=", "open")
    .returningAll()
    .executeTakeFirstOrThrow();
  await publishAssignmentSummaries(transaction, finished, true);
}
export interface AssignmentMutationResult {
  readonly assignment: AssignmentSummary;

  readonly wasDuplicate: boolean;
}
export interface CancelAssignmentInput {
  readonly actorRunId?: RunId;
  readonly assignmentId: AssignmentId;
  readonly idempotencyKey: string;
  readonly requestedBy: UserId;
}
export interface CancelAssignmentResult extends AssignmentMutationResult {
  readonly interruptCommands: readonly CommandRow[];
  /** The grants of the Runs the cancellation interrupts. */
  readonly revokedGrants: readonly RevokedRunGrant[];
}

interface ObservedAssignment {
  readonly createdBy: UserId;
}

/** The personal owner may stop any task. */
async function requireCancelOwner(
  transaction: Transaction<DatabaseSchema>,
  _observed: ObservedAssignment,
  requestedBy: UserId,
  _lock: boolean,
): Promise<void> {
  await requirePersonalOwner(transaction, requestedBy);
}

async function requireCancelScope(
  transaction: Transaction<DatabaseSchema>,
  input: CancelAssignmentInput,
): Promise<void> {
  if (!input.actorRunId) return;
  const actor = await transaction
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .select(["runs.requestedBy", "runs.status", "runs.threadId", "threads.lineageRootThreadId"])
    .where("runs.id", "=", input.actorRunId)
    .executeTakeFirst();
  if (
    !actor ||
    actor.requestedBy !== input.requestedBy ||
    !["running", "waiting"].includes(actor.status)
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Cancelling Run is no longer active",
    });
  }
  const worker = await transaction
    .selectFrom("delegations")
    .innerJoin("threads", "threads.id", "delegations.childThreadId")
    .select("delegations.childThreadId")
    .where("delegations.id", "=", input.assignmentId)
    .executeTakeFirst();
  if (!worker) {
    throw new OpensteerError({
      code: "forbidden",
      message: "This task is outside the agent's consent scope",
    });
  }
  if (worker.childThreadId === actor.threadId) {
    throw new OpensteerError({ code: "forbidden", message: "A Run cannot stop its own task" });
  }
}

/**
 * The worker Threads of an open Assignment and of every open Assignment below
 * it: the Threads cancelling it changes. Read before admission, so commands for
 * those Threads are ordered against the cancellation.
 */
export async function assignmentTreeThreadIds(
  database: Kysely<DatabaseSchema>,
  assignmentId: AssignmentId,
): Promise<readonly ThreadId[]> {
  const result = await sql<{
    childThreadId: ThreadId;
  }>`
    with recursive tree as (
      select id, child_thread_id from public.delegations
        where id = ${assignmentId} and status = 'open'
      union all
      select child.id, child.child_thread_id from public.delegations as child
        join tree on child.parent_assignment_id = tree.id
        where child.status = 'open'
    ) select distinct child_thread_id as "childThreadId" from tree order by 1
  `.execute(database);
  return result.rows.map(({ childThreadId }) => childThreadId);
}
export async function cancelAssignmentInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: CancelAssignmentInput,
): Promise<CancelAssignmentResult> {
  const observed = await transaction
    .selectFrom("delegations")
    .innerJoin("threads", "threads.id", "delegations.childThreadId")
    .select(["delegations.childThreadId", "threads.createdBy", "threads.environmentId"])
    .where("delegations.id", "=", input.assignmentId)
    .executeTakeFirst();
  if (!observed)
    throw new OpensteerError({
      code: "not_found",
      message: "Delegation not found",
    });
  await requireCancelOwner(transaction, observed, input.requestedBy, false);
  await requireCancelScope(transaction, input);
  await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
  const payload = {
    ...(input.actorRunId
      ? {
          actorRunId: input.actorRunId,
        }
      : {}),
    assignmentId: input.assignmentId,
    type: "assignment.cancel",
  } as const;
  const existing = await transaction
    .selectFrom("commands")
    .select(["id", "payload", "type"])
    .where("requestedBy", "=", input.requestedBy)
    .where("idempotencyKey", "=", input.idempotencyKey)
    .executeTakeFirst();
  if (existing) {
    if (existing.type !== "assignment.cancel" || !isDeepStrictEqual(existing.payload, payload)) {
      throw idempotencyConflict(input.idempotencyKey);
    }
    const row = await transaction
      .selectFrom("delegations")
      .selectAll()
      .where("id", "=", input.assignmentId)
      .executeTakeFirstOrThrow();
    return {
      assignment: await assignmentSummaryInTransaction(transaction, row),
      interruptCommands: [],
      revokedGrants: [],
      wasDuplicate: true,
    };
  }
  const now = new Date();
  const [target] = await cancelAssignmentRowsInTransaction(transaction, [input.assignmentId], now);
  if (!target)
    throw new OpensteerError({ code: "conflict", message: "Delegation is already finished" });
  await transaction
    .updateTable("delegations")
    .set({ cancellationRootId: target.id })
    .where("id", "=", target.id)
    .execute();
  await publishAssignmentSummaries(transaction, target, true);
  await transaction
    .insertInto("commands")
    .values({
      actorPrincipalId: await principalIdForUser(transaction, input.requestedBy),
      authoritySource: jsonValue({
        kind: "assignment-cancel",
        userId: input.requestedBy,
      }),
      dispatcherId: null,
      environmentId: observed.environmentId,
      id: createId("command"),
      idempotencyKey: input.idempotencyKey,
      lastError: null,
      payload: jsonValue(payload),
      requestedBy: input.requestedBy,
      runId: input.actorRunId ?? null,
      status: "succeeded",
      threadId: observed.childThreadId,
      type: "assignment.cancel",
    })
    .executeTakeFirstOrThrow();
  return {
    assignment: await assignmentSummaryInTransaction(transaction, target),
    interruptCommands: [],
    revokedGrants: [],
    wasDuplicate: false,
  };
}

export async function drainAssignmentCancellation(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  root?: AssignmentId,
): Promise<Pick<CancelAssignmentResult, "interruptCommands" | "revokedGrants">> {
  const interruptCommands: CommandRow[] = [];
  const revokedGrants: RevokedRunGrant[] = [];
  for (;;) {
    const next = await commitPersonalMutation(database, async (tx) => {
      const assignment = await tx
        .selectFrom("delegations")
        .selectAll()
        .where("cancellationRootId", "is not", null)
        .$if(root !== undefined, (query) => query.where("cancellationRootId", "=", root!))
        .orderBy("id")
        .limit(1)
        .executeTakeFirst();
      if (!assignment?.cancellationRootId) return null;
      const now = new Date();
      const children = await tx
        .selectFrom("delegations")
        .select("id")
        .where("parentAssignmentId", "=", assignment.id)
        .where(sql<boolean>`status = 'open'`)
        .orderBy("id")
        .limit(16)
        .execute();
      if (children.length) {
        const rows = await cancelAssignmentRowsInTransaction(
          tx,
          children.map(({ id }) => id),
          now,
        );
        await tx
          .updateTable("delegations")
          .set({ cancellationRootId: assignment.cancellationRootId })
          .where(
            "id",
            "in",
            rows.map(({ id }) => id),
          )
          .execute();
        for (const child of rows) await publishAssignmentSummaries(tx, child, true);
        return {};
      }

      const inputs = await tx
        .selectFrom("threadInputs")
        .select("messageId")
        .where("assignmentId", "=", assignment.id)
        .where(sql<boolean>`state = 'pending'`)
        .orderBy("messageId")
        .limit(16)
        .execute();
      if (inputs.length) {
        await lockThreadRow(tx, assignment.childThreadId);
        await lockThreadProviderSession(tx, assignment.childThreadId);
        const rows = await tx
          .updateTable("threadInputs")
          .set({ state: "cancelled", cancelReason: "assignment-cancelled", updatedAt: now })
          .where(
            "messageId",
            "in",
            inputs.map(({ messageId }) => messageId),
          )
          .returning(["threadId", "messageId"])
          .execute();
        for (const row of rows) await refreshInputQueue(tx, row.threadId, row.messageId);
        return {};
      }

      const pending = await tx
        .selectFrom("requests")
        .innerJoin("runs", "runs.id", "requests.originatingRunId")
        .select("requests.id")
        .where("requests.originatingThreadId", "=", assignment.childThreadId)
        .where("runs.assignmentId", "=", assignment.id)
        .where(sql<boolean>`requests.status = 'pending'`)
        .orderBy("requests.id")
        .limit(16)
        .execute();
      if (pending.length) {
        await cancelPending(tx, {
          reason: "source-closed",
          resolvedAt: now,
          requestIds: pending.map(({ id }) => id),
        });
        return {};
      }

      const run = await tx
        .selectFrom("runs")
        .select(["id", "status", "bindingGeneration", "threadId", "environmentId", "requestedBy"])
        .where("threadId", "=", assignment.childThreadId)
        .where("assignmentId", "=", assignment.id)
        .where("status", "in", nonTerminalRunStatuses)
        .where("finishIntent", "is", null)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("commands")
                .select("id")
                .whereRef("runId", "=", "runs.id")
                .where("type", "=", "run.interrupt")
                .where("status", "in", ["pending", "dispatched", "succeeded"]),
            ),
          ),
        )
        .orderBy("id")
        .limit(1)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!run) {
        await tx
          .updateTable("delegations")
          .set({ cancellationRootId: null })
          .where("id", "=", assignment.id)
          .execute();
        return {};
      }
      await lockThreadRow(tx, run.threadId);
      await lockRunProjectionRows(tx, { runIds: [run.id], threadIds: [run.threadId] });
      if (
        run.status === "queued" ||
        (run.status === "starting" && run.bindingGeneration === null)
      ) {
        await finalizeRunTransaction(tx, {
          completedAt: now,
          links,
          queuedInputCancellation: "activation-input",
          requestCancellationReason: "source-closed",
          runId: run.id,
          source: "host",
          status: "interrupted",
        });
        return {};
      }
      const command = await tx
        .insertInto("commands")
        .values({
          actorPrincipalId: await principalIdForUser(tx, run.requestedBy),
          authoritySource: jsonValue({
            assignmentId: assignment.cancellationRootId,
            kind: "assignment-cancel",
          }),
          dispatcherId: null,
          environmentId: run.environmentId,
          id: createId("command"),
          idempotencyKey: `assignment-cancel:${assignment.cancellationRootId}:${run.id}`,
          lastError: null,
          payload: jsonValue({ runId: run.id, threadId: run.threadId, type: "run.interrupt" }),
          requestedBy: run.requestedBy,
          runId: run.id,
          status: "pending",
          threadId: run.threadId,
          type: "run.interrupt",
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await wakeExecutionCommands(tx);
      const grants = await revokeRunGrants(tx, [run.id], "assignment-cancelled");
      return { command, grants };
    });
    if (!next) break;
    if (next.command) interruptCommands.push(next.command);
    if (next.grants) revokedGrants.push(...next.grants);
  }
  return { interruptCommands, revokedGrants };
}

/** The caller reserves the complete Assignment tree before mutating it. */
export async function cancelAssignmentRowsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  ids: readonly AssignmentId[],
  now: Date,
) {
  if (!ids.length) return [];
  return await transaction
    .updateTable("delegations")
    .set((expression) => ({
      finishedAt: now,
      resultRunId: null,
      resultText: null,
      revision: expression("revision", "+", 1),
      status: "cancelled",
      updatedAt: now,
    }))
    .where("id", "in", [...ids])
    .where("status", "=", "open")
    .returningAll()
    .execute();
}

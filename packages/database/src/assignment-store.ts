import { TransactionScopeChanged } from "./connection.js";
import { revokeRunGrants, type RevokedRunGrant } from "./run-grants.js";
import {
  AssignmentSummarySchema,
  ModelSelectionSchema,
  OpensteerError,
  assignmentResultMaxBytes,
  createId,
  nonTerminalRunStatuses,
  utf8Prefix,
  type AgentEvent,
  type AssignmentId,
  type AssignmentSummary,
  type RunId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { CommandRow, DatabaseSchema, DelegationTable } from "./schema.js";
import { threadInputFromRow } from "./thread-row-mappers.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import {
  idempotencyConflict,
  jsonValue,
  lockCommandIdempotency,
  principalIdForUser,
  requireActiveWorkspaceMembership,
  threadExecutionIsAvailableToUser,
  type ChannelLinks,
} from "./store-primitives.js";
import { isDeepStrictEqual } from "node:util";
import { cancelPending } from "./request-store.js";
import { finalizeRunTransaction } from "./run-finalization.js";
import { lockRunProjectionRows } from "./run-projection-locks.js";
import { runReply } from "./run-reply.js";

const assignmentResultPreviewMaxBytes = 8 * 1_024;
const truncatedReplyNote = "\n\n[Reply truncated. The full reply is in the task Thread.]";

export async function assignmentSummaryInTransaction(
  transaction: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  row: Selectable<DelegationTable>,
): Promise<AssignmentSummary> {
  const worker = await transaction
    .selectFrom("threads")
    .select([
      "environmentId",
      "id",
      "title",
      "icon",
      "color",
      "workspaceId",
      "status",
      "pendingRequestCount",
    ])
    .where("id", "=", row.childThreadId)
    .executeTakeFirstOrThrow();
  const [currentRun, parentRun] = await Promise.all([
    transaction
      .selectFrom("runs")
      .select(["id", "status", "modelSelection"])
      .where("assignmentId", "=", row.id)
      .orderBy("runOrdinal", "desc")
      .executeTakeFirstOrThrow(),
    row.parentRunId === null
      ? Promise.resolve(null)
      : transaction
          .selectFrom("runs")
          .select("modelSelection")
          .where("id", "=", row.parentRunId)
          .executeTakeFirstOrThrow(),
  ]);
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
    revision: row.revision,
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
      workspaceId: worker.workspaceId,
    },
  });
}

/**
 * The worker Workspace's copy of an Assignment's summary. Transactions that
 * hold only the worker Workspace publish here and nowhere else: appending to
 * the parent Workspace would lock a second Workspace out of order.
 */
async function assignmentWorkerEventInTransaction(
  transaction: Transaction<DatabaseSchema>,
  row: Selectable<DelegationTable>,
  type: "assignment.created" | "assignment.updated",
  runId: RunId | null,
): Promise<AgentEvent> {
  return appendAssignmentWorkerEvent(
    transaction,
    await assignmentSummaryInTransaction(transaction, row),
    type,
    runId,
  );
}

function appendAssignmentWorkerEvent(
  transaction: Transaction<DatabaseSchema>,
  assignment: AssignmentSummary,
  type: "assignment.created" | "assignment.updated",
  runId: RunId | null,
): Promise<AgentEvent> {
  return appendHostWorkspaceEvent(transaction, {
    data: { assignment },
    environmentId: assignment.workerThread.environmentId,
    runId,
    threadId: assignment.workerThread.id,
    type,
    workspaceId: assignment.workerThread.workspaceId,
  });
}

/**
 * The summary in both the worker and the parent Workspace. Only creation,
 * cancellation, return delivery and title changes call this; each already
 * holds both Workspaces, locked in id order.
 */
export async function assignmentEventsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  row: Selectable<DelegationTable>,
  type: "assignment.created" | "assignment.updated",
  runId: RunId | null = null,
  parentRunId: RunId | null = row.parentRunId,
): Promise<readonly AgentEvent[]> {
  const assignment = await assignmentSummaryInTransaction(transaction, row);
  const events = [await appendAssignmentWorkerEvent(transaction, assignment, type, runId)];
  const [parent, requester] = await Promise.all([
    transaction
      .selectFrom("threads")
      .select(["environmentId", "workspaceId"])
      .where("id", "=", row.parentThreadId)
      .executeTakeFirstOrThrow(),
    transaction
      .selectFrom("runs")
      .select("requestedBy")
      .where("id", "=", row.childRunId)
      .executeTakeFirstOrThrow(),
  ]);
  // A parent Workspace keeps its history after the requester loses worker
  // access. New worker details and result text must not reach it.
  if (
    (await threadExecutionIsAvailableToUser(
      transaction,
      row.childThreadId,
      requester.requestedBy,
    )) &&
    (await threadExecutionIsAvailableToUser(transaction, row.parentThreadId, requester.requestedBy))
  ) {
    events.push(
      await appendHostWorkspaceEvent(transaction, {
        data: { assignment },
        environmentId: parent.environmentId,
        runId: parentRunId,
        threadId: row.parentThreadId,
        type,
        workspaceId: parent.workspaceId,
      }),
    );
  }
  return events;
}

/** Reserve every summary destination before a name or symbol writer takes its Thread lock. */
export async function lockThreadNameWorkspaces(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
): Promise<WorkspaceId | null> {
  const worker = await transaction
    .selectFrom("threads")
    .select("workspaceId")
    .where("id", "=", threadId)
    .executeTakeFirst();
  if (!worker) return null;
  const parents = () =>
    transaction
      .selectFrom("delegations")
      .innerJoin("threads", "threads.id", "delegations.parentThreadId")
      .select("threads.workspaceId")
      .where("delegations.childThreadId", "=", threadId)
      .execute();
  const workspaceIds = [
    ...new Set([worker.workspaceId, ...(await parents()).map((row) => row.workspaceId)]),
  ];
  const locked = await transaction
    .selectFrom("workspaces")
    .select("id")
    .where("id", "in", workspaceIds)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  if (!locked.some(({ id }) => id === worker.workspaceId)) return null;
  // Delegation creation also holds the worker Workspace. A new parent may have
  // committed while this writer waited; rediscover it in a fresh transaction.
  if ((await parents()).some(({ workspaceId }) => !locked.some(({ id }) => id === workspaceId)))
    throw new TransactionScopeChanged();
  return worker.workspaceId;
}

export async function assignmentNameEventsForThread(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
): Promise<readonly AgentEvent[]> {
  const assignments = await transaction
    .selectFrom("delegations")
    .select("id")
    .where("childThreadId", "=", threadId)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  const events: AgentEvent[] = [];
  for (const assignment of assignments) {
    const row = await transaction
      .updateTable("delegations")
      .set((expression) => ({ revision: expression("revision", "+", 1), updatedAt: new Date() }))
      .where("id", "=", assignment.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    // Name writers hold no Run lock; null attribution keeps the event's
    // foreign-key check from acquiring one after the Assignment lock.
    events.push(
      ...(await assignmentEventsInTransaction(transaction, row, "assignment.updated", null, null)),
    );
  }
  return events;
}

async function touchAssignment(
  transaction: Transaction<DatabaseSchema>,
  assignmentId: AssignmentId,
  runId: RunId,
): Promise<readonly AgentEvent[]> {
  const row = await transaction
    .updateTable("delegations")
    .set((expression) => ({ revision: expression("revision", "+", 1), updatedAt: new Date() }))
    .where("id", "=", assignmentId)
    .returningAll()
    .executeTakeFirstOrThrow();
  return [await assignmentWorkerEventInTransaction(transaction, row, "assignment.updated", runId)];
}

/** Pending counts also feed task cards; publish their corrected worker summary after projection. */
export async function assignmentStateEventsForThread(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
): Promise<readonly AgentEvent[]> {
  const rows = await transaction
    .updateTable("delegations")
    .set((expression) => ({ revision: expression("revision", "+", 1), updatedAt: new Date() }))
    .where("childThreadId", "=", threadId)
    .where("status", "=", "open")
    .returningAll()
    .execute();
  const events: AgentEvent[] = [];
  for (const row of rows) {
    // A deferred projection holds no Run lock. Null attribution preserves
    // ./lock-order.ts through the event's foreign-key check.
    events.push(
      await assignmentWorkerEventInTransaction(transaction, row, "assignment.updated", null),
    );
  }
  return events;
}

/** A Run's progress changes what its Assignment's card shows. */
export async function assignmentActivityEventsForRun(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<readonly AgentEvent[]> {
  const run = await transaction
    .selectFrom("runs")
    .select("assignmentId")
    .where("id", "=", runId)
    .executeTakeFirst();
  return run?.assignmentId ? touchAssignment(transaction, run.assignmentId, runId) : [];
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
    .select("delegations.status")
    .where("runs.id", "=", runId)
    .forShare("delegations")
    .executeTakeFirst();
  return !assignment || assignment.status === "open";
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
  scope: { readonly assignmentId: AssignmentId } | { readonly threadId: ThreadId },
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
  run: { readonly id: RunId; readonly threadId: ThreadId },
): Promise<string | null> {
  const message = await runReply(transaction, run);
  if (!message) return null;
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
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
    readonly run: { readonly id: RunId; readonly threadId: ThreadId };
    readonly status: "completed" | "failed" | "interrupted";
  },
): Promise<readonly AgentEvent[]> {
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
    (await threadOrAssignmentHasPendingWork(transaction, { assignmentId: input.assignmentId }))
  ) {
    return touchAssignment(transaction, input.assignmentId, input.run.id);
  }
  const reply = await finalReplyOfRun(transaction, input.run);
  const resultText =
    outcome === "completed"
      ? boundedResult(reply ?? "The task ended without a written reply.")
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
  return [
    await assignmentWorkerEventInTransaction(
      transaction,
      finished,
      "assignment.updated",
      input.run.id,
    ),
  ];
}

export interface AssignmentMutationResult {
  readonly assignment: AssignmentSummary;
  readonly events: readonly AgentEvent[];
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

/** The tree gained work between its snapshot and its locks; retry the whole transaction. */
export const assignmentTreeChangedReason = "assignment-tree-changed";

interface ObservedAssignment {
  readonly createdBy: UserId;
  readonly workspaceId: WorkspaceId;
}

/** A person may stop a task they started a worker for, or any task in a Workspace they own. */
async function requireCancelMembership(
  transaction: Transaction<DatabaseSchema>,
  observed: ObservedAssignment,
  requestedBy: UserId,
  lock: boolean,
): Promise<void> {
  const membership = await requireActiveWorkspaceMembership(
    transaction,
    observed.workspaceId,
    requestedBy,
    lock,
  );
  if (observed.createdBy !== requestedBy && membership.role !== "owner") {
    throw new OpensteerError({
      code: "forbidden",
      message: "Only the owner can stop another member's task",
    });
  }
}

/**
 * An agent acts for its person, so the person's rule applies first. A
 * Main-profile Run may then stop anything that person could; any other Run
 * only work handed out from its own Thread, and what that work handed out.
 */
async function requireCancelScope(
  transaction: Transaction<DatabaseSchema>,
  input: CancelAssignmentInput,
): Promise<void> {
  if (!input.actorRunId) return;
  const actor = await transaction
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .select(["runs.requestedBy", "runs.status", "runs.threadId", "threads.capabilityProfileId"])
    .where("runs.id", "=", input.actorRunId)
    .executeTakeFirst();
  if (
    !actor ||
    actor.requestedBy !== input.requestedBy ||
    !["running", "waiting"].includes(actor.status)
  ) {
    throw new OpensteerError({ code: "forbidden", message: "Cancelling Run is no longer active" });
  }
  if (actor.capabilityProfileId === "main") return;
  const handedOut = await sql<{ id: AssignmentId }>`
    with recursive lineage as (
      select id, parent_assignment_id, parent_thread_id
        from public.delegations where id = ${input.assignmentId}
      union all
      select parent.id, parent.parent_assignment_id, parent.parent_thread_id
        from public.delegations as parent
        join lineage on parent.id = lineage.parent_assignment_id
    ) select id from lineage where parent_thread_id = ${actor.threadId} limit 1
  `.execute(transaction);
  if (handedOut.rows.length === 0) {
    throw new OpensteerError({
      code: "forbidden",
      message: "This Thread can stop only tasks it started and the work they started",
    });
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
  const result = await sql<{ childThreadId: ThreadId }>`
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
  links: ChannelLinks,
): Promise<CancelAssignmentResult> {
  const observed = await transaction
    .selectFrom("delegations")
    .innerJoin("threads", "threads.id", "delegations.childThreadId")
    .select([
      "delegations.childThreadId",
      "threads.createdBy",
      "threads.environmentId",
      "threads.workspaceId",
    ])
    .where("delegations.id", "=", input.assignmentId)
    .executeTakeFirst();
  if (!observed) throw new OpensteerError({ code: "not_found", message: "Assignment not found" });
  await requireCancelMembership(transaction, observed, input.requestedBy, false);
  await requireCancelScope(transaction, input);
  await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
  const payload = {
    ...(input.actorRunId ? { actorRunId: input.actorRunId } : {}),
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
      events: [],
      interruptCommands: [],
      revokedGrants: [],
      wasDuplicate: true,
    };
  }
  // See ./lock-order.ts. Fence every Run that could extend this tree or
  // queue work into it, including the actor, as one ordered set. Admission
  // revalidates the actor after cancellation, within this same transaction.
  const openTree = async (): Promise<AssignmentId[]> => {
    const result = await sql<{ id: AssignmentId }>`
      with recursive tree as (
        select id from public.delegations where id = ${input.assignmentId} and status = 'open'
        union all
        select child.id from public.delegations as child
          join tree on child.parent_assignment_id = tree.id
          where child.status = 'open'
      ) select id from tree order by id
    `.execute(transaction);
    return result.rows.map(({ id }) => id);
  };
  const treeRuns = (assignmentIds: readonly AssignmentId[]) =>
    transaction
      .selectFrom("runs")
      .select(["id", "status", "threadId", "environmentId"])
      .where("assignmentId", "in", [...assignmentIds])
      .where("status", "in", nonTerminalRunStatuses)
      .$if(input.actorRunId !== undefined, (query) => query.where("id", "<>", input.actorRunId!))
      .orderBy("id", "asc");
  const ids = await openTree();
  if (!ids.includes(input.assignmentId)) {
    throw new OpensteerError({ code: "conflict", message: "Assignment is already terminal" });
  }
  const discoveredRunIds = (await treeRuns(ids).execute()).map(({ id }) => id);
  const fenceRunIds = [
    ...new Set([...discoveredRunIds, ...(input.actorRunId ? [input.actorRunId] : [])]),
  ];
  const fencedRuns = fenceRunIds.length
    ? await transaction
        .selectFrom("runs")
        .select(["bindingGeneration", "id", "status", "threadId", "environmentId"])
        .where("id", "in", fenceRunIds)
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute()
    : [];
  await requireCancelScope(transaction, input);
  // The fence returns each Run as it stands after any wait: one that finished
  // meanwhile needs no interrupt, and a command for it would never settle.
  const lockedRuns = fencedRuns.filter(
    ({ id, status }) =>
      id !== input.actorRunId && (nonTerminalRunStatuses as readonly string[]).includes(status),
  );

  const linked = await transaction
    .selectFrom("delegations")
    .innerJoin("threads as worker", "worker.id", "delegations.childThreadId")
    .innerJoin("threads as parent", "parent.id", "delegations.parentThreadId")
    .select([
      "worker.id as workerThreadId",
      "worker.workspaceId as workerWorkspaceId",
      "parent.workspaceId as parentWorkspaceId",
    ])
    .where("delegations.id", "in", ids)
    .execute();
  await transaction
    .selectFrom("workspaces")
    .select("id")
    .where("id", "in", [
      ...new Set(linked.flatMap((row) => [row.workerWorkspaceId, row.parentWorkspaceId])),
    ])
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  await requireCancelMembership(transaction, observed, input.requestedBy, true);
  // Holding the worker Threads means no Run can be queued into the tree now.
  await transaction
    .selectFrom("threads")
    .select("id")
    .where(
      "id",
      "in",
      linked.map(({ workerThreadId }) => workerThreadId),
    )
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  await lockRunProjectionRows(transaction, {
    runIds: lockedRuns.map(({ id }) => id),
    threadIds: linked.map(({ workerThreadId }) => workerThreadId),
    assignmentIds: ids,
  });
  await transaction
    .selectFrom("delegations")
    .select("id")
    .where("id", "in", ids)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  // Anything committed between the snapshot and these locks is visible now.
  // New work cannot be locked out of order, so the whole transaction retries.
  const lockedRunIds = new Set(lockedRuns.map(({ id }) => id));
  const currentIds = await openTree();
  const currentRuns = await treeRuns(currentIds).execute();
  if (!isDeepStrictEqual(currentIds, ids) || currentRuns.some(({ id }) => !lockedRunIds.has(id))) {
    throw new OpensteerError({
      code: "conflict",
      message: "The task changed while it was being stopped. Try again.",
      reason: assignmentTreeChangedReason,
      retryable: true,
    });
  }
  const now = new Date();
  // The return stays pending: delivery tells the parent with a passive report.
  const updatedRows = await cancelAssignmentRowsInTransaction(transaction, ids, now);
  const events: AgentEvent[] = [];
  const cancelledInputs = await transaction
    .updateTable("threadInputs")
    .set({ cancelReason: "assignment-cancelled", state: "cancelled", updatedAt: now })
    .where("assignmentId", "in", ids)
    .where("state", "=", "pending")
    .returningAll()
    .execute();
  for (const row of cancelledInputs) {
    const thread = await transaction
      .selectFrom("threads")
      .select(["environmentId", "workspaceId"])
      .where("id", "=", row.threadId)
      .executeTakeFirstOrThrow();
    events.push(
      await appendHostWorkspaceEvent(transaction, {
        data: { input: threadInputFromRow(row) },
        environmentId: thread.environmentId,
        runId: null,
        threadId: row.threadId,
        type: "thread-input.updated",
        workspaceId: thread.workspaceId,
      }),
    );
  }
  // Live and durable alike: nothing the stopped work asked for stays open.
  const pendingRequests = await transaction
    .selectFrom("requests")
    .innerJoin("runs", "runs.id", "requests.originatingRunId")
    .select("requests.id")
    .where("runs.assignmentId", "in", ids)
    .where("requests.status", "=", "pending")
    .execute();
  events.push(
    ...(await cancelPending(transaction, {
      reason: "source-closed",
      resolvedAt: now,
      requestIds: pendingRequests.map(({ id }) => id),
    })),
  );
  const actorRun = input.actorRunId
    ? await transaction
        .selectFrom("runs")
        .select(["bindingGeneration", "id", "status", "threadId", "environmentId"])
        .where("id", "=", input.actorRunId)
        .where("assignmentId", "in", ids)
        .where("status", "in", nonTerminalRunStatuses)
        .executeTakeFirst()
    : undefined;
  const interruptCommands: CommandRow[] = [];
  for (const run of actorRun ? [...lockedRuns, actorRun] : lockedRuns) {
    // An unbound Run has never reached a Runner and now never will.
    if (run.status === "queued" || (run.status === "starting" && run.bindingGeneration === null)) {
      events.push(
        ...(await finalizeRunTransaction(transaction, {
          completedAt: now,
          links,
          queuedInputCancellation: "activation-input",
          requestCancellationReason: "source-closed",
          runId: run.id,
          source: "host",
          status: "interrupted",
        })),
      );
      continue;
    }
    const command = await transaction
      .insertInto("commands")
      .values({
        actorPrincipalId: await principalIdForUser(transaction, input.requestedBy),
        authoritySource: jsonValue({ assignmentId: input.assignmentId, kind: "assignment-cancel" }),
        dispatcherId: null,
        environmentId: run.environmentId,
        id: createId("command"),
        idempotencyKey: `assignment-cancel:${input.assignmentId}:${run.id}`,
        lastError: null,
        payload: jsonValue({ runId: run.id, threadId: run.threadId, type: "run.interrupt" }),
        requestedBy: input.requestedBy,
        runId: run.id,
        status: "pending",
        threadId: run.threadId,
        type: "run.interrupt",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    interruptCommands.push(command);
  }
  await transaction
    .insertInto("commands")
    .values({
      actorPrincipalId: await principalIdForUser(transaction, input.requestedBy),
      authoritySource: jsonValue({ kind: "assignment-cancel", userId: input.requestedBy }),
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
  const terminalRows = await transaction
    .selectFrom("delegations")
    .selectAll()
    .where(
      "id",
      "in",
      updatedRows.map(({ id }) => id),
    )
    .orderBy("id", "asc")
    .execute();
  for (const row of terminalRows) {
    events.push(
      ...(await assignmentEventsInTransaction(
        transaction,
        row,
        "assignment.updated",
        input.actorRunId ?? null,
      )),
    );
  }
  const target = terminalRows.find(({ id }) => id === input.assignmentId);
  if (!target)
    throw new OpensteerError({ code: "internal", message: "Cancelled Assignment is missing" });
  const assignment = await assignmentSummaryInTransaction(transaction, target);
  // Cancelled work loses its tools now, while its interrupts are delivered.
  const revokedGrants = await revokeRunGrants(
    transaction,
    interruptCommands.flatMap(({ runId }) => (runId ? [runId] : [])),
    "assignment-cancelled",
  );
  return { assignment, events, interruptCommands, revokedGrants, wasDuplicate: false };
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

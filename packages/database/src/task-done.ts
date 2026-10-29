import { isDeepStrictEqual } from "node:util";
import {
  createId,
  nonTerminalRunStatuses,
  OpensteerError,
  SequenceSchema,
  type AgentEvent,
  type AssignmentId,
  type RunId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import { TransactionScopeChanged, withDatabaseTransaction } from "./connection.js";
import type { DatabaseSchema, ThreadRow } from "./schema.js";
import {
  assignmentEventsInTransaction,
  cancelAssignmentRowsInTransaction,
} from "./assignment-store.js";
import { persistRunnerControlCommand } from "./command-store.js";
import { finalizeRunTransaction } from "./run-finalization.js";
import { revokeRunGrants } from "./run-grants.js";
import { lockRunProjectionRows } from "./run-projection-locks.js";
import { cancelPending } from "./request-cancellation.js";
import { pauseTriggerInTransaction } from "./trigger-store.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";
import {
  idempotencyConflict,
  jsonValue,
  lockCommandIdempotency,
  principalIdForUser,
  requireActiveWorkspaceMembership,
  type ChannelLinks,
} from "./store-primitives.js";
import {
  threadContinuationIdentitySelection,
  threadFromRow,
  threadInputFromRow,
  threadPendingRequestsSelection,
  threadProviderSessionSelection,
} from "./thread-row-mappers.js";
import { lockThreadChannelAuthorities } from "./channel-execution.js";
import { projectThreadState } from "./thread-status.js";
import {
  admitAgentControlRequestInTransaction,
  type AgentControlAdmissionInput,
} from "./agent-control-admission.js";

export interface ThreadWriteActor {
  readonly requestedBy: UserId;
  readonly actorRunId?: RunId;
}

/** Write reach is narrower than read reach, and never replaces the person's authority. */
export async function requireThreadWriteAuthority(
  transaction: Transaction<DatabaseSchema>,
  thread: Pick<ThreadRow, "id" | "workspaceId" | "createdBy">,
  actor: ThreadWriteActor,
  action: "rename" | "set_icon" | "done" | "reopen",
): Promise<void> {
  const membership = await requireActiveWorkspaceMembership(
    transaction,
    thread.workspaceId,
    actor.requestedBy,
  );
  const run = actor.actorRunId
    ? await transaction
        .selectFrom("runs")
        .innerJoin("threads", "threads.id", "runs.threadId")
        .select([
          "runs.requestedBy",
          "runs.status",
          "runs.threadId",
          "threads.workspaceId",
          "threads.capabilityProfileId",
        ])
        .where("runs.id", "=", actor.actorRunId)
        .executeTakeFirst()
    : null;
  if (
    actor.actorRunId &&
    (!run ||
      run.requestedBy !== actor.requestedBy ||
      !nonTerminalRunStatuses.some((status) => status === run.status))
  )
    throw new OpensteerError({ code: "forbidden", message: "Writing Run is no longer active" });
  const self = run?.threadId === thread.id;
  if (
    (action === "done" || action === "reopen") &&
    !(self && action === "done") &&
    thread.createdBy !== actor.requestedBy &&
    membership.role !== "owner"
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "Only the owner can stop another member's task",
    });
  if (!run || self || run.capabilityProfileId === "main") return;
  if (run.capabilityProfileId === "workspace" && run.workspaceId === thread.workspaceId) return;
  if (run.capabilityProfileId === "delegated") {
    const descendants = await sql<{ id: ThreadId }>`with recursive descendants as (
      select id, child_thread_id from delegations where parent_thread_id = ${run.threadId}
      union
      select child.id, child.child_thread_id from delegations child join descendants parent on child.parent_assignment_id = parent.id
    ) select child_thread_id as id from descendants where child_thread_id = ${thread.id}`.execute(
      transaction,
    );
    if (descendants.rows.length) return;
  }
  throw new OpensteerError({
    code: "forbidden",
    message: "This agent can write only its own task and tasks it handed out",
  });
}

export interface SetThreadDoneInput extends ThreadWriteActor {
  readonly done: boolean;
  readonly idempotencyKey: string;
  readonly threadId: ThreadId;
  readonly admission?: AgentControlAdmissionInput;
}

/** The open Assignments a task serves or handed out, and every open one beneath them. */
async function openDoneAssignments(database: Kysely<DatabaseSchema>, threadId: ThreadId) {
  return (
    await sql<{ id: AssignmentId; childThreadId: ThreadId; parentThreadId: ThreadId }>`
    with recursive tree as (
      select id, child_thread_id, parent_thread_id from delegations
      where status = 'open' and (child_thread_id = ${threadId} or parent_thread_id = ${threadId})
      union
      select child.id, child.child_thread_id, child.parent_thread_id from delegations child
      join tree parent on child.parent_assignment_id = parent.id where child.status = 'open'
    ) select * from tree order by id
  `.execute(database)
  ).rows;
}

/**
 * The Threads marking a task Done stops: the task and the subtask Threads its
 * open Assignments reach. The Host admits the command under all of them.
 */
export async function doneScopeThreadIds(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
): Promise<readonly ThreadId[]> {
  const assignments = await openDoneAssignments(database, threadId);
  return [...new Set([threadId, ...assignments.map((row) => row.childThreadId)])].sort();
}

async function discoverDoneScope(
  transaction: Transaction<DatabaseSchema>,
  input: SetThreadDoneInput,
) {
  const assignments = input.done ? await openDoneAssignments(transaction, input.threadId) : [];
  const threadIds = [
    ...new Set([input.threadId, ...assignments.map((row) => row.childThreadId)]),
  ].sort();
  const runs = await transaction
    .selectFrom("runs")
    .select(["id", "threadId"])
    .where((eb) =>
      eb.or([
        eb.and([
          eb("threadId", "in", threadIds),
          eb.or([
            eb("status", "in", nonTerminalRunStatuses),
            eb(
              "id",
              "in",
              eb
                .selectFrom("requests")
                .select("originatingRunId")
                .where("originatingThreadId", "in", threadIds)
                .where("status", "=", "pending"),
            ),
          ]),
        ]),
        ...(input.actorRunId ? [eb("id", "=", input.actorRunId)] : []),
      ]),
    )
    .orderBy("id")
    .execute();
  const triggers = await transaction
    .selectFrom("triggers")
    .select("id")
    .where("anchorThreadId", "in", threadIds)
    .orderBy("id")
    .execute();
  const requests = await transaction
    .selectFrom("requests")
    .select(["id", "originatingWorkspaceId"])
    .where("originatingThreadId", "in", threadIds)
    .where("status", "=", "pending")
    .orderBy("id")
    .execute();
  const inputs = await transaction
    .selectFrom("threadInputs")
    .select("messageId")
    .where("threadId", "in", threadIds)
    .where("state", "in", ["pending", "claimed"])
    .where("policy", "<>", "report")
    .orderBy("messageId")
    .execute();
  return { assignments, threadIds, runs, triggers, requests, inputs };
}

export async function setThreadDone(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: SetThreadDoneInput,
) {
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
      const payload = {
        threadId: input.threadId,
        done: input.done,
        ...(input.actorRunId ? { actorRunId: input.actorRunId } : {}),
      };
      const existing = await transaction
        .selectFrom("commands")
        .selectAll()
        .where("requestedBy", "=", input.requestedBy)
        .where("idempotencyKey", "=", input.idempotencyKey)
        .executeTakeFirst();
      if (
        existing &&
        (existing.type !== "thread.shared-done.set" ||
          !isDeepStrictEqual(existing.payload, payload))
      )
        throw idempotencyConflict(input.idempotencyKey);
      const scope = await discoverDoneScope(transaction, input);
      const runs = scope.runs.length
        ? await transaction
            .selectFrom("runs")
            .selectAll()
            .where(
              "id",
              "in",
              scope.runs.map(({ id }) => id),
            )
            .orderBy("id")
            .forNoKeyUpdate()
            .execute()
        : [];
      await admitThreadWrite(transaction, input);
      const workspaceThreads = [
        ...new Set([
          ...scope.threadIds,
          ...scope.assignments.map(({ parentThreadId }) => parentThreadId),
          ...runs.map(({ threadId }) => threadId),
        ]),
      ];
      const workspaceRows = await transaction
        .selectFrom("threads")
        .select("workspaceId")
        .where("id", "in", workspaceThreads)
        .execute();
      const workspaces = await transaction
        .selectFrom("workspaces")
        .select(["id", "homeThreadId"])
        .where("id", "in", [
          ...new Set([
            ...workspaceRows.map(({ workspaceId }) => workspaceId),
            ...scope.requests.map(({ originatingWorkspaceId }) => originatingWorkspaceId),
          ]),
        ])
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      const observed = await transaction
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", input.threadId)
        .executeTakeFirst();
      if (!observed) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
      await requireActiveWorkspaceMembership(
        transaction,
        observed.workspaceId,
        input.requestedBy,
        true,
      );
      await lockThreadChannelAuthorities(transaction, scope.threadIds);
      // Active bindings must not rotate into this set while scope is checked.
      const channelContexts = await transaction
        .selectFrom("channelConversationContexts")
        .selectAll()
        .where("activeThreadId", "in", scope.threadIds)
        .orderBy("conversationId")
        .orderBy("authorityUserId")
        .forNoKeyUpdate()
        .execute();
      const threads = await transaction
        .selectFrom("threads")
        .selectAll()
        .where("id", "in", scope.threadIds)
        .orderBy("id")
        .forNoKeyUpdate()
        .execute();
      const thread = threads.find(({ id }) => id === input.threadId)!;
      await requireThreadWriteAuthority(transaction, thread, input, input.done ? "done" : "reopen");
      if (
        threads.some(
          (row) =>
            row.role !== "work" ||
            workspaces.some(({ homeThreadId }) => homeThreadId === row.id) ||
            channelContexts.some(({ activeThreadId }) => activeThreadId === row.id),
        )
      )
        throw new OpensteerError({
          code: "bad_request",
          message: "Chat and active channel conversations cannot be Done",
        });
      const triggers = scope.triggers.length
        ? await transaction
            .selectFrom("triggers")
            .selectAll()
            .where(
              "id",
              "in",
              scope.triggers.map(({ id }) => id),
            )
            .orderBy("id")
            .forNoKeyUpdate()
            .execute()
        : [];
      if (triggers.length)
        await transaction
          .selectFrom("triggerWatchActivations")
          .select("id")
          .where(
            "triggerId",
            "in",
            triggers.map(({ id }) => id),
          )
          .orderBy("id")
          .forNoKeyUpdate()
          .execute();
      await lockRunProjectionRows(transaction, {
        runIds: runs.map(({ id }) => id),
        threadIds: scope.threadIds,
        assignmentIds: scope.assignments.map(({ id }) => id),
        requestIds: scope.requests.map(({ id }) => id),
      });
      if (!isDeepStrictEqual(scope, await discoverDoneScope(transaction, input)))
        throw new TransactionScopeChanged("Task changed while being marked Done");
      const events: AgentEvent[] = [];
      const interruptCommands = [];
      let doneWhenRunEnds = false;
      const now = new Date();
      if (!existing) {
        const self =
          input.done &&
          runs.find((run) => run.id === input.actorRunId && run.threadId === input.threadId);
        if (self) {
          await transaction
            .updateTable("runs")
            .set({ doneWhenFinished: true })
            .where("id", "=", self.id)
            .execute();
          doneWhenRunEnds = true;
        } else {
          // Reopen withdraws this task's own pending self-Done; the calling
          // Run, locked above only to authorize it, keeps its intent.
          const reopened = runs.filter(({ threadId }) => threadId === input.threadId);
          if (!input.done && reopened.length)
            await transaction
              .updateTable("runs")
              .set({ doneWhenFinished: false })
              .where(
                "id",
                "in",
                reopened.map(({ id }) => id),
              )
              .execute();
          for (const row of threads) {
            if (input.done) {
              await transaction
                .updateTable("threads")
                .set({
                  doneAt: row.doneAt ?? now,
                  inputQueuePaused: false,
                  inputQueuePausedBy: null,
                })
                .where("id", "=", row.id)
                .execute();
            } else
              await transaction
                .updateTable("threads")
                .set({ doneAt: null })
                .where("id", "=", row.id)
                .execute();
          }
          if (input.done) {
            for (const trigger of triggers) await pauseTriggerInTransaction(transaction, trigger);
            const cancelledAssignments = await cancelAssignmentRowsInTransaction(
              transaction,
              scope.assignments.map(({ id }) => id),
              now,
            );
            const cancelledInputs = await transaction
              .updateTable("threadInputs")
              .set({ state: "cancelled", cancelReason: "task-done", updatedAt: now })
              .where("threadId", "in", scope.threadIds)
              .where("state", "in", ["pending", "claimed"])
              .where("policy", "<>", "report")
              .returningAll()
              .execute();
            for (const row of cancelledInputs) {
              const owner = threads.find(({ id }) => id === row.threadId)!;
              events.push(
                await appendHostWorkspaceEvent(transaction, {
                  data: { input: threadInputFromRow(row) },
                  environmentId: owner.environmentId,
                  workspaceId: owner.workspaceId,
                  threadId: owner.id,
                  runId: null,
                  type: "thread-input.updated",
                }),
              );
            }
            events.push(
              ...(await cancelPending(transaction, {
                reason: "thread-archived",
                resolvedAt: now,
                requestIds: scope.requests.map(({ id }) => id),
              })),
            );
            for (const assignment of cancelledAssignments)
              events.push(
                ...(await assignmentEventsInTransaction(
                  transaction,
                  assignment,
                  "assignment.updated",
                )),
              );
            for (const run of runs) {
              if (
                !scope.threadIds.includes(run.threadId) ||
                !nonTerminalRunStatuses.some((status) => status === run.status)
              )
                continue;
              if (
                run.status === "queued" ||
                (run.status === "starting" && run.bindingGeneration === null)
              ) {
                events.push(
                  ...(await finalizeRunTransaction(transaction, {
                    completedAt: now,
                    links,
                    runId: run.id,
                    source: "host",
                    status: "interrupted",
                    queuedInputCancellation: "activation-input",
                    requestCancellationReason: "thread-archived",
                  })),
                );
              } else {
                interruptCommands.push(
                  await persistRunnerControlCommand(transaction, {
                    id: createId("command"),
                    actorPrincipalId: await principalIdForUser(transaction, input.requestedBy),
                    authoritySource: jsonValue({ kind: "user-session", userId: input.requestedBy }),
                    dispatcherId: null,
                    environmentId: run.environmentId,
                    idempotencyKey: `task-done:${input.idempotencyKey}:${run.id}`,
                    lastError: null,
                    payload: jsonValue({
                      type: "run.interrupt",
                      runId: run.id,
                      threadId: run.threadId,
                    }),
                    requestedBy: input.requestedBy,
                    runId: run.id,
                    status: "pending",
                    threadId: run.threadId,
                    type: "run.interrupt",
                  }),
                );
              }
            }
          }
          for (const row of threads) {
            events.push(...(await projectThreadState(transaction, row.id, now)));
            events.push(await appendDoneState(transaction, row.id));
          }
        }
        await transaction
          .insertInto("commands")
          .values({
            id: createId("command"),
            actorPrincipalId: await principalIdForUser(transaction, input.requestedBy),
            authoritySource: jsonValue({ kind: "user-session", userId: input.requestedBy }),
            dispatcherId: null,
            environmentId: thread.environmentId,
            idempotencyKey: input.idempotencyKey,
            lastError: null,
            payload: jsonValue(payload),
            requestedBy: input.requestedBy,
            runId: input.actorRunId ?? null,
            status: "succeeded",
            threadId: thread.id,
            type: "thread.shared-done.set",
          })
          .execute();
      } else
        doneWhenRunEnds = runs.some((run) => run.id === input.actorRunId && run.doneWhenFinished);
      const revokedGrants =
        !existing && input.done && !doneWhenRunEnds
          ? await revokeRunGrants(
              transaction,
              runs.filter((run) => scope.threadIds.includes(run.threadId)).map(({ id }) => id),
              "stopped",
            )
          : [];
      const current = await transaction
        .selectFrom("threads")
        .selectAll()
        .select([
          threadPendingRequestsSelection,
          threadProviderSessionSelection,
          threadContinuationIdentitySelection,
        ])
        .where("id", "=", thread.id)
        .executeTakeFirstOrThrow();
      const head = await transaction
        .selectFrom("workspaces")
        .select("eventSequence")
        .where("id", "=", thread.workspaceId)
        .executeTakeFirstOrThrow();
      return {
        asOfSequence: SequenceSchema.parse(head.eventSequence),
        thread: threadFromRow(current),
        events,
        interruptCommands,
        revokedGrants,
        wasDuplicate: !!existing,
        doneWhenRunEnds,
      };
    },
    undefined,
    (error) => error instanceof TransactionScopeChanged,
  );
}

export async function appendDoneState(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
): Promise<AgentEvent> {
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  return appendHostWorkspaceEvent(transaction, {
    data: {
      status: thread.status,
      title: thread.title,
      icon: thread.icon,
      doneAt: thread.doneAt?.toISOString() ?? null,
      inputQueuePaused: thread.inputQueuePaused,
      pendingRequests: thread.pendingRequestCount,
    },
    environmentId: thread.environmentId,
    workspaceId: thread.workspaceId,
    threadId,
    runId: null,
    type: "thread.state-changed",
  });
}

export async function admitThreadWrite(
  transaction: Transaction<DatabaseSchema>,
  input: ThreadWriteActor & { readonly admission?: AgentControlAdmissionInput },
): Promise<void> {
  if (!input.admission) return;
  if (
    input.admission.runId !== input.actorRunId ||
    input.admission.action !== "thread.write" ||
    input.admission.requestedBy !== input.requestedBy
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Thread write admission disagrees with Run",
    });
  }
  await admitAgentControlRequestInTransaction(transaction, input.admission);
}

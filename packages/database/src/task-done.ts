import { withPersonalTransaction } from "./personal-transaction.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import {
  lockThreadCaller,
  assertThreadCaller,
  type ThreadCallerAuthority,
} from "./thread-caller.js";
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
import { TransactionScopeChanged } from "./connection.js";
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
import { appendHostDeploymentEvent } from "./deployment-events.js";
import {
  idempotencyConflict,
  jsonValue,
  lockCommandIdempotency,
  principalIdForUser,
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
import { admitRunToolCallInTransaction, type RunToolAdmissionInput } from "./run-tool-admission.js";
import { threadIsQuiet } from "./quiet-tasks.js";
export interface ThreadWriteActor {
  readonly authority?: ThreadCallerAuthority;
  readonly requestedBy: UserId;
  readonly actorRunId?: RunId;
}

export async function requireThreadWriteAuthority(
  transaction: Transaction<DatabaseSchema>,
  thread: Pick<ThreadRow, "id" | "createdBy">,
  actor: ThreadWriteActor,
  _action: "rename" | "set_icon" | "done" | "reopen",
): Promise<void> {
  await requirePersonalOwner(transaction, actor.requestedBy);
  await assertThreadCaller(transaction, actor.authority, {
    threadId: thread.id,
  });
  if (actor.actorRunId) {
    const run = await transaction
      .selectFrom("runs")
      .select(["requestedBy", "status"])
      .where("id", "=", actor.actorRunId)
      .executeTakeFirst();
    if (
      !run ||
      run.requestedBy !== actor.requestedBy ||
      !nonTerminalRunStatuses.some((status) => status === run.status)
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Writing Run is no longer active",
      });
  }
}
export interface SetThreadDoneInput extends ThreadWriteActor {
  readonly done: boolean;
  readonly idempotencyKey: string;
  readonly threadId: ThreadId;
  readonly admission?: RunToolAdmissionInput;
  /**
   * The Host moving a quiet task to Done for its creator: it happens only if
   * the task is still quiet once every lock is held, and otherwise changes and
   * records nothing, so a later pass may try again.
   */
  readonly quiet?: true;
}

/** The open Assignments a task serves or handed out, and every open one beneath them. */
async function openDoneAssignments(database: Kysely<DatabaseSchema>, threadId: ThreadId) {
  return (
    await sql<{
      id: AssignmentId;
      childThreadId: ThreadId;
      parentThreadId: ThreadId;
    }>`
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
    .select(["id"])
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
  return {
    assignments,
    threadIds,
    runs,
    triggers,
    requests,
    inputs,
  };
}
export async function setThreadDone(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: SetThreadDoneInput,
) {
  return withPersonalTransaction(
    database,
    async (transaction) => {
      await lockCommandIdempotency(transaction, input.requestedBy, input.idempotencyKey);
      const payload = {
        threadId: input.threadId,
        done: input.done,
        ...(input.actorRunId
          ? {
              actorRunId: input.actorRunId,
            }
          : {}),
        ...(input.quiet
          ? {
              quiet: true,
            }
          : {}),
      };
      const existing = await transaction
        .selectFrom("commands")
        .selectAll()
        .where("requestedBy", "=", input.requestedBy)
        .where("idempotencyKey", "=", input.idempotencyKey)
        .executeTakeFirst();
      if (
        existing &&
        (existing.type !== "thread.done.set" || !isDeepStrictEqual(existing.payload, payload))
      )
        throw idempotencyConflict(input.idempotencyKey);
      const scope = await discoverDoneScope(transaction, input);
      await lockThreadCaller(
        transaction,
        input.authority,
        scope.runs.map((run) => run.id),
      );
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
      const observed = await transaction
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", input.threadId)
        .executeTakeFirst();
      if (!observed)
        throw new OpensteerError({
          code: "not_found",
          message: "Thread not found",
        });
      await lockThreadChannelAuthorities(transaction, scope.threadIds);
      // Active bindings must not rotate into this set while scope is checked.
      await transaction
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
      const stillQuiet =
        !input.quiet ||
        (input.done && !input.actorRunId && (await threadIsQuiet(transaction, thread.id, now)));
      const authoritySource = jsonValue(
        input.quiet
          ? {
              kind: "quiet-tasks",
              userId: input.requestedBy,
            }
          : {
              kind: "user-session",
              userId: input.requestedBy,
            },
      );
      if (!existing && stillQuiet) {
        const self =
          input.done &&
          runs.find((run) => run.id === input.actorRunId && run.threadId === input.threadId);
        if (self) {
          await transaction
            .updateTable("runs")
            .set({
              doneWhenFinished: true,
            })
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
              .set({
                doneWhenFinished: false,
              })
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
                  doneReason: row.doneAt ? row.doneReason : input.quiet ? "quiet" : null,
                  inputQueuePaused: false,
                  inputQueuePausedBy: null,
                })
                .where("id", "=", row.id)
                .execute();
            } else
              await transaction
                .updateTable("threads")
                .set({
                  doneAt: null,
                  doneReason: null,
                })
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
              .set({
                state: "cancelled",
                cancelReason: "task-done",
                updatedAt: now,
              })
              .where("threadId", "in", scope.threadIds)
              .where("state", "in", ["pending", "claimed"])
              .where("policy", "<>", "report")
              .returningAll()
              .execute();
            for (const row of cancelledInputs) {
              const owner = threads.find(({ id }) => id === row.threadId)!;
              events.push(
                await appendHostDeploymentEvent(transaction, {
                  data: {
                    input: threadInputFromRow(row),
                  },
                  environmentId: owner.environmentId,
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
                    authoritySource,
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
            authoritySource,
            dispatcherId: null,
            environmentId: thread.environmentId,
            idempotencyKey: input.idempotencyKey,
            lastError: null,
            payload: jsonValue(payload),
            requestedBy: input.requestedBy,
            runId: input.actorRunId ?? null,
            status: "succeeded",
            threadId: thread.id,
            type: "thread.done.set",
          })
          .execute();
      } else
        doneWhenRunEnds = runs.some((run) => run.id === input.actorRunId && run.doneWhenFinished);
      const revokedGrants =
        !existing && stillQuiet && input.done && !doneWhenRunEnds
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
        .selectFrom("deploymentEventState")
        .select("sequence")
        .executeTakeFirstOrThrow();
      return {
        asOfSequence: SequenceSchema.parse(head.sequence),
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
  return appendHostDeploymentEvent(transaction, {
    data: {
      status: thread.status,
      title: thread.title,
      icon: thread.icon,
      doneAt: thread.doneAt?.toISOString() ?? null,
      doneReason: thread.doneReason,
      inputQueuePaused: thread.inputQueuePaused,
      pendingRequests: thread.pendingRequestCount,
    },
    environmentId: thread.environmentId,
    threadId,
    runId: null,
    type: "thread.state-changed",
  });
}
export async function admitThreadWrite(
  transaction: Transaction<DatabaseSchema>,
  input: ThreadWriteActor & {
    readonly threadId: ThreadId;
    readonly admission?: RunToolAdmissionInput;
  },
): Promise<void> {
  await assertThreadCaller(transaction, input.authority, {
    threadId: input.threadId,
  });
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
  await admitRunToolCallInTransaction(transaction, input.admission);
}

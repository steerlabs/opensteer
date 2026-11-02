import { recoverLostRunTransaction } from "./run-recovery.js";
import { isPlaceContentPart } from "@opensteer/core";
import { isRecord } from "@opensteer/shared/isRecord";
import { lockRunProjectionRows } from "./run-projection-locks.js";
import { isConstraintViolation, withDatabaseTransaction } from "./connection.js";
import { type WorkspaceEventRow, type RunRow, type DatabaseSchema } from "./schema.js";
import { type PendingAgentEvent, PendingAgentEventSchema } from "@opensteer/protocol";
import {
  type EnvironmentId,
  type RunnerId,
  OpensteerError,
  type AgentEvent,
  MessageAuthorSchema,
  ReplyTargetSchema,
  type IntegrationCallSubject,
  IntegrationCallSubjectSchema,
  createId,
  runBackgroundMaxMs,
} from "@opensteer/core";
import { isDeepStrictEqual } from "node:util";
import { type Transaction, sql, type Kysely } from "kysely";
import {
  type ChannelLinks,
  systemPrincipalId,
  jsonValue,
  eventFromRow,
  lockThreadRow,
} from "./store-primitives.js";
import { appendHostWorkspaceEvent, stampRunContext } from "./workspace-events.js";
import { messageFromRow, runUsageFromRow, threadInputFromRow } from "./thread-row-mappers.js";
import { markThreadStatePending, projectThreadState } from "./thread-status.js";
import { finalizeRunTransaction } from "./run-finalization.js";
import {
  runAssignmentAcceptsRequests,
  assignmentActivityEventsForRun,
} from "./assignment-store.js";
import { requestInsert, cancelPending } from "./request-store.js";
import { enqueueChannelConversationStatus, enqueueChannelReply } from "./channel-deliveries.js";
import { assertActiveExecutionBinding as assertActiveExecutionBindingInStore } from "./execution-authority.js";
import { runReply } from "./run-reply.js";
import { runHasActiveGrant, runWasStopped, type RevokedRunGrant } from "./run-grants.js";
import { deliverConversationInputsInTransaction } from "./thread-inbox.js";
import {
  completeExecutionNode,
  endLiveExecutionNodes,
  requireRunNode,
  startExecutionNode,
  updateExecutionNode,
} from "./execution-nodes.js";
import {
  attemptForBinding,
  currentRunAttempt,
  endAttempt,
  markAttemptStarted,
  recordAttemptUsage,
  type RunAttemptRow,
} from "./run-attempts.js";

function isExactRunnerEventReplay(
  row: WorkspaceEventRow,
  event: PendingAgentEvent,
  input: {
    readonly environmentId: EnvironmentId;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  },
): boolean {
  return (
    row.runId === event.runId &&
    row.runnerOrdinal === event.ordinal &&
    row.runnerId === input.runnerId &&
    row.runnerBootId === input.runnerBootId &&
    row.runnerBindingGeneration === event.bindingGeneration &&
    row.environmentId === input.environmentId &&
    row.threadId === event.threadId &&
    row.workspaceId === event.workspaceId &&
    row.type === event.type &&
    row.createdAt.getTime() === Date.parse(event.emittedAt) &&
    isDeepStrictEqual(runnerReportedData(row), event.data)
  );
}

/**
 * A stored Runner event's data less what the Host added when it committed it:
 * an integration call's subject, or which message was a turn's or a completed
 * Run's reply.
 */
function runnerReportedData(row: WorkspaceEventRow): unknown {
  const hostKey =
    row.type === "tool.started"
      ? "integration"
      : row.type === "run.completed" || row.type === "run.phase"
        ? "replyMessageId"
        : null;
  if (typeof row.data !== "object" || row.data === null) return row.data;
  return Object.fromEntries(
    Object.entries(row.data).filter(
      ([key]) => key !== hostKey && !["startedBy", "startedAt", "personWaiting"].includes(key),
    ),
  );
}

function assertRunnerEventTransition(
  run: Pick<RunRow, "harnessInstanceId" | "nextRunnerOrdinal" | "requestedBy" | "status">,
  event: PendingAgentEvent,
): void {
  if (event.ordinal !== run.nextRunnerOrdinal) {
    throw new OpensteerError({
      code: "conflict",
      message: `Runner event ordinal ${event.ordinal} is out of sequence; expected ${run.nextRunnerOrdinal}`,
    });
  }

  let valid = false;
  switch (event.type) {
    case "run.started":
      valid = run.status === "starting";
      break;
    case "run.completed":
      valid = run.status === "running" || run.status === "waiting";
      break;
    case "run.failed":
    case "run.interrupted":
      valid = run.status === "starting" || run.status === "running" || run.status === "waiting";
      break;
    case "request.opened": {
      if (
        event.data.request.originatingRunId !== event.runId ||
        event.data.request.requestedBy !== run.requestedBy
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Harness Request does not match the Run's authority binding",
        });
      }
      valid = run.status === "running" || run.status === "waiting";
      break;
    }
    case "run.status":
      valid =
        (run.status === "running" || run.status === "waiting") &&
        (event.data.status === "running" || event.data.status === "waiting");
      break;
    case "message.injected":
      valid = run.status === "running";
      break;
    default:
      valid = run.status === "running" || run.status === "waiting";
      break;
  }
  if (!valid) {
    throw new OpensteerError({
      code: "conflict",
      message: `Runner event ${event.type} is invalid while the Run is ${run.status}`,
    });
  }
}

interface EventProjection {
  readonly compensatingEvents: readonly AgentEvent[];
  /** A restart that took the person's waiting messages ended the attempt's tools. */
  readonly revokedGrants: readonly RevokedRunGrant[];
  /**
   * A second `run.usage` arrived for a Run that already has one. The first
   * statement stands; the caller reports the conflict rather than failing the
   * Runner's delivery over a fact nobody is waiting on.
   */
  readonly duplicateRunUsage: boolean;
}

async function applyEventProjection(
  transaction: Transaction<DatabaseSchema>,
  event: PendingAgentEvent,
  links: ChannelLinks,
  attempt: RunAttemptRow | undefined,
): Promise<EventProjection> {
  let canonicalMessageEvent: AgentEvent | null = null;
  let duplicateRunUsage = false;
  let revokedGrants: readonly RevokedRunGrant[] = [];
  if (event.type === "assistant.message") {
    if (event.data.content.some(isPlaceContentPart)) {
      throw new OpensteerError({
        code: "bad_request",
        message:
          "An assistant reply cannot attach place references. Forward selected places through delegation.",
      });
    }

    if (!event.runId) {
      throw new OpensteerError({ code: "conflict", message: "Assistant message has no Run" });
    }
    // A Run's actor is its authority principal, not the assistant's identity.
    const assistantPrincipal = await transaction
      .selectFrom("principals")
      .select("displayName")
      .where("id", "=", systemPrincipalId)
      .where("kind", "=", "system")
      .executeTakeFirstOrThrow();
    const runContext = await transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .innerJoin("workspaces", "workspaces.id", "threads.workspaceId")
      .select([
        "runs.actorPrincipalId",
        "threads.id as threadId",
        "threads.nextMessageSequence",
        "threads.workspaceId",
        "workspaces.name as workspaceName",
      ])
      .where("runs.id", "=", event.runId)
      .forNoKeyUpdate("threads")
      .executeTakeFirstOrThrow();
    const messageRow = await transaction
      .insertInto("messages")
      .values({
        actorPrincipalId: runContext.actorPrincipalId,
        author: jsonValue(
          MessageAuthorSchema.parse({
            displayName: assistantPrincipal.displayName,
            kind: "agent",
            runId: event.runId,
            threadId: runContext.threadId,
            workspaceId: runContext.workspaceId,
            workspaceName: runContext.workspaceName,
          }),
        ),
        content: jsonValue(event.data.content),
        id: event.data.messageId,
        kind: "assistant",
        runId: event.runId,
        sequence: runContext.nextMessageSequence,
        threadId: event.threadId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("threads")
      .set({ nextMessageSequence: sql`next_message_sequence + 1`, updatedAt: new Date() })
      .where("id", "=", event.threadId)
      .executeTakeFirstOrThrow();
    canonicalMessageEvent = await appendHostWorkspaceEvent(transaction, {
      data: { input: null, message: messageFromRow(messageRow) },
      environmentId: event.environmentId,
      runId: event.runId,
      threadId: event.threadId,
      type: "message.created",
      workspaceId: event.workspaceId,
    });
  }

  const now = new Date(event.emittedAt);
  const compensatingEvents: AgentEvent[] = canonicalMessageEvent ? [canonicalMessageEvent] : [];
  switch (event.type) {
    case "request.cancelled": {
      const pendingRequest = await transaction
        .selectFrom("requests")
        .select(["id", "responseCommandId"])
        .where("id", "=", event.data.requestId)
        .where("originatingThreadId", "=", event.threadId)
        .where("originatingRunId", "=", event.runId)
        .where("mode", "=", "live")
        .where("status", "=", "pending")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!pendingRequest) break;
      if (pendingRequest.responseCommandId) {
        const responseCommand = await transaction
          .selectFrom("commands")
          .select("status")
          .where("id", "=", pendingRequest.responseCommandId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        // A committed Runner acknowledgement is the only proof that the user
        // response won. Otherwise the provider's ordered cancellation wins and
        // terminalizes the reserved command with the Request.
        if (responseCommand?.status === "succeeded") break;
        await transaction
          .updateTable("commands")
          .set({
            lastError: jsonValue({ message: "The provider cancelled this Request" }),
            status: "failed",
            updatedAt: now,
          })
          .where("id", "=", pendingRequest.responseCommandId)
          .where("status", "in", ["pending", "dispatched", "unknown"])
          .execute();
      }
      const cancelled = await transaction
        .updateTable("requests")
        .set({
          cancellationReason: event.data.reason,
          resolvedAt: now,
          resolvedBy: null,
          responseCommandId: null,
          status: "cancelled",
        })
        .where("id", "=", event.data.requestId)
        .where("originatingThreadId", "=", event.threadId)
        .where("originatingRunId", "=", event.runId)
        .where("mode", "=", "live")
        .where("status", "=", "pending")
        .returningAll()
        .executeTakeFirst();
      if (!cancelled) break;
      const anotherLiveRequest = event.runId
        ? await transaction
            .selectFrom("requests")
            .select("id")
            .where("originatingRunId", "=", event.runId)
            .where("mode", "=", "live")
            .where("status", "=", "pending")
            .executeTakeFirst()
        : null;
      const resumedStatus = anotherLiveRequest ? "waiting" : "running";
      if (event.runId) {
        await transaction
          .updateTable("runs")
          .set({ status: resumedStatus })
          .where("id", "=", event.runId)
          .where("status", "in", ["running", "waiting"])
          .execute();
        if (resumedStatus === "running") {
          const handed = await deliverConversationInputsInTransaction(transaction, event.runId);
          compensatingEvents.push(...handed.events);
          revokedGrants = handed.revokedGrants;
        }
      }
      break;
    }
    case "message.injected":
      await transaction
        .selectFrom("commands")
        .select("id")
        .where("id", "in", (query) =>
          query
            .selectFrom("threadInputs")
            .select("steerCommandId")
            .where("messageId", "=", event.data.messageId)
            .where("runId", "=", event.runId)
            .where("steerCommandId", "is not", null),
        )
        .orderBy("id", "asc")
        .forNoKeyUpdate()
        .execute();
      const injected = await transaction
        .updateTable("threadInputs")
        .set({ deliveredAt: now, state: "delivered", updatedAt: now })
        .where("messageId", "=", event.data.messageId)
        .where("runId", "=", event.runId)
        .where("state", "in", ["claimed", "unknown"])
        .returningAll()
        .executeTakeFirst();
      if (injected?.steerCommandId) {
        await transaction
          .updateTable("commands")
          .set({ status: "succeeded", updatedAt: now })
          .where("id", "=", injected.steerCommandId)
          .where("status", "in", ["pending", "dispatched", "unknown"])
          .execute();
      }
      if (injected) {
        compensatingEvents.push(
          await appendHostWorkspaceEvent(transaction, {
            data: { input: threadInputFromRow(injected) },
            environmentId: event.environmentId,
            runId: event.runId,
            threadId: event.threadId,
            type: "thread-input.updated",
            workspaceId: event.workspaceId,
          }),
        );
      }
      break;
    case "run.started":
      await transaction
        .updateTable("providerSessions")
        .set({ status: "running", updatedAt: now })
        .where("id", "=", (builder) =>
          builder.selectFrom("runs").select("providerSessionId").where("id", "=", event.runId!),
        )
        .where("active", "=", true)
        .where("bindingGeneration", "=", event.bindingGeneration)
        .execute();
      if (event.runId) {
        await transaction
          .updateTable("runs")
          .set({ startedAt: sql`coalesce(started_at, ${now})`, status: "running" })
          .where("id", "=", event.runId)
          .execute();
        // The attempt's start delivers its fixed batch: a first attempt's
        // claimed work, or the messages a restart was started with.
        const fixedBatch = await transaction
          .selectFrom("threadInputs")
          .innerJoin("messages", "messages.id", "threadInputs.messageId")
          .leftJoin("commands", "commands.id", "threadInputs.steerCommandId")
          .select("threadInputs.messageId")
          .where("threadInputs.runId", "=", event.runId)
          .where((expression) =>
            expression.or([
              expression("threadInputs.steerCommandId", "is", null),
              expression("commands.type", "=", "run.restart"),
            ]),
          )
          .where("threadInputs.state", "=", "claimed")
          .orderBy("messages.sequence", "asc")
          .execute();
        const deliveredRows =
          fixedBatch.length === 0
            ? []
            : await transaction
                .updateTable("threadInputs")
                .set({ deliveredAt: now, state: "delivered", updatedAt: now })
                .where(
                  "messageId",
                  "in",
                  fixedBatch.map(({ messageId }) => messageId),
                )
                .where("state", "=", "claimed")
                .returningAll()
                .execute();
        const deliveredById = new Map(deliveredRows.map((row) => [row.messageId, row]));
        for (const { messageId } of fixedBatch) {
          const row = deliveredById.get(messageId);
          if (!row) continue;
          compensatingEvents.push(
            await appendHostWorkspaceEvent(transaction, {
              data: { input: threadInputFromRow(row) },
              environmentId: event.environmentId,
              runId: event.runId,
              threadId: event.threadId,
              type: "thread-input.updated",
              workspaceId: event.workspaceId,
            }),
          );
        }
        // What the person wrote while the engine was starting is the started
        // turn's to take now.
        const handed = await deliverConversationInputsInTransaction(transaction, event.runId);
        compensatingEvents.push(...handed.events);
        revokedGrants = handed.revokedGrants;
      }
      compensatingEvents.push(...(await projectThreadState(transaction, event.threadId, now)));
      break;
    case "run.status":
      const liveRequest =
        event.runId && event.data.status === "running"
          ? await transaction
              .selectFrom("requests")
              .select("id")
              .where("originatingRunId", "=", event.runId)
              .where("mode", "=", "live")
              .where("status", "=", "pending")
              .executeTakeFirst()
          : null;
      const projectedStatus = liveRequest ? "waiting" : event.data.status;
      if (event.runId) {
        await transaction
          .updateTable("runs")
          .set({ status: projectedStatus })
          .where("id", "=", event.runId)
          .execute();
      }
      compensatingEvents.push(...(await projectThreadState(transaction, event.threadId, now)));
      break;
    case "run.completed":
    case "run.interrupted":
      if (event.runId) {
        const status = event.type === "run.completed" ? "completed" : "interrupted";
        compensatingEvents.push(
          ...(await finalizeRunTransaction(transaction, {
            completedAt: now,
            links,
            source: "runner",
            queuedInputCancellation: "seed-input",
            runId: event.runId,
            status,
          })),
        );
      }
      break;
    case "run.failed":
      if (event.runId) {
        compensatingEvents.push(
          ...(await finalizeRunTransaction(transaction, {
            completedAt: now,
            failure: event.data,
            links,
            source: "runner",
            queuedInputCancellation: "seed-input",
            runId: event.runId,
            status: "failed",
          })),
        );
      }
      break;
    case "request.opened":
      if (
        event.data.request.originatingWorkspaceId !== event.workspaceId ||
        event.data.request.originatingThreadId !== event.threadId ||
        event.data.request.originatingRunId !== event.runId ||
        event.data.request.targetWorkspaceId !== event.workspaceId ||
        event.data.request.mode !== "live"
      ) {
        throw new OpensteerError({ code: "conflict", message: "Harness Request scope is invalid" });
      }
      if (event.data.request.originatingNodeId) {
        await requireRunNode(transaction, event.runId, event.data.request.originatingNodeId);
      }
      // The Runner's event stream must keep moving, so an ask from a stopped
      // Run or task is recorded and cancelled at once instead of refused.
      const accepted =
        !event.runId ||
        ((await runHasActiveGrant(transaction, event.runId)) &&
          (await runAssignmentAcceptsRequests(transaction, event.runId)));
      await transaction
        .insertInto("requests")
        .values(requestInsert(event.data.request))
        .executeTakeFirstOrThrow();
      if (!accepted) {
        compensatingEvents.push(
          ...(await cancelPending(transaction, {
            reason: "source-closed",
            requestIds: [event.data.request.id],
            resolvedAt: now,
          })),
        );
        break;
      }
      if (event.runId) {
        await transaction
          .updateTable("runs")
          .set({ status: "waiting" })
          .where("id", "=", event.runId)
          .execute();
        // The Request insert above is this transaction's unique key, so the
        // notice is written exactly once per Request rather than once per
        // delivery attempt of the event that opened it.
        const waiting = await transaction
          .selectFrom("runs")
          .select("replyTarget")
          .where("id", "=", event.runId)
          .executeTakeFirst();
        const replyTarget = waiting?.replyTarget
          ? ReplyTargetSchema.parse(waiting.replyTarget)
          : null;
        if (replyTarget) {
          await enqueueChannelConversationStatus(transaction, {
            conversationId: replyTarget.conversationId,
            text: `The agent needs your input before it can continue. Open the Thread in Opensteer: ${links.threadUrl(event.threadId)}`,
          });
        }
      }
      break;
    case "run.phase":
      compensatingEvents.push(...(await projectRunPhase(transaction, event, links)));
      break;
    case "node.started":
      await startExecutionNode(transaction, {
        attemptId: (attempt ?? (await currentRunAttempt(transaction, event.runId))).id,
        node: event.data,
        runId: event.runId,
        startedAt: now,
      });
      break;
    case "node.updated":
      await updateExecutionNode(transaction, event.runId, event.data);
      break;
    case "node.completed":
      await completeExecutionNode(transaction, {
        completion: event.data,
        endedAt: now,
        runId: event.runId,
      });
      break;
    case "tool.started":
    case "tool.completed":
      if (event.data.nodeId) await requireRunNode(transaction, event.runId, event.data.nodeId);
      break;
    case "run.usage":
      if (event.runId) {
        // The Run row is already held FOR NO KEY UPDATE by the caller, so the
        // write is the whole conflict check: it lands only while this attempt
        // has no usage recorded yet.
        duplicateRunUsage = !(await recordAttemptUsage(transaction, {
          attemptId: (attempt ?? (await currentRunAttempt(transaction, event.runId))).id,
          runId: event.runId,
          usage: event.data,
        }));
      }
      break;
    default:
      break;
  }
  return { compensatingEvents, duplicateRunUsage, revokedGrants };
}

/**
 * A turn ended with background work still running, or another turn began in
 * the same Run. A channel hears each turn's reply when that turn ends, once,
 * rather than only when the Run does. The background deadline is set the
 * first time and never moved.
 */
async function projectRunPhase(
  transaction: Transaction<DatabaseSchema>,
  event: Extract<PendingAgentEvent, { readonly type: "run.phase" }>,
  links: ChannelLinks,
): Promise<readonly AgentEvent[]> {
  const background = event.data.phase === "background";
  const run = await transaction
    .selectFrom("runs")
    .select(["backgroundDeadlineAt", "replyTarget", "threadId", "turnReplyMessageId"])
    .where("id", "=", event.runId)
    .executeTakeFirstOrThrow();
  const replyTarget = run.replyTarget ? ReplyTargetSchema.parse(run.replyTarget) : null;
  const reply =
    background && replyTarget
      ? await runReply(transaction, { id: event.runId, threadId: run.threadId })
      : null;
  const deliver = reply !== null && reply.id !== run.turnReplyMessageId;
  await transaction
    .updateTable("runs")
    .set({
      phase: event.data.phase,
      ...(background && run.backgroundDeadlineAt === null
        ? { backgroundDeadlineAt: new Date(Date.now() + runBackgroundMaxMs) }
        : {}),
      ...(deliver ? { turnReplyMessageId: reply.id } : {}),
    })
    .where("id", "=", event.runId)
    .execute();
  if (deliver && replyTarget) {
    await enqueueChannelReply(transaction, {
      content: reply.content,
      conversationId: replyTarget.conversationId,
      links,
      messageId: reply.id,
      threadId: run.threadId,
    });
  }
  return [];
}

/**
 * The same JSON value as PostgreSQL can store it. jsonb refuses half of a
 * surrogate pair and U+0000 in any text, keys included: the one is made
 * well-formed and the other becomes U+FFFD, as in tool output.
 */
function storableJson<Value>(value: Value): Value {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "string") return storableText(item);
      if (!isRecord(item)) return item;
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [storableText(key), entry]),
      );
    }),
  ) as Value;
}

export function storableText(text: string): string {
  return text.toWellFormed().replaceAll("\u0000", "\uFFFD");
}

async function latestRunEvent(
  transaction: Transaction<DatabaseSchema>,
  runId: RunRow["id"],
): Promise<AgentEvent> {
  return eventFromRow(
    await transaction
      .selectFrom("workspaceEvents")
      .selectAll()
      .where("runId", "=", runId)
      .orderBy("sequence", "desc")
      .limit(1)
      .executeTakeFirstOrThrow(),
  );
}

/**
 * An event from an attempt a restart superseded, which the Runner sends until
 * the interruption lands. Its ordinal is consumed so the stream keeps moving,
 * but nothing it reports reaches the Run, except what it consumed. Its
 * interruption is the restart's cue: the Run goes back to its queue with a
 * new `run.execute`, whose attempt starts with the messages steered into it.
 */
async function commitSupersededAttemptEvent(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly attempt: RunAttemptRow;
    readonly event: PendingAgentEvent;
    readonly run: RunRow;
  },
): Promise<{
  readonly compensatingEvents: readonly AgentEvent[];
  readonly duplicateRunUsage: boolean;
  readonly event: AgentEvent;
  readonly revokedGrants: readonly RevokedRunGrant[];
  readonly wasDuplicate: boolean;
}> {
  const { attempt, event, run } = input;
  if (event.ordinal !== run.nextRunnerOrdinal) {
    throw new OpensteerError({
      code: "conflict",
      message: `Runner event ordinal ${event.ordinal} is out of sequence; expected ${run.nextRunnerOrdinal}`,
    });
  }
  if (event.type !== "run.interrupted") {
    await transaction
      .updateTable("runs")
      .set({ nextRunnerOrdinal: event.ordinal + 1 })
      .where("id", "=", run.id)
      .executeTakeFirstOrThrow();
    const duplicateRunUsage =
      event.type === "run.usage" &&
      !(await recordAttemptUsage(transaction, {
        attemptId: attempt.id,
        runId: run.id,
        usage: event.data,
      }));
    return {
      compensatingEvents: [],
      duplicateRunUsage,
      event: await latestRunEvent(transaction, run.id),
      revokedGrants: [],
      wasDuplicate: true,
    };
  }
  if (!attempt.supersededBy) throw new Error("A superseded attempt has no successor");
  const successor = await transaction
    .selectFrom("runAttempts")
    .selectAll()
    .where("id", "=", attempt.supersededBy)
    .executeTakeFirstOrThrow();
  const now = new Date(event.emittedAt);
  await lockRunProjectionRows(transaction, { runIds: [run.id], threadIds: [run.threadId] });
  await transaction
    .updateTable("runs")
    .set({ bindingGeneration: null, nextRunnerOrdinal: event.ordinal + 1, status: "queued" })
    .where("id", "=", run.id)
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable("providerSessions")
    .set({ status: "ready", updatedAt: now })
    .where("id", "=", run.providerSessionId)
    .where("bindingGeneration", "=", event.bindingGeneration)
    .execute();
  const execute = await transaction
    .selectFrom("commands")
    .selectAll()
    .where("runId", "=", run.id)
    .where("type", "=", "run.execute")
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .limit(1)
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto("commands")
    .values({
      actorPrincipalId: execute.actorPrincipalId,
      authoritySource: jsonValue(execute.authoritySource),
      dispatcherId: null,
      environmentId: execute.environmentId,
      id: createId("command"),
      idempotencyKey: `restart:${successor.id}`,
      lastError: null,
      payload: jsonValue(execute.payload),
      requestedBy: execute.requestedBy,
      runId: run.id,
      status: "pending",
      threadId: execute.threadId,
      type: "run.execute",
    })
    .executeTakeFirstOrThrow();
  // The Run row was read under its lock after every earlier attempt's usage.
  const priorUsage = runUsageFromRow(run);
  const restarted = await appendHostWorkspaceEvent(transaction, {
    data: { attempt: successor.ordinal, ...(priorUsage ? { priorUsage } : {}), reason: "steer" },
    environmentId: run.environmentId,
    runId: run.id,
    threadId: run.threadId,
    type: "run.restarted",
    workspaceId: event.workspaceId,
  });
  const compensatingEvents: AgentEvent[] = [
    await appendHostWorkspaceEvent(transaction, {
      data: { status: "queued" },
      environmentId: run.environmentId,
      runId: run.id,
      threadId: run.threadId,
      type: "run.status",
      workspaceId: event.workspaceId,
    }),
    ...(await projectThreadState(transaction, run.threadId, now)),
    ...(await assignmentActivityEventsForRun(transaction, run.id)),
  ];
  await endLiveExecutionNodes(transaction, { attemptId: attempt.id, endedAt: now, runId: run.id });
  await endAttempt(transaction, attempt.id, "interrupted");
  return {
    compensatingEvents,
    duplicateRunUsage: false,
    event: restarted,
    revokedGrants: [],
    wasDuplicate: false,
  };
}

export async function commitRunnerEvent(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: {
    readonly environmentId: EnvironmentId;
    readonly event: PendingAgentEvent;
    /**
     * What a `tool.started` integration call addressed, as the Host resolved
     * it. It is stored with the event but is not the Runner's to send, so a
     * replay is still compared against the Runner's data alone.
     */
    readonly integration?: IntegrationCallSubject;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  },
  executionNow: () => number = Date.now,
): Promise<{
  /** Turns the Host requeued because this event ended their injection window. */
  readonly compensatingEvents: readonly AgentEvent[];
  /** A `run.usage` this Run had already stated; the first one still stands. */
  readonly duplicateRunUsage: boolean;
  readonly event: AgentEvent;
  /** Grants a restart took when the event let the person's messages reach the Run. */
  readonly revokedGrants: readonly RevokedRunGrant[];
  readonly wasDuplicate: boolean;
}> {
  // An engine can put half of a surrogate pair or U+0000 in any text it
  // reports, and PostgreSQL refuses either in jsonb. The event is made
  // storable once, here, so the log, every projection and the comparison with
  // a replay all see the same text, and one bad character never fails the
  // commit, which the Runner would otherwise send again forever.
  const event = storableJson(PendingAgentEventSchema.parse(input.event));
  if (event.environmentId !== input.environmentId) {
    throw new OpensteerError({ code: "forbidden", message: "Runner event environment mismatch" });
  }
  if (input.integration && event.type !== "tool.started") {
    throw new Error("Only a tool.started event names an integration call's subject");
  }
  const data = storableJson(
    input.integration
      ? { ...event.data, integration: IntegrationCallSubjectSchema.parse(input.integration) }
      : event.data,
  );

  // An event whose content the schema refuses fails the same way on every
  // replay, so it is refused — which ends its Run — rather than reported as a
  // store failure, which would have the Runner send it again forever.
  const committed = await withDatabaseTransaction(database, async (transaction) => {
    const run = await transaction
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", event.runId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!run) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Runner event has no durable run",
      });
    }
    const retired = await transaction
      .selectFrom("runAttempts")
      .select("id")
      .where("runId", "=", run.id)
      .where("bindingGeneration", "=", event.bindingGeneration)
      .where("status", "=", "superseded")
      .where("endedAt", "is not", null)
      .where((expression) =>
        expression.exists(
          expression
            .selectFrom("runAttempts as replacement")
            .select("replacement.id")
            .whereRef("replacement.runId", "=", "runAttempts.runId")
            .whereRef("replacement.ordinal", ">", "runAttempts.ordinal")
            .where("replacement.reason", "=", "recovery"),
        ),
      )
      .executeTakeFirst();
    if (retired) {
      const binding = await transaction
        .selectFrom("providerSessions")
        .select("bindingGeneration")
        .where("id", "=", run.providerSessionId)
        .executeTakeFirst();
      if (binding?.bindingGeneration !== event.bindingGeneration) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Another execution binding holds this Run",
        });
      }
    }
    const duplicate = await transaction
      .selectFrom("workspaceEvents")
      .selectAll()
      .where("runId", "=", event.runId)
      .where("runnerOrdinal", "=", event.ordinal)
      .executeTakeFirst();
    if (duplicate) {
      if (!isExactRunnerEventReplay(duplicate, event, input)) {
        throw new OpensteerError({
          code: "conflict",
          message: "Runner event ordinal was already committed with different content",
        });
      }
      return {
        compensatingEvents: [],
        duplicateRunUsage: false,
        revokedGrants: [],
        event: eventFromRow(duplicate),
        wasDuplicate: true,
      };
    }
    const attempt = await attemptForBinding(transaction, run.id, event.bindingGeneration);
    const superseded =
      attempt?.status === "superseded" &&
      attempt.runnerId === input.runnerId &&
      attempt.runnerBootId === input.runnerBootId &&
      run.environmentId === input.environmentId &&
      run.threadId === event.threadId
        ? attempt
        : null;
    // A superseded attempt's events below the Run's ordinal were absorbed,
    // not stored: a repeat is acknowledged as the duplicate it is.
    if (superseded && event.ordinal < run.nextRunnerOrdinal) {
      return {
        compensatingEvents: [],
        duplicateRunUsage: false,
        revokedGrants: [],
        event: await latestRunEvent(transaction, run.id),
        wasDuplicate: true,
      };
    }
    if (["completed", "failed", "interrupted"].includes(run.status)) {
      const formerBinding = await transaction
        .selectFrom("providerSessions")
        .innerJoin("threads", "threads.id", "providerSessions.threadId")
        .select(["threads.workspaceId"])
        .where("providerSessions.id", "=", run.providerSessionId)
        .where("providerSessions.bindingGeneration", "=", event.bindingGeneration)
        .where("providerSessions.runnerId", "=", input.runnerId)
        .where("providerSessions.runnerBootId", "=", input.runnerBootId)
        .executeTakeFirst();
      const isExactLateEvent =
        formerBinding !== undefined &&
        formerBinding.workspaceId === event.workspaceId &&
        run.environmentId === input.environmentId &&
        run.threadId === event.threadId &&
        run.nextRunnerOrdinal === event.ordinal;
      if (isExactLateEvent) {
        const durableTerminal = await transaction
          .selectFrom("workspaceEvents")
          .selectAll()
          .where("runId", "=", run.id)
          .where("type", "in", ["run.completed", "run.failed", "run.interrupted"])
          .orderBy("sequence", "desc")
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("runs")
          .set({ nextRunnerOrdinal: event.ordinal + 1 })
          .where("id", "=", run.id)
          .where("nextRunnerOrdinal", "=", event.ordinal)
          .executeTakeFirstOrThrow();
        return {
          compensatingEvents: [],
          duplicateRunUsage: false,
          revokedGrants: [],
          event: eventFromRow(durableTerminal),
          wasDuplicate: true,
        };
      }
    }
    const workspace = await transaction
      .selectFrom("workspaces")
      .select("status")
      .where("id", "=", event.workspaceId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (
      !workspace ||
      (workspace.status !== "ready" &&
        !(event.type === "run.interrupted" && event.data.cause === "lease-lost"))
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Runner event Workspace is no longer available",
      });
    }
    await assertActiveExecutionBindingInStore(
      transaction,
      {
        ...(event.type === "run.interrupted" && event.data.cause === "lease-lost"
          ? { lostExecution: true }
          : {}),
        bindingGeneration: event.bindingGeneration,
        environmentId: input.environmentId,
        requestedBy: run.requestedBy,
        runId: event.runId,
        runnerBootId: input.runnerBootId,
        runnerId: input.runnerId,
        threadId: event.threadId,
        workspaceId: event.workspaceId,
      },
      executionNow,
    );
    // An engine cancelling its own question can be what lets the Run work
    // again, so that one Request event is fenced like the Run's own events.
    if (!event.type.startsWith("request.") || event.type === "request.cancelled")
      await lockThreadRow(transaction, event.threadId);
    if (event.type === "run.interrupted" && event.data.cause === "lease-lost") {
      assertRunnerEventTransition(run, event);
      const recovered = await recoverLostRunTransaction(transaction, {
        failure: {
          code: "execution_binding_expired",
          message: "The Runner stopped renewing this Run's execution binding",
          retryable: false,
          status: "failed",
        },
        links,
        now: new Date(),
        runId: run.id,
      });
      const outcome = recovered.events.find(
        (entry) =>
          entry.type === "run.restarted" ||
          entry.type === "run.failed" ||
          entry.type === "run.interrupted",
      );
      if (!outcome) throw new Error("A lost execution has no recovery outcome");
      return {
        event: outcome,
        compensatingEvents: recovered.events.filter((entry) => entry !== outcome),
        duplicateRunUsage: false,
        revokedGrants: recovered.revokedGrants,
        wasDuplicate: false,
      };
    }
    if (superseded) {
      // Only an end the Run shares is the Run's: one that finished before
      // its interruption landed, or an interruption somebody also asked for.
      const endsRun =
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        (event.type === "run.interrupted" && (await runWasStopped(transaction, run.id)));
      if (!endsRun) {
        return commitSupersededAttemptEvent(transaction, { attempt: superseded, event, run });
      }
    }
    if (
      event.type === "run.started" ||
      event.type === "run.status" ||
      event.type === "request.cancelled"
    ) {
      await lockRunProjectionRows(transaction, { runIds: [run.id], threadIds: [event.threadId] });
    }
    assertRunnerEventTransition(run, event);
    // A completed Run's reply, and the reply of a turn that ended with work
    // still running in the background, which every client shows as one.
    const stored =
      event.type === "run.completed" ||
      (event.type === "run.phase" && event.data.phase === "background")
        ? {
            ...data,
            replyMessageId: (await runReply(transaction, run))?.id ?? null,
          }
        : data;
    const eventId = createId("event");
    const sequenceRow = await transaction
      .updateTable("workspaces")
      .set({ eventSequence: sql<string>`event_sequence + 1` })
      .where("id", "=", event.workspaceId)
      .returning("eventSequence")
      .executeTakeFirstOrThrow();
    const inserted = await transaction
      .insertInto("workspaceEvents")
      .values({
        createdAt: new Date(event.emittedAt),
        data: jsonValue(await stampRunContext(transaction, event.type, event.runId, stored)),
        environmentId: input.environmentId,
        eventId,
        runId: event.runId,
        runnerBindingGeneration: event.bindingGeneration,
        runnerBootId: input.runnerBootId,
        runnerId: input.runnerId,
        runnerOrdinal: event.ordinal,
        sequence: sequenceRow.eventSequence,
        threadId: event.threadId,
        type: event.type,
        workspaceId: event.workspaceId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const projection = await applyEventProjection(transaction, event, links, attempt);
    if (event.type.startsWith("request."))
      await markThreadStatePending(transaction, event.threadId);
    const advanced = await transaction
      .updateTable("runs")
      .set({ nextRunnerOrdinal: event.ordinal + 1 })
      .where("id", "=", event.runId)
      .where("nextRunnerOrdinal", "=", event.ordinal)
      .executeTakeFirst();
    if (advanced.numUpdatedRows !== 1n) {
      throw new OpensteerError({
        code: "conflict",
        message: "Runner event ordinal changed while the event was committing",
      });
    }
    // A terminal event reaches the Assignment through Run finalization.
    const assignmentEvents =
      event.type === "run.started" || event.type === "run.status" || event.type === "request.opened"
        ? await assignmentActivityEventsForRun(transaction, event.runId)
        : [];
    // Attempts rank last in ./lock-order.ts.
    if (event.type === "run.started") {
      await markAttemptStarted(transaction, run.id, event.bindingGeneration);
    }
    return {
      compensatingEvents: [...projection.compensatingEvents, ...assignmentEvents],
      duplicateRunUsage: projection.duplicateRunUsage,
      revokedGrants: projection.revokedGrants,
      event: eventFromRow(inserted),
      wasDuplicate: false,
    };
  }).catch((error: unknown) => {
    if (!isConstraintViolation(error)) throw error;
    throw new OpensteerError({
      code: "conflict",
      message: `Runner ${event.type} event conflicts with what the Host recorded`,
      retryable: false,
    });
  });
  // Assignment return delivery is an independent durable outbox. A Runner's
  // terminal-event ACK does not depend on delivery into a parent inbox.
  return committed;
}

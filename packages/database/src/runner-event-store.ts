import { lockRunProjectionRows } from "./run-projection-locks.js";
import { outsideName } from "@opensteer/shared/outsideName";
import { executionDate } from "./personal-transaction.js";
import {
  projectThreadState,
  publishRunQueue,
  publishThreadSummary,
  replyPreview,
  writeThreadSummary,
} from "./thread-status.js";
import { refreshRequestState } from "./request-persistence.js";
import {
  commitPersonalMutation,
  wakeTriggerSchedules,
  wakeWatches,
  type PersonalMutation,
} from "./personal-mutation.js";
import { acceptPersonalRunnerStatement } from "./personal-runner-receipts.js";
import { beginPersonalRunFinish, readFinishChildren } from "./personal-run-state.js";
import { completePersonalToolCall, startPersonalToolCall } from "./personal-tool-calls.js";
import {
  publishExecutionInput,
  publishTranscriptRun,
  recordExecutionRunChange,
  writeExecutionItem,
} from "./execution-changes.js";
import {
  describeTranscriptMessage,
  transcriptIdentity,
  transcriptPreview,
} from "./transcript-store.js";
import { completeRunReplacement, recoverLostRunTransaction } from "./run-recovery.js";
import { clearThreadStartHold } from "./execution-recovery.js";
import {
  contentSaysSomething,
  isPlaceContentPart,
  runTerminationUnprovenCode,
} from "@opensteer/core";
import { storableJson } from "./storable-json.js";
export { storableText } from "./storable-json.js";
import { isConstraintViolation } from "./connection.js";
import { type RunRow, type DatabaseSchema } from "./schema.js";
import {
  type PendingAgentEventV2 as PendingAgentEvent,
  PendingAgentEventV2Schema,
} from "@opensteer/protocol";
import {
  type EnvironmentId,
  type RunnerId,
  type ThreadId,
  OpensteerError,
  MessageAuthorSchema,
  ReplyTargetSchema,
  type IntegrationCallSubject,
  IntegrationCallSubjectSchema,
  runBackgroundMaxMs,
  utf8Prefix,
} from "@opensteer/core";
import { type Transaction, sql, type Kysely, type Selectable } from "kysely";
import { type ChannelLinks, systemPrincipalId, jsonValue } from "./store-primitives.js";
import { messageFromRow } from "./thread-row-mappers.js";
import {
  finalizeRunTransaction,
  drainRunFinish,
  settleFinishChildren,
} from "./run-finalization.js";
import {
  runAssignmentAcceptsRequests,
  assignmentActivityEventsForRun,
} from "./assignment-store.js";
import { requestInsert } from "./request-store.js";
import { enqueueChannelConversationStatus, enqueueChannelReply } from "./channel-deliveries.js";
import { executionBindingHolds, refuseExecutionBinding } from "./execution-authority.js";
import { runReply } from "./run-reply.js";
import { runHasActiveGrant, runWasStopped, type RevokedRunGrant } from "./run-grants.js";
import { deliverConversationInputsInTransaction } from "./thread-inbox.js";
import {
  completeExecutionNode,
  requireRunNode,
  startExecutionNode,
  updateExecutionNode,
} from "./execution-nodes.js";
import { markAttemptStarted, recordAttemptUsage, type RunAttemptRow } from "./run-attempts.js";
function assertRunnerEventTransition(
  run: Pick<
    RunRow,
    "harnessInstanceId" | "nextRunnerOrdinal" | "requestedBy" | "status" | "maintenance"
  >,
  event: PendingAgentEvent,
): void {
  if (run.maintenance && (event.type.startsWith("request.") || event.type.startsWith("tool.")))
    throw new OpensteerError({
      code: "conflict",
      message: "Compaction cannot request interaction or use tools",
    });
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
type StatementThread = Awaited<ReturnType<typeof lockStatementThread>>;

/** lockThreadRow, also reading what a Runner message needs from the locked task. */
async function lockStatementThread(tx: Transaction<DatabaseSchema>, threadId: ThreadId) {
  return tx
    .selectFrom("threads")
    .select((eb) => [
      "nextMessageSequence",
      eb
        .selectFrom("principals")
        .select("displayName")
        .where("id", "=", systemPrincipalId)
        .where("kind", "=", "system")
        .as("assistantName"),
    ])
    .where("id", "=", threadId)
    .where("removedAt", "is", null)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow(
      () => new OpensteerError({ code: "not_found", message: "Task not found" }),
    );
}

async function publishRunnerMessage(
  tx: Transaction<DatabaseSchema>,
  mutation: PersonalMutation,
  row: Selectable<DatabaseSchema["messages"]>,
  attempt: RunAttemptRow,
) {
  const message = messageFromRow(row);
  const { published, visible, isTurnStart, view, refs, messageText } = describeTranscriptMessage({
    ...message,
    edited: false,
    admittedSeed: false,
    seedInRun: false,
    assigned: false,
  });
  if (published !== row.published)
    await tx.updateTable("messages").set({ published }).where("id", "=", row.id).execute();
  const reply = message.kind === "assistant" && contentSaysSomething(message.content);
  // One task update takes the message's sequence, its transcript position and the last reply,
  // and publishes the task when the reply changed it.
  const changes = {
    nextMessageSequence: sql<string>`next_message_sequence + 1`,
    updatedAt: new Date(),
    ...(visible
      ? {
          nextTranscriptPosition: sql<string>`next_transcript_position + 1`,
          revision: mutation.sequence,
        }
      : {}),
    ...(reply
      ? { lastReplyMessageId: message.id, lastReplyPreview: replyPreview(message.content) }
      : {}),
  };
  const thread = reply
    ? await writeThreadSummary(tx, row.threadId, changes)
    : await tx
        .updateTable("threads")
        .set(changes)
        .where("id", "=", row.threadId)
        .returning("nextTranscriptPosition")
        .executeTakeFirstOrThrow();
  await writeExecutionItem(
    tx,
    mutation,
    {
      id: row.id,
      kind: "message",
      messageId: row.id,
      createdAt: row.createdAt,
      threadId: row.threadId,
      runId: row.runId,
      attemptId: attempt.id,
      nodeId: null,
      visible,
      isTurnStart,
      view,
      refs,
    },
    { position: visible ? thread.nextTranscriptPosition : null },
    undefined,
    messageText,
  );
}

async function applyEventProjection(
  transaction: Transaction<DatabaseSchema>,
  mutation: PersonalMutation,
  event: PendingAgentEvent,
  links: ChannelLinks,
  attempt: RunAttemptRow,
  run: RunRow,
  thread: StatementThread,
  integration?: IntegrationCallSubject,
): Promise<{ duplicateRunUsage: boolean; revokedGrants: readonly RevokedRunGrant[] }> {
  let duplicateRunUsage = false;
  let revokedGrants: readonly RevokedRunGrant[] = [];
  const close = (itemId: string, nodeId: import("@opensteer/core").ExecutionNodeId | null = null) =>
    mutation.react({
      type: "liveClosed",
      itemId,
      runId: event.runId,
      threadId: event.threadId,
      attemptId: attempt.id,
      bindingGeneration: event.bindingGeneration,
      nodeId,
      afterSequence: mutation.sequence,
    });
  if (event.type === "assistant.message") {
    if (event.data.content.some(isPlaceContentPart)) {
      throw new OpensteerError({
        code: "bad_request",
        message:
          "An assistant reply cannot attach place references. Forward selected places through delegation.",
      });
    }
    if (!event.runId) {
      throw new OpensteerError({
        code: "conflict",
        message: "Assistant message has no Run",
      });
    }
  }
  // A reply that says nothing stays in the Runner journal, where it still ends
  // its live text, but never becomes a message.
  if (
    event.type === "assistant.message" &&
    event.runId &&
    contentSaysSomething(event.data.content)
  ) {
    // A Run's actor is its authority principal, not the assistant's identity.
    const messageRow = await transaction
      .insertInto("messages")
      .values({
        actorPrincipalId: run.actorPrincipalId,
        author: jsonValue(
          MessageAuthorSchema.parse({
            displayName: thread.assistantName,
            kind: "agent",
            runId: event.runId,
            threadId: run.threadId,
          }),
        ),
        createdAt: new Date(),
        content: jsonValue(event.data.content),
        id: event.data.messageId,
        kind: "assistant",
        published: true,
        runId: event.runId,
        sequence: thread.nextMessageSequence,
        threadId: event.threadId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await publishRunnerMessage(transaction, mutation, messageRow, attempt);
  }
  if (event.type === "voice.heard") {
    if (!event.runId)
      throw new OpensteerError({
        code: "conflict",
        message: "A voice call's words have no Run",
      });
    const call = await transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .innerJoin("principals", "principals.id", "runs.actorPrincipalId")
      .select([
        "runs.actorPrincipalId",
        "runs.requestedBy",
        "threads.nextMessageSequence",
        "principals.displayName",
      ])
      .where("runs.id", "=", event.runId)
      .where("runs.voiceSessionId", "is not", null)
      .forNoKeyUpdate("threads")
      .executeTakeFirstOrThrow();
    const messageRow = await transaction
      .insertInto("messages")
      .values({
        actorPrincipalId: call.actorPrincipalId,
        author: jsonValue(
          MessageAuthorSchema.parse({
            displayName: call.displayName,
            kind: "human",
            principalId: call.actorPrincipalId,
            userId: call.requestedBy,
          }),
        ),
        content: jsonValue([
          {
            text: event.data.text,
            type: "text",
          },
        ]),
        id: event.data.messageId,
        kind: "input",
        published: true,
        runId: event.runId,
        sequence: call.nextMessageSequence,
        threadId: event.threadId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await publishRunnerMessage(transaction, mutation, messageRow, attempt);
  }
  const now = new Date(event.emittedAt);

  switch (event.type) {
    case "request.cancelled": {
      if (event.runId)
        await lockRunProjectionRows(transaction, {
          threadIds: [event.threadId],
          runIds: [event.runId],
          requestIds: [event.data.requestId],
        });
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
            lastError: jsonValue({
              message: "The provider cancelled this Request",
            }),
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
      await refreshRequestState(transaction, cancelled.id);
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
          .set({
            status: resumedStatus,
          })
          .where("id", "=", event.runId)
          .where("status", "in", ["running", "waiting"])
          .execute();
        if (resumedStatus === "running") {
          const handed = await deliverConversationInputsInTransaction(transaction, event.runId);
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
        .set({
          deliveredAt: now,
          state: "delivered",
          updatedAt: now,
        })
        .where("messageId", "=", event.data.messageId)
        .where("runId", "=", event.runId)
        .where("state", "in", ["claimed", "unknown"])
        .returningAll()
        .executeTakeFirst();
      if (injected?.steerCommandId) {
        await transaction
          .updateTable("commands")
          .set({
            status: "succeeded",
            updatedAt: now,
          })
          .where("id", "=", injected.steerCommandId)
          .where("status", "in", ["pending", "dispatched", "unknown"])
          .execute();
      }
      if (injected) {
        await publishExecutionInput(transaction, injected);
      }
      break;
    case "run.started":
      if (event.runId)
        await lockRunProjectionRows(transaction, {
          threadIds: [event.threadId],
          runIds: [event.runId],
        });
      await transaction
        .updateTable("providerSessions")
        .set({
          status: "running",
          updatedAt: now,
        })
        .where("id", "=", (builder) =>
          builder.selectFrom("runs").select("providerSessionId").where("id", "=", event.runId!),
        )
        .where("active", "=", true)
        .where("bindingGeneration", "=", event.bindingGeneration)
        .execute();
      if (event.runId) {
        await transaction
          .updateTable("runs")
          .set({
            startedAt: sql`coalesce(started_at, ${now})`,
            status: "running",
          })
          .where("id", "=", event.runId)
          .execute();
        await transaction
          .selectFrom("runAttempts")
          .select("id")
          .where("runId", "=", event.runId)
          .where("endedAt", "is", null)
          .orderBy("id")
          .forNoKeyUpdate()
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
                .set({
                  deliveredAt: now,
                  state: "delivered",
                  updatedAt: now,
                })
                .where(
                  "messageId",
                  "in",
                  fixedBatch.map(({ messageId }) => messageId),
                )
                .where("state", "=", "claimed")
                .returningAll()
                .execute();
        if (deliveredRows.length)
          await transaction
            .selectFrom("messages")
            .select("id")
            .where(
              "id",
              "in",
              deliveredRows.map(({ messageId }) => messageId),
            )
            .orderBy("id")
            .forNoKeyUpdate()
            .execute();
        // What the person wrote while the engine was starting is the started
        // turn's to take now.
        const handed = await deliverConversationInputsInTransaction(transaction, event.runId);
        revokedGrants = handed.revokedGrants;
        await markAttemptStarted(transaction, event.runId, event.bindingGeneration);
        const deliveredById = new Map(deliveredRows.map((row) => [row.messageId, row]));
        for (const { messageId } of fixedBatch) {
          const row = deliveredById.get(messageId);
          if (!row) continue;
          await publishExecutionInput(transaction, row);
        }
      }

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
          .set({
            status: projectedStatus,
          })
          .where("id", "=", event.runId)
          .execute();
      }

      break;
    case "request.opened":
      if (
        event.data.request.originatingThreadId !== event.threadId ||
        event.data.request.originatingRunId !== event.runId ||
        event.data.request.mode !== "live"
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "Harness Request scope is invalid",
        });
      }
      if (event.data.request.originatingNodeId) {
        await requireRunNode(
          transaction,
          event.runId,
          event.data.request.originatingNodeId,
          attempt.id,
        );
      }
      // The Runner's event stream must keep moving, so an ask from a stopped
      // Run or task is recorded and cancelled at once instead of refused.
      const accepted =
        !event.runId ||
        ((await runHasActiveGrant(transaction, event.runId)) &&
          (await runAssignmentAcceptsRequests(transaction, event.runId)));
      const request = event.data.request;
      const presentation =
        request.kind === "harness.approval"
          ? {
              ...request.presentation,
              title: outsideName(request.presentation.title, 240) || "Approval required",
            }
          : request.presentation;
      await transaction
        .insertInto("requests")
        .values(requestInsert({ ...request, presentation }))
        .executeTakeFirstOrThrow();
      if (!accepted) {
        await transaction
          .updateTable("requests")
          .set({ status: "cancelled", cancellationReason: "source-closed", resolvedAt: now })
          .where("id", "=", event.data.request.id)
          .execute();
        await refreshRequestState(transaction, event.data.request.id);
        break;
      }
      await refreshRequestState(transaction, event.data.request.id);
      if (event.runId) {
        await transaction
          .updateTable("runs")
          .set({
            status: "waiting",
          })
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
        if (replyTarget?.kind === "channel") {
          await enqueueChannelConversationStatus(transaction, {
            conversationId: replyTarget.conversationId,
            // One line and a link: what is asked, and every answer, stay in Opensteer.
            text: `This task needs you: ${links.threadUrl(event.threadId)}`,
          });
        }
      }
      break;
    case "run.phase":
      await projectRunPhase(transaction, event, links);
      break;
    case "node.started":
      if (event.data.parentNodeId)
        await requireRunNode(transaction, event.runId, event.data.parentNodeId, attempt.id);
      await startExecutionNode(transaction, {
        attemptId: attempt.id,
        node: event.data,
        runId: event.runId,
        startedAt: now,
      });
      break;
    case "node.updated":
      await requireRunNode(transaction, event.runId, event.data.nodeId, attempt.id);
      if (event.data.parentNodeId)
        await requireRunNode(transaction, event.runId, event.data.parentNodeId, attempt.id);
      await updateExecutionNode(transaction, event.runId, event.data);
      break;
    case "node.completed":
      await requireRunNode(transaction, event.runId, event.data.nodeId, attempt.id);
      await completeExecutionNode(transaction, {
        completion: event.data,
        endedAt: now,
        runId: event.runId,
      });
      break;
    case "assistant.message":
      close(event.data.messageId);
      break;
    case "tool.started":
    case "tool.completed": {
      if (event.data.nodeId)
        await requireRunNode(transaction, event.runId, event.data.nodeId, attempt.id);
      const key = {
        runId: event.runId,
        threadId: event.threadId,
        attemptId: attempt.id,
        bindingGeneration: event.bindingGeneration,
        nodeId: event.data.nodeId ?? null,
        callId: event.data.callId,
        origin: "runner" as const,
      };
      if (event.type === "tool.started") {
        await startPersonalToolCall(
          transaction,
          mutation,
          {
            ...key,
            tool: event.data.tool,
            arguments: event.data.arguments,
            ...(integration ? { integration } : {}),
            ...(event.data.provisional ? { provisional: true } : {}),
          },
          run,
        );
      } else {
        await completePersonalToolCall(
          transaction,
          mutation,
          { ...key, output: event.data.output, isError: event.data.isError },
          run,
        );
      }
      break;
    }
    case "node.message":
    case "reasoning.completed": {
      const nodeId = event.data.nodeId ?? null;
      if (nodeId) await requireRunNode(transaction, event.runId, nodeId, attempt.id);
      const reasoning = event.type === "reasoning.completed";
      const id = reasoning
        ? transcriptIdentity(
            "reasoning",
            event.runId,
            attempt.id,
            event.bindingGeneration,
            nodeId,
            event.data.blockId,
          )
        : transcriptIdentity("node-message", event.runId, event.ordinal);
      const body = utf8Prefix(event.data.text, 480 * 1024);
      await writeExecutionItem(transaction, mutation, {
        id,
        kind: reasoning ? "reasoning" : "node-message",
        createdAt: now,
        threadId: event.threadId,
        runId: event.runId,
        attemptId: attempt.id,
        nodeId,
        visible: true,
        isTurnStart: false,
        body,
        view: transcriptPreview({ preview: body }),
        ...(reasoning
          ? { blockId: event.data.blockId, bindingGeneration: event.bindingGeneration }
          : {}),
      });
      close(id, nodeId);
      break;
    }
    case "run.context-measured": {
      const run = await transaction
        .selectFrom("runs")
        .select(["providerSessionId", "maintenance"])
        .where("id", "=", event.runId)
        .executeTakeFirstOrThrow();
      if (run.providerSessionId && !run.maintenance) {
        const current = await transaction
          .selectFrom("providerSessions")
          .select("contextSnapshot")
          .where("id", "=", run.providerSessionId)
          .executeTakeFirstOrThrow();
        const prior = current.contextSnapshot;
        const generation = event.bindingGeneration;
        if (
          !prior ||
          generation > prior.bindingGeneration ||
          (generation === prior.bindingGeneration && event.ordinal > prior.ordinal)
        ) {
          await transaction
            .updateTable("providerSessions")
            .set({
              contextSnapshot: {
                ...event.data,
                sourceRunId: event.runId,
                bindingGeneration: generation,
                ordinal: event.ordinal,
              },
            })
            .where("id", "=", run.providerSessionId)
            .execute();
        }
      }
      break;
    }
    case "run.compaction": {
      if (event.data.status === "created") {
        const run = await transaction
          .selectFrom("runs")
          .select("providerSessionId")
          .where("id", "=", event.runId)
          .executeTakeFirstOrThrow();
        if (run.providerSessionId)
          await transaction
            .updateTable("providerSessions")
            .set({ contextSnapshot: null })
            .where("id", "=", run.providerSessionId)
            .execute();
      }
      break;
    }
    case "run.retry": {
      if (event.runId) {
        const activeRetry = event.data.status === "retrying" ? jsonValue(event.data) : null;
        await transaction
          .updateTable("runs")
          .set({ providerRetry: activeRetry })
          .where("id", "=", event.runId)
          .execute();
        await publishTranscriptRun(transaction, mutation, event.runId);
      }
      break;
    }
    case "run.usage":
      if (event.runId) {
        // The Run row is already held FOR NO KEY UPDATE by the caller, so the
        // write is the whole conflict check: it lands only while this attempt
        // has no usage recorded yet.
        duplicateRunUsage = !(await recordAttemptUsage(transaction, {
          attemptId: attempt.id,
          runId: event.runId,
          usage: event.data,
        }));
      }
      break;
    default:
      break;
  }
  return {
    duplicateRunUsage,
    revokedGrants,
  };
}

/**
 * A turn ended with background work still running, or another turn began in
 * the same Run. A channel hears each turn's reply when that turn ends, once,
 * rather than only when the Run does. The background deadline is set the
 * first time and never moved.
 */
async function projectRunPhase(
  transaction: Transaction<DatabaseSchema>,
  event: Extract<
    PendingAgentEvent,
    {
      readonly type: "run.phase";
    }
  >,
  links: ChannelLinks,
): Promise<void> {
  const background = event.data.phase === "background";
  const run = await transaction
    .selectFrom("runs")
    .select(["backgroundDeadlineAt", "replyTarget", "threadId", "turnReplyMessageId"])
    .where("id", "=", event.runId)
    .executeTakeFirstOrThrow();
  const replyTarget = run.replyTarget ? ReplyTargetSchema.parse(run.replyTarget) : null;
  const reply =
    background && replyTarget?.kind === "channel"
      ? await runReply(transaction, {
          id: event.runId,
          threadId: run.threadId,
        })
      : null;
  const deliver = reply !== null && reply.id !== run.turnReplyMessageId;
  await transaction
    .updateTable("runs")
    .set({
      phase: event.data.phase,
      ...(background && run.backgroundDeadlineAt === null
        ? {
            backgroundDeadlineAt: new Date(
              executionDate(transaction).getTime() + runBackgroundMaxMs,
            ),
          }
        : {}),
      ...(deliver
        ? {
            turnReplyMessageId: reply.id,
          }
        : {}),
    })
    .where("id", "=", event.runId)
    .execute();
  if (deliver && replyTarget?.kind === "channel") {
    await enqueueChannelReply(transaction, {
      content: reply.content,
      conversationId: replyTarget.conversationId,
      links,
      messageId: reply.id,
      threadId: run.threadId,
    });
  }
}

export async function commitRunnerEvent(
  database: Kysely<DatabaseSchema>,
  links: ChannelLinks,
  input: {
    readonly environmentId: EnvironmentId;
    readonly event: PendingAgentEvent;
    readonly integration?: IntegrationCallSubject;
    readonly verifiedContainment?: boolean;
    readonly runnerBootId: string;
    readonly runnerId: RunnerId;
  },
  executionNow: () => number = Date.now,
) {
  const event = storableJson(PendingAgentEventV2Schema.parse(input.event));
  if (event.environmentId !== input.environmentId)
    throw new OpensteerError({ code: "forbidden", message: "Runner event environment mismatch" });
  if (input.integration && event.type !== "tool.started")
    throw new Error("Only tool.started reports can have an integration subject");
  const integration = input.integration && IntegrationCallSubjectSchema.parse(input.integration);
  const terminalReceipt =
    event.type === "run.completed" ||
    (event.type === "run.failed" && event.data.code !== runTerminationUnprovenCode) ||
    event.type === "run.interrupted";
  let connectionId: string | null = null;
  const recordTerminalEvidence = async () => {
    if (!terminalReceipt || !connectionId) return;
    await database
      .updateTable("runAttempts")
      .set({
        terminalEvidenceAt: new Date(),
        contactLostAt: input.verifiedContainment ? null : new Date(),
      })
      .where("runId", "=", event.runId)
      .where("bindingGeneration", "=", event.bindingGeneration)
      .where("runnerId", "=", input.runnerId)
      .where("runnerBootId", "=", input.runnerBootId)
      .where((eb) => eb.or([eb("connectionId", "=", connectionId), eb("connectionId", "is", null)]))
      .where("terminalEvidenceAt", "is", null)
      .execute();
  };
  let duplicateRunUsage = false;
  let revokedGrants: readonly RevokedRunGrant[] = [];
  let clearHeldThreadId: ThreadId | null = null;
  const statement = { ...event, runnerId: input.runnerId, runnerBootId: input.runnerBootId };
  const accept = () =>
    commitPersonalMutation(database, async (tx, mutation) =>
      acceptPersonalRunnerStatement(
        tx,
        mutation,
        statement,
        async (digest, event, authority, { run, attempt, ...context }) => {
          // Late confirmation from the Runner that an unproven stop has now settled:
          // move the Run from failed/execution_termination_unproven to interrupted
          // with stopConfirmedAt, lift any previous-stop-unconfirmed hold on queued
          // Runs, and clear the failed task status. Never becomes completed.
          if (
            input.verifiedContainment !== false &&
            run.status === "failed" &&
            run.failure?.code === runTerminationUnprovenCode &&
            event.type === "run.interrupted"
          ) {
            const confirmedAt = mutation.state.now;
            clearHeldThreadId = run.threadId;
            await lockStatementThread(tx, event.threadId);
            await lockRunProjectionRows(tx, {
              threadIds: [run.threadId],
              runIds: [run.id],
            });
            await tx
              .updateTable("runs")
              .set({
                status: "interrupted",
                failure: null,
                completedAt: confirmedAt,
                stopConfirmedAt: confirmedAt,
                runnerSafetyTerminal: true,
                revision: mutation.sequence,
              })
              .where("id", "=", run.id)
              .executeTakeFirstOrThrow();
            await tx
              .updateTable("threads")
              .set({ unconfirmedStopRunId: null })
              .where("id", "=", run.threadId)
              .where("unconfirmedStopRunId", "=", run.id)
              .execute();
            if (run.providerSessionId) {
              await tx
                .updateTable("providerSessions")
                .set({
                  status: "ready",
                  updatedAt: confirmedAt,
                })
                .where("id", "=", run.providerSessionId)
                .where("status", "=", "broken")
                .execute();
            }
            await tx
              .updateTable("runAttempts")
              .set({
                outcome: "interrupted",
                endedAt: confirmedAt,
                terminalEvidenceAt: confirmedAt,
                contactLostAt: null,
              })
              .where("runId", "=", run.id)
              .where("bindingGeneration", "=", event.bindingGeneration)
              .execute();
            await projectThreadState(tx, run.threadId, confirmedAt, true);
            await publishTranscriptRun(tx, mutation, run.id);
            await publishRunQueue(tx, run.threadId);
            await wakeTriggerSchedules(tx);
            await wakeWatches(tx, run.environmentId);
            return "applied";
          }
          const lostExecution =
            event.type === "run.interrupted" && event.data.cause === "lease-lost";
          if (
            !executionBindingHolds(
              context.binding,
              {
                bindingGeneration: event.bindingGeneration,
                environmentId: input.environmentId,
                requestedBy: run.requestedBy,
                runId: run.id,
                runnerBootId: input.runnerBootId,
                runnerId: input.runnerId,
                threadId: run.threadId,
                ...(lostExecution ? { lostExecution } : {}),
              },
              executionNow(),
            ) ||
            (!lostExecution && !context.threadAdmitted)
          )
            refuseExecutionBinding();
          const thread = await lockStatementThread(tx, event.threadId);
          if (lostExecution) {
            assertRunnerEventTransition(run, event);
            const recovery = await recoverLostRunTransaction(tx, {
              failure: {
                code: "execution_binding_expired",
                message: "The Runner stopped renewing this Run's execution binding",
                retryable: false,
                status: "failed",
              },
              links,
              now: mutation.state.now,
              runId: run.id,
              statement: {
                ordinal: event.ordinal,
                runnerId: input.runnerId,
                runnerBootId: input.runnerBootId,
                digest: digest.toString("hex"),
              },
            });
            revokedGrants = recovery.revokedGrants;
            return "applied";
          }
          const terminal =
            event.type === "run.completed" ||
            event.type === "run.failed" ||
            event.type === "run.interrupted";
          // A restart waiting to interrupt this binding can still lose to its final reply.
          const replyFromLiveAttempt =
            event.type === "assistant.message" && attempt.endedAt === null;
          if (
            authority.kind === "superseded" &&
            ((!terminal && !replyFromLiveAttempt) ||
              (event.type === "run.interrupted" && !(await runWasStopped(tx, run.id))))
          ) {
            if (event.type === "run.interrupted") {
              const scope = { attemptId: attempt.id, bindingGeneration: event.bindingGeneration };
              const children = await readFinishChildren(tx, run.id, scope);
              if (children.hasMore) {
                await beginPersonalRunFinish(tx, mutation, {
                  runId: run.id,
                  intent: {
                    ...scope,
                    mode: "steer",
                    outcome: "interrupted",
                    completedAt: event.emittedAt,
                    replyMessageId: null,
                    statement: {
                      ordinal: event.ordinal,
                      runnerId: input.runnerId,
                      runnerBootId: input.runnerBootId,
                      digest: digest.toString("hex"),
                    },
                  },
                });
                await recordExecutionRunChange(tx, mutation, {
                  runId: run.id,
                  threadId: run.threadId,
                  transition: "finishing",
                });
              } else {
                await lockRunProjectionRows(tx, {
                  threadIds: [run.threadId],
                  runIds: [run.id],
                });
                await settleFinishChildren(
                  tx,
                  mutation,
                  run.id,
                  { completedAt: new Date(event.emittedAt), source: "runner" },
                  children,
                );
                await completeRunReplacement(
                  tx,
                  mutation,
                  run,
                  attempt.id,
                  "steer",
                  new Date(event.emittedAt),
                );
                mutation.react({
                  type: "runFinished",
                  attemptOnly: true,
                  ...scope,
                  runId: run.id,
                  threadId: run.threadId,
                  outcome: "interrupted",
                });
              }
              return "applied";
            }
            if (event.type === "run.usage")
              duplicateRunUsage = !(await recordAttemptUsage(tx, {
                attemptId: attempt.id,
                runId: run.id,
                usage: event.data,
              }));
            return "absorbed";
          }
          assertRunnerEventTransition(run, event);
          if (terminal) {
            await finalizeRunTransaction(tx, {
              completedAt: mutation.state.now,
              links,
              source: "runner",
              queuedInputCancellation: "seed-input",
              runId: run.id,
              status:
                event.type === "run.completed"
                  ? "completed"
                  : event.type === "run.failed"
                    ? "failed"
                    : "interrupted",
              ...(event.type === "run.failed" ? { failure: event.data } : {}),
              ...(event.type === "run.interrupted" && event.data.cause
                ? { interruptedCause: event.data.cause }
                : {}),
              statement: {
                ordinal: event.ordinal,
                runnerId: input.runnerId,
                runnerBootId: input.runnerBootId,
                digest: digest.toString("hex"),
              },
              attemptId: attempt.id,
            });
            return "applied";
          }
          const projection = await applyEventProjection(
            tx,
            mutation,
            event,
            links,
            attempt,
            run,
            thread,
            integration,
          );
          duplicateRunUsage = projection.duplicateRunUsage;
          revokedGrants = projection.revokedGrants;
          const transition =
            event.type === "run.started"
              ? "started"
              : event.type === "run.phase"
                ? event.data.phase === "background"
                  ? "background"
                  : "foreground"
                : event.type === "run.status" ||
                    event.type === "request.opened" ||
                    event.type === "request.cancelled"
                  ? "status"
                  : null;
          if (transition) {
            // The Run change below publishes the Run queue with the Run's new revision.
            await projectThreadState(tx, run.threadId, new Date(event.emittedAt));
            await recordExecutionRunChange(tx, mutation, {
              runId: run.id,
              threadId: run.threadId,
              transition,
            });
            if (event.type !== "run.phase") await assignmentActivityEventsForRun(tx, run.id);
          }
          if (
            event.type === "run.context-measured" ||
            event.type === "run.compaction" ||
            event.type === "run.retry"
          )
            await publishThreadSummary(tx, run.threadId);
          return "applied";
        },
        {
          now: executionNow(),
          onRunLoaded: (run) => {
            connectionId = run.connectionId;
          },
          allowExpiredLease: event.type === "run.interrupted" && event.data.cause === "lease-lost",
          verifiedContainment: input.verifiedContainment,
        },
      ),
    );
  try {
    let result = await accept();
    if ("finishing" in result) {
      await drainRunFinish(database, links, event.runId);
      result = await accept();
      if ("finishing" in result) throw new Error("Run finish did not commit its Runner receipt");
    }
    if (clearHeldThreadId) {
      await clearThreadStartHold(database, clearHeldThreadId);
    }
    await recordTerminalEvidence();
    return { ...result, duplicateRunUsage, revokedGrants };
  } catch (error) {
    // A former binding can prove that it stopped without changing the current Run.
    await recordTerminalEvidence();
    if (!isConstraintViolation(error)) throw error;
    throw new OpensteerError({
      code: "conflict",
      message: `Runner ${event.type} event conflicts with what the Host recorded`,
      retryable: false,
    });
  }
}

import { freshContextBoundary } from "./fresh-context.js";
import { threadAllowsPersonalContext } from "./run-personal-context.js";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { MANAGED_MEMORY_WAKE_SKIPPED } from "@opensteer/triggers";
import {
  isMemoryPassWake,
  memoryPassWakeContext,
  startMemoryPassInTransaction,
} from "./memory-pass-store.js";
import { assertLineageCompatibleReuse } from "./resource-access.js";
import { recordPersonWaited } from "./run-visibility.js";
import {
  taskQuestionCause,
  taskQuestionNoticeSource,
  taskQuestionNoticeIsPending,
} from "./task-question-notices.js";
import { finalizeRunTransaction } from "./run-finalization.js";
import { z } from "zod";
import { isPlaceContentPart } from "@opensteer/core";
import { lockRunProjectionRows, lockThreadProjectionParents } from "./run-projection-locks.js";
import { recordIncludedBrowserPages } from "./browser-session-store.js";
import { TransactionScopeChanged } from "./connection.js";

import { harnessRevisionChanged, prepareThreadInsertion } from "./thread-insertion.js";
import { projectThreadState } from "./thread-status.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ChannelConversationIdSchema,
  ChannelBindingSchema,
  ChannelIngressIdSchema,
  PrincipalIdSchema,
  type PrincipalId,
} from "@opensteer/channel-core";
import {
  deriveThreadStatus,
  placeInputFailure,
  ContentPartSchema,
  MessageContentSchema,
  MessageAuthorSchema,
  nonTerminalRunStatuses,
  ModelSelectionSchema,
  OpensteerError,
  ReplyTargetSchema,
  ThreadAccessModeSchema,
  ThreadInputPolicySchema,
  causalChainMaxDelegations,
  causalChainMaxAutonomousRuns,
  createId,
  moveQueueItem,
  threadAccessModeAtMost,
  requestTitleText,
  RequestIdSchema,
  type RequestId,
  threadReportMaxPendingEntries,
  threadReportMaxPendingSerializedBytes,
  threadReportBatchMaxEntries,
  threadReportBatchMaxSerializedBytes,
  threadInputMaxPendingEntries,
  threadInputMaxPendingSerializedBytes,
  surrogateSafeCut,
  type AgentEvent,
  type AssignmentId,
  type CausalChainId,
  type ContentPart,
  type MessageAuthor,
  type MessageId,
  type MessageKind,
  type HarnessInstanceId,
  type ProviderSessionId,
  type ReplyTarget,
  type RunId,
  type ThreadId,
  type TriggerId,
  type ThreadInputQueue,
  type TriggerWatchActivationId,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import {
  runExecuteInputsMax,
  runHistoryMaxMessages,
  runHistoryMaxSerializedBytes,
} from "@opensteer/protocol";
import type {
  CommandRow,
  DatabaseSchema,
  DelegationTable,
  RunRow,
  ThreadInputTable,
  ThreadRow,
} from "./schema.js";
import {
  messageFromRow,
  runFromRow,
  threadFromRow,
  threadPendingRequestsSelection,
  threadVisitSelection,
  threadLatestRunCompletedAtSelection,
  threadProviderSessionSelection,
  threadContinuationIdentitySelection,
  threadInputFromRow,
  threadRunQueueEntryFromRow,
} from "./thread-row-mappers.js";
import {
  idempotencyConflict,
  jsonValue,
  lockCommandIdempotency,
  lockThreadRow,
  principalIdForUser,
  requireBoundedIdentity,
  requireExecutionEnvironmentAccess,
  safeCount,
  systemPrincipalId,
  threadExecutionIsAvailableToUser,
  threadPathLinks,
} from "./store-primitives.js";
import type {
  CancelledThreadInput,
  CancelThreadInputRequest,
  DelegateThreadRequest,
  DelegatedThreadResult,
  EnqueuedThreadInput,
  EnqueueThreadInputRequest,
  MovedThreadInput,
  MoveThreadInputRequest,
  SteerThreadInputRequest,
  ThreadInputSource,
} from "./store.js";
import { appendHostDeploymentEvent } from "./deployment-events.js";
import { appendDoneState, requireThreadWriteAuthority } from "./task-done.js";
import {
  assertDelegationDepth,
  descendsByParentLink,
  nearestListedThread,
} from "./thread-lineage.js";
import {
  revokeRunGrants,
  runHasActiveGrant,
  runWasStopped,
  type RevokedRunGrant,
} from "./run-grants.js";
import {
  pendingReplacementAttempt,
  runHolder,
  runSteeringMode,
  supersedeCurrentAttempt,
  type SteeringMode,
} from "./run-attempts.js";
import { resolveChannelAuthority } from "./channel-authority.js";
import { claimMessageAttachments } from "./attachment-store.js";
import {
  channelInputAuthorityIsCurrent,
  lockThreadChannelAuthorities,
} from "./channel-execution.js";
import { resolveMessageQuote } from "./message-quotes.js";
import {
  assignmentEventsInTransaction,
  assignmentSummaryInTransaction,
} from "./assignment-store.js";
import {
  assertThreadCaller,
  lockThreadCaller,
  type ThreadCallerAuthority,
} from "./thread-caller.js";
function canManageQueuedInput(
  row: {
    readonly requestedBy: UserId;
    readonly authoritySource: Readonly<Record<string, unknown>>;
  },
  request: {
    readonly requestedBy: UserId;
    readonly authority?: import("./thread-caller.js").ThreadCallerAuthority;
  },
): boolean {
  if (row.requestedBy !== request.requestedBy) return false;
  const source = row.authoritySource;
  if (source.kind === "user-session") return true;
  const caller = request.authority;
  if (!caller) return source.kind === "connection";
  switch (caller.kind) {
    case "connection":
      return source.kind === "connection" && source.connectionId === caller.connectionId;
    case "run":
      return source.kind === "thread-agent" && source.threadId === caller.scope.threadId;
    case "trigger":
      return (
        source.kind === "trigger-occurrence" && source.occurrenceId === caller.scope.occurrenceId
      );
    case "watch":
      return (
        source.kind === "watch-observation" && source.activationId === caller.scope.activationId
      );
  }
}

/**
 * The durable Thread Inbox is the sole scheduler for new model input. It owns
 * admission, fixed-batch claiming, active-Run steering, causal budgets, and
 * delegation completion. Harnesses receive only references to this state.
 */

export async function readThreadInputQueue(
  transaction: Transaction<DatabaseSchema>,
  request: {
    readonly authority?: import("./thread-caller.js").ThreadCallerAuthority;
    readonly threadId: ThreadId;
    readonly requestedBy: UserId;
  },
): Promise<ThreadInputQueue> {
  await requirePersonalOwner(transaction, request.requestedBy);
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", request.threadId)
    .executeTakeFirst();
  if (!thread)
    throw new OpensteerError({
      code: "not_found",
      message: "Thread not found",
    });
  const runs = await transaction
    .selectFrom("runs")
    .selectAll()
    .where("threadId", "=", thread.id)
    .where("status", "in", nonTerminalRunStatuses)
    .execute();
  const active = runs.find((run) => run.status === "running");
  const steerable =
    !thread.inputQueuePaused &&
    thread.status !== "archived" &&
    active &&
    active.requestedBy === request.requestedBy &&
    active.environmentId === thread.environmentId &&
    active.harnessInstanceId === thread.harnessInstanceId &&
    (await steerRoute(transaction, active.id)) !== null &&
    (await threadExecutionIsAvailableToUser(transaction, thread.id, request.requestedBy));
  const rows = await waitingThreadInputs(transaction, thread.id);
  const messages =
    rows.length === 0
      ? []
      : await transaction
          .selectFrom("messages")
          .selectAll()
          .where(
            "id",
            "in",
            rows.map((row) => row.messageId),
          )
          .execute();
  const byId = new Map(messages.map((message) => [message.id, message]));
  return {
    threadId: thread.id,
    paused: thread.inputQueuePaused,
    steerRunId: steerable ? active.id : null,
    items: rows.map((row) => {
      const message = byId.get(row.messageId);
      if (!message) throw new Error("Pending input lost its message");
      const own = canManageQueuedInput(row, request);
      return {
        message: messageFromRow(message),
        input: threadInputFromRow(row),
        canCancel: own && thread.status !== "archived",
        canMove: own && thread.status !== "archived",
        canSteer: Boolean(
          steerable &&
          own &&
          !row.freshContext &&
          compatibleSteeringTarget(active.replyTarget, row),
        ),
      };
    }),
  };
}

/**
 * How a running Run takes a message steered into it now, or null when it
 * cannot. While a restart waits to start, every steered message joins it:
 * the attempt that would have been steered is already being interrupted.
 * Otherwise the Run needs its grant, and the Runner holding it decides.
 */
async function steerRoute(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<SteeringMode | null> {
  const replacement = await pendingReplacementAttempt(transaction, runId);
  if (replacement?.reason === "recovery") return null;
  if (replacement) {
    if (await runWasStopped(transaction, runId)) return null;
    return (await restartInputCount(transaction, runId)) < runExecuteInputsMax ? "restart" : null;
  }
  if (!(await runHasActiveGrant(transaction, runId))) return null;
  return runSteeringMode(transaction, runId);
}

/**
 * The messages the Run's waiting replacement attempt starts with: those a
 * restart handed it, and a conversation's that its dispatch took along.
 */
async function restartInputCount(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<number> {
  const joined = await transaction
    .selectFrom("threadInputs")
    .leftJoin("commands", "commands.id", "threadInputs.steerCommandId")
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .where("threadInputs.runId", "=", runId)
    .where("threadInputs.state", "=", "claimed")
    .where("threadInputs.policy", "!=", "report")
    .where((expression) =>
      expression.or([
        expression("threadInputs.steerCommandId", "is", null),
        expression("commands.type", "=", "run.restart"),
      ]),
    )
    .executeTakeFirstOrThrow();
  return Number(joined.count);
}

/**
 * The sources that are the person themselves writing: in the app, or in a
 * direct message their channel identity sent. Everything else that reaches a
 * conversation — Triggers, watches, tasks, other agents — keeps its queue.
 */
const personAuthoritySourceKinds = ["user-session", "channel-ingress"] as const;

/** Whether a message is the person themselves writing, rather than a machine queuing work. */
function isPersonsMessage(input: {
  readonly authoritySource: Readonly<Record<string, unknown>>;
  readonly policy: string;
}): boolean {
  return (
    input.policy === "queue" &&
    personAuthoritySourceKinds.some((kind) => kind === input.authoritySource.kind)
  );
}

function compatibleSteeringTarget(
  target: ReplyTarget | null,
  input: {
    readonly replyTarget: ReplyTarget | null;
    readonly authoritySource: Readonly<Record<string, unknown>>;
  },
): boolean {
  return (
    isDeepStrictEqual(target, input.replyTarget) ||
    (target?.kind === "team" &&
      input.replyTarget === null &&
      input.authoritySource.kind === "user-session")
  );
}

async function conversationalReply(
  transaction: Transaction<DatabaseSchema>,
  thread: Pick<ThreadRow, "purpose">,
  replyTarget: RunRow["replyTarget"],
): Promise<boolean> {
  if (thread.purpose === "voice") return true;
  if (replyTarget?.kind !== "channel") return false;
  const conversation = await transaction
    .selectFrom("channelConversations")
    .select("personalContext")
    .where("id", "=", ChannelConversationIdSchema.parse(replyTarget.conversationId))
    .executeTakeFirst();
  return conversation?.personalContext === true;
}

function exchangeInputs(
  transaction: Transaction<DatabaseSchema>,
  run: Pick<RunRow, "assignmentId" | "replyTarget" | "requestedBy" | "voiceSessionId">,
  threadId: ThreadId,
  state: "claimed" | "pending",
) {
  const addressed = transaction
    .selectFrom("threadInputs")
    .where("threadInputs.threadId", "=", threadId)
    .where("threadInputs.policy", "=", "queue")
    .where("threadInputs.state", "=", state)
    .where("threadInputs.requestedBy", "=", run.requestedBy);
  // A call stays open across turns, so anything sent to its Thread arrives now.
  if (run.voiceSessionId) return addressed;
  return addressed
    .where(
      sql<boolean>`thread_inputs.reply_target is not distinct from ${run.replyTarget === null ? null : JSON.stringify(run.replyTarget)}::jsonb`,
    )
    .where(sql<boolean>`thread_inputs.assignment_id is not distinct from ${run.assignmentId}`)
    .where(sql<string>`thread_inputs.authority_source->>'kind'`, "in", [
      ...personAuthoritySourceKinds,
    ]);
}

/** The exchange's waiting messages a Run can take: those not already the seed of a Run. */
function conversationFollowUps(
  transaction: Transaction<DatabaseSchema>,
  run: Pick<RunRow, "assignmentId" | "replyTarget" | "requestedBy" | "voiceSessionId">,
  threadId: ThreadId,
) {
  return exchangeInputs(transaction, run, threadId, "pending").where(
    ({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("runs")
            .select("runs.id")
            .whereRef("runs.seedInputId", "=", "threadInputs.messageId")
            .where("runs.status", "in", nonTerminalRunStatuses),
        ),
      ),
  );
}

/**
 * Gives a Run the person's waiting messages, oldest first, up to `limit`. Each
 * whose channel authority still holds is claimed by the Run and placed after
 * what it has said; one whose authority ended is cancelled. A message `holds`
 * keeps waiting, and so does everything after it, so nothing overtakes it.
 * `handOff` makes the command each one travels by; without it the Run's own
 * dispatch carries them.
 */
async function claimFollowUps(
  transaction: Transaction<DatabaseSchema>,
  run: RunRow,
  thread: ThreadRow,
  input: {
    readonly handOff?: (row: Selectable<ThreadInputTable>) => Promise<CommandRow["id"]>;
    readonly holds?: (content: readonly ContentPart[]) => boolean;
    readonly limit: number;
  },
): Promise<{
  readonly claimed: number;
  readonly events: readonly AgentEvent[];
}> {
  const barrier = await transaction
    .selectFrom("threadInputs")
    .select("queueRank")
    .where("threadId", "=", thread.id)
    .where("state", "=", "pending")
    .where("policy", "=", "queue")
    .where("freshContext", "=", true)
    .orderBy("queueRank", "asc")
    .limit(1)
    .executeTakeFirst();
  const waiting = await conversationFollowUps(transaction, run, thread.id)
    .$if(barrier !== undefined, (query) =>
      query.where("threadInputs.queueRank", "<", barrier!.queueRank),
    )
    .select("threadInputs.messageId")
    .orderBy("threadInputs.queueRank", "asc")
    .limit(input.limit)
    .execute();
  if (waiting.length === 0)
    return {
      claimed: 0,
      events: [],
    };
  const ids = waiting.map(({ messageId }) => messageId);
  const locked = await transaction
    .selectFrom("threadInputs")
    .selectAll()
    .where("messageId", "in", ids)
    .where("state", "=", "pending")
    .orderBy("messageId", "asc")
    .forNoKeyUpdate()
    .execute();
  const contents = await transaction
    .selectFrom("messages")
    .select(["content", "id"])
    .where("id", "in", ids)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  const lockedById = new Map(locked.map((row) => [row.messageId, row]));
  const contentById = new Map(contents.map(({ content, id }) => [id, content]));
  const events: AgentEvent[] = [];
  let claimed = 0;
  for (const messageId of ids) {
    const row = lockedById.get(messageId);
    if (!row) continue;
    if (!(await channelInputAuthorityIsCurrent(transaction, messageId))) {
      const cancelled = await transaction
        .updateTable("threadInputs")
        .set({
          cancelReason: "channel-authority-unavailable",
          state: "cancelled",
          updatedAt: new Date(),
        })
        .where("messageId", "=", messageId)
        .where("state", "=", "pending")
        .returningAll()
        .executeTakeFirstOrThrow();
      events.push(await inputUpdatedEvent(transaction, thread, cancelled));
      continue;
    }
    if (input.holds?.(ContentPartSchema.array().parse(contentById.get(messageId)))) break;
    const steerCommandId = input.handOff ? await input.handOff(row) : null;
    const taken = await transaction
      .updateTable("threadInputs")
      .set({
        runId: run.id,
        state: "claimed",
        steerCommandId,
        updatedAt: new Date(),
      })
      .where("messageId", "=", messageId)
      .where("state", "=", "pending")
      .returningAll()
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("messages")
      .set({
        runId: run.id,
      })
      .where("id", "=", messageId)
      .execute();
    await recordPersonWaited(transaction, run.id);
    events.push(
      await placeQueuedMessage(transaction, thread, messageId, run.id),
      await inputUpdatedEvent(transaction, thread, taken),
    );
    claimed += 1;
  }
  return {
    claimed,
    events,
  };
}

/** The image test `attachmentInputFailure` applies before an engine takes a message. */
function hasImage(content: readonly ContentPart[]): boolean {
  return content.some((part) => part.type === "artifact" && part.mediaType.startsWith("image/"));
}

/**
 * Hands the person's waiting messages to the conversation Run answering them,
 * oldest first, the moment it can take them: as they arrive, when its engine
 * starts, and when its last open question is answered. A native engine takes
 * each at its next step; any other restarts the attempt once with all of
 * them. Nothing here retries: a refusal returns a message to the inbox, and
 * the next of those moments, or the next Run, hands it over again.
 *
 * The caller holds the Run, the Thread (`lockThreadRow`
 * fences channel authority first) and the Thread's projection parents, in the
 * order of ./lock-order.ts.
 */
export async function deliverConversationInputsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<{
  readonly events: readonly AgentEvent[];
  readonly revokedGrants: readonly RevokedRunGrant[];
}> {
  const none = {
    events: [],
    revokedGrants: [],
  };
  const run = await transaction
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", run.threadId)
    .executeTakeFirstOrThrow();
  if (
    !(await conversationalReply(transaction, thread, run.replyTarget)) ||
    run.status !== "running" ||
    thread.inputQueuePaused ||
    thread.status === "archived" ||
    run.environmentId !== thread.environmentId ||
    run.harnessInstanceId !== thread.harnessInstanceId ||
    !isDeepStrictEqual(run.modelSelection, thread.modelSelection)
  )
    return none;
  const route = await steerRoute(transaction, run.id);
  if (route === null) return none;
  // Only a Runner whose drivers answer, in the same Run, a message accepted
  // while it replies is handed one. A Run an older Runner still holds from
  // before a Host upgrade answers it next, and that Run's dispatch asks for
  // the update.
  const holder = await runHolder(transaction, run.id);
  if (!holder?.capabilities.includes("steer-answer-v1")) return none;
  if (!(await threadExecutionIsAvailableToUser(transaction, thread.id, run.requestedBy)))
    return none;
  const claimed = await claimFollowUps(transaction, run, thread, {
    handOff: async (row) => {
      const payload =
        route === "native"
          ? ({
              messageId: row.messageId,
              runId: run.id,
              threadId: thread.id,
              type: "run.steer",
            } as const)
          : restartPayload(run, row.messageId);
      // Each hand-off of a message into a Run is its own command: a refused
      // one may be handed to the same Run again later.
      const previous = await transaction
        .selectFrom("commands")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("runId", "=", run.id)
        .where("type", "in", ["run.steer", "run.restart"])
        .where(sql<string>`payload->>'messageId'`, "=", row.messageId)
        .executeTakeFirstOrThrow();
      const command = await transaction
        .insertInto("commands")
        .values({
          actorPrincipalId: row.actorPrincipalId,
          authoritySource: row.authoritySource,
          // Commands for one Thread dispatch in creation order and their ids
          // are random, so each hand-off is stamped when it is made, not when
          // the transaction began.
          createdAt: sql<Date>`clock_timestamp()`,
          dispatcherId: null,
          environmentId: run.environmentId,
          id: createId("command"),
          idempotencyKey: `steer:${row.messageId}:${run.id}:${safeCount(previous.count)}`,
          lastError: null,
          payload: jsonValue(payload),
          requestedBy: run.requestedBy,
          runId: run.id,
          status: "pending",
          threadId: thread.id,
          type: payload.type,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      return command.id;
    },
    // A picture the engine cannot take mid-turn waits for the next Run's
    // start, and so does everything after it. So does a page for a Runner
    // that cannot read one: that Run's dispatch asks for the update.
    holds: (content) =>
      placeInputFailure(content, holder.capabilities) !== null ||
      (route === "native" &&
        holder.driver.messageAttachments?.nativeImages?.steering !== true &&
        hasImage(content)),
    // A native hand-off is one command per message, bounded only by the
    // inbox; a restart's replacement starts with all of them in one dispatch.
    limit:
      route === "restart"
        ? await restartBatchCapacity(transaction, run.id)
        : threadInputMaxPendingEntries,
  });
  const revokedGrants =
    route === "restart" && claimed.claimed > 0
      ? await supersedeForRestart(transaction, run.id)
      : [];
  return {
    events: claimed.events,
    revokedGrants,
  };
}
async function inputUpdatedEvent(
  transaction: Transaction<DatabaseSchema>,
  thread: Pick<ThreadRow, "environmentId" | "id">,
  row: Selectable<ThreadInputTable>,
): Promise<AgentEvent> {
  return appendHostDeploymentEvent(transaction, {
    data: {
      input: threadInputFromRow(row),
    },
    environmentId: thread.environmentId,
    runId: row.runId,
    threadId: thread.id,
    type: "thread-input.updated",
  });
}

/** Whether the person stopped this Run themselves, rather than a deadline or a cancelled task. */
async function runStoppedByPerson(
  database: Kysely<DatabaseSchema>,
  runId: RunId,
): Promise<boolean> {
  return (
    (await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", runId)
      .where("type", "=", "run.interrupt")
      .where(sql<string>`authority_source->>'kind'`, "=", "user-session")
      .limit(1)
      .executeTakeFirst()) !== undefined
  );
}

/** Whether the person stopped the Thread's newest Run themselves. */
export async function latestRunStoppedByPerson(
  database: Kysely<DatabaseSchema>,
  threadId: ThreadId,
): Promise<boolean> {
  const latest = await database
    .selectFrom("runs")
    .select("id")
    .where("threadId", "=", threadId)
    .orderBy("runOrdinal", "desc")
    .limit(1)
    .executeTakeFirst();
  return latest !== undefined && (await runStoppedByPerson(database, latest.id));
}

/**
 * A person's message in their conversation that a hand-off into a Run they
 * stopped never delivered ends with that reply: it does not start another.
 */
async function endsWithStoppedReply(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly authoritySource: Readonly<Record<string, unknown>>;
    readonly policy: string;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  },
): Promise<boolean> {
  if (!isPersonsMessage(input)) return false;
  const run = await transaction
    .selectFrom("runs")
    .innerJoin("threads", "threads.id", "runs.threadId")
    .select(["threads.purpose", "runs.replyTarget"])
    .where("runs.id", "=", input.runId)
    .where("runs.threadId", "=", input.threadId)
    .executeTakeFirstOrThrow();
  return (
    (await conversationalReply(transaction, run, run.replyTarget)) &&
    (await runStoppedByPerson(transaction, input.runId))
  );
}

/**
 * The person stopped the conversation's reply: the follow-ups they had sent
 * for it that it has not taken end with it, and say so. A hand-off already on
 * its way to the Runner keeps its receipt; one a refusal later returns is
 * settled the same way (`endsWithStoppedReply`). Anything sent after this
 * commits is the next reply's. The caller holds the Run, Thread and
 * the Run's projection rows (`lockRunProjectionRows`).
 */
export async function settleStoppedConversationInputs(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<readonly AgentEvent[]> {
  const run = await transaction
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", run.threadId)
    .executeTakeFirstOrThrow();
  if (run.voiceSessionId || !(await conversationalReply(transaction, thread, run.replyTarget)))
    return [];
  const now = new Date();
  const replacement = await pendingReplacementAttempt(transaction, run.id);
  const restartSent = replacement?.dispatchedAt != null;
  const handed = await transaction
    .selectFrom("threadInputs")
    .innerJoin("commands", "commands.id", "threadInputs.steerCommandId")
    .select([
      "commands.id as commandId",
      "commands.status",
      "commands.type",
      "threadInputs.messageId",
    ])
    .where("threadInputs.runId", "=", run.id)
    .where("threadInputs.state", "=", "claimed")
    .where("threadInputs.policy", "=", "queue")
    .where(sql<string>`thread_inputs.authority_source->>'kind'`, "in", [
      ...personAuthoritySourceKinds,
    ])
    .where((expression) =>
      expression.or([
        expression.and([
          expression("commands.type", "=", "run.steer"),
          expression("commands.status", "=", "pending"),
        ]),
        ...(restartSent ? [] : [expression("commands.type", "=", "run.restart")]),
      ]),
    )
    .execute();
  const cancelled: Selectable<ThreadInputTable>[] = [];
  if (handed.length > 0) {
    await transaction
      .updateTable("commands")
      .set({
        lastError: jsonValue({
          message: "The reply was stopped before this message reached it",
        }),
        status: "failed",
        updatedAt: now,
      })
      .where(
        "id",
        "in",
        handed.map(({ commandId }) => commandId),
      )
      .where("status", "=", "pending")
      .execute();
    cancelled.push(
      ...(await transaction
        .updateTable("threadInputs")
        .set({
          cancelReason: "stopped",
          state: "cancelled",
          updatedAt: now,
        })
        .where(
          "messageId",
          "in",
          handed.map(({ messageId }) => messageId),
        )
        .where("state", "=", "claimed")
        .returningAll()
        .execute()),
    );
  }
  cancelled.push(
    ...(await transaction
      .updateTable("threadInputs")
      .set({
        cancelReason: "stopped",
        state: "cancelled",
        updatedAt: now,
      })
      .where(
        "messageId",
        "in",
        conversationFollowUps(transaction, run, thread.id).select("threadInputs.messageId"),
      )
      .returningAll()
      .execute()),
  );
  const cancelledById = new Map(cancelled.map((row) => [row.messageId, row]));
  const order =
    cancelled.length === 0
      ? []
      : await transaction
          .selectFrom("threadInputs")
          .select("messageId")
          .where("messageId", "in", [...cancelledById.keys()])
          .orderBy("queueRank", "asc")
          .execute();
  const events: AgentEvent[] = [];
  for (const { messageId } of order)
    events.push(await inputUpdatedEvent(transaction, thread, cancelledById.get(messageId)!));
  return events;
}

/** Each steered message has its own restart; the first one interrupts the attempt. */
function restartPayload(
  run: Pick<RunRow, "bindingGeneration" | "id" | "threadId">,
  messageId: MessageId,
) {
  if (run.bindingGeneration === null) throw new Error("A running Run has no binding");
  return {
    bindingGeneration: run.bindingGeneration,
    messageId,
    runId: run.id,
    threadId: run.threadId,
    type: "run.restart",
  } as const;
}

/**
 * Replaces the attempt a restart interrupts, unless a replacement is already
 * waiting, and ends its tools now. Attempts and grants rank after the steered
 * input, so this is the steer's last write.
 */
async function supersedeForRestart(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<readonly RevokedRunGrant[]> {
  await supersedeCurrentAttempt(transaction, runId);
  return revokeRunGrants(transaction, [runId], "superseded");
}

/** Promotion preserves the message, original queue intent, and send fingerprint. */
export async function steerThreadInputInTransaction(
  transaction: Transaction<DatabaseSchema>,
  request: SteerThreadInputRequest,
): Promise<EnqueuedThreadInput> {
  requireBoundedIdentity(request.idempotencyKey, "Steer idempotency key", 255);
  await lockCommandIdempotency(transaction, request.requestedBy, request.idempotencyKey);
  const run = await transaction
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", request.expectedRunId)
    .where("threadId", "=", request.threadId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!run)
    throw new OpensteerError({
      code: "conflict",
      message: "The target Run is no longer available",
    });
  await lockThreadRow(transaction, request.threadId);
  await requirePersonalOwner(transaction, request.requestedBy);
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", request.threadId)
    .executeTakeFirstOrThrow();
  await requireExecutionEnvironmentAccess(
    transaction,
    thread.environmentId,
    request.requestedBy,
    "Only the execution owner can steer this Thread",
  );
  const row = await transaction
    .selectFrom("threadInputs")
    .selectAll()
    .where("messageId", "=", request.messageId)
    .where("threadId", "=", thread.id)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!row || !canManageQueuedInput(row, request))
    throw new OpensteerError({
      code: "forbidden",
      message: "Only your own queued messages can be steered",
    });
  const existing = await transaction
    .selectFrom("commands")
    .selectAll()
    .where("requestedBy", "=", request.requestedBy)
    .where("idempotencyKey", "=", request.idempotencyKey)
    .executeTakeFirst();
  if (existing) {
    const replayed = existing.payload as Readonly<Record<string, unknown>>;
    if (
      (existing.type !== "run.steer" && existing.type !== "run.restart") ||
      replayed.runId !== request.expectedRunId ||
      replayed.threadId !== request.threadId ||
      replayed.messageId !== request.messageId
    )
      throw idempotencyConflict(request.idempotencyKey);
    return replayThreadInput(transaction, row);
  }
  if (row.freshContext)
    throw new OpensteerError({
      code: "bad_request",
      message: "A fresh-context input must start its own Run and cannot be steered.",
    });
  // A stopped or cancelled Run keeps running until its Runner winds it down,
  // but it takes nothing new.
  const route = run.status === "running" ? await steerRoute(transaction, run.id) : null;
  const holder = route === null ? null : await runHolder(transaction, run.id);
  if (
    route === null ||
    thread.inputQueuePaused ||
    thread.status === "archived" ||
    run.status !== "running" ||
    run.requestedBy !== request.requestedBy ||
    run.environmentId !== thread.environmentId ||
    run.harnessInstanceId !== thread.harnessInstanceId ||
    !compatibleSteeringTarget(run.replyTarget, row) ||
    !(await threadExecutionIsAvailableToUser(transaction, thread.id, request.requestedBy))
  ) {
    throw new OpensteerError({
      code: "conflict",
      message: "This Run cannot accept steering. Your message remains queued.",
    });
  }
  const pendingMessage = await transaction
    .selectFrom("messages")
    .select("content")
    .where("id", "=", row.messageId)
    .executeTakeFirstOrThrow();
  const placeFailure = placeInputFailure(
    ContentPartSchema.array().parse(pendingMessage.content),
    holder?.capabilities ?? [],
  );
  if (placeFailure)
    throw new OpensteerError({
      code: "conflict",
      message: placeFailure,
    });
  const reserved = await transaction
    .selectFrom("runs")
    .select("id")
    .where("seedInputId", "=", row.messageId)
    .where("status", "in", nonTerminalRunStatuses)
    .executeTakeFirst();
  if (row.policy !== "queue" || row.state !== "pending" || row.steerCommandId !== null || reserved)
    throw new OpensteerError({
      code: "conflict",
      message: "This message is no longer waiting in the queue",
    });
  const payload =
    route === "native"
      ? ({
          type: "run.steer",
          runId: run.id,
          threadId: thread.id,
          messageId: row.messageId,
        } as const)
      : restartPayload(run, row.messageId);
  const command = await transaction
    .insertInto("commands")
    .values({
      actorPrincipalId: row.actorPrincipalId,
      authoritySource: row.authoritySource,
      dispatcherId: null,
      environmentId: run.environmentId,
      id: createId("command"),
      idempotencyKey: request.idempotencyKey,
      lastError: null,
      payload: jsonValue(payload),
      requestedBy: request.requestedBy,
      runId: run.id,
      status: "pending",
      threadId: thread.id,
      type: payload.type,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const promoted = await transaction
    .updateTable("threadInputs")
    .set({
      state: "claimed",
      runId: run.id,
      steerCommandId: command.id,
      updatedAt: new Date(),
    })
    .where("messageId", "=", row.messageId)
    .returningAll()
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable("messages")
    .set({
      runId: run.id,
    })
    .where("id", "=", row.messageId)
    .execute();
  await recordPersonWaited(transaction, run.id);
  const placed = await placeQueuedMessage(transaction, thread, row.messageId, run.id);
  const event = await appendHostDeploymentEvent(transaction, {
    data: {
      input: threadInputFromRow(promoted),
    },
    environmentId: run.environmentId,
    runId: run.id,
    threadId: thread.id,
    type: "thread-input.updated",
  });
  const revokedGrants = route === "restart" ? await supersedeForRestart(transaction, run.id) : [];
  return {
    ...(await replayThreadInput(transaction, promoted)),
    events: [placed, event],
    revokedGrants,
    wasDuplicate: false,
  };
}

/**
 * Moves one of the reader's own waiting messages to just before another
 * waiting message, or to the back of the queue. Only the order changes: the
 * ranks the queue already holds are handed out again in the new order, so
 * work sent afterwards still lands behind all of it. A neighbour that has
 * left the queue is refused rather than guessed at, because the place the
 * person chose no longer exists.
 */
export async function moveThreadInputInTransaction(
  transaction: Transaction<DatabaseSchema>,
  request: MoveThreadInputRequest,
): Promise<MovedThreadInput> {
  requireBoundedIdentity(request.idempotencyKey, "Move idempotency key", 255);
  await lockCommandIdempotency(transaction, request.requestedBy, request.idempotencyKey);
  const observed = await transaction
    .selectFrom("threads")
    .where("id", "=", request.threadId)
    .executeTakeFirst();
  if (!observed)
    throw new OpensteerError({
      code: "not_found",
      message: "Thread not found",
    });
  await lockThreadRow(transaction, request.threadId);
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", request.threadId)
    .executeTakeFirstOrThrow();
  const row = await transaction
    .selectFrom("threadInputs")
    .selectAll()
    .where("messageId", "=", request.messageId)
    .where("threadId", "=", thread.id)
    .executeTakeFirst();
  if (!row || !canManageQueuedInput(row, request))
    throw new OpensteerError({
      code: "forbidden",
      message: "Only your own queued messages can be moved",
    });
  const payload = {
    type: "thread.input.move",
    threadId: request.threadId,
    messageId: request.messageId,
    beforeMessageId: request.beforeMessageId,
  } as const;
  const existing = await findCommandByIdempotency(
    transaction,
    request.requestedBy,
    request.idempotencyKey,
  );
  if (existing) {
    if (!isDeepStrictEqual(existing.payload, payload))
      throw idempotencyConflict(request.idempotencyKey);
    return {
      events: [],
      wasDuplicate: true,
    };
  }
  if (thread.status === "archived")
    throw new OpensteerError({
      code: "conflict",
      message: "Archived threads cannot run",
    });
  const waiting = await waitingThreadInputs(transaction, thread.id);
  const moving = waiting.find((input) => input.messageId === request.messageId);
  const before =
    request.beforeMessageId === null
      ? null
      : waiting.find((input) => input.messageId === request.beforeMessageId);
  if (!moving || before === undefined)
    throw new OpensteerError({
      code: "conflict",
      message: "This message is no longer waiting in the queue",
    });
  // Nothing dispatches this command; the row exists so a retry with the same
  // key replays the move instead of applying it over a newer arrangement.
  await transaction
    .insertInto("commands")
    .values({
      actorPrincipalId: row.actorPrincipalId,
      authoritySource: row.authoritySource,
      dispatcherId: null,
      environmentId: thread.environmentId,
      id: createId("command"),
      idempotencyKey: request.idempotencyKey,
      lastError: null,
      payload: jsonValue(payload),
      requestedBy: request.requestedBy,
      runId: null,
      status: "succeeded",
      threadId: thread.id,
      type: payload.type,
    })
    .execute();
  await transaction
    .selectFrom("threadInputs")
    .select("messageId")
    .where(
      "messageId",
      "in",
      waiting.map(({ messageId }) => messageId),
    )
    .orderBy("messageId", "asc")
    .forNoKeyUpdate()
    .execute();
  for (const [index, input] of moveQueueItem(waiting, moving, before).entries()) {
    const rank = waiting[index]!.queueRank;
    if (input.queueRank === rank) continue;
    await transaction
      .updateTable("threadInputs")
      .set({
        queueRank: rank,
        updatedAt: new Date(),
      })
      .where("messageId", "=", input.messageId)
      .execute();
  }
  const event = await appendHostDeploymentEvent(transaction, {
    data: {
      paused: thread.inputQueuePaused,
    },
    environmentId: thread.environmentId,
    runId: null,
    threadId: thread.id,
    type: "thread.input-queue-updated",
  });
  return {
    events: [event],
    wasDuplicate: false,
  };
}

/**
 * Withdrawal retires the queue entry and keeps the Message in the durable
 * ledger: a person takes back what they said before a Run hears it, they do
 * not unsay it. The Deployment snapshot omits the Message so a reconnecting
 * conversation never seeds it as sent.
 */
export async function cancelThreadInputInTransaction(
  transaction: Transaction<DatabaseSchema>,
  request: CancelThreadInputRequest,
): Promise<CancelledThreadInput> {
  requireBoundedIdentity(request.idempotencyKey, "Cancel idempotency key", 255);
  await lockCommandIdempotency(transaction, request.requestedBy, request.idempotencyKey);
  const observed = await transaction
    .selectFrom("threads")
    .where("id", "=", request.threadId)
    .executeTakeFirst();
  if (!observed)
    throw new OpensteerError({
      code: "not_found",
      message: "Thread not found",
    });
  await lockThreadRow(transaction, request.threadId);
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", request.threadId)
    .executeTakeFirstOrThrow();
  const row = await transaction
    .selectFrom("threadInputs")
    .selectAll()
    .where("messageId", "=", request.messageId)
    .where("threadId", "=", thread.id)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!row || !canManageQueuedInput(row, request))
    throw new OpensteerError({
      code: "forbidden",
      message: "Only your own queued messages can be cancelled",
    });
  const payload = {
    type: "thread.input.cancel",
    threadId: request.threadId,
    messageId: request.messageId,
  } as const;
  const existing = await findCommandByIdempotency(
    transaction,
    request.requestedBy,
    request.idempotencyKey,
  );
  if (existing) {
    if (!isDeepStrictEqual(existing.payload, payload))
      throw idempotencyConflict(request.idempotencyKey);
    return {
      events: [],
      input: threadInputFromRow(row),
      wasDuplicate: true,
    };
  }
  if (thread.status === "archived")
    throw new OpensteerError({
      code: "conflict",
      message: "Archived threads cannot run",
    });
  const reserved = await transaction
    .selectFrom("runs")
    .select("id")
    .where("seedInputId", "=", row.messageId)
    .where("status", "in", nonTerminalRunStatuses)
    .executeTakeFirst();
  if (row.policy !== "queue" || row.state !== "pending" || row.steerCommandId !== null || reserved)
    throw new OpensteerError({
      code: "conflict",
      message: "This message is no longer waiting in the queue",
    });
  // Nothing dispatches this command; the row exists so a retry with the same
  // key replays the withdrawal instead of finding the input already gone.
  await transaction
    .insertInto("commands")
    .values({
      actorPrincipalId: row.actorPrincipalId,
      authoritySource: row.authoritySource,
      dispatcherId: null,
      environmentId: thread.environmentId,
      id: createId("command"),
      idempotencyKey: request.idempotencyKey,
      lastError: null,
      payload: jsonValue(payload),
      requestedBy: request.requestedBy,
      runId: null,
      status: "succeeded",
      threadId: thread.id,
      type: payload.type,
    })
    .execute();
  const cancelled = await transaction
    .updateTable("threadInputs")
    .set({
      cancelReason: "withdrawn",
      state: "cancelled",
      updatedAt: new Date(),
    })
    .where("messageId", "=", row.messageId)
    .returningAll()
    .executeTakeFirstOrThrow();
  const input = threadInputFromRow(cancelled);
  const event = await appendHostDeploymentEvent(transaction, {
    data: {
      input,
    },
    environmentId: thread.environmentId,
    runId: null,
    threadId: thread.id,
    type: "thread-input.updated",
  });
  return {
    events: [event],
    input,
    wasDuplicate: false,
  };
}
export async function claimRunInputBatch(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<readonly AgentEvent[]> {
  const run = await transaction
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  await lockThreadRow(transaction, run.threadId);
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", run.threadId)
    .executeTakeFirstOrThrow();
  if (thread.inputQueuePaused)
    throw new OpensteerError({
      code: "conflict",
      message: "The Thread work queue is paused",
    });
  if (run.reportContext !== null) return [];
  const seed = await transaction
    .selectFrom("threadWorkInputs")
    .selectAll()
    .where("messageId", "=", run.seedInputId)
    .where("threadId", "=", run.threadId)
    .where("state", "=", "pending")
    .executeTakeFirst();
  if (!seed)
    throw new OpensteerError({
      code: "conflict",
      message: "A Run must start with its queued work item",
    });

  const events: AgentEvent[] = [];
  if (seed.freshContext) {
    const providerSessionId = await ensureSelectedProviderSession(transaction, thread, {
      freshRunId: run.id,
      personalContext: await threadAllowsPersonalContext(transaction, thread.id, thread.createdBy),
    });
    await transaction
      .updateTable("runs")
      .set({ providerSessionId })
      .where("id", "=", run.id)
      .execute();
    run.providerSessionId = providerSessionId;
    const updated = await transaction
      .selectFrom("threads")
      .selectAll()
      .select([
        threadPendingRequestsSelection,
        threadVisitSelection,
        threadLatestRunCompletedAtSelection,
        threadProviderSessionSelection,
        threadContinuationIdentitySelection,
      ])
      .where("id", "=", thread.id)
      .executeTakeFirstOrThrow();
    events.push(
      await appendHostDeploymentEvent(transaction, {
        data: { thread: threadFromRow(updated) },
        environmentId: thread.environmentId,
        runId: null,
        threadId: thread.id,
        type: "thread.execution-updated",
      }),
    );
  }
  const seedMessage = await transaction
    .selectFrom("messages")
    .select("sequence")
    .where("id", "=", seed.messageId)
    .executeTakeFirstOrThrow();
  const boundary = seed.freshContext
    ? seedMessage.sequence
    : await freshContextBoundary(transaction, run);
  // The Thread lock defines one snapshot for both first dispatch and retries.
  // Reports share delivery receipts with work, but never enter the work view.
  const throughSequence = (BigInt(thread.nextMessageSequence) - 1n).toString();
  const eligible = transaction
    .selectFrom("threadInputs")
    .innerJoin("messages", "messages.id", "threadInputs.messageId")
    .where("threadInputs.threadId", "=", run.threadId)
    .where("threadInputs.policy", "=", "report")
    .where("threadInputs.state", "in", ["pending", "unknown"])
    .where("threadInputs.requestedBy", "=", run.requestedBy)
    .where(
      sql<boolean>`thread_inputs.reply_target is not distinct from ${run.replyTarget === null ? null : JSON.stringify(run.replyTarget)}::jsonb`,
    )
    .where("messages.sequence", "<=", throughSequence);
  const total = await eligible
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();
  const reportIds: MessageId[] = [];
  let cancelledCount = 0;
  let bytes = 2; // JSON array delimiters.
  let afterSequence = "-1";
  selection: while (reportIds.length < threadReportBatchMaxEntries) {
    const candidates = await eligible
      .selectAll("messages")
      .where("messages.sequence", ">", afterSequence)
      .orderBy("messages.sequence", "asc")
      .limit(threadReportBatchMaxEntries)
      .execute();
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      afterSequence = String(candidate.sequence);
      if (!(await channelInputAuthorityIsCurrent(transaction, candidate.id))) {
        const cancelled = await transaction
          .updateTable("threadInputs")
          .set({
            cancelReason: "channel-authority-unavailable",
            state: "cancelled",
            updatedAt: new Date(),
          })
          .where("messageId", "=", candidate.id)
          .where("state", "in", ["pending", "unknown"])
          .returningAll()
          .executeTakeFirst();
        if (cancelled) {
          cancelledCount += 1;
          events.push(
            await appendHostDeploymentEvent(transaction, {
              data: {
                input: threadInputFromRow(cancelled),
              },
              environmentId: thread.environmentId,
              runId: cancelled.runId,
              threadId: thread.id,
              type: "thread-input.updated",
            }),
          );
        }
        continue;
      }
      const candidateBytes =
        Buffer.byteLength(JSON.stringify(messageFromRow(candidate)), "utf8") + 1;
      if (bytes + candidateBytes > threadReportBatchMaxSerializedBytes) break selection;
      reportIds.push(candidate.id);
      bytes += candidateBytes;
      if (reportIds.length === threadReportBatchMaxEntries) break selection;
    }
  }
  const selected = [seed.messageId, ...reportIds];
  const now = new Date();
  const claimed = await transaction
    .updateTable("threadInputs")
    .set({
      runId,
      state: "claimed",
      updatedAt: now,
    })
    .where("messageId", "in", selected)
    .where("state", "in", ["pending", "unknown"])
    .returningAll()
    .execute();
  if (claimed.length !== selected.length)
    throw new OpensteerError({
      code: "conflict",
      message: "Run context changed while claiming",
    });
  await transaction
    .updateTable("messages")
    .set({
      runId,
    })
    .where("id", "in", selected)
    .execute();
  await recordPersonWaited(transaction, runId);
  let initialContext: {
    readonly messageIds: readonly MessageId[];
    readonly omittedCount: number;
    readonly throughSequence: string | null;
  } | null = null;
  if (
    !seed.freshContext &&
    run.providerSessionId &&
    !(await isMemoryPassWake(transaction, run.threadId, seed.authoritySource))
  ) {
    const priorAccepted = await transaction
      .selectFrom("runs")
      .select("id")
      .where("providerSessionId", "=", run.providerSessionId)
      .where("id", "!=", run.id)
      .where("startedAt", "is not", null)
      .limit(1)
      .executeTakeFirst();
    if (!priorAccepted) {
      const history = transaction
        .selectFrom("messages")
        .leftJoin("threadInputs", "threadInputs.messageId", "messages.id")
        .where("messages.threadId", "=", run.threadId)
        .where("messages.sequence", "<", seedMessage.sequence)
        .$if(boundary !== null, (query) => query.where("messages.sequence", ">=", boundary!))
        .where((expression) =>
          expression.or([
            expression("threadInputs.messageId", "is", null),
            expression("threadInputs.state", "=", "delivered"),
          ]),
        );
      const total = await history
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .executeTakeFirstOrThrow();
      const candidates = await history
        .selectAll("messages")
        .orderBy("messages.sequence", "desc")
        .limit(runHistoryMaxMessages)
        .execute();
      const messageIds: MessageId[] = [];
      let bytes = 2;
      for (const candidate of candidates) {
        const size = Buffer.byteLength(JSON.stringify(messageFromRow(candidate)), "utf8") + 1;
        if (bytes + size > runHistoryMaxSerializedBytes) break;
        messageIds.push(candidate.id);
        bytes += size;
      }
      messageIds.reverse();
      if (safeCount(total.count) > 0) {
        initialContext = {
          messageIds,
          omittedCount: safeCount(total.count) - messageIds.length,
          throughSequence:
            BigInt(seedMessage.sequence) > 0n
              ? (BigInt(seedMessage.sequence) - 1n).toString()
              : null,
        };
      }
    }
  }
  await transaction
    .updateTable("runs")
    .set({
      initialContext: initialContext ? jsonValue(initialContext) : null,
      reportContext: jsonValue({
        messageIds: reportIds,
        omittedCount: safeCount(total.count) - cancelledCount - reportIds.length,
        throughSequence,
      }),
    })
    .where("id", "=", runId)
    .execute();
  for (const row of claimed)
    events.push(
      await appendHostDeploymentEvent(transaction, {
        data: {
          input: threadInputFromRow(row),
        },
        environmentId: thread.environmentId,
        runId,
        threadId: run.threadId,
        type: "thread-input.updated",
      }),
    );
  events.push(...(await claimConversationBatch(transaction, runId, runExecuteInputsMax - 1)));
  return events;
}

/**
 * A conversation's dispatch takes the person's other waiting messages along
 * with the one it starts with, so what they sent before the engine could
 * start arrives as one turn rather than one reply each. Bounded by what one
 * dispatch carries. The caller holds the claim's prefix through the Thread's
 * inputs (`lockRunProjectionRows`).
 */
export async function claimConversationBatch(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
  capacity: number,
): Promise<readonly AgentEvent[]> {
  const run = await transaction
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", run.threadId)
    .executeTakeFirstOrThrow();
  if (capacity <= 0 || !(await conversationalReply(transaction, thread, run.replyTarget)))
    return [];
  return (
    await claimFollowUps(transaction, run, thread, {
      limit: capacity,
    })
  ).events;
}

/**
 * A conversation an earlier Host paused on Stop. A conversation no longer
 * pauses, and nothing would show its Resume, so startup settles it once in
 * the conversation's own terms: what the person sent for the reply they
 * stopped ends with it ("stopped"), and what tasks, Triggers and other agents
 * left for that reply stays as context for the person's next turn (a report)
 * rather than running now or being dropped. No Run waits behind such a pause:
 * a queued Run is never created while a Thread is paused, and Stop ends one
 * that no Runner holds. Records are kept and every change is an event.
 * Settling an unpaused conversation does nothing.
 */
export async function settlePausedConversation(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
): Promise<readonly AgentEvent[]> {
  await lockThreadRow(transaction, threadId);
  await lockRunProjectionRows(transaction, {
    runIds: [],
    threadIds: [threadId],
  });
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  if (thread.purpose !== "voice" || !thread.inputQueuePaused) return [];
  const now = new Date();
  const events: AgentEvent[] = [];
  const held = await transaction
    .selectFrom("threadInputs")
    .select(["authoritySource", "messageId", "queueRank"])
    .where("threadId", "=", threadId)
    .where("policy", "=", "queue")
    .where("state", "=", "pending")
    .orderBy("queueRank", "asc")
    .execute();
  for (const row of held) {
    const settled = await transaction
      .updateTable("threadInputs")
      .set(
        isPersonsMessage({
          authoritySource: row.authoritySource,
          policy: "queue",
        })
          ? {
              cancelReason: "stopped",
              state: "cancelled",
              updatedAt: now,
            }
          : {
              policy: "report",
              updatedAt: now,
            },
      )
      .where("messageId", "=", row.messageId)
      .where("state", "=", "pending")
      .returningAll()
      .executeTakeFirstOrThrow();
    events.push(await inputUpdatedEvent(transaction, thread, settled));
  }
  await transaction
    .updateTable("threads")
    .set({
      inputQueuePaused: false,
      inputQueuePausedBy: null,
      updatedAt: now,
    })
    .where("id", "=", threadId)
    .execute();
  events.push(
    await appendHostDeploymentEvent(transaction, {
      data: {
        paused: false,
      },
      environmentId: thread.environmentId,
      runId: null,
      threadId,
      type: "thread.input-queue-updated",
    }),
  );
  events.push(...(await projectThreadState(transaction, threadId, now)));
  return events;
}

/** What a restart's replacement attempt can still take along when it is dispatched. */
export async function restartBatchCapacity(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<number> {
  return runExecuteInputsMax - (await restartInputCount(transaction, runId));
}
export async function settleSteer(
  transaction: Transaction<DatabaseSchema>,
  commandId: CommandRow["id"],
  outcome: "failed" | "unknown",
  reason: string,
  reasonCode?: string,
): Promise<readonly AgentEvent[]> {
  const observed = await transaction
    .selectFrom("commands")
    .innerJoin("threadInputs", "threadInputs.steerCommandId", "commands.id")
    .innerJoin("threads", "threads.id", "threadInputs.threadId")
    .select([
      "commands.id as commandId",
      "commands.runId",
      "threadInputs.authoritySource",
      "threadInputs.causalChainId",
      "threadInputs.messageId",
      "threadInputs.policy",
      "threads.environmentId",
      "threads.id as threadId",
      "threads.purpose",
    ])
    .where("commands.id", "=", commandId)
    .where("commands.type", "=", "run.steer")
    .executeTakeFirst();
  if (!observed?.runId) return [];
  // Every path that settles delivery against a Run takes the same global
  // order.  In particular, an RPC acknowledgement must never hold Command
  // while a terminal Runner event holds Run and waits for that Command.
  const run = await transaction
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", observed.runId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!run) return [];
  const channelAuthorityCurrent = await channelInputAuthorityIsCurrent(
    transaction,
    observed.messageId,
  );
  await lockThreadRow(transaction, observed.threadId);
  // A refusal can return the hand-offs behind this one as well.
  await lockRunProjectionRows(transaction, {
    runIds: [run.id],
    threadIds: [observed.threadId],
  });
  const command = await transaction
    .selectFrom("commands")
    .select(["id", "status"])
    .where("id", "=", commandId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!command || !["pending", "dispatched"].includes(command.status)) return [];
  const now = new Date();
  // A refusal proves the message never reached a reply the person stopped.
  const stopped =
    outcome === "failed" &&
    (await endsWithStoppedReply(transaction, {
      authoritySource: observed.authoritySource,
      policy: observed.policy,
      runId: observed.runId,
      threadId: observed.threadId,
    }));
  await transaction
    .updateTable("commands")
    .set({
      lastError: jsonValue({
        message: channelAuthorityCurrent
          ? reason.trim().slice(0, 500) || "Steer was refused"
          : "Channel authority changed before the input could be delivered",
      }),
      status: channelAuthorityCurrent ? outcome : "failed",
      updatedAt: now,
    })
    .where("id", "=", commandId)
    .execute();
  const inputRow = await transaction
    .updateTable("threadInputs")
    .set(
      !channelAuthorityCurrent
        ? {
            cancelReason: "channel-authority-unavailable",
            state: "cancelled",
            updatedAt: now,
          }
        : stopped
          ? {
              cancelReason: "stopped",
              state: "cancelled",
              updatedAt: now,
            }
          : outcome === "failed"
            ? observed.policy === "queue" || reasonCode === "request-pending"
              ? {
                  cancelReason: null,
                  state: "pending",
                  policy: reasonCode === "request-pending" ? "queue" : observed.policy,
                  runId: null,
                  steerCommandId: null,
                  updatedAt: now,
                }
              : {
                  cancelReason: "steer-refused",
                  state: "cancelled",
                  updatedAt: now,
                }
            : {
                state: "unknown",
                updatedAt: now,
              },
    )
    .where("messageId", "=", observed.messageId)
    .where("state", "=", "claimed")
    .returningAll()
    .executeTakeFirst();
  if (!inputRow) return [];
  if (inputRow.state === "pending") {
    await transaction
      .updateTable("messages")
      .set({
        runId: null,
      })
      .where("id", "=", inputRow.messageId)
      .execute();
  }
  const input = threadInputFromRow(inputRow);
  const events: AgentEvent[] = [
    await appendHostDeploymentEvent(transaction, {
      data: {
        input,
      },
      environmentId: observed.environmentId,
      runId: input.runId,
      threadId: observed.threadId,
      type: "thread-input.updated",
    }),
  ];
  if (
    inputRow.state === "pending" &&
    isPersonsMessage(observed) &&
    (await conversationalReply(transaction, observed, run.replyTarget))
  )
    events.push(...(await returnHandOffsBehind(transaction, commandId, run, observed)));
  return events;
}

/**
 * A person's message a Run refused waits for the next moment it can be handed
 * over, and so does every later one from the same exchange that was handed to
 * that Run but not yet sent: one control command per Thread is in flight at a
 * time, so those provably never reached the Runner. The next hand-off, or the
 * next Run, takes them all again in the order they were sent.
 */
async function returnHandOffsBehind(
  transaction: Transaction<DatabaseSchema>,
  refusedCommandId: CommandRow["id"],
  run: RunRow,
  thread: Pick<ThreadRow, "environmentId"> & {
    readonly threadId: ThreadId;
  },
): Promise<readonly AgentEvent[]> {
  const behind = await exchangeInputs(transaction, run, thread.threadId, "claimed")
    .innerJoin("commands", "commands.id", "threadInputs.steerCommandId")
    .select(["commands.id as commandId", "threadInputs.messageId"])
    .where("threadInputs.runId", "=", run.id)
    .where("commands.type", "=", "run.steer")
    .where("commands.status", "=", "pending")
    .where(
      sql<boolean>`(commands.created_at, commands.id) > (select created_at, id from commands where id = ${refusedCommandId})`,
    )
    .orderBy("threadInputs.queueRank", "asc")
    .execute();
  if (behind.length === 0) return [];
  const now = new Date();
  const ids = behind.map(({ messageId }) => messageId);
  await transaction
    .updateTable("commands")
    .set({
      lastError: jsonValue({
        message: "A message sent before this one was not delivered",
      }),
      status: "failed",
      updatedAt: now,
    })
    .where(
      "id",
      "in",
      behind.map(({ commandId }) => commandId),
    )
    .where("status", "=", "pending")
    .execute();
  const returned = await transaction
    .updateTable("threadInputs")
    .set({
      cancelReason: null,
      runId: null,
      state: "pending",
      steerCommandId: null,
      updatedAt: now,
    })
    .where("messageId", "in", ids)
    .where("state", "=", "claimed")
    .returningAll()
    .execute();
  await transaction
    .updateTable("messages")
    .set({
      runId: null,
    })
    .where("id", "in", ids)
    .execute();
  const returnedById = new Map(returned.map((row) => [row.messageId, row]));
  const events: AgentEvent[] = [];
  for (const messageId of ids) {
    const row = returnedById.get(messageId);
    if (row)
      events.push(
        await inputUpdatedEvent(
          transaction,
          {
            environmentId: thread.environmentId,
            id: thread.threadId,
          },
          row,
        ),
      );
  }
  return events;
}
export async function settleOutstandingSteersForRun(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
  recoveringLostExecution = false,
): Promise<readonly AgentEvent[]> {
  // finalizeRunTransaction already owns the prefix in ./lock-order.ts. Commands
  // are locked only after those scope locks, matching settleSteer and the ACK
  // path. A promoted message is returned to its queue only with proof that
  // dispatch never happened. An uncertain delivery cannot become new work.
  const commands = await transaction
    .selectFrom("commands")
    .innerJoin("threadInputs", "threadInputs.steerCommandId", "commands.id")
    .select([
      "commands.id",
      "commands.status",
      "commands.type",
      "threadInputs.authoritySource",
      "threadInputs.causalChainId",
      "threadInputs.messageId",
      "threadInputs.policy",
      "threadInputs.state",
      "threadInputs.threadId",
    ])
    .where("commands.runId", "=", runId)
    .where("commands.type", "in", ["run.steer", "run.restart"])
    .where("threadInputs.state", "in", ["claimed", "unknown"])
    .orderBy("commands.createdAt", "asc")
    .forNoKeyUpdate("commands")
    .execute();
  // A restarted message is delivered by the next attempt's start, which has
  // not happened: it was never sent, unless that attempt reached a Runner.
  const replacement = commands.some((command) => command.type === "run.restart")
    ? await pendingReplacementAttempt(transaction, runId)
    : undefined;
  const restartSent = replacement?.dispatchedAt != null;
  const events: AgentEvent[] = [];
  for (const command of commands) {
    const now = new Date();
    const restart = command.type === "run.restart";
    const provedDelivered = !restart && command.status === "succeeded";
    // Retiring a command does not resolve its input's uncertain delivery.
    const provedNotDispatched =
      command.state !== "unknown" &&
      (restart ? !restartSent : command.status === "pending" || command.status === "failed");
    const stopped =
      !provedDelivered &&
      provedNotDispatched &&
      (await endsWithStoppedReply(transaction, {
        authoritySource: command.authoritySource,
        policy: command.policy,
        runId,
        threadId: command.threadId,
      }));
    const row = await transaction
      .updateTable("threadInputs")
      .set(
        provedDelivered
          ? {
              deliveredAt: now,
              state: "delivered",
              updatedAt: now,
            }
          : stopped
            ? {
                cancelReason: "stopped",
                state: "cancelled",
                updatedAt: now,
              }
            : command.policy === "queue" ||
                command.state === "unknown" ||
                (recoveringLostExecution && !provedNotDispatched)
              ? provedNotDispatched
                ? {
                    cancelReason: null,
                    state: "pending",
                    runId: null,
                    steerCommandId: null,
                    updatedAt: now,
                  }
                : {
                    state: "unknown",
                    updatedAt: now,
                  }
              : {
                  cancelReason: provedNotDispatched
                    ? "steer-not-delivered"
                    : "run-ended-delivery-unknown",
                  state: "cancelled",
                  updatedAt: now,
                },
      )
      .where("messageId", "=", command.messageId)
      .where("state", "in", ["claimed", "unknown"])
      .returningAll()
      .executeTakeFirst();
    // Finalization fails a restart that never reached the Runner itself.
    if (
      !restart &&
      (command.status === "pending" ||
        command.status === "dispatched" ||
        command.status === "unknown")
    ) {
      await transaction
        .updateTable("commands")
        .set({
          lastError: jsonValue({
            message: provedNotDispatched
              ? "The Run ended before this input could be dispatched"
              : "The Run ended before delivery could be confirmed",
          }),
          status: command.policy === "queue" && !provedNotDispatched ? "unknown" : "failed",
          updatedAt: now,
        })
        .where("id", "=", command.id)
        .where("status", "in", ["pending", "dispatched", "unknown"])
        .execute();
    }
    if (!row) continue;
    if (row.state === "pending") {
      await transaction
        .updateTable("messages")
        .set({
          runId: null,
        })
        .where("id", "=", row.messageId)
        .execute();
    }
    const thread = await transaction
      .selectFrom("threads")
      .select(["environmentId"])
      .where("id", "=", row.threadId)
      .executeTakeFirstOrThrow();
    events.push(
      await appendHostDeploymentEvent(transaction, {
        data: {
          input: threadInputFromRow(row),
        },
        environmentId: thread.environmentId,
        runId,
        threadId: row.threadId,
        type: "thread-input.updated",
      }),
    );
  }
  return events;
}
async function lockThreadInputPreconditions(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly requestedBy: UserId;
    readonly source: ThreadInputSource;
    readonly threadId: ThreadId;
    readonly policy: "report" | "queue" | "steer";
    readonly teamRequest?: EnqueueThreadInputRequest["teamRequest"];
    readonly memoryPass?: { readonly harnessInstanceId: HarnessInstanceId };
    readonly expectedHarnessRevision?: number;
  },
): Promise<{
  readonly executionValid: boolean;
  readonly prelockedActiveRunId: RunId | null;
  /** The source may bring this Done task back without the person: see `sourceReopensDoneTask`. */
  readonly reopensDone: boolean;
  readonly thread: ThreadRow;
}> {
  await requirePersonalOwner(transaction, input.requestedBy);
  const observed = await transaction
    .selectFrom("threads")
    .select("harnessInstanceId")
    .where("id", "=", input.threadId)
    .executeTakeFirstOrThrow(
      () => new OpensteerError({ code: "not_found", message: "Task not found" }),
    );
  const active = await transaction
    .selectFrom("runs")
    .select("id")
    .where("threadId", "=", input.threadId)
    .where("status", "=", "running")
    .executeTakeFirst();
  const sourceRunId =
    input.source.kind === "agent"
      ? input.source.runId
      : input.source.kind === "platform"
        ? input.source.sourceRunId
        : null;
  const runIds = [
    ...new Set([active?.id, sourceRunId].filter((id): id is RunId => Boolean(id))),
  ].sort();
  if (runIds.length)
    await transaction
      .selectFrom("runs")
      .select("id")
      .where("id", "in", runIds)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
  if (input.source.kind === "trigger")
    await transaction
      .selectFrom("triggerOccurrences")
      .select("id")
      .where("id", "=", input.source.occurrenceId)
      .forNoKeyUpdate()
      .executeTakeFirst();
  const harnessId =
    input.memoryPass?.harnessInstanceId ??
    (input.expectedHarnessRevision === undefined ? undefined : observed.harnessInstanceId);
  const harness = harnessId
    ? await transaction
        .selectFrom("harnessInstances")
        .select("runtimeRevision")
        .where("id", "=", harnessId)
        .forShare()
        .executeTakeFirst()
    : null;
  if (
    input.expectedHarnessRevision !== undefined &&
    harness?.runtimeRevision !== input.expectedHarnessRevision
  )
    throw harnessRevisionChanged();
  await lockThreadChannelAuthorities(transaction, [input.threadId]);
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", input.threadId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  if (input.source.kind === "platform" && input.source.cause === taskQuestionCause) {
    const question = await taskQuestionNoticeSource(
      transaction,
      RequestIdSchema.parse(input.source.referenceId),
    );
    const worker = question
      ? await transaction
          .selectFrom("threads")
          .selectAll()
          .where("id", "=", question.request.originatingThreadId)
          .executeTakeFirst()
      : null;
    if (
      !question ||
      !worker ||
      question.parentThreadId !== thread.id ||
      question.parentRunId !== sourceRunId ||
      !threadAccessModeAtMost(worker.accessMode, thread.accessMode)
    )
      throw new OpensteerError({ code: "conflict", message: "Task question is unavailable" });
  }
  if (input.source.kind === "watch")
    await transaction
      .selectFrom("triggerWatchActivations")
      .select("id")
      .where("id", "=", input.source.activationId)
      .forNoKeyUpdate()
      .executeTakeFirst();
  const reopensDone =
    thread.doneAt !== null &&
    (await sourceReopensDoneTask(transaction, input.source, input.policy, thread.id));
  if (
    thread.doneAt &&
    input.policy !== "report" &&
    input.source.kind !== "human" &&
    !input.teamRequest &&
    !reopensDone &&
    !(
      input.source.kind === "trigger" &&
      (await isMemoryPassWake(transaction, thread.id, {
        kind: "trigger-occurrence",
        occurrenceId: input.source.occurrenceId,
      }))
    )
  )
    throw new OpensteerError({ code: "conflict", message: "This task is Done. Reopen it first." });
  return {
    reopensDone,
    thread,
    prelockedActiveRunId: active?.id ?? null,
    executionValid:
      input.policy === "report" ||
      (thread.status !== "archived" &&
        (await threadExecutionIsAvailableToUser(transaction, thread.id, input.requestedBy))),
  };
}

interface ResolvedThreadInputFacts {
  readonly actorPrincipalId: PrincipalId;
  readonly author: MessageAuthor;
  readonly authoritySource: Readonly<Record<string, unknown>>;
  /** Human ingress acquires a root only after delivery chooses steer vs. a new Run. */
  readonly causalChainId: CausalChainId | null;
  readonly kind: MessageKind;
  readonly replyTarget: ReplyTarget | null;
  /** A managed memory pass's own wake, admitted onto its idle worker. */
  readonly memoryPass?: true;
}

async function assertThreadInputCapacity(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
  contentBytes: number,
  policy: "report" | "queue" | "steer" = "queue",
  replacingMessageId?: MessageId,
): Promise<void> {
  const pendingUsage = await transaction
    .selectFrom("threadInputs")
    .innerJoin("messages", "messages.id", "threadInputs.messageId")
    .select(({ fn }) => [
      fn.countAll<string>().as("count"),
      sql<string>`coalesce(sum(octet_length(messages.content::text)), 0)`.as("bytes"),
    ])
    .where("threadInputs.threadId", "=", threadId)
    .where("threadInputs.state", "in", ["pending", "claimed", "unknown"])
    .where("threadInputs.policy", policy === "report" ? "=" : "!=", "report")
    .$if(replacingMessageId !== undefined, (query) =>
      query.where("threadInputs.messageId", "!=", replacingMessageId!),
    )
    .executeTakeFirstOrThrow();
  const maxEntries =
    policy === "report" ? threadReportMaxPendingEntries : threadInputMaxPendingEntries;
  const maxBytes =
    policy === "report"
      ? threadReportMaxPendingSerializedBytes
      : threadInputMaxPendingSerializedBytes;
  if (safeCount(pendingUsage.count) >= maxEntries) {
    throw new OpensteerError({
      code: "resource_exhausted",
      message: `A Thread can hold at most ${maxEntries} undelivered ${policy === "report" ? "reports" : "work inputs"}`,
    });
  }
  if (safeCount(pendingUsage.bytes) + contentBytes > maxBytes) {
    throw new OpensteerError({
      code: "resource_exhausted",
      message: "The Thread inbox reached its durable byte limit",
    });
  }
}
function normalizedThreadInputSource(source: ThreadInputSource): ThreadInputSource {
  switch (source.kind) {
    case "human":
      return {
        kind: "human",
      };
    case "connection":
      return {
        kind: "connection",
        connectionId: source.connectionId,
      };
    case "agent":
      return {
        kind: "agent",
        runId: source.runId,
      };
    case "trigger":
      return {
        kind: "trigger",
        occurrenceId: source.occurrenceId,
      };
    case "channel":
      return {
        kind: "channel",
        conversationId: source.conversationId,
        ingressId: source.ingressId,
        principalId: source.principalId,
      };
    case "watch":
      return {
        kind: "watch",
        activationId: source.activationId,
        observationId: source.observationId,
        revisionId: source.revisionId,
        triggerId: source.triggerId,
      };
    case "platform":
      return {
        kind: "platform",
        cause: source.cause,
        ...(source.referenceId
          ? {
              referenceId: source.referenceId,
            }
          : {}),
        sourceRunId: source.sourceRunId,
      };
    case "automation":
      return {
        kind: "automation",
        noticeId: source.noticeId,
        triggerId: source.triggerId,
      };
  }
}
export function deliverTaskQuestionNotice(
  database: Kysely<DatabaseSchema>,
  requestId: RequestId,
  isWaiting: (parentThreadId: ThreadId, workerThreadId: ThreadId) => boolean,
): Promise<readonly AgentEvent[]> {
  return withPersonalTransaction(database, async (transaction) => {
    const source = await taskQuestionNoticeSource(transaction, requestId);
    if (!source) return [];
    const key = `task-question:${requestId}`;
    await lockCommandIdempotency(transaction, source.request.requestedBy, key);
    if (
      await transaction
        .selectFrom("taskQuestionNotices")
        .select("requestId")
        .where("requestId", "=", requestId)
        .executeTakeFirst()
    )
      return [];
    const input: EnqueueThreadInputRequest = {
      idempotencyKey: key,
      policy: "queue",
      requestedBy: source.request.requestedBy,
      threadId: source.parentThreadId,
      source: {
        kind: "platform",
        cause: taskQuestionCause,
        referenceId: requestId,
        sourceRunId: source.parentRunId,
      },
      content: [
        {
          type: "text",
          text: `Task ${JSON.stringify(source.workerTitle)} (${source.request.originatingThreadId}) asked ${JSON.stringify(requestTitleText(source.request.presentation))}. Read it with pending_request action read, requestId ${requestId}. Answer with action respond when the answer follows from the task or the person's instructions, or leave it for the person.`,
        },
      ],
    };
    await lockThreadInputPreconditions(transaction, input);
    if (isWaiting(source.parentThreadId, source.request.originatingThreadId)) {
      await transaction
        .insertInto("taskQuestionNotices")
        .values({
          requestId,
          messageId: null,
        })
        .execute();
      return [];
    }
    const queued = await enqueueThreadInputInTransaction(transaction, input);
    await transaction
      .insertInto("taskQuestionNotices")
      .values({
        requestId,
        messageId: queued.message.id,
      })
      .execute();
    return queued.events;
  });
}
export function cancelSettledTaskQuestionNotice(
  database: Kysely<DatabaseSchema>,
  requestId: RequestId,
): Promise<readonly AgentEvent[]> {
  return withPersonalTransaction(database, async (transaction) => {
    const notice = await transaction
      .selectFrom("taskQuestionNotices")
      .innerJoin("threadInputs", "threadInputs.messageId", "taskQuestionNotices.messageId")
      .innerJoin("threads", "threads.id", "threadInputs.threadId")
      .select(["taskQuestionNotices.messageId", "threads.id", "threads.environmentId"])
      .where("taskQuestionNotices.requestId", "=", requestId)
      .where("threadInputs.state", "=", "pending")
      .executeTakeFirst();
    if (!notice?.messageId) return [];
    const reserved = await transaction
      .selectFrom("runs")
      .select(["id", "status"])
      .where("seedInputId", "=", notice.messageId)
      .where("status", "in", nonTerminalRunStatuses)
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
    if (reserved.some(({ status }) => status !== "queued")) return [];
    await lockThreadRow(transaction, notice.id);
    await lockRunProjectionRows(transaction, {
      threadIds: [notice.id],
      runIds: reserved.map(({ id }) => id),
    });
    if (await taskQuestionNoticeIsPending(transaction, notice.messageId)) return [];
    const cancelled = await transaction
      .updateTable("threadInputs")
      .set({
        state: "cancelled",
        cancelReason: "withdrawn",
        updatedAt: new Date(),
      })
      .where("messageId", "=", notice.messageId)
      .where("state", "=", "pending")
      .returningAll()
      .executeTakeFirst();
    if (!cancelled) return [];
    const events = [await inputUpdatedEvent(transaction, notice, cancelled)];
    for (const run of reserved)
      events.push(
        ...(await finalizeRunTransaction(transaction, {
          runId: run.id,
          status: "interrupted",
          source: "host",
          links: threadPathLinks,
          queuedInputCancellation: "seed-input",
          completedAt: new Date(),
        })),
      );
    return events;
  });
}
export async function enqueueThreadInputInTransaction(
  transaction: Transaction<DatabaseSchema>,
  request: EnqueueThreadInputRequest,
): Promise<EnqueuedThreadInput> {
  let content = ContentPartSchema.array().min(1).parse(request.content);
  if (
    (request.source.kind === "agent" || request.source.kind === "connection") &&
    !request.forwardedPlaces &&
    content.some(isPlaceContentPart)
  ) {
    throw new OpensteerError({
      code: "bad_request",
      message: "An agent can forward place references only through delegation.",
    });
  }
  const policy = ThreadInputPolicySchema.parse(request.policy);
  if (request.freshContext && policy !== "queue")
    throw new OpensteerError({
      code: "bad_request",
      message: "freshContext requires queue delivery.",
    });
  if (request.teamRequest && (policy !== "queue" || request.source.kind !== "human"))
    throw new OpensteerError({
      code: "bad_request",
      message: "A team request must be its own queued input.",
    });
  requireBoundedIdentity(request.idempotencyKey, "Thread input idempotency key", 255);
  const requestFingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        request.teamRequest
          ? {
              ...(request.freshContext ? { freshContext: true } : {}),
              requestId: request.teamRequest.id,
              triggerMessageId: request.teamRequest.triggerMessageId,
            }
          : {
              content,
              policy,
              ...(request.freshContext ? { freshContext: true } : {}),
              source: normalizedThreadInputSource(request.source),
              threadId: request.threadId,
              ...(request.requireUnassigned
                ? {
                    requireUnassigned: true,
                  }
                : {}),
              ...(request.quotedMessageId
                ? {
                    quotedMessageId: request.quotedMessageId,
                  }
                : {}),
            },
      ),
      "utf8",
    )
    .digest("base64url");
  await lockCommandIdempotency(transaction, request.requestedBy, request.idempotencyKey);
  const existing = await transaction
    .selectFrom("threadInputs")
    .selectAll()
    .where("requestedBy", "=", request.requestedBy)
    .where("idempotencyKey", "=", request.idempotencyKey)
    .executeTakeFirst();
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      throw idempotencyConflict(request.idempotencyKey);
    }
    return replayThreadInput(transaction, existing);
  }
  const preconditions = await lockThreadInputPreconditions(transaction, request);
  const { executionValid, prelockedActiveRunId } = preconditions;
  let thread = preconditions.thread;
  const messageId = createId("message");
  const facts = await resolveThreadInputFacts(transaction, {
    messageId,
    requestedBy: request.requestedBy,
    source: request.source,
    targetThread: thread,
  });
  const passEvents: AgentEvent[] = [];
  if (thread.doneAt && request.policy !== "report") {
    // Writing to a Done task reopens it for whoever could reopen it by hand.
    const reopens =
      preconditions.reopensDone ||
      ((request.source.kind === "human" || Boolean(request.teamRequest)) &&
        (await requireThreadWriteAuthority(
          transaction,
          thread,
          {
            requestedBy: request.requestedBy,
          },
          "reopen",
        ).then(
          () => true,
          (error: unknown) => {
            if (error instanceof OpensteerError && error.code === "forbidden") return false;
            throw error;
          },
        )));
    if (!reopens)
      throw new OpensteerError({
        code: "conflict",
        message: "This task is Done. Reopen it first.",
      });
    await transaction
      .updateTable("threads")
      .set({
        doneAt: null,
        doneReason: null,
      })
      .where("id", "=", thread.id)
      .execute();
    thread = {
      ...thread,
      doneAt: null,
      doneReason: null,
    };
    passEvents.push(await appendDoneState(transaction, thread.id));
  }
  if (facts.memoryPass) {
    if (policy !== "queue" || !request.memoryPass)
      throw new OpensteerError({
        code: "conflict",
        message: MANAGED_MEMORY_WAKE_SKIPPED,
      });
    // After the fingerprint and receipt replay, so a retry replays what this wake froze.
    content = [
      ...content,
      {
        type: "text",
        text: await memoryPassWakeContext(transaction, thread),
      },
    ];
    const started = await startMemoryPassInTransaction(transaction, thread, request.memoryPass);
    thread = started.worker;
    passEvents.push(started.event);
  }
  await lockThreadProjectionParents(transaction, {
    threadIds: [thread.id],
    runIds: prelockedActiveRunId ? [prelockedActiveRunId] : [],
    causalChainIds: facts.causalChainId ? [facts.causalChainId] : [],
  });
  const activeAssignment = await transaction
    .selectFrom("delegations")
    .select("id")
    .where("childThreadId", "=", thread.id)
    .where("status", "=", "open")
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (request.requireUnassigned && activeAssignment)
    throw new OpensteerError({
      code: "conflict",
      message: "Thread already has an open Assignment",
    });
  const sourceRunId =
    request.source.kind === "agent"
      ? request.source.runId
      : request.source.kind === "platform"
        ? request.source.sourceRunId
        : null;
  const sourceRun = sourceRunId
    ? await transaction
        .selectFrom("runs")
        .select(["assignmentId", "threadId"])
        .where("id", "=", sourceRunId)
        .executeTakeFirst()
    : null;
  if (request.source.kind === "agent" && sourceRun && policy !== "report")
    await assertLineageCompatibleReuse(transaction, sourceRun.threadId, thread.id);
  if (
    policy !== "report" &&
    (request.source.kind === "trigger" || request.source.kind === "watch")
  ) {
    const anchor =
      request.source.kind === "trigger"
        ? await transaction
            .selectFrom("triggerOccurrences")
            .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
            .select("triggers.anchorThreadId")
            .where("triggerOccurrences.id", "=", request.source.occurrenceId)
            .executeTakeFirst()
        : await transaction
            .selectFrom("triggerWatchActivations")
            .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
            .select("triggers.anchorThreadId")
            .where("triggerWatchActivations.id", "=", request.source.activationId)
            .executeTakeFirst();
    if (anchor && anchor.anchorThreadId !== thread.id)
      await assertLineageCompatibleReuse(transaction, anchor.anchorThreadId, thread.id);
  }
  if (sourceRun?.assignmentId) {
    const sourceAssignment = await transaction
      .selectFrom("delegations")
      .select("status")
      .where("id", "=", sourceRun.assignmentId)
      .executeTakeFirstOrThrow();
    if (sourceAssignment.status !== "open") {
      throw new OpensteerError({
        code: "conflict",
        message: "Source Assignment is terminal",
      });
    }
  }
  if (
    sourceRun?.assignmentId &&
    sourceRun.threadId === thread.id &&
    activeAssignment?.id !== sourceRun.assignmentId
  ) {
    throw new OpensteerError({
      code: "conflict",
      message: "Continuation belongs to an older Assignment",
    });
  }
  // Input into a Thread with open work joins that work; otherwise it is unbound.
  const assignmentId: AssignmentId | null = activeAssignment?.id ?? null;
  if (request.quotedMessageId && request.source.kind !== "human")
    throw new OpensteerError({
      code: "bad_request",
      message: "Only a person's message can select a conversation quote",
    });
  const quote = request.quotedMessageId
    ? await resolveMessageQuote(transaction, request.quotedMessageId, request.requestedBy)
    : null;
  if (executionValid) {
    await assertThreadInputCapacity(
      transaction,
      thread.id,
      Buffer.byteLength(JSON.stringify(content), "utf8"),
      policy,
    );
  }
  const activeRun = await // `waiting` is an unresolved tool/action boundary. The Runner may only be
  // steered between tool calls, after it reports `running`.
  transaction
    .selectFrom("runs")
    .selectAll()
    .where("threadId", "=", thread.id)
    .where("status", "=", "running")
    .executeTakeFirst();
  // The person writing in their conversation contributes to the reply under
  // way: the message is accepted like any other, then handed over by the one
  // operation every moment of readiness shares.
  const conversational =
    !request.freshContext &&
    (await conversationalReply(transaction, thread, facts.replyTarget)) &&
    policy === "queue" &&
    (request.source.kind === "human" ||
      request.source.kind === "channel" ||
      Boolean(activeRun?.voiceSessionId));
  // A Run whose turn ended while its background work runs on takes the next
  // message from its own requester, on the same engine and model, as a new
  // turn; anything else waits behind it.
  const joinsBackground =
    !request.freshContext &&
    request.source.kind !== "channel" &&
    !request.teamRequest &&
    activeRun?.replyTarget?.kind !== "team" &&
    !conversational &&
    policy === "queue" &&
    activeRun?.phase === "background" &&
    activeRun.harnessInstanceId === thread.harnessInstanceId &&
    isDeepStrictEqual(activeRun.modelSelection, thread.modelSelection);
  const route =
    (policy === "steer" || joinsBackground) &&
    !thread.inputQueuePaused &&
    executionValid &&
    activeRun !== undefined &&
    activeRun.id === prelockedActiveRunId &&
    activeRun.requestedBy === request.requestedBy &&
    (policy === "steer"
      ? compatibleSteeringTarget(activeRun.replyTarget, facts)
      : isDeepStrictEqual(activeRun.replyTarget, facts.replyTarget))
      ? await steerRoute(transaction, activeRun.id)
      : null;
  const steerRun =
    route !== null && activeRun && (policy === "steer" || route === "native") ? activeRun : null;
  const steer = steerRun !== null;
  if (policy === "steer" && !steer) {
    throw new OpensteerError({
      code: "conflict",
      message: "Steer requires a compatible running turn. Use Queue to start a new turn.",
    });
  }
  if (
    content.some(
      (part) => part.type === "artifact" || part.type === "computer-app" || part.type === "phone",
    )
  ) {
    const selected = steerRun ?? thread;
    const harness = await transaction
      .selectFrom("harnessInstances")
      .select("driverKind")
      .where("id", "=", selected.harnessInstanceId)
      .executeTakeFirst();
    if (!harness)
      throw new OpensteerError({
        code: "conflict",
        message: "Selected AI engine is no longer available",
      });
    request.validateNewAttachmentInput?.({
      driverKind: harness.driverKind,
      environmentId: selected.environmentId,
      harnessInstanceId: selected.harnessInstanceId,
      modelSelection: selected.modelSelection,
      // A restart hands the message to the next attempt as its first input.
      steering: route === "native",
    });
  }
  let causalChainId = facts.causalChainId;
  if (!causalChainId) {
    if (steerRun) {
      causalChainId = steerRun.causalChainId;
    } else {
      causalChainId = createId("causalChain");
      await transaction
        .insertInto("causalChains")
        .values({
          id: causalChainId,
          maxDelegations: causalChainMaxDelegations,
          maxAutonomousRuns: causalChainMaxAutonomousRuns,
          rootMessageId: messageId,
          rootOccurrenceId: null,
          usedDelegations: 0,
          usedAutonomousRuns: 0,
        })
        .executeTakeFirstOrThrow();
    }
  }
  const steerCommandId = steer ? createId("command") : null;
  const messageRow = await transaction
    .insertInto("messages")
    .values({
      quote: quote ? jsonValue(quote) : null,
      actorPrincipalId: facts.actorPrincipalId,
      author: jsonValue(facts.author),
      content: jsonValue(content),
      id: messageId,
      kind: facts.kind,
      runId: steerRun?.id ?? null,
      sequence: thread.nextMessageSequence,
      threadId: thread.id,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await claimMessageAttachments(transaction, {
    content,
    messageId,
    requestedBy: request.requestedBy,
    sourceKind: request.source.kind,
    threadId: thread.id,
  });
  let steerCommand: CommandRow | null = null;
  if (steerRun && steerCommandId) {
    const payload =
      route === "native"
        ? ({
            runId: steerRun.id,
            threadId: thread.id,
            type: "run.steer",
          } as const)
        : restartPayload(steerRun, messageId);
    steerCommand = await transaction
      .insertInto("commands")
      .values({
        actorPrincipalId: facts.actorPrincipalId,
        authoritySource: jsonValue(facts.authoritySource),
        dispatcherId: null,
        environmentId: thread.environmentId,
        id: steerCommandId,
        idempotencyKey: `steer:${messageId}`,
        lastError: null,
        payload: jsonValue(payload),
        requestedBy: request.requestedBy,
        runId: steerRun.id,
        status: "pending",
        threadId: thread.id,
        type: payload.type,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  const inputRow = await transaction
    .insertInto("threadInputs")
    .values({
      teamRequestId: request.teamRequest?.id ?? null,
      teamSource: request.teamRequest?.source ?? null,
      assignmentId,
      actorPrincipalId: facts.actorPrincipalId,
      authoritySource: jsonValue(
        request.teamRequest
          ? {
              kind: "team-request",
              teamId: request.teamRequest.source.teamId,
              requestId: request.teamRequest.id,
            }
          : facts.authoritySource,
      ),
      cancelReason: executionValid ? null : "execution-authority-unavailable",
      causalChainId,
      deliveredAt: null,
      idempotencyKey: request.idempotencyKey,
      messageId,
      policy,
      queueRank: thread.nextMessageSequence,
      replyTarget: request.teamRequest
        ? jsonValue(
            ReplyTargetSchema.parse({
              kind: "team",
              teamId: request.teamRequest.source.teamId,
              channelId: request.teamRequest.source.channelId,
              threadRootId: request.teamRequest.source.threadRootId,
              requestId: request.teamRequest.id,
            }),
          )
        : facts.replyTarget
          ? jsonValue(facts.replyTarget)
          : null,
      requestedBy: request.requestedBy,
      requestFingerprint,
      ...(request.freshContext ? { freshContext: true } : {}),
      runId: steerRun?.id ?? null,
      state: executionValid ? (steer ? "claimed" : "pending") : "cancelled",
      steerCommandId,
      threadId: thread.id,
      updatedAt: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const admittedAt = new Date();
  await transaction
    .updateTable("threads")
    .set({
      nextMessageSequence: sql`next_message_sequence + 1`,
      updatedAt: admittedAt,
      ...(facts.author.kind === "human" && policy !== "report" && executionValid
        ? {
            askedAt: admittedAt,
          }
        : {}),
    })
    .where("id", "=", thread.id)
    .executeTakeFirstOrThrow();
  const message = messageFromRow(messageRow);
  const durableInput = threadInputFromRow(inputRow);
  const messageEvent = await appendHostDeploymentEvent(transaction, {
    data: {
      input: durableInput,
      message,
    },
    environmentId: thread.environmentId,
    runId: steerRun?.id ?? null,
    threadId: thread.id,
    type: "message.created",
  });
  // The pages a person included are the conversation's from the moment the
  // message is, and last, after everything else that kept it.
  const credited = async (result: EnqueuedThreadInput): Promise<EnqueuedThreadInput> => {
    if (request.source.kind !== "human" && !request.forwardedPlaces) return result;
    const browserUsage = await recordIncludedBrowserPages(transaction, {
      content,
      ownerId: request.requestedBy,
      threadId: thread.id,
    });
    return browserUsage.length > 0
      ? {
          ...result,
          browserUsage,
        }
      : result;
  };
  if (steerCommand && steerRun) {
    const revokedGrants =
      route === "restart" ? await supersedeForRestart(transaction, steerRun.id) : [];
    return credited({
      command: steerCommand,
      disposition: "steering",
      events: [...passEvents, messageEvent],
      input: durableInput,
      message,
      revokedGrants,
      run: runFromRow(steerRun),
      wasDuplicate: false,
    });
  }
  let handed: Awaited<ReturnType<typeof deliverConversationInputsInTransaction>> = {
    events: [],
    revokedGrants: [],
  };
  if (
    conversational &&
    executionValid &&
    activeRun !== undefined &&
    activeRun.id === prelockedActiveRunId
  ) {
    handed = await deliverConversationInputsInTransaction(transaction, activeRun.id);
    const joined = await transaction
      .selectFrom("threadInputs")
      .selectAll()
      .where("messageId", "=", messageId)
      .executeTakeFirstOrThrow();
    if (joined.state === "claimed" && joined.steerCommandId) {
      return credited({
        command: await transaction
          .selectFrom("commands")
          .selectAll()
          .where("id", "=", joined.steerCommandId)
          .executeTakeFirstOrThrow(),
        disposition: "steering",
        events: [...passEvents, messageEvent, ...handed.events],
        input: threadInputFromRow(joined),
        message: messageFromRow(
          await transaction
            .selectFrom("messages")
            .selectAll()
            .where("id", "=", messageId)
            .executeTakeFirstOrThrow(),
        ),
        revokedGrants: handed.revokedGrants,
        run: runFromRow(activeRun),
        wasDuplicate: false,
      });
    }
  }
  const queued =
    executionValid && policy === "queue" ? await ensureQueuedRun(transaction, thread) : null;
  // Only a live Run stops the account's endpoint moving, so a waiting input can't keep this fence.
  if (request.expectedHarnessRevision !== undefined && !queued?.run)
    throw new OpensteerError({
      code: "conflict",
      reason: "thread-not-accepting-work",
      message: "This task isn't taking new work right now, so nothing was sent.",
    });
  const finalInputRow =
    queued?.run || inputRow.state === "cancelled"
      ? inputRow
      : await transaction
          .selectFrom("threadInputs")
          .selectAll()
          .where("messageId", "=", messageId)
          .executeTakeFirstOrThrow();
  const finalInput = threadInputFromRow(finalInputRow);
  return credited({
    command: queued?.run?.seedInputId === messageId ? queued.command : null,
    disposition:
      queued?.run?.seedInputId === messageId
        ? "run-queued"
        : finalInput.state === "cancelled"
          ? "cancelled"
          : "pending",
    events: [...passEvents, messageEvent, ...handed.events, ...(queued?.events ?? [])],
    input: finalInput,
    message,
    revokedGrants: handed.revokedGrants,
    run: queued?.run?.seedInputId === messageId ? runFromRow(queued.run) : null,
    wasDuplicate: false,
  });
}

/** The platform cause an automation that stopped working is told to its Thread with. */
export const automationStoppedCause = "automation-stopped";
async function resolveThreadInputFacts(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly messageId: MessageId;
    readonly requestedBy: UserId;
    readonly source: ThreadInputSource;
    readonly targetThread: ThreadRow;
  },
): Promise<ResolvedThreadInputFacts> {
  const { source } = input;
  if (source.kind === "channel") requireBoundedIdentity(source.ingressId, "Channel ingress", 255);
  if (source.kind === "human" || source.kind === "channel") {
    const channelSource =
      source.kind === "channel"
        ? await transaction
            .selectFrom("channelIngressEvents")
            .innerJoin(
              "channelConversations",
              "channelConversations.id",
              "channelIngressEvents.conversationId",
            )
            .innerJoin("channelBindings", "channelBindings.id", "channelConversations.bindingId")
            .innerJoin("channelIdentities", (join) =>
              join
                .onRef("channelIdentities.accountId", "=", "channelIngressEvents.accountId")
                .on(
                  "channelIdentities.principalId",
                  "=",
                  PrincipalIdSchema.parse(source.principalId),
                ),
            )
            .select([
              "channelBindings.accessPolicy",
              "channelBindings.accountId as bindingAccountId",
              "channelBindings.createdAt as bindingCreatedAt",
              "channelBindings.createdBy as bindingCreatedBy",
              "channelBindings.executionPolicy",
              "channelBindings.id as bindingId",
              "channelBindings.revision as currentBindingRevision",
              "channelBindings.selector",
              "channelBindings.status as bindingStatus",
              "channelBindings.updatedAt as bindingUpdatedAt",
              "channelConversations.activeThreadId as contextActiveThreadId",
              "channelConversations.bindingRevision as contextBindingRevision",
              "channelConversations.conversationType",
              "channelConversations.externalConversationId",
              "channelConversations.id as conversationId",
              "channelIdentities.externalUserId",
              "channelIdentities.id",
              "channelIdentities.linkedUserId",
              "channelIdentities.status as identityStatus",
              "channelIdentities.principalId",
            ])
            .where("channelIngressEvents.id", "=", ChannelIngressIdSchema.parse(source.ingressId))
            .where("channelIngressEvents.status", "=", "leased")
            .where(
              "channelIngressEvents.conversationId",
              "=",
              ChannelConversationIdSchema.parse(source.conversationId),
            )
            // This is the final authority check, not a snapshot replay. A
            // concurrent binding/identity revocation either commits first and
            // is observed here, or waits until this admission commits.
            .forNoKeyUpdate([
              "channelIngressEvents",
              "channelConversations",
              "channelBindings",
              "channelIdentities",
            ])
            .executeTakeFirst()
        : null;
    let channelAuthority: Awaited<ReturnType<typeof resolveChannelAuthority>> | null = null;
    if (source.kind === "channel" && channelSource) {
      const binding = ChannelBindingSchema.parse({
        accessPolicy: channelSource.accessPolicy,
        accountId: channelSource.bindingAccountId,
        createdAt: channelSource.bindingCreatedAt.toISOString(),
        createdBy: channelSource.bindingCreatedBy,
        executionPolicy: channelSource.executionPolicy,
        id: channelSource.bindingId,
        revision: channelSource.currentBindingRevision,
        selector: channelSource.selector,
        status: channelSource.bindingStatus,
        updatedAt: channelSource.bindingUpdatedAt.toISOString(),
      });
      channelAuthority = await resolveChannelAuthority(transaction, binding, channelSource, {
        externalConversationId: channelSource.externalConversationId,
        type: channelSource.conversationType,
      });
    }
    if (
      source.kind === "channel" &&
      (!channelSource ||
        channelSource.bindingStatus !== "active" ||
        channelSource.contextBindingRevision !== channelSource.currentBindingRevision ||
        channelSource.contextActiveThreadId !== input.targetThread.id ||
        !channelAuthority ||
        channelAuthority.userId !== input.requestedBy)
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Channel ingress source is invalid",
      });
    }
    const principal =
      source.kind === "human"
        ? await transaction
            .selectFrom("principals")
            .innerJoin("users", "users.id", "principals.userId")
            .select(["principals.displayName", "principals.id", "principals.userId"])
            .where("principals.kind", "=", "user")
            .where("principals.userId", "=", input.requestedBy)
            .executeTakeFirstOrThrow()
        : await transaction
            .selectFrom("principals")
            .select(["displayName", "id", "userId"])
            .where("id", "=", PrincipalIdSchema.parse(source.principalId))
            .executeTakeFirstOrThrow();
    const authorUserId =
      source.kind === "channel"
        ? channelSource?.identityStatus === "linked"
          ? channelSource.linkedUserId
          : null
        : principal.userId;
    const replyTarget =
      source.kind === "channel"
        ? ReplyTargetSchema.parse({
            conversationId: source.conversationId,
            kind: "channel",
          })
        : null;
    return {
      actorPrincipalId: principal.id,
      author: MessageAuthorSchema.parse({
        displayName: principal.displayName,
        kind: "human",
        principalId: principal.id,
        ...(authorUserId
          ? {
              userId: authorUserId,
            }
          : {}),
      }),
      authoritySource:
        source.kind === "channel"
          ? {
              access: channelAuthority!.source,
              bindingId: channelSource!.bindingId,
              bindingRevision: channelSource!.contextBindingRevision,
              conversationId: source.conversationId,
              ingressId: source.ingressId,
              kind: "channel-ingress",
              principalId: principal.id,
              userId: input.requestedBy,
            }
          : {
              kind: "user-session",
              userId: input.requestedBy,
            },
      causalChainId: null,
      kind: "input",
      replyTarget,
    };
  }
  if (source.kind === "connection") {
    const connection = await transaction
      .selectFrom("agentConnections")
      .selectAll()
      .where("id", "=", source.connectionId)
      .where("userId", "=", input.requestedBy)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", new Date())
      .executeTakeFirst();
    if (!connection || !connection.tokenHash)
      throw new OpensteerError({
        code: "forbidden",
        message: "Connected agent source is invalid",
      });
    return {
      actorPrincipalId: await principalIdForUser(transaction, input.requestedBy),
      author: MessageAuthorSchema.parse({
        kind: "connection",
        connectionId: connection.id,
        displayName: connection.label,
      }),
      authoritySource: {
        kind: "connection",
        connectionId: connection.id,
        userId: input.requestedBy,
      },
      causalChainId: null,
      kind: "input",
      replyTarget: null,
    };
  }
  if (source.kind === "agent") {
    const origin = await transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .innerJoin("users", "users.id", "runs.requestedBy")
      .select([
        "runs.actorPrincipalId",
        "runs.causalChainId",
        "runs.id as runId",
        "runs.requestedBy",
        "runs.status",
        "threads.id as threadId",
        "threads.title as threadTitle",
        "users.displayName as requesterName",
      ])
      .where("runs.id", "=", source.runId)
      .executeTakeFirst();
    if (
      !origin ||
      origin.requestedBy !== input.requestedBy ||
      !["starting", "running", "waiting"].includes(origin.status)
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Agent source Run is invalid",
      });
    }
    return {
      actorPrincipalId: origin.actorPrincipalId,
      author: MessageAuthorSchema.parse({
        displayName: origin.threadTitle,
        kind: "agent",
        runId: origin.runId,
        threadId: origin.threadId,
      }),
      authoritySource: {
        kind: "thread-agent",
        runId: origin.runId,
        threadId: origin.threadId,
        userId: input.requestedBy,
      },
      causalChainId: origin.causalChainId,
      kind: "input",
      replyTarget: null,
    };
  }
  if (source.kind === "trigger") {
    const origin = await transaction
      .selectFrom("triggerOccurrences")
      .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
      .select([
        "triggerOccurrences.id as occurrenceId",
        "triggerOccurrences.causalChainId",
        "triggerOccurrences.event",
        "triggerOccurrences.status",
        "triggers.createdBy",
        "triggers.id as triggerId",
        "triggers.name",
        "triggers.systemRole",
        "triggers.anchorThreadId",
        "triggers.status as triggerStatus",
      ])
      .where("triggerOccurrences.id", "=", source.occurrenceId)
      .forNoKeyUpdate("triggerOccurrences")
      .forNoKeyUpdate("triggers")
      .executeTakeFirst();
    if (!origin || origin.createdBy !== input.requestedBy || origin.status !== "running") {
      throw new OpensteerError({
        code: "forbidden",
        message: "Trigger source is invalid",
      });
    }
    if (origin.systemRole && origin.anchorThreadId === input.targetThread.id) {
      const worker = input.targetThread;
      const [busy, pending] = await Promise.all([
        transaction
          .selectFrom("runs")
          .select("id")
          .where("threadId", "=", worker.id)
          .where("status", "in", nonTerminalRunStatuses)
          .executeTakeFirst(),
        transaction
          .selectFrom("threadInputs")
          .select("messageId")
          .where("threadId", "=", worker.id)
          .where("policy", "!=", "report")
          .where("state", "in", ["pending", "claimed", "unknown"])
          .executeTakeFirst(),
      ]);
      if (
        origin.triggerStatus !== "active" ||
        worker.doneAt ||
        worker.inputQueuePaused ||
        worker.status === "archived" ||
        busy ||
        pending
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: MANAGED_MEMORY_WAKE_SKIPPED,
        });
      }
    }
    let causalChainId = origin.causalChainId;
    if (!causalChainId) {
      const chain = await transaction
        .insertInto("causalChains")
        .values({
          id: createId("causalChain"),
          maxDelegations: causalChainMaxDelegations,
          maxAutonomousRuns: causalChainMaxAutonomousRuns,
          rootMessageId: null,
          rootOccurrenceId: origin.occurrenceId,
          usedDelegations: 0,
          usedAutonomousRuns: 0,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      causalChainId = chain.id;
      await transaction
        .updateTable("triggerOccurrences")
        .set({
          causalChainId,
        })
        .where("id", "=", origin.occurrenceId)
        .where("causalChainId", "is", null)
        .executeTakeFirstOrThrow();
    }
    return {
      actorPrincipalId: await principalIdForUser(transaction, input.requestedBy),
      author: MessageAuthorSchema.parse({
        displayName: origin.name,
        kind: "trigger",
        occurrenceId: origin.occurrenceId,
        source: origin.event.source.kind,
        triggerId: origin.triggerId,
      }),
      authoritySource: {
        kind: "trigger-occurrence",
        occurrenceId: origin.occurrenceId,
        userId: input.requestedBy,
      },
      causalChainId,
      kind: "input",
      replyTarget: null,
      ...(origin.systemRole && origin.anchorThreadId === input.targetThread.id
        ? {
            memoryPass: true as const,
          }
        : {}),
    };
  }
  if (source.kind === "watch") {
    const origin = await transaction
      .selectFrom("triggerWatchActivations")
      .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
      .select([
        "triggerWatchActivations.desired",
        "triggerWatchActivations.revisionId",
        "triggers.createdBy",
        "triggers.currentRevisionId",
        "triggers.id as triggerId",
        "triggers.name",
        "triggers.status",
      ])
      .where("triggerWatchActivations.id", "=", source.activationId)
      .executeTakeFirst();
    if (
      !origin ||
      origin.createdBy !== input.requestedBy ||
      origin.desired !== "active" ||
      origin.status !== "active" ||
      origin.triggerId !== source.triggerId ||
      origin.revisionId !== source.revisionId ||
      origin.currentRevisionId !== source.revisionId
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Watch source is invalid",
      });
    }
    return {
      actorPrincipalId: await principalIdForUser(transaction, input.requestedBy),
      author: MessageAuthorSchema.parse({
        activationId: source.activationId,
        displayName: origin.name,
        kind: "watch",
        revisionId: source.revisionId,
        triggerId: source.triggerId,
      }),
      authoritySource: {
        activationId: source.activationId,
        kind: "watch-observation",
        observationId: source.observationId,
        revisionId: source.revisionId,
        triggerId: source.triggerId,
        userId: input.requestedBy,
      },
      causalChainId: await watchObservationCausalChain(
        transaction,
        source.activationId,
        source.observationId,
      ),
      kind: "input",
      replyTarget: null,
    };
  }
  if (source.kind === "automation") {
    const trigger = await transaction
      .selectFrom("triggers")
      .select(["anchorThreadId", "createdBy"])
      .where("id", "=", source.triggerId)
      .executeTakeFirst();
    if (!trigger || trigger.createdBy !== input.requestedBy) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Automation source is invalid",
      });
    }
    await assertAutomationNoticeDestination(
      transaction,
      trigger.anchorThreadId,
      input.targetThread.id,
    );
    return {
      actorPrincipalId: systemPrincipalId,
      author: MessageAuthorSchema.parse({
        cause: automationStoppedCause,
        kind: "platform",
        referenceId: source.triggerId,
      }),
      authoritySource: {
        cause: automationStoppedCause,
        kind: "platform",
        noticeId: source.noticeId,
        referenceId: source.triggerId,
        userId: input.requestedBy,
      },
      causalChainId: null,
      kind: "continuation",
      replyTarget: null,
    };
  }
  const sourceRun = await transaction
    .selectFrom("runs")
    .select(["causalChainId", "replyTarget", "requestedBy"])
    .where("id", "=", source.sourceRunId)
    .executeTakeFirst();
  if (!sourceRun || sourceRun.requestedBy !== input.requestedBy) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Platform source Run is invalid",
    });
  }
  return {
    actorPrincipalId: systemPrincipalId,
    author: MessageAuthorSchema.parse({
      cause: source.cause,
      kind: "platform",
      ...(source.referenceId
        ? {
            referenceId: source.referenceId,
          }
        : {}),
    }),
    authoritySource: {
      cause: source.cause,
      kind: "platform",
      ...(source.referenceId
        ? {
            referenceId: source.referenceId,
          }
        : {}),
      sourceRunId: source.sourceRunId,
      userId: input.requestedBy,
    },
    causalChainId: sourceRun.causalChainId,
    kind: "continuation",
    replyTarget: sourceRun.replyTarget ? ReplyTargetSchema.parse(sourceRun.replyTarget) : null,
  };
}

/** Call while holding the Thread lock, including when a legacy Thread first admits work. */
export async function ensureSelectedProviderSession(
  transaction: Transaction<DatabaseSchema>,
  thread: {
    readonly id: ThreadId;
    readonly harnessInstanceId: HarnessInstanceId;
  },
  options: { readonly personalContext?: boolean; readonly freshRunId?: RunId } = {},
): Promise<ProviderSessionId> {
  const selected = await transaction
    .selectFrom("providerSessions")
    .select(["id", "harnessInstanceId", "personalContext"])
    .where("threadId", "=", thread.id)
    .where("active", "=", true)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (selected) {
    if (selected.harnessInstanceId !== thread.harnessInstanceId) {
      throw new OpensteerError({
        code: "conflict",
        message: "Selected provider session does not match the Thread's AI engine",
      });
    }
    if (
      !options.freshRunId &&
      (options.personalContext === undefined ||
        selected.personalContext === options.personalContext)
    )
      return selected.id;
    const active = await transaction
      .selectFrom("runs")
      .select("id")
      .where("providerSessionId", "=", selected.id)
      .$if(options.freshRunId !== undefined, (query) =>
        query.where("id", "!=", options.freshRunId!),
      )
      .where("status", "in", nonTerminalRunStatuses)
      .executeTakeFirst();
    if (active)
      throw new OpensteerError({
        code: "conflict",
        message: "Waiting for the previous Messaging audience's Run to end",
        retryable: true,
      });
    await transaction
      .updateTable("providerSessions")
      .set({ active: false, updatedAt: new Date() })
      .where("id", "=", selected.id)
      .execute();
  }
  const prior = await transaction
    .selectFrom("providerSessions")
    .select("id")
    .where("threadId", "=", thread.id)
    .limit(1)
    .executeTakeFirst();
  if (prior && !selected) {
    throw new OpensteerError({
      code: "conflict",
      message: "A prior native provider session cannot be replaced without an explicit switch",
    });
  }
  const id = createId("providerSession");
  await transaction
    .insertInto("providerSessions")
    .values({
      active: true,
      personalContext: options.personalContext ?? true,
      bindingGeneration: 0,
      continuationIdentity: null,
      harnessInstanceId: thread.harnessInstanceId,
      id,
      leaseExpiresAt: null,
      leaseTokenHash: null,
      providerSessionReference: null,
      runnerBootId: null,
      runnerId: null,
      status: "starting",
      stateLayout: "session",
      threadId: thread.id,
    })
    .executeTakeFirstOrThrow();
  return id;
}
export async function ensureQueuedRun(
  transaction: Transaction<DatabaseSchema>,
  thread: ThreadRow,
  options: {
    readonly onInvalidSelection?: "throw" | "defer";
  } = {},
): Promise<{
  readonly command: CommandRow | null;
  readonly events: readonly AgentEvent[];
  readonly run: RunRow | null;
}> {
  const events: AgentEvent[] = [];
  if (thread.status === "archived" || thread.inputQueuePaused || thread.doneAt)
    return {
      command: null,
      events,
      run: null,
    };
  const existing = await transaction
    .selectFrom("runs")
    .selectAll()
    .where("threadId", "=", thread.id)
    .where("status", "=", "queued")
    .executeTakeFirst();
  if (existing)
    return {
      command: null,
      events,
      run: existing,
    };
  // Follow-ups remain inputs until their predecessor ends. They do not reserve
  // a Run, charge its budget, or freeze execution settings while waiting.
  const active = await transaction
    .selectFrom("runs")
    .select("id")
    .where("threadId", "=", thread.id)
    .where("status", "in", nonTerminalRunStatuses)
    .executeTakeFirst();
  if (active)
    return {
      command: null,
      events,
      run: null,
    };
  const pending = await transaction
    .selectFrom("threadWorkInputs")
    .select("messageId")
    .where("threadId", "=", thread.id)
    .where("state", "=", "pending")
    .limit(1)
    .executeTakeFirst();
  if (!pending)
    return {
      command: null,
      events,
      run: null,
    };
  const selected = await transaction
    .selectFrom("providerSessions")
    .select("harnessInstanceId")
    .where("threadId", "=", thread.id)
    .where("active", "=", true)
    .executeTakeFirst();
  if (selected && selected.harnessInstanceId !== thread.harnessInstanceId) {
    if (options.onInvalidSelection === "defer")
      return {
        command: null,
        events,
        run: null,
      };
    throw new OpensteerError({
      code: "conflict",
      message:
        "Selected provider session does not match this Thread's AI engine; choose the engine again",
    });
  }
  if (!selected) {
    const prior = await transaction
      .selectFrom("providerSessions")
      .select("id")
      .where("threadId", "=", thread.id)
      .limit(1)
      .executeTakeFirst();
    if (prior) {
      if (options.onInvalidSelection === "defer")
        return {
          command: null,
          events,
          run: null,
        };
      throw new OpensteerError({
        code: "conflict",
        message: "This Thread has no selected provider session; choose an AI engine to continue",
      });
    }
  }
  await lockRunProjectionRows(transaction, {
    runIds: [],
    threadIds: [thread.id],
  });
  let seed:
    | (Selectable<ThreadInputTable> & {
        readonly messageKind: MessageKind;
      })
    | undefined;
  for (let attempt = 0; attempt < threadInputMaxPendingEntries; attempt += 1) {
    let candidate = await transaction
      .selectFrom("threadWorkInputs as threadInputs")
      .innerJoin("messages", "messages.id", "threadInputs.messageId")
      .selectAll("threadInputs")
      .select("messages.kind as messageKind")
      .where("threadInputs.threadId", "=", thread.id)
      .where("threadInputs.state", "=", "pending")
      .orderBy("threadInputs.queueRank", "asc")
      .executeTakeFirst();
    if (!candidate)
      return {
        command: null,
        events,
        run: null,
      };

    // Channel authority can change after inbox admission. Read and lock its
    // binding before taking the input lock so revocation and policy updates
    // cannot cross a requeue boundary.
    if (!(await channelInputAuthorityIsCurrent(transaction, candidate.messageId))) {
      const cancelled = await transaction
        .updateTable("threadInputs")
        .set({
          cancelReason: "channel-authority-unavailable",
          state: "cancelled",
          updatedAt: new Date(),
        })
        .where("messageId", "=", candidate.messageId)
        .where("state", "=", "pending")
        .where("policy", "=", "queue")
        .returningAll()
        .executeTakeFirst();
      if (cancelled) {
        events.push(
          await appendHostDeploymentEvent(transaction, {
            data: {
              input: threadInputFromRow(cancelled),
            },
            environmentId: thread.environmentId,
            runId: null,
            threadId: thread.id,
            type: "thread-input.updated",
          }),
        );
      }
      continue;
    }
    const lockedCandidate = await transaction
      .selectFrom("threadWorkInputs as threadInputs")
      .innerJoin("messages", "messages.id", "threadInputs.messageId")
      .selectAll("threadInputs")
      .select("messages.kind as messageKind")
      .where("threadInputs.messageId", "=", candidate.messageId)
      .where("threadInputs.state", "=", "pending")
      .forNoKeyUpdate("threadInputs")
      .executeTakeFirst();
    if (!lockedCandidate) continue;
    candidate = lockedCandidate;
    if (!(await taskQuestionNoticeIsPending(transaction, candidate.messageId))) {
      const cancelled = await transaction
        .updateTable("threadInputs")
        .set({
          state: "cancelled",
          cancelReason: "withdrawn",
          updatedAt: new Date(),
        })
        .where("messageId", "=", candidate.messageId)
        .returningAll()
        .executeTakeFirstOrThrow();
      events.push(await inputUpdatedEvent(transaction, thread, cancelled));
      continue;
    }
    if (candidate.assignmentId) {
      const assignment = await transaction
        .selectFrom("delegations")
        .select("status")
        .where("id", "=", candidate.assignmentId)
        .executeTakeFirst();
      if (assignment && assignment.status !== "open") {
        const cancelled = await transaction
          .updateTable("threadInputs")
          .set({
            cancelReason: "assignment-cancelled",
            state: "cancelled",
            updatedAt: new Date(),
          })
          .where("messageId", "=", candidate.messageId)
          .where("state", "=", "pending")
          .returningAll()
          .executeTakeFirst();
        if (cancelled) {
          events.push(
            await appendHostDeploymentEvent(transaction, {
              data: {
                input: threadInputFromRow(cancelled),
              },
              environmentId: thread.environmentId,
              runId: null,
              threadId: thread.id,
              type: "thread-input.updated",
            }),
          );
        }
        continue;
      }
    }
    const authorityValid = await threadExecutionIsAvailableToUser(
      transaction,
      thread.id,
      candidate.requestedBy,
    );
    if (!authorityValid) {
      const cancelled = await transaction
        .updateTable("threadInputs")
        .set({
          cancelReason: "execution-authority-unavailable",
          state: "cancelled",
          updatedAt: new Date(),
        })
        .where("threadId", "=", thread.id)
        .where("requestedBy", "=", candidate.requestedBy)
        .where("state", "=", "pending")
        .where("policy", "=", "queue")
        .returningAll()
        .execute();
      for (const row of cancelled) {
        events.push(
          await appendHostDeploymentEvent(transaction, {
            data: {
              input: threadInputFromRow(row),
            },
            environmentId: thread.environmentId,
            runId: null,
            threadId: thread.id,
            type: "thread-input.updated",
          }),
        );
      }
      continue;
    }
    if (isGuaranteedCompletionKind(candidate.messageKind)) {
      seed = candidate;
      break;
    }
    const budget = await transaction
      .updateTable("causalChains")
      .set((expression) => ({
        usedAutonomousRuns: expression("usedAutonomousRuns", "+", 1),
      }))
      .where("id", "=", candidate.causalChainId)
      .whereRef("usedAutonomousRuns", "<", "maxAutonomousRuns")
      .returning("id")
      .executeTakeFirst();
    if (budget) {
      seed = candidate;
      break;
    }
    const cancelled = await transaction
      .updateTable("threadInputs")
      .set({
        cancelReason: "causal-run-budget-exhausted",
        state: "cancelled",
        updatedAt: new Date(),
      })
      .where("threadId", "=", thread.id)
      .where("causalChainId", "=", candidate.causalChainId)
      .where("policy", "=", "queue")
      .where("state", "=", "pending")
      .returningAll()
      .execute();
    for (const row of cancelled) {
      events.push(
        await appendHostDeploymentEvent(transaction, {
          data: {
            input: threadInputFromRow(row),
          },
          environmentId: thread.environmentId,
          runId: null,
          threadId: thread.id,
          type: "thread-input.updated",
        }),
      );
    }
  }
  if (!seed)
    return {
      command: null,
      events,
      run: null,
    };
  const selectedSession = await ensureSelectedProviderSession(transaction, thread, {
    personalContext: await threadAllowsPersonalContext(transaction, thread.id, thread.createdBy),
  });
  const runId = createId("run");
  const runRow = await transaction
    .insertInto("runs")
    .values({
      accessMode: thread.accessMode,
      activationInputId: seed.messageId,
      assignmentId: seed.assignmentId,
      actorPrincipalId: seed.actorPrincipalId,
      authoritySource: seed.authoritySource,
      causalChainId: seed.causalChainId,
      completedAt: null,
      environmentId: thread.environmentId,
      harnessInstanceId: thread.harnessInstanceId,
      id: runId,
      modelSelection: thread.modelSelection,
      providerSessionId: selectedSession,
      replyTarget: seed.replyTarget,
      requestedBy: seed.requestedBy,
      runOrdinal: thread.nextRunOrdinal,
      startedAt: null,
      status: "queued",
      threadId: thread.id,
      seedInputId: seed.messageId,
      personWaited: sql<boolean>`exists (select 1 from messages where id = ${seed.messageId} and author->>'kind' = 'human')`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (seed.messageKind === "continuation") await recordPersonWaited(transaction, runId);
  const payload = {
    runId,
    threadId: thread.id,
    type: "run.execute",
  } as const;
  const command = await transaction
    .insertInto("commands")
    .values({
      actorPrincipalId: seed.actorPrincipalId,
      authoritySource: seed.authoritySource,
      dispatcherId: null,
      environmentId: thread.environmentId,
      id: createId("command"),
      idempotencyKey: `run:${runId}`,
      lastError: null,
      payload: jsonValue(payload),
      requestedBy: seed.requestedBy,
      runId,
      status: "pending",
      threadId: thread.id,
      type: payload.type,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable("threads")
    .set((expression) => ({
      nextRunOrdinal: expression("nextRunOrdinal", "+", 1),
      updatedAt: new Date(),
    }))
    .where("id", "=", thread.id)
    .executeTakeFirstOrThrow();
  events.push(
    await placeQueuedMessage(transaction, thread, seed.messageId, runId),
    await appendHostDeploymentEvent(transaction, {
      data: {
        run: threadRunQueueEntryFromRow(runRow),
      },
      environmentId: thread.environmentId,
      runId,
      threadId: thread.id,
      type: "run.queued",
    }),
  );
  events.push(...(await projectThreadState(transaction, thread.id, new Date(), true)));
  if (seed.teamRequestId)
    await transaction
      .updateTable("personalTeamRequests")
      .set({ runId })
      .where("requestId", "=", seed.teamRequestId)
      .where("localInputId", "=", seed.messageId)
      .execute();
  return {
    command,
    events,
    run: runRow,
  };
}

/**
 * The work still waiting its turn, in the order the next Run takes it. A
 * message that seeds a queued Run stays `pending` until that Run claims it,
 * but the Run already owns it: it is transcript, not queue, and nothing may
 * steer, withdraw or move it.
 */
async function waitingThreadInputs(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
): Promise<Selectable<ThreadInputTable>[]> {
  return transaction
    .selectFrom("threadInputs")
    .selectAll()
    .where("threadId", "=", threadId)
    .where("policy", "=", "queue")
    .where("state", "=", "pending")
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("runs")
            .select("runs.id")
            .whereRef("runs.seedInputId", "=", "threadInputs.messageId")
            .where("runs.status", "in", nonTerminalRunStatuses),
        ),
      ),
    )
    .orderBy("queueRank", "asc")
    .limit(threadInputMaxPendingEntries)
    .execute();
}

/**
 * A queued Message joins the conversation where a Run takes it, after
 * everything the Thread said while it waited, rather than where it was sent.
 * Callers hold the Thread lock, so the next sequence is theirs alone.
 */
async function placeQueuedMessage(
  transaction: Transaction<DatabaseSchema>,
  thread: Pick<ThreadRow, "environmentId" | "id">,
  messageId: MessageId,
  runId: RunId,
): Promise<AgentEvent> {
  const { nextMessageSequence } = await transaction
    .selectFrom("threads")
    .select("nextMessageSequence")
    .where("id", "=", thread.id)
    .executeTakeFirstOrThrow();
  const current = await transaction
    .selectFrom("messages")
    .selectAll()
    .where("id", "=", messageId)
    .executeTakeFirstOrThrow();
  let placed = current;
  if (BigInt(current.sequence) !== BigInt(nextMessageSequence) - 1n) {
    placed = await transaction
      .updateTable("messages")
      .set({
        sequence: nextMessageSequence,
      })
      .where("id", "=", messageId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("threads")
      .set({
        nextMessageSequence: sql`next_message_sequence + 1`,
      })
      .where("id", "=", thread.id)
      .executeTakeFirstOrThrow();
  }
  return appendHostDeploymentEvent(transaction, {
    data: {
      message: messageFromRow(placed),
    },
    environmentId: thread.environmentId,
    runId,
    threadId: thread.id,
    type: "message.placed",
  });
}
function isGuaranteedCompletionKind(kind: MessageKind): boolean {
  return kind === "run-result" || kind === "continuation";
}
async function replayThreadInput(
  transaction: Transaction<DatabaseSchema>,
  row: Selectable<ThreadInputTable>,
): Promise<EnqueuedThreadInput> {
  const messageRow = await transaction
    .selectFrom("messages")
    .selectAll()
    .where("id", "=", row.messageId)
    .executeTakeFirstOrThrow();
  const steerCommand = row.steerCommandId
    ? await transaction
        .selectFrom("commands")
        .selectAll()
        .where("id", "=", row.steerCommandId)
        .executeTakeFirstOrThrow()
    : null;
  let runRow = messageRow.runId
    ? await transaction
        .selectFrom("runs")
        .selectAll()
        .where("id", "=", messageRow.runId)
        .executeTakeFirst()
    : undefined;
  if (!runRow && row.policy === "queue") {
    const queued = transaction
      .selectFrom("runs")
      .selectAll()
      .where("threadId", "=", row.threadId)
      .where("status", "=", "queued");
    runRow = await queued.where("seedInputId", "=", row.messageId).executeTakeFirst();
  }
  const executeCommand =
    !steerCommand &&
    runRow?.status === "queued" &&
    row.policy === "queue" &&
    runRow.seedInputId === row.messageId
      ? await transaction
          .selectFrom("commands")
          .selectAll()
          .where("runId", "=", runRow.id)
          .where("type", "=", "run.execute")
          .executeTakeFirstOrThrow()
      : null;
  const command = steerCommand ?? executeCommand;
  return {
    command,
    disposition: steerCommand
      ? "steering"
      : row.policy === "queue" && runRow?.status === "queued"
        ? "run-queued"
        : row.state === "cancelled"
          ? "cancelled"
          : "pending",
    events: [],
    input: threadInputFromRow(row),
    message: messageFromRow(messageRow),
    revokedGrants: [],
    run: runRow ? runFromRow(runRow) : null,
    wasDuplicate: true,
  };
}
async function assignmentReturnGroup(
  transaction: Transaction<DatabaseSchema>,
  assignment: Pick<
    Selectable<DelegationTable>,
    | "origin"
    | "parentThreadId"
    | "parentRunId"
    | "parentOccurrenceId"
    | "parentWatchActivationId"
    | "parentAssignmentId"
  > & {
    readonly causalChainId: CausalChainId;
    readonly requestedBy: UserId;
  },
) {
  return transaction
    .selectFrom("delegations")
    .innerJoin("runs as childRun", "childRun.id", "delegations.childRunId")
    .innerJoin("threads as childThread", "childThread.id", "delegations.childThreadId")
    .selectAll("delegations")
    .where("delegations.parentThreadId", "=", assignment.parentThreadId)
    .where("delegations.origin", "=", assignment.origin)
    .where(
      "delegations.parentRunId",
      assignment.parentRunId === null ? "is" : "=",
      assignment.parentRunId,
    )
    .where(
      "delegations.parentOccurrenceId",
      assignment.parentOccurrenceId === null ? "is" : "=",
      assignment.parentOccurrenceId,
    )
    .where(
      "delegations.parentWatchActivationId",
      assignment.parentWatchActivationId === null ? "is" : "=",
      assignment.parentWatchActivationId,
    )
    .where(
      "delegations.parentAssignmentId",
      assignment.parentAssignmentId === null ? "is" : "=",
      assignment.parentAssignmentId,
    )
    .where("childRun.causalChainId", "=", assignment.causalChainId)
    .where("childRun.requestedBy", "=", assignment.requestedBy)
    .orderBy("delegations.createdAt", "asc")
    .orderBy("delegations.id", "asc")
    .execute();
}
async function lockAssignmentReturn(
  transaction: Transaction<DatabaseSchema>,
  assignmentId: AssignmentId,
) {
  const observed = await transaction
    .selectFrom("delegations")
    .innerJoin("threads as childThread", "childThread.id", "delegations.childThreadId")
    .innerJoin("threads as parentThread", "parentThread.id", "delegations.parentThreadId")
    .innerJoin("runs as childRun", "childRun.id", "delegations.childRunId")
    .selectAll("delegations")
    .select(["childRun.causalChainId", "childRun.requestedBy"])
    .where("delegations.id", "=", assignmentId)
    .executeTakeFirst();
  if (!observed) return null;
  const group = await assignmentReturnGroup(transaction, observed);
  const threadIds = [
    ...new Set([observed.parentThreadId, ...group.map(({ childThreadId }) => childThreadId)]),
  ];
  await lockThreadChannelAuthorities(transaction, threadIds);
  await transaction
    .selectFrom("threads")
    .select("id")
    .where("id", "in", threadIds)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  const lockedGroup = await assignmentReturnGroup(transaction, observed);
  if (lockedGroup.some(({ id }) => !group.some((member) => member.id === id)))
    throw new TransactionScopeChanged();
  await lockThreadProjectionParents(transaction, {
    threadIds,
    runIds: group.map(({ childRunId }) => childRunId),
    assignmentIds: group.map(({ id }) => id),
  });
  const assignment = await transaction
    .selectFrom("delegations")
    .selectAll()
    .where("id", "=", assignmentId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  return {
    assignment,
    observed,
    group: lockedGroup,
  };
}
async function waitingAssignmentReturn(
  transaction: Transaction<DatabaseSchema>,
  messageId: MessageId,
) {
  return transaction
    .selectFrom("threadInputs")
    .selectAll()
    .where("messageId", "=", messageId)
    .where("state", "=", "pending")
    .where("runId", "is", null)
    .where("steerCommandId", "is", null)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("runs").select("id").whereRef("seedInputId", "=", "threadInputs.messageId"),
        ),
      ),
    )
    .executeTakeFirst();
}
async function assignmentReturnMembers(
  transaction: Transaction<DatabaseSchema>,
  messageId: MessageId,
) {
  return transaction
    .selectFrom("delegations")
    .innerJoin("threads", "threads.id", "delegations.childThreadId")
    .innerJoin("runs", "runs.id", "delegations.childRunId")
    .select([
      "delegations.id",
      "delegations.childThreadId",
      "delegations.status",
      "delegations.resultText",
      "threads.title",
      "runs.requestedBy",
    ])
    .where("delegations.resultMessageId", "=", messageId)
    .where("delegations.resultReason", "is", null)
    .orderBy("delegations.createdAt", "asc")
    .orderBy("delegations.id", "asc")
    .execute();
}
type AssignmentReturnMember = Awaited<ReturnType<typeof assignmentReturnMembers>>[number];
const assignmentReturnMaxBytes = 64 * 1_024;
function assignmentReturnContent(
  members: readonly AssignmentReturnMember[],
  maxBytes = assignmentReturnMaxBytes,
) {
  const entries = members.map((member) => ({
    header: `Task ${member.status}: ${member.title}\nTask Thread: ${member.childThreadId} · Assignment: ${member.id}`,
    result: member.status === "cancelled" ? "" : (member.resultText ?? ""),
    pointer: `\n\n[Result shortened. Read the rest with task_status (assignmentId: ${member.id}) or thread_read (threadId: ${member.childThreadId}).]`,
  }));
  const content = (results: readonly string[]) => [
    {
      type: "text" as const,
      text: results.join("\n\n"),
    },
  ];
  const full = content(
    entries.map(({ header, result }) => (result ? `${header}\n\n${result}` : header)),
  );
  const serializedBytes = (value: string) => Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
  if (Buffer.byteLength(JSON.stringify(full), "utf8") <= maxBytes)
    return MessageContentSchema.parse(full);
  const needsPreview = entries.map(
    ({ result, pointer }) => serializedBytes(result) > serializedBytes(pointer),
  );
  const minimal = entries.map(({ header, result, pointer }, index) =>
    result ? `${header}\n\n${needsPreview[index] ? pointer : result}` : header,
  );
  const fixedBytes = Buffer.byteLength(JSON.stringify(content(minimal)), "utf8");
  const allowance = Math.max(
    0,
    Math.floor((maxBytes - fixedBytes) / needsPreview.filter(Boolean).length),
  );
  return MessageContentSchema.parse(
    content(
      entries.map(({ header, result, pointer }, index) => {
        if (!needsPreview[index]) return minimal[index]!;
        if (serializedBytes(result) <= allowance + serializedBytes(pointer))
          return `${header}\n\n${result}`;
        let low = 0;
        let high = result.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (serializedBytes(result.slice(0, middle)) <= allowance) low = middle;
          else high = middle - 1;
        }
        return `${header}\n\n${result.slice(0, surrogateSafeCut(result, low))}${pointer}`;
      }),
    ),
  );
}
async function rewriteAssignmentReturn(
  transaction: Transaction<DatabaseSchema>,
  input: Selectable<ThreadInputTable>,
  members: readonly AssignmentReturnMember[],
  mayGrow = false,
): Promise<readonly AgentEvent[]> {
  const events: AgentEvent[] = [];
  const readable: AssignmentReturnMember[] = [];
  for (const member of members) {
    if (
      member.status === "cancelled" ||
      (await threadExecutionIsAvailableToUser(
        transaction,
        member.childThreadId,
        member.requestedBy,
      ))
    ) {
      readable.push(member);
    } else {
      const unavailable = await transaction
        .updateTable("delegations")
        .set((expression) => ({
          resultMessageId: null,
          resultStatus: "undeliverable",
          resultReason: "execution-authority-unavailable",
          completedAt: new Date(),
          revision: expression("revision", "+", 1),
          updatedAt: new Date(),
        }))
        .where("id", "=", member.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      events.push(
        ...(await assignmentEventsInTransaction(transaction, unavailable, "assignment.updated")),
      );
    }
  }
  if (!readable.length) return [...events, await withdrawAssignmentReturn(transaction, input)];
  const currentMessage = await transaction
    .selectFrom("messages")
    .select("content")
    .where("id", "=", input.messageId)
    .executeTakeFirstOrThrow();
  const content = assignmentReturnContent(
    readable,
    mayGrow
      ? assignmentReturnMaxBytes
      : Math.min(
          assignmentReturnMaxBytes,
          Buffer.byteLength(JSON.stringify(currentMessage.content)),
        ),
  );
  await assertThreadInputCapacity(
    transaction,
    input.threadId,
    Buffer.byteLength(JSON.stringify(content)),
    input.policy,
    input.messageId,
  );
  const updatedInput = await transaction
    .updateTable("threadInputs")
    .set({
      requestFingerprint: createHash("sha256").update(JSON.stringify(content)).digest("base64url"),
      updatedAt: new Date(),
    })
    .where("messageId", "=", input.messageId)
    .returningAll()
    .executeTakeFirstOrThrow();
  const message = await transaction
    .updateTable("messages")
    .set({
      content: jsonValue(content),
    })
    .where("id", "=", input.messageId)
    .returningAll()
    .executeTakeFirstOrThrow();
  const parent = await transaction
    .selectFrom("threads")
    .select(["environmentId"])
    .where("id", "=", input.threadId)
    .executeTakeFirstOrThrow();
  events.push(
    await appendHostDeploymentEvent(transaction, {
      data: {
        input: threadInputFromRow(updatedInput),
        message: messageFromRow(message),
      },
      environmentId: parent.environmentId,
      runId: null,
      threadId: input.threadId,
      type: "message.created",
    }),
  );
  return events;
}
async function withdrawAssignmentReturn(
  transaction: Transaction<DatabaseSchema>,
  input: Selectable<ThreadInputTable>,
) {
  const pending = await transaction
    .updateTable("threadInputs")
    .set({
      state: "cancelled",
      cancelReason: "withdrawn",
      updatedAt: new Date(),
    })
    .where("messageId", "=", input.messageId)
    .returningAll()
    .executeTakeFirstOrThrow();
  const parent = await transaction
    .selectFrom("threads")
    .select(["environmentId"])
    .where("id", "=", input.threadId)
    .executeTakeFirstOrThrow();
  return appendHostDeploymentEvent(transaction, {
    data: {
      input: threadInputFromRow(pending),
    },
    environmentId: parent.environmentId,
    runId: null,
    threadId: input.threadId,
    type: "thread-input.updated",
  });
}
async function deliverAssignmentReturnTransaction(
  transaction: Transaction<DatabaseSchema>,
  assignmentId: AssignmentId,
): Promise<readonly AgentEvent[]> {
  const locked = await lockAssignmentReturn(transaction, assignmentId);
  if (!locked) return [];
  const { assignment } = locked;
  if (assignment.status === "open" || assignment.resultStatus !== "pending") return [];
  // An empty result has nothing to return and wakes nobody. A parent task still
  // receives it below: it needs the completion to continue and settle.
  if (
    assignment.status === "completed" &&
    assignment.resultText === "" &&
    assignment.parentAssignmentId === null
  ) {
    const settled = await transaction
      .updateTable("delegations")
      .set((expression) => ({
        completedAt: new Date(),
        resultStatus: "delivered",
        resultWaits: jsonValue([]),
        revision: expression("revision", "+", 1),
        updatedAt: new Date(),
      }))
      .where("id", "=", assignmentId)
      .where("resultStatus", "=", "pending")
      .returningAll()
      .executeTakeFirstOrThrow();
    return assignmentEventsInTransaction(transaction, settled, "assignment.updated");
  }
  const [worker, parent, requester, parentOpenAssignment] = await Promise.all([
    transaction
      .selectFrom("threads")
      .select(["id", "title"])
      .where("id", "=", assignment.childThreadId)
      .executeTakeFirstOrThrow(),
    transaction
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", assignment.parentThreadId)
      .executeTakeFirstOrThrow(),
    transaction
      .selectFrom("runs")
      .select(["causalChainId", "requestedBy"])
      .where("id", "=", assignment.childRunId)
      .executeTakeFirstOrThrow(),
    transaction
      .selectFrom("delegations")
      .select("id")
      .where("childThreadId", "=", assignment.parentThreadId)
      .where("status", "=", "open")
      .executeTakeFirst(),
  ]);
  // The work that asked for this result has ended; only its own Thread still
  // cares, and that Thread was told when its work was stopped.
  const parentAssignmentEnded =
    assignment.parentAssignmentId !== null &&
    parentOpenAssignment?.id !== assignment.parentAssignmentId;
  const executionValid =
    !parentAssignmentEnded &&
    parent.status !== "archived" &&
    (await threadExecutionIsAvailableToUser(transaction, parent.id, requester.requestedBy)) &&
    (assignment.status === "cancelled" ||
      (await threadExecutionIsAvailableToUser(transaction, worker.id, requester.requestedBy)));
  if (!executionValid) {
    const updated = await transaction
      .updateTable("delegations")
      .set((expression) => ({
        completedAt: new Date(),
        resultReason: parentAssignmentEnded
          ? "parent-assignment-terminal"
          : "execution-authority-unavailable",
        resultStatus: "undeliverable",
        resultWaits: jsonValue([]),
        revision: expression("revision", "+", 1),
        updatedAt: new Date(),
      }))
      .where("id", "=", assignmentId)
      .where("resultStatus", "=", "pending")
      .returningAll()
      .executeTakeFirstOrThrow();
    return assignmentEventsInTransaction(transaction, updated, "assignment.updated");
  }
  for (const wait of assignment.resultWaits) {
    if (wait.expiresAt <= Date.now()) continue;
    try {
      await assertThreadCaller(transaction, wait.authority, {
        threadId: assignment.childThreadId,
        readOnly: true,
      });
      await transaction
        .updateTable("delegations")
        .set({
          resultAttemptedAt: new Date(),
        })
        .where("id", "=", assignment.id)
        .execute();
      return [];
    } catch (error) {
      if (!(error instanceof OpensteerError && error.code === "forbidden")) throw error;
    }
  }
  // A result is work for the parent's next turn; a cancellation is only
  // context, so it never starts a Run the parent did not ask for.
  const cancelled = assignment.status === "cancelled";
  const policy = cancelled || parent.doneAt ? "report" : "queue";
  const member: AssignmentReturnMember = {
    id: assignment.id,
    childThreadId: worker.id,
    title: worker.title,
    status: assignment.status,
    resultText: assignment.resultText,
    requestedBy: requester.requestedBy,
  };
  const siblings = locked.group.filter(
    ({ resultMessageId, resultReason }) => resultMessageId !== null && resultReason === null,
  );
  for (const messageId of new Set(siblings.map(({ resultMessageId }) => resultMessageId))) {
    if (!messageId) continue;
    const waiting = await waitingAssignmentReturn(transaction, messageId);
    if (
      !waiting ||
      waiting.policy !== policy ||
      waiting.requestedBy !== requester.requestedBy ||
      waiting.assignmentId !== (parentOpenAssignment?.id ?? null) ||
      !isDeepStrictEqual(waiting.replyTarget, assignment.replyTarget)
    )
      continue;
    const members = [...(await assignmentReturnMembers(transaction, messageId)), member];
    const updated = await transaction
      .updateTable("delegations")
      .set((expression) => ({
        completedAt: new Date(),
        resultMessageId: messageId,
        resultReason: null,
        resultStatus: "delivered",
        resultWaits: jsonValue([]),
        revision: expression("revision", "+", 1),
        updatedAt: new Date(),
      }))
      .where("id", "=", assignment.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return [
      ...(await rewriteAssignmentReturn(transaction, waiting, members, true)),
      ...(await assignmentEventsInTransaction(transaction, updated, "assignment.updated")),
    ];
  }
  const content = assignmentReturnContent([member]);
  await assertThreadInputCapacity(
    transaction,
    parent.id,
    Buffer.byteLength(JSON.stringify(content), "utf8"),
    policy,
  );
  const messageId = createId("message");
  const source = {
    cause: "assignment-result",
    kind: "platform",
    referenceId: assignment.id,
  } as const;
  const messageRow = await transaction
    .insertInto("messages")
    .values({
      actorPrincipalId: systemPrincipalId,
      author: jsonValue(MessageAuthorSchema.parse(source)),
      content: jsonValue(content),
      id: messageId,
      kind: "continuation",
      runId: null,
      sequence: parent.nextMessageSequence,
      threadId: parent.id,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const inputRow = await transaction
    .insertInto("threadInputs")
    .values({
      actorPrincipalId: systemPrincipalId,
      // The parent's open work receives the result, as any input into its Thread would.
      assignmentId: parentOpenAssignment?.id ?? null,
      authoritySource: jsonValue({
        ...source,
        sourceRunId: assignment.resultRunId ?? assignment.childRunId,
        userId: requester.requestedBy,
      }),
      cancelReason: null,
      causalChainId: requester.causalChainId,
      deliveredAt: null,
      idempotencyKey: `assignment-return:${assignment.id}`,
      messageId,
      policy,
      queueRank: parent.nextMessageSequence,
      replyTarget: assignment.replyTarget ? jsonValue(assignment.replyTarget) : null,
      requestedBy: requester.requestedBy,
      requestFingerprint: createHash("sha256").update(JSON.stringify(content)).digest("base64url"),
      runId: null,
      state: "pending",
      steerCommandId: null,
      threadId: parent.id,
      updatedAt: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable("threads")
    .set({
      nextMessageSequence: sql`next_message_sequence + 1`,
      updatedAt: new Date(),
    })
    .where("id", "=", parent.id)
    .executeTakeFirstOrThrow();
  const updated = await transaction
    .updateTable("delegations")
    .set((expression) => ({
      completedAt: new Date(),
      resultMessageId: messageId,
      resultReason: null,
      resultStatus: "delivered",
      resultWaits: jsonValue([]),
      revision: expression("revision", "+", 1),
      updatedAt: new Date(),
    }))
    .where("id", "=", assignment.id)
    .where("resultStatus", "=", "pending")
    .returningAll()
    .executeTakeFirstOrThrow();
  const events: AgentEvent[] = [
    await appendHostDeploymentEvent(transaction, {
      data: {
        input: threadInputFromRow(inputRow),
        message: messageFromRow(messageRow),
      },
      environmentId: parent.environmentId,
      runId: null,
      threadId: parent.id,
      type: "message.created",
    }),
  ];
  if (policy === "queue") events.push(...(await ensureQueuedRun(transaction, parent)).events);
  events.push(...(await assignmentEventsInTransaction(transaction, updated, "assignment.updated")));
  return events;
}
async function assignmentResultReader(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly assignmentId: AssignmentId;
    readonly authority: ThreadCallerAuthority;
  },
) {
  await lockThreadCaller(transaction, input.authority);
  const locked = await lockAssignmentReturn(transaction, input.assignmentId);
  if (!locked)
    throw new OpensteerError({
      code: "forbidden",
      message: "Assignment is unavailable",
    });
  const { assignment } = locked;
  const authority = input.authority;
  await assertThreadCaller(transaction, authority, {
    threadId: assignment.childThreadId,
    readOnly: true,
  });
  if (
    !(await threadExecutionIsAvailableToUser(
      transaction,
      assignment.childThreadId,
      authority.userId,
    ))
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "Assignment is unavailable",
    });
  const requester = await transaction
    .selectFrom("runs")
    .select("requestedBy")
    .where("id", "=", assignment.childRunId)
    .executeTakeFirstOrThrow();
  const assigner =
    requester.requestedBy === authority.userId &&
    (authority.kind === "run"
      ? assignment.origin === "run" && assignment.parentRunId === authority.scope.runId
      : authority.kind === "trigger"
        ? assignment.parentOccurrenceId === authority.scope.occurrenceId
        : authority.kind === "watch"
          ? assignment.parentWatchActivationId === authority.scope.activationId
          : false);
  return {
    assignment,
    assigner,
  };
}

/**
 * How long a hold outlives its wait's own deadline: the waiter still has to
 * recheck its authority and read the result after the wait resolves. The wait
 * releases its hold when it ends; this bounds only a waiter that never does.
 */
const assignmentResultWaitGraceMs = 30_000;
export function beginAssignmentResultWait(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly assignmentId: AssignmentId;
    readonly authority: ThreadCallerAuthority;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  },
): Promise<string | null> {
  return withPersonalTransaction(
    database,
    async (transaction) => {
      const { assignment, assigner } = await assignmentResultReader(transaction, input);
      if (!assigner || assignment.resultStatus !== "pending") return null;
      const id = randomUUID();
      const now = Date.now();
      await transaction
        .updateTable("delegations")
        .set({
          resultWaits: jsonValue([
            ...assignment.resultWaits.filter(({ expiresAt }) => expiresAt > now),
            {
              id,
              authority: input.authority,
              expiresAt:
                now + Math.min(100_000, Math.max(1, input.timeoutMs)) + assignmentResultWaitGraceMs,
            },
          ]),
        })
        .where("id", "=", assignment.id)
        .execute();
      await assertThreadCaller(transaction, input.authority, {
        threadId: assignment.childThreadId,
        readOnly: true,
      });
      input.signal?.throwIfAborted();
      return id;
    },
    undefined,
    (error) => error instanceof TransactionScopeChanged,
  );
}
export async function endAssignmentResultWait(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly assignmentId: AssignmentId;
    readonly waitId: string;
  },
): Promise<readonly AgentEvent[]> {
  await withPersonalTransaction(
    database,
    async (transaction) => {
      const locked = await lockAssignmentReturn(transaction, input.assignmentId);
      if (!locked) return;
      await transaction
        .updateTable("delegations")
        .set({
          resultWaits: jsonValue(
            locked.assignment.resultWaits.filter(({ id }) => id !== input.waitId),
          ),
        })
        .where("id", "=", input.assignmentId)
        .execute();
    },
    undefined,
    (error) => error instanceof TransactionScopeChanged,
  );
  return drainAssignmentReturn(database, input.assignmentId);
}

/** Startup holds the Deployment's exclusive Host lease; no waiter survived it. */
export async function recoverAssignmentResultWaits(
  database: Kysely<DatabaseSchema>,
): Promise<void> {
  await withPersonalTransaction(database, async (transaction) => {
    const waits = await transaction
      .selectFrom("delegations")
      .select("id")
      .where(sql<boolean>`result_waits <> '[]'::jsonb`)
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
    if (waits.length)
      await transaction
        .updateTable("delegations")
        .set({
          resultWaits: jsonValue([]),
        })
        .where(
          "id",
          "in",
          waits.map(({ id }) => id),
        )
        .execute();
  });
}

/** Reading and automatic return share the same Thread and Assignment fences. */
export function readAssignmentResult(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly assignmentId: AssignmentId;
    readonly authority: ThreadCallerAuthority;
    readonly signal?: AbortSignal;
  },
) {
  return withPersonalTransaction(
    database,
    async (transaction) => {
      let { assignment, assigner } = await assignmentResultReader(transaction, input);
      const authority = input.authority;
      const events: AgentEvent[] = [];
      let result = assignment.resultText;
      if (assigner && assignment.status !== "open") {
        let canRead =
          assignment.resultMessageId === null || assignment.resultReason === "read-by-assigner";
        if (assignment.resultMessageId && assignment.resultReason !== "read-by-assigner") {
          const waiting = await waitingAssignmentReturn(transaction, assignment.resultMessageId);
          if (waiting) {
            canRead = true;
            const remaining = (
              await assignmentReturnMembers(transaction, waiting.messageId)
            ).filter(({ id }) => id !== assignment.id);
            if (remaining.length) {
              events.push(...(await rewriteAssignmentReturn(transaction, waiting, remaining)));
            } else {
              events.push(await withdrawAssignmentReturn(transaction, waiting));
            }
          }
        }
        if (canRead && assignment.resultReason !== "read-by-assigner") {
          assignment = await transaction
            .updateTable("delegations")
            .set((expression) => ({
              completedAt: new Date(),
              resultStatus: "delivered",
              resultReason: "read-by-assigner",
              resultWaits: jsonValue([]),
              revision: expression("revision", "+", 1),
              updatedAt: new Date(),
            }))
            .where("id", "=", assignment.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          events.push(
            ...(await assignmentEventsInTransaction(transaction, assignment, "assignment.updated")),
          );
        }
        if (!canRead) result = null;
      }
      await assertThreadCaller(transaction, authority, {
        threadId: assignment.childThreadId,
        readOnly: true,
      });
      input.signal?.throwIfAborted();
      return {
        assignment: await assignmentSummaryInTransaction(transaction, assignment),
        result,
        events,
      };
    },
    undefined,
    (error) => error instanceof TransactionScopeChanged,
  );
}

/**
 * Delivers one Assignment's return if it is still pending. A failed attempt is
 * recorded so the row waits behind the others; a full parent inbox is an
 * ordinary wait, anything else also surfaces to the caller.
 */
export async function drainAssignmentReturn(
  database: Kysely<DatabaseSchema>,
  assignmentId: AssignmentId,
): Promise<readonly AgentEvent[]> {
  try {
    return await withPersonalTransaction(
      database,
      (transaction) => deliverAssignmentReturnTransaction(transaction, assignmentId),
      undefined,
      (error) => error instanceof TransactionScopeChanged,
    );
  } catch (error) {
    await database
      .updateTable("delegations")
      .set({
        resultAttemptedAt: new Date(),
      })
      .where("id", "=", assignmentId)
      .where("resultStatus", "=", "pending")
      .execute();
    if (error instanceof OpensteerError && error.code === "resource_exhausted") return [];
    throw error;
  }
}
export interface AssignmentReturnDrain {
  readonly events: readonly AgentEvent[];
  readonly failures: readonly {
    readonly assignmentId: AssignmentId;
    readonly error: unknown;
  }[];
}

/** The outbox retry: one return that cannot be delivered never holds back the rest. */
export async function drainPendingAssignmentReturns(
  database: Kysely<DatabaseSchema>,
  limit = 100,
): Promise<AssignmentReturnDrain> {
  const candidates = await database
    .selectFrom("delegations")
    .select("id")
    .where("status", "!=", "open")
    .where("resultStatus", "=", "pending")
    .orderBy(sql`result_attempted_at asc nulls first`)
    .orderBy("createdAt", "asc")
    .limit(Math.max(1, Math.min(limit, 1_000)))
    .execute();
  const events: AgentEvent[] = [];
  const failures: {
    readonly assignmentId: AssignmentId;
    readonly error: unknown;
  }[] = [];
  for (const candidate of candidates) {
    try {
      events.push(...(await drainAssignmentReturn(database, candidate.id)));
    } catch (error) {
      failures.push({
        assignmentId: candidate.id,
        error,
      });
    }
  }
  return {
    events,
    failures,
  };
}
function canonicalDelegateThreadRequest(
  input: DelegateThreadRequest,
): Readonly<Record<string, unknown>> {
  return {
    ...(input.callerIntent
      ? {
          callerIntent: input.callerIntent,
        }
      : {}),
    accessMode: input.accessMode,
    createdBy: input.createdBy,
    environmentId: input.environmentId,
    harnessInstanceId: input.harnessInstanceId,
    idempotencyKey: input.idempotencyKey,
    modelSelection: input.modelSelection,
    origin: input.origin,
    task: input.task,
    ...(input.threadId
      ? {
          threadId: input.threadId,
        }
      : {}),
    title: input.title,
    ...(input.titleSource && input.titleSource !== "chosen"
      ? {
          titleSource: input.titleSource,
        }
      : {}),
    ...(input.specialistId
      ? {
          specialistId: input.specialistId,
        }
      : {}),
    type: "thread.delegate",
  };
}
/**
 * An automation's notice goes where its owner finds it: its anchor, or the
 * nearest listed task above an anchor that runs in its own linked task.
 */
async function assertAutomationNoticeDestination(
  transaction: Transaction<DatabaseSchema>,
  anchorThreadId: ThreadId,
  targetThreadId: ThreadId,
): Promise<void> {
  if ((await nearestListedThread(transaction, anchorThreadId))?.threadId === targetThreadId) return;
  // An anchor above may have become listed since the notice was addressed; the
  // sender reads the destination again.
  if (await descendsByParentLink(transaction, anchorThreadId, targetThreadId))
    throw new OpensteerError({
      code: "conflict",
      message: "The automation's task moved; address its notice again",
      retryable: true,
    });
  throw new OpensteerError({ code: "forbidden", message: "Automation source is invalid" });
}

/**
 * Work that may reopen a Done task without the person: an automation's notice
 * addressed to it, or queued work from a task linked under it, such as a
 * monitor that runs in its own task and reports what it found.
 */
async function sourceReopensDoneTask(
  transaction: Transaction<DatabaseSchema>,
  source: ThreadInputSource,
  policy: "report" | "queue" | "steer",
  threadId: ThreadId,
): Promise<boolean> {
  if (policy !== "queue") return false;
  if (source.kind === "automation") return true;
  const sourceThread =
    source.kind === "agent"
      ? await transaction
          .selectFrom("runs")
          .select("threadId")
          .where("id", "=", source.runId)
          .executeTakeFirst()
      : source.kind === "trigger"
        ? await transaction
            .selectFrom("triggerOccurrences")
            .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
            .select("triggers.anchorThreadId as threadId")
            .where("triggerOccurrences.id", "=", source.occurrenceId)
            .executeTakeFirst()
        : source.kind === "watch"
          ? await transaction
              .selectFrom("triggerWatchActivations")
              .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
              .select("triggers.anchorThreadId as threadId")
              .where("triggerWatchActivations.id", "=", source.activationId)
              .executeTakeFirst()
          : undefined;
  return (
    sourceThread !== undefined && descendsByParentLink(transaction, sourceThread.threadId, threadId)
  );
}
async function findCommandByIdempotency(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  requestedBy: UserId,
  idempotencyKey: string,
): Promise<CommandRow | undefined> {
  return database
    .selectFrom("commands")
    .selectAll()
    .where("requestedBy", "=", requestedBy)
    .where("idempotencyKey", "=", idempotencyKey)
    .executeTakeFirst();
}
const delegationIntentPayloadSchema = z.object({
  callerIntent: z
    .object({
      requestId: z.string(),
      requestFingerprint: z.string(),
    })
    .optional(),
  createdBy: z.string(),
  origin: z.unknown(),
  type: z.literal("thread.delegate"),
});
async function delegationCallerIntentMatches(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  input: DelegateThreadRequest,
  storedPayload: unknown,
): Promise<boolean> {
  const intent = input.callerIntent;
  const stored = delegationIntentPayloadSchema.safeParse(storedPayload);
  if (
    !intent ||
    !stored.success ||
    stored.data.createdBy !== input.createdBy ||
    !isDeepStrictEqual(stored.data.origin, input.origin)
  )
    return false;
  // A Watch retries the same observation under a fresh transport request id.
  if (stored.data.callerIntent)
    return stored.data.callerIntent.requestFingerprint === intent.requestFingerprint;

  // Previous releases kept caller intent in the admission ledger, while the
  // command payload included a derived title whose algorithm can change.
  let receipt:
    | {
        readonly requestFingerprint: string;
      }
    | undefined;
  switch (input.origin.kind) {
    case "run":
      receipt = await database
        .selectFrom("agentControlRequests")
        .select("requestFingerprint")
        .where("runId", "=", input.origin.parentRunId)
        .where("sourceThreadId", "=", input.origin.parentThreadId)
        .where("requestId", "=", intent.requestId)
        .where("action", "=", "thread.delegate")
        .executeTakeFirst();
      break;
    case "trigger":
      receipt = await database
        .selectFrom("triggerControlRequests")
        .select("requestFingerprint")
        .where("occurrenceId", "=", input.origin.occurrenceId)
        .where("requestId", "=", intent.requestId)
        .where("action", "=", "thread.delegate")
        .executeTakeFirst();
      break;
    case "watch":
      receipt = await database
        .selectFrom("watchControlRequests")
        .select("requestFingerprint")
        .where("activationId", "=", input.origin.activationId)
        .where("observationId", "=", input.origin.observationId)
        .where("action", "=", "thread.delegate")
        .executeTakeFirst();
      break;
  }
  return receipt?.requestFingerprint === intent.requestFingerprint;
}
async function replayDelegatedThread(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  input: DelegateThreadRequest,
  payload: Readonly<Record<string, unknown>>,
): Promise<DelegatedThreadResult | undefined> {
  const command = await findCommandByIdempotency(database, input.createdBy, input.idempotencyKey);
  if (!command) return undefined;
  if (
    !["thread.create", "thread.delegate"].includes(command.type) ||
    !command.threadId ||
    !(input.callerIntent
      ? await delegationCallerIntentMatches(database, input, command.payload)
      : isDeepStrictEqual(command.payload, payload))
  ) {
    throw idempotencyConflict(input.idempotencyKey);
  }
  const taskInput = await database
    .selectFrom("threadInputs")
    .select("messageId")
    .where("threadId", "=", command.threadId)
    .where("requestedBy", "=", input.createdBy)
    .where("idempotencyKey", "=", `${input.idempotencyKey}:task`)
    .executeTakeFirstOrThrow();
  const [threadRow, delegationRow] = await Promise.all([
    database
      .selectFrom("threads")
      .selectAll()
      .select([
        threadPendingRequestsSelection,
        threadVisitSelection,
        threadLatestRunCompletedAtSelection,
        threadProviderSessionSelection,
        threadContinuationIdentitySelection,
      ])
      .where("id", "=", command.threadId)
      .executeTakeFirstOrThrow(),
    database
      .selectFrom("delegations")
      .selectAll()
      .where("initialInputMessageId", "=", taskInput.messageId)
      .executeTakeFirstOrThrow(),
  ]);
  const runRow = await database
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", delegationRow.childRunId)
    .executeTakeFirstOrThrow();
  const [messageRow, inputRow, executeCommand] = await Promise.all([
    database
      .selectFrom("messages")
      .selectAll()
      .where("id", "=", runRow.seedInputId)
      .executeTakeFirstOrThrow(),
    database
      .selectFrom("threadInputs")
      .selectAll()
      .where("messageId", "=", runRow.seedInputId)
      .executeTakeFirstOrThrow(),
    database
      .selectFrom("commands")
      .selectAll()
      .where("runId", "=", runRow.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow(),
  ]);
  return {
    assignment: await assignmentSummaryInTransaction(database, delegationRow),
    command: executeCommand,
    events: [],
    input: threadInputFromRow(inputRow),
    message: messageFromRow(messageRow),
    run: runFromRow(runRow),
    thread: threadFromRow(threadRow),
    wasDuplicate: true,
  };
}
export async function findDelegatedThreadByIdempotency(
  database: Kysely<DatabaseSchema>,
  input: DelegateThreadRequest,
): Promise<DelegatedThreadResult | null> {
  return (
    (await replayDelegatedThread(database, input, canonicalDelegateThreadRequest(input))) ?? null
  );
}
async function watchObservationCausalChain(
  transaction: Transaction<DatabaseSchema>,
  activationId: TriggerWatchActivationId,
  observationId: string,
): Promise<CausalChainId> {
  const existing = await transaction
    .selectFrom("causalChains")
    .select("id")
    .where("rootWatchActivationId", "=", activationId)
    .where("rootWatchObservationId", "=", observationId)
    .executeTakeFirst();
  if (existing) return existing.id;
  return (
    await transaction
      .insertInto("causalChains")
      .values({
        id: createId("causalChain"),
        maxDelegations: causalChainMaxDelegations,
        maxAutonomousRuns: causalChainMaxAutonomousRuns,
        rootMessageId: null,
        rootOccurrenceId: null,
        rootWatchActivationId: activationId,
        rootWatchObservationId: observationId,
        usedDelegations: 0,
        usedAutonomousRuns: 0,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}

/** Reserve both caller and child-input identities before execution fences; see ./lock-order.ts. */
export async function lockDelegationIdempotency(
  transaction: Transaction<DatabaseSchema>,
  input: Pick<DelegateThreadRequest, "createdBy" | "idempotencyKey">,
): Promise<void> {
  for (const key of [input.idempotencyKey, `${input.idempotencyKey}:task`].sort()) {
    await lockCommandIdempotency(transaction, input.createdBy, key);
  }
}
export async function delegateThreadInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: DelegateThreadRequest,
): Promise<DelegatedThreadResult> {
  const task = ContentPartSchema.array().min(1).parse(input.task);
  const request = {
    ...input,
    task,
  };
  const requestPayload = canonicalDelegateThreadRequest(request);
  await lockDelegationIdempotency(transaction, input);
  const existing = await replayDelegatedThread(transaction, request, requestPayload);
  if (existing) return existing;

  await requirePersonalOwner(transaction, input.createdBy);
  const observedTarget = input.threadId
    ? await transaction
        .selectFrom("threads")
        .select([
          "id",
          "environmentId",
          "harnessInstanceId",
          "modelSelection",
          "purpose",
          "status",
          "inputQueuePaused",
        ])
        .where("id", "=", input.threadId)
        .executeTakeFirst()
    : null;
  if (input.threadId && !observedTarget) {
    throw new OpensteerError({
      code: "not_found",
      message: "Target work Thread not found",
    });
  }
  if (
    observedTarget &&
    (observedTarget.id === input.origin.parentThreadId ||
      observedTarget.environmentId !== input.environmentId ||
      observedTarget.harnessInstanceId !== input.harnessInstanceId ||
      !isDeepStrictEqual(observedTarget.modelSelection, input.modelSelection) ||
      observedTarget.purpose === "voice" ||
      observedTarget.status === "archived" ||
      observedTarget.inputQueuePaused)
  ) {
    throw new OpensteerError({
      code: "conflict",
      message: "Target work Thread is not available for this Assignment",
    });
  }
  let parentRunReplyTarget: ReplyTarget | null = null;
  let parentAssignmentId: AssignmentId | null = null;
  let parentCausalChainId: CausalChainId | null = null;
  if (input.origin.kind === "run") {
    const parentRun = await transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select([
        "runs.assignmentId",
        "runs.replyTarget",
        "runs.causalChainId",
        "runs.requestedBy",
        "runs.status",
        "runs.threadId",
      ])
      .where("runs.id", "=", input.origin.parentRunId)
      .forNoKeyUpdate("runs")
      .executeTakeFirst();
    if (
      !parentRun ||
      parentRun.threadId !== input.origin.parentThreadId ||
      parentRun.requestedBy !== input.createdBy ||
      !["running", "waiting"].includes(parentRun.status)
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Parent Run is invalid",
      });
    }
    parentRunReplyTarget = parentRun.replyTarget
      ? ReplyTargetSchema.parse(parentRun.replyTarget)
      : null;
    parentAssignmentId = parentRun.assignmentId;
    parentCausalChainId = parentRun.causalChainId;
  }
  let parentTriggerId: TriggerId | null = null;
  if (input.origin.kind === "trigger") {
    const occurrence = await transaction
      .selectFrom("triggerOccurrences")
      .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
      .select([
        "triggerOccurrences.causalChainId",
        "triggerOccurrences.status",
        "triggers.anchorThreadId",
        "triggers.createdBy",
        "triggers.id as triggerId",
      ])
      .where("triggerOccurrences.id", "=", input.origin.occurrenceId)
      .forNoKeyUpdate("triggerOccurrences")
      .executeTakeFirst();
    if (
      !occurrence ||
      occurrence.anchorThreadId !== input.origin.parentThreadId ||
      occurrence.createdBy !== input.createdBy ||
      occurrence.status !== "running"
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Parent Trigger is invalid",
      });
    }
    parentTriggerId = occurrence.triggerId;
    parentCausalChainId = occurrence.causalChainId;
    if (!parentCausalChainId) {
      parentCausalChainId = createId("causalChain");
      await transaction
        .insertInto("causalChains")
        .values({
          id: parentCausalChainId,
          maxDelegations: causalChainMaxDelegations,
          maxAutonomousRuns: causalChainMaxAutonomousRuns,
          rootMessageId: null,
          rootOccurrenceId: input.origin.occurrenceId,
          usedDelegations: 0,
          usedAutonomousRuns: 0,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("triggerOccurrences")
        .set({
          causalChainId: parentCausalChainId,
        })
        .where("id", "=", input.origin.occurrenceId)
        .where("causalChainId", "is", null)
        .executeTakeFirstOrThrow();
    }
  }
  const insertThread = await prepareThreadInsertion(
    transaction,
    {
      createdBy: input.createdBy,
      environmentId: input.environmentId,
      harnessInstanceId: input.harnessInstanceId,
    },
    input.expectedHarnessRevision,
  );
  await lockThreadChannelAuthorities(transaction, [
    input.origin.parentThreadId,
    ...(input.threadId ? [input.threadId] : []),
  ]);
  const lockedThreads = await transaction
    .selectFrom("threads")
    .select(["id", "lineageRootThreadId", "purpose", "doneAt", "specialistId"])
    .where("id", "in", [input.origin.parentThreadId, ...(input.threadId ? [input.threadId] : [])])
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  if (input.threadId && lockedThreads.find(({ id }) => id === input.threadId)?.doneAt) {
    throw new OpensteerError({
      code: "conflict",
      message: "This task is Done. Reopen it first.",
    });
  }
  const parent = lockedThreads.find(({ id }) => id === input.origin.parentThreadId);
  if (!parent) {
    throw new OpensteerError({
      code: "conflict",
      message: "Parent Thread changed during delegation",
    });
  }
  // The task's first input re-reads its Trigger under lock. Taking that lock
  // here keeps it after the Threads and before the projection parents below,
  // in the declared order, rather than after them.
  if (parentTriggerId) {
    await transaction
      .selectFrom("triggers")
      .select("id")
      .where("id", "=", parentTriggerId)
      .forNoKeyUpdate()
      .execute();
  }
  if (input.origin.kind === "watch") {
    const activation = await transaction
      .selectFrom("triggerWatchActivations")
      .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
      .select([
        "triggerWatchActivations.desired",
        "triggerWatchActivations.revisionId",
        "triggers.anchorThreadId",
        "triggers.createdBy",
        "triggers.currentRevisionId",
        "triggers.status",
      ])
      .where("triggerWatchActivations.id", "=", input.origin.activationId)
      .forNoKeyUpdate("triggerWatchActivations")
      .executeTakeFirst();
    if (
      !activation ||
      activation.anchorThreadId !== input.origin.parentThreadId ||
      activation.createdBy !== input.createdBy ||
      activation.desired !== "active" ||
      activation.status !== "active" ||
      activation.revisionId !== input.origin.revisionId ||
      activation.currentRevisionId !== input.origin.revisionId
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Parent Watch is invalid",
      });
    }
    parentCausalChainId = await watchObservationCausalChain(
      transaction,
      input.origin.activationId,
      input.origin.observationId,
    );
  }
  await assertDelegationDepth(transaction, parent.id);
  if (!parentCausalChainId) {
    throw new OpensteerError({
      code: "internal",
      message: "Delegation has no causal chain",
    });
  }
  await lockThreadProjectionParents(transaction, {
    threadIds: [parent.id, ...(input.threadId ? [input.threadId] : [])],
    runIds: input.origin.kind === "run" ? [input.origin.parentRunId] : [],
    causalChainIds: [parentCausalChainId],
    assignmentIds: parentAssignmentId ? [parentAssignmentId] : [],
  });
  if (parentAssignmentId) {
    const parentAssignment = await transaction
      .selectFrom("delegations")
      .select("status")
      .where("id", "=", parentAssignmentId)
      .forShare()
      .executeTakeFirstOrThrow();
    if (parentAssignment.status !== "open") {
      throw new OpensteerError({
        code: "conflict",
        message: "Parent Assignment is terminal",
      });
    }
  }
  const delegationBudget = await transaction
    .updateTable("causalChains")
    .set((expression) => ({
      usedDelegations: expression("usedDelegations", "+", 1),
    }))
    .where("id", "=", parentCausalChainId)
    .whereRef("usedDelegations", "<", "maxDelegations")
    .executeTakeFirst();
  if (delegationBudget.numUpdatedRows !== 1n) {
    throw new OpensteerError({
      code: "resource_exhausted",
      message: `This causal chain reached its ${causalChainMaxDelegations}-delegation budget`,
    });
  }
  const actorPrincipalId = await principalIdForUser(transaction, input.createdBy);
  const threadId = input.threadId ?? createId("thread");
  if (input.threadId) {
    const [open, busy, queuedInput] = await Promise.all([
      transaction
        .selectFrom("delegations")
        .select("id")
        .where("childThreadId", "=", threadId)
        .where("status", "=", "open")
        .executeTakeFirst(),
      transaction
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", threadId)
        .where("status", "in", nonTerminalRunStatuses)
        .executeTakeFirst(),
      // Reports are context for a later turn, not work that occupies the Thread.
      transaction
        .selectFrom("threadInputs")
        .select("messageId")
        .where("threadId", "=", threadId)
        .where("state", "=", "pending")
        .where("policy", "<>", "report")
        .executeTakeFirst(),
    ]);
    if (open) {
      throw new OpensteerError({
        code: "conflict",
        details: {
          assignmentId: open.id,
        },
        message: `Thread ${threadId} is still working on task ${open.id}. Send corrections with thread_send, or cancel that task with task_cancel before giving the Thread new work.`,
      });
    }
    if (busy || queuedInput) {
      throw new OpensteerError({
        code: "conflict",
        message: "Target work Thread is still busy",
      });
    }
  }
  const reusedRow = input.threadId
    ? await transaction
        .selectFrom("threads")
        .selectAll()
        .select([threadVisitSelection, threadLatestRunCompletedAtSelection])
        .where("id", "=", threadId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow()
    : null;
  if (reusedRow) {
    await assertLineageCompatibleReuse(transaction, parent.id, reusedRow.id);
    if (input.specialistId && input.specialistId !== reusedRow.specialistId) {
      throw new OpensteerError({
        code: "forbidden",
        message: "The worker has a different specialist binding",
      });
    }
  }
  const listed = await delegationListsThread(transaction, parent.purpose, input.origin);
  // Delegation can promote a task; only a migration can take it off the list.
  const managedAnchor = reusedRow
    ? await transaction
        .selectFrom("triggers")
        .select("id")
        .where("anchorThreadId", "=", reusedRow.id)
        .where("systemRole", "is not", null)
        .executeTakeFirst()
    : null;
  const listedNow = reusedRow !== null && !reusedRow.listed && listed && !managedAnchor;
  const threadRow = reusedRow
    ? listedNow
      ? await transaction
          .updateTable("threads")
          .set({
            listed: true,
          })
          .where("id", "=", threadId)
          .returningAll()
          .executeTakeFirstOrThrow()
      : reusedRow
    : await insertThread({
        accessMode: ThreadAccessModeSchema.parse(input.accessMode),
        specialistId: input.specialistId ?? parent.specialistId,
        purpose: "task",
        teamId: null,
        channelId: null,
        threadRootId: null,
        createdByPrincipalId: actorPrincipalId,
        id: threadId,
        lineageRootThreadId: parent.lineageRootThreadId,
        listed,
        modelSelection: jsonValue(ModelSelectionSchema.parse(input.modelSelection)),
        parentThreadId: input.origin.parentThreadId,
        status: deriveThreadStatus({
          earliestActiveRunStatus: null,
          inputQueuePaused: false,
          lastRunFailed: false,
        }),
        title: input.title,
        titleSource: input.titleSource ?? "chosen",
        icon: null,
        iconSource: "provisional",
      });
  await ensureSelectedProviderSession(transaction, threadRow);
  await transaction
    .insertInto("commands")
    .values({
      actorPrincipalId,
      authoritySource: jsonValue({
        kind: "delegation",
        origin: input.origin,
      }),
      dispatcherId: null,
      environmentId: input.environmentId,
      id: createId("command"),
      idempotencyKey: input.idempotencyKey,
      lastError: null,
      payload: jsonValue(requestPayload),
      requestedBy: input.createdBy,
      runId: null,
      status: "succeeded",
      threadId,
      type: input.threadId ? "thread.delegate" : "thread.create",
    })
    .executeTakeFirstOrThrow();
  const selectedSession = await transaction
    .selectFrom("providerSessions")
    .select(["id", "continuationIdentity"])
    .where("threadId", "=", threadRow.id)
    .where("active", "=", true)
    .executeTakeFirstOrThrow();
  const thread = threadFromRow({
    ...threadRow,
    lastVisitedAt: reusedRow?.lastVisitedAt ?? null,
    latestRunCompletedAt: reusedRow?.latestRunCompletedAt ?? null,
    continuationIdentity: selectedSession.continuationIdentity,
    providerSessionId: selectedSession.id,
    pendingRequests: threadRow.pendingRequestCount,
  });
  const threadEvent =
    reusedRow === null || listedNow
      ? await appendHostDeploymentEvent(transaction, {
          data: {
            thread,
          },
          environmentId: thread.environmentId,
          runId: null,
          threadId,
          type: reusedRow === null ? "thread.created" : "thread.listed",
        })
      : null;
  const queued = await enqueueThreadInputInTransaction(transaction, {
    ...(input.origin.kind === "run"
      ? {
          forwardedPlaces: true as const,
        }
      : {}),
    content: task,
    idempotencyKey: `${input.idempotencyKey}:task`,
    policy: "queue",
    requestedBy: input.createdBy,
    source:
      input.origin.kind === "run"
        ? {
            kind: "agent",
            runId: input.origin.parentRunId,
          }
        : input.origin.kind === "trigger"
          ? {
              kind: "trigger",
              occurrenceId: input.origin.occurrenceId,
            }
          : {
              activationId: input.origin.activationId,
              kind: "watch",
              observationId: input.origin.observationId,
              revisionId: input.origin.revisionId,
              triggerId: input.origin.triggerId,
            },
    threadId,
  });
  if (!queued.run || !queued.command || queued.disposition !== "run-queued") {
    throw new OpensteerError({
      code: "internal",
      message: "Delegated Run was not queued",
    });
  }
  const assignmentId = createId("delegation");
  await transaction
    .updateTable("threadInputs")
    .set({
      assignmentId,
    })
    .where("messageId", "=", queued.message.id)
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable("runs")
    .set({
      assignmentId,
    })
    .where("id", "=", queued.run.id)
    .executeTakeFirstOrThrow();
  const delegationRow = await transaction
    .insertInto("delegations")
    .values({
      childRunId: queued.run.id,
      childThreadId: threadId,
      completedAt: null,
      finishedAt: null,
      id: assignmentId,
      initialInputMessageId: queued.message.id,
      objective: input.title,
      origin: input.origin.kind,
      parentAssignmentId: input.origin.kind === "run" ? parentAssignmentId : null,
      parentOccurrenceId: input.origin.kind === "trigger" ? input.origin.occurrenceId : null,
      parentRunId: input.origin.kind === "run" ? input.origin.parentRunId : null,
      parentWatchActivationId: input.origin.kind === "watch" ? input.origin.activationId : null,
      parentThreadId: input.origin.parentThreadId,
      replyTarget: parentRunReplyTarget ? jsonValue(parentRunReplyTarget) : null,
      resultAttemptedAt: null,
      resultMessageId: null,
      resultReason: null,
      resultRunId: null,
      resultStatus: "pending",
      resultText: null,
      status: "open",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const assignmentEvents = await assignmentEventsInTransaction(
    transaction,
    delegationRow,
    "assignment.created",
  );
  const [assignedInput, assignedRun] = await Promise.all([
    transaction
      .selectFrom("threadInputs")
      .selectAll()
      .where("messageId", "=", queued.message.id)
      .executeTakeFirstOrThrow(),
    transaction
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", queued.run.id)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    assignment: await assignmentSummaryInTransaction(transaction, delegationRow),
    ...queued,
    command: queued.command,
    events: [...(threadEvent ? [threadEvent] : []), ...queued.events, ...assignmentEvents],
    input: threadInputFromRow(assignedInput),
    run: runFromRow(assignedRun),
    thread,
  };
}

/** Work delegated from Voice belongs in the person's task list. */
async function delegationListsThread(
  transaction: Transaction<DatabaseSchema>,
  parentPurpose: string,
  origin: DelegateThreadRequest["origin"],
): Promise<boolean> {
  if (parentPurpose !== "voice" || origin.kind !== "run") return false;
  const seed = await transaction
    .selectFrom("runs")
    .innerJoin("messages", "messages.id", "runs.seedInputId")
    .select(["messages.author", "runs.voiceSessionId"])
    .where("runs.id", "=", origin.parentRunId)
    .executeTakeFirstOrThrow();
  return seed.voiceSessionId !== null || MessageAuthorSchema.parse(seed.author).kind === "human";
}

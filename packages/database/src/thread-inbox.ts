import { z } from "zod";
import { isPlaceContentPart } from "@opensteer/core";
import { lockRunProjectionRows, lockThreadProjectionParents } from "./run-projection-locks.js";
import { recordIncludedBrowserPages } from "./browser-session-store.js";
import { withDatabaseTransaction } from "./connection.js";
import { executionEnvironmentIsAvailableToUser } from "./execution-authority.js";
import { prepareThreadInsertion } from "./thread-insertion.js";
import { projectThreadState } from "./thread-status.js";
import { createHash } from "node:crypto";
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
  agentDelegationMaxDepth,
  causalChainMaxDelegations,
  causalChainMaxAutonomousRuns,
  createId,
  moveQueueItem,
  threadReportMaxPendingEntries,
  threadReportMaxPendingSerializedBytes,
  threadReportBatchMaxEntries,
  threadReportBatchMaxSerializedBytes,
  threadInputMaxPendingEntries,
  threadInputMaxPendingSerializedBytes,
  workspaceWakesOnDemand,
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
  type WorkspaceId,
} from "@opensteer/core";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import {
  runExecuteInputsMax,
  runHistoryMaxMessages,
  runHistoryMaxSerializedBytes,
} from "@opensteer/protocol";
import type { CommandRow, DatabaseSchema, RunRow, ThreadInputTable, ThreadRow } from "./schema.js";
import {
  messageFromRow,
  runFromRow,
  threadFromRow,
  threadPendingRequestsSelection,
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
  lockWorkspaceRow,
  principalIdForUser,
  requireActiveWorkspaceMembership,
  requireBoundedIdentity,
  requireExecutionEnvironmentAccess,
  safeCount,
  safeGeneration,
  systemPrincipalId,
  threadExecutionIsAvailableToUser,
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
import { appendHostWorkspaceEvent } from "./workspace-events.js";
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

/**
 * The durable Thread Inbox is the sole scheduler for new model input. It owns
 * admission, fixed-batch claiming, active-Run steering, causal budgets, and
 * delegation completion. Harnesses receive only references to this state.
 */

export async function readThreadInputQueue(
  transaction: Transaction<DatabaseSchema>,
  request: {
    readonly threadId: ThreadId;
    readonly requestedBy: UserId;
  },
): Promise<ThreadInputQueue> {
  const observed = await transaction
    .selectFrom("threads")
    .select("workspaceId")
    .where("id", "=", request.threadId)
    .executeTakeFirst();
  if (!observed) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
  await lockWorkspaceRow(transaction, observed.workspaceId);
  await lockThreadRow(transaction, request.threadId);
  const membership = await requireActiveWorkspaceMembership(
    transaction,
    observed.workspaceId,
    request.requestedBy,
  );
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", request.threadId)
    .executeTakeFirstOrThrow();
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
    safeGeneration(active.membershipGeneration) === safeGeneration(membership.generation) &&
    (await steerRoute(transaction, active.id)) !== null &&
    (await threadExecutionIsAvailableToUser(
      transaction,
      thread.id,
      request.requestedBy,
      safeGeneration(membership.generation),
    ));
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
      const own =
        row.requestedBy === request.requestedBy &&
        row.authoritySource.kind === "workspace-membership";
      return {
        message: messageFromRow(message),
        input: threadInputFromRow(row),
        canCancel: own && thread.status !== "archived",
        canMove: own && thread.status !== "archived",
        canSteer: Boolean(
          steerable &&
          own &&
          safeGeneration(row.membershipGeneration) === safeGeneration(membership.generation) &&
          isDeepStrictEqual(row.replyTarget, active.replyTarget),
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
const personAuthoritySourceKinds = ["workspace-membership", "channel-ingress"] as const;

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

/**
 * A person's messages in a conversation from the exchange a Run answers:
 * theirs, under the Run's membership, written where it answers them, and for
 * the same Assignment.
 */
function exchangeInputs(
  transaction: Transaction<DatabaseSchema>,
  run: Pick<RunRow, "assignmentId" | "membershipGeneration" | "replyTarget" | "requestedBy">,
  threadId: ThreadId,
  state: "claimed" | "pending",
) {
  return transaction
    .selectFrom("threadInputs")
    .where("threadInputs.threadId", "=", threadId)
    .where("threadInputs.policy", "=", "queue")
    .where("threadInputs.state", "=", state)
    .where("threadInputs.requestedBy", "=", run.requestedBy)
    .where("threadInputs.membershipGeneration", "=", run.membershipGeneration)
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
  run: Pick<RunRow, "assignmentId" | "membershipGeneration" | "replyTarget" | "requestedBy">,
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
): Promise<{ readonly claimed: number; readonly events: readonly AgentEvent[] }> {
  const waiting = await conversationFollowUps(transaction, run, thread.id)
    .select("threadInputs.messageId")
    .orderBy("threadInputs.queueRank", "asc")
    .limit(input.limit)
    .execute();
  if (waiting.length === 0) return { claimed: 0, events: [] };
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
      .set({ runId: run.id, state: "claimed", steerCommandId, updatedAt: new Date() })
      .where("messageId", "=", messageId)
      .where("state", "=", "pending")
      .returningAll()
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("messages")
      .set({ runId: run.id })
      .where("id", "=", messageId)
      .execute();
    events.push(
      await placeQueuedMessage(transaction, thread, messageId, run.id),
      await inputUpdatedEvent(transaction, thread, taken),
    );
    claimed += 1;
  }
  return { claimed, events };
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
 * The caller holds the Run, its Workspace and the Thread (`lockThreadRow`
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
  const none = { events: [], revokedGrants: [] };
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
    thread.role !== "conversation" ||
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
  if (
    !(await threadExecutionIsAvailableToUser(
      transaction,
      thread.id,
      run.requestedBy,
      safeGeneration(run.membershipGeneration),
    ))
  )
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
  return { events: claimed.events, revokedGrants };
}

async function inputUpdatedEvent(
  transaction: Transaction<DatabaseSchema>,
  thread: Pick<ThreadRow, "environmentId" | "id" | "workspaceId">,
  row: Selectable<ThreadInputTable>,
): Promise<AgentEvent> {
  return appendHostWorkspaceEvent(transaction, {
    data: { input: threadInputFromRow(row) },
    environmentId: thread.environmentId,
    runId: row.runId,
    threadId: thread.id,
    type: "thread-input.updated",
    workspaceId: thread.workspaceId,
  });
}

/** Whether the person stopped this Run themselves, rather than a deadline or a cancelled task. */
async function runStoppedByPerson(
  transaction: Transaction<DatabaseSchema>,
  runId: RunId,
): Promise<boolean> {
  return (
    (await transaction
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", runId)
      .where("type", "=", "run.interrupt")
      .where(sql<string>`authority_source->>'kind'`, "=", "workspace-membership")
      .limit(1)
      .executeTakeFirst()) !== undefined
  );
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
  const thread = await transaction
    .selectFrom("threads")
    .select("role")
    .where("id", "=", input.threadId)
    .executeTakeFirstOrThrow();
  return thread.role === "conversation" && (await runStoppedByPerson(transaction, input.runId));
}

/**
 * The person stopped the conversation's reply: the follow-ups they had sent
 * for it that it has not taken end with it, and say so. A hand-off already on
 * its way to the Runner keeps its receipt; one a refusal later returns is
 * settled the same way (`endsWithStoppedReply`). Anything sent after this
 * commits is the next reply's. The caller holds the Run, Workspace, Thread and
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
  if (thread.role !== "conversation") return [];
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
        lastError: jsonValue({ message: "The reply was stopped before this message reached it" }),
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
        .set({ cancelReason: "stopped", state: "cancelled", updatedAt: now })
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
      .set({ cancelReason: "stopped", state: "cancelled", updatedAt: now })
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
  const observed = await transaction
    .selectFrom("threads")
    .select("workspaceId")
    .where("id", "=", request.threadId)
    .executeTakeFirstOrThrow();
  await lockWorkspaceRow(transaction, observed.workspaceId);
  await lockThreadRow(transaction, request.threadId);
  const membership = await requireActiveWorkspaceMembership(
    transaction,
    observed.workspaceId,
    request.requestedBy,
  );
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
  if (
    !row ||
    row.requestedBy !== request.requestedBy ||
    row.authoritySource.kind !== "workspace-membership"
  )
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
    safeGeneration(run.membershipGeneration) !== safeGeneration(membership.generation) ||
    safeGeneration(row.membershipGeneration) !== safeGeneration(membership.generation) ||
    !isDeepStrictEqual(run.replyTarget, row.replyTarget) ||
    !(await threadExecutionIsAvailableToUser(
      transaction,
      thread.id,
      request.requestedBy,
      safeGeneration(membership.generation),
    ))
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
  if (placeFailure) throw new OpensteerError({ code: "conflict", message: placeFailure });

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
    .set({ runId: run.id })
    .where("id", "=", row.messageId)
    .execute();
  const placed = await placeQueuedMessage(transaction, thread, row.messageId, run.id);
  const event = await appendHostWorkspaceEvent(transaction, {
    data: { input: threadInputFromRow(promoted) },
    environmentId: run.environmentId,
    runId: run.id,
    threadId: thread.id,
    type: "thread-input.updated",
    workspaceId: thread.workspaceId,
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
    .select("workspaceId")
    .where("id", "=", request.threadId)
    .executeTakeFirst();
  if (!observed) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
  await lockWorkspaceRow(transaction, observed.workspaceId);
  await lockThreadRow(transaction, request.threadId);
  await requireActiveWorkspaceMembership(transaction, observed.workspaceId, request.requestedBy);
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
  if (
    !row ||
    row.requestedBy !== request.requestedBy ||
    row.authoritySource.kind !== "workspace-membership"
  )
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
    return { events: [], wasDuplicate: true };
  }
  if (thread.status === "archived")
    throw new OpensteerError({ code: "conflict", message: "Archived threads cannot run" });
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
      .set({ queueRank: rank, updatedAt: new Date() })
      .where("messageId", "=", input.messageId)
      .execute();
  }
  const event = await appendHostWorkspaceEvent(transaction, {
    data: { paused: thread.inputQueuePaused },
    environmentId: thread.environmentId,
    runId: null,
    threadId: thread.id,
    type: "thread.input-queue-updated",
    workspaceId: thread.workspaceId,
  });
  return { events: [event], wasDuplicate: false };
}

/**
 * Withdrawal retires the queue entry and keeps the Message in the durable
 * ledger: a person takes back what they said before a Run hears it, they do
 * not unsay it. The workspace snapshot omits the Message so a reconnecting
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
    .select("workspaceId")
    .where("id", "=", request.threadId)
    .executeTakeFirst();
  if (!observed) throw new OpensteerError({ code: "not_found", message: "Thread not found" });
  await lockWorkspaceRow(transaction, observed.workspaceId);
  await lockThreadRow(transaction, request.threadId);
  await requireActiveWorkspaceMembership(transaction, observed.workspaceId, request.requestedBy);
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
  if (
    !row ||
    row.requestedBy !== request.requestedBy ||
    row.authoritySource.kind !== "workspace-membership"
  )
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
    return { events: [], input: threadInputFromRow(row), wasDuplicate: true };
  }
  if (thread.status === "archived")
    throw new OpensteerError({ code: "conflict", message: "Archived threads cannot run" });
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
    .set({ cancelReason: "withdrawn", state: "cancelled", updatedAt: new Date() })
    .where("messageId", "=", row.messageId)
    .returningAll()
    .executeTakeFirstOrThrow();
  const input = threadInputFromRow(cancelled);
  const event = await appendHostWorkspaceEvent(transaction, {
    data: { input },
    environmentId: thread.environmentId,
    runId: null,
    threadId: thread.id,
    type: "thread-input.updated",
    workspaceId: thread.workspaceId,
  });
  return { events: [event], input, wasDuplicate: false };
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
    throw new OpensteerError({ code: "conflict", message: "The Thread work queue is paused" });
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
    .where("threadInputs.membershipGeneration", "=", run.membershipGeneration)
    .where(
      sql<boolean>`thread_inputs.reply_target is not distinct from ${run.replyTarget === null ? null : JSON.stringify(run.replyTarget)}::jsonb`,
    )
    .where("messages.sequence", "<=", throughSequence);
  const total = await eligible
    .select(({ fn }) => fn.countAll<string>().as("count"))
    .executeTakeFirstOrThrow();
  const events: AgentEvent[] = [];
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
            await appendHostWorkspaceEvent(transaction, {
              data: { input: threadInputFromRow(cancelled) },
              environmentId: thread.environmentId,
              runId: cancelled.runId,
              threadId: thread.id,
              type: "thread-input.updated",
              workspaceId: thread.workspaceId,
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
    .set({ runId, state: "claimed", updatedAt: now })
    .where("messageId", "in", selected)
    .where("state", "in", ["pending", "unknown"])
    .returningAll()
    .execute();
  if (claimed.length !== selected.length)
    throw new OpensteerError({ code: "conflict", message: "Run context changed while claiming" });
  await transaction.updateTable("messages").set({ runId }).where("id", "in", selected).execute();
  let initialContext: {
    readonly messageIds: readonly MessageId[];
    readonly omittedCount: number;
    readonly throughSequence: string | null;
  } | null = null;
  if (run.providerSessionId) {
    const priorAccepted = await transaction
      .selectFrom("runs")
      .select("id")
      .where("providerSessionId", "=", run.providerSessionId)
      .where("id", "!=", run.id)
      .where("startedAt", "is not", null)
      .limit(1)
      .executeTakeFirst();
    if (!priorAccepted) {
      const seedMessage = await transaction
        .selectFrom("messages")
        .select("sequence")
        .where("id", "=", seed.messageId)
        .executeTakeFirstOrThrow();
      const history = transaction
        .selectFrom("messages")
        .leftJoin("threadInputs", "threadInputs.messageId", "messages.id")
        .where("messages.threadId", "=", run.threadId)
        .where("messages.sequence", "<", seedMessage.sequence)
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
      await appendHostWorkspaceEvent(transaction, {
        data: { input: threadInputFromRow(row) },
        environmentId: thread.environmentId,
        runId,
        threadId: run.threadId,
        type: "thread-input.updated",
        workspaceId: thread.workspaceId,
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
  if (thread.role !== "conversation" || capacity <= 0) return [];
  return (await claimFollowUps(transaction, run, thread, { limit: capacity })).events;
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
  const observed = await transaction
    .selectFrom("threads")
    .select("workspaceId")
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  await lockWorkspaceRow(transaction, observed.workspaceId);
  await lockThreadRow(transaction, threadId);
  await lockRunProjectionRows(transaction, { runIds: [], threadIds: [threadId] });
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  if (thread.role !== "conversation" || !thread.inputQueuePaused) return [];
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
        isPersonsMessage({ authoritySource: row.authoritySource, policy: "queue" })
          ? { cancelReason: "stopped", state: "cancelled", updatedAt: now }
          : { policy: "report", updatedAt: now },
      )
      .where("messageId", "=", row.messageId)
      .where("state", "=", "pending")
      .returningAll()
      .executeTakeFirstOrThrow();
    events.push(await inputUpdatedEvent(transaction, thread, settled));
  }
  await transaction
    .updateTable("threads")
    .set({ inputQueuePaused: false, inputQueuePausedBy: null, updatedAt: now })
    .where("id", "=", threadId)
    .execute();
  events.push(
    await appendHostWorkspaceEvent(transaction, {
      data: { paused: false },
      environmentId: thread.environmentId,
      runId: null,
      threadId,
      type: "thread.input-queue-updated",
      workspaceId: thread.workspaceId,
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
      "threads.role",
      "threads.workspaceId",
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
  await lockWorkspaceRow(transaction, observed.workspaceId);
  const channelAuthorityCurrent = await channelInputAuthorityIsCurrent(
    transaction,
    observed.messageId,
  );
  await lockThreadRow(transaction, observed.threadId);
  // A refusal can return the hand-offs behind this one as well.
  await lockRunProjectionRows(transaction, { runIds: [run.id], threadIds: [observed.threadId] });
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
          ? { cancelReason: "stopped", state: "cancelled", updatedAt: now }
          : outcome === "failed"
            ? observed.policy === "queue"
              ? {
                  cancelReason: null,
                  state: "pending",
                  runId: null,
                  steerCommandId: null,
                  updatedAt: now,
                }
              : { cancelReason: "steer-refused", state: "cancelled", updatedAt: now }
            : { state: "unknown", updatedAt: now },
    )
    .where("messageId", "=", observed.messageId)
    .where("state", "=", "claimed")
    .returningAll()
    .executeTakeFirst();
  if (!inputRow) return [];
  if (inputRow.state === "pending") {
    await transaction
      .updateTable("messages")
      .set({ runId: null })
      .where("id", "=", inputRow.messageId)
      .execute();
  }
  const input = threadInputFromRow(inputRow);
  const events: AgentEvent[] = [
    await appendHostWorkspaceEvent(transaction, {
      data: { input },
      environmentId: observed.environmentId,
      runId: input.runId,
      threadId: observed.threadId,
      type: "thread-input.updated",
      workspaceId: observed.workspaceId,
    }),
  ];
  if (
    inputRow.state === "pending" &&
    observed.role === "conversation" &&
    isPersonsMessage(observed)
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
  thread: Pick<ThreadRow, "environmentId" | "workspaceId"> & { readonly threadId: ThreadId },
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
      lastError: jsonValue({ message: "A message sent before this one was not delivered" }),
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
  await transaction.updateTable("messages").set({ runId: null }).where("id", "in", ids).execute();
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
            workspaceId: thread.workspaceId,
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
          ? { deliveredAt: now, state: "delivered", updatedAt: now }
          : stopped
            ? { cancelReason: "stopped", state: "cancelled", updatedAt: now }
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
                : { state: "unknown", updatedAt: now }
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
        .set({ runId: null })
        .where("id", "=", row.messageId)
        .execute();
    }
    const thread = await transaction
      .selectFrom("threads")
      .select(["environmentId", "workspaceId"])
      .where("id", "=", row.threadId)
      .executeTakeFirstOrThrow();
    events.push(
      await appendHostWorkspaceEvent(transaction, {
        data: { input: threadInputFromRow(row) },
        environmentId: thread.environmentId,
        runId,
        threadId: row.threadId,
        type: "thread-input.updated",
        workspaceId: thread.workspaceId,
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
  },
): Promise<{
  readonly executionValid: boolean;
  readonly membershipGeneration: number;
  readonly prelockedActiveRunId: RunId | null;
  readonly thread: ThreadRow;
}> {
  const observedThread = await transaction
    .selectFrom("threads")
    .select("workspaceId")
    .where("id", "=", input.threadId)
    .executeTakeFirst();
  if (!observedThread) {
    throw new OpensteerError({ code: "not_found", message: "Thread not found" });
  }
  const [observedActive, sourceRun] = await Promise.all([
    transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .select(["runs.id", "threads.workspaceId"])
      .where("runs.threadId", "=", input.threadId)
      .where("runs.status", "=", "running")
      .executeTakeFirst(),
    input.source.kind === "agent" || input.source.kind === "platform"
      ? transaction
          .selectFrom("runs")
          .innerJoin("threads", "threads.id", "runs.threadId")
          .select(["runs.id", "runs.membershipGeneration", "threads.workspaceId"])
          .where(
            "runs.id",
            "=",
            input.source.kind === "agent" ? input.source.runId : input.source.sourceRunId,
          )
          .executeTakeFirst()
      : null,
  ]);
  if ((input.source.kind === "agent" || input.source.kind === "platform") && !sourceRun) {
    throw new OpensteerError({ code: "forbidden", message: "Source Run is invalid" });
  }
  const runIds = [
    ...new Set([observedActive?.id, sourceRun?.id].filter(Boolean)),
  ].sort() as RunId[];
  if (runIds.length > 0) {
    await transaction
      .selectFrom("runs")
      .select("id")
      .where("id", "in", runIds)
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
  }
  if (input.source.kind === "trigger") {
    await transaction
      .selectFrom("triggerOccurrences")
      .select("id")
      .where("id", "=", input.source.occurrenceId)
      .forNoKeyUpdate()
      .executeTakeFirst();
  }
  const workspaceIds = [
    ...new Set(
      [observedThread.workspaceId, observedActive?.workspaceId, sourceRun?.workspaceId].filter(
        Boolean,
      ),
    ),
  ].sort() as WorkspaceId[];
  const lockedWorkspaces = await transaction
    .selectFrom("workspaces")
    .select(["id", "status"])
    .where("id", "in", workspaceIds)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  const workspace = lockedWorkspaces.find(({ id }) => id === observedThread.workspaceId);
  if (!workspace) throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
  const membership = await transaction
    .selectFrom("workspaceMemberships")
    .select(["generation", "state"])
    .where("workspaceId", "=", observedThread.workspaceId)
    .where("userId", "=", input.requestedBy)
    .forNoKeyUpdate()
    .executeTakeFirst();
  await lockThreadChannelAuthorities(transaction, [input.threadId]);
  const thread = await transaction
    .selectFrom("threads")
    .selectAll()
    .where("id", "=", input.threadId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!thread || thread.workspaceId !== observedThread.workspaceId) {
    throw new OpensteerError({
      code: "conflict",
      message: "Thread execution binding changed while the input was being created",
    });
  }
  if (input.source.kind === "watch") {
    await transaction
      .selectFrom("triggerWatchActivations")
      .select("id")
      .where("id", "=", input.source.activationId)
      .forNoKeyUpdate()
      .executeTakeFirst();
  }
  const isPlatformCompletion = input.source.kind === "platform";
  if (thread.doneAt && input.policy !== "report") {
    throw new OpensteerError({ code: "conflict", message: "This task is Done. Reopen it first." });
  }
  if (
    input.policy !== "report" &&
    !workspaceWakesOnDemand(workspace.status) &&
    workspace.status !== "ready" &&
    !(isPlatformCompletion && ["failed", "deleting", "deleted"].includes(workspace.status))
  ) {
    throw new OpensteerError({
      code: "conflict",
      message: "Workspace filesystem is not ready",
      retryable: workspace.status === "provisioning" || workspace.status === "unavailable",
    });
  }
  if ((!membership || membership.state !== "active") && !isPlatformCompletion) {
    throw new OpensteerError({
      code: "forbidden",
      message: "An active Workspace membership is required to start a Run",
    });
  }
  // The Thread and membership are already fenced above. Reuse their state,
  // and check environment ownership once for both admission and refusal.
  const executionEligible =
    input.policy !== "report" &&
    thread.status !== "archived" &&
    (workspace.status === "ready" || workspaceWakesOnDemand(workspace.status)) &&
    membership?.state === "active";
  const environmentAvailable =
    !isPlatformCompletion || executionEligible
      ? await executionEnvironmentIsAvailableToUser(
          transaction,
          thread.environmentId,
          input.requestedBy,
        )
      : false;
  const executionValid =
    input.policy === "report"
      ? membership?.state === "active"
      : executionEligible && environmentAvailable;
  if (!isPlatformCompletion && !environmentAvailable) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Only the execution owner can send input to this Thread",
    });
  }
  return {
    executionValid,
    membershipGeneration: membership
      ? safeGeneration(membership.generation)
      : safeGeneration(sourceRun!.membershipGeneration),
    prelockedActiveRunId: observedActive?.id ?? null,
    thread,
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
}

/** Caller holds the prefix in ./lock-order.ts, serializing admission and membership changes. */
async function cancelStaleReportMemberships(
  transaction: Transaction<DatabaseSchema>,
  thread: ThreadRow,
): Promise<AgentEvent[]> {
  const cancelled = await transaction
    .updateTable("threadInputs")
    .set({ cancelReason: "membership-changed", state: "cancelled", updatedAt: new Date() })
    .where("threadId", "=", thread.id)
    .where("policy", "=", "report")
    .where("state", "in", ["pending", "unknown"])
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("workspaceMemberships")
            .select("id")
            .where("workspaceId", "=", thread.workspaceId)
            .whereRef("userId", "=", "threadInputs.requestedBy")
            .whereRef("generation", "=", "threadInputs.membershipGeneration")
            .where("state", "=", "active"),
        ),
      ),
    )
    .returningAll()
    .execute();
  const events: AgentEvent[] = [];
  for (const row of cancelled) {
    events.push(
      await appendHostWorkspaceEvent(transaction, {
        data: { input: threadInputFromRow(row) },
        environmentId: thread.environmentId,
        runId: row.runId,
        threadId: thread.id,
        type: "thread-input.updated",
        workspaceId: thread.workspaceId,
      }),
    );
  }
  return events;
}

async function assertThreadInputCapacity(
  transaction: Transaction<DatabaseSchema>,
  threadId: ThreadId,
  contentBytes: number,
  policy: "report" | "queue" | "steer" = "queue",
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
      return { kind: "human" };
    case "agent":
      return { kind: "agent", runId: source.runId };
    case "trigger":
      return { kind: "trigger", occurrenceId: source.occurrenceId };
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
        ...(source.referenceId ? { referenceId: source.referenceId } : {}),
        sourceRunId: source.sourceRunId,
      };
    case "automation":
      return { kind: "automation", noticeId: source.noticeId, triggerId: source.triggerId };
  }
}

export async function enqueueThreadInputInTransaction(
  transaction: Transaction<DatabaseSchema>,
  request: EnqueueThreadInputRequest,
): Promise<EnqueuedThreadInput> {
  const content = ContentPartSchema.array().min(1).parse(request.content);
  if (
    request.source.kind === "agent" &&
    !request.forwardedPlaces &&
    content.some(isPlaceContentPart)
  ) {
    throw new OpensteerError({
      code: "bad_request",
      message: "An agent can forward place references only through delegation.",
    });
  }

  const policy = ThreadInputPolicySchema.parse(request.policy);
  requireBoundedIdentity(request.idempotencyKey, "Thread input idempotency key", 255);
  const requestFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        content,
        policy,
        source: normalizedThreadInputSource(request.source),
        threadId: request.threadId,
        ...(request.quotedMessageId ? { quotedMessageId: request.quotedMessageId } : {}),
      }),
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

  const { executionValid, membershipGeneration, prelockedActiveRunId, thread } =
    await lockThreadInputPreconditions(transaction, request);
  const messageId = createId("message");
  const facts = await resolveThreadInputFacts(transaction, {
    membershipGeneration,
    messageId,
    requestedBy: request.requestedBy,
    source: request.source,
    targetThread: thread,
  });
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
  if (sourceRun?.assignmentId) {
    const sourceAssignment = await transaction
      .selectFrom("delegations")
      .select("status")
      .where("id", "=", sourceRun.assignmentId)
      .executeTakeFirstOrThrow();
    if (sourceAssignment.status !== "open") {
      throw new OpensteerError({ code: "conflict", message: "Source Assignment is terminal" });
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
  const retiredReportEvents = await cancelStaleReportMemberships(transaction, thread);
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
    thread.role === "conversation" &&
    policy === "queue" &&
    (request.source.kind === "human" || request.source.kind === "channel");
  // A Run whose turn ended while its background work runs on takes the next
  // message from its own requester, on the same engine and model, as a new
  // turn; anything else waits behind it.
  const joinsBackground =
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
    safeGeneration(activeRun.membershipGeneration) === membershipGeneration &&
    isDeepStrictEqual(activeRun.replyTarget, facts.replyTarget)
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
    workspaceId: thread.workspaceId,
  });
  let steerCommand: CommandRow | null = null;
  if (steerRun && steerCommandId) {
    const payload =
      route === "native"
        ? ({ runId: steerRun.id, threadId: thread.id, type: "run.steer" } as const)
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
      assignmentId,
      actorPrincipalId: facts.actorPrincipalId,
      authoritySource: jsonValue(facts.authoritySource),
      cancelReason: executionValid ? null : "execution-authority-unavailable",
      causalChainId,
      deliveredAt: null,
      idempotencyKey: request.idempotencyKey,
      membershipGeneration,
      messageId,
      policy,
      queueRank: thread.nextMessageSequence,
      replyTarget: facts.replyTarget ? jsonValue(facts.replyTarget) : null,
      requestedBy: request.requestedBy,
      requestFingerprint,
      runId: steerRun?.id ?? null,
      state: executionValid ? (steer ? "claimed" : "pending") : "cancelled",
      steerCommandId,
      threadId: thread.id,
      updatedAt: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable("threads")
    .set({ nextMessageSequence: sql`next_message_sequence + 1`, updatedAt: new Date() })
    .where("id", "=", thread.id)
    .executeTakeFirstOrThrow();
  const message = messageFromRow(messageRow);
  const durableInput = threadInputFromRow(inputRow);
  const messageEvent = await appendHostWorkspaceEvent(transaction, {
    data: { input: durableInput, message },
    environmentId: thread.environmentId,
    runId: steerRun?.id ?? null,
    threadId: thread.id,
    type: "message.created",
    workspaceId: thread.workspaceId,
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
    return browserUsage.length > 0 ? { ...result, browserUsage } : result;
  };
  if (steerCommand && steerRun) {
    const revokedGrants =
      route === "restart" ? await supersedeForRestart(transaction, steerRun.id) : [];
    return credited({
      command: steerCommand,
      disposition: "steering",
      events: [...retiredReportEvents, messageEvent],
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
        events: [...retiredReportEvents, messageEvent, ...handed.events],
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
    events: [...retiredReportEvents, messageEvent, ...handed.events, ...(queued?.events ?? [])],
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
    readonly membershipGeneration: number;
    readonly messageId: MessageId;
    readonly requestedBy: UserId;
    readonly source: ThreadInputSource;
    readonly targetThread: ThreadRow;
  },
): Promise<ResolvedThreadInputFacts> {
  const { source } = input;
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
            .innerJoin("channelConversationContexts", (join) =>
              join
                .onRef("channelConversationContexts.conversationId", "=", "channelConversations.id")
                .on("channelConversationContexts.authorityUserId", "=", input.requestedBy),
            )
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
              "channelBindings.workspaceId as bindingWorkspaceId",
              "channelConversationContexts.activeThreadId as contextActiveThreadId",
              "channelConversationContexts.bindingRevision as contextBindingRevision",
              "channelConversations.conversationType",
              "channelConversations.externalConversationId",
              "channelConversations.id as conversationId",
              "channelConversations.workspaceId",
              "channelIdentities.externalUserId",
              "channelIdentities.id",
              "channelIdentities.linkedUserId",
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
              "channelConversationContexts",
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
        workspaceId: channelSource.bindingWorkspaceId,
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
        channelSource.workspaceId !== input.targetThread.workspaceId ||
        channelSource.bindingWorkspaceId !== input.targetThread.workspaceId ||
        channelSource.contextActiveThreadId !== input.targetThread.id ||
        !channelAuthority ||
        channelAuthority.userId !== input.requestedBy ||
        channelAuthority.membershipGeneration !== input.membershipGeneration)
    ) {
      throw new OpensteerError({ code: "forbidden", message: "Channel ingress source is invalid" });
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
    const replyTarget =
      source.kind === "channel"
        ? ReplyTargetSchema.parse({ conversationId: source.conversationId, kind: "channel" })
        : null;
    return {
      actorPrincipalId: principal.id,
      author: MessageAuthorSchema.parse({
        displayName: principal.displayName,
        kind: "human",
        principalId: principal.id,
        ...(principal.userId ? { userId: principal.userId } : {}),
      }),
      authoritySource:
        source.kind === "channel"
          ? {
              access: channelAuthority!.source,
              bindingId: channelSource!.bindingId,
              bindingRevision: channelSource!.contextBindingRevision,
              conversationId: replyTarget!.conversationId,
              ingressId: requireBoundedIdentity(source.ingressId, "Channel ingress", 255),
              kind: "channel-ingress",
              principalId: principal.id,
              userId: input.requestedBy,
            }
          : { kind: "workspace-membership", userId: input.requestedBy },
      causalChainId: null,
      kind: "input",
      replyTarget,
    };
  }

  if (source.kind === "agent") {
    const origin = await transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .innerJoin("workspaces", "workspaces.id", "threads.workspaceId")
      .innerJoin("users", "users.id", "runs.requestedBy")
      .select([
        "runs.actorPrincipalId",
        "runs.causalChainId",
        "runs.id as runId",
        "runs.requestedBy",
        "runs.status",
        "threads.id as threadId",
        "threads.title as threadTitle",
        "threads.workspaceId",
        "users.displayName as requesterName",
        "workspaces.homeThreadId",
        "workspaces.name as workspaceName",
      ])
      .where("runs.id", "=", source.runId)
      .executeTakeFirst();
    if (
      !origin ||
      origin.requestedBy !== input.requestedBy ||
      !["starting", "running", "waiting"].includes(origin.status)
    ) {
      throw new OpensteerError({ code: "forbidden", message: "Agent source Run is invalid" });
    }
    return {
      actorPrincipalId: origin.actorPrincipalId,
      author: MessageAuthorSchema.parse({
        // "Chat" names a conversation only to its owner. Anyone else reading
        // what it sent, such as a teammate in a shared Workspace, is told whose
        // assistant it was; the owner's own client still says Chat.
        displayName:
          origin.homeThreadId === origin.threadId
            ? `${origin.requesterName}’s Opensteer`
            : origin.threadTitle,
        kind: "agent",
        runId: origin.runId,
        threadId: origin.threadId,
        workspaceId: origin.workspaceId,
        workspaceName: origin.workspaceName,
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
      ])
      .where("triggerOccurrences.id", "=", source.occurrenceId)
      .forNoKeyUpdate("triggerOccurrences")
      .forNoKeyUpdate("triggers")
      .executeTakeFirst();
    if (!origin || origin.createdBy !== input.requestedBy || origin.status !== "running") {
      throw new OpensteerError({ code: "forbidden", message: "Trigger source is invalid" });
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
        .set({ causalChainId })
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
      throw new OpensteerError({ code: "forbidden", message: "Watch source is invalid" });
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
    if (
      !trigger ||
      trigger.createdBy !== input.requestedBy ||
      trigger.anchorThreadId !== input.targetThread.id
    ) {
      throw new OpensteerError({ code: "forbidden", message: "Automation source is invalid" });
    }
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
    throw new OpensteerError({ code: "forbidden", message: "Platform source Run is invalid" });
  }
  return {
    actorPrincipalId: systemPrincipalId,
    author: MessageAuthorSchema.parse({
      cause: source.cause,
      kind: "platform",
      ...(source.referenceId ? { referenceId: source.referenceId } : {}),
    }),
    authoritySource: {
      cause: source.cause,
      kind: "platform",
      ...(source.referenceId ? { referenceId: source.referenceId } : {}),
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
  thread: { readonly id: ThreadId; readonly harnessInstanceId: HarnessInstanceId },
): Promise<ProviderSessionId> {
  const selected = await transaction
    .selectFrom("providerSessions")
    .select(["id", "harnessInstanceId"])
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
    return selected.id;
  }
  const prior = await transaction
    .selectFrom("providerSessions")
    .select("id")
    .where("threadId", "=", thread.id)
    .limit(1)
    .executeTakeFirst();
  if (prior) {
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
  options: { readonly onInvalidSelection?: "throw" | "defer" } = {},
): Promise<{
  readonly command: CommandRow | null;
  readonly events: readonly AgentEvent[];
  readonly run: RunRow | null;
}> {
  const events: AgentEvent[] = [];
  if (thread.inputQueuePaused || thread.doneAt) return { command: null, events, run: null };
  const existing = await transaction
    .selectFrom("runs")
    .selectAll()
    .where("threadId", "=", thread.id)
    .where("status", "=", "queued")
    .executeTakeFirst();
  if (existing) return { command: null, events, run: existing };
  // Follow-ups remain inputs until their predecessor ends. They do not reserve
  // a Run, charge its budget, or freeze execution settings while waiting.
  const active = await transaction
    .selectFrom("runs")
    .select("id")
    .where("threadId", "=", thread.id)
    .where("status", "in", nonTerminalRunStatuses)
    .executeTakeFirst();
  if (active) return { command: null, events, run: null };
  const pending = await transaction
    .selectFrom("threadWorkInputs")
    .select("messageId")
    .where("threadId", "=", thread.id)
    .where("state", "=", "pending")
    .limit(1)
    .executeTakeFirst();
  if (!pending) return { command: null, events, run: null };
  const selected = await transaction
    .selectFrom("providerSessions")
    .select("harnessInstanceId")
    .where("threadId", "=", thread.id)
    .where("active", "=", true)
    .executeTakeFirst();
  if (selected && selected.harnessInstanceId !== thread.harnessInstanceId) {
    if (options.onInvalidSelection === "defer") return { command: null, events, run: null };
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
      if (options.onInvalidSelection === "defer") return { command: null, events, run: null };
      throw new OpensteerError({
        code: "conflict",
        message: "This Thread has no selected provider session; choose an AI engine to continue",
      });
    }
  }
  await lockRunProjectionRows(transaction, { runIds: [], threadIds: [thread.id] });
  let seed: (Selectable<ThreadInputTable> & { readonly messageKind: MessageKind }) | undefined;
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
    if (!candidate) return { command: null, events, run: null };

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
          await appendHostWorkspaceEvent(transaction, {
            data: { input: threadInputFromRow(cancelled) },
            environmentId: thread.environmentId,
            runId: null,
            threadId: thread.id,
            type: "thread-input.updated",
            workspaceId: thread.workspaceId,
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
            await appendHostWorkspaceEvent(transaction, {
              data: { input: threadInputFromRow(cancelled) },
              environmentId: thread.environmentId,
              runId: null,
              threadId: thread.id,
              type: "thread-input.updated",
              workspaceId: thread.workspaceId,
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
      safeGeneration(candidate.membershipGeneration),
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
        .where("membershipGeneration", "=", candidate.membershipGeneration)
        .where("state", "=", "pending")
        .where("policy", "=", "queue")
        .returningAll()
        .execute();
      for (const row of cancelled) {
        events.push(
          await appendHostWorkspaceEvent(transaction, {
            data: { input: threadInputFromRow(row) },
            environmentId: thread.environmentId,
            runId: null,
            threadId: thread.id,
            type: "thread-input.updated",
            workspaceId: thread.workspaceId,
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
        await appendHostWorkspaceEvent(transaction, {
          data: { input: threadInputFromRow(row) },
          environmentId: thread.environmentId,
          runId: null,
          threadId: thread.id,
          type: "thread-input.updated",
          workspaceId: thread.workspaceId,
        }),
      );
    }
  }
  if (!seed) return { command: null, events, run: null };
  const selectedSession = await ensureSelectedProviderSession(transaction, thread);
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
      membershipGeneration: seed.membershipGeneration,
      modelSelection: thread.modelSelection,
      providerSessionId: selectedSession,
      replyTarget: seed.replyTarget,
      requestedBy: seed.requestedBy,
      runOrdinal: thread.nextRunOrdinal,
      startedAt: null,
      status: "queued",
      threadId: thread.id,
      seedInputId: seed.messageId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const payload = { runId, threadId: thread.id, type: "run.execute" } as const;
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
    await appendHostWorkspaceEvent(transaction, {
      data: { run: threadRunQueueEntryFromRow(runRow) },
      environmentId: thread.environmentId,
      runId,
      threadId: thread.id,
      type: "run.queued",
      workspaceId: thread.workspaceId,
    }),
  );
  events.push(...(await projectThreadState(transaction, thread.id)));
  return { command, events, run: runRow };
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
  thread: Pick<ThreadRow, "environmentId" | "id" | "workspaceId">,
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
      .set({ sequence: nextMessageSequence })
      .where("id", "=", messageId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("threads")
      .set({ nextMessageSequence: sql`next_message_sequence + 1` })
      .where("id", "=", thread.id)
      .executeTakeFirstOrThrow();
  }
  return appendHostWorkspaceEvent(transaction, {
    data: { message: messageFromRow(placed) },
    environmentId: thread.environmentId,
    runId,
    threadId: thread.id,
    type: "message.placed",
    workspaceId: thread.workspaceId,
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

async function deliverAssignmentReturnTransaction(
  transaction: Transaction<DatabaseSchema>,
  assignmentId: AssignmentId,
): Promise<readonly AgentEvent[]> {
  const observed = await transaction
    .selectFrom("delegations")
    .innerJoin("threads as childThread", "childThread.id", "delegations.childThreadId")
    .innerJoin("threads as parentThread", "parentThread.id", "delegations.parentThreadId")
    .select([
      "delegations.childThreadId",
      "delegations.parentThreadId",
      "delegations.childRunId",
      "childThread.workspaceId as childWorkspaceId",
      "parentThread.workspaceId as parentWorkspaceId",
    ])
    .where("delegations.id", "=", assignmentId)
    .where("delegations.status", "!=", "open")
    .where("delegations.resultStatus", "=", "pending")
    .executeTakeFirst();
  if (!observed) return [];
  const workspaces = await transaction
    .selectFrom("workspaces")
    .select(["id", "status"])
    .where("id", "in", [...new Set([observed.childWorkspaceId, observed.parentWorkspaceId])])
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  await lockThreadChannelAuthorities(transaction, [
    observed.childThreadId,
    observed.parentThreadId,
  ]);
  await transaction
    .selectFrom("threads")
    .select("id")
    .where("id", "in", [observed.childThreadId, observed.parentThreadId])
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  await lockThreadProjectionParents(transaction, {
    threadIds: [observed.childThreadId, observed.parentThreadId],
    runIds: [observed.childRunId],
    assignmentIds: [assignmentId],
  });
  const assignment = await transaction
    .selectFrom("delegations")
    .selectAll()
    .where("id", "=", assignmentId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  if (assignment.status === "open" || assignment.resultStatus !== "pending") return [];
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
  const [membership, workerMembership] = await Promise.all(
    [parent.workspaceId, observed.childWorkspaceId].map((workspaceId) =>
      transaction
        .selectFrom("workspaceMemberships")
        .select(["generation", "state"])
        .where("workspaceId", "=", workspaceId)
        .where("userId", "=", requester.requestedBy)
        .executeTakeFirst(),
    ),
  );
  const parentWorkspace = workspaces.find(({ id }) => id === parent.workspaceId);
  // The work that asked for this result has ended; only its own Thread still
  // cares, and that Thread was told when its work was stopped.
  const parentAssignmentEnded =
    assignment.parentAssignmentId !== null &&
    parentOpenAssignment?.id !== assignment.parentAssignmentId;
  const executionValid =
    !parentAssignmentEnded &&
    // A result is the worker Workspace's content: whoever handed the work out
    // must still be able to read it there before it is copied anywhere else.
    // A stop carries none of it.
    (assignment.status === "cancelled" || workerMembership?.state === "active") &&
    parent.status !== "archived" &&
    !!parentWorkspace &&
    (parentWorkspace.status === "ready" || workspaceWakesOnDemand(parentWorkspace.status)) &&
    membership?.state === "active" &&
    (await threadExecutionIsAvailableToUser(
      transaction,
      parent.id,
      requester.requestedBy,
      safeGeneration(membership.generation),
    ));
  if (!executionValid || !membership) {
    const updated = await transaction
      .updateTable("delegations")
      .set((expression) => ({
        completedAt: new Date(),
        resultReason: parentAssignmentEnded
          ? "parent-assignment-terminal"
          : "execution-authority-unavailable",
        resultStatus: "undeliverable",
        revision: expression("revision", "+", 1),
        updatedAt: new Date(),
      }))
      .where("id", "=", assignmentId)
      .where("resultStatus", "=", "pending")
      .returningAll()
      .executeTakeFirstOrThrow();
    return assignmentEventsInTransaction(transaction, updated, "assignment.updated");
  }
  // A result is work for the parent's next turn; a cancellation is only
  // context, so it never starts a Run the parent did not ask for.
  const cancelled = assignment.status === "cancelled";
  const policy = cancelled || parent.doneAt ? "report" : "queue";
  const content = MessageContentSchema.parse([
    {
      text: [
        `Task ${assignment.status}: ${worker.title}`,
        `Task Thread: ${worker.id} · Assignment: ${assignment.id}`,
        ...(cancelled ? [] : ["", assignment.resultText]),
      ].join("\n"),
      type: "text",
    },
  ]);
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
      membershipGeneration: safeGeneration(membership.generation),
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
    .set({ nextMessageSequence: sql`next_message_sequence + 1`, updatedAt: new Date() })
    .where("id", "=", parent.id)
    .executeTakeFirstOrThrow();
  const updated = await transaction
    .updateTable("delegations")
    .set((expression) => ({
      completedAt: new Date(),
      resultMessageId: messageId,
      resultReason: null,
      resultStatus: "delivered",
      revision: expression("revision", "+", 1),
      updatedAt: new Date(),
    }))
    .where("id", "=", assignment.id)
    .where("resultStatus", "=", "pending")
    .returningAll()
    .executeTakeFirstOrThrow();
  const events: AgentEvent[] = [
    await appendHostWorkspaceEvent(transaction, {
      data: { input: threadInputFromRow(inputRow), message: messageFromRow(messageRow) },
      environmentId: parent.environmentId,
      runId: null,
      threadId: parent.id,
      type: "message.created",
      workspaceId: parent.workspaceId,
    }),
  ];
  if (policy === "queue") events.push(...(await ensureQueuedRun(transaction, parent)).events);
  events.push(...(await assignmentEventsInTransaction(transaction, updated, "assignment.updated")));
  return events;
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
    return await withDatabaseTransaction(database, (transaction) =>
      deliverAssignmentReturnTransaction(transaction, assignmentId),
    );
  } catch (error) {
    await database
      .updateTable("delegations")
      .set({ resultAttemptedAt: new Date() })
      .where("id", "=", assignmentId)
      .where("resultStatus", "=", "pending")
      .execute();
    if (error instanceof OpensteerError && error.code === "resource_exhausted") return [];
    throw error;
  }
}

export interface AssignmentReturnDrain {
  readonly events: readonly AgentEvent[];
  readonly failures: readonly { readonly assignmentId: AssignmentId; readonly error: unknown }[];
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
  const failures: { readonly assignmentId: AssignmentId; readonly error: unknown }[] = [];
  for (const candidate of candidates) {
    try {
      events.push(...(await drainAssignmentReturn(database, candidate.id)));
    } catch (error) {
      failures.push({ assignmentId: candidate.id, error });
    }
  }
  return { events, failures };
}

function canonicalDelegateThreadRequest(
  input: DelegateThreadRequest,
): Readonly<Record<string, unknown>> {
  return {
    ...(input.callerIntent ? { callerIntent: input.callerIntent } : {}),
    accessMode: input.accessMode,
    createdBy: input.createdBy,
    environmentId: input.environmentId,
    harnessInstanceId: input.harnessInstanceId,
    idempotencyKey: input.idempotencyKey,
    modelSelection: input.modelSelection,
    origin: input.origin,
    task: input.task,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    title: input.title,
    ...(input.icon ? { icon: input.icon } : {}),
    ...(input.titleSource && input.titleSource !== "chosen"
      ? { titleSource: input.titleSource }
      : {}),
    type: "thread.delegate",
    workspaceId: input.workspaceId,
  };
}

async function assertDelegationDepth(
  transaction: Transaction<DatabaseSchema>,
  parentThreadId: ThreadId,
): Promise<void> {
  let currentId: ThreadId | null = parentThreadId;
  const visited = new Set<ThreadId>();
  let childDepth = 0;
  while (currentId) {
    if (visited.has(currentId)) {
      throw new OpensteerError({ code: "internal", message: "Thread lineage contains a cycle" });
    }
    visited.add(currentId);
    childDepth += 1;
    if (childDepth > agentDelegationMaxDepth) {
      throw new OpensteerError({
        code: "conflict",
        details: { maxDelegationDepth: agentDelegationMaxDepth },
        message: `Agent delegation cannot exceed ${agentDelegationMaxDepth} parent-child levels`,
      });
    }
    const current: { readonly parentThreadId: ThreadId | null } | undefined = await transaction
      .selectFrom("threads")
      .select("parentThreadId")
      .where("id", "=", currentId)
      .executeTakeFirst();
    if (!current) {
      throw new OpensteerError({ code: "internal", message: "Thread lineage is incomplete" });
    }
    currentId = current.parentThreadId;
  }
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
  callerIntent: z.object({ requestId: z.string(), requestFingerprint: z.string() }).optional(),
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
  let receipt: { readonly requestFingerprint: string } | undefined;
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
  if (input.threadId && input.icon !== undefined) {
    throw new OpensteerError({
      code: "bad_request",
      message: "An icon can be chosen only for a new Thread",
    });
  }

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
  if (input.threadId && input.icon !== undefined) {
    throw new OpensteerError({
      code: "bad_request",
      message: "An icon can be chosen only for a new Thread",
    });
  }

  const task = ContentPartSchema.array().min(1).parse(input.task);
  const request = { ...input, task };
  const requestPayload = canonicalDelegateThreadRequest(request);
  await lockDelegationIdempotency(transaction, input);
  const existing = await replayDelegatedThread(transaction, request, requestPayload);
  if (existing) return existing;

  // Observe the parent before taking locks so cross-Workspace delegation can
  // acquire every Workspace lock in one global order. The row is re-read under
  // lock after the Workspaces are locked; this first read grants no authority.
  const observedParent = await transaction
    .selectFrom("threads")
    .select(["id", "workspaceId"])
    .where("id", "=", input.origin.parentThreadId)
    .executeTakeFirst();
  if (!observedParent) {
    throw new OpensteerError({ code: "not_found", message: "Parent Thread not found" });
  }
  const observedTarget = input.threadId
    ? await transaction
        .selectFrom("threads")
        .select([
          "id",
          "workspaceId",
          "environmentId",
          "harnessInstanceId",
          "modelSelection",
          "role",
          "status",
          "inputQueuePaused",
        ])
        .where("id", "=", input.threadId)
        .executeTakeFirst()
    : null;
  if (input.threadId && !observedTarget) {
    throw new OpensteerError({ code: "not_found", message: "Target work Thread not found" });
  }
  if (
    observedTarget &&
    (observedTarget.id === input.origin.parentThreadId ||
      observedTarget.workspaceId !== input.workspaceId ||
      observedTarget.environmentId !== input.environmentId ||
      observedTarget.harnessInstanceId !== input.harnessInstanceId ||
      !isDeepStrictEqual(observedTarget.modelSelection, input.modelSelection) ||
      observedTarget.role !== "work" ||
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
  let parentWorkspaceId = observedParent.workspaceId;
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
        "threads.workspaceId",
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
      throw new OpensteerError({ code: "forbidden", message: "Parent Run is invalid" });
    }
    parentRunReplyTarget = parentRun.replyTarget
      ? ReplyTargetSchema.parse(parentRun.replyTarget)
      : null;
    parentAssignmentId = parentRun.assignmentId;
    parentCausalChainId = parentRun.causalChainId;
    parentWorkspaceId = parentRun.workspaceId;
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
      throw new OpensteerError({ code: "forbidden", message: "Parent Trigger is invalid" });
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
        .set({ causalChainId: parentCausalChainId })
        .where("id", "=", input.origin.occurrenceId)
        .where("causalChainId", "is", null)
        .executeTakeFirstOrThrow();
    }
  }
  const workspaceIds = [...new Set([input.workspaceId, parentWorkspaceId])].sort();
  const workspaces = await transaction
    .selectFrom("workspaces")
    .select(["id", "status"])
    .where("id", "in", workspaceIds)
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  const workspace = workspaces.find(({ id }) => id === input.workspaceId);
  if (!workspace) throw new OpensteerError({ code: "not_found", message: "Workspace not found" });
  if (workspace.status !== "ready") {
    throw new OpensteerError({
      code: "conflict",
      message: "Workspace filesystem is not ready",
      retryable: workspace.status === "provisioning" || workspace.status === "unavailable",
    });
  }
  const membership = await transaction
    .selectFrom("workspaceMemberships")
    .select("state")
    .where("workspaceId", "=", input.workspaceId)
    .where("userId", "=", input.createdBy)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!membership || membership.state !== "active") {
    throw new OpensteerError({
      code: "forbidden",
      message: "Delegated Thread creator must be an active Workspace member",
    });
  }
  const insertThread = await prepareThreadInsertion(transaction, {
    createdBy: input.createdBy,
    environmentId: input.environmentId,
    harnessInstanceId: input.harnessInstanceId,
  });
  await lockThreadChannelAuthorities(transaction, [
    input.origin.parentThreadId,
    ...(input.threadId ? [input.threadId] : []),
  ]);
  const lockedThreads = await transaction
    .selectFrom("threads")
    .select(["id", "lineageRootThreadId", "role", "workspaceId", "doneAt"])
    .where("id", "in", [input.origin.parentThreadId, ...(input.threadId ? [input.threadId] : [])])
    .orderBy("id", "asc")
    .forNoKeyUpdate()
    .execute();
  if (input.threadId && lockedThreads.find(({ id }) => id === input.threadId)?.doneAt) {
    throw new OpensteerError({ code: "conflict", message: "This task is Done. Reopen it first." });
  }
  const parent = lockedThreads.find(({ id }) => id === input.origin.parentThreadId);
  if (!parent || parent.workspaceId !== parentWorkspaceId) {
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
        "triggers.workspaceId",
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
      activation.currentRevisionId !== input.origin.revisionId ||
      activation.workspaceId !== parent.workspaceId
    ) {
      throw new OpensteerError({ code: "forbidden", message: "Parent Watch is invalid" });
    }
    parentCausalChainId = await watchObservationCausalChain(
      transaction,
      input.origin.activationId,
      input.origin.observationId,
    );
  }

  await requireActiveWorkspaceMembership(transaction, parent.workspaceId, input.createdBy);
  await assertDelegationDepth(transaction, parent.id);
  if (!parentCausalChainId) {
    throw new OpensteerError({ code: "internal", message: "Delegation has no causal chain" });
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
      throw new OpensteerError({ code: "conflict", message: "Parent Assignment is terminal" });
    }
  }
  const delegationBudget = await transaction
    .updateTable("causalChains")
    .set((expression) => ({ usedDelegations: expression("usedDelegations", "+", 1) }))
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
        details: { assignmentId: open.id },
        message: `Thread ${threadId} is still working on task ${open.id}. Send corrections with thread_message, or cancel that task with assignment_cancel before giving the Thread new work.`,
      });
    }
    if (busy || queuedInput) {
      throw new OpensteerError({ code: "conflict", message: "Target work Thread is still busy" });
    }
  }
  const reusedRow = input.threadId
    ? await transaction
        .selectFrom("threads")
        .selectAll()
        .where("id", "=", threadId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow()
    : null;
  // Work a conversation gives an existing Thread makes it one of the person's
  // tasks, whoever created it. Nothing ever takes a task off the list.
  const listedNow = reusedRow !== null && !reusedRow.listed && parent.role === "conversation";
  const threadRow = reusedRow
    ? listedNow
      ? await transaction
          .updateTable("threads")
          .set({ listed: true })
          .where("id", "=", threadId)
          .returningAll()
          .executeTakeFirstOrThrow()
      : reusedRow
    : await insertThread({
        accessMode: ThreadAccessModeSchema.parse(input.accessMode),
        capabilityProfileId: "delegated",
        role: "work",
        createdByPrincipalId: actorPrincipalId,
        id: threadId,
        lineageRootThreadId: parent.lineageRootThreadId,
        // Work a conversation hands off is the person's own task; work a task
        // hands off belongs inside that task.
        listed: parent.role === "conversation",
        modelSelection: jsonValue(ModelSelectionSchema.parse(input.modelSelection)),
        parentThreadId: input.origin.parentThreadId,
        status: deriveThreadStatus({
          earliestActiveRunStatus: null,
          inputQueuePaused: false,
          lastRunFailed: false,
        }),
        title: input.title,
        titleSource: input.titleSource ?? "chosen",
        icon: input.icon ?? null,
        iconSource: input.icon ? "chosen" : "provisional",
        workspaceId: input.workspaceId,
      });
  await ensureSelectedProviderSession(transaction, threadRow);
  await transaction
    .insertInto("commands")
    .values({
      actorPrincipalId,
      authoritySource: jsonValue({ kind: "delegation", origin: input.origin }),
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
    continuationIdentity: selectedSession.continuationIdentity,
    providerSessionId: selectedSession.id,
    pendingRequests: threadRow.pendingRequestCount,
  });
  const threadEvent =
    reusedRow === null || listedNow
      ? await appendHostWorkspaceEvent(transaction, {
          data: { thread },
          environmentId: thread.environmentId,
          runId: null,
          threadId,
          type: reusedRow === null ? "thread.created" : "thread.listed",
          workspaceId: thread.workspaceId,
        })
      : null;
  const queued = await enqueueThreadInputInTransaction(transaction, {
    ...(input.origin.kind === "run" ? { forwardedPlaces: true as const } : {}),
    content: task,
    idempotencyKey: `${input.idempotencyKey}:task`,
    policy: "queue",
    requestedBy: input.createdBy,
    source:
      input.origin.kind === "run"
        ? { kind: "agent", runId: input.origin.parentRunId }
        : input.origin.kind === "trigger"
          ? { kind: "trigger", occurrenceId: input.origin.occurrenceId }
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
    throw new OpensteerError({ code: "internal", message: "Delegated Run was not queued" });
  }
  const assignmentId = createId("delegation");
  await transaction
    .updateTable("threadInputs")
    .set({ assignmentId })
    .where("messageId", "=", queued.message.id)
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable("runs")
    .set({ assignmentId })
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

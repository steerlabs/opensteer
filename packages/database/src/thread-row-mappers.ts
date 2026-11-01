import {
  AssignmentSchema,
  MessageSchema,
  RunSchema,
  ThreadInputSchema,
  ThreadRunQueueEntrySchema,
  ThreadSchema,
  type CausalChainId,
  type Assignment,
  type AssignmentId,
  type EnvironmentId,
  type HarnessInstanceId,
  type Message,
  type MessageId,
  type ModelSelection,
  type ReplyTarget,
  type ProviderSessionId,
  type Run,
  type RunFailure,
  type RunId,
  type ExecutionNode,
  type RunAttempt,
  type RunUsage,
  type Thread,
  type ThreadAccessMode,
  type ThreadId,
  type ThreadInput,
  type ThreadRunQueueEntry,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import { sql, type Selectable } from "kysely";
import type {
  DelegationTable,
  ExecutionNodeTable,
  MessageTable,
  RunAttemptTable,
  ThreadCapabilityProfileId,
  ThreadInputTable,
} from "./schema.js";

export const threadPendingRequestsSelection = sql<number>`threads.pending_request_count`.as(
  "pendingRequests",
);

export const threadProviderSessionSelection = sql<ProviderSessionId | null>`(
  select id from provider_sessions
  where thread_id = threads.id and active
)`.as("providerSessionId");

export const threadContinuationIdentitySelection = sql<Thread["continuationIdentity"]>`(
  select continuation_identity from provider_sessions
  where thread_id = threads.id and active
)`.as("continuationIdentity");

type ThreadReadRow = {
  readonly askedAt: Date;
  readonly doneAt: Date | null;
  readonly inputQueuePaused: boolean;
  readonly accessMode: ThreadAccessMode;
  readonly capabilityProfileId: ThreadCapabilityProfileId;
  readonly role: Thread["role"];
  readonly continuationIdentity: Thread["continuationIdentity"];
  readonly providerSessionId: ProviderSessionId | null;
  readonly id: ThreadId;
  readonly lineageRootThreadId: ThreadId;
  readonly workspaceId: WorkspaceId;
  readonly parentThreadId: ThreadId | null;
  readonly listed: boolean;
  readonly title: string;
  readonly icon: Thread["icon"];
  readonly color: NonNullable<Thread["color"]>;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly modelSelection: ModelSelection;
  readonly pendingRequests: number;
  readonly status: string;
  readonly createdBy: UserId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export function threadFromRow(row: ThreadReadRow): Thread {
  return ThreadSchema.parse(threadValueFromRow(row));
}

export function threadsFromRows(rows: readonly ThreadReadRow[]): Thread[] {
  return ThreadSchema.array().parse(rows.map(threadValueFromRow));
}

function threadValueFromRow(row: ThreadReadRow) {
  return {
    ...row,
    askedAt: row.askedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    doneAt: row.doneAt?.toISOString() ?? null,
    pendingRequests: row.pendingRequests,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function messageFromRow(row: Selectable<MessageTable>): Message {
  return MessageSchema.parse(messageValueFromRow(row));
}

export function messagesFromRows(rows: readonly Selectable<MessageTable>[]): Message[] {
  return MessageSchema.array().parse(rows.map(messageValueFromRow));
}

function messageValueFromRow(row: Selectable<MessageTable>) {
  return {
    ...(row.quote ? { quote: row.quote } : {}),
    author: row.author,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    kind: row.kind,
    runId: row.runId,
    sequence: String(row.sequence),
    threadId: row.threadId,
  };
}

export function threadInputFromRow(row: Selectable<ThreadInputTable>): ThreadInput {
  return ThreadInputSchema.parse({
    assignmentId: row.assignmentId,
    cancelReason: row.cancelReason,
    causalChainId: row.causalChainId,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    messageId: row.messageId,
    policy: row.policy,
    replyTarget: row.replyTarget,
    runId: row.runId,
    state: row.state,
    threadId: row.threadId,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export function assignmentFromRow(row: Selectable<DelegationTable>): Assignment {
  return AssignmentSchema.parse({
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    id: row.id as AssignmentId,
    initialInputMessageId: row.initialInputMessageId,
    initialRunId: row.childRunId,
    objective: row.objective,
    origin: row.origin,
    parentAssignmentId: row.parentAssignmentId,
    parentOccurrenceId: row.parentOccurrenceId,
    parentRunId: row.parentRunId,
    parentThreadId: row.parentThreadId,
    parentWatchActivationId: row.parentWatchActivationId,
    replyTarget: row.replyTarget,
    resultRunId: row.resultRunId,
    resultText: row.resultText,
    returnAttemptedAt: row.resultAttemptedAt?.toISOString() ?? null,
    returnMessageId: row.resultMessageId,
    returnReason: row.resultReason,
    returnStatus: row.resultStatus,
    revision: row.revision,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    workerThreadId: row.childThreadId,
  });
}

export function runFromRow(row: {
  readonly accessMode: ThreadAccessMode;
  readonly activationInputId: MessageId;
  readonly assignmentId: AssignmentId | null;
  readonly id: RunId;
  readonly providerSessionId: ProviderSessionId | null;
  readonly threadId: ThreadId;
  readonly causalChainId: CausalChainId;
  readonly environmentId: EnvironmentId;
  readonly failure: RunFailure | null;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly modelSelection: ModelSelection;
  readonly requestedBy: UserId;
  readonly replyTarget: ReplyTarget | null;
  readonly runOrdinal: number;
  readonly status: string;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly seedInputId: MessageId;
  readonly inputTokens: string | null;
  readonly outputTokens: string | null;
  readonly cachedInputTokens: string | null;
  readonly cacheWriteTokens: string | null;
  readonly reasoningTokens: string | null;
  readonly costUsd: string | null;
}): Run {
  const usage = runUsageFromRow(row);
  return RunSchema.parse({
    accessMode: row.accessMode,
    activationInputId: row.activationInputId,
    assignmentId: row.assignmentId,
    causalChainId: row.causalChainId,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    environmentId: row.environmentId,
    failure: row.failure,
    harnessInstanceId: row.harnessInstanceId,
    id: row.id,
    providerSessionId: row.providerSessionId,
    modelSelection: row.modelSelection,
    replyTarget: row.replyTarget,
    requestedBy: row.requestedBy,
    runOrdinal: row.runOrdinal,
    startedAt: row.startedAt?.toISOString() ?? null,
    status: row.status,
    threadId: row.threadId,
    seedInputId: row.seedInputId,
    ...(usage ? { usage } : {}),
  });
}

/**
 * `bigint` and `numeric` arrive from `pg` as strings. The pair of token totals
 * is what says a Run has usage at all; the rest are present only when the
 * engine reported them.
 */
export function executionNodeFromRow(row: Selectable<ExecutionNodeTable>): ExecutionNode {
  return {
    attemptId: row.attemptId,
    endedAt: row.endedAt?.toISOString() ?? null,
    id: row.id,
    kind: row.kind,
    model: row.model,
    parentNodeId: row.parentNodeId,
    prompt: row.prompt,
    result: row.result,
    runId: row.runId,
    startedAt: row.startedAt.toISOString(),
    status: row.status,
    title: row.title,
    usage: runUsageFromRow(row),
  };
}

export function runAttemptFromRow(row: Selectable<RunAttemptTable>): RunAttempt {
  return {
    createdAt: row.startedAt.toISOString(),
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    engineStart: row.engineStart,
    id: row.id,
    modelSelection: row.modelSelection,
    ordinal: row.ordinal,
    outcome: row.outcome,
    reason: row.reason,
    runId: row.runId,
    runnerId: row.runnerId,
    startedAt: row.firstEventAt?.toISOString() ?? null,
    status: row.status,
    usage: runUsageFromRow(row),
  };
}

export function runUsageFromRow(row: {
  readonly inputTokens: string | null;
  readonly outputTokens: string | null;
  readonly cachedInputTokens: string | null;
  readonly cacheWriteTokens: string | null;
  readonly reasoningTokens: string | null;
  readonly costUsd: string | null;
}): RunUsage | null {
  if (row.inputTokens === null || row.outputTokens === null) return null;
  const optional = {
    cachedInputTokens: row.cachedInputTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costUsd: row.costUsd,
    reasoningTokens: row.reasoningTokens,
  };
  return {
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    ...Object.fromEntries(
      Object.entries(optional)
        .filter(([, value]) => value !== null)
        .map(([key, value]) => [key, Number(value)]),
    ),
  };
}

type ThreadRunQueueReadRow = {
  readonly createdAt: Date;
  readonly id: RunId;
  readonly status: string;
  readonly threadId: ThreadId;
  readonly runOrdinal: number;
};

export function threadRunQueueEntryFromRow(row: ThreadRunQueueReadRow): ThreadRunQueueEntry {
  return ThreadRunQueueEntrySchema.parse(threadRunQueueValueFromRow(row));
}

export function threadRunQueueEntriesFromRows(
  rows: readonly ThreadRunQueueReadRow[],
): ThreadRunQueueEntry[] {
  return ThreadRunQueueEntrySchema.array().parse(rows.map(threadRunQueueValueFromRow));
}

function threadRunQueueValueFromRow(row: ThreadRunQueueReadRow) {
  return {
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    status: row.status,
    threadId: row.threadId,
    runOrdinal: row.runOrdinal,
  };
}

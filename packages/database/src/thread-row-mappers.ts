import {
  AssignmentSchema,
  MessageOriginSchema,
  MessageSchema,
  RunSchema,
  ThreadInputSchema,
  ThreadRunQueueEntrySchema,
  ThreadSchema,
  type CausalChainId,
  type MessageOrigin,
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
} from "@opensteer/core";
import { sql, type Selectable } from "kysely";
import type {
  DelegationTable,
  ExecutionNodeTable,
  MessageTable,
  RunAttemptTable,
  ThreadInputTable,
} from "./schema.js";
import { latestRunCompletion } from "./thread-visits.js";
export const threadVisitSelection = sql<Date | null>`(
  select last_visited_at from thread_visits
  where thread_id = threads.id and user_id = (select owner_id from personal_settings)
)`.as("lastVisitedAt");
export const threadLatestRunCompletedAtSelection = latestRunCompletion(sql`threads.id`).as(
  "latestRunCompletedAt",
);
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
/** A connected agent or a chat started this task, so the person's own engine rules do not apply. */
export const threadStartedByOtherSelection = sql<boolean>`(
  threads.origin_connection_id is not null
)`.as("startedByOther");
type ThreadReadRow = {
  readonly lastVisitedAt?: Date | null;
  readonly latestRunCompletedAt?: Date | null;
  readonly originConnectionId?: string | null;
  readonly startedByOther?: boolean;
  readonly askedAt: Date;
  readonly doneAt: Date | null;
  readonly doneReason?: Thread["doneReason"];
  readonly doneBy?: Thread["doneBy"];
  readonly inputQueuePaused: boolean;
  readonly accessMode: ThreadAccessMode;
  readonly purpose: Thread["purpose"];
  readonly continuationIdentity: Thread["continuationIdentity"];
  readonly providerSessionId: ProviderSessionId | null;
  readonly id: ThreadId;
  readonly lineageRootThreadId: ThreadId;
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
  const startedByOther = row.startedByOther ?? row.originConnectionId != null;
  return {
    ...row,
    lastVisitedAt: row.lastVisitedAt?.toISOString() ?? null,
    latestRunCompletedAt: row.latestRunCompletedAt?.toISOString() ?? null,
    askedAt: row.askedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    doneAt: row.doneAt?.toISOString() ?? null,
    doneReason: row.doneReason ?? null,
    ...(row.doneBy === undefined ? {} : { doneBy: row.doneBy }),
    pendingRequests: row.pendingRequests,
    ...(startedByOther ? { startedByOther: true } : {}),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export function messageEditFromRow(
  row: Pick<Selectable<MessageTable>, "revision" | "editedAt" | "author">,
) {
  return row.revision > 0 && row.editedAt
    ? { revision: row.revision, editedAt: row.editedAt.toISOString() }
    : undefined;
}

export function messageViewFromRow(row: Selectable<MessageTable>) {
  const edit = messageEditFromRow(row);
  return { ...messageFromRow(row), ...(edit ? { edit } : {}) };
}

export function messageFromRow(row: Selectable<MessageTable>): Message {
  return MessageSchema.parse(messageValueFromRow(row));
}
/**
 * A message a teammate wrote, kept by a database from before team removal. A Message has no way
 * to say it without its author, so every read of Messages leaves it out: neither shown nor an
 * error. A transcript item keeps its text without the author.
 */
export function isRetiredMessageRow(row: Pick<Selectable<MessageTable>, "author">): boolean {
  return (row.author as { readonly kind?: unknown }).kind === "team-member";
}
/** The same rule as `isRetiredMessageRow`, for a query that pages or counts messages. */
export function keptMessageSql(alias = "messages") {
  return sql<boolean>`${sql.ref(`${alias}.author`)}->>'kind' is distinct from 'team-member'`;
}
export function messagesFromRows(rows: readonly Selectable<MessageTable>[]): Message[] {
  return MessageSchema.array().parse(
    rows.filter((row) => !isRetiredMessageRow(row)).map(messageValueFromRow),
  );
}
/** A reply target of a kind this release no longer has (a team thread) reads as none. */
export function personalReplyTarget(target: ReplyTarget | null): ReplyTarget | null {
  return target?.kind === "channel" ? target : null;
}
/** Where a person sent a message from; absent for other authors and older apps. */
export function messageOriginFromRow(
  row: Pick<Selectable<MessageTable>, "origin">,
): MessageOrigin | undefined {
  const parsed = MessageOriginSchema.safeParse(row.origin);
  return parsed.success ? parsed.data : undefined;
}
function messageValueFromRow(row: Selectable<MessageTable>) {
  return {
    ...(row.quote
      ? {
          quote: row.quote,
        }
      : {}),
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
    ...(row.freshContext ? { freshContext: true } : {}),
    assignmentId: row.assignmentId,
    cancelReason: row.cancelReason,
    causalChainId: row.causalChainId,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    messageId: row.messageId,
    policy: row.policy,
    replyTarget: personalReplyTarget(row.replyTarget),
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
    replyTarget: personalReplyTarget(row.replyTarget),
    resultRunId: row.resultRunId,
    resultText: row.resultText,
    returnAttemptedAt: row.resultAttemptedAt?.toISOString() ?? null,
    returnMessageId: row.resultMessageId,
    returnReason: row.resultReason,
    returnStatus: row.resultStatus,
    revision: Number(row.revision),
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
    workerThreadId: row.childThreadId,
  });
}
export function runFromRow(row: {
  readonly maintenance?: import("@opensteer/core").RunMaintenance | null;
  readonly accessMode: ThreadAccessMode;
  readonly activationInputId: MessageId;
  readonly assignmentId: AssignmentId | null;
  readonly id: RunId;
  readonly providerSessionId: ProviderSessionId | null;
  readonly threadId: ThreadId;
  readonly causalChainId: CausalChainId;
  readonly environmentId: EnvironmentId;
  readonly failure: RunFailure | null;
  readonly providerRetry?: import("@opensteer/core").RunRetry | null;
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
    ...(row.maintenance ? { maintenance: row.maintenance } : {}),
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
    replyTarget: personalReplyTarget(row.replyTarget),
    requestedBy: row.requestedBy,
    ...(row.providerRetry !== undefined ? { retry: row.providerRetry } : {}),
    runOrdinal: row.runOrdinal,
    startedAt: row.startedAt?.toISOString() ?? null,
    status: row.status,
    threadId: row.threadId,
    seedInputId: row.seedInputId,
    ...(usage
      ? {
          usage,
        }
      : {}),
  });
}

/**
 * `bigint` and `numeric` arrive from `pg` as strings. The pair of token totals
 * is what says a Run has usage at all; the rest are present only when the
 * engine reported them.
 */
export function executionNodeFromRow(
  row: Omit<Selectable<ExecutionNodeTable>, "nativeRef" | "sessionRef" | "originCallId">,
): ExecutionNode {
  return {
    attemptId: row.attemptId,
    stopSupported: row.stopSupported,
    stopping: row.stopping,
    effort: row.effort,
    phaseIndex: row.phaseIndex,
    phases: row.phases,
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
  readonly maintenance?: import("@opensteer/core").RunMaintenance | null;
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
    ...(row.maintenance ? { maintenance: row.maintenance } : {}),
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    status: row.status,
    threadId: row.threadId,
    runOrdinal: row.runOrdinal,
  };
}

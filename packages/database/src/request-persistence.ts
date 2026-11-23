import {
  OpensteerError,
  RequestSchema,
  requestOutcomeText,
  utf8Prefix,
  type EnvironmentId,
  type Request,
  type RequestId,
  type ThreadId,
} from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import type { DatabaseSchema, RequestRow } from "./schema.js";
import { jsonValue } from "./store-primitives.js";
import { refreshRequestAttention } from "./personal-attention-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { allocateTranscriptPosition } from "./message-visibility.js";
import { itemView } from "./personal-sync-store.js";
import { transcriptPreview } from "./transcript-store.js";

export function assertRequestRevision(row: Pick<RequestRow, "revision">, expectedRevision: string) {
  if (row.revision !== expectedRevision)
    throw new OpensteerError({
      code: "conflict",
      reason: "request-changed",
      message: "Request changed; read it again before answering",
    });
}

export function describeTranscriptRequest(request: Request) {
  return transcriptPreview({
    title: request.presentation.title,
    status: request.status,
    preview: requestOutcomeText(request),
    requestKind: request.kind,
    ...(request.mode === "live" ? { waitedSince: request.createdAt } : {}),
  });
}

export async function lockRequestThreads(
  tx: Transaction<DatabaseSchema>,
  threadIds: readonly ThreadId[],
): Promise<void> {
  if (!threadIds.length) return;
  await tx
    .selectFrom("threads")
    .select("id")
    .where("id", "in", [...new Set(threadIds)])
    .orderBy("id")
    .forNoKeyUpdate()
    .execute();
}

export function refreshRequestState(
  transaction: Transaction<DatabaseSchema>,
  requestId: RequestId,
) {
  return commitPersonalMutation(transaction, async (tx, mutation) => {
    const row = await tx
      .updateTable("requests")
      .set({ revision: mutation.sequence })
      .where("id", "=", requestId)
      .returningAll()
      .executeTakeFirstOrThrow();
    const {
      originatingThreadId: threadId,
      originatingNodeId: nodeId,
      originatingRunId: runId,
    } = row;
    const scopeKey = nodeId ? (`node:${nodeId}` as const) : (`thread:${threadId}` as const);
    const id = `request:${requestId}`;
    const title = utf8Prefix(row.presentation.title, 240);
    const request = requestFromRow(row);
    if (request.status !== "pending") {
      const view = describeTranscriptRequest(request);
      const prior =
        mutation.transcriptPlacement(id) ??
        (await tx
          .selectFrom("transcriptItems")
          .select("position")
          .where("id", "=", id)
          .executeTakeFirst());
      const node = nodeId
        ? await tx
            .selectFrom("executionNodes")
            .select("attemptId")
            .where("id", "=", nodeId)
            .executeTakeFirstOrThrow()
        : null;
      const position = prior?.position ?? (await allocateTranscriptPosition(tx, threadId));
      const fields = {
        position,
        revision: mutation.sequence,
        view,
        visible: true,
        createdAt: request.resolvedAt,
      };
      mutation.stageTranscript(
        id,
        { position, visible: true, nodeId, isTurnStart: false },
        async () => {
          const item = await tx
            .insertInto("transcriptItems")
            .values({
              id,
              threadId,
              runId,
              attemptId: node?.attemptId ?? null,
              nodeId,
              requestId,
              kind: "request",
              isTurnStart: false,
              ...fields,
            })
            .onConflict((conflict) => conflict.column("id").doUpdateSet(fields))
            .returningAll()
            .executeTakeFirstOrThrow();
          // The receipt is drawn where `itemView` places it, which may be the task for a node's ask.
          const shown = itemView({ ...item, question: request });
          mutation.change(
            {
              scopeKey: shown.nodeId ? `node:${shown.nodeId}` : `thread:${threadId}`,
              entityKind: "item",
              entityId: id,
              operation: "upsert",
            },
            () => shown,
          );
        },
      );
    }
    // A subagent's Request is answered from its task as well as its own view.
    for (const requestScope of new Set([scopeKey, `thread:${threadId}` as const]))
      mutation.change(
        {
          scopeKey: requestScope,
          entityKind: "request",
          entityId: requestId,
          operation: row.status === "pending" ? "upsert" : "remove",
        },
        () => ({
          id: requestId,
          revision: row.revision,
          status: row.status,
          kind: row.kind,
          title,
          threadId,
        }),
      );

    await refreshRequestAttention(tx, mutation, requestId);
    if (row.kind === "browser.password-sign-in" || row.kind === "computer.app.access")
      mutation.react({ type: "deadlinesChanged" });
    return request;
  });
}

export async function requestOriginEnvironment(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  request: Pick<
    Request,
    | "originatingOccurrenceId"
    | "originatingRunId"
    | "originatingWatchActivationId"
    | "originatingAgentSessionId"
  >,
): Promise<EnvironmentId> {
  if (request.originatingAgentSessionId)
    return (
      await database
        .selectFrom("agentSessions")
        .innerJoin("threads", "threads.id", "agentSessions.threadId")
        .select("threads.environmentId")
        .where("agentSessions.id", "=", request.originatingAgentSessionId)
        .executeTakeFirstOrThrow()
    ).environmentId;
  if (request.originatingRunId !== null) {
    const run = await database
      .selectFrom("runs")
      .select("environmentId")
      .where("id", "=", request.originatingRunId)
      .executeTakeFirstOrThrow();
    return run.environmentId;
  }
  if (request.originatingWatchActivationId)
    return (
      await database
        .selectFrom("triggerWatchActivations")
        .select("environmentId")
        .where("id", "=", request.originatingWatchActivationId)
        .executeTakeFirstOrThrow()
    ).environmentId;
  if (request.originatingOccurrenceId === null) {
    throw new Error("Request has no origin to read its environment from");
  }
  const occurrence = await database
    .selectFrom("triggerOccurrences")
    .select("environmentId")
    .where("id", "=", request.originatingOccurrenceId)
    .executeTakeFirstOrThrow();
  return occurrence.environmentId;
}
export function requestFromRow(row: RequestRow): Request {
  return RequestSchema.parse({
    callId: row.callId,
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    kind: row.kind,
    mode: row.mode,
    ...(row.originatingNodeId
      ? {
          originatingNodeId: row.originatingNodeId,
        }
      : {}),
    originatingOccurrenceId: row.originatingOccurrenceId,
    originatingWatchActivationId: row.originatingWatchActivationId,
    ...(row.originatingAgentSessionId
      ? { originatingAgentSessionId: row.originatingAgentSessionId }
      : {}),
    ...(row.agentOperation ? { agentOperation: row.agentOperation as never } : {}),
    ...(row.command ? { command: row.command as never } : {}),
    originatingRunId: row.originatingRunId,
    originatingThreadId: row.originatingThreadId,
    payload: row.payload,
    presentation: row.presentation,
    requestedBy: row.requestedBy,
    requiredActor: row.requiredActor,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    settlementProvenance: row.settlementProvenance ?? null,
    response: row.response,
    status: row.status,
  });
}
export function requestInsert(request: Request) {
  return {
    callId: request.callId,
    cancellationReason: request.cancellationReason,
    createdAt: new Date(request.createdAt),
    id: request.id,
    kind: request.kind,
    mode: request.mode,
    originatingNodeId: request.originatingNodeId ?? null,
    originatingOccurrenceId: request.originatingOccurrenceId,
    originatingWatchActivationId: request.originatingWatchActivationId ?? null,
    originatingAgentSessionId: request.originatingAgentSessionId ?? null,
    originatingRunId: request.originatingRunId,
    originatingThreadId: request.originatingThreadId,
    payload: jsonValue(request.payload),
    presentation: jsonValue(request.presentation),
    requestedBy: request.requestedBy,
    requiredActor: request.requiredActor,
    resolvedAt: request.resolvedAt ? new Date(request.resolvedAt) : null,
    resolvedBy: request.resolvedBy,
    settlementProvenance: request.settlementProvenance
      ? jsonValue(request.settlementProvenance)
      : null,
    response: request.response ? jsonValue(request.response) : null,
    status: request.status,
  };
}

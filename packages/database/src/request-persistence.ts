import { publishThreadSummary } from "./thread-status.js";
import { refreshAssignmentWorkerSummaries } from "./assignment-store.js";
import {
  OpensteerError,
  RequestSchema,
  utf8Prefix,
  type EnvironmentId,
  type Request,
  type RequestId,
} from "@opensteer/core";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema, RequestRow } from "./schema.js";
import { jsonValue } from "./store-primitives.js";
import { refreshRequestAttention } from "./personal-attention-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { itemView } from "./personal-sync-store.js";
import { transcriptPreview } from "./transcript-store.js";

export function assertRequestRevision(row: Pick<RequestRow, "revision">, expectedRevision: string) {
  if (row.revision !== expectedRevision)
    throw new OpensteerError({
      code: "conflict",
      message: "Request changed; read it again before answering",
    });
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
    const view = transcriptPreview({ title, status: row.status });
    let item = await tx
      .updateTable("transcriptItems")
      .set({ revision: mutation.sequence, view })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!item) {
      const { nextTranscriptPosition: position } = await tx
        .updateTable("threads")
        .set({ nextTranscriptPosition: sql<string>`next_transcript_position + 1` })
        .where("id", "=", threadId)
        .returning("nextTranscriptPosition")
        .executeTakeFirstOrThrow();
      item = await tx
        .insertInto("transcriptItems")
        .values({
          id,
          threadId,
          runId,
          nodeId,
          position,
          requestId,
          view,
          kind: "request",
          revision: mutation.sequence,
          visible: true,
          isTurnStart: false,
          createdAt: row.createdAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    const viewItem = itemView(item);
    mutation.change(
      { scopeKey, entityKind: "item", entityId: id, operation: "upsert" },
      () => viewItem,
    );
    mutation.change(
      {
        scopeKey,
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
    await publishThreadSummary(tx, threadId);
    await refreshAssignmentWorkerSummaries(tx, threadId);
    return requestFromRow(row);
  });
}

export async function requestOriginEnvironment(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  request: Pick<Request, "originatingOccurrenceId" | "originatingRunId">,
): Promise<EnvironmentId> {
  if (request.originatingRunId !== null) {
    const run = await database
      .selectFrom("runs")
      .select("environmentId")
      .where("id", "=", request.originatingRunId)
      .executeTakeFirstOrThrow();
    return run.environmentId;
  }
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

import { RequestSchema, type EnvironmentId, type Request } from "@opensteer/core";
import type { Kysely, Transaction } from "kysely";
import type { DatabaseSchema, RequestRow } from "./schema.js";
import { jsonValue } from "./store-primitives.js";

/**
 * Workspace events are stamped with the environment the work ran in, and a
 * Request's origin is the only thing that knows it: a Run carries it directly,
 * a Trigger Occurrence carries its own.
 */
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
    ...(row.originatingNodeId ? { originatingNodeId: row.originatingNodeId } : {}),
    originatingOccurrenceId: row.originatingOccurrenceId,
    originatingRunId: row.originatingRunId,
    originatingThreadId: row.originatingThreadId,
    originatingWorkspaceId: row.originatingWorkspaceId,
    payload: row.payload,
    presentation: row.presentation,
    requestedBy: row.requestedBy,
    requiredActor: row.requiredActor,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    response: row.response,
    status: row.status,
    targetWorkspaceId: row.targetWorkspaceId,
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
    originatingWorkspaceId: request.originatingWorkspaceId,
    payload: jsonValue(request.payload),
    presentation: jsonValue(request.presentation),
    requestedBy: request.requestedBy,
    requiredActor: request.requiredActor,
    resolvedAt: request.resolvedAt ? new Date(request.resolvedAt) : null,
    resolvedBy: request.resolvedBy,
    response: request.response ? jsonValue(request.response) : null,
    status: request.status,
    targetWorkspaceId: request.targetWorkspaceId,
  };
}

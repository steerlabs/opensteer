import { lockRequestWorkspaces } from "./request-workspace-locks.js";
import { RequestResponseSchema, type AgentEvent, type UserId } from "@opensteer/core";
import type {
  IntegrationAccess,
  IntegrationConnectionId,
  IntegrationInstallationId,
  IntegrationServerId,
} from "@opensteer/integration-core";
import type { Transaction } from "kysely";
import { assignmentActivityEventsForRun } from "./assignment-store.js";
import { requestFromRow, requestOriginEnvironment } from "./request-persistence.js";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";
import { appendHostWorkspaceEvent } from "./workspace-events.js";

/**
 * Settles Main-workspace access that a newly available computer connection now
 * covers. Main inherits authority, so no grant row is created; the durable
 * Request still receives the same continuation and terminal workspace event as
 * an explicit fulfillment.
 */
export async function fulfillPendingMainIntegrationAccessRequestsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly access: IntegrationAccess;
    readonly connectionId: IntegrationConnectionId;
    readonly displayName: string;
    readonly installationId: IntegrationInstallationId;
    readonly ownerUserId: UserId;
    readonly serverId: IntegrationServerId;
  },
): Promise<readonly AgentEvent[]> {
  const pendingQuery = pendingMainIntegrationAccessRequests(transaction, input);
  await lockRequestWorkspaces(
    transaction,
    (await pendingQuery.execute()).flatMap((row) => [
      row.originatingWorkspaceId,
      row.targetWorkspaceId,
    ]),
  );
  const pending = await pendingQuery.forNoKeyUpdate("requests").execute();
  const events: AgentEvent[] = [];
  const now = new Date();
  for (const row of pending) {
    const response = RequestResponseSchema.parse({
      kind: "external",
      value: {
        account: { accountIdentifier: null, displayName: input.displayName },
        connectionId: input.connectionId,
        decision: "fulfilled",
      },
    });
    const resolvedRow = await transaction
      .updateTable("requests")
      .set({
        resolvedAt: now,
        resolvedBy: input.ownerUserId,
        response: jsonValue(response),
        responseCommandId: null,
        status: "fulfilled",
      })
      .where("id", "=", row.id)
      .where("status", "=", "pending")
      .returningAll()
      .executeTakeFirst();
    if (!resolvedRow) continue;
    const request = requestFromRow(resolvedRow);
    if (request.mode === "durable") {
      await transaction
        .insertInto("requestContinuations")
        .values({
          attemptedAt: null,
          createdAt: now,
          reason: null,
          requestId: request.id,
          status: "waiting",
          updatedAt: now,
        })
        .onConflict((conflict) => conflict.column("requestId").doNothing())
        .execute();
    }
    events.push(
      await appendHostWorkspaceEvent(transaction, {
        data: { request },
        environmentId: await requestOriginEnvironment(transaction, request),
        runId: request.originatingRunId,
        threadId: request.originatingThreadId,
        type: "request.resolved",
        workspaceId: request.originatingWorkspaceId,
      }),
    );
    if (request.originatingRunId) {
      events.push(...(await assignmentActivityEventsForRun(transaction, request.originatingRunId)));
    }
  }
  return events;
}

/** The Main Requests a connection change will settle, also used to fence the full Request set. */
export function pendingMainIntegrationAccessRequests(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly access: IntegrationAccess;
    readonly connectionId: IntegrationConnectionId;
    readonly installationId: IntegrationInstallationId;
    readonly ownerUserId: UserId;
    readonly serverId: IntegrationServerId;
  },
) {
  return transaction
    .selectFrom("requests")
    .innerJoin("integrationRequestDetails", "integrationRequestDetails.requestId", "requests.id")
    .innerJoin("workspaces", "workspaces.id", "requests.targetWorkspaceId")
    .selectAll("requests")
    .where("requests.kind", "=", "integration.access")
    .where("requests.status", "=", "pending")
    .where("requests.requestedBy", "=", input.ownerUserId)
    .where("integrationRequestDetails.installationId", "=", input.installationId)
    .where((expression) =>
      expression.or([
        expression("integrationRequestDetails.requestedConnectionId", "is", null),
        expression("integrationRequestDetails.requestedConnectionId", "=", input.connectionId),
      ]),
    )
    .where("workspaces.kind", "=", "main")
    .where("workspaces.createdBy", "=", input.ownerUserId)
    .where((expression) =>
      expression.or([
        expression("integrationRequestDetails.requestedServerId", "is", null),
        expression("integrationRequestDetails.requestedServerId", "=", input.serverId),
      ]),
    )
    .$if(input.access === "read", (query) =>
      query.where("integrationRequestDetails.access", "=", "read"),
    )
    .orderBy("requests.id", "asc");
}

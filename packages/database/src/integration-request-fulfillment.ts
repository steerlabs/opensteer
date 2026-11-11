import { appendHostDeploymentEvent } from "./deployment-events.js";
import { writeIntegrationGrantInTransaction } from "./integration-grant-write.js";
import {
  RequestResponseSchema,
  type AgentEvent,
  type RequestSettlementProvenance,
  type UserId,
} from "@opensteer/core";
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

export async function fulfillPendingIntegrationAccessRequestsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly access: IntegrationAccess;
    readonly connectionId: IntegrationConnectionId;
    readonly displayName: string;
    readonly settlementActor?: RequestSettlementProvenance | null;
    readonly installationId: IntegrationInstallationId;
    readonly ownerUserId: UserId;
    readonly serverId: IntegrationServerId;
  },
): Promise<readonly AgentEvent[]> {
  const pendingQuery = pendingIntegrationAccessRequests(transaction, input);
  const pending = await pendingQuery.forNoKeyUpdate("requests").execute();
  const events: AgentEvent[] = [];
  const now = new Date();
  for (const row of pending) {
    const details = await transaction
      .selectFrom("integrationRequestDetails")
      .select("access")
      .where("requestId", "=", row.id)
      .executeTakeFirstOrThrow();
    await writeIntegrationGrantInTransaction(transaction, {
      access: details.access ?? input.access,
      alias: input.displayName,
      connectionId: input.connectionId,
      createdBy: input.ownerUserId,
      installationId: input.installationId,
      isDefault: false,
      ownerUserId: input.ownerUserId,
      providerAuthorizations: {},
    });
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
        settlementProvenance: input.settlementActor ? jsonValue(input.settlementActor) : null,
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
      await appendHostDeploymentEvent(transaction, {
        data: { request },
        environmentId: await requestOriginEnvironment(transaction, request),
        runId: request.originatingRunId,
        threadId: request.originatingThreadId,
        type: "request.resolved",
      }),
    );
    if (request.originatingRunId) {
      events.push(...(await assignmentActivityEventsForRun(transaction, request.originatingRunId)));
    }
  }
  return events;
}

export function pendingIntegrationAccessRequests(
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

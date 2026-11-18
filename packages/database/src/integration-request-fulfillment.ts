import { ResolvedRequestSchema } from "@opensteer/core";
import {
  RequestResponseSchema,
  type RequestId,
  type RequestSettlementProvenance,
  type UserId,
} from "@opensteer/core";
import type { IntegrationAccess } from "@opensteer/integration-core/access";
import type {
  IntegrationConnectionId,
  IntegrationInstallationId,
  IntegrationServerId,
} from "@opensteer/integration-core/ids";
import type { Transaction } from "kysely";
import { refreshRequestState, requestFromRow } from "./request-persistence.js";
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
): Promise<readonly RequestId[]> {
  const pendingQuery = pendingIntegrationAccessRequests(transaction, input);
  const pending = await pendingQuery.forNoKeyUpdate("requests").execute();
  const settled: RequestId[] = [];
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
    const request = ResolvedRequestSchema.parse(requestFromRow(resolvedRow));
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
    await refreshRequestState(transaction, request.id);
    settled.push(request.id);
  }
  return settled;
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
    .select("integrationRequestDetails.access as requestedAccess")
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

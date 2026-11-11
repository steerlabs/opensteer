import { ResolvedRequestSchema } from "@opensteer/core";
import { appendHostDeploymentEvent } from "./deployment-events.js";
import { assertPersonalOwner } from "./private-resource-owner.js";
import {
  OpensteerError,
  type AgentEvent,
  type RequestId,
  type RequestSettlementProvenance,
  type RunnerId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import {
  computerAppIdentitiesEqual,
  integrationAccessCovers,
  widerIntegrationAccess,
  type ComputerAppIdentity,
  type IntegrationAccess,
  type IntegrationConnectionId,
  type IntegrationGrant,
  type IntegrationInstallationId,
} from "@opensteer/integration-core";
import { sql, type Kysely, type Transaction } from "kysely";
import { assignmentActivityEventsForRun } from "./assignment-store.js";
import {
  computerAppScopeOf,
  computerAppSetupRequestMatches,
  deleteComputerAppSetupRequestsInTransaction,
  insertComputerAppSetupRequestInTransaction,
  lockComputerAppSetupRequestInTransaction,
  relinkComputerAppAccessRequestsInTransaction,
  type ComputerAppScope,
  type ComputerAppSetupRequestRow,
} from "./computer-app-setup.js";
import {
  activeIntegrationGrantInTransaction,
  lockIntegrationGrantScopeInTransaction,
  writeIntegrationGrantInTransaction,
} from "./integration-grant-write.js";
import { requestFromRow, requestOriginEnvironment } from "./request-persistence.js";
import type { DatabaseSchema, RequestRow } from "./schema.js";
import { jsonValue } from "./store-primitives.js";

export async function lockComputerApprovalScopeInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly runnerId: RunnerId;
  },
): Promise<{
  readonly id: RunnerId;
  readonly name: string;
  readonly revokedAt: Date | null;
}> {
  const runner = await transaction
    .selectFrom("runners")
    .select(["id", "name", "revokedAt"])
    .where("id", "=", input.runnerId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!runner) throw new OpensteerError({ code: "not_found", message: "Computer not found" });
  return runner;
}

export interface ComputerAppAccessSettlement {
  readonly grants: readonly IntegrationGrant[];
  readonly requestEvents: readonly AgentEvent[];
  readonly requestIds: readonly RequestId[];
}

export const emptyComputerAppAccessSettlement: ComputerAppAccessSettlement = {
  grants: [],
  requestEvents: [],
  requestIds: [],
};

export interface ComputerUsePolicy {
  readonly appApproval: "ask" | "automatic";
  readonly revision: number;
}

export async function computerUsePolicyInTransaction(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
  ownerUserId: UserId,
): Promise<ComputerUsePolicy> {
  const deployment = await database
    .selectFrom("deployments")
    .select("id")
    .where("singletonKey", "=", "primary")
    .executeTakeFirstOrThrow();
  const row = await database
    .selectFrom("computerUsePolicies")
    .select(["appApproval", "revision"])
    .where("deploymentId", "=", deployment.id)
    .where("runnerId", "=", runnerId)
    .where("ownerUserId", "=", ownerUserId)
    .executeTakeFirst();
  return row ?? { appApproval: "ask", revision: 0 };
}

/** The task an approval names, which is what the Mac's reviewer shows it for. */
export interface ComputerAppApprovalTask {
  readonly reason: string;
  readonly threadId: ThreadId;
  readonly threadTitle: string | null;
}

/**
 * The one way anything asks for an app on a Mac: a task through
 * `integration_request`, the picker, and unblocking all come here.
 *
 * A waiting approval that already covers the ask is joined. Anything else
 * replaces it under a new id — wider access, the app as the Mac now resolves
 * it, a new catalog digest, or a Thread joining an approval no Thread carries
 * — and every Request waiting on the old one moves to the new one. A new id
 * prevents an answer to the old request from consuming its replacement,
 * including when a Thread joins a request that had no task context. Nothing is declined by a replacement. Only an approval that is
 * already over, because it expired or another owner asked for it, is
 * declined here.
 */
export async function askForComputerAppApprovalInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly access: IntegrationAccess;
    readonly app: ComputerAppIdentity | null;
    readonly definitionDigest: string;
    readonly definitionId: string;
    readonly now: Date;
    readonly ownerUserId: UserId;
    readonly runnerId: RunnerId;
    readonly task: ComputerAppApprovalTask | null;
  },
): Promise<{
  readonly row: ComputerAppSetupRequestRow;
  readonly settlement: ComputerAppAccessSettlement;
}> {
  const scope = computerAppScopeOf(input);
  const existing = await lockComputerAppSetupRequestInTransaction(transaction, scope);
  const waiting =
    existing && existing.ownerUserId === input.ownerUserId && existing.expiresAt > input.now
      ? existing
      : undefined;
  const fields = {
    app: input.app,
    definitionDigest: input.definitionDigest,
    definitionId: input.definitionId,
    now: input.now,
    ownerUserId: input.ownerUserId,
    runnerId: input.runnerId,
  };
  if (!waiting) {
    const over = await deleteComputerAppSetupRequestsInTransaction(transaction, scope);
    const settlement = await declineComputerAppAccessRequestsInTransaction(transaction, {
      setupRequestIds: over,
    });
    const row = await insertComputerAppSetupRequestInTransaction(transaction, {
      ...fields,
      ...taskFields(input.task),
      access: input.access,
    });
    return { row, settlement };
  }
  const covers =
    integrationAccessCovers(waiting.access, input.access) &&
    computerAppSetupRequestMatches(waiting, { ...fields, access: waiting.access });
  // The Mac's reviewer shows only approvals that name a task, so a Thread
  // joining one the picker opened would otherwise wait on a prompt that the
  // Mac never shows it.
  const joinsWithoutTask = input.task !== null && waiting.threadId === null;
  if (covers && !joinsWithoutTask) {
    return { row: waiting, settlement: emptyComputerAppAccessSettlement };
  }
  await deleteComputerAppSetupRequestsInTransaction(transaction, scope);
  // The prompt keeps naming the first task that asked, when one did.
  const row = await insertComputerAppSetupRequestInTransaction(transaction, {
    ...fields,
    ...(waiting.threadId === null
      ? taskFields(input.task)
      : {
          reason: waiting.reason,
          threadId: waiting.threadId,
          threadTitle: waiting.threadTitle,
        }),
    access: widerIntegrationAccess(waiting.access, input.access),
  });
  await relinkComputerAppAccessRequestsInTransaction(transaction, { from: waiting.id, to: row.id });
  return { row, settlement: emptyComputerAppAccessSettlement };
}

function taskFields(task: ComputerAppApprovalTask | null) {
  return {
    reason: task?.reason ?? null,
    threadId: task?.threadId ?? null,
    threadTitle: task?.threadTitle ?? null,
  };
}

/**
 * Declines every Request waiting on these approvals.
 *
 * Only a person's answer reaches this: the approvals were cancelled,
 * refused, left to expire, or taken back with the app or the Mac.
 */
export async function declineComputerAppAccessRequestsInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly setupRequestIds: readonly string[];
    readonly settlementActor?: RequestSettlementProvenance | null;
  },
): Promise<ComputerAppAccessSettlement> {
  const requestEvents: AgentEvent[] = [];
  const requestIds: RequestId[] = [];
  for (const row of await linkedPendingRequests(transaction, input.setupRequestIds)) {
    const resolved = await resolveComputerAppAccessRequest(
      transaction,
      row,
      null,
      input.settlementActor,
    );
    if (!resolved) continue;
    requestEvents.push(...resolved.events);
    requestIds.push(resolved.requestId);
  }
  return { grants: [], requestEvents, requestIds };
}

/** The connection an approval produced or a change left, as a settlement reads it. */
export interface SettledComputerConnection {
  readonly access: IntegrationAccess;

  readonly alias: string;
  /** The full identity the connection now holds, which a waiting approval must name. */
  readonly app: ComputerAppIdentity | null;
  /** The catalog digest this change was made under, which a waiting approval must share. */
  readonly definitionDigest: string;
  readonly connectionId: IntegrationConnectionId;
  readonly installationId: IntegrationInstallationId;
  readonly ownerUserId: UserId;
}

export async function settleComputerAppApprovalInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly alsoGrant?: { readonly access: IntegrationAccess };
    readonly additionalRequestIds: readonly RequestId[];
    readonly settlementActor?: RequestSettlementProvenance | null;
    readonly connection: SettledComputerConnection;
    readonly consumedSetupRequestId: string | null;
    readonly reissueWaiting: boolean;
    readonly scope: ComputerAppScope;
  },
): Promise<ComputerAppAccessSettlement & { readonly reissuedSetupRequestId: string | null }> {
  const { connection } = input;
  const waiting = await lockComputerAppSetupRequestInTransaction(transaction, input.scope);
  const requestEvents: AgentEvent[] = [];
  const requestIds: RequestId[] = [];
  let wanted: IntegrationAccess | null = input.alsoGrant?.access ?? null;
  const want = (access: IntegrationAccess) => {
    wanted = wanted ? widerIntegrationAccess(wanted, access) : access;
  };
  const waitingRequests = waiting
    ? await transaction
        .selectFrom("requests")
        .selectAll()
        .where("kind", "=", "computer.app.access")
        .where("status", "=", "pending")
        .where(sql<string>`payload->>'setupRequestId'`, "=", waiting.id)
        .orderBy("id", "asc")
        .execute()
    : [];
  const grantCandidates =
    waiting &&
    waiting.ownerUserId === connection.ownerUserId &&
    computerAppIdentitiesEqual(waiting.app, connection.app) &&
    waiting.definitionDigest === connection.definitionDigest
      ? waitingRequests
      : [];
  for (const row of grantCandidates) {
    const request = requestFromRow(row);
    if (
      request.payload.kind !== "computer.app.access" ||
      request.requestedBy !== connection.ownerUserId ||
      !integrationAccessCovers(connection.access, request.payload.access)
    )
      continue;
    await assertPersonalOwner(transaction, request.requestedBy);
    want(request.payload.access);
  }
  const grants: IntegrationGrant[] = [];
  if (wanted)
    grants.push(
      await grantComputerAppInTransaction(transaction, { ...connection, access: wanted }),
    );
  // Linked computer access and personal integration access settle together. Fence
  // their complete Request set in one order after personal grants.
  const requestIdsToLock = [
    ...new Set([...waitingRequests.map(({ id }) => id), ...input.additionalRequestIds]),
  ];
  if (requestIdsToLock.length > 0) {
    await transaction
      .selectFrom("requests")
      .select("id")
      .where("id", "in", requestIdsToLock)
      .orderBy("id", "asc")
      .forNoKeyUpdate()
      .execute();
  }
  let reissuedSetupRequestId: string | null = null;
  if (waiting && waiting.ownerUserId !== connection.ownerUserId) {
    // Another owner's approval is over: nobody who could answer it is left.
    await deleteComputerAppSetupRequestsInTransaction(transaction, input.scope);
    const declined = await declineComputerAppAccessRequestsInTransaction(transaction, {
      setupRequestIds: [waiting.id],
    });
    requestEvents.push(...declined.requestEvents);
    requestIds.push(...declined.requestIds);
  } else if (waiting) {
    // An approval for another identity of this app — re-signed, renamed — or
    // for another catalog digest is a question about something this
    // connection is not, so it stays waiting with every Request on it.
    const compatible =
      computerAppIdentitiesEqual(waiting.app, connection.app) &&
      waiting.definitionDigest === connection.definitionDigest;
    for (const row of compatible ? await linkedPendingRequests(transaction, [waiting.id]) : []) {
      const request = requestFromRow(row);
      if (request.payload.kind !== "computer.app.access") continue;
      if (request.requestedBy !== connection.ownerUserId) continue;
      if (!integrationAccessCovers(connection.access, request.payload.access)) continue;
      await assertPersonalOwner(transaction, request.requestedBy);
      const resolved = await resolveComputerAppAccessRequest(
        transaction,
        row,
        connection.connectionId,
        input.settlementActor,
      );
      if (!resolved) continue;
      requestEvents.push(...resolved.events);
      requestIds.push(resolved.requestId);
    }
    const usedUp =
      waiting.id === input.consumedSetupRequestId ||
      (compatible && integrationAccessCovers(connection.access, waiting.access));
    if (usedUp) {
      await deleteComputerAppSetupRequestsInTransaction(transaction, input.scope);
    } else if (input.reissueWaiting) {
      await deleteComputerAppSetupRequestsInTransaction(transaction, input.scope);
      const reissued = await insertComputerAppSetupRequestInTransaction(transaction, {
        access: waiting.access,
        app: waiting.app,
        definitionDigest: waiting.definitionDigest,
        definitionId: waiting.definitionId,
        now: new Date(),
        ownerUserId: waiting.ownerUserId,
        reason: waiting.reason,
        runnerId: waiting.runnerId,
        threadId: waiting.threadId,
        threadTitle: waiting.threadTitle,
      });
      await relinkComputerAppAccessRequestsInTransaction(transaction, {
        from: waiting.id,
        to: reissued.id,
      });
      reissuedSetupRequestId = reissued.id;
    }
  }
  return { grants, reissuedSetupRequestId, requestEvents, requestIds };
}

async function grantComputerAppInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: SettledComputerConnection,
): Promise<IntegrationGrant> {
  await lockIntegrationGrantScopeInTransaction(transaction, input);
  const existing = await activeIntegrationGrantInTransaction(transaction, input);
  return writeIntegrationGrantInTransaction(transaction, {
    access: existing ? widerIntegrationAccess(existing.access, input.access) : input.access,
    alias: existing?.alias ?? input.alias,
    connectionId: input.connectionId,
    createdBy: input.ownerUserId,
    installationId: input.installationId,
    isDefault: existing?.isDefault ?? false,
    ownerUserId: input.ownerUserId,
    providerAuthorizations: {},
  });
}

async function linkedPendingRequests(
  transaction: Transaction<DatabaseSchema>,
  setupRequestIds: readonly string[],
): Promise<readonly RequestRow[]> {
  if (setupRequestIds.length === 0) return [];
  const pending = transaction
    .selectFrom("requests")
    .selectAll()
    .where("kind", "=", "computer.app.access")
    .where("status", "=", "pending")
    .where(sql<string>`payload->>'setupRequestId'`, "in", [...setupRequestIds])
    .orderBy("id", "asc");
  return pending.forNoKeyUpdate().execute();
}

async function resolveComputerAppAccessRequest(
  transaction: Transaction<DatabaseSchema>,
  row: RequestRow,
  connectionId: IntegrationConnectionId | null,
  settlementActor?: RequestSettlementProvenance | null,
): Promise<{ readonly events: readonly AgentEvent[]; readonly requestId: RequestId } | null> {
  const observed = requestFromRow(row);
  const now = new Date();
  const resolvedRow = await transaction
    .updateTable("requests")
    .set({
      settlementProvenance: settlementActor ? jsonValue(settlementActor) : null,
      resolvedAt: now,
      resolvedBy: observed.requestedBy,
      response: jsonValue(
        connectionId
          ? { kind: "external", value: { connectionId, decision: "fulfilled" } }
          : { kind: "external", value: { decision: "declined" } },
      ),
      responseCommandId: null,
      status: connectionId ? "fulfilled" : "declined",
    })
    .where("id", "=", observed.id)
    .where("status", "=", "pending")
    .returningAll()
    .executeTakeFirst();
  if (!resolvedRow) return null;
  const request = ResolvedRequestSchema.parse(requestFromRow(resolvedRow));
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
  const event = await appendHostDeploymentEvent(transaction, {
    data: { request },
    environmentId: await requestOriginEnvironment(transaction, request),
    runId: request.originatingRunId,
    threadId: request.originatingThreadId,
    type: "request.resolved",
  });
  return {
    events: [
      event,
      ...(request.originatingRunId
        ? await assignmentActivityEventsForRun(transaction, request.originatingRunId)
        : []),
    ],
    requestId: request.id,
  };
}

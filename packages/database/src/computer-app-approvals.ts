import { machineOwnershipIn } from "./machine-ownership.js";
import { lockRequestWorkspaces } from "./request-workspace-locks.js";
import {
  OpensteerError,
  type AgentEvent,
  type RequestId,
  type RunnerId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import { verifyComputerAppApproval } from "@opensteer/runner-auth";
import {
  computerAppIdentitiesEqual,
  integrationAccessCovers,
  widerIntegrationAccess,
  type ComputerAppApproval,
  type ComputerAppIdentity,
  type ComputerAppSetupRequest,
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
import { appendHostWorkspaceEvent } from "./workspace-events.js";

/*
 * One app on one Mac has at most one waiting approval, and every
 * `computer.app.access` Request that is waiting for that app names it. This
 * module is the only place those Requests are answered, so the rules live in
 * one spot:
 *
 * - Only a person declines: `Don't allow`, a decline from any client, a
 *   cancellation, the week running out, or removing the app or the Mac.
 * - A connection that appears or changes answers the Requests its access
 *   covers and leaves a wider approval, and the Threads waiting on it,
 *   waiting.
 * - A Workspace's grant is the widest access among the Requests answered for
 *   it, and an answer never lowers a grant it already holds; only an explicit
 *   edit does that.
 *
 * Every function here expects the caller to hold that Mac's approval scope,
 * taken after the complete Request Workspace set by `lockComputerApprovalScopeInTransaction`.
 */

/** The Mac's approvals plus integration access its owners' connections can settle. */
export async function discoverComputerRequestWorkspaces(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<readonly WorkspaceId[]> {
  const ownership = await machineOwnershipIn(database, runnerId);
  const connections = await database
    .selectFrom("integrationConnections")
    .select("ownerUserId")
    .distinct()
    .where("runnerId", "=", runnerId)
    .where("connectionKind", "=", "computer")
    .execute();
  const owners = [
    ...new Set([
      ...(ownership?.effectiveOwner ? [ownership.effectiveOwner] : []),
      ...connections.map(({ ownerUserId }) => ownerUserId),
    ]),
  ];
  const waiting = await database
    .selectFrom("requests")
    .select(["originatingWorkspaceId", "targetWorkspaceId"])
    .distinct()
    .where("status", "=", "pending")
    .where((eb) =>
      eb.or([
        eb.and([
          eb("kind", "=", "computer.app.access"),
          eb(sql<string>`payload->>'runnerId'`, "=", runnerId),
        ]),
        ...(owners.length === 0
          ? []
          : [eb.and([eb("kind", "=", "integration.access"), eb("requestedBy", "in", owners)])]),
      ]),
    )
    .execute();
  return waiting.flatMap((row) => [row.originatingWorkspaceId, row.targetWorkspaceId]);
}

/** Locks the complete Request Workspace set before the Mac's approval fence. */
export async function lockComputerApprovalScopeInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly runnerId: RunnerId;
    /** A Workspace this mutation writes that no waiting Request names yet. */
    readonly workspaceIds?: readonly WorkspaceId[];
  },
): Promise<{
  readonly id: RunnerId;
  readonly name: string;
  readonly revokedAt: Date | null;
}> {
  const discover = async () => [
    ...(input.workspaceIds ?? []),
    ...(await discoverComputerRequestWorkspaces(transaction, input.runnerId)),
  ];
  await lockRequestWorkspaces(transaction, await discover());
  const runner = await transaction
    .selectFrom("runners")
    .select(["id", "name", "revokedAt"])
    .where("id", "=", input.runnerId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!runner) throw new OpensteerError({ code: "not_found", message: "Computer not found" });
  // A new ask may have committed while the Workspace or Mac fence was waiting.
  // Request a rollback with the larger set before touching its Request or grant.
  await lockRequestWorkspaces(transaction, await discover());
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

/** The approval key registered for one Mac, as its owner registered it. */
export interface ComputerUseApprovalKey {
  readonly keyId: string;
  readonly ownerUserId: UserId;
  readonly publicKeyPem: string;
}

export async function computerUseApprovalKeyInTransaction(
  database: Kysely<DatabaseSchema>,
  runnerId: RunnerId,
): Promise<ComputerUseApprovalKey | null> {
  const row = await database
    .selectFrom("computerUseApprovalKeys")
    .select(["keyId", "ownerUserId", "publicKeyPem"])
    .where("runnerId", "=", runnerId)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Whether this approval is the person's answer on that Mac.
 *
 * Only the desktop's approval key, registered for this Mac by the same person
 * who owns the request, is accepted. The Runner's own key never is: any process
 * running as the person can read it, so a signature by it proves a process,
 * not a person. With no key registered nothing is accepted, and the sentence
 * says how to register one.
 */
export async function assertComputerAppApprovalInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly approval: ComputerAppApproval;
    readonly decision?: "allow" | "deny";
    readonly now: Date;
    readonly ownerUserId: UserId;
    readonly refusal: string;
    readonly request: ComputerAppSetupRequest | null;
    readonly runnerId: RunnerId;
  },
): Promise<ComputerAppSetupRequest> {
  const key = await computerUseApprovalKeyInTransaction(transaction, input.runnerId);
  if (!key || key.ownerUserId !== input.ownerUserId) {
    const runner = await transaction
      .selectFrom("runners")
      .select("deviceProfile")
      .where("id", "=", input.runnerId)
      .executeTakeFirstOrThrow();
    throw new OpensteerError({
      code: "forbidden",
      message:
        runner.deviceProfile === "iphone"
          ? "This iPhone cannot approve apps yet. Open Opensteer on this iPhone to finish setup, then try again."
          : computerUseApprovalKeyMissingMessage,
    });
  }

  if (
    !input.request ||
    !verifyComputerAppApproval({
      approval: input.approval,
      ...(input.decision === undefined ? {} : { decision: input.decision }),
      now: input.now.getTime(),
      publicKey: key.publicKeyPem,
      request: input.request,
    })
  ) {
    throw new OpensteerError({ code: "forbidden", message: input.refusal });
  }
  return input.request;
}

export const computerUseApprovalKeyMissingMessage =
  "This Mac cannot approve apps yet. Open this Mac's page in Opensteer on the Mac to finish setting up computer use, then try again.";

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
  readonly workspaceId: WorkspaceId;
}

/**
 * The one way anything asks for an app on a Mac: a task through
 * `integration_request`, the picker, and unblocking all come here.
 *
 * A waiting approval that already covers the ask is joined. Anything else
 * replaces it under a new id — wider access, the app as the Mac now resolves
 * it, a new catalog digest, or a Thread joining an approval no Thread carries
 * — and every Request waiting on the old one moves to the new one. A new id
 * is what makes a signature taken over the old approval consume nothing,
 * which matters for a Thread joining too: the signature covers the task the
 * panel named. Nothing is declined by a replacement. Only an approval that is
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
          workspaceId: waiting.workspaceId,
          workspaceName: waiting.workspaceName,
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
    workspaceId: task?.workspaceId ?? null,
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
  input: { readonly setupRequestIds: readonly string[] },
): Promise<ComputerAppAccessSettlement> {
  const requestEvents: AgentEvent[] = [];
  const requestIds: RequestId[] = [];
  for (const row of await linkedPendingRequests(transaction, input.setupRequestIds)) {
    const resolved = await resolveComputerAppAccessRequest(transaction, row, null);
    if (!resolved) continue;
    requestEvents.push(...resolved.events);
    requestIds.push(resolved.requestId);
  }
  return { grants: [], requestEvents, requestIds };
}

/** The connection an approval produced or a change left, as a settlement reads it. */
export interface SettledComputerConnection {
  readonly access: IntegrationAccess;
  /** The grant's name in a Workspace: the app, as the Mac named it. */
  readonly alias: string;
  /** The full identity the connection now holds, which a waiting approval must name. */
  readonly app: ComputerAppIdentity | null;
  /** The catalog digest this change was made under, which a waiting approval must share. */
  readonly definitionDigest: string;
  readonly connectionId: IntegrationConnectionId;
  readonly installationId: IntegrationInstallationId;
  readonly ownerUserId: UserId;
}

/**
 * Answers what a connection that was just created or changed now covers.
 *
 * Every `computer.app.access` Request waiting on this app's approval whose
 * access the connection covers is fulfilled — but only when the connection is
 * the app that approval names, under the catalog it was issued under: a
 * change that kept an older identity (an unsigned same-access edit, or an
 * automatic grant on the connection as it is) answers nothing an approval for
 * the app as the Mac now resolves it is waiting for, and each specialized Workspace
 * among them gets the widest access its Requests asked for, never less than
 * a grant it already holds. The approval itself is used up when it was the
 * one consumed or when the connection covers all of it; otherwise it keeps
 * waiting with the Requests it still owes an answer. `reissueWaiting` gives
 * that remaining approval a new id — for an explicit reduction, after which
 * no signature taken over the wider approval may widen the app back.
 * `alsoGrant` is the automatic ask's own Workspace, which has no Request.
 */
export async function settleComputerAppApprovalInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly alsoGrant?: { readonly access: IntegrationAccess; readonly workspaceId: WorkspaceId };
    readonly additionalRequestIds: readonly RequestId[];
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
  const wanted = new Map<WorkspaceId, IntegrationAccess>();
  const want = (workspaceId: WorkspaceId, access: IntegrationAccess) => {
    const held = wanted.get(workspaceId);
    wanted.set(workspaceId, held ? widerIntegrationAccess(held, access) : access);
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
    const workspace = await transaction
      .selectFrom("workspaces")
      .select(["kind", "status"])
      .where("id", "=", request.targetWorkspaceId)
      .where("createdBy", "=", request.requestedBy)
      .executeTakeFirst();
    if (workspace?.status === "ready" && workspace.kind !== "main")
      want(request.targetWorkspaceId, request.payload.access);
  }
  if (input.alsoGrant) want(input.alsoGrant.workspaceId, input.alsoGrant.access);
  const grants: IntegrationGrant[] = [];
  for (const [workspaceId, access] of [...wanted].sort(([a], [b]) => a.localeCompare(b))) {
    grants.push(
      await grantComputerAppWorkspaceInTransaction(transaction, {
        ...connection,
        access,
        workspaceId,
      }),
    );
  }
  // Linked computer access and Main integration access settle together. Fence
  // their complete Request set in one order after all Workspace grants.
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
      const workspace = await transaction
        .selectFrom("workspaces")
        .select(["kind", "status"])
        .where("id", "=", request.targetWorkspaceId)
        .where("createdBy", "=", request.requestedBy)
        .executeTakeFirst();
      // A Workspace that went away while the Mac was being approved leaves
      // nothing to grant into; the Request is cancelled by its own authority
      // path rather than fulfilled against a Workspace that cannot hold a grant.
      if (!workspace || workspace.status !== "ready") continue;
      const resolved = await resolveComputerAppAccessRequest(
        transaction,
        row,
        connection.connectionId,
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
        workspaceId: waiting.workspaceId,
        workspaceName: waiting.workspaceName,
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

/**
 * A Workspace's grant on an approved app, which an approval only ever widens.
 *
 * Two Threads of one Workspace asking for Notes, one to control it and one to
 * look, must leave that Workspace able to control it however the answers are
 * ordered; lowering a grant is the explicit edit's job, not an approval's.
 */
async function grantComputerAppWorkspaceInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: SettledComputerConnection & { readonly workspaceId: WorkspaceId },
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
    workspaceId: input.workspaceId,
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
  await lockRequestWorkspaces(
    transaction,
    (await pending.execute()).flatMap((row) => [row.originatingWorkspaceId, row.targetWorkspaceId]),
  );
  return pending.forNoKeyUpdate().execute();
}

/**
 * Gives one Request its terminal state, its continuation and the workspace
 * event an `integration.access` answer gets, because the Thread is waiting on
 * exactly the same kind of news. A null connection declines.
 */
async function resolveComputerAppAccessRequest(
  transaction: Transaction<DatabaseSchema>,
  row: RequestRow,
  connectionId: IntegrationConnectionId | null,
): Promise<{ readonly events: readonly AgentEvent[]; readonly requestId: RequestId } | null> {
  const observed = requestFromRow(row);
  const now = new Date();
  const resolvedRow = await transaction
    .updateTable("requests")
    .set({
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
  const request = requestFromRow(resolvedRow);
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
  const event = await appendHostWorkspaceEvent(transaction, {
    data: { request },
    environmentId: await requestOriginEnvironment(transaction, request),
    runId: request.originatingRunId,
    threadId: request.originatingThreadId,
    type: "request.resolved",
    workspaceId: request.originatingWorkspaceId,
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

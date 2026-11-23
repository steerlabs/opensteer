import { lockComputerApprovalRequestThreads } from "./computer-app-setup.js";
import { isPhoneDisplayDefinitionId, type DeviceId } from "@opensteer/core";
import { deviceOwnershipIn } from "./machine-ownership.js";
import { computerConnectionDeviceId } from "./integration-connections.js";
import { readRequestSettlementActor, requestSettlementActor } from "./request-settlement.js";

import { assertPersonalOwner } from "./private-resource-owner.js";
import { jsonValue } from "./store-primitives.js";
import {
  type ComputerAppIdentity,
  ComputerAppIdentitySchema,
  IntegrationConnectionRequirementSchema,
  IntegrationDefinitionSummarySchema,
  IntegrationServerSchema,
  type IntegrationToolMaterial,
  createIntegrationId,
  type IntegrationConnectionId,
  type DeviceIntegrationConnectionSummary as IntegrationConnectionSummary,
  type IntegrationAccess,
  type IntegrationGrant,
  type IntegrationDefinitionSummary,
  type IntegrationInstallationId,
  type IntegrationServerId,
  computerAppIdentitiesEqual,
} from "@opensteer/integration-core";
import { integrationAccessCovers } from "@opensteer/integration-core/access";
import { computerAppApprovalChangedReason } from "@opensteer/integration-core/computer-app-setup";
import { OpensteerError, createId, type RequestId, type UserId } from "@opensteer/core";
import { outsideName } from "@opensteer/shared/outsideName";
import { type Selectable, type Transaction, sql } from "kysely";
import type { DatabaseSchema, IntegrationConnectionTable } from "./schema.js";
import {
  fulfillPendingIntegrationAccessRequestsInTransaction,
  pendingIntegrationAccessRequests,
} from "./integration-request-fulfillment.js";
import { getDeviceSelfRunnerId } from "./device-inventory-store.js";
import { integrationConnectionFromRow } from "./integration-connections.js";
import {
  computerAppScopeOf,
  computerAppSetupRequestFromRow,
  type ComputerAppScope,
} from "./computer-app-setup.js";
import {
  lockComputerApprovalScopeInTransaction,
  settleComputerAppApprovalInTransaction,
} from "./computer-app-approvals.js";
import { upsertConnectionTools } from "./integration-platform-stores.js";

export interface SetComputerConnectionInput {
  readonly settlementSessionId?: string | undefined;
  readonly setupRequestId?: string;
  readonly definitionDigest: string;
  readonly access: IntegrationAccess;
  readonly actorUserId: UserId;
  readonly app: ComputerAppIdentity | null;
  readonly createIfMissing: boolean;
  readonly definitionId: string;
  readonly requestId: string;
  readonly deviceId: DeviceId;
  readonly tools: (connectionId: IntegrationConnectionId) => readonly IntegrationToolMaterial[];
}

export interface SetComputerConnectionResult {
  readonly connection: IntegrationConnectionSummary;
  readonly created: boolean;
  readonly grants: readonly IntegrationGrant[];
  readonly fulfilledRequestIds: readonly RequestId[];
  /**
   * A wider approval this change left waiting under a new id, which the Mac
   * has to be asked about again.
   */
  readonly reissuedSetupRequestId: string | null;

  /**
   * The live session this change ended, if any: the one holding this app on a
   * Mac, or the one holding a phone's display. Null for a change that left
   * every session's authority as it was.
   */
  readonly sessionReset:
    | { readonly appKey: string; readonly kind: "app"; readonly deviceId: DeviceId }
    | { readonly definitionId: string; readonly kind: "display"; readonly deviceId: DeviceId }
    | null;
}

/** A valid owner tried to create an app connection the computer is not offering live. */
export class ComputerAppNotOfferedError extends Error {
  readonly runnerName: string;

  constructor(runnerName: string) {
    super("Computer app is not offered by this Runner");
    this.name = "ComputerAppNotOfferedError";
    this.runnerName = runnerName;
  }
}

export type AutomaticComputerAppApprovalInput = Omit<
  SetComputerConnectionInput,
  "setupRequestId" | "createIfMissing"
> & {};

export interface LockedComputer {
  readonly id: DeviceId;
  readonly name: string;
}

/** The computer's fence, taken after deployment events, and the owner check under it. */
export async function lockComputerOwnerInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorUserId: UserId;
    readonly deviceId: DeviceId;
  },
): Promise<LockedComputer> {
  const runner = await lockComputerApprovalScopeInTransaction(transaction, {
    deviceId: input.deviceId,
  });
  if (runner.removedAt !== null) {
    throw new OpensteerError({ code: "not_found", message: "Computer not found" });
  }
  const ownership = await deviceOwnershipIn(transaction, runner.id);
  if (ownership?.effectiveOwner !== input.actorUserId) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Only the person who added this computer can turn its apps on.",
    });
  }
  return runner;
}

/** Where a computer app's connection lives, and the row it has now, locked. */
export interface ComputerConnectionTarget {
  readonly current: Selectable<IntegrationConnectionTable> | undefined;
  readonly definition: IntegrationDefinitionSummary;
  readonly installed: {
    readonly installationId: IntegrationInstallationId;
    readonly serverId: IntegrationServerId;
    readonly toolGeneration: number;
  };
  readonly scope: ComputerAppScope;
}

export async function computerConnectionTargetInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly app: ComputerAppIdentity | null;
    readonly definitionId: string;
    readonly deviceId: DeviceId;
  },
): Promise<ComputerConnectionTarget> {
  const installedRows = await transaction
    .selectFrom("integrationInstallations")
    .innerJoin(
      "integrationServers",
      "integrationServers.installationId",
      "integrationInstallations.id",
    )
    .select([
      "integrationInstallations.id as installationId",
      "integrationInstallations.manifest",
      "integrationInstallations.title",
      "integrationServers.connectionRequirement",
      "integrationServers.id as serverId",
      "integrationServers.toolGeneration",
      "integrationServers.transport",
    ])
    .where("integrationInstallations.status", "=", "active")
    .where("integrationServers.status", "=", "active")
    .where(
      sql<boolean>`integration_installations.manifest -> 'definition' ->> 'id' = ${input.definitionId}`,
    )
    .orderBy("integrationServers.id", "asc")
    .forNoKeyUpdate("integrationServers")
    .execute();
  const installed = installedRows.find((row) => {
    const transport = IntegrationServerSchema.shape.transport.safeParse(row.transport);
    const requirement = IntegrationConnectionRequirementSchema.safeParse(row.connectionRequirement);
    return (
      transport.success &&
      transport.data.type === "computer" &&
      transport.data.definitionId === input.definitionId &&
      requirement.success &&
      requirement.data.kind === "computer" &&
      requirement.data.definitionId === input.definitionId
    );
  });
  if (!installed) {
    const known = await transaction
      .selectFrom("integrationInstallations")
      .select("title")
      .where(
        sql<boolean>`integration_installations.manifest -> 'definition' ->> 'id' = ${input.definitionId}`,
      )
      .orderBy("createdAt", "asc")
      .executeTakeFirst();
    throw new OpensteerError({
      code: "not_found",
      message: `${known?.title ?? input.definitionId} is not installed`,
    });
  }
  const parsed = IntegrationDefinitionSummarySchema.safeParse(installed.manifest.definition);
  if (!parsed.success)
    throw new OpensteerError({
      cause: parsed.error,
      code: "bad_request",
      reason: "computer-app-installation-invalid",
      message:
        "The Host couldn't read this app's installation. Check for an Opensteer update on the Host.",
    });
  const definition = parsed.data;
  if (definition.adapter !== "computer") {
    throw new OpensteerError({ code: "not_found", message: `${definition.name} is not installed` });
  }
  assertComputerAppPresence({
    app: input.app,
    requiresApp: definition.computerApp?.kind === "gui",
  });
  const device = await transaction
    .selectFrom("devices")
    .select("platform")
    .where("id", "=", input.deviceId)
    .executeTakeFirstOrThrow();
  const selfRunnerId = await getDeviceSelfRunnerId(transaction, input.deviceId);
  const runner = selfRunnerId
    ? await transaction
        .selectFrom("runners")
        .select("moduleDescriptors")
        .where("id", "=", selfRunnerId)
        .executeTakeFirst()
    : undefined;
  const platform =
    runner?.moduleDescriptors.integrations?.platform ??
    (device.platform === "macos" ? "darwin" : device.platform);
  if (
    platform &&
    !definition.computerApp?.platforms.includes(platform === "windows" ? "win32" : platform)
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "This app is not supported on this device.",
    });
  const scope = computerAppScopeOf(input);
  const current = await transaction
    .selectFrom("integrationConnections")
    .selectAll()
    .where("connectionKind", "=", "computer")
    .where("integrationDefinitionId", "=", input.definitionId)
    .where(computerConnectionDeviceId, "=", input.deviceId)
    .where("computerAppKey", scope.appKey === null ? "is" : "=", scope.appKey)
    .where("status", "!=", "revoked")
    .forNoKeyUpdate()
    .executeTakeFirst();
  return {
    current,
    definition,
    installed: {
      installationId: installed.installationId,
      serverId: installed.serverId,
      toolGeneration: installed.toolGeneration,
    },
    scope,
  };
}

async function pendingComputerConnectionRequestThreads(
  tx: Transaction<DatabaseSchema>,
  target: ComputerConnectionTarget,
  ownerId: UserId,
) {
  const rows = await tx
    .selectFrom("requests")
    .innerJoin("integrationRequestDetails", "integrationRequestDetails.requestId", "requests.id")
    .select("requests.originatingThreadId")
    .distinct()
    .where("requests.kind", "=", "integration.access")
    .where("requests.status", "=", "pending")
    .where("requests.requestedBy", "=", ownerId)
    .where("integrationRequestDetails.installationId", "=", target.installed.installationId)
    .where((eb) =>
      eb.or([
        eb("integrationRequestDetails.requestedConnectionId", "is", null),
        ...(target.current
          ? [eb("integrationRequestDetails.requestedConnectionId", "=", target.current.id)]
          : []),
      ]),
    )
    .execute();
  return rows.map(({ originatingThreadId }) => originatingThreadId);
}

export function storedComputerApp(
  row: Selectable<IntegrationConnectionTable> | undefined,
): ComputerAppIdentity | null {
  return row?.computerApp === null || row?.computerApp === undefined
    ? null
    : ComputerAppIdentitySchema.parse(row.computerApp);
}

/**
 * Consumes one owner-approved request: the only way a Mac connection is created, widened
 * or unblocked. The approval is one row, so consuming it invalidates every
 * other answer for this app — and only for this app: consuming Notes leaves
 * Calendar's approval, and the Thread waiting on it, where it was.
 */
export async function consumeComputerAppApprovalInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: SetComputerConnectionInput & {
    readonly setupRequestId: string;
    readonly runner: LockedComputer;
    readonly target: ComputerConnectionTarget;
  },
): Promise<SetComputerConnectionResult> {
  const { current, scope } = input.target;
  if (!current && !input.createIfMissing) throw new ComputerAppNotOfferedError(input.runner.name);
  const widened = current?.computerAccess === "read" && input.access === "read-write";
  if (widened && !input.createIfMissing) throw new ComputerAppNotOfferedError(input.runner.name);
  const now = new Date();
  await lockComputerApprovalRequestThreads(
    transaction,
    [input.setupRequestId],
    await pendingComputerConnectionRequestThreads(transaction, input.target, input.actorUserId),
  );
  const pending = await transaction
    .selectFrom("computerAppSetupRequests")
    .selectAll()
    .where("id", "=", input.setupRequestId)
    .where("runnerId", "=", input.deviceId)
    .where("ownerUserId", "=", input.actorUserId)
    .where("definitionId", "=", input.definitionId)
    .where("kind", "=", "app")
    .where("access", "=", input.access)
    .where("definitionDigest", "=", input.definitionDigest)
    // One pending decision cannot authorize another app on the same computer.
    .where("appKey", scope.appKey === null ? "is" : "=", scope.appKey)
    .where("expiresAt", ">", now)
    // FOR UPDATE: Consuming the app approval deletes this setup request.
    .forUpdate()
    .executeTakeFirst();
  const candidate = pending ? computerAppSetupRequestFromRow(pending) : null;
  if (!candidate || !computerAppIdentitiesEqual(candidate.app, input.app)) {
    throw new OpensteerError({
      code: "forbidden",
      reason: computerAppApprovalChangedReason,
      message: "This approval changed or is no longer waiting.",
    });
  }
  const pendingRequest = candidate;
  const row = await writeComputerConnectionInTransaction(transaction, {
    access: input.access,
    app: pendingRequest.app,
    now,
    ownerUserId: input.actorUserId,
    runner: input.runner,
    target: input.target,
  });
  const changed = await finishComputerConnectionChangeInTransaction(transaction, {
    ...input,
    actorSessionId: input.settlementSessionId,
    recordProvenance: true,
    connectionAccess: input.access,
    consumedSetupRequestId: pendingRequest.id,
    created: current === undefined,
    now,
    reissueWaiting: false,
    row,
    tools: input.tools(row.id),
    widened,
  });
  return {
    ...changed,
    sessionReset: sessionResetFor(current, pendingRequest.app, input.access, input.target),
  };
}

/**
 * The owner setting a phone's access, or keeping or lowering a Mac app's access.
 * A lower access leaves a wider waiting approval under a new id, so an answer
 * to the request before the reduction cannot widen the app back behind the owner's back.
 */
export async function reviseComputerConnectionInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: SetComputerConnectionInput & {
    readonly runner: LockedComputer;
    readonly target: ComputerConnectionTarget;
  },
): Promise<SetComputerConnectionResult> {
  const { current } = input.target;
  if (!current && !input.createIfMissing) throw new ComputerAppNotOfferedError(input.runner.name);
  const widened = current?.computerAccess === "read" && input.access === "read-write";
  if (widened && !input.createIfMissing) throw new ComputerAppNotOfferedError(input.runner.name);
  if (
    !isPhoneDisplayDefinitionId(input.definitionId) &&
    (!current || widened || current.computerBlockedAt)
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Approve this access in Opensteer on the computer that provides the app.",
    });
  }
  const now = new Date();
  const app = storedComputerApp(current);
  const row = await writeComputerConnectionInTransaction(transaction, {
    access: input.access,
    app,
    now,
    ownerUserId: input.actorUserId,
    runner: input.runner,
    target: input.target,
  });
  const changed = await finishComputerConnectionChangeInTransaction(transaction, {
    ...input,
    connectionAccess: input.access,
    consumedSetupRequestId: null,
    actorSessionId: input.settlementSessionId,
    recordProvenance: !(current?.computerAccess === "read-write" && input.access === "read"),
    created: current === undefined,
    now,
    reissueWaiting: current?.computerAccess === "read-write" && input.access === "read",
    row,
    tools: input.tools(row.id),
    widened,
  });
  return { ...changed, sessionReset: sessionResetFor(current, app, input.access, input.target) };
}

/**
 * Approves an app under the owner's automatic policy: a new connection with
 * the asked access, or a grant on an existing one that already covers the
 * ask. It never widens or re-identifies an existing connection; that is
 * always a prompt on the Mac.
 *
 * The caller holds the Mac's row and has read the policy under that lock, so
 * the decision and this write are one.
 */
export async function approveComputerAppAutomaticallyInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: AutomaticComputerAppApprovalInput & { readonly runner: LockedComputer },
): Promise<SetComputerConnectionResult> {
  const target = await computerConnectionTargetInTransaction(transaction, input);
  const { current } = target;
  const app = input.app;
  if (app === null || target.definition.computerApp?.kind !== "gui") {
    throw new OpensteerError({
      code: "forbidden",
      message: "Automatic app approval is not enabled on this Mac.",
    });
  }
  if (current?.computerBlockedAt) {
    throw new OpensteerError({
      code: "forbidden",
      message: `${app.displayName} is blocked on ${input.runner.name}. The owner can unblock it from any Opensteer app.`,
    });
  }
  const connectionAccess = current?.computerAccess ?? input.access;
  if (
    current &&
    (!computerAppIdentitiesEqual(current.computerApp, app) ||
      !integrationAccessCovers(connectionAccess, input.access))
  ) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Approve this access in Opensteer on the computer that provides the app.",
    });
  }
  await assertPersonalOwner(transaction, input.actorUserId);
  const now = new Date();
  const row = await writeComputerConnectionInTransaction(transaction, {
    access: connectionAccess,
    app,
    now,
    ownerUserId: input.actorUserId,
    preservePolicyRevision: true,
    runner: input.runner,
    target,
  });
  const changed = await finishComputerConnectionChangeInTransaction(transaction, {
    ...input,
    actorSessionId: undefined,
    recordProvenance: false,
    alsoGrant: { access: input.access },
    connectionAccess,
    consumedSetupRequestId: null,
    created: current === undefined,
    now,
    reissueWaiting: false,
    row,
    target,
    // An existing connection keeps the tools its own approval gave it.
    tools: current ? null : input.tools(row.id),
    widened: false,
  });
  return { ...changed, sessionReset: null };
}

export async function writeComputerConnectionInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly access: IntegrationAccess;
    readonly app: ComputerAppIdentity | null;
    readonly now: Date;
    readonly ownerUserId: UserId;
    readonly preservePolicyRevision?: boolean;
    readonly runner: LockedComputer;
    readonly target: ComputerConnectionTarget;
  },
): Promise<Selectable<IntegrationConnectionTable>> {
  const { current, definition, installed, scope } = input.target;
  const appName = input.app ? outsideName(input.app.displayName, 255) || "App" : null;
  const values = {
    computerAccess: input.access,
    computerApp: input.app === null ? null : jsonValue(input.app),
    computerAppKey: scope.appKey,
    computerBlockedAt: null,
    displayName: appName === null ? input.runner.name : `${appName} on ${input.runner.name}`,
    integrationServerId: installed.serverId,
    provider: definition.provider,
    status: "connected" as const,
    statusDetail: null,
    updatedAt: input.now,
  };
  if (current) {
    return transaction
      .updateTable("integrationConnections")
      .set({
        ...values,
        ...(input.preservePolicyRevision
          ? {}
          : { computerPolicyRevision: sql`coalesce(computer_policy_revision, 0) + 1` }),
      })
      .where("id", "=", current.id)
      .where("connectionKind", "=", "computer")
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  return transaction
    .insertInto("integrationConnections")
    .values({
      ...values,
      accountIdentifier: null,
      capabilities: jsonValue([]),
      connectionKind: "computer",
      connectionMethod: "computer",
      credentialId: null,
      externalIdentityId: null,
      externalTenantId: null,
      id: createIntegrationId("connection"),
      integrationDefinitionId: scope.definitionId,
      ownerUserId: input.ownerUserId,
      deviceId: scope.deviceId,
      runnerId: await getDeviceSelfRunnerId(transaction, scope.deviceId),
      transportKind: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Everything a connection change owes after its row is written: the tools
 * its access exposes, the generation bump that makes callers re-read them,
 * the personal Requests it satisfies, the `computer.app.access` Requests it
 * answers, and the audit record — one transaction, exactly as an
 * `integration.access` answer is.
 */
export async function finishComputerConnectionChangeInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorSessionId: string | undefined;
    readonly recordProvenance: boolean;
    readonly access: IntegrationAccess;
    readonly actorUserId: UserId;
    readonly alsoGrant?: { readonly access: IntegrationAccess };
    readonly connectionAccess: IntegrationAccess;
    readonly consumedSetupRequestId: string | null;
    readonly created: boolean;
    readonly definitionDigest: string;
    readonly definitionId: string;
    readonly now: Date;
    readonly reissueWaiting: boolean;
    readonly requestId: string;
    readonly row: Selectable<IntegrationConnectionTable>;
    readonly target: ComputerConnectionTarget;
    /** Null keeps the tools the connection already has. */
    readonly tools: readonly IntegrationToolMaterial[] | null;
    readonly widened: boolean;
  },
): Promise<Omit<SetComputerConnectionResult, "sessionReset">> {
  const actor = await readRequestSettlementActor(
    transaction,
    input.actorUserId,
    input.actorSessionId,
  );
  const settlementActor = input.recordProvenance ? actor : null;
  const { installed, scope } = input.target;
  const connectionId = input.row.id;
  await transaction
    .updateTable("integrationServers")
    .set({ toolGeneration: installed.toolGeneration + 1, updatedAt: input.now })
    .where("id", "=", installed.serverId)
    .where("toolGeneration", "=", installed.toolGeneration)
    .executeTakeFirstOrThrow();
  const app = storedComputerApp(input.row);
  const pendingRequests =
    input.created || input.widened
      ? await pendingIntegrationAccessRequests(transaction, {
          access: input.connectionAccess,
          connectionId,
          installationId: installed.installationId,
          ownerUserId: input.actorUserId,
          serverId: installed.serverId,
        }).execute()
      : [];
  // Both Request kinds settle after the widest personal grant is written.
  const pendingAccess = pendingRequests.some(
    ({ requestedAccess }) => requestedAccess === "read-write",
  )
    ? "read-write"
    : pendingRequests.length > 0
      ? "read"
      : null;
  const grantAccess =
    input.alsoGrant?.access === "read-write" || pendingAccess === "read-write"
      ? "read-write"
      : (input.alsoGrant?.access ?? pendingAccess);
  const requestThreads = pendingRequests.map(({ originatingThreadId }) => originatingThreadId);
  await lockComputerApprovalRequestThreads(
    transaction,
    transaction
      .selectFrom("computerAppSetupRequests")
      .select("id")
      .where("kind", "=", scope.kind)
      .where("runnerId", "=", scope.deviceId)
      .where("definitionId", "=", scope.definitionId)
      .where("appKey", scope.appKey === null ? "is" : "=", scope.appKey),
    requestThreads,
  );
  const settlement = await settleComputerAppApprovalInTransaction(transaction, {
    settlementActor,
    additionalRequestIds: pendingRequests.map(({ id }) => id),
    ...(grantAccess ? { alsoGrant: { access: grantAccess } } : {}),
    connection: {
      access: input.connectionAccess,
      alias: app ? outsideName(app.displayName, 80) || "App" : input.row.displayName,
      app,
      definitionDigest: input.definitionDigest,
      connectionId,
      installationId: installed.installationId,
      ownerUserId: input.actorUserId,
    },
    consumedSetupRequestId: input.consumedSetupRequestId,
    reissueWaiting: input.reissueWaiting,
    scope,
  });
  if (input.created || input.widened) {
    await fulfillPendingIntegrationAccessRequestsInTransaction(transaction, {
      settlementActor,
      access: input.connectionAccess,
      connectionId,
      displayName: input.row.displayName,
      installationId: installed.installationId,
      ownerUserId: input.actorUserId,
      serverId: installed.serverId,
    });
  }
  if (input.tools !== null) {
    await upsertConnectionTools(
      transaction,
      installed.serverId,
      connectionId,
      { definitions: {}, tools: input.tools },
      input.now,
      "delete",
    );
  }
  await transaction
    .insertInto("securityAudit")
    .values({
      action: input.created
        ? "integration.computer-connection.created"
        : "integration.computer-connection.updated",
      actorSessionId: null,
      actorUserId: input.actorUserId,
      id: createId("securityAudit"),
      metadata: jsonValue({
        access: input.access,
        ...(scope.appKey === null ? {} : { appKey: scope.appKey }),
        definitionId: input.definitionId,
      }),
      requestId: input.requestId,
      targetId: connectionId,
      targetType: "integration-connection",
    })
    .executeTakeFirstOrThrow();
  await requestSettlementActor(transaction, input.actorUserId, input.actorSessionId);
  return {
    connection: integrationConnectionFromRow(input.row),
    created: input.created,
    fulfilledRequestIds: settlement.requestIds,
    grants: settlement.grants,
    reissuedSetupRequestId: settlement.reissuedSetupRequestId,
  };
}

/**
 * A session keeps the access and identity it opened with, so a lower access —
 * or, for an app, a different app on the same key — ends it. A phone's
 * session holds its whole display, which a lower access ends the same way.
 * Every other computer app has no session at all.
 */
export function sessionResetFor(
  current: Selectable<IntegrationConnectionTable> | undefined,
  app: ComputerAppIdentity | null,
  access: IntegrationAccess,
  target: ComputerConnectionTarget,
): SetComputerConnectionResult["sessionReset"] {
  const { scope } = target;
  if (!current) return null;
  const lowered = current.computerAccess === "read-write" && access === "read";
  if (scope.appKey === null) {
    return lowered && target.definition.computerApp?.kind === "display"
      ? { definitionId: scope.definitionId, kind: "display", deviceId: scope.deviceId }
      : null;
  }
  return lowered || !computerAppIdentitiesEqual(storedComputerApp(current), app)
    ? { appKey: scope.appKey, kind: "app", deviceId: scope.deviceId }
    : null;
}

/**
 * A `gui` definition's connection is one app; every other computer app's
 * connection is the definition on the Runner. Getting this wrong either way
 * would put a row in the wrong slot of the live unique index, so it is an
 * error rather than a default.
 */
export function assertComputerAppPresence(input: {
  readonly app: ComputerAppIdentity | null;
  readonly requiresApp: boolean;
}): void {
  if (input.requiresApp === (input.app !== null)) return;
  throw new OpensteerError({
    code: "bad_request",
    message: input.requiresApp
      ? "This computer app names one app on the computer, and none was given."
      : "This computer app is the whole app, not one app on the computer.",
  });
}

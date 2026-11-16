import { withPersonalReadTransaction, withPersonalTransaction } from "./personal-transaction.js";
import {} from "@opensteer/integration-core";
import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import {} from "@opensteer/shared/isRecord";
import {} from "./resource-access.js";
import { readRequestSettlementActor, requestSettlementActor } from "./request-settlement.js";
import type {} from "@opensteer/integration-core/ports";
import { runnerIntegrationsCompatibilityReason } from "@opensteer/protocol";

import { assertPersonalOwner } from "./private-resource-owner.js";
import {} from "./channel-deliveries.js";
import { jsonValue } from "./store-primitives.js";
import {} from "@opensteer/shared/canonicalJson";
import {} from "@opensteer/integration-core/authorization-digest";
import {
  type ComputerAppIdentity,
  ComputerAppIdentitySchema,
  type ComputerAppSetupRequest,
  IntegrationConnectionRequirementSchema,
  IntegrationDefinitionSummarySchema,
  IntegrationServerSchema,
  type IntegrationToolMaterial,
  createIntegrationId,
  type IntegrationConnectionId,
  type IntegrationConnectionSummary,
  type IntegrationAccess,
  type IntegrationGrant,
  type IntegrationDefinitionSummary,
  type IntegrationInstallationId,
  type IntegrationServerId,
  computerAppIdentitiesEqual,
} from "@opensteer/integration-core";
import { integrationAccessCovers } from "@opensteer/integration-core/access";
import {} from "@opensteer/integration-core/effect";
import {
  OpensteerError,
  createId,
  type AgentEvent,
  type RequestId,
  type UserId,
  type RunnerId,
} from "@opensteer/core";
import { type Selectable, type Transaction, sql } from "kysely";
import {} from "./integration-auth-attempt-store.js";
import type { DatabaseSchema, IntegrationConnectionTable } from "./schema.js";
import {} from "./request-cancellation.js";
import {
  fulfillPendingIntegrationAccessRequestsInTransaction,
  pendingIntegrationAccessRequests,
} from "./integration-request-fulfillment.js";
import {} from "./integration-authority-cache.js";
import { machineOwnershipIn } from "./machine-ownership.js";
import { integrationConnectionFromRow } from "./integration-store.js";
import {
  computerAppScopeOf,
  computerAppSetupRequestFromRow,
  computerAppSetupRequestMatches,
  deleteComputerAppSetupRequestsInTransaction,
  insertComputerAppSetupRequestInTransaction,
  lockComputerAppSetupRequestInTransaction,
  type ComputerAppScope,
} from "./computer-app-setup.js";
import {
  askForComputerAppApprovalInTransaction,
  computerUsePolicyInTransaction,
  declineComputerAppAccessRequestsInTransaction,
  emptyComputerAppAccessSettlement,
  lockComputerApprovalScopeInTransaction,
  settleComputerAppApprovalInTransaction,
  type ComputerAppAccessSettlement,
} from "./computer-app-approvals.js";
import {
  IntegrationPlatformStoreBase,
  type RevokeComputerConnectionsMutation,
  revokeComputerConnectionsInTransaction,
  upsertConnectionTools,
} from "./integration-platform-stores.js";

/**
 * Computer apps and phones as connections: who may use which app on which
 * computer, with what access, and the setup requests and policy that decide it.
 */
export class ComputerConnectionStore extends IntegrationPlatformStoreBase {
  /** Immutable enrollment facts; callers apply their resource's owner check first. */
  async computerAppRunner(runnerId: RunnerId): Promise<{
    readonly deviceProfile: "iphone" | null;
    readonly publicKeyFingerprint: string;
  } | null> {
    return (
      (await this.database
        .selectFrom("runners")
        .select(["deviceProfile", "publicKeyFingerprint"])
        .where("id", "=", runnerId)
        .where("revokedAt", "is", null)
        .executeTakeFirst()) ?? null
    );
  }

  async getComputerUsePolicy(input: {
    readonly runnerId: RunnerId;
    readonly ownerUserId: UserId;
  }): Promise<{
    readonly appApproval: "ask" | "automatic";
    readonly revision: number;
  }> {
    return withPersonalReadTransaction(this.database, async (transaction) => {
      await this.#computerUsePolicyOwner(transaction, input.runnerId, input.ownerUserId, false);
      const policy = await computerUsePolicyInTransaction(
        transaction,
        input.runnerId,
        input.ownerUserId,
      );
      return {
        ...policy,
      };
    });
  }

  async #computerUsePolicyOwner(
    transaction: Transaction<DatabaseSchema>,
    runnerId: RunnerId,
    ownerUserId: UserId,
    lock = true,
  ) {
    const runner = await transaction
      .selectFrom("runners")
      .select(["id", "name", "revokedAt"])
      .where("id", "=", runnerId)
      .$if(lock, (query) => query.forNoKeyUpdate())
      .executeTakeFirst();
    if (!runner || runner.revokedAt !== null)
      throw new OpensteerError({ code: "not_found", message: "Computer not found" });
    const ownership = await machineOwnershipIn(transaction, runnerId);
    if (ownership?.effectiveOwner !== ownerUserId)
      throw new OpensteerError({
        code: "forbidden",
        message: "Only this computer’s owner can change app approvals.",
      });
    return runner;
  }

  async setComputerUsePolicy(
    input: {
      readonly settlementSessionId?: string | undefined;
      readonly runnerId: RunnerId;
      readonly ownerUserId: UserId;
      readonly requestId: string;
    } & (
      | { readonly appApproval: "ask" }
      | {
          readonly appApproval: "automatic";
          readonly setupRequestId: string;
          readonly definitionDigest: string;
        }
    ),
  ): Promise<{ readonly appApproval: "ask" | "automatic"; readonly revision: number }> {
    return withPersonalTransaction(this.database, async (transaction) => {
      await this.#computerUsePolicyOwner(transaction, input.runnerId, input.ownerUserId);
      const now = new Date();
      const deployment = await transaction
        .selectFrom("deployments")
        .select("id")
        .where("singletonKey", "=", "primary")
        .executeTakeFirstOrThrow();
      if (input.appApproval === "automatic") {
        const pending = await transaction
          .selectFrom("computerAppSetupRequests")
          .selectAll()
          .where("id", "=", input.setupRequestId)
          .where("deploymentId", "=", deployment.id)
          .where("runnerId", "=", input.runnerId)
          .where("ownerUserId", "=", input.ownerUserId)
          .where("kind", "=", "policy")
          .where("policyAppApproval", "=", "automatic")
          .where("definitionDigest", "=", input.definitionDigest)
          .where("expiresAt", ">", now)
          // FOR UPDATE: Consuming the policy approval deletes this setup request.
          .forUpdate()
          .executeTakeFirst();
        if (!pending)
          throw new OpensteerError({
            code: "forbidden",
            message: "This approval changed or is no longer waiting.",
          });
      }
      const previous = await computerUsePolicyInTransaction(
        transaction,
        input.runnerId,
        input.ownerUserId,
      );
      const revision = previous.revision + 1;
      await transaction
        .insertInto("computerUsePolicies")
        .values({
          deploymentId: deployment.id,
          runnerId: input.runnerId,
          ownerUserId: input.ownerUserId,
          appApproval: input.appApproval,
          revision,
          updatedAt: now,
        })
        .onConflict((conflict) =>
          conflict.columns(["deploymentId", "runnerId", "ownerUserId"]).doUpdateSet({
            appApproval: input.appApproval,
            revision,
            updatedAt: now,
          }),
        )
        .execute();
      await transaction
        .deleteFrom("computerAppSetupRequests")
        .where("runnerId", "=", input.runnerId)
        .where("ownerUserId", "=", input.ownerUserId)
        .where("kind", "=", "policy")
        .execute();
      await transaction
        .insertInto("securityAudit")
        .values({
          action: "integration.computer-policy.updated",
          actorSessionId: null,
          actorUserId: input.ownerUserId,
          id: createId("securityAudit"),
          metadata: jsonValue({ appApproval: input.appApproval, revision }),
          requestId: input.requestId,
          targetId: input.runnerId,
          targetType: "runner",
        })
        .execute();
      await requestSettlementActor(transaction, input.ownerUserId, input.settlementSessionId);
      return { appApproval: input.appApproval, revision };
    });
  }

  async listComputerAppSetupRequests(
    ownerUserId: UserId,
  ): Promise<readonly ComputerAppSetupRequest[]> {
    const rows = await this.database
      .selectFrom("computerAppSetupRequests")
      .innerJoin("runners", "runners.id", "computerAppSetupRequests.runnerId")
      .selectAll("computerAppSetupRequests")
      .where("computerAppSetupRequests.ownerUserId", "=", ownerUserId)
      .where("computerAppSetupRequests.expiresAt", ">", new Date())
      .where("runners.revokedAt", "is", null)
      .orderBy("computerAppSetupRequests.createdAt", "asc")
      .limit(1_000)
      .execute();
    return rows.map(computerAppSetupRequestFromRow);
  }

  /**
   * Whether this person administers the Deployment, for an answer that arrives
   * on a Mac's Runner stream rather than with a session that already says so.
   */
  async isPersonalOwner(userId: UserId): Promise<boolean> {
    try {
      await assertPersonalOwner(this.database, userId);
      return true;
    } catch (error) {
      if (error instanceof OpensteerError) return false;
      throw error;
    }
  }

  /** One waiting approval on one Mac, which that Mac is answering. */
  async getComputerAppSetupRequest(input: {
    readonly runnerId?: RunnerId;
    readonly setupRequestId: string;
  }): Promise<ComputerAppSetupRequest | null> {
    const row = await this.database
      .selectFrom("computerAppSetupRequests")
      .selectAll()
      .where("id", "=", input.setupRequestId)
      .$if(input.runnerId !== undefined, (query) => query.where("runnerId", "=", input.runnerId!))
      .where("expiresAt", ">", new Date())
      .executeTakeFirst();
    return row ? computerAppSetupRequestFromRow(row) : null;
  }

  /**
   * `app` is non-null exactly when the definition's connections name one app,
   * which `requiresApp` states. It comes from the caller for the same reason
   * `definitionDigest` does: the catalog is the Host's, not the store's, and
   * one of the two facts would otherwise be read from a different source than
   * the other.
   *
   * An app ask from the picker or an unblock is the same ask a task makes,
   * without a task, so it joins or widens the one waiting approval for that
   * app exactly as `askForComputerAppApprovalInTransaction` decides.
   */
  async requestComputerAppSetup(
    requestInput: {
      readonly actorUserId: UserId;
      readonly runnerId: RunnerId;
      readonly definitionDigest: string;
    } & (
      | {
          readonly kind: "policy";
          readonly appApproval: "automatic";
        }
      | {
          readonly kind?: "app";
          readonly definitionId: string;
          readonly access: IntegrationAccess;
          readonly app: ComputerAppIdentity | null;
          readonly requiresApp: boolean;
        }
    ),
  ): Promise<{
    readonly request: ComputerAppSetupRequest;
    readonly settlement: ComputerAppAccessSettlement;
  }> {
    const input =
      requestInput.kind === "policy"
        ? {
            ...requestInput,
            definitionId: "macos-app",
            access: "read-write" as const,
            app: null,
            requiresApp: false,
          }
        : requestInput;
    assertComputerAppPresence(input);
    return withPersonalTransaction(this.database, async (transaction) => {
      const runner = await lockComputerApprovalScopeInTransaction(transaction, {
        runnerId: input.runnerId,
      });
      const ownership =
        runner.revokedAt === null ? await machineOwnershipIn(transaction, runner.id) : null;
      if (ownership?.effectiveOwner !== input.actorUserId) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Only this computer’s owner can request app setup.",
        });
      }
      const now = new Date();
      if (input.kind !== "policy") {
        const { row, settlement } = await askForComputerAppApprovalInTransaction(transaction, {
          access: input.access,
          app: input.app,
          definitionDigest: input.definitionDigest,
          definitionId: input.definitionId,
          now,
          ownerUserId: input.actorUserId,
          runnerId: input.runnerId,
          task: null,
        });
        return { request: computerAppSetupRequestFromRow(row), settlement };
      }
      // The policy approval has no Requests waiting on it, so replacing it
      // only has to mint the new id that invalidates older decisions.
      const scope = computerAppScopeOf(input);
      const existing = await lockComputerAppSetupRequestInTransaction(transaction, scope);
      if (
        existing &&
        computerAppSetupRequestMatches(existing, {
          access: input.access,
          app: input.app,
          definitionDigest: input.definitionDigest,
          now,
          ownerUserId: input.actorUserId,
        })
      ) {
        return {
          request: computerAppSetupRequestFromRow(existing),
          settlement: emptyComputerAppAccessSettlement,
        };
      }
      await deleteComputerAppSetupRequestsInTransaction(transaction, scope);
      const row = await insertComputerAppSetupRequestInTransaction(transaction, {
        kind: "policy",
        policyAppApproval: "automatic",
        access: input.access,
        app: input.app,
        definitionDigest: input.definitionDigest,
        definitionId: input.definitionId,
        now,
        ownerUserId: input.actorUserId,
        runnerId: input.runnerId,
      });
      return {
        request: computerAppSetupRequestFromRow(row),
        settlement: emptyComputerAppAccessSettlement,
      };
    });
  }

  /** The owner taking the ask back, which declines whatever Threads were waiting on it. */
  async cancelComputerAppSetup(input: {
    readonly settlementSessionId?: string | undefined;
    readonly requestId: string;
    readonly ownerUserId: UserId;
  }): Promise<ComputerAppAccessSettlement & { readonly runnerId: RunnerId | null }> {
    return withPersonalTransaction(this.database, async (transaction) => {
      const request = await transaction
        .selectFrom("computerAppSetupRequests")
        .select("runnerId")
        .where("id", "=", input.requestId)
        .where("ownerUserId", "=", input.ownerUserId)
        .executeTakeFirst();
      if (!request) return { ...emptyComputerAppAccessSettlement, runnerId: null };
      // Same scope as enable/reduce/revoke, so cancellation cannot race an approval.
      await this.#computerUsePolicyOwner(transaction, request.runnerId, input.ownerUserId);
      const settlementActor = await readRequestSettlementActor(
        transaction,
        input.ownerUserId,
        input.settlementSessionId,
      );
      const removed = await transaction
        .deleteFrom("computerAppSetupRequests")
        .where("id", "=", input.requestId)
        .where("ownerUserId", "=", input.ownerUserId)
        .returning("id")
        .execute();
      const settlement = await declineComputerAppAccessRequestsInTransaction(transaction, {
        setupRequestIds: removed.map(({ id }) => id),
        settlementActor,
      });
      await requestSettlementActor(transaction, input.ownerUserId, input.settlementSessionId);
      return {
        ...settlement,
        runnerId: request.runnerId,
      };
    });
  }

  /**
   * Sweeps approvals nobody answered inside their week.
   *
   * Reads already hide an expired row and `setComputerConnection` already
   * refuses it, so the row itself is harmless. A `computer.app.access` Request
   * linked to one is not — it would sit pending forever — so the Host's
   * minute tick calls this, and every other path that removes a row settles
   * its Requests too.
   */
  async expireComputerAppSetupRequests(
    now = new Date(),
  ): Promise<ComputerAppAccessSettlement & { readonly runnerIds: readonly RunnerId[] }> {
    // One Mac per transaction, each under that Mac's approval scope, so the
    // sweep takes its locks in the order every approval does.
    const expiring = await this.database
      .selectFrom("computerAppSetupRequests")
      .select("runnerId")
      .distinct()
      .where("expiresAt", "<=", now)
      .orderBy("runnerId", "asc")
      .execute();
    const grants: IntegrationGrant[] = [];
    const requestEvents: AgentEvent[] = [];
    const requestIds: RequestId[] = [];
    const runnerIds: RunnerId[] = [];
    for (const { runnerId } of expiring) {
      const settled = await withPersonalTransaction(this.database, async (transaction) => {
        await lockComputerApprovalScopeInTransaction(transaction, { runnerId });
        const expired = await transaction
          .deleteFrom("computerAppSetupRequests")
          .where("runnerId", "=", runnerId)
          .where("expiresAt", "<=", now)
          .returning("id")
          .execute();
        return declineComputerAppAccessRequestsInTransaction(transaction, {
          setupRequestIds: expired.map(({ id }) => id),
        });
      });
      grants.push(...settled.grants);
      requestEvents.push(...settled.requestEvents);
      requestIds.push(...settled.requestIds);
      runnerIds.push(runnerId);
    }
    return { grants, requestEvents, requestIds, runnerIds };
  }

  /**
   * The owner's change to a computer app's connection.
   *
   * With a setup request it consumes that request, which is how a
   * Mac connection is created, widened or unblocked. Without one a Mac app can
   * only keep or lower access. An owner can set phone access from any client.
   *
   * `app` names which app on the Mac, for a definition whose connections do.
   * It is checked against the installed definition rather than trusted, so a
   * caller that forgot it cannot write an app-less `macos-app` row and take
   * the `(definitionId, runnerId, '')` slot every other app needs.
   */
  async setComputerConnection(
    input: SetComputerConnectionInput,
  ): Promise<SetComputerConnectionResult> {
    return withPersonalTransaction(this.database, async (transaction) => {
      const runner = await lockComputerOwnerInTransaction(transaction, {
        ...input,
      });
      const descriptor = await transaction
        .selectFrom("runners")
        .select(["device", "moduleDescriptors", "allowedModules", "kind"])
        .where("id", "=", runner.id)
        .executeTakeFirstOrThrow();
      const phone = input.definitionId === "android-phone";
      if (
        phone &&
        (input.app !== null ||
          descriptor.kind !== "local" ||
          descriptor.device?.form !== "phone" ||
          descriptor.device.platform !== "android" ||
          !descriptor.allowedModules.includes("integrations") ||
          descriptor.moduleDescriptors.integrations?.platform !== "android" ||
          runnerIntegrationsCompatibilityReason(descriptor.moduleDescriptors.integrations) !== null)
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message: "This computer is not an eligible Android phone.",
        });
      }
      if (input.setupRequestId && (phone || descriptor.device?.platform === "android")) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Allow phone access from any Opensteer app.",
        });
      }
      const target = await computerConnectionTargetInTransaction(transaction, input);
      return input.setupRequestId
        ? consumeComputerAppApprovalInTransaction(transaction, {
            ...input,
            setupRequestId: input.setupRequestId,
            runner,
            target,
          })
        : reviseComputerConnectionInTransaction(transaction, { ...input, runner, target });
    });
  }

  /** A task's ask for a new app on a Mac whose owner allows any app automatically. */
  async approveComputerAppAutomatically(
    input: AutomaticComputerAppApprovalInput,
  ): Promise<SetComputerConnectionResult> {
    return withPersonalTransaction(this.database, async (transaction) => {
      const runner = await lockComputerOwnerInTransaction(transaction, {
        ...input,
      });
      const policy = await computerUsePolicyInTransaction(
        transaction,
        input.runnerId,
        input.actorUserId,
      );
      if (policy.appApproval !== "automatic") {
        throw new OpensteerError({
          code: "forbidden",
          message: "Automatic app approval is not enabled on this Mac.",
        });
      }
      return approveComputerAppAutomaticallyInTransaction(transaction, { ...input, runner });
    });
  }

  async blockComputerApp(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
    readonly requestId: string;
  }): Promise<RevokeComputerConnectionsMutation> {
    return withPersonalTransaction(this.database, async (transaction) =>
      administrationCommand(transaction, input.administration, async () => {
        const connection = await transaction
          .selectFrom("integrationConnections")
          .select(["runnerId", "computerApp"])
          .where("id", "=", input.connectionId)
          .where("ownerUserId", "=", input.ownerUserId)
          .where("connectionKind", "=", "computer")
          .where("status", "!=", "revoked")
          .executeTakeFirst();
        if (!connection?.runnerId || !connection.computerApp) {
          throw new OpensteerError({ code: "not_found", message: "Computer app not found" });
        }
        await lockComputerApprovalScopeInTransaction(transaction, {
          runnerId: connection.runnerId,
        });
        const ownership = await machineOwnershipIn(transaction, connection.runnerId);
        if (ownership?.effectiveOwner !== input.ownerUserId) {
          throw new OpensteerError({
            code: "forbidden",
            message: "Only this computer’s owner can block its apps.",
          });
        }
        const mutation = await revokeComputerConnectionsInTransaction(transaction, input);
        const now = new Date();
        await transaction
          .updateTable("integrationConnections")
          .set({ computerBlockedAt: now, status: "paused", updatedAt: now })
          .where("id", "=", input.connectionId)
          .execute();
        await transaction
          .insertInto("securityAudit")
          .values({
            action: "integration.computer-app.blocked",
            actorSessionId: null,
            actorUserId: input.ownerUserId,
            id: createId("securityAudit"),
            metadata: jsonValue({}),
            requestId: input.requestId,
            targetId: input.connectionId,
            targetType: "integration-connection",
          })
          .execute();
        return mutation;
      }),
    );
  }

  async revokeComputerConnection(input: {
    readonly administration?: AdministrationCommandIdentity | undefined;
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
    readonly requestId: string;
  }): Promise<RevokeComputerConnectionsMutation> {
    return withPersonalTransaction(this.database, async (transaction) =>
      administrationCommand(transaction, input.administration, async () => {
        const named = await transaction
          .selectFrom("integrationConnections")
          .select("runnerId")
          .where("id", "=", input.connectionId)
          .where("ownerUserId", "=", input.ownerUserId)
          .where("connectionKind", "=", "computer")
          .executeTakeFirst();
        if (named?.runnerId) {
          await lockComputerApprovalScopeInTransaction(transaction, { runnerId: named.runnerId });
        }
        const mutation = await revokeComputerConnectionsInTransaction(transaction, {
          connectionId: input.connectionId,
          ownerUserId: input.ownerUserId,
        });
        if (mutation.connectionIds.length === 0) {
          throw new OpensteerError({ code: "not_found", message: "Computer app not found" });
        }
        await transaction
          .insertInto("securityAudit")
          .values({
            action: "integration.computer-connection.revoked",
            actorSessionId: null,
            actorUserId: input.ownerUserId,
            id: createId("securityAudit"),
            metadata: jsonValue({ cancelledRequests: mutation.cancelledRequestIds.length }),
            requestId: input.requestId,
            targetId: input.connectionId,
            targetType: "integration-connection",
          })
          .executeTakeFirstOrThrow();
        return mutation;
      }),
    );
  }

  async getComputerConnectionForCall(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
  }): Promise<{
    readonly access: IntegrationAccess;
    readonly connection: IntegrationConnectionSummary;
    readonly runnerId: RunnerId;
    readonly runnerName: string;
    readonly deviceProfile: "iphone" | null;
    readonly runnerRevoked: boolean;
  } | null> {
    const row = await this.database
      .selectFrom("integrationConnections")
      .innerJoin("runners", "runners.id", "integrationConnections.runnerId")
      .selectAll("integrationConnections")
      .select([
        "runners.name as runnerName",
        "runners.deviceProfile",
        "runners.revokedAt as runnerRevokedAt",
      ])
      .where("integrationConnections.id", "=", input.connectionId)
      .where("integrationConnections.ownerUserId", "=", input.ownerUserId)
      .where("integrationConnections.connectionKind", "=", "computer")
      .where("integrationConnections.status", "!=", "revoked")
      .executeTakeFirst();
    if (!row?.runnerId || !row.computerAccess || row.computerBlockedAt !== null) return null;
    return {
      access: row.computerAccess,
      connection: integrationConnectionFromRow(row),
      runnerId: row.runnerId,
      runnerName: row.runnerName,
      deviceProfile: row.deviceProfile,
      runnerRevoked: row.runnerRevokedAt !== null,
    };
  }
}

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
  readonly runnerId: RunnerId;
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
  readonly requestEvents: readonly AgentEvent[];
  /**
   * The live session this change ended, if any: the one holding this app on a
   * Mac, or the one holding a phone's display. Null for a change that left
   * every session's authority as it was.
   */
  readonly sessionReset:
    | { readonly appKey: string; readonly kind: "app"; readonly runnerId: RunnerId }
    | { readonly definitionId: string; readonly kind: "display"; readonly runnerId: RunnerId }
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

interface LockedComputer {
  readonly id: RunnerId;
  readonly name: string;
}

/** The computer's fence, taken after deployment events, and the owner check under it. */
async function lockComputerOwnerInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorUserId: UserId;
    readonly runnerId: RunnerId;
  },
): Promise<LockedComputer> {
  const runner = await lockComputerApprovalScopeInTransaction(transaction, {
    runnerId: input.runnerId,
  });
  if (runner.revokedAt !== null) {
    throw new OpensteerError({ code: "not_found", message: "Computer not found" });
  }
  const ownership = await machineOwnershipIn(transaction, runner.id);
  if (ownership?.effectiveOwner !== input.actorUserId) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Only the person who added this computer can turn its apps on.",
    });
  }
  return runner;
}

/** Where a computer app's connection lives, and the row it has now, locked. */
interface ComputerConnectionTarget {
  readonly current: Selectable<IntegrationConnectionTable> | undefined;
  readonly definition: IntegrationDefinitionSummary;
  readonly installed: {
    readonly installationId: IntegrationInstallationId;
    readonly serverId: IntegrationServerId;
    readonly toolGeneration: number;
  };
  readonly scope: ComputerAppScope;
}

async function computerConnectionTargetInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly app: ComputerAppIdentity | null;
    readonly definitionId: string;
    readonly runnerId: RunnerId;
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
  const definition = IntegrationDefinitionSummarySchema.parse(installed.manifest.definition);
  if (definition.adapter !== "computer") {
    throw new OpensteerError({ code: "not_found", message: `${definition.name} is not installed` });
  }
  assertComputerAppPresence({
    app: input.app,
    requiresApp: definition.computerApp?.kind === "gui",
  });
  const runner = await transaction
    .selectFrom("runners")
    .select("moduleDescriptors")
    .where("id", "=", input.runnerId)
    .executeTakeFirstOrThrow();
  const platform = runner.moduleDescriptors.integrations?.platform;
  if (platform && !definition.computerApp?.platforms.includes(platform))
    throw new OpensteerError({
      code: "forbidden",
      message: "This app is not supported on this computer.",
    });
  const scope = computerAppScopeOf(input);
  const current = await transaction
    .selectFrom("integrationConnections")
    .selectAll()
    .where("connectionKind", "=", "computer")
    .where("integrationDefinitionId", "=", input.definitionId)
    .where("runnerId", "=", input.runnerId)
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

function storedComputerApp(
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
async function consumeComputerAppApprovalInTransaction(
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
  const pending = await transaction
    .selectFrom("computerAppSetupRequests")
    .selectAll()
    .where("id", "=", input.setupRequestId)
    .where("runnerId", "=", input.runnerId)
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
async function reviseComputerConnectionInTransaction(
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
    input.definitionId !== "android-phone" &&
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

async function writeComputerConnectionInTransaction(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly access: IntegrationAccess;
    readonly app: ComputerAppIdentity | null;
    readonly now: Date;
    readonly ownerUserId: UserId;
    readonly runner: LockedComputer;
    readonly target: ComputerConnectionTarget;
  },
): Promise<Selectable<IntegrationConnectionTable>> {
  const { current, definition, installed, scope } = input.target;
  const values = {
    computerAccess: input.access,
    computerApp: input.app === null ? null : jsonValue(input.app),
    computerAppKey: scope.appKey,
    computerBlockedAt: null,
    displayName:
      input.app === null ? input.runner.name : `${input.app.displayName} on ${input.runner.name}`,
    integrationServerId: installed.serverId,
    provider: definition.provider,
    status: "connected" as const,
    statusDetail: null,
    updatedAt: input.now,
  };
  if (current) {
    return transaction
      .updateTable("integrationConnections")
      .set(values)
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
      applicationSource: null,
      authMethodId: "computer",
      authorizationDigest: null,
      capabilities: jsonValue([]),
      connectionKind: "computer",
      connectionMethod: "computer",
      credentialId: null,
      externalIdentityId: null,
      externalTenantId: null,
      grantedScopes: jsonValue([]),
      id: createIntegrationId("connection"),
      integrationDefinitionId: scope.definitionId,
      ownerUserId: input.ownerUserId,
      providerApplicationId: null,
      runnerId: scope.runnerId,
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
async function finishComputerConnectionChangeInTransaction(
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
  const settlement = await settleComputerAppApprovalInTransaction(transaction, {
    settlementActor,
    additionalRequestIds: pendingRequests.map(({ id }) => id),
    ...(grantAccess ? { alsoGrant: { access: grantAccess } } : {}),
    connection: {
      access: input.connectionAccess,
      alias: app?.displayName ?? input.row.displayName,
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
  const pendingRequestEvents =
    input.created || input.widened
      ? await fulfillPendingIntegrationAccessRequestsInTransaction(transaction, {
          settlementActor,
          access: input.connectionAccess,
          connectionId,
          displayName: input.row.displayName,
          installationId: installed.installationId,
          ownerUserId: input.actorUserId,
          serverId: installed.serverId,
        })
      : [];
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
    requestEvents: [...pendingRequestEvents, ...settlement.requestEvents],
  };
}

/**
 * A session keeps the access and identity it opened with, so a lower access —
 * or, for an app, a different app on the same key — ends it. A phone's
 * session holds its whole display, which a lower access ends the same way.
 * Every other computer app has no session at all.
 */
function sessionResetFor(
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
      ? { definitionId: scope.definitionId, kind: "display", runnerId: scope.runnerId }
      : null;
  }
  return lowered || !computerAppIdentitiesEqual(storedComputerApp(current), app)
    ? { appKey: scope.appKey, kind: "app", runnerId: scope.runnerId }
    : null;
}

/**
 * A `gui` definition's connection is one app; every other computer app's
 * connection is the definition on the Runner. Getting this wrong either way
 * would put a row in the wrong slot of the live unique index, so it is an
 * error rather than a default.
 */
function assertComputerAppPresence(input: {
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

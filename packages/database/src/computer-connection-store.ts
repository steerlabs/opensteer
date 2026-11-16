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
  type ComputerAppSetupRequest,
  type IntegrationConnectionId,
  type IntegrationConnectionSummary,
  type IntegrationAccess,
  type IntegrationGrant,
} from "@opensteer/integration-core";
import {} from "@opensteer/integration-core/access";
import {} from "@opensteer/integration-core/effect";
import {
  OpensteerError,
  createId,
  type AgentEvent,
  type RequestId,
  type UserId,
  type RunnerId,
} from "@opensteer/core";
import { type Transaction } from "kysely";
import {} from "./integration-auth-attempt-store.js";
import type { DatabaseSchema } from "./schema.js";
import {} from "./request-cancellation.js";
import {} from "./integration-authority-cache.js";
import { machineOwnershipIn } from "./machine-ownership.js";
import { integrationConnectionFromRow } from "./integration-connections.js";
import {
  computerAppScopeOf,
  computerAppSetupRequestFromRow,
  computerAppSetupRequestMatches,
  deleteComputerAppSetupRequestsInTransaction,
  insertComputerAppSetupRequestInTransaction,
  lockComputerAppSetupRequestInTransaction,
} from "./computer-app-setup.js";
import {
  askForComputerAppApprovalInTransaction,
  computerUsePolicyInTransaction,
  declineComputerAppAccessRequestsInTransaction,
  emptyComputerAppAccessSettlement,
  lockComputerApprovalScopeInTransaction,
  type ComputerAppAccessSettlement,
} from "./computer-app-approvals.js";
import {
  IntegrationPlatformStoreBase,
  type RevokeComputerConnectionsMutation,
  revokeComputerConnectionsInTransaction,
} from "./integration-platform-stores.js";

import {
  lockComputerOwnerInTransaction,
  computerConnectionTargetInTransaction,
  consumeComputerAppApprovalInTransaction,
  reviseComputerConnectionInTransaction,
  approveComputerAppAutomaticallyInTransaction,
  assertComputerAppPresence,
  type SetComputerConnectionInput,
  type SetComputerConnectionResult,
  type AutomaticComputerAppApprovalInput,
} from "./computer-connection-writes.js";
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

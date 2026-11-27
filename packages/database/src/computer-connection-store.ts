import {
  legacySelfConnection,
  legacySelfSetupRequest,
  legacySelfSessionReset,
} from "./device-legacy-store.js";
import { getSelfDeviceId, getDeviceSelfRunnerId } from "./device-inventory-store.js";
import { isPhoneDisplayDefinitionId, type DeviceId } from "@opensteer/core";
import { deviceOwnershipIn } from "./machine-ownership.js";
import { computerConnectionDeviceId } from "./integration-connections.js";
import { withPersonalReadTransaction } from "./personal-transaction.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import {
  administrationCommand,
  type AdministrationCommandIdentity,
} from "./administration-command.js";
import { readRequestSettlementActor, requestSettlementActor } from "./request-settlement.js";
import { runnerIntegrationsCompatibilityReason } from "@opensteer/protocol";
import { computerAppApprovalChangedReason } from "@opensteer/integration-core/computer-app-setup";

import { assertPersonalOwner } from "./private-resource-owner.js";
import { jsonValue } from "./store-primitives.js";
import {
  type ComputerAppIdentity,
  type DeviceComputerAppSetupRequest as ComputerAppSetupRequest,
  type IntegrationConnectionId,
  type DeviceIntegrationConnectionSummary as IntegrationConnectionSummary,
  type IntegrationAccess,
  type IntegrationGrant,
} from "@opensteer/integration-core";
import {
  OpensteerError,
  createId,
  type RequestId,
  type UserId,
  type RunnerId,
} from "@opensteer/core";
import { type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { integrationConnectionFromRow } from "./integration-connections.js";
import {
  computerAppScopeOf,
  computerAppSetupRequestFromRow,
  computerAppSetupRequestMatches,
  deleteComputerAppSetupRequestsInTransaction,
  insertComputerAppSetupRequestInTransaction,
  lockComputerAppSetupRequestInTransaction,
  lockComputerApprovalRequestThreads,
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

  async getComputerUsePolicy(
    input: Omit<
      Parameters<ComputerConnectionStore["getDeviceComputerUsePolicy"]>[0],
      "deviceId"
    > & { readonly runnerId: RunnerId },
  ) {
    return this.getDeviceComputerUsePolicy({
      ...input,
      deviceId: await this.requireSelfDeviceId(input.runnerId),
    });
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
  ) {
    return this.setDeviceComputerUsePolicy({
      ...input,
      deviceId: await this.requireSelfDeviceId(input.runnerId),
    });
  }

  async listComputerAppSetupRequests(owner: UserId) {
    const result = [];
    for (const request of await this.listDeviceComputerAppSetupRequests(owner)) {
      if (!(await getDeviceSelfRunnerId(this.database, request.deviceId))) continue;
      result.push(await legacySelfSetupRequest(this.database, request));
    }
    return result;
  }

  async getComputerAppSetupRequest(input: {
    readonly runnerId?: RunnerId;
    readonly setupRequestId: string;
  }) {
    const request = await this.getDeviceComputerAppSetupRequest({
      setupRequestId: input.setupRequestId,
      ...(input.runnerId ? { deviceId: await this.requireSelfDeviceId(input.runnerId) } : {}),
    });
    return request ? legacySelfSetupRequest(this.database, request) : null;
  }

  async requestComputerAppSetup(
    input: {
      readonly actorUserId: UserId;
      readonly runnerId: RunnerId;
      readonly definitionDigest: string;
    } & (
      | { readonly kind: "policy"; readonly appApproval: "automatic" }
      | {
          readonly kind?: "app";
          readonly definitionId: string;
          readonly access: IntegrationAccess;
          readonly app: ComputerAppIdentity | null;
          readonly requiresApp: boolean;
        }
    ),
  ) {
    const result = await this.requestDeviceComputerAppSetup({
      ...input,
      deviceId: await this.requireSelfDeviceId(input.runnerId),
    });
    return { ...result, request: await legacySelfSetupRequest(this.database, result.request) };
  }

  async cancelComputerAppSetup(
    input: Parameters<ComputerConnectionStore["cancelDeviceComputerAppSetup"]>[0],
  ) {
    const result = await this.cancelDeviceComputerAppSetup(input);
    const { deviceId, ...rest } = result;
    return { ...rest, runnerId: deviceId ? await this.requireDeviceSelfRunnerId(deviceId) : null };
  }

  async expireComputerAppSetupRequests(now = new Date()) {
    const result = await this.expireDeviceComputerAppSetupRequests(now);
    const runnerIds = [];
    for (const id of result.deviceIds) {
      const runnerId = await getDeviceSelfRunnerId(this.database, id);
      if (runnerId) runnerIds.push(runnerId);
    }
    const { deviceIds: _deviceIds, ...rest } = result;
    return { ...rest, runnerIds };
  }

  async setComputerConnection(
    input: Omit<SetComputerConnectionInput, "deviceId"> & { readonly runnerId: RunnerId },
  ) {
    const deviceId = await getSelfDeviceId(this.database, input.runnerId);
    if (!deviceId) {
      const runner = await this.database
        .selectFrom("runners")
        .select(["revokedAt", "ownerKind"])
        .where("id", "=", input.runnerId)
        .executeTakeFirst();
      if (runner && !runner.revokedAt && runner.ownerKind === "deployment")
        throw new OpensteerError({
          code: "forbidden",
          message: "Only the person who added this computer can turn its apps on.",
        });
      throw new OpensteerError({ code: "not_found", message: "Computer not found" });
    }
    const result = await this.setDeviceComputerConnection({ ...input, deviceId });
    return {
      ...result,
      connection: await legacySelfConnection(this.database, result.connection),
      sessionReset: await legacySelfSessionReset(this.database, result.sessionReset),
    };
  }

  async approveComputerAppAutomatically(
    input: Omit<AutomaticComputerAppApprovalInput, "deviceId"> & { readonly runnerId: RunnerId },
  ) {
    const result = await this.approveDeviceComputerAppAutomatically({
      ...input,
      deviceId: await this.requireSelfDeviceId(input.runnerId),
    });
    return {
      ...result,
      connection: await legacySelfConnection(this.database, result.connection),
      sessionReset: await legacySelfSessionReset(this.database, result.sessionReset),
    };
  }

  async getComputerConnectionForCall(
    input: Parameters<ComputerConnectionStore["getDeviceComputerConnectionForCall"]>[0],
  ) {
    const result = await this.getDeviceComputerConnectionForCall(input);
    if (!result) return null;
    const runnerId = await getDeviceSelfRunnerId(this.database, result.deviceId);
    if (!runnerId) return null;
    const {
      deviceId: _deviceId,
      deviceName: _deviceName,
      deviceAddedAt: _added,
      runnerUpdateRequired: _update,
      ...rest
    } = result;
    return {
      ...rest,
      runnerId,
      connection: await legacySelfConnection(this.database, result.connection),
    };
  }

  async getDeviceComputerUsePolicy(input: {
    readonly deviceId: DeviceId;
    readonly ownerUserId: UserId;
  }): Promise<{
    readonly appApproval: "ask" | "automatic";
    readonly revision: number;
  }> {
    const { accessPolicy: _accessPolicy, ...policy } = await this.deviceComputerUseFacts(input);
    return policy;
  }

  /**
   * A device's computer-use policy with its own switches, in the one read the policy takes: what
   * its Apps switch says, for a listing that decides the device's own refusal from it.
   */
  async deviceComputerUseFacts(input: {
    readonly deviceId: DeviceId;
    readonly ownerUserId: UserId;
  }): Promise<{
    readonly appApproval: "ask" | "automatic";
    readonly revision: number;
    readonly accessPolicy: unknown;
  }> {
    return withPersonalReadTransaction(this.database, async (transaction) => {
      const device = await this.#computerUsePolicyOwner(
        transaction,
        input.deviceId,
        input.ownerUserId,
        false,
      );
      const policy = await computerUsePolicyInTransaction(
        transaction,
        input.deviceId,
        input.ownerUserId,
      );
      return {
        ...policy,
        accessPolicy: device.accessPolicy,
      };
    });
  }

  async #computerUsePolicyOwner(
    transaction: Transaction<DatabaseSchema>,
    deviceId: DeviceId,
    ownerUserId: UserId,
    lock = true,
  ) {
    const runner = await transaction
      .selectFrom("devices")
      .select(["id", "name", "removedAt", "accessPolicy"])
      .where("id", "=", deviceId)
      .$if(lock, (query) => query.forNoKeyUpdate())
      .executeTakeFirst();
    if (!runner || runner.removedAt !== null)
      throw new OpensteerError({ code: "not_found", message: "Computer not found" });
    const ownership = await deviceOwnershipIn(transaction, deviceId);
    if (ownership?.effectiveOwner !== ownerUserId)
      throw new OpensteerError({
        code: "forbidden",
        message: "Only this computer’s owner can change app approvals.",
      });
    return runner;
  }

  async setDeviceComputerUsePolicy(
    input: {
      readonly settlementSessionId?: string | undefined;
      readonly deviceId: DeviceId;
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
    return commitPersonalMutation(this.database, async (transaction) => {
      await this.#computerUsePolicyOwner(transaction, input.deviceId, input.ownerUserId);
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
          .where("runnerId", "=", input.deviceId)
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
            reason: computerAppApprovalChangedReason,
            message: "This approval changed or is no longer waiting.",
          });
      }
      const previous = await computerUsePolicyInTransaction(
        transaction,
        input.deviceId,
        input.ownerUserId,
      );
      const revision = previous.revision + 1;
      await transaction
        .insertInto("computerUsePolicies")
        .values({
          deploymentId: deployment.id,
          runnerId: input.deviceId,
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
        .where("runnerId", "=", input.deviceId)
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
          targetId: input.deviceId,
          targetType: "runner",
        })
        .execute();
      await requestSettlementActor(transaction, input.ownerUserId, input.settlementSessionId);
      return { appApproval: input.appApproval, revision };
    });
  }

  async listDeviceComputerAppSetupRequests(
    ownerUserId: UserId,
  ): Promise<readonly ComputerAppSetupRequest[]> {
    const rows = await this.database
      .selectFrom("computerAppSetupRequests")
      .innerJoin("devices", "devices.id", "computerAppSetupRequests.runnerId")
      .selectAll("computerAppSetupRequests")
      .where("computerAppSetupRequests.ownerUserId", "=", ownerUserId)
      .where("computerAppSetupRequests.expiresAt", ">", new Date())
      .where("devices.removedAt", "is", null)
      .orderBy("computerAppSetupRequests.createdAt", "asc")
      .limit(1_000)
      .execute();
    return rows.map(computerAppSetupRequestFromRow);
  }

  async isPersonalOwner(userId: UserId): Promise<boolean> {
    try {
      await assertPersonalOwner(this.database, userId);
      return true;
    } catch (error) {
      if (error instanceof OpensteerError) return false;
      throw error;
    }
  }

  async getDeviceComputerAppSetupRequest(input: {
    readonly deviceId?: DeviceId;
    readonly setupRequestId: string;
  }): Promise<ComputerAppSetupRequest | null> {
    const row = await this.database
      .selectFrom("computerAppSetupRequests")
      .selectAll()
      .where("id", "=", input.setupRequestId)
      .$if(input.deviceId !== undefined, (query) => query.where("runnerId", "=", input.deviceId!))
      .where("expiresAt", ">", new Date())
      .executeTakeFirst();
    return row ? computerAppSetupRequestFromRow(row) : null;
  }

  async requestDeviceComputerAppSetup(
    requestInput: {
      readonly actorUserId: UserId;
      readonly deviceId: DeviceId;
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
    return commitPersonalMutation(this.database, async (transaction) => {
      const runner = await lockComputerApprovalScopeInTransaction(transaction, {
        deviceId: input.deviceId,
      });
      const ownership =
        runner.removedAt === null ? await deviceOwnershipIn(transaction, runner.id) : null;
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
          deviceId: input.deviceId,
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
        deviceId: input.deviceId,
      });
      return {
        request: computerAppSetupRequestFromRow(row),
        settlement: emptyComputerAppAccessSettlement,
      };
    });
  }

  async cancelDeviceComputerAppSetup(input: {
    readonly settlementSessionId?: string | undefined;
    readonly requestId: string;
    readonly ownerUserId: UserId;
  }): Promise<ComputerAppAccessSettlement & { readonly deviceId: DeviceId | null }> {
    return commitPersonalMutation(this.database, async (transaction) => {
      const request = await transaction
        .selectFrom("computerAppSetupRequests")
        .select("runnerId as deviceId")
        .where("id", "=", input.requestId)
        .where("ownerUserId", "=", input.ownerUserId)
        .executeTakeFirst();
      if (!request) return { ...emptyComputerAppAccessSettlement, deviceId: null };
      // Same scope as enable/reduce/revoke, so cancellation cannot race an approval.
      await this.#computerUsePolicyOwner(transaction, request.deviceId, input.ownerUserId);
      const settlementActor = await readRequestSettlementActor(
        transaction,
        input.ownerUserId,
        input.settlementSessionId,
      );
      await lockComputerApprovalRequestThreads(transaction, [input.requestId]);
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
        deviceId: request.deviceId,
      };
    });
  }

  async expireDeviceComputerAppSetupRequests(
    now = new Date(),
  ): Promise<ComputerAppAccessSettlement & { readonly deviceIds: readonly DeviceId[] }> {
    // One Mac per transaction, each under that Mac's approval scope, so the
    // sweep takes its locks in the order every approval does.
    const expiring = await this.database
      .selectFrom("computerAppSetupRequests")
      .select("runnerId as deviceId")
      .distinct()
      .where("expiresAt", "<=", now)
      .orderBy("runnerId", "asc")
      .execute();
    const grants: IntegrationGrant[] = [];

    const requestIds: RequestId[] = [];
    const deviceIds: DeviceId[] = [];
    for (const { deviceId } of expiring) {
      const settled = await commitPersonalMutation(this.database, async (transaction) => {
        await lockComputerApprovalScopeInTransaction(transaction, { deviceId });
        const due = transaction
          .selectFrom("computerAppSetupRequests")
          .select("id")
          .where("runnerId", "=", deviceId)
          .where("expiresAt", "<=", now);
        await lockComputerApprovalRequestThreads(transaction, due);
        const rows = await due
          .orderBy("id")
          // FOR UPDATE: Deletes the expired approvals.
          .forUpdate()
          .execute();
        if (!rows.length) return emptyComputerAppAccessSettlement;
        const expired = await transaction
          .deleteFrom("computerAppSetupRequests")
          .where(
            "id",
            "in",
            rows.map(({ id }) => id),
          )
          .returning("id")
          .execute();
        return declineComputerAppAccessRequestsInTransaction(transaction, {
          setupRequestIds: expired.map(({ id }) => id),
        });
      });
      grants.push(...settled.grants);

      requestIds.push(...settled.requestIds);
      deviceIds.push(deviceId);
    }
    return { grants, requestIds, deviceIds };
  }

  async setDeviceComputerConnection(
    input: SetComputerConnectionInput,
  ): Promise<SetComputerConnectionResult> {
    return commitPersonalMutation(this.database, async (transaction) => {
      const runner = await lockComputerOwnerInTransaction(transaction, {
        ...input,
      });
      const device = await transaction
        .selectFrom("devices")
        .select(["kind", "platform"])
        .where("id", "=", input.deviceId)
        .executeTakeFirstOrThrow();
      const selfRunnerId = await getDeviceSelfRunnerId(transaction, input.deviceId);
      const descriptor = selfRunnerId
        ? await transaction
            .selectFrom("runners")
            .select(["device", "moduleDescriptors", "allowedModules", "kind"])
            .where("id", "=", selfRunnerId)
            .executeTakeFirst()
        : undefined;
      const phone = isPhoneDisplayDefinitionId(input.definitionId);
      if (
        phone &&
        (input.app !== null ||
          (input.definitionId === "iphone-screen"
            ? device.kind !== "phone" || device.platform !== "ios" || selfRunnerId !== null
            : !descriptor ||
              descriptor.kind !== "local" ||
              descriptor.device?.form !== "phone" ||
              descriptor.device.platform !== "android" ||
              !descriptor.allowedModules.includes("integrations") ||
              descriptor.moduleDescriptors.integrations?.platform !== "android" ||
              runnerIntegrationsCompatibilityReason(descriptor.moduleDescriptors.integrations) !==
                null))
      )
        throw new OpensteerError({
          code: "forbidden",
          message: "This device is not eligible for this phone display.",
        });
      if (input.setupRequestId && phone)
        throw new OpensteerError({
          code: "forbidden",
          message: "Allow phone access from any Opensteer app.",
        });
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

  async approveDeviceComputerAppAutomatically(
    input: AutomaticComputerAppApprovalInput,
  ): Promise<SetComputerConnectionResult> {
    return commitPersonalMutation(this.database, async (transaction) => {
      const runner = await lockComputerOwnerInTransaction(transaction, {
        ...input,
      });
      const policy = await computerUsePolicyInTransaction(
        transaction,
        input.deviceId,
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
    return commitPersonalMutation(this.database, async (transaction) =>
      administrationCommand(transaction, input.administration, async () => {
        const connection = await transaction
          .selectFrom("integrationConnections")
          .select([computerConnectionDeviceId.as("deviceId"), "computerApp"])
          .where("id", "=", input.connectionId)
          .where("ownerUserId", "=", input.ownerUserId)
          .where("connectionKind", "=", "computer")
          .where("status", "!=", "revoked")
          .executeTakeFirst();
        if (!connection?.deviceId || !connection.computerApp) {
          throw new OpensteerError({ code: "not_found", message: "Computer app not found" });
        }
        await lockComputerApprovalScopeInTransaction(transaction, {
          deviceId: connection.deviceId,
        });
        const ownership = await deviceOwnershipIn(transaction, connection.deviceId);
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
    return commitPersonalMutation(this.database, async (transaction) =>
      administrationCommand(transaction, input.administration, async () => {
        const named = await transaction
          .selectFrom("integrationConnections")
          .select(computerConnectionDeviceId.as("deviceId"))
          .where("id", "=", input.connectionId)
          .where("ownerUserId", "=", input.ownerUserId)
          .where("connectionKind", "=", "computer")
          .executeTakeFirst();
        if (named?.deviceId) {
          await lockComputerApprovalScopeInTransaction(transaction, { deviceId: named.deviceId });
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

  async getDeviceComputerConnectionForCall(input: {
    readonly connectionId: IntegrationConnectionId;
    readonly ownerUserId: UserId;
    readonly includeRecordedAppName?: boolean;
  }): Promise<{
    readonly access: IntegrationAccess;
    readonly connection: IntegrationConnectionSummary;
    readonly recordedAppName?: string | null;
    readonly deviceId: DeviceId;
    readonly deviceName: string;
    readonly deviceAddedAt: Date;
    readonly runnerName: string;
    readonly deviceProfile: "iphone" | null;
    readonly runnerRevoked: boolean;
    readonly runnerUpdateRequired: boolean;
    /** The device's switches, read with it, so a listing reads no device again. */
    readonly deviceAccessPolicy?: unknown;
  } | null> {
    const row = await this.database
      .selectFrom("integrationConnections")
      .innerJoin("devices", (join) => join.on("devices.id", "=", computerConnectionDeviceId))
      .leftJoin("deviceDrivers", (join) =>
        join
          .onRef("deviceDrivers.deviceId", "=", "devices.id")
          .on("deviceDrivers.role", "=", "self")
          .on("deviceDrivers.detachedAt", "is", null),
      )
      .leftJoin("runners", "runners.id", "deviceDrivers.runnerId")
      .selectAll("integrationConnections")
      .select(computerConnectionDeviceId.as("deviceId"))
      .select([
        "devices.name as runnerName",
        "devices.createdAt as deviceAddedAt",
        "runners.deviceProfile",
        "runners.updateRequired",
        "devices.removedAt as runnerRevokedAt",
        "devices.accessPolicy as deviceAccessPolicy",
      ])
      .$if(input.includeRecordedAppName === true, (query) =>
        query.select((eb) =>
          eb
            .selectFrom("integrationGrants")
            .select("alias")
            .whereRef("integrationGrants.connectionId", "=", "integrationConnections.id")
            .whereRef("integrationGrants.ownerUserId", "=", "integrationConnections.ownerUserId")
            .where("integrationGrants.revokedAt", "is", null)
            .limit(1)
            .as("recordedAppName"),
        ),
      )
      .where("integrationConnections.id", "=", input.connectionId)
      .where("integrationConnections.ownerUserId", "=", input.ownerUserId)
      .where("integrationConnections.connectionKind", "=", "computer")
      .where("integrationConnections.status", "!=", "revoked")
      .executeTakeFirst();
    if (!row?.deviceId || !row.computerAccess || row.computerBlockedAt !== null) return null;
    return {
      access: row.computerAccess,
      connection: integrationConnectionFromRow(row),
      ...(input.includeRecordedAppName ? { recordedAppName: row.recordedAppName ?? null } : {}),
      deviceId: row.deviceId,
      deviceName: row.runnerName,
      deviceAddedAt: row.deviceAddedAt,
      runnerName: row.runnerName,
      deviceProfile: row.deviceProfile,
      runnerRevoked: row.runnerRevokedAt !== null,
      runnerUpdateRequired: row.updateRequired !== null,
      deviceAccessPolicy: row.deviceAccessPolicy,
    };
  }
}

import { createHash } from "node:crypto";
import {
  ConnectCredentialResponseSchema,
  ProvisionConnectRequestSchema,
  RevokeConnectRequestSchema,
  RevokeConnectResponseSchema,
  RotateConnectCredentialRequestSchema,
  type ConnectCredentialResponse,
  type ConnectOperationId,
  type ProvisionConnectRequest,
  type RevokeConnectRequest,
  type RevokeConnectResponse,
  type RotateConnectCredentialRequest,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import { DeploymentIdSchema, type DeploymentId, type HostInstanceId } from "@opensteer/core";
import type { HostKeyFingerprint } from "@opensteer/core";
import { type Kysely, type Transaction } from "kysely";
import {
  acquireConnectSessionLock,
  releaseConnectSessionLock,
} from "../database/advisory-locks.js";
import type {
  CloudflareConnectResource,
  ConnectResourceProvider,
} from "./cloudflare-connect-provider.js";
import { ControlPlaneError } from "../server/errors.js";
import type { HostAuthority } from "../database/store.js";
import type {
  ConnectResourceOperationKind,
  ControlPlaneDatabaseSchema,
  DeploymentConnectResourceRow,
  DeploymentConnectOperationRow,
  DeploymentRow,
} from "../database/schema.js";

const defaultOperationLeaseMilliseconds = 5 * 60 * 1_000;

interface ConnectAuthority {
  readonly canonicalOrigin: string;
  readonly deploymentId: DeploymentId;
  readonly hostInstanceId: HostInstanceId;
  readonly hostKeyFingerprint: HostKeyFingerprint;
}

interface BegunCredentialOperation {
  readonly authority: ConnectAuthority;
  readonly generation: number;
  readonly localOrigin: string;
  readonly routeOrigin: string;
  readonly replay: boolean;
  readonly resource?: CloudflareConnectResource;
}

interface BegunRevokeOperation {
  readonly alreadyRevoked: boolean;
  readonly generation: number;
  readonly hostname?: string;
  readonly resource?: CloudflareConnectResource;
}

type ConnectRevokeAuthority =
  | { readonly kind: "account-owner"; readonly ownerAccountId: ControlPlaneAccountId }
  | { readonly authority: HostAuthority; readonly kind: "host" };

/**
 * Serializes durable Connect intent around Cloudflare calls. Connector tokens
 * exist only in the provider response and the caller's response; this service
 * never writes one to PostgreSQL.
 */
export class ConnectLifecycleService {
  readonly #database: Kysely<ControlPlaneDatabaseSchema>;
  readonly #operationLeaseMilliseconds: number;
  readonly #provider: ConnectResourceProvider;
  readonly #managedConnectDomain: string;

  constructor(
    database: Kysely<ControlPlaneDatabaseSchema>,
    provider: ConnectResourceProvider,
    options: {
      readonly managedConnectDomain?: string;
      readonly operationLeaseMilliseconds?: number;
    } = {},
  ) {
    this.#database = database;
    this.#provider = provider;
    this.#managedConnectDomain = managedConnectDomain(
      options.managedConnectDomain ?? "connect.opensteer.invalid",
    );
    this.#operationLeaseMilliseconds =
      options.operationLeaseMilliseconds ?? defaultOperationLeaseMilliseconds;
    if (
      !Number.isSafeInteger(this.#operationLeaseMilliseconds) ||
      this.#operationLeaseMilliseconds < 1_000 ||
      this.#operationLeaseMilliseconds > 30 * 60 * 1_000
    ) {
      throw new TypeError("Connect operation lease must be from 1 second through 30 minutes");
    }
  }

  async provision(
    ownerAccountId: ControlPlaneAccountId,
    deploymentIdInput: DeploymentId,
    requestInput: ProvisionConnectRequest,
  ): Promise<ConnectCredentialResponse> {
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    const request = ProvisionConnectRequestSchema.parse(requestInput);
    return this.#withDeploymentLock(deploymentId, async (database) => {
      const begun = await this.#beginProvision(database, ownerAccountId, deploymentId, request);
      let provisioned;
      try {
        provisioned = await this.#provider.ensure({
          deploymentId,
          ...(begun.resource ? { expected: begun.resource } : {}),
          hostname: new URL(begun.routeOrigin).hostname,
          localOrigin: begun.localOrigin,
        });
        const generation = begun.replay
          ? begun.generation
          : await this.#completeProvision(database, deploymentId, request.operationId, provisioned);
        return ConnectCredentialResponseSchema.parse({
          ...begun.authority,
          connectorCredentialGeneration: generation,
          routeOrigin: begun.routeOrigin,
          tunnelToken: provisioned.connectorToken,
        });
      } catch (error) {
        await this.#markFailed(database, deploymentId, request.operationId, "provision");
        if (error instanceof ControlPlaneError) throw error;
        throw new ControlPlaneError("internal", "Opensteer Connect could not be provisioned", {
          cause: error,
        });
      }
    });
  }

  async rotateCredential(
    ownerAccountId: ControlPlaneAccountId,
    deploymentIdInput: DeploymentId,
    requestInput: RotateConnectCredentialRequest,
  ): Promise<ConnectCredentialResponse> {
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    const request = RotateConnectCredentialRequestSchema.parse(requestInput);
    return this.#withDeploymentLock(deploymentId, async (database) => {
      const begun = await this.#beginCredentialRotation(
        database,
        ownerAccountId,
        deploymentId,
        request,
      );
      try {
        const resource = begun.resource;
        if (!resource) throw new Error("Connect resource disappeared before credential rotation");
        const tunnelToken = begun.replay
          ? await this.#provider.readConnectorToken(resource)
          : await this.#provider.rotateConnectorToken(resource, request.operationId);
        const generation = begun.replay
          ? begun.generation
          : await this.#completeRotation(database, deploymentId, request.operationId);
        return ConnectCredentialResponseSchema.parse({
          ...begun.authority,
          connectorCredentialGeneration: generation,
          routeOrigin: begun.routeOrigin,
          tunnelToken,
        });
      } catch (error) {
        await this.#markFailed(database, deploymentId, request.operationId, "rotate");
        if (error instanceof ControlPlaneError) throw error;
        throw new ControlPlaneError("internal", "Opensteer Connect credential rotation failed", {
          cause: error,
        });
      }
    });
  }

  async revoke(
    ownerAccountId: ControlPlaneAccountId,
    deploymentIdInput: DeploymentId,
    requestInput: RevokeConnectRequest,
  ): Promise<RevokeConnectResponse> {
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    return this.#revoke({ kind: "account-owner", ownerAccountId }, deploymentId, requestInput);
  }

  /**
   * Lets an exact Personal Host authority reduce its own reachability without
   * requiring a signed-in Account user. Provisioning and credential rotation
   * deliberately remain Account-owner operations.
   */
  async revokeForHost(
    authority: HostAuthority,
    requestInput: RevokeConnectRequest,
  ): Promise<RevokeConnectResponse> {
    return this.#revoke({ authority, kind: "host" }, authority.deploymentId, requestInput);
  }

  async #revoke(
    authority: ConnectRevokeAuthority,
    deploymentId: DeploymentId,
    requestInput: RevokeConnectRequest,
  ): Promise<RevokeConnectResponse> {
    const request = RevokeConnectRequestSchema.parse(requestInput);
    return this.#withDeploymentLock(deploymentId, async (database) => {
      const begun = await this.#beginRevoke(database, authority, deploymentId, request);
      if (begun.alreadyRevoked) {
        return RevokeConnectResponseSchema.parse({
          generation: begun.generation,
          revoked: true,
        });
      }
      try {
        if (!begun.hostname) throw new Error("Connect deletion identity is missing");
        await this.#provider.delete({
          deploymentId,
          ...(begun.resource ? { expected: begun.resource } : {}),
          hostname: begun.hostname,
        });
        const generation = await this.#completeRevoke(database, deploymentId, request.operationId);
        return RevokeConnectResponseSchema.parse({ generation, revoked: true });
      } catch (error) {
        await this.#markFailed(database, deploymentId, request.operationId, "revoke");
        if (error instanceof ControlPlaneError) throw error;
        throw new ControlPlaneError("internal", "Opensteer Connect could not be revoked", {
          cause: error,
        });
      }
    });
  }

  async #withDeploymentLock<T>(
    deploymentId: DeploymentId,
    operation: (database: Kysely<ControlPlaneDatabaseSchema>) => Promise<T>,
  ): Promise<T> {
    // The pinned-session lock spans the committed intent, provider call, and
    // committed result. A crashed process releases it with its PostgreSQL
    // connection, while the intent row remains available for exact recovery.
    return this.#database.connection().execute(async (database) => {
      await acquireConnectSessionLock(database, deploymentId);
      const operationOutcome = await operation(database).then(
        (value) => ({ status: "fulfilled", value }) as const,
        (reason: unknown) => ({ reason, status: "rejected" }) as const,
      );
      const unlockOutcome = await releaseConnectSessionLock(database, deploymentId).then(
        (unlocked) => {
          if (!unlocked) {
            return {
              reason: new Error("Opensteer Connect deployment lock was not held"),
              status: "rejected",
            } as const;
          }
          return { status: "fulfilled" } as const;
        },
        (reason: unknown) => ({ reason, status: "rejected" }) as const,
      );
      if (operationOutcome.status === "rejected" && unlockOutcome.status === "rejected") {
        throw new AggregateError(
          [operationOutcome.reason, unlockOutcome.reason],
          "Opensteer Connect operation and deployment lock release both failed",
        );
      }
      if (unlockOutcome.status === "rejected") throw unlockOutcome.reason;
      if (operationOutcome.status === "rejected") throw operationOutcome.reason;
      return operationOutcome.value;
    });
  }

  /**
   * Confirms that a Host-signed Connect route names the exact currently
   * provisioned provider endpoint. Host route generations are deliberately
   * independent from Cloudflare connector-credential generations.
   */
  async requireCurrentRoute(deploymentIdInput: DeploymentId, routeOrigin: string): Promise<void> {
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    const origin = new URL(routeOrigin);
    const resource = await this.#database
      .selectFrom("deploymentConnectResources")
      .select(["hostname", "state"])
      .where("deploymentId", "=", deploymentId)
      .executeTakeFirst();
    if (
      origin.protocol !== "https:" ||
      origin.origin !== routeOrigin ||
      resource?.state !== "ready" ||
      resource.hostname !== origin.hostname
    ) {
      throw new ControlPlaneError(
        "conflict",
        "Signed Connect route does not match the current managed resource",
      );
    }
  }

  async requireRevoked(deploymentIdInput: DeploymentId): Promise<void> {
    const deploymentId = DeploymentIdSchema.parse(deploymentIdInput);
    const resource = await this.#database
      .selectFrom("deploymentConnectResources")
      .select("state")
      .where("deploymentId", "=", deploymentId)
      .executeTakeFirst();
    if (resource && resource.state !== "revoked") {
      throw new ControlPlaneError("conflict", "Managed Connect resource is not revoked");
    }
  }

  async #beginProvision(
    database: Kysely<ControlPlaneDatabaseSchema>,
    ownerAccountId: ControlPlaneAccountId,
    deploymentId: DeploymentId,
    request: ProvisionConnectRequest,
  ): Promise<BegunCredentialOperation> {
    return database.transaction().execute(async (transaction) => {
      const deployment = await requireManagedAuthority(
        transaction,
        ownerAccountId,
        deploymentId,
        request,
      );
      const authority = connectAuthority(deployment);
      const hostname = connectHostname(deployment.id, this.#managedConnectDomain);
      const tunnelName = tunnelNameFor(deploymentId);
      const row = await transaction
        .selectFrom("deploymentConnectResources")
        .selectAll()
        .where("deploymentId", "=", deploymentId)
        .forNoKeyUpdate()
        .executeTakeFirst();

      if (row) assertStoredIdentity(row, hostname, tunnelName);
      const now = new Date();
      const claimed = await claimConnectOperation(
        transaction,
        deploymentId,
        request.operationId,
        "provision",
        operationFingerprint("provision", request),
        row,
        now,
      );
      if (claimed.replay) {
        if (!row || row.localOrigin !== request.localOrigin || row.state !== "ready") {
          throw operationReuse();
        }
        return {
          authority,
          generation: claimed.generation,
          localOrigin: row.localOrigin,
          routeOrigin: `https://${row.hostname}`,
          replay: true,
          resource: storedResource(row),
        };
      }

      if (
        row?.operationId === request.operationId &&
        row.operationKind === "provision" &&
        row.localOrigin !== request.localOrigin
      ) {
        throw operationReuse();
      }
      if (row) assertOperationAvailable(row, request.operationId, "provision", now);
      const operationExpiresAt = new Date(now.getTime() + this.#operationLeaseMilliseconds);
      if (!row) {
        await transaction
          .insertInto("deploymentConnectResources")
          .values({
            createdAt: now,
            credentialGeneration: 0,
            deploymentId,
            dnsRecordId: null,
            hostname,
            lastCompletedOperationId: null,
            lastCompletedOperationKind: null,
            localOrigin: request.localOrigin,
            operationExpiresAt,
            operationId: request.operationId,
            operationKind: "provision",
            provider: "cloudflare",
            state: "provisioning",
            tunnelId: null,
            tunnelName,
            updatedAt: now,
          })
          .executeTakeFirstOrThrow();
      } else {
        await transaction
          .updateTable("deploymentConnectResources")
          .set({
            localOrigin: request.localOrigin,
            operationExpiresAt,
            operationId: request.operationId,
            operationKind: "provision",
            state: "provisioning",
            updatedAt: now,
          })
          .where("deploymentId", "=", deploymentId)
          .executeTakeFirstOrThrow();
      }
      const currentGeneration = row ? storedGeneration(row) : 0;
      return {
        authority,
        generation:
          row?.state === "revoked"
            ? nextGeneration(currentGeneration)
            : Math.max(1, currentGeneration),
        localOrigin: request.localOrigin,
        routeOrigin: `https://${hostname}`,
        replay: false,
        ...(row ? resourceIfComplete(row) : {}),
      };
    });
  }

  async #beginCredentialRotation(
    database: Kysely<ControlPlaneDatabaseSchema>,
    ownerAccountId: ControlPlaneAccountId,
    deploymentId: DeploymentId,
    request: RotateConnectCredentialRequest,
  ): Promise<BegunCredentialOperation> {
    return database.transaction().execute(async (transaction) => {
      const deployment = await requireManagedAuthority(
        transaction,
        ownerAccountId,
        deploymentId,
        request,
      );
      const row = await transaction
        .selectFrom("deploymentConnectResources")
        .selectAll()
        .where("deploymentId", "=", deploymentId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row || row.state === "revoked") {
        throw new ControlPlaneError("conflict", "Opensteer Connect is not provisioned");
      }
      assertStoredIdentity(
        row,
        connectHostname(deployment.id, this.#managedConnectDomain),
        tunnelNameFor(deploymentId),
      );
      const resource = storedResource(row);
      const now = new Date();
      const claimed = await claimConnectOperation(
        transaction,
        deploymentId,
        request.operationId,
        "rotate",
        operationFingerprint("rotate", request),
        row,
        now,
      );
      if (claimed.replay) {
        return {
          authority: connectAuthority(deployment),
          generation: claimed.generation,
          localOrigin: row.localOrigin,
          routeOrigin: `https://${row.hostname}`,
          replay: true,
          resource,
        };
      }
      assertOperationAvailable(row, request.operationId, "rotate", now);
      await transaction
        .updateTable("deploymentConnectResources")
        .set({
          operationExpiresAt: new Date(now.getTime() + this.#operationLeaseMilliseconds),
          operationId: request.operationId,
          operationKind: "rotate",
          state: "rotating",
          updatedAt: now,
        })
        .where("deploymentId", "=", deploymentId)
        .executeTakeFirstOrThrow();
      return {
        authority: connectAuthority(deployment),
        generation: nextGeneration(storedGeneration(row)),
        localOrigin: row.localOrigin,
        routeOrigin: `https://${row.hostname}`,
        replay: false,
        resource,
      };
    });
  }

  async #beginRevoke(
    database: Kysely<ControlPlaneDatabaseSchema>,
    authority: ConnectRevokeAuthority,
    deploymentId: DeploymentId,
    request: RevokeConnectRequest,
  ): Promise<BegunRevokeOperation> {
    return database.transaction().execute(async (transaction) => {
      const deployment = await requireConnectRevokeAuthority(
        transaction,
        authority,
        deploymentId,
        request,
      );
      const hostname = connectHostname(deployment.id, this.#managedConnectDomain);
      const row = await transaction
        .selectFrom("deploymentConnectResources")
        .selectAll()
        .where("deploymentId", "=", deploymentId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const now = new Date();
      const claimed = await claimConnectOperation(
        transaction,
        deploymentId,
        request.operationId,
        "revoke",
        operationFingerprint("revoke", request),
        row,
        now,
      );
      if (claimed.replay) {
        return { alreadyRevoked: true, generation: claimed.generation };
      }
      if (!row) {
        await completeConnectOperation(transaction, deploymentId, request.operationId, 0);
        return { alreadyRevoked: true, generation: 0 };
      }
      if (row.state === "revoked") {
        const generation = storedGeneration(row);
        await transaction
          .updateTable("deploymentConnectResources")
          .set({
            lastCompletedOperationId: request.operationId,
            lastCompletedOperationKind: "revoke",
            updatedAt: new Date(),
          })
          .where("deploymentId", "=", deploymentId)
          .executeTakeFirstOrThrow();
        await completeConnectOperation(transaction, deploymentId, request.operationId, generation);
        return { alreadyRevoked: true, generation };
      }
      assertOperationAvailable(row, request.operationId, "revoke", now);
      await transaction
        .updateTable("deploymentConnectResources")
        .set({
          operationExpiresAt: new Date(now.getTime() + this.#operationLeaseMilliseconds),
          operationId: request.operationId,
          operationKind: "revoke",
          state: "deleting",
          updatedAt: now,
        })
        .where("deploymentId", "=", deploymentId)
        .executeTakeFirstOrThrow();
      return {
        alreadyRevoked: false,
        generation: nextGeneration(storedGeneration(row)),
        hostname,
        ...resourceIfComplete(row),
      };
    });
  }

  async #completeProvision(
    database: Kysely<ControlPlaneDatabaseSchema>,
    deploymentId: DeploymentId,
    operationId: ConnectOperationId,
    provisioned: CloudflareConnectResource,
  ): Promise<number> {
    return database.transaction().execute(async (transaction) => {
      const locked = await lockedOperation(transaction, deploymentId, operationId, "provision");
      if (locked.completed) return locked.generation;
      const row = locked.row;
      const prior = storedGeneration(row);
      // A row without external IDs is either the first provision or a
      // re-provision after revocation. An existing resource keeps its current
      // credential generation because `ensure` does not rotate the token.
      const generation = row.tunnelId ? Math.max(1, prior) : nextGeneration(prior);
      await transaction
        .updateTable("deploymentConnectResources")
        .set({
          credentialGeneration: generation,
          dnsRecordId: provisioned.dnsRecordId,
          hostname: provisioned.hostname,
          lastCompletedOperationId: operationId,
          lastCompletedOperationKind: "provision",
          operationExpiresAt: null,
          operationId: null,
          operationKind: null,
          state: "ready",
          tunnelId: provisioned.tunnelId,
          tunnelName: provisioned.tunnelName,
          updatedAt: new Date(),
        })
        .where("deploymentId", "=", deploymentId)
        .executeTakeFirstOrThrow();
      await completeConnectOperation(transaction, deploymentId, operationId, generation);
      return generation;
    });
  }

  async #completeRotation(
    database: Kysely<ControlPlaneDatabaseSchema>,
    deploymentId: DeploymentId,
    operationId: ConnectOperationId,
  ): Promise<number> {
    return this.#completeCredentialOperation(
      database,
      deploymentId,
      operationId,
      "rotate",
      "ready",
    );
  }

  async #completeRevoke(
    database: Kysely<ControlPlaneDatabaseSchema>,
    deploymentId: DeploymentId,
    operationId: ConnectOperationId,
  ): Promise<number> {
    return database.transaction().execute(async (transaction) => {
      const locked = await lockedOperation(transaction, deploymentId, operationId, "revoke");
      if (locked.completed) return locked.generation;
      const row = locked.row;
      const generation = row.tunnelId
        ? nextGeneration(storedGeneration(row))
        : storedGeneration(row);
      await transaction
        .updateTable("deploymentConnectResources")
        .set({
          credentialGeneration: generation,
          dnsRecordId: null,
          lastCompletedOperationId: operationId,
          lastCompletedOperationKind: "revoke",
          operationExpiresAt: null,
          operationId: null,
          operationKind: null,
          state: "revoked",
          tunnelId: null,
          updatedAt: new Date(),
        })
        .where("deploymentId", "=", deploymentId)
        .executeTakeFirstOrThrow();
      await completeConnectOperation(transaction, deploymentId, operationId, generation);
      return generation;
    });
  }

  async #completeCredentialOperation(
    database: Kysely<ControlPlaneDatabaseSchema>,
    deploymentId: DeploymentId,
    operationId: ConnectOperationId,
    kind: "rotate",
    state: "ready",
  ): Promise<number> {
    return database.transaction().execute(async (transaction) => {
      const locked = await lockedOperation(transaction, deploymentId, operationId, kind);
      if (locked.completed) return locked.generation;
      const row = locked.row;
      const generation = nextGeneration(storedGeneration(row));
      await transaction
        .updateTable("deploymentConnectResources")
        .set({
          credentialGeneration: generation,
          lastCompletedOperationId: operationId,
          lastCompletedOperationKind: kind,
          operationExpiresAt: null,
          operationId: null,
          operationKind: null,
          state,
          updatedAt: new Date(),
        })
        .where("deploymentId", "=", deploymentId)
        .executeTakeFirstOrThrow();
      await completeConnectOperation(transaction, deploymentId, operationId, generation);
      return generation;
    });
  }

  async #markFailed(
    database: Kysely<ControlPlaneDatabaseSchema>,
    deploymentId: DeploymentId,
    operationId: ConnectOperationId,
    operationKind: ConnectResourceOperationKind,
  ): Promise<void> {
    await database.transaction().execute(async (transaction) => {
      const now = new Date();
      await transaction
        .updateTable("deploymentConnectResources")
        .set({ operationExpiresAt: now, state: "error", updatedAt: now })
        .where("deploymentId", "=", deploymentId)
        .where("operationId", "=", operationId)
        .where("operationKind", "=", operationKind)
        .execute();
      await transaction
        .updateTable("deploymentConnectOperations")
        .set({ resultGeneration: null, state: "failed", updatedAt: now })
        .where("deploymentId", "=", deploymentId)
        .where("operationId", "=", operationId)
        .where("operationKind", "=", operationKind)
        .where("state", "=", "running")
        .execute();
    });
  }
}

async function requireConnectRevokeAuthority(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  principal: ConnectRevokeAuthority,
  deploymentId: DeploymentId,
  fence: { readonly hostInstanceId: HostInstanceId },
): Promise<DeploymentRow> {
  if (principal.kind === "account-owner") {
    return requireManagedAuthority(transaction, principal.ownerAccountId, deploymentId, fence);
  }

  const authority = principal.authority;
  if (
    authority.deploymentId !== deploymentId ||
    authority.hostInstanceId !== fence.hostInstanceId
  ) {
    throw new ControlPlaneError("forbidden", "Host authority fence does not match");
  }
  const row = await transaction
    .selectFrom("deployments")
    .innerJoin("deploymentCredentials", "deploymentCredentials.deploymentId", "deployments.id")
    .selectAll("deployments")
    .select("deploymentCredentials.tokenHash as hostTokenHash")
    .where("deployments.id", "=", deploymentId)
    .forNoKeyUpdate("deployments")
    .executeTakeFirst();
  if (
    !row ||
    row.lifecycle !== "active" ||
    row.activeHostInstanceId !== authority.hostInstanceId ||
    row.hostTokenHash !== authority.credentialHash
  ) {
    throw new ControlPlaneError("forbidden", "Host authority fence is stale");
  }
  if (row.reachability !== "routed") {
    throw new ControlPlaneError(
      "forbidden",
      "Opensteer Connect is available only for a managed personal Host",
    );
  }
  const { hostTokenHash: _hostTokenHash, ...deployment } = row;
  return deployment;
}

async function requireManagedAuthority(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  ownerAccountId: ControlPlaneAccountId,
  deploymentId: DeploymentId,
  fence: { readonly hostInstanceId: HostInstanceId },
): Promise<DeploymentRow> {
  const deployment = await transaction
    .selectFrom("deployments")
    .selectAll()
    .where("id", "=", deploymentId)
    .where("ownerAccountId", "=", ownerAccountId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!deployment) throw new ControlPlaneError("not_found", "Deployment was not found");
  if (deployment.reachability !== "routed") {
    throw new ControlPlaneError(
      "forbidden",
      "Opensteer Connect is available only for a managed personal Host",
    );
  }
  if (deployment.lifecycle !== "active") {
    throw new ControlPlaneError("conflict", "Deployment authority is not active");
  }
  if (deployment.activeHostInstanceId !== fence.hostInstanceId) {
    throw new ControlPlaneError("forbidden", "Deployment authority fence does not match");
  }
  return deployment;
}

async function lockedOperation(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  deploymentId: DeploymentId,
  operationId: ConnectOperationId,
  operationKind: ConnectResourceOperationKind,
): Promise<
  | { readonly completed: true; readonly generation: number }
  | { readonly completed: false; readonly row: DeploymentConnectResourceRow }
> {
  const row = await transaction
    .selectFrom("deploymentConnectResources")
    .selectAll()
    .where("deploymentId", "=", deploymentId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  const operation = await transaction
    .selectFrom("deploymentConnectOperations")
    .selectAll()
    .where("deploymentId", "=", deploymentId)
    .where("operationId", "=", operationId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (!operation || operation.operationKind !== operationKind) {
    throw new ControlPlaneError("conflict", "Connect operation was superseded");
  }
  if (operation.state === "completed") {
    return { completed: true, generation: storedOperationGeneration(operation) };
  }
  if (
    !row ||
    row.operationId !== operationId ||
    row.operationKind !== operationKind ||
    (operation.state !== "running" && operation.state !== "failed")
  ) {
    throw new ControlPlaneError("conflict", "Connect operation was superseded");
  }
  return { completed: false, row };
}

async function claimConnectOperation(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  deploymentId: DeploymentId,
  operationId: ConnectOperationId,
  operationKind: ConnectResourceOperationKind,
  requestFingerprint: string,
  resource: DeploymentConnectResourceRow | undefined,
  now: Date,
): Promise<{ readonly replay: false } | { readonly generation: number; readonly replay: true }> {
  const existing = await transaction
    .selectFrom("deploymentConnectOperations")
    .selectAll()
    .where("deploymentId", "=", deploymentId)
    .where("operationId", "=", operationId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (existing) {
    if (
      existing.operationKind !== operationKind ||
      existing.requestFingerprint !== requestFingerprint
    ) {
      throw operationReuse();
    }
    if (existing.state === "completed") {
      const generation = storedOperationGeneration(existing);
      const currentGeneration = resource ? storedGeneration(resource) : 0;
      if (
        generation !== currentGeneration ||
        (resource !== undefined &&
          (resource.lastCompletedOperationId !== operationId ||
            resource.lastCompletedOperationKind !== operationKind ||
            resource.operationId !== null))
      ) {
        throw new ControlPlaneError("conflict", "Connect operation was superseded");
      }
      return { generation, replay: true };
    }
    if (
      !resource ||
      resource.operationId !== operationId ||
      resource.operationKind !== operationKind
    ) {
      throw new ControlPlaneError("conflict", "Connect operation was superseded");
    }
    if (existing.state === "running") return { replay: false };
    await transaction
      .updateTable("deploymentConnectOperations")
      .set({ resultGeneration: null, state: "running", updatedAt: now })
      .where("deploymentId", "=", deploymentId)
      .where("operationId", "=", operationId)
      .executeTakeFirstOrThrow();
    return { replay: false };
  }
  await transaction
    .insertInto("deploymentConnectOperations")
    .values({
      createdAt: now,
      deploymentId,
      operationId,
      operationKind,
      requestFingerprint,
      resultGeneration: null,
      state: "running",
      updatedAt: now,
    })
    .executeTakeFirstOrThrow();
  return { replay: false };
}

async function completeConnectOperation(
  transaction: Transaction<ControlPlaneDatabaseSchema>,
  deploymentId: DeploymentId,
  operationId: ConnectOperationId,
  generation: number,
): Promise<void> {
  const completed = await transaction
    .updateTable("deploymentConnectOperations")
    .set({ resultGeneration: generation, state: "completed", updatedAt: new Date() })
    .where("deploymentId", "=", deploymentId)
    .where("operationId", "=", operationId)
    .returning("operationId")
    .executeTakeFirst();
  if (!completed) throw new ControlPlaneError("conflict", "Connect operation was superseded");
}

function assertOperationAvailable(
  row: DeploymentConnectResourceRow,
  operationId: ConnectOperationId,
  operationKind: ConnectResourceOperationKind,
  now: Date,
): void {
  if (!row.operationId) return;
  if (row.operationId === operationId && row.operationKind === operationKind) return;
  // The advisory lock spans the provider call, so once a revoke owns that
  // lock no earlier operation can still be executing. Any different operation
  // left on the row is crash residue; authority reduction supersedes it
  // immediately instead of making unlink wait for an artificial lease.
  if (operationKind === "revoke") return;
  if (row.operationExpiresAt && row.operationExpiresAt > now) {
    throw new ControlPlaneError("conflict", "Another Connect operation is still running");
  }
  if (row.operationKind && row.operationKind !== operationKind) {
    throw new ControlPlaneError(
      "conflict",
      `Retry the interrupted Connect ${row.operationKind} operation first`,
    );
  }
}

function connectAuthority(deployment: DeploymentRow): ConnectAuthority {
  return {
    canonicalOrigin: deployment.canonicalOrigin,
    deploymentId: deployment.id,
    hostInstanceId: deployment.activeHostInstanceId,
    hostKeyFingerprint: deployment.hostKeyFingerprint,
  };
}

function connectHostname(deploymentId: DeploymentId, managedDomain: string): string {
  return `connect-${deploymentId.slice("dep_".length)}.${managedDomain}`;
}

function managedConnectDomain(value: string | undefined): string {
  const domain = value?.trim().toLowerCase().replace(/\.$/u, "");
  if (!domain) throw new TypeError("A managed Connect domain is required");
  const url = new URL(`https://${domain}`);
  if (url.hostname !== domain || url.port || domain.length > 253) {
    throw new TypeError("Managed Connect domain must be a normalized DNS domain");
  }
  return domain;
}

function tunnelNameFor(deploymentId: DeploymentId): string {
  return `opensteer-${deploymentId.slice("dep_".length)}`;
}

function assertStoredIdentity(
  row: DeploymentConnectResourceRow,
  hostname: string,
  tunnelName: string,
): void {
  if (row.provider !== "cloudflare" || row.hostname !== hostname || row.tunnelName !== tunnelName) {
    throw new ControlPlaneError("conflict", "Stored Connect resource identity is invalid");
  }
}

function storedResource(row: DeploymentConnectResourceRow): CloudflareConnectResource {
  if (!row.tunnelId || !row.dnsRecordId) {
    throw new ControlPlaneError("conflict", "Opensteer Connect resource is incomplete");
  }
  return {
    dnsRecordId: row.dnsRecordId,
    hostname: row.hostname,
    tunnelId: row.tunnelId,
    tunnelName: row.tunnelName,
  };
}

function resourceIfComplete(
  row: DeploymentConnectResourceRow,
): { readonly resource: CloudflareConnectResource } | Record<string, never> {
  return row.tunnelId && row.dnsRecordId ? { resource: storedResource(row) } : {};
}

function storedGeneration(row: DeploymentConnectResourceRow): number {
  const generation = Number(row.credentialGeneration);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new ControlPlaneError("conflict", "Stored Connect generation is invalid");
  }
  return generation;
}

function storedOperationGeneration(row: DeploymentConnectOperationRow): number {
  const generation = Number(row.resultGeneration);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new ControlPlaneError("conflict", "Stored Connect operation result is invalid");
  }
  return generation;
}

function operationFingerprint(
  operationKind: ConnectResourceOperationKind,
  request: {
    readonly hostInstanceId: HostInstanceId;
    readonly localOrigin?: string;
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "opensteer-connect-operation-v2",
        operationKind,
        request.hostInstanceId,
        request.localOrigin ?? null,
      ]),
      "utf8",
    )
    .digest("base64url");
}

function nextGeneration(generation: number): number {
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation >= Number.MAX_SAFE_INTEGER
  ) {
    throw new ControlPlaneError("conflict", "Connect credential generation is exhausted");
  }
  return generation + 1;
}

function operationReuse(): ControlPlaneError {
  return new ControlPlaneError(
    "conflict",
    "Connect operation ID was reused with different content",
  );
}

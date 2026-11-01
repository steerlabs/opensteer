import {
  CloudDeploymentOperationSchema,
  CreateCloudDeploymentRequestSchema,
  ManagedHostProvisioningBundleSchema,
  type CloudDeploymentOperation,
  type ControlPlaneAccountId,
  type CreateCloudDeploymentRequest,
} from "@opensteer/control-plane-protocol";
import { DeploymentIdSchema, HostInstanceIdSchema, type DeploymentId } from "@opensteer/core";
import {
  HostDiscoveryEnvelopeSchema,
  hostDiscoveryDefaultWorkspaceBacking,
  hostKeyFingerprint,
  isSameHost,
  verifyHostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import type { Kysely, Selectable } from "kysely";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { withCloudOperationLock } from "../database/advisory-locks.js";
import type {
  CloudDeploymentOperationTable,
  ControlPlaneDatabaseSchema,
} from "../database/schema.js";
import type { ControlPlaneStore } from "../database/store.js";
import { ControlPlaneError } from "../server/errors.js";
import { cloudHostReady } from "./host-readiness.js";
import { managedWorkloadLabel } from "./kubernetes-managed-deployment-resources.js";
import { CloudMaterialCipher } from "./material.js";

export interface CloudDeploymentInput {
  readonly operationId: string;
  readonly deploymentId: DeploymentId;
  readonly canonicalOrigin: string;
  readonly name: string;
  readonly secrets: Readonly<Record<string, string>>;
}

/**
 * What the platform can already tell us about a converge: done, still coming up (and on what), or
 * a workload Kubernetes has given up on. No per-component state machine lives above this.
 */
export type CloudDeploymentEnsureResult =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly failed: { readonly reason: string; readonly workload: string };
      readonly waiting?: undefined;
    }
  | {
      readonly ready: false;
      readonly failed?: undefined;
      readonly waiting: readonly string[];
    };

export interface CloudDeploymentProvider {
  captureConfiguration(): string;
  /** Identifies the release the live template describes; equal values mean nothing would change. */
  currentRelease(): string;
  validateConfiguration(): Promise<void>;
  ensure(input: CloudDeploymentInput): Promise<CloudDeploymentEnsureResult>;
  delete(input: CloudDeploymentInput): Promise<boolean>;
}

/** A failure whose text is already written for the person waiting on the page. */
class CloudOperationFailure extends Error {}

interface CloudLifecycleOptions {
  readonly issuer: string;
  readonly domain: string;
  readonly cipher?: CloudMaterialCipher;
  readonly provider?: CloudDeploymentProvider;
  readonly fetch?: typeof globalThis.fetch;
  readonly onError?: (operationId: string, error: unknown) => void;
}

type OperationRow = Selectable<CloudDeploymentOperationTable>;

/** One durable intent per deployment; the provider converges the ordinary Host stack to it. */
export class CloudDeploymentLifecycle {
  readonly database: Kysely<ControlPlaneDatabaseSchema>;
  readonly store: ControlPlaneStore;
  readonly options: CloudLifecycleOptions;

  constructor(
    database: Kysely<ControlPlaneDatabaseSchema>,
    store: ControlPlaneStore,
    options: CloudLifecycleOptions,
  ) {
    this.database = database;
    this.store = store;
    this.options = options;
  }

  get available(): boolean {
    return this.options.provider !== undefined && this.options.cipher !== undefined;
  }

  async list(accountId: ControlPlaneAccountId): Promise<CloudDeploymentOperation[]> {
    const rows = await this.database
      .selectFrom("cloudDeploymentOperations")
      .selectAll()
      .where("ownerAccountId", "=", accountId)
      .where("status", "!=", "deleted")
      .orderBy("createdAt", "asc")
      .execute();
    return rows.map(projectOperation);
  }

  async get(
    accountId: ControlPlaneAccountId,
    operationId: string,
  ): Promise<CloudDeploymentOperation> {
    return projectOperation(await requireOwnedOperation(this.database, accountId, operationId));
  }

  async create(
    accountId: ControlPlaneAccountId,
    input: CreateCloudDeploymentRequest,
  ): Promise<CloudDeploymentOperation> {
    if (!this.options.provider || !this.options.cipher)
      throw new ControlPlaneError("unavailable", "Cloud deployment creation is not available");
    const cipher = this.options.cipher;
    const provider = this.options.provider;
    const request = CreateCloudDeploymentRequestSchema.parse(input);
    return withCloudOperationLock(this.database, request.operationId, async (database) => {
      const existing = await database
        .selectFrom("cloudDeploymentOperations")
        .selectAll()
        .where("operationId", "=", request.operationId)
        .executeTakeFirst();
      if (existing) {
        if (existing.ownerAccountId !== accountId || existing.name !== request.name) {
          throw new ControlPlaneError("conflict", "This creation request has already been used");
        }
        return projectOperation(existing);
      }
      try {
        await provider.validateConfiguration();
      } catch (error) {
        throw new ControlPlaneError(
          "unavailable",
          "Cloud deployment creation is temporarily unavailable",
          { cause: error },
        );
      }
      return database.transaction().execute(async (transaction) => {
        const deploymentId = DeploymentIdSchema.parse(`dep_${randomUUID()}`);
        const hostInstanceId = HostInstanceIdSchema.parse(`hst_${randomUUID()}`);
        const canonicalOrigin = `https://d-${deploymentId.slice(4).replaceAll("-", "")}.${this.options.domain}`;
        const keys = generateKeyPairSync("ed25519");
        const fingerprint = hostKeyFingerprint(
          keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
        );
        const provisioned = await this.store.provisionManagedDeployment(
          accountId,
          {
            deploymentId,
            hostInstanceId,
            canonicalOrigin,
            name: request.name,
            hostKeyFingerprint: fingerprint,
            reachability: "canonical",
          },
          transaction,
        );
        // Three computers, three one-use credentials, each scoped to the one
        // module its machine is for. A leaked browser token cannot come back
        // as something that executes agents.
        const runnerToken = randomBytes(32).toString("base64url");
        const bundle = ManagedHostProvisioningBundleSchema.parse({
          provisioningMode: "managed",
          controlApiOrigin: this.options.issuer,
          deployment: {
            deploymentId,
            hostInstanceId,
            canonicalOrigin,
            hostKeyFingerprint: fingerprint,
            reachability: "canonical",
          },
          hostCredential: provisioned.hostCredential,
          oidc: provisioned.oidc,
          oidcClientSecret: provisioned.oidcClientSecret,
          owner: provisioned.owner,
          initialRunnerEnrollmentToken: runnerToken,
        });
        const secrets = {
          "hosting-template.json": provider.captureConfiguration(),
          "account-bundle.json": JSON.stringify(bundle),
          "host-private.pem": keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
          "host-public.pem": keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
          "credential.key": randomBytes(32).toString("base64url"),
          OPENSTEER_AUTH_SECRET: randomBytes(48).toString("base64url"),
          POSTGRES_PASSWORD: randomBytes(32).toString("base64url"),
          OPENSTEER_RUNNER_ENROLLMENT_TOKEN: runnerToken,
          OPENSTEER_BROWSER_BRIDGE_TOKEN: randomBytes(32).toString("base64url"),
          OPENSTEER_BROWSER_RUNNER_ENROLLMENT_TOKEN: randomBytes(32).toString("base64url"),
          OPENSTEER_MESSAGING_RUNNER_ENROLLMENT_TOKEN: randomBytes(32).toString("base64url"),
        };
        const row = await transaction
          .insertInto("cloudDeploymentOperations")
          .values({
            operationId: request.operationId,
            ownerAccountId: accountId,
            deploymentId,
            name: request.name,
            canonicalOrigin,
            status: "creating",
            desiredState: "present",
            error: null,
            sealedMaterial: cipher.seal(request.operationId, secrets),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return projectOperation(row);
      });
    });
  }

  async retry(
    accountId: ControlPlaneAccountId,
    operationId: string,
  ): Promise<CloudDeploymentOperation> {
    if (!this.available)
      throw new ControlPlaneError(
        "unavailable",
        "Cloud deployment management is temporarily unavailable",
      );
    return withCloudOperationLock(this.database, operationId, async (database) => {
      const row = await requireOwnedOperation(database, accountId, operationId);
      if (row.status !== "failed") return projectOperation(row);
      const updated = await database
        .updateTable("cloudDeploymentOperations")
        .set({
          status: row.desiredState === "deleted" ? "deleting" : "creating",
          error: null,
          progress: null,
          updatedAt: new Date(),
        })
        .where("operationId", "=", operationId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return projectOperation(updated);
    });
  }

  async delete(
    accountId: ControlPlaneAccountId,
    operationId: string,
    name: string,
  ): Promise<CloudDeploymentOperation> {
    if (!this.available)
      throw new ControlPlaneError(
        "unavailable",
        "Cloud deployment management is temporarily unavailable",
      );
    return withCloudOperationLock(this.database, operationId, async (database) =>
      database.transaction().execute(async (transaction) => {
        const row = await requireOwnedOperation(transaction, accountId, operationId);
        if (name !== row.name)
          throw new ControlPlaneError(
            "bad_request",
            "Enter the deployment name to confirm deletion",
          );
        if (row.status === "deleted" || row.status === "deleting") return projectOperation(row);
        // Revoke publication and Account entry points with deletion intent, before external teardown.
        await transaction
          .selectFrom("deployments")
          .select("id")
          .where("id", "=", row.deploymentId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        await transaction
          .deleteFrom("deploymentCredentials")
          .where("deploymentId", "=", row.deploymentId)
          .execute();
        const deployment = await transaction
          .updateTable("deployments")
          .set({ authorityEnvelope: null })
          .where("id", "=", row.deploymentId)
          .returning("oidcClientId")
          .executeTakeFirstOrThrow();
        if (deployment.oidcClientId)
          await transaction
            .updateTable("oauthClients")
            .set({ disabled: true })
            .where("clientId", "=", deployment.oidcClientId)
            .execute();
        const updated = await transaction
          .updateTable("cloudDeploymentOperations")
          .set({
            desiredState: "deleted",
            status: "deleting",
            error: null,
            updatedAt: new Date(),
          })
          .where("operationId", "=", operationId)
          .returningAll()
          .executeTakeFirstOrThrow();
        return projectOperation(updated);
      }),
    );
  }

  /**
   * Operations still converging, plus present deployments that have not reached the release this
   * Account runs. Server-side apply is idempotent, so a converged deployment is never touched.
   */
  async reconcile(): Promise<void> {
    const provider = this.options.provider;
    if (!provider) return;
    const release = provider.currentRelease();
    const pending = await this.database
      .selectFrom("cloudDeploymentOperations")
      .select("operationId")
      .where((eb) =>
        eb.or([
          eb("status", "in", ["creating", "deleting"]),
          eb.and([
            eb("status", "=", "ready"),
            eb.or([eb("appliedRelease", "is", null), eb("appliedRelease", "!=", release)]),
          ]),
        ]),
      )
      .orderBy("lastReconciledAt", "asc")
      .limit(20)
      .execute();
    for (const { operationId } of pending) await this.reconcileOperation(operationId);
  }

  async reconcileOperation(operationId: string): Promise<void> {
    const { provider, cipher } = this.options;
    if (!provider || !cipher) return;
    await withCloudOperationLock(this.database, operationId, async (database) => {
      const row = await database
        .selectFrom("cloudDeploymentOperations")
        .selectAll()
        .where("operationId", "=", operationId)
        .executeTakeFirst();
      if (!row) return;
      const release = provider.currentRelease();
      // A present deployment is rolled forward in place: it exists and stays usable meanwhile.
      const rolling =
        row.status === "ready" && row.desiredState === "present" && row.appliedRelease !== release;
      if (row.status !== "creating" && row.status !== "deleting" && !rolling) return;
      await database
        .updateTable("cloudDeploymentOperations")
        .set({ lastReconciledAt: new Date() })
        .where("operationId", "=", operationId)
        .execute();
      try {
        if (!row.sealedMaterial) throw new Error("Cloud material is missing");
        const input = {
          operationId,
          deploymentId: row.deploymentId,
          canonicalOrigin: row.canonicalOrigin,
          name: row.name,
          secrets: cipher.open(operationId, row.sealedMaterial),
        };
        if (row.desiredState === "deleted") {
          if (!(await provider.delete(input))) {
            if (Date.now() - row.updatedAt.getTime() > 20 * 60 * 1_000)
              throw new Error("Cloud deletion timed out");
            return;
          }
          await database.transaction().execute(async (transaction) => {
            const deployment = await transaction
              .deleteFrom("deployments")
              .where("id", "=", row.deploymentId)
              .returning("oidcClientId")
              .executeTakeFirst();
            if (deployment?.oidcClientId)
              await transaction
                .deleteFrom("oauthClients")
                .where("clientId", "=", deployment.oidcClientId)
                .execute();
            await transaction
              .updateTable("cloudDeploymentOperations")
              .set({
                status: "deleted",
                sealedMaterial: null,
                error: null,
                progress: null,
                updatedAt: new Date(),
              })
              .where("operationId", "=", operationId)
              .execute();
          });
          return;
        }
        const workloads = await provider.ensure(input);
        if (!workloads.ready && workloads.failed) {
          throw new CloudOperationFailure(
            `${managedWorkloadLabel(workloads.failed.workload)} workload could not start (${workloads.failed.reason})`,
          );
        }
        if (rolling) {
          await database
            .updateTable("cloudDeploymentOperations")
            .set(
              workloads.ready
                ? { appliedRelease: release, progress: null, updatedAt: new Date() }
                : { progress: creatingProgress(workloads) },
            )
            .where("operationId", "=", operationId)
            .execute();
          return;
        }
        const deployment = await database
          .selectFrom("deployments")
          .selectAll()
          .where("id", "=", row.deploymentId)
          .executeTakeFirstOrThrow();
        const authority = HostDiscoveryEnvelopeSchema.safeParse(deployment.authorityEnvelope);
        const published =
          authority.success &&
          verifyHostDiscoveryEnvelope(authority.data) &&
          isSameHost(authority.data, {
            deploymentId: row.deploymentId,
            hostInstanceId: deployment.activeHostInstanceId,
            hostKeyFingerprint: deployment.hostKeyFingerprint,
          }) &&
          authority.data.document.canonicalOrigin === row.canonicalOrigin &&
          authority.data.document.deploymentShape.kind === "server" &&
          hostDiscoveryDefaultWorkspaceBacking(authority.data.document.deploymentShape) ===
            "portablefs";
        if (
          workloads.ready &&
          published &&
          (await cloudHostReady(
            row.canonicalOrigin,
            {
              deploymentId: row.deploymentId,
              hostInstanceId: deployment.activeHostInstanceId,
              hostKeyFingerprint: deployment.hostKeyFingerprint,
            },
            this.options.fetch,
          ))
        ) {
          await database
            .updateTable("cloudDeploymentOperations")
            .set({
              appliedRelease: release,
              error: null,
              progress: null,
              status: "ready",
              updatedAt: new Date(),
            })
            .where("operationId", "=", operationId)
            .execute();
          return;
        }
        // Kubernetes names a stuck workload long before this; the wall clock is the outer bound.
        if (Date.now() - row.updatedAt.getTime() > 20 * 60 * 1_000) {
          throw new CloudOperationFailure(
            workloads.ready
              ? "The deployment did not publish its signed Host identity. Retry to continue."
              : `${creatingProgress(workloads)} timed out. Retry to continue.`,
          );
        }
        await database
          .updateTable("cloudDeploymentOperations")
          .set({ progress: creatingProgress(workloads) })
          .where("operationId", "=", operationId)
          .execute();
      } catch (error) {
        this.options.onError?.(operationId, error);
        await database
          .updateTable("cloudDeploymentOperations")
          .set({
            status: "failed",
            error: operationFailureText(error, row.desiredState),
            progress: null,
            updatedAt: new Date(),
          })
          .where("operationId", "=", operationId)
          .execute();
      }
    });
  }
}

async function requireOwnedOperation(
  database: Kysely<ControlPlaneDatabaseSchema>,
  accountId: ControlPlaneAccountId,
  operationId: string,
): Promise<OperationRow> {
  const row = await database
    .selectFrom("cloudDeploymentOperations")
    .selectAll()
    .where("operationId", "=", operationId)
    .where("ownerAccountId", "=", accountId)
    .executeTakeFirst();
  if (!row) throw new ControlPlaneError("not_found", "Cloud deployment was not found");
  return row;
}

function projectOperation(row: OperationRow): CloudDeploymentOperation {
  return CloudDeploymentOperationSchema.parse({
    operationId: row.operationId,
    deploymentId: row.deploymentId,
    canonicalOrigin: row.canonicalOrigin,
    name: row.name,
    status: row.status,
    desiredState: row.desiredState,
    error: row.error,
    progress: row.progress,
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** What the page says under the status label while the operation is still moving. */
function creatingProgress(workloads: CloudDeploymentEnsureResult): string {
  const waiting = workloads.ready ? [] : (workloads.waiting ?? []);
  return waiting.length === 0
    ? "Waiting for the deployment to publish its signed Host identity"
    : `Starting ${waiting.map(managedWorkloadLabel).join(", ")}`;
}

function operationFailureText(error: unknown, desiredState: OperationRow["desiredState"]): string {
  if (error instanceof CloudOperationFailure) return error.message.slice(0, 512);
  return desiredState === "deleted"
    ? "Deletion could not finish. Retry to complete it."
    : "Setup could not finish. Retry to continue setting up this deployment.";
}

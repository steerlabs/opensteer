import { createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import {
  ControlPlaneAccountIdSchema,
  ManagedHostProvisioningBundleSchema,
} from "@opensteer/control-plane-protocol";
import { hostDiscoverySigningBytes } from "@opensteer/deployment-authority";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createControlPlaneDatabase } from "../database/database.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { ControlPlaneStore } from "../database/store.js";
import {
  CloudDeploymentLifecycle,
  type CloudDeploymentEnsureResult,
  type CloudDeploymentInput,
} from "./lifecycle.js";
import { publicHostDescriptor } from "./host-descriptor.test-support.js";
import { CloudMaterialCipher } from "./material.js";

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("durable cloud deployment lifecycle", () => {
  const database = createControlPlaneDatabase({
    connectionString: databaseUrl ?? "postgresql://unconfigured",
  });
  const issuer = "https://accounts.cloud.test.invalid";
  const domain = "cloud.test.invalid";
  const accountId = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
  const otherId = ControlPlaneAccountIdSchema.parse(`acct_${randomUUID()}`);
  const store = new ControlPlaneStore(database, new URL(issuer), {
    managedDeploymentDomain: domain,
  });
  const cipher = new CloudMaterialCipher(Buffer.alloc(32, 7).toString("base64url"));
  let release = "sha256:first";
  const provider = {
    captureConfiguration: () => JSON.stringify({ version: 1 }),
    currentRelease: () => release,
    validateConfiguration: vi.fn<() => Promise<void>>(),
    ensure: vi.fn<(input: CloudDeploymentInput) => Promise<CloudDeploymentEnsureResult>>(),
    delete: vi.fn<(input: CloudDeploymentInput) => Promise<boolean>>(),
  };
  const fetchPublicHost: typeof globalThis.fetch = async (input) => {
    const origin = new URL(String(input)).origin;
    const row = await database
      .selectFrom("deployments")
      .select("authorityEnvelope")
      .where("canonicalOrigin", "=", origin)
      .executeTakeFirst();
    return Response.json(row ? publicHostDescriptor(row.authorityEnvelope) : {});
  };
  const lifecycle = () =>
    new CloudDeploymentLifecycle(database, store, {
      issuer,
      domain,
      cipher,
      provider,
      fetch: fetchPublicHost,
    });
  beforeAll(async () => {
    await migrateControlPlaneToLatest(database);
  });
  beforeEach(async () => {
    await sql`truncate users, deployments, oauth_clients cascade`.execute(database);
    const now = new Date();
    await database
      .insertInto("users")
      .values(
        [accountId, otherId].map((id) => ({
          id,
          displayName: "Cloud owner",
          email: `${id}@example.test`,
          emailVerified: true,
          image: null,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .execute();
    release = "sha256:first";
    provider.ensure.mockReset().mockResolvedValue({ ready: false, waiting: ["host"] });
    provider.delete.mockReset().mockResolvedValue(true);
    provider.validateConfiguration.mockReset().mockResolvedValue();
  });
  afterAll(async () => {
    await database.destroy();
  });

  it("commits one identity and encrypted credential set for concurrent and restarted retries", async () => {
    const request = { operationId: randomUUID(), name: "My Opensteer" };
    const results = await Promise.all([
      lifecycle().create(accountId, request),
      lifecycle().create(accountId, request),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await database.selectFrom("deployments").selectAll().execute()).toHaveLength(1);
    expect(await database.selectFrom("oauthClients").selectAll().execute()).toHaveLength(1);
    const row = await database
      .selectFrom("cloudDeploymentOperations")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.sealedMaterial).not.toContain("hostCredential");
    await lifecycle().reconcile();
    await lifecycle().reconcile();
    expect(provider.ensure).toHaveBeenCalledTimes(2);
    expect(provider.ensure.mock.calls[0]![0].secrets).toEqual(
      provider.ensure.mock.calls[1]![0].secrets,
    );
    expect(JSON.stringify(results)).not.toContain("secrets");
    await expect(lifecycle().create(otherId, request)).rejects.toMatchObject({ code: "conflict" });
    await expect(
      lifecycle().create(accountId, { ...request, name: "Different" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("checks provider availability only before reserving a new identity", async () => {
    const request = { operationId: randomUUID(), name: "Cloud" };
    provider.validateConfiguration.mockRejectedValueOnce(new Error("hosting cluster unavailable"));

    await expect(lifecycle().create(accountId, request)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await database.selectFrom("deployments").selectAll().execute()).toEqual([]);
    expect(await database.selectFrom("cloudDeploymentOperations").selectAll().execute()).toEqual(
      [],
    );

    provider.validateConfiguration.mockResolvedValue();
    const created = await lifecycle().create(accountId, request);
    provider.validateConfiguration.mockRejectedValue(new Error("hosting cluster unavailable"));
    await expect(lifecycle().create(accountId, request)).resolves.toEqual(created);
    await expect(lifecycle().list(accountId)).resolves.toEqual([created]);
    expect(provider.validateConfiguration).toHaveBeenCalledTimes(2);
  });

  it("requires healthy workloads AND exact signed Host publication before becoming ready", async () => {
    const operation = await lifecycle().create(accountId, {
      operationId: randomUUID(),
      name: "Cloud",
    });
    provider.ensure.mockResolvedValue({ ready: true });
    await lifecycle().reconcile();
    expect((await lifecycle().list(accountId))[0]).toMatchObject({
      status: "creating",
      progress: "Waiting for the deployment to publish its signed Host identity",
    });
    const input = provider.ensure.mock.calls[0]![0];
    await publish(input);
    await lifecycle().reconcile();
    expect((await lifecycle().list(accountId))[0]?.status).toBe("ready");
    expect((await store.listDeployments(accountId))[0]?.id).toBe(operation.deploymentId);
  });

  it("names the workload Kubernetes gave up on instead of waiting out the clock", async () => {
    const operation = await lifecycle().create(accountId, {
      operationId: randomUUID(),
      name: "Cloud",
    });
    provider.ensure.mockResolvedValue({
      ready: false,
      waiting: ["browser-runtime", "channel-runtime"],
    });
    await lifecycle().reconcile();
    expect((await lifecycle().list(accountId))[0]).toMatchObject({
      status: "creating",
      error: null,
      progress: "Starting Browser, Messaging",
    });

    provider.ensure.mockResolvedValue({
      ready: false,
      failed: { reason: "ProgressDeadlineExceeded", workload: "channel-runtime" },
    });
    await lifecycle().reconcile();
    expect((await lifecycle().list(accountId))[0]).toMatchObject({
      status: "failed",
      error: "Messaging workload could not start (ProgressDeadlineExceeded)",
      progress: null,
    });

    // A fixed release reaches the broken deployment through Retry, with the same material.
    provider.ensure.mockResolvedValue({ ready: true });
    release = "sha256:fixed";
    await lifecycle().retry(accountId, operation.operationId);
    await lifecycle().reconcile();
    await publish(provider.ensure.mock.calls[0]![0]);
    await lifecycle().reconcile();
    expect((await lifecycle().list(accountId))[0]).toMatchObject({ status: "ready", error: null });
    expect(
      (await database.selectFrom("cloudDeploymentOperations").selectAll().executeTakeFirstOrThrow())
        .appliedRelease,
    ).toBe("sha256:fixed");
  });

  it("rolls a present deployment to the current release and leaves a converged one alone", async () => {
    await lifecycle().create(accountId, { operationId: randomUUID(), name: "Cloud" });
    provider.ensure.mockResolvedValue({ ready: true });
    await lifecycle().reconcile();
    await publish(provider.ensure.mock.calls[0]![0]);
    await lifecycle().reconcile();
    expect((await lifecycle().list(accountId))[0]?.status).toBe("ready");
    const converged = provider.ensure.mock.calls.length;

    // Nothing to converge to: server-side apply is not even attempted again.
    await lifecycle().reconcile();
    expect(provider.ensure).toHaveBeenCalledTimes(converged);

    release = "sha256:second";
    provider.ensure.mockResolvedValue({ ready: false, waiting: ["channel-runtime"] });
    await lifecycle().reconcile();
    expect(provider.ensure).toHaveBeenCalledTimes(converged + 1);
    // The deployment exists and is registered, so it stays "Created" while it rolls.
    expect((await lifecycle().list(accountId))[0]).toMatchObject({
      status: "ready",
      progress: "Starting Messaging",
    });

    provider.ensure.mockResolvedValue({ ready: true });
    await lifecycle().reconcile();
    expect((await lifecycle().list(accountId))[0]).toMatchObject({
      status: "ready",
      progress: null,
    });
    await lifecycle().reconcile();
    expect(provider.ensure).toHaveBeenCalledTimes(converged + 2);
  });

  it("fails a present deployment whose roll-out stalls and recovers it through retry", async () => {
    const operation = await lifecycle().create(accountId, {
      operationId: randomUUID(),
      name: "Cloud",
    });
    provider.ensure.mockResolvedValue({ ready: true });
    await lifecycle().reconcile();
    await publish(provider.ensure.mock.calls[0]![0]);
    await lifecycle().reconcile();

    release = "sha256:broken";
    provider.ensure.mockResolvedValue({
      ready: false,
      failed: { reason: "ProgressDeadlineExceeded", workload: "runner" },
    });
    await lifecycle().reconcile();
    expect((await lifecycle().list(accountId))[0]).toMatchObject({
      status: "failed",
      desiredState: "present",
      error: "Runner workload could not start (ProgressDeadlineExceeded)",
    });

    release = "sha256:repaired";
    provider.ensure.mockResolvedValue({ ready: true });
    await lifecycle().retry(accountId, operation.operationId);
    await lifecycle().reconcile();
    expect((await lifecycle().list(accountId))[0]?.status).toBe("ready");
  });

  it("failed setup retries the same material and does not create another deployment", async () => {
    const operation = await lifecycle().create(accountId, {
      operationId: randomUUID(),
      name: "Cloud",
    });
    provider.ensure.mockRejectedValueOnce(new Error("provider failed with private data"));
    await lifecycle().reconcile();
    expect((await lifecycle().list(accountId))[0]).toMatchObject({
      status: "failed",
      desiredState: "present",
    });
    expect(JSON.stringify(await lifecycle().list(accountId))).not.toContain("private data");
    await lifecycle().retry(accountId, operation.operationId);
    await lifecycle().reconcile();
    expect(provider.ensure.mock.calls[0]![0]).toEqual(provider.ensure.mock.calls[1]![0]);
    expect(await database.selectFrom("deployments").selectAll().execute()).toHaveLength(1);
  });

  it("deletion revokes access first, resumes teardown, atomically removes listing, and retains replay tombstone", async () => {
    const operation = await lifecycle().create(accountId, {
      operationId: randomUUID(),
      name: "Cloud",
    });
    await lifecycle().reconcile();
    const input = provider.ensure.mock.calls[0]![0];
    await publish(input);
    const bundle = ManagedHostProvisioningBundleSchema.parse(
      JSON.parse(input.secrets["account-bundle.json"]!),
    );
    await expect(lifecycle().delete(otherId, operation.operationId, "Cloud")).rejects.toMatchObject(
      { code: "not_found" },
    );
    await expect(
      lifecycle().delete(accountId, operation.operationId, "Wrong"),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(await store.listDeployments(accountId)).toHaveLength(1);
    await lifecycle().delete(accountId, operation.operationId, "Cloud");
    expect(await store.listDeployments(accountId)).toHaveLength(0);
    await expect(
      store.authenticateHostCredential(`Bearer ${bundle.hostCredential}`),
    ).rejects.toMatchObject({ code: "unauthorized" });
    provider.delete.mockRejectedValueOnce(new Error("teardown failed"));
    await lifecycle().reconcile();
    expect((await lifecycle().list(accountId))[0]).toMatchObject({
      status: "failed",
      desiredState: "deleted",
    });
    await lifecycle().retry(accountId, operation.operationId);
    await lifecycle().reconcile();
    expect(await lifecycle().list(accountId)).toHaveLength(0);
    expect(await database.selectFrom("deployments").selectAll().execute()).toHaveLength(0);
    expect(await database.selectFrom("oauthClients").selectAll().execute()).toHaveLength(0);
    expect(
      await lifecycle().create(accountId, { operationId: operation.operationId, name: "Cloud" }),
    ).toMatchObject({ status: "deleted" });
    expect(await lifecycle().delete(accountId, operation.operationId, "Cloud")).toMatchObject({
      status: "deleted",
    });
  });

  it("keeps operations visible if hosting is temporarily disabled", async () => {
    await lifecycle().create(accountId, { operationId: randomUUID(), name: "Cloud" });
    const disabled = new CloudDeploymentLifecycle(database, store, { issuer, domain });
    expect(disabled.available).toBe(false);
    expect(await disabled.list(accountId)).toHaveLength(1);
    await expect(
      disabled.create(accountId, { operationId: randomUUID(), name: "New" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await disabled.reconcile();
    expect(provider.ensure).not.toHaveBeenCalled();
  });

  async function publish(input: CloudDeploymentInput) {
    const bundle = ManagedHostProvisioningBundleSchema.parse(
      JSON.parse(input.secrets["account-bundle.json"]!),
    );
    const key = createPrivateKey(input.secrets["host-private.pem"]!);
    const document = {
      canonicalOrigin: input.canonicalOrigin,
      deploymentId: input.deploymentId,
      hostInstanceId: bundle.deployment.hostInstanceId,
      hostKey: { algorithm: "Ed25519" as const },
      deploymentShape: { defaultWorkspaceBacking: "portablefs" as const, kind: "server" as const },
    };
    // A managed Host publishes its signed identity on start, then projects membership.
    const authority = await store.authenticateHostCredential(`Bearer ${bundle.hostCredential}`);
    await store.publishHostAuthority(authority, {
      authorityEnvelope: {
        document,
        publicKey: {
          algorithm: "Ed25519",
          spki: createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url"),
        },
        signature: sign(null, hostDiscoverySigningBytes(document), key).toString("base64url"),
      },
    });
    await store.projectDirectoryEntry(authority, accountId, {
      hostInstanceId: bundle.deployment.hostInstanceId,
      generation: 1,
      present: true,
      observedAt: new Date().toISOString(),
    });
  }
});

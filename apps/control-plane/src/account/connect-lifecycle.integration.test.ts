import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  ControlPlaneAccountIdSchema,
  ConnectOperationIdSchema,
  PersonalHostAccessRouteEnvelopeSchema,
  personalHostAccessRouteSigningBytes,
  type ConnectOperationId,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import {
  HostKeyFingerprintSchema,
  createId,
  type DeploymentId,
  type HostInstanceId,
} from "@opensteer/core";
import { hostKeyFingerprint as fingerprintForSpki } from "@opensteer/deployment-authority";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type CloudflareConnectResource,
  type ConnectResourceProvider,
  type DeleteCloudflareConnectInput,
  type EnsureCloudflareConnectInput,
  type ProvisionedCloudflareConnect,
} from "./cloudflare-connect-provider.js";
import { ConnectLifecycleService } from "./connect-lifecycle.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { createHostCredential, hashCredential } from "../auth/credentials.js";
import { migrateControlPlaneToLatest } from "../database/migrations.js";
import { ControlPlaneStore } from "../database/store.js";

const databaseUrl = process.env.OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const publicOrigin = new URL("https://accounts.connect.test.invalid");
const managedDeploymentDomain = "connect.test.opensteer.invalid";

integration("Opensteer Connect lifecycle PostgreSQL boundary", () => {
  const database = createControlPlaneDatabase({
    connectionString: databaseUrl ?? "postgresql://unconfigured",
    maxConnections: 4,
  });
  const provider = new FakeConnectProvider();
  const lifecycle = new ConnectLifecycleService(database, provider, {
    managedConnectDomain: managedDeploymentDomain,
    operationLeaseMilliseconds: 1_000,
  });
  const store = new ControlPlaneStore(database, publicOrigin, {
    managedDeploymentDomain,
  });
  const ownerAccountId = accountId();
  const otherAccountId = accountId();

  beforeAll(async () => {
    await migrateControlPlaneToLatest(database);
  });

  beforeEach(async () => {
    provider.reset();
    await sql`
      truncate table deployments, oauth_clients, users cascade
    `.execute(database);
    const now = new Date();
    await database
      .insertInto("users")
      .values([account(ownerAccountId, now), account(otherAccountId, now)])
      .execute();
  });

  afterAll(async () => {
    await database.destroy();
  });

  it("persists only non-secret resource identity and returns the scoped token", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    const operationId = connectOperationId();
    const request = provisionRequest(fixture, operationId);
    const response = await lifecycle.provision(ownerAccountId, fixture.deploymentId, request);

    expect(response).toMatchObject({
      canonicalOrigin: fixture.canonicalOrigin,
      connectorCredentialGeneration: 1,
      deploymentId: fixture.deploymentId,
      hostInstanceId: fixture.hostInstanceId,
      hostKeyFingerprint: hostKeyFingerprint(),
      routeOrigin: expect.stringMatching(/^https:\/\/connect-/u),
      tunnelToken: provider.token,
    });
    const row = await database
      .selectFrom("deploymentConnectResources")
      .selectAll()
      .where("deploymentId", "=", fixture.deploymentId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      credentialGeneration: "1",
      dnsRecordId: provider.resource.dnsRecordId,
      lastCompletedOperationId: operationId,
      lastCompletedOperationKind: "provision",
      localOrigin: request.localOrigin,
      state: "ready",
      tunnelId: provider.resource.tunnelId,
    });
    expect(JSON.stringify(row)).not.toContain(provider.token);
    const operation = await database
      .selectFrom("deploymentConnectOperations")
      .selectAll()
      .where("deploymentId", "=", fixture.deploymentId)
      .where("operationId", "=", operationId)
      .executeTakeFirstOrThrow();
    expect(operation).toMatchObject({
      operationKind: "provision",
      resultGeneration: "1",
      state: "completed",
    });
    expect(JSON.stringify(operation)).not.toContain(provider.token);

    const replay = await lifecycle.provision(ownerAccountId, fixture.deploymentId, request);
    expect(replay.connectorCredentialGeneration).toBe(1);
    expect(provider.ensureCalls).toHaveLength(2);
    expect(provider.ensureCalls[1]?.expected).toEqual(provider.resource);
  });

  it("requires the fresh caller to own the exact active Host authority", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    const request = provisionRequest(fixture, connectOperationId());
    await expect(
      lifecycle.provision(otherAccountId, fixture.deploymentId, request),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      lifecycle.provision(ownerAccountId, fixture.deploymentId, {
        ...request,
        hostInstanceId: createId("hostInstance"),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(provider.ensureCalls).toHaveLength(0);
  });

  it("recovers a provider-created resource whose first response was lost before IDs persisted", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    const operationId = connectOperationId();
    const request = provisionRequest(fixture, operationId);
    provider.failAfterNextEnsure = true;
    await expect(
      lifecycle.provision(ownerAccountId, fixture.deploymentId, request),
    ).rejects.toMatchObject({ code: "internal" });
    await expect(
      database
        .selectFrom("deploymentConnectResources")
        .select(["dnsRecordId", "state", "tunnelId"])
        .where("deploymentId", "=", fixture.deploymentId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ dnsRecordId: null, state: "error", tunnelId: null });

    await expect(
      lifecycle.provision(ownerAccountId, fixture.deploymentId, request),
    ).resolves.toMatchObject({ connectorCredentialGeneration: 1, tunnelToken: provider.token });
    expect(provider.ensureCalls).toHaveLength(2);
    expect(provider.ensureCalls[0]?.expected).toBeUndefined();
    expect(provider.ensureCalls[1]?.expected).toBeUndefined();
  });

  it("does not let an older failed provision overwrite a later provision", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    const olderRequest = provisionRequest(fixture, connectOperationId());
    provider.failAfterNextEnsure = true;
    await expect(
      lifecycle.provision(ownerAccountId, fixture.deploymentId, olderRequest),
    ).rejects.toMatchObject({ code: "internal" });

    await expect(
      lifecycle.provision(ownerAccountId, fixture.deploymentId, {
        ...provisionRequest(fixture, connectOperationId()),
        localOrigin: "http://localhost:4310",
      }),
    ).resolves.toMatchObject({ connectorCredentialGeneration: 1 });
    const callsAfterLaterProvision = provider.ensureCalls.length;

    await expect(
      lifecycle.provision(ownerAccountId, fixture.deploymentId, olderRequest),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(provider.ensureCalls).toHaveLength(callsAfterLaterProvision);
  });

  it("revokes a deterministic provider resource even when its IDs never reached PostgreSQL", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    provider.failAfterNextEnsure = true;
    await expect(
      lifecycle.provision(
        ownerAccountId,
        fixture.deploymentId,
        provisionRequest(fixture, connectOperationId()),
      ),
    ).rejects.toMatchObject({ code: "internal" });

    await lifecycle.revoke(ownerAccountId, fixture.deploymentId, revokeRequest(fixture));
    expect(provider.deleteInputs).toEqual([
      {
        deploymentId: fixture.deploymentId,
        hostname: expect.stringMatching(/^connect-/u),
      },
    ]);
  });

  it("serializes concurrent exact retries and converges on one database generation", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    const request = provisionRequest(fixture, connectOperationId());
    const gate = provider.pauseNextEnsure();
    const first = lifecycle.provision(ownerAccountId, fixture.deploymentId, request);
    await gate.started;
    const second = lifecycle.provision(ownerAccountId, fixture.deploymentId, request);
    gate.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ connectorCredentialGeneration: 1 });
    expect(secondResult).toMatchObject({ connectorCredentialGeneration: 1 });
    expect(provider.ensureCalls).toHaveLength(2);
    expect(provider.maxConcurrentEnsures).toBe(1);
    await expect(
      database
        .selectFrom("deploymentConnectOperations")
        .select(["resultGeneration", "state"])
        .where("deploymentId", "=", fixture.deploymentId)
        .where("operationId", "=", request.operationId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ resultGeneration: "1", state: "completed" });
  });

  it("rejects a signed route origin until the managed resource is provisioned", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    const routeOrigin = `https://connect-${fixture.deploymentId.slice("dep_".length)}.${managedDeploymentDomain}`;
    await expect(
      lifecycle.requireCurrentRoute(fixture.deploymentId, routeOrigin),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await lifecycle.provision(
      ownerAccountId,
      fixture.deploymentId,
      provisionRequest(fixture, connectOperationId()),
    );
    await expect(
      lifecycle.requireCurrentRoute(fixture.deploymentId, routeOrigin),
    ).resolves.toBeUndefined();
    await expect(
      lifecycle.requireCurrentRoute(fixture.deploymentId, fixture.canonicalOrigin),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("uses signed route generation independently from connector credentials and liveness", async () => {
    const fixture = await personalLoopbackFixture(database, ownerAccountId);
    const credential = await lifecycle.provision(ownerAccountId, fixture.deploymentId, {
      hostInstanceId: fixture.hostInstanceId,
      localOrigin: fixture.authority.canonicalOrigin,
      operationId: connectOperationId(),
    });
    expect(credential.connectorCredentialGeneration).toBe(1);
    const document = {
      authority: fixture.authority,
      documentVersion: 2,
      purpose: "opensteer-personal-access-route",
      route: {
        // Private mode may already have consumed generations 1 through 6.
        generation: 7,
        kind: "connect",
        origin: credential.routeOrigin,
      },
    } as const;
    const accessRoute = PersonalHostAccessRouteEnvelopeSchema.parse({
      document,
      publicKey: { algorithm: "Ed25519", spki: fixture.publicKeySpki },
      schemaVersion: 1,
      signature: sign(
        null,
        personalHostAccessRouteSigningBytes(document),
        fixture.privateKey,
      ).toString("base64url"),
    });
    const authority = await store.authenticateHostCredential(`Bearer ${fixture.hostCredential}`);
    const request = {
      accessRoute,
      generation: 7,
      hostInstanceId: fixture.hostInstanceId,
      origin: credential.routeOrigin,
      state: "ready" as const,
    };
    await expect(store.projectConnect(authority, request)).resolves.toMatchObject({
      generation: 7,
      lastSeenAt: expect.any(String),
      origin: credential.routeOrigin,
      state: "ready",
    });

    const oldObservation = new Date("2020-01-01T00:00:00.000Z");
    await database
      .updateTable("deploymentConnect")
      .set({ observedAt: oldObservation })
      .where("deploymentId", "=", fixture.deploymentId)
      .executeTakeFirstOrThrow();
    const repeated = await store.projectConnect(authority, request);
    expect(repeated).toMatchObject({ generation: 7, state: "ready" });
    expect(Date.parse(repeated.lastSeenAt!)).toBeGreaterThan(oldObservation.getTime());

    await expect(
      store.projectConnect(authority, { ...request, state: "offline" }),
    ).resolves.toMatchObject({ generation: 7, lastSeenAt: null, state: "offline" });
    await expect(store.projectConnect(authority, request)).resolves.toMatchObject({
      generation: 7,
      state: "ready",
    });

    await expect(
      store.projectConnect(authority, {
        ...request,
        accessRoute: null,
        origin: null,
        state: "provisioning",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Connect route generation was reused for different route authority",
    });
  });

  it("recovers a lost rotation response, advances once, and replays the current token", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    await lifecycle.provision(
      ownerAccountId,
      fixture.deploymentId,
      provisionRequest(fixture, connectOperationId()),
    );
    const operationId = connectOperationId();
    provider.failAfterNextRotation = true;
    await expect(
      lifecycle.rotateCredential(ownerAccountId, fixture.deploymentId, {
        hostInstanceId: fixture.hostInstanceId,
        operationId,
      }),
    ).rejects.toMatchObject({ code: "internal" });

    const recovered = await lifecycle.rotateCredential(ownerAccountId, fixture.deploymentId, {
      hostInstanceId: fixture.hostInstanceId,
      operationId,
    });
    expect(recovered).toMatchObject({
      connectorCredentialGeneration: 2,
      tunnelToken: provider.token,
    });
    expect(provider.rotateCalls).toBe(2);

    const replay = await lifecycle.rotateCredential(ownerAccountId, fixture.deploymentId, {
      hostInstanceId: fixture.hostInstanceId,
      operationId,
    });
    expect(replay).toMatchObject({ connectorCredentialGeneration: 2, tunnelToken: provider.token });
    expect(provider.rotateCalls).toBe(2);
    expect(provider.readCalls).toBe(1);

    await expect(
      lifecycle.rotateCredential(ownerAccountId, fixture.deploymentId, {
        hostInstanceId: fixture.hostInstanceId,
        operationId: connectOperationId(),
      }),
    ).resolves.toMatchObject({ connectorCredentialGeneration: 3 });
    const callsAfterSecondRotation = provider.rotateCalls;
    await expect(
      lifecycle.rotateCredential(ownerAccountId, fixture.deploymentId, {
        hostInstanceId: fixture.hostInstanceId,
        operationId,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(provider.rotateCalls).toBe(callsAfterSecondRotation);
  });

  it("does not replay an older completed rotation after a later rotation may have changed the token", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    await lifecycle.provision(
      ownerAccountId,
      fixture.deploymentId,
      provisionRequest(fixture, connectOperationId()),
    );
    const olderOperationId = connectOperationId();
    await lifecycle.rotateCredential(ownerAccountId, fixture.deploymentId, {
      hostInstanceId: fixture.hostInstanceId,
      operationId: olderOperationId,
    });

    provider.failAfterNextRotation = true;
    await expect(
      lifecycle.rotateCredential(ownerAccountId, fixture.deploymentId, {
        hostInstanceId: fixture.hostInstanceId,
        operationId: connectOperationId(),
      }),
    ).rejects.toMatchObject({ code: "internal" });
    const readsBeforeStaleRetry = provider.readCalls;
    const rotationsBeforeStaleRetry = provider.rotateCalls;

    await expect(
      lifecycle.rotateCredential(ownerAccountId, fixture.deploymentId, {
        hostInstanceId: fixture.hostInstanceId,
        operationId: olderOperationId,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(provider.readCalls).toBe(readsBeforeStaleRetry);
    expect(provider.rotateCalls).toBe(rotationsBeforeStaleRetry);
  });

  it("immediately resumes the same internal revocation after a lost cleanup response", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    await lifecycle.provision(
      ownerAccountId,
      fixture.deploymentId,
      provisionRequest(fixture, connectOperationId()),
    );
    provider.failAfterNextDelete = true;
    const revocation = revokeRequest(fixture);
    await expect(
      lifecycle.revoke(ownerAccountId, fixture.deploymentId, revocation),
    ).rejects.toMatchObject({ code: "internal" });
    const failed = await database
      .selectFrom("deploymentConnectResources")
      .select(["operationId", "operationKind", "state"])
      .where("deploymentId", "=", fixture.deploymentId)
      .executeTakeFirstOrThrow();
    expect(failed).toMatchObject({ operationKind: "revoke", state: "error" });

    await lifecycle.revoke(ownerAccountId, fixture.deploymentId, revocation);
    expect(provider.deleteCalls).toBe(2);
    await expect(
      database
        .selectFrom("deploymentConnectOperations")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("deploymentId", "=", fixture.deploymentId)
        .where("operationKind", "=", "revoke")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "1" });
  });

  it("lets the exact Personal Host authority revoke and retry its own Connect resource", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    await lifecycle.provision(
      ownerAccountId,
      fixture.deploymentId,
      provisionRequest(fixture, connectOperationId()),
    );
    const authority = await store.authenticateHostCredential(`Bearer ${fixture.hostCredential}`);
    const request = revokeRequest(fixture);
    provider.failAfterNextDelete = true;

    await expect(lifecycle.revokeForHost(authority, request)).rejects.toMatchObject({
      code: "internal",
    });
    await expect(lifecycle.revokeForHost(authority, request)).resolves.toMatchObject({
      revoked: true,
    });
    expect(provider.deleteCalls).toBe(2);

    await expect(lifecycle.revokeForHost(authority, request)).resolves.toMatchObject({
      revoked: true,
    });
    expect(provider.deleteCalls).toBe(2);
  });

  it.each(["provision", "rotate"] as const)(
    "lets Host revocation immediately supersede crash residue from %s",
    async (operationKind) => {
      const fixture = await deploymentFixture(database, ownerAccountId);
      await lifecycle.provision(
        ownerAccountId,
        fixture.deploymentId,
        provisionRequest(fixture, connectOperationId()),
      );
      const interruptedOperationId = connectOperationId();
      const now = new Date();
      await database
        .insertInto("deploymentConnectOperations")
        .values({
          createdAt: now,
          deploymentId: fixture.deploymentId,
          operationId: interruptedOperationId,
          operationKind,
          requestFingerprint: createHash("sha256")
            .update(`interrupted-${operationKind}`, "utf8")
            .digest("base64url"),
          resultGeneration: null,
          state: "running",
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
      await database
        .updateTable("deploymentConnectResources")
        .set({
          operationExpiresAt: new Date(now.getTime() + 30 * 60_000),
          operationId: interruptedOperationId,
          operationKind,
          state: operationKind === "provision" ? "provisioning" : "rotating",
          updatedAt: now,
        })
        .where("deploymentId", "=", fixture.deploymentId)
        .executeTakeFirstOrThrow();

      const authority = await store.authenticateHostCredential(`Bearer ${fixture.hostCredential}`);
      await expect(
        lifecycle.revokeForHost(authority, revokeRequest(fixture)),
      ).resolves.toMatchObject({ revoked: true });
      expect(provider.deleteCalls).toBe(1);
      await expect(
        database
          .selectFrom("deploymentConnectResources")
          .select(["operationId", "operationKind", "state"])
          .where("deploymentId", "=", fixture.deploymentId)
          .executeTakeFirstOrThrow(),
      ).resolves.toMatchObject({ operationId: null, operationKind: null, state: "revoked" });
    },
  );

  it("makes a revoke wait for the provision holding the session lock before superseding it", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    const gate = provider.pauseNextEnsure();
    const provisioning = lifecycle.provision(
      ownerAccountId,
      fixture.deploymentId,
      provisionRequest(fixture, connectOperationId()),
    );
    await gate.started;
    let settled = false;
    const revoking = lifecycle
      .revoke(ownerAccountId, fixture.deploymentId, revokeRequest(fixture))
      .finally(() => {
        settled = true;
      });
    revoking.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
    // This is the invariant that lets a revoke supersede leftover operation
    // state unconditionally: while the lock is held by a live provision, the
    // revoke has not begun, so any residue it later finds is from a crash.
    expect(settled).toBe(false);
    expect(provider.deleteCalls).toBe(0);
    gate.release();
    await expect(provisioning).resolves.toMatchObject({ connectorCredentialGeneration: 1 });
    await expect(revoking).resolves.toMatchObject({ revoked: true });
    expect(provider.deleteCalls).toBe(1);
    await expect(
      database
        .selectFrom("deploymentConnectResources")
        .select(["operationId", "operationKind", "state"])
        .where("deploymentId", "=", fixture.deploymentId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ operationId: null, operationKind: null, state: "revoked" });
  });

  it("does not let one Host credential revoke another Deployment", async () => {
    const first = await deploymentFixture(database, ownerAccountId);
    const second = await deploymentFixture(database, ownerAccountId, "second-host");
    await lifecycle.provision(
      ownerAccountId,
      second.deploymentId,
      provisionRequest(second, connectOperationId()),
    );
    const firstAuthority = await store.authenticateHostCredential(`Bearer ${first.hostCredential}`);

    await expect(
      lifecycle.revokeForHost(
        { ...firstAuthority, deploymentId: second.deploymentId },
        revokeRequest(second),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(provider.deleteCalls).toBe(0);
    await expect(
      database
        .selectFrom("deploymentConnectResources")
        .select("state")
        .where("deploymentId", "=", second.deploymentId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ state: "ready" });
  });

  it("rejects stale Host request fences before touching the provider", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    const authority = await store.authenticateHostCredential(`Bearer ${fixture.hostCredential}`);
    const request = revokeRequest(fixture);

    await expect(
      lifecycle.revokeForHost(authority, {
        ...request,
        hostInstanceId: createId("hostInstance"),
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(provider.deleteCalls).toBe(0);
  });

  it("does not grant Host-authorized Connect revocation to self-hosted deployments", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    const authority = await store.authenticateHostCredential(`Bearer ${fixture.hostCredential}`);
    await database
      .updateTable("deployments")
      .set({ accountLink: null, reachability: "canonical" })
      .where("id", "=", fixture.deploymentId)
      .executeTakeFirstOrThrow();

    await expect(lifecycle.revokeForHost(authority, revokeRequest(fixture))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(provider.deleteCalls).toBe(0);
  });

  it("rejects a Personal Host authority whose Deployment is gone", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    const authority = await store.authenticateHostCredential(`Bearer ${fixture.hostCredential}`);
    await database
      .deleteFrom("deployments")
      .where("id", "=", fixture.deploymentId)
      .executeTakeFirstOrThrow();

    await expect(lifecycle.revokeForHost(authority, revokeRequest(fixture))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(provider.deleteCalls).toBe(0);
  });

  it("does not offer Connect for a cloud Deployment", async () => {
    const fixture = await deploymentFixture(database, ownerAccountId);
    await database
      .updateTable("deployments")
      .set({ accountLink: null, reachability: "canonical" })
      .where("id", "=", fixture.deploymentId)
      .executeTakeFirstOrThrow();
    await expect(
      lifecycle.provision(
        ownerAccountId,
        fixture.deploymentId,
        provisionRequest(fixture, connectOperationId()),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

class FakeConnectProvider implements ConnectResourceProvider {
  readonly resource: CloudflareConnectResource = {
    dnsRecordId: "d".repeat(32),
    hostname: "placeholder.invalid",
    tunnelId: "11111111-1111-4111-8111-111111111111",
    tunnelName: "placeholder",
  };
  deleteCalls = 0;
  deleteInputs: DeleteCloudflareConnectInput[] = [];
  activeEnsures = 0;
  ensureCalls: EnsureCloudflareConnectInput[] = [];
  failAfterNextEnsure = false;
  failAfterNextDelete = false;
  failAfterNextRotation = false;
  ensureGate:
    | {
        readonly release: Promise<void>;
        readonly resolveRelease: () => void;
        readonly resolveStarted: () => void;
      }
    | undefined;
  readCalls = 0;
  maxConcurrentEnsures = 0;
  rotateCalls = 0;
  rotationTokens = new Map<string, string>();
  token = "t".repeat(64);

  reset(): void {
    this.deleteCalls = 0;
    this.deleteInputs = [];
    this.activeEnsures = 0;
    this.ensureCalls = [];
    this.failAfterNextEnsure = false;
    this.failAfterNextDelete = false;
    this.failAfterNextRotation = false;
    this.ensureGate = undefined;
    this.readCalls = 0;
    this.maxConcurrentEnsures = 0;
    this.rotateCalls = 0;
    this.rotationTokens.clear();
    this.token = "t".repeat(64);
  }

  async ensure(input: EnsureCloudflareConnectInput): Promise<ProvisionedCloudflareConnect> {
    this.ensureCalls.push(input);
    this.activeEnsures += 1;
    this.maxConcurrentEnsures = Math.max(this.maxConcurrentEnsures, this.activeEnsures);
    try {
      Object.assign(this.resource, {
        hostname: input.hostname,
        tunnelName: `opensteer-${input.deploymentId.slice("dep_".length)}`,
      });
      const gate = this.ensureGate;
      if (gate) {
        this.ensureGate = undefined;
        gate.resolveStarted();
        await gate.release;
      }
      if (this.failAfterNextEnsure) {
        this.failAfterNextEnsure = false;
        throw new Error("response lost after deterministic resource creation");
      }
      return { ...this.resource, connectorToken: this.token };
    } finally {
      this.activeEnsures -= 1;
    }
  }

  pauseNextEnsure(): { readonly release: () => void; readonly started: Promise<void> } {
    let resolveRelease!: () => void;
    let resolveStarted!: () => void;
    const release = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    this.ensureGate = { release, resolveRelease, resolveStarted };
    return { release: resolveRelease, started };
  }

  async rotateConnectorToken(
    _resource: CloudflareConnectResource,
    operationId: ConnectOperationId,
  ): Promise<string> {
    this.rotateCalls += 1;
    this.token = this.rotationTokens.get(operationId) ?? String(this.rotateCalls % 10).repeat(64);
    this.rotationTokens.set(operationId, this.token);
    if (this.failAfterNextRotation) {
      this.failAfterNextRotation = false;
      throw new Error("response lost after upstream rotation");
    }
    return this.token;
  }

  async readConnectorToken(_resource: CloudflareConnectResource): Promise<string> {
    this.readCalls += 1;
    return this.token;
  }

  async delete(input: DeleteCloudflareConnectInput): Promise<void> {
    this.deleteCalls += 1;
    this.deleteInputs.push(input);
    if (this.failAfterNextDelete) {
      this.failAfterNextDelete = false;
      throw new Error("response lost after deterministic resource deletion");
    }
  }
}

async function deploymentFixture(
  database: ReturnType<typeof createControlPlaneDatabase>,
  ownerAccountId: ControlPlaneAccountId,
  hostKeySeed = "host",
): Promise<{
  readonly canonicalOrigin: string;
  readonly deploymentId: DeploymentId;
  readonly hostInstanceId: HostInstanceId;
  readonly hostCredential: string;
}> {
  const hostInstanceId = createId("hostInstance");
  const deploymentId = createId("deployment");
  const canonicalOrigin = `https://d-${deploymentId.slice("dep_".length)}.${managedDeploymentDomain}`;
  const hostCredential = createHostCredential();
  const oidcClientId = `osh_${deploymentId.slice("dep_".length)}`;
  const now = new Date();
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("oauthClients")
      .values({
        id: `oac_${crypto.randomUUID()}`,
        clientId: oidcClientId,
        clientSecret: hashCredential(`ocs_${"A".repeat(43)}`),
        disabled: false,
        skipConsent: true,
        enableEndSession: false,
        subjectType: "public",
        scopes: JSON.stringify(["openid", "profile", "email"]),
        userId: ownerAccountId,
        createdAt: now,
        updatedAt: now,
        name: "Connect test Host",
        uri: canonicalOrigin,
        icon: null,
        contacts: null,
        tos: null,
        policy: null,
        softwareId: "opensteer-host",
        softwareVersion: null,
        softwareStatement: null,
        redirectUris: JSON.stringify([`${canonicalOrigin}/v1/auth/oidc/callback`]),
        postLogoutRedirectUris: null,
        tokenEndpointAuthMethod: "client_secret_basic",
        grantTypes: JSON.stringify(["authorization_code"]),
        responseTypes: JSON.stringify(["code"]),
        public: false,
        type: "web",
        requirePkce: true,
        referenceId: `deployment:${deploymentId}`,
        metadata: { managedBy: "test-fixture", deploymentId },
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("deployments")
      .values({
        accountLink: {
          generation: "g".repeat(43),
          issuer: publicOrigin.origin,
          subject: ownerAccountId,
        },
        activeHostInstanceId: hostInstanceId,
        canonicalOrigin,
        createdAt: now,
        hostKeyFingerprint: hostKeyFingerprint(hostKeySeed),
        reachability: "routed",
        id: deploymentId,
        lifecycle: "active",
        name: "Connect fixture",
        oidcClientId,
        ownerAccountId,
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("deploymentCredentials")
      .values({
        createdAt: now,
        deploymentId,
        rotatedAt: now,
        tokenHash: hashCredential(hostCredential),
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("deploymentConnect")
      .values({
        accessRoute: null,
        deploymentId,
        generation: 0,
        observedAt: null,
        origin: null,
        state: "disabled",
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
  });
  return {
    canonicalOrigin,
    deploymentId,
    hostCredential,
    hostInstanceId,
  };
}

async function personalLoopbackFixture(
  database: ReturnType<typeof createControlPlaneDatabase>,
  ownerAccountId: ControlPlaneAccountId,
) {
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  const deploymentId = createId("deployment");
  const hostInstanceId = createId("hostInstance");
  const hostCredential = createHostCredential();
  const fingerprint = fingerprintForSpki(spki.toString("base64url"));
  const authority = {
    canonicalOrigin: "http://127.0.0.1:4310",
    deploymentId,
    hostInstanceId,
    hostKey: { algorithm: "Ed25519" },
    deploymentShape: {
      defaultWorkspaceBacking: "local-directory",
      kind: "personal" as const,
    },
  } as const;
  const now = new Date();
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("deployments")
      .values({
        accountLink: {
          generation: "g".repeat(43),
          issuer: publicOrigin.origin,
          subject: ownerAccountId,
        },
        activeHostInstanceId: hostInstanceId,
        canonicalOrigin: authority.canonicalOrigin,
        createdAt: now,
        hostKeyFingerprint: fingerprint,
        reachability: "routed",
        id: deploymentId,
        lifecycle: "active",
        name: "Personal loopback fixture",
        oidcClientId: null,
        ownerAccountId,
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("deploymentCredentials")
      .values({
        createdAt: now,
        deploymentId,
        rotatedAt: now,
        tokenHash: hashCredential(hostCredential),
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("deploymentConnect")
      .values({
        accessRoute: null,
        deploymentId,
        generation: 0,
        observedAt: null,
        origin: null,
        state: "disabled",
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
  });
  return {
    authority,
    deploymentId,
    hostCredential,
    hostInstanceId,
    privateKey: keys.privateKey,
    publicKeySpki: spki.toString("base64url"),
  };
}

function provisionRequest(
  fixture: { readonly hostInstanceId: HostInstanceId },
  operationId: ConnectOperationId,
) {
  return {
    hostInstanceId: fixture.hostInstanceId,
    localOrigin: "http://127.0.0.1:4310",
    operationId,
  };
}

function revokeRequest(fixture: { readonly hostInstanceId: HostInstanceId }) {
  return {
    hostInstanceId: fixture.hostInstanceId,
    operationId: connectOperationId(),
  };
}

function connectOperationId(): ConnectOperationId {
  return ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`);
}

function hostKeyFingerprint(seed = "host"): ReturnType<typeof HostKeyFingerprintSchema.parse> {
  return HostKeyFingerprintSchema.parse(
    `sha256:${Buffer.from(seed.padEnd(32, "x")).subarray(0, 32).toString("base64url")}`,
  );
}

function account(id: ControlPlaneAccountId, now: Date) {
  return {
    createdAt: now,
    displayName: `Account ${id}`,
    email: `${id}@example.test`,
    emailVerified: true,
    id,
    image: null,
    updatedAt: now,
  };
}

function accountId(): ControlPlaneAccountId {
  return ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`);
}

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createId, type DeploymentId } from "@opensteer/core";
import {
  ConnectOperationIdSchema,
  connectLivenessRefreshIntervalMilliseconds,
  type ConnectCredentialResponse,
  type ConnectOperationId,
  type ProvisionConnectRequest,
  type RevokeConnectRequest,
  type RotateConnectCredentialRequest,
} from "@opensteer/control-plane-protocol";
import { hostKeyFingerprint } from "@opensteer/deployment-authority";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonalHostConnectControlPlane } from "@opensteer/client/connections";
import type {
  CloudflaredConnectorConfiguration,
  CloudflaredConnectorStatus,
} from "./cloudflared-connector-supervisor.js";
import {
  DesktopConnectCredentialStateSchema,
  DesktopConnectCredentialStore,
} from "../secrets/connect-credential-store.js";
import {
  PersonalHostConnectOrchestrator,
  PersonalHostConnectTeardownCoordinator,
  type PersonalHostConnectorSupervisor,
} from "./personal-host-connect-orchestrator.js";
import {
  type PersonalHostConnectProjection,
  type PersonalHostConnectRouteSource,
  type PersonalHostRuntimeRecord,
} from "./personal-host-runtime.js";
import { testPersonalHostRuntime } from "./personal-host-runtime-test-support.js";
import type { DesktopSecretCryptography } from "../secrets/protected-json-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("PersonalHostConnectOrchestrator", () => {
  it("makes no control-plane call without an explicit Desktop-owned Host runtime", async () => {
    const fixture = await orchestratorFixture();
    fixture.runtime.current = null;

    await expect(fixture.orchestrator.reconcile()).resolves.toMatchObject({
      state: "unavailable",
    });
    await expect(fixture.orchestrator.enable()).rejects.toThrow(/Desktop-owned Personal Host/u);
    expect(fixture.controlPlane.calls).toEqual([]);
    expect(fixture.supervisor.startCalls).toHaveLength(0);
    expect(fixture.projections).toEqual([]);
  });

  it("persists a provision operation before I/O and retries the same ID after response loss", async () => {
    const fixture = await orchestratorFixture();
    fixture.controlPlane.failNextProvision = true;

    await expect(fixture.orchestrator.enable()).rejects.toThrow(/response was lost/u);
    const pending = await fixture.store.load(fixture.deploymentId);
    expect(pending).toMatchObject({
      credential: null,
      pendingOperation: { kind: "provision", operationId: fixture.operationIds[0] },
    });

    await expect(fixture.orchestrator.enable()).resolves.toMatchObject({
      generation: 1,
      state: "enabled",
    });
    const provisionCalls = fixture.controlPlane.calls.filter(
      (call): call is Extract<ControlPlaneCall, { kind: "provision" }> => call.kind === "provision",
    );
    expect(provisionCalls.map(({ request }) => request.operationId)).toEqual([
      fixture.operationIds[0],
      fixture.operationIds[0],
    ]);
    expect(fixture.operationIds).toHaveLength(1);
    expect(fixture.supervisor.startCalls).toHaveLength(1);
    expect(fixture.projections.map(({ state }) => state)).toEqual(["ready"]);
  });

  it("finishes a pending revoke before enabling with a new provision operation", async () => {
    const fixture = await orchestratorFixture();
    await fixture.orchestrator.enable();
    fixture.controlPlane.failNextRevoke = true;
    await expect(fixture.teardown.disable()).rejects.toThrow(/response was lost/u);
    const pending = await fixture.store.load(fixture.deploymentId);
    const revokeOperationId = pending?.pendingOperation?.operationId;
    expect(pending).toMatchObject({
      desiredState: "disabled",
      pendingOperation: { kind: "revoke", operationId: fixture.operationIds[1] },
    });

    fixture.controlPlane.failNextRevoke = true;
    await expect(fixture.orchestrator.enable()).rejects.toThrow(/response was lost/u);
    await expect(fixture.store.load(fixture.deploymentId)).resolves.toMatchObject({
      desiredState: "disabled",
      pendingOperation: { kind: "revoke", operationId: revokeOperationId },
    });
    expect(fixture.operationIds).toHaveLength(2);

    await expect(fixture.orchestrator.enable()).resolves.toMatchObject({
      generation: 1,
      state: "enabled",
    });
    expect(
      fixture.controlPlane.calls.map(({ kind, request }) => ({
        kind,
        operationId: request.operationId,
      })),
    ).toEqual([
      { kind: "provision", operationId: fixture.operationIds[0] },
      { kind: "revoke", operationId: revokeOperationId },
      { kind: "revoke", operationId: revokeOperationId },
      { kind: "revoke", operationId: revokeOperationId },
      { kind: "provision", operationId: fixture.operationIds[2] },
    ]);
    expect(fixture.operationIds).toHaveLength(3);
    expect(fixture.operationIds[2]).not.toBe(revokeOperationId);
    await expect(fixture.store.load(fixture.deploymentId)).resolves.toMatchObject({
      desiredState: "enabled",
      pendingOperation: null,
    });
    expect(fixture.projections.map(({ state }) => state)).toEqual(["ready", "disabled", "ready"]);
  });

  it("persists the fresh provision after cleanup and retries it without replaying revoke", async () => {
    const fixture = await orchestratorFixture();
    const revokeOperationId = ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`);
    await fixture.store.save(fixture.deploymentId, {
      authority: fixture.authority,
      credential: credential(fixture.authority, 1),
      desiredState: "disabled",
      pendingOperation: { kind: "revoke", operationId: revokeOperationId },
      schemaVersion: 2,
    });
    fixture.controlPlane.failNextProvision = true;

    await expect(fixture.orchestrator.enable()).rejects.toThrow(/response was lost/u);
    await expect(fixture.store.load(fixture.deploymentId)).resolves.toMatchObject({
      credential: null,
      desiredState: "enabled",
      pendingOperation: { kind: "provision", operationId: fixture.operationIds[0] },
    });

    await expect(fixture.orchestrator.enable()).resolves.toMatchObject({
      generation: 1,
      state: "enabled",
    });
    expect(
      fixture.controlPlane.calls.map(({ kind, request }) => ({
        kind,
        operationId: request.operationId,
      })),
    ).toEqual([
      { kind: "revoke", operationId: revokeOperationId },
      { kind: "provision", operationId: fixture.operationIds[0] },
      { kind: "provision", operationId: fixture.operationIds[0] },
    ]);
    expect(fixture.operationIds).toHaveLength(1);
    expect(fixture.projections.map(({ state }) => state)).toEqual(["disabled", "ready"]);
  });

  it("reuses the signed route generation when an enabled Connect request is repeated", async () => {
    const fixture = await orchestratorFixture();

    await expect(fixture.orchestrator.enable()).resolves.toMatchObject({
      generation: 1,
      state: "enabled",
    });
    await expect(fixture.orchestrator.enable()).resolves.toMatchObject({
      generation: 1,
      state: "enabled",
    });

    expect(fixture.routes.generation).toBe(1);
    expect(fixture.supervisor.startCalls).toHaveLength(1);
    expect(
      fixture.projections.map(({ accessRoute, state }) => ({
        generation: accessRoute?.document.route.generation,
        state,
      })),
    ).toEqual([
      { generation: 1, state: "ready" },
      { generation: 1, state: "ready" },
    ]);
  });

  it("refreshes Account liveness while the signed Connect route remains enabled", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await orchestratorFixture();
      await fixture.orchestrator.enable();
      expect(fixture.projections).toHaveLength(1);

      const refreshed = fixture.projection.waitForCalls(2);
      await vi.advanceTimersByTimeAsync(connectLivenessRefreshIntervalMilliseconds);
      await refreshed;

      expect(fixture.routes.generation).toBe(1);
      expect(fixture.supervisor.startCalls).toHaveLength(1);
      expect(fixture.projections.map(({ state }) => state)).toEqual(["ready", "ready"]);
      await fixture.orchestrator.shutdown();
      expect(fixture.projections.map(({ state }) => state)).toEqual(["ready", "ready"]);
      await vi.advanceTimersByTimeAsync(connectLivenessRefreshIntervalMilliseconds);
      expect(fixture.projections.map(({ state }) => state)).toEqual(["ready", "ready"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("explicit disable revokes a remote resource even when no local credential exists", async () => {
    const fixture = await orchestratorFixture();

    await expect(fixture.teardown.disable()).resolves.toBeUndefined();

    expect(fixture.controlPlane.calls).toHaveLength(1);
    expect(fixture.controlPlane.calls[0]).toMatchObject({ kind: "revoke" });
    expect(fixture.projections.map(({ state }) => state)).toEqual(["disabled"]);
    await expect(fixture.store.load(fixture.deploymentId)).resolves.toBeNull();
  });

  it("fences an authority change that happens while provisioning", async () => {
    const fixture = await orchestratorFixture();
    fixture.controlPlane.afterProvision = () => {
      fixture.runtime.current = testPersonalHostRuntime({
        ...fixture.authority,
        discovery: {
          ...fixture.authority.discovery,
          hostInstanceId: createId("hostInstance"),
        },
      });
    };

    await expect(fixture.orchestrator.enable()).rejects.toThrow(/authority changed/u);
    expect(fixture.orchestrator.status.state).toBe("fenced");
    expect(fixture.supervisor.startCalls).toHaveLength(0);
    expect(fixture.projections).toEqual([]);
    await expect(fixture.store.load(fixture.deploymentId)).resolves.toMatchObject({
      credential: null,
      pendingOperation: { kind: "provision" },
    });
  });

  it("rotates to a higher generation and durably retries revoke before clearing", async () => {
    const fixture = await orchestratorFixture();
    await fixture.orchestrator.enable();
    await fixture.store.save(fixture.deploymentId, {
      ...(await fixture.store.load(fixture.deploymentId))!,
      desiredState: "rotating",
      pendingOperation: {
        kind: "rotate",
        operationId: ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`),
      },
    });

    await expect(fixture.orchestrator.reconcile()).resolves.toMatchObject({
      generation: 2,
      state: "enabled",
    });
    expect(fixture.supervisor.rotateCalls).toHaveLength(1);
    expect(fixture.supervisor.rotateCalls[0]?.generation).toBe(2);

    fixture.controlPlane.failNextRevoke = true;
    await expect(fixture.teardown.disable()).rejects.toThrow(/response was lost/u);
    const pending = await fixture.store.load(fixture.deploymentId);
    expect(pending).toMatchObject({
      desiredState: "disabled",
      pendingOperation: { kind: "revoke" },
    });
    const revokeOperationId = pending?.pendingOperation?.operationId;

    const unlinkJournalOperationId = ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`);
    expect(unlinkJournalOperationId).not.toBe(revokeOperationId);
    await expect(
      fixture.teardown.revokeResourceForUnlink(unlinkJournalOperationId),
    ).resolves.toBeUndefined();
    const revokeCalls = fixture.controlPlane.calls.filter(
      (call): call is Extract<ControlPlaneCall, { kind: "revoke" }> => call.kind === "revoke",
    );
    expect(revokeCalls.map(({ request }) => request.operationId)).toEqual([
      revokeOperationId,
      revokeOperationId,
    ]);
    await expect(fixture.store.load(fixture.deploymentId)).resolves.toBeNull();
    expect(fixture.supervisor.status.state).toBe("stopped");
    expect(fixture.projections.map(({ state }) => state)).toEqual(["ready", "ready", "disabled"]);
  });

  it.each(["provision", "rotate"] as const)(
    "tears down persisted %s intent with Host authority and no Account management client",
    async (kind) => {
      const fixture = await orchestratorFixture();
      const interruptedOperationId = ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`);
      const unlinkOperationId = ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`);
      await fixture.store.save(fixture.deploymentId, {
        authority: fixture.authority,
        credential: kind === "rotate" ? credential(fixture.authority, 3) : null,
        desiredState: kind === "rotate" ? "rotating" : "enabled",
        pendingOperation: { kind, operationId: interruptedOperationId },
        schemaVersion: 2,
      });

      fixture.controlPlane.failNextRevoke = true;
      await expect(fixture.teardown.revokeResourceForUnlink(unlinkOperationId)).rejects.toThrow(
        "response was lost",
      );
      await expect(fixture.store.load(fixture.deploymentId)).resolves.toMatchObject({
        desiredState: "disabled",
        pendingOperation: { kind: "revoke", operationId: unlinkOperationId },
      });
      await expect(
        fixture.teardown.revokeResourceForUnlink(unlinkOperationId),
      ).resolves.toBeUndefined();

      expect(fixture.controlPlane.calls).toEqual([
        {
          kind: "revoke",
          request: {
            hostInstanceId: fixture.authority.discovery.hostInstanceId,
            operationId: unlinkOperationId,
          },
        },
        {
          kind: "revoke",
          request: {
            hostInstanceId: fixture.authority.discovery.hostInstanceId,
            operationId: unlinkOperationId,
          },
        },
      ]);
      expect(fixture.supervisor.status.state).toBe("stopped");
      expect(fixture.projections.map(({ state }) => state)).toEqual(["disabled"]);
      await expect(fixture.store.load(fixture.deploymentId)).resolves.toBeNull();
    },
  );

  it("resumes a pending revoke while the Host route is already Off", async () => {
    const fixture = await orchestratorFixture();
    await fixture.orchestrator.enable();
    fixture.controlPlane.failNextRevoke = true;
    await expect(fixture.teardown.disable()).rejects.toThrow("response was lost");
    await expect(fixture.store.load(fixture.deploymentId)).resolves.toMatchObject({
      desiredState: "disabled",
      pendingOperation: { kind: "revoke" },
    });

    await expect(fixture.orchestrator.reconcile()).resolves.toMatchObject({ state: "disabled" });
    await expect(fixture.store.load(fixture.deploymentId)).resolves.toBeNull();
    expect(fixture.routes.generation).toBe(2);
  });

  it("resumes a pending provision while the Host route is Off", async () => {
    const fixture = await orchestratorFixture();
    const operationId = ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`);
    await fixture.store.save(fixture.deploymentId, {
      authority: fixture.authority,
      credential: null,
      desiredState: "enabled",
      pendingOperation: { kind: "provision", operationId },
      schemaVersion: 2,
    });

    await expect(fixture.orchestrator.reconcile()).resolves.toMatchObject({
      generation: 1,
      state: "enabled",
    });
    expect(fixture.controlPlane.calls).toMatchObject([
      { kind: "provision", request: { operationId } },
    ]);
    expect(fixture.projections.map(({ state }) => state)).toEqual(["ready"]);
  });

  it("does not rerun an already-completed rotation after the rotated credential is lost locally", async () => {
    const fixture = await orchestratorFixture();
    await fixture.orchestrator.enable();
    await fixture.store.save(fixture.deploymentId, {
      ...(await fixture.store.load(fixture.deploymentId))!,
      desiredState: "rotating",
      pendingOperation: {
        kind: "rotate",
        operationId: ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`),
      },
    });
    fixture.controlPlane.failNextRotateAfterMutation = true;

    await expect(fixture.orchestrator.reconcile()).rejects.toThrow(/response was lost/u);
    await expect(fixture.orchestrator.reconcile()).resolves.toMatchObject({
      generation: 2,
      state: "enabled",
    });

    const rotateCalls = fixture.controlPlane.calls.filter(
      (call): call is Extract<ControlPlaneCall, { kind: "rotate" }> => call.kind === "rotate",
    );
    expect(rotateCalls).toHaveLength(2);
    expect(rotateCalls[0]?.request.operationId).toBe(rotateCalls[1]?.request.operationId);
    expect(fixture.controlPlane.rotationMutations).toBe(1);
  });

  it("keeps the completed revoke operation until the Host publishes disabled", async () => {
    const fixture = await orchestratorFixture();
    await fixture.orchestrator.enable();
    fixture.projection.failDisabledOnce = true;

    await expect(fixture.teardown.disable()).rejects.toThrow(/projection response was lost/u);
    const pending = await fixture.store.load(fixture.deploymentId);
    const operationId = pending?.pendingOperation?.operationId;
    expect(pending).toMatchObject({ pendingOperation: { kind: "revoke" } });

    await expect(fixture.teardown.disable()).resolves.toBeUndefined();
    const calls = fixture.controlPlane.calls.filter(
      (call): call is Extract<ControlPlaneCall, { kind: "revoke" }> => call.kind === "revoke",
    );
    expect(calls.map(({ request }) => request.operationId)).toEqual([operationId, operationId]);
    await expect(fixture.store.load(fixture.deploymentId)).resolves.toBeNull();
  });

  it("starts from a stored enabled credential but rejects one for an old authority", async () => {
    const fixture = await orchestratorFixture();
    await fixture.store.save(
      fixture.deploymentId,
      enabledState(fixture.authority, credential(fixture.authority, 7)),
    );
    await expect(fixture.orchestrator.reconcile()).resolves.toMatchObject({
      generation: 7,
      state: "enabled",
    });
    expect(fixture.supervisor.startCalls).toHaveLength(1);

    await fixture.orchestrator.quiesce();
    expect(fixture.projections.map(({ state }) => state)).toEqual(["ready"]);
    fixture.runtime.current = testPersonalHostRuntime({
      ...fixture.authority,
      discovery: {
        ...fixture.authority.discovery,
        hostInstanceId: createId("hostInstance"),
      },
    });
    await expect(fixture.orchestrator.reconcile()).rejects.toThrow(/earlier Personal Host/u);
    expect(fixture.orchestrator.status.state).toBe("fenced");
    expect(fixture.controlPlane.calls).toHaveLength(0);
  });
});

async function orchestratorFixture() {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-connect-orchestrator-"));
  temporaryDirectories.push(dataDirectory);
  const authority = personalHostRuntime();
  const deploymentId = authority.discovery.deploymentId;
  const runtime: { current: PersonalHostRuntimeRecord | null } = { current: authority };
  const store = new DesktopConnectCredentialStore({
    cryptography: fakeCryptography(),
    dataDirectory,
  });
  const controlPlane = new FakeControlPlane(authority);
  const supervisor = new FakeSupervisor();
  const projection = new FakeProjection();
  const routes = new FakeRoutes(authority);
  const operationIds: ConnectOperationId[] = [];
  const newOperationId = () => {
    const id = ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`);
    operationIds.push(id);
    return id;
  };
  const teardown = new PersonalHostConnectTeardownCoordinator({
    deploymentId,
    newOperationId,
    projection,
    revocation: controlPlane,
    runtime: { current: async () => runtime.current },
    store,
    supervisor,
  });
  const orchestrator = new PersonalHostConnectOrchestrator({
    controlPlane,
    deploymentId,
    newOperationId,
    projection,
    routes,
    runtime: { current: async () => runtime.current },
    store,
    supervisor,
    teardown,
  });
  return {
    authority,
    controlPlane,
    deploymentId,
    operationIds,
    orchestrator,
    projection,
    projections: projection.calls,
    runtime,
    routes,
    store,
    supervisor,
    teardown,
  };
}

type ControlPlaneCall =
  | { readonly kind: "provision"; readonly request: ProvisionConnectRequest }
  | { readonly kind: "revoke"; readonly request: RevokeConnectRequest }
  | { readonly kind: "rotate"; readonly request: RotateConnectCredentialRequest };

class FakeControlPlane implements PersonalHostConnectControlPlane {
  readonly calls: ControlPlaneCall[] = [];
  readonly #authority: PersonalHostRuntimeRecord;
  afterProvision: (() => void) | null = null;
  failNextProvision = false;
  failNextRevoke = false;
  failNextRotateAfterMutation = false;
  #generation = 0;
  readonly #rotations = new Map<ConnectOperationId, ConnectCredentialResponse>();

  get rotationMutations(): number {
    return this.#rotations.size;
  }

  constructor(authority: PersonalHostRuntimeRecord) {
    this.#authority = authority;
  }

  async provision(
    _deploymentId: DeploymentId,
    request: ProvisionConnectRequest,
  ): Promise<ConnectCredentialResponse> {
    this.calls.push({ kind: "provision", request });
    this.#generation = Math.max(this.#generation, 1);
    this.afterProvision?.();
    if (this.failNextProvision) {
      this.failNextProvision = false;
      throw new Error("The provision response was lost.");
    }
    return credential(this.#authority, this.#generation);
  }

  async rotate(
    _deploymentId: DeploymentId,
    request: RotateConnectCredentialRequest,
  ): Promise<ConnectCredentialResponse> {
    this.calls.push({ kind: "rotate", request });
    let rotated = this.#rotations.get(request.operationId);
    if (!rotated) {
      this.#generation += 1;
      rotated = credential(this.#authority, this.#generation);
      this.#rotations.set(request.operationId, rotated);
    }
    if (this.failNextRotateAfterMutation) {
      this.failNextRotateAfterMutation = false;
      throw new Error("The rotate response was lost.");
    }
    return rotated;
  }

  async revoke(
    _deploymentId: DeploymentId,
    request: RevokeConnectRequest,
  ): Promise<{ generation: number; revoked: true }> {
    this.calls.push({ kind: "revoke", request });
    if (this.failNextRevoke) {
      this.failNextRevoke = false;
      throw new Error("The revoke response was lost.");
    }
    return { generation: this.#generation, revoked: true };
  }

  async revokeConnectResource(operationId: ConnectOperationId): Promise<void> {
    await this.revoke(this.#authority.discovery.deploymentId, {
      hostInstanceId: this.#authority.discovery.hostInstanceId,
      operationId,
    });
  }
}

class FakeSupervisor implements PersonalHostConnectorSupervisor {
  readonly rotateCalls: CloudflaredConnectorConfiguration[] = [];
  readonly startCalls: CloudflaredConnectorConfiguration[] = [];
  status: CloudflaredConnectorStatus = emptySupervisorStatus();

  async rotateToken(configuration: CloudflaredConnectorConfiguration): Promise<void> {
    this.rotateCalls.push(configuration);
    this.status = supervisorStatus(configuration);
  }

  async start(configuration: CloudflaredConnectorConfiguration): Promise<void> {
    this.startCalls.push(configuration);
    this.status = supervisorStatus(configuration);
  }

  async stop(): Promise<void> {
    this.status = emptySupervisorStatus();
  }
}

class FakeProjection {
  readonly calls: PersonalHostConnectProjection[] = [];
  failDisabledOnce = false;
  readonly #waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];

  async publish(projection: PersonalHostConnectProjection): Promise<void> {
    this.calls.push(projection);
    for (const waiter of this.#waiters.splice(0)) {
      if (this.calls.length >= waiter.count) waiter.resolve();
      else this.#waiters.push(waiter);
    }
    if (projection.state === "disabled" && this.failDisabledOnce) {
      this.failDisabledOnce = false;
      throw new Error("The Host projection response was lost.");
    }
  }

  waitForCalls(count: number): Promise<void> {
    if (this.calls.length >= count) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push({ count, resolve }));
  }
}

class FakeRoutes implements PersonalHostConnectRouteSource {
  readonly #authority: PersonalHostRuntimeRecord;
  #routeOrigin: string | null = null;
  generation = 0;

  constructor(authority: PersonalHostRuntimeRecord) {
    this.#authority = authority;
  }

  async configureConnect(routeOrigin: string) {
    if (routeOrigin !== this.#routeOrigin) {
      this.#routeOrigin = routeOrigin;
      this.generation += 1;
    }
    return {
      document: {
        authority: this.#authority.discovery,
        documentVersion: 2 as const,
        purpose: "opensteer-personal-access-route" as const,
        route: {
          generation: this.generation,
          kind: "connect" as const,
          origin: routeOrigin,
        },
      },
      publicKey: { algorithm: "Ed25519" as const, spki: "A".repeat(59) },
      schemaVersion: 1 as const,
      signature: "A".repeat(86),
    };
  }

  async disableConnect(): Promise<void> {
    if (this.#routeOrigin !== null) {
      this.#routeOrigin = null;
      this.generation += 1;
    }
  }
}

function personalHostRuntime(): PersonalHostRuntimeRecord {
  return testPersonalHostRuntime({
    discovery: {
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "personal" as const,
      },
    },
    localOrigin: "http://127.0.0.1:4310",
    observedAt: "2026-08-11T10:00:00.000Z",
    ownership: "desktop-personal-host-supervisor",
    schemaVersion: 2,
    state: "ready",
    verification: "signed-loopback-discovery",
  });
}

function credential(
  authority: PersonalHostRuntimeRecord,
  generation: number,
): ConnectCredentialResponse {
  const discovery = authority.discovery;
  return {
    canonicalOrigin: discovery.canonicalOrigin,
    deploymentId: discovery.deploymentId,
    connectorCredentialGeneration: generation,
    hostInstanceId: discovery.hostInstanceId,
    hostKeyFingerprint: hostKeyFingerprint(authority.discoveryEnvelope.publicKey.spki),
    routeOrigin: `https://personal-${generation}.connect.opensteer.test`,
    tunnelToken: `eyJ${generation}${"x".repeat(80)}`,
  };
}

function enabledState(
  authority: PersonalHostRuntimeRecord,
  connectCredential: ConnectCredentialResponse,
) {
  return DesktopConnectCredentialStateSchema.parse({
    authority,
    credential: connectCredential,
    desiredState: "enabled",
    pendingOperation: null,
    schemaVersion: 2,
  });
}

function fakeCryptography(): DesktopSecretCryptography {
  return {
    decryptStringAsync: async (encrypted) => ({
      result: Buffer.from(encrypted.toString("utf8"), "base64").toString("utf8"),
      shouldReEncrypt: false,
    }),
    encryptStringAsync: async (plaintext) =>
      Buffer.from(Buffer.from(plaintext, "utf8").toString("base64"), "utf8"),
    getSelectedStorageBackend: () => "gnome_libsecret",
    isAsyncEncryptionAvailable: async () => true,
  };
}

function emptySupervisorStatus(): CloudflaredConnectorStatus {
  return {
    deploymentId: null,
    generation: null,
    hostInstanceId: null,
    lastError: null,
    lastHealthyAt: null,
    restartAttempt: 0,
    state: "stopped",
  };
}

function supervisorStatus(
  configuration: CloudflaredConnectorConfiguration,
): CloudflaredConnectorStatus {
  return {
    deploymentId: configuration.discovery.deploymentId,
    generation: configuration.generation,
    hostInstanceId: configuration.discovery.hostInstanceId,
    lastError: null,
    lastHealthyAt: "2026-08-11T10:00:00.000Z",
    restartAttempt: 0,
    state: "healthy",
  };
}

import { generateKeyPairSync } from "node:crypto";
import { createId, WorkspaceSchema } from "@opensteer/core";
import type { RunnerIdentity } from "@opensteer/orchestration";
import {
  PortableFsControlPlaneError,
  type PortableFsControlPlane,
  type PortableFsMountGrant,
} from "@opensteer/workspace-portablefs";
import { describe, expect, it, vi } from "vitest";
import { SignedTokenService } from "./host-keys.js";
import { MountExchangeService } from "./mount-exchange.js";

const certificate = "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----";
const csr = "-----BEGIN CERTIFICATE REQUEST-----\ntest\n-----END CERTIFICATE REQUEST-----";
const tokenAuthority = {
  deploymentId: createId("deployment"),
  hostInstanceId: createId("hostInstance"),
} as const;

describe("MountExchangeService", () => {
  it("issues a Workspace-scoped grant for a connected machine", async () => {
    const fixture = setup("local");
    const token = await fixture.service.issue(fixture.issueInput);

    const response = await fixture.service.exchange(token, { clientCertificateRequestPem: csr });

    const managerInput = fixture.issueGrant.mock.calls[0]?.[1];
    expect(managerInput).not.toHaveProperty("renewalEpoch");
    expect(managerInput).not.toHaveProperty("renewalScope");
    expect(fixture.mounts.recordIssued).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizedBy: fixture.requestedBy,
        environmentId: fixture.environmentId,
        membershipGeneration: 3,
      }),
    );
    expect(response).not.toHaveProperty("mountId");
    expect(response.automaticReauthorization).not.toHaveProperty("enrollmentExpiresAt");
  });

  it.each([
    ["membership generation", "membershipGeneration"],
    ["Workspace backing", "workspaceBackingGeneration"],
  ] as const)("rejects a stale %s before Manager issuance", async (_label, field) => {
    const fixture = setup("managed");
    const token = await fixture.service.issue(fixture.issueInput);
    fixture.authority[field] = (fixture.authority[field] ?? 0) + 1;

    await expect(
      fixture.service.exchange(token, { clientCertificateRequestPem: csr }),
    ).rejects.toThrow("stale mount authority");
    expect(fixture.issueGrant).not.toHaveBeenCalled();
  });

  it("revokes the issued enrollment when authority changes during the Manager call", async () => {
    const fixture = setup("managed");
    const token = await fixture.service.issue(fixture.issueInput);
    fixture.store.assertWorkspaceMountAuthority
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("authority fenced"));

    await expect(
      fixture.service.exchange(token, { clientCertificateRequestPem: csr }),
    ).rejects.toThrow("authority fenced");
    expect(fixture.mounts.revokeIssued).toHaveBeenCalledWith({
      enrollmentId: "22222222-2222-4222-8222-222222222222",
      reason: "opensteer-mount-authority-fenced",
      volumeId: fixture.workspace.backing.volumeId,
    });
  });

  it("rejects a token after the exact Runner boot disconnects", async () => {
    const fixture = setup("managed");
    const token = await fixture.service.issue(fixture.issueInput);
    fixture.runners.identityForEnvironment.mockReturnValue(undefined);

    await expect(
      fixture.service.exchange(token, { clientCertificateRequestPem: csr }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("returns a retryable Workspace outage when Manager issuance is unavailable", async () => {
    const fixture = setup("managed");
    fixture.issueGrant.mockRejectedValue(
      new PortableFsControlPlaneError({
        message: "manager unavailable",
        operation: "issue-mount-grant",
        retryable: true,
      }),
    );
    const token = await fixture.service.issue(fixture.issueInput);

    await expect(
      fixture.service.exchange(token, { clientCertificateRequestPem: csr }),
    ).rejects.toMatchObject({ code: "workspace_unavailable", retryable: true });
  });
});

function setup(runnerKind: "local" | "managed") {
  const environmentId = createId("environment");
  const requestedBy = createId("user");
  const parsedWorkspace = WorkspaceSchema.parse({
    backing: {
      generation: 4,
      kind: "portablefs",
      serviceId: "portablefs-test",
      volumeId: "volume_test",
    },
    capacityPolicy: {
      blockHardLimitBytes: 1_000_000,
      inodeHardLimit: 1_000,
      kind: "hard-quota",
    },
    createdAt: new Date().toISOString(),
    createdBy: createId("user"),
    id: createId("workspace"),
    homeThreadId: null,
    icon: null,
    kind: "specialized",
    name: "Test",
    status: "ready",
    storageIssue: null,
    updatedAt: new Date().toISOString(),
  });
  if (parsedWorkspace.backing.kind !== "portablefs") throw new Error("fixture backing");
  const workspace = { ...parsedWorkspace, backing: parsedWorkspace.backing };
  const identity = {
    bootId: "boot-test",
    capabilities: ["filesystem"],
    connectionGeneration: 1,
    connectionId: "rcn_00000000-0000-4000-8000-000000000000",
    modules: {
      agents: {
        environmentIds: [environmentId],
        harnessDrivers: [],
        maxConcurrentRuns: 1,
        workspaceBackings: ["portablefs"],
        localStorage: null,
        workspaceMounts: [],
      },
    },
    name: "Runner",
    runnerId: createId("runner"),
    runnerKind,
    runtimeVersion: "test",
  } as unknown as RunnerIdentity;
  const runners = {
    identityForEnvironment: vi.fn(
      (_environmentId: typeof environmentId) => identity as RunnerIdentity | undefined,
    ),
  };
  const authority = {
    membershipGeneration: 3,
    workspaceBackingGeneration: workspace.backing.generation,
  };
  const store = {
    assertWorkspaceMountAuthority: vi.fn(
      async (input: {
        readonly membershipGeneration: number;
        readonly workspaceBackingGeneration: number;
      }) => {
        if (
          input.membershipGeneration !== authority.membershipGeneration ||
          input.workspaceBackingGeneration !== authority.workspaceBackingGeneration
        ) {
          throw new Error("stale mount authority");
        }
      },
    ),
  };
  const mounts = {
    recordIssued: vi.fn(async (input) => ({ ...input, id: "wmt_test", status: "active" })),
    revokeIssued: vi.fn(async () => undefined),
  };
  const issueGrant = vi.fn(
    async (
      _volumeId: string,
      _input: Parameters<PortableFsControlPlane["issueAutomaticMountGrant"]>[1],
      _options?: Parameters<PortableFsControlPlane["issueAutomaticMountGrant"]>[2],
    ) => grant(workspace.backing.volumeId),
  );
  const controlPlane = controlPlaneFake(issueGrant);
  const service = new MountExchangeService({
    controlPlane,
    mounts: mounts as never,
    runners,
    store,
    tokens: new SignedTokenService(generateKeyPairSync("ed25519"), tokenAuthority),
  });
  return {
    authority,
    environmentId,
    issueGrant,
    issueInput: {
      environmentId,
      membershipGeneration: 3,
      requestedBy,
      runnerIdentity: identity,
      workspace,
    },
    mounts,
    requestedBy,
    runners,
    service,
    store,
    workspace,
  };
}

function grant(volumeId: string): PortableFsMountGrant {
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  return {
    access: ["write"],
    authorityAddress: "authority.internal:7443",
    authorityCaCertificatePem: certificate,
    authorityGeneration: 1,
    authorityServerName: "authority.internal",
    capability: "v1.payload.signature" as PortableFsMountGrant["capability"],
    certificateExpiresAt: expiresAt,
    clientCertificatePem: certificate,
    enrollment: {
      certificatePem: certificate,
      id: "22222222-2222-4222-8222-222222222222",
    },
    expiresAt,
    manager: {
      caCertificatePem: certificate,
      serverName: "manager.test",
      url: "https://manager.test",
    },
    managerReleaseId: "test",
    sequence: 0,
    volumeId: volumeId as PortableFsMountGrant["volumeId"],
  };
}

function controlPlaneFake(
  issueAutomaticMountGrant: PortableFsControlPlane["issueAutomaticMountGrant"],
): PortableFsControlPlane {
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    advanceRenewalFences: unused,
    archiveVolume: unused,
    capacity: unused,
    createVolume: unused,
    destroyVolume: unused,
    getVolume: unused,
    health: unused,
    issueAutomaticMountGrant,
    issueReadSessionGrant: unused,
    revokeMountEnrollment: unused,
    wakeVolume: unused,
  };
}

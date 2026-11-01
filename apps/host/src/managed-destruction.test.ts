import type { HostConfig } from "@opensteer/config";
import { createId, type Deployment, type Workspace } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import {
  assertManagedDestructionConfig,
  destroyManagedDeploymentData,
} from "./managed-destruction.js";

const deploymentId = createId("deployment");
const lentEnvironmentId = createId("environment");
const hostInstanceId = createId("hostInstance");

describe("managed deployment data destruction", () => {
  it("refuses non-managed and mismatched Host identities", () => {
    const config = managedConfig();
    expect(() =>
      assertManagedDestructionConfig(
        { ...config, account: { ...config.account, provisioningMode: "adoption" } },
        deploymentId,
      ),
    ).toThrow("managed Account deployment");
    expect(() => assertManagedDestructionConfig(config, createId("deployment"))).toThrow(
      "pinned Host identity",
    );
  });

  it("reports Workspaces on lent computers instead of claiming they were erased", async () => {
    const local: Workspace = {
      backing: {
        bindingId: createId("workspaceBinding"),
        generation: 1,
        kind: "local-directory",
        ownerEnvironmentId: lentEnvironmentId,
        storageAuthorityId: createId("storageAuthority"),
      },
      capacityPolicy: { kind: "host-filesystem" },
      createdAt: "2026-08-12T12:00:00.000Z",
      createdBy: createId("user"),
      homeThreadId: null,
      icon: null,
      id: createId("workspace"),
      kind: "specialized",
      name: "On a laptop",
      status: "ready",
      storageIssue: null,
      updatedAt: "2026-08-12T12:00:00.000Z",
    };
    const destroy = vi.fn(async (_input: { readonly workspace: Workspace }) => undefined);

    await expect(
      destroyManagedDeploymentData({
        config: managedConfig(),
        driver: { destroy },
        expectedDeploymentId: deploymentId,
        store: {
          getDeployment: async () => deployment(),
          listWorkspaces: async () => [portableWorkspace("volume_1"), local],
        },
      }),
    ).resolves.toEqual({
      destroyedPortableFsWorkspaces: 1,
      outstandingLocalWorkspaces: [
        { ownerEnvironmentId: lentEnvironmentId, workspaceId: local.id },
      ],
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("refuses a persisted identity mismatch before touching workspace storage", async () => {
    const destroy = vi.fn(async (_input: { readonly workspace: Workspace }) => undefined);
    await expect(
      destroyManagedDeploymentData({
        config: managedConfig(),
        driver: { destroy },
        expectedDeploymentId: deploymentId,
        store: {
          getDeployment: async () => ({ ...deployment(), id: createId("deployment") }),
          listWorkspaces: async () => [],
        },
      }),
    ).rejects.toThrow("persisted deployment identity");
    expect(destroy).not.toHaveBeenCalled();
  });

  it("accepts only a provably empty migrated database before Host initialization", async () => {
    const destroy = vi.fn(async (_input: { readonly workspace: Workspace }) => undefined);
    await expect(
      destroyManagedDeploymentData({
        config: managedConfig(),
        driver: { destroy },
        expectedDeploymentId: deploymentId,
        store: { getDeployment: async () => null, listWorkspaces: async () => [] },
      }),
    ).resolves.toEqual({ destroyedPortableFsWorkspaces: 0, outstandingLocalWorkspaces: [] });
    await expect(
      destroyManagedDeploymentData({
        config: managedConfig(),
        driver: { destroy },
        expectedDeploymentId: deploymentId,
        store: {
          getDeployment: async () => null,
          listWorkspaces: async () => [portableWorkspace("v")],
        },
      }),
    ).rejects.toThrow("without a deployment identity");
    await expect(
      destroyManagedDeploymentData({
        config: managedConfig(),
        driver: { destroy },
        expectedDeploymentId: deploymentId,
        store: {
          getDeployment: async () => null,
          listWorkspaces: async () => {
            throw new Error('relation "workspaces" does not exist');
          },
        },
      }),
    ).rejects.toThrow('relation "workspaces" does not exist');
    expect(destroy).not.toHaveBeenCalled();
  });
});

function deployment(): Deployment {
  return {
    activeHostInstanceId: hostInstanceId,
    canonicalOrigin: "https://managed.example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
    id: deploymentId,
    lifecycle: "active",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function portableWorkspace(volumeId: string): Workspace {
  return {
    backing: { generation: 1, kind: "portablefs", serviceId: "managed", volumeId },
    capacityPolicy: { blockHardLimitBytes: 1024, inodeHardLimit: 10, kind: "hard-quota" },
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: createId("user"),
    homeThreadId: null,
    icon: null,
    id: createId("workspace"),
    kind: "specialized",
    name: "Workspace",
    status: "ready",
    storageIssue: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function managedConfig(): HostConfig & { readonly account: NonNullable<HostConfig["account"]> } {
  return {
    account: {
      controlApiOrigin: new URL("https://account.example.com"),
      hostCredential: "credential",
      initialRunnerEnrollmentToken: undefined,
      issuer: new URL("https://account.example.com"),
      oidcClientId: "client",
      oidcClientSecret: "secret",
      owner: undefined,
      provisioningMode: "managed",
      reachability: "canonical",
    },
    acceptsExternalRunners: true,
    authSecret: "x".repeat(40),
    bindAddress: "0.0.0.0",
    browserRuntime: { attachKeyId: "host-browser-v1" },
    canonicalOrigin: new URL("https://managed.example.com"),
    credentialKeyPath: undefined,
    databaseUrl: "postgres://unused",
    dataDirectory: "/tmp/opensteer-test",
    deploymentIdentity: {
      deploymentId,
      hostInstanceId,
      hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
    },
    exposure: "networked",
    identity: {
      initialOwnerEnrollment: undefined,
      localPasswordEnabled: false,
      oidcConfigPath: undefined,
      signupPolicy: "closed",
    },
    executionLeaseMs: 90_000,
    maxConcurrentDispatches: 1,
    maxConcurrentTriggerDispatches: 1,
    mode: "production",
    port: 4310,
    privateKeyPath: undefined,
    publicKeyPath: undefined,
    runtimeOrigin: new URL("http://host:4310"),
    workspace: {
      deletionRetentionDays: 14,
      shape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
      storage: {
        archiveAfterDays: 7,
        authorizationDomain: "managed",
        defaultBlockLimitBytes: 1024,
        defaultInodeLimit: 10,
        filesServiceUrl: new URL("http://portablefs:4315"),
        kind: "portablefs",
        managerCaPath: undefined,
        managerCertPath: undefined,
        managerKeyPath: undefined,
        managerServerName: undefined,
        managerUrl: new URL("http://portablefs:4316"),
        maxBlockLimitBytes: 2048,
        maxInodeLimit: 20,
        productIssuer: "managed",
        productPrivateKeyPath: undefined,
        serviceId: "managed",
      },
    },
  };
}

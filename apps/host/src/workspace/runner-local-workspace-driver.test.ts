import {
  OpensteerError,
  createId,
  type EnvironmentId,
  type LocalWorkspaceBacking,
  type StorageAuthorityId,
  type Workspace,
} from "@opensteer/core";
import type { RunnerIdentity, WorkspaceLocalRequest } from "@opensteer/orchestration";
import {
  workspaceLocalOperationId,
  type RunnerWorkspaceLocalResult,
  type WorkspaceStorageFence,
} from "@opensteer/protocol";
import { WorkspaceAuthorityUnreachableError } from "@opensteer/workspace";
import { localWorkspaceBindingId } from "@opensteer/workspace/local-binding";
import { LocalWorkspaceAuthority } from "@opensteer/workspace-local";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LocalWorkspaceFailureError,
  RunnerLocalWorkspaceDriver,
  type RunnerStorageRegistry,
} from "./runner-local-workspace-driver.js";

const environmentId = createId("environment");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("RunnerLocalWorkspaceDriver", () => {
  it("refuses to admit a Workspace onto a machine that is not connected", () => {
    const driver = new RunnerLocalWorkspaceDriver({ runners: registry({ connected: false }) });

    expect(() => driver.initialBacking(provisionInput())).toThrow(/not connected right now/u);
  });

  it("refuses a machine that holds no directories of its own", () => {
    const driver = new RunnerLocalWorkspaceDriver({
      runners: registry({ storageAuthorityId: null }),
    });

    expect(() => driver.initialBacking(provisionInput())).toThrow(
      /does not hold Workspace directories/u,
    );
  });

  it("derives the same binding the owning machine derives, before touching any disk", () => {
    const storageAuthorityId = createId("storageAuthority");
    const driver = new RunnerLocalWorkspaceDriver({ runners: registry({ storageAuthorityId }) });
    const input = provisionInput();

    expect(driver.initialBacking(input)).toEqual({
      bindingId: localWorkspaceBindingId({
        createdBy: input.createdBy,
        idempotencyKey: workspaceLocalOperationId({
          generation: 1,
          operation: "provision",
          workspaceId: input.workspaceId,
        }),
        kind: input.kind,
        ownerEnvironmentId: environmentId,
        workspaceId: input.workspaceId,
      }),
      generation: 1,
      kind: "local-directory",
      ownerEnvironmentId: environmentId,
      storageAuthorityId,
    });
  });

  it("provisions the Host's initial binding through the Runner's local authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "opensteer-host-local-workspace-"));
    temporaryDirectories.push(root);
    const authority = new LocalWorkspaceAuthority({
      namespace: { kind: "single-owner", ownerEnvironmentId: environmentId },
      registryFilePath: path.join(root, "private", "workspace-registry.json"),
      visibleRootPath: path.join(root, "workspaces"),
    });
    const storageAuthorityId = await authority.storageAuthorityId();
    const driver = new RunnerLocalWorkspaceDriver({
      runners: registry({
        storageAuthorityId,
        answer: async (request, fence) => {
          if (request.type !== "host.workspace.local.provision") return unexpected(request, fence);
          await authority.provision({
            binding: request.binding,
            fingerprint: request.fingerprint,
            idempotencyKey: request.operationId,
          });
          return {
            binding: request.binding,
            fence,
            operationId: request.operationId,
            requestId: request.requestId,
            type: "runner.workspace.local.provisioned",
          };
        },
      }),
    });
    const input = provisionInput();
    const backing = driver.initialBacking(input);

    await expect(
      driver.provision({
        idempotencyKey: input.idempotencyKey,
        workspace: localWorkspace(backing),
      }),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(authority.inventory()).resolves.toMatchObject({
      bindings: [expect.objectContaining({ bindingId: backing.bindingId })],
    });
  });

  it("is globally available even while a machine is asleep, because one disk is not an outage", async () => {
    const driver = new RunnerLocalWorkspaceDriver({ runners: registry({ connected: false }) });

    await expect(driver.preflight()).resolves.toMatchObject({ available: true });
  });

  it("reports an unreachable machine as unreachable rather than as a missing directory", async () => {
    const driver = new RunnerLocalWorkspaceDriver({ runners: registry({ connected: false }) });

    await expect(driver.inspect(localWorkspace())).rejects.toBeInstanceOf(
      WorkspaceAuthorityUnreachableError,
    );
    await expect(driver.destroy({ workspace: localWorkspace() })).rejects.toBeInstanceOf(
      WorkspaceAuthorityUnreachableError,
    );
  });

  it("treats an answer fenced to an earlier connection as an unreachable machine", async () => {
    const driver = new RunnerLocalWorkspaceDriver({
      runners: registry({
        answer: (request, fence) => ({
          error: {
            code: "fence-stale",
            message: "This Workspace storage request belongs to an earlier connection.",
            retryable: true,
          },
          fence,
          operationId: request.operationId,
          requestId: request.requestId,
          type: "runner.workspace.local.error",
        }),
      }),
    });

    await expect(driver.inspect(localWorkspace())).rejects.toBeInstanceOf(
      WorkspaceAuthorityUnreachableError,
    );
  });

  it("refuses an answer from a machine holding another disk", async () => {
    const driver = new RunnerLocalWorkspaceDriver({
      runners: registry({ storageAuthorityId: createId("storageAuthority") }),
    });

    await expect(driver.inspect(localWorkspace())).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps a replaced directory a replaced directory, and never recreates it", async () => {
    const driver = new RunnerLocalWorkspaceDriver({
      runners: registry({
        answer: (request, fence) =>
          request.type === "host.workspace.local.inspect"
            ? {
                binding: request.binding,
                fence,
                health: {
                  issue: {
                    code: "directory-replaced",
                    message: "The managed Workspace directory has been replaced.",
                    retryable: false,
                  },
                  status: "failed",
                },
                operationId: request.operationId,
                requestId: request.requestId,
                type: "runner.workspace.local.inspected",
              }
            : unexpected(request, fence),
      }),
    });

    await expect(driver.inspect(localWorkspace())).resolves.toEqual({
      issue: expect.objectContaining({ code: "local-directory-replaced", retryable: false }),
      status: "failed",
    });
  });

  it("sends the same operation identity for every retry of one provision", async () => {
    const seen: string[] = [];
    const driver = new RunnerLocalWorkspaceDriver({
      runners: registry({
        answer: (request, fence) => {
          seen.push(request.operationId);
          return {
            binding: request.binding,
            fence,
            operationId: request.operationId,
            requestId: request.requestId,
            type: "runner.workspace.local.provisioned",
          };
        },
      }),
    });
    const workspace = localWorkspace();

    await driver.provision({ idempotencyKey: "ignored", workspace });
    await driver.provision({ idempotencyKey: "ignored", workspace });

    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toMatch(/:provision:v1:1$/u);
  });

  it("reports a destruction only from the receipt the owning machine returned", async () => {
    const destroyed = vi.fn();
    const driver = new RunnerLocalWorkspaceDriver({
      runners: registry({
        answer: (request, fence) => {
          destroyed();
          return {
            binding: request.binding,
            fence,
            operationId: request.operationId,
            receipt: { destroyedAt: "2026-08-12T12:00:00.000Z", outcome: "destroyed" },
            requestId: request.requestId,
            type: "runner.workspace.local.destroyed",
          };
        },
      }),
    });

    await expect(driver.destroy({ workspace: localWorkspace() })).resolves.toBeUndefined();
    expect(destroyed).toHaveBeenCalledOnce();
  });

  it("refuses to run a local Workspace anywhere but on the machine that holds it", () => {
    const driver = new RunnerLocalWorkspaceDriver({ runners: registry({}) });

    expect(() =>
      driver.planExecutionAccess({
        environmentId: createId("environment"),
        workspace: localWorkspace(),
      }),
    ).toThrow(/only on the computer that holds it/u);
  });

  it("translates a machine's own failure into the Workspace issue it means", () => {
    const driver = new RunnerLocalWorkspaceDriver({ runners: registry({}) });

    expect(
      driver.issueFromError(
        new LocalWorkspaceFailureError({
          code: "directory-missing",
          message: "The managed Workspace directory is missing.",
          retryable: false,
        }),
      ),
    ).toMatchObject({ code: "local-directory-missing", retryable: false });
    expect(
      driver.issueFromError(new WorkspaceAuthorityUnreachableError("That computer is asleep.")),
    ).toMatchObject({ code: "local-authority-unavailable", retryable: true });
  });
});

const fixedStorageAuthorityId = createId("storageAuthority");
const fixedWorkspaceId = createId("workspace");
const fixedCreatedBy = createId("user");

function provisionInput() {
  return {
    backingKind: "local-directory" as const,
    capacityPolicy: { kind: "host-filesystem" as const },
    createdBy: fixedCreatedBy,
    idempotencyKey: `workspace:${fixedWorkspaceId}:provision:v1`,
    kind: "specialized" as const,
    name: "Research",
    ownerEnvironmentId: environmentId,
    workspaceId: fixedWorkspaceId,
  };
}

function localBacking(): LocalWorkspaceBacking {
  return {
    bindingId: createId("workspaceBinding"),
    generation: 1,
    kind: "local-directory",
    ownerEnvironmentId: environmentId,
    storageAuthorityId: fixedStorageAuthorityId,
  };
}

function localWorkspace(
  backing: LocalWorkspaceBacking = localBacking(),
): Workspace & { readonly backing: LocalWorkspaceBacking } {
  const now = "2026-08-12T12:00:00.000Z";
  return {
    backing,
    capacityPolicy: { kind: "host-filesystem" },
    createdAt: now,
    createdBy: fixedCreatedBy,
    homeThreadId: null,
    icon: null,
    id: fixedWorkspaceId,
    kind: "specialized",
    name: "Research",
    status: "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

function registry(options: {
  readonly answer?: (
    request: WorkspaceLocalRequest,
    fence: WorkspaceStorageFence,
  ) => Promise<RunnerWorkspaceLocalResult> | RunnerWorkspaceLocalResult;
  readonly connected?: boolean;
  readonly storageAuthorityId?: StorageAuthorityId | null;
}): RunnerStorageRegistry {
  const connected = options.connected ?? true;
  const storageAuthorityId =
    options.storageAuthorityId === undefined ? fixedStorageAuthorityId : options.storageAuthorityId;
  return {
    identityForEnvironment: (candidate: EnvironmentId) =>
      connected && candidate === environmentId ? runnerIdentity(storageAuthorityId) : undefined,
    requestWorkspaceLocal: async (candidate, request) => {
      if (!connected) {
        throw new OpensteerError({
          code: "workspace_unavailable",
          message: "That computer is not connected right now.",
          retryable: true,
        });
      }
      if (storageAuthorityId !== request.binding.storageAuthorityId) {
        throw new OpensteerError({
          code: "conflict",
          message: "That computer does not hold the disk this Workspace lives on.",
        });
      }
      const fence: WorkspaceStorageFence = {
        bootId: "rbt_11111111-1111-4111-8111-111111111111" as WorkspaceStorageFence["bootId"],
        connectionGeneration: 1,
        connectionId:
          "rcn_11111111-1111-4111-8111-111111111111" as WorkspaceStorageFence["connectionId"],
        connectionLeaseId:
          "rls_11111111-1111-4111-8111-111111111111" as WorkspaceStorageFence["connectionLeaseId"],
        environmentId: candidate,
        runnerId: createId("runner"),
        storageAuthorityId: request.binding.storageAuthorityId,
      };
      return (await options.answer?.(request, fence)) ?? unexpected(request, fence);
    },
  };
}

function runnerIdentity(storageAuthority: StorageAuthorityId | null): RunnerIdentity {
  const runnerId = createId("runner");
  return {
    allowedModules: ["agents"],
    bootId: "rbt_11111111-1111-4111-8111-111111111111" as RunnerIdentity["bootId"],
    capabilities: ["filesystem"],
    connectionGeneration: 1,
    personalRemoteAccessGeneration: null,
    connectionId: "rcn_11111111-1111-4111-8111-111111111111" as RunnerIdentity["connectionId"],
    connectionLeaseId:
      "rls_11111111-1111-4111-8111-111111111111" as RunnerIdentity["connectionLeaseId"],
    environmentIds: [environmentId],
    fence: {
      bootId: "rbt_11111111-1111-4111-8111-111111111111" as RunnerIdentity["bootId"],
      connectionGeneration: 1,
      connectionId: "rcn_11111111-1111-4111-8111-111111111111" as RunnerIdentity["connectionId"],
      connectionLeaseId:
        "rls_11111111-1111-4111-8111-111111111111" as RunnerIdentity["connectionLeaseId"],
      runnerId,
    },
    modules: {
      agents: {
        environmentIds: [environmentId],
        harnessDrivers: [],
        localStorage:
          storageAuthority === null
            ? null
            : { bindings: [], storageAuthorityId: storageAuthority, truncated: false },
        maxConcurrentRuns: 1,
        providerStateModes: ["isolated"],
        workspaceBackings: ["local-directory"],
        workspaceMounts: [],
      },
    },
    name: "Lent machine",
    runnerId,
    runnerKind: "local",
    runtimeVersion: "test",
  };
}

function unexpected(
  request: WorkspaceLocalRequest,
  fence: WorkspaceStorageFence,
): RunnerWorkspaceLocalResult {
  return {
    error: { code: "invalid-request", message: "unexpected request", retryable: false },
    fence,
    operationId: request.operationId,
    requestId: request.requestId,
    type: "runner.workspace.local.error",
  };
}

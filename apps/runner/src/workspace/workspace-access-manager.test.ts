import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId, type EnvironmentId } from "@opensteer/core";
import type { PortableFsWorkspaceExecutionAccessPlan } from "@opensteer/workspace";
import { localWorkspaceBindingId } from "@opensteer/workspace/local-binding";
import { LocalWorkspaceAuthority } from "@opensteer/workspace-local";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunWorkspaceManager } from "./mount-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("RunWorkspaceManager", () => {
  it("resolves the exact protected local binding and leaves the durable directory in place", async () => {
    const fixture = await localFixture();
    const reads: Array<{ readonly path: string; readonly root: string }> = [];
    const manager = new RunWorkspaceManager({
      local: {
        environmentId: fixture.environmentId,
        namespace: "single-owner",
        resolver: fixture.driver,
        root: fixture.root,
        workspaceInstructionReader: {
          read: async (input) => {
            reads.push(input);
            return { content: Buffer.from("Keep this local.", "utf8") };
          },
        },
      },
    });

    await expect(manager.preflight()).resolves.toEqual({
      workspaceBackings: ["local-directory"],
    });
    const access = await manager.prepare({
      instructionsPath: "AGENTS.md",
      plan: fixture.plan,
      signal: new AbortController().signal,
    });

    expect(access.path).toBe(fixture.workspacePath);
    expect(access.instructions).toBe("Keep this local.");
    expect(reads).toEqual([{ path: "AGENTS.md", root: fixture.workspacePath }]);
    expect(
      manager.writableRoots({
        plan: fixture.plan,
        requestedBy: createId("user"),
        workspaceKind: "specialized",
        workspacePath: fixture.workspacePath,
      }),
    ).toEqual([fixture.workspacePath]);
    expect(
      manager.writableRoots({
        plan: fixture.plan,
        requestedBy: createId("user"),
        workspaceKind: "main",
        workspacePath: fixture.workspacePath,
      }),
    ).toEqual([fixture.root]);
    await expect(
      fixture.driver.resolveExecutionPath({
        environmentId: fixture.environmentId,
        plan: fixture.plan,
      }),
    ).resolves.toBe(fixture.workspacePath);
  });

  it("rejects a local access plan for another execution environment", async () => {
    const fixture = await localFixture();
    const otherEnvironmentId = createId("environment");
    const manager = localManager(fixture.driver, otherEnvironmentId, fixture.root);

    await expect(
      manager.prepare({
        instructionsPath: null,
        plan: fixture.plan,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("another execution environment");
  });

  it("rejects stale generations and a directory replaced at the same path", async () => {
    const fixture = await localFixture();
    const manager = localManager(fixture.driver, fixture.environmentId, fixture.root);

    await expect(
      manager.prepare({
        instructionsPath: null,
        plan: { ...fixture.plan, generation: fixture.plan.generation + 1 },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("generation is stale");

    await rename(fixture.workspacePath, `${fixture.workspacePath}.replaced`);
    await mkdir(fixture.workspacePath);
    await expect(
      manager.prepare({
        instructionsPath: null,
        plan: fixture.plan,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("has been replaced");
  });

  it("routes mixed backings without running PortableFS preflight for a local-only Runner", async () => {
    const fixture = await localFixture();
    const portableWorkspacePath = join(fixture.basePath, "portablefs-mounted");
    const portableFs = {
      ensureMounted: vi.fn(async () => ({ path: portableWorkspacePath })),
      namespaceRoot: vi.fn(() => fixture.root),
      preflight: vi.fn(async () => ({ portableFsVersion: "3.0.0-test" })),
      workspaceInstructionReader: unusedInstructionReader(),
    };
    const localOnly = localManager(fixture.driver, fixture.environmentId, fixture.root);

    await expect(localOnly.preflight()).resolves.toEqual({
      workspaceBackings: ["local-directory"],
    });
    expect(portableFs.preflight).not.toHaveBeenCalled();

    const mixed = new RunWorkspaceManager({
      local: {
        environmentId: fixture.environmentId,
        namespace: "single-owner",
        resolver: fixture.driver,
        root: fixture.root,
        workspaceInstructionReader: unusedInstructionReader(),
      },
      portableFs,
    });
    await expect(mixed.preflight()).resolves.toEqual({
      portableFsVersion: "3.0.0-test",
      workspaceBackings: ["local-directory", "portablefs"],
    });
    const access = await mixed.prepare({
      instructionsPath: null,
      plan: portableFsPlan(),
      signal: new AbortController().signal,
    });
    expect(access.path).toBe(portableWorkspacePath);
    expect(portableFs.ensureMounted).toHaveBeenCalledOnce();
  });
});

function localManager(
  driver: LocalWorkspaceAuthority,
  environmentId: EnvironmentId,
  root: string,
): RunWorkspaceManager {
  return new RunWorkspaceManager({
    local: {
      environmentId,
      namespace: "single-owner",
      resolver: driver,
      root,
      workspaceInstructionReader: unusedInstructionReader(),
    },
  });
}

async function localFixture() {
  const basePath = await mkdtemp(join(tmpdir(), "opensteer-runner-local-workspace-"));
  temporaryDirectories.push(basePath);
  const environmentId = createId("environment");
  const driver = new LocalWorkspaceAuthority({
    namespace: { kind: "single-owner", ownerEnvironmentId: environmentId },
    registryFilePath: join(basePath, "private", "workspace-registry.json"),
    visibleRootPath: join(basePath, "workspaces"),
  });
  const storageAuthorityId = await driver.storageAuthorityId();
  const intent = {
    createdBy: createId("user"),
    idempotencyKey: globalThis.crypto.randomUUID(),
    kind: "specialized" as const,
    ownerEnvironmentId: environmentId,
    workspaceId: createId("workspace"),
  };
  const binding = {
    bindingId: localWorkspaceBindingId(intent),
    generation: 1,
    ownerEnvironmentId: environmentId,
    storageAuthorityId,
    workspaceId: intent.workspaceId,
  };
  await driver.provision({
    binding,
    fingerprint: { createdBy: intent.createdBy, workspaceKind: intent.kind },
    idempotencyKey: intent.idempotencyKey,
  });
  const plan = { ...binding, kind: "local-directory" as const };
  const workspacePath = await driver.resolveExecutionPath({ environmentId, plan });
  return {
    basePath,
    driver,
    environmentId,
    plan,
    root: join(basePath, "workspaces"),
    workspacePath,
  };
}

function unusedInstructionReader() {
  return {
    read: async (): Promise<never> => {
      throw new Error("unexpected Workspace instruction read");
    },
  };
}

function portableFsPlan(): PortableFsWorkspaceExecutionAccessPlan {
  const workspaceId = createId("workspace");
  return {
    createdBy: createId("user"),
    exchangeToken: "opaque-exchange-token",
    exchangeUrl: "https://host.example/internal/v1/mount-grants/exchange",
    generation: 1,
    kind: "portablefs",
    volumeId: "workspace_volume",
    workspaceId,
    workspaceKind: "specialized",
  };
}

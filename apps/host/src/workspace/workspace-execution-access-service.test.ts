import { RunnerBootIdSchema } from "@opensteer/protocol";
import {
  ProjectRunBindingSchema,
  createId,
  type EnvironmentId,
  type Workspace,
} from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import type { RunnerLocalWorkspaceDriver } from "./runner-local-workspace-driver.js";
import { WorkspaceExecutionAccessService } from "./workspace-execution-access-service.js";

describe("WorkspaceExecutionAccessService", () => {
  it("issues Project storage only to its exact bound Workspace, environment and Runner boot", async () => {
    const environmentId = createId("environment");
    const workspace = { ...localWorkspace(environmentId), kind: "project" as const };
    const legacy = planInput({
      environmentId,
      runnerWorkspaceBackings: ["local-directory"],
      workspace,
    });
    const binding = ProjectRunBindingSchema.parse({
      authority: {
        version: 1,
        principal: {
          kind: "project",
          principalId: "pri-project-fixture",
          workspaceId: workspace.id,
        },
        origin: null,
      },
      workspaceId: workspace.id,
      environmentId,
      runnerId: legacy.runnerIdentity.runnerId,
      runnerBootId: legacy.runnerIdentity.bootId,
      runId: createId("run"),
      threadId: createId("thread"),
      bindingGeneration: 1,
      grantId: createId("grant"),
    });
    const planExecutionAccess = vi.fn(() => ({
      ...workspace.backing,
      workspaceId: workspace.id,
      storageAuthorityId: createId("storageAuthority"),
    }));
    const service = new WorkspaceExecutionAccessService({
      local: { planExecutionAccess },
      shape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
    });
    const input = { binding, workspace, runnerIdentity: legacy.runnerIdentity };
    expect(await service.planProject(input)).toMatchObject({
      workspaceId: workspace.id,
      ownerEnvironmentId: environmentId,
    });
    for (const changed of [
      { ...input, workspace: { ...workspace, id: createId("workspace") } },
      {
        ...input,
        runnerIdentity: {
          ...legacy.runnerIdentity,
          bootId: RunnerBootIdSchema.parse("rbt_00000000-0000-4000-8000-000000000001"),
        },
      },
      { ...input, runnerIdentity: { ...legacy.runnerIdentity, runnerId: createId("runner") } },
    ])
      await expect(service.planProject(changed)).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      service.planProject({
        ...input,
        binding: { ...binding, environmentId: createId("environment") },
      }),
    ).rejects.toThrow(/only in its owning environment/u);
    expect(planExecutionAccess).toHaveBeenCalledOnce();
  });
  it("returns a local access plan only for the owning, capable Runner", async () => {
    const environmentId = createId("environment");
    const workspace = localWorkspace(environmentId);
    const storageAuthorityId = createId("storageAuthority");
    const planExecutionAccess = vi.fn(() => ({
      bindingId: workspace.backing.bindingId,
      generation: workspace.backing.generation,
      kind: "local-directory" as const,
      ownerEnvironmentId: environmentId,
      storageAuthorityId,
      workspaceId: workspace.id,
    }));
    const service = localService({ planExecutionAccess });

    await expect(
      service.plan(
        planInput({ environmentId, runnerWorkspaceBackings: ["local-directory"], workspace }),
      ),
    ).resolves.toMatchObject({
      bindingId: workspace.backing.bindingId,
      kind: "local-directory",
      ownerEnvironmentId: environmentId,
      storageAuthorityId,
      workspaceId: workspace.id,
    });
    expect(planExecutionAccess).toHaveBeenCalledOnce();
  });

  it("fails before issuing access when the Runner did not advertise the backing", async () => {
    const environmentId = createId("environment");
    const workspace = localWorkspace(environmentId);
    const planExecutionAccess = vi.fn();
    const service = localService({ planExecutionAccess });

    await expect(
      service.plan(planInput({ environmentId, runnerWorkspaceBackings: [], workspace })),
    ).rejects.toThrow(/Runner does not support local-directory Workspace access/u);
    expect(planExecutionAccess).not.toHaveBeenCalled();
  });

  it("fails before issuing access when a local Workspace belongs to another environment", async () => {
    const workspace = localWorkspace(createId("environment"));
    const planExecutionAccess = vi.fn();
    const service = localService({ planExecutionAccess });

    await expect(
      service.plan(
        planInput({
          environmentId: createId("environment"),
          runnerWorkspaceBackings: ["local-directory"],
          workspace,
        }),
      ),
    ).rejects.toThrow(/only in its owning environment/u);
    expect(planExecutionAccess).not.toHaveBeenCalled();
  });
});

function localService(
  local: Pick<RunnerLocalWorkspaceDriver, "planExecutionAccess">,
): WorkspaceExecutionAccessService {
  return new WorkspaceExecutionAccessService({
    local,
    shape: { defaultWorkspaceBacking: "local-directory", kind: "personal" },
  });
}

function planInput(input: {
  readonly environmentId: EnvironmentId;
  readonly runnerWorkspaceBackings: readonly Workspace["backing"]["kind"][];
  readonly workspace: Workspace;
}): Parameters<WorkspaceExecutionAccessService["plan"]>[0] {
  return {
    environmentId: input.environmentId,
    membershipGeneration: 1,
    requestedBy: input.workspace.createdBy,
    runnerIdentity: {
      bootId: "boot-test",
      environmentIds: [input.environmentId],
      modules: {
        agents: {
          environmentIds: [input.environmentId],
          workspaceBackings: input.runnerWorkspaceBackings,
        },
      },
      runnerId: createId("runner"),
    } as never,
    workspace: input.workspace,
  };
}

function localWorkspace(ownerEnvironmentId: EnvironmentId): Workspace & {
  readonly backing: Extract<Workspace["backing"], { readonly kind: "local-directory" }>;
} {
  const now = new Date().toISOString();
  return {
    backing: {
      bindingId: createId("workspaceBinding"),
      generation: 1,
      kind: "local-directory",
      ownerEnvironmentId,
      storageAuthorityId: createId("storageAuthority"),
    },

    createdAt: now,
    createdBy: createId("user"),
    homeThreadId: null,
    voiceThreadId: null,
    icon: null,
    id: createId("workspace"),
    kind: "main",
    name: "Main",
    status: "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

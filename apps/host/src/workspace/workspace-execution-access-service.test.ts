import { createId, type EnvironmentId, type Workspace } from "@opensteer/core";
import type { RunnerLocalWorkspaceDriver } from "./runner-local-workspace-driver.js";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceExecutionAccessService } from "./workspace-execution-access-service.js";

describe("WorkspaceExecutionAccessService", () => {
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
      service.plan(
        planInput({ environmentId, runnerWorkspaceBackings: ["portablefs"], workspace }),
      ),
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

  it("holds local and shared access together, but gates PortableFS on the Deployment default", () => {
    const local = { planExecutionAccess: vi.fn() } as Pick<
      RunnerLocalWorkspaceDriver,
      "planExecutionAccess"
    >;

    expect(
      () =>
        new WorkspaceExecutionAccessService({
          local,
          portableFs: {} as never,
          shape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
        }),
    ).not.toThrow();
    expect(
      () =>
        new WorkspaceExecutionAccessService({
          local,
          portableFs: {} as never,
          shape: {
            defaultWorkspaceBacking: "local-directory",
            kind: "personal" as const,
          },
        }),
    ).toThrow(/requires a PortableFS Deployment default/u);
    expect(
      () =>
        new WorkspaceExecutionAccessService({
          shape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
        }),
    ).toThrow(/requires at least one driver/u);
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
    capacityPolicy: { kind: "host-filesystem" },
    createdAt: now,
    createdBy: createId("user"),
    homeThreadId: null,
    icon: null,
    id: createId("workspace"),
    kind: "main",
    name: "Main",
    status: "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

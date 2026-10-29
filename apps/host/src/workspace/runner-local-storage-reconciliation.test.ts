import {
  createId,
  type EnvironmentId,
  type StorageAuthorityId,
  type Workspace,
  type WorkspaceBindingId,
} from "@opensteer/core";
import type { RunnerLocalStorageInventory } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  reconcileLocalStorageInventory,
  reconcileRunnerLocalStorage,
  unlinkedLocalBindingCount,
} from "./runner-local-storage-reconciliation.js";

const environmentId = createId("environment");
const storageAuthorityId = createId("storageAuthority");

function localWorkspace(options: {
  readonly bindingId: WorkspaceBindingId;
  readonly ownerEnvironmentId?: EnvironmentId;
  readonly status?: Workspace["status"];
  readonly storageAuthorityId?: StorageAuthorityId;
}): Workspace {
  const now = "2026-09-01T10:00:00.000Z";
  return {
    backing: {
      bindingId: options.bindingId,
      generation: 1,
      kind: "local-directory",
      ownerEnvironmentId: options.ownerEnvironmentId ?? environmentId,
      storageAuthorityId: options.storageAuthorityId ?? storageAuthorityId,
    },
    capacityPolicy: { kind: "host-filesystem" },
    createdAt: now,
    createdBy: createId("user"),
    homeThreadId: null,
    icon: null,
    id: createId("workspace"),
    kind: "specialized",
    name: "Research",
    status: options.status ?? "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

function inventory(
  bindings: readonly WorkspaceBindingId[],
  options: { readonly truncated?: boolean } = {},
): RunnerLocalStorageInventory {
  return {
    bindings: bindings.map((bindingId) => ({
      bindingId,
      generation: 1,
      state: "ready" as const,
      workspaceId: createId("workspace"),
    })),
    storageAuthorityId,
    truncated: options.truncated ?? false,
  };
}

describe("reconcileLocalStorageInventory", () => {
  it("reports a ready Workspace whose binding the machine no longer holds", () => {
    const held = createId("workspaceBinding");
    const gone = localWorkspace({ bindingId: createId("workspaceBinding") });

    expect(
      reconcileLocalStorageInventory({
        inventory: inventory([held]),
        workspaces: [localWorkspace({ bindingId: held }), gone],
      }),
    ).toEqual({ missingWorkspaceIds: [gone.id] });
  });

  it("infers nothing from a truncated inventory", () => {
    const gone = localWorkspace({ bindingId: createId("workspaceBinding") });

    expect(
      reconcileLocalStorageInventory({
        inventory: inventory([], { truncated: true }),
        workspaces: [gone],
      }),
    ).toEqual({ missingWorkspaceIds: [] });
  });

  it("ignores a Workspace held on a different disk, even in the same environment", () => {
    const elsewhere = localWorkspace({
      bindingId: createId("workspaceBinding"),
      storageAuthorityId: createId("storageAuthority"),
    });

    expect(
      reconcileLocalStorageInventory({ inventory: inventory([]), workspaces: [elsewhere] }),
    ).toEqual({ missingWorkspaceIds: [] });
  });

  it("leaves a Workspace that is not yet verified ready to the lifecycle", () => {
    const provisioning = localWorkspace({
      bindingId: createId("workspaceBinding"),
      status: "provisioning",
    });

    expect(
      reconcileLocalStorageInventory({ inventory: inventory([]), workspaces: [provisioning] }),
    ).toEqual({ missingWorkspaceIds: [] });
  });
});

describe("unlinkedLocalBindingCount", () => {
  it("counts the folders a machine holds that no Workspace claims", () => {
    const known = createId("workspaceBinding");

    expect(
      unlinkedLocalBindingCount({
        inventory: inventory([known, createId("workspaceBinding"), createId("workspaceBinding")]),
        workspaces: [localWorkspace({ bindingId: known })],
      }),
    ).toBe(2);
  });

  it("counts nothing for a machine that holds no local directories", () => {
    expect(unlinkedLocalBindingCount({ inventory: null, workspaces: [] })).toBe(0);
  });

  it("does not credit a binding recorded against another disk", () => {
    const bindingId = createId("workspaceBinding");

    expect(
      unlinkedLocalBindingCount({
        inventory: inventory([bindingId]),
        workspaces: [
          localWorkspace({ bindingId, storageAuthorityId: createId("storageAuthority") }),
        ],
      }),
    ).toBe(1);
  });
});

describe("reconcileRunnerLocalStorage", () => {
  it("marks a Workspace whose directory the machine stopped reporting", async () => {
    const gone = localWorkspace({ bindingId: createId("workspaceBinding") });
    const setWorkspaceStorageState = vi.fn(async () => gone);
    const store = {
      listLocalWorkspacesForEnvironments: vi.fn(async () => [gone]),
      setWorkspaceStorageState,
    };

    await reconcileRunnerLocalStorage(
      { modules: { agents: agentsModule(inventory([])) } },
      store as never,
      () => new Date("2026-09-12T00:00:00.000Z"),
    );

    expect(store.listLocalWorkspacesForEnvironments).toHaveBeenCalledWith([environmentId]);
    expect(setWorkspaceStorageState).toHaveBeenCalledWith({
      issue: {
        code: "local-directory-missing",
        message: "This Workspace's folder is no longer on the computer that holds it.",
        occurredAt: "2026-09-12T00:00:00.000Z",
        retryable: false,
      },
      status: "failed",
      workspaceId: gone.id,
    });
  });

  it("asks the store nothing for a machine that holds no local directories", async () => {
    const store = {
      listLocalWorkspacesForEnvironments: vi.fn(async () => []),
      setWorkspaceStorageState: vi.fn(),
    };

    await reconcileRunnerLocalStorage({ modules: { agents: agentsModule(null) } }, store as never);

    expect(store.listLocalWorkspacesForEnvironments).not.toHaveBeenCalled();
  });
});

function agentsModule(localStorage: RunnerLocalStorageInventory | null) {
  return {
    environmentIds: [environmentId],
    harnessDrivers: [],
    localStorage,
    maxConcurrentRuns: 2,
    providerStateModes: ["isolated" as const],
    workspaceBackings: [localStorage ? ("local-directory" as const) : ("portablefs" as const)],
    workspaceMounts: [],
  };
}

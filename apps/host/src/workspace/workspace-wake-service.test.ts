import { createId, type Workspace } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceWakeService } from "./workspace-wake-service.js";

describe("WorkspaceWakeService", () => {
  it("single-flights an archived Workspace wake and starts provisioning", async () => {
    const workspace = archivedWorkspace();
    let finish!: (value: ReturnType<typeof managerVolume>) => void;
    const wakeVolume = vi.fn(
      () =>
        new Promise<ReturnType<typeof managerVolume>>((resolve) => {
          finish = resolve;
        }),
    );
    const setWorkspaceStorageState = vi.fn(async () => workspace);
    const service = new WorkspaceWakeService({
      controlPlane: { wakeVolume },
      store: { getWorkspace: async () => workspace, setWorkspaceStorageState },
      workspaces: { recordControlPlaneFailure: vi.fn() },
    });

    const first = service.wake(workspace.id, "message-send");
    const second = service.wake(workspace.id, "dispatch");
    await vi.waitFor(() => expect(wakeVolume).toHaveBeenCalledOnce());
    finish(managerVolume());
    await Promise.all([first, second]);

    // Per call, never per lifecycle: a stable key would let a Manager receipt
    // from an earlier archive/wake cycle satisfy this one.
    expect(wakeVolume).toHaveBeenCalledWith(workspace.backing.volumeId, {
      idempotencyKey: expect.stringMatching(
        new RegExp(
          `^workspace:${workspace.id}:wake:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
        ),
      ),
    });
    expect(setWorkspaceStorageState).toHaveBeenCalledWith({
      issue: null,
      status: "provisioning",
      workspaceId: workspace.id,
    });
  });

  it("wakes a Workspace whose archive cycle is still running", async () => {
    // Wake is what cancels a quiescing archive at the Manager, so a Workspace
    // that has been claimed but not sealed must be as wakeable as a sealed one.
    const workspace = { ...archivedWorkspace(), status: "archiving" as const };
    const wakeVolume = vi.fn(async () => managerVolume());
    const setWorkspaceStorageState = vi.fn(async () => workspace);
    const service = new WorkspaceWakeService({
      controlPlane: { wakeVolume },
      store: { getWorkspace: async () => workspace, setWorkspaceStorageState },
      workspaces: { recordControlPlaneFailure: vi.fn() },
    });

    await service.wake(workspace.id, "run-dispatch");

    expect(wakeVolume).toHaveBeenCalledOnce();
    expect(setWorkspaceStorageState).toHaveBeenCalledWith({
      issue: null,
      status: "provisioning",
      workspaceId: workspace.id,
    });
  });

  it("records a control-plane failure without rejecting the demand path", async () => {
    const workspace = archivedWorkspace();
    const error = new Error("manager down");
    const recordControlPlaneFailure = vi.fn(async () => workspace);
    const service = new WorkspaceWakeService({
      controlPlane: { wakeVolume: vi.fn(async () => Promise.reject(error)) },
      store: { getWorkspace: async () => workspace, setWorkspaceStorageState: vi.fn() },
      workspaces: { recordControlPlaneFailure },
    });

    await expect(service.wake(workspace.id, "prefetch")).resolves.toBeUndefined();
    expect(recordControlPlaneFailure).toHaveBeenCalledWith(workspace.id, error);
  });
});

function archivedWorkspace(): Workspace & {
  readonly backing: Extract<Workspace["backing"], { readonly kind: "portablefs" }>;
} {
  const now = new Date().toISOString();
  return {
    backing: {
      generation: 1,
      kind: "portablefs",
      serviceId: "test-portablefs",
      volumeId: "123e4567-e89b-42d3-a456-426614174000",
    },
    capacityPolicy: {
      blockHardLimitBytes: 10_000_000,
      inodeHardLimit: 10_000,
      kind: "hard-quota",
    },
    createdAt: now,
    createdBy: createId("user"),
    homeThreadId: null,
    icon: null,
    id: createId("workspace"),
    kind: "specialized",
    name: "Archived",
    status: "archived",
    storageIssue: null,
    updatedAt: now,
  };
}

function managerVolume() {
  return {
    authority_endpoint: "authority.test:7443",
    authority_generation: 1,
    authority_server_name: "authority.test",
    cell_id: "00000000-0000-4000-8000-000000000001",
    created_unix: 1,
    id: "123e4567-e89b-42d3-a456-426614174000",
    owner: "owner",
    product_issuer: "opensteer",
    project_id: 1,
    quota_bytes: 1,
    quota_inodes: 1,
    state: "RESTORING" as const,
    updated_unix: 1,
  };
}

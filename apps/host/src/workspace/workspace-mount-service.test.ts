import { createId } from "@opensteer/core";
import type {
  PendingWorkspaceMountRevocation,
  WorkspaceMountInventoryEntry,
  WorkspaceMountRecord,
} from "@opensteer/database";
import type { PortableFsControlPlane } from "@opensteer/workspace-portablefs";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceMountService } from "./workspace-mount-service.js";

describe("WorkspaceMountService", () => {
  it("membership revocation detaches and revokes only the member-authorized machine", async () => {
    const revokedUser = createId("user");
    const workspaceId = createId("workspace");
    const revokedMount = activeMount({ authorizedBy: revokedUser, workspaceId });
    const store = storeFake();
    store.listWorkspaceMountsAuthorizedBy.mockResolvedValue([revokedMount]);
    store.claimPendingMountEnrollmentRevocations.mockResolvedValue([
      pendingMount(revokedMount, "workspace-membership-revoked"),
    ]);
    const dispatch = vi.fn(async () => ({ type: "runner.command-accepted" as const }));
    const revokeMountEnrollment = vi.fn(async () => ({
      enrollmentId: revokedMount.enrollmentId,
      outcome: "REVOKED" as const,
      volumeId: revokedMount.volumeId as never,
    }));
    const service = new WorkspaceMountService({
      controlPlane: controlPlaneFake(revokeMountEnrollment),
      runners: { dispatch } as never,
      store: store as never,
    });

    await service.revokeForMembership(workspaceId, revokedUser);

    expect(store.listWorkspaceMountsAuthorizedBy).toHaveBeenCalledWith({
      authorizedBy: revokedUser,
      workspaceId,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: revokedMount.environmentId,
        type: "workspace.detach",
        volumeId: revokedMount.volumeId,
        workspaceId,
      }),
      expect.any(AbortSignal),
    );
    expect(store.requestWorkspaceMountRevocations).toHaveBeenCalledWith({
      reason: "workspace-membership-revoked",
      workspaceMountIds: [revokedMount.id],
    });
    expect(revokeMountEnrollment).toHaveBeenCalledOnce();
  });

  it("ignores detach transport failure and still records durable revocation", async () => {
    const mount = activeMount();
    const store = storeFake();
    store.listWorkspaceMounts.mockResolvedValue([mount]);
    const service = new WorkspaceMountService({
      controlPlane: controlPlaneFake(
        vi.fn(async () => ({
          enrollmentId: mount.enrollmentId,
          outcome: "REVOKED" as const,
          volumeId: mount.volumeId as never,
        })),
      ),
      runners: { dispatch: vi.fn(async () => Promise.reject(new Error("offline"))) } as never,
      store: store as never,
    });

    await service.evictIdle(mount.workspaceId);

    expect(store.requestWorkspaceMountRevocations).toHaveBeenCalledOnce();
    expect(store.claimPendingMountEnrollmentRevocations).toHaveBeenCalledOnce();
  });

  it.each([
    ["workspace deletion", "revokeWorkspace", "opensteer-workspace-deletion"],
    ["idle eviction", "evictIdle", "workspace-idle-archive"],
  ] as const)(
    "%s detaches from the mount environment before marking rows pending",
    async (_label, operation, reason) => {
      const mount = activeMount();
      const order: string[] = [];
      const store = storeFake();
      store.listWorkspaceMounts.mockResolvedValue([mount]);
      store.requestWorkspaceMountRevocations.mockImplementation(async () => {
        order.push("pending");
        return 1;
      });
      const dispatch = vi.fn(async () => {
        order.push("detach");
        return { type: "runner.command-accepted" as const };
      });
      const service = new WorkspaceMountService({
        controlPlane: controlPlaneFake(vi.fn()),
        runners: { dispatch } as never,
        store: store as never,
      });

      await service[operation](mount.workspaceId);

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          environmentId: mount.environmentId,
          type: "workspace.detach",
          volumeId: mount.volumeId,
          workspaceId: mount.workspaceId,
        }),
        expect.any(AbortSignal),
      );
      expect(store.requestWorkspaceMountRevocations).toHaveBeenCalledWith({
        reason,
        workspaceMountIds: [mount.id],
      });
      expect(order).toEqual(["detach", "pending"]);
    },
  );

  it("revokes only lower backing generations", async () => {
    const mount = activeMount({ workspaceBackingGeneration: 2 });
    const store = storeFake();
    store.listReplacedWorkspaceMounts.mockResolvedValue([mount]);
    const service = new WorkspaceMountService({
      controlPlane: controlPlaneFake(
        vi.fn(async () => ({
          enrollmentId: mount.enrollmentId,
          outcome: "REVOKED" as const,
          volumeId: mount.volumeId as never,
        })),
      ),
      runners: { dispatch: vi.fn(async () => ({ type: "runner.command-accepted" })) } as never,
      store: store as never,
    });

    await service.revokeReplacedBacking(mount.workspaceId, 3);

    expect(store.listReplacedWorkspaceMounts).toHaveBeenCalledWith({
      currentGeneration: 3,
      workspaceId: mount.workspaceId,
    });
    expect(store.requestWorkspaceMountRevocations).toHaveBeenCalledWith({
      reason: "workspace-backing-replaced",
      workspaceMountIds: [mount.id],
    });
  });

  it("closes missing inventory and detaches unknown reported mounts", async () => {
    const environmentId = createId("environment");
    const unknown = {
      enrollmentId: "enrollment-unknown",
      volumeId: "volume-unknown",
      workspaceId: createId("workspace"),
    };
    const store = storeFake();
    store.reconcileRunnerInventory.mockResolvedValue([unknown]);
    const dispatch = vi.fn(async () => ({ type: "runner.command-accepted" as const }));
    const service = new WorkspaceMountService({
      controlPlane: controlPlaneFake(vi.fn()),
      runners: { dispatch } as never,
      store: store as never,
    });

    await service.reconcileRunnerInventory(environmentId, [unknown]);

    expect(store.reconcileRunnerInventory).toHaveBeenCalledWith({
      environmentId,
      mounts: [unknown],
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId,
        type: "workspace.detach",
        volumeId: unknown.volumeId,
        workspaceId: unknown.workspaceId,
      }),
      expect.any(AbortSignal),
    );
  });

  it("durably reschedules a Manager failure", async () => {
    const record = pendingMount(activeMount(), "workspace-idle-archive", 3);
    const store = storeFake();
    store.claimPendingMountEnrollmentRevocations.mockResolvedValue([record]);
    const service = new WorkspaceMountService({
      controlPlane: controlPlaneFake(vi.fn(async () => Promise.reject(new Error("unavailable")))),
      runners: { dispatch: vi.fn() } as never,
      store: store as never,
    });

    await expect(service.reconcile()).rejects.toThrow(
      "PortableFS mount enrollment revocation failed",
    );
    expect(store.failMountEnrollmentRevocation).toHaveBeenCalledWith({
      enrollmentId: record.enrollmentId,
      errorCode: "portablefs-manager-revocation-failed",
      nextAttemptAt: expect.any(Date),
    });
  });
});

function activeMount(overrides: Partial<WorkspaceMountRecord> = {}): WorkspaceMountRecord {
  return {
    authorizedBy: createId("user"),
    enrollmentId: `enrollment-${crypto.randomUUID()}`,
    environmentId: createId("environment"),
    id: `wmt_${crypto.randomUUID()}`,
    membershipGeneration: 1,
    revocationAttempts: 0,
    runnerId: createId("runner"),
    status: "active",
    terminationReason: null,
    volumeId: `volume-${crypto.randomUUID()}`,
    workspaceBackingGeneration: 1,
    workspaceId: createId("workspace"),
    ...overrides,
  };
}

function pendingMount(
  mount: WorkspaceMountRecord,
  terminationReason: string,
  revocationAttempt = 1,
): PendingWorkspaceMountRevocation {
  return {
    ...mount,
    revocationAttempt,
    status: "revocation_pending",
    terminationReason,
  };
}

function storeFake() {
  return {
    claimPendingMountEnrollmentRevocations: vi.fn(
      async () => [] as PendingWorkspaceMountRevocation[],
    ),
    closeEnvironment: vi.fn(async () => 0),
    closeEnvironmentMountsBeforeAttachmentGeneration: vi.fn(async () => 0),
    completeMountEnrollmentRevocation: vi.fn(async () => undefined),
    failMountEnrollmentRevocation: vi.fn(async () => undefined),
    listEnvironmentWorkspaceMounts: vi.fn(async () => []),
    listReplacedWorkspaceMounts: vi.fn(async () => [] as WorkspaceMountRecord[]),
    listWorkspaceMounts: vi.fn(async () => [] as WorkspaceMountRecord[]),
    listWorkspaceMountsAuthorizedBy: vi.fn(async () => [] as WorkspaceMountRecord[]),
    reconcileRunnerInventory: vi.fn(async () => [] as WorkspaceMountInventoryEntry[]),
    recordWorkspaceMount: vi.fn(),
    requestWorkspaceMountRevocationByEnrollmentId: vi.fn(async () => false),
    requestWorkspaceMountRevocations: vi.fn(async () => 0),
  };
}

function controlPlaneFake(
  revokeMountEnrollment: PortableFsControlPlane["revokeMountEnrollment"],
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
    issueAutomaticMountGrant: unused,
    issueReadSessionGrant: unused,
    revokeMountEnrollment,
    wakeVolume: unused,
  };
}

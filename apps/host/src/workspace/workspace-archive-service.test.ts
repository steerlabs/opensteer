import { createId, OpensteerError, type Workspace } from "@opensteer/core";
import { PortableFsControlPlaneError } from "@opensteer/workspace-portablefs";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceArchiveService } from "./workspace-archive-service.js";

describe("WorkspaceArchiveService", () => {
  it("evicts live mounts and waits until a later pass to claim", async () => {
    const workspace = readyWorkspace();
    const evictIdle = vi.fn(async () => undefined);
    const claimPortableFsWorkspaceForArchive = claimTo(workspace, 2);
    const listWorkspaceMounts = vi
      .fn()
      .mockResolvedValueOnce([{ id: "wmt_live", status: "active" }])
      .mockResolvedValueOnce([]);
    const archiveVolume = vi.fn(async () => volume("ARCHIVED"));
    const service = new WorkspaceArchiveService({
      archiveAfterDays: 7,
      controlPlane: { archiveVolume },
      mounts: { evictIdle },
      store: {
        claimPortableFsWorkspaceForArchive,
        listArchiveEligibleWorkspaces: vi.fn(async () => [workspace]),
        listWorkspaceMounts,
        setWorkspaceStorageState: vi.fn(async () => workspace),
      },
    });

    await service.sweep();
    expect(evictIdle).toHaveBeenCalledWith(workspace.id);
    expect(claimPortableFsWorkspaceForArchive).not.toHaveBeenCalled();
    expect(archiveVolume).not.toHaveBeenCalled();

    await service.sweep();
    expect(claimPortableFsWorkspaceForArchive).toHaveBeenCalledOnce();
    expect(archiveVolume).toHaveBeenCalledOnce();
  });

  it("archives eligible Workspaces and persists the Manager lifecycle mapping", async () => {
    const workspace = readyWorkspace();
    const archiveVolume = vi.fn(async () => volume("ARCHIVING", "seal"));
    const setWorkspaceStorageState = vi.fn(async (): Promise<Workspace> => ({
      ...workspace,
      status: "archiving",
    }));
    const listArchiveEligibleWorkspaces = vi
      .fn()
      .mockResolvedValueOnce([workspace])
      .mockResolvedValueOnce([]);
    const service = new WorkspaceArchiveService({
      archiveAfterDays: 7,
      controlPlane: { archiveVolume },
      mounts: mountsFake(),
      now: () => Date.parse("2026-08-20T12:00:00.000Z"),
      store: {
        claimPortableFsWorkspaceForArchive: claimTo(workspace, 2),
        listArchiveEligibleWorkspaces,
        listWorkspaceMounts: vi.fn(async () => []),
        setWorkspaceStorageState,
      },
    });

    await service.sweep();

    expect(listArchiveEligibleWorkspaces).toHaveBeenCalledWith({
      idleBefore: new Date("2026-08-13T12:00:00.000Z"),
      limit: 100,
    });
    expect(archiveVolume).toHaveBeenCalledWith(workspace.backing.volumeId, {
      idempotencyKey: expect.stringMatching(
        new RegExp(
          `^workspace:${workspace.id}:archive:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
        ),
      ),
    });
    // The cycle has started but nothing is sealed yet, so the Workspace says so.
    expect(setWorkspaceStorageState).toHaveBeenCalledWith({
      issue: null,
      status: "archiving",
      workspaceId: workspace.id,
    });
  });

  it("claims against the sweep cutoff and the generation the listing observed", async () => {
    const workspace = readyWorkspace();
    const claimPortableFsWorkspaceForArchive = claimTo(workspace, 2);
    const service = new WorkspaceArchiveService({
      archiveAfterDays: 7,
      controlPlane: { archiveVolume: vi.fn(async () => volume("ARCHIVED")) },
      mounts: mountsFake(),
      now: () => Date.parse("2026-08-20T12:00:00.000Z"),
      store: {
        claimPortableFsWorkspaceForArchive,
        listArchiveEligibleWorkspaces: vi.fn(async () => [workspace]),
        listWorkspaceMounts: vi.fn(async () => []),
        setWorkspaceStorageState: vi.fn(async () => workspace),
      },
    });

    await service.sweep();

    expect(claimPortableFsWorkspaceForArchive).toHaveBeenCalledWith({
      backingGeneration: 1,
      idleBefore: new Date("2026-08-13T12:00:00.000Z"),
      workspaceId: workspace.id,
    });
  });

  it("claims before evicting the read session and before archiving", async () => {
    const workspace = readyWorkspace();
    const order: string[] = [];
    const claimPortableFsWorkspaceForArchive = vi.fn(async () => {
      order.push("claim");
      return claimed(workspace, 2);
    });
    const evictSession = vi.fn(async (evicted: Workspace) => {
      order.push(`evict:${String(evicted.backing.generation)}`);
    });
    const archiveVolume = vi.fn(async () => {
      order.push("archive");
      return volume("ARCHIVED");
    });
    const service = new WorkspaceArchiveService({
      archiveAfterDays: 7,
      controlPlane: { archiveVolume },
      files: { evictSession },
      mounts: mountsFake(),
      store: {
        claimPortableFsWorkspaceForArchive,
        listArchiveEligibleWorkspaces: vi.fn(async () => [workspace]),
        listWorkspaceMounts: vi.fn(async () => []),
        setWorkspaceStorageState: vi.fn(async () => workspace),
      },
    });

    await service.sweep();

    // The evicted Workspace carries the post-claim generation, which is the
    // fence floor the gateway records for this archive cycle.
    expect(order).toEqual(["claim", "evict:2", "archive"]);
  });

  it("skips a Workspace whose eligibility was lost before the claim", async () => {
    const workspace = readyWorkspace();
    const archiveVolume = vi.fn();
    const evictSession = vi.fn();
    const onError = vi.fn();
    const onSkip = vi.fn();
    const service = new WorkspaceArchiveService({
      archiveAfterDays: 7,
      controlPlane: { archiveVolume },
      files: { evictSession },
      mounts: mountsFake(),
      onError,
      onSkip,
      store: {
        claimPortableFsWorkspaceForArchive: vi.fn(async () => {
          throw new OpensteerError({
            code: "conflict",
            message: "Workspace is no longer eligible for archiving",
          });
        }),
        listArchiveEligibleWorkspaces: vi.fn(async () => [workspace]),
        listWorkspaceMounts: vi.fn(async () => []),
        setWorkspaceStorageState: vi.fn(),
      },
    });

    await service.sweep();

    expect(evictSession).not.toHaveBeenCalled();
    expect(archiveVolume).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith(workspace.id, "no-longer-eligible");
  });

  it.each([409, 429, 503])("treats a busy Manager (HTTP %i) as a skip", async (httpStatus) => {
    const workspace = readyWorkspace();
    const onError = vi.fn();
    const onSkip = vi.fn();
    const setWorkspaceStorageState = vi.fn();
    const service = new WorkspaceArchiveService({
      archiveAfterDays: 7,
      controlPlane: {
        archiveVolume: vi.fn(async () => {
          throw new PortableFsControlPlaneError({
            httpStatus,
            message: "cell archive capacity is exhausted",
            operation: "archive-volume",
          });
        }),
      },
      mounts: mountsFake(),
      onError,
      onSkip,
      store: {
        claimPortableFsWorkspaceForArchive: claimTo(workspace, 2),
        listArchiveEligibleWorkspaces: vi.fn(async () => [workspace]),
        listWorkspaceMounts: vi.fn(async () => []),
        setWorkspaceStorageState,
      },
    });

    await service.sweep();

    expect(setWorkspaceStorageState).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith(workspace.id, "manager-busy");
  });

  it("reports a Manager that cannot archive at all as an operator-facing failure", async () => {
    const workspace = readyWorkspace();
    const onError = vi.fn();
    const onSkip = vi.fn();
    const cause = new PortableFsControlPlaneError({
      httpStatus: 501,
      message: "cell has no archive configuration",
      operation: "archive-volume",
    });
    const service = new WorkspaceArchiveService({
      archiveAfterDays: 7,
      controlPlane: {
        archiveVolume: vi.fn(async () => {
          throw cause;
        }),
      },
      mounts: mountsFake(),
      onError,
      onSkip,
      store: {
        claimPortableFsWorkspaceForArchive: claimTo(workspace, 2),
        listArchiveEligibleWorkspaces: vi.fn(async () => [workspace]),
        listWorkspaceMounts: vi.fn(async () => []),
        setWorkspaceStorageState: vi.fn(),
      },
    });

    await service.sweep();

    expect(onSkip).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const [reported] = onError.mock.calls[0] as [Error, Workspace["id"]];
    expect(reported.name).toBe("WorkspaceArchiveUnsupportedError");
    expect(reported.message).toContain("cannot archive volumes");
    expect(reported.cause).toBe(cause);
  });

  it("archives a page with bounded concurrency and unique per-call request identities", async () => {
    const workspaces = Array.from({ length: 10 }, () => readyWorkspace());
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const keys: string[] = [];
    const archiveVolume = vi.fn(
      async (_volumeId: string, options: { readonly idempotencyKey: string }) => {
        keys.push(options.idempotencyKey);
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight -= 1;
        return volume("ARCHIVED");
      },
    );
    const service = new WorkspaceArchiveService({
      archiveAfterDays: 7,
      controlPlane: { archiveVolume },
      mounts: mountsFake(),
      store: {
        claimPortableFsWorkspaceForArchive: claimFrom(workspaces),
        listArchiveEligibleWorkspaces: vi.fn(async () => workspaces),
        listWorkspaceMounts: vi.fn(async () => []),
        setWorkspaceStorageState: vi.fn(async () => workspaces[0]!),
      },
    });

    const sweep = service.sweep();
    for (let released = 0; released < workspaces.length; released += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(released));
      expect(inFlight).toBeLessThanOrEqual(4);
      releases[released]!();
    }
    await sweep;

    expect(archiveVolume).toHaveBeenCalledTimes(10);
    expect(peakInFlight).toBe(4);
    expect(new Set(keys).size).toBe(10);
  });

  it("logs one Workspace failure and continues the page", async () => {
    const workspaces = [readyWorkspace(), readyWorkspace()];
    const archiveVolume = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(volume("ARCHIVED"));
    const setWorkspaceStorageState = vi.fn(async () => workspaces[1]!);
    const onError = vi.fn();
    const service = new WorkspaceArchiveService({
      archiveAfterDays: 1,
      controlPlane: { archiveVolume },
      mounts: mountsFake(),
      onError,
      store: {
        claimPortableFsWorkspaceForArchive: claimFrom(workspaces),
        listArchiveEligibleWorkspaces: vi.fn(async () => workspaces),
        listWorkspaceMounts: vi.fn(async () => []),
        setWorkspaceStorageState,
      },
    });

    await service.sweep();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), workspaces[0]!.id);
    expect(setWorkspaceStorageState).toHaveBeenCalledWith(
      expect.objectContaining({ status: "archived", workspaceId: workspaces[1]!.id }),
    );
  });
});

type PortableFsWorkspace = Workspace & {
  readonly backing: Extract<Workspace["backing"], { readonly kind: "portablefs" }>;
};

function claimed(workspace: PortableFsWorkspace, generation: number): PortableFsWorkspace {
  return { ...workspace, backing: { ...workspace.backing, generation } };
}

function claimTo(workspace: PortableFsWorkspace, generation: number) {
  return vi.fn(async () => claimed(workspace, generation));
}

function claimFrom(workspaces: readonly PortableFsWorkspace[]) {
  return vi.fn(async (input: { readonly workspaceId: Workspace["id"] }) => {
    const found = workspaces.find((candidate) => candidate.id === input.workspaceId);
    if (!found) throw new Error("Unexpected Workspace");
    return claimed(found, found.backing.generation + 1);
  });
}

function mountsFake() {
  return { evictIdle: vi.fn(async () => undefined) };
}

function readyWorkspace(): PortableFsWorkspace {
  const now = new Date().toISOString();
  return {
    backing: {
      generation: 1,
      kind: "portablefs",
      serviceId: "test-portablefs",
      volumeId: createId("workspace").slice(4),
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
    name: "Ready",
    status: "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

function volume(state: "ARCHIVING" | "ARCHIVED", archiveCycleStep?: string) {
  return {
    ...(archiveCycleStep ? { archive_cycle_step: archiveCycleStep } : {}),
    authority_endpoint: "authority.test:7443",
    authority_generation: 1,
    authority_server_name: "authority.test",
    cell_id: "00000000-0000-4000-8000-000000000001",
    created_unix: 1,
    id: "123e4567-e89b-42d3-a456-426614174000" as never,
    owner: "owner",
    product_issuer: "opensteer",
    project_id: 1,
    quota_bytes: 1,
    quota_inodes: 1,
    state,
    updated_unix: 1,
  };
}

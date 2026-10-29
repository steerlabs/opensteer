import { createId, type Workspace } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceDeletionService } from "./workspace-deletion-service.js";

function workspace(status: Workspace["status"] = "deleting"): Workspace {
  const now = new Date().toISOString();
  return {
    backing: {
      bindingId: createId("workspaceBinding"),
      generation: 1,
      kind: "local-directory",
      ownerEnvironmentId: createId("environment"),
      storageAuthorityId: createId("storageAuthority"),
    },
    capacityPolicy: { kind: "host-filesystem" },
    createdAt: now,
    createdBy: createId("user"),
    homeThreadId: null,
    icon: null,
    id: createId("workspace"),
    kind: "specialized",
    name: "Delete me",
    status,
    storageIssue: null,
    updatedAt: now,
  };
}

describe("WorkspaceDeletionService", () => {
  it("commits retention intent before best-effort immediate teardown", async () => {
    const held = workspace();
    const order: string[] = [];
    const requestEvent = { type: "request.cancelled" } as never;
    const requestWorkspaceDeletion = vi.fn(async () => {
      order.push("held");
      return { requestEvents: [requestEvent], workspace: held };
    });
    const onWorkspaceEvent = vi.fn();
    const terminateRuns = vi.fn(async () => {
      order.push("runs");
    });
    const revokeWorkspace = vi.fn(async () => {
      order.push("mounts");
    });
    const now = new Date("2026-08-20T12:00:00.000Z");
    const service = serviceWith({
      mounts: { revokeWorkspace },
      now: () => now,
      onWorkspaceEvent,
      requestWorkspaceDeletion,
      terminateRuns,
    });

    await expect(service.requestDeletion(held.id, held.createdBy)).resolves.toBe(held);

    expect(requestWorkspaceDeletion).toHaveBeenCalledWith({
      purgeAfter: new Date("2026-09-03T12:00:00.000Z"),
      requestedBy: held.createdBy,
      workspaceId: held.id,
    });
    expect(order[0]).toBe("held");
    expect(order.slice(1).sort()).toEqual(["mounts", "runs"]);
    expect(onWorkspaceEvent).toHaveBeenCalledWith(requestEvent);
  });

  it("marks only successfully destroyed Workspaces deleted and continues after errors", async () => {
    const first = workspace();
    const second = workspace();
    const destroy = vi.fn(async ({ workspace: candidate }: { workspace: Workspace }) => {
      if (candidate.id === first.id) throw new Error("ambiguous destroy");
    });
    const markWorkspaceDeleted = vi.fn(async () => second);
    const onError = vi.fn();
    const service = serviceWith({
      destroy,
      listWorkspacesDuePurge: vi.fn(async () => [first, second]),
      markWorkspaceDeleted,
      onError,
    });

    await service.purgeDue(new Date("2026-08-20T12:00:00.000Z"));

    expect(markWorkspaceDeleted).toHaveBeenCalledOnce();
    expect(markWorkspaceDeleted).toHaveBeenCalledWith({ workspaceId: second.id });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), first.id);
  });
});

function serviceWith(overrides: Record<string, unknown> = {}): WorkspaceDeletionService {
  const held = workspace();
  const values = overrides as {
    readonly destroy?: (input: { readonly workspace: Workspace }) => Promise<void>;
    readonly listWorkspacesDuePurge?: () => Promise<readonly Workspace[]>;
    readonly markWorkspaceDeleted?: () => Promise<Workspace>;
    readonly mounts?: { readonly revokeWorkspace: () => Promise<void> };
    readonly now?: () => Date;
    readonly onError?: (error: unknown, workspaceId: Workspace["id"]) => void;
    readonly onWorkspaceEvent?: (event: never) => void;
    readonly requestWorkspaceDeletion?: () => Promise<{
      readonly requestEvents: readonly never[];
      readonly workspace: Workspace;
    }>;
    readonly terminateRuns?: () => Promise<void>;
  };
  return new WorkspaceDeletionService({
    drivers: { local: { destroy: values.destroy ?? vi.fn(async () => undefined) } },
    ...(values.mounts ? { mounts: values.mounts as never } : {}),
    ...(values.now ? { now: values.now } : {}),
    onError: values.onError ?? vi.fn(),
    onWorkspaceEvent: values.onWorkspaceEvent ?? vi.fn(),
    retentionDays: 14,
    store: {
      listWorkspacesDuePurge: values.listWorkspacesDuePurge ?? vi.fn(async () => []),
      markWorkspaceDeleted: values.markWorkspaceDeleted ?? vi.fn(async () => held),
      recoverWorkspaceDeletion: vi.fn(async () => held),
      requestWorkspaceDeletion:
        values.requestWorkspaceDeletion ??
        vi.fn(async () => ({ requestEvents: [], workspace: held })),
    },
    terminateRuns: values.terminateRuns ?? vi.fn(async () => undefined),
  } as never);
}

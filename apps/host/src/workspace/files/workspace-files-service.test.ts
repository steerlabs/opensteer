import {
  createId,
  type LocalWorkspaceBacking,
  type PortableFsWorkspaceBacking,
  type Workspace,
} from "@opensteer/core";
import type {
  WorkspaceFilesAdmission,
  WorkspaceMembershipChangeListener,
  WorkspaceMembershipRecord,
} from "@opensteer/database";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFilesService } from "./workspace-files-service.js";

afterEach(() => vi.useRealTimers());

describe("WorkspaceFilesService", () => {
  it("fails closed when a Workspace backing has no configured driver", async () => {
    const portableFs = membershipFixture(portableFsWorkspace());
    const service = new WorkspaceFilesService({
      local: { list: vi.fn() } as never,
      memberships: portableFs.repository,
    });
    await expect(
      service.list(portableFs.admission, { limit: 200, parentKey: "" }),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
    service.close();
  });

  it("rechecks durable membership while streaming even if no change event is delivered", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00Z"));
    const fixture = membershipFixture(localWorkspace());
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1_024));
      },
    });
    const service = new WorkspaceFilesService({
      local: { download: async () => new Response(upstream) } as never,
      memberships: fixture.repository,
    });
    const response = await service.download(fixture.admission, "file_key");
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });

    fixture.changeSilently({ generation: 2, state: "revoked" });
    vi.setSystemTime(new Date("2026-08-13T00:00:01Z"));
    await expect(reader.read()).rejects.toMatchObject({ code: "not_found" });
    service.close();
  });

  it("aborts promptly while the upstream download is stalled", async () => {
    const fixture = membershipFixture(localWorkspace());
    let pulls = 0;
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      cancel() {
        upstreamCancelled = true;
      },
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array(64 * 1_024));
          return;
        }
        return new Promise<void>(() => undefined);
      },
    });
    const service = new WorkspaceFilesService({
      local: { download: async () => new Response(upstream) } as never,
      memberships: fixture.repository,
    });
    const response = await service.download(fixture.admission, "file_key");
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });

    const stalledRead = reader.read();
    await vi.waitFor(() => expect(pulls).toBeGreaterThanOrEqual(2));
    fixture.change({ generation: 2, state: "revoked" });
    await expect(stalledRead).rejects.toMatchObject({ code: "not_found" });
    expect(upstreamCancelled).toBe(true);
    service.close();
  });

  it("fails closed when membership changes between admission and lease registration", async () => {
    const fixture = membershipFixture(localWorkspace());
    fixture.changeSilently({ generation: 2, state: "active" });
    const list = vi.fn(async () => directoryPage());
    const service = new WorkspaceFilesService({
      local: { list } as never,
      memberships: fixture.repository,
    });

    await expect(
      service.list(fixture.admission, { limit: 200, parentKey: "" }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(list).not.toHaveBeenCalled();
    service.close();
  });

  it("rechecks membership before returning list or preview results", async () => {
    const fixture = membershipFixture(localWorkspace());
    let finishList!: (value: ReturnType<typeof directoryPage>) => void;
    const list = vi.fn(
      () =>
        new Promise<ReturnType<typeof directoryPage>>((resolve) => {
          finishList = resolve;
        }),
    );
    const preview = vi.fn(async () => {
      fixture.changeSilently({ generation: 2, state: "revoked" });
      return {
        bytes: new Uint8Array([1]),
        metadata: {
          contentType: "application/octet-stream",
          etag: '"revision"',
          modifiedAt: null,
          sizeBytes: 1,
          truncated: false,
        },
      };
    });
    const service = new WorkspaceFilesService({
      local: { list, preview } as never,
      memberships: fixture.repository,
    });

    const pendingList = service.list(fixture.admission, { limit: 200, parentKey: "" });
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    fixture.changeSilently({ generation: 2, state: "revoked" });
    finishList(directoryPage());
    await expect(pendingList).rejects.toMatchObject({ code: "not_found" });

    fixture.changeSilently({ generation: 3, state: "active" });
    const nextAdmission = { ...fixture.admission, membershipGeneration: 3 };
    await expect(service.preview(nextAdmission, "file_key")).rejects.toMatchObject({
      code: "not_found",
    });
    service.close();
  });
});

function membershipFixture(workspace: Workspace) {
  const userId = workspace.createdBy;
  let membership: WorkspaceMembershipRecord = {
    generation: 1,
    id: createId("workspaceMembership"),
    invitedBy: null,
    joinedAt: new Date(),
    role: "owner",
    state: "active",
    userId,
    workspaceId: workspace.id,
  };
  const listeners = new Set<WorkspaceMembershipChangeListener>();
  const repository = {
    onWorkspaceMembershipChanged(listener: WorkspaceMembershipChangeListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async workspaceMembershipForUser(
      requestedWorkspaceId: Workspace["id"],
      requestedUserId: typeof userId,
    ) {
      return requestedWorkspaceId === workspace.id && requestedUserId === userId
        ? membership
        : null;
    },
  };
  const changeSilently = (value: Pick<WorkspaceMembershipRecord, "generation" | "state">): void => {
    membership = { ...membership, ...value };
  };
  return {
    admission: {
      membershipGeneration: membership.generation,
      userId,
      workspace,
    } satisfies WorkspaceFilesAdmission,
    change(value: Pick<WorkspaceMembershipRecord, "generation" | "state">) {
      changeSilently(value);
      for (const listener of listeners) listener(membership);
    },
    changeSilently,
    membership: () => membership,
    repository,
  };
}

function localWorkspace(): Workspace & { readonly backing: LocalWorkspaceBacking } {
  return workspace({
    bindingId: createId("workspaceBinding"),
    generation: 1,
    kind: "local-directory",
    ownerEnvironmentId: createId("environment"),
    storageAuthorityId: createId("storageAuthority"),
  });
}

function portableFsWorkspace(): Workspace & { readonly backing: PortableFsWorkspaceBacking } {
  return workspace({
    generation: 1,
    kind: "portablefs",
    serviceId: "portablefs-test",
    volumeId: "volume_test",
  });
}

function workspace<Backing extends Workspace["backing"]>(
  backing: Backing,
): Workspace & { readonly backing: Backing } {
  const now = new Date().toISOString();
  return {
    backing,
    capacityPolicy:
      backing.kind === "local-directory"
        ? { kind: "host-filesystem" }
        : { blockHardLimitBytes: 1_000_000, inodeHardLimit: 10_000, kind: "hard-quota" },
    createdAt: now,
    createdBy: createId("user"),
    homeThreadId: null,
    icon: null,
    id: createId("workspace"),
    kind: "specialized",
    name: "Workspace",
    status: "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

function directoryPage() {
  return { cursor: null, entries: [], parentKey: "", revision: "directory_revision_1" };
}

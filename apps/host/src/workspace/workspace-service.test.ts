import {
  createId,
  type EnvironmentId,
  type Workspace,
  type WorkspaceId,
  type WorkspaceStorageIssue,
} from "@opensteer/core";
import {
  WorkspaceAuthorityUnreachableError,
  type WorkspaceBackingLifecycleDriver,
} from "@opensteer/workspace";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceService } from "./workspace-service.js";

const retryableIssue: WorkspaceStorageIssue = {
  code: "manager-unavailable",
  message: "Workspace storage is temporarily unavailable.",
  occurredAt: "2026-08-20T12:00:00.000Z",
  retryable: true,
};
describe("WorkspaceService with a machine that owns its own directories", () => {
  it("preserves unsupported stored backing data and requires relocation without calling a driver", async () => {
    const legacy = {
      ...localWorkspace(),
      backing: { kind: "retired-storage", volumeId: "keep-user-data" },
    } as never as Workspace;
    const harness = createStore([legacy]);
    const inspect = vi.fn();
    const provision = vi.fn();
    const service = localService(harness.store, { inspect, provision });
    await service.reconcile();
    const current = harness.workspaces[0]!;
    expect(current).toMatchObject({
      backing: legacy.backing,
      status: "failed",
      storageIssue: { code: "relocation-required", retryable: false },
    });
    await expect(service.ensureExecutionReady(current)).rejects.toMatchObject({
      code: "workspace_unavailable",
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("leaves every Workspace alone while its machine is unreachable", async () => {
    const ready = localWorkspace({ status: "ready" });
    const harness = createStore([ready]);
    const service = localService(harness.store, {
      inspect: async () => {
        throw new WorkspaceAuthorityUnreachableError("That computer is asleep.");
      },
    });

    await expect(service.reconcile()).resolves.toMatchObject({ available: true });

    expect(harness.stateChanges).toEqual([]);
    expect(harness.workspaces[0]?.status).toBe("ready");
  });

  it("keeps a provisioning intent outstanding instead of failing it when the machine is away", async () => {
    const pending = localWorkspace({ status: "provisioning" });
    const harness = createStore([pending]);
    const service = localService(harness.store, {
      provision: async () => {
        throw new WorkspaceAuthorityUnreachableError("That computer is asleep.");
      },
    });

    await service.provision(pending);

    expect(harness.workspaces[0]).toMatchObject({
      status: "provisioning",
      storageIssue: expect.objectContaining({
        code: "local-authority-unavailable",
        retryable: true,
      }),
    });
  });

  it("preserves a non-retryable legacy authority mismatch for the owner to act on", async () => {
    const legacy = localWorkspace({ status: "unavailable" });
    const storageIssue = {
      code: "local-authority-mismatch" as const,
      message:
        "This Workspace predates machine-owned storage and must be recreated on the computer that holds its files.",
      occurredAt: "2026-08-20T12:00:00.000Z",
      retryable: false,
    };
    const harness = createStore([{ ...legacy, storageIssue }]);
    const provision = vi.fn<WorkspaceBackingLifecycleDriver<"local-directory">["provision"]>();
    const service = localService(harness.store, { provision });

    await service.reconcile();

    expect(provision).not.toHaveBeenCalled();
    expect(harness.workspaces[0]).toMatchObject({ status: "unavailable", storageIssue });
  });

  it("asks a caller to retry rather than recording a storage fault it cannot observe", async () => {
    const ready = localWorkspace({ status: "ready" });
    const harness = createStore([ready]);
    const service = localService(harness.store, {
      inspect: async () => {
        throw new WorkspaceAuthorityUnreachableError("That computer is asleep.");
      },
    });

    await expect(service.ensureExecutionReady(ready)).rejects.toMatchObject({
      code: "workspace_unavailable",
      retryable: true,
    });
    expect(harness.stateChanges).toEqual([]);
  });

  it("refuses a storage quota on a Workspace that lives on a machine's own disk", async () => {
    const harness = createStore([]);
    const service = localService(harness.store, {});

    await expect(
      service.create({
        kind: "main",

        createdBy: createId("user"),
        idempotencyKey: "quota-on-a-laptop",
        name: "Research",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("WorkspaceService creation capacity policy", () => {
  it("refuses a hard-quota override on a local-directory deployment", async () => {
    const service = new WorkspaceService({
      drivers: { local: { kind: "local-directory" } as never },
      shape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "server" as const,
      },
      resolveOwnerEnvironmentId: async () => createId("environment"),
      store: createStore([]).store as never,
    });

    await expect(
      service.create({
        kind: "main",

        createdBy: createId("user"),
        idempotencyKey: "local-hard-quota",
        name: "Local",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

const localEnvironmentId = createId("environment");
const localStorageAuthorityId = createId("storageAuthority");

function localWorkspace(options: { readonly status?: Workspace["status"] } = {}): Workspace {
  const now = "2026-08-20T12:00:00.000Z";
  return {
    backing: {
      bindingId: createId("workspaceBinding"),
      generation: 1,
      kind: "local-directory",
      ownerEnvironmentId: localEnvironmentId,
      storageAuthorityId: localStorageAuthorityId,
    },

    createdAt: now,
    createdBy: createId("user"),
    homeThreadId: null,
    icon: null,
    id: createId("workspace"),
    kind: "project",
    name: "Research",
    status: options.status ?? "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

function localService(
  store: ReturnType<typeof createStore>["store"],
  options: {
    readonly relocate?: WorkspaceBackingLifecycleDriver<"local-directory">["relocate"];
    readonly storageLocation?: WorkspaceBackingLifecycleDriver<"local-directory">["storageLocation"];
    readonly inspect?: WorkspaceBackingLifecycleDriver<"local-directory">["inspect"];
    readonly provision?: WorkspaceBackingLifecycleDriver<"local-directory">["provision"];
  },
): WorkspaceService {
  const driver: WorkspaceBackingLifecycleDriver<"local-directory"> = {
    ...(options.relocate ? { relocate: options.relocate } : {}),
    ...(options.storageLocation ? { storageLocation: options.storageLocation } : {}),
    destroy: async () => undefined,
    initialBacking: (input) => ({
      bindingId: createId("workspaceBinding"),
      generation: 1,
      kind: "local-directory",
      ownerEnvironmentId: input.ownerEnvironmentId,
      storageAuthorityId: localStorageAuthorityId,
    }),
    inspect: options.inspect ?? (async () => ({ issue: null, status: "ready" })),
    // Mirrors the real proxy: an unreachable machine is not a storage fault.
    issueFromError: (error) =>
      error instanceof WorkspaceAuthorityUnreachableError
        ? {
            code: "local-authority-unavailable",
            message: error.message,
            occurredAt: "2026-08-20T12:00:00.000Z",
            retryable: true,
          }
        : retryableIssue,
    kind: "local-directory",
    preflight: async () => ({ available: true, detail: "machines answer for themselves" }),
    provision:
      options.provision ??
      (async ({ workspace: current }) => ({ backing: current.backing, status: "ready" })),
  };
  return new WorkspaceService({
    drivers: { local: driver },
    resolveOwnerEnvironmentId: async () => localEnvironmentId,
    shape: { defaultWorkspaceBacking: "local-directory", kind: "server" as const },
    store: store as never,
  });
}

function createStore(
  initial: readonly Workspace[],
  environments: ReadonlyMap<EnvironmentId, string> = new Map(),
) {
  const workspaces = [...initial];
  const stateChanges: WorkspaceId[] = [];
  const pages: { readonly size: number; readonly status: Workspace["status"] }[] = [];
  return {
    pages,
    stateChanges,
    store: {
      async findMainWorkspaceForOwner(ownerId: Workspace["createdBy"]) {
        return (
          workspaces.find((item) => item.createdBy === ownerId && item.kind === "main") ?? null
        );
      },
      async getWorkspaceForOwner(workspaceId: WorkspaceId, ownerId: Workspace["createdBy"]) {
        return (
          workspaces.find((item) => item.id === workspaceId && item.createdBy === ownerId) ?? null
        );
      },
      async getEnvironment(id: EnvironmentId) {
        const name = environments.get(id);
        return name === undefined ? null : { id, name };
      },
      async createWorkspace(input: {
        readonly backing: Workspace["backing"];
        readonly createdBy: Workspace["createdBy"];
        readonly id: WorkspaceId;
        readonly kind?: Workspace["kind"];
        readonly name: string;
        readonly status: Workspace["status"];
      }) {
        const now = new Date().toISOString();
        const created: Workspace = {
          backing: input.backing,
          createdAt: now,
          createdBy: input.createdBy,
          homeThreadId: null,
          icon: null,
          id: input.id,
          kind: input.kind ?? "project",
          name: input.name,
          status: input.status,
          storageIssue: null,
          updatedAt: now,
        };
        workspaces.push(created);
        return created;
      },
      async listWorkspaces() {
        return [...workspaces];
      },
      async listWorkspacesByStatus(
        status: Workspace["status"],
        options: {
          readonly after?: { readonly createdAt: string; readonly id: WorkspaceId };
          readonly limit?: number;
        } = {},
      ) {
        const ordered = workspaces
          .filter(
            (item) =>
              item.status === status &&
              (!options.after ||
                item.createdAt > options.after.createdAt ||
                (item.createdAt === options.after.createdAt && item.id > options.after.id)),
          )
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(0, options.limit ?? 100);
        pages.push({ size: ordered.length, status });
        return ordered;
      },
      async setWorkspaceStorageState(input: {
        readonly issue: Workspace["storageIssue"];
        readonly status: Workspace["status"];
        readonly workspaceId: WorkspaceId;
      }) {
        const index = workspaces.findIndex((item) => item.id === input.workspaceId);
        const current = workspaces[index];
        if (!current) throw new Error("Workspace not found");
        const updated = { ...current, status: input.status, storageIssue: input.issue };
        workspaces[index] = updated;
        stateChanges.push(input.workspaceId);
        return updated;
      },
      async setWorkspaceProvisioningResult(input: {
        readonly backing: Workspace["backing"];
        readonly status: Workspace["status"];
        readonly workspaceId: WorkspaceId;
      }) {
        const index = workspaces.findIndex((item) => item.id === input.workspaceId);
        const current = workspaces[index];
        if (!current) throw new Error("Workspace not found");
        const updated = {
          ...current,
          backing: input.backing,
          status: input.status,
          storageIssue: null,
        };
        workspaces[index] = updated;
        return updated;
      },
    },
    workspaces,
  };
}

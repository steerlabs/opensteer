import {
  createId,
  type EnvironmentId,
  type Workspace,
  type WorkspaceId,
  type WorkspaceStorageIssue,
} from "@opensteer/core";
import {
  WorkspaceAuthorityUnreachableError,
  type WorkspaceBackingHealth,
  type WorkspaceBackingLifecycleDriver,
  type WorkspaceBackingReadiness,
} from "@opensteer/workspace";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceService } from "./workspace-service.js";

const retryableIssue: WorkspaceStorageIssue = {
  code: "manager-unavailable",
  message: "Workspace storage is temporarily unavailable.",
  occurredAt: "2026-08-20T12:00:00.000Z",
  retryable: true,
};
const alertIssue: WorkspaceStorageIssue = {
  code: "manager-protocol-error",
  message: "The Host and PortableFS authority use incompatible storage contracts.",
  occurredAt: "2026-08-20T12:00:00.000Z",
  retryable: false,
};

describe("WorkspaceService reconciliation", () => {
  it("skips only pending volume creates when product-pool admission is closed", async () => {
    const pending = workspace({ pending: true, status: "provisioning" });
    const existing = workspace({ status: "provisioning" });
    const harness = createStore([pending, existing]);
    const provision = vi.fn(async ({ workspace: current }) => ({
      backing: current.backing,
      status: "ready" as const,
    }));
    const service = createService(harness.store, {
      admitsCreates: async () => false,
      preflight: async () => ({ available: true, detail: "portablefs-test" }),
      provision,
    });

    const result = await service.reconcile();

    expect(provision).toHaveBeenCalledOnce();
    expect(provision.mock.calls[0]?.[0].workspace.id).toBe(existing.id);
    expect(harness.workspaces.find((item) => item.id === pending.id)?.status).toBe("provisioning");
    expect(result).toMatchObject({ available: true, severity: "alert" });
    expect(result.detail).toMatch(/no create headroom.*skipped/u);
  });

  it("pauses pending volume creates when the create admission check is unavailable", async () => {
    const pending = workspace({ pending: true, status: "provisioning" });
    const existing = workspace({ status: "provisioning" });
    const harness = createStore([pending, existing]);
    const provision = vi.fn(async ({ workspace: current }) => ({
      backing: current.backing,
      status: "ready" as const,
    }));
    const service = createService(harness.store, {
      admitsCreates: async () => {
        throw new Error("Manager v1 has no capacity endpoint");
      },
      preflight: async () => ({ available: true, detail: "portablefs-test" }),
      provision,
    });

    const result = await service.reconcile();

    expect(provision).toHaveBeenCalledOnce();
    expect(provision.mock.calls[0]?.[0].workspace.id).toBe(existing.id);
    expect(harness.workspaces.find((item) => item.id === pending.id)?.status).toBe("provisioning");
    expect(result).toMatchObject({ available: true, severity: "alert" });
    expect(result.detail).toMatch(
      /Create admission check is unavailable \(Manager v1 has no capacity endpoint\), so creates are paused/u,
    );
  });

  it("provisions pending volume creates when the create admission check succeeds", async () => {
    const pending = workspace({ pending: true, status: "provisioning" });
    const harness = createStore([pending]);
    const provision = vi.fn(async ({ workspace: current }) => ({
      backing: current.backing,
      status: "ready" as const,
    }));
    const service = createService(harness.store, {
      admitsCreates: async () => true,
      preflight: async () => ({ available: true, detail: "portablefs-test" }),
      provision,
    });

    const result = await service.reconcile();

    expect(provision).toHaveBeenCalledOnce();
    expect(provision.mock.calls[0]?.[0].workspace.id).toBe(pending.id);
    expect(result).toEqual({ available: true, detail: "portablefs-test" });
  });

  it("waits for three consecutive failed preflights before global demotion", async () => {
    const harness = createStore([workspace()]);
    const service = createService(harness.store, {
      preflight: async () => {
        throw new PreflightFailure(retryableIssue);
      },
    });

    await service.reconcile();
    await service.reconcile();
    expect(harness.workspaces[0]).toMatchObject({ status: "ready", storageIssue: null });
    expect(harness.stateChanges).toHaveLength(0);

    await service.reconcile();
    expect(harness.workspaces[0]).toMatchObject({
      status: "unavailable",
      storageIssue: retryableIssue,
    });
  });

  it("alerts on a non-retryable global issue without terminally failing Workspaces", async () => {
    const harness = createStore([workspace()]);
    const service = createService(harness.store, {
      preflight: async () => {
        throw new PreflightFailure(alertIssue);
      },
    });

    await service.reconcile();
    await service.reconcile();
    const result = await service.reconcile();

    expect(result).toEqual({
      available: false,
      detail: alertIssue.message,
      issue: alertIssue,
      severity: "alert",
    });
    expect(harness.workspaces[0]).toMatchObject({
      status: "unavailable",
      storageIssue: alertIssue,
    });
  });

  it("resets the failed-preflight counter after a successful pass", async () => {
    const harness = createStore([workspace()]);
    let attempt = 0;
    const service = createService(harness.store, {
      preflight: async () => {
        attempt += 1;
        if (attempt === 3) return { available: true, detail: "portablefs-test" };
        throw new PreflightFailure(retryableIssue);
      },
    });

    await service.reconcile();
    await service.reconcile();
    await service.reconcile();
    await service.reconcile();
    await service.reconcile();
    expect(harness.workspaces[0]?.status).toBe("ready");

    await service.reconcile();
    expect(harness.workspaces[0]?.status).toBe("unavailable");
  });

  it("does not skip rows when inspection mutates status across keyset pages", async () => {
    const harness = createStore(Array.from({ length: 205 }, () => workspace()));
    const service = createService(harness.store, {
      inspect: async () => ({ issue: retryableIssue, status: "unavailable" }),
      preflight: async () => ({ available: true, detail: "portablefs-test" }),
    });

    await service.reconcile();

    expect(harness.workspaces).toHaveLength(205);
    expect(harness.workspaces.every((item) => item.status === "unavailable")).toBe(true);
    expect(
      harness.pages.filter((page) => page.status === "ready").map((page) => page.size),
    ).toEqual([100, 100, 5]);
  });

  // The archive cycle seals, or a wake cancels it, entirely at the storage
  // authority; neither transition reports itself, so reconciliation is the only
  // thing that can move an `archiving` Workspace off that status.
  it.each(["archived", "ready"] as const)(
    "converges an archiving Workspace to %s",
    async (status) => {
      const harness = createStore([workspace({ status: "archiving" })]);
      const service = createService(harness.store, {
        inspect: async () => ({ issue: null, status }),
        preflight: async () => ({ available: true, detail: "portablefs-test" }),
      });

      await service.reconcile();

      expect(harness.workspaces[0]?.status).toBe(status);
    },
  );

  it("leaves a Workspace whose archive cycle is still running untouched", async () => {
    const harness = createStore([workspace({ status: "archiving" })]);
    const service = createService(harness.store, {
      inspect: async () => ({ issue: null, status: "archiving" }),
      preflight: async () => ({ available: true, detail: "portablefs-test" }),
    });

    await service.reconcile();

    expect(harness.workspaces[0]?.status).toBe("archiving");
    expect(harness.stateChanges).toHaveLength(0);
  });

  it("keeps restore progress in the ephemeral Workspace view", async () => {
    const harness = createStore([workspace()]);
    const service = createService(harness.store, {
      inspect: async () => ({
        issue: null,
        restoreProgressPermille: 625,
        status: "provisioning",
      }),
      preflight: async () => ({ available: true, detail: "portablefs-test" }),
    });

    await service.reconcile();

    await expect(service.workspaceView(harness.workspaces[0]!)).resolves.toMatchObject({
      restoreProgressPermille: 625,
      status: "provisioning",
    });
  });
});

describe("WorkspaceService with a machine that owns its own directories", () => {
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
        capacityPolicy: { blockHardLimitBytes: 1_024, inodeHardLimit: 10, kind: "hard-quota" },
        createdBy: createId("user"),
        idempotencyKey: "quota-on-a-laptop",
        name: "Research",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("WorkspaceService creation capacity policy", () => {
  it("refuses a quota above the deployment ceiling", async () => {
    const harness = createStore([]);
    const service = createService(harness.store, {
      preflight: async () => ({ available: true, detail: "portablefs-test" }),
    });

    await expect(
      service.create({
        capacityPolicy: {
          blockHardLimitBytes: 101 * 1_024 * 1_024 * 1_024,
          inodeHardLimit: 2_000_000,
          kind: "hard-quota",
        },
        createdBy: createId("user"),
        idempotencyKey: "over-ceiling",
        name: "Too Large",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(harness.workspaces).toHaveLength(0);
  });

  it("refuses a capacity policy kind that differs from the deployment", async () => {
    const service = createService(createStore([]).store, {
      preflight: async () => ({ available: true, detail: "portablefs-test" }),
    });

    await expect(
      service.create({
        capacityPolicy: { kind: "host-filesystem" },
        createdBy: createId("user"),
        idempotencyKey: "wrong-kind",
        name: "Wrong Kind",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

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
        capacityPolicy: {
          blockHardLimitBytes: 1_024,
          inodeHardLimit: 1,
          kind: "hard-quota",
        },
        createdBy: createId("user"),
        idempotencyKey: "local-hard-quota",
        name: "Local",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

class PreflightFailure extends Error {
  readonly issue: WorkspaceStorageIssue;

  constructor(issue: WorkspaceStorageIssue) {
    super(issue.message);
    this.issue = issue;
  }
}

function createService(
  store: object,
  options: {
    readonly admitsCreates?: () => Promise<boolean>;
    readonly inspect?: (workspace: Workspace) => Promise<WorkspaceBackingHealth>;
    readonly preflight: () => Promise<WorkspaceBackingReadiness>;
    readonly provision?: WorkspaceBackingLifecycleDriver<"portablefs">["provision"];
  },
): WorkspaceService {
  const driver: WorkspaceBackingLifecycleDriver<"portablefs"> = {
    ...(options.admitsCreates ? { admitsCreates: options.admitsCreates } : {}),
    destroy: async () => undefined,
    kind: "portablefs",
    initialBacking: (input) => ({
      generation: 1,
      kind: "portablefs",
      serviceId: "portablefs-test",
      volumeId: `pending_${input.workspaceId}`,
    }),
    inspect: options.inspect ?? (async () => ({ issue: null, status: "ready" })),
    issueFromError: (error) => (error instanceof PreflightFailure ? error.issue : retryableIssue),
    preflight: options.preflight,
    provision:
      options.provision ??
      (async ({ workspace: current }) => ({ backing: current.backing, status: "ready" })),
  };
  return new WorkspaceService({
    capacityPolicy: {
      blockHardLimitBytes: 512 * 1_024 * 1_024,
      inodeHardLimit: 50_000,
      kind: "hard-quota",
    },
    capacityPolicyCeiling: {
      blockHardLimitBytes: 100 * 1_024 * 1_024 * 1_024,
      inodeHardLimit: 10_000_000,
      kind: "hard-quota",
    },
    drivers: { portableFs: driver },
    shape: {
      defaultWorkspaceBacking: "portablefs",
      kind: "server" as const,
    },
    store: store as never,
  });
}

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

function localService(
  store: ReturnType<typeof createStore>["store"],
  options: {
    readonly inspect?: WorkspaceBackingLifecycleDriver<"local-directory">["inspect"];
    readonly provision?: WorkspaceBackingLifecycleDriver<"local-directory">["provision"];
  },
): WorkspaceService {
  const driver: WorkspaceBackingLifecycleDriver<"local-directory"> = {
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
      async getEnvironment(id: EnvironmentId) {
        const name = environments.get(id);
        return name === undefined ? null : { id, name };
      },
      async createWorkspace(input: {
        readonly backing: Workspace["backing"];
        readonly capacityPolicy: Workspace["capacityPolicy"];
        readonly createdBy: Workspace["createdBy"];
        readonly id: WorkspaceId;
        readonly kind?: Workspace["kind"];
        readonly name: string;
        readonly status: Workspace["status"];
      }) {
        const now = new Date().toISOString();
        const created: Workspace = {
          backing: input.backing,
          capacityPolicy: input.capacityPolicy,
          createdAt: now,
          createdBy: input.createdBy,
          homeThreadId: null,
          icon: null,
          id: input.id,
          kind: input.kind ?? "specialized",
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

function workspace(
  options: {
    readonly pending?: boolean;
    readonly status?: Workspace["status"];
  } = {},
): Workspace {
  const now = "2026-08-20T12:00:00.000Z";
  const id = createId("workspace");
  return {
    backing: {
      generation: 1,
      kind: "portablefs",
      serviceId: "portablefs-test",
      volumeId: options.pending ? `pending_${id}` : `volume_${id}`,
    },
    capacityPolicy: {
      blockHardLimitBytes: 512 * 1_024 * 1_024,
      inodeHardLimit: 50_000,
      kind: "hard-quota",
    },
    createdAt: now,
    createdBy: createId("user"),
    homeThreadId: null,
    icon: null,
    id,
    kind: "main",
    name: "Main",
    status: options.status ?? "ready",
    storageIssue: null,
    updatedAt: now,
  };
}

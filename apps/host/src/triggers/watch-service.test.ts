import { WorkspaceSchema, createId, type EnvironmentId, type WorkspaceId } from "@opensteer/core";
import type { WatchActivationContext } from "@opensteer/database";
import type { RunnerIdentity } from "@opensteer/orchestration";
import {
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  runnerEnvironmentIds,
  RunnerDescriptorSchema,
} from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { TriggerWatchActivationSchema } from "@opensteer/triggers";
import { describe, expect, it, vi } from "vitest";
import { WatchService, type WatchServiceOptions } from "./watch-service.js";

describe("WatchService", () => {
  it("never activates an unsupported v3 Watch and records the actionable failure", async () => {
    const fixture = watchFixture();
    const context = { ...fixture.context, toolContractVersion: 3 as const };
    const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
      async () => undefined,
    );
    const recordWatchUnavailable = vi.fn<WatchServiceOptions["store"]["recordWatchUnavailable"]>(
      async () => context.activation,
    );
    const service = new WatchService({
      ...options(fixture, {
        reconcileWatches,
        recordWatchUnavailable,
        reconcileWatchesForRunner: async () => ({ activations: [context], reconcileGeneration: 1 }),
      }),
      runnerStore: {
        getEnvironment: async () => ({ runnerId: fixture.identity.runnerId }),
        runnerCapabilities: async () => [],
      } as never,
    });
    try {
      await service.reconcile(context.activation.environmentId);
      expect(reconcileWatches.mock.calls[0]?.[2]).toEqual([]);
      expect(recordWatchUnavailable).toHaveBeenCalledWith(
        expect.objectContaining({
          activationId: context.activation.id,
          reason:
            "This computer's Runner cannot run Trigger program version 3. Use version 2 or update that computer.",
        }),
      );
    } finally {
      await service.close();
    }
  });

  it("builds the desired set without sending program bodies and applies fenced status", async () => {
    const fixture = watchFixture();
    const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
      async () => undefined,
    );
    const applyWatchStatus = vi.fn(async () => ({
      activation: { ...fixture.context.activation, desired: "stopped" as const },
      autoPaused: true,
    }));
    const onChanged = vi.fn();
    const service = new WatchService(
      options(fixture, { applyWatchStatus, onChanged, reconcileWatches }),
    );

    expect(service.runnerRegistered(fixture.identity)).toBeUndefined();
    await vi.waitFor(() => expect(reconcileWatches).toHaveBeenCalledOnce());
    const desired = reconcileWatches.mock.calls[0]?.[2];
    expect(desired).toEqual([
      expect.objectContaining({
        activationId: fixture.context.activation.id,
        capabilities: {
          browserCdp: null,
          integrationMcp: expect.objectContaining({ token: "integration-token" }),
          mcp: expect.objectContaining({ token: "control-token" }),
        },
        executionGeneration: 3,
        revisionId: fixture.context.activation.revisionId,
      }),
    ]);
    expect(desired?.[0]).not.toHaveProperty("program");

    await service.applyStatus(fixture.identity, {
      activationId: fixture.context.activation.id,
      executionGeneration: 3,
      healthySince: null,
      lastError: "program exited",
      lastExitCode: 1,
      observed: "backoff",
      restartCount: 3,
      stderrTail: "failed\n",
      stdoutTail: "",
      type: "runner.watch-status",
    });
    expect(applyWatchStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        runnerBootId: fixture.identity.bootId,
        runnerConnectionGeneration: fixture.identity.connectionGeneration,
        runnerId: fixture.identity.runnerId,
      }),
    );
    expect(onChanged).toHaveBeenCalledWith(fixture.context.activation.workspaceId);
    await vi.waitFor(() => expect(reconcileWatches).toHaveBeenCalledTimes(2));
    await service.close();
  });

  it("leaves a not-ready Workspace in starting state and sends an empty desired set", async () => {
    const fixture = watchFixture("provisioning");
    const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
      async () => undefined,
    );
    const plan = vi.fn();
    const service = new WatchService(options(fixture, { plan, reconcileWatches }));

    expect(service.runnerRegistered(fixture.identity)).toBeUndefined();
    await vi.waitFor(() => expect(reconcileWatches).toHaveBeenCalledOnce());
    expect(plan).not.toHaveBeenCalled();
    expect(reconcileWatches.mock.calls[0]?.[2]).toEqual([]);
    await service.close();
  });

  it("runs an accessible local watch while recording an unsupported shared watch", async () => {
    const fixture = watchFixture();
    const sharedWorkspaceId = createId("workspace");
    const sharedContext: WatchActivationContext = {
      ...fixture.context,
      activation: TriggerWatchActivationSchema.parse({
        ...fixture.context.activation,
        id: createId("triggerWatchActivation"),
        triggerId: createId("trigger"),
        workspaceId: sharedWorkspaceId,
      }),
      workspace: WorkspaceSchema.parse({
        ...fixture.context.workspace,
        backing: {
          generation: 1,
          kind: "portablefs",
          serviceId: "test-portablefs",
          volumeId: "test-volume",
        },
        capacityPolicy: {
          blockHardLimitBytes: 10_000_000,
          inodeHardLimit: 10_000,
          kind: "hard-quota",
        },
        id: sharedWorkspaceId,
      }),
    };
    const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
      async () => undefined,
    );
    const recordWatchUnavailable = vi.fn<WatchServiceOptions["store"]["recordWatchUnavailable"]>(
      async () => ({
        ...sharedContext.activation,
        lastError: "Runner does not support portablefs Workspace access",
        observed: "backoff",
      }),
    );
    const plan = vi.fn<WatchServiceOptions["workspaceAccess"]["plan"]>(async ({ workspace }) => {
      if (workspace.backing.kind === "portablefs") {
        throw new Error("Runner does not support portablefs Workspace access");
      }
      if (workspace.backing.storageAuthorityId === null) {
        throw new Error("Workspace predates machine-owned storage");
      }
      return {
        ...workspace.backing,
        storageAuthorityId: workspace.backing.storageAuthorityId,
        workspaceId: workspace.id,
      };
    });
    const service = new WatchService(
      options(fixture, {
        plan,
        reconcileWatches,
        reconcileWatchesForRunner: async () => ({
          activations: [fixture.context, sharedContext],
          reconcileGeneration: 1,
        }),
        recordWatchUnavailable,
      }),
    );

    try {
      service.runnerRegistered(fixture.identity);
      await vi.waitFor(() => expect(reconcileWatches).toHaveBeenCalledOnce());
      expect(reconcileWatches.mock.calls[0]?.[2].map(({ activationId }) => activationId)).toEqual([
        fixture.context.activation.id,
      ]);
      expect(recordWatchUnavailable).toHaveBeenCalledWith(
        expect.objectContaining({
          activationId: sharedContext.activation.id,
          reason: "Runner does not support portablefs Workspace access",
        }),
      );
    } finally {
      await service.close();
    }
  });

  it("serializes repeated reconciliation so the latest live Runner identity is used", async () => {
    const fixture = watchFixture();
    let identity = fixture.identity;
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    const reconcileWatchesForRunner = vi
      .fn()
      .mockImplementationOnce(async () => {
        await first;
        return { activations: [fixture.context], reconcileGeneration: 1 };
      })
      .mockResolvedValue({ activations: [fixture.context], reconcileGeneration: 2 });
    const service = new WatchService(
      options(fixture, {
        identityForEnvironment: () => identity,
        reconcileWatchesForRunner,
      }),
    );
    service.changed(fixture.context.activation.environmentId);
    const newBootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    identity = { ...identity, bootId: newBootId, connectionGeneration: 2 };
    service.changed(fixture.context.activation.environmentId);
    releaseFirst?.();
    await vi.waitFor(() => expect(reconcileWatchesForRunner).toHaveBeenCalledTimes(2));

    expect(reconcileWatchesForRunner.mock.calls[1]?.[0]).toMatchObject({
      runnerBootId: newBootId,
    });
    await service.close();
  });

  it("retries a failed reconciliation until the desired state converges", async () => {
    vi.useFakeTimers();
    const fixture = watchFixture();
    const reconcileWatchesForRunner = vi
      .fn<WatchServiceOptions["store"]["reconcileWatchesForRunner"]>()
      .mockRejectedValueOnce(new Error("transient database failure"))
      .mockResolvedValue({ activations: [fixture.context], reconcileGeneration: 2 });
    const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
      async () => undefined,
    );
    const onError = vi.fn();
    const service = new WatchService(
      options(fixture, { onError, reconcileWatches, reconcileWatchesForRunner }),
    );

    try {
      service.changed(fixture.context.activation.environmentId);
      await vi.advanceTimersByTimeAsync(0);
      expect(reconcileWatchesForRunner).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "transient database failure" }),
        fixture.context.activation.environmentId,
      );

      await vi.advanceTimersByTimeAsync(4_999);
      expect(reconcileWatchesForRunner).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(reconcileWatchesForRunner).toHaveBeenCalledTimes(2);
      expect(reconcileWatches).toHaveBeenCalledOnce();
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });
});

function options(
  fixture: ReturnType<typeof watchFixture>,
  overrides: Partial<WatchServiceOptions> & {
    readonly applyWatchStatus?: WatchServiceOptions["store"]["applyWatchStatus"];
    readonly identityForEnvironment?: WatchServiceOptions["runners"]["identityForEnvironment"];
    readonly onChanged?: WatchServiceOptions["onChanged"];
    readonly onError?: WatchServiceOptions["onError"];
    readonly plan?: WatchServiceOptions["workspaceAccess"]["plan"];
    readonly reconcileWatches?: WatchServiceOptions["runners"]["reconcileWatches"];
    readonly reconcileWatchesForRunner?: WatchServiceOptions["store"]["reconcileWatchesForRunner"];
    readonly recordWatchUnavailable?: WatchServiceOptions["store"]["recordWatchUnavailable"];
  } = {},
): WatchServiceOptions {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  return {
    runnerStore: { getEnvironment: vi.fn(), runnerCapabilities: vi.fn() },
    browser: { hasBrowserProfileAccess: async () => false },
    browserCdpUrl: "wss://host.test/internal/v1/watch-cdp",
    controlTokens: { issue: () => ({ expiresAt, token: "control-token" }) },
    integrationMcpUrl: "https://host.test/integration-mcp",
    integrationTokens: { issue: () => ({ expiresAt, token: "integration-token" }) },
    mcpUrl: "https://host.test/mcp",
    onChanged: overrides.onChanged ?? (() => undefined),
    onError: overrides.onError ?? (() => undefined),
    runners: {
      identityForEnvironment: overrides.identityForEnvironment ?? (() => fixture.identity),
      reconcileWatches: overrides.reconcileWatches ?? (async () => undefined),
    },
    store: {
      applyWatchStatus:
        overrides.applyWatchStatus ??
        (async () => ({ activation: fixture.context.activation, autoPaused: false })),
      reconcileWatchesForRunner:
        overrides.reconcileWatchesForRunner ??
        (async () => ({ activations: [fixture.context], reconcileGeneration: 1 })),
      recordWatchUnavailable:
        overrides.recordWatchUnavailable ??
        (async () => ({
          ...fixture.context.activation,
          lastError: "Workspace access is unavailable",
          observed: "backoff",
        })),
      watchEnvironmentForTrigger: async () => fixture.context.activation.environmentId,
      watchEnvironmentsForWorkspace: async () => [fixture.context.activation.environmentId],
    },
    watchBrowserTokens: { issue: () => ({ expiresAt, token: "browser-token" }) },
    workspaceAccess: {
      plan:
        overrides.plan ??
        (async () => ({
          bindingId: createId("workspaceBinding"),
          generation: 1,
          kind: "local-directory" as const,
          ownerEnvironmentId: fixture.context.activation.environmentId,
          storageAuthorityId: createId("storageAuthority"),
          workspaceId: fixture.context.activation.workspaceId,
        })),
    },
  };
}

function watchFixture(status: "provisioning" | "ready" = "ready"): {
  readonly context: WatchActivationContext;
  readonly identity: RunnerIdentity;
} {
  const environmentId: EnvironmentId = createId("environment");
  const workspaceId: WorkspaceId = createId("workspace");
  const userId = createId("user");
  const triggerId = createId("trigger");
  const revisionId = createId("triggerRevision");
  const storageAuthorityId = createId("storageAuthority");
  const context: WatchActivationContext = {
    activation: TriggerWatchActivationSchema.parse({
      anchorThreadId: createId("thread"),
      consecutiveFailures: 0,
      createdAt: new Date().toISOString(),
      createdBy: userId,
      desired: "active",
      environmentId,
      executionGeneration: 3,
      healthySince: null,
      id: createId("triggerWatchActivation"),
      lastError: null,
      lastExitCode: null,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      observed: "starting",
      restartCount: 0,
      revisionId,
      runnerBootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
      runnerId: createId("runner"),
      stderrTail: "",
      stdoutTail: "",
      triggerId,
      updatedAt: new Date().toISOString(),
      workspaceId,
    }),
    membershipGeneration: 2,
    toolContractVersion: 2,
    workspace: WorkspaceSchema.parse({
      backing: {
        bindingId: createId("workspaceBinding"),
        generation: 1,
        kind: "local-directory",
        ownerEnvironmentId: environmentId,
        storageAuthorityId,
      },
      capacityPolicy: { kind: "host-filesystem" },
      createdAt: new Date().toISOString(),
      createdBy: userId,
      id: workspaceId,
      homeThreadId: createId("thread"),
      icon: null,
      kind: "main",
      name: "Main",
      status,
      storageIssue: null,
      updatedAt: new Date().toISOString(),
    }),
  };
  const descriptor = RunnerDescriptorSchema.parse({
    bootId: context.activation.runnerBootId,
    capabilities: ["filesystem"],
    modules: {
      agents: {
        environmentIds: [environmentId],
        harnessDrivers: [],
        localStorage: { bindings: [], storageAuthorityId, truncated: false },
        maxConcurrentRuns: 4,
        providerStateModes: ["isolated"],
        workspaceBackings: ["local-directory"],
        workspaceMounts: [],
      },
    },
    name: "Runner",
    runnerId: context.activation.runnerId,
    runnerKind: "main",
    runtimeVersion: "test",
  });
  const fence = {
    bootId: descriptor.bootId,
    connectionGeneration: 1,
    connectionId: RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`),
    connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`),
    runnerId: descriptor.runnerId,
  };
  return {
    context,
    identity: {
      ...descriptor,
      ...fence,
      allowedModules: ["agents"],
      environmentIds: runnerEnvironmentIds(descriptor),
      personalRemoteAccessGeneration: null,
      fence,
    },
  };
}

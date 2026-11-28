import { createId, type EnvironmentId } from "@opensteer/core";
import type { WatchActivationContext } from "@opensteer/database";
import type { RunnerIdentity } from "@opensteer/orchestration";
import {
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  RunnerDescriptorSchema,
  runnerEnvironmentIds,
} from "@opensteer/protocol";
import { TriggerWatchActivationSchema } from "@opensteer/triggers";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WatchService, type WatchServiceOptions } from "./watch-service.js";
describe("WatchService", () => {
  it.each([
    {
      capabilities: ["agent-tools-plan-v1"] as const,
      reason: "Update this computer to run script automations.",
    },
    {
      capabilities: [] as const,
      reason: "Update this computer to use Opensteer tools.",
    },
  ])(
    "never activates an unsupported Watch and records $reason",
    async ({ capabilities, reason }) => {
      const fixture = watchFixture();
      const context = {
        ...fixture.context,
      };
      const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
        async () => undefined,
      );
      const reconcileWatchesForRunner = vi.fn<
        WatchServiceOptions["store"]["reconcileWatchesForRunner"]
      >(async () => ({ activations: [], reconcileGeneration: 1, unavailable: true }));
      const service = new WatchService({
        ...options(fixture, {
          reconcileWatches,
          identityForEnvironment: () => ({
            ...fixture.identity,
            capabilities: [...capabilities],
          }),
          reconcileWatchesForRunner,
        }),
        runnerStore: {
          getEnvironment: async () => ({
            runnerId: fixture.identity.runnerId,
          }),
          runnerCapabilities: async () => [],
        } as never,
      });
      try {
        await service.reconcile(context.activation.environmentId);
        expect(reconcileWatches.mock.calls[0]?.[2]).toEqual([]);
        expect(reconcileWatchesForRunner).toHaveBeenCalledWith(
          expect.objectContaining({
            environmentId: context.activation.environmentId,
            unavailableReason: reason,
          }),
        );
      } finally {
        await service.close();
      }
    },
  );
  it("builds the desired set without sending program bodies and applies fenced status", async () => {
    const fixture = watchFixture();
    const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
      async () => undefined,
    );
    const applyWatchStatus = vi.fn(async () => ({
      activation: {
        ...fixture.context.activation,
        desired: "active" as const,
      },
    }));
    const onChanged = vi.fn();
    const service = new WatchService(
      options(fixture, {
        applyWatchStatus,
        onChanged,
        reconcileWatches,
      }),
    );
    expect(service.runnerRegistered(fixture.identity)).toBeUndefined();
    await vi.waitFor(() => expect(reconcileWatches).toHaveBeenCalledOnce());
    const desired = reconcileWatches.mock.calls[0]?.[2];
    expect(desired).toEqual([
      expect.objectContaining({
        activationId: fixture.context.activation.id,
        capabilities: {
          browserCdp: null,
          mcp: expect.objectContaining({
            token: "control-token",
          }),
        },
        executionGeneration: 3,
        revisionId: fixture.context.activation.revisionId,
        agentHome: fixture.context.agentHome,
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
    expect(onChanged).toHaveBeenCalledWith();
    expect(reconcileWatches).toHaveBeenCalledTimes(1);
    await service.close();
  });
  it("reconciles a desired Watch after a stopped report is replayed", async () => {
    const fixture = watchFixture();
    const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
      async () => undefined,
    );
    const service = new WatchService(
      options(fixture, {
        reconcileWatches,
        applyWatchStatus: async () => ({
          activation: { ...fixture.context.activation, desired: "active" },
        }),
      }),
    );
    try {
      await service.applyStatus(fixture.identity, {
        type: "runner.watch-status",
        activationId: fixture.context.activation.id,
        executionGeneration: 3,
        observed: "stopped",
        restartCount: 0,
        healthySince: null,
        lastError: null,
        lastExitCode: null,
        stderrTail: "",
        stdoutTail: "",
      });
      await vi.waitFor(() => expect(reconcileWatches).toHaveBeenCalledOnce());
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
        return {
          activations: [fixture.context],
          reconcileGeneration: 1,
        };
      })
      .mockResolvedValue({
        activations: [fixture.context],
        reconcileGeneration: 2,
      });
    const service = new WatchService(
      options(fixture, {
        identityForEnvironment: () => identity,
        reconcileWatchesForRunner,
      }),
    );
    service.changed(fixture.context.activation.environmentId);
    const newBootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    identity = {
      ...identity,
      bootId: newBootId,
      connectionGeneration: 2,
    };
    service.changed(fixture.context.activation.environmentId);
    releaseFirst?.();
    await vi.waitFor(() => expect(reconcileWatchesForRunner).toHaveBeenCalledTimes(2));
    expect(reconcileWatchesForRunner.mock.calls[1]?.[0]).toMatchObject({
      runnerBootId: newBootId,
    });
    await service.close();
  });

  it("passes earlierBootsContained=false when a Runner lacks earlier-boots-contained-v1 and notifies on halted watches (AB8)", async () => {
    const fixture = watchFixture();
    const reconcileWatchesForRunner = vi.fn<
      WatchServiceOptions["store"]["reconcileWatchesForRunner"]
    >(async () => ({ activations: [], halted: true, reconcileGeneration: 1 }));
    const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
      async () => undefined,
    );
    const onChanged = vi.fn();
    const service = new WatchService(
      options(fixture, {
        identityForEnvironment: () => ({
          ...fixture.identity,
          capabilities: fixture.identity.capabilities.filter(
            (capability) => capability !== "earlier-boots-contained-v1",
          ),
        }),
        onChanged,
        reconcileWatches,
        reconcileWatchesForRunner,
      }),
    );
    try {
      await service.reconcile(fixture.context.activation.environmentId);
      expect(reconcileWatchesForRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          earlierBootsContained: false,
        }),
      );
      expect(reconcileWatches.mock.calls[0]?.[2]).toEqual([]);
      expect(onChanged).toHaveBeenCalledOnce();
    } finally {
      await service.close();
    }
  });
  it("retries a failed reconciliation until the desired state converges", async () => {
    vi.useFakeTimers();
    const fixture = watchFixture();
    const reconcileWatchesForRunner = vi
      .fn<WatchServiceOptions["store"]["reconcileWatchesForRunner"]>()
      .mockRejectedValueOnce(new Error("transient database failure"))
      .mockResolvedValue({
        activations: [fixture.context],
        reconcileGeneration: 2,
      });
    const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
      async () => undefined,
    );
    const onError = vi.fn();
    const service = new WatchService(
      options(fixture, {
        onError,
        reconcileWatches,
        reconcileWatchesForRunner,
      }),
    );
    try {
      service.changed(fixture.context.activation.environmentId);
      await vi.advanceTimersByTimeAsync(0);
      expect(reconcileWatchesForRunner).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "transient database failure",
        }),
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

  it("arms no periodic renewal timer on an idle Home (Y2 / Rule 7)", async () => {
    vi.useFakeTimers();
    const fixture = watchFixture();
    const reconcileWatchesForRunner = vi.fn(async () => ({
      activations: [],
      reconcileGeneration: 1,
    }));
    const service = new WatchService(
      options(fixture, {
        reconcileWatchesForRunner,
      }),
    );
    try {
      service.start();
      expect(vi.getTimerCount()).toBe(0);
      // Advancing 24 hours on an idle Home must trigger zero watch reconciliation timers.
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
      expect(reconcileWatchesForRunner).not.toHaveBeenCalled();
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });

  it("recovers a watch wake-up when watchEnvironmentForTrigger transiently fails", async () => {
    vi.useFakeTimers();
    const fixture = watchFixture();
    const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
      async () => undefined,
    );
    const watchEnvironmentForTrigger = vi
      .fn<WatchServiceOptions["store"]["watchEnvironmentForTrigger"]>()
      .mockRejectedValueOnce(new Error("transient db lookup error"))
      .mockResolvedValueOnce(fixture.context.activation.environmentId);
    const baseOptions = options(fixture, { reconcileWatches });
    const service = new WatchService({
      ...baseOptions,
      store: { ...baseOptions.store, watchEnvironmentForTrigger },
    });
    try {
      await service.triggerChanged(fixture.context.activation.triggerId);
      expect(reconcileWatches).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(watchEnvironmentForTrigger).toHaveBeenCalledTimes(2);
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
    readonly reconcileWatches?: WatchServiceOptions["runners"]["reconcileWatches"];
    readonly reconcileWatchesForRunner?: WatchServiceOptions["store"]["reconcileWatchesForRunner"];
  } = {},
): WatchServiceOptions {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  return {
    runnerStore: {
      getEnvironment: async () => ({ runnerId: fixture.identity.runnerId }) as never,
      runnerCapabilities: async () => ["automation-script-v1"],
    },
    browser: {
      hasBrowserProfiles: async () => false,
    },
    browserCdpUrl: "wss://host.test/internal/v1/watch-cdp",
    controlTokens: {
      issue: () => ({
        expiresAt,
        token: "control-token",
      }),
    },
    mcpUrl: "https://host.test/mcp",
    onChanged: overrides.onChanged ?? (() => undefined),
    onError: overrides.onError ?? (() => undefined),
    runners: {
      identityForEnvironment: overrides.identityForEnvironment ?? (() => fixture.identity),
      reconcileWatches: overrides.reconcileWatches ?? (async () => undefined),
    },
    store: {
      assertActiveWatchBinding: async () => undefined,
      applyWatchStatus:
        overrides.applyWatchStatus ??
        (async () => ({
          activation: fixture.context.activation,
        })),
      reconcileWatchesForRunner:
        overrides.reconcileWatchesForRunner ??
        (async () => ({
          activations: [fixture.context],
          reconcileGeneration: 1,
        })),
      watchEnvironmentForTrigger: async () => fixture.context.activation.environmentId,
      watchEnvironments: async () => [fixture.context.activation.environmentId],
    },
    watchBrowserTokens: {
      issue: () => ({
        expiresAt,
        token: "browser-token",
      }),
    },
  };
}
function watchFixture(): {
  readonly context: WatchActivationContext;
  readonly identity: RunnerIdentity;
} {
  const environmentId: EnvironmentId = createId("environment");
  const userId = createId("user");
  const triggerId = createId("trigger");
  const revisionId = createId("triggerRevision");
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
    }),
    agentHome: { computerId: createId("runner"), path: "/tmp/watch-home" },
  };
  const descriptor = RunnerDescriptorSchema.parse({
    bootId: context.activation.runnerBootId,
    capabilities: ["filesystem", "agent-tools-plan-v1"],
    modules: {
      agents: {
        environmentIds: [environmentId],
        harnessDrivers: [],

        maxConcurrentRuns: 4,
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

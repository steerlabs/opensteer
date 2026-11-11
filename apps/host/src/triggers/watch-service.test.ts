import { WorkspaceSchema, createId, type EnvironmentId } from "@opensteer/core";
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
      reason:
        "This computer's Runner cannot run Trigger program version 3. Use version 2 or update that computer.",
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
        toolContractVersion: 3 as const,
      };
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
          identityForEnvironment: () => ({
            ...fixture.identity,
            capabilities: [...capabilities],
          }),
          reconcileWatchesForRunner: async () => ({
            activations: [context],
            reconcileGeneration: 1,
          }),
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
        expect(recordWatchUnavailable).toHaveBeenCalledWith(
          expect.objectContaining({
            activationId: context.activation.id,
            reason,
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
        desired: "stopped" as const,
      },
      autoPaused: true,
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
    await vi.waitFor(() => expect(reconcileWatches).toHaveBeenCalledTimes(2));
    await service.close();
  });
  it("marks an unavailable anchor folder and sends an empty desired set", async () => {
    const fixture = watchFixture();
    const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
      async () => undefined,
    );
    const recordWatchUnavailable = vi.fn<WatchServiceOptions["store"]["recordWatchUnavailable"]>(
      async () => fixture.context.activation,
    );
    const assertAvailable = vi.fn<WatchServiceOptions["folders"]["assertAvailable"]>(async () => {
      throw new Error("The anchor folder is missing");
    });
    const service = new WatchService(
      options(fixture, { assertAvailable, recordWatchUnavailable, reconcileWatches }),
    );
    try {
      service.runnerRegistered(fixture.identity);
      await vi.waitFor(() => expect(reconcileWatches).toHaveBeenCalledOnce());
      expect(assertAvailable).toHaveBeenCalledWith(fixture.context.location.folder);
      expect(reconcileWatches.mock.calls[0]?.[2]).toEqual([]);
      expect(recordWatchUnavailable).toHaveBeenCalledWith(
        expect.objectContaining({
          activationId: fixture.context.activation.id,
          reason: "The anchor folder is missing",
        }),
      );
    } finally {
      await service.close();
    }
  });

  it("runs an available anchor while reporting another task's missing folder", async () => {
    const fixture = watchFixture();
    const unavailable: WatchActivationContext = {
      ...fixture.context,
      activation: {
        ...fixture.context.activation,
        id: createId("triggerWatchActivation"),
        triggerId: createId("trigger"),
        anchorThreadId: createId("thread"),
      },
      location: {
        ...fixture.context.location,
        folder: { ...fixture.context.location.folder, path: "/tmp/missing-task" },
      },
    };
    const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
      async () => undefined,
    );
    const recordWatchUnavailable = vi.fn<WatchServiceOptions["store"]["recordWatchUnavailable"]>(
      async () => unavailable.activation,
    );
    const service = new WatchService(
      options(fixture, {
        assertAvailable: async (folder) => {
          if (folder.path === unavailable.location.folder.path)
            throw new Error("The anchor folder is missing");
        },
        reconcileWatches,
        recordWatchUnavailable,
        reconcileWatchesForRunner: async () => ({
          activations: [fixture.context, unavailable],
          reconcileGeneration: 1,
        }),
      }),
    );
    try {
      service.runnerRegistered(fixture.identity);
      await vi.waitFor(() => expect(reconcileWatches).toHaveBeenCalledOnce());
      expect(reconcileWatches.mock.calls[0]?.[2].map(({ activationId }) => activationId)).toEqual([
        fixture.context.activation.id,
      ]);
      expect(reconcileWatches.mock.calls[0]?.[2][0]?.location).toEqual(fixture.context.location);
      expect(recordWatchUnavailable).toHaveBeenCalledWith(
        expect.objectContaining({
          activationId: unavailable.activation.id,
          reason: "The anchor folder is missing",
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
});
function options(
  fixture: ReturnType<typeof watchFixture>,
  overrides: Partial<WatchServiceOptions> & {
    readonly applyWatchStatus?: WatchServiceOptions["store"]["applyWatchStatus"];
    readonly identityForEnvironment?: WatchServiceOptions["runners"]["identityForEnvironment"];
    readonly onChanged?: WatchServiceOptions["onChanged"];
    readonly onError?: WatchServiceOptions["onError"];
    readonly assertAvailable?: WatchServiceOptions["folders"]["assertAvailable"];
    readonly reconcileWatches?: WatchServiceOptions["runners"]["reconcileWatches"];
    readonly reconcileWatchesForRunner?: WatchServiceOptions["store"]["reconcileWatchesForRunner"];
    readonly recordWatchUnavailable?: WatchServiceOptions["store"]["recordWatchUnavailable"];
  } = {},
): WatchServiceOptions {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  return {
    runnerStore: {
      getEnvironment: async () => ({ runnerId: fixture.identity.runnerId }) as never,
      runnerCapabilities: async () => ["trigger-program-v3"],
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
      applyWatchStatus:
        overrides.applyWatchStatus ??
        (async () => ({
          activation: fixture.context.activation,
          autoPaused: false,
        })),
      reconcileWatchesForRunner:
        overrides.reconcileWatchesForRunner ??
        (async () => ({
          activations: [fixture.context],
          reconcileGeneration: 1,
        })),
      recordWatchUnavailable:
        overrides.recordWatchUnavailable ??
        (async () => ({
          ...fixture.context.activation,
          lastError: "The anchor folder is unavailable",
          observed: "backoff",
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
    folders: { assertAvailable: overrides.assertAvailable ?? (async () => undefined) },
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
    toolContractVersion: 3,
    location: {
      folder: { computerId: createId("runner"), path: "/tmp/watch-task" },
      agentHome: { computerId: createId("runner"), path: "/tmp/watch-home" },
    },
  };
  const descriptor = RunnerDescriptorSchema.parse({
    bootId: context.activation.runnerBootId,
    capabilities: ["filesystem", "agent-tools-plan-v1"],
    modules: {
      agents: {
        environmentIds: [environmentId],
        harnessDrivers: [],

        maxConcurrentRuns: 4,
        providerStateModes: ["isolated"],
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

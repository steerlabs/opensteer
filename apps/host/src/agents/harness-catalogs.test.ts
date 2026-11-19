import {
  HarnessIdSchema,
  createId,
  harnessUsageLimitFailureCode,
  type EnvironmentId,
  type HarnessInstanceId,
} from "@opensteer/core";
import type { HarnessInstanceRecord } from "@opensteer/database";
import { HarnessInstanceCatalogSchema, type HarnessInstanceCatalog } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  HarnessCatalogReconciliationOwner,
  harnessCatalogMaxAgeMs,
  harnessCatalogRetryMs,
  inspectHarnessCatalogsAfterUsageLimit,
  reconcileHarnessCatalogs,
  recaptureInvalidatedHarnessCatalog,
  createHarnessCatalogConvergence,
  type HarnessCatalogConvergenceStore,
  type HarnessCatalogInspector,
} from "./harness-catalogs.js";
const harnessInstanceId = createId("harnessInstance");
const harnessEnvironmentId = createId("environment");
const harness: HarnessInstanceRecord = {
  config: {},
  driverKind: HarnessIdSchema.parse("codex"),
  enabled: true,
  environmentId: harnessEnvironmentId,
  id: harnessInstanceId,
  isDefault: true,
  name: "Codex",
  removedAt: null,
  runtimeRevision: 1,
  sourceId: "openai",
  stateKind: "isolated",
};
function readyCatalog(): HarnessInstanceCatalog {
  return HarnessInstanceCatalogSchema.parse({
    continuationIdentity: {
      continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
      driverKind: "codex",
    },
    driverKind: "codex",
    harnessInstanceId,
    models: [
      {
        displayName: "GPT-5.6 Sol",
        isDefault: true,
        modelId: "gpt-5.6-sol",
        options: [],
        providerId: "openai",
      },
    ],
    status: "ready",
    steering: false,
  });
}
function errorCatalog(): HarnessInstanceCatalog {
  return HarnessInstanceCatalogSchema.parse({
    detail: "The AI engine could not be inspected",
    driverKind: "codex",
    harnessInstanceId,
    models: [],
    status: "error",
  });
}
function convergence(options: {
  readonly capturedAt?: Date;
  readonly harnesses?: readonly HarnessInstanceRecord[];
  readonly stored?: HarnessInstanceCatalog | null;
}) {
  const recorded: HarnessInstanceCatalog[][] = [];
  const revisions: ReadonlyMap<HarnessInstanceId, number>[] = [];
  // Stored before the reconcile under test starts its clock, as a real observation is.
  const capturedAt = options.capturedAt ?? new Date();
  const inspectHarnesses = vi.fn<HarnessCatalogInspector["inspectHarnesses"]>(async () => [
    readyCatalog(),
  ]);
  const catalogs: HarnessCatalogConvergenceStore = {
    listHarnessCatalogs: async () =>
      options.stored
        ? [
            {
              capturedAt,
              catalog: options.stored,
              environmentId: harnessEnvironmentId,
              harnessInstanceId,
            },
          ]
        : [],
    listHarnessInstances: async () => options.harnesses ?? [harness],
    recordHarnessCatalogs: async ({ catalogs: captured, expectedRevisions }) => {
      recorded.push([...captured]);
      revisions.push(expectedRevisions);
      return captured;
    },
  };
  return {
    catalogs,
    inspectHarnesses,
    recorded,
    revisions,
  };
}
describe("harness catalog convergence", () => {
  it("observes only the subset the recorder actually persisted", async () => {
    const { catalogs, inspectHarnesses } = convergence({
      stored: null,
    });
    catalogs.recordHarnessCatalogs = async () => [];
    const onCommitted = vi.fn();
    await reconcileHarnessCatalogs({
      catalogs,
      connectedEnvironmentIds: [harnessEnvironmentId],
      runners: {
        inspectHarnesses,
      },
      signal: AbortSignal.timeout(1_000),
      onCommitted,
    });
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(harnessEnvironmentId, []);
  });
  it("captures the catalog an attached work location never managed to report", async () => {
    const environmentId = harnessEnvironmentId;
    const { catalogs, inspectHarnesses, recorded, revisions } = convergence({
      stored: null,
    });
    await reconcileHarnessCatalogs({
      catalogs,
      connectedEnvironmentIds: [environmentId],
      runners: {
        inspectHarnesses,
      },
      signal: AbortSignal.timeout(1_000),
    });
    expect(inspectHarnesses).toHaveBeenCalledTimes(1);
    expect(inspectHarnesses.mock.calls[0]?.[0]).toBe(environmentId);
    expect(recorded).toEqual([[readyCatalog()]]);
    expect(revisions).toEqual([new Map([[harnessInstanceId, harness.runtimeRevision]])]);
  });
  it("answers when the oldest ready catalog goes stale, so a deadline can refresh it", async () => {
    const now = Date.now();
    const { catalogs, inspectHarnesses } = convergence({
      capturedAt: new Date(now - 10 * 60_000),
      stored: readyCatalog(),
    });
    await expect(
      reconcileHarnessCatalogs({
        catalogs,
        connectedEnvironmentIds: [harnessEnvironmentId],
        now,
        runners: { inspectHarnesses },
        signal: AbortSignal.timeout(1_000),
      }),
    ).resolves.toEqual({ staleAt: new Date(now - 10 * 60_000 + harnessCatalogMaxAgeMs) });
    expect(inspectHarnesses).not.toHaveBeenCalled();
  });
  it("asks again thirty seconds after inspecting an error", async () => {
    const now = Date.now();
    const { catalogs, inspectHarnesses } = convergence({ stored: null });
    inspectHarnesses.mockResolvedValueOnce([errorCatalog()]);
    await expect(
      reconcileHarnessCatalogs({
        catalogs,
        connectedEnvironmentIds: [harnessEnvironmentId],
        now,
        runners: { inspectHarnesses },
        signal: AbortSignal.timeout(1_000),
      }),
    ).resolves.toEqual({ staleAt: new Date(now + harnessCatalogRetryMs) });
  });
  it("leaves convergence owed after an invalidation whose recapture fails", async () => {
    let stored: HarnessInstanceCatalog | null = {
      ...errorCatalog(),
      status: "authentication-required",
      detail: "Sign in to use this engine",
    };
    const settled = convergence({ stored });
    // Sign-in required is settled: convergence alone would never ask again.
    await reconcileHarnessCatalogs({
      catalogs: settled.catalogs,
      connectedEnvironmentIds: [harnessEnvironmentId],
      runners: { inspectHarnesses: settled.inspectHarnesses },
      signal: AbortSignal.timeout(1_000),
    });
    expect(settled.inspectHarnesses).not.toHaveBeenCalled();
    const onFailed = vi.fn();
    await recaptureInvalidatedHarnessCatalog({
      catalogs: settled.catalogs,
      environmentIds: [harnessEnvironmentId],
      harnessInstanceId,
      runners: {
        inspectHarnesses: vi.fn(async () => {
          throw new Error("Runner did not answer");
        }),
      },
      signal: AbortSignal.timeout(1_000),
      store: {
        getHarnessInstance: async () => harness,
        discardHarnessCatalog: async () => {
          stored = null;
        },
      },
      onCaptured: vi.fn(),
      onFailed,
    });
    expect(onFailed).toHaveBeenCalledTimes(1);
    // What the woken convergence then finds: no stored catalog, so it asks.
    const after = convergence({ stored });
    await reconcileHarnessCatalogs({
      catalogs: after.catalogs,
      connectedEnvironmentIds: [harnessEnvironmentId],
      runners: { inspectHarnesses: after.inspectHarnesses },
      signal: AbortSignal.timeout(1_000),
    });
    expect(after.inspectHarnesses).toHaveBeenCalledTimes(1);
  });
  describe("the convergence owner after an invalidation", () => {
    function manual() {
      let now = Date.now();
      const timers = new Set<{ at: number; run: () => void }>();
      return {
        clock: {
          now: () => now,
          schedule(run: () => void, milliseconds: number) {
            const timer = { at: now + milliseconds, run };
            timers.add(timer);
            return () => timers.delete(timer);
          },
        },
        armed: () => [...timers].map((timer) => timer.at - now),
        advance(milliseconds: number) {
          now += milliseconds;
          for (const timer of [...timers].filter((t) => t.at <= now)) {
            timers.delete(timer);
            timer.run();
          }
        },
      };
    }
    const signIn = {
      ...errorCatalog(),
      status: "authentication-required" as const,
      detail: "Sign in to use this engine",
    };
    it("owes a recapture when the invalidation fails before its discard", async () => {
      const time = manual();
      const stored = convergence({ stored: signIn });
      const owner = createHarnessCatalogConvergence({
        catalogs: stored.catalogs,
        runners: { inspectHarnesses: stored.inspectHarnesses },
        captureTimeoutMs: 1_000,
        connectedEnvironmentIds: async () => [harnessEnvironmentId],
        onCommitted: vi.fn(),
        onError: vi.fn(),
        clock: time.clock,
      });
      await recaptureInvalidatedHarnessCatalog({
        catalogs: stored.catalogs,
        environmentIds: [harnessEnvironmentId],
        harnessInstanceId,
        runners: { inspectHarnesses: stored.inspectHarnesses },
        signal: AbortSignal.timeout(1_000),
        store: {
          getHarnessInstance: async () => {
            throw new Error("database connection lost");
          },
          discardHarnessCatalog: vi.fn(),
        },
        onCaptured: vi.fn(),
        onFailed: () => owner.owe(harnessInstanceId),
      });
      await owner.settled();
      // The stored answer still says sign-in required, but the invalidation is honoured.
      expect(stored.inspectHarnesses).toHaveBeenCalledTimes(1);
      await owner.close();
    });
    it("arms a deadline after a recapture that comes back unsettled", async () => {
      const time = manual();
      const stored = convergence({
        capturedAt: new Date(time.clock.now()),
        stored: { ...errorCatalog(), status: "preparing", detail: "Preparing Codex…" },
      });
      const owner = createHarnessCatalogConvergence({
        catalogs: stored.catalogs,
        runners: { inspectHarnesses: stored.inspectHarnesses },
        captureTimeoutMs: 1_000,
        connectedEnvironmentIds: async () => [harnessEnvironmentId],
        onCommitted: vi.fn(),
        onError: vi.fn(),
        clock: time.clock,
      });
      // What the invalidation's capture callback does with the preparing answer it recorded.
      owner.wake();
      await owner.settled();
      expect(time.armed()).toEqual([harnessCatalogRetryMs]);
      time.advance(harnessCatalogRetryMs);
      await owner.settled();
      expect(stored.inspectHarnesses).toHaveBeenCalledTimes(1);
      await owner.close();
    });
  });
  it("re-inspects a stored error once its retry time has passed, and not right after it was recorded", async () => {
    const now = Date.now();
    const fresh = convergence({ capturedAt: new Date(now - 1_000), stored: errorCatalog() });
    // The capture that recorded it just asked; asking again at once only rewrites it.
    await expect(
      reconcileHarnessCatalogs({
        catalogs: fresh.catalogs,
        connectedEnvironmentIds: [harnessEnvironmentId],
        now,
        runners: { inspectHarnesses: fresh.inspectHarnesses },
        signal: AbortSignal.timeout(1_000),
      }),
    ).resolves.toEqual({ staleAt: new Date(now - 1_000 + harnessCatalogRetryMs) });
    expect(fresh.inspectHarnesses).not.toHaveBeenCalled();
    const { catalogs, inspectHarnesses } = convergence({
      capturedAt: new Date(now - harnessCatalogRetryMs),
      stored: errorCatalog(),
    });
    await reconcileHarnessCatalogs({
      now,
      catalogs,
      connectedEnvironmentIds: [harnessEnvironmentId],
      runners: {
        inspectHarnesses,
      },
      signal: AbortSignal.timeout(1_000),
    });
    expect(inspectHarnesses).toHaveBeenCalledTimes(1);
  });
  it.each([0, 40_000, harnessCatalogMaxAgeMs * 2])(
    "keeps sign-in required stable after %i milliseconds",
    async (age) => {
      const now = Date.now();
      const { catalogs, inspectHarnesses, recorded } = convergence({
        capturedAt: new Date(now - age),
        stored: {
          ...errorCatalog(),
          status: "authentication-required",
          detail: "Sign in to use this engine",
        },
      });
      await reconcileHarnessCatalogs({
        catalogs,
        connectedEnvironmentIds: [harnessEnvironmentId],
        now,
        runners: {
          inspectHarnesses,
        },
        signal: AbortSignal.timeout(1_000),
      });
      expect(inspectHarnesses).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
    },
  );
  it("converges a preparing catalog to the Runner's completed result", async () => {
    const { catalogs, inspectHarnesses, recorded } = convergence({
      capturedAt: new Date(Date.now() - harnessCatalogRetryMs),
      stored: {
        ...errorCatalog(),
        status: "preparing",
        detail: "Preparing Codex…",
      },
    });
    await reconcileHarnessCatalogs({
      catalogs,
      connectedEnvironmentIds: [harnessEnvironmentId],
      runners: {
        inspectHarnesses,
      },
      signal: AbortSignal.timeout(1_000),
    });
    expect(inspectHarnesses).toHaveBeenCalledTimes(1);
    expect(recorded).toEqual([[readyCatalog()]]);
  });
  it("does not re-inspect a fresh ready catalog", async () => {
    const { catalogs, inspectHarnesses } = convergence({
      stored: readyCatalog(),
    });
    await reconcileHarnessCatalogs({
      catalogs,
      connectedEnvironmentIds: [harnessEnvironmentId],
      runners: {
        inspectHarnesses,
      },
      signal: AbortSignal.timeout(1_000),
    });
    expect(inspectHarnesses).not.toHaveBeenCalled();
  });
  it("ignores an AI engine that is turned off", async () => {
    const { catalogs, inspectHarnesses } = convergence({
      harnesses: [
        {
          ...harness,
          enabled: false,
        },
      ],
      stored: null,
    });
    await reconcileHarnessCatalogs({
      catalogs,
      connectedEnvironmentIds: [harnessEnvironmentId],
      runners: {
        inspectHarnesses,
      },
      signal: AbortSignal.timeout(1_000),
    });
    expect(inspectHarnesses).not.toHaveBeenCalled();
  });
  it.each([harnessCatalogMaxAgeMs, harnessCatalogMaxAgeMs + 1, -1])(
    "refreshes ready catalogs whose capture age is %i milliseconds",
    async (age) => {
      const now = Date.now();
      const { catalogs, inspectHarnesses, recorded } = convergence({
        capturedAt: new Date(now - age),
        stored: readyCatalog(),
      });
      await reconcileHarnessCatalogs({
        catalogs,
        connectedEnvironmentIds: [harnessEnvironmentId],
        now,
        runners: {
          inspectHarnesses,
        },
        signal: AbortSignal.timeout(1_000),
      });
      expect(inspectHarnesses).toHaveBeenCalledTimes(1);
      expect(recorded).toEqual([[readyCatalog()]]);
    },
  );
  it("keeps a catalog just inside its freshness window", async () => {
    const now = Date.now();
    const { catalogs, inspectHarnesses } = convergence({
      capturedAt: new Date(now - harnessCatalogMaxAgeMs + 1),
      stored: readyCatalog(),
    });
    await reconcileHarnessCatalogs({
      catalogs,
      connectedEnvironmentIds: [harnessEnvironmentId],
      now,
      runners: {
        inspectHarnesses,
      },
      signal: AbortSignal.timeout(1_000),
    });
    expect(inspectHarnesses).not.toHaveBeenCalled();
  });
  it("refreshes other computers even if one inspection fails", async () => {
    const other = createId("environment");
    const { catalogs, inspectHarnesses } = convergence({
      harnesses: [
        harness,
        {
          ...harness,
          environmentId: other,
          id: createId("harnessInstance"),
        },
      ],
    });
    inspectHarnesses.mockImplementation(async (environmentId) => {
      if (environmentId === harnessEnvironmentId) throw new Error("Computer disconnected");
      return [];
    });
    await expect(
      reconcileHarnessCatalogs({
        catalogs,
        connectedEnvironmentIds: [harnessEnvironmentId, other],
        runners: {
          inspectHarnesses,
        },
        signal: AbortSignal.timeout(1_000),
      }),
    ).rejects.toThrow("AI model catalog refresh failed");
    expect(inspectHarnesses).toHaveBeenCalledTimes(2);
  });
});
describe("mutation-owned harness catalog reconciliation", () => {
  it("retains A's inspection when adding B discards the in-flight desired set", async () => {
    const first = Promise.withResolvers<readonly HarnessInstanceCatalog[]>();
    const secondHarness = {
      ...harness,
      id: createId("harnessInstance"),
      name: "B",
    };
    let current = [harness];
    const stored = new Map<HarnessInstanceId, HarnessInstanceCatalog>();
    const reconcileHarnesses = vi.fn(
      async (
        _environmentId: EnvironmentId,
        _desired: readonly unknown[],
        _signal: AbortSignal,
        inspect?: readonly HarnessInstanceId[],
      ) => {
        if (reconcileHarnesses.mock.calls.length === 1) return await first.promise;
        return (inspect ?? []).map((id) => ({
          ...readyCatalog(),
          harnessInstanceId: id,
        }));
      },
    );
    const owner = new HarnessCatalogReconciliationOwner({
      catalogs: {
        listHarnessInstances: async () => current,
        recordHarnessCatalogs: async ({ catalogs }) => {
          for (const catalog of catalogs) stored.set(catalog.harnessInstanceId, catalog);
          return catalogs;
        },
      },
      onError: (environmentId, error) => {
        throw new Error(`${environmentId}: ${String(error)}`);
      },
      runners: {
        isAvailable: () => true,
        reconcileHarnesses,
      },
    });
    try {
      owner.schedule(harnessEnvironmentId, [harness.id]);
      await vi.waitFor(() => expect(reconcileHarnesses).toHaveBeenCalledTimes(1));
      current = [harness, secondHarness];
      owner.schedule(harnessEnvironmentId, [secondHarness.id]);
      first.resolve([readyCatalog()]);
      await vi.waitFor(() => expect([...stored.keys()]).toEqual([harness.id, secondHarness.id]));
      expect(reconcileHarnesses.mock.calls[1]?.[1]).toHaveLength(2);
      expect(reconcileHarnesses.mock.calls[1]?.[3]).toEqual([harness.id, secondHarness.id]);
    } finally {
      first.resolve([]);
      await owner.close();
    }
  });
  it("coalesces changes behind an active pass and rereads the complete desired set", async () => {
    const first = Promise.withResolvers<readonly HarnessInstanceCatalog[]>();
    let current = [harness];
    const reconcileHarnesses = vi
      .fn()
      .mockImplementationOnce(async () => await first.promise)
      .mockImplementationOnce(async () => []);
    const recordHarnessCatalogs = vi.fn(
      async ({ catalogs }: { readonly catalogs: readonly HarnessInstanceCatalog[] }) => catalogs,
    );
    const owner = new HarnessCatalogReconciliationOwner({
      catalogs: {
        listHarnessInstances: async () => current,
        recordHarnessCatalogs,
      },
      onError: () => undefined,
      runners: {
        isAvailable: () => true,
        reconcileHarnesses,
      },
    });
    owner.schedule(harnessEnvironmentId);
    await vi.waitFor(() => expect(reconcileHarnesses).toHaveBeenCalledTimes(1));
    current = [
      {
        ...harness,
        enabled: false,
      },
    ];
    owner.schedule(harnessEnvironmentId, []);
    owner.schedule(harnessEnvironmentId, [harness.id]);
    first.resolve([readyCatalog()]);
    await vi.waitFor(() => expect(reconcileHarnesses).toHaveBeenCalledTimes(2));
    expect(reconcileHarnesses.mock.calls.map(([, desired]) => desired)).toEqual([
      [
        expect.objectContaining({
          id: harnessInstanceId,
        }),
      ],
      [],
    ]);
    expect(recordHarnessCatalogs).toHaveBeenCalledTimes(1);
    expect(reconcileHarnesses.mock.calls[1]?.[3]).toBeUndefined();
    expect(recordHarnessCatalogs).toHaveBeenCalledWith({
      catalogs: [],
      environmentId: harnessEnvironmentId,
      expectedRevisions: new Map(),
    });
    await owner.close();
  });
  it("cancels an active pass when its Host closes", async () => {
    let operationSignal: AbortSignal | undefined;
    const reconcileHarnesses = vi.fn(
      async (
        _environmentId: EnvironmentId,
        _harnesses: readonly unknown[],
        signal: AbortSignal,
      ) => {
        operationSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        return [];
      },
    );
    const owner = new HarnessCatalogReconciliationOwner({
      catalogs: {
        listHarnessInstances: async () => [harness],
        recordHarnessCatalogs: async ({ catalogs }) => catalogs,
      },
      onError: () => undefined,
      runners: {
        isAvailable: () => true,
        reconcileHarnesses,
      },
    });
    owner.schedule(harnessEnvironmentId);
    await vi.waitFor(() => expect(reconcileHarnesses).toHaveBeenCalledTimes(1));
    await owner.close();
    expect(operationSignal?.aborted).toBe(true);
  });
  it("does not dispatch after shutdown begins during the durable inventory read", async () => {
    const inventory = Promise.withResolvers<readonly HarnessInstanceRecord[]>();
    const listHarnessInstances = vi.fn(async () => await inventory.promise);
    const reconcileHarnesses = vi.fn(async () => []);
    const owner = new HarnessCatalogReconciliationOwner({
      catalogs: {
        listHarnessInstances,
        recordHarnessCatalogs: async ({ catalogs }) => catalogs,
      },
      onError: () => undefined,
      runners: {
        isAvailable: () => true,
        reconcileHarnesses,
      },
    });
    owner.schedule(harnessEnvironmentId);
    await vi.waitFor(() => expect(listHarnessInstances).toHaveBeenCalledTimes(1));
    const closing = owner.close();
    inventory.resolve([harness]);
    await closing;
    expect(reconcileHarnesses).not.toHaveBeenCalled();
  });
});
describe("harness catalog re-inspection after a usage limit", () => {
  it("re-reads the failing work location, because the Run just proved the stored answer wrong", async () => {
    const { catalogs, inspectHarnesses, recorded } = convergence({
      stored: readyCatalog(),
    });
    await inspectHarnessCatalogsAfterUsageLimit({
      catalogs,
      environmentId: harnessEnvironmentId,
      failureCode: harnessUsageLimitFailureCode,
      runners: {
        inspectHarnesses,
      },
      signal: AbortSignal.timeout(1_000),
    });
    expect(inspectHarnesses).toHaveBeenCalledTimes(1);
    expect(inspectHarnesses.mock.calls[0]?.[0]).toBe(harnessEnvironmentId);
    expect(inspectHarnesses.mock.calls[0]?.[1].map(({ id }) => id)).toEqual([harnessInstanceId]);
    expect(recorded).toEqual([[readyCatalog()]]);
  });
  it("leaves every other failure alone", async () => {
    const { catalogs, inspectHarnesses } = convergence({
      stored: readyCatalog(),
    });
    for (const failureCode of ["codex_harness_error", undefined]) {
      await inspectHarnessCatalogsAfterUsageLimit({
        catalogs,
        environmentId: harnessEnvironmentId,
        failureCode,
        runners: {
          inspectHarnesses,
        },
        signal: AbortSignal.timeout(1_000),
      });
    }
    expect(inspectHarnesses).not.toHaveBeenCalled();
  });
});

import {
  AgentEventSchema,
  HarnessIdSchema,
  createId,
  harnessUsageLimitFailureCode,
  type AgentEvent,
  type EnvironmentId,
  type HarnessInstanceId,
} from "@opensteer/core";
import type { HarnessInstanceRecord } from "@opensteer/database";
import { HarnessInstanceCatalogSchema, type HarnessInstanceCatalog } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  HarnessCatalogReconciliationOwner,
  harnessCatalogMaxAgeMs,
  inspectHarnessCatalogsAfterUsageLimit,
  reconcileHarnessCatalogs,
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
  return { catalogs, inspectHarnesses, recorded, revisions };
}

describe("harness catalog convergence", () => {
  it("observes only the subset the recorder actually persisted", async () => {
    const { catalogs, inspectHarnesses } = convergence({ stored: null });
    catalogs.recordHarnessCatalogs = async () => [];
    const onCommitted = vi.fn();
    await reconcileHarnessCatalogs({
      catalogs,
      connectedEnvironmentIds: [harnessEnvironmentId],
      runners: { inspectHarnesses },
      signal: AbortSignal.timeout(1_000),
      onCommitted,
    });
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(harnessEnvironmentId, []);
  });

  it("captures the catalog an attached work location never managed to report", async () => {
    const environmentId = harnessEnvironmentId;
    const { catalogs, inspectHarnesses, recorded, revisions } = convergence({ stored: null });

    await reconcileHarnessCatalogs({
      catalogs,
      connectedEnvironmentIds: [environmentId],
      runners: { inspectHarnesses },
      signal: AbortSignal.timeout(1_000),
    });

    expect(inspectHarnesses).toHaveBeenCalledTimes(1);
    expect(inspectHarnesses.mock.calls[0]?.[0]).toBe(environmentId);
    expect(recorded).toEqual([[readyCatalog()]]);
    expect(revisions).toEqual([new Map([[harnessInstanceId, harness.runtimeRevision]])]);
  });

  it("re-inspects a stored error, because that is the answer looking again can change", async () => {
    const { catalogs, inspectHarnesses } = convergence({ stored: errorCatalog() });

    await reconcileHarnessCatalogs({
      catalogs,
      connectedEnvironmentIds: [harnessEnvironmentId],
      runners: { inspectHarnesses },
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
        runners: { inspectHarnesses },
        signal: AbortSignal.timeout(1_000),
      });
      expect(inspectHarnesses).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
    },
  );

  it("converges a preparing catalog to the Runner's completed result", async () => {
    const { catalogs, inspectHarnesses, recorded } = convergence({
      stored: { ...errorCatalog(), status: "preparing", detail: "Preparing Codex…" },
    });
    await reconcileHarnessCatalogs({
      catalogs,
      connectedEnvironmentIds: [harnessEnvironmentId],
      runners: { inspectHarnesses },
      signal: AbortSignal.timeout(1_000),
    });
    expect(inspectHarnesses).toHaveBeenCalledTimes(1);
    expect(recorded).toEqual([[readyCatalog()]]);
  });

  it("does not re-inspect a fresh ready catalog", async () => {
    const { catalogs, inspectHarnesses } = convergence({ stored: readyCatalog() });

    await reconcileHarnessCatalogs({
      catalogs,
      connectedEnvironmentIds: [harnessEnvironmentId],
      runners: { inspectHarnesses },
      signal: AbortSignal.timeout(1_000),
    });

    expect(inspectHarnesses).not.toHaveBeenCalled();
  });

  it("ignores an AI engine that is turned off", async () => {
    const { catalogs, inspectHarnesses } = convergence({
      harnesses: [{ ...harness, enabled: false }],
      stored: null,
    });

    await reconcileHarnessCatalogs({
      catalogs,
      connectedEnvironmentIds: [harnessEnvironmentId],
      runners: { inspectHarnesses },
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
        runners: { inspectHarnesses },
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
      runners: { inspectHarnesses },
      signal: AbortSignal.timeout(1_000),
    });
    expect(inspectHarnesses).not.toHaveBeenCalled();
  });

  it("refreshes other computers even if one inspection fails", async () => {
    const other = createId("environment");
    const { catalogs, inspectHarnesses } = convergence({
      harnesses: [harness, { ...harness, environmentId: other, id: createId("harnessInstance") }],
    });
    inspectHarnesses.mockImplementation(async (environmentId) => {
      if (environmentId === harnessEnvironmentId) throw new Error("Computer disconnected");
      return [];
    });
    await expect(
      reconcileHarnessCatalogs({
        catalogs,
        connectedEnvironmentIds: [harnessEnvironmentId, other],
        runners: { inspectHarnesses },
        signal: AbortSignal.timeout(1_000),
      }),
    ).rejects.toThrow("AI model catalog refresh failed");
    expect(inspectHarnesses).toHaveBeenCalledTimes(2);
  });
});

describe("mutation-owned harness catalog reconciliation", () => {
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
      runners: { isAvailable: () => true, reconcileHarnesses },
    });

    owner.schedule(harnessEnvironmentId);
    await vi.waitFor(() => expect(reconcileHarnesses).toHaveBeenCalledTimes(1));
    current = [{ ...harness, enabled: false }];
    owner.schedule(harnessEnvironmentId);
    owner.schedule(harnessEnvironmentId);
    first.resolve([readyCatalog()]);
    await vi.waitFor(() => expect(reconcileHarnesses).toHaveBeenCalledTimes(2));

    expect(reconcileHarnesses.mock.calls.map(([, desired]) => desired)).toEqual([
      [expect.objectContaining({ id: harnessInstanceId })],
      [],
    ]);
    expect(recordHarnessCatalogs).toHaveBeenCalledTimes(1);
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
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
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
      runners: { isAvailable: () => true, reconcileHarnesses },
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
      runners: { isAvailable: () => true, reconcileHarnesses },
    });

    owner.schedule(harnessEnvironmentId);
    await vi.waitFor(() => expect(listHarnessInstances).toHaveBeenCalledTimes(1));
    const closing = owner.close();
    inventory.resolve([harness]);
    await closing;

    expect(reconcileHarnesses).not.toHaveBeenCalled();
  });
});

function runEvent(
  environmentId: EnvironmentId,
  outcome: { readonly data: object; readonly type: "run.completed" | "run.failed" },
): AgentEvent {
  return AgentEventSchema.parse({
    createdAt: "2026-09-05T00:00:00.000Z",
    data: {
      ...outcome.data,
      startedAt: "2026-08-09T09:00:00.000Z",
      personWaiting: true,
      startedBy: {
        displayName: "Alex",
        kind: "human",
        userId: createId("user"),
        principalId: "test-principal",
      },
    },
    environmentId,
    eventId: createId("event"),
    runId: createId("run"),
    sequence: "1",
    threadId: createId("thread"),
    type: outcome.type,
    workspaceId: createId("workspace"),
  });
}

function runFailure(environmentId: EnvironmentId, code: string): AgentEvent {
  return runEvent(environmentId, {
    data: { code, message: "You've hit your usage limit.", retryable: false, status: "failed" },
    type: "run.failed",
  });
}

describe("harness catalog re-inspection after a usage limit", () => {
  it("re-reads the failing work location, because the Run just proved the stored answer wrong", async () => {
    const { catalogs, inspectHarnesses, recorded } = convergence({ stored: readyCatalog() });

    await inspectHarnessCatalogsAfterUsageLimit({
      catalogs,
      event: runFailure(harnessEnvironmentId, harnessUsageLimitFailureCode),
      runners: { inspectHarnesses },
      signal: AbortSignal.timeout(1_000),
    });

    expect(inspectHarnesses).toHaveBeenCalledTimes(1);
    expect(inspectHarnesses.mock.calls[0]?.[0]).toBe(harnessEnvironmentId);
    expect(inspectHarnesses.mock.calls[0]?.[1].map(({ id }) => id)).toEqual([harnessInstanceId]);
    expect(recorded).toEqual([[readyCatalog()]]);
  });

  it("leaves every other failure alone", async () => {
    const { catalogs, inspectHarnesses } = convergence({ stored: readyCatalog() });

    for (const event of [
      runFailure(harnessEnvironmentId, "codex_harness_error"),
      runEvent(harnessEnvironmentId, {
        data: { replyMessageId: null, status: "completed" },
        type: "run.completed",
      }),
    ]) {
      await inspectHarnessCatalogsAfterUsageLimit({
        catalogs,
        event,
        runners: { inspectHarnesses },
        signal: AbortSignal.timeout(1_000),
      });
    }

    expect(inspectHarnesses).not.toHaveBeenCalled();
  });
});

import { createId, ModelSelectionSchema, type ResolvedBackgroundCandidate } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import { describe, expect, it, vi } from "vitest";
import { ThreadNaming, namingCandidates } from "./thread-naming.js";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), snapshot: vi.fn(), refresh: vi.fn() }));
vi.mock("./background-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./background-models.js")>()),
  resolveBackgroundCandidates: mocks.resolve,
}));
vi.mock("./background-model-settings.js", () => ({
  readBackgroundResolutionInput: mocks.snapshot,
}));
vi.mock("./harness-catalogs.js", () => ({
  harnessInspectionDefinition: (value: unknown) => value,
  inspectAndRecordInvalidatedHarnessCatalog: mocks.refresh,
}));

function candidate(
  modelId: string,
  reason: ResolvedBackgroundCandidate["reason"] = "ranked",
): ResolvedBackgroundCandidate {
  return {
    environmentId: createId("environment"),
    harnessInstanceId: createId("harnessInstance"),
    harnessRevision: 1,
    modelSelection: ModelSelectionSchema.parse({ providerId: "openai", modelId, options: {} }),
    reason,
  };
}
function fixture() {
  vi.clearAllMocks();
  const fallback = candidate("task", "task-model");
  const ranked = [candidate("a"), candidate("b"), candidate("c"), candidate("d")];
  const threadId = createId("thread");
  const input = {
    ...fallback,
    threadId,
    sourceMessageId: createId("message"),
    principalId: "principal",
    requestedBy: createId("user"),
    membershipGeneration: 1,
    request: "Review the report",
    icon: true,
  };
  const identity = {};
  const store = {
    getThreadNamingInput: vi.fn(async () => input),
    getHarnessInstance: vi.fn(async () => ({ enabled: true, removedAt: null, runtimeRevision: 1 })),
    environmentIsAvailableToUser: vi.fn(async () => true),
    applyGeneratedThreadName: vi.fn(async () => ({ events: [] })),
    listThreadNamingCandidates: vi.fn(async () => [{ id: threadId }]),
  };
  const runners = {
    identityForEnvironment: vi.fn(() => identity),
    backgroundText: vi.fn(async () => ({ ok: true, text: "Report review\nplane" })),
  };
  mocks.snapshot.mockResolvedValue({ accounts: [{ ...fallback }], preferences: {} });
  mocks.resolve.mockReturnValue([...ranked, fallback]);
  mocks.refresh.mockResolvedValue([]);
  const naming = new ThreadNaming({
    store: store as unknown as OpensteerStore,
    runners: runners as unknown as RunnerRegistry,
    publish: vi.fn(),
    onError: vi.fn(),
  });
  return { naming, store, runners, input, fallback, ranked, threadId };
}

describe("Host naming jobs", () => {
  it("caps ranking at three and retains a deduplicated final task model", () => {
    const f = fixture();
    expect(namingCandidates([...f.ranked, f.fallback], f.fallback)).toEqual([
      ...f.ranked.slice(0, 3),
      f.fallback,
    ]);
    expect(namingCandidates([f.fallback, ...f.ranked], f.fallback)).toHaveLength(4);
    expect(
      namingCandidates([{ ...f.fallback, reason: "ranked" }, ...f.ranked], f.fallback),
    ).toHaveLength(3);
  });
  it("shares one pending job and refreshes the catalog on typed failure before advancing", async () => {
    const f = fixture();
    f.runners.backgroundText.mockResolvedValueOnce({ ok: false, failure: "signed-out" } as never);
    const pending = f.naming.request(f.threadId);
    expect(f.naming.request(f.threadId)).toBe(pending);
    await pending;
    expect(f.runners.backgroundText).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(f.store.applyGeneratedThreadName).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Report review",
        icon: "plane",
        namingAuthority: expect.objectContaining({
          sourceMessageId: f.input.sourceMessageId,
          principalId: f.input.principalId,
        }),
      }),
    );
    await f.naming.stop();
  });
  it("tries only three ranked models and the task fallback on repeated typed failures", async () => {
    const f = fixture();
    // Resolution states the task model as its catalog runs it, defaults included.
    mocks.resolve.mockReturnValue([
      ...f.ranked,
      {
        ...f.fallback,
        modelSelection: { ...f.fallback.modelSelection, options: { effort: "low" } },
      },
    ]);
    f.runners.backgroundText.mockResolvedValue({ ok: false, failure: "usage-limit" } as never);
    await f.naming.request(f.threadId);
    expect(
      f.runners.backgroundText.mock.calls.map(
        (call) =>
          (call as unknown as [{ modelSelection: { modelId: string } }])[0].modelSelection.modelId,
      ),
    ).toEqual(["a", "b", "c", "task"]);
    expect(mocks.refresh).toHaveBeenCalledTimes(4);
    expect(f.store.applyGeneratedThreadName).not.toHaveBeenCalled();
    await f.naming.stop();
  });
  it("does not send for ineligible input or apply after a connection changes", async () => {
    const f = fixture();
    f.store.getThreadNamingInput.mockResolvedValueOnce(null as never);
    await f.naming.request(f.threadId);
    expect(f.runners.backgroundText).not.toHaveBeenCalled();
    f.runners.backgroundText.mockImplementationOnce(async () => {
      f.runners.identityForEnvironment.mockReturnValue({});
      return { ok: true, text: "Stale" };
    });
    await f.naming.request(f.threadId);
    expect(f.store.applyGeneratedThreadName).not.toHaveBeenCalled();
    await f.naming.stop();
  });
  it("reconciles provisional work after a fresh Host instance and bounds the query", async () => {
    const f = fixture();
    await f.naming.reconcile();
    expect(f.store.listThreadNamingCandidates).toHaveBeenCalledWith(100);
    expect(f.runners.backgroundText).toHaveBeenCalledOnce();
    await f.naming.stop();
  });
});

import {
  createId,
  emptyAutomaticModelConfig,
  ModelSelectionSchema,
  type HarnessInstanceId,
  type ResolvedModelCandidate,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import { describe, expect, it, vi } from "vitest";
import { ThreadNaming, namingCandidates } from "./thread-naming.js";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), refresh: vi.fn() }));
vi.mock("./automatic-models.js", () => ({
  backgroundTextSupport: () => () => ({ ok: true }),
  resolveAutomaticModels: async () => ({ candidates: mocks.resolve() }),
}));
vi.mock("./harness-catalogs.js", () => ({
  harnessInspectionDefinition: (value: unknown) => value,
  inspectAndRecordInvalidatedHarnessCatalog: mocks.refresh,
}));

function candidate(modelId: string, original = false): ResolvedModelCandidate {
  const modelSelection = ModelSelectionSchema.parse({ providerId: "openai", modelId, options: {} });
  return {
    environmentId: createId("environment"),
    harnessInstanceId: createId("harnessInstance"),
    harnessRevision: 1,
    account: {} as ResolvedModelCandidate["account"],
    storedModelSelection: modelSelection,
    runModelSelection: modelSelection,
    usageLimited: false,
    original,
  };
}
function fixture() {
  vi.clearAllMocks();
  const fallback = candidate("task", true);
  const ranked = [candidate("a"), candidate("b"), candidate("c"), candidate("d")];
  const threadId = createId("thread");
  const input = {
    environmentId: fallback.environmentId,
    harnessInstanceId: fallback.harnessInstanceId,
    modelSelection: fallback.storedModelSelection,
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
    getAutomaticModelConfig: vi.fn(async () => structuredClone(emptyAutomaticModelConfig)),
    environmentIsAvailableToUser: vi.fn(async () => true),
    applyGeneratedThreadName: vi.fn(async () => ({ events: [] })),
    listThreadNamingCandidates: vi.fn(async () => [{ id: threadId }]),
  };
  const runners = {
    identityForEnvironment: vi.fn(() => identity),
    backgroundText: vi.fn(async () => ({ ok: true, text: "Report review\nplane" })),
  };
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
const sentModels = (runners: ReturnType<typeof fixture>["runners"]) =>
  runners.backgroundText.mock.calls.map(
    (call) =>
      (call as unknown as [{ modelSelection: { modelId: string } }])[0].modelSelection.modelId,
  );

describe("Host naming jobs", () => {
  it("caps automatic attempts at three and keeps the task's own model last", () => {
    const f = fixture();
    expect(namingCandidates([...f.ranked, f.fallback])).toEqual([
      ...f.ranked.slice(0, 3),
      f.fallback,
    ]);
    expect(namingCandidates(f.ranked)).toEqual(f.ranked.slice(0, 3));
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
  it("tries only three automatic models and the task's own on repeated typed failures", async () => {
    const f = fixture();
    f.runners.backgroundText.mockResolvedValue({ ok: false, failure: "usage-limit" } as never);
    await f.naming.request(f.threadId);
    expect(sentModels(f.runners)).toEqual(["a", "b", "c", "task"]);
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
    expect(f.store.listThreadNamingCandidates).toHaveBeenCalledWith(100, undefined);
    expect(f.runners.backgroundText).toHaveBeenCalledOnce();
    await f.naming.stop();
  });
});

it.each(["timeout", "failed", "no result"])("does not refresh catalogs on %s", async (failure) => {
  const f = fixture();
  if (failure === "no result")
    f.runners.backgroundText.mockRejectedValueOnce(new Error("connection dropped"));
  else f.runners.backgroundText.mockResolvedValueOnce({ ok: false, failure } as never);
  await f.naming.request(f.threadId);
  expect(mocks.refresh).not.toHaveBeenCalled();
  // A failed attempt moves to the next candidate, which names the task.
  expect(f.runners.backgroundText).toHaveBeenCalledTimes(2);
  expect(f.store.applyGeneratedThreadName).toHaveBeenCalledOnce();
  await f.naming.stop();
});
it("sends one Runner two attempts at a time, each deadline starting when sent", async () => {
  const f = fixture();
  let active = 0;
  let peak = 0;
  const budgets: number[] = [];
  const releases: (() => void)[] = [];
  f.runners.backgroundText.mockImplementation((async (request: { deadline: string }) => {
    budgets.push(Date.parse(request.deadline) - Date.now());
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return { ok: true, text: "Named" };
  }) as never);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const jobs = Array.from({ length: 4 }, () => f.naming.request(createId("thread")));
    await vi.waitFor(() => expect(releases).toHaveLength(2), { timeout: 2_000 });
    // The queued attempts wait most of a minute; their deadlines have not started.
    vi.advanceTimersByTime(50_000);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(2), { timeout: 2_000 });
    releases.splice(0).forEach((release) => release());
    await Promise.all(jobs);
  } finally {
    vi.useRealTimers();
  }
  expect(peak).toBe(2);
  expect(budgets.every((budget) => budget >= 60_000)).toBe(true);
  // Waiting for a slot never spends a candidate or refreshes a catalog.
  expect(f.runners.backgroundText).toHaveBeenCalledTimes(4);
  expect(f.store.applyGeneratedThreadName).toHaveBeenCalledTimes(4);
  expect(mocks.refresh).not.toHaveBeenCalled();
  await f.naming.stop();
});
it("logs an unnamed job's thread, candidate count and failure kinds, never its content", async () => {
  const f = fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    f.runners.backgroundText
      .mockResolvedValueOnce({ ok: false, failure: "refused" } as never)
      .mockResolvedValueOnce({ ok: false, failure: "timeout" } as never)
      .mockRejectedValueOnce(new Error("connection dropped"))
      .mockResolvedValueOnce({ ok: false, failure: "usage-limit" } as never);
    await f.naming.request(f.threadId);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("Thread naming found no name", {
      threadId: f.threadId,
      candidates: 4,
      failures: ["refused", "timeout", "no-result", "usage-limit"],
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(f.input.request);
    mocks.resolve.mockReturnValue([]);
    await f.naming.request(f.threadId);
    expect(warn).toHaveBeenLastCalledWith("Thread naming found no name", {
      threadId: f.threadId,
      candidates: 0,
      failures: [],
    });
  } finally {
    warn.mockRestore();
  }
  await f.naming.stop();
});
it("advances recovery past 100 rows including unnameable tasks", async () => {
  const f = fixture();
  const rows = Array.from({ length: 103 }, () => ({ id: createId("thread") })).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  f.store.listThreadNamingCandidates
    .mockResolvedValueOnce(rows.slice(0, 100))
    .mockResolvedValueOnce(rows.slice(100));
  f.store.getThreadNamingInput.mockResolvedValue(null as never);
  await f.naming.reconcile();
  expect(f.store.getThreadNamingInput).toHaveBeenCalledTimes(103);
  expect(f.store.listThreadNamingCandidates).toHaveBeenLastCalledWith(100, rows[99]!.id);
  await f.naming.stop();
});

it.each(["refused", "unavailable"])(
  "refreshes potentially stale catalogs after %s",
  async (failure) => {
    const f = fixture();
    f.runners.backgroundText.mockResolvedValueOnce({ ok: false, failure } as never);
    await f.naming.request(f.threadId);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    await f.naming.stop();
  },
);

it.each(["excluded", "revoked"])(
  "re-checks an account %s while its attempt waited for a Runner slot",
  async (change) => {
    const f = fixture();
    const shared = f.ranked[0]!.environmentId;
    const first = { ...f.ranked[0]!, environmentId: shared };
    mocks.resolve.mockReturnValue([first, f.ranked[1]!, f.fallback]);
    const releases: (() => void)[] = [];
    f.runners.backgroundText.mockImplementation((async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { ok: true, text: "Named" };
    }) as never);
    const held = [f.naming.request(createId("thread")), f.naming.request(createId("thread"))];
    await vi.waitFor(
      () => expect(releases, "two attempts never filled the Runner's slots").toHaveLength(2),
      {
        timeout: 2_000,
      },
    );
    const queued = f.naming.request(f.threadId);
    // Resolved and queued behind the held attempts before anything changes.
    await vi.waitFor(
      () =>
        expect(mocks.resolve, "the queued job never resolved its candidates").toHaveBeenCalledTimes(
          3,
        ),
      {
        timeout: 2_000,
      },
    );
    if (change === "excluded")
      f.store.getAutomaticModelConfig.mockResolvedValue({
        roles: {},
        excludedAccounts: [first.harnessInstanceId as HarnessInstanceId],
      });
    else f.store.environmentIsAvailableToUser.mockResolvedValue(false as never);
    releases.splice(0).forEach((release) => release());
    await Promise.all(held);
    if (change === "revoked") {
      // Every account was revoked, so nothing more is sent at all.
      await queued;
      expect(sentModels(f.runners)).toEqual(["a", "a"]);
    } else {
      await vi.waitFor(
        () => expect(releases, "the next candidate was never sent").toHaveLength(1),
        {
          timeout: 2_000,
        },
      );
      releases.splice(0).forEach((release) => release());
      await queued;
      // The excluded account was skipped once a slot was free; the next one was asked.
      expect(sentModels(f.runners)).toEqual(["a", "a", "b"]);
    }
    await f.naming.stop();
  },
);

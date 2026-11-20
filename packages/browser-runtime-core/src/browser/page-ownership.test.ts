import { afterEach, expect, it, vi } from "vitest";
import { BrowserRuntime } from "../runtime.js";
import {
  FakeContext,
  FakeLaunchedBrowser,
  FakeLauncher,
  FakePage,
  FakeSink,
  FakeTicketVerifier,
  freshClaims,
  testSessionFilesRoot,
} from "../test-support/fakes.js";
import { PageOwnership, type BrowserPageDiagnostic } from "./page-ownership.js";
import { SurfaceLedger } from "./surface-ledger.js";
import { TabSleeper } from "./tab-sleeper.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function registry() {
  const diagnostics: BrowserPageDiagnostic[] = [];
  const owner = new PageOwnership({ onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
  /** Lines of one event whose fields equal `match`. */
  const events = (event: BrowserPageDiagnostic["event"], match: Record<string, unknown> = {}) =>
    diagnostics.filter(
      (diagnostic) =>
        diagnostic.event === event &&
        Object.entries(match).every(
          ([key, value]) => (diagnostic as Record<string, unknown>)[key] === value,
        ),
    );
  return { diagnostics, events, owner };
}

async function harness(pages: FakePage[]) {
  vi.useFakeTimers();
  const r = registry();
  const context = new FakeContext(pages);
  const ledger = new SurfaceLedger(context, { pages: r.owner });
  await ledger.start();
  await vi.advanceTimersByTimeAsync(0);
  const idOf = async (page: FakePage) => ledger.surfaceIdForTarget(await page.targetId())!;
  return { ...r, context, idOf, ledger };
}

/** A page whose close the test answers, or never does. */
function closeGate(page: FakePage) {
  const answer = Promise.withResolvers<void>();
  const close = vi.spyOn(page, "close").mockImplementation(() => answer.promise);
  return { answer, close };
}

/** A failed wake: its page refuses initialization once, then its close is the test's. */
function refusingPage() {
  const page = new FakePage();
  page.cdpSession.responses.set("Page.enable", () => {
    page.cdpSession.responses.delete("Page.enable");
    throw new Error("initialization refused");
  });
  return page;
}

it.each(["resolves with no event", "hangs until the event", "rejects after the event"] as const)(
  "answers a tab close from the engine's confirmation when the close call %s",
  async (close) => {
    const page = new FakePage({ url: "https://closing.test/" });
    const sibling = new FakePage({ url: "https://sibling.test/" });
    const f = await harness([page, sibling]);
    const id = await f.idOf(page);
    const siblingId = await f.idOf(sibling);
    const gate = closeGate(page);
    try {
      const closing = f.ledger.closeSurface(id, "person-closed");
      let outcome: string | undefined;
      void closing.then(
        () => (outcome = "closed"),
        (error: { reason?: string }) => (outcome = error.reason),
      );
      await expect(f.ledger.use(siblingId, async () => "acted")).resolves.toBe("acted");
      if (close === "resolves with no event") {
        gate.answer.resolve();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(outcome, "A settled call proves nothing").toBe("tab-still-closing");
        expect(f.ledger.stateOf(id), "The tab stays listed until its page is gone").toBe("live");
        expect(f.ledger.binding(id), "No route reaches a page whose close started").toBeNull();
        await expect(f.ledger.use(id, async () => "acted")).rejects.toMatchObject({
          code: "not_found",
        });
        page.crash();
        await vi.advanceTimersByTimeAsync(0);
      } else {
        await vi.advanceTimersByTimeAsync(500);
        page.crash();
        if (close === "rejects after the event") gate.answer.reject(new Error("late refusal"));
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome, "Confirmation is success, whatever the call does").toBe("closed");
      }
      expect(f.ledger.stateOf(id)).toBeUndefined();
      expect(f.ledger.stateOf(siblingId)).toBe("live");
      expect(f.events("browser.page.ended", { surface: id })).toEqual([
        expect.objectContaining({
          reason: "person-closed",
          surface: id,
          confirmedBy: "page-event",
          rendererGone: null,
        }),
      ]);
    } finally {
      gate.answer.resolve();
      await f.ledger.close();
    }
  },
);

it("closes a tab whose sleep request is still closing, and its late end lists no dead tab", async () => {
  const page = new FakePage({ url: "https://sleep.test/" });
  const f = await harness([page, new FakePage()]);
  const id = await f.idOf(page);
  const gate = closeGate(page);
  try {
    expect(await f.ledger.sleep(id, () => null)).toBe(true);
    expect(f.ledger.stateOf(id)).toBe("suspended");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.events("browser.page.closing.hung", { surface: id })).toHaveLength(1);
    await f.ledger.closeSurface(id, "person-closed");
    expect(f.ledger.stateOf(id)).toBeUndefined();
    expect(gate.close, "Close asks a hung sleeping page again").toHaveBeenCalledTimes(2);
    page.crash();
    expect(f.ledger.snapshot().map((surface) => surface.id)).not.toContain(id);
    expect(f.events("browser.page.ended", { surface: id })).toMatchObject([{ reason: "slept" }]);
  } finally {
    gate.answer.resolve();
    await f.ledger.close();
  }
});

it.each(["hangs", "keeps refusing"] as const)(
  "keeps a tab whose failed wake's close %s recoverable by a later wake or close",
  async (close) => {
    const page = new FakePage({ url: "https://wake.test/" });
    const f = await harness([page]);
    const id = await f.idOf(page);
    expect(await f.ledger.sleep(id, () => null)).toBe(true);
    const failed = refusingPage();
    const asked = vi
      .spyOn(failed, "close")
      .mockImplementation(() =>
        close === "hangs" ? new Promise(() => {}) : Promise.reject(new Error("close refused")),
      );
    const create = vi.spyOn(f.context, "createPage").mockImplementationOnce(async () => failed);
    try {
      await expect(f.ledger.wake(id)).rejects.toMatchObject({ code: "conflict", retryable: true });
      // Inside the Host's 15-second request budget, the answer is a retryable pending one.
      const again = f.ledger.wake(id);
      const pending = expect(again).rejects.toMatchObject({ reason: "tab-still-closing" });
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
      expect(create, "No replacement while the failed page may live").toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const automatic = asked.mock.calls.length;
      expect(
        f.events(
          close === "hangs" ? "browser.page.closing.hung" : "browser.page.closing.exhausted",
        ),
      ).not.toEqual([]);
      const third = f.ledger.wake(id);
      const refused = expect(third).rejects.toMatchObject({ reason: "tab-still-closing" });
      await vi.advanceTimersByTimeAsync(2_000);
      await refused;
      expect(asked.mock.calls.length, "A later wake drives cleanup again").toBeGreaterThan(
        automatic,
      );
      await f.ledger.closeSurface(id, "person-closed");
      expect(f.ledger.stateOf(id)).toBeUndefined();
      failed.crash();
      expect(f.events("browser.page.ended", { reason: "wake-failed" })).toHaveLength(1);
    } finally {
      await f.ledger.close();
    }
  },
);

it("finds a sibling target at once past a closing page and a page whose target never answers", async () => {
  vi.useFakeTimers();
  const r = registry();
  const root = new FakePage();
  const closing = new FakePage();
  const silent = new FakePage();
  const sibling = new FakePage();
  const context = new FakeContext([root, closing]);
  const ledger = new SurfaceLedger(context, { pages: r.owner, rootPages: [root], sessionId: "a" });
  await ledger.start();
  vi.spyOn(closing, "close").mockReturnValue(new Promise(() => {}));
  const closingTarget = vi.spyOn(closing, "targetId").mockReturnValue(new Promise(() => {}));
  vi.spyOn(silent, "targetId").mockReturnValue(new Promise(() => {}));
  r.owner.destroy(closing, "agent-closed");
  context.handOffPage(silent);
  context.handOffPage(sibling);
  try {
    await expect(ledger.adoptTarget(await sibling.targetId())).resolves.toBe(true);
    expect(closingTarget, "A closing page is never asked").not.toHaveBeenCalled();
    expect(r.owner.sessionOf(sibling)).toBe("a");
  } finally {
    await ledger.close();
  }
});

it("ends a page still registering when its session ends, while another session keeps the profile", async () => {
  vi.useFakeTimers();
  const r = registry();
  const rootA = new FakePage();
  const rootB = new FakePage();
  const context = new FakeContext([rootA, rootB]);
  const a = new SurfaceLedger(context, { pages: r.owner, rootPages: [rootA], sessionId: "a" });
  const b = new SurfaceLedger(context, { pages: r.owner, rootPages: [rootB], sessionId: "b" });
  await a.start();
  await b.start();
  const popup = new FakePage({ opener: rootA });
  vi.spyOn(popup, "cdp").mockReturnValue(new Promise(() => {}));
  context.addPage(popup);
  await vi.advanceTimersByTimeAsync(0);
  expect(r.owner.sessionOf(popup)).toBe("a");
  try {
    await a.closeOwnedPages("session-ended");
    const closing = a.close();
    await vi.advanceTimersByTimeAsync(2_000);
    await closing;
    expect(popup.isClosed()).toBe(true);
    expect(r.events("browser.page.ended", { surface: null })).toMatchObject([
      { reason: "session-ended" },
    ]);
    expect(rootB.isClosed()).toBe(false);
    expect(b.snapshot()).toHaveLength(1);
  } finally {
    await b.close();
  }
});

it("ends a popup whose opener's session ended before the popup was discovered", async () => {
  vi.useFakeTimers();
  const r = registry();
  const rootA = new FakePage();
  const rootB = new FakePage();
  const context = new FakeContext([rootA, rootB]);
  const a = new SurfaceLedger(context, { pages: r.owner, rootPages: [rootA], sessionId: "a" });
  const b = new SurfaceLedger(context, { pages: r.owner, rootPages: [rootB], sessionId: "b" });
  await a.start();
  await b.start();
  await a.closeOwnedPages("session-ended");
  await a.close();
  const popup = new FakePage({ opener: rootA });
  context.handOffPage(popup);
  try {
    expect(popup.isClosed(), "No session would ever own it").toBe(true);
    expect(r.events("browser.page.ended", { surface: null })).toMatchObject([
      { reason: "session-ended" },
    ]);
  } finally {
    await b.close();
  }
});

it("never ends a page for its age, only a creation its owner abandoned", async () => {
  vi.useFakeTimers();
  const r = registry();
  const context = new FakeContext([]);
  r.owner.adopt(context);
  // Opened by a person in a visible browser: no creator, no opener, no adoption.
  const personTab = new FakePage();
  context.handOffPage(personTab);
  // A session's own page whose admission is simply slow.
  const slow = new FakePage();
  await r.owner.create("a", null, "open-failed", async (own) => {
    own(slow);
    return slow;
  }).page;
  const late = Promise.withResolvers<FakePage>();
  const abandoned = r.owner.create("a", null, "open-failed", () => late.promise);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  expect(personTab.isClosed()).toBe(false);
  expect(slow.isClosed()).toBe(false);
  expect(r.events("browser.page.unadopted")).toMatchObject([
    { attributed: false, ageMs: 30_000 },
    { attributed: true, ageMs: 30_000 },
  ]);
  abandoned.abandon();
  const arrived = new FakePage();
  late.resolve(arrived);
  await abandoned.page;
  expect(arrived.isClosed(), "The creator gave it up, so it is ended").toBe(true);
  expect(r.events("browser.page.ended")).toMatchObject([{ reason: "open-failed" }]);
});

it.each(["crashed", "exited"] as const)(
  "keeps a page whose renderer %s, and ends it only on confirmation",
  async (cause) => {
    const page = new FakePage();
    const f = await harness([page, new FakePage()]);
    const id = await f.idOf(page);
    const incarnation = f.ledger.binding(id)!.incarnation;
    try {
      page.crashRenderer(cause);
      expect(f.ledger.binding(id)?.page).toBe(page);
      expect(f.events("browser.page.renderer.gone")).toEqual([
        {
          event: "browser.page.renderer.gone",
          page: incarnation,
          surface: id,
          state: "live",
          cause,
        },
      ]);
      page.crash();
      expect(f.events("browser.page.ended", { page: incarnation })).toMatchObject([
        { reason: "native-gone", rendererGone: cause },
      ]);
    } finally {
      await f.ledger.close();
    }
  },
);

it("finishes shutdown with a page still closing, reporting it and still asking the engine", async () => {
  const page = new FakePage();
  const close = vi.spyOn(page, "close").mockReturnValue(new Promise(() => {}));
  const browser = new FakeLaunchedBrowser(new FakeContext([page]));
  const diagnostics: BrowserPageDiagnostic[] = [];
  const runtime = new BrowserRuntime({
    launcher: new FakeLauncher(browser),
    onPageDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    runtimeId: "runtime_test",
    sessionFilesRoot: testSessionFilesRoot(),
    ticketVerifier: new FakeTicketVerifier(freshClaims()),
  });
  const attachment = await runtime.attach("fresh-ticket", new FakeSink());
  vi.useFakeTimers();
  const detaching = attachment.close();
  await vi.advanceTimersByTimeAsync(10_000);
  await detaching;
  expect(runtime.health().profileHostCount).toBe(0);
  const stopping = runtime.shutdown();
  await vi.advanceTimersByTimeAsync(1_000);
  // Resolving lets the engine's own teardown run after it and a supervisor restart.
  await expect(stopping).resolves.toBeUndefined();
  expect(runtime.health().state).toBe("closed");
  expect(diagnostics.filter((line) => line.event === "browser.page.shutdown.incomplete")).toEqual([
    {
      event: "browser.page.shutdown.incomplete",
      states: { provisional: 0, live: 0, closing: 1 },
    },
  ]);
  const asked = close.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(close.mock.calls.length, "Recovery stays on after shutdown").toBeGreaterThan(asked);
  page.crash();
  expect(runtime.pages.counts().states).toEqual({ provisional: 0, live: 0, closing: 0 });
});

it("keeps a fresh browser process until its slept page is confirmed gone", async () => {
  const page = new FakePage({ url: "https://leftover.test/" });
  const f = await harness([page]);
  const gate = closeGate(page);
  const record = [...f.ledger.policyRecords()][0]!;
  record.origin = "agent";
  record.personUsed = false;
  const retireHost = vi.fn(async () => undefined);
  const sleeper = new TabSleeper({
    hostCost: "process",
    memoryBudgetBytes: 1,
    memory: () => ({ total: 100, available: 1 }),
    hosts: () => [
      { key: "fresh", kind: "fresh", lastUsed: 0, sessionIds: ["session"], blocked: false },
    ],
    retireHost,
  });
  sleeper.add("session", { ledger: f.ledger, restoreVersion: 1, blocked: () => null });
  try {
    sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [] });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(f.ledger.stateOf(record.id)).toBe("suspended");
    expect(retireHost, "A closing page still holds its process").not.toHaveBeenCalled();
    page.crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(retireHost).toHaveBeenCalledWith("fresh");
  } finally {
    gate.answer.resolve();
    sleeper.close();
    await f.ledger.close();
  }
});

it("ends a page handed off while shutdown waits, instead of stranding it", async () => {
  vi.useFakeTimers();
  const r = registry();
  const context = new FakeContext([]);
  r.owner.adopt(context);
  const stuck = new FakePage();
  vi.spyOn(stuck, "close").mockReturnValue(new Promise(() => {}));
  context.handOffPage(stuck);
  const draining = r.owner.shutdown(1_000);
  const late = new FakePage();
  context.handOffPage(late);
  expect(late.isClosed()).toBe(true);
  expect(r.events("browser.page.ended")).toMatchObject([{ reason: "runtime-shutdown" }]);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(draining).resolves.toBe(false);
});

it("logs each sleep blocker and refusal once per transition, again after it clears, with nothing from the page", async () => {
  const page = new FakePage({
    url: "https://bank.test/account?token=hunter2",
    title: "Balance: 1,234",
  });
  const f = await harness([page]);
  const id = await f.idOf(page);
  const record = [...f.ledger.policyRecords()][0]!;
  record.origin = "agent";
  record.personUsed = false;
  page.keepAwake = () => "media";
  const passes: unknown[] = [];
  const sleeper = new TabSleeper({
    onPass: (pass) => passes.push(pass),
    pageCounts: () => f.owner.counts(),
  });
  sleeper.add("session", { ledger: f.ledger, restoreVersion: 1, blocked: () => null });
  const blocked = () => f.events("browser.page.sleep.blocked", { surface: id });
  const refused = () => f.events("browser.page.sleep.refused", { surface: id });
  try {
    sleeper.poke();
    expect(blocked(), "Missing Host facts are explained before any probe").toMatchObject([
      { reason: "host-state", surface: id },
    ]);
    expect(passes, "With nothing due, the state is still summarized").toMatchObject([
      { attempted: 0, livePages: 1, pages: { sleepBlocked: { "host-state": 1 } } },
    ]);
    sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [] });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refused()).toMatchObject([{ reason: "media", previous: null, previousAttempts: 0 }]);
    sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [id] });
    await vi.advanceTimersByTimeAsync(60_000);
    sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(blocked().map((line) => (line as { reason: string }).reason)).toEqual([
      "host-state",
      "pinned",
    ]);
    expect(refused(), "The same refusal after a blocker cleared is logged again").toHaveLength(2);
    expect(refused()[1]).toMatchObject({ reason: "media", previous: null });
    page.keepAwake = () => null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.ledger.stateOf(id)).toBe("suspended");
    expect(f.owner.counts()).toMatchObject({
      ended: { slept: 1 },
      sleepBlocked: { "host-state": 1, pinned: 1 },
    });
    expect(f.owner.counts().sleepRefused.media, "Every refused attempt counts").toBeGreaterThan(2);
    expect(passes.at(-1)).toMatchObject({ pages: { ended: { slept: 1 } } });
    expect(JSON.stringify(f.diagnostics)).not.toMatch(/bank|hunter2|Balance/);
  } finally {
    sleeper.close();
    await f.ledger.close();
  }
});

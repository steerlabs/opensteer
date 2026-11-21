import { afterEach, expect, it, vi } from "vitest";
import { BrowserRuntime } from "../runtime.js";
import {
  FakeContext,
  FakeIsolatingLauncher,
  FakeLaunchedBrowser,
  FakeLauncher,
  FakePage,
  FakeSink,
  FakeTicketVerifier,
  freshClaims,
  testSessionFilesRoot,
} from "../test-support/fakes.js";
import { BrowserRuntimeError } from "../errors.js";
import {
  PageOwnership,
  pageUnnameableReason,
  type BrowserPageDiagnostic,
} from "./page-ownership.js";
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
        await vi.advanceTimersByTimeAsync(9_999);
        expect(outcome, "A slow close waits for as long as its caller can").toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
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

it("keeps asking Chrome to close a durably closed tab after the ordinary retry cap", async () => {
  const page = new FakePage({ url: "https://closing.test/" });
  const f = await harness([page]);
  const id = await f.idOf(page);
  const nativeClose = page.close.bind(page);
  let permitClose = false;
  const close = vi.spyOn(page, "close").mockImplementation(async () => {
    if (!permitClose) throw new Error("Chromium refused the close");
    await nativeClose();
  });
  try {
    f.ledger.fenceDurableClose(id);
    expect(f.ledger.binding(id)).toBeNull();
    expect(close).not.toHaveBeenCalled();
    const pending = expect(f.ledger.closeDurableSurface(id)).rejects.toMatchObject({
      reason: "tab-still-closing",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(close.mock.calls.length).toBeGreaterThan(8);
    expect(page.isClosed()).toBe(false);
    permitClose = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(page.isClosed()).toBe(true);
    expect(f.ledger.stateOf(id)).toBeUndefined();
    await expect(f.ledger.closeDurableSurface(id)).resolves.toBeUndefined();
  } finally {
    permitClose = true;
    await f.ledger.close();
  }
});

it("answers a sleep once its page is confirmed gone, with the tab asleep from the request", async () => {
  const page = new FakePage({ url: "https://sleep.test/" });
  const f = await harness([page, new FakePage()]);
  const id = await f.idOf(page);
  const gate = closeGate(page);
  try {
    let answered = false;
    const sleeping = f.ledger
      .sleep(id, () => null)
      .then((slept) => {
        answered = true;
        return slept;
      });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.ledger.stateOf(id), "The tab sleeps at the destroy request").toBe("suspended");
    expect(answered, "The caller waits for the page itself").toBe(false);
    page.crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(await sleeping).toBe(true);
    expect(f.owner.counts().states.closing, "The page was gone when the sleep answered").toBe(0);
  } finally {
    gate.answer.resolve();
    await f.ledger.close();
  }
});

it("closes a tab whose sleep request is still closing, and its late end lists no dead tab", async () => {
  const page = new FakePage({ url: "https://sleep.test/" });
  const f = await harness([page, new FakePage()]);
  const id = await f.idOf(page);
  const gate = closeGate(page);
  try {
    const sleeping = f.ledger.sleep(id, () => null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await sleeping, "Past its bound a sleep answers with the page still closing").toBe(true);
    expect(f.ledger.stateOf(id)).toBe("suspended");
    await vi.advanceTimersByTimeAsync(8_000);
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

it("keeps every tab not explicitly closed when its browser dies, Guest and mid-sleep tabs included", async () => {
  vi.useFakeTimers();
  const r = registry();
  const root = new FakePage({ url: "https://profile.test/" });
  const live = new FakePage({ url: "https://live.test/" });
  const sleeping = new FakePage({ url: "https://sleeping.test/" });
  const closing = new FakePage({ url: "https://closing.test/" });
  const guestRoot = new FakePage({ url: "https://guest.test/" });
  const profile = new FakeContext([root, live, sleeping, closing]);
  const guest = new FakeContext([guestRoot]);
  const named = new SurfaceLedger(profile, { pages: r.owner, sessionId: "profile" });
  const guestLedger = new SurfaceLedger(guest, { pages: r.owner, sessionId: "guest" });
  await named.start();
  await guestLedger.start();
  await vi.advanceTimersByTimeAsync(0);
  const id = async (ledger: SurfaceLedger, page: FakePage) =>
    ledger.surfaceIdForTarget(await page.targetId())!;
  const [rootId, liveId, sleepingId, closingId, guestId] = [
    await id(named, root),
    await id(named, live),
    await id(named, sleeping),
    await id(named, closing),
    await id(guestLedger, guestRoot),
  ];
  vi.spyOn(sleeping, "close").mockReturnValue(new Promise(() => {}));
  vi.spyOn(closing, "close").mockReturnValue(new Promise(() => {}));
  try {
    const sleeping = named.sleep(sleepingId, () => null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await sleeping).toBe(true);
    void named.closeSurface(closingId, "person-closed").catch(() => undefined);
    // Chromium dies: every page reports its own end before its context does.
    profile.end();
    guest.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(named.snapshot().map((tab) => [tab.id, tab.state])).toEqual([
      [rootId, "suspended"],
      [liveId, "suspended"],
      [sleepingId, "suspended"],
    ]);
    expect(guestLedger.snapshot().map((tab) => [tab.id, tab.state])).toEqual([
      [guestId, "suspended"],
    ]);
    expect(named.binding(liveId), "No tab is left pointing at a dead page").toBeNull();
  } finally {
    const closingLedgers = Promise.all([named.close(), guestLedger.close()]);
    await vi.advanceTimersByTimeAsync(2_000);
    await closingLedgers;
  }
});

it("samples a held reclaim once, at its pages' confirmation or a cutoff, never in a loop", async () => {
  const page = new FakePage({ url: "https://leftover.test/" });
  const other = new FakePage({ url: "https://other.test/" });
  const f = await harness([page, other]);
  const gate = closeGate(page);
  const otherId = await f.idOf(other);
  for (const record of f.ledger.policyRecords()) {
    record.origin = "agent";
    record.personUsed = false;
  }
  let samples = 0;
  const sleeper = new TabSleeper({
    memoryBudgetBytes: 1,
    rendererUsage: () => {
      samples++;
      return { processes: 2, bytes: 1024 ** 3 };
    },
  });
  sleeper.add("session", { ledger: f.ledger, restoreVersion: 1, blocked: () => null });
  try {
    sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [otherId] });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(f.ledger.untabbedPages(), "The slept page is still closing").toBe(1);
    const held = samples;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(samples - held, "No sample loop while destruction is held").toBeLessThanOrEqual(1);
    const confirmed = samples;
    page.crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(samples, "Confirmation brings the reclaim sample at once").toBe(confirmed + 1);
  } finally {
    gate.answer.resolve();
    sleeper.close();
    await f.ledger.close();
  }
});

it("lets go of each closed browser context once its pages are gone", async () => {
  const launcher = new FakeIsolatingLauncher();
  const verifier = new FakeTicketVerifier(freshClaims());
  const runtime = new BrowserRuntime({
    launcher,
    runtimeId: "runtime_test",
    sessionFilesRoot: testSessionFilesRoot(),
    ticketVerifier: verifier,
  });
  try {
    const attachment = await runtime.attach("fresh-ticket", new FakeSink());
    const context = [...launcher.browsersByPartition.values()][0]!.context as FakeContext;
    expect(context.handOffListeners).toBeGreaterThan(0);
    await attachment.close();
    await vi.waitFor(() => expect(runtime.health().profileHostCount).toBe(0), { timeout: 1_000 });
    expect(context.handOffListeners, "A closed context is no longer held").toBe(0);
  } finally {
    await runtime.shutdown();
  }
});

it("starts a woken tab's new page when the engine cannot name the failed one, which stays closing", async () => {
  const page = new FakePage({ url: "https://wake.test/" });
  const f = await harness([page]);
  const id = await f.idOf(page);
  expect(await f.ledger.sleep(id, () => null)).toBe(true);
  const failed = refusingPage();
  vi.spyOn(failed, "close").mockImplementation(async () => {
    throw new BrowserRuntimeError("conflict", "This page cannot be named to close it.", {
      reason: pageUnnameableReason,
    });
  });
  vi.spyOn(f.context, "createPage").mockImplementationOnce(async () => failed);
  try {
    await expect(f.ledger.wake(id)).rejects.toMatchObject({ code: "conflict" });
    const woken = f.ledger.wake(id);
    await vi.advanceTimersByTimeAsync(0);
    const binding = await woken;
    expect(binding.page, "The tab has exactly one usable page, the new one").not.toBe(failed);
    expect(f.owner.counts().states.closing, "The unnameable page stays owned and asked").toBe(1);
    expect(f.events("browser.page.closing.unnameable")).toHaveLength(1);
    const adopting = f.ledger.adoptTarget(await failed.targetId());
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(adopting, "The unnameable page is never reachable again").resolves.toBe(false);
  } finally {
    await f.ledger.close();
  }
});

it("counts a closing page of an ended session toward memory pressure", async () => {
  const page = new FakePage({ url: "https://kept.test/" });
  const f = await harness([page]);
  const id = await f.idOf(page);
  const record = [...f.ledger.policyRecords()][0]!;
  record.origin = "person";
  record.personUsed = true;
  const orphan = new FakePage();
  vi.spyOn(orphan, "close").mockReturnValue(new Promise(() => {}));
  await f.owner.create("ended", null, "open-failed", async (own) => {
    own(orphan);
    return orphan;
  }).page;
  void f.owner.endSession("ended", "session-ended");
  const sleeper = new TabSleeper({
    memoryBudgetBytes: 150 * 1024 ** 2,
    untabbedPages: () => {
      const { provisional, closing } = f.owner.counts().states;
      return provisional + closing;
    },
  });
  sleeper.add("session", { ledger: f.ledger, restoreVersion: 1, blocked: () => null });
  try {
    sleeper.setSessionState("session", { runs: 0, personUsed: [id], viewed: [], pinned: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.ledger.stateOf(id), "A dying page of an ended session still uses memory").toBe(
      "suspended",
    );
  } finally {
    sleeper.close();
    await f.ledger.close();
  }
});

it("stops after a timed-out drain empties, and keeps asking a page handed off just before", async () => {
  vi.useFakeTimers();
  const r = registry();
  const context = new FakeContext([]);
  r.owner.adopt(context);
  const stuck = new FakePage();
  vi.spyOn(stuck, "close").mockReturnValue(new Promise(() => {}));
  context.handOffPage(stuck);
  const draining = r.owner.shutdown(1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(draining).resolves.toBe(false);
  const late = new FakePage();
  const lateClose = vi.spyOn(late, "close").mockRejectedValue(new Error("refused"));
  context.handOffPage(late);
  stuck.crash();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(lateClose.mock.calls.length, "A late page keeps its retries").toBeGreaterThan(1);
  late.crash();
  expect(context.handOffListeners, "An emptied registry lets go of its contexts").toBe(0);
});

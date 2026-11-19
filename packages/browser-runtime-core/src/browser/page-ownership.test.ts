import { afterEach, expect, it, vi } from "vitest";
import { FakeContext, FakePage } from "../test-support/fakes.js";
import { PageOwnership, type BrowserPageDiagnostic } from "./page-ownership.js";
import { SurfaceLedger } from "./surface-ledger.js";
import { TabSleeper } from "./tab-sleeper.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function harness(pages: FakePage[]) {
  vi.useFakeTimers();
  const diagnostics: BrowserPageDiagnostic[] = [];
  const owner = new PageOwnership({ onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
  const context = new FakeContext(pages);
  const ledger = new SurfaceLedger(context, { pages: owner });
  await ledger.start();
  await vi.advanceTimersByTimeAsync(0);
  const idOf = async (page: FakePage) => ledger.surfaceIdForTarget(await page.targetId())!;
  const events = (event: BrowserPageDiagnostic["event"], page?: FakePage) =>
    diagnostics.filter(
      (diagnostic) =>
        diagnostic.event === event &&
        (!page || ("page" in diagnostic && diagnostic.page === owner.incarnationOf(page))),
    );
  return { context, diagnostics, events, idOf, ledger, owner };
}

/** A failed open or wake: its page refuses initialization once, then its close never answers. */
function refusingPage(answer: Promise<void>) {
  const page = new FakePage();
  page.cdpSession.responses.set("Page.enable", () => {
    page.cdpSession.responses.delete("Page.enable");
    throw new Error("initialization refused");
  });
  vi.spyOn(page, "close").mockReturnValue(answer);
  return page;
}

it.each(["delayed", "falsely acknowledged", "hung", "rejected"] as const)(
  "owns a %s close's page as closing until the engine confirms it, without holding a sibling",
  async (close) => {
    const page = new FakePage({ url: "https://closing.test/" });
    const sibling = new FakePage({ url: "https://sibling.test/" });
    const f = await harness([page, sibling]);
    const id = await f.idOf(page);
    const siblingId = await f.idOf(sibling);
    const incarnation = f.owner.incarnationOf(page);
    const answer = Promise.withResolvers<void>();
    const asked = vi
      .spyOn(page, "close")
      .mockImplementation(() =>
        close === "falsely acknowledged"
          ? Promise.resolve()
          : close === "rejected"
            ? Promise.reject(new Error("close refused"))
            : answer.promise,
      );
    try {
      expect(f.owner.stateOf(page)).toBe("live");
      const closing = f.ledger.closeSurface(id, "person-closed");
      void closing.catch(() => undefined);
      expect(f.owner.stateOf(page)).toBe("closing");

      await expect(f.ledger.use(siblingId, async () => "acted")).resolves.toBe("acted");
      const opened = await f.ledger.openSurface();
      await f.ledger.closeSurface(opened.id, "agent-closed");
      expect(f.owner.stateOf(page), "Sibling work never settles this page").toBe("closing");

      if (close === "delayed") {
        answer.resolve();
        page.crash();
        await closing;
      } else {
        if (close === "hung") await vi.advanceTimersByTimeAsync(2_000);
        if (close === "falsely acknowledged") await closing;
        else await expect(closing).rejects.toThrow();
        expect(f.owner.stateOf(page)).toBe("closing");
        expect(f.owner.incarnationOf(page)).toBe(incarnation);
        // A refused or hung close keeps its tab listed until the page is gone.
        expect(f.ledger.stateOf(id)).toBe(close === "falsely acknowledged" ? undefined : "live");
        await vi.advanceTimersByTimeAsync(10_000);
        expect(asked.mock.calls.length, "Only a settled, unproven close is asked again").toBe(
          close === "hung" ? 1 : 4,
        );
        expect(f.events("browser.page.closing.stuck", page)).toHaveLength(1);
        expect(f.events("browser.page.ended", page)).toEqual([]);
        page.crash();
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(f.owner.stateOf(page)).toBe("absent");
      expect(f.ledger.stateOf(id)).toBeUndefined();
      expect(f.events("browser.page.ended", page)).toEqual([
        {
          event: "browser.page.ended",
          page: incarnation,
          surface: id,
          reason: "person-closed",
          lifetimeMs: expect.any(Number),
          closingMs: expect.any(Number),
          closeAttempts: close === "delayed" || close === "hung" ? 1 : 4,
        },
      ]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(asked.mock.calls.length, "A confirmed page is never asked again").toBe(
        close === "delayed" || close === "hung" ? 1 : 4,
      );
    } finally {
      answer.resolve();
      await f.ledger.close();
    }
  },
);

it.each(["live", "closing"] as const)(
  "keeps a page whose renderer crashed while %s, ending it only on confirmation",
  async (state) => {
    const page = new FakePage();
    const f = await harness([page, new FakePage()]);
    const id = await f.idOf(page);
    if (state === "closing") {
      vi.spyOn(page, "close").mockReturnValue(new Promise(() => {}));
      void f.ledger.closeSurface(id, "agent-closed").catch(() => undefined);
    }
    try {
      page.crashRenderer();
      expect(f.owner.stateOf(page)).toBe(state);
      expect(f.events("browser.page.renderer.crashed")).toEqual([
        {
          event: "browser.page.renderer.crashed",
          page: f.owner.incarnationOf(page),
          surface: id,
          state,
        },
      ]);
      if (state === "live") expect(f.ledger.binding(id)?.page).toBe(page);
      page.crash();
      expect(f.events("browser.page.ended", page)).toMatchObject([
        { reason: state === "live" ? "crashed" : "agent-closed" },
      ]);
    } finally {
      await f.ledger.close();
    }
  },
);

it("owns a failed open's page until confirmed and never registers it, while the next open proceeds", async () => {
  const f = await harness([new FakePage()]);
  const answer = Promise.withResolvers<void>();
  const failed = refusingPage(answer.promise);
  vi.spyOn(f.context, "createPage").mockImplementationOnce(async () => {
    f.context.addPage(failed);
    return failed;
  });
  try {
    await expect(f.ledger.openSurface()).rejects.toThrow("initialization refused");
    expect(f.owner.stateOf(failed)).toBe("closing");
    const next = await f.ledger.openSurface();
    expect(next.state).toBe("live");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.ledger.snapshot().map((surface) => surface.id)).not.toContain(
      f.ledger.surfaceIdForTarget(await failed.targetId()),
    );
    answer.resolve();
    failed.crash();
    expect(f.events("browser.page.ended", failed)).toMatchObject([{ reason: "open-failed" }]);
  } finally {
    answer.resolve();
    await f.ledger.close();
  }
});

it("makes no replacement for a tab while its failed wake's page is unconfirmed", async () => {
  const page = new FakePage({ url: "https://wake.test/" });
  const f = await harness([page]);
  const id = await f.idOf(page);
  expect(await f.ledger.sleep(id, () => null)).toBe(true);
  const answer = Promise.withResolvers<void>();
  const failed = refusingPage(answer.promise);
  const create = vi.spyOn(f.context, "createPage").mockImplementationOnce(async () => failed);
  try {
    await expect(f.ledger.wake(id)).rejects.toMatchObject({ code: "conflict", retryable: true });
    expect(f.owner.stateOf(failed)).toBe("closing");
    await f.ledger.openSurface();
    expect(create, "A sibling open never waits on that close").toHaveBeenCalledTimes(2);
    const waking = f.ledger.wake(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(create, "No replacement while the failed page may live").toHaveBeenCalledTimes(2);
    answer.resolve();
    failed.crash();
    const binding = await waking;
    expect(create).toHaveBeenCalledTimes(3);
    expect(binding.page).not.toBe(failed);
    expect(f.events("browser.page.ended", failed)).toMatchObject([{ reason: "wake-failed" }]);
  } finally {
    answer.resolve();
    await f.ledger.close();
  }
});

it("keeps a falsely acknowledged sleep's page in service and makes no replacement for it", async () => {
  const page = new FakePage({ url: "https://sleep.test/" });
  const f = await harness([page]);
  const id = await f.idOf(page);
  const close = vi.spyOn(page, "close").mockResolvedValue(undefined);
  const create = vi.spyOn(f.context, "createPage");
  try {
    expect(await f.ledger.sleep(id, () => null)).toBe(false);
    expect(f.owner.stateOf(page)).toBe("closing");
    expect(f.ledger.stateOf(id)).toBe("live");
    expect((await f.ledger.wake(id)).page).toBe(page);
    expect(create).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      close,
      "A failed sleep returns the page to service; nothing retries it",
    ).toHaveBeenCalledOnce();
    page.crash();
    expect(f.ledger.stateOf(id)).toBe("suspended");
    expect(f.events("browser.page.ended", page)).toMatchObject([{ reason: "slept" }]);
    expect(f.events("browser.page.sleep.refused", page)).toMatchObject([
      { reason: "close-failed" },
    ]);
  } finally {
    await f.ledger.close();
  }
});

it.each(["rejected", "hung"] as const)(
  "keeps owning a page whose teardown close %s after the ledger lets go",
  async (close) => {
    const page = new FakePage();
    const f = await harness([page]);
    const asked = vi
      .spyOn(page, "close")
      .mockImplementation(() =>
        close === "rejected" ? Promise.reject(new Error("close refused")) : new Promise(() => {}),
      );
    const tearingDown = f.ledger.closeOwnedPages("session-ended");
    await vi.advanceTimersByTimeAsync(2_000);
    await tearingDown;
    await f.ledger.close();
    expect(f.owner.stateOf(page)).toBe("closing");
    expect(f.owner.counts().states).toEqual({ provisional: 0, live: 0, closing: 1 });
    expect(asked).toHaveBeenCalledTimes(close === "rejected" ? 2 : 1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(asked, "Backoff doubles; a hung close is never stacked").toHaveBeenCalledTimes(
      close === "rejected" ? 3 : 1,
    );
    page.crash();
    expect(f.events("browser.page.ended", page)).toMatchObject([{ reason: "session-ended" }]);
    expect(f.owner.counts()).toMatchObject({
      states: { provisional: 0, live: 0, closing: 0 },
      ended: { "session-ended": 1 },
    });
  },
);

it("logs one ending per page and one sleep refusal per reason change, with nothing from the page", async () => {
  const page = new FakePage({
    url: "https://bank.test/account?token=hunter2",
    title: "Balance: 1,234",
  });
  const pinned = new FakePage({ url: "https://pinned.test/private" });
  const f = await harness([page, pinned]);
  const id = await f.idOf(page);
  const pinnedId = await f.idOf(pinned);
  for (const record of f.ledger.policyRecords()) {
    record.origin = "agent";
    record.personUsed = false;
  }
  page.keepAwake = () => "media";
  Object.assign(page, { rendererExit: () => "exited" });
  const sleeper = new TabSleeper();
  sleeper.add("session", { ledger: f.ledger, restoreVersion: 1, blocked: () => null });
  const refusals = (of: FakePage) => f.events("browser.page.sleep.refused", of);
  try {
    sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [pinnedId] });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(refusals(page)).toEqual([
      {
        event: "browser.page.sleep.refused",
        page: f.owner.incarnationOf(page),
        surface: id,
        reason: "media",
        previous: null,
        previousAttempts: 0,
      },
    ]);
    expect(refusals(pinned)).toMatchObject([{ reason: "pinned", previous: null }]);
    page.keepAwake = () => "upload";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refusals(page)).toHaveLength(2);
    expect(refusals(page)[1]).toMatchObject({ reason: "upload", previous: "media" });
    expect((refusals(page)[1] as { previousAttempts: number }).previousAttempts).toBeGreaterThan(
      20,
    );
    page.keepAwake = () => null;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.ledger.stateOf(id)).toBe("suspended");
    expect(f.events("browser.page.ended")).toMatchObject([{ reason: "slept", surface: id }]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(f.events("browser.page.renderer.exit")).toEqual([
      { event: "browser.page.renderer.exit", page: f.owner.incarnationOf(page), outcome: "exited" },
    ]);
    expect(refusals(pinned)).toHaveLength(1);
    expect(f.owner.counts().ended).toEqual({ slept: 1 });
    expect(JSON.stringify(f.diagnostics)).not.toMatch(/bank|hunter2|Balance|pinned\.test|private/);
  } finally {
    sleeper.close();
    await f.ledger.close();
  }
});

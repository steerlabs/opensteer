import { describe, expect, it, vi } from "vitest";
import { FakeContext, FakePage, flushMicrotasks } from "../test-support/fakes.js";
import { SurfaceLedger, type SurfaceLedgerEvent } from "./surface-ledger.js";

type Respond = (parameters: Record<string, unknown> | undefined) => unknown;

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await flushMicrotasks();
}

/**
 * Holds the page's answers to one method. Each answer is computed when the
 * page is asked, as Chromium would, and delivered only when released.
 */
function holdAnswers(
  page: FakePage,
  method: string,
  holds: (parameters: Record<string, unknown> | undefined) => boolean = () => true,
) {
  const answer = page.cdpSession.responses.get(method) as Respond;
  const held: (() => void)[] = [];
  let holding = true;
  page.cdpSession.responses.set(method, async (parameters: Record<string, unknown> | undefined) => {
    if (!holds(parameters) || !holding) return answer(parameters);
    let value: unknown;
    let failure: unknown;
    try {
      value = answer(parameters);
    } catch (error) {
      failure = error;
    }
    await new Promise<void>((resolve) => held.push(resolve));
    if (failure) throw failure;
    return value;
  });
  return {
    count: () => held.length,
    async release(): Promise<void> {
      holding = false;
      for (const release of held.splice(0)) release();
      await settle();
    },
  };
}

/** Holds the page's document-bound title samples. */
function holdTitleSamples(page: FakePage) {
  return holdAnswers(
    page,
    "Runtime.evaluate",
    (parameters) => parameters?.uniqueContextId !== undefined,
  );
}

/** The contexts the page was asked to read a title in, in order. */
function sampledWorlds(page: FakePage): unknown[] {
  return page.cdpSession.sent
    .filter(
      (command) =>
        command.method === "Runtime.evaluate" && command.parameters?.uniqueContextId !== undefined,
    )
    .map((command) => command.parameters?.uniqueContextId);
}

function context(id: number, uniqueId: string, frameId: string, main: boolean) {
  return {
    context: {
      id,
      uniqueId,
      origin: "",
      name: main ? "" : "isolated",
      auxData: { frameId, isDefault: main, type: main ? "default" : "isolated" },
    },
  };
}

function titledSurfaces(ledger: SurfaceLedger) {
  const seen: { documentId: string | undefined; title: string; url: string }[] = [];
  ledger.subscribe((event: SurfaceLedgerEvent) => {
    if (event.type === "changed" && "surface" in event && event.surface)
      seen.push({
        documentId: event.surface.documentId,
        title: event.surface.title,
        url: event.surface.url,
      });
  });
  return seen;
}

describe("page titles", () => {
  it("never pairs a new document with its predecessor's title, even when the browser-side title lags", async () => {
    const page = new FakePage({
      title: "Automatic context /login",
      url: "https://site.test/login",
    });
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    try {
      await settle();
      expect(ledger.snapshot()[0]).toMatchObject({
        title: "Automatic context /login",
        url: "https://site.test/login",
      });
      const seen = titledSurfaces(ledger);
      const samples = holdTitleSamples(page);
      // Target info is browser-side; it can still report the predecessor's title.
      vi.spyOn(page, "title").mockResolvedValue("Automatic context /login");
      page.navigate("https://site.test/pay", "Automatic context /pay");
      await settle();
      const committed = ledger.snapshot()[0]!;
      expect(committed).toMatchObject({ title: "", url: "https://site.test/pay" });
      await samples.release();
      expect(ledger.snapshot()[0]).toMatchObject({
        documentId: committed.documentId,
        title: "Automatic context /pay",
        url: "https://site.test/pay",
      });
      expect(
        seen.filter(
          (surface) =>
            surface.url === "https://site.test/pay" && surface.title === "Automatic context /login",
        ),
      ).toEqual([]);
    } finally {
      await ledger.close();
    }
  });

  it.each([
    ["another address", "https://site.test/b", "B"],
    ["a same-address reload", "https://site.test/a", "A reloaded"],
    ["an untitled document", "https://site.test/untitled", ""],
  ])(
    "discards a sample the previous document answered after %s commits",
    async (_case, url, title) => {
      const page = new FakePage({ title: "A", url: "https://site.test/a" });
      const ledger = new SurfaceLedger(new FakeContext([page]));
      await ledger.start();
      try {
        await settle();
        expect(ledger.snapshot()[0]?.title).toBe("A");
        const seen = titledSurfaces(ledger);
        const samples = holdTitleSamples(page);
        // A metadata hint asks the old document for its title; it answers late.
        page.setMetadata("A", "https://site.test/a");
        await settle();
        expect(samples.count()).toBe(1);
        page.navigate(url, title);
        await settle();
        const document = ledger.snapshot()[0]!.documentId;
        await samples.release();
        expect(ledger.snapshot()[0]).toMatchObject({ documentId: document, title, url });
        expect(
          seen.filter((surface) => surface.documentId === document && surface.title === "A"),
        ).toEqual([]);
      } finally {
        await ledger.close();
      }
    },
  );

  it("discards the first sample when the page commits another document during registration", async () => {
    const page = new FakePage({ title: "Before", url: "https://site.test/before" });
    const samples = holdTitleSamples(page);
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    try {
      await settle();
      expect(ledger.snapshot()[0]?.title).toBe("");
      page.navigate("https://site.test/after", "After");
      await settle();
      await samples.release();
      expect(ledger.snapshot()[0]).toMatchObject({
        title: "After",
        url: "https://site.test/after",
      });
    } finally {
      await ledger.close();
    }
  });

  it("reads only the new document's world when it commits while the page says which document it shows", async () => {
    const page = new FakePage({ targetId: "page", title: "A", url: "https://site.test/a" });
    const trees = holdAnswers(page, "Page.getFrameTree");
    const ledger = new SurfaceLedger(new FakeContext([page]));
    const seen = titledSurfaces(ledger);
    await ledger.start();
    try {
      await settle();
      // The first sample asked which document the page shows; A's answer is late.
      expect(trees.count()).toBe(1);
      page.navigate("https://site.test/b", "B");
      await settle();
      const document = ledger.snapshot()[0]!.documentId;
      await trees.release();
      expect(ledger.snapshot()[0]).toMatchObject({
        documentId: document,
        title: "B",
        url: "https://site.test/b",
      });
      // A's answer read nothing; the next sample read B's own world.
      expect(sampledWorlds(page)).toEqual(["page-world-2"]);
      expect(seen.filter((surface) => surface.title === "A")).toEqual([]);
    } finally {
      await ledger.close();
    }
  });

  it("reads the main frame's own world, never an isolated world or an iframe's", async () => {
    const page = new FakePage({ targetId: "page", title: "Main", url: "https://site.test/main" });
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    try {
      await settle();
      expect(ledger.snapshot()[0]?.title).toBe("Main");
      // Reported after the main world, as an extension's world and an ad frame's are.
      page.cdpSession.emit(
        "Runtime.executionContextCreated",
        context(7, "isolated", "page", false),
      );
      page.cdpSession.emit("Runtime.executionContextCreated", context(8, "ad", "ad-frame", true));
      const before = sampledWorlds(page).length;
      page.setMetadata("Renamed", "https://site.test/main");
      await settle();
      expect(ledger.snapshot()[0]?.title).toBe("Renamed");
      expect(sampledWorlds(page).slice(before)).toEqual(["page-world-1"]);
    } finally {
      await ledger.close();
    }
  });

  it.each([
    ["as the page registered", false],
    ["after a replay", true],
  ])(
    "reads a replacement renderer's world that reuses the number of one reported %s",
    async (_case, replayed) => {
      const page = new FakePage({ targetId: "page", title: "A", url: "https://site.test/a" });
      const ledger = new SurfaceLedger(new FakeContext([page]));
      await ledger.start();
      try {
        await settle();
        expect(ledger.snapshot()[0]?.title).toBe("A");
        // A resubscribed session forgets and replays the shown document's contexts.
        if (replayed) page.replayContexts();
        await settle();
        const surfaceId = ledger.snapshot()[0]!.id;
        // The replacement renderer, scripted: it shows B and answers only in its own world.
        const shown = { title: "B" };
        page.cdpSession.responses.set("Page.getFrameTree", () => ({
          frameTree: { frame: { id: "page", loaderId: "page-loader-b" } },
        }));
        page.cdpSession.responses.set(
          "Runtime.evaluate",
          (parameters: Record<string, unknown> | undefined) => {
            if (parameters?.uniqueContextId === undefined) return {};
            if (parameters.uniqueContextId !== "page-world-b")
              throw new Error("uniqueContextId not found");
            return { result: { value: { href: "https://site.test/b", title: shown.title } } };
          },
        );
        const before = sampledWorlds(page).length;
        // It commits with no reset first, and numbers its contexts afresh.
        page.cdpSession.emit("Page.frameNavigated", {
          frame: { id: "page", loaderId: "page-loader-b", url: "https://site.test/b" },
          type: "Navigation",
        });
        await settle();
        expect(ledger.snapshot()[0]).toMatchObject({ title: "", url: "https://site.test/b" });
        page.cdpSession.emit(
          "Runtime.executionContextCreated",
          context(1, "page-world-b", "page", true),
        );
        // The predecessor's world reports its end late, under the number they shared.
        page.cdpSession.emit("Runtime.executionContextDestroyed", {
          executionContextId: 1,
          executionContextUniqueId: "page-world-1",
        });
        await settle();
        expect(ledger.snapshot()[0]?.title).toBe("B");
        shown.title = "B renamed";
        await ledger.refresh(surfaceId);
        await settle();
        expect(ledger.snapshot()[0]?.title).toBe("B renamed");
        expect(sampledWorlds(page).slice(before)).toEqual(["page-world-b", "page-world-b"]);
      } finally {
        await ledger.close();
      }
    },
  );

  it("gives a tab that takes a closed tab's place none of the closed tab's late samples", async () => {
    const closing = new FakePage({ targetId: "page", title: "Old", url: "https://site.test/same" });
    const context = new FakeContext([closing]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    try {
      await settle();
      const surfaceId = ledger.snapshot()[0]!.id;
      const samples = holdTitleSamples(closing);
      closing.setMetadata("Old renamed", "https://site.test/same");
      await settle();
      expect(samples.count()).toBe(1);
      await ledger.closeSurface(surfaceId);
      const replacement = new FakePage({
        targetId: "page",
        title: "New",
        url: "https://site.test/same",
      });
      vi.spyOn(context, "createPage").mockImplementationOnce(async () => {
        context.addPage(replacement);
        return replacement;
      });
      const seen = titledSurfaces(ledger);
      await ledger.openSurface({ surfaceId });
      await settle();
      await samples.release();
      expect(ledger.snapshot().find((surface) => surface.id === surfaceId)?.title).toBe("New");
      expect(seen.filter((surface) => surface.title === "Old renamed")).toEqual([]);
    } finally {
      await ledger.close();
    }
  });

  it("names a restored document by its own contexts, which arrive before its commit", async () => {
    const page = new FakePage({ title: "B", url: "https://site.test/b" });
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    try {
      await settle();
      const seen = titledSurfaces(ledger);
      page.restore("https://site.test/a", "A restored");
      await settle();
      expect(ledger.snapshot()[0]).toMatchObject({
        title: "A restored",
        url: "https://site.test/a",
      });
      expect(seen.filter((surface) => surface.title === "B")).toEqual([]);
    } finally {
      await ledger.close();
    }
  });

  it("keeps reading after contexts are replayed without a navigation", async () => {
    const page = new FakePage({ title: "Kept", url: "https://site.test/kept" });
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    try {
      await settle();
      expect(ledger.snapshot()[0]?.title).toBe("Kept");
      page.replayContexts();
      page.setMetadata("Renamed", "https://site.test/kept");
      await settle();
      expect(ledger.snapshot()[0]?.title).toBe("Renamed");
    } finally {
      await ledger.close();
    }
  });

  it("stops sampling a page that closes, and a stuck page holds no other page or teardown", async () => {
    const stuck = new FakePage({ title: "Stuck", url: "https://site.test/stuck" });
    const healthy = new FakePage({ title: "Healthy", url: "https://site.test/healthy" });
    stuck.cdpSession.responses.set(
      "Runtime.evaluate",
      (parameters: Record<string, unknown> | undefined) =>
        parameters?.uniqueContextId === undefined ? {} : new Promise(() => undefined),
    );
    const ledger = new SurfaceLedger(new FakeContext([stuck, healthy]));
    await ledger.start();
    await settle();
    const titles = new Map(ledger.snapshot().map((surface) => [surface.url, surface.title]));
    expect(titles.get("https://site.test/stuck")).toBe("");
    expect(titles.get("https://site.test/healthy")).toBe("Healthy");
    // A page whose renderer never answers keeps one sample outstanding, not one per hint.
    const evaluations = () =>
      stuck.cdpSession.sent.filter(
        (command) =>
          command.method === "Runtime.evaluate" &&
          command.parameters?.uniqueContextId !== undefined,
      ).length;
    const before = evaluations();
    for (let hint = 0; hint < 5; hint += 1) stuck.setMetadata("Stuck", "https://site.test/stuck");
    await settle();
    expect(evaluations()).toBe(before);
    await expect(
      Promise.race([
        ledger.close().then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
      ]),
    ).resolves.toBe("closed");
    const sentAtClose = stuck.cdpSession.sent.length;
    stuck.navigate("https://site.test/after-close", "After close");
    await settle();
    expect(stuck.cdpSession.sent.length).toBe(sentAtClose);
  });
});

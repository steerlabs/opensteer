import { describe, expect, it, vi } from "vitest";
import {
  FakeContext,
  FakePage,
  flushMicrotasks,
  withoutTitleSamples,
} from "../test-support/fakes.js";
import { SurfaceLedger, type SurfaceLedgerEvent } from "./surface-ledger.js";

/** The agent-cursor observer an announced page installs, after its events and size. */
const scriptTargetSetup = [
  { method: "Runtime.enable" },
  {
    method: "Runtime.addBinding",
    parameters: {
      name: expect.stringMatching(/^opensteerTarget_[0-9a-f]{32}$/),
      executionContextName: expect.stringMatching(/^opensteer-targets-/),
    },
  },
  {
    method: "Page.addScriptToEvaluateOnNewDocument",
    parameters: {
      source: expect.any(String),
      worldName: expect.stringMatching(/^opensteer-targets-/),
      runImmediately: true,
    },
  },
];

describe("SurfaceLedger", () => {
  it("retains validated fragments on committed full navigations", async () => {
    const page = new FakePage();
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    try {
      page.cdpSession.emit("Page.frameNavigated", {
        frame: { id: "main", url: "https://example.test/", urlFragment: "#/document/42" },
      });
      expect(ledger.durableSnapshot()[0]?.url).toBe("https://example.test/#/document/42");
      page.cdpSession.emit("Page.frameNavigated", {
        frame: { id: "child", parentId: "main", url: "https://child.test/", urlFragment: "#child" },
      });
      expect(ledger.durableSnapshot()[0]?.url).toBe("https://example.test/#/document/42");
      for (const urlFragment of [undefined, 42, "invalid"]) {
        page.cdpSession.emit("Page.frameNavigated", {
          frame: { id: "main", url: "https://example.test/next", urlFragment },
        });
        expect(ledger.durableSnapshot()[0]?.url).toBe("https://example.test/next");
      }
    } finally {
      await ledger.close();
    }
  });
  it("marks over-limit committed URLs unavailable instead of truncating them", async () => {
    const page = new FakePage();
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    try {
      const url = `https://example.test/${"x".repeat(9000)}`;
      page.cdpSession.emit("Page.frameNavigated", { frame: { id: "main", url } });
      expect(ledger.durableSnapshot()[0]?.url).toBe(url);
      const limitUrl = "https://example.test/".padEnd(16384, "x");
      page.cdpSession.emit("Page.frameNavigated", { frame: { id: "main", url: limitUrl } });
      expect(ledger.durableSnapshot()[0]?.url).toBe(limitUrl);
      page.cdpSession.emit("Page.frameNavigated", {
        frame: { id: "main", url: limitUrl, urlFragment: "#over" },
      });
      expect(ledger.durableSnapshot()[0]?.url).toBe("opensteer:unavailable-url");
      page.cdpSession.emit("Page.navigatedWithinDocument", {
        frameId: "main",
        url: `${limitUrl}x`,
      });
      expect(ledger.durableSnapshot()[0]?.url).toBe("opensteer:unavailable-url");
    } finally {
      await ledger.close();
    }
  });
  it("rejects unknown surfaces and isolates failing subscribers", async () => {
    const page = new FakePage();
    const ledger = new SurfaceLedger(new FakeContext([page]));
    const healthy = vi.fn();
    ledger.subscribe(() => {
      throw new Error("listener failed");
    });
    ledger.subscribe(healthy);
    await ledger.start();

    await expect(
      ledger.activate("surface_missing" as Parameters<typeof ledger.activate>[0]),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(healthy).toHaveBeenCalled();
    await ledger.close();
  });

  it("treats active selection as logical state and makes reselection idempotent", async () => {
    const first = new FakePage({ title: "First" });
    const second = new FakePage({ title: "Second" });
    const ledger = new SurfaceLedger(new FakeContext([first, second]));
    const events: SurfaceLedgerEvent[] = [];
    ledger.subscribe((event) => events.push(event));
    await ledger.start();

    const [firstSurface, secondSurface] = ledger.snapshot();
    if (!firstSurface || !secondSurface) throw new Error("Expected two surfaces.");
    expect(secondSurface.active).toBe(true);

    const beforeSelection = events.length;
    await ledger.activate(firstSurface.id);
    expect(ledger.active()?.surface.id).toBe(firstSurface.id);
    expect(events.slice(beforeSelection)).toEqual([
      expect.objectContaining({ surfaces: expect.any(Array), type: "snapshot" }),
    ]);

    const beforeReselection = events.length;
    await ledger.activate(firstSurface.id);
    expect(ledger.active()?.surface.id).toBe(firstSurface.id);
    expect(events).toHaveLength(beforeReselection);
    await ledger.close();
  });

  it("bounds the number of browser surfaces", async () => {
    const first = new FakePage();
    const context = new FakeContext([first]);
    const ledger = new SurfaceLedger(context, { maxSurfaces: 1 });
    await ledger.start();
    const excess = new FakePage({ opener: first });

    context.addPage(excess);
    await flushMicrotasks();
    expect(ledger.snapshot()).toHaveLength(1);
    expect(excess.closeCount).toBe(1);
    await ledger.close();
    expect(() => new SurfaceLedger(context, { maxSurfaces: 65 })).toThrow(/1 through 64/);
  });

  it("adopts only openerless targets created through the scoped session router", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context, { rootPages: [root] });
    await ledger.start();

    const unrelated = new FakePage({ title: "Unrelated" });
    context.addPage(unrelated);
    await flushMicrotasks();
    expect(ledger.snapshot()).toEqual([expect.objectContaining({ title: "Root" })]);

    expect(await ledger.adoptTarget(await unrelated.targetId())).toBe(true);
    expect(ledger.snapshot()).toEqual([
      expect.objectContaining({ active: true, title: "Root" }),
      expect.objectContaining({ active: false, title: "Unrelated" }),
    ]);

    await ledger.close();
  });

  it("waits for an in-flight discovered target before resolving it, without selecting it", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context, { rootPages: [root] });
    await ledger.start();

    let releaseMetrics: (() => void) | undefined;
    const metricsReady = new Promise<void>((resolve) => {
      releaseMetrics = resolve;
    });
    const popup = new FakePage({ opener: root, title: "Popup" });
    popup.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", async () => {
      await metricsReady;
      return {};
    });
    context.addPage(popup);

    let resolved = false;
    const resolution = ledger.resolveTarget(await popup.targetId()).then((found) => {
      resolved = true;
      return found;
    });
    await flushMicrotasks();
    expect(resolved).toBe(false);
    releaseMetrics?.();
    await expect(resolution).resolves.toBe(true);
    // Resolving a target for an agent never moves the person's selection.
    expect(ledger.active()?.targetId).toBe(await root.targetId());
    await ledger.close();
  });

  it("gives every page and popup its starting size before announcing it", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context, {
      initialViewport: { devicePixelRatio: 1, height: 600, width: 900 },
    });
    await ledger.start();
    // Page events come first, so a dialog the page opens while it is sized is seen.
    expect(withoutTitleSamples(root.cdpSession.sent)).toEqual([
      { method: "Page.enable" },
      {
        method: "Emulation.setDeviceMetricsOverride",
        parameters: {
          deviceScaleFactor: 1,
          height: 600,
          mobile: false,
          // Resizing a window does not resize its monitor: one ordinary screen.
          screenHeight: 1_080,
          screenWidth: 1_920,
          width: 900,
        },
      },
      ...scriptTargetSetup,
    ]);

    const popup = new FakePage({ opener: root, title: "Popup" });
    context.addPage(popup);
    await flushMicrotasks();
    expect(withoutTitleSamples(popup.cdpSession.sent)).toMatchObject([
      { method: "Page.enable" },
      { method: "Emulation.setDeviceMetricsOverride", parameters: { height: 600, width: 900 } },
      ...scriptTargetSetup,
    ]);
    expect(ledger.snapshot()).toContainEqual(
      expect.objectContaining({ active: false, title: "Popup" }),
    );
    await ledger.close();
  });

  it("keeps target-local viewports isolated across sessions sharing one context", async () => {
    const first = new FakePage({ title: "First session" });
    const second = new FakePage({ title: "Second session" });
    const context = new FakeContext([first, second]);
    const firstLedger = new SurfaceLedger(context, { rootPages: [first] });
    const secondLedger = new SurfaceLedger(context, { rootPages: [second] });
    await firstLedger.start();
    await secondLedger.start();

    const firstSurface = firstLedger.snapshot()[0];
    const secondSurface = secondLedger.snapshot()[0];
    if (!firstSurface || !secondSurface) throw new Error("Missing session surfaces");
    await firstLedger.fitViewport(firstSurface.id, { height: 600, width: 900 });
    await secondLedger.fitViewport(secondSurface.id, { height: 500, width: 700 });
    expect(
      first.cdpSession.sent
        .filter((command) => command.method === "Emulation.setDeviceMetricsOverride")
        .at(-1)?.parameters,
    ).toMatchObject({ height: 600, width: 900 });
    expect(
      second.cdpSession.sent
        .filter((command) => command.method === "Emulation.setDeviceMetricsOverride")
        .at(-1)?.parameters,
    ).toMatchObject({ height: 500, width: 700 });

    await firstLedger.close();
    await secondLedger.close();
  });

  it("closes and detaches an explicitly opened surface when initial metrics fail", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    const failed = new FakePage({ title: "Failed tab" });
    failed.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => {
      throw new Error("metrics failed");
    });
    context.createPage = async () => {
      context.addPage(failed);
      return failed;
    };

    await expect(ledger.openSurface()).rejects.toThrow("metrics failed");
    expect(failed.closeCount).toBe(1);
    expect(failed.cdpSession.detachCount).toBe(1);
    expect(ledger.snapshot()).toEqual([expect.objectContaining({ title: "Root" })]);
    await ledger.close();
  });

  it("closes and detaches a discovered popup when initial metrics fail", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    const failed = new FakePage({ opener: root, title: "Failed popup" });
    failed.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => {
      throw new Error("metrics failed");
    });

    context.addPage(failed);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(failed.closeCount).toBe(1);
    expect(failed.cdpSession.detachCount).toBe(1);
    expect(ledger.snapshot()).toEqual([expect.objectContaining({ title: "Root" })]);
    await ledger.close();
  });

  it("closes a discovered popup when its platform CDP channel cannot be acquired", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    const failed = new FakePage({ opener: root, title: "Failed popup" });
    failed.cdp = async () => {
      throw new Error("CDP attach failed");
    };

    context.addPage(failed);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(failed.closeCount).toBe(1);
    expect(failed.cdpSession.detachCount).toBe(0);
    expect(ledger.snapshot()).toEqual([expect.objectContaining({ title: "Root" })]);
    await ledger.close();
  });

  it("serializes a Fit with in-flight registration and sizes only the page it names", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    const rootSurface = ledger.snapshot()[0];
    if (!rootSurface) throw new Error("Missing root surface");

    let releasePopupMetrics: () => void = () => undefined;
    const popupMetrics = new Promise<void>((resolve) => {
      releasePopupMetrics = resolve;
    });
    const popup = new FakePage({ opener: root, title: "Popup" });
    popup.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => popupMetrics);
    context.addPage(popup);
    await flushMicrotasks();
    // The popup's starting size is in flight.
    expect(popup.cdpSession.sent.map((command) => command.method)).toEqual([
      "Page.enable",
      "Emulation.setDeviceMetricsOverride",
    ]);

    const resize = ledger.fitViewport(rootSurface.id, { height: 600, width: 900 });
    releasePopupMetrics();
    await resize;
    await flushMicrotasks();
    expect(
      popup.cdpSession.sent
        .filter((command) => command.method === "Emulation.setDeviceMetricsOverride")
        .map((command) => command.parameters),
    ).toEqual([expect.objectContaining({ height: 729, width: 709 })]);
    expect(
      root.cdpSession.sent
        .filter((command) => command.method === "Emulation.setDeviceMetricsOverride")
        .at(-1)?.parameters,
    ).toMatchObject({ height: 600, width: 900 });
    await ledger.close();
  });

  it("settles popup geometry before exposing its target to an agent", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();

    let releaseMetrics: () => void = () => undefined;
    const metrics = new Promise<void>((resolve) => {
      releaseMetrics = resolve;
    });
    const popup = new FakePage({ opener: root, title: "Popup" });
    popup.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => metrics);
    context.addPage(popup);
    await flushMicrotasks();

    let settled = false;
    const targetReady = ledger.settleTarget(await popup.targetId()).then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    releaseMetrics();
    await targetReady;
    expect(settled).toBe(true);
    expect(ledger.snapshot()).toContainEqual(
      expect.objectContaining({ active: false, title: "Popup" }),
    );
    await ledger.close();
  });

  it("serializes surface closure with an in-flight viewport write", async () => {
    const root = new FakePage({ title: "Root" });
    const popup = new FakePage({ opener: root, title: "Popup" });
    const context = new FakeContext([root, popup]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    const popupSurface = ledger.snapshot().find((surface) => surface.title === "Popup");
    if (!popupSurface) throw new Error("Missing popup surface");

    let releaseMetrics: () => void = () => undefined;
    const metrics = new Promise<void>((resolve) => {
      releaseMetrics = resolve;
    });
    popup.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => metrics);
    const resize = ledger.fitViewport(popupSurface.id, { height: 600, width: 900 });
    await flushMicrotasks();
    const close = ledger.closeSurface(popupSurface.id);
    releaseMetrics();

    await expect(resize).resolves.toMatchObject({ changed: true });
    await close;
    expect(ledger.snapshot()).toEqual([expect.objectContaining({ title: "Root" })]);
    await ledger.close();
  });

  it("reports a page that cannot take its size and leaves every page open", async () => {
    const root = new FakePage({ title: "Root" });
    const popup = new FakePage({ opener: root, title: "Popup" });
    const context = new FakeContext([root, popup]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    const popupSurface = ledger.snapshot().find((surface) => surface.title === "Popup");
    const rootSurface = ledger.snapshot().find((surface) => surface.title === "Root");
    if (!popupSurface || !rootSurface) throw new Error("Missing surfaces");
    popup.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => {
      throw new Error("live target rejected metrics");
    });
    const rootWrites = root.cdpSession.sent.length;

    await expect(ledger.fitViewport(popupSurface.id, { height: 600, width: 900 })).rejects.toThrow(
      "live target rejected metrics",
    );
    await flushMicrotasks();
    expect(popup.closeCount).toBe(0);
    expect(ledger.snapshot()).toHaveLength(2);
    expect(root.cdpSession.sent).toHaveLength(rootWrites);
    // The refused size never became the page's own: its popup starts at the old one.
    const nested = new FakePage({ opener: popup, title: "Nested popup" });
    context.addPage(nested);
    await flushMicrotasks();
    expect(withoutTitleSamples(nested.cdpSession.sent)).toMatchObject([
      { method: "Page.enable" },
      { method: "Emulation.setDeviceMetricsOverride", parameters: { height: 729, width: 709 } },
      ...scriptTargetSetup,
    ]);

    // The session keeps serving later writes to any page.
    await ledger.fitViewport(rootSurface.id, { height: 500, width: 700 });
    expect(
      root.cdpSession.sent
        .filter((command) => command.method === "Emulation.setDeviceMetricsOverride")
        .at(-1)?.parameters,
    ).toMatchObject({ height: 500, width: 700 });
    await ledger.closeOwnedPages();
    await ledger.close();
  });

  it("ignores a viewport failure from a surface that closed as the write landed", async () => {
    const root = new FakePage({ title: "Root" });
    const popup = new FakePage({ opener: root, title: "Popup" });
    const ledger = new SurfaceLedger(new FakeContext([root, popup]));
    await ledger.start();
    const popupSurface = ledger.snapshot().find((surface) => surface.title === "Popup");
    if (!popupSurface) throw new Error("Missing popup surface");
    popup.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => {
      popup.crash();
      throw new Error("target closed mid-write");
    });

    await expect(
      ledger.fitViewport(popupSurface.id, { height: 600, width: 900 }),
    ).rejects.toMatchObject({ code: "not_found" });
    await flushMicrotasks();
    // The benign close race is not a reason to close a page the engine already
    // closed, and the page's own close path still retires the surface.
    expect(popup.closeCount).toBe(0);
    expect(ledger.snapshot()).toEqual([expect.objectContaining({ active: true, title: "Root" })]);
    await ledger.closeOwnedPages();
    await ledger.close();
  });

  it("requires a bounded DPR-1 logical viewport", async () => {
    const context = new FakeContext([new FakePage()]);
    expect(
      () =>
        new SurfaceLedger(context, {
          initialViewport: { devicePixelRatio: 2, height: 600, width: 900 },
        }),
    ).toThrow(/DPR 1/);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    const surface = ledger.snapshot()[0];
    if (!surface) throw new Error("Missing surface");
    await expect(
      Promise.resolve().then(() =>
        ledger.fitViewport(surface.id, { height: 10_000, width: 10_000 }),
      ),
    ).rejects.toThrow(/bounded/);
    await ledger.close();
  });
});

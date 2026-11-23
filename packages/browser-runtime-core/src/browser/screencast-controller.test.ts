import { describe, expect, it, vi } from "vitest";
import { screencastRaster } from "./screencast-controller.js";

describe("screencastRaster", () => {
  it.each([0.75, 1, 1.25, 1.5, 2])("uses density %s without resizing CSS geometry", (density) => {
    const size = { width: 800, height: 600 };
    expect(screencastRaster(size, density)).toEqual({
      width: 800 * density,
      height: 600 * density,
    });
    expect(size).toEqual({ width: 800, height: 600 });
  });
  it("keeps the released default and caps native density", () => {
    expect(screencastRaster({ width: 800, height: 600 })).toEqual({ width: 1600, height: 1200 });
    expect(screencastRaster({ width: 800, height: 600 }, 3)).toEqual({ width: 1600, height: 1200 });
  });
});

/*
 * F32 (a), from the walker's runs on 963f808d0 and fb245664c: the follow view stopped and started
 * its cast when nothing about the picture had changed. A navigation bumps the surface's geometry
 * revision at the same size, and a page that lets its capture go gets it back the same; each
 * restarted the cast, once per trigger. Shared with the Linux Home's viewer, which has no hub to
 * absorb them.
 */
describe("the follow view's cast, when nothing about the picture changed", async () => {
  const { ScreencastController } = await import("./screencast-controller.js");
  const { LatestFrameStream } = await import("../stream/latest-frame-stream.js");
  const { FakeCdpSession, jpeg } = await import("../test-support/fakes.js");
  const shown = { height: 600, width: 800 };
  const frame = (id: number, size = shown) => ({
    data: jpeg(size.width, size.height).toString("base64"),
    metadata: {
      deviceHeight: size.height,
      deviceWidth: size.width,
      offsetTop: 0,
      pageScaleFactor: 1,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
    },
    sessionId: id,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  async function following(withCapture: boolean) {
    const cdp = new FakeCdpSession();
    const surface = {
      active: true,
      documentId: "a",
      geometryRevision: 1,
      id: "tab",
      loading: false,
    };
    let size = { ...shown };
    let capture: { height: number; rasterScale: number; revision: number; width: number } | null = {
      ...shown,
      rasterScale: 1,
      revision: 1,
    };
    const captureListeners = new Set<() => void>();
    const page = {
      applyGeometry: async () => undefined,
      settleRendering: async () => undefined,
      ...(withCapture
        ? {
            capture: {
              read: () => capture,
              subscribe: (listener: () => void) => {
                captureListeners.add(listener);
                return () => captureListeners.delete(listener);
              },
            },
          }
        : {}),
    };
    const binding = { cdp, page, surface };
    const listeners = new Set<(event: unknown) => void>();
    const ledger = {
      active: () => binding,
      binding: () => binding,
      dialogOf: () => null,
      dialogOpen: () => false,
      recordPageScale: () => undefined,
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      use: <T>(_id: string, operation: () => Promise<T>) => operation(),
      viewportOf: () => size,
      withGeometry: <T>(_id: string, operation: () => Promise<T>) => operation(),
    };
    const delivered: { header: { geometryRevision: number } }[] = [];
    const follow = new ScreencastController({
      frames: new LatestFrameStream({
        sendFrame: async (sent) => void delivered.push(sent as never),
      }),
      ledger: ledger as never,
      onDialogChanged: () => undefined,
    });
    await follow.start();
    await follow.setStreaming(true);
    await settle();
    const count = (method: string) => cdp.sent.filter((sent) => sent.method === method).length;
    return {
      cdp,
      count,
      delivered,
      follow,
      navigate: async () => {
        surface.documentId += "+";
        surface.geometryRevision += 1;
        for (const listener of listeners)
          listener({ change: "updated", surface: { ...surface }, type: "changed" });
        await settle();
      },
      letCaptureGo: async () => {
        const kept = capture;
        capture = null;
        for (const listener of captureListeners) listener();
        await settle();
        capture = kept;
        for (const listener of captureListeners) listener();
        await settle();
      },
      resize: async (next: { height: number; width: number }) => {
        size = next;
        if (capture) capture = { ...next, rasterScale: 1, revision: capture.revision + 1 };
        surface.geometryRevision += 1;
        for (const listener of captureListeners) listener();
        for (const listener of listeners)
          listener({ change: "updated", surface: { ...surface }, type: "changed" });
        await settle();
      },
    };
  }

  for (const withCapture of [true, false])
    it(`keeps its cast across a navigation at the same size (${withCapture ? "a native capture" : "no capture"})`, async () => {
      const tab = await following(withCapture);
      expect(tab.count("Page.startScreencast")).toBe(1);
      await tab.navigate();
      expect({
        starts: tab.count("Page.startScreencast"),
        stops: tab.count("Page.stopScreencast"),
      }).toEqual({ starts: 1, stops: 0 });
      // The new document's first frame is taken, as the new revision's.
      tab.cdp.emit("Page.screencastFrame", frame(1));
      await vi.waitFor(() => expect(tab.delivered.at(-1)?.header.geometryRevision).toBe(2));
      await tab.follow.close();
    });

  it("keeps its cast while the page's capture is let go and comes back the same", async () => {
    const tab = await following(true);
    await tab.letCaptureGo();
    expect({
      starts: tab.count("Page.startScreencast"),
      stops: tab.count("Page.stopScreencast"),
    }).toEqual({ starts: 1, stops: 0 });
    tab.cdp.emit("Page.screencastFrame", frame(1));
    await vi.waitFor(() => expect(tab.delivered.length).toBeGreaterThan(0));
    await tab.follow.close();
  });

  it("still starts the cast again for a page of another size", async () => {
    const tab = await following(true);
    await tab.resize({ height: 700, width: 1_000 });
    await vi.waitFor(() => expect(tab.count("Page.startScreencast")).toBe(2));
    expect(tab.count("Page.stopScreencast")).toBe(1);
    await tab.follow.close();
  });
});

/*
 * F41, the re-check of fb245664c..e67033f5f, finding 3 (Sequence A): the follow view's one lock is
 * shared by every tab, and the tab it binds changes only inside `rebind`, queued on that lock. A
 * cast queued for the tab a person has just left still ran, with a new abort handle nothing would
 * abort, and waited the whole paint limit on a still page while holding the lock: the tab now in
 * view could not be bound until it let go.
 */
describe("the follow view, when the person turns to another tab", async () => {
  const { ScreencastController } = await import("./screencast-controller.js");
  const { LatestFrameStream } = await import("../stream/latest-frame-stream.js");
  const { FakeCdpSession } = await import("../test-support/fakes.js");
  const { BrowserPaintTimeoutError } = await import("./backend.js");

  it("starts the cast of the tab now in view at once, though work for the tab it left was queued", async () => {
    const paintLimitMs = 5_000;
    const geometryHeld = Promise.withResolvers<void>();
    let holdGeometry = false;
    const tab = (id: string) => {
      const cdp = new FakeCdpSession();
      let painted = false;
      const surface = { active: false, documentId: id, geometryRevision: 1, id, loading: false };
      const size = { height: 600, width: 800 };
      const page = {
        applyGeometry: async () => undefined,
        // Its first paint comes at once; after that a still page paints nothing more, and a
        // wait for a paint lasts the paint limit unless it is canceled.
        settleRendering: (signal?: AbortSignal) => {
          if (!painted || id === "b") {
            painted = true;
            return Promise.resolve();
          }
          return new Promise<void>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new BrowserPaintTimeoutError("paint wait timed out")),
              paintLimitMs,
            );
            signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(signal.reason);
            });
          });
        },
      };
      return { cdp, page, size, surface };
    };
    const a = tab("a");
    const b = tab("b");
    let shown = a;
    const listeners = new Set<(event: unknown) => void>();
    const emit = (event: unknown) => {
      for (const listener of listeners) listener(event);
    };
    const bindingOf = (t: typeof a) => ({ cdp: t.cdp, page: t.page, surface: t.surface });
    const ledger = {
      active: () => bindingOf(shown),
      binding: (id: string) => bindingOf(id === "a" ? a : b),
      dialogOf: () => null,
      dialogOpen: () => false,
      recordPageScale: () => undefined,
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      use: <T>(_id: string, operation: () => Promise<T>) => operation(),
      viewportOf: (id: string) => (id === "a" ? a : b).size,
      // Tab A's dialog holds its geometry while the person turns away.
      withGeometry: async <T>(id: string, operation: () => Promise<T>) => {
        if (id === "a" && holdGeometry) await geometryHeld.promise;
        return operation();
      },
    };
    const follow = new ScreencastController({
      frames: new LatestFrameStream({ sendFrame: async () => undefined }),
      ledger: ledger as never,
      onDialogChanged: () => undefined,
    });
    const starts = (t: typeof a) =>
      t.cdp.sent.filter(({ method }) => method === "Page.startScreencast").length;
    await follow.start();
    await follow.setStreaming(true);
    await vi.waitFor(() => expect(starts(a)).toBe(1));
    // Tab A is sized anew while its dialog holds its geometry: its restart waits there, and a
    // second restart queues behind it.
    holdGeometry = true;
    a.size = { height: 700, width: 900 };
    a.surface.geometryRevision += 1;
    emit({ change: "updated", surface: { ...a.surface }, type: "changed" });
    await new Promise((resolve) => setImmediate(resolve));
    a.size = { height: 720, width: 920 };
    a.surface.geometryRevision += 1;
    emit({ change: "updated", surface: { ...a.surface }, type: "changed" });
    // The person turns to tab B, then A's dialog is answered and its geometry let go.
    shown = b;
    b.surface.active = true;
    a.surface.active = false;
    const turnedAt = performance.now();
    emit({ change: "updated", surface: { ...b.surface }, type: "changed" });
    geometryHeld.resolve();
    await vi.waitFor(() => expect(starts(b)).toBe(1), { timeout: 1_000 });
    expect(performance.now() - turnedAt).toBeLessThan(paintLimitMs);
    await follow.close();
  });
});

/*
 * The walker's eight runs on 4ecf539ae, `never-shown-tab` failing in four: a tab the person opens
 * with an address is not yet attached to a page when the follow view first asks it for a picture.
 * Chromium refused each start ("Not attached to an active page") and the follow view deferred it
 * for the navigation, but every trigger that came before the page could take one sent another
 * start into the same unattached page: four starts in 3 ms, the last answered once the document
 * committed about 40 ms later.
 */
describe("the follow view, when a tab it is shown is not attached to a page yet", async () => {
  const { ScreencastController } = await import("./screencast-controller.js");
  const { LatestFrameStream } = await import("../stream/latest-frame-stream.js");
  const { FakeCdpSession } = await import("../test-support/fakes.js");
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /** A tab opened with an address, loading its first document, which Chromium has not attached. */
  async function opening() {
    const cdp = new FakeCdpSession();
    let attached = false;
    /** Each start sent, by whether the page was attached to take it. */
    const sent: boolean[] = [];
    cdp.responses.set("Page.startScreencast", () => {
      sent.push(attached);
      if (!attached) throw new Error("Not attached to an active page");
      return {};
    });
    const surface = {
      active: true,
      documentId: "a",
      geometryRevision: 0,
      id: "tab",
      loading: true,
    };
    let size = { height: 600, width: 800 };
    let capture = { height: 600, rasterScale: 1, revision: 1, width: 800 };
    const captureListeners = new Set<() => void>();
    const page = {
      applyGeometry: async () => undefined,
      capture: {
        read: () => capture,
        subscribe: (listener: () => void) => {
          captureListeners.add(listener);
          return () => captureListeners.delete(listener);
        },
      },
      settleRendering: async () => undefined,
    };
    const binding = { cdp, page, surface };
    const listeners = new Set<(event: unknown) => void>();
    const emit = (event: unknown) => {
      for (const listener of listeners) listener(event);
    };
    const ledger = {
      active: () => binding,
      binding: () => binding,
      dialogOf: () => null,
      dialogOpen: () => false,
      recordPageScale: () => undefined,
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      use: <T>(_id: string, operation: () => Promise<T>) => operation(),
      viewportOf: () => size,
      withGeometry: <T>(_id: string, operation: () => Promise<T>) => operation(),
    };
    const follow = new ScreencastController({
      frames: new LatestFrameStream({ sendFrame: async () => undefined }),
      ledger: ledger as never,
      onDialogChanged: () => undefined,
    });
    const changed = () => emit({ change: "updated", surface: { ...surface }, type: "changed" });
    // The person's tab is shown, and streamed: the follow view binds it (`rebind`).
    await follow.start();
    await follow.setStreaming(true);
    await settle();
    return {
      follow,
      starts: () => ({
        refused: sent.filter((taken) => !taken).length,
        taken: sent.filter(Boolean).length,
      }),
      /** The surface it has bound, if any. */
      bound: () =>
        (follow as unknown as { active: { surfaceId: string } | null }).active?.surfaceId,
      /** Something about the loading page changed: its title, its address, its geometry. */
      changed: async () => {
        surface.geometryRevision += 1;
        changed();
        await settle();
      },
      /** Its initial size reached it. */
      resized: async () => {
        size = { height: 610, width: 810 };
        capture = { height: 610, rasterScale: 1, revision: capture.revision + 1, width: 810 };
        surface.geometryRevision += 1;
        for (const listener of captureListeners) listener();
        emit({ surfaceId: "tab", type: "resized" });
        await settle();
      },
      /** Its first document commits, and Chromium attaches the page to it. */
      commit: async () => {
        attached = true;
        surface.documentId = "b";
        surface.geometryRevision += 1;
        changed();
        await settle();
      },
      /** Its navigation stopped without a document Chromium attached. */
      stop: async () => {
        attached = true;
        surface.loading = false;
        changed();
        await settle();
      },
    };
  }

  it("sends no further start into the unattached page, and one once its document commits", async () => {
    const tab = await opening();
    await tab.changed();
    await tab.changed();
    await tab.changed();
    expect(tab.starts()).toEqual({ refused: 1, taken: 0 });
    // The deferred start kept the tab bound: nothing has to bind it again for its commit to count.
    expect(tab.bound()).toBe("tab");
    await tab.commit();
    await vi.waitFor(() => expect(tab.starts()).toEqual({ refused: 1, taken: 1 }));
    await tab.follow.close();
  });

  it("holds its size and capture's triggers too, and starts once its navigation stops", async () => {
    const tab = await opening();
    await tab.resized();
    await tab.changed();
    expect(tab.starts()).toEqual({ refused: 1, taken: 0 });
    expect(tab.bound()).toBe("tab");
    await tab.stop();
    await vi.waitFor(() => expect(tab.starts()).toEqual({ refused: 1, taken: 1 }));
    await tab.follow.close();
  });
});

/*
 * The walker's run 3 on 4ecf539ae, stale-dialog-answers: tab B, a still page, was never pictured
 * after the person answered its dialog. Two faults, each reproduced here with a page whose only
 * frame comes with its start:
 * - A start answered while the page's capture moved left the follow view "not casting" while
 *   Chromium cast: leaving the tab sent no stop, and the next start was a join it did not know of.
 * - A frame that came with a start, before its answer was handled (Chromium's first frame, or the
 *   one frame the hub holds when it joins a running cast), was dropped: on a still page there is
 *   no other.
 */
describe("the follow view, for a still page whose one frame comes with its start", async () => {
  const { ScreencastController } = await import("./screencast-controller.js");
  const { LatestFrameStream } = await import("../stream/latest-frame-stream.js");
  const { FakeCdpSession, jpeg } = await import("../test-support/fakes.js");
  const shown = { height: 600, width: 800 };
  const frame = (id: number) => ({
    data: jpeg(shown.width, shown.height).toString("base64"),
    metadata: {
      deviceHeight: shown.height,
      deviceWidth: shown.width,
      offsetTop: 0,
      pageScaleFactor: 1,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
    },
    sessionId: id,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /**
   * `withStart` runs as Chromium takes each start, before its answer: it may send the start's frame
   * there, move the page's capture, or refuse it.
   */
  async function still(
    withStart: (start: number, tab: { moveCapture(): void; sendFrame(): void }) => void,
  ) {
    const cdp = new FakeCdpSession();
    const surface = {
      active: true,
      documentId: "a",
      geometryRevision: 1,
      id: "tab",
      loading: false,
    };
    let capture = { ...shown, rasterScale: 1, revision: 1 };
    const captureListeners = new Set<() => void>();
    const moveCapture = () => {
      capture = { ...capture, revision: capture.revision + 1 };
      for (const listener of captureListeners) listener();
    };
    let starts = 0;
    cdp.responses.set("Page.startScreencast", () => {
      starts += 1;
      const id = starts;
      withStart(id, { moveCapture, sendFrame: () => cdp.emit("Page.screencastFrame", frame(id)) });
      return {};
    });
    const page = {
      applyGeometry: async () => undefined,
      capture: {
        read: () => capture,
        subscribe: (listener: () => void) => {
          captureListeners.add(listener);
          return () => captureListeners.delete(listener);
        },
      },
      settleRendering: async () => undefined,
    };
    const binding = { cdp, page, surface };
    const ledger = {
      active: () => binding,
      binding: () => binding,
      dialogOf: () => null,
      dialogOpen: () => false,
      recordPageScale: () => undefined,
      subscribe: () => () => undefined,
      use: <T>(_id: string, operation: () => Promise<T>) => operation(),
      viewportOf: () => shown,
      withGeometry: <T>(_id: string, operation: () => Promise<T>) => operation(),
    };
    const delivered: unknown[] = [];
    const follow = new ScreencastController({
      frames: new LatestFrameStream({ sendFrame: async (sent) => void delivered.push(sent) }),
      ledger: ledger as never,
      onDialogChanged: () => undefined,
    });
    const count = (method: string) => cdp.sent.filter((sent) => sent.method === method).length;
    await follow.start();
    // A refused start is the caller's to hear of; the test reads what reached the page.
    await follow.setStreaming(true).catch(() => undefined);
    await settle();
    await settle();
    return { cdp, count, delivered, follow };
  }

  it("is casting after a start answered while its capture moved, and stops what it started when the person leaves", async () => {
    const tab = await still((start, page) => {
      if (start === 1) page.moveCapture();
    });
    // Each start Chromium answered is either running and counted so, or stopped.
    expect(tab.count("Page.startScreencast")).toBe(tab.count("Page.stopScreencast") + 1);
    await tab.follow.setStreaming(false);
    await settle();
    expect(tab.count("Page.startScreencast")).toBe(tab.count("Page.stopScreencast"));
    await tab.follow.close();
  });

  const acks = (tab: { cdp: InstanceType<typeof FakeCdpSession> }) =>
    tab.cdp.sent
      .filter((sent) => sent.method === "Page.screencastFrameAck")
      .map((sent) => sent.parameters?.sessionId);

  it("shows the frame that came with its start, before the answer, and acks it once", async () => {
    const tab = await still((_start, page) => page.sendFrame());
    await vi.waitFor(() => expect(tab.delivered).toHaveLength(1));
    expect(acks(tab)).toEqual([1]);
    await tab.follow.close();
  });

  it("drops the frame that came with a start Chromium refused, and acks it", async () => {
    const tab = await still((_start, page) => {
      page.sendFrame();
      throw new Error("Not attached to an active page");
    });
    await settle();
    expect(tab.delivered).toEqual([]);
    expect(acks(tab)).toEqual([1]);
    await tab.follow.close();
  });
});

/*
 * The walker's six runs on be9b313a5, runs 4 and 6 of never-shown-tab: three starts. The ledger
 * listed the tab's blank first document as loading, and the follow view sent it a start, refused;
 * then the real document's commit came, and the start sent at that same moment was refused too:
 * Chromium tells the page's session of a commit before its browser side takes commands for that
 * document. The answered start waited for the load to end, which on a slow page would be seconds.
 * Here the page has the navigation port the desktop app's has: it counts each navigation its
 * browser side finished, after which the committed document takes commands.
 */
describe("the follow view, on a page that says when its browser side has finished a navigation", async () => {
  const { ScreencastController } = await import("./screencast-controller.js");
  const { LatestFrameStream } = await import("../stream/latest-frame-stream.js");
  const { FakeCdpSession } = await import("../test-support/fakes.js");
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  async function navigating(options: { readonly opened: boolean }) {
    const cdp = new FakeCdpSession();
    // Whether the browser side takes commands for the page's current document.
    let active = options.opened;
    const sent: Array<{ readonly taken: boolean; readonly loading: boolean }> = [];
    const surface = {
      active: true,
      documentId: "a",
      geometryRevision: 1,
      id: "tab",
      loading: true,
      url: options.opened ? "https://example.test/one" : "about:blank",
    };
    cdp.responses.set("Page.startScreencast", () => {
      sent.push({ loading: surface.loading, taken: active });
      if (!active) throw new Error("Not attached to an active page");
      return {};
    });
    let finished = options.opened ? 1 : 0;
    const navigationListeners = new Set<() => void>();
    const capture = { height: 600, rasterScale: 1, revision: 1, width: 800 };
    const page = {
      applyGeometry: async () => undefined,
      capture: { read: () => capture, subscribe: () => () => undefined },
      navigations: {
        finished: () => finished,
        subscribe: (listener: () => void) => {
          navigationListeners.add(listener);
          return () => navigationListeners.delete(listener);
        },
      },
      settleRendering: async () => undefined,
    };
    const binding = { cdp, page, surface };
    const listeners = new Set<(event: unknown) => void>();
    const changed = () => {
      for (const listener of listeners)
        listener({ change: "updated", surface: { ...surface }, type: "changed" });
    };
    const ledger = {
      active: () => binding,
      binding: () => binding,
      dialogOf: () => null,
      dialogOpen: () => false,
      recordPageScale: () => undefined,
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      use: <T>(_id: string, operation: () => Promise<T>) => operation(),
      viewportOf: () => ({ height: 600, width: 800 }),
      withGeometry: <T>(_id: string, operation: () => Promise<T>) => operation(),
    };
    const follow = new ScreencastController({
      frames: new LatestFrameStream({ sendFrame: async () => undefined }),
      ledger: ledger as never,
      onDialogChanged: () => undefined,
    });
    await follow.start();
    await follow.setStreaming(true).catch(() => undefined);
    await settle();
    return {
      follow,
      sent,
      /** The page's session hears of a new document; its browser side does not take it yet. */
      commit: async () => {
        active = false;
        surface.documentId += "+";
        surface.geometryRevision += 1;
        surface.url = "https://example.test/two";
        changed();
        await settle();
      },
      /** The browser side's end of the navigation: the committed document takes commands. */
      navigated: async () => {
        active = true;
        finished += 1;
        for (const listener of navigationListeners) listener();
        await settle();
      },
      /** Something else about the loading page changed. */
      changed: async () => {
        surface.geometryRevision += 1;
        changed();
        await settle();
      },
    };
  }

  it("sends a tab opened with an address no start before its first document can take one", async () => {
    const tab = await navigating({ opened: false });
    await tab.changed();
    await tab.commit();
    await tab.changed();
    expect(tab.sent).toEqual([]);
    await tab.navigated();
    await vi.waitFor(() => expect(tab.sent).toEqual([{ loading: true, taken: true }]));
    await tab.follow.close();
  });

  it("sends a start refused at a commit again once the navigation finished, while the page still loads", async () => {
    const tab = await navigating({ opened: true });
    await vi.waitFor(() => expect(tab.sent).toHaveLength(1));
    // The person turns away and back as it navigates: the start goes out at the commit, refused.
    await tab.commit();
    await tab.follow.setStreaming(false);
    const turned = tab.sent.length;
    await tab.follow.setStreaming(true).catch(() => undefined);
    await settle();
    await tab.changed();
    expect(tab.sent.slice(turned)).toEqual([{ loading: true, taken: false }]);
    await tab.navigated();
    // The answered start goes out at the navigation's end, with the page still loading.
    await vi.waitFor(() =>
      expect(tab.sent.slice(turned)).toEqual([
        { loading: true, taken: false },
        { loading: true, taken: true },
      ]),
    );
    await tab.follow.close();
  });
});

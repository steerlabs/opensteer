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
      bound: () => (follow as unknown as { bound: { id: string } | null }).bound?.id,
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
    // A tab opened with an address is navigating to its first document from the start.
    let pending = !options.opened;
    let blankDocument = !options.opened;
    const navigationListeners = new Set<() => void>();
    const capture = { height: 600, rasterScale: 1, revision: 1, width: 800 };
    const page = {
      applyGeometry: async () => undefined,
      capture: { read: () => capture, subscribe: () => () => undefined },
      navigations: {
        read: () => ({ blankDocument, finished, pending }),
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
        pending = true;
        surface.documentId += "+";
        surface.geometryRevision += 1;
        surface.url = "https://example.test/two";
        changed();
        await settle();
      },
      /** The browser side's end of the navigation: the committed document takes commands. */
      navigated: async () => {
        active = true;
        pending = false;
        blankDocument = false;
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

/*
 * The reader's re-check of e67033f5f..5ebc2cbbd, findings 1 to 3 and question D, each as its own
 * sequence on a stand-in: two tabs, a start Chromium answers when the test says, a frame that
 * comes with it before the answer, a page's paint the test releases.
 */
describe("the follow view, in the reader's sequences on 5ebc2cbbd", async () => {
  const { ScreencastController } = await import("./screencast-controller.js");
  const { LatestFrameStream } = await import("../stream/latest-frame-stream.js");
  const { FakeCdpSession, jpeg } = await import("../test-support/fakes.js");
  const settle = async () => {
    for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const shown = { height: 600, width: 800 };

  function stage(options: { readonly port?: boolean; readonly loadingB?: boolean } = {}) {
    let frameId = 0;
    const tab = (id: "a" | "b") => {
      const cdp = new FakeCdpSession();
      const answers: Array<() => void> = [];
      const control = {
        answerLater: false,
        attached: true,
        /** Chromium's frame for a start, sent before its answer: as it does, and a hub joining. */
        frameWithStart: true,
        starts: [] as Array<{ readonly refused: boolean }>,
      };
      const frame = () => ({
        data: jpeg(shown.width, shown.height).toString("base64"),
        metadata: { deviceHeight: shown.height, deviceWidth: shown.width },
        sessionId: ++frameId,
      });
      cdp.responses.set("Page.startScreencast", async () => {
        if (!control.attached) {
          control.starts.push({ refused: true });
          throw new Error("Not attached to an active page");
        }
        control.starts.push({ refused: false });
        if (control.frameWithStart) cdp.emit("Page.screencastFrame", frame());
        if (control.answerLater) await new Promise<void>((resolve) => answers.push(resolve));
        return {};
      });
      let capture: { height: number; rasterScale: number; revision: number; width: number } | null =
        { ...shown, rasterScale: 1, revision: 1 };
      const captureListeners = new Set<() => void>();
      let navigation = { blankDocument: false, finished: 1, pending: false };
      const navigationListeners = new Set<() => void>();
      let paint: Promise<void> | null = null;
      const surface = {
        active: id === "a",
        documentId: `${id}1`,
        geometryRevision: 1,
        id,
        loading: id === "b" && options.loadingB === true,
      };
      const page = {
        applyGeometry: async () => undefined,
        capture: {
          read: () => capture,
          subscribe: (listener: () => void) => {
            captureListeners.add(listener);
            return () => captureListeners.delete(listener);
          },
        },
        ...(options.port
          ? {
              navigations: {
                read: () => navigation,
                subscribe: (listener: () => void) => {
                  navigationListeners.add(listener);
                  return () => navigationListeners.delete(listener);
                },
              },
            }
          : {}),
        settleRendering: (signal?: AbortSignal) =>
          paint
            ? Promise.race([
                paint,
                new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve())),
              ])
            : Promise.resolve(),
      };
      return {
        answer: () => {
          for (const resolve of answers.splice(0)) resolve();
        },
        captureListeners,
        cdp,
        control,
        frame,
        holdPaint: () => {
          const painted = Promise.withResolvers<void>();
          paint = painted.promise;
          return () => {
            paint = null;
            painted.resolve();
          };
        },
        navigate: (next: Partial<typeof navigation>) => {
          navigation = { ...navigation, ...next };
          for (const listener of navigationListeners) listener();
        },
        page,
        setCapture: (next: typeof capture) => {
          capture = next;
          for (const listener of captureListeners) listener();
        },
        surface,
      };
    };
    const a = tab("a");
    const b = tab("b");
    const tabs = { a, b };
    let inView: "a" | "b" = "a";
    const listeners = new Set<(event: unknown) => void>();
    const emit = (event: unknown) => {
      for (const listener of listeners) listener(event);
    };
    const bindingOf = (id: "a" | "b") => ({
      cdp: tabs[id].cdp,
      page: tabs[id].page,
      surface: { ...tabs[id].surface, active: inView === id },
    });
    const ledger = {
      active: () => bindingOf(inView),
      binding: (id: "a" | "b") => bindingOf(id),
      dialogOf: () => null,
      dialogOpen: () => false,
      recordPageScale: () => undefined,
      subscribe: (listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      use: <T>(_id: string, operation: () => Promise<T>) => operation(),
      viewportOf: () => shown,
      withGeometry: <T>(_id: string, operation: () => Promise<T>) => operation(),
    };
    const delivered: Array<{ header: { surfaceId: string } }> = [];
    const follow = new ScreencastController({
      frames: new LatestFrameStream({
        sendFrame: async (sent) => void delivered.push(sent as never),
      }),
      ledger: ledger as never,
      onDialogChanged: () => undefined,
    });
    const snapshot = () =>
      emit({ surfaces: [bindingOf("a").surface, bindingOf("b").surface], type: "snapshot" });
    return {
      a,
      b,
      delivered,
      follow,
      changed: (id: "a" | "b") =>
        emit({ change: "updated", surface: bindingOf(id).surface, type: "changed" }),
      pictured: (id: "a" | "b") =>
        delivered.filter((frame) => frame.header.surfaceId === id).length,
      turnTo: (id: "a" | "b") => {
        inView = id;
        snapshot();
      },
    };
  }

  it("finding 1: pictures A after the person turns to B and back while A's start is prepared, in one burst or two", async () => {
    for (const bursts of [1, 2]) {
      const view = stage();
      const painted = view.a.holdPaint();
      await view.follow.start();
      void view.follow.setStreaming(true);
      await settle();
      view.turnTo("b");
      if (bursts === 2) await settle();
      view.turnTo("a");
      painted();
      await settle();
      expect(view.pictured("a"), `${bursts} bursts`).toBeGreaterThan(0);
      await view.follow.close();
    }
  });

  // Re-check 9, R3: the frame that came with the start before the same-size commit is the old
  // document's, and is dropped; the new document's own paint is its picture.
  it("finding 2.1: shows the new document's paint, never the old one's frame, after a same-size commit overtook its start", async () => {
    for (const paints of [false, true]) {
      const view = stage();
      view.a.control.answerLater = true;
      await view.follow.start();
      void view.follow.setStreaming(true);
      await settle();
      view.a.surface.documentId = "a2";
      view.a.surface.geometryRevision = 2;
      view.changed("a");
      await settle();
      // The new document paints into the cast Chromium runs.
      if (paints) view.a.cdp.emit("Page.screencastFrame", view.a.frame());
      await settle();
      view.a.answer();
      await settle();
      expect(view.pictured("a"), paints ? "the new document's paint" : "no paint").toBe(
        paints ? 1 : 0,
      );
      await view.follow.close();
    }
  });

  it("finding 2.2: shows the frame that came with a start while the capture was let go and came back the same", async () => {
    const view = stage();
    view.a.control.answerLater = true;
    await view.follow.start();
    void view.follow.setStreaming(true);
    await settle();
    view.a.setCapture(null);
    view.a.setCapture({ ...shown, rasterScale: 1, revision: 1 });
    await settle();
    view.a.answer();
    await settle();
    expect(view.pictured("a")).toBe(1);
    await view.follow.close();
  });

  it("finding 2.3: shows the frame that came with a start the person paused and resumed", async () => {
    const view = stage();
    view.a.control.answerLater = true;
    await view.follow.start();
    void view.follow.setStreaming(true);
    await settle();
    void view.follow.setStreaming(false);
    void view.follow.setStreaming(true);
    await settle();
    view.a.answer();
    await settle();
    expect(view.pictured("a")).toBeGreaterThan(0);
    await view.follow.close();
  });

  it("finding 3: a tab announced not yet loading, its first document pending, gets no start until it can take one, and stays bound after a refusal", async () => {
    const view = stage({ loadingB: false, port: true });
    view.b.control.attached = false;
    view.b.navigate({ blankDocument: true, finished: 1, pending: true });
    await view.follow.start();
    void view.follow.setStreaming(true);
    await settle();
    view.turnTo("b");
    await settle();
    expect(view.b.control.starts).toEqual([]);
    view.b.control.attached = true;
    view.b.navigate({ blankDocument: false, finished: 2, pending: false });
    await settle();
    expect(view.b.control.starts).toEqual([{ refused: false }]);
    expect(view.pictured("b")).toBe(1);
    // A refusal outside any navigation, as the person turns to the tab, leaves it bound: the
    // next navigation's end starts it, with nothing else happening.
    view.turnTo("a");
    await settle();
    view.b.control.attached = false;
    view.turnTo("b");
    await settle();
    expect(view.b.control.starts.at(-1)).toEqual({ refused: true });
    expect((view.follow as unknown as { bound: { id: string } | null }).bound?.id).toBe("b");
    view.b.control.attached = true;
    view.b.navigate({ finished: 3 });
    await settle();
    expect(view.b.control.starts.at(-1)).toEqual({ refused: false });
    expect(view.pictured("b")).toBe(2);
    await view.follow.close();
  });

  it("question D: opening a tab with an address on the desktop sends one start; one refused at a commit costs one more", async () => {
    const view = stage({ loadingB: true, port: true });
    view.b.control.attached = false;
    view.b.navigate({ blankDocument: true, finished: 1, pending: true });
    await view.follow.start();
    void view.follow.setStreaming(true);
    await settle();
    view.turnTo("b");
    // The document commits; its page's session hears of it before the browser side takes it.
    view.b.surface.documentId = "b2";
    view.b.surface.geometryRevision = 2;
    view.changed("b");
    await settle();
    view.b.control.attached = true;
    view.b.navigate({ blankDocument: false, finished: 2, pending: false });
    await settle();
    expect(view.b.control.starts).toEqual([{ refused: false }]);
    // A start refused while a later navigation commits goes out again at that navigation's end.
    void view.follow.setStreaming(false);
    await settle();
    view.b.control.attached = false;
    view.b.navigate({ pending: true });
    void view.follow.setStreaming(true).catch(() => undefined);
    await settle();
    view.b.control.attached = true;
    view.b.navigate({ finished: 3, pending: false });
    await settle();
    expect(view.b.control.starts.slice(1)).toEqual([{ refused: true }, { refused: false }]);
    await view.follow.close();
  });
});

/*
 * Every restart has a bound. A page whose frames never fit the region they are cast for is repaired
 * a few times with no picture shown (three; a page sized natively, once), then its cast stops, the
 * person keeps the last picture they had, and the follow view says the capture does not match. It
 * casts that page again only when what it would cast changes.
 */
describe("the follow view, on a page whose frames never fit", async () => {
  const { ScreencastController } = await import("./screencast-controller.js");
  const { LatestFrameStream } = await import("../stream/latest-frame-stream.js");
  const { FakeCdpSession, jpeg } = await import("../test-support/fakes.js");
  const { pictureLimit } = await import("./screencast-plan.js");
  const settle = async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  for (const native of [false, true])
    it(`stops after its bound and says so (${native ? "sized natively" : "sized by command"})`, async () => {
      const cdp = new FakeCdpSession();
      let size = { height: 600, width: 800 };
      let fitting = true;
      let frameId = 0;
      // Each start's one frame: of the page's size while it fits, of another size after.
      cdp.responses.set("Page.startScreencast", () => {
        const drawn = fitting ? size : { height: size.height + 50, width: size.width + 100 };
        // Chromium's frame for a start, once its answer is handled.
        setImmediate(() =>
          cdp.emit("Page.screencastFrame", {
            data: jpeg(drawn.width, drawn.height).toString("base64"),
            metadata: { deviceHeight: drawn.height, deviceWidth: drawn.width },
            sessionId: ++frameId,
          }),
        );
        return {};
      });
      const surface = {
        active: true,
        documentId: "a",
        geometryRevision: 1,
        id: "tab",
        loading: false,
      };
      const page = native
        ? {
            applyGeometry: async () => undefined,
            capture: {
              read: () => ({ ...size, rasterScale: 1, revision: surface.geometryRevision }),
              subscribe: () => () => undefined,
            },
            invalidateSurface: async () => undefined,
            settleRendering: async () => undefined,
          }
        : { invalidateSurface: async () => undefined, settleRendering: async () => undefined };
      const binding = { cdp, page, surface };
      const listeners = new Set<(event: unknown) => void>();
      const errors: string[] = [];
      const delivered: unknown[] = [];
      const follow = new ScreencastController({
        frames: new LatestFrameStream({ sendFrame: async (sent) => void delivered.push(sent) }),
        ledger: {
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
        } as never,
        onDialogChanged: () => undefined,
        onError: (error) => errors.push(error.reason ?? error.message),
      });
      const starts = () =>
        cdp.sent.filter(({ method }) => method === "Page.startScreencast").length;
      await follow.start();
      await follow.setStreaming(true);
      await settle();
      expect(delivered).toHaveLength(1);
      // From here the view is not at the size it is cast at: every frame is of another.
      fitting = false;
      const before = starts();
      cdp.emit("Page.screencastFrame", {
        data: jpeg(900, 650).toString("base64"),
        metadata: { deviceHeight: 650, deviceWidth: 900 },
        sessionId: ++frameId,
      });
      await settle();
      const repairs = pictureLimit(native);
      expect(starts() - before).toBe(repairs);
      expect(errors).toEqual(["browser-capture-mismatch"]);
      // The cast stopped, and the person kept the last picture they had.
      expect(cdp.sent.at(-1)?.method).toBe("Page.stopScreencast");
      expect(delivered).toHaveLength(1);
      // Nothing more is tried for that cast; another size asks again.
      await settle();
      expect(starts() - before).toBe(repairs);
      fitting = true;
      size = { height: 700, width: 900 };
      surface.geometryRevision += 1;
      for (const listener of listeners)
        listener({ change: "updated", surface: { ...surface }, type: "changed" });
      await settle();
      expect(starts() - before).toBe(repairs + 1);
      expect(delivered).toHaveLength(2);
      await follow.close();
    });
});

/*
 * Re-check 9, R7: three sequences, each with its own test. Chromium gone while a start it never
 * answers holds a caller on the follow view; a dialog opening while Chromium sizes the view for a
 * start; and a picture the viewers could not take (a crop they did not show) followed by the
 * viewers saying they can.
 */
describe("the follow view, in re-check 9's sequences (R7)", async () => {
  const { ScreencastController } = await import("./screencast-controller.js");
  const { LatestFrameStream } = await import("../stream/latest-frame-stream.js");
  const { FakeCdpSession, jpeg } = await import("../test-support/fakes.js");
  const settle = async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  function stage(page: Record<string, unknown>, size = { height: 600, width: 800 }) {
    const cdp = new FakeCdpSession();
    const surface = {
      active: true,
      documentId: "a",
      geometryRevision: 1,
      id: "tab",
      loading: false,
    };
    const binding = { cdp, page, surface };
    const listeners = new Set<(event: unknown) => void>();
    let dialog = false;
    const delivered: Array<{ header: { capture?: unknown } }> = [];
    const errors: string[] = [];
    const follow = new ScreencastController({
      frames: new LatestFrameStream({
        sendFrame: async (sent) => void delivered.push(sent as never),
      }),
      ledger: {
        active: () => binding,
        binding: () => binding,
        dialogOf: () => null,
        dialogOpen: () => dialog,
        recordPageScale: () => undefined,
        subscribe: (listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        use: <T>(_id: string, operation: () => Promise<T>) => operation(),
        viewportOf: () => size,
        withGeometry: <T>(_id: string, operation: () => Promise<T>) => operation(),
      } as never,
      onDialogChanged: () => undefined,
      onError: (error) => errors.push(error.reason ?? error.message),
    });
    return {
      cdp,
      delivered,
      errors,
      follow,
      openDialog: () => {
        dialog = true;
        for (const listener of listeners) listener({ surfaceId: "tab", type: "dialog-event" });
        for (const listener of listeners)
          listener({ change: "updated", surface: { ...surface }, type: "changed" });
      },
      starts: () => cdp.sent.filter(({ method }) => method === "Page.startScreencast").length,
    };
  }

  it("lets a caller waiting on it go when Chromium is gone with a start it never answered", async () => {
    const view = stage({ settleRendering: async () => undefined });
    view.cdp.responses.set("Page.startScreencast", () => new Promise(() => undefined));
    await view.follow.start();
    let settled = false;
    void view.follow.setStreaming(true).finally(() => {
      settled = true;
    });
    await settle();
    expect(view.starts()).toBe(1);
    expect(settled).toBe(false);
    view.follow.abort();
    await settle();
    expect(settled).toBe(true);
  });

  it("sends no start when a dialog opened while Chromium sized the view for it", async () => {
    const view = stage({ settleRendering: async () => undefined });
    const sized = Promise.withResolvers<void>();
    let sizing = false;
    view.cdp.responses.set("Emulation.setVisibleSize", async () => {
      sizing = true;
      await sized.promise;
      return {};
    });
    await view.follow.start();
    void view.follow.setStreaming(true).catch(() => undefined);
    await settle();
    expect(sizing).toBe(true);
    view.openDialog();
    await settle();
    sized.resolve();
    await settle();
    expect(view.starts()).toBe(0);
    await view.follow.close();
  });

  it("pictures a cropped page once the viewers can show its region, after its frame was dropped", async () => {
    const region = { height: 300, width: 400 };
    const view = stage({
      applyGeometry: async () => undefined,
      capture: {
        read: () => ({ ...region, rasterScale: 1, revision: 1 }),
        subscribe: () => () => undefined,
      },
      settleRendering: async () => undefined,
    });
    let frameId = 0;
    // A still page: each start's one frame, of the capture's region.
    view.cdp.responses.set("Page.startScreencast", () => {
      setImmediate(() =>
        view.cdp.emit("Page.screencastFrame", {
          data: jpeg(region.width, region.height).toString("base64"),
          metadata: { deviceHeight: region.height, deviceWidth: region.width },
          sessionId: ++frameId,
        }),
      );
      return {};
    });
    await view.follow.start();
    await view.follow.setStreaming(true, false);
    await settle();
    // The viewers do not show a region: the frame is dropped, and they are told why.
    expect(view.delivered).toHaveLength(0);
    expect(view.errors).toEqual(["browser-capture-region-unsupported"]);
    await view.follow.setStreaming(true, true);
    await settle();
    expect(view.delivered).toHaveLength(1);
    expect(view.delivered[0]?.header.capture).toEqual({ ...region, revision: 1 });
    await view.follow.close();
  });
});

/*
 * Re-check 10, finding 1: when the engine ends a session's casts, the session's stops end with
 * them and the start in flight is let go (S1). Before, the follow view's own count of stops kept
 * every frame of the next cast dropped, and a pause waited on the start no one answered.
 */
describe("the follow view, when the engine ends the casts of a session it holds work on", async () => {
  const { ScreencastController } = await import("./screencast-controller.js");
  const { LatestFrameStream } = await import("../stream/latest-frame-stream.js");
  const { FakeCdpSession, jpeg } = await import("../test-support/fakes.js");
  const { screencastEndedEvent } = await import("./backend.js");
  const settle = async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const shown = { height: 600, width: 800 };

  function stage() {
    const cdp = new FakeCdpSession();
    let frameId = 0;
    const held = { starts: false, stops: false };
    const answers: Array<() => void> = [];
    const hold = (which: "starts" | "stops") =>
      held[which] ? new Promise<void>((resolve) => answers.push(resolve)) : Promise.resolve();
    let size = { ...shown };
    cdp.responses.set("Page.startScreencast", async () => {
      // A still page: the start's one frame, of the page as it is, once it is taken.
      const drawn = size;
      setImmediate(() =>
        cdp.emit("Page.screencastFrame", {
          data: jpeg(drawn.width, drawn.height).toString("base64"),
          metadata: { deviceHeight: drawn.height, deviceWidth: drawn.width },
          sessionId: ++frameId,
        }),
      );
      await hold("starts");
      return {};
    });
    cdp.responses.set("Page.stopScreencast", async () => {
      await hold("stops");
      return {};
    });
    const surface = {
      active: true,
      documentId: "a",
      geometryRevision: 1,
      id: "tab",
      loading: false,
    };
    const page = {
      applyGeometry: async () => undefined,
      capture: {
        read: () => ({ ...size, rasterScale: 1, revision: surface.geometryRevision }),
        subscribe: () => () => undefined,
      },
      settleRendering: async () => undefined,
    };
    const binding = { cdp, page, surface };
    const listeners = new Set<(event: unknown) => void>();
    const delivered: unknown[] = [];
    const follow = new ScreencastController({
      frames: new LatestFrameStream({ sendFrame: async (sent) => void delivered.push(sent) }),
      ledger: {
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
      } as never,
      onDialogChanged: () => undefined,
    });
    return {
      answer: () => {
        for (const resolve of answers.splice(0)) resolve();
      },
      cdp,
      delivered,
      follow,
      held,
      resize: () => {
        size = { height: 700, width: 900 };
        surface.geometryRevision += 1;
        for (const listener of listeners)
          listener({ change: "updated", surface: { ...surface }, type: "changed" });
      },
      starts: () => cdp.sent.filter(({ method }) => method === "Page.startScreencast").length,
      stops: () => cdp.sent.filter(({ method }) => method === "Page.stopScreencast").length,
    };
  }

  it("pictures the next cast at once when the engine ended them while a stop was unanswered", async () => {
    const view = stage();
    await view.follow.start();
    await view.follow.setStreaming(true);
    await settle();
    expect(view.delivered).toHaveLength(1);
    // A restart's stop that Chromium holds, and then the engine ends the session's casts.
    view.held.stops = true;
    view.resize();
    await settle();
    view.cdp.emit(screencastEndedEvent, {});
    await settle();
    // The next cast starts, and its frame is shown: the unanswered stop is settled with the casts.
    expect(view.starts()).toBe(2);
    expect(view.delivered).toHaveLength(2);
    await view.follow.close();
  });

  it("answers a pause at once when the engine ended them while a start was unanswered", async () => {
    const view = stage();
    view.held.starts = true;
    await view.follow.start();
    void view.follow.setStreaming(true).catch(() => undefined);
    await settle();
    expect(view.starts()).toBe(1);
    view.cdp.emit(screencastEndedEvent, {});
    let paused = false;
    void view.follow.setStreaming(false).then(() => {
      paused = true;
    });
    await settle();
    expect(paused).toBe(true);
    await view.follow.close();
  });

  // Re-check 11, finding 2 (U2): as the follow view's own protection whatever the hub does, a
  // start whose answer arrives after the state abandoned it (casts-ended followed by pause or a
  // new start) is followed by a stop through the session state, so no cast runs unknown to state.
  it("stops an abandoned start whose answer arrives after casts-ended and a pause", async () => {
    const view = stage();
    view.held.starts = true;
    await view.follow.start();
    void view.follow.setStreaming(true).catch(() => undefined);
    await settle();
    expect(view.starts()).toBe(1);
    expect(view.stops()).toBe(0);
    // The engine's notice arrives without failing the held start, then the person pauses.
    view.cdp.emit(screencastEndedEvent, {});
    await view.follow.setStreaming(false);
    await settle();
    expect(view.stops()).toBe(0);
    // Now the abandoned start unexpectedly answers: the follow view stops that orphaned cast.
    view.answer();
    await settle();
    expect(view.stops()).toBe(1);
    await view.follow.close();
  });
});

/*
 * Re-check 9, R1: the state of a bound tab has one writer, the pure `after` in screencast-plan.ts.
 * The controller turns what happened into an event and stores what `after` returns; it never sets
 * a field of that state itself.
 */
describe("the follow view's state", () => {
  it("is written only by after", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./screencast-controller.ts", import.meta.url), "utf8");
    const lines = source.split("\n");
    const assignments = lines.flatMap((line, index) => {
      const where = `screencast-controller.ts:${index + 1}: ${line.trim()}`;
      // A field of a state set in place, or a state stored from anything but `after`.
      if (/\bstate\.\w+\s*(?:=(?!=)|\+=|-=|\+\+|--)/u.test(line)) return [where];
      if (/\.state\s*=(?!=)/u.test(line) && !/\.state\s*=\s*after\(/u.test(line)) return [where];
      return [];
    });
    expect(assignments).toEqual([]);
    // And it is stored in one place.
    expect(lines.filter((line) => /\.state\s*=\s*after\(/u.test(line))).toHaveLength(1);
  });
});

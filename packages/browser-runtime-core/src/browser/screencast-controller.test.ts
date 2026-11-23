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
 * Re-check 11, finding 3 (U3): once the cast's key moves on (e.g. a resize), `observed` clears a
 * stale paint backoff so `reconcile` re-acquires `retainRendering()` and cancels the old timer.
 */
describe("the follow view, when a paint-timed-out tab moves to a new size (U3)", async () => {
  const { ScreencastController } = await import("./screencast-controller.js");
  const { LatestFrameStream } = await import("../stream/latest-frame-stream.js");
  const { FakeCdpSession } = await import("../test-support/fakes.js");
  const { BrowserPaintTimeoutError } = await import("./backend.js");
  const settle = async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  it("restores retainRendering and clears the old paint timer when the tab resizes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const cdp = new FakeCdpSession();
      let retained = 0;
      (cdp as unknown as { retainRendering: () => () => void }).retainRendering = () => {
        retained += 1;
        return () => {
          retained -= 1;
        };
      };
      let size = { height: 600, width: 800 };
      const surface = {
        active: true,
        documentId: "a",
        geometryRevision: 1,
        id: "tab",
        loading: false,
      };
      let failPaint = true;
      const holdStart = Promise.withResolvers<void>();
      cdp.responses.set("Page.startScreencast", async () => {
        await holdStart.promise;
        return {};
      });
      const page = {
        applyGeometry: async () => undefined,
        settleRendering: async () => {
          if (failPaint) throw new BrowserPaintTimeoutError("stalled");
        },
      };
      const binding = { cdp, page, surface };
      const listeners = new Set<(event: unknown) => void>();
      const follow = new ScreencastController({
        frames: new LatestFrameStream({ sendFrame: async () => undefined }),
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
      await follow.start();
      await follow.setStreaming(true);
      await settle();
      // Paint timed out: rendering demand was released and the 1 s backoff timer is armed.
      expect(retained).toBe(0);
      expect(vi.getTimerCount()).toBe(1);
      // Resize before the backoff fires; the new start holds on Chromium.
      failPaint = false;
      size = { height: 700, width: 900 };
      surface.geometryRevision = 2;
      for (const listener of listeners)
        listener({ change: "updated", surface: { ...surface }, type: "changed" });
      await settle();
      // Stale paint wait must be cleared: rendering demand is back on and old timer is gone.
      expect(retained).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      holdStart.resolve();
      await settle();
      await follow.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

/*
 * Re-check 11, finding 4 (U4): a stop that timed out keeps its attempt count across a resize or
 * rebind (including when the stop times out while the tab is unbound), and stop timers are cleared
 * on `close()` and `abort()` by `reconcile`.
 */
describe("the follow view, when a stop times out or the controller shuts down (U4)", async () => {
  const { ScreencastController } = await import("./screencast-controller.js");
  const { LatestFrameStream } = await import("../stream/latest-frame-stream.js");
  const { FakeCdpSession, jpeg } = await import("../test-support/fakes.js");
  const settle = async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  function makeTabs() {
    let frameId = 0;
    const makeTab = (id: "a" | "b") => {
      const cdp = new FakeCdpSession();
      let size = { height: 600, width: 800 };
      let hangStop = false;
      let emitMisfit = false;
      cdp.responses.set("Page.startScreencast", () => {
        const drawn = emitMisfit ? { height: size.height + 50, width: size.width + 100 } : size;
        setImmediate(() =>
          cdp.emit("Page.screencastFrame", {
            data: jpeg(drawn.width, drawn.height).toString("base64"),
            metadata: { deviceHeight: drawn.height, deviceWidth: drawn.width },
            sessionId: ++frameId,
          }),
        );
        return {};
      });
      cdp.responses.set("Page.stopScreencast", () =>
        hangStop ? new Promise(() => undefined) : Promise.resolve({}),
      );
      const surface = {
        active: id === "a",
        documentId: `${id}1`,
        geometryRevision: 1,
        id,
        loading: false,
      };
      const page = {
        applyGeometry: async () => undefined,
        capture: {
          read: () => ({ ...size, rasterScale: 1, revision: surface.geometryRevision }),
          subscribe: () => () => undefined,
        },
        invalidateSurface: async () => undefined,
        settleRendering: async () => undefined,
      };
      return {
        cdp,
        page,
        setEmitMisfit: (value: boolean) => {
          emitMisfit = value;
        },
        setHangStop: (value: boolean) => {
          hangStop = value;
        },
        setSize: (next: { height: number; width: number }) => {
          size = next;
          surface.geometryRevision += 1;
        },
        size: () => size,
        surface,
      };
    };
    const a = makeTab("a");
    const b = makeTab("b");
    let active: "a" | "b" = "a";
    const listeners = new Set<(event: unknown) => void>();
    const bindingOf = (id: "a" | "b") => {
      const t = id === "a" ? a : b;
      return { cdp: t.cdp, page: t.page, surface: { ...t.surface, active: active === id } };
    };
    const errors: string[] = [];
    const follow = new ScreencastController({
      frames: new LatestFrameStream({ sendFrame: async () => undefined }),
      ledger: {
        active: () => bindingOf(active),
        binding: (id: "a" | "b") => bindingOf(id),
        dialogOf: () => null,
        dialogOpen: () => false,
        recordPageScale: () => undefined,
        subscribe: (listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        use: <T>(_id: string, operation: () => Promise<T>) => operation(),
        viewportOf: (id: "a" | "b") => (id === "a" ? a : b).size(),
        withGeometry: <T>(_id: string, operation: () => Promise<T>) => operation(),
      } as never,
      onDialogChanged: () => undefined,
      onError: (error) => errors.push(error.reason ?? error.message),
    });
    const emit = (event: unknown) => {
      for (const listener of listeners) listener(event);
    };
    return {
      a,
      b,
      changed: (id: "a" | "b") =>
        emit({ change: "updated", surface: bindingOf(id).surface, type: "changed" }),
      errors,
      follow,
      turnTo: (id: "a" | "b") => {
        active = id;
        emit({ surfaces: [bindingOf("a").surface, bindingOf("b").surface], type: "snapshot" });
      },
    };
  }

  it("keeps a stop timeout's attempt count across a resize", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const view = makeTabs();
      await view.follow.start();
      await view.follow.setStreaming(true);
      await settle();
      // Resize while stop hangs for 5 s: the stop timeout counts as attempt 1 of the resized cast.
      view.a.setHangStop(true);
      view.a.setEmitMisfit(true);
      view.a.setSize({ height: 700, width: 900 });
      view.changed("a");
      await settle();
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      // Native limit is 1: with unpictured already 1 from the timed-out stop, one misfit gives up.
      expect(view.errors).toEqual(["browser-capture-mismatch"]);
      expect(
        view.a.cdp.sent.filter(({ method }) => method === "Page.startScreencast"),
      ).toHaveLength(2);
      await view.follow.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a stop timeout's attempt count across a rebind when the stop timed out while unbound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const view = makeTabs();
      await view.follow.start();
      await view.follow.setStreaming(true);
      await settle();
      // Turn to B while A's stop hangs; let A's stop time out while B is bound, then return to A.
      view.a.setHangStop(true);
      view.a.setEmitMisfit(true);
      view.turnTo("b");
      await settle();
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      view.turnTo("a");
      await settle();
      expect(view.errors).toEqual(["browser-capture-mismatch"]);
      expect(
        view.a.cdp.sent.filter(({ method }) => method === "Page.startScreencast"),
      ).toHaveLength(2);
      await view.follow.close();
    } finally {
      vi.useRealTimers();
    }
  });

  for (const shutdown of ["close", "abort"] as const)
    it(`clears armed stop timers on ${shutdown}()`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const view = makeTabs();
        await view.follow.start();
        await view.follow.setStreaming(true);
        await settle();
        view.a.setHangStop(true);
        view.a.setSize({ height: 700, width: 900 });
        view.changed("a");
        await settle();
        expect(vi.getTimerCount()).toBe(1);
        if (shutdown === "close") await view.follow.close();
        else view.follow.abort();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(10_000);
        await settle();
        expect(view.follow.diagnostics.some((entry) => entry.stage === "cast-stop-timeout")).toBe(
          false,
        );
      } finally {
        vi.useRealTimers();
      }
    });
});

/*
 * Re-check 11, findings 5.1 & 6.6 (U5): a Linux Emulation.setVisibleSize failure during a load is
 * held as a navigation refusal rather than spinning into failure, and onError calling abort()
 * synchronously during reconcile leaves no timer or retained rendering behind.
 */
describe("the follow view, on preparation refusal during load and synchronous abort in onError (U5)", async () => {
  const { ScreencastController } = await import("./screencast-controller.js");
  const { LatestFrameStream } = await import("../stream/latest-frame-stream.js");
  const { FakeCdpSession, jpeg } = await import("../test-support/fakes.js");
  const settle = async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  it("holds Emulation.setVisibleSize failure during load as a refusal and pictures when loading ends", async () => {
    const cdp = new FakeCdpSession();
    const size = { height: 600, width: 800 };
    const surface = {
      active: true,
      documentId: "d1",
      geometryRevision: 1,
      id: "tab",
      loading: true,
    };
    let frameId = 0;
    cdp.responses.set("Emulation.setVisibleSize", () => {
      if (surface.loading) throw new Error("Not attached to an active page");
      return {};
    });
    cdp.responses.set("Page.startScreencast", () => {
      setImmediate(() =>
        cdp.emit("Page.screencastFrame", {
          data: jpeg(size.width, size.height).toString("base64"),
          metadata: { deviceHeight: size.height, deviceWidth: size.width },
          sessionId: ++frameId,
        }),
      );
      return {};
    });
    const binding = { cdp, page: {}, surface };
    const listeners = new Set<(event: unknown) => void>();
    const delivered: unknown[] = [];
    const errors: string[] = [];
    const follow = new ScreencastController({
      frames: new LatestFrameStream({ sendFrame: async (frame) => void delivered.push(frame) }),
      ledger: {
        active: () => ({ ...binding, surface: { ...surface } }),
        binding: () => ({ ...binding, surface: { ...surface } }),
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
    await follow.start();
    await follow.setStreaming(true);
    await settle();
    // Must not spin through microtask retries or give up during load.
    expect(cdp.sent.filter(({ method }) => method === "Emulation.setVisibleSize")).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(follow.diagnostics.some((entry) => entry.stage === "cast-deferred")).toBe(true);
    expect(follow.diagnostics.some((entry) => entry.stage === "cast-failed")).toBe(false);
    // Loading ends without a new document: refusal releases, setVisibleSize succeeds, picture lands.
    surface.loading = false;
    for (const listener of listeners)
      listener({ change: "updated", surface: { ...surface }, type: "changed" });
    await settle();
    expect(cdp.sent.filter(({ method }) => method === "Emulation.setVisibleSize")).toHaveLength(2);
    expect(delivered).toHaveLength(1);
    expect(errors).toEqual([]);
    await follow.close();
  });

  it("handles onError synchronously calling abort() inside reconcile without re-arming timers or rendering", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const cdp = new FakeCdpSession();
      let retained = 0;
      (cdp as unknown as { retainRendering: () => () => void }).retainRendering = () => {
        retained += 1;
        return () => {
          retained -= 1;
        };
      };
      const size = { height: 600, width: 800 };
      const surface = {
        active: true,
        documentId: "d1",
        geometryRevision: 1,
        id: "tab",
        loading: false,
      };
      const page = {
        applyGeometry: async () => undefined,
        capture: {
          read: () => ({ ...size, rasterScale: 1, revision: 1 }),
          subscribe: () => () => undefined,
        },
        settleRendering: async () => {
          throw new Error("Electron browser page is closed.");
        },
      };
      const binding = { cdp, page, surface };
      let follow!: InstanceType<typeof ScreencastController>;
      let abortedInError = false;
      follow = new ScreencastController({
        frames: new LatestFrameStream({ sendFrame: async () => undefined }),
        ledger: {
          active: () => binding,
          binding: () => binding,
          dialogOf: () => null,
          dialogOpen: () => false,
          recordPageScale: () => undefined,
          subscribe: () => () => undefined,
          use: <T>(_id: string, operation: () => Promise<T>) => operation(),
          viewportOf: () => size,
          withGeometry: <T>(_id: string, operation: () => Promise<T>) => operation(),
        } as never,
        onDialogChanged: () => undefined,
        onError: () => {
          abortedInError = true;
          follow.abort();
        },
      });
      await follow.start();
      await follow.setStreaming(true);
      await settle();
      expect(abortedInError).toBe(true);
      expect(retained).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/*
 * Re-check 11, finding 5.2 (U6): a page that stays loading forever and never paints is given 10 s
 * (then 20 s, 40 s) to paint, repairs, and gives up at the bound instead of waiting forever; if a
 * slow page eventually finishes loading, it clears the loading-time failure and pictures.
 */
describe("the follow view, when a page loads forever and never paints (U6)", async () => {
  const { ScreencastController } = await import("./screencast-controller.js");
  const { LatestFrameStream } = await import("../stream/latest-frame-stream.js");
  const { FakeCdpSession, jpeg } = await import("../test-support/fakes.js");
  const settle = async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  for (const native of [true, false] as const)
    it(`repairs at 10 s and gives up at the bound without looping (${native ? "native" : "command-sized"})`, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const cdp = new FakeCdpSession();
        const size = { height: 600, width: 800 };
        const surface = {
          active: true,
          documentId: "d1",
          geometryRevision: 1,
          id: "tab",
          loading: true,
        };
        let invalidations = 0;
        let paintNow = false;
        let frameId = 0;
        cdp.responses.set("Page.startScreencast", () => {
          if (paintNow) {
            setImmediate(() =>
              cdp.emit("Page.screencastFrame", {
                data: jpeg(size.width, size.height).toString("base64"),
                metadata: { deviceHeight: size.height, deviceWidth: size.width },
                sessionId: ++frameId,
              }),
            );
          }
          return {};
        });
        const page = {
          ...(native
            ? {
                applyGeometry: async () => undefined,
                capture: {
                  read: () => ({ ...size, rasterScale: 1, revision: 1 }),
                  subscribe: () => () => undefined,
                },
                settleRendering: async () => undefined,
              }
            : {}),
          invalidateSurface: async () => {
            invalidations += 1;
          },
        };
        const listeners = new Set<(event: unknown) => void>();
        const delivered: unknown[] = [];
        const errors: string[] = [];
        const follow = new ScreencastController({
          frames: new LatestFrameStream({ sendFrame: async (frame) => void delivered.push(frame) }),
          ledger: {
            active: () => ({ cdp, page, surface: { ...surface } }),
            binding: () => ({ cdp, page, surface: { ...surface } }),
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
        await follow.start();
        await follow.setStreaming(true);
        await settle();
        const starts = () =>
          cdp.sent.filter(({ method }) => method === "Page.startScreencast").length;
        expect(starts()).toBe(1);
        expect(vi.getTimerCount()).toBe(1);
        // 9.9 s: still waiting, no repair yet.
        await vi.advanceTimersByTimeAsync(9_900);
        await settle();
        expect(starts()).toBe(1);
        expect(invalidations).toBe(0);
        expect(errors).toEqual([]);
        // 10 s: first timeout triggers repair #1 and restart.
        await vi.advanceTimersByTimeAsync(100);
        await settle();
        expect(invalidations).toBe(1);
        expect(starts()).toBe(2);
        expect(errors).toEqual([]);
        // Advance through the remaining backoff limits (native: +20 s; command-sized: +20 s +40 s +40 s).
        const remainingWaits = native ? [20_000] : [20_000, 40_000, 40_000];
        for (const ms of remainingWaits) {
          await vi.advanceTimersByTimeAsync(ms);
          await settle();
        }
        expect(errors).toEqual(["browser-capture-mismatch"]);
        expect(starts()).toBe(native ? 2 : 4);
        expect(invalidations).toBe(native ? 1 : 3);
        expect(vi.getTimerCount()).toBe(0);
        // Further time passes while still loading forever: no loop, no extra start or error.
        await vi.advanceTimersByTimeAsync(60_000);
        await settle();
        expect(starts()).toBe(native ? 2 : 4);
        expect(errors).toEqual(["browser-capture-mismatch"]);
        // If that slow page eventually finishes loading and paints, it recovers cleanly.
        paintNow = true;
        surface.loading = false;
        for (const listener of listeners)
          listener({ change: "updated", surface: { ...surface }, type: "changed" });
        await settle();
        expect(delivered).toHaveLength(1);
        await follow.close();
      } finally {
        vi.useRealTimers();
      }
    });

  it("keeps the armed timers equal to what the state asks for after every reconcile (paint backoff, first-frame limit, loading wait, stop answer)", async () => {
    const { BrowserPaintTimeoutError } = await import("./backend.js");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const surface = {
        active: true,
        documentId: "doc-1",
        geometryRevision: 1,
        id: "tab-1" as never,
        loading: true,
        url: "https://example.com/",
      };
      let holdStop = false;
      const stopDone = Promise.withResolvers<void>();
      let failPaintOnce = true;
      const cdp = new FakeCdpSession();
      cdp.responses.set("Page.stopScreencast", async () => {
        if (holdStop) await stopDone.promise;
        return {};
      });
      const captureListeners = new Set<() => void>();
      let capture = { height: 600, rasterScale: 1, revision: 1, width: 800 };
      const page = {
        applyGeometry: async () => undefined,
        capture: {
          read: () => capture,
          subscribe: (listener: () => void) => {
            captureListeners.add(listener);
            return () => captureListeners.delete(listener);
          },
        },
        invalidateSurface: async () => undefined,
        settleRendering: async () => {
          if (failPaintOnce) {
            failPaintOnce = false;
            throw new BrowserPaintTimeoutError();
          }
        },
      };
      const binding = { cdp, page, surface };
      const listeners = new Set<(event: unknown) => void>();
      let dialogOpen = false;
      const ledger = {
        active: () => binding,
        binding: () => binding,
        dialogOf: () => null,
        dialogOpen: () => dialogOpen,
        recordPageScale: () => undefined,
        subscribe: (listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        use: async <T>(_surfaceId: unknown, operation: () => Promise<T>) => operation(),
        viewportOf: () => ({ height: capture.height, width: capture.width }),
        withGeometry: async <T>(_surfaceId: unknown, operation: () => Promise<T>) => operation(),
      };
      const follow = new ScreencastController({
        frames: new LatestFrameStream({ sendFrame: async () => undefined }),
        ledger: ledger as never,
        onDialogChanged: () => undefined,
      });
      const internals = follow as unknown as {
        readonly bound: {
          readonly firstFrameTimer: { readonly ms: number } | null;
          readonly paintTimer: unknown;
        } | null;
        readonly stopTimers: Map<object, unknown>;
      };
      const expectTimers = (want: {
        readonly paint: boolean;
        readonly firstFrameMs: number | null;
        readonly stop: boolean;
      }) => {
        expect(internals.bound?.paintTimer !== null).toBe(want.paint);
        expect(internals.bound?.firstFrameTimer?.ms ?? null).toBe(want.firstFrameMs);
        expect(internals.stopTimers.size).toBe(want.stop ? 1 : 0);
        expect(vi.getTimerCount()).toBe(
          (want.paint ? 1 : 0) + (want.firstFrameMs !== null ? 1 : 0) + (want.stop ? 1 : 0),
        );
      };

      await follow.start();
      await follow.setStreaming(true);
      await settle();
      // 1. Paint timeout arms only the paint backoff timer.
      expectTimers({ firstFrameMs: null, paint: true, stop: false });

      // 2. Resizing clears the stale paint backoff timer and starts the loading cast (10 s timer).
      capture = { height: 700, rasterScale: 1, revision: 2, width: 900 };
      surface.geometryRevision = 2;
      for (const listener of captureListeners) listener();
      await settle();
      expectTimers({ firstFrameMs: 10_000, paint: false, stop: false });

      // 3. Loading finishes -> 10 s loading timer is replaced by 3 s first-frame timer (still 1 timer).
      surface.loading = false;
      for (const listener of listeners)
        listener({ change: "updated", surface: { ...surface }, type: "changed" });
      await settle();
      expectTimers({ firstFrameMs: 3_000, paint: false, stop: false });

      // 4. Opening a dialog clears the first-frame timer cleanly.
      dialogOpen = true;
      for (const listener of listeners)
        listener({ change: "dialog", surface: { ...surface }, type: "changed" });
      await settle();
      expectTimers({ firstFrameMs: null, paint: false, stop: false });

      // 5. Closing the dialog re-arms the 3 s first-frame timer; delivering a frame clears it.
      dialogOpen = false;
      for (const listener of listeners)
        listener({ change: "dialog", surface: { ...surface }, type: "changed" });
      await settle();
      expectTimers({ firstFrameMs: 3_000, paint: false, stop: false });
      cdp.emit("Page.screencastFrame", {
        data: jpeg(900, 700).toString("base64"),
        metadata: { deviceHeight: 700, deviceWidth: 900 },
        sessionId: 1,
      });
      await settle();
      expectTimers({ firstFrameMs: null, paint: false, stop: false });

      // 6. Pausing with an unanswered stop arms only the 5 s stop-answer timer; answering clears it.
      holdStop = true;
      const pause = follow.setStreaming(false);
      await settle();
      expectTimers({ firstFrameMs: null, paint: false, stop: true });
      stopDone.resolve();
      await pause;
      await settle();
      expectTimers({ firstFrameMs: null, paint: false, stop: false });

      await follow.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Opus review W1: a stale frame from a cast whose stop timed out is shown, but does not mark
  // a silent next cast pictured or disarm its first-frame timer.
  it("keeps the first-frame timer armed when a stale frame from a timed-out stop arrives on a silent next cast (W1)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const surface = {
        active: true,
        documentId: "doc-1",
        geometryRevision: 1,
        id: "tab-1" as never,
        loading: false,
        url: "https://example.com/",
      };
      const delivered: Buffer[] = [];
      const errors: string[] = [];
      const cdp = new FakeCdpSession();
      let starts = 0;
      const stopAnswers: Array<() => void> = [];
      cdp.responses.set("Page.startScreencast", async () => {
        starts += 1;
        return {};
      });
      cdp.responses.set("Page.stopScreencast", async () => {
        await new Promise<void>((resolve) => stopAnswers.push(resolve));
        return {};
      });
      const binding = {
        cdp,
        page: {
          applyGeometry: async () => undefined,
          capture: {
            read: () => ({ height: 600, rasterScale: 1, revision: 1, width: 800 }),
            subscribe: () => () => undefined,
          },
          invalidateSurface: async () => undefined,
          settleRendering: async () => undefined,
        },
        surface,
      };
      const ledger = {
        active: () => binding,
        binding: () => binding,
        dialogOf: () => null,
        dialogOpen: () => false,
        recordPageScale: () => undefined,
        subscribe: () => () => undefined,
        use: async <T>(_surfaceId: unknown, operation: () => Promise<T>) => operation(),
        viewportOf: () => ({ height: 600, width: 800 }),
        withGeometry: async <T>(_surfaceId: unknown, operation: () => Promise<T>) => operation(),
      };
      const follow = new ScreencastController({
        frames: new LatestFrameStream({
          sendFrame: async (frame) => {
            delivered.push(frame.data);
          },
        }),
        ledger: ledger as never,
        onDialogChanged: () => undefined,
        onError: (error) => errors.push(error.reason ?? error.message),
      });
      const internals = follow as unknown as {
        readonly bound: {
          readonly firstFrameTimer: { readonly ms: number } | null;
          readonly state: { readonly shown: boolean; readonly unpictured: number };
        } | null;
      };

      await follow.start();
      await follow.setStreaming(true);
      await settle();
      expect(starts).toBe(1);

      // Cast 1 is silent: 3 s first-frame timer fires, repair begins, stop hangs in Chromium.
      vi.advanceTimersByTime(3_001);
      await settle();
      expect(stopAnswers).toHaveLength(1);

      // After 5 s, stop times out and cast 2 starts (also silent!).
      vi.advanceTimersByTime(5_001);
      await settle();
      expect(starts).toBe(2);

      // While cast 1's stop is still unanswered, a stale frame of cast 1 arrives and is shown.
      cdp.emit("Page.screencastFrame", {
        data: jpeg(800, 600).toString("base64"),
        metadata: { deviceHeight: 600, deviceWidth: 800 },
        sessionId: 1,
      });
      await settle();
      expect(delivered).toHaveLength(1);
      // It must NOT prove cast 2 works: shown stays false, unpictured is NOT wiped, timer stays armed!
      expect(internals.bound?.state.shown).toBe(false);
      expect(internals.bound?.state.unpictured).toBeGreaterThan(0);
      expect(internals.bound?.firstFrameTimer).not.toBeNull();

      // When cast 2's first-frame limit expires, cast 2 gives up honestly instead of staying stuck.
      vi.advanceTimersByTime(internals.bound!.firstFrameTimer!.ms + 1);
      await settle();
      expect(errors).toEqual(["browser-capture-mismatch"]);

      for (const resolve of stopAnswers.splice(0)) resolve();
      await follow.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // Opus review W2: a navigation-time refusal while loading forever is bounded and gives up.
  it("bounds a navigation-time refusal while a page loads forever and gives up at pictureLimit (W2)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const surface = {
        active: true,
        documentId: "doc-1",
        geometryRevision: 1,
        id: "tab-1" as never,
        loading: true,
        url: "https://example.com/slow-sign-in",
      };
      const errors: string[] = [];
      const cdp = new FakeCdpSession();
      let sizeCalls = 0;
      cdp.responses.set("Emulation.setVisibleSize", async () => {
        sizeCalls += 1;
        throw new Error("Emulation.setVisibleSize failed");
      });
      const binding = {
        cdp,
        page: { invalidateSurface: async () => undefined, settleRendering: async () => undefined },
        surface,
      };
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
        use: async <T>(_surfaceId: unknown, operation: () => Promise<T>) => operation(),
        viewportOf: () => ({ height: 600, width: 800 }),
        withGeometry: async <T>(_surfaceId: unknown, operation: () => Promise<T>) => operation(),
      };
      const follow = new ScreencastController({
        frames: new LatestFrameStream({ sendFrame: async () => undefined }),
        ledger: ledger as never,
        onDialogChanged: () => undefined,
        onError: (error) => errors.push(`${error.reason}:${error.message}`),
      });

      await follow.start();
      await follow.setStreaming(true);
      await settle();
      expect(sizeCalls).toBe(1);
      // Refusal is held with the 10 s loading bound timer (not unbounded).
      expect(vi.getTimerCount()).toBe(1);

      // 10 s -> retry 1 (attempt 2), 20 s -> retry 2 (attempt 3), 40 s -> retry 3 (attempt 4), 40 s -> give up.
      vi.advanceTimersByTime(10_001);
      await settle();
      expect(sizeCalls).toBe(2);
      vi.advanceTimersByTime(20_001);
      await settle();
      expect(sizeCalls).toBe(3);
      vi.advanceTimersByTime(40_001);
      await settle();
      expect(sizeCalls).toBe(4);
      expect(errors).toEqual([]);

      vi.advanceTimersByTime(40_001);
      await settle();
      expect(sizeCalls).toBe(4);
      expect(errors).toEqual([
        "browser-capture-mismatch:The picture of the page was given up: Emulation.setVisibleSize failed.",
      ]);
      expect(vi.getTimerCount()).toBe(0);

      await follow.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

/*
 * Re-check 9, R1, re-check 11 finding 6.6 (U5), and mutation audit M19 (U8): the state of a bound
 * tab has one writer, the pure `after` in screencast-plan.ts, and session state has one writer,
 * `afterSession`. Checked by parsing the TypeScript AST (`@babel/parser`) and resolving types,
 * imports and aliases rather than matching identifier names, so renaming fields or variables
 * cannot bypass it.
 */
describe("the follow view's state", () => {
  it("is written only by after and afterSession", async () => {
    const { readFileSync } = await import("node:fs");
    const { parse } = await import("@babel/parser");
    const planSource = readFileSync(new URL("./screencast-plan.ts", import.meta.url), "utf8");
    const controllerSource = readFileSync(
      new URL("./screencast-controller.ts", import.meta.url),
      "utf8",
    );
    const parseTs = (source: string) =>
      parse(source, { plugins: ["typescript"], sourceType: "module" });
    type AstNode = {
      readonly type: string;
      readonly loc?: { readonly start: { readonly line: number } } | null;
      readonly [key: string]: unknown;
    };
    const walk = (node: unknown, visit: (current: AstNode) => void) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, visit);
        return;
      }
      const record = node as AstNode;
      if (typeof record.type === "string") visit(record);
      for (const [key, value] of Object.entries(record)) {
        if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
        walk(value, visit);
      }
    };
    const identName = (node: unknown): string | null => {
      if (!node || typeof node !== "object") return null;
      const n = node as AstNode;
      if (n.type === "Identifier" && typeof n.name === "string") return n.name;
      if (n.type === "PrivateName") return identName(n.id);
      return null;
    };
    const typeRefName = (node: unknown): string | null => {
      if (!node || typeof node !== "object") return null;
      const n = node as AstNode;
      if (n.type === "TSTypeAnnotation") return typeRefName(n.typeAnnotation);
      if (n.type === "TSTypeReference") return identName(n.typeName);
      return null;
    };
    const typeHasName = (node: unknown, target: string): boolean => {
      let found = false;
      walk(node, (n) => {
        if (n.type === "TSTypeReference" && identName(n.typeName) === target) found = true;
      });
      return found;
    };

    // 1. Every property on TabCastState and SessionCastState in screencast-plan.ts is readonly.
    const planAst = parseTs(planSource);
    const mutablePlanFields: string[] = [];
    const tabStateFields = new Set<string>();
    const sessionStateFields = new Set<string>();
    walk(planAst, (node) => {
      if (node.type !== "TSInterfaceDeclaration") return;
      const iface = identName(node.id);
      if (iface !== "TabCastState" && iface !== "SessionCastState") return;
      const body = (node.body as { readonly body?: AstNode[] } | undefined)?.body ?? [];
      for (const member of body) {
        if (member.type !== "TSPropertySignature") continue;
        const prop = identName(member.key);
        if (!prop) continue;
        if (iface === "TabCastState") tabStateFields.add(prop);
        else sessionStateFields.add(prop);
        if (member.readonly !== true) mutablePlanFields.push(`${iface}.${prop}`);
      }
    });
    expect(mutablePlanFields).toEqual([]);
    expect(tabStateFields.size).toBeGreaterThan(0);
    expect(sessionStateFields.size).toBeGreaterThan(0);

    // 2. Track local names imported from ./screencast-plan.js and every property/variable typed as
    //    TabCastState, SessionCastState, or a map of SessionCastState (independent of field names).
    const controllerAst = parseTs(controllerSource);
    const importedAs = new Map<string, string>();
    const tabStateProps = new Set<string>();
    const sessionMapProps = new Set<string>();
    const tabStateVars = new Set<string>();
    const sessionStateVars = new Set<string>();
    const sessionMapVars = new Set<string>();
    const sessionGetterMethods = new Set<string>();

    walk(controllerAst, (node) => {
      if (
        node.type === "ImportDeclaration" &&
        (node.source as { readonly value?: string } | undefined)?.value === "./screencast-plan.js"
      ) {
        for (const spec of (node.specifiers as AstNode[] | undefined) ?? []) {
          if (spec.type !== "ImportSpecifier") continue;
          const imported = identName(spec.imported);
          const local = identName(spec.local);
          if (imported && local) importedAs.set(imported, local);
        }
      }
      if (
        node.type === "TSPropertySignature" ||
        node.type === "ClassProperty" ||
        node.type === "ClassPrivateProperty"
      ) {
        const prop = identName(node.key);
        if (!prop) return;
        const tname = typeRefName(node.typeAnnotation);
        if (tname === "TabCastState") tabStateProps.add(prop);
        if (
          (tname === "WeakMap" || tname === "Map") &&
          typeHasName(node.typeAnnotation, "SessionCastState")
        )
          sessionMapProps.add(prop);
        if (
          node.value &&
          (node.value as AstNode).type === "NewExpression" &&
          typeHasName((node.value as AstNode).typeParameters, "SessionCastState")
        )
          sessionMapProps.add(prop);
      }
      if (node.type === "ClassMethod" && typeRefName(node.returnType) === "SessionCastState") {
        const name = identName(node.key);
        if (name) sessionGetterMethods.add(name);
      }
    });

    const afterLocal = importedAs.get("after");
    const afterSessionLocal = importedAs.get("afterSession");
    const initialTabLocal = importedAs.get("initialTabCastState");
    expect(afterLocal && afterSessionLocal && initialTabLocal).toBeTruthy();
    expect(tabStateProps.size).toBeGreaterThan(0);
    expect(sessionMapProps.size).toBeGreaterThan(0);

    const isTabStateExpr = (expr: unknown): boolean => {
      if (!expr || typeof expr !== "object") return false;
      const n = expr as AstNode;
      if (n.type === "Identifier") return tabStateVars.has(n.name as string);
      if (n.type === "MemberExpression" && !n.computed) {
        const prop = identName(n.property);
        return prop !== null && tabStateProps.has(prop);
      }
      if (
        n.type === "TSAsExpression" ||
        n.type === "TSTypeAssertion" ||
        n.type === "TSNonNullExpression"
      )
        return isTabStateExpr(n.expression);
      return false;
    };
    const isSessionMapExpr = (expr: unknown): boolean => {
      if (!expr || typeof expr !== "object") return false;
      const n = expr as AstNode;
      if (n.type === "Identifier") return sessionMapVars.has(n.name as string);
      if (n.type === "MemberExpression" && !n.computed) {
        const prop = identName(n.property);
        return prop !== null && sessionMapProps.has(prop);
      }
      if (
        n.type === "TSAsExpression" ||
        n.type === "TSTypeAssertion" ||
        n.type === "TSNonNullExpression"
      )
        return isSessionMapExpr(n.expression);
      return false;
    };
    const isSessionStateExpr = (expr: unknown): boolean => {
      if (!expr || typeof expr !== "object") return false;
      const n = expr as AstNode;
      if (n.type === "Identifier") return sessionStateVars.has(n.name as string);
      if (n.type === "CallExpression") {
        const callee = n.callee as AstNode | undefined;
        if (callee?.type === "MemberExpression" && !callee.computed) {
          const name = identName(callee.property);
          if (name === "get" && isSessionMapExpr(callee.object)) return true;
          if (name !== null && sessionGetterMethods.has(name)) return true;
        }
      }
      if (
        n.type === "TSAsExpression" ||
        n.type === "TSTypeAssertion" ||
        n.type === "TSNonNullExpression"
      )
        return isSessionStateExpr(n.expression);
      return false;
    };

    // Propagate local aliases (e.g. `const s = bound.state` or `const m = this.sessionStates`).
    for (let pass = 0; pass < 3; pass += 1) {
      walk(controllerAst, (node) => {
        if (node.type === "VariableDeclarator") {
          const name = identName(node.id);
          if (!name) return;
          const tname = typeRefName((node.id as AstNode).typeAnnotation);
          if (tname === "TabCastState" || isTabStateExpr(node.init)) tabStateVars.add(name);
          if (tname === "SessionCastState" || isSessionStateExpr(node.init))
            sessionStateVars.add(name);
          if (
            ((tname === "WeakMap" || tname === "Map") &&
              typeHasName((node.id as AstNode).typeAnnotation, "SessionCastState")) ||
            isSessionMapExpr(node.init)
          )
            sessionMapVars.add(name);
        }
      });
    }

    const callsLocal = (expr: unknown, local: string | undefined): boolean => {
      if (!local || !expr || typeof expr !== "object") return false;
      const n = expr as AstNode;
      return n.type === "CallExpression" && identName(n.callee) === local;
    };
    const sourceLines = controllerSource.split("\n");
    const where = (node: AstNode) => {
      const line = node.loc?.start.line ?? 0;
      return `screencast-controller.ts:${line}: ${sourceLines[line - 1]?.trim() ?? node.type}`;
    };

    const isTabStateProp = (expr: unknown): boolean => {
      if (!expr || typeof expr !== "object") return false;
      const n = expr as AstNode;
      if (n.type === "MemberExpression" && !n.computed) {
        const prop = identName(n.property);
        return prop !== null && tabStateProps.has(prop);
      }
      if (
        n.type === "TSAsExpression" ||
        n.type === "TSTypeAssertion" ||
        n.type === "TSNonNullExpression"
      )
        return isTabStateProp(n.expression);
      return false;
    };

    const violations: string[] = [];
    let afterWrites = 0;
    let afterSessionWrites = 0;
    walk(controllerAst, (node) => {
      if (node.type === "AssignmentExpression") {
        const left = node.left as AstNode;
        if (isTabStateProp(left)) {
          if (node.operator === "=" && callsLocal(node.right, afterLocal)) afterWrites += 1;
          else violations.push(where(node));
        } else if (left.type === "MemberExpression") {
          if (isTabStateExpr(left.object) || isSessionStateExpr(left.object))
            violations.push(where(node));
        }
      }
      if (node.type === "UpdateExpression") {
        const arg = node.argument as AstNode;
        if (
          arg.type === "MemberExpression" &&
          (isTabStateExpr(arg.object) || isSessionStateExpr(arg.object))
        )
          violations.push(where(node));
      }
      if (node.type === "CallExpression") {
        const callee = node.callee as AstNode;
        if (callee.type === "MemberExpression" && !callee.computed) {
          const method = identName(callee.property);
          if (method === "set" && isSessionMapExpr(callee.object)) {
            const args = (node.arguments as AstNode[] | undefined) ?? [];
            if (callsLocal(args[1], afterSessionLocal)) afterSessionWrites += 1;
            else violations.push(where(node));
          }
          const obj = identName(callee.object);
          if (
            (obj === "Object" && (method === "assign" || method === "defineProperty")) ||
            (obj === "Reflect" && method === "set")
          ) {
            const target = (node.arguments as AstNode[] | undefined)?.[0];
            if (isTabStateExpr(target) || isSessionStateExpr(target)) violations.push(where(node));
          }
        }
      }
      if (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") {
        if (
          isTabStateExpr(node.expression) ||
          isSessionStateExpr(node.expression) ||
          isSessionMapExpr(node.expression)
        )
          violations.push(where(node));
      }
      if (node.type === "ObjectProperty") {
        const key = identName(node.key);
        if (
          key !== null &&
          tabStateProps.has(key) &&
          !callsLocal(node.value, initialTabLocal) &&
          !callsLocal(node.value, afterLocal)
        )
          violations.push(where(node));
      }
    });

    expect(violations).toEqual([]);
    expect(afterWrites).toBe(1);
    expect(afterSessionWrites).toBe(1);
  });
});

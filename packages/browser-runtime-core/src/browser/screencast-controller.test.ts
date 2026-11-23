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

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createId } from "@opensteer/core";
import type { LocalProfileBinding } from "@opensteer/protocol";
import { BrowserSessionIdSchema } from "@opensteer/protocol";
import { SurfaceLedger } from "@opensteer/browser-runtime-core";
import type { BaseWindow } from "electron";
import { describe, expect, it, vi } from "vitest";

type Bounds = { x: number; y: number; width: number; height: number };

const electron = vi.hoisted(() => ({
  storage: undefined as undefined | (() => Promise<unknown>),
  bootstrap: undefined as
    | undefined
    | ((
        method: string,
        deliver: (method: string, parameters: unknown) => void,
      ) => Promise<unknown> | undefined),
  hosts: [] as Array<{
    contentView: {
      addChildView: ReturnType<typeof vi.fn>;
      removeChildView: ReturnType<typeof vi.fn>;
    };
    destroy: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn<(event: string, listener: () => void) => void>>;
    off: ReturnType<typeof vi.fn>;
    isFocused: ReturnType<typeof vi.fn>;
    setContentSize: ReturnType<typeof vi.fn>;
    getContentBounds: ReturnType<typeof vi.fn<() => Bounds>>;
    options: Record<string, unknown>;
    setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    showInactive: ReturnType<typeof vi.fn>;
  }>,
  views: [] as Array<{
    options: { webPreferences?: { focusOnNavigation?: boolean } };
    webContents: {
      isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
      beginFrameSubscription: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
      debugger: {
        attach: ReturnType<typeof vi.fn>;
        detach: ReturnType<typeof vi.fn>;
        isAttached: ReturnType<typeof vi.fn<() => boolean>>;
        on: ReturnType<typeof vi.fn>;
        sendCommand: ReturnType<
          typeof vi.fn<(method: string, parameters?: Record<string, unknown>) => Promise<unknown>>
        >;
      };
    };
    getBounds: ReturnType<typeof vi.fn<() => Bounds>>;
    setBounds: ReturnType<typeof vi.fn<(bounds: Bounds) => void>>;
  }>,
}));

vi.mock("electron", () => {
  class MockWebContents {
    readonly debugger = {
      attach: vi.fn(),
      detach: vi.fn(),
      isAttached: vi.fn(() => true),
      off: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      sendCommand: vi.fn((method: string) => {
        const result = electron.bootstrap?.(method, (name, parameters) => {
          for (const [event, listener] of this.debugger.on.mock.calls)
            if (event === "message") listener({}, name, parameters);
        });
        return (
          result ??
          Promise.resolve(
            method === "Target.getTargetInfo"
              ? { targetInfo: { targetId: "target-1" } }
              : method === "Network.getAllCookies"
                ? { cookies: [] }
                : {},
          )
        );
      }),
    };
    readonly focus = vi.fn();
    readonly beginFrameSubscription = vi.fn(
      (callback: (image: { getSize(): { width: number; height: number } }) => void) =>
        setImmediate(() => callback({ getSize: () => ({ width: 800, height: 600 }) })),
    );
    readonly endFrameSubscription = vi.fn();
    readonly close = vi.fn(() => {
      for (const [event, listener] of this.once.mock.calls) if (event === "destroyed") listener();
    });
    readonly stopFindInPage = vi.fn();
    readonly getTitle = vi.fn(() => "");
    readonly getURL = vi.fn(() => "about:blank");
    readonly isDestroyed = vi.fn(() => false);
    readonly loadURL = vi.fn(async () => undefined);
    readonly executeJavaScriptInIsolatedWorld = vi.fn(async () => electron.storage?.() ?? {});
    readonly off = vi.fn();
    readonly on = vi.fn();
    readonly once = vi.fn();
    readonly removeAllListeners = vi.fn();
    readonly setWindowOpenHandler = vi.fn();
    readonly setVisualZoomLevelLimits = vi.fn(async () => undefined);
  }

  class MockWebContentsView {
    readonly webContents = new MockWebContents();
    bounds = { height: 600, width: 800, x: 0, y: 0 };
    readonly getBounds = vi.fn(() => ({ ...this.bounds }));
    readonly options: { webPreferences?: { focusOnNavigation?: boolean } };
    readonly setBounds = vi.fn((bounds: typeof this.bounds) => {
      this.bounds = { ...bounds };
    });
    readonly setVisible = vi.fn();
    readonly setBackgroundColor = vi.fn();
    readonly setBorderRadius = vi.fn();

    constructor(options: { webPreferences?: { focusOnNavigation?: boolean } } = {}) {
      this.options = options;
      electron.views.push(this);
    }
  }

  class MockBaseWindow {
    readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    readonly destroy = vi.fn();
    readonly isDestroyed = vi.fn(() => false);
    readonly isVisible = vi.fn(() => false);
    readonly isFocused = vi.fn(() => true);
    readonly on = vi.fn();
    readonly off = vi.fn();
    readonly hide = vi.fn();
    readonly options: Record<string, unknown>;
    readonly setIgnoreMouseEvents = vi.fn();
    readonly setContentSize = vi.fn();
    readonly getBounds = vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 }));
    readonly getContentBounds = this.getBounds;
    readonly show = vi.fn();
    readonly showInactive = vi.fn();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      electron.hosts.push(this);
    }
  }

  const makeSession = () => ({
    cookies: { on: vi.fn(), off: vi.fn(), flushStore: vi.fn(async () => undefined) },
    flushStorageData: vi.fn(),
    clearCache: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
    getPreloadScripts: vi.fn(() => []),
    getUserAgent: vi.fn(() => "Mozilla/5.0 Chrome/1 Safari/1"),
    on: vi.fn(),
    registerPreloadScript: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setUserAgent: vi.fn(),
    unregisterPreloadScript: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() },
  });

  const sessions = new Map<string, ReturnType<typeof makeSession>>();
  return {
    app: { on: vi.fn(), whenReady: vi.fn(async () => undefined) },
    safeStorage: {
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => "gnome_libsecret",
      encryptStringAsync: async (text: string) => Buffer.from(text),
      decryptStringAsync: async (text: Buffer) => ({
        result: text.toString(),
        shouldReEncrypt: false,
      }),
    },
    BaseWindow: MockBaseWindow,
    WebContentsView: MockWebContentsView,
    screen: { getDisplayMatching: vi.fn(() => ({ scaleFactor: 1 })), on: vi.fn(), off: vi.fn() },
    session: {
      fromPath: vi.fn((directory: string) => {
        if (!sessions.has(directory)) sessions.set(directory, makeSession());
        return sessions.get(directory)!;
      }),
      fromPartition: vi.fn((partition: string) => {
        if (!sessions.has(partition)) sessions.set(partition, makeSession());
        return sessions.get(partition)!;
      }),
    },
  };
});

const {
  ElectronBrowserLauncher,
  electronBrowserPartition,
  electronPagePresentation,
  nativePlacement,
} = await import("./electron-browser-launcher.js");

describe("electronBrowserPartition", () => {
  it("keeps fresh partitions in a namespace of their own", () => {
    const profile = electronBrowserPartition("profile:bpr_00000000-0000-4000-8000-000000000001");
    const fresh = electronBrowserPartition("session:bsn_00000000-0000-4000-8000-000000000002");

    expect(profile).toMatch(/^opensteer-browser-[0-9a-f]{32}$/);
    expect(fresh).toMatch(/^opensteer-browser-[0-9a-f]{32}$/);
    expect(fresh).not.toBe(profile);
    // The same identity always lands on the same partition.
    expect(electronBrowserPartition("profile:bpr_00000000-0000-4000-8000-000000000001")).toBe(
      profile,
    );
  });
});

describe("ElectronBrowserLauncher focus", () => {
  it.each([false, true])(
    "forwards only an injected qualified clipboard (%s)",
    async (supported) => {
      const clipboard = {
        machineClipboardShared: true,
        open: vi.fn(async () => ({ close: async () => null })),
      };
      const launcher = new ElectronBrowserLauncher({
        downloads: { accept: () => undefined },
        pagePolicyPreloadPath: "/tmp/browser-page-preload.cjs",
        ...(supported ? { clipboard } : {}),
      });
      const sessionId = BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000001");
      const browser = await launcher.launch({
        sessionId,
        partitionKey: `session:${sessionId}`,
        initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
        storage: { kind: "guest" },
      });
      try {
        expect(browser.clipboard).toBe(supported ? clipboard : undefined);
        expect(clipboard.open).not.toHaveBeenCalled();
      } finally {
        await browser.close();
        launcher.close();
      }
    },
  );

  it("keeps every browser view resting where it cannot take native focus", async () => {
    electron.hosts.length = 0;
    electron.views.length = 0;
    const launcher = new ElectronBrowserLauncher({
      downloads: { accept: () => undefined },
      pagePolicyPreloadPath: "/opensteer/browser-page-preload.cjs",
    });
    const browser = await launcher.launch({
      initialViewport: { devicePixelRatio: 1, height: 1600, width: 2560 },
      partitionKey: "session:bsn_00000000-0000-4000-8000-000000000003",
      sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000003"),
      storage: { kind: "guest" },
    });

    expect(electron.hosts).not.toHaveLength(0);
    for (const host of electron.hosts) {
      expect(host.showInactive).not.toHaveBeenCalled();
      expect(host.show).not.toHaveBeenCalled();
      expect(host.options.type).toBe(process.platform === "darwin" ? "panel" : undefined);
      expect(host.options.focusable).toBe(false);
      expect(host.options.enableLargerThanScreen).toBe(true);
      expect(host.options).toMatchObject({ width: 2560, height: 1600 });
    }

    const page = browser.context.pages()[0];
    if (!page) throw new Error("Electron test browser is incomplete.");
    expect(
      electron.views.every((view) => view.options.webPreferences?.focusOnNavigation === false),
    ).toBe(true);
    for (const view of electron.views) expect(view.webContents.focus).not.toHaveBeenCalled();
    for (const view of electron.views)
      expect(view.getBounds()).toEqual({ x: 0, y: 0, width: 2560, height: 1600 });
    await expect(
      browser.cdp.send("Target.activateTarget", { targetId: await page.targetId() }),
    ).rejects.toThrow("Target.activateTarget is unavailable at Electron browser scope.");
    await browser.close();
  });
});

describe("Electron input attribution", () => {
  it.each(["resolve", "reject"] as const)(
    "keeps disposed channels' input outstanding until the underlying command %ss",
    async (outcome) => {
      const launcher = new ElectronBrowserLauncher({
        downloads: { accept: () => undefined },
        pagePolicyPreloadPath: "/opensteer/browser-page-preload.cjs",
      });
      const browser = await launcher.launch({
        initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
        partitionKey: "session:bsn_00000000-0000-4000-8000-000000000004",
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000004"),
        storage: { kind: "guest" },
      });
      const page = browser.context.pages()[0]!;
      const presentation = electronPagePresentation(page)!;
      const contents = electron.views.at(-1)!.webContents;
      const unbind = page.bindGeometry!(
        (operation) => operation(),
        async () => undefined,
      );
      await page.applyGeometry!({ person: { width: 800, height: 600 }, agent: null });
      const observations = vi.fn();
      page.observeHumanInput!(observations);
      const mouse = contents.on.mock.calls.find(([name]) => name === "before-mouse-event")![1];
      const key = contents.on.mock.calls.find(([name]) => name === "before-input-event")![1];
      const hook = () => {
        mouse({}, { type: "mouseDown", x: 3, y: 4 });
        key({}, { type: "rawKeyDown", key: "a", control: false });
      };
      const pending = Promise.withResolvers<unknown>();
      contents.debugger.sendCommand.mockImplementation((method: string) => {
        if (method === "Page.createIsolatedWorld")
          return Promise.resolve({ executionContextId: 1 });
        if (method.startsWith("Input.")) {
          hook();
          return pending.promise;
        }
        return Promise.resolve({});
      });
      const agent = await page.agentCdp!();
      const command = agent.send("Input.dispatchMouseEvent", { type: "mousePressed" });
      const result = command.catch(() => undefined);
      await vi.waitFor(() => expect(presentation.inputOutstanding()).toBe(true));
      expect(observations).not.toHaveBeenCalled();
      expect(presentation.inputOutstanding()).toBe(true);
      await agent.detach();
      hook();
      expect(observations).not.toHaveBeenCalled();
      expect(presentation.inputOutstanding()).toBe(true);
      for (const name of ["detach", "render-process-gone", "destroyed"]) {
        const calls =
          name === "detach"
            ? contents.debugger.on.mock.calls
            : [...contents.on.mock.calls, ...contents.once.mock.calls];
        for (const [event, listener] of calls) if (event === name) listener({}, "test");
        expect(presentation.inputOutstanding()).toBe(true);
      }
      if (outcome === "resolve") pending.resolve({});
      else pending.reject(new Error("debugger detached"));
      await result;
      expect(presentation.inputOutstanding()).toBe(false);
      unbind();
      await browser.close();
    },
  );
});

describe("Electron title reads at teardown", () => {
  it("closes a ledger whose title read the page never answers, and publishes nothing late", async () => {
    const browser = await new ElectronBrowserLauncher({
      downloads: { accept: () => undefined },
      pagePolicyPreloadPath: "/opensteer/browser-page-preload.cjs",
    }).launch({
      initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
      partitionKey: "session:bsn_00000000-0000-4000-8000-000000000006",
      sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000006"),
      storage: { kind: "guest" },
    });
    const contents = electron.views.at(-1)!.webContents;
    const held = Promise.withResolvers<unknown>();
    const send = contents.debugger.sendCommand.getMockImplementation()!;
    contents.debugger.sendCommand.mockImplementation((method: string, ...rest: unknown[]) => {
      if (method === "Page.getFrameTree")
        return Promise.resolve({ frameTree: { frame: { id: "target-1", loaderId: "loader-1" } } });
      // The page's own document never answers its title read.
      if (method === "Runtime.evaluate") return held.promise;
      return (send as (method: string, ...rest: unknown[]) => Promise<unknown>)(method, ...rest);
    });
    const ledger = new SurfaceLedger(browser.context);
    await ledger.start();
    const context = {
      context: {
        id: 1,
        uniqueId: "world-1",
        origin: "",
        name: "",
        auxData: { frameId: "target-1", isDefault: true, type: "default" },
      },
    };
    const deliver = () => {
      for (const [event, listener] of contents.debugger.on.mock.calls)
        if (event === "message") listener({}, "Runtime.executionContextCreated", context);
    };
    deliver();
    await vi.waitFor(() =>
      expect(
        contents.debugger.sendCommand.mock.calls.some(([method]) => method === "Runtime.evaluate"),
      ).toBe(true),
    );
    const published: string[] = [];
    ledger.subscribe((event) => {
      if (event.type === "changed" && "surface" in event && event.surface)
        published.push(event.surface.title);
    });
    // The page stays alive: only the ledger lets its debugger channel go.
    await expect(
      Promise.race([
        ledger.close().then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve("held"), 1_000)),
      ]),
    ).resolves.toBe("closed");
    expect(contents.debugger.detach).toHaveBeenCalled();
    const commands = contents.debugger.sendCommand.mock.calls.length;
    held.resolve({ result: { value: { href: "about:blank", title: "Late" } } });
    deliver();
    await new Promise((resolve) => setImmediate(resolve));
    expect(published).not.toContain("Late");
    // Nothing of the closed ledger still listens to the page or asks it again.
    expect(contents.debugger.sendCommand.mock.calls).toHaveLength(commands);
    await browser.close();
  });
});

/**
 * A page on the real debugger hub. Its fake debugger keeps its attachment,
 * reports a fresh main world to each Runtime.enable, and holds the commands a
 * test names until the test answers them.
 */
async function hubPage(session: string) {
  const sessionId = `bsn_00000000-0000-4000-8000-${session.padStart(12, "0")}`;
  const browser = await new ElectronBrowserLauncher({
    downloads: { accept: () => undefined },
    pagePolicyPreloadPath: "/opensteer/browser-page-preload.cjs",
  }).launch({
    initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
    partitionKey: `session:${sessionId}`,
    sessionId: BrowserSessionIdSchema.parse(sessionId),
    storage: { kind: "guest" },
  });
  const page = browser.context.pages()[0]!;
  const contents = electron.views.at(-1)!.webContents;
  const debug = contents.debugger;
  let attached = true;
  debug.isAttached.mockImplementation(() => attached);
  debug.attach.mockImplementation(() => {
    attached = true;
  });
  debug.detach.mockImplementation(() => {
    attached = false;
  });
  const deliver = (method: string, parameters: unknown) => {
    for (const [event, listener] of debug.on.mock.calls)
      if (event === "message") listener({}, method, parameters);
  };
  const holds = new Map<string, PromiseWithResolvers<unknown>[]>();
  let worlds = 0;
  const answer = debug.sendCommand.getMockImplementation()!;
  debug.sendCommand.mockImplementation((method: string, parameters?: Record<string, unknown>) => {
    const held = holds.get(method);
    if (held) {
      const reply = Promise.withResolvers<unknown>();
      held.push(reply);
      return reply.promise;
    }
    if (method === "Runtime.enable") deliver("Runtime.executionContextCreated", world(++worlds));
    return answer(method, parameters);
  });
  return {
    browser,
    page,
    contents,
    deliver,
    sent: (method: string) => debug.sendCommand.mock.calls.filter(([name]) => name === method),
    /** Holds every later `method` until released; its replies answer the held ones. */
    hold(method: string) {
      const replies: PromiseWithResolvers<unknown>[] = [];
      holds.set(method, replies);
      return { replies, release: () => holds.delete(method) };
    },
    destroy() {
      contents.isDestroyed.mockReturnValue(true);
      for (const [event, listener] of [...contents.on.mock.calls, ...contents.once.mock.calls])
        if (event === "destroyed") listener({});
    },
  };
}

function world(id: number | string) {
  return {
    context: {
      id: typeof id === "number" ? id : 99,
      uniqueId: `world-${id}`,
      origin: "",
      name: "",
      auxData: { frameId: "target-1", isDefault: true, type: "default" },
    },
  };
}

/** How a promise ends within a second, if it does; the page stays open throughout. */
function within(promise: Promise<unknown>): Promise<"fulfilled" | "rejected" | "held"> {
  return Promise.race([
    promise.then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    ),
    new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 1_000)),
  ]);
}

describe("Electron debugger teardown", () => {
  it("lets the last channel go while a domain enable is never answered", async () => {
    const hub = await hubPage("10");
    const platform = await hub.page.cdp();
    const held = hub.hold("Network.enable");
    const enabling = platform.send("Network.enable").catch((error: unknown) => error);
    await vi.waitFor(() => expect(held.replies).toHaveLength(1));
    expect(await within(platform.detach())).toBe("fulfilled");
    expect(hub.contents.debugger.detach).toHaveBeenCalledOnce();
    expect(await enabling).toBeInstanceOf(Error);
    await hub.browser.close();
  });

  it("lets the last channel go while its screencast start is never answered", async () => {
    const hub = await hubPage("11");
    const platform = await hub.page.cdp();
    const held = hub.hold("Page.startScreencast");
    void platform.send("Page.startScreencast", { format: "png" }).catch(() => undefined);
    await vi.waitFor(() => expect(held.replies).toHaveLength(1));
    expect(await within(platform.detach())).toBe("fulfilled");
    expect(hub.contents.debugger.detach).toHaveBeenCalledOnce();
    await hub.browser.close();
  });

  it("asks nothing more of the renderer when the last channel goes, even to stop a cast", async () => {
    const hub = await hubPage("12");
    const platform = await hub.page.cdp();
    await platform.send("Page.startScreencast", { format: "png" });
    await platform.send("Network.enable");
    const stops = hub.sent("Page.stopScreencast").length;
    // Neither would ever be answered; the detach ends the cast and the domain.
    hub.hold("Page.stopScreencast");
    hub.hold("Network.disable");
    expect(await within(platform.detach())).toBe("fulfilled");
    expect(hub.sent("Page.stopScreencast")).toHaveLength(stops);
    expect(hub.sent("Network.disable")).toHaveLength(0);
    expect(hub.contents.debugger.detach).toHaveBeenCalledOnce();
    await hub.browser.close();
  });

  it("stops another channel's release from asking more once the last channel goes", async () => {
    const hub = await hubPage("13");
    const platform = await hub.page.cdp();
    const agent = await hub.page.agentCdp();
    await agent.send("Page.startScreencast", { format: "png" });
    await agent.send("Network.enable");
    const stop = hub.hold("Page.stopScreencast");
    hub.hold("Network.disable");
    // Another channel remains, so the agent's release cleans up after itself.
    const releasing = agent.detach();
    await vi.waitFor(() => expect(stop.replies).toHaveLength(1));
    expect(await within(platform.detach())).toBe("fulfilled");
    expect(await within(releasing)).toBe("fulfilled");
    expect(hub.sent("Network.disable")).toHaveLength(0);
    await hub.browser.close();
  });

  it("gives a cast that a released channel was restarting to no one", async () => {
    const hub = await hubPage("14");
    const platform = await hub.page.cdp();
    await platform.send("Page.startScreencast", { format: "png", quality: 10 });
    const stop = hub.hold("Page.stopScreencast");
    const restarting = platform
      .send("Page.startScreencast", { format: "png", quality: 20 })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(stop.replies).toHaveLength(1));
    expect(await within(platform.detach())).toBe("fulfilled");
    expect(await restarting).toBeInstanceOf(Error);
    stop.release();
    stop.replies[0]!.resolve({});
    const agent = await hub.page.agentCdp();
    const before = hub.contents.debugger.sendCommand.mock.calls.length;
    await agent.send("Page.startScreencast", { format: "jpeg", quality: 30 });
    await agent.send("Page.screencastFrameAck", { sessionId: 7 });
    expect(
      hub.contents.debugger.sendCommand.mock.calls
        .slice(before)
        .filter(([method]) => method.includes("creencast")),
    ).toEqual([
      ["Page.startScreencast", { format: "jpeg", quality: 30 }],
      ["Page.screencastFrameAck", { sessionId: 7 }],
    ]);
    await hub.browser.close();
  });

  it("lets go of a released channel's domains when the renderer is lost during its release", async () => {
    const hub = await hubPage("19");
    const platform = await hub.page.cdp();
    const agent = await hub.page.agentCdp();
    await agent.send("Page.startScreencast", { format: "png" });
    await agent.send("Network.enable");
    const stop = hub.hold("Page.stopScreencast");
    const releasing = agent.detach();
    await vi.waitFor(() => expect(stop.replies).toHaveLength(1));
    const listeners = [...hub.contents.on.mock.calls];
    for (const [event, listener] of listeners)
      if (event === "render-process-gone") listener({}, { reason: "crashed" });
    expect(await within(releasing)).toBe("fulfilled");
    for (const [event, listener] of listeners) if (event === "did-navigate") listener({});
    // A new subscriber's enable reaches Chromium, and so does the last one's disable.
    const replacement = await hub.page.agentCdp();
    const enables = hub.sent("Network.enable").length;
    await replacement.send("Network.enable");
    expect(hub.sent("Network.enable")).toHaveLength(enables + 1);
    const disables = hub.sent("Network.disable").length;
    await replacement.send("Network.disable");
    expect(hub.sent("Network.disable")).toHaveLength(disables + 1);
    await platform.detach();
    await hub.browser.close();
  });

  it("gives up an attachment that never answers without closing the next one", async () => {
    const hub = await hubPage("20");
    await (await hub.page.cdp()).detach();
    expect(hub.contents.debugger.detach).toHaveBeenCalledOnce();
    // The next attachment's Runtime.enable never answers; a subscription waits on it.
    const attachment = hub.hold("Runtime.enable");
    const first = await hub.page.agentCdp();
    const subscribing = first.send("Runtime.enable").catch((error: unknown) => error);
    await vi.waitFor(() => expect(attachment.replies).toHaveLength(1));
    expect(await within(first.detach())).toBe("fulfilled");
    expect(await subscribing).toBeInstanceOf(Error);
    expect(hub.contents.debugger.detach).toHaveBeenCalledTimes(2);
    attachment.release();
    const replacement = await hub.page.agentCdp();
    const reported: unknown[] = [];
    replacement.on("Runtime.executionContextCreated", (parameters) =>
      reported.push((parameters as ReturnType<typeof world>).context.uniqueId),
    );
    await replacement.send("Runtime.enable");
    expect(reported).toEqual(["world-1"]);
    // The abandoned attachment answers late; the replacement keeps working.
    attachment.replies[0]!.resolve({});
    const enables = hub.sent("Network.enable").length;
    await replacement.send("Network.enable");
    expect(hub.sent("Network.enable")).toHaveLength(enables + 1);
    await hub.browser.close();
  });

  it("closes a page that stays open while its ownership work is never answered", async () => {
    const hub = await hubPage("15");
    const platform = await hub.page.cdp();
    const held = hub.hold("Network.enable");
    void platform.send("Network.enable").catch(() => undefined);
    await vi.waitFor(() => expect(held.replies).toHaveLength(1));
    expect(await within(hub.page.close())).toBe("fulfilled");
    expect(hub.contents.debugger.detach).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"] as const)(
    "lets a new channel join only after the detach, on a fresh attachment (input %ss)",
    async (outcome) => {
      const hub = await hubPage(outcome === "resolve" ? "16" : "17");
      const presentation = electronPagePresentation(hub.page)!;
      const unbind = hub.page.bindGeometry!(
        (operation) => operation(),
        async () => undefined,
      );
      await hub.page.applyGeometry!({ person: { width: 800, height: 600 }, agent: null });
      const platform = await hub.page.cdp();
      const agent = await hub.page.agentCdp();
      hub.deliver("Runtime.executionContextCreated", world("old"));
      const input = hub.hold("Input.dispatchMouseEvent");
      const pressed = agent
        .send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1, button: "left" })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(input.replies).toHaveLength(1));
      const late = hub.hold("Network.enable");
      void platform.send("Network.enable").catch(() => undefined);
      await vi.waitFor(() => expect(late.replies).toHaveLength(1));
      late.release();
      const releasing = Promise.all([agent.detach(), platform.detach()]);
      // The caller hears at once; the input stays the page's until Chromium answers.
      expect(await pressed).toBeInstanceOf(Error);
      expect(presentation.inputOutstanding()).toBe(true);
      let joined = false;
      const joining = hub.page.agentCdp().then((channel) => {
        joined = true;
        return channel;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(joined).toBe(false);
      expect(hub.contents.debugger.detach).not.toHaveBeenCalled();
      if (outcome === "resolve") input.replies[0]!.resolve({});
      else input.replies[0]!.reject(new Error("Input failed"));
      await releasing;
      const replacement = await joining;
      expect(presentation.inputOutstanding()).toBe(false);
      const { attach, detach } = hub.contents.debugger;
      expect(detach).toHaveBeenCalledOnce();
      expect(attach.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
        detach.mock.invocationCallOrder[0]!,
      );
      const reported: unknown[] = [];
      replacement.on("Runtime.executionContextCreated", (parameters) =>
        reported.push((parameters as ReturnType<typeof world>).context.uniqueId),
      );
      await replacement.send("Runtime.enable");
      // Only the world the fresh attachment reported, not the one the old session had.
      expect(reported).toEqual(["world-1"]);
      // The old attachment's late answer changes nothing the replacement owns.
      late.replies[0]!.resolve({});
      const enables = hub.sent("Network.enable").length;
      await replacement.send("Network.enable");
      expect(hub.sent("Network.enable")).toHaveLength(enables + 1);
      await replacement.send("Page.startScreencast", { format: "png" });
      expect(hub.sent("Page.startScreencast").at(-1)).toEqual([
        "Page.startScreencast",
        { format: "png" },
      ]);
      unbind();
      await hub.browser.close();
    },
  );

  it("refuses a channel that waited for a teardown the page's destruction ended", async () => {
    const hub = await hubPage("18");
    const presentation = electronPagePresentation(hub.page)!;
    const unbind = hub.page.bindGeometry!(
      (operation) => operation(),
      async () => undefined,
    );
    await hub.page.applyGeometry!({ person: { width: 800, height: 600 }, agent: null });
    const platform = await hub.page.cdp();
    const agent = await hub.page.agentCdp();
    const input = hub.hold("Input.dispatchMouseEvent");
    void agent
      .send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1, button: "left" })
      .catch(() => undefined);
    await vi.waitFor(() => expect(input.replies).toHaveLength(1));
    const releasing = Promise.all([agent.detach(), platform.detach()]);
    const joining = hub.page.agentCdp();
    hub.destroy();
    // Destruction ends the teardown with Chromium's answer to the input still owed.
    expect(await within(releasing)).toBe("fulfilled");
    expect(presentation.inputOutstanding()).toBe(true);
    await expect(joining).rejects.toThrow("closed");
    unbind();
  });
});

describe("native placement", () => {
  const stage = { x: 30, y: 50, width: 700, height: 500 };
  const person = { width: 1000, height: 800 };

  it("keeps focused follows at the stage through lagging ledger writes", () => {
    expect(nativePlacement({ stage, followsPerson: true }, { person, agent: null })).toEqual({
      bounds: stage,
      crop: { right: false, bottom: false },
      emulation: null,
    });
  });

  it("preserves an unfocused person's full layout while cropping real bounds", () => {
    expect(nativePlacement({ stage, followsPerson: false }, { person, agent: null })).toEqual({
      bounds: stage,
      crop: { right: true, bottom: true },
      emulation: { ...person, deviceScaleFactor: 0, mobile: false, dontSetVisibleSize: true },
    });
  });

  it("gives the agent's complete override precedence and centres each smaller width", () => {
    const agent = { width: 400, height: 900, deviceScaleFactor: 0, mobile: false, scale: 1.5 };
    expect(nativePlacement({ stage, followsPerson: true }, { person, agent })).toEqual({
      bounds: { x: 180, y: 50, width: 400, height: 500 },
      crop: { right: false, bottom: true },
      emulation: { ...agent, dontSetVisibleSize: true },
    });
    expect(nativePlacement(null, { person, agent })).toEqual({
      bounds: { x: 0, y: 0, width: 400, height: 900 },
      crop: { right: false, bottom: false },
      emulation: { ...agent, dontSetVisibleSize: true },
    });
  });
});

describe("Electron geometry lifecycle", () => {
  async function launch(bindGeometry = true, provider = false) {
    const browser = await new ElectronBrowserLauncher({
      ...(provider
        ? {
            authenticator: {
              ceremony: async () => ({
                kind: "refused" as const,
                error: "NotAllowedError" as const,
              }),
            },
          }
        : {}),
      downloads: { accept: () => undefined },
      pagePolicyPreloadPath: "/opensteer/browser-page-preload.cjs",
    }).launch({
      initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
      partitionKey: "session:bsn_00000000-0000-4000-8000-000000000005",
      sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000005"),
      storage: { kind: "guest" },
    });
    const page = browser.context.pages()[0]!;
    const native = electronPagePresentation(page)!;
    const view = electron.views.at(-1)!;
    const host = electron.hosts.at(-1)!;
    const operations: Promise<void>[] = [];
    const releaseInput = vi.fn<() => Promise<void>>(async () => undefined);
    const serialize = (operation: () => Promise<void>) => {
      const pending = (operations.at(-1) ?? Promise.resolve()).then(operation);
      operations.push(pending);
      return pending;
    };
    const unbind = bindGeometry ? page.bindGeometry!(serialize, releaseInput) : () => undefined;
    if (bindGeometry)
      await page.applyGeometry!({ person: { width: 800, height: 600 }, agent: null });
    const drain = async () => {
      for (let index = 0; index < operations.length; index++) await operations[index];
    };
    return { browser, page, native, view, host, unbind, drain, releaseInput, serialize };
  }

  it("keeps provider TLS domains in the existing hub ownership until the page releases", async () => {
    const { browser, page, view } = await launch(false, true);
    try {
      const platform = await page.cdp();
      for (const domain of ["Network", "Security"]) {
        await platform.send(`${domain}.enable`);
        await platform.send(`${domain}.disable`);
        expect(
          view.webContents.debugger.sendCommand.mock.calls.filter(
            ([method]) => method === `${domain}.enable`,
          ),
        ).toHaveLength(1);
        expect(
          view.webContents.debugger.sendCommand.mock.calls.filter(
            ([method]) => method === `${domain}.disable`,
          ),
        ).toHaveLength(0);
      }
    } finally {
      await browser.close();
    }
  });

  it("admits private platform composition without granting agents or derived gestures", async () => {
    const { browser, page, view, unbind } = await launch();
    try {
      const platform = await page.cdp();
      const agent = await page.agentCdp();
      const composition = { text: "한", selectionStart: 1, selectionEnd: 1 };
      await expect(agent.send("Input.imeSetComposition", composition)).rejects.toThrow(
        /unavailable/,
      );
      for (const channel of [platform, agent])
        await expect(channel.send("Input.synthesizeScrollGesture", { x: 5, y: 5 })).rejects.toThrow(
          /unavailable/,
        );
      await expect(platform.send("Input.imeSetComposition", composition)).resolves.toEqual({});
      const cancel = { text: "", selectionStart: 0, selectionEnd: 0 };
      await expect(platform.send("Input.imeSetComposition", cancel)).resolves.toEqual({});
      expect(
        view.webContents.debugger.sendCommand.mock.calls.filter(([method]) =>
          method.startsWith("Input."),
        ),
      ).toEqual([
        ["Input.imeSetComposition", composition],
        ["Input.imeSetComposition", cancel],
      ]);
    } finally {
      unbind();
      await browser.close();
    }
  });

  // Network domain leases must not discard explicit agent settings or let an
  // empty platform subscription reset them, regardless of acquisition order.
  it.each(["platform-first", "agent-first"])(
    "preserves explicit Network settings with %s subscriptions",
    async (order) => {
      const { browser, page, view } = await launch(false);
      const platform = await page.cdp();
      const agent = await page.agentCdp();
      const initial = { maxTotalBufferSize: 4_000_000, maxResourceBufferSize: 1_000_000 };
      const updated = { maxTotalBufferSize: 8_000_000, maxResourceBufferSize: 2_000_000 };
      try {
        if (order === "platform-first") {
          await platform.send("Network.enable");
          await agent.send("Network.enable", initial);
        } else {
          await agent.send("Network.enable", initial);
          await platform.send("Network.enable");
        }
        await agent.send("Network.enable", updated);
        await platform.send("Network.enable");
        const enables = view.webContents.debugger.sendCommand.mock.calls.filter(
          ([method]) => method === "Network.enable",
        );
        expect(enables).toEqual(
          order === "platform-first"
            ? [
                ["Network.enable", undefined],
                ["Network.enable", initial],
                ["Network.enable", updated],
              ]
            : [
                ["Network.enable", initial],
                ["Network.enable", updated],
              ],
        );
      } finally {
        await agent.detach();
        await platform.detach();
        await browser.close();
      }
    },
  );

  it.each([
    ["unbind", "resolve"],
    ["unbind", "reject"],
    ["close", "resolve"],
    ["close", "reject"],
    ["crash", "resolve"],
    ["crash", "reject"],
  ] as const)("stops placement after %s during a barrier that %ss", async (terminal, outcome) => {
    const { browser, page, native, view, host, unbind, drain, releaseInput, serialize } =
      await launch();
    const placed = vi.fn();
    native.mount(host as unknown as BaseWindow, { x: 10, y: 20, width: 800, height: 600 }, placed);
    await drain();
    const entered = Promise.withResolvers<void>();
    const barrier = Promise.withResolvers<void>();
    releaseInput.mockImplementationOnce(() => {
      entered.resolve();
      return barrier.promise;
    });
    const getBounds = view.getBounds.getMockImplementation()!;
    let reads = 0;
    view.getBounds.mockImplementation(() => {
      if (++reads > 20) throw new Error("Placement retried a terminal barrier");
      return getBounds();
    });
    const pending = serialize(() =>
      page.applyGeometry!({
        person: { width: 800, height: 600 },
        agent: { width: 700, height: 500, deviceScaleFactor: 0, mobile: false },
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    await entered.promise;
    try {
      if (terminal === "unbind") unbind();
      else if (terminal === "close") await page.close();
      else {
        for (const [event, listener] of view.webContents.on.mock.calls)
          if (event === "render-process-gone") listener({}, { reason: "crashed" });
      }
      const writes = view.setBounds.mock.calls.length;
      const hostWrites = host.setContentSize.mock.calls.length;
      const commands = view.webContents.debugger.sendCommand.mock.calls.length;
      const subscriptions = view.webContents.beginFrameSubscription.mock.calls.length;
      const placements = placed.mock.calls.length;
      if (outcome === "resolve") barrier.resolve();
      else barrier.reject(new Error("Release barrier failed"));
      expect(await pending).toBeInstanceOf(Error);
      await native.invalidateSurface().catch(() => undefined);
      expect(view.setBounds.mock.calls).toHaveLength(writes);
      expect(host.setContentSize.mock.calls).toHaveLength(hostWrites);
      expect(view.webContents.debugger.sendCommand.mock.calls).toHaveLength(commands);
      expect(view.webContents.beginFrameSubscription.mock.calls).toHaveLength(subscriptions);
      expect(placed.mock.calls).toHaveLength(placements);
      await expect(native.waitForPaint()).rejects.toThrow(/canceled|closed|aborted|crashed/);
      expect(reads).toBeLessThan(20);
    } finally {
      view.getBounds.mockImplementation(getBounds);
      await browser.close();
    }
  });

  it("propagates a live release-barrier rejection without applying geometry", async () => {
    const { browser, page, view, host, releaseInput } = await launch();
    const writes = view.setBounds.mock.calls.length;
    const hostWrites = host.setContentSize.mock.calls.length;
    const commands = view.webContents.debugger.sendCommand.mock.calls.length;
    const subscriptions = view.webContents.beginFrameSubscription.mock.calls.length;
    const error = new Error("Release barrier failed");
    releaseInput.mockRejectedValueOnce(error);
    try {
      await expect(
        page.applyGeometry!({ person: { width: 820, height: 610 }, agent: null }),
      ).rejects.toBe(error);
      expect(view.setBounds.mock.calls).toHaveLength(writes);
      expect(host.setContentSize.mock.calls).toHaveLength(hostWrites);
      expect(view.webContents.debugger.sendCommand.mock.calls).toHaveLength(commands);
      expect(view.webContents.beginFrameSubscription.mock.calls).toHaveLength(subscriptions);
      await page.applyGeometry!({ person: { width: 820, height: 610 }, agent: null });
      expect(view.getBounds()).toEqual({ x: 0, y: 0, width: 820, height: 610 });
    } finally {
      await browser.close();
    }
  });

  it.each(["resolve", "reject"] as const)(
    "recomputes a newer live epoch when the obsolete release barrier %ss",
    async (outcome) => {
      const { browser, native, view, host, drain, releaseInput } = await launch();
      const placed = vi.fn();
      native.mount(
        host as unknown as BaseWindow,
        { x: 10, y: 20, width: 800, height: 600 },
        placed,
      );
      await drain();
      const entered = Promise.withResolvers<void>();
      const barrier = Promise.withResolvers<void>();
      releaseInput.mockImplementation(() => {
        if (releaseInput.mock.calls.length > 3) throw new Error("Placement retried its barrier");
        return Promise.resolve();
      });
      releaseInput.mockImplementationOnce(() => {
        entered.resolve();
        return barrier.promise;
      });
      const writes = view.setBounds.mock.calls.length;
      native.setStage({ x: 30, y: 40, width: 820, height: 610 });
      await entered.promise;
      native.setStage({ x: 50, y: 60, width: 840, height: 620 });
      placed.mockClear();
      try {
        if (outcome === "resolve") barrier.resolve();
        else barrier.reject(new Error("Obsolete release barrier failed"));
        await drain();
        expect(releaseInput).toHaveBeenCalledTimes(2);
        expect(view.setBounds.mock.calls.slice(writes)).toEqual([
          [{ x: 50, y: 60, width: 840, height: 620 }],
        ]);
        expect(placed).toHaveBeenCalledTimes(1);
        expect(placed).toHaveBeenLastCalledWith(
          expect.objectContaining({ bounds: { x: 50, y: 60, width: 840, height: 620 } }),
        );
        const commands = view.webContents.debugger.sendCommand.mock.calls.length;
        await native.invalidateSurface();
        expect(view.webContents.debugger.sendCommand.mock.calls.length).toBeGreaterThan(commands);
      } finally {
        await browser.close();
      }
    },
  );

  it("rejects geometry canceled at a layout acknowledgment", async () => {
    const { browser, page, view, unbind } = await launch();
    const entered = Promise.withResolvers<void>();
    const layout = Promise.withResolvers<unknown>();
    const send = view.webContents.debugger.sendCommand.getMockImplementation()!;
    view.webContents.debugger.sendCommand.mockImplementation((method) => {
      if (method === "Page.getLayoutMetrics") {
        entered.resolve();
        return layout.promise;
      }
      return send(method);
    });
    const pending = page.applyGeometry!({ person: { width: 820, height: 610 }, agent: null }).then(
      () => null,
      (error: unknown) => error,
    );
    await entered.promise;
    unbind();
    const commands = view.webContents.debugger.sendCommand.mock.calls.length;
    layout.resolve({});
    try {
      expect(await pending).toBeInstanceOf(Error);
      expect(view.webContents.debugger.sendCommand.mock.calls).toHaveLength(commands);
    } finally {
      await browser.close();
    }
  });

  it("reconciles a recovered renderer in a new live navigation epoch", async () => {
    const { browser, page, native, view, host, drain } = await launch();
    native.mount(host as unknown as BaseWindow, { x: 10, y: 20, width: 800, height: 600 }, vi.fn());
    await drain();
    try {
      for (const [event, listener] of view.webContents.on.mock.calls)
        if (event === "render-process-gone") listener({}, { reason: "crashed" });
      await expect(
        page.applyGeometry!({ person: { width: 800, height: 600 }, agent: null }),
      ).rejects.toThrow(/crashed|canceled|aborted/);
      for (const [event, listener] of view.webContents.on.mock.calls)
        if (event === "did-navigate") listener({}, "https://example.test");
      native.setStage({ x: 30, y: 40, width: 820, height: 610 });
      await drain();
      expect(view.getBounds()).toEqual({ x: 30, y: 40, width: 820, height: 610 });
    } finally {
      await browser.close();
    }
  });

  it("keeps full child and ledger geometry when the resting host constrains its content size", async () => {
    const { browser, native, view, host } = await launch(false);
    const ledger = new SurfaceLedger(browser.context, {
      initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
    });
    host.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 800, height: 600 });
    await ledger.start();
    const surface = ledger.snapshot()[0]!;
    const size = { width: 2560, height: 1600 };
    const before = host.setContentSize.mock.calls.length;
    try {
      await ledger.fitViewport(surface.id, size);
      expect(view.getBounds()).toEqual({ x: 0, y: 0, ...size });
      expect(ledger.viewportOf(surface.id)).toEqual(size);
      expect(ledger.appliedGeometry(surface.id)?.geometry).toEqual({ person: size, agent: null });
      if (process.platform !== "linux") expect(host.showInactive).toHaveBeenCalled();
      await native.invalidateSurface();
      await native.invalidateSurface();
      await ledger.fitViewport(surface.id, size);
      expect(host.setContentSize.mock.calls.slice(before)).toEqual([[2560, 1600]]);
      expect(host.getContentBounds()).toMatchObject({ width: 800, height: 600 });
      expect(view.getBounds()).toEqual({ x: 0, y: 0, ...size });
      expect(ledger.viewportOf(surface.id)).toEqual(size);
      expect(ledger.appliedGeometry(surface.id)?.geometry).toEqual({ person: size, agent: null });
    } finally {
      await ledger.close();
      await browser.close();
    }
  });

  it("rejects a terminal paint epoch without retrying the same aborted signal", async () => {
    const { browser, native, view, unbind } = await launch();
    unbind();
    // Bound the reproduction by reads, since the original microtask spin starves timers.
    let reads = 0;
    view.webContents.isDestroyed.mockImplementation(() => {
      if (++reads > 20) throw new Error("Paint retried a terminal epoch");
      return false;
    });
    try {
      await expect(native.waitForPaint()).rejects.toThrow(/canceled|closed|aborted/);
      expect(reads).toBeLessThan(20);
    } finally {
      view.webContents.isDestroyed.mockImplementation(() => false);
      await browser.close();
    }
  });

  it("cancels an existing paint wait when its geometry owner releases it", async () => {
    const { browser, native, view, unbind } = await launch();
    view.webContents.beginFrameSubscription.mockImplementation(() => undefined);
    const waiting = native.waitForPaint();
    unbind();
    await expect(waiting).rejects.toThrow(/canceled|closed/);
    await browser.close();
  });

  it("starts a live epoch for a new geometry owner after release", async () => {
    const { browser, page, view, unbind, serialize, releaseInput } = await launch();
    unbind();
    const rebind = page.bindGeometry!(serialize, releaseInput);
    try {
      await page.applyGeometry!({ person: { width: 820, height: 610 }, agent: null });
      expect(view.getBounds()).toEqual({ x: 0, y: 0, width: 820, height: 610 });
    } finally {
      rebind();
      await browser.close();
    }
  });

  it("stops an origin-only unmount reconciliation canceled by page close", async () => {
    const { browser, page, native, view, host, drain, unbind } = await launch();
    native.mount(host as unknown as BaseWindow, { x: 10, y: 20, width: 800, height: 600 }, vi.fn());
    await drain();
    const getBounds = view.getBounds.getMockImplementation()!;
    let reads = 0;
    view.getBounds.mockImplementation(() => {
      if (++reads > 20) throw new Error("Placement retried a terminal epoch");
      return getBounds();
    });
    native.unmount();
    try {
      await page.close();
      await expect(drain()).rejects.toThrow(/canceled|closed|aborted/);
      expect(reads).toBeLessThan(20);
    } finally {
      unbind();
      view.getBounds.mockImplementation(getBounds);
      await browser.close();
    }
  });

  it("keeps capture identity across equal-size mount and unmount", async () => {
    const { browser, page, native, host, drain } = await launch();
    try {
      const resting = page.capture!.read();
      expect(resting).not.toBeNull();
      expect(resting).not.toHaveProperty("mounted");
      native.mount(
        host as unknown as BaseWindow,
        { x: 10, y: 20, width: 800, height: 600 },
        vi.fn(),
      );
      await drain();
      expect(page.capture!.read()).toEqual(resting);
      native.unmount();
      await drain();
      expect(page.capture!.read()).toEqual(resting);
    } finally {
      await browser.close();
    }
  });

  it("does not invalidate for owner resize events without a stage or scale change", async () => {
    const { browser, page, native, view, host, drain } = await launch();
    native.mount(host as unknown as BaseWindow, { x: 10, y: 20, width: 800, height: 600 }, vi.fn());
    await drain();
    await native.waitForPaint();
    const writes = view.setBounds.mock.calls.length;
    const commands = view.webContents.debugger.sendCommand.mock.calls.length;
    const subscriptions = view.webContents.beginFrameSubscription.mock.calls.length;
    const resize = host.on.mock.calls.find(([name]) => name === "resize")![1];
    resize();
    await drain();
    await page.applyGeometry!({ person: { width: 800, height: 600 }, agent: null });
    expect(view.setBounds.mock.calls).toHaveLength(writes);
    expect(view.webContents.debugger.sendCommand.mock.calls).toHaveLength(commands);
    expect(view.webContents.beginFrameSubscription.mock.calls).toHaveLength(subscriptions);
    await browser.close();
  });

  it("releases held input for size changes and keeps origin-only placement atomic", async () => {
    const { browser, page, native, view, host, drain, releaseInput } = await launch();
    native.mount(host as unknown as BaseWindow, { x: 10, y: 20, width: 800, height: 600 }, vi.fn());
    await drain();
    native.setStage({ x: 30, y: 40, width: 800, height: 600 });
    await drain();
    expect(releaseInput).not.toHaveBeenCalled();
    const before = releaseInput.mock.calls.length;
    native.setStage({ x: 30, y: 40, width: 820, height: 610 });
    await drain();
    await page.applyGeometry!({ person: { width: 820, height: 610 }, agent: null });
    expect(releaseInput.mock.calls.length - before).toBe(1);
    expect(view.getBounds()).toEqual({ x: 30, y: 40, width: 820, height: 610 });
    await browser.close();
  });

  it.each([false, true])(
    "keeps Fit at the latest native size after emulation (mounted=%s)",
    async (mounted) => {
      const { browser, page, native, view, host, drain } = await launch();
      if (mounted) {
        native.mount(
          host as unknown as BaseWindow,
          { x: 10, y: 20, width: 800, height: 600 },
          vi.fn(),
        );
        await drain();
      }
      let widget = { width: 800, height: 600 };
      let cached: typeof widget | null = null;
      let emulated: typeof widget | null = null;
      const setBounds = view.setBounds.getMockImplementation()!;
      view.setBounds.mockImplementation((bounds) => {
        setBounds(bounds);
        widget = { width: bounds.width, height: bounds.height };
      });
      const commands: { method: string; parameters: Record<string, unknown> | undefined }[] = [];
      view.webContents.debugger.sendCommand.mockImplementation(
        async (method, parameters?: Record<string, unknown>) => {
          commands.push({ method, parameters });
          // Chromium 152 WebContentsImpl::Set/ClearDeviceEmulationSize caches this
          // widget size independently of Electron's View bounds.
          if (
            method === "Emulation.setDeviceMetricsOverride" &&
            parameters?.dontSetVisibleSize !== true
          ) {
            cached ??= { ...widget };
            emulated = { width: Number(parameters?.width), height: Number(parameters?.height) };
            widget = { ...emulated };
          }
          if (method === "Emulation.clearDeviceMetricsOverride") {
            if (cached && widget.width === emulated?.width && widget.height === emulated.height)
              widget = cached;
            cached = null;
            emulated = null;
          }
          return {};
        },
      );
      const agent = {
        width: 800,
        height: 600,
        deviceScaleFactor: 0,
        mobile: false,
        screenWidth: 430,
        screenHeight: 932,
        screenOrientation: { type: "portraitPrimary", angle: 0 },
      };
      await page.applyGeometry!({ person: { width: 800, height: 600 }, agent });
      if (mounted) {
        native.setStage({ x: 10, y: 20, width: 819, height: 611 });
        await drain();
      }
      await page.applyGeometry!({
        person: { width: 819, height: 611 },
        agent: { ...agent, width: 819, height: 611 },
      });
      await page.applyGeometry!({ person: { width: 819, height: 611 }, agent: null });
      expect(widget).toEqual({ width: 819, height: 611 });
      const metrics = commands.filter(
        ({ method }) => method === "Emulation.setDeviceMetricsOverride",
      );
      expect(metrics[0]!.parameters).toEqual({ ...agent, dontSetVisibleSize: true });
      const before = commands.length;
      await page.applyGeometry!({ person: { width: 819, height: 611 }, agent: null });
      expect(commands).toHaveLength(before);
      await browser.close();
    },
  );
});

describe("native page security formerly exercised by Sec01, I and C", () => {
  it("creates sandboxed isolated page preferences and refuses nonweb navigation", async () => {
    const launcher = new ElectronBrowserLauncher({
      downloads: { accept: () => undefined },
      pagePolicyPreloadPath: "/policy.cjs",
    });
    const browser = await launcher.launch({
      initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
      partitionKey: "session:security",
      sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000001"),
      storage: { kind: "guest" },
    });
    try {
      const view = electron.views.at(-1)!;
      expect(view.options.webPreferences).toMatchObject({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      });
      const navigate = view.webContents.on.mock.calls.find(
        ([name]) => name === "will-navigate",
      )![1];
      for (const url of [
        "opensteer://forbidden",
        "unknown:test",
        "file:///etc/passwd",
        "javascript:alert(1)",
      ]) {
        const preventDefault = vi.fn();
        navigate({ preventDefault }, url);
        expect(preventDefault).toHaveBeenCalledOnce();
        const popup = view.webContents.setWindowOpenHandler.mock.calls[0]![0];
        expect(popup({ url })).toMatchObject({ action: "deny" });
      }
    } finally {
      await browser.close();
    }
  });
  it("binds different partition identities to different Electron sessions (Sec01)", async () => {
    const { session } = await import("electron");
    const launcher = new ElectronBrowserLauncher({
      downloads: { accept: () => undefined },
      pagePolicyPreloadPath: "/policy.cjs",
    });
    const browsers = [];
    try {
      for (const key of ["session:one", "session:two"] as const) {
        browsers.push(
          await launcher.launch({
            initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
            partitionKey: key,
            sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000001"),
            storage: { kind: "guest" },
          }),
        );
        expect(electron.views.at(-1)!.options.webPreferences).toMatchObject({
          session: session.fromPartition(electronBrowserPartition(key)),
        });
      }
      expect(session.fromPartition(electronBrowserPartition("session:one"))).not.toBe(
        session.fromPartition(electronBrowserPartition("session:two")),
      );
    } finally {
      await Promise.all(browsers.map((b) => b.close()));
      launcher.close();
    }
  });
  it.each(["mouse", "Shift-F10"])(
    "overwrites pending person provenance with %s agent input and keeps exclusion until both commands settle (C02/I05)",
    async (kind) => {
      const launcher = new ElectronBrowserLauncher({
        downloads: { accept: () => undefined },
        pagePolicyPreloadPath: "/policy.cjs",
      });
      const browser = await launcher.launch({
        initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
        partitionKey: "session:race",
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000001"),
        storage: { kind: "guest" },
      });
      try {
        const page = browser.context.pages()[0]!,
          native = electronPagePresentation(page)!;
        const contents = electron.views.at(-1)!.webContents;
        const emit = (event: string, input: Record<string, unknown>) =>
          contents.on.mock.calls.find(([name]) => name === event)![1]({}, input);
        const unbind = page.bindGeometry!(
          (op) => op(),
          async () => undefined,
        );
        await page.applyGeometry!({ person: { width: 800, height: 600 }, agent: null });
        emit("before-mouse-event", { type: "mouseDown", button: "right", x: 1, y: 2 });
        const first = Promise.withResolvers<unknown>(),
          second = Promise.withResolvers<unknown>();
        let calls = 0;
        contents.debugger.sendCommand.mockImplementation((method) =>
          method.startsWith("Input.")
            ? ++calls === 1
              ? first.promise
              : second.promise
            : Promise.resolve({}),
        );
        const agent = await page.agentCdp!();
        const a = agent.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "right" });
        const b = agent.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "F10",
          modifiers: 8,
        });
        await vi.waitFor(() => expect(calls).toBe(2));
        if (kind === "mouse")
          emit("before-mouse-event", { type: "mouseDown", button: "right", x: 1, y: 2 });
        else
          emit("before-input-event", { type: "keyDown", key: "F10", shift: true, control: false });
        const otherPage = await browser.context.createPage();
        const otherNative = electronPagePresentation(otherPage)!;
        const otherContents = electron.views.at(-1)!.webContents;
        otherContents.on.mock.calls.find(([name]) => name === "input-event")![1](
          {},
          { type: "mouseDown" },
        );
        expect(otherNative.takeContextMenuTrigger()).toBe(null);
        otherContents.on.mock.calls.find(([name]) => name === "before-mouse-event")![1](
          {},
          { type: "mouseDown", button: "right", x: 7, y: 8 },
        );
        first.resolve({});
        await a;
        expect(native.inputOutstanding()).toBe(true);
        second.resolve({});
        await b;
        expect(native.inputOutstanding()).toBe(false);
        emit("input-event", { type: kind === "mouse" ? "mouseDown" : "keyDown" });
        expect(native.takeContextMenuTrigger()).toBe("agent");
        expect(native.takeContextMenuTrigger()).toBe(null);
        otherContents.on.mock.calls.find(([name]) => name === "input-event")![1](
          {},
          { type: "mouseDown" },
        );
        expect(otherNative.takeContextMenuTrigger()).toBe("person");
        unbind();
      } finally {
        await browser.close();
        launcher.close();
      }
    },
  );
  it("keeps activity coarse, exclusion per page and context provenance single use", async () => {
    const launcher = new ElectronBrowserLauncher({
      downloads: { accept: () => undefined },
      pagePolicyPreloadPath: "/policy.cjs",
    });
    const browser = await launcher.launch({
      initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
      partitionKey: "session:provenance",
      sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000001"),
      storage: { kind: "guest" },
    });
    try {
      const page = browser.context.pages()[0]!,
        native = electronPagePresentation(page)!;
      const contents = electron.views.at(-1)!.webContents;
      const listener = (event: string) =>
        contents.on.mock.calls.find(([name]) => name === event)![1];
      const unbind = page.bindGeometry!(
        (operation) => operation(),
        async () => undefined,
      );
      await page.applyGeometry!({ person: { width: 800, height: 600 }, agent: null });
      const activity = vi.fn();
      page.observeHumanInput!(activity);
      listener("before-input-event")({}, { type: "keyDown", key: "private-text", control: false });
      expect(activity.mock.calls).toEqual([[{ kind: "typing" }]]);
      listener("before-mouse-event")({}, { type: "mouseDown", button: "right", x: 1, y: 2 });
      listener("input-event")({}, { type: "mouseDown" });
      expect(native.takeContextMenuTrigger()).toBe("person");
      expect(native.takeContextMenuTrigger()).toBe(null);
      listener("input-event")({}, { type: "mouseDown" });
      expect(native.takeContextMenuTrigger()).toBe(null);
      const pending = Promise.withResolvers<unknown>();
      contents.debugger.sendCommand.mockImplementation((method) =>
        method.startsWith("Input.") ? pending.promise : Promise.resolve({}),
      );
      const agent = await page.agentCdp!();
      const command = agent.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "right",
      });
      await vi.waitFor(() => expect(native.inputOutstanding()).toBe(true));
      activity.mockClear();
      listener("before-mouse-event")({}, { type: "mouseDown", button: "right", x: 1, y: 2 });
      listener("input-event")({}, { type: "mouseDown" });
      expect(native.takeContextMenuTrigger()).toBe("agent");
      expect(activity).not.toHaveBeenCalled();
      const other = await launcher.launch({
        initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
        partitionKey: "session:independent-provenance",
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000002"),
        storage: { kind: "guest" },
      });
      try {
        const otherActivity = vi.fn();
        other.context.pages()[0]!.observeHumanInput!(otherActivity);
        const otherContents = electron.views.at(-1)!.webContents;
        const mouse = otherContents.on.mock.calls.find(
          ([name]) => name === "before-mouse-event",
        )![1];
        mouse({}, { type: "mouseDown", button: "left", x: 7, y: 8 });
        expect(otherActivity).toHaveBeenCalledWith({ kind: "click", x: 7, y: 8 });
        expect(activity).not.toHaveBeenCalled();
      } finally {
        await other.close();
      }
      pending.resolve({});
      await command;
      unbind();
    } finally {
      await browser.close();
    }
  });
});

it.each([false, true])(
  "owns commit, TLS and context before attachment with retained world %s and held Page replies",
  async (retained) => {
    const ceremony = vi.fn(async () => ({
      kind: "refused" as const,
      error: "InvalidStateError" as const,
    }));
    const sent: string[] = [];
    const held: PromiseWithResolvers<unknown>[] = [];
    let deliver: (method: string, parameters: unknown) => void = () => undefined;
    electron.bootstrap = (method, emit) => {
      deliver = emit;
      sent.push(method);
      if (method === "Page.enable") {
        const reply = Promise.withResolvers<unknown>();
        held.push(reply);
        return reply.promise;
      }
      if (method === "Runtime.enable") {
        if (retained) {
          emit("Runtime.executionContextCreated", {
            context: {
              id: 1,
              uniqueId: "first-context",
              origin: "https://example.test",
              auxData: { frameId: "target-1", isDefault: true, type: "default" },
            },
          });
        }
        emit("Network.responseReceived", {
          type: "Document",
          frameId: "target-1",
          loaderId: "first-loader",
          response: {
            url: "https://example.test/",
            securityState: "secure",
            securityDetails: { protocol: "TLS 1.3" },
          },
        });
        emit("Page.frameNavigated", {
          frame: {
            id: "target-1",
            loaderId: "first-loader",
            url: "https://example.test/",
            securityOrigin: "https://example.test",
          },
        });

        if (!retained) {
          emit("Runtime.executionContextCreated", {
            context: {
              id: 1,
              uniqueId: "first-context",
              origin: "https://example.test",
              auxData: { frameId: "target-1", isDefault: true, type: "default" },
            },
          });
        }
      }
      return undefined;
    };
    const launching = new ElectronBrowserLauncher({
      authenticator: { ceremony },
      downloads: { accept: () => undefined },
      pagePolicyPreloadPath: "/opensteer/browser-page-preload.cjs",
    }).launch({
      initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
      partitionKey: "session:bsn_00000000-0000-4000-8000-000000000099",
      sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000099"),
      storage: { kind: "guest" },
    });
    try {
      try {
        await vi.waitFor(() => expect(sent).toContain("Target.getTargetInfo"));
        expect(sent).toContain("Network.enable");
        expect(sent).toContain("Security.enable");
        expect(sent.indexOf("Network.enable")).toBeLessThan(sent.indexOf("Runtime.enable"));
        expect(sent.indexOf("Security.enable")).toBeLessThan(sent.indexOf("Runtime.enable"));
        expect(sent).toContain("Page.addScriptToEvaluateOnNewDocument");
      } finally {
        for (const reply of held) reply.resolve({});
      }
      await launching;
      const debug = electron.views.at(-1)!.webContents.debugger;
      await vi.waitFor(() =>
        expect(debug.sendCommand.mock.calls.some(([m]) => m === "Runtime.addBinding")).toBe(true),
      );
      const registration = debug.sendCommand.mock.calls.find(([m]) => m === "Runtime.addBinding")!;
      debug.sendCommand.mockImplementation(async (method) =>
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: {
                  id: "target-1",
                  url: "https://example.test/",
                  securityOrigin: "https://example.test",
                },
              },
            }
          : method === "Page.getPermissionsPolicyState"
            ? { states: [{ feature: "publickey-credentials-get", allowed: true }] }
            : {},
      );
      deliver("Runtime.bindingCalled", {
        name: registration[1]!.name,
        executionContextId: 1,
        payload: JSON.stringify({ op: "get", id: "first", options: { challenge: "AQID" } }),
      });
      await vi.waitFor(() => expect(ceremony).toHaveBeenCalledOnce());
    } finally {
      for (const reply of held) reply.resolve({});
      electron.bootstrap = undefined;
      await (await launching).close();
    }
  },
);

it("closes a failed provider bootstrap without retrying an initial domain enable", async () => {
  let attempts = 0;
  electron.bootstrap = (method) =>
    method === "Network.enable" && ++attempts === 1
      ? Promise.reject(new Error("Synthetic bootstrap failure."))
      : undefined;
  const launcher = new ElectronBrowserLauncher({
    authenticator: { ceremony: async () => ({ kind: "refused", error: "NotAllowedError" }) },
    downloads: { accept: () => undefined },
    pagePolicyPreloadPath: "/opensteer/browser-page-preload.cjs",
  });
  let browser;
  try {
    browser = await launcher
      .launch({
        initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
        partitionKey: "session:bsn_00000000-0000-4000-8000-000000000098",
        sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000098"),
        storage: { kind: "guest" },
      })
      .catch(() => undefined);
    expect(attempts).toBe(1);
    if (browser) await vi.waitFor(() => expect(browser!.context.pages()).toHaveLength(0));
  } finally {
    electron.bootstrap = undefined;
    await browser?.close();
    launcher.close();
  }
});

it("updates provider header policy disabled, enabled, disabled on the same Session", async () => {
  const { session } = await import("electron");
  const accept = vi.fn();
  const launcher = new ElectronBrowserLauncher({
    downloads: { accept },
    pagePolicyPreloadPath: "/tmp/browser-page-preload.cjs",
  });
  const sessionId = BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000009");
  const observed: boolean[] = [];
  try {
    for (const provider of [false, true, false]) {
      const browser = await launcher.launch({
        sessionId,
        partitionKey: `session:${sessionId}`,
        initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
        storage: { kind: "guest" },
        ...(provider
          ? {
              authenticator: {
                ceremony: async () => ({
                  kind: "refused" as const,
                  error: "NotAllowedError" as const,
                }),
              },
            }
          : {}),
      });
      try {
        const profile = vi.mocked(session.fromPartition).mock.results.at(-1)!.value as {
          webRequest: { onHeadersReceived: ReturnType<typeof vi.fn> };
          registerPreloadScript: ReturnType<typeof vi.fn>;
          setPermissionCheckHandler: ReturnType<typeof vi.fn>;
        };
        const headers = profile.webRequest.onHeadersReceived.mock.calls.at(-1)![1] as (
          details: object,
          answer: (value: { responseHeaders: Record<string, string[]> }) => void,
        ) => void;
        headers(
          { resourceType: "mainFrame", url: "https://example.test", responseHeaders: {} },
          (value) =>
            observed.push(!JSON.stringify(value.responseHeaders).includes("publickey-credentials")),
        );
        expect(observed.at(-1)).toBe(provider);
        expect(profile.registerPreloadScript).toHaveBeenCalledTimes(1);
        expect(profile.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
      } finally {
        await browser.close();
      }
    }
    expect(observed).toEqual([false, true, false]);
    expect(accept).toHaveBeenCalledTimes(1);
  } finally {
    launcher.close();
  }
});

describe("native Electron profiles", () => {
  async function fixture(policyFailure = false) {
    const root = await mkdtemp(path.join(tmpdir(), "opensteer-native-unit-"));
    const binding: LocalProfileBinding = {
      version: 1,
      deploymentId: createId("deployment"),
      profileId: createId("browserProfile"),
      runnerId: createId("runner"),
      storageInstanceId: randomUUID(),
      bindingId: randomUUID(),
      engine: "electron",
    };
    const directory = path.join(root, "profiles", binding.profileId, "native");
    const launcher = new ElectronBrowserLauncher({
      downloads: {
        accept: vi.fn(() => {
          if (policyFailure) throw new Error("policy failed");
        }),
      },
      pagePolicyPreloadPath: "/policy.cjs",
      localProfileRoot: root,
    });
    const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
    return {
      root,
      binding,
      directory,
      launcher,
      launch: () =>
        launcher.launch({
          sessionId,
          partitionKey: `profile:${binding.profileId}`,
          initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
          storage: { kind: "local", binding, directory },
        }),
    };
  }
  it("waits for origin import completion, verifies cookies and commits localStorage before ready", async () => {
    const f = await fixture();
    const { session } = await import("electron");
    let finish!: () => void;
    const committed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    electron.storage = () => committed;
    try {
      const initializing = f.launcher.localProfiles.importAndFlush({
        directory: f.directory,
        binding: f.binding,
        snapshot: {
          cookies: [],
          origins: ["https://a.test", "https://b.test"].map((origin) => ({
            origin,
            localStorage: [{ name: "key", value: "value" }],
          })),
        },
        signal: new AbortController().signal,
      });
      await vi.waitFor(
        () =>
          expect(
            electron.views.filter((view) => "executeJavaScriptInIsolatedWorld" in view.webContents),
          ).not.toHaveLength(0),
        { timeout: 1000 },
      );
      const profile = vi.mocked(session.fromPath).mock.results.at(-1)!.value;
      expect(profile.flushStorageData).not.toHaveBeenCalled();
      finish();
      await initializing;
      expect(profile.flushStorageData).toHaveBeenCalledOnce();
      expect(profile.clearStorageData).toHaveBeenCalledExactlyOnceWith({
        origin: expect.stringMatching(/^https:\/\/[a-f0-9-]+\.invalid$/u),
        storages: ["localstorage"],
      });
      expect(profile.cookies.flushStore.mock.invocationCallOrder[0]).toBeLessThan(
        profile.flushStorageData.mock.invocationCallOrder[0],
      );
      expect(profile.flushStorageData.mock.invocationCallOrder[0]).toBeLessThan(
        profile.clearStorageData.mock.invocationCallOrder[0],
      );
    } finally {
      finish();
      electron.storage = undefined;
      await f.launcher.localProfiles.release(f.directory);
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("detects silent cookie import rejection by readback and keeps failed native data fenced", async () => {
    const f = await fixture();
    const { session } = await import("electron");
    try {
      await expect(
        f.launcher.localProfiles.importAndFlush({
          directory: f.directory,
          binding: f.binding,
          snapshot: {
            cookies: [
              {
                name: "missing",
                value: "value",
                domain: "site.test",
                path: "/",
                expires: -1,
                httpOnly: true,
                secure: true,
              },
            ],
            origins: [],
          },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow();
      const profile = vi.mocked(session.fromPath).mock.results.at(-1)!.value;
      expect(profile.clearCache).not.toHaveBeenCalled();
      expect(profile.clearStorageData).not.toHaveBeenCalled();
      await expect(f.launch()).rejects.toThrow();
    } finally {
      await f.launcher.localProfiles.release(f.directory);
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("prepares with Guest only and never allocates a persistent Session", async () => {
    const f = await fixture();
    const { session } = await import("electron");
    const calls = vi.mocked(session.fromPath).mock.calls.length;
    try {
      await f.launcher.prepare();
      expect(vi.mocked(session.fromPath).mock.calls).toHaveLength(calls);
      expect(await readdir(f.root)).toEqual([]);
    } finally {
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("remembers a Session even if policy setup fails and never retries conversion in that process", async () => {
    const f = await fixture(true);
    try {
      await expect(
        f.launcher.localProfiles.importAndFlush({
          directory: f.directory,
          binding: f.binding,
          snapshot: { cookies: [], origins: [] },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("policy failed");
      expect(await f.launcher.localProfiles.release(f.directory)).toBe("retained-until-exit");
      await expect(f.launch()).rejects.toThrow();
    } finally {
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("retains the exact persistent Session through close and deletion reports pending restart", async () => {
    const f = await fixture();
    const { session } = await import("electron");
    try {
      expect(await f.launcher.localProfiles.release(f.directory)).toBe("released");
      await f.launcher.localProfiles.importAndFlush({
        directory: f.directory,
        binding: f.binding,
        snapshot: { cookies: [], origins: [] },
        signal: new AbortController().signal,
      });
      const profile = vi.mocked(session.fromPath).mock.results.at(-1)!.value;
      const browser = await f.launch();
      await browser.close();
      const reopened = await f.launch();
      await reopened.close();
      expect(session.fromPath).toHaveBeenCalledWith(f.directory);
      expect(profile.clearCache).not.toHaveBeenCalled();
      expect(profile.clearStorageData).not.toHaveBeenCalled();
      expect(profile.cookies.flushStore).toHaveBeenCalled();
      expect(await f.launcher.localProfiles.release(f.directory)).toBe("retained-until-exit");
    } finally {
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("refuses a missing ready mirror before constructing any page and retains the Session after failure", async () => {
    const f = await fixture();
    const count = electron.views.length;
    try {
      await expect(f.launch()).rejects.toThrow();
      expect(electron.views).toHaveLength(count);
      expect(await f.launcher.localProfiles.release(f.directory)).toBe("retained-until-exit");
    } finally {
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

import { cdpProfileRefusal } from "@opensteer/browser-core";
import { SurfaceLedger, type BrowserLaunchRequest } from "@opensteer/browser-runtime-core";
import { createId } from "@opensteer/core";
import type { LocalProfileBinding } from "@opensteer/protocol";
import { BrowserSessionIdSchema } from "@opensteer/protocol";
import { gate } from "@opensteer/shared/test-support/observation";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { app, BaseWindow, session, webContents } from "electron";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Bounds = { x: number; y: number; width: number; height: number };

const electron = vi.hoisted(() => ({
  restore: undefined as undefined | (() => Promise<void>),
  storage: undefined as undefined | (() => Promise<unknown>),
  blankLoad: undefined as undefined | (() => Promise<void>),
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
      backgroundThrottling: boolean;
      close: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
      forcefullyCrashRenderer: ReturnType<typeof vi.fn>;
      loadURL: ReturnType<typeof vi.fn>;
      getURL: ReturnType<typeof vi.fn<() => string>>;
      isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
      beginFrameSubscription: ReturnType<typeof vi.fn>;
      endFrameSubscription: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      off: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
      debugger: {
        attach: ReturnType<typeof vi.fn>;
        detach: ReturnType<typeof vi.fn>;
        isAttached: ReturnType<typeof vi.fn<() => boolean>>;
        on: ReturnType<typeof vi.fn>;
        sendCommand: ReturnType<
          typeof vi.fn<
            (
              method: string,
              parameters?: Record<string, unknown>,
              sessionId?: string,
            ) => Promise<unknown>
          >
        >;
      };
    };
    getBounds: ReturnType<typeof vi.fn<() => Bounds>>;
    setBounds: ReturnType<typeof vi.fn<(bounds: Bounds) => void>>;
  }>,
}));

// Each debugger session's state, as the hub makes it, to read what it still keeps.
const debuggerSessions = vi.hoisted(() => [] as unknown[]);
vi.mock("./electron-debugger-session.js", async (original) => {
  const made = await original<typeof import("./electron-debugger-session.js")>();
  return {
    DebuggerSessionState: class extends made.DebuggerSessionState {
      constructor() {
        super();
        debuggerSessions.push(this);
      }
    },
  };
});
vi.mock("electron", () => {
  class MockWebContents {
    readonly id = electron.views.length + 1;
    backgroundThrottling = true;
    readonly navigationHistory = {
      restore: vi.fn(async () => electron.restore?.()),
      getAllEntries: vi.fn(() => [{ url: "https://restore.test/", title: "Saved" }]),
      getActiveIndex: vi.fn(() => 0),
    };
    readonly isCurrentlyAudible = vi.fn(() => false);
    readonly isBeingCaptured = vi.fn(() => false);
    readonly opener = null;
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
            method === "Target.attachToTarget"
              ? { sessionId: "agent-native-session" }
              : method === "Target.getTargetInfo"
                ? { targetInfo: { targetId: "target-1" } }
                : method === "Page.getFrameTree"
                  ? {
                      frameTree: {
                        frame: { id: "target-1", loaderId: "loader-1", url: this.getURL() },
                      },
                    }
                  : method === "Network.getAllCookies"
                    ? { cookies: [] }
                    : {},
          )
        );
      }),
    };
    readonly focus = vi.fn();
    readonly forcefullyCrashRenderer = vi.fn();
    readonly beginFrameSubscription = vi.fn(
      (callback: (image: { getSize(): { width: number; height: number } }) => void) =>
        setImmediate(() => callback({ getSize: () => ({ width: 800, height: 600 }) })),
    );
    readonly endFrameSubscription = vi.fn();
    readonly close = vi.fn(() => {
      this.isDestroyed.mockReturnValue(true);
      for (const [event, listener] of this.once.mock.calls) if (event === "destroyed") listener();
    });
    readonly destroy = vi.fn();
    readonly stopFindInPage = vi.fn();
    readonly getTitle = vi.fn(() => "");
    readonly getURL = vi.fn(() => "about:blank");
    readonly isDestroyed = vi.fn(() => false);
    readonly loadURL = vi.fn(async (url: string) =>
      url === "about:blank" ? electron.blankLoad?.() : undefined,
    );
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
    getUserAgent: vi.fn(
      () =>
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.169 Electron/44.10.2 Safari/537.36",
    ),
    on: vi.fn(),
    registerPreloadScript: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setUserAgent: vi.fn(),
    unregisterPreloadScript: vi.fn(),
    webRequest: {
      onBeforeRequest: vi.fn(),
      onBeforeSendHeaders: vi.fn(),
      onHeadersReceived: vi.fn(),
      onCompleted: vi.fn(),
      onErrorOccurred: vi.fn(),
    },
  });

  const sessions = new Map<string, ReturnType<typeof makeSession>>();
  return {
    ipcMain: { on: vi.fn(), off: vi.fn() },
    app: {
      getAppMetrics: vi.fn(() => []),
      on: vi.fn(),
      whenReady: vi.fn(async () => undefined),
      getPreferredSystemLanguages: () => ["en-US"],
      userAgentFallback:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Opensteer/1.0 Chrome/152.0.7977.169 Electron/44.10.2 Safari/537.36",
    },
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
    webContents: { getAllWebContents: vi.fn(() => []) },
    WebContentsView: MockWebContentsView,
    screen: { getDisplayMatching: vi.fn(() => ({ scaleFactor: 1 })), on: vi.fn(), off: vi.fn() },
    session: {
      defaultSession: {
        setUserAgent: vi.fn(),
        getUserAgent: vi.fn(
          () =>
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Opensteer/1.0 Chrome/152.0.7977.169 Electron/44.10.2 Safari/537.36",
        ),
      },
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

it("attributes renderer memory to its own frame trees and keeps unassigned counts separate", async () => {
  const launch = () =>
    new ElectronBrowserLauncher({
      downloads: { accept: vi.fn() },
      pagePolicyPreloadPath: path.resolve("browser-preload.cjs"),
    });
  const request = (suffix: string) => {
    const sessionId = BrowserSessionIdSchema.parse(
      `bsn_00000000-0000-4000-8000-0000000000${suffix}`,
    );
    return {
      initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
      partitionKey: `session:${sessionId}` as const,
      sessionId,
      storage: { kind: "guest" } as const,
    };
  };
  const frameTree = (pids: number[]) => ({
    framesInSubtree: pids.map((osProcessId) => ({ osProcessId, isDestroyed: () => false })),
  });
  const metric = (
    pid: number,
    workingSetSize: number,
    type: Electron.ProcessMetric["type"] = "Tab",
  ) => ({
    pid,
    type,
    memory: { workingSetSize, peakWorkingSetSize: workingSetSize },
    creationTime: 0,
    cpu: { cumulativeCPUUsage: 0, percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
  });
  const a = launch();
  const b = launch();
  const first = await a.launch(request("40"));
  const firstContents = Object.assign(electron.views.at(-1)!.webContents, {
    mainFrame: frameTree([1, 2, 2]),
    getOSProcessId: () => 1,
  });
  const second = await b.launch(request("41"));
  const secondContents = Object.assign(electron.views.at(-1)!.webContents, {
    mainFrame: frameTree([3, 4]),
    getOSProcessId: () => 3,
  });
  const product = {
    isDestroyed: () => false,
    mainFrame: frameTree([5, 6]),
    getOSProcessId: () => 5,
    session: session.defaultSession,
  };
  const metrics = [
    metric(1, 200),
    metric(2, 350),
    metric(2, 350),
    metric(3, 250),
    metric(4, 125),
    metric(5, 400),
    metric(6, 350),
    metric(7, 250),
    metric(8, 500, "GPU"),
  ];
  const usage = (launcher: InstanceType<typeof ElectronBrowserLauncher>, sample = metrics) => {
    vi.mocked(app.getAppMetrics).mockReturnValueOnce(sample);
    vi.mocked(webContents.getAllWebContents).mockReturnValueOnce([
      firstContents,
      secondContents,
      product,
    ] as unknown as Electron.WebContents[]);
    return launcher.rendererUsage();
  };
  try {
    expect(usage(a)).toEqual({ processes: 2, bytes: 550 * 1024, unassignedProcesses: 1 });
    expect(usage(b)).toEqual({ processes: 2, bytes: 375 * 1024, unassignedProcesses: 1 });
    expect(usage(a, [metric(1, 200), metric(2, 0)])).toMatchObject({ processes: 2, bytes: null });
    expect(usage(a, [])).toMatchObject({ bytes: null });
  } finally {
    await Promise.all([first.close(), second.close()]);
    a.close();
    b.close();
  }
});

it("restores a Guest page before announcing without loading a blank", async () => {
  const launcher = new ElectronBrowserLauncher({
    downloads: { accept: vi.fn() },
    pagePolicyPreloadPath: "/policy.cjs",
  });
  const browser = await launcher.launch({
    partitionKey: "session:restore",
    initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    storage: { kind: "guest" },
  });
  const state = {
    entries: [{ url: "https://restore.test/", title: "Saved" }],
    index: 0,
    sessionStorage: null,
  };
  try {
    const announced = vi.fn(() => {
      const view = electron.views.at(-1)!;
      expect(view.webContents.loadURL).not.toHaveBeenCalled();
      expect(
        (
          view.webContents as unknown as {
            navigationHistory: { restore: ReturnType<typeof vi.fn> };
          }
        ).navigationHistory.restore,
      ).toHaveBeenCalledWith({ entries: state.entries, index: 0 });
    });
    browser.context.onPage(announced);
    await browser.context.createPage({ restore: state });
    expect(announced).toHaveBeenCalledOnce();
  } finally {
    await browser.close();
    launcher.close();
  }
});

it("keeps POST results and engine activity awake and treats a POST redirect as GET", async () => {
  const downloads = { accept: vi.fn(), active: vi.fn(() => false) };
  const launcher = new ElectronBrowserLauncher({ downloads, pagePolicyPreloadPath: "/policy.cjs" });
  const browser = await launcher.launch({
    partitionKey: "session:signals",
    initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    storage: { kind: "guest" },
  });
  const contents = electron.views.at(-1)!.webContents as unknown as import("electron").WebContents;
  const page = browser.context.pages()[0]!;
  const { session } = await import("electron");
  const profile = vi.mocked(session.fromPartition).mock.results.at(-1)!.value;
  const before = vi.mocked(profile.webRequest.onBeforeRequest).mock.calls[0]![0] as (
    details: object,
    answer: (value: object) => void,
  ) => void;
  const emit = (event: string) => {
    for (const [name, listener] of electron.views.at(-1)!.webContents.on.mock.calls)
      if (name === event) listener();
  };
  const finished = vi.mocked(profile.webRequest.onCompleted).mock.calls[0]![0]!;
  const request = (method: string) => {
    before(
      {
        id: 0,
        url: "https://site.test/",
        resourceType: "mainFrame",
        webContentsId: contents.id,
        method,
      },
      () => {},
    );
    finished({ id: 0 } as import("electron").OnCompletedListenerDetails);
  };
  try {
    request("POST");
    emit("did-navigate");
    expect(await page.keepAwake!()).toBe("post");
    request("GET");
    emit("did-fail-load");
    expect(await page.keepAwake!()).toBe("post");
    request("POST");
    request("GET");
    emit("did-navigate");
    expect(await page.keepAwake!()).toBeNull();
    const upload = (id: number, method: string) =>
      before(
        {
          id,
          method,
          webContentsId: contents.id,
          url: "https://site.test/upload",
          resourceType: "xhr",
        },
        () => {},
      );
    const failed = vi.mocked(profile.webRequest.onErrorOccurred).mock.calls[0]![0]!;
    upload(1, "POST");
    upload(2, "PUT");
    expect(await page.keepAwake!()).toBe("upload");
    finished({ id: 1 } as import("electron").OnCompletedListenerDetails);
    expect(await page.keepAwake!()).toBe("upload");
    failed({ id: 2 } as import("electron").OnErrorOccurredListenerDetails);
    expect(await page.keepAwake!()).toBeNull();
    downloads.active.mockReturnValue(true);
    expect(await page.keepAwake!()).toBe("download");
    downloads.active.mockReturnValue(false);
    vi.mocked(contents.isCurrentlyAudible).mockReturnValue(true);
    expect(await page.keepAwake!()).toBe("media");
    vi.mocked(contents.isCurrentlyAudible).mockReturnValue(false);
    emit("media-started-playing");
    expect(await page.keepAwake!()).toBe("media");
    emit("media-paused");
    emit("enter-html-full-screen");
    expect(await page.keepAwake!()).toBe("fullscreen");
    emit("leave-html-full-screen");
    vi.mocked(contents.isBeingCaptured).mockReturnValue(true);
    expect(await page.keepAwake!()).toBe("capturing");
  } finally {
    await browser.close();
    launcher.close();
  }
});

it("ends a page only on its WebContents' destroyed event and reports what became of its renderer", async () => {
  const launcher = new ElectronBrowserLauncher({
    downloads: { accept: vi.fn() },
    pagePolicyPreloadPath: "/policy.cjs",
  });
  const browser = await launcher.launch({
    partitionKey: "session:confirmation",
    initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    storage: { kind: "guest" },
  });
  const mock = electron.views.at(-1)!.webContents;
  const contents = Object.assign(mock, { getOSProcessId: () => 41 });
  const page = browser.context.pages()[0]!;
  const listeners = (event: string) =>
    [...mock.on.mock.calls, ...mock.once.mock.calls]
      .filter(([name]) => name === event)
      .map(([, listener]) => listener as (...args: unknown[]) => void);
  const gone = vi.fn();
  const crashed = vi.fn();
  page.onClose(gone);
  page.onRendererGone?.(crashed);
  // Neither a close nor a destroy call is the confirmation; only `destroyed` is.
  mock.close.mockImplementation(() => undefined);
  vi.useFakeTimers();
  try {
    for (const listener of listeners("render-process-gone")) listener({}, { reason: "crashed" });
    for (const listener of listeners("render-process-gone")) listener({}, { reason: "clean-exit" });
    expect(crashed.mock.calls).toEqual([["crashed"], ["exited"]]);
    expect(page.isClosed(), "A crashed renderer is not a closed page").toBe(false);
    const refused = expect(page.close()).rejects.toThrow("wasn't destroyed");
    await vi.advanceTimersByTimeAsync(1_500);
    await refused;
    expect(mock.destroy).toHaveBeenCalledOnce();
    expect(page.isClosed()).toBe(false);
    expect(gone).not.toHaveBeenCalled();
    const retried = page.close();
    expect(mock.close, "A close that never confirmed can be asked again").toHaveBeenCalledTimes(2);
    mock.isDestroyed.mockReturnValue(true);
    for (const listener of listeners("destroyed")) listener();
    await retried;
    expect(page.isClosed()).toBe(true);
    expect(gone).toHaveBeenCalledOnce();
    const tab = (pid: number) => ({
      pid,
      type: "Tab" as const,
      creationTime: 0,
      cpu: { cumulativeCPUUsage: 0, percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 1, peakWorkingSetSize: 1 },
    });
    const sibling = {
      isDestroyed: () => false,
      mainFrame: { framesInSubtree: [{ osProcessId: 41, isDestroyed: () => false }] },
    } as unknown as Electron.WebContents;
    vi.mocked(app.getAppMetrics).mockReturnValueOnce([tab(7)]);
    expect(page.rendererExit?.()).toBe("exited");
    vi.mocked(app.getAppMetrics).mockReturnValueOnce([tab(41)]);
    vi.mocked(webContents.getAllWebContents).mockReturnValueOnce([contents, sibling] as never);
    expect(page.rendererExit?.()).toBe("shared");
    vi.mocked(app.getAppMetrics).mockReturnValueOnce([tab(41)]);
    vi.mocked(webContents.getAllWebContents).mockReturnValueOnce([contents] as never);
    expect(page.rendererExit?.()).toBe("running");
  } finally {
    vi.useRealTimers();
    await browser.close();
    launcher.close();
  }
});

it("reports a page its context ends as the context's end, and keeps a refused close requested", async () => {
  const launcher = new ElectronBrowserLauncher({
    downloads: { accept: vi.fn() },
    pagePolicyPreloadPath: "/policy.cjs",
  });
  const browser = await launcher.launch({
    partitionKey: "session:context-end",
    initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    storage: { kind: "guest" },
  });
  const mock = electron.views.at(-1)!.webContents;
  const page = browser.context.pages()[0]!;
  const destroy = () => {
    mock.isDestroyed.mockReturnValue(true);
    for (const [event, listener] of [...mock.on.mock.calls, ...mock.once.mock.calls])
      if (event === "destroyed") (listener as () => void)();
  };
  const gone = vi.fn();
  page.onClose(gone);
  mock.close.mockImplementation(() => undefined);
  vi.useFakeTimers();
  try {
    const refused = expect(page.close()).rejects.toThrow("wasn't destroyed");
    await vi.advanceTimersByTimeAsync(1_500);
    await refused;
    expect(
      (page as unknown as { closeRequested: boolean }).closeRequested,
      "A page asked to close never returns to lookups",
    ).toBe(true);
  } finally {
    vi.useRealTimers();
  }
  mock.close.mockImplementation(destroy);
  await browser.close();
  launcher.close();
  expect(gone).toHaveBeenCalledWith("context");
});

it("hands each page off at its handle and gives a create that fails while loading to its owner", async () => {
  const launcher = new ElectronBrowserLauncher({
    downloads: { accept: vi.fn() },
    pagePolicyPreloadPath: "/policy.cjs",
  });
  const browser = await launcher.launch({
    partitionKey: "session:handoff",
    initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    storage: { kind: "guest" },
  });
  const handed: [unknown, unknown][] = [];
  browser.context.handOff((page, opener) => handed.push([page, opener]));
  expect(handed).toEqual([[browser.context.pages()[0], null]]);
  const owned: unknown[] = [];
  electron.blankLoad = async () => {
    throw new Error("load failed");
  };
  try {
    await expect(browser.context.createPage({ own: (page) => owned.push(page) })).rejects.toThrow(
      "load failed",
    );
    expect(owned, "The owner holds the handle before the create fails").toHaveLength(1);
    expect(handed.at(-1)).toEqual([owned[0], null]);
  } finally {
    electron.blankLoad = undefined;
    await browser.close();
    launcher.close();
  }
});

it("refuses capture when session storage is oversized or the isolated read is denied", async () => {
  const launcher = new ElectronBrowserLauncher({
    downloads: { accept: vi.fn() },
    pagePolicyPreloadPath: "/policy.cjs",
  });
  const browser = await launcher.launch({
    partitionKey: "session:capture-bounds",
    initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    storage: { kind: "guest" },
  });
  let denied = false;
  electron.bootstrap = (method) =>
    method === "Page.createIsolatedWorld"
      ? Promise.resolve({ executionContextId: 31 })
      : method === "Runtime.evaluate"
        ? Promise.resolve(
            denied
              ? { result: {}, exceptionDetails: {} }
              : {
                  result: {
                    value: {
                      origin: "https://restore.test",
                      items: [["key", "x".repeat(256 * 1024)]],
                    },
                  },
                },
          )
        : undefined;
  try {
    expect(await browser.context.pages()[0]!.captureRestore!()).toBeNull();
    denied = true;
    expect(await browser.context.pages()[0]!.captureRestore!()).toBeNull();
  } finally {
    electron.bootstrap = undefined;
    await browser.close();
    launcher.close();
  }
});

it("rejects a refused restore before announcing and closes its unloaded view", async () => {
  const launcher = new ElectronBrowserLauncher({
    downloads: { accept: vi.fn() },
    pagePolicyPreloadPath: "/policy.cjs",
  });
  const browser = await launcher.launch({
    partitionKey: "session:refused-restore",
    initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    storage: { kind: "guest" },
  });
  const announced = vi.fn();
  browser.context.onPage(announced);
  electron.restore = async () => {
    throw new Error("History refused");
  };
  try {
    await expect(
      browser.context.createPage({
        restore: {
          entries: [{ url: "https://restore.test/", title: "Saved" }],
          index: 0,
          sessionStorage: null,
        },
      }),
    ).rejects.toThrow("History refused");
    expect(announced).not.toHaveBeenCalled();
    expect(electron.views.at(-1)!.webContents.loadURL).not.toHaveBeenCalled();
    expect(electron.views.at(-1)!.webContents.close).toHaveBeenCalled();
  } finally {
    electron.restore = undefined;
    await browser.close();
    launcher.close();
  }
});

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
        return Promise.resolve({
          frameTree: { frame: { id: "target-1", loaderId: "loader-1", url: contents.getURL() } },
        });
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
  const deliver = (method: string, parameters: unknown, sessionId?: string) => {
    for (const [event, listener] of debug.on.mock.calls)
      if (event === "message") listener({}, method, parameters, sessionId);
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

/**
 * Each attach the hub makes for itself gets a session of its own, as Chromium gives it; what was
 * attached, and what the hub let go, is read back. `announce`: Chromium tells the parent session of
 * the attach before it answers it. `refuseStartIn`: a start in that session is refused.
 */
function ownSessions(
  hub: Awaited<ReturnType<typeof hubPage>>,
  options: { readonly announce?: boolean; readonly refuseStartIn?: string } = {},
) {
  const answer = hub.contents.debugger.sendCommand.getMockImplementation()!;
  const attached: string[] = [];
  hub.contents.debugger.sendCommand.mockImplementation(
    (method: string, parameters?: Record<string, unknown>, session?: string) => {
      if (method === "Target.attachToTarget") {
        const sessionId = `cast-${attached.length + 1}`;
        attached.push(sessionId);
        if (options.announce)
          hub.deliver("Target.attachedToTarget", {
            sessionId,
            targetInfo: { targetId: "target-1", type: "page" },
            waitingForDebugger: false,
          });
        return Promise.resolve({ sessionId });
      }
      if (
        method === "Page.startScreencast" &&
        options.refuseStartIn !== undefined &&
        session === options.refuseStartIn
      )
        return Promise.reject(new Error("Session with given id not found."));
      return answer(method, parameters, session);
    },
  );
  return {
    attached,
    detached: () =>
      hub
        .sent("Target.detachFromTarget")
        .map(([, parameters]) => String((parameters as { sessionId: string }).sessionId)),
  };
}

/**
 * Past the moment a cast its last owner stopped runs on for that owner to ask again
 * (`parkedCastMs` in the launcher): as a person who turned away seconds ago.
 */
async function pastParking(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_000);
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

describe.each([
  {
    method: "Browser.setDownloadBehavior",
    parameters: { behavior: "allow", downloadPath: "/fixture" },
  },
  { method: "Browser.cancelDownload", parameters: { guid: "fixture-download" } },
])("Electron $method profile scoping", ({ method, parameters }) => {
  it.each([
    { contextId: undefined, errorMessage: undefined, forbidden: true },
    { contextId: "native-profile", errorMessage: `'${method}' wasn't found`, forbidden: true },
    { contextId: "native-profile", errorMessage: "Not allowed", forbidden: true },
    {
      contextId: "native-profile",
      errorMessage: "Browser context management is not supported.",
      forbidden: true,
    },
    { contextId: "native-profile", errorMessage: "Invalid parameters", forbidden: false },
  ])(
    "handles context $contextId and debugger error $errorMessage",
    async ({ contextId, errorMessage, forbidden }) => {
      const hub = await hubPage("92");
      const debug = hub.contents.debugger;
      const answer = debug.sendCommand.getMockImplementation()!;
      const debuggerError = new Error(errorMessage);
      debug.sendCommand.mockImplementation(async (command, params) => {
        if (command === "Target.getTargetInfo")
          return { targetInfo: { targetId: "target-1", browserContextId: contextId } };
        if (command === method) throw debuggerError;
        return answer(command, params);
      });

      try {
        const result = hub.browser.cdp.send(method, parameters);
        if (forbidden) {
          await expect(result).rejects.toMatchObject({
            code: "forbidden",
            message: `${method} cannot be scoped to this browser profile by this Electron version.`,
          });
        } else {
          await expect(result).rejects.toBe(debuggerError);
        }
        expect(hub.sent(method)).toEqual(
          contextId === undefined ? [] : [[method, { ...parameters, browserContextId: contextId }]],
        );
      } finally {
        await hub.browser.close();
      }
    },
  );
});

it("inspects profiler scripts on a private Electron session and refuses a renderer change", async () => {
  const hub = await hubPage("91");
  const debug = hub.contents.debugger;
  const answer = debug.sendCommand.getMockImplementation()!;
  const inventorySessionId = "agent-native-session";
  const result = {
    profile: {
      nodes: [
        {
          id: 1,
          callFrame: {
            scriptId: "17",
            functionName: "pageWork",
            url: "https://page.test/work.js",
            lineNumber: 4,
            columnNumber: 2,
          },
        },
      ],
    },
  };
  let rendererChanges = false;
  debug.sendCommand.mockImplementation(async (method, parameters, sessionId) => {
    if (method === "Runtime.getIsolateId") return { id: "page-isolate" };
    if (method === "Profiler.stop") return result;
    if (sessionId === inventorySessionId) {
      if (method === "Runtime.enable")
        hub.deliver("Runtime.executionContextCreated", world(17), sessionId);
      if (method === "Debugger.enable") {
        hub.deliver("Debugger.scriptParsed", { scriptId: "17", executionContextId: 17 }, sessionId);
        if (rendererChanges) hub.deliver("Runtime.executionContextsCleared", {});
      }
      return {};
    }
    return answer(method, parameters);
  });
  try {
    const agent = await hub.page.agentCdp();
    const events = vi.fn();
    agent.on("Debugger.scriptParsed", events);
    await agent.send("Profiler.enable");
    await agent.send("Profiler.start");
    await expect(agent.send("Profiler.stop")).resolves.toEqual(result);
    expect(events).not.toHaveBeenCalled();
    expect(hub.sent("Debugger.enable")).toEqual([
      ["Debugger.enable", { maxScriptsCacheSize: 0 }, inventorySessionId],
    ]);
    expect(hub.sent("Target.detachFromTarget")).toEqual([
      ["Target.detachFromTarget", { sessionId: inventorySessionId }],
    ]);

    rendererChanges = true;
    await agent.send("Profiler.start");
    await expect(agent.send("Profiler.stop")).rejects.toMatchObject({ code: "forbidden" });
    // The page changed under the profile's own inventory, so the scripts alive
    // at stop are read on a second session; every session read is let go.
    expect(hub.sent("Target.attachToTarget")).toHaveLength(3);
    expect(hub.sent("Target.detachFromTarget")).toHaveLength(3);
  } finally {
    await hub.browser.close();
  }
});

it("knows a page script that ran during a profile and was collected before it stopped", async () => {
  const hub = await hubPage("92");
  const debug = hub.contents.debugger;
  const answer = debug.sendCommand.getMockImplementation()!;
  const inventorySessionId = "agent-native-session";
  const platformWorld = {
    context: { ...world(30).context, id: 30, uniqueId: "world-30", name: "opensteer-editing" },
  };
  const watching = new Set<string>();
  /** Scripts V8 holds now; a collected one is reported to nobody who enables Debugger later. */
  const alive = new Map<string, number>([["17", 17]]);
  let parsedDuringProfile: [string, number][] = [];
  const frame = (scriptId: string) => ({
    scriptId,
    functionName: `work${scriptId}`,
    url: "https://page.test/work.js",
    lineNumber: 4,
    columnNumber: 2,
  });
  let stopped: unknown = null;
  debug.sendCommand.mockImplementation(async (method, parameters, sessionId) => {
    if (method === "Runtime.getIsolateId") return { id: "page-isolate" };
    if (method === "Profiler.start") {
      // The page compiles, runs and drops scripts while it is profiled.
      for (const [scriptId, executionContextId] of parsedDuringProfile)
        for (const session of watching)
          hub.deliver("Debugger.scriptParsed", { scriptId, executionContextId }, session);
      return {};
    }
    if (method === "Profiler.stop") return stopped;
    if (sessionId === inventorySessionId) {
      if (method === "Runtime.enable") {
        hub.deliver("Runtime.executionContextCreated", world(17), sessionId);
        hub.deliver("Runtime.executionContextCreated", platformWorld, sessionId);
      }
      if (method === "Debugger.enable") {
        watching.add(sessionId);
        for (const [scriptId, executionContextId] of alive)
          hub.deliver("Debugger.scriptParsed", { scriptId, executionContextId }, sessionId);
      }
      return {};
    }
    if (method === "Target.detachFromTarget") watching.delete(String(parameters?.sessionId));
    return answer(method, parameters);
  });
  const profile = async (scripts: [string, number][]) => {
    parsedDuringProfile = scripts;
    stopped = {
      profile: {
        nodes: ["17", ...scripts.map(([id]) => id)].map((id, index) => ({
          id: index + 1,
          callFrame: frame(id),
        })),
      },
    };
    await agent.send("Profiler.start");
    return agent.send("Profiler.stop");
  };
  const agent = await hub.page.agentCdp();
  try {
    await agent.send("Profiler.enable");
    // The page's own script, gone by the time the profile stops, is still the page's.
    await expect(profile([["23", 17]])).resolves.toEqual(stopped);
    // One parsed in a platform world during the profile is still refused, and says why.
    const platform = await profile([["31", 30]]).catch((error: unknown) => error);
    expect(platform).toMatchObject({
      code: "forbidden",
      message: "Profiler.stop returned Opensteer's preload or platform state.",
    });
    expect(cdpProfileRefusal(platform)).toBe("platform-script");
    // A frame of a script nobody ever reported cannot be classified, so it is refused.
    parsedDuringProfile = [];
    stopped = { profile: { nodes: [{ id: 1, callFrame: frame("99") }] } };
    await agent.send("Profiler.start");
    const unknown = await agent.send("Profiler.stop").catch((error: unknown) => error);
    expect(unknown).toMatchObject({ code: "forbidden" });
    expect(cdpProfileRefusal(unknown)).toBe("unknown-script");
    expect(watching.size).toBe(0);
  } finally {
    await hub.browser.close();
  }
});

/**
 * A page whose profiler and private inspection sessions answer as Chromium
 * does: each attach is a new session, a session with Debugger enabled hears
 * every script parsed from then on, and a stop with no profile running fails.
 */
async function profiledPage(id: string) {
  const hub = await hubPage(id);
  const debug = hub.contents.debugger;
  const answer = debug.sendCommand.getMockImplementation()!;
  const platformWorld = {
    context: { ...world(30).context, id: 30, uniqueId: "world-30", name: "opensteer-editing" },
  };
  const state = {
    attached: [] as string[],
    detached: [] as string[],
    watching: new Set<string>(),
    alive: new Map<string, number>([["17", 17]]),
    parsedDuringProfile: [] as [string, number][],
    stopped: null as unknown,
    profiling: false,
    attachGate: null as Promise<void> | null,
  };
  debug.sendCommand.mockImplementation(async (method, parameters, sessionId) => {
    if (method === "Runtime.getIsolateId") return { id: "page-isolate" };
    if (method === "Target.attachToTarget") {
      const session = `inventory-${state.attached.length + 1}`;
      state.attached.push(session);
      await state.attachGate;
      return { sessionId: session };
    }
    if (method === "Target.detachFromTarget") {
      const session = String(parameters?.sessionId);
      if (session.startsWith("inventory-")) {
        state.detached.push(session);
        state.watching.delete(session);
      }
      return {};
    }
    if (method === "Profiler.start") {
      state.profiling = true;
      // The page compiles, runs and drops scripts while it is profiled.
      for (const [scriptId, executionContextId] of state.parsedDuringProfile)
        for (const session of state.watching)
          hub.deliver("Debugger.scriptParsed", { scriptId, executionContextId }, session);
      return {};
    }
    if (method === "Profiler.stop") {
      if (!state.profiling) throw new Error("No recording profiles found");
      state.profiling = false;
      return state.stopped;
    }
    if (sessionId?.startsWith("inventory-")) {
      if (method === "Runtime.enable") {
        hub.deliver("Runtime.executionContextCreated", world(17), sessionId);
        hub.deliver("Runtime.executionContextCreated", platformWorld, sessionId);
      }
      if (method === "Debugger.enable") {
        state.watching.add(sessionId);
        for (const [scriptId, executionContextId] of state.alive)
          hub.deliver("Debugger.scriptParsed", { scriptId, executionContextId }, sessionId);
      }
      return {};
    }
    return answer(method, parameters);
  });
  const profile = (...ids: string[]) => ({
    profile: {
      nodes: ids.map((scriptId, index) => ({
        id: index + 1,
        callFrame: {
          scriptId,
          functionName: `work${scriptId}`,
          url: "https://page.test/work.js",
          lineNumber: 4,
          columnNumber: 2,
        },
      })),
    },
  });
  /** Every private session ever attached has been let go. */
  const settled = () =>
    vi.waitFor(() => {
      expect(state.watching).toEqual(new Set());
      expect([...state.detached].sort()).toEqual([...state.attached].sort());
    });
  return { hub, state, profile, settled };
}

for (const leaving of ["release", "Profiler.disable"] as const)
  it(`lets go of a profile inventory whose channel left by ${leaving} while it opened`, async () => {
    const { hub, state, profile, settled } = await profiledPage(
      leaving === "release" ? "93" : "94",
    );
    const keep = await hub.page.agentCdp();
    try {
      const agent = await hub.page.agentCdp();
      await agent.send("Profiler.enable");
      const opened = Promise.withResolvers<void>();
      state.attachGate = opened.promise;
      const starting = agent.send("Profiler.start").catch((error: unknown) => error);
      await vi.waitFor(() => expect(state.attached).toHaveLength(1));
      // A disable follows the start it was sent behind, so it settles after the attach.
      const left = leaving === "release" ? agent.close() : agent.send("Profiler.disable");
      if (leaving === "release") await left;
      state.attachGate = null;
      opened.resolve();
      await starting;
      await left;
      // A channel that has gone never starts a profile.
      if (leaving === "release") expect(hub.sent("Profiler.start")).toHaveLength(0);
      await settled();
      // The next profile still gets its own inventory.
      state.profiling = false;
      const next = await hub.page.agentCdp();
      await next.send("Profiler.enable");
      state.parsedDuringProfile = [["23", 17]];
      state.stopped = profile("17", "23");
      await next.send("Profiler.start");
      await expect(next.send("Profiler.stop")).resolves.toEqual(state.stopped);
      await settled();
    } finally {
      await keep.close();
      await hub.browser.close();
    }
  });

it("lets go of a profile inventory when the page navigates, and judges the stop as before", async () => {
  const { hub, state, profile, settled } = await profiledPage("95");
  const agent = await hub.page.agentCdp();
  try {
    await agent.send("Profiler.enable");
    state.parsedDuringProfile = [["23", 17]];
    await agent.send("Profiler.start");
    expect(state.watching).toEqual(new Set(["inventory-1"]));
    hub.deliver("Runtime.executionContextsCleared", {});
    await vi.waitFor(() => expect(state.detached).toEqual(["inventory-1"]));
    // The scripts alive at stop are read on a second session, as before.
    state.stopped = profile("17");
    await expect(agent.send("Profiler.stop")).resolves.toEqual(state.stopped);
    expect(state.attached).toEqual(["inventory-1", "inventory-2"]);
    await settled();
  } finally {
    await hub.browser.close();
  }
});

it("never reads a profile inventory still opening for a stop sent right behind its start", async () => {
  const { hub, state, profile, settled } = await profiledPage("96");
  const agent = await hub.page.agentCdp();
  try {
    await agent.send("Profiler.enable");
    const opened = Promise.withResolvers<void>();
    state.attachGate = opened.promise;
    state.parsedDuringProfile = [["23", 17]];
    state.stopped = profile("17", "23");
    const started = agent.send("Profiler.start");
    const stopped = agent.send("Profiler.stop");
    await vi.waitFor(() => expect(state.attached).toHaveLength(1));
    state.attachGate = null;
    opened.resolve();
    await started;
    await expect(stopped).resolves.toEqual(state.stopped);
    expect(
      hub
        .sent("Profiler.start")
        .concat(hub.sent("Profiler.stop"))
        .map(([method]) => method),
    ).toEqual(["Profiler.start", "Profiler.stop"]);
    await settled();
  } finally {
    await hub.browser.close();
  }
});

it("never lets a pause on the profile inventory hold the page", async () => {
  const { hub, state, settled } = await profiledPage("97");
  const agent = await hub.page.agentCdp();
  try {
    await agent.send("Profiler.enable");
    await agent.send("Profiler.start");
    const inventory = (method: string) =>
      hub.contents.debugger.sendCommand.mock.calls
        .map(([name, , session], index) => ({ name, session, index }))
        .filter(({ name, session }) => name === method && session === "inventory-1");
    // Skipping pauses is asked again once Debugger is on.
    expect(inventory("Debugger.setSkipAllPauses").at(-1)!.index).toBeGreaterThan(
      inventory("Debugger.enable")[0]!.index,
    );
    hub.deliver(
      "Debugger.paused",
      { callFrames: [], reason: "other", hitBreakpoints: [] },
      "inventory-1",
    );
    expect(inventory("Debugger.resume")).toHaveLength(1);
    state.stopped = { profile: { nodes: [] } };
    await agent.send("Profiler.stop");
    await settled();
  } finally {
    await hub.browser.close();
  }
});

it("keeps a profile inventory its own channel's, whatever another channel does", async () => {
  const { hub, state, profile, settled } = await profiledPage("98");
  const keep = await hub.page.agentCdp();
  try {
    const owner = await hub.page.agentCdp();
    const other = await hub.page.agentCdp();
    await owner.send("Profiler.enable");
    await other.send("Profiler.enable");
    state.stopped = profile("17");
    await owner.send("Profiler.start");
    expect(state.watching).toEqual(new Set(["inventory-1"]));
    // Another channel's stop reads the scripts alive then and leaves the owner's inventory.
    await expect(other.send("Profiler.stop")).resolves.toEqual(state.stopped);
    expect(state.watching).toEqual(new Set(["inventory-1"]));
    expect(state.detached).toEqual(["inventory-2"]);
    // Its own start finds the owner's inventory and takes the old path too.
    await other.send("Profiler.start");
    await other.send("Profiler.disable");
    expect(state.watching).toEqual(new Set(["inventory-1"]));
    await other.close();
    expect(state.watching).toEqual(new Set(["inventory-1"]));
    // The owner's disable lets it go; its close lets go of the next one.
    await owner.send("Profiler.disable");
    await vi.waitFor(() => expect(state.watching).toEqual(new Set()));
    await owner.send("Profiler.enable");
    await owner.send("Profiler.start");
    expect(state.watching.size).toBe(1);
    await owner.close();
    await settled();
  } finally {
    await keep.close();
    await hub.browser.close();
  }
});

describe("Electron debugger teardown", () => {
  // A cast its last owner stopped runs on a moment for that owner to ask again
  // (`parkedCastMs`): time runs as it does, and a test moves it past that moment where it says.
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("waits for the native page to be destroyed even when no CDP input is pending", async () => {
    const hub = await hubPage("44");
    hub.contents.close.mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const settled = vi.fn();
      const closing = hub.page.close();
      void closing.then(settled, settled);
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).not.toHaveBeenCalled();
      expect(hub.contents.destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(hub.contents.destroy).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
      hub.destroy();
      await closing;
      expect(hub.page.isClosed()).toBe(true);
    } finally {
      vi.useRealTimers();
      hub.destroy();
      await hub.browser.close();
    }
  });

  it("retries timed-out native disposal without retaining its old destruction listener", async () => {
    const hub = await hubPage("45");
    const host = electron.hosts.at(-1)!;
    const events = new EventEmitter();
    for (const [name, listener] of hub.contents.once.mock.calls)
      if (name === "destroyed") events.once(name, listener);
    hub.contents.once.mockImplementation((name, listener) => events.once(name, listener));
    hub.contents.off.mockImplementation((name, listener) => events.off(name, listener));
    const initialListeners = events.listenerCount("destroyed");
    hub.contents.close.mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const closing = hub.page.close();
      expect(hub.page.close()).toBe(closing);
      const failed = expect(closing).rejects.toThrow("wasn't destroyed");
      await vi.advanceTimersByTimeAsync(1_500);
      await failed;
      expect(events.listenerCount("destroyed")).toBe(initialListeners);
      expect(host.destroy).not.toHaveBeenCalled();
      expect(hub.page.isClosed()).toBe(false);
      hub.contents.close.mockImplementation(() => {
        hub.contents.isDestroyed.mockReturnValue(true);
        events.emit("destroyed");
      });
      await expect(hub.page.close()).resolves.toBeUndefined();
      expect(host.destroy).toHaveBeenCalledOnce();
      expect(events.listenerCount("destroyed")).toBe(0);
    } finally {
      hub.contents.isDestroyed.mockReturnValue(true);
      vi.useRealTimers();
      await hub.browser.close();
    }
  });

  it("keeps a surviving page owned when browser teardown must be retried", async () => {
    const hub = await hubPage("47");
    hub.contents.close.mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const failed = expect(hub.browser.close()).rejects.toThrow("pages failed to close");
      await vi.advanceTimersByTimeAsync(1_500);
      await failed;
      expect(hub.browser.context.pages()).toEqual([hub.page]);
      hub.contents.destroy.mockImplementation(hub.destroy);
      const retry = hub.browser.close();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(retry).resolves.toBeUndefined();
      expect(hub.browser.context.pages()).toHaveLength(0);
    } finally {
      hub.destroy();
      vi.useRealTimers();
      await hub.browser.close();
    }
  });

  it("force-disposes a page when the graceful native close throws", async () => {
    const hub = await hubPage("46");
    hub.contents.close.mockImplementation(() => {
      throw new Error("Native close failed");
    });
    hub.contents.destroy.mockImplementation(hub.destroy);
    try {
      await expect(hub.page.close()).resolves.toBeUndefined();
      expect(hub.page.isClosed()).toBe(true);
      expect(hub.contents.destroy).toHaveBeenCalledOnce();
    } finally {
      hub.destroy();
      await hub.browser.close();
    }
  });

  it("forces page disposal when closing never destroys a target with outstanding input", async () => {
    const hub = await hubPage("21");
    const host = electron.hosts.at(-1)!;
    const unbind = hub.page.bindGeometry!(
      (operation) => operation(),
      async () => undefined,
    );
    await hub.page.applyGeometry!({ person: { width: 800, height: 600 }, agent: null });
    const agent = await hub.page.agentCdp();
    const held = hub.hold("Input.dispatchKeyEvent");
    void agent.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a" }).catch(() => undefined);
    await vi.waitFor(
      () => expect(held.replies, "input never reached the renderer").toHaveLength(1),
      { timeout: 1_000 },
    );
    hub.contents.close.mockImplementation(() => {});
    hub.contents.destroy.mockImplementation(hub.destroy);
    vi.useFakeTimers();
    try {
      const closing = hub.browser.close();
      const contextClosing = (
        hub.browser.context as typeof hub.browser.context & {
          close(): Promise<void>;
        }
      ).close();
      const settled = vi.fn();
      void closing.then(settled, settled);
      await vi.advanceTimersByTimeAsync(999);
      expect(settled, "concurrent close skipped in-flight page disposal").not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled, "browser teardown never settled").toHaveBeenCalledOnce();
      await closing;
      await contextClosing;
      expect(
        hub.contents.forcefullyCrashRenderer,
        "teardown crashed a renderer other pages may share",
      ).not.toHaveBeenCalled();
      expect(hub.page.isClosed()).toBe(true);
      expect(host.destroy).toHaveBeenCalled();
      expect(hub.browser.context.isConnected?.()).toBe(false);
    } finally {
      unbind();
      hub.destroy();
      vi.useRealTimers();
    }
  });
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
    // JPEG: a PNG's quality is not a setting Chromium uses, so it would be the same cast.
    await platform.send("Page.startScreencast", { format: "jpeg", quality: 10 });
    // A restart is a new start with no stop before it: the channel goes while it is held.
    const start = hub.hold("Page.startScreencast");
    const restarting = platform
      .send("Page.startScreencast", { format: "jpeg", quality: 20 })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(start.replies).toHaveLength(1));
    expect(await within(platform.detach())).toBe("fulfilled");
    start.release();
    start.replies[0]!.resolve({});
    expect(await restarting).toBeInstanceOf(Error);
    const agent = await hub.page.agentCdp();
    const before = hub.contents.debugger.sendCommand.mock.calls.length;
    await agent.send("Page.startScreencast", { format: "jpeg", quality: 30 });
    // Its first frame, which it acks: an ack is forwarded only for a frame Chromium sent.
    hub.deliver("Page.screencastFrame", { data: "AAAA", metadata: {}, sessionId: 7 });
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

  // Run 20261122T201214Z-67db1a88: a tab a person opened and never showed started its cast three
  // times, each a stop and a start, so whoever was watching saw it go stale or blank. One cast
  // serves everyone who wants the tab's picture.
  it("starts one cast for every channel that asks for the same picture, and never stops it under them", async () => {
    const hub = await hubPage("21");
    // The page's own channel, and two agents' (each a channel of its own).
    const stream = await hub.page.cdp();
    const picture = await hub.page.agentCdp();
    const cast = { everyNthFrame: 1, format: "jpeg", maxHeight: 600, maxWidth: 800, quality: 80 };
    const frames = { late: [] as unknown[], picture: [] as unknown[], stream: [] as unknown[] };
    const watch = (
      channel: { onEvent(listener: (method: string, parameters: unknown) => void): unknown },
      into: unknown[],
    ) =>
      channel.onEvent((method, parameters) => {
        if (method === "Page.screencastFrame") into.push(parameters);
      });
    watch(stream, frames.stream);
    watch(picture, frames.picture);
    // Two owners at once, then one asking again for the same picture.
    await Promise.all([
      stream.send("Page.startScreencast", cast),
      picture.send("Page.startScreencast", cast),
    ]);
    const frame = { data: "AAAA", metadata: { deviceWidth: 800 }, sessionId: 1 };
    hub.deliver("Page.screencastFrame", frame);
    await stream.send("Page.startScreencast", cast);
    expect(hub.sent("Page.startScreencast")).toHaveLength(1);
    expect(hub.sent("Page.stopScreencast")).toHaveLength(0);
    // The page's own channel asked again, so it reset what it shows: it has the frame again.
    expect(frames.stream).toEqual([frame, frame]);
    expect(frames.picture).toEqual([frame]);
    // One that joins after the frame has it at once: a still page sends no other.
    const late = await hub.page.agentCdp();
    watch(late, frames.late);
    await late.send("Page.startScreencast", cast);
    expect(frames.late).toEqual([frame]);
    // Chromium hears one ack a frame, from whichever owner acks it first.
    await picture.send("Page.screencastFrameAck", { sessionId: 1 });
    await stream.send("Page.screencastFrameAck", { sessionId: 1 });
    await late.send("Page.screencastFrameAck", { sessionId: 1 });
    await stream.send("Page.screencastFrameAck", { sessionId: 1 });
    expect(hub.sent("Page.screencastFrameAck")).toEqual([
      ["Page.screencastFrameAck", { sessionId: 1 }],
    ]);
    // A new size for one is a cast of its own, in a session of its own: the two still watching
    // the first keep the size they asked for, and see no stop.
    await stream.send("Page.startScreencast", { ...cast, maxWidth: 1_200 });
    expect(hub.sent("Page.startScreencast")).toEqual([
      ["Page.startScreencast", cast],
      ["Page.startScreencast", { ...cast, maxWidth: 1_200 }, "agent-native-session"],
    ]);
    expect(hub.sent("Page.stopScreencast")).toHaveLength(0);
    hub.deliver("Page.screencastFrame", { ...frame, data: "800" });
    expect(frames.stream).toEqual([frame, frame]);
    // The last of each cast to go ends it.
    await late.send("Page.stopScreencast");
    expect(hub.sent("Page.stopScreencast")).toHaveLength(0);
    await picture.send("Page.stopScreencast");
    await pastParking();
    expect(hub.sent("Page.stopScreencast")).toHaveLength(1);
    await stream.send("Page.stopScreencast");
    await pastParking();
    expect(hub.sent("Target.detachFromTarget").at(-1)).toEqual([
      "Target.detachFromTarget",
      { sessionId: "agent-native-session" },
    ]);
    await hub.browser.close();
  });

  // A frame's ack names the cast, not the frame, and Chromium sends no more while two wait.
  it("acks every frame Chromium sent once, from the owner that paces it, and never a replay", async () => {
    const hub = await hubPage("22");
    const page = await hub.page.cdp();
    const slow = await hub.page.agentCdp();
    const cast = { format: "jpeg", maxHeight: 600, maxWidth: 800, quality: 80 };
    const seen: unknown[] = [];
    page.onEvent((method, parameters) => {
      if (method === "Page.screencastFrame") seen.push(parameters);
    });
    await page.send("Page.startScreencast", cast);
    await slow.send("Page.startScreencast", cast);
    for (let index = 1; index <= 20; index += 1) {
      hub.deliver("Page.screencastFrame", { data: `${index}`, metadata: {}, sessionId: 1 });
      await page.send("Page.screencastFrameAck", { sessionId: 1 });
      // The other owner acks now and then, late; its acks pace nothing.
      if (index % 7 === 0) await slow.send("Page.screencastFrameAck", { sessionId: 1 });
    }
    expect(seen).toHaveLength(20);
    expect(hub.sent("Page.screencastFrameAck")).toHaveLength(20);
    // One who joins is handed the latest frame; its ack of that is the hub's to answer.
    const joiner = await hub.page.cdp();
    await joiner.send("Page.startScreencast", cast);
    await joiner.send("Page.screencastFrameAck", { sessionId: 1 });
    expect(hub.sent("Page.screencastFrameAck")).toHaveLength(20);
    await hub.browser.close();
  });

  it("starts the cast again after the debugger lets go, though the settings are the same", async () => {
    const hub = await hubPage("23");
    const page = await hub.page.cdp();
    const cast = { format: "jpeg", maxHeight: 600, maxWidth: 800, quality: 80 };
    await page.send("Page.startScreencast", cast);
    for (const [event, listener] of hub.contents.debugger.on.mock.calls)
      if (event === "detach") listener({}, "target closed");
    await page.send("Page.startScreencast", cast).catch(() => undefined);
    await vi.waitFor(() => expect(hub.sent("Page.startScreencast")).toHaveLength(2));
    await hub.browser.close();
  });

  it("hands no one a frame of the old size, and an owner asking again the latest", async () => {
    const hub = await hubPage("24");
    const page = await hub.page.cdp();
    const agent = await hub.page.agentCdp();
    const cast = { format: "jpeg", maxHeight: 600, maxWidth: 800, quality: 80 };
    const seen: unknown[] = [];
    agent.onEvent((method, parameters) => {
      if (method === "Page.screencastFrame") seen.push(parameters);
    });
    await page.send("Page.startScreencast", cast);
    await agent.send("Page.startScreencast", cast);
    hub.deliver("Page.screencastFrame", {
      data: "old",
      metadata: { deviceWidth: 800 },
      sessionId: 1,
    });
    expect(seen).toHaveLength(1);
    // The page changes size, as a repair does; one who comes back is not handed the old picture.
    await page.send("Emulation.setVisibleSize", { height: 700, width: 1_000 });
    await agent.send("Page.stopScreencast");
    await agent.send("Page.startScreencast", cast);
    expect(seen).toHaveLength(1);
    hub.deliver("Page.screencastFrame", {
      data: "new",
      metadata: { deviceWidth: 1_000 },
      sessionId: 1,
    });
    await agent.send("Page.startScreencast", cast);
    expect(seen.map((frame) => (frame as { data: string }).data)).toEqual(["old", "new", "new"]);
    await hub.browser.close();
  });

  // Run 20261122T204015Z-32e9d77d: an agent asked for PNG at 320x240 beside the person's view and
  // was handed the person's JPEG at 1400x900, while the person watched and after they turned away.
  it("gives each owner frames in the format and size it asked for, and a cast only to owners who asked the same", async () => {
    const hub = await hubPage("25");
    const answer = hub.contents.debugger.sendCommand.getMockImplementation()!;
    let sessions = 0;
    hub.contents.debugger.sendCommand.mockImplementation(
      (method: string, parameters?: Record<string, unknown>, session?: string) =>
        method === "Target.attachToTarget"
          ? Promise.resolve({ sessionId: `cast-${++sessions}` })
          : answer(method, parameters, session),
    );
    const person = await hub.page.cdp();
    const agent = await hub.page.agentCdp();
    const frames = { agent: [] as string[], person: [] as string[] };
    person.onEvent((method, parameters) => {
      if (method === "Page.screencastFrame")
        frames.person.push((parameters as { data: string }).data);
    });
    agent.onEvent((method, parameters) => {
      if (method === "Page.screencastFrame")
        frames.agent.push((parameters as { data: string }).data);
    });
    const view = { format: "jpeg", maxHeight: 900, maxWidth: 1_400, quality: 80 };
    const ask = { format: "png", maxHeight: 240, maxWidth: 320 };
    // Chromium numbers each cast in a session upward: the person's second cast sends frame id 2.
    const jpeg = (frame = 1) =>
      hub.deliver("Page.screencastFrame", {
        data: "jpeg 1400x900",
        metadata: {},
        sessionId: frame,
      });
    const png = () =>
      hub.deliver(
        "Page.screencastFrame",
        { data: "png 320x240", metadata: {}, sessionId: 2 },
        "cast-1",
      );
    await person.send("Page.startScreencast", view);
    await agent.send("Page.startScreencast", ask);
    // Chromium runs one cast a session: the agent's is a second one, in a session of its own.
    expect(hub.sent("Page.startScreencast")).toEqual([
      ["Page.startScreencast", view],
      ["Page.startScreencast", ask, "cast-1"],
    ]);
    jpeg();
    png();
    expect(frames).toEqual({ agent: ["png 320x240"], person: ["jpeg 1400x900"] });
    // Each cast's frame is acked once, in the session that cast runs in.
    await agent.send("Page.screencastFrameAck", { sessionId: 2 });
    await person.send("Page.screencastFrameAck", { sessionId: 1 });
    expect(hub.sent("Page.screencastFrameAck")).toEqual([
      ["Page.screencastFrameAck", { sessionId: 2 }, "cast-1"],
      ["Page.screencastFrameAck", { sessionId: 1 }],
    ]);
    // The person turns away: their cast stops and the agent's goes on. The agent asking again
    // for its own settings joins its own cast, and is handed its latest frame.
    await person.send("Page.stopScreencast");
    await pastParking();
    expect(hub.sent("Page.stopScreencast")).toHaveLength(1);
    png();
    await agent.send("Page.startScreencast", ask);
    expect(hub.sent("Page.startScreencast")).toHaveLength(2);
    expect(frames.agent).toEqual(["png 320x240", "png 320x240", "png 320x240"]);
    // The person comes back: their cast starts again, and each still sees only its own.
    await person.send("Page.startScreencast", view);
    expect(hub.sent("Page.startScreencast").at(-1)).toEqual(["Page.startScreencast", view]);
    jpeg(2);
    png();
    expect(frames.person).toEqual(["jpeg 1400x900", "jpeg 1400x900"]);
    expect(new Set(frames.agent)).toEqual(new Set(["png 320x240"]));
    // The agent stops: its session ends with its cast, and the person's picture goes on.
    await agent.send("Page.stopScreencast");
    await pastParking();
    expect(hub.sent("Target.detachFromTarget").at(-1)).toEqual([
      "Target.detachFromTarget",
      { sessionId: "cast-1" },
    ]);
    expect(hub.sent("Page.stopScreencast")).toHaveLength(1);
    const agentFrames = frames.agent.length;
    jpeg(2);
    expect(frames.person).toHaveLength(3);
    expect(frames.agent).toHaveLength(agentFrames);
    await hub.browser.close();
  });

  // Run 20261122T204015Z-32e9d77d: a tab whose dialog had held it was not pictured again once the
  // dialog closed. Its cast went on with the same sessionId, and every ack after the first was
  // dropped as if that frame had been acked already.
  it("keeps a tab's picture coming after its dialog closes, each frame acked once", async () => {
    const hub = await hubPage("26");
    const person = await hub.page.cdp();
    let seen = 0;
    person.onEvent((method) => {
      if (method === "Page.screencastFrame") seen += 1;
    });
    await person.send("Page.startScreencast", { format: "jpeg", maxHeight: 700, maxWidth: 1_000 });
    const frame = async (index: number) => {
      hub.deliver("Page.screencastFrame", { data: `${index}`, metadata: {}, sessionId: 1 });
      await person.send("Page.screencastFrameAck", { sessionId: 1 });
    };
    await frame(1);
    await frame(2);
    // The dialog holds the page, and Chromium sends nothing until it closes.
    hub.deliver("Page.javascriptDialogOpening", {
      defaultPrompt: "",
      frameId: "target-1",
      hasBrowserHandler: false,
      message: "Delete this listing?",
      type: "confirm",
      url: "https://example.test/follow",
    });
    hub.deliver("Page.javascriptDialogClosed", {
      frameId: "target-1",
      result: false,
      userInput: "",
    });
    for (let index = 3; index <= 8; index += 1) await frame(index);
    expect(seen).toBe(8);
    // Chromium sends no third frame while two wait for an ack: each one is acked.
    expect(hub.sent("Page.screencastFrameAck")).toHaveLength(8);
    await hub.browser.close();
  });

  // The read of 564ca7424..5d197dfbc, findings 3 and 4: a frame and its ack belong to the run of
  // the cast that produced them, by its identity, not by where its owner stands when it arrives.
  describe("a cast's frames and acks, by the run that produced them", () => {
    const view = { format: "jpeg", maxHeight: 900, maxWidth: 1_400, quality: 80 };
    const small = { format: "png", maxHeight: 240, maxWidth: 320 };
    const frame = (data: string, sessionId: number) => ({ data, metadata: {}, sessionId });
    const seen = (channel: { onEvent(l: (m: string, p: unknown) => void): unknown }) => {
      const into: string[] = [];
      channel.onEvent((method, parameters) => {
        if (method === "Page.screencastFrame") into.push((parameters as { data: string }).data);
      });
      return into;
    };

    // Finding 3: the old cast's acks still queued after a hand-over were counted against the new
    // one and sent with the old id, which Chromium ignores; the new cast's own were then dropped.
    it("drops the acks of a cast handed over, and sends the new cast's", async () => {
      const hub = await hubPage("31");
      const person = await hub.page.cdp();
      await person.send("Page.startScreencast", view);
      hub.deliver("Page.screencastFrame", frame("view 1", 1));
      hub.deliver("Page.screencastFrame", frame("view 2", 1));
      await person.send("Page.startScreencast", small);
      hub.deliver("Page.screencastFrame", frame("small 1", 2));
      hub.deliver("Page.screencastFrame", frame("small 2", 2));
      for (const id of [1, 1, 2, 2])
        await person.send("Page.screencastFrameAck", { sessionId: id });
      expect(hub.sent("Page.screencastFrameAck")).toEqual([
        ["Page.screencastFrameAck", { sessionId: 2 }],
        ["Page.screencastFrameAck", { sessionId: 2 }],
      ]);
      await hub.browser.close();
    });

    // Finding 4: a frame of the old settings arriving while the new start was still unanswered
    // was delivered as the new cast's, kept as its latest and replayed to the next owner.
    it("delivers and keeps nothing before a start has resolved", async () => {
      const hub = await hubPage("32");
      const person = await hub.page.cdp();
      const agent = await hub.page.agentCdp();
      const personSaw = seen(person);
      const agentSaw = seen(agent);
      await person.send("Page.startScreencast", view);
      hub.deliver("Page.screencastFrame", frame("jpeg 1400x900", 1));
      const start = hub.hold("Page.startScreencast");
      const starting = person.send("Page.startScreencast", small);
      await vi.waitFor(() => expect(start.replies).toHaveLength(1));
      // Late, in the old settings, before Chromium has answered the new start.
      hub.deliver("Page.screencastFrame", frame("jpeg 1400x900 late", 1));
      start.release();
      start.replies[0]!.resolve({});
      await starting;
      await agent.send("Page.startScreencast", small);
      expect(personSaw).toEqual(["jpeg 1400x900"]);
      expect(agentSaw).toEqual([]);
      await agent.send("Page.screencastFrameAck", { sessionId: 1 });
      expect(hub.sent("Page.screencastFrameAck")).toEqual([]);
      await hub.browser.close();
    });

    // Two owners share a cast; one moves to other settings, a second cast in a session of its
    // own. Its ack of a frame of the first goes to the first; of the second, to the second.
    it("sends each ack to the cast that handed that frame, though two casts share a frame id", async () => {
      const hub = await hubPage("33");
      const own = ownSessions(hub);
      const person = await hub.page.cdp();
      const agent = await hub.page.agentCdp();
      await person.send("Page.startScreencast", view);
      await agent.send("Page.startScreencast", view);
      hub.deliver("Page.screencastFrame", frame("view", 1));
      await agent.send("Page.startScreencast", small);
      expect(own.attached).toEqual(["cast-1"]);
      hub.deliver("Page.screencastFrame", frame("small", 1), "cast-1");
      await agent.send("Page.screencastFrameAck", { sessionId: 1 });
      await agent.send("Page.screencastFrameAck", { sessionId: 1 });
      // The person's ack of the same frame finds it acked already.
      await person.send("Page.screencastFrameAck", { sessionId: 1 });
      expect(hub.sent("Page.screencastFrameAck")).toEqual([
        ["Page.screencastFrameAck", { sessionId: 1 }],
        ["Page.screencastFrameAck", { sessionId: 1 }, "cast-1"],
      ]);
      await hub.browser.close();
    });

    // Finding 4, second part: an owner joined the running cast before its own old cast had ended,
    // and was handed a frame arriving meanwhile twice, live and as the replay.
    it("hands an owner that moves to a running cast each frame once", async () => {
      const hub = await hubPage("34");
      ownSessions(hub);
      const person = await hub.page.cdp();
      const agent = await hub.page.agentCdp();
      const agentSaw = seen(agent);
      await person.send("Page.startScreencast", view);
      await agent.send("Page.startScreencast", small);
      // Its old cast ends as it leaves: its session's detach is held, and a frame arrives.
      const detach = hub.hold("Target.detachFromTarget");
      const moving = agent.send("Page.startScreencast", view);
      await vi.waitFor(() => expect(detach.replies).toHaveLength(1));
      hub.deliver("Page.screencastFrame", frame("view 1", 1));
      detach.release();
      detach.replies[0]!.resolve({});
      await moving;
      expect(agentSaw).toEqual(["view 1"]);
      await hub.browser.close();
    });

    // The re-check of 5d197dfbc..e7080ea31, finding 1: what a start read before an await was used
    // after it without being read again. Its three orders.
    const crash = (hub: Awaited<ReturnType<typeof hubPage>>) => {
      for (const [name, listener] of [
        ...hub.contents.on.mock.calls,
        ...hub.contents.once.mock.calls,
      ])
        if (name === "render-process-gone")
          (listener as (...a: unknown[]) => void)({}, { reason: "crashed" });
    };

    it("refuses a move to a running cast that ended while the channel left its own", async () => {
      const hub = await hubPage("35");
      ownSessions(hub);
      const person = await hub.page.cdp();
      const agent = await hub.page.agentCdp();
      const agentSaw = seen(agent);
      await person.send("Page.startScreencast", view);
      await agent.send("Page.startScreencast", small);
      const detach = hub.hold("Target.detachFromTarget");
      const moving = agent.send("Page.startScreencast", view);
      await vi.waitFor(() => expect(detach.replies).toHaveLength(1));
      crash(hub);
      detach.release();
      detach.replies[0]!.resolve({});
      // Refused for the renderer's loss, not with a TypeError of the ended cast.
      await expect(moving).rejects.toThrow(/crashed/u);
      // It is in no cast: the person's, started again, reaches the person alone.
      for (const [name, listener] of hub.contents.on.mock.calls)
        if (name === "did-navigate") (listener as (...a: unknown[]) => void)({});
      await person.send("Page.startScreencast", view);
      hub.deliver("Page.screencastFrame", frame("view again", 2));
      expect(agentSaw).toEqual([]);
      await hub.browser.close();
    });

    it("hands a new cast's first frame to the owner that started it, and sends its ack", async () => {
      const hub = await hubPage("36");
      const own = ownSessions(hub);
      const person = await hub.page.cdp();
      const agent = await hub.page.agentCdp();
      const agentSaw = seen(agent);
      await person.send("Page.startScreencast", view);
      await agent.send("Page.startScreencast", view);
      const start = hub.hold("Page.startScreencast");
      const starting = agent.send("Page.startScreencast", small);
      await vi.waitFor(() => expect(start.replies).toHaveLength(1));
      expect(own.attached).toEqual(["cast-1"]);
      start.release();
      // Chromium answers the start, and its first frame arrives before the hub hears the answer.
      start.replies[0]!.resolve({});
      hub.deliver("Page.screencastFrame", frame("small 1", 1), "cast-1");
      await starting;
      expect(agentSaw).toEqual(["small 1"]);
      await agent.send("Page.screencastFrameAck", { sessionId: 1 });
      expect(hub.sent("Page.screencastFrameAck")).toEqual([
        ["Page.screencastFrameAck", { sessionId: 1 }, "cast-1"],
      ]);
      await hub.browser.close();
    });

    it("takes no late frame of an earlier run for a run whose first frame has not come", async () => {
      const hub = await hubPage("37");
      const person = await hub.page.cdp();
      const personSaw = seen(person);
      await person.send("Page.startScreencast", view);
      const start = hub.hold("Page.startScreencast");
      const starting = person.send("Page.startScreencast", small);
      await vi.waitFor(() => expect(start.replies).toHaveLength(1));
      hub.deliver("Page.screencastFrame", frame("view 1", 1));
      start.release();
      start.replies[0]!.resolve({});
      await starting;
      hub.deliver("Page.screencastFrame", frame("view 2", 1));
      hub.deliver("Page.screencastFrame", frame("small 1", 2));
      expect(personSaw).toEqual(["small 1"]);
      await hub.browser.close();
    });

    // The re-check of e7080ea31..963f808d0, finding 1: a debugger session's counts die with it.
    // The hub lets the debugger go when its last channel goes, and Electron says nothing of a
    // detach it was asked for; the next session numbers its casts from 1 again.
    it("pictures a page again after the hub let its debugger go and attached it anew", async () => {
      const hub = await hubPage("71");
      const first = await hub.page.cdp();
      await first.send("Page.startScreencast", view);
      hub.deliver("Page.screencastFrame", frame("before", 1));
      await first.send("Page.screencastFrameAck", { sessionId: 1 });
      await first.detach();
      await vi.waitFor(() => expect(hub.contents.debugger.isAttached()).toBe(false));
      // The page's own channel is gone; the next one to open attaches the debugger again.
      const second = await hub.page.agentCdp();
      expect(hub.contents.debugger.isAttached()).toBe(true);
      const secondSaw = seen(second);
      await second.send("Page.startScreencast", view);
      hub.deliver("Page.screencastFrame", frame("after", 1));
      expect(secondSaw).toEqual(["after"]);
      await second.send("Page.screencastFrameAck", { sessionId: 1 });
      expect(hub.sent("Page.screencastFrameAck")).toEqual([
        ["Page.screencastFrameAck", { sessionId: 1 }],
        ["Page.screencastFrameAck", { sessionId: 1 }],
      ]);
      await hub.browser.close();
    });

    // The re-check of e7080ea31..963f808d0, finding 3: a kept frame is acked or handed, never
    // forgotten.
    for (const [clearedBy, clear] of [
      [
        "a navigation",
        (hub: Awaited<ReturnType<typeof hubPage>>) => {
          for (const [name, listener] of hub.contents.on.mock.calls)
            if (name === "did-navigate") (listener as (...a: unknown[]) => void)({});
        },
      ],
      [
        "a new size",
        (
          _hub: Awaited<ReturnType<typeof hubPage>>,
          person: Awaited<ReturnType<Awaited<ReturnType<typeof hubPage>>["page"]["cdp"]>>,
        ) =>
          void person.send("Emulation.setDeviceMetricsOverride", {
            deviceScaleFactor: 1,
            height: 700,
            mobile: false,
            width: 1_000,
          }),
      ],
    ] as const)
      it(`acks a frame kept for an unanswered start that ${clearedBy} discards`, async () => {
        const hub = await hubPage(clearedBy === "a navigation" ? "72" : "73");
        const person = await hub.page.cdp();
        const start = hub.hold("Page.startScreencast");
        const starting = person.send("Page.startScreencast", view);
        await vi.waitFor(() => expect(start.replies).toHaveLength(1));
        hub.deliver("Page.screencastFrame", frame("old document", 1));
        clear(hub, person);
        await vi.waitFor(() =>
          expect(hub.sent("Page.screencastFrameAck")).toEqual([
            ["Page.screencastFrameAck", { sessionId: 1 }],
          ]),
        );
        start.release();
        start.replies[0]!.resolve({});
        await starting;
        // Its next frame is the run's, and acked once, by its owner.
        hub.deliver("Page.screencastFrame", frame("new document", 1));
        await person.send("Page.screencastFrameAck", { sessionId: 1 });
        expect(hub.sent("Page.screencastFrameAck")).toHaveLength(2);
        await hub.browser.close();
      });

    it("joins a channel released while its start waited to nothing, and ends the cast it asked for", async () => {
      const hub = await hubPage("74");
      const own = ownSessions(hub);
      const person = await hub.page.cdp();
      const agent = await hub.page.agentCdp();
      const agentSaw = seen(agent);
      await person.send("Page.startScreencast", view);
      const start = hub.hold("Page.startScreencast");
      const starting = agent.send("Page.startScreencast", small);
      await vi.waitFor(() => expect(start.replies).toHaveLength(1));
      const releasing = agent.detach();
      start.release();
      hub.deliver("Page.screencastFrame", frame("small 1", 1), "cast-1");
      start.replies[0]!.resolve({});
      await expect(starting).rejects.toThrow(/closed/u);
      await releasing;
      expect(agentSaw).toEqual([]);
      expect(own.detached()).toEqual(["cast-1"]);
      await hub.browser.close();
    });

    // The re-check of 963f808d0..fb245664c, finding 2: a closed channel does nothing, on every
    // branch of its start, though the start was queued while it was open.
    it("does nothing for a closed channel's queued ask for the cast it already owns", async () => {
      const hub = await hubPage("77");
      ownSessions(hub);
      const person = await hub.page.cdp();
      const agent = await hub.page.agentCdp();
      const other = await hub.page.agentCdp();
      const agentSaw = seen(agent);
      await person.send("Page.startScreencast", view);
      await agent.send("Page.startScreencast", view);
      hub.deliver("Page.screencastFrame", frame("view 1", 1));
      // Another channel's start holds the queue; the agent asks again, then closes.
      const start = hub.hold("Page.startScreencast");
      const holding = other.send("Page.startScreencast", small);
      await vi.waitFor(() => expect(start.replies).toHaveLength(1));
      const asking = agent.send("Page.startScreencast", view);
      const releasing = agent.detach();
      start.release();
      start.replies[0]!.resolve({});
      await holding;
      await expect(asking).rejects.toThrow(/closed/u);
      await releasing;
      expect(agentSaw).toEqual(["view 1"]);
      await hub.browser.close();
    });

    it("sends Chromium nothing for a closed sole owner's queued ask for new settings", async () => {
      const hub = await hubPage("78");
      ownSessions(hub);
      const person = await hub.page.cdp();
      const agent = await hub.page.agentCdp();
      await person.send("Page.startScreencast", view);
      await agent.send("Page.startScreencast", small);
      const starts = hub.sent("Page.startScreencast").length;
      // The person's restart holds the queue; the agent, alone in its cast, asks for new
      // settings, then closes.
      const start = hub.hold("Page.startScreencast");
      const holding = person.send("Page.startScreencast", { ...view, maxWidth: 1_200 });
      await vi.waitFor(() => expect(start.replies).toHaveLength(1));
      const asking = agent.send("Page.startScreencast", { ...small, maxWidth: 640 });
      const releasing = agent.detach();
      start.release();
      start.replies[0]!.resolve({});
      await holding;
      await expect(asking).rejects.toThrow(/closed/u);
      await releasing;
      // The person's restart alone reached Chromium.
      expect(hub.sent("Page.startScreencast")).toHaveLength(starts + 1);
      await hub.browser.close();
    });

    it("acks a frame kept for a start that then fails", async () => {
      const hub = await hubPage("79");
      ownSessions(hub, { refuseStartIn: "cast-1" });
      const person = await hub.page.cdp();
      const agent = await hub.page.agentCdp();
      await person.send("Page.startScreencast", view);
      const answer = hub.contents.debugger.sendCommand.getMockImplementation()!;
      hub.contents.debugger.sendCommand.mockImplementation(
        (method: string, parameters?: Record<string, unknown>, session?: string) => {
          // Chromium sends the cast's first frame, then refuses its start.
          if (method === "Page.startScreencast" && session === "cast-1")
            hub.deliver("Page.screencastFrame", frame("small 1", 1), "cast-1");
          return answer(method, parameters, session);
        },
      );
      await expect(agent.send("Page.startScreencast", small)).rejects.toThrow();
      expect(hub.sent("Page.screencastFrameAck")).toEqual([
        ["Page.screencastFrameAck", { sessionId: 1 }, "cast-1"],
      ]);
      await hub.browser.close();
    });

    // The re-check of 963f808d0..fb245664c, finding 3: when casts end, ownership ends with them.
    it("makes no channel an owner after a crash but one that asks again", async () => {
      const hub = await hubPage("80");
      const person = await hub.page.cdp();
      const agent = await hub.page.agentCdp();
      const personSaw = seen(person);
      await person.send("Page.startScreencast", view);
      await agent.send("Page.startScreencast", view);
      for (const [name, listener] of hub.contents.on.mock.calls) {
        if (name === "render-process-gone")
          (listener as (...a: unknown[]) => void)({}, { reason: "crashed" });
        if (name === "did-navigate") (listener as (...a: unknown[]) => void)({});
      }
      // Only the agent asks again; the person never does.
      const start = hub.hold("Page.startScreencast");
      const asking = agent.send("Page.startScreencast", view);
      await vi.waitFor(() => expect(start.replies).toHaveLength(1));
      hub.deliver("Page.screencastFrame", frame("after the crash", 2));
      // The agent closes while its start is unanswered.
      const releasing = agent.detach();
      start.release();
      start.replies[0]!.resolve({});
      await expect(asking).rejects.toThrow(/closed/u);
      await releasing;
      await pastParking();
      // No one asked for that cast: it ended, and the person was handed none of it.
      expect(personSaw).toEqual([]);
      expect(hub.sent("Page.stopScreencast")).toHaveLength(1);
      await hub.browser.close();
    });

    // Run on e7080ea31, follow-stale-dialog-answers: the second tab, answered, was pictured no
    // more. The smoke's order on that tab: opened and pictured, its cast started again in a new
    // size, then left before that start's first frame; a dialog opens there and is answered; its
    // cast starts again. A late frame of the start that never pictured anything (Chromium's id 2)
    // then arrives first.
    const underADialog = async (label: string) => {
      const hub = await hubPage(label);
      const person = await hub.page.cdp();
      const personSaw = seen(person);
      const resized = { ...view, maxWidth: 1_200 };
      await person.send("Page.startScreencast", view);
      hub.deliver("Page.screencastFrame", frame("opened", 1));
      await person.send("Page.screencastFrameAck", { sessionId: 1 });
      await person.send("Page.stopScreencast");
      await person.send("Page.startScreencast", resized);
      // The person turns to another tab, seconds before the dialog.
      await person.send("Page.stopScreencast");
      await pastParking();
      hub.deliver("Page.javascriptDialogOpening", {
        defaultPrompt: "",
        frameId: "target-1",
        hasBrowserHandler: false,
        message: "Allow destructive action B?",
        type: "confirm",
        url: "https://example.test/follow?dialog-b",
      });
      await person.send("Page.handleJavaScriptDialog", { accept: false });
      hub.deliver("Page.javascriptDialogClosed", {
        frameId: "target-1",
        result: false,
        userInput: "",
      });
      return { hub, person, personSaw, resized };
    };

    it("pictures a tab again once its dialog is answered, though a late frame comes first", async () => {
      const { hub, person, personSaw, resized } = await underADialog("38");
      await person.send("Page.startScreencast", resized);
      hub.deliver("Page.screencastFrame", frame("late, never pictured", 2));
      hub.deliver("Page.screencastFrame", frame("answered", 3));
      expect(personSaw).toEqual(["opened", "answered"]);
      await person.send("Page.screencastFrameAck", { sessionId: 3 });
      expect(hub.sent("Page.screencastFrameAck").at(-1)).toEqual([
        "Page.screencastFrameAck",
        { sessionId: 3 },
      ]);
      await hub.browser.close();
    });

    it("pictures a still tab once its dialog is answered, though its one frame beats the start's answer", async () => {
      const { hub, person, personSaw, resized } = await underADialog("39");
      const start = hub.hold("Page.startScreencast");
      const starting = person.send("Page.startScreencast", resized);
      await vi.waitFor(() => expect(start.replies).toHaveLength(1));
      start.release();
      start.replies[0]!.resolve({});
      hub.deliver("Page.screencastFrame", frame("answered", 3));
      await starting;
      expect(personSaw).toEqual(["opened", "answered"]);
      await person.send("Page.screencastFrameAck", { sessionId: 3 });
      expect(hub.sent("Page.screencastFrameAck").at(-1)).toEqual([
        "Page.screencastFrameAck",
        { sessionId: 3 },
      ]);
      await hub.browser.close();
    });
  });

  // Finding 5: every session the hub attaches for itself is detached exactly once, on every path
  // a cast ends by, and no channel hears of it. The paths: stopped; its owner released; after a
  // navigation; the renderer gone; the renderer gone during a release; a start it was attached
  // for failing; the page closed; the app quitting; the window destroyed; the debugger's detach;
  // and interrupted while attaching, once the attach answers. Which attach is the hub's is told by
  // its session, never by whether one of the hub's is under way.
  describe("the hub's own sessions", () => {
    const view = { format: "jpeg", maxHeight: 900, maxWidth: 1_400, quality: 80 };
    const small = { format: "png", maxHeight: 240, maxWidth: 320 };
    type Hub = Awaited<ReturnType<typeof hubPage>>;
    const fire = (hub: Hub, event: string, ...args: unknown[]) => {
      for (const [name, listener] of [
        ...hub.contents.on.mock.calls,
        ...hub.contents.once.mock.calls,
      ])
        if (name === event) (listener as (...a: unknown[]) => void)({}, ...args);
    };
    /** Each own session let go once: by the hub, or, where `implicit`, with the debugger itself. */
    const expectOnce = (hub: Hub, own: ReturnType<typeof ownSessions>, implicit = false) => {
      expect(own.attached.length).toBeGreaterThan(0);
      for (const id of own.attached) {
        const explicit = own.detached().filter((detached) => detached === id).length;
        expect(explicit, `${id} detached ${explicit} times`).toBeLessThanOrEqual(1);
        if (!implicit) expect(explicit, `${id} never detached`).toBe(1);
      }
      if (implicit)
        expect(
          hub.contents.debugger.detach.mock.calls.length > 0 || hub.contents.isDestroyed(),
        ).toBe(true);
    };
    async function casting(label: string) {
      const hub = await hubPage(label);
      const own = ownSessions(hub);
      const person = await hub.page.cdp();
      const agent = await hub.page.agentCdp();
      await person.send("Page.startScreencast", view);
      await agent.send("Page.startScreencast", small);
      expect(own.attached).toEqual(["cast-1"]);
      return { agent, hub, own, person };
    }

    it("lets go of a cast's session when it is stopped", async () => {
      const { agent, hub, own } = await casting("41");
      await agent.send("Page.stopScreencast");
      await pastParking();
      expectOnce(hub, own);
      await hub.browser.close();
    });

    it("when its owner is released", async () => {
      const { agent, hub, own } = await casting("42");
      await agent.detach();
      expectOnce(hub, own);
      await hub.browser.close();
    });

    it("after a navigation, when it is stopped, and not at the navigation", async () => {
      const { agent, hub, own } = await casting("43");
      fire(hub, "did-navigate");
      expect(own.detached()).toEqual([]);
      await agent.send("Page.stopScreencast");
      await pastParking();
      expectOnce(hub, own);
      await hub.browser.close();
    });

    it("when the renderer is gone, and not again when its owner stops", async () => {
      const { agent, hub, own } = await casting("44");
      fire(hub, "render-process-gone", { reason: "crashed" });
      await vi.waitFor(() => expect(own.detached()).toEqual(["cast-1"]));
      await agent.send("Page.stopScreencast").catch(() => undefined);
      expectOnce(hub, own);
      await hub.browser.close();
    });

    // The read's sequence: a release already under way when the renderer goes.
    it("when the renderer goes while its owner's release is under way", async () => {
      const { agent, hub, own, person } = await casting("45");
      // The person's restart holds the page's ownership changes: the agent's release, begun in
      // this generation, waits behind it while the renderer goes.
      const start = hub.hold("Page.startScreencast");
      const restarting = person
        .send("Page.startScreencast", { ...view, maxWidth: 1_200 })
        .catch(() => undefined);
      await vi.waitFor(() => expect(start.replies).toHaveLength(1));
      const releasing = agent.detach();
      await Promise.resolve();
      fire(hub, "render-process-gone", { reason: "crashed" });
      start.release();
      start.replies[0]!.resolve({});
      await restarting;
      await releasing;
      await vi.waitFor(() => expect(own.detached()).toEqual(["cast-1"]));
      expectOnce(hub, own);
      await hub.browser.close();
    });

    // The read's sequence: a session attached for a start that fails, while another owner stays.
    it("when a start it was attached for fails, though another owner remains", async () => {
      const hub = await hubPage("46");
      const own = ownSessions(hub, { refuseStartIn: "cast-2" });
      const person = await hub.page.cdp();
      const first = await hub.page.agentCdp();
      const second = await hub.page.agentCdp();
      await person.send("Page.startScreencast", view);
      await first.send("Page.startScreencast", small);
      await second.send("Page.startScreencast", small);
      fire(hub, "render-process-gone", { reason: "crashed" });
      fire(hub, "did-navigate");
      await person.send("Page.startScreencast", view);
      await expect(first.send("Page.startScreencast", small)).rejects.toThrow();
      expect(own.attached).toEqual(["cast-1", "cast-2"]);
      expectOnce(hub, own);
      await hub.browser.close();
    });

    it("with the debugger, when the page is closed", async () => {
      const { hub, own } = await casting("47");
      await hub.page.close();
      expectOnce(hub, own, true);
      await hub.browser.close();
    });

    it("with the debugger, when the app quits", async () => {
      const { hub, own } = await casting("48");
      await hub.browser.close();
      expectOnce(hub, own, true);
    });

    it("with the page, when its window is destroyed", async () => {
      const { hub, own } = await casting("49");
      hub.destroy();
      expectOnce(hub, own, true);
      await hub.browser.close();
    });

    it("with the debugger, when it detaches, and is not let go again", async () => {
      const { agent, hub, own } = await casting("50");
      for (const [name, listener] of hub.contents.debugger.on.mock.calls)
        if (name === "detach") listener({}, "target closed");
      // As Electron has it once the debugger has let go.
      (hub.contents.debugger.detach as unknown as () => void)();
      await agent.send("Page.stopScreencast").catch(() => undefined);
      expectOnce(hub, own, true);
      expect(own.detached()).toEqual([]);
      await hub.browser.close();
    });

    it("reaches no channel that has Target enabled, while that channel's own frames do", async () => {
      const hub = await hubPage("51");
      const own = ownSessions(hub, { announce: true });
      const platform = await hub.page.cdp();
      const heard: string[] = [];
      platform.onEvent((method, parameters) => {
        if (method.startsWith("Target."))
          heard.push(`${method} ${String((parameters as { sessionId?: string }).sessionId)}`);
      });
      await platform.send("Target.setAutoAttach", {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: false,
      });
      const agent = await hub.page.agentCdp();
      await platform.send("Page.startScreencast", view);
      await agent.send("Page.startScreencast", small);
      await agent.send("Page.stopScreencast");
      hub.deliver("Target.detachedFromTarget", { sessionId: "cast-1", targetId: "target-1" });
      // An out-of-process frame of the page's own is still the platform's.
      hub.deliver("Target.attachedToTarget", {
        sessionId: "frame-1",
        targetInfo: { targetId: "iframe-1", type: "iframe" },
        waitingForDebugger: false,
      });
      expect(own.attached).toEqual(["cast-1"]);
      expect(heard).toEqual(["Target.attachedToTarget frame-1"]);
      await hub.browser.close();
    });

    // The re-check of 5d197dfbc..e7080ea31, finding 5.
    it("when the renderer goes while it is attaching, once the attach answers", async () => {
      const hub = await hubPage("52");
      const answer = hub.contents.debugger.sendCommand.getMockImplementation()!;
      const attach = Promise.withResolvers<unknown>();
      hub.contents.debugger.sendCommand.mockImplementation(
        (method: string, parameters?: Record<string, unknown>, session?: string) =>
          method === "Target.attachToTarget" ? attach.promise : answer(method, parameters, session),
      );
      const person = await hub.page.cdp();
      const agent = await hub.page.agentCdp();
      await person.send("Page.startScreencast", view);
      const starting = agent.send("Page.startScreencast", small);
      await vi.waitFor(() => expect(hub.sent("Target.attachToTarget")).toHaveLength(1));
      fire(hub, "render-process-gone", { reason: "crashed" });
      await expect(starting).rejects.toThrow(/crashed/u);
      attach.resolve({ sessionId: "cast-1" });
      await vi.waitFor(() =>
        expect(hub.sent("Target.detachFromTarget")).toEqual([
          ["Target.detachFromTarget", { sessionId: "cast-1" }],
        ]),
      );
      await hub.browser.close();
    });

    it("lets an agent hear its own target session, attached while one of the hub's was", async () => {
      const hub = await hubPage("53");
      const answer = hub.contents.debugger.sendCommand.getMockImplementation()!;
      const attaches: { id: string; reply: PromiseWithResolvers<unknown> }[] = [];
      hub.contents.debugger.sendCommand.mockImplementation(
        (method: string, parameters?: Record<string, unknown>, session?: string) => {
          if (method !== "Target.attachToTarget") return answer(method, parameters, session);
          const id = `session-${attaches.length + 1}`;
          const reply = Promise.withResolvers<unknown>();
          attaches.push({ id, reply });
          // Chromium tells the page's session of each attach to it before it answers.
          hub.deliver("Target.attachedToTarget", {
            sessionId: id,
            targetInfo: { targetId: "target-1", type: "page" },
            waitingForDebugger: false,
          });
          return reply.promise;
        },
      );
      const person = await hub.page.cdp();
      const caster = await hub.page.agentCdp();
      const agent = await hub.page.agentCdp();
      const agentHeard: string[] = [];
      agent.onEvent((method) => agentHeard.push(method));
      await person.send("Page.startScreencast", view);
      // The hub attaches for the caster's cast, and the agent for its targets, at once.
      const casting = caster.send("Page.startScreencast", small);
      await vi.waitFor(() => expect(attaches).toHaveLength(1));
      const targets = agent.send("Target.getTargetInfo");
      await vi.waitFor(() => expect(attaches).toHaveLength(2));
      attaches[1]!.reply.resolve({ sessionId: "session-2" });
      await targets;
      attaches[0]!.reply.resolve({ sessionId: "session-1" });
      await casting;
      hub.deliver(
        "Target.targetInfoChanged",
        { targetInfo: { targetId: "target-1" } },
        "session-2",
      );
      expect(agentHeard).toEqual(["Target.targetInfoChanged"]);
      await hub.browser.close();
    });
  });

  // The re-check of e7080ea31..963f808d0, finding 2: while an attach of the hub's own is
  // unanswered, every Target event waits, and is released in order once the answer says whose.
  describe("Target events while one of the hub's attaches is unanswered", () => {
    const view = { format: "jpeg", maxHeight: 900, maxWidth: 1_400, quality: 80 };
    const small = { format: "png", maxHeight: 240, maxWidth: 320 };
    async function announcing(label: string) {
      const hub = await hubPage(label);
      const answer = hub.contents.debugger.sendCommand.getMockImplementation()!;
      const attaches: { id: string; reply: PromiseWithResolvers<unknown> }[] = [];
      hub.contents.debugger.sendCommand.mockImplementation(
        (method: string, parameters?: Record<string, unknown>, session?: string) => {
          if (method !== "Target.attachToTarget") return answer(method, parameters, session);
          const id = `session-${attaches.length + 1}`;
          const reply = Promise.withResolvers<unknown>();
          attaches.push({ id, reply });
          hub.deliver("Target.attachedToTarget", {
            sessionId: id,
            targetInfo: { targetId: "target-1", type: "page" },
            waitingForDebugger: false,
          });
          return reply.promise;
        },
      );
      const platform = await hub.page.cdp();
      const heard: string[] = [];
      platform.onEvent((method, parameters) => {
        if (method.startsWith("Target."))
          heard.push(`${method} ${String((parameters as { sessionId?: string }).sessionId)}`);
      });
      await platform.send("Target.setAutoAttach", {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: false,
      });
      await platform.send("Page.startScreencast", view);
      return { attaches, heard, hub, platform };
    }

    it("tells no channel of the hub's session when the renderer goes before the attach answers", async () => {
      const { attaches, heard, hub } = await announcing("75");
      const agent = await hub.page.agentCdp();
      const casting = agent.send("Page.startScreencast", small);
      await vi.waitFor(() => expect(attaches).toHaveLength(1));
      for (const [name, listener] of hub.contents.on.mock.calls)
        if (name === "render-process-gone")
          (listener as (...a: unknown[]) => void)({}, { reason: "crashed" });
      await expect(casting).rejects.toThrow(/crashed/u);
      attaches[0]!.reply.resolve({ sessionId: "session-1" });
      await vi.waitFor(() =>
        expect(hub.sent("Target.detachFromTarget")).toEqual([
          ["Target.detachFromTarget", { sessionId: "session-1" }],
        ]),
      );
      hub.deliver("Target.detachedFromTarget", { sessionId: "session-1", targetId: "target-1" });
      expect(heard).toEqual([]);
      await hub.browser.close();
    });

    // The re-check of 963f808d0..fb245664c, finding 6: what is counted is released on every exit.
    it("holds nothing once an attach of the hub's own throws before it is sent", async () => {
      const hub = await hubPage("81");
      const answer = hub.contents.debugger.sendCommand.getMockImplementation()!;
      let throws = true;
      hub.contents.debugger.sendCommand.mockImplementation(
        (method: string, parameters?: Record<string, unknown>, session?: string) => {
          if (method === "Target.attachToTarget" && throws) {
            throws = false;
            throw new Error("Debugger is not attached to a target.");
          }
          return answer(method, parameters, session);
        },
      );
      const platform = await hub.page.cdp();
      const heard: string[] = [];
      platform.onEvent((method, parameters) => {
        if (method.startsWith("Target."))
          heard.push(`${method} ${String((parameters as { sessionId?: string }).sessionId)}`);
      });
      await platform.send("Target.setAutoAttach", {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: false,
      });
      await platform.send("Page.startScreencast", view);
      const agent = await hub.page.agentCdp();
      await expect(agent.send("Page.startScreencast", small)).rejects.toThrow(/not attached/u);
      hub.deliver("Target.attachedToTarget", {
        sessionId: "frame-1",
        targetInfo: { targetId: "iframe-1", type: "iframe" },
        waitingForDebugger: false,
      });
      hub.deliver("Target.detachedFromTarget", { sessionId: "frame-1", targetId: "iframe-1" });
      expect(heard).toEqual([
        "Target.attachedToTarget frame-1",
        "Target.detachedFromTarget frame-1",
      ]);
      await hub.browser.close();
    });

    // The re-check of 963f808d0..fb245664c, finding 8: nothing in a debugger session's state
    // outlives what it describes, on a debugger session that lives as long as the tab.
    it("keeps nothing of a hundred private sessions that came and went", async () => {
      const hub = await hubPage("82");
      const own = ownSessions(hub);
      const frame = (data: string, sessionId: number) => ({ data, metadata: {}, sessionId });
      const person = await hub.page.cdp();
      await person.send("Page.startScreencast", view);
      for (let index = 1; index <= 100; index += 1) {
        const agent = await hub.page.agentCdp();
        await agent.send("Page.startScreencast", small);
        const session = own.attached.at(-1)!;
        hub.deliver("Page.screencastFrame", frame(`small ${index}`, 1), session);
        await agent.detach();
        // Chromium's last word of a session the hub let go; a late frame of it before that.
        hub.deliver("Page.screencastFrame", frame(`late ${index}`, 1), session);
        hub.deliver("Target.detachedFromTarget", { sessionId: session, targetId: "target-1" });
      }
      expect(own.detached()).toHaveLength(100);
      const state = debuggerSessions.at(
        -1,
      ) as import("./electron-debugger-session.js").DebuggerSessionState;
      // The page's own session is counted while it lives; of the private ones, nothing is left.
      expect({
        laneFrames: [...state.laneFrames.keys()].filter((key) => key !== ""),
        laneStarts: [...state.laneStarts.keys()].filter((key) => key !== ""),
        ownSessions: [...state.ownSessions],
        ownSessionsSeen: [...state.ownSessionsSeen],
      }).toEqual({ laneFrames: [], laneStarts: [], ownSessions: [], ownSessionsSeen: [] });
      await hub.browser.close();
    });

    it("passes on an agent's attach and detach that came meanwhile, in order, attach first", async () => {
      const { attaches, heard, hub } = await announcing("76");
      const caster = await hub.page.agentCdp();
      const agent = await hub.page.agentCdp();
      const casting = caster.send("Page.startScreencast", small);
      await vi.waitFor(() => expect(attaches).toHaveLength(1));
      const targets = agent.send("Target.getTargetInfo");
      await vi.waitFor(() => expect(attaches).toHaveLength(2));
      attaches[1]!.reply.resolve({ sessionId: "session-2" });
      await targets;
      // The agent goes, and Chromium tells of its session's end before the hub's attach answers.
      // (Its release waits behind the cast's start, as every ownership change does.)
      const releasing = agent.detach();
      await vi.waitFor(() =>
        expect(hub.sent("Target.detachFromTarget")).toEqual([
          ["Target.detachFromTarget", { sessionId: "session-2" }],
        ]),
      );
      hub.deliver("Target.detachedFromTarget", { sessionId: "session-2", targetId: "target-1" });
      expect(heard).toEqual([]);
      attaches[0]!.reply.resolve({ sessionId: "session-1" });
      await casting;
      await releasing;
      expect(heard).toEqual([
        "Target.attachedToTarget session-2",
        "Target.detachedFromTarget session-2",
      ]);
      await hub.browser.close();
    });
  });

  // F32, the re-check of 963f808d0..fb245664c: a tab the person opens with an address is
  // announced at about:blank, so the follow view starts its cast there, and navigates at once.
  // Its commit bumps the surface's geometry revision though its size did not change (a stop and a
  // start), and Electron's did-navigate lets the page's capture go and restores it (another).
  // Chromium's picture needs neither: one start reaches it, and no stop.
  it("starts one cast for a tab opened with an address, whatever the follow view restarts", async () => {
    const { ScreencastController } =
      await import("../../../../packages/browser-runtime-core/src/browser/screencast-controller.js");
    const { LatestFrameStream } =
      await import("../../../../packages/browser-runtime-core/src/stream/latest-frame-stream.js");
    const { jpeg } =
      await import("../../../../packages/browser-runtime-core/src/test-support/fakes.js");
    const hub = await hubPage("66");
    const channel = await hub.page.cdp();
    const shown = { height: 900, width: 1_400 };
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
    const surface = {
      active: true,
      documentId: "about-blank",
      geometryRevision: 1,
      id: "surface-1",
      loading: true,
    };
    let capture: { height: number; rasterScale: number; revision: number; width: number } | null = {
      height: shown.height,
      rasterScale: 1,
      revision: 1,
      width: shown.width,
    };
    const captureListeners = new Set<() => void>();
    const binding = {
      cdp: channel,
      page: {
        applyGeometry: async () => undefined,
        capture: {
          read: () => capture,
          subscribe: (listener: () => void) => {
            captureListeners.add(listener);
            return () => captureListeners.delete(listener);
          },
        },
        invalidateSurface: async () => undefined,
        settleRendering: async () => undefined,
      },
      surface,
    };
    const ledgerListeners = new Set<(event: unknown) => void>();
    const ledger = {
      active: () => binding,
      binding: () => binding,
      dialogOf: () => null,
      dialogOpen: () => false,
      recordPageScale: () => undefined,
      subscribe: (listener: (event: unknown) => void) => {
        ledgerListeners.add(listener);
        return () => ledgerListeners.delete(listener);
      },
      use: <T>(_id: string, operation: () => Promise<T>) => operation(),
      viewportOf: () => shown,
      withGeometry: <T>(_id: string, operation: () => Promise<T>) => operation(),
    };
    const changed = () => {
      for (const listener of ledgerListeners)
        listener({ change: "updated", surface: { ...surface }, type: "changed" });
    };
    const delivered: unknown[] = [];
    const follow = new ScreencastController({
      frames: new LatestFrameStream({ sendFrame: async (sent) => void delivered.push(sent) }),
      ledger: ledger as never,
      onDialogChanged: () => undefined,
    });
    // The first start is unanswered while the page navigates.
    const start = hub.hold("Page.startScreencast");
    await follow.start();
    const streaming = follow.setStreaming(true);
    await vi.waitFor(() => expect(start.replies).toHaveLength(1));
    // Page.frameNavigated: a new document, its geometry revision bumped, its size the same.
    Object.assign(surface, { documentId: "follow", geometryRevision: 2 });
    changed();
    // Electron's did-navigate: the page lets its capture go, and its reconcile restores it.
    for (const [name, listener] of hub.contents.on.mock.calls)
      if (name === "did-navigate") (listener as (...a: unknown[]) => void)({});
    capture = null;
    for (const listener of captureListeners) listener();
    capture = { height: shown.height, rasterScale: 1, revision: 1, width: shown.width };
    for (const listener of captureListeners) listener();
    start.release();
    start.replies[0]!.resolve({});
    await streaming;
    // The page finishes loading, and draws.
    Object.assign(surface, { loading: false });
    changed();
    await vi.waitFor(() =>
      expect(
        follow.diagnostics.filter(({ stage }) => stage === "cast-start").length,
      ).toBeGreaterThan(1),
    );
    // Chromium numbers each start's frames: the latest it answered.
    hub.deliver("Page.screencastFrame", frame(hub.sent("Page.startScreencast").length));
    await vi.waitFor(() => expect(delivered.length).toBeGreaterThan(0));
    await pastParking();
    expect({
      starts: hub.sent("Page.startScreencast").length,
      stops: hub.sent("Page.stopScreencast").length,
    }).toEqual({ starts: 1, stops: 0 });
    await follow.close();
    await hub.browser.close();
  });

  // F32, widened after the walker's runs on 963f808d0 and fb245664c: one ordering passing proves
  // nothing. Every order of the events around a tab's first start, for a tab opened with an
  // address: the start's answer, a frame that beats it, the commit bumping the geometry revision,
  // Electron's did-navigate letting the capture go and restoring it, and a second channel asking
  // for the same picture. In each, one start reaches Chromium, no stop, and the follow view is
  // handed a frame.
  it("starts one cast for a tab opened with an address, in every order of what happens around it", async () => {
    const { ScreencastController } =
      await import("../../../../packages/browser-runtime-core/src/browser/screencast-controller.js");
    const { LatestFrameStream } =
      await import("../../../../packages/browser-runtime-core/src/stream/latest-frame-stream.js");
    const { jpeg } =
      await import("../../../../packages/browser-runtime-core/src/test-support/fakes.js");
    const shown = { height: 900, width: 1_400 };
    const settings = {
      everyNthFrame: 1,
      format: "jpeg",
      maxHeight: shown.height,
      maxWidth: shown.width,
      quality: 72,
    };
    const frameOf = (id: number) => ({
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
    const events = ["answer", "early frame", "commit", "did-navigate", "second channel"] as const;
    type Event = (typeof events)[number];
    // Every order of the first four, then orders of all five drawn from a fixed seed.
    const orders: Event[][] = [];
    const permute = (rest: readonly Event[], made: Event[]) => {
      if (rest.length === 0) orders.push(made);
      for (const [index, event] of rest.entries())
        permute([...rest.slice(0, index), ...rest.slice(index + 1)], [...made, event]);
    };
    permute(events.slice(0, 4), []);
    let seed = 0x5eed;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let drawn = 0; drawn < 24; drawn += 1) {
      const order = [...events];
      for (let index = order.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [order[index], order[other]] = [order[other]!, order[index]!];
      }
      orders.push(order);
    }
    const failures: string[] = [];
    for (const [index, order] of orders.entries()) {
      const hub = await hubPage(String(700 + index));
      const channel = await hub.page.cdp();
      const surface = {
        active: true,
        documentId: "about-blank",
        geometryRevision: 1,
        id: "surface-1",
        loading: true,
      };
      let capture: { height: number; rasterScale: number; revision: number; width: number } | null =
        { height: shown.height, rasterScale: 1, revision: 1, width: shown.width };
      const captureListeners = new Set<() => void>();
      const binding = {
        cdp: channel,
        page: {
          applyGeometry: async () => undefined,
          capture: {
            read: () => capture,
            subscribe: (listener: () => void) => {
              captureListeners.add(listener);
              return () => captureListeners.delete(listener);
            },
          },
          invalidateSurface: async () => undefined,
          settleRendering: async () => undefined,
        },
        surface,
      };
      const ledgerListeners = new Set<(event: unknown) => void>();
      const ledger = {
        active: () => binding,
        binding: () => binding,
        dialogOf: () => null,
        dialogOpen: () => false,
        recordPageScale: () => undefined,
        subscribe: (listener: (event: unknown) => void) => {
          ledgerListeners.add(listener);
          return () => ledgerListeners.delete(listener);
        },
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
      const start = hub.hold("Page.startScreencast");
      await follow.start();
      const streaming = follow.setStreaming(true).catch(() => undefined);
      await vi.waitFor(() => expect(start.replies).toHaveLength(1));
      const other = await hub.page.agentCdp();
      let otherAsked: Promise<unknown> = Promise.resolve();
      for (const event of order) {
        if (event === "answer") {
          start.release();
          for (const reply of start.replies) reply.resolve({});
        } else if (event === "early frame") hub.deliver("Page.screencastFrame", frameOf(1));
        else if (event === "commit") {
          Object.assign(surface, { documentId: "follow", geometryRevision: 2 });
          for (const listener of ledgerListeners)
            listener({ change: "updated", surface: { ...surface }, type: "changed" });
        } else if (event === "did-navigate") {
          for (const [name, listener] of hub.contents.on.mock.calls)
            if (name === "did-navigate") (listener as (...a: unknown[]) => void)({});
          capture = null;
          for (const listener of captureListeners) listener();
          capture = { height: shown.height, rasterScale: 1, revision: 1, width: shown.width };
          for (const listener of captureListeners) listener();
        } else otherAsked = other.send("Page.startScreencast", settings).catch(() => undefined);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await streaming;
      await otherAsked;
      // The page draws: Chromium's frames carry the latest start it answered.
      await vi.waitFor(() => {
        hub.deliver("Page.screencastFrame", frameOf(hub.sent("Page.startScreencast").length));
        expect(delivered.length).toBeGreaterThan(0);
      });
      await pastParking();
      const reached = {
        starts: hub.sent("Page.startScreencast").length,
        stops: hub.sent("Page.stopScreencast").length,
      };
      if (reached.starts !== 1 || reached.stops !== 0)
        failures.push(`${order.join(" → ")}: ${JSON.stringify(reached)}`);
      await follow.close();
      await hub.browser.close();
    }
    expect(failures).toEqual([]);
    expect(orders).toHaveLength(48);
  });

  // F32 (b), from the walker's run on fb245664c: after a dialog on the shown tab is answered,
  // its cast runs again at once: a start is sent and a frame handed to the follow view. Every
  // order of what happens around the answer, on the hub with the real follow view: the dialog's
  // close, the frame Chromium sends after it, a second channel asking for the same picture, and
  // the follow view's start being answered.
  it("pictures a tab again once its dialog is answered, in every order of what happens around it", async () => {
    const { ScreencastController } =
      await import("../../../../packages/browser-runtime-core/src/browser/screencast-controller.js");
    const { LatestFrameStream } =
      await import("../../../../packages/browser-runtime-core/src/stream/latest-frame-stream.js");
    const { jpeg } =
      await import("../../../../packages/browser-runtime-core/src/test-support/fakes.js");
    const shown = { height: 900, width: 1_400 };
    const settings = {
      everyNthFrame: 1,
      format: "jpeg",
      maxHeight: shown.height,
      maxWidth: shown.width,
      quality: 72,
    };
    const frameOf = (id: number) => ({
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
    const events = ["closed", "frame", "second channel", "answer"] as const;
    type Event = (typeof events)[number];
    const orders: Event[][] = [];
    const permute = (rest: readonly Event[], made: Event[]) => {
      if (rest.length === 0) orders.push(made);
      for (const [index, event] of rest.entries())
        permute([...rest.slice(0, index), ...rest.slice(index + 1)], [...made, event]);
    };
    permute(events, []);
    const failures: string[] = [];
    for (const [index, order] of orders.entries()) {
      const hub = await hubPage(String(800 + index));
      const channel = await hub.page.cdp();
      let dialogOpen = false;
      const surface = {
        active: true,
        documentId: "b",
        geometryRevision: 1,
        id: "tab-b",
        loading: false,
      };
      const capture = { height: shown.height, rasterScale: 1, revision: 1, width: shown.width };
      const binding = {
        cdp: channel,
        page: {
          applyGeometry: async () => undefined,
          capture: { read: () => capture, subscribe: () => () => undefined },
          invalidateSurface: async () => undefined,
          settleRendering: async () => undefined,
        },
        surface,
      };
      const ledgerListeners = new Set<(event: unknown) => void>();
      const ledger = {
        active: () => binding,
        binding: () => binding,
        dialogOf: () => (dialogOpen ? { id: "dialog-b", surfaceId: "tab-b" } : null),
        dialogOpen: () => dialogOpen,
        recordPageScale: () => undefined,
        subscribe: (listener: (event: unknown) => void) => {
          ledgerListeners.add(listener);
          return () => ledgerListeners.delete(listener);
        },
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
      // The tab was pictured, then the person turned away, seconds before its dialog opened.
      await follow.start();
      await follow.setStreaming(true);
      await vi.waitFor(() => expect(hub.sent("Page.startScreencast")).toHaveLength(1));
      hub.deliver("Page.screencastFrame", frameOf(1));
      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      await follow.setStreaming(false);
      await pastParking();
      dialogOpen = true;
      hub.deliver("Page.javascriptDialogOpening", {
        defaultPrompt: "",
        frameId: "target-1",
        hasBrowserHandler: false,
        message: "Allow destructive action B?",
        type: "confirm",
        url: "https://example.test/follow?dialog-b",
      });
      for (const listener of ledgerListeners)
        listener({ dialog: { id: "dialog-b" }, surfaceId: "tab-b", type: "dialog" });
      // The person turns back while it is open: the last picture, and no cast until the answer.
      delivered.length = 0;
      const start = hub.hold("Page.startScreencast");
      await follow.setStreaming(true);
      const other = await hub.page.agentCdp();
      let otherAsked: Promise<unknown> = Promise.resolve();
      let answered = false;
      for (const event of order) {
        if (event === "closed") {
          dialogOpen = false;
          hub.deliver("Page.javascriptDialogClosed", {
            frameId: "target-1",
            result: false,
            userInput: "",
          });
          for (const listener of ledgerListeners)
            listener({ dialog: null, surfaceId: "tab-b", type: "dialog" });
        } else if (event === "frame")
          // A late frame of the cast before the dialog: Chromium's id for that cast.
          hub.deliver("Page.screencastFrame", frameOf(1));
        else if (event === "second channel")
          otherAsked = other.send("Page.startScreencast", settings).catch(() => undefined);
        else {
          answered = true;
          start.release();
          for (const reply of start.replies) reply.resolve({});
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (!answered) start.release();
      start.release();
      for (const reply of start.replies) reply.resolve({});
      await otherAsked;
      try {
        await vi.waitFor(() => {
          hub.deliver("Page.screencastFrame", frameOf(hub.sent("Page.startScreencast").length));
          expect(delivered.length).toBeGreaterThan(0);
        });
      } catch {
        failures.push(
          `${order.join(" → ")}: no picture, ${hub.sent("Page.startScreencast").length} starts`,
        );
      }
      await follow.close();
      await hub.browser.close();
    }
    expect(failures).toEqual([]);
    expect(orders).toHaveLength(24);
  });

  // F30, the first half of the hypothesis for follow-never-shown-tab's four starts: a tab never
  // shown sends, before its start's answer is handled, a first frame at the size it last drew,
  // which 6a0311f0b made the hub hand on; the real follow view, sized as the Electron page sizes
  // it, sees that frame. If it restarted the cast for every such frame, one show would send
  // several starts. Here it is the follow view of browser-runtime-core, its resizeView included,
  // on the hub's own channel; only the ledger around it is the least the follow view reads.
  it("sends one start when a never-shown tab's first frame, of its old size, beats the answer", async () => {
    const { ScreencastController } =
      await import("../../../../packages/browser-runtime-core/src/browser/screencast-controller.js");
    const { LatestFrameStream } =
      await import("../../../../packages/browser-runtime-core/src/stream/latest-frame-stream.js");
    const { jpeg } =
      await import("../../../../packages/browser-runtime-core/src/test-support/fakes.js");
    const hub = await hubPage("65");
    const channel = await hub.page.cdp();
    const shown = { height: 900, width: 1_400 };
    // The size the tab drew at before it was shown: its resting host's.
    const resting = { height: 600, width: 800 };
    const answer = hub.contents.debugger.sendCommand.getMockImplementation()!;
    let starts = 0;
    const frame = (size: { height: number; width: number }, id: number) => ({
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
    hub.contents.debugger.sendCommand.mockImplementation(
      (method: string, parameters?: Record<string, unknown>, session?: string) => {
        const answered = answer(method, parameters, session);
        if (method !== "Page.startScreencast") return answered;
        const id = (starts += 1);
        // Chromium answers, and sends the picture it last drew before the hub hears the
        // answer; the picture at the shown size follows.
        return Promise.resolve(answered).then((result) => {
          hub.deliver("Page.screencastFrame", frame(resting, id));
          setTimeout(() => hub.deliver("Page.screencastFrame", frame(shown, id)), 5);
          return result;
        });
      },
    );
    const surface = {
      documentId: "document-1",
      geometryRevision: 1,
      id: "surface-1",
      loading: false,
    };
    const capture = { height: shown.height, rasterScale: 1, revision: 1, width: shown.width };
    const binding = {
      cdp: channel,
      page: {
        applyGeometry: async () => undefined,
        capture: { read: () => capture, subscribe: () => () => undefined },
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
    // What the follow view asks of the hub, beside what reaches Chromium (`starts`).
    const asked: string[] = [];
    const ask = channel.send.bind(channel);
    channel.send = ((method: string, parameters?: Record<string, unknown>) => {
      if (method === "Page.startScreencast" || method === "Page.stopScreencast") asked.push(method);
      return ask(method, parameters);
    }) as typeof channel.send;
    const handed: number[] = [];
    channel.onEvent((method, parameters) => {
      if (method === "Page.screencastFrame")
        handed.push((parameters as { metadata: { deviceWidth: number } }).metadata.deviceWidth);
    });
    await follow.start();
    await follow.setStreaming(true);
    const admitted = () =>
      follow.diagnostics.filter(({ stage }) => stage === "capture-admit").length;
    // Drawn: the frame at the shown size, which comes after any restart the first one caused.
    await vi.waitFor(() => expect(admitted()).toBe(1));
    await new Promise((resolve) => setImmediate(resolve));
    const discarded = () =>
      follow.diagnostics.filter(({ stage }) => stage === "capture-discard").length;
    // The hub handed it the old-size frame with the start, and it took the frame for none of its
    // own: its cast had not started when the frame came, so it neither drew it nor restarted.
    expect(handed).toEqual([resting.width, shown.width]);
    expect({ discarded: discarded(), starts }).toEqual({ discarded: 0, starts: 1 });
    // The same frame once its cast runs is one it restarts for, once: what the test would see.
    // The hub asks Chromium for nothing then (F32): the same picture, asked for again by the
    // owner that stopped it, is the cast that runs.
    hub.deliver("Page.screencastFrame", frame(resting, starts));
    await vi.waitFor(() => expect(discarded()).toBe(1));
    await vi.waitFor(() =>
      expect(asked).toEqual([
        "Page.startScreencast",
        "Page.stopScreencast",
        "Page.startScreencast",
      ]),
    );
    hub.deliver("Page.screencastFrame", frame(shown, starts));
    await vi.waitFor(() => expect(admitted()).toBe(2));
    expect({ starts, stops: hub.sent("Page.stopScreencast").length }).toEqual({
      starts: 1,
      stops: 0,
    });
    await follow.close();
    await hub.browser.close();
  });

  // Finding 8: a page runs a few casts at most, and equal settings are one cast.
  describe("how many casts a page runs", () => {
    // Run on 963f808d0, follow-never-shown-tab: a tab the person opened recorded four starts in
    // equal settings. Every caller that asks while a start for the tab is unanswered waits for it
    // (the ownership queue) and joins the cast it makes: one start, whoever and however many ask.
    it("sends one start for a never-shown tab that several callers ask for at once", async () => {
      const hub = await hubPage("64");
      const settings = {
        everyNthFrame: 1,
        format: "jpeg",
        maxHeight: 900,
        maxWidth: 1_400,
        quality: 72,
      };
      const person = await hub.page.cdp();
      const agents = await Promise.all([1, 2].map(() => hub.page.agentCdp()));
      const start = hub.hold("Page.startScreencast");
      const asking = [person, person, ...agents, person].map((channel) =>
        channel.send("Page.startScreencast", settings),
      );
      await vi.waitFor(() => expect(start.replies).toHaveLength(1));
      start.release();
      start.replies[0]!.resolve({});
      await Promise.all(asking);
      expect(hub.sent("Page.startScreencast")).toHaveLength(1);
      await hub.browser.close();
    });

    it("takes settings that differ only by Chromium's defaults for one cast", async () => {
      const hub = await hubPage("61");
      const person = await hub.page.cdp();
      const agent = await hub.page.agentCdp();
      const other = await hub.page.agentCdp();
      await person.send("Page.startScreencast", { format: "jpeg", quality: 80 });
      await agent.send("Page.startScreencast", { everyNthFrame: 1, format: "jpeg", quality: 80 });
      await other.send("Page.startScreencast", { format: "jpeg" });
      expect(hub.sent("Page.startScreencast")).toHaveLength(1);
      await hub.browser.close();
    });

    it("refuses a fourth in a sentence, takes nothing from those that run, and never refuses the person", async () => {
      const hub = await hubPage("62");
      const own = ownSessions(hub);
      const person = await hub.page.cdp();
      const agents = await Promise.all([1, 2, 3].map(() => hub.page.agentCdp()));
      await person.send("Page.startScreencast", { format: "jpeg", maxWidth: 1_400 });
      await agents[0]!.send("Page.startScreencast", { format: "png", maxWidth: 320 });
      await agents[1]!.send("Page.startScreencast", { format: "png", maxWidth: 640 });
      // The third agent watches the person's cast, then asks for a fourth.
      await agents[2]!.send("Page.startScreencast", { format: "jpeg", maxWidth: 1_400 });
      const saw: string[] = [];
      agents[2]!.onEvent((method, parameters) => {
        if (method === "Page.screencastFrame") saw.push((parameters as { data: string }).data);
      });
      const starts = hub.sent("Page.startScreencast").length;
      await expect(
        agents[2]!.send("Page.startScreencast", { format: "png", maxWidth: 800 }),
      ).rejects.toThrow(/already pictured in 3 formats or sizes at once/u);
      expect(hub.sent("Page.startScreencast")).toHaveLength(starts);
      expect(own.attached).toEqual(["cast-1", "cast-2"]);
      hub.deliver("Page.screencastFrame", { data: "person's", metadata: {}, sessionId: 1 });
      expect(saw).toEqual(["person's"]);
      // The person's own view in another size is never the one refused.
      const phone = await hub.page.cdp();
      await phone.send("Page.startScreencast", { format: "jpeg", maxWidth: 390 });
      expect(own.attached).toEqual(["cast-1", "cast-2", "cast-3"]);
      await hub.browser.close();
    });

    // The re-check of 5d197dfbc..e7080ea31, finding 5: the cap counts casts that run or start.
    it("counts no cast the renderer's loss ended, though its owners stay", async () => {
      const hub = await hubPage("63");
      ownSessions(hub);
      const person = await hub.page.cdp();
      const agents = await Promise.all([1, 2, 3].map(() => hub.page.agentCdp()));
      await person.send("Page.startScreencast", { format: "jpeg", maxWidth: 1_400 });
      await agents[0]!.send("Page.startScreencast", { format: "png", maxWidth: 320 });
      await agents[1]!.send("Page.startScreencast", { format: "png", maxWidth: 640 });
      for (const [name, listener] of hub.contents.on.mock.calls) {
        if (name === "render-process-gone")
          (listener as (...a: unknown[]) => void)({}, { reason: "crashed" });
        if (name === "did-navigate") (listener as (...a: unknown[]) => void)({});
      }
      await expect(
        agents[2]!.send("Page.startScreencast", { format: "png", maxWidth: 800 }),
      ).resolves.toEqual({});
      await hub.browser.close();
    });
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
    hub.contents.close.mockImplementation(() => {
      setImmediate(hub.destroy);
    });
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
  it("normalizes native cursor changes and invalidates attribution on native movement", async () => {
    const { browser, page, view } = await launch();
    const publish = vi.fn();
    const unsubscribe = page.cursor!.subscribe(publish);
    const changed = view.webContents.on.mock.calls.find(
      ([event]) => event === "cursor-changed",
    )?.[1];
    const moved = view.webContents.on.mock.calls.find(
      ([event]) => event === "before-mouse-event",
    )?.[1];
    try {
      changed!({}, "hand");
      expect(page.cursor!.read()).toBe("pointer");
      expect(publish).toHaveBeenLastCalledWith("pointer");
      moved!({}, { type: "mouseMove", x: 1, y: 1 });
      expect(publish).toHaveBeenLastCalledWith(null);
      changed!({}, "custom", { privateImage: "must never escape" });
      expect(page.cursor!.read()).toBe("default");
      expect(publish).toHaveBeenLastCalledWith("default");
    } finally {
      unsubscribe();
      await browser.close();
    }
  });

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
      const pending = (operations.at(-1)?.catch(() => undefined) ?? Promise.resolve()).then(
        operation,
      );
      operations.push(pending);
      return pending;
    };
    const unbind = bindGeometry ? page.bindGeometry!(serialize, releaseInput) : () => undefined;
    if (bindGeometry)
      await page.applyGeometry!({ person: { width: 800, height: 600 }, agent: null });
    const drain = async () => {
      for (let index = 0; index < operations.length; index++) await operations[index];
    };
    return {
      browser,
      page,
      native,
      view,
      host,
      unbind,
      drain,
      operations,
      releaseInput,
      serialize,
    };
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

  it("admits page composition and synthesized gestures for both platform and full-access agents", async () => {
    const { browser, page, view, unbind } = await launch();
    try {
      const platform = await page.cdp();
      const agent = await page.agentCdp();
      const composition = { text: "한", selectionStart: 1, selectionEnd: 1 };
      await expect(agent.send("Input.imeSetComposition", composition)).resolves.toEqual({});
      for (const channel of [platform, agent])
        await expect(
          channel.send("Input.synthesizeScrollGesture", { x: 5, y: 5 }),
        ).resolves.toEqual({});
      await expect(platform.send("Input.imeSetComposition", composition)).resolves.toEqual({});
      const cancel = { text: "", selectionStart: 0, selectionEnd: 0 };
      await expect(platform.send("Input.imeSetComposition", cancel)).resolves.toEqual({});
      expect(
        view.webContents.debugger.sendCommand.mock.calls.filter(([method]) =>
          method.startsWith("Input."),
        ),
      ).toEqual([
        ["Input.imeSetComposition", composition],
        ["Input.synthesizeScrollGesture", { x: 5, y: 5 }],
        ["Input.synthesizeScrollGesture", { x: 5, y: 5 }],
        ["Input.imeSetComposition", composition],
        ["Input.imeSetComposition", cancel],
      ]);
    } finally {
      unbind();
      await browser.close();
    }
  });

  it("allows page drag cancellation and private cleanup on the originating channel", async () => {
    const { browser, page, view } = await launch(false);
    const platform = await page.cdp();
    const agent = await page.agentCdp();
    try {
      await expect(agent.send("Input.cancelDragging")).resolves.toEqual({});
      await platform.cancelDragging!();
      await agent.cancelDragging!();
      expect(
        view.webContents.debugger.sendCommand.mock.calls.filter(
          ([method]) => method === "Input.cancelDragging",
        ),
      ).toEqual([
        ["Input.cancelDragging", undefined],
        ["Input.cancelDragging", undefined],
        ["Input.cancelDragging", undefined],
      ]);
    } finally {
      await agent.detach();
      await platform.detach();
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

  it.each([
    ["geometry lock", { x: 280, y: 52, width: 800, height: 600 }],
    ["resize barrier", { x: 280, y: 52, width: 1000, height: 700 }],
  ] as const)(
    "keeps a mounted page out of its window until its %s releases placement",
    async (wait, stage) => {
      const { browser, native, view, serialize, drain, releaseInput } = await launch();
      const window = new BaseWindow({}) as unknown as (typeof electron.hosts)[number];
      const joined: Bounds[] = [];
      window.contentView.addChildView.mockImplementation((child: typeof view) =>
        joined.push(child.getBounds()),
      );
      const held = gate({ label: `mounted page ${wait}`, deadlineMs: 1000 });
      if (wait === "geometry lock") void serialize(() => held.enter());
      else releaseInput.mockImplementationOnce(() => held.enter());
      const placed = vi.fn();
      try {
        native.mount(window as unknown as BaseWindow, stage, placed);
        await held.entered;
        expect(joined).toEqual([]);
        expect(placed).not.toHaveBeenCalled();
        held.release();
        await drain();
        expect(joined).toEqual([stage]);
        expect(placed).toHaveBeenCalledWith(expect.objectContaining({ bounds: stage }));
      } finally {
        held.release();
        await browser.close();
      }
    },
  );

  describe("a page in a hidden window", () => {
    const stage = { x: 280, y: 52, width: 800, height: 600 };
    type Host = (typeof electron.hosts)[number];
    type View = (typeof electron.views)[number];
    /** The host the view was last added to, by the order Electron saw the calls. */
    const parentOf = (view: View, hosts: readonly Host[]) => {
      let parent: Host | null = null;
      let latest = -1;
      for (const candidate of hosts) {
        const { calls, invocationCallOrder } = candidate.contentView.addChildView.mock;
        calls.forEach(([child], index) => {
          if (child === view && invocationCallOrder[index]! > latest) {
            latest = invocationCallOrder[index]!;
            parent = candidate;
          }
        });
      }
      return parent;
    };
    const mounted = async () => {
      const launched = await launch();
      const window = new BaseWindow({}) as unknown as Host;
      launched.native.mount(window as unknown as BaseWindow, stage, vi.fn());
      await launched.drain();
      return { ...launched, window };
    };

    it("rests in its own host at its own origin, then returns to its place in the window", async () => {
      const { browser, drain, host, native, view, window } = await mounted();
      try {
        expect(parentOf(view, [host, window])).toBe(window);
        native.setParked(true);
        expect(parentOf(view, [host, window])).toBe(host);
        expect(view.getBounds()).toEqual({ ...stage, x: 0, y: 0 });
        await drain();
        native.setParked(false);
        await drain();
        expect(parentOf(view, [host, window])).toBe(window);
        expect(view.getBounds()).toEqual(stage);
      } finally {
        await browser.close();
      }
    });

    it("settles a resize while parked instead of placing it again forever", async () => {
      const { browser, drain, host, native, operations, view, window } = await mounted();
      try {
        native.setParked(true);
        native.setStage({ ...stage, width: 820 });
        await drain();
        const settled = operations.length;
        const writes = view.setBounds.mock.calls.length;
        await drain();
        expect(operations.length).toBe(settled);
        expect(view.setBounds.mock.calls.length).toBe(writes);
        expect(parentOf(view, [host, window])).toBe(host);
        expect(view.getBounds()).toEqual({ x: 0, y: 0, width: 820, height: 600 });
        native.setParked(false);
        await drain();
        expect(parentOf(view, [host, window])).toBe(window);
        expect(view.getBounds()).toEqual({ ...stage, width: 820 });
      } finally {
        await browser.close();
      }
    });

    it("lands in its place, not at the corner, after a quick hide and show", async () => {
      const { browser, drain, host, native, view, window } = await mounted();
      try {
        native.setParked(true);
        native.setParked(false);
        await drain();
        expect(parentOf(view, [host, window])).toBe(window);
        expect(view.getBounds()).toEqual(stage);
      } finally {
        await browser.close();
      }
    });

    it("never joins a window that hid before its first placement", async () => {
      const { browser, drain, host, native, view } = await launch();
      const window = new BaseWindow({}) as unknown as Host;
      try {
        native.mount(window as unknown as BaseWindow, stage, vi.fn());
        native.setParked(true);
        await drain();
        expect(window.contentView.addChildView).not.toHaveBeenCalled();
        expect(parentOf(view, [host, window])).toBe(host);
        native.setParked(false);
        await drain();
        expect(parentOf(view, [host, window])).toBe(window);
        expect(view.getBounds()).toEqual(stage);
      } finally {
        await browser.close();
      }
    });

    it("stays in its own host when it closes while parked", async () => {
      const { browser, drain, host, native, view, window } = await mounted();
      try {
        native.setParked(true);
        native.unmount();
        native.setParked(false);
        await drain();
        expect(parentOf(view, [host, window])).toBe(host);
        expect(window.contentView.addChildView).toHaveBeenCalledTimes(1);
      } finally {
        await browser.close();
      }
    });
  });

  it("attaches a page remounted while its placement waited only to its latest window", async () => {
    const { browser, native, view, serialize, drain } = await launch();
    const [first, second] = [new BaseWindow({}), new BaseWindow({})] as unknown as Array<
      (typeof electron.hosts)[number]
    >;
    const held = gate({ label: "remounted page geometry lock", deadlineMs: 1000 });
    void serialize(() => held.enter());
    const stage = { x: 280, y: 52, width: 800, height: 600 };
    const placed = vi.fn();
    try {
      native.mount(first as unknown as BaseWindow, { ...stage, x: 10 }, vi.fn());
      await held.entered;
      native.unmount();
      native.mount(second as unknown as BaseWindow, stage, placed);
      held.release();
      await drain();
      expect(first!.contentView.addChildView).not.toHaveBeenCalled();
      expect(second!.contentView.addChildView).toHaveBeenCalledExactlyOnceWith(view);
      expect(view.getBounds()).toEqual(stage);
      expect(placed).toHaveBeenCalledWith(expect.objectContaining({ bounds: stage }));
    } finally {
      held.release();
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

  it("only composites a hidden page while a caller needs a frame", async () => {
    const { browser, native, view, unbind } = await launch();
    const contents = view.webContents;
    const first = new AbortController();
    const last = new AbortController();
    try {
      expect(contents.beginFrameSubscription).not.toHaveBeenCalled();
      expect(contents.backgroundThrottling).toBe(true);
      contents.beginFrameSubscription.mockImplementation(() => undefined);
      const a = expect(native.waitForPaint(first.signal)).rejects.toThrow();
      const b = expect(native.waitForPaint(last.signal)).rejects.toThrow();
      expect(contents.beginFrameSubscription).toHaveBeenCalledTimes(1);
      expect(contents.backgroundThrottling).toBe(false);
      first.abort();
      await a;
      expect(contents.endFrameSubscription).not.toHaveBeenCalled();
      last.abort();
      await b;
      expect(contents.endFrameSubscription).toHaveBeenCalledTimes(1);
      expect(contents.backgroundThrottling).toBe(true);
    } finally {
      first.abort();
      last.abort();
      unbind();
      await browser.close();
    }
  });

  it.each(["without a waiter", "after the last waiter aborts"])(
    "releases stalled hidden geometry %s and allows a new geometry write",
    async (scenario) => {
      const { browser, native, view, unbind, drain } = await launch();
      const contents = view.webContents;
      const held = Promise.withResolvers<unknown>();
      const started = vi.fn();
      const send = contents.debugger.sendCommand.getMockImplementation()!;
      contents.debugger.sendCommand.mockImplementation((method, parameters) => {
        if (method !== "Page.getLayoutMetrics") return send(method, parameters);
        started();
        return held.promise;
      });
      const signal = new AbortController();
      vi.useFakeTimers();
      try {
        for (const [event, listener] of contents.on.mock.calls)
          if (event === "did-navigate") listener();
        const placement = drain().catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(0);
        expect(started).toHaveBeenCalledOnce();
        if (scenario === "after the last waiter aborts") {
          const canceled = expect(native.waitForPaint(signal.signal)).rejects.toThrow("canceled");
          signal.abort();
          await canceled;
        }
        expect(contents.backgroundThrottling).toBe(false);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(contents.backgroundThrottling).toBe(true);
        expect(contents.beginFrameSubscription).not.toHaveBeenCalled();
        expect(await placement).toBeInstanceOf(Error);
        contents.debugger.sendCommand.mockImplementation(send);
        await native.invalidateSurface();
        expect(native.view.getBounds()).toEqual({ x: 0, y: 0, width: 800, height: 600 });
        held.resolve({});
      } finally {
        held.resolve({});
        unbind();
        vi.useRealTimers();
        await browser.close();
      }
    },
  );

  it("ends capture when only different-size frames arrive", async () => {
    const { browser, native, page, view, serialize, releaseInput } = await launch(false);
    const contents = view.webContents;
    contents.beginFrameSubscription.mockImplementation((callback) => {
      callback({ getSize: () => ({ width: 1, height: 1 }) });
    });
    const unbind = page.bindGeometry!(serialize, releaseInput);
    vi.useFakeTimers();
    try {
      await page.applyGeometry!({ person: { width: 800, height: 600 }, agent: null });
      const waiting = native.waitForPaint();
      const settled = vi.fn();
      void waiting.then(settled, settled);
      const failure = expect(waiting).rejects.toThrow("paint wait timed out");
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await failure;
      expect(contents.endFrameSubscription).toHaveBeenCalledTimes(1);
      expect(contents.backgroundThrottling).toBe(true);
    } finally {
      unbind();
      await browser.close();
      vi.useRealTimers();
    }
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
  it("keeps a tab opened behind its page apart from a popup a person will look at", async () => {
    const launcher = new ElectronBrowserLauncher({
      downloads: { accept: () => undefined },
      pagePolicyPreloadPath: "/policy.cjs",
    });
    const browser = await launcher.launch({
      initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
      partitionKey: "session:background-tab",
      sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000001"),
      storage: { kind: "guest" },
    });
    try {
      const opened: { readonly openedInBackground?: boolean }[] = [];
      browser.context.onPage((page) => opened.push(page));
      const open = electron.views.at(-1)!.webContents.setWindowOpenHandler.mock.calls[0]![0];
      for (const disposition of ["background-tab", "foreground-tab", "new-window"])
        open({ url: "https://example.test/", disposition }).createWindow({});
      await vi.waitFor(() => expect(opened).toHaveLength(3));
      expect(opened.map((page) => page.openedInBackground)).toEqual([true, false, false]);
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

it("presents the session identity on passkey provider pages too", async () => {
  const launcher = new ElectronBrowserLauncher({
    downloads: { accept: vi.fn() },
    pagePolicyPreloadPath: "/policy.cjs",
  });
  const browser = await launcher.launch({
    initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
    partitionKey: "session:provider-identity",
    sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000010"),
    storage: { kind: "guest" },
    authenticator: {
      ceremony: async () => ({ kind: "refused" as const, error: "NotAllowedError" as const }),
    },
  });
  try {
    // The bridge owns these pages' debugger and attaches it during
    // bootstrap; the identity override lands once it is attached.
    await vi.waitFor(() => {
      const calls = electron.views.at(-1)!.webContents.debugger.sendCommand.mock.calls;
      expect(
        calls.some(
          ([method, parameters]) =>
            method === "Emulation.setUserAgentOverride" &&
            (parameters as { userAgent: string }).userAgent.includes("Chrome/152.0.0.0"),
        ),
      ).toBe(true);
    });
  } finally {
    await browser.close();
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
    const onLocalProfileOpenTiming = vi.fn();
    const onLocalProfileDiagnostic = vi.fn();
    const launcher = new ElectronBrowserLauncher({
      downloads: {
        accept: vi.fn(() => {
          if (policyFailure) throw new Error("policy failed");
        }),
      },
      pagePolicyPreloadPath: "/policy.cjs",
      localProfileRoot: root,
      onLocalProfileOpenTiming,
      onLocalProfileDiagnostic,
    });
    const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
    return {
      root,
      binding,
      directory,
      launcher,
      onLocalProfileOpenTiming,
      onLocalProfileDiagnostic,
      initialize: async () => {
        await launcher.localProfiles.createFiles(
          path.dirname(directory),
          binding,
          new AbortController().signal,
        );
        const { acquireElectronLocalProfile } = await import("./electron-local-profile.js");
        const profile = acquireElectronLocalProfile({
          root,
          directory,
          binding,
          configure: () => {},
          onDiagnostic: onLocalProfileDiagnostic,
        });
        await profile.ready();
      },
      launch: async (preparation = false, signal?: AbortSignal) => {
        const browser = await launcher.launch(
          {
            sessionId,
            partitionKey: `profile:${binding.profileId}`,
            initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
            storage: { kind: "local", binding, directory },
          },
          signal,
        );
        if (!preparation) {
          await browser.profile!.admit(signal);
          await browser.context.createPage();
        }
        return browser;
      },
    };
  }
  it("restores a local-profile page without either blank load", async () => {
    const f = await fixture();
    let browser: Awaited<ReturnType<typeof f.launch>> | undefined;
    try {
      await f.initialize();
      browser = await f.launch(true);
      await browser.profile!.admit();
      const announced = vi.fn(() =>
        expect(electron.views.at(-1)!.webContents.loadURL).not.toHaveBeenCalled(),
      );
      browser.context.onPage(announced);
      await browser.context.createPage({
        restore: {
          entries: [{ url: "https://restore.test/", title: "Saved" }],
          index: 0,
          sessionStorage: null,
        },
      });
      expect(announced).toHaveBeenCalledOnce();
    } finally {
      await browser?.close();
      f.launcher.close();
      await f.launcher.localProfiles.release(f.directory);
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("presents the session user agent per page on a local profile", async () => {
    const f = await fixture();
    let browser: Awaited<ReturnType<typeof f.launch>> | undefined;
    try {
      await f.initialize();
      browser = await f.launch();
      // A fromPath session's user agent never reaches its contents, so the
      // launcher presents it per page over CDP before navigation.
      const overrides = electron.views
        .at(-1)!
        .webContents.debugger.sendCommand.mock.calls.filter(
          ([method]) => method === "Emulation.setUserAgentOverride",
        );
      expect(overrides).toHaveLength(1);
      const parameters = overrides[0]![1] as {
        userAgent: string;
        userAgentMetadata: { brands: unknown; platform: string };
        acceptLanguage: string;
      };
      expect(parameters.userAgent).toContain("Chrome/152.0.0.0");
      expect(parameters.userAgent).not.toContain("Electron/");
      expect(parameters.acceptLanguage).toBe("en-US,en");
      // Contents that never see the session identity use the app fallback,
      // which the launcher reduces for the same reason. The app's own
      // service traffic keeps the branded agent device lists read.
      const { app, session } = await import("electron");
      expect(app.userAgentFallback).toBe(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
      );
      expect(session.defaultSession.setUserAgent).toHaveBeenCalledWith(
        expect.stringContaining("Electron/44.10.2"),
      );
      // Without metadata Chromium empties navigator.userAgentData while the
      // wire carries client hints; the two identities must agree.
      expect(parameters.userAgentMetadata).toEqual(
        expect.objectContaining({
          brands: [
            { brand: "Not?A_Brand", version: "24" },
            { brand: "Chromium", version: "152" },
          ],
          platform: "macOS",
          mobile: false,
        }),
      );
    } finally {
      await browser?.close();
      f.launcher.close();
      await f.launcher.localProfiles.release(f.directory);
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("keeps an admitted page and request gate open after a cookie capture times out", async () => {
    const f = await fixture();
    const { acquireElectronLocalProfile } = await import("./electron-local-profile.js");
    let browser: Awaited<ReturnType<typeof f.launch>> | undefined;
    try {
      await f.initialize();
      browser = await f.launch();
      const owner = acquireElectronLocalProfile({
        root: f.root,
        directory: f.directory,
        binding: f.binding,
        configure: () => {},
      });
      const page = electron.views.at(-1)!;
      vi.useFakeTimers();
      const entered = Promise.withResolvers<void>();
      electron.bootstrap = (method) => {
        if (method !== "Network.getAllCookies") return undefined;
        entered.resolve();
        return new Promise(() => {});
      };
      const failed = expect(owner.mirror.flush()).rejects.toThrow();
      await withTimeout(entered.promise, 1_000, {
        timeoutError: () => new Error("Cookie capture never started."),
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await failed;
      expect(
        page.webContents.close,
        "save failure closed the admitted page",
      ).not.toHaveBeenCalled();
      expect(browser.context.isConnected?.()).toBe(true);
      expect(() => owner.assertAdmitted()).not.toThrow();
      const callback = vi.fn();
      const native = vi.mocked(owner.session);
      vi.mocked(native.webRequest.onBeforeRequest).mock.calls[0]![0]!(
        { url: "https://site.test/" } as never,
        callback,
      );
      expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: false });
      expect(f.onLocalProfileDiagnostic).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ event: "browser.profile.save.failed" }),
      );
      electron.bootstrap = undefined;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() =>
        expect(f.onLocalProfileDiagnostic, "save retry never recovered").toHaveBeenCalledWith({
          event: "browser.profile.save.recovered",
        }),
      );
      expect(page.webContents.close).not.toHaveBeenCalled();
    } finally {
      electron.bootstrap = undefined;
      await browser?.close().catch(() => undefined);
      await f.launcher.localProfiles.release(f.directory);
      vi.useRealTimers();
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("resolves close for a retired owner without trying to save its stopped mirror", async () => {
    const f = await fixture();
    const { acquireElectronLocalProfile } = await import("./electron-local-profile.js");
    try {
      await f.initialize();
      const browser = await f.launch();
      const owner = acquireElectronLocalProfile({
        root: f.root,
        directory: f.directory,
        binding: f.binding,
        configure: () => {},
      });
      await owner.retire();
      expect(f.onLocalProfileDiagnostic).toHaveBeenCalledExactlyOnceWith({
        event: "browser.profile.retired",
        reason: "cancelled",
      });
      const flush = vi.spyOn(owner.mirror, "flush");
      await expect(
        withTimeout(browser.close(), 1_000, {
          timeoutError: () => new Error("Retired browser close never settled."),
        }),
      ).resolves.toBeUndefined();
      expect(flush).not.toHaveBeenCalled();
      expect(browser.context.isConnected?.()).toBe(false);
    } finally {
      await f.launcher.localProfiles.release(f.directory);
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it.each(["rejected", "hung"])(
    "saves after disposal and reports a %s final save",
    async (mode) => {
      const f = await fixture();
      const { acquireElectronLocalProfile } = await import("./electron-local-profile.js");
      try {
        await f.initialize();
        const browser = await f.launch();
        const page = electron.views.at(-1)!;
        const owner = acquireElectronLocalProfile({
          root: f.root,
          directory: f.directory,
          binding: f.binding,
          configure: () => {},
        });
        const entered = Promise.withResolvers<void>();
        let pageClosedFirst = false;
        const flush = vi
          .spyOn(owner.session.cookies, "flushStore")
          .mockImplementationOnce(async () => {
            pageClosedFirst = page.webContents.close.mock.calls.length > 0;
            entered.resolve();
            if (mode === "hung") await new Promise(() => {});
            throw new Error("secret final save failure");
          });
        vi.useFakeTimers();
        const closed = browser.close().catch((error: unknown) => error);
        const settled = vi.fn();
        void closed.then(settled);
        await withTimeout(entered.promise, 1_000, {
          timeoutError: () => new Error("Final save never started."),
        });
        expect(pageClosedFirst, "final save ran before the pages that write cookies closed").toBe(
          true,
        );
        if (mode === "hung") await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(
          () =>
            expect(
              settled,
              "final save failure never settled after disposal",
            ).toHaveBeenCalledOnce(),
          { timeout: 1_000 },
        );
        expect(await closed).toMatchObject({ reason: "browser-profile-persistence-failed" });
        expect(browser.context.isConnected?.()).toBe(false);
        expect(page.webContents.close).toHaveBeenCalled();
        await expect(browser.cdp.send("Target.getTargets")).rejects.toThrow(/closed/);
        expect(() => owner.assertReady()).not.toThrow();
        flush.mockRestore();
      } finally {
        await f.launcher.localProfiles.release(f.directory);
        vi.useRealTimers();
        f.launcher.close();
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );
  it("rejects a helper close timeout without retiring and reconciles a partial import", async () => {
    const f = await fixture();
    const { acquireElectronLocalProfile } = await import("./electron-local-profile.js");
    let browser: Awaited<ReturnType<typeof f.launch>> | undefined;
    try {
      await f.initialize();
      browser = await f.launch();
      const owner = acquireElectronLocalProfile({
        root: f.root,
        directory: f.directory,
        binding: f.binding,
        configure: () => {},
      });
      const capture = vi.spyOn(owner.mirror, "flush");
      const imported = Promise.withResolvers<void>();
      electron.bootstrap = (method) => {
        if (method === "Network.setCookies") imported.resolve();
        return undefined;
      };
      vi.useFakeTimers();
      const pending = browser.replaceSiteCookies(
        "https://example.test",
        [
          {
            name: "sid",
            value: "partial",
            domain: "example.test",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ],
        new AbortController().signal,
      );
      const rejected = expect(pending).rejects.toThrow("Browser cookie target did not close");
      await withTimeout(imported.promise, 1_000, {
        timeoutError: () => new Error("Cookie import was never applied."),
      });
      const helper = electron.views.at(-1)!;
      helper.webContents.close.mockImplementationOnce(() => {});
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
      expect(
        helper.webContents.forcefullyCrashRenderer,
        "cookie helper timeout crashed a shared renderer",
      ).not.toHaveBeenCalled();
      expect(() => owner.assertAdmitted()).not.toThrow();
      const captures = electron.views
        .flatMap((v) => v.webContents.debugger.sendCommand.mock.calls)
        .filter(([method]) => method === "Network.getAllCookies").length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        electron.views
          .flatMap((v) => v.webContents.debugger.sendCommand.mock.calls)
          .filter(([method]) => method === "Network.getAllCookies"),
      ).toHaveLength(captures + 1);
      expect(capture).toHaveBeenCalledOnce();
    } finally {
      electron.bootstrap = undefined;
      await browser?.close().catch(() => undefined);
      await f.launcher.localProfiles.release(f.directory);
      vi.useRealTimers();
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("advertises engine support at startup without opening a browser or checking the keychain", async () => {
    const f = await fixture();
    const { safeStorage } = await import("electron");
    const encrypt = vi.spyOn(safeStorage, "encryptStringAsync");
    const decrypt = vi.spyOn(safeStorage, "decryptStringAsync");
    try {
      await f.launcher.prepare();
      expect(f.launcher.nativeProfilesAvailable).toBe(true);
      expect(encrypt).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();
      expect(await readdir(f.root)).toEqual([]);
    } finally {
      encrypt.mockRestore();
      decrypt.mockRestore();
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it.each(["unavailable", "basic_text"])(
    "keeps Guest browsing available with %s native-profile encryption",
    async (provider) => {
      const f = await fixture();
      const { session } = await import("electron");
      const { VerifiedDesktopSecretCryptography } =
        await import("../secrets/verified-secret-cryptography.js");
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...platform, value: "linux" });
      const available = vi
        .spyOn(VerifiedDesktopSecretCryptography.prototype, "isAsyncEncryptionAvailable")
        .mockResolvedValue(provider !== "unavailable");
      const backend = vi
        .spyOn(VerifiedDesktopSecretCryptography.prototype, "getSelectedStorageBackend")
        .mockReturnValue("basic_text");
      const sessions = vi.mocked(session.fromPath).mock.calls.length;
      try {
        await expect(f.launcher.prepare()).resolves.toBeUndefined();
        expect(f.launcher.nativeProfilesAvailable).toBe(true);
        for (const storage of [{ kind: "guest" }] satisfies BrowserLaunchRequest["storage"][]) {
          const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
          const browser = await f.launcher.launch({
            sessionId,
            partitionKey: `session:${sessionId}`,
            initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
            storage,
          });
          expect(browser.context.pages()).toHaveLength(1);
          await browser.close();
        }
        await expect(f.launch(true)).rejects.toThrow(/encryption is unavailable/u);
        await expect(f.initialize()).rejects.toThrow(/encryption is unavailable/u);
        expect(vi.mocked(session.fromPath).mock.calls).toHaveLength(sessions);
        expect(await readdir(f.root)).toEqual([]);
      } finally {
        available.mockRestore();
        backend.mockRestore();
        Object.defineProperty(process, "platform", platform);
        f.launcher.close();
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );
  it("reopens a prepared host after ordinary capacity eviction without retiring its Session", async () => {
    const f = await fixture();
    const { session } = await import("electron");
    try {
      await f.initialize();
      const profile = vi.mocked(session.fromPath).mock.results.at(-1)!.value;
      const before = vi.mocked(session.fromPath).mock.calls.length;
      const prepared = await f.launch(true);
      expect(prepared.context.pages()).toEqual([]);
      await prepared.close();
      const reopened = await f.launch();
      expect(reopened.context.pages()).toHaveLength(1);
      await reopened.close();
      expect(vi.mocked(session.fromPath).mock.calls).toHaveLength(before);
      expect(profile.clearCache).not.toHaveBeenCalled();
      expect(profile.clearStorageData).not.toHaveBeenCalled();
    } finally {
      await f.launcher.localProfiles.release(f.directory);
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("leaves normal native admission and page creation to the shared runtime", async () => {
    const f = await fixture();
    try {
      await f.initialize();
      const browser = await f.launcher.launch({
        partitionKey: `profile:${f.binding.profileId}`,
        initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
        storage: { kind: "local", binding: f.binding, directory: f.directory },
      });
      expect(browser.context.pages()).toEqual([]);
      await expect(browser.context.createPage()).rejects.toThrow(/admitted/);
      await browser.close();
    } finally {
      await f.launcher.localProfiles.release(f.directory);
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("does not admit a prepared profile when attachment is cancelled during readiness recovery", async () => {
    const f = await fixture();
    const { acquireElectronLocalProfile } = await import("./electron-local-profile.js");
    const held = gate({ label: "prepared profile recovery", deadlineMs: 1000 });
    try {
      await f.initialize();
      const browser = await f.launch(true);
      const owner = acquireElectronLocalProfile({
        root: f.root,
        directory: f.directory,
        binding: f.binding,
        configure: () => {},
      });
      vi.spyOn(owner, "ready").mockImplementationOnce(() => held.enter());
      const opened = vi.spyOn(owner.gate, "open");
      const cancellation = new AbortController();
      const admission = browser.profile!.admit(cancellation.signal);
      const refused = expect(admission).rejects.toThrow();
      await held.entered;
      cancellation.abort();
      held.release();
      await refused;
      expect(opened).not.toHaveBeenCalled();
      expect(browser.context.pages()).toEqual([]);
      await browser.close();
    } finally {
      held.release();
      await f.launcher.localProfiles.release(f.directory);
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("retries a locked mirror key on the same Session without clearing native data", async () => {
    const f = await fixture();
    const { safeStorage, session } = await import("electron");
    const { acquireElectronLocalProfile } = await import("./electron-local-profile.js");
    await f.initialize();
    const owner = acquireElectronLocalProfile({
      root: f.root,
      directory: f.directory,
      binding: f.binding,
      configure: () => {},
    });
    await owner.retire();
    const before = await Promise.all(
      ["session-cookie-key.v1.json", "session-cookies.v1.json"].map((name) =>
        readFile(path.join(path.dirname(f.directory), name)),
      ),
    );
    const decrypt = vi
      .spyOn(safeStorage, "decryptStringAsync")
      .mockRejectedValue(new Error("private-cookie https://private.test locked"));
    try {
      await expect(f.launch()).rejects.toThrow(/Unlock the login keychain.*Retry opening/u);
      await expect(f.launch()).rejects.toThrow(/Unlock the login keychain.*Retry opening/u);
      expect(f.onLocalProfileDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "browser.profile.retired",
          reason: "startup-failed",
          error: expect.objectContaining({ name: "BrowserRuntimeError" }),
        }),
      );
      expect(JSON.stringify(f.onLocalProfileDiagnostic.mock.calls)).not.toMatch(
        /private-cookie|private\.test|locked/u,
      );
      const native = vi.mocked(session.fromPath).mock.results.at(-1)!.value;
      expect(native).toBe(owner.session);
      expect(native.clearCache).not.toHaveBeenCalled();
      expect(native.clearStorageData).not.toHaveBeenCalled();
      expect(
        await Promise.all(
          ["session-cookie-key.v1.json", "session-cookies.v1.json"].map((name) =>
            readFile(path.join(path.dirname(f.directory), name)),
          ),
        ),
      ).toEqual(before);
      decrypt.mockRestore();
      const retried = await f.launch();
      expect(vi.mocked(session.fromPath).mock.results.at(-1)!.value).toBe(native);
      const callback = vi.fn();
      native.webRequest.onBeforeRequest.mock.calls[0]![0]({ url: "https://site.test/" }, callback);
      expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: false });
      await retried.close();
    } finally {
      decrypt.mockRestore();
      await f.launcher.localProfiles.release(f.directory);
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("rejects an out-of-scope sign-in without poisoning a ready profile", async () => {
    const f = await fixture();
    try {
      await f.initialize();
      const browser = await f.launch();
      await expect(
        browser.replaceSiteCookies(
          "https://example.test",
          [
            {
              name: "partitioned",
              value: "value",
              domain: "example.test",
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: "None",
              partitionKey: "https://other.test",
              partitionKeyHasCrossSiteAncestor: true,
            },
          ],
          new AbortController().signal,
        ),
      ).rejects.toThrow("outside the requested site");
      const helpersBefore = electron.views.length;
      await browser.replaceSiteCookies("https://example.test", [], new AbortController().signal);
      for (const helper of electron.views.slice(helpersBefore)) {
        expect(helper.webContents.loadURL).not.toHaveBeenCalled();
        expect(helper.webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
          "Fetch.enable",
          expect.anything(),
        );
      }
      const reopened = await f.launch();
      await reopened.close();
      await browser.close();
    } finally {
      await f.launcher.localProfiles.release(f.directory);
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("announces a native page and registers its ledger without awaiting the initial renderer load", async () => {
    const f = await fixture();
    const loaded = Promise.withResolvers<void>();
    try {
      await f.initialize();
      const browser = await f.launch(true);
      await browser.profile!.admit();
      electron.blankLoad = () => loaded.promise;
      const creating = browser.context.createPage();
      const announced = vi.fn();
      void creating.then(announced, () => undefined);
      await vi.waitFor(() => expect(announced).toHaveBeenCalled(), { timeout: 1000 });
      const page = await creating;
      const view = electron.views.at(-1)!;
      expect(view.webContents.loadURL).toHaveBeenCalledExactlyOnceWith("about:blank");
      expect(view.webContents.loadURL.mock.invocationCallOrder[0]).toBeLessThan(
        electron.hosts.at(-1)!.setIgnoreMouseEvents.mock.invocationCallOrder[0]!,
      );
      view.webContents.getURL.mockReturnValue("");
      expect(page.url()).toBe("about:blank");
      const ledger = new SurfaceLedger(browser.context, { rootPages: [page] });
      await ledger.start();
      expect(ledger.snapshot()).toHaveLength(1);
      await ledger.navigate(ledger.snapshot()[0]!.id, "https://site.test/");
      expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith("Page.navigate", {
        url: "https://site.test/",
      });
      loaded.reject(new Error("ERR_ABORTED: superseded by real navigation"));
      await ledger.close();
      await browser.close();
    } finally {
      loaded.resolve();
      electron.blankLoad = undefined;
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
  it("prepares page-free, cancels worker requests through recovery, and admits only once", async () => {
    const f = await fixture();
    const { app, session } = await import("electron");
    const { acquireElectronLocalProfile } = await import("./electron-local-profile.js");
    try {
      await f.initialize();
      const start = electron.views.length;
      let browser = await f.launch(true);
      const disconnected = vi.fn();
      browser.onClose(disconnected);
      expect(browser.profile).toBeDefined();
      expect(browser.context.pages()).toEqual([]);
      expect(electron.views).toHaveLength(start);
      const profile = vi.mocked(session.fromPath).mock.results.at(-1)!.value;
      const before = profile.webRequest.onBeforeRequest.mock.calls[0]![0];
      const worker = vi.fn();
      before({ url: "https://site.test/" }, worker);
      expect(worker).toHaveBeenCalledExactlyOnceWith({ cancel: true });
      for (const [event, listener] of vi.mocked(app.on).mock.calls)
        if ((event as string) === "child-process-gone")
          (listener as (event: unknown, details: unknown) => void)(
            {},
            { type: "Utility", serviceName: "network.mojom.NetworkService" },
          );
      await expect(browser.profile!.ready()).rejects.toThrow();
      expect(disconnected).toHaveBeenCalledOnce();
      expect(f.onLocalProfileDiagnostic).toHaveBeenCalledExactlyOnceWith({
        event: "browser.profile.retired",
        reason: "network-service-lost",
      });
      browser = await f.launch(true);
      const recovered = vi.fn();
      before({ url: "https://site.test/" }, recovered);
      expect(recovered).toHaveBeenCalledExactlyOnceWith({ cancel: true });
      await expect(browser.context.createPage()).rejects.toThrow(/admitted/u);
      const owner = acquireElectronLocalProfile({
        root: f.root,
        directory: f.directory,
        binding: f.binding,
        configure: () => {},
      });
      const open = vi.spyOn(owner.gate, "open");
      await Promise.all([browser.profile!.admit(), browser.profile!.admit()]);
      expect(open).toHaveBeenCalledOnce();
      const admitted = vi.fn();
      before({ url: "https://site.test/" }, admitted);
      expect(admitted).toHaveBeenCalledExactlyOnceWith({ cancel: false });
      expect(worker).toHaveBeenCalledOnce();
      expect(recovered).toHaveBeenCalledOnce();
      await browser.context.createPage();
      expect(browser.context.pages()).toHaveLength(1);
      await browser.close();
      const idle = vi.fn();
      before({ url: "https://site.test/" }, idle);
      expect(idle).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    } finally {
      await f.launcher.localProfiles.release(f.directory);
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("unwraps the mirror key during preparation, waits before ready and fences cancellation", async () => {
    const f = await fixture();
    const { safeStorage, session } = await import("electron");
    await f.initialize();
    // Simulate the next process's uncached key without changing the approved provider.
    const { ElectronLocalProfile } = await import("./electron-local-profile.js");
    const owner = new ElectronLocalProfile(f.directory, f.binding, () => {});
    const held = Promise.withResolvers<{ result: string; shouldReEncrypt: boolean }>();
    const decrypt = vi
      .spyOn(safeStorage, "decryptStringAsync")
      .mockImplementationOnce(() => held.promise);
    const read = vi.spyOn(safeStorage, "decryptStringAsync");
    try {
      owner.start();
      const ready = owner.ready();
      const settled = vi.fn();
      void ready.then(settled, settled);
      await vi.waitFor(() => expect(read).toHaveBeenCalled(), { timeout: 1000 });
      expect(settled).not.toHaveBeenCalled();
      const retiring = owner.retire();
      held.reject(new Error("cancelled unwrap"));
      await expect(ready).rejects.toThrow();
      await retiring;
      await expect(owner.admit()).rejects.toThrow();
      const native = vi.mocked(session.fromPath).mock.results.at(-1)!.value;
      expect(native.clearCache).not.toHaveBeenCalled();
      expect(native.clearStorageData).not.toHaveBeenCalled();
    } finally {
      decrypt.mockRestore();
      await f.launcher.localProfiles.release(f.directory);
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("cancels a hung cookie read and retries the same Electron Session without releasing the read", async () => {
    const f = await fixture();
    const { session } = await import("electron");
    const { acquireElectronLocalProfile } = await import("./electron-local-profile.js");
    await f.initialize();
    const previous = acquireElectronLocalProfile({
      root: f.root,
      directory: f.directory,
      binding: f.binding,
      configure: () => {},
    });
    await previous.retire();
    const entered = Promise.withResolvers<void>();
    const never = new Promise<unknown>(() => {});
    const cancellation = new AbortController();
    electron.bootstrap = (method) => {
      if (method !== "Network.getAllCookies") return undefined;
      entered.resolve();
      return never;
    };
    const launching = f.launch(true, cancellation.signal);
    const refused = expect(launching).rejects.toThrow();
    try {
      await withTimeout(entered.promise, 1_000, {
        timeoutError: () => new Error("Cookie read was never issued."),
      });
      cancellation.abort();
      await withTimeout(refused, 1_000, {
        timeoutError: () => new Error("Cancelled launch still waits for its cookie read."),
      });
      electron.bootstrap = undefined;
      const retried = await f.launch();
      const native = vi.mocked(session.fromPath).mock.results.at(-1)!.value;
      expect(native).toBe(previous.session);
      const answer = vi.fn();
      native.webRequest.onBeforeRequest.mock.calls[0]![0]({ url: "https://site.test/" }, answer);
      expect(answer).toHaveBeenCalledExactlyOnceWith({ cancel: false });
      expect(native.clearStorageData).not.toHaveBeenCalled();
      await retried.close();
    } finally {
      electron.bootstrap = undefined;
      cancellation.abort();
      await f.launcher.localProfiles.release(f.directory);
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it.each(["during-restore", "prepared"])(
    "retries a cancelled launch (%s) without erasing storage",
    async (phase) => {
      const f = await fixture();
      const { session } = await import("electron");
      const cancellation = new AbortController();
      const held = Promise.withResolvers<unknown>();
      const capturing = vi.fn();
      try {
        await f.initialize();
        if (phase === "during-restore") {
          const { acquireElectronLocalProfile } = await import("./electron-local-profile.js");
          const owner = acquireElectronLocalProfile({
            root: f.root,
            directory: f.directory,
            binding: f.binding,
            configure: () => {},
          });
          electron.bootstrap = (method) => {
            if (method !== "Network.getAllCookies") return undefined;
            capturing();
            return held.promise;
          };
          await owner.retire();
        }
        const launching = f.launch(true, cancellation.signal);
        const observed = launching.catch(() => undefined);
        if (phase === "prepared") {
          const browser = await launching;
          cancellation.abort();
          await expect(browser.profile!.admit()).rejects.toThrow();
          await browser.close();
        } else {
          await vi.waitFor(() => expect(capturing).toHaveBeenCalled(), { timeout: 1000 });
          const target = electron.views.at(-1)!;
          expect(target.webContents.close).not.toHaveBeenCalled();
          cancellation.abort();
          expect(target.webContents.close).toHaveBeenCalled();
          held.resolve({ cookies: [] });
          await expect(launching).rejects.toThrow();
        }
        await observed;
        const retried = await f.launch();
        await retried.close();
        const native = vi.mocked(session.fromPath).mock.results.at(-1)!.value;
        expect(native.clearCache).not.toHaveBeenCalled();
        expect(native.clearStorageData).not.toHaveBeenCalled();
        expect(await f.launcher.localProfiles.release(f.directory)).toBe("retained-until-exit");
      } finally {
        held.resolve({ cookies: [] });
        electron.bootstrap = undefined;
        f.launcher.close();
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );
  it("retains the same Session when native policy setup fails", async () => {
    const f = await fixture(true);
    const { electronProfileRootReleaseState } = await import("./electron-local-profile.js");
    try {
      await f.initialize();
      await expect(f.launch()).rejects.toThrow("policy failed");
      f.launcher.close();
      expect(electronProfileRootReleaseState(f.root)).toBe("retained-until-exit");
      expect(electronProfileRootReleaseState(f.root + "-other")).toBe("released");
      expect(await f.launcher.localProfiles.release(f.directory)).toBe("retained-until-exit");
      await expect(f.launch()).rejects.toThrow();
    } finally {
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("releases idle cookie renderers and recreates them for cookie changes and Network Service recovery", async () => {
    const f = await fixture();
    const { app, session } = await import("electron");
    const { acquireElectronLocalProfile } = await import("./electron-local-profile.js");
    try {
      const start = electron.views.length;
      await f.initialize();
      const first = electron.views
        .slice(start)
        .filter((view) =>
          view.webContents.debugger.sendCommand.mock.calls.some(
            ([method]) => method === "Network.getAllCookies",
          ),
        )
        .at(-1)!;
      expect(first.webContents.close).toHaveBeenCalled();
      expect(first.webContents.loadURL).not.toHaveBeenCalled();
      const browser = await f.launch();
      const page = browser.context.pages()[0]!;
      const view = electron.views.at(-1)!;
      // Snapshot-only bookkeeping must not add a navigation subscription here.
      expect(
        view.webContents.on.mock.calls.filter(([name]) => name === "did-frame-navigate"),
      ).toHaveLength(0);
      await page.close();
      await browser.close();
      const owner = acquireElectronLocalProfile({
        root: f.root,
        directory: f.directory,
        binding: f.binding,
        configure: () => {},
      });
      await owner.mirror.flush();
      const captured = electron.views.at(-1)!;
      await vi.waitFor(() => expect(captured.webContents.close).toHaveBeenCalled(), {
        timeout: 1000,
      });
      const profile = vi.mocked(session.fromPath).mock.results.at(-1)!.value;
      const beforeRecovery = electron.views.length;
      for (const [event, listener] of vi.mocked(app.on).mock.calls)
        if ((event as string) === "child-process-gone")
          (listener as (event: unknown, details: unknown) => void)(
            {},
            { type: "Utility", serviceName: "network.mojom.NetworkService" },
          );
      await expect(owner.ready()).rejects.toThrow();
      const retried = await f.launch();
      await retried.close();
      expect(electron.views.length).toBeGreaterThan(beforeRecovery);
      expect(electron.views.at(-1)!.webContents.close).toHaveBeenCalled();
      expect(profile.clearStorageData).not.toHaveBeenCalled();
    } finally {
      await f.launcher.localProfiles.release(f.directory);
      f.launcher.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("retains the exact persistent Session through close and deletion reports pending restart", async () => {
    const f = await fixture();
    const { session } = await import("electron");
    try {
      expect(await f.launcher.localProfiles.release(f.directory)).toBe("released");
      await f.initialize();
      const profile = vi.mocked(session.fromPath).mock.results.at(-1)!.value;
      const browser = await f.launch();
      await browser.close();
      expect(f.onLocalProfileOpenTiming.mock.calls.map(([timing]) => timing.stage)).toEqual([
        "session-created",
        "mirror-restored",
        "admitted",
        "page-create-started",
        "web-contents-view-created",
        "blank-navigation-submitted",
        "resting-host-created",
        "page-policy-dispatched",
        "page-policy-ready",
        "blank-loaded",
        "renderer-ready",
        "page-announced",
        "first-page-created",
      ]);
      const durations = f.onLocalProfileOpenTiming.mock.calls.map(([timing]) => timing.elapsedMs);
      expect(durations).toEqual([...durations].sort((a, b) => a - b));
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

describe("native Electron profiles through the shared runtime", () => {
  it("reopens a profile whose owner retired after Network Service loss, without clearing it", async () => {
    const { app, session } = await import("electron");
    const { BrowserRuntime, sessionFilesRoot } = await import("@opensteer/browser-runtime-core");
    const { FakeSink, FakeTicketVerifier, validClaims } =
      await import("@opensteer/browser-runtime-core/test-support");
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "opensteer-native-runtime-")));
    const launcher = new ElectronBrowserLauncher({
      downloads: { accept: vi.fn() },
      pagePolicyPreloadPath: "/policy.cjs",
      localProfileRoot: root,
    });
    const verifier = new FakeTicketVerifier();
    const runtime = new BrowserRuntime({
      launcher,
      ticketVerifier: verifier,
      localProfiles: { root },
      runtimeId: "runtime_test",
      sessionFilesRoot: sessionFilesRoot(root),
    });
    try {
      await runtime.prepare();
      const binding: LocalProfileBinding = {
        version: 1,
        deploymentId: createId("deployment"),
        profileId: createId("browserProfile"),
        runnerId: createId("runner"),
        storageInstanceId: runtime.localProfileStorage!.storageInstanceId,
        bindingId: randomUUID(),
        engine: "electron",
      };
      let initialized = false;
      const open = async (token: string) => {
        verifier.setClaims(
          token,
          validClaims({
            identity: {
              kind: "profile-local",
              binding,
              initialized,
              readyUrl: "https://host.test/ready",
            },
            sessionId: BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`),
          }),
        );
        const attached = await runtime.attach(token, new FakeSink());
        initialized = true;
        return attached;
      };
      const views = electron.views.length;
      await open("first");
      const native = vi.mocked(session.fromPath).mock.results.at(-1)!.value;
      const pages = electron.views.slice(views);
      for (const [event, listener] of vi.mocked(app.on).mock.calls)
        if ((event as string) === "child-process-gone")
          (listener as (event: unknown, details: unknown) => void)(
            {},
            { type: "Utility", serviceName: "network.mojom.NetworkService" },
          );
      await vi.waitFor(
        () =>
          expect(
            pages.every((view) => view.webContents.close.mock.calls.length > 0),
            "Network Service loss never closed the retired owner's views",
          ).toBe(true),
        { timeout: 2_000 },
      );
      const reopened = await open("second");
      await reopened.close();
      expect(vi.mocked(session.fromPath).mock.results.at(-1)!.value).toBe(native);
      expect(native.clearStorageData).not.toHaveBeenCalled();
      expect(native.clearCache).not.toHaveBeenCalled();
    } finally {
      await runtime.shutdown().catch(() => undefined);
      launcher.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("routes root and attached cookie commands to the admitted native profile context", async () => {
  electron.bootstrap = (method) =>
    method === "Target.getTargetInfo"
      ? Promise.resolve({
          targetInfo: { targetId: "target-1", browserContextId: "native-profile-context" },
        })
      : undefined;
  const browser = await new ElectronBrowserLauncher({
    downloads: { accept: () => undefined },
    pagePolicyPreloadPath: "/opensteer/browser-page-preload.cjs",
  }).launch({
    initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    partitionKey: "session:bsn_00000000-0000-4000-8000-000000000306",
    sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000306"),
    storage: { kind: "guest" },
  });
  const { SessionCdpRouter } = await import("@opensteer/browser-core");
  const router = new SessionCdpRouter(browser.cdp);
  const targetId = await browser.context.pages()[0]!.targetId();
  router.registerSession("agent", targetId, async () => true, "/files");
  try {
    const { sessionId } = (await router.send("agent", {
      method: "Target.attachToTarget",
      parameters: { targetId },
    })) as { sessionId: string };
    await router.send("agent", { method: "Storage.getCookies", sessionId });
    await router.send("agent", { method: "Storage.getCookies" });
    const native = electron.views.at(-1)!.webContents.debugger.sendCommand;
    expect(native.mock.calls.filter(([method]) => method === "Storage.getCookies")).toEqual([
      ["Storage.getCookies", { browserContextId: "native-profile-context" }],
      ["Storage.getCookies", { browserContextId: "native-profile-context" }],
    ]);
    await expect(
      router.send("agent", {
        method: "Storage.setCookies",
        parameters: { browserContextId: "foreign-context", cookies: [] },
        sessionId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  } finally {
    await router.close();
    await browser.close();
  }
});

it("answers a connection's browser_connect the one sentence for a command outside the list, before the Mac's own check", async () => {
  const sentence = (method: string) =>
    `${method} is not available to a connected agent. Its CDP acts on its own pages through the Accessibility, Console, CSS, Debugger, DOM, DOMSnapshot, Emulation, Fetch, Input, Log, Network, Page, Performance, Runtime, Target domains, and at the browser root only through Target and Browser.getVersion.`;
  const browser = await new ElectronBrowserLauncher({
    downloads: { accept: () => undefined },
    pagePolicyPreloadPath: "/opensteer/browser-page-preload.cjs",
  }).launch({
    initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    partitionKey: "session:bsn_00000000-0000-4000-8000-000000000307",
    sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000307"),
    storage: { kind: "guest" },
  });
  const { SessionCdpRouter } = await import("@opensteer/browser-core");
  const router = new SessionCdpRouter(browser.cdp);
  const targetId = await browser.context.pages()[0]!.targetId();
  router.registerSession("agent", targetId, async () => true, "/files");
  try {
    const refusal = async (connection: boolean, method: string, parameters = {}) => {
      const client = router.openStandardClient("agent", {
        wholeContext: false,
        ...(connection
          ? { connection: true, lineage: { attachmentId: "mac-agent", seedTargetId: targetId } }
          : {}),
      });
      try {
        return await client.send({ method, parameters }).then(
          () => "sent",
          (error: unknown) => (error as Error).message,
        );
      } finally {
        client.close();
      }
    };
    for (const method of [
      "SystemInfo.getProcessInfo",
      "SystemInfo.getInfo",
      "Browser.getBrowserCommandLine",
    ]) {
      expect(await refusal(true, method), method).toBe(sentence(method));
      expect(await refusal(false, method), method).toBe(
        `${method} describes the Opensteer process, outside browser page ownership.`,
      );
    }
    // A listed command still meets the Mac's own check.
    expect(await refusal(true, "Target.createTarget", { url: "about:blank", windowId: 1 })).toBe(
      "Opensteer windows are outside the browser page context.",
    );
  } finally {
    await router.close();
    await browser.close();
  }
});

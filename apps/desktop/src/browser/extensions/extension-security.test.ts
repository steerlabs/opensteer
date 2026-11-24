import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcListeners = new Map<string, (...args: unknown[]) => unknown>();

class FakeBaseWindow extends EventEmitter {
  static nextId = 100;
  static all: FakeBaseWindow[] = [];
  readonly id = FakeBaseWindow.nextId++;
  #destroyed = false;
  #focused = true;
  constructor() {
    super();
    FakeBaseWindow.all.push(this);
  }
  static getAllWindows() {
    return FakeBaseWindow.all;
  }
  isDestroyed() {
    return this.#destroyed;
  }
  isFocused() {
    return this.#focused;
  }
  isFullScreen() {
    return false;
  }
  isMaximized() {
    return false;
  }
  isMinimized() {
    return false;
  }
  isAlwaysOnTop() {
    return false;
  }
  getPosition() {
    return [0, 0];
  }
  getSize() {
    return [1280, 800];
  }
  getBounds() {
    return { x: 0, y: 0, width: 1280, height: 800 };
  }
  getContentBounds() {
    return { x: 0, y: 0, width: 1280, height: 800 };
  }
  maximize() {}
  minimize() {}
  restore() {}
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.emit("closed");
  }
}

vi.mock("electron", () => ({
  app: {
    getName: () => "Opensteer",
    getGPUInfo: async () => ({}),
    getGPUFeatureStatus: () => ({ webgl: "enabled" }),
  },
  BaseWindow: FakeBaseWindow,
  BrowserWindow: FakeBaseWindow,
  Menu: class {
    append() {}
    popup() {}
  },
  MenuItem: class {},
  Notification: Object.assign(
    class extends EventEmitter {
      show() {}
      close() {
        this.emit("close");
      }
    },
    { isSupported: () => true },
  ),
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => ipcHandlers.set(channel, fn),
    on: (channel: string, fn: (...args: unknown[]) => unknown) => ipcListeners.set(channel, fn),
  },
  nativeImage: {
    createEmpty: () => ({ isEmpty: () => true, resize: () => ({ isEmpty: () => true }) }),
    createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({ isEmpty: () => true }) }),
    createFromPath: () => ({ isEmpty: () => true, resize: () => ({ isEmpty: () => true }) }),
    createFromDataURL: () => ({ isEmpty: () => true, resize: () => ({ isEmpty: () => true }) }),
  },
  webFrameMain: { fromId: () => null },
}));

const { ExtensionRouter } = await import("./extension-router.js");
const { ChromeExtensionApis } = await import("./chrome-apis.js");
const { WebStoreController, CHROME_WEB_STORE_ORIGIN } = await import("./web-store.js");

const extMinimalId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const extPrivilegedId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function createFakeSession() {
  const extensionsMap = new Map<string, Electron.Extension>();
  const extEmitter = new EventEmitter();
  const cookiesEmitter = new EventEmitter();
  const swEmitter = new EventEmitter();
  const cookiesStore = [
    {
      name: "sid",
      value: "secret-bank",
      domain: "bank.test",
      path: "/",
      secure: true,
      httpOnly: true,
    },
    {
      name: "pref",
      value: "dark",
      domain: "example.com",
      path: "/",
      secure: true,
      httpOnly: false,
    },
  ];

  const session = {
    isPersistent: () => true,
    getPreloadScripts: () => [],
    registerPreloadScript: vi.fn(),
    unregisterPreloadScript: vi.fn(),
    extensions: Object.assign(extEmitter, {
      getExtension: (id: string) => extensionsMap.get(id) ?? null,
      getAllExtensions: () => [...extensionsMap.values()],
      removeExtension: (id: string) => {
        const ext = extensionsMap.get(id);
        if (ext) {
          extensionsMap.delete(id);
          extEmitter.emit("extension-unloaded", {}, ext);
        }
      },
      _add: (ext: Electron.Extension) => {
        extensionsMap.set(ext.id, ext);
        extEmitter.emit("extension-loaded", {}, ext);
      },
    }),
    cookies: Object.assign(cookiesEmitter, {
      get: vi.fn(async (filter: { url?: string }) => {
        if (!filter.url) return cookiesStore;
        const host = new URL(filter.url).hostname;
        return cookiesStore.filter((c) => c.domain === host);
      }),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }),
    serviceWorkers: Object.assign(swEmitter, {
      getWorkerFromVersionID: () => null,
      startWorkerForScope: vi.fn(async () => ({ send: vi.fn() })),
    }),
  };
  return { session: session as unknown as Electron.Session, raw: session };
}

function createFakeWebContents(id: number, url: string, title: string, session: Electron.Session) {
  const frameSend = vi.fn();
  const mainFrame = {
    url,
    origin: new URL(url).origin,
    framesInSubtree: [],
    isDestroyed: () => false,
    send: frameSend,
  };
  const wc = Object.assign(new EventEmitter(), {
    id,
    session,
    audioMuted: false,
    mainFrame,
    isDestroyed: () => false,
    isLoading: () => false,
    isCurrentlyAudible: () => false,
    getURL: () => url,
    getTitle: () => title,
    send: frameSend,
    insertCSS: vi.fn(async () => ""),
    loadURL: vi.fn(async () => undefined),
    setAudioMuted: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    navigationHistory: { goBack: vi.fn(), goForward: vi.fn() },
  });
  return wc as unknown as Electron.WebContents & {
    send: ReturnType<typeof vi.fn>;
    mainFrame: typeof mainFrame;
  };
}

function frameEvent(origin: string, wc: Electron.WebContents) {
  const frame = (
    wc as unknown as {
      mainFrame: { origin: string; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
    }
  ).mainFrame;
  frame.origin = origin;
  return {
    type: "frame",
    sender: wc,
    senderFrame: frame,
  } as unknown as Electron.IpcMainInvokeEvent;
}

describe("ExtensionRouter and ChromeExtensionApis security boundaries", () => {
  beforeEach(() => {
    FakeBaseWindow.all = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("derives extension identity from senderFrame.origin and rejects web origins", async () => {
    const { session, raw } = createFakeSession();
    raw.extensions._add({
      id: extMinimalId,
      name: "Minimal",
      version: "1.0.0",
      path: "/tmp/minimal",
      url: `chrome-extension://${extMinimalId}/`,
      manifest: { manifest_version: 3, name: "Minimal", version: "1.0.0", permissions: [] },
    } as Electron.Extension);

    const router = new ExtensionRouter(session);
    const sharedWindow = new FakeBaseWindow() as unknown as Electron.BaseWindow;
    const apis = new ChromeExtensionApis({
      session,
      router,
      sharedWindow,
      openTab: () => createFakeWebContents(99, "https://example.com/", "New", session),
      createExtensionWindow: () => new FakeBaseWindow() as unknown as Electron.BaseWindow,
      closeExtensionWindow: () => false,
      onActionChanged: () => undefined,
      isClosed: () => false,
      canAccessCookies: () => true,
    });

    const webPage = createFakeWebContents(10, "https://evil.test/", "Evil", session);
    await expect(
      router.dispatchCall(frameEvent("https://evil.test", webPage), "tabs.query", [{}]),
    ).rejects.toThrow(/Unauthorized/u);

    const extPage = createFakeWebContents(
      11,
      `chrome-extension://${extMinimalId}/popup.html`,
      "Popup",
      session,
    );
    const tabs = await router.dispatchCall(
      frameEvent(`chrome-extension://${extMinimalId}`, extPage),
      "tabs.query",
      [{}],
    );
    expect(Array.isArray(tabs)).toBe(true);

    apis.dispose();
    router.dispose();
  });

  it("enforces cookie permissions, host permissions, tab redaction, and blocks permissions.request escalation", async () => {
    const { session, raw } = createFakeSession();
    raw.extensions._add({
      id: extMinimalId,
      name: "No Perms",
      version: "1.0.0",
      path: "/tmp/minimal",
      url: `chrome-extension://${extMinimalId}/`,
      manifest: {
        manifest_version: 3,
        name: "No Perms",
        version: "1.0.0",
        permissions: ["storage"],
        optional_permissions: ["cookies"],
        optional_host_permissions: ["https://example.com/*"],
      },
    } as Electron.Extension);
    raw.extensions._add({
      id: extPrivilegedId,
      name: "Example Only",
      version: "1.0.0",
      path: "/tmp/priv",
      url: `chrome-extension://${extPrivilegedId}/`,
      manifest: {
        manifest_version: 3,
        name: "Example Only",
        version: "1.0.0",
        permissions: ["cookies"],
        host_permissions: ["https://example.com/*"],
      },
    } as Electron.Extension);

    const router = new ExtensionRouter(session);
    const sharedWindow = new FakeBaseWindow() as unknown as Electron.BaseWindow;
    const apis = new ChromeExtensionApis({
      session,
      router,
      sharedWindow,
      openTab: () => createFakeWebContents(99, "https://example.com/", "New", session),
      createExtensionWindow: () => new FakeBaseWindow() as unknown as Electron.BaseWindow,
      closeExtensionWindow: () => false,
      onActionChanged: () => undefined,
      isClosed: () => false,
      canAccessCookies: () => true,
    });

    const bankTab = createFakeWebContents(21, "https://bank.test/dashboard", "My Bank", session);
    const exampleTab = createFakeWebContents(
      22,
      "https://example.com/home",
      "Example Home",
      session,
    );
    apis.addTab(
      {
        contents: bankTab,
        open: () => bankTab,
        close: () => undefined,
        presentedWindow: () => sharedWindow,
      },
      sharedWindow,
    );
    apis.addTab(
      {
        contents: exampleTab,
        open: () => exampleTab,
        close: () => undefined,
        presentedWindow: () => sharedWindow,
      },
      sharedWindow,
    );

    const minFrame = frameEvent(
      `chrome-extension://${extMinimalId}`,
      createFakeWebContents(30, `chrome-extension://${extMinimalId}/p.html`, "P", session),
    );
    const privFrame = frameEvent(
      `chrome-extension://${extPrivilegedId}`,
      createFakeWebContents(31, `chrome-extension://${extPrivilegedId}/p.html`, "P", session),
    );

    // 1. Minimal extension cannot access cookies or webNavigation or notifications.
    await expect(router.dispatchCall(minFrame, "cookies.getAll", [{}])).rejects.toThrow(
      /"cookies" permission/u,
    );
    await expect(
      router.dispatchCall(minFrame, "webNavigation.getAllFrames", [{ tabId: 21 }]),
    ).rejects.toThrow(/"webNavigation" permission/u);
    await expect(
      router.dispatchCall(minFrame, "notifications.create", [{ title: "Hi", message: "Spam" }]),
    ).rejects.toThrow(/"notifications" permission/u);

    // 2. Extension with cookies + example.com host permission only sees example.com cookies, NEVER bank.test.
    const cookies = (await router.dispatchCall(privFrame, "cookies.getAll", [{}])) as {
      domain: string;
    }[];
    expect(cookies.map((c) => c.domain)).toEqual(["example.com"]);
    await expect(
      router.dispatchCall(privFrame, "cookies.get", [{ url: "https://bank.test/", name: "sid" }]),
    ).rejects.toThrow(/host permission/u);

    // 3. cookies.onChanged only reaches extensions authorized for that cookie's domain.
    const minListenerWc = createFakeWebContents(
      40,
      `chrome-extension://${extMinimalId}/bg.html`,
      "bg",
      session,
    );
    const privListenerWc = createFakeWebContents(
      41,
      `chrome-extension://${extPrivilegedId}/bg.html`,
      "bg",
      session,
    );
    router.registerListener(
      frameEvent(
        `chrome-extension://${extMinimalId}`,
        minListenerWc,
      ) as unknown as Electron.IpcMainEvent,
      "cookies.onChanged",
    );
    router.registerListener(
      frameEvent(
        `chrome-extension://${extPrivilegedId}`,
        privListenerWc,
      ) as unknown as Electron.IpcMainEvent,
      "cookies.onChanged",
    );

    raw.cookies.emit(
      "changed",
      {},
      { name: "sid", value: "top-secret", domain: "bank.test", path: "/", secure: true },
      "explicit",
      false,
    );
    expect(minListenerWc.send).not.toHaveBeenCalled();
    expect(privListenerWc.send).not.toHaveBeenCalled();

    raw.cookies.emit(
      "changed",
      {},
      { name: "pref", value: "dark", domain: "example.com", path: "/", secure: true },
      "explicit",
      false,
    );
    expect(minListenerWc.send).not.toHaveBeenCalled();
    expect(privListenerWc.send).toHaveBeenCalledTimes(1);

    // 4. Tab URL/title are stripped without `tabs` or host permission, and URL oracle query returns empty.
    const minTabs = (await router.dispatchCall(minFrame, "tabs.query", [{}])) as Record<
      string,
      unknown
    >[];
    expect(minTabs).toHaveLength(2);
    expect(minTabs[0]!.url).toBeUndefined();
    expect(minTabs[0]!.title).toBeUndefined();
    const oracleQuery = (await router.dispatchCall(minFrame, "tabs.query", [
      { url: "*://bank.test/*" },
    ])) as unknown[];
    expect(oracleQuery).toEqual([]);

    // 5. permissions.request never silently escalates and rejects undeclared origins.
    await expect(
      router.dispatchCall(minFrame, "permissions.request", [{ origins: ["<all_urls>"] }]),
    ).rejects.toThrow(/undeclared origin/u);
    const granted = await router.dispatchCall(minFrame, "permissions.request", [
      { permissions: ["cookies"], origins: ["https://example.com/*"] },
    ]);
    expect(granted).toBe(false);

    apis.dispose();
    router.dispose();
  });

  it("populates tabs on windows.create and emits windows.onRemoved exactly once", async () => {
    const { session, raw } = createFakeSession();
    raw.extensions._add({
      id: extPrivilegedId,
      name: "Win Ext",
      version: "1.0.0",
      path: "/tmp/win",
      url: `chrome-extension://${extPrivilegedId}/`,
      manifest: { manifest_version: 3, name: "Win Ext", version: "1.0.0", permissions: ["tabs"] },
    } as Electron.Extension);

    const router = new ExtensionRouter(session);
    const sharedWindow = new FakeBaseWindow() as unknown as Electron.BaseWindow;
    const extWins = new Set<FakeBaseWindow>();
    const apis = new ChromeExtensionApis({
      session,
      router,
      sharedWindow,
      openTab: (url, _active, targetWindow) => {
        const wc = createFakeWebContents(
          Math.floor(Math.random() * 1000) + 50,
          url,
          "Tab",
          session,
        );
        apis.addTab(
          {
            contents: wc,
            open: () => wc,
            close: () => undefined,
            presentedWindow: () => targetWindow ?? sharedWindow,
          },
          targetWindow ?? sharedWindow,
        );
        return wc;
      },
      createExtensionWindow: (urls) => {
        const created = new FakeBaseWindow();
        extWins.add(created);
        apis.addWindow(created as unknown as Electron.BaseWindow);
        for (const url of urls) {
          const wc = createFakeWebContents(
            Math.floor(Math.random() * 1000) + 50,
            url,
            "WinTab",
            session,
          );
          apis.addTab(
            {
              contents: wc,
              open: () => wc,
              close: () => undefined,
              presentedWindow: () => created as unknown as Electron.BaseWindow,
            },
            created as unknown as Electron.BaseWindow,
          );
        }
        return created as unknown as Electron.BaseWindow;
      },
      closeExtensionWindow: (win) => {
        if (win === sharedWindow) return false;
        win.destroy();
        return true;
      },
      onActionChanged: () => undefined,
      isClosed: () => false,
      canAccessCookies: () => true,
    });

    const listenerWc = createFakeWebContents(
      42,
      `chrome-extension://${extPrivilegedId}/bg.html`,
      "bg",
      session,
    );
    router.registerListener(
      frameEvent(
        `chrome-extension://${extPrivilegedId}`,
        listenerWc,
      ) as unknown as Electron.IpcMainEvent,
      "windows.onRemoved",
    );

    const created = (await router.dispatchCall(
      frameEvent(`chrome-extension://${extPrivilegedId}`, listenerWc),
      "windows.create",
      [{ url: "https://example.com/pop" }],
    )) as { id: number; tabs: { url: string }[] };
    expect(created.tabs).toHaveLength(1);
    expect(created.tabs[0]!.url).toBe("https://example.com/pop");

    await router.dispatchCall(
      frameEvent(`chrome-extension://${extPrivilegedId}`, listenerWc),
      "windows.remove",
      [created.id],
    );
    const removedCalls = listenerWc.send.mock.calls.filter(
      (call: unknown[]) => call[0] === "opensteer-crx:event:windows.onRemoved",
    );
    expect(removedCalls).toHaveLength(1);

    apis.dispose();
    router.dispose();
  });

  it("isolates Chrome Web Store IPC to its extension-free Session and blocks lookalikes, subframes, and page uninstall", async () => {
    const { session: profileSession } = createFakeSession();
    const { session: storeSession } = createFakeSession();
    const dir = await mkdtemp(path.join(os.tmpdir(), "opensteer-cws-test-"));
    const controller = new WebStoreController({
      profileSession,
      storeSession,
      preloadPath: path.join(dir, "preload.cjs"),
      confirmInstall: vi.fn(async () => true),
      commitStagedInstall: vi.fn(),
    });
    try {
      const begin = ipcHandlers.get("opensteer-cws:beginInstall")!;
      const uninstall = ipcHandlers.get("opensteer-cws:uninstall")!;
      const profileStoreTab = createFakeWebContents(
        59,
        `${CHROME_WEB_STORE_ORIGIN}/detail/${extMinimalId}`,
        "Store in profile",
        profileSession,
      );
      const mainWc = createFakeWebContents(
        60,
        `${CHROME_WEB_STORE_ORIGIN}/detail/${extMinimalId}`,
        "Store",
        storeSession,
      );
      const lookalikeWc = createFakeWebContents(
        61,
        "https://chromewebstore.google.com.evil.test/",
        "Evil",
        storeSession,
      );

      // Even the real Store origin inside the profile's extension-loaded Session is rejected.
      const profileSessionResult = await begin(
        { sender: profileStoreTab, senderFrame: profileStoreTab.mainFrame },
        { id: extMinimalId, manifest: JSON.stringify({ manifest_version: 3, version: "1.0.0" }) },
      );
      expect(profileSessionResult).toBeUndefined();

      // Lookalike origin is ignored.
      const lookalikeResult = await begin(
        { sender: lookalikeWc, senderFrame: lookalikeWc.mainFrame },
        { id: extMinimalId, manifest: JSON.stringify({ manifest_version: 3, version: "1.0.0" }) },
      );
      expect(lookalikeResult).toBeUndefined();

      // Subframe on real store origin is ignored.
      const subframeResult = await begin(
        {
          sender: mainWc,
          senderFrame: { origin: CHROME_WEB_STORE_ORIGIN, isDestroyed: () => false },
        },
        { id: extMinimalId, manifest: JSON.stringify({ manifest_version: 3, version: "1.0.0" }) },
      );
      expect(subframeResult).toBeUndefined();

      // Page uninstall is always refused even from real top-level isolated Store frame.
      const uninstallResult = await uninstall(
        { sender: mainWc, senderFrame: mainWc.mainFrame },
        extMinimalId,
      );
      expect(uninstallResult).toBe("unknown_error");
    } finally {
      controller.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks activeTab self-grant via action.openPopup, stops cross-extension event delivery after navigation, and gates cookies on profile admission", async () => {
    const { session, raw } = createFakeSession();
    raw.extensions._add({
      id: extMinimalId,
      name: "Minimal",
      version: "1.0.0",
      path: "/tmp/minimal",
      url: `chrome-extension://${extMinimalId}/`,
      manifest: {
        manifest_version: 3,
        name: "Minimal",
        version: "1.0.0",
        permissions: [],
        action: { default_title: "Min" },
      },
    } as Electron.Extension);
    raw.extensions._add({
      id: extPrivilegedId,
      name: "Cookie Ext",
      version: "1.0.0",
      path: "/tmp/priv",
      url: `chrome-extension://${extPrivilegedId}/`,
      manifest: {
        manifest_version: 3,
        name: "Cookie Ext",
        version: "1.0.0",
        permissions: ["cookies"],
        host_permissions: ["https://example.com/*"],
      },
    } as Electron.Extension);

    let admitted = false;
    const router = new ExtensionRouter(session);
    const sharedWindow = new FakeBaseWindow() as unknown as Electron.BaseWindow;
    const apis = new ChromeExtensionApis({
      session,
      router,
      sharedWindow,
      openTab: () => createFakeWebContents(99, "https://example.com/", "New", session),
      createExtensionWindow: () => new FakeBaseWindow() as unknown as Electron.BaseWindow,
      closeExtensionWindow: () => false,
      onActionChanged: () => undefined,
      isClosed: () => false,
      canAccessCookies: () => admitted,
    });

    const bankTab = createFakeWebContents(21, "https://bank.test/account", "Bank", session);
    apis.addTab(
      {
        contents: bankTab,
        open: () => bankTab,
        close: () => undefined,
        presentedWindow: () => sharedWindow,
      },
      sharedWindow,
    );

    const minWc = createFakeWebContents(
      30,
      `chrome-extension://${extMinimalId}/p.html`,
      "P",
      session,
    );
    const minEvt = frameEvent(`chrome-extension://${extMinimalId}`, minWc);
    // action.openPopup cannot self-grant activeTab (and refuses when no popup is declared).
    await expect(router.dispatchCall(minEvt, "action.openPopup", [])).rejects.toThrow(/no popup/u);
    const tabsAfter = (await router.dispatchCall(minEvt, "tabs.query", [{}])) as Record<
      string,
      unknown
    >[];
    expect(tabsAfter[0]!.url).toBeUndefined();

    // Cookie IPC and events are blocked while profile is not admitted.
    const privWc = createFakeWebContents(
      31,
      `chrome-extension://${extPrivilegedId}/p.html`,
      "P",
      session,
    );
    const privEvt = frameEvent(`chrome-extension://${extPrivilegedId}`, privWc);
    await expect(router.dispatchCall(privEvt, "cookies.getAll", [{}])).rejects.toThrow(
      /unavailable/u,
    );
    router.registerListener(privEvt as unknown as Electron.IpcMainEvent, "cookies.onChanged");
    raw.cookies.emit(
      "changed",
      {},
      { name: "pref", value: "1", domain: "example.com", path: "/", secure: true },
      "explicit",
      false,
    );
    expect(privWc.send).not.toHaveBeenCalled();

    // Once admitted, partitioned selectors are rejected, and navigation to another extension stops delivery.
    admitted = true;
    await expect(
      router.dispatchCall(privEvt, "cookies.get", [
        {
          url: "https://example.com/",
          name: "pref",
          partitionKey: { topLevelSite: "https://example.com" },
        },
      ]),
    ).rejects.toThrow(/Partitioned/u);
    raw.cookies.emit(
      "changed",
      {},
      { name: "pref", value: "2", domain: "example.com", path: "/", secure: true },
      "explicit",
      false,
    );
    expect(privWc.send).toHaveBeenCalledTimes(1);

    // Frame navigates to a different extension: must NOT receive extPrivilegedId's cookie events.
    privWc.mainFrame.origin = `chrome-extension://${extMinimalId}`;
    raw.cookies.emit(
      "changed",
      {},
      { name: "pref", value: "3", domain: "example.com", path: "/", secure: true },
      "explicit",
      false,
    );
    expect(privWc.send).toHaveBeenCalledTimes(1);

    // Malformed permissions.request rejects instead of silently dropping invalid members.
    await expect(
      router.dispatchCall(minEvt, "permissions.request", [{ origins: [123] }]),
    ).rejects.toThrow(/non-empty strings/u);

    // Oversized / malformed action.setIcon is rejected before entering state.
    await expect(
      router.dispatchCall(minEvt, "action.setIcon", [{ imageData: "not-a-png-data-url" }]),
    ).rejects.toThrow(/Invalid or oversized/u);

    // tabs.insertCSS is strictly forbidden on the Chrome Web Store origin even with <all_urls>.
    const storeTab = createFakeWebContents(
      22,
      "https://chromewebstore.google.com/detail/test",
      "Chrome Web Store",
      session,
    );
    apis.addTab(
      {
        contents: storeTab,
        open: () => storeTab,
        close: () => undefined,
        presentedWindow: () => sharedWindow,
      },
      sharedWindow,
    );
    await expect(
      router.dispatchCall(privEvt, "tabs.insertCSS", [22, { code: "body { display:none }" }]),
    ).rejects.toThrow(/Chrome Web Store/u);

    apis.dispose();
    router.dispose();
  });
});

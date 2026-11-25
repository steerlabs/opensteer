import { describe, expect, it } from "vitest";
import { chromeUserAgent } from "./browser-session-policy.js";

describe("Chrome user agent for every release", () => {
  const chrome =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
  for (const name of [
    "Opensteer",
    "Opensteer",
    "Opensteer Development",
    "Opensteer Future Release",
  ]) {
    it(`removes ${name}'s Electron product token`, () => {
      const token = name.replace(/\s/gu, "");
      const electron = chrome
        .replace("Chrome/150.0.0.0", "Chrome/150.0.7339.0")
        .replace(" Chrome/", ` ${token}/0.1.118 Chrome/`)
        .replace(" Safari/", " Electron/43.3.0 Safari/");
      expect(chromeUserAgent(electron)).toBe(chrome);
    });
  }
  it("leaves a Chrome string intact", () => {
    expect(chromeUserAgent(chrome)).toBe(chrome);
  });
});

it("denies device permissions and external protocols for every browser session (Sec01)", async () => {
  const { applyBrowserSessionPolicy } = await import("./browser-session-policy.js");
  const { vi } = await import("vitest");
  const session = {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    getPreloadScripts: () => [],
    registerPreloadScript: vi.fn(),
    webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn(), onBeforeRedirect: vi.fn() },
    setUserAgent: vi.fn(),
    getUserAgent: () => "Chrome/150",
  };
  const onMainFrameRequest = vi.fn();
  applyBrowserSessionPolicy(session as unknown as import("electron").Session, {
    onMainFrameRequest,
    downloads: { accept: vi.fn() },
    pagePolicyPreloadPath: "/policy.cjs",
  });
  const check = session.setPermissionCheckHandler.mock.calls[0]![0];
  const request = session.setPermissionRequestHandler.mock.calls[0]![0];
  for (const permission of [
    "media",
    "geolocation",
    "notifications",
    "clipboard-read",
    "camera",
    "microphone",
    // Storage access changes a cross-site privacy decision, so it stays
    // denied until an origin-scoped consent exists.
    "storage-access",
    // The browser shares the person's own clipboard; page script must not
    // write it without the person copying.
    "clipboard-sanitized-write",
  ]) {
    expect(check({}, permission)).toBe(false);
    const answer = vi.fn();
    request({}, permission, answer);
    expect(answer).toHaveBeenCalledWith(false);
  }
  expect(check({}, "fullscreen")).toBe(true);
  for (const permission of ["sensors", "background-sync", "screen-wake-lock", "payment-handler"]) {
    expect(check({}, permission)).toBe(true);
    const granted = vi.fn();
    request({}, permission, granted);
    expect(granted).toHaveBeenCalledWith(true);
  }
  expect(session.setUserAgent).toHaveBeenCalledWith("Chrome/150");
  const before = session.webRequest.onBeforeRequest.mock.calls[0]![0];
  for (const method of ["POST", "GET"])
    before(
      { url: "https://site.test/redirect", webContentsId: 7, resourceType: "mainFrame", method },
      vi.fn(),
    );
  before(
    { url: "https://site.test/frame", webContentsId: 7, resourceType: "subFrame", method: "POST" },
    vi.fn(),
  );
  expect(onMainFrameRequest.mock.calls).toEqual([
    [7, "POST"],
    [7, "GET"],
  ]);
  for (const url of ["file:///etc/passwd", "opensteer://test", "unknown:test"]) {
    const answer = vi.fn();
    before({ url }, answer);
    expect(answer).toHaveBeenCalledWith({ cancel: true });
  }
});

it("keeps site policy readable for provider frames and denies foreign ancestors", async () => {
  const { applyBrowserSessionPolicy } = await import("./browser-session-policy.js");
  const { vi } = await import("vitest");
  const session = {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    getPreloadScripts: () => [],
    registerPreloadScript: vi.fn(),
    webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn(), onBeforeRedirect: vi.fn() },
    setUserAgent: vi.fn(),
    getUserAgent: () => "Chrome/151",
  };
  applyBrowserSessionPolicy(session as unknown as import("electron").Session, {
    provider: true,
    downloads: { accept: vi.fn() },
    pagePolicyPreloadPath: "/policy.cjs",
  });
  const headers = session.webRequest.onHeadersReceived.mock.calls[0]![1];
  const original = { "Permissions-Policy": ["publickey-credentials-get=()"] };
  for (const [resourceType, parent, denied] of [
    ["mainFrame", null, false],
    ["subFrame", { url: "https://rp.test/", parent: null }, false],
    ["subFrame", { url: "https://other.test/", parent: null }, true],
    [
      "subFrame",
      { url: "https://rp.test/", parent: { url: "https://other.test/", parent: null } },
      true,
    ],
    ["subFrame", null, true],
  ] as const) {
    const callback = vi.fn();
    headers(
      { resourceType, url: "https://rp.test/frame", frame: { parent }, responseHeaders: original },
      callback,
    );
    const result = callback.mock.calls[0]![0].responseHeaders as Record<string, string[]>;
    expect(result["Permissions-Policy"]).toHaveLength(denied ? 2 : 1);
    expect(result["Permissions-Policy"]![0]).toBe("publickey-credentials-get=()");
  }
});

it("presents one reduced identity and supplies the navigation client hints Electron drops", async () => {
  const { applyBrowserSessionPolicy, browserAcceptLanguages, browserIdentity } =
    await import("./browser-session-policy.js");
  const { vi } = await import("vitest");
  const identity = browserIdentity(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Opensteer/1.0 Chrome/152.0.7977.169 Electron/44.10.2 Safari/537.36",
    { architecture: "arm", bitness: "64", platformVersion: "26.6.2" },
  );
  expect(identity.userAgent).toBe(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  );
  expect(identity.clientHints).toEqual({
    brands: '"Not?A_Brand";v="24", "Chromium";v="152"',
    platform: "macOS",
  });
  // The JS identity (CDP metadata) and the wire identity (client hints) come
  // from the same source, so the brands a page reads are the brands it sends.
  expect(identity.userAgentMetadata).toEqual({
    brands: [
      { brand: "Not?A_Brand", version: "24" },
      { brand: "Chromium", version: "152" },
    ],
    fullVersionList: [
      { brand: "Not?A_Brand", version: "24.0.0.0" },
      { brand: "Chromium", version: "152.0.7977.169" },
    ],
    fullVersion: "152.0.7977.169",
    platform: "macOS",
    platformVersion: "26.6.2",
    architecture: "arm",
    model: "",
    mobile: false,
    bitness: "64",
  });
  expect(browserAcceptLanguages(["en-US", "fr-FR", "en"])).toBe("en-US,en,fr-FR,fr");
  const session = {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    getPreloadScripts: () => [],
    registerPreloadScript: vi.fn(),
    webRequest: {
      onHeadersReceived: vi.fn(),
      onBeforeRequest: vi.fn(),
      onBeforeRedirect: vi.fn(),
      onBeforeSendHeaders: vi.fn(),
    },
    setUserAgent: vi.fn(),
    getUserAgent: () =>
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.169 Electron/44.10.2 Safari/537.36",
  };
  applyBrowserSessionPolicy(session as unknown as import("electron").Session, {
    acceptLanguages: "en-US,en",
    downloads: { accept: vi.fn() },
    pagePolicyPreloadPath: "/policy.cjs",
  });
  expect(session.setUserAgent).toHaveBeenCalledWith(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    "en-US,en",
  );
  const sendHeaders = session.webRequest.onBeforeSendHeaders.mock.calls[0]![0];
  const injected = vi.fn();
  sendHeaders({ url: "https://site.test/", requestHeaders: { "User-Agent": "x" } }, injected);
  expect(injected).toHaveBeenCalledWith({
    requestHeaders: {
      "User-Agent": "x",
      "Sec-CH-UA": '"Not?A_Brand";v="24", "Chromium";v="152"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"macOS"',
    },
  });
  const untouched = vi.fn();
  sendHeaders(
    { url: "https://site.test/", requestHeaders: { "Sec-CH-UA": '"Chromium";v="152"' } },
    untouched,
  );
  expect(untouched).toHaveBeenCalledWith({});
  const insecure = vi.fn();
  sendHeaders({ url: "http://site.test/", requestHeaders: {} }, insecure);
  expect(insecure).toHaveBeenCalledWith({});
  // Loopback http is a secure context in Chrome, so it gets the hints too.
  for (const url of ["http://localhost:3000/", "http://127.0.0.2/", "http://app.localhost/"]) {
    const loopback = vi.fn();
    sendHeaders({ url, requestHeaders: {} }, loopback);
    expect(loopback).toHaveBeenCalledWith({
      requestHeaders: {
        "Sec-CH-UA": '"Not?A_Brand";v="24", "Chromium";v="152"',
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"macOS"',
      },
    });
  }
  // Userinfo must not make a remote host look like loopback.
  const spoofed = vi.fn();
  sendHeaders({ url: "http://localhost:80@evil.example/", requestHeaders: {} }, spoofed);
  expect(spoofed).toHaveBeenCalledWith({});
});

it("immediately cancels every request at a closed restoration gate, including service workers", async () => {
  const { BrowserSessionRequestGate, applyBrowserSessionPolicy } =
    await import("./browser-session-policy.js");
  const { vi } = await import("vitest");
  const gate = new BrowserSessionRequestGate();
  const session = {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    getPreloadScripts: () => [],
    registerPreloadScript: vi.fn(),
    webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn(), onBeforeRedirect: vi.fn() },
    setUserAgent: vi.fn(),
    getUserAgent: () => "Chrome/151",
  };
  applyBrowserSessionPolicy(session as unknown as import("electron").Session, {
    downloads: { accept: vi.fn() },
    pagePolicyPreloadPath: "/policy.cjs",
    requestGate: gate,
  });
  const before = session.webRequest.onBeforeRequest.mock.calls[0]![0];
  const worker = vi.fn();
  const page = vi.fn();
  const helper = vi.fn();
  before({ url: "https://site.test/" }, worker);
  before({ url: "https://site.test/", webContentsId: 1 }, page);
  before({ url: "https://site.test/", webContentsId: 2 }, helper);
  expect(helper).toHaveBeenCalledWith({ cancel: true });
  expect(worker).toHaveBeenCalledExactlyOnceWith({ cancel: true });
  expect(page).toHaveBeenCalledExactlyOnceWith({ cancel: true });
  gate.open();
  expect(worker).toHaveBeenCalledOnce();
  expect(page).toHaveBeenCalledOnce();
  gate.close();
  const blocked = vi.fn();
  before({ url: "https://site.test/", webContentsId: 2 }, blocked);
  expect(blocked).toHaveBeenCalledExactlyOnceWith({ cancel: true });
  gate.fail();
  expect(blocked).toHaveBeenCalledWith({ cancel: true });
  expect(session.webRequest.onBeforeRequest).toHaveBeenCalledOnce();
});

it("cancels dormant page and worker requests without replaying them on admission", async () => {
  const { BrowserSessionRequestGate } = await import("./browser-session-policy.js");
  const { vi } = await import("vitest");
  const gate = new BrowserSessionRequestGate();
  const queued = vi.fn();
  gate.beforeRequest(undefined, queued);
  gate.dormant();
  expect(queued).toHaveBeenCalledExactlyOnceWith({ cancel: true });
  const worker = vi.fn();
  const page = vi.fn();
  const helper = vi.fn();
  gate.beforeRequest(undefined, worker);
  gate.beforeRequest(1, page);
  gate.beforeRequest(2, helper);
  expect(worker).toHaveBeenCalledExactlyOnceWith({ cancel: true });
  expect(page).toHaveBeenCalledExactlyOnceWith({ cancel: true });
  expect(helper).toHaveBeenCalledExactlyOnceWith({ cancel: true });
  gate.open();
  expect(worker).toHaveBeenCalledOnce();
  expect(page).toHaveBeenCalledOnce();
  const admitted = vi.fn();
  gate.beforeRequest(undefined, admitted);
  expect(admitted).toHaveBeenCalledExactlyOnceWith({ cancel: false });
  gate.dormant();
  const dormantAgain = vi.fn();
  gate.beforeRequest(undefined, dormantAgain);
  expect(dormantAgain).toHaveBeenCalledExactlyOnceWith({ cancel: true });
  gate.fail();
  gate.open();
  const retired = vi.fn();
  gate.beforeRequest(2, retired);
  expect(retired).toHaveBeenCalledExactlyOnceWith({ cancel: true });
});

it("loads extension files ahead of the profile gate and keeps extension preloads", async () => {
  const { applyBrowserSessionPolicy, BrowserSessionRequestGate } =
    await import("./browser-session-policy.js");
  const { vi } = await import("vitest");
  const preloads = [{ id: "opensteer-page-policy" }, { id: "crx-mv3-preload" }];
  const session = {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    getPreloadScripts: () => preloads,
    registerPreloadScript: vi.fn(),
    unregisterPreloadScript: vi.fn(),
    webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn(), onBeforeRedirect: vi.fn() },
    setUserAgent: vi.fn(),
    getUserAgent: () => "Chrome/150",
  };
  // A dormant profile refuses web requests until it is admitted.
  const gate = new BrowserSessionRequestGate();
  gate.dormant();
  applyBrowserSessionPolicy(session as unknown as import("electron").Session, {
    downloads: { accept: vi.fn() },
    pagePolicyPreloadPath: "/policy.cjs",
    requestGate: gate,
  });
  expect(session.unregisterPreloadScript.mock.calls).toEqual([["opensteer-page-policy"]]);
  expect(session.registerPreloadScript).toHaveBeenCalledWith({
    filePath: "/policy.cjs",
    id: "opensteer-page-policy",
    type: "frame",
  });
  const before = session.webRequest.onBeforeRequest.mock.calls[0]![0];
  const extension = vi.fn();
  before({ url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/worker.js" }, extension);
  expect(extension).toHaveBeenCalledWith({ cancel: false });
  const web = vi.fn();
  before({ url: "https://site.test/" }, web);
  expect(web).toHaveBeenCalledWith({ cancel: true });
});

it("cancels chrome-extension: requests for connection-controlled webContents while keeping them for the person and extension workers (M1a, S1)", async () => {
  const { applyBrowserSessionPolicy } = await import("./browser-session-policy.js");
  const { vi } = await import("vitest");
  const session = {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    getPreloadScripts: () => [],
    registerPreloadScript: vi.fn(),
    webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn(), onBeforeRedirect: vi.fn() },
    setUserAgent: vi.fn(),
    getUserAgent: () => "Chrome/150",
  };
  applyBrowserSessionPolicy(session as unknown as import("electron").Session, {
    downloads: { accept: vi.fn() },
    pagePolicyPreloadPath: "/policy.cjs",
    isConnectionWebContents: (id: number) => id === 42,
  });
  const before = session.webRequest.onBeforeRequest.mock.calls[0]![0];
  const extId = "abcdefghijklmnopabcdefghijklmnop";
  for (const url of [
    `chrome-extension://${extId}/war.txt`,
    `chrome-ex\ttension://${extId}/war.html`,
    `\u0001chrome-extension://${extId}/war.html`,
    `blob:chrome-extension://${extId}/subresource`,
    `filesystem:chrome-extension://${extId}/temporary/subresource`,
  ]) {
    const connAnswer = vi.fn();
    before({ url, webContentsId: 42 }, connAnswer);
    expect(connAnswer, url).toHaveBeenCalledWith({ cancel: true });
  }
  const webBlobAnswer = vi.fn();
  before({ url: "blob:https://site.test/subresource", webContentsId: 42 }, webBlobAnswer);
  expect(webBlobAnswer).toHaveBeenCalledWith({ cancel: false });
  const personAnswer = vi.fn();
  before({ url: `chrome-extension://${extId}/options.html`, webContentsId: 7 }, personAnswer);
  expect(personAnswer).toHaveBeenCalledWith({ cancel: false });
  const workerAnswer = vi.fn();
  before({ url: `chrome-extension://${extId}/worker.js` }, workerAnswer);
  expect(workerAnswer).toHaveBeenCalledWith({ cancel: false });
});

it("loads a page's own request for an extension resource only when the extension lists it as web-accessible for the page", async () => {
  const { applyBrowserSessionPolicy } = await import("./browser-session-policy.js");
  const { vi } = await import("vitest");
  const extId = "abcdefghijklmnopabcdefghijklmnop";
  const absentId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const manifest = {
    manifest_version: 3,
    web_accessible_resources: [{ resources: ["war.txt"], matches: ["<all_urls>"] }],
  };
  const getExtension = vi.fn((id: string) => (id === extId ? { manifest } : null));
  const session = {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    getPreloadScripts: () => [],
    registerPreloadScript: vi.fn(),
    webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn(), onBeforeRedirect: vi.fn() },
    setUserAgent: vi.fn(),
    getUserAgent: () => "Chrome/150",
    extensions: { getExtension },
  };
  applyBrowserSessionPolicy(session as unknown as import("electron").Session, {
    downloads: { accept: vi.fn() },
    pagePolicyPreloadPath: "/policy.cjs",
    isConnectionWebContents: () => false,
  });
  const before = session.webRequest.onBeforeRequest.mock.calls[0]![0];
  const web = { origin: "https://site.test" };
  const own = { origin: `chrome-extension://${extId}` };
  const opaque = { origin: "null" };
  const gone = {
    get origin(): string {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    },
  };
  const cancelled = (
    url: string,
    frame: object | null,
    resourceType = "xhr",
    initiatorOrigin?: string,
  ) => {
    const answer = vi.fn();
    before(
      {
        url,
        webContentsId: 7,
        resourceType,
        frame,
        method: "GET",
        ...(initiatorOrigin === undefined ? {} : { initiatorOrigin }),
      },
      answer,
    );
    return answer.mock.calls[0]![0].cancel as boolean;
  };
  // A web page: the web-accessible resource loads; one not listed and one of an absent
  // extension are refused alike.
  expect(cancelled(`chrome-extension://${extId}/war.txt`, web)).toBe(false);
  expect(cancelled(`chrome-extension://${extId}/nonwar.html`, web)).toBe(true);
  expect(cancelled(`chrome-extension://${absentId}/nonwar.html`, web)).toBe(true);
  expect(cancelled(`chrome-extension://${extId}/nonwar.html`, web, "image")).toBe(true);
  expect(cancelled(`chrome-extension://${extId}/nonwar.html`, web, "script")).toBe(true);
  // An opaque frame (a data: iframe) matches no MV3 entry; a frame already gone is refused.
  expect(cancelled(`chrome-extension://${extId}/war.txt`, opaque)).toBe(true);
  expect(cancelled(`chrome-extension://${extId}/war.txt`, gone)).toBe(true);
  // The extension's own pages load their own files.
  expect(cancelled(`chrome-extension://${extId}/nonwar.html`, own)).toBe(false);
  // Navigations are the page's navigation events' to decide: a load the browser starts carries
  // the frame's previous origin here.
  expect(cancelled(`chrome-extension://${extId}/nonwar.html`, web, "mainFrame")).toBe(false);
  expect(cancelled(`chrome-extension://${extId}/nonwar.html`, web, "subFrame")).toBe(false);
  // No frame: the request's initiator says who asked (a page's worker, a keepalive request);
  // with neither, it is left to Chromium's extension loader (S3).
  expect(cancelled(`chrome-extension://${extId}/nonwar.html`, null, "xhr", web.origin)).toBe(true);
  expect(cancelled(`chrome-extension://${absentId}/nonwar.html`, null, "xhr", web.origin)).toBe(
    true,
  );
  expect(cancelled(`chrome-extension://${extId}/war.txt`, null, "xhr", web.origin)).toBe(false);
  expect(cancelled(`chrome-extension://${extId}/nonwar.html`, null, "xhr", own.origin)).toBe(false);
  expect(cancelled(`chrome-extension://${extId}/war.txt`, gone, "xhr", web.origin)).toBe(false);
  expect(cancelled(`chrome-extension://${extId}/nonwar.html`, gone, "xhr", web.origin)).toBe(true);
  expect(cancelled(`chrome-extension://${extId}/worker.js`, null, "script")).toBe(false);
  // An extension's dynamic address (use_dynamic_url) is let through, and so is Chromium's own
  // rewrite of it into the static address, followed by its request id (S2).
  const dynamicHost = "chrome-extension://e7c508fa-1f5c-471b-9065-5bf03292faaa";
  expect(cancelled(`${dynamicHost}/dyn.txt`, web)).toBe(false);
  const beforeRedirect = session.webRequest.onBeforeRedirect.mock.calls[0]!.at(-1) as (
    details: object,
  ) => void;
  const hop = (requestId: number, from: string, to: string) =>
    beforeRedirect({ id: requestId, url: from, redirectURL: to, resourceType: "xhr" });
  const staticDyn = `chrome-extension://${extId}/dyn.txt`;
  const nextRequest = (requestId: number, url: string) => {
    const answer = vi.fn();
    before(
      { id: requestId, url, webContentsId: 7, resourceType: "xhr", frame: web, method: "GET" },
      answer,
    );
    return answer.mock.calls[0]![0].cancel as boolean;
  };
  hop(91, `${dynamicHost}/dyn.txt`, staticDyn);
  expect(nextRequest(91, staticDyn), "Chromium's hop").toBe(false);
  expect(nextRequest(91, staticDyn), "the hop is taken once").toBe(true);
  hop(92, `${dynamicHost}/dyn.txt`, staticDyn);
  expect(nextRequest(93, staticDyn), "another request").toBe(true);
  hop(94, "https://evil.test/dyn.txt", staticDyn);
  expect(nextRequest(94, staticDyn), "a web redirect is no hop").toBe(true);
  // Rule 7: an ordinary web request never reads a manifest.
  getExtension.mockClear();
  expect(cancelled("https://site.test/app.js", web, "script")).toBe(false);
  expect(getExtension).not.toHaveBeenCalled();
});

describe("no page of a browser the Home owns loads one of the Home's addresses, for anyone (G1)", () => {
  const policy = async () => {
    const { applyBrowserSessionPolicy, takeHomeRefusal } =
      await import("./browser-session-policy.js");
    const { ThisHomeAddressSet } = await import("@opensteer/shared/homeAddress");
    const { vi } = await import("vitest");
    const session = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      getPreloadScripts: () => [],
      registerPreloadScript: vi.fn(),
      webRequest: {
        onHeadersReceived: vi.fn(),
        onBeforeRequest: vi.fn(),
        onBeforeRedirect: vi.fn(),
        onBeforeSendHeaders: vi.fn(),
      },
      setUserAgent: vi.fn(),
      getUserAgent: () => "Chrome/150",
    };
    const home = new ThisHomeAddressSet({
      origins: ["http://127.0.0.1:4310", "https://route.example.com"],
      loopbackPorts: [4310],
    });
    applyBrowserSessionPolicy(session as unknown as import("electron").Session, {
      homeAddresses: () => home,
      downloads: { accept: vi.fn() },
      pagePolicyPreloadPath: "/policy.cjs",
    });
    const before = session.webRequest.onBeforeRequest.mock.calls[0]![0] as (
      details: Record<string, unknown>,
      callback: (response: { cancel?: boolean }) => void,
    ) => void;
    const ask = (details: Record<string, unknown>) => {
      let answer: { cancel?: boolean } | undefined;
      before({ method: "GET", ...details }, (response) => (answer = response));
      return answer;
    };
    return { ask, takeHomeRefusal };
  };

  it("refuses every request to it: a page, a popup, a frame, a redirect hop, a worker and a service worker, the person's and an agent's alike", async () => {
    const { ask, takeHomeRefusal } = await policy();
    const cases = [
      // The person's own tab, or an agent's: the browser cannot tell, and need not.
      { url: "http://127.0.0.1:4310/", webContentsId: 7, resourceType: "mainFrame" },
      { url: "http://localhost:4310/tasks", webContentsId: 8, resourceType: "mainFrame" },
      { url: "https://route.example.com/settings", webContentsId: 9, resourceType: "mainFrame" },
      { url: "http://[::1]:4310/", webContentsId: 7, resourceType: "subFrame" },
      // A redirect hop is asked here again, with its new address.
      { url: "http://127.0.0.1:4310/v1/rpc/tasks.page", webContentsId: 7, resourceType: "xhr" },
      // A worker's and a service worker's own requests have no WebContents.
      { url: "http://127.0.0.1:4310/v1/realtime", resourceType: "webSocket" },
      { url: "https://route.example.com/v1/auth/session", resourceType: "other" },
      // Network.loadNetworkResource, a navigation preload and a prerender are requests too.
      { url: "http://sub.localhost:4310/", webContentsId: 7, resourceType: "other" },
    ];
    for (const details of cases) expect(ask(details), details.url).toEqual({ cancel: true });
    // A refused page says where the Home opens; a refused subresource does not.
    expect(takeHomeRefusal(7)).toBe(true);
    expect(takeHomeRefusal(7)).toBe(false);
    expect(takeHomeRefusal(8)).toBe(true);
  });

  it("keeps every other site, a dev server on another loopback port included", async () => {
    const { ask } = await policy();
    for (const url of ["http://localhost:5173/", "http://127.0.0.1:3000/x", "https://web.test/"])
      expect(ask({ url, webContentsId: 7, resourceType: "mainFrame" }), url).toEqual({
        cancel: false,
      });
  });

  it("removes a session cookie of the Home's from a profile once, and nothing else", async () => {
    const { forgetHomeSessionCookies } = await import("./browser-session-policy.js");
    const jar = [
      { name: "opensteer.session", domain: "127.0.0.1", path: "/", secure: false },
      { name: "__Host-opensteer.session", domain: "route.example.com", path: "/", secure: true },
      { name: "opensteer.admission", domain: "localhost", path: "/", secure: false },
      { name: "better-auth.session_token", domain: "localhost", path: "/", secure: false },
      { name: "theirs", domain: "127.0.0.1", path: "/", secure: false },
    ];
    const removed: string[] = [];
    await forgetHomeSessionCookies({
      cookies: {
        get: async () => jar,
        remove: async (url: string, name: string) => {
          removed.push(`${name}@${url}`);
        },
      },
    } as never);
    expect(removed).toEqual([
      "opensteer.session@http://127.0.0.1/",
      "__Host-opensteer.session@https://route.example.com/",
      "opensteer.admission@http://localhost/",
    ]);
  });
});

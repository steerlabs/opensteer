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
    webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn() },
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
  ]) {
    expect(check({}, permission)).toBe(false);
    const answer = vi.fn();
    request({}, permission, answer);
    expect(answer).toHaveBeenCalledWith(false);
  }
  expect(check({}, "fullscreen")).toBe(true);
  for (const permission of [
    "sensors",
    "background-sync",
    "clipboard-sanitized-write",
    "storage-access",
    "screen-wake-lock",
    "payment-handler",
  ]) {
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
    webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn() },
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
  );
  expect(identity.userAgent).toBe(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  );
  expect(identity.clientHints).toEqual({
    brands: '"Not?A_Brand";v="24", "Chromium";v="152"',
    platform: "macOS",
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
    webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn() },
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

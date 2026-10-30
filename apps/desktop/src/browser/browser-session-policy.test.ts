import { describe, expect, it } from "vitest";
import { chromeUserAgent } from "./browser-session-policy.js";

describe("Chrome user agent for every release", () => {
  const chrome =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7339.0 Safari/537.36";
  for (const name of [
    "Opensteer",
    "Opensteer Beta",
    "Opensteer Development",
    "Opensteer Future Release",
  ]) {
    it(`removes ${name}'s Electron product token`, () => {
      const token = name.replace(/\s/gu, "");
      const electron = chrome
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
  applyBrowserSessionPolicy(session as unknown as import("electron").Session, {
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
  const before = session.webRequest.onBeforeRequest.mock.calls[0]![0];
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

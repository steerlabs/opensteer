import { describe, expect, it } from "vitest";
import {
  extensionNavigationEnded,
  extensionNavigationStarted,
  extensionRedirectedIntoDynamic,
  forgetExtensionNavigations,
  isDynamicExtensionHop,
  isDynamicExtensionUrl,
  recordDynamicExtensionRequestHop,
  recordExtensionRedirect,
  takeDynamicExtensionRequestHop,
  takeExtensionRedirect,
} from "./extension-redirects.js";

const dynamic = "chrome-extension://e7c508fa-1f5c-471b-9065-5bf03292faaa";
const id = "abcdefghijklmnopabcdefghijklmnop";
const staticBase = `chrome-extension://${id}`;

describe("Chromium's rewrite of an extension's dynamic address", () => {
  it("is a hop from a dynamic host to an extension id with the same path and query", () => {
    expect(isDynamicExtensionHop(`${dynamic}/dyn.html?a=1`, `${staticBase}/dyn.html?a=1`)).toBe(
      true,
    );
    expect(isDynamicExtensionHop(`${dynamic}/dyn.html`, `${staticBase}/nonwar.html`)).toBe(false);
    expect(isDynamicExtensionHop(`${dynamic}/dyn.html?a=1`, `${staticBase}/dyn.html`)).toBe(false);
    expect(isDynamicExtensionHop("https://evil.test/dyn.html", `${staticBase}/dyn.html`)).toBe(
      false,
    );
    expect(isDynamicExtensionHop(`${staticBase}/dyn.html`, `${staticBase}/dyn.html`)).toBe(false);
    expect(isDynamicExtensionHop(`${dynamic}/dyn.html`, `${dynamic}/dyn.html`)).toBe(false);
    expect(isDynamicExtensionHop("not a url", `${staticBase}/dyn.html`)).toBe(false);
    expect(isDynamicExtensionUrl(`${dynamic}/dyn.html`)).toBe(true);
    expect(isDynamicExtensionUrl(`${staticBase}/dyn.html`)).toBe(false);
  });

  it("carries how the navigation came to the dynamic address into its hop", () => {
    const session = {};
    // A page started it.
    extensionNavigationStarted(session, 1, 7, `${dynamic}/dyn.html`, {
      initiatorOrigin: "https://site.test",
    });
    recordExtensionRedirect(session, 1, 7, `${dynamic}/dyn.html`, `${staticBase}/dyn.html`);
    expect(takeExtensionRedirect(session, 1, 7, `${staticBase}/dyn.html`)).toEqual({
      dynamicHop: true,
      judge: { kind: "initiator", origin: "https://site.test" },
    });
    // The browser started it.
    extensionNavigationStarted(session, 1, 7, `${dynamic}/dyn.html`, { browserStarted: true });
    recordExtensionRedirect(session, 1, 7, `${dynamic}/dyn.html`, `${staticBase}/dyn.html`);
    expect(takeExtensionRedirect(session, 1, 7, `${staticBase}/dyn.html`)).toEqual({
      dynamicHop: true,
      judge: { kind: "browser" },
    });
    // A web response's redirect led there.
    extensionRedirectedIntoDynamic(session, 1, 7, `${dynamic}/nonwar.html`, "https://evil.test");
    recordExtensionRedirect(session, 1, 7, `${dynamic}/nonwar.html`, `${staticBase}/nonwar.html`);
    expect(takeExtensionRedirect(session, 1, 7, `${staticBase}/nonwar.html`)).toEqual({
      dynamicHop: true,
      judge: { kind: "redirect", origin: "https://evil.test" },
    });
    // Nothing said how: the hop has no judge.
    recordExtensionRedirect(session, 1, 7, `${dynamic}/dyn.html`, `${staticBase}/dyn.html`);
    expect(takeExtensionRedirect(session, 1, 7, `${staticBase}/dyn.html`)).toEqual({
      dynamicHop: true,
      judge: undefined,
    });
  });

  it("keeps a web response's redirect apart, per frame, used once", () => {
    const session = {};
    recordExtensionRedirect(session, 1, 7, "https://idp.test/auth", `${staticBase}/callback.html`);
    expect(takeExtensionRedirect(session, 1, 8, `${staticBase}/callback.html`)).toBeUndefined();
    expect(takeExtensionRedirect(session, 1, 7, `${staticBase}/callback.html`)).toEqual({
      dynamicHop: false,
      from: "https://idp.test",
    });
    expect(takeExtensionRedirect(session, 1, 7, `${staticBase}/callback.html`)).toBeUndefined();
  });

  it("keeps one store per Session", () => {
    const one = {};
    const two = {};
    recordExtensionRedirect(one, 1, 7, "https://idp.test/auth", `${staticBase}/callback.html`);
    expect(takeExtensionRedirect(two, 1, 7, `${staticBase}/callback.html`)).toBeUndefined();
    recordDynamicExtensionRequestHop(one, 42, `${staticBase}/dyn.txt`);
    expect(takeDynamicExtensionRequestHop(two, 42, `${staticBase}/dyn.txt`)).toBe(false);
    expect(takeDynamicExtensionRequestHop(one, 42, `${staticBase}/dyn.txt`)).toBe(true);
  });

  it("drops a frame's records when it starts or ends a navigation, and a page's with it (R2)", () => {
    const session = {};
    const record = (frame: number) =>
      recordExtensionRedirect(
        session,
        1,
        frame,
        "https://trusted.test/x",
        `${staticBase}/trusted-only.html`,
      );
    record(7);
    extensionNavigationStarted(session, 1, 7, "https://elsewhere.test/", {
      initiatorOrigin: "https://elsewhere.test",
    });
    expect(takeExtensionRedirect(session, 1, 7, `${staticBase}/trusted-only.html`)).toBeUndefined();
    record(7);
    record(8);
    extensionNavigationEnded(session, 1, 7);
    expect(takeExtensionRedirect(session, 1, 7, `${staticBase}/trusted-only.html`)).toBeUndefined();
    expect(takeExtensionRedirect(session, 1, 8, `${staticBase}/trusted-only.html`)).toEqual({
      dynamicHop: false,
      from: "https://trusted.test",
    });
    record(7);
    extensionNavigationStarted(session, 1, 9, `${dynamic}/dyn.html`, { browserStarted: true });
    forgetExtensionNavigations(session, 1);
    expect(takeExtensionRedirect(session, 1, 7, `${staticBase}/trusted-only.html`)).toBeUndefined();
    recordExtensionRedirect(session, 1, 9, `${dynamic}/dyn.html`, `${staticBase}/dyn.html`);
    expect(takeExtensionRedirect(session, 1, 9, `${staticBase}/dyn.html`)).toEqual({
      dynamicHop: true,
      judge: undefined,
    });
  });

  it("matches a navigation's URL with its #fragment to the loader's URL without it", () => {
    const session = {};
    // A hash route: did-start-navigation and will-redirect carry the fragment, Chromium's loader
    // (onBeforeRedirect) does not.
    extensionNavigationStarted(session, 1, 7, `${dynamic}/app.html#/settings`, {
      initiatorOrigin: `chrome-extension://${id}`,
    });
    recordExtensionRedirect(session, 1, 7, `${dynamic}/app.html`, `${staticBase}/app.html`);
    expect(takeExtensionRedirect(session, 1, 7, `${staticBase}/app.html#/settings`)).toEqual({
      dynamicHop: true,
      judge: { kind: "initiator", origin: `chrome-extension://${id}` },
    });
    // A 302 whose Location carries #token=…
    recordExtensionRedirect(session, 1, 7, "https://trusted.test/oauth", `${dynamic}/dyn.html`);
    expect(takeExtensionRedirect(session, 1, 7, `${dynamic}/dyn.html#token=1`)).toEqual({
      dynamicHop: false,
      from: "https://trusted.test",
    });
    extensionRedirectedIntoDynamic(
      session,
      1,
      7,
      `${dynamic}/dyn.html#token=1`,
      "https://trusted.test",
    );
    recordExtensionRedirect(session, 1, 7, `${dynamic}/dyn.html`, `${staticBase}/dyn.html`);
    expect(takeExtensionRedirect(session, 1, 7, `${staticBase}/dyn.html#token=1`)).toEqual({
      dynamicHop: true,
      judge: { kind: "redirect", origin: "https://trusted.test" },
    });
  });

  it("follows a subresource request by its id and address, once", () => {
    const session = {};
    recordDynamicExtensionRequestHop(session, 42, `${staticBase}/dyn.txt`);
    expect(takeDynamicExtensionRequestHop(session, 43, `${staticBase}/dyn.txt`)).toBe(false);
    expect(takeDynamicExtensionRequestHop(session, 42, `${staticBase}/nonwar.txt`)).toBe(false);
    expect(takeDynamicExtensionRequestHop(session, 42, `${staticBase}/dyn.txt`)).toBe(true);
    expect(takeDynamicExtensionRequestHop(session, 42, `${staticBase}/dyn.txt`)).toBe(false);
  });
});
